import fs from "node:fs";
import { expandHome } from "../accounts/env.js";
import { folderAllowed, selectAccount, usedPct, type Candidate, type Exclusion } from "../accounts/select.js";
import { canonicalPath } from "../guards/paths.js";
import { markLimited, refreshStale, type UsageFetch } from "../status/quota-poller.js";
import type { Repos } from "../store/repos.js";
import type { Account, AccountStatus, Limits, Run } from "../types.js";
import { NEST_ENV, runClaude, type ClaudeOutcome } from "./claude-run.js";
import { processStart, sweepDeadRuns, type ControlOptions } from "./control.js";
import { cut } from "./tool-text.js";
import { planWorker, type WorkerPlan } from "./worker.js";

export interface DispatchRequest {
  prompt: string;
  cwd: string;
  label?: string;
  /** Account name (trimmed, case-insensitive); skips the quota comparison and the reserve. */
  account?: string;
  /** Never resume the folder's worker. */
  fresh?: boolean;
  readOnly?: boolean;
  retryOf?: number;
}
export interface DispatchDeps {
  repos: Repos;
  claudePath: string;
  /** Asks an account for its quota; without it the stored numbers are used as they are. */
  fetch?: UsageFetch;
  env: NodeJS.ProcessEnv;
  now(): number;
  /** The dispatching process, recorded on the run so others can tell whether it is still alive and stop it. */
  pid: number;
  pidStart: string;
  /** Called once the run row exists, before claude starts. */
  onStart?(run: Run, account: Account): void;
  /** How `ps` is asked (sweep, the worker's start time). Default /bin/ps with a 2 s timeout; tests give more time. */
  ps?: ControlOptions;
  signal?: AbortSignal;
}

export type RefuseCode = "nested" | "bad-cwd" | "too-many" | "too-fast" | "no-account" | "unknown-account";

/** Dispatch said no before creating a run. `message` is a short English sentence; callers format the details. */
export class DispatchRefused extends Error {
  code: RefuseCode;
  exclusions?: Exclusion[];
  constructor(code: RefuseCode, message: string, exclusions?: Exclusion[]) {
    super(message);
    this.name = "DispatchRefused";
    this.code = code;
    if (exclusions) this.exclusions = exclusions;
  }
}

const HOUR_MS = 60 * 60_000;
const DETAIL_CAP = 120;

/**
 * Guards, fresh quota, an account and a run row claimed in one transaction, the folder's worker
 * resumed when it can be, claude run, outcome recorded. Resolves with the finished run row (done | failed | limited |
 * stopped). Throws only DispatchRefused, and only before a run row exists; anything unexpected after that is recorded
 * on the row as failed.
 */
export async function dispatch(deps: DispatchDeps, req: DispatchRequest): Promise<Run> {
  if (deps.env[NEST_ENV]) throw new DispatchRefused("nested", "Delegating is not allowed from inside a run");
  const cwd = folderOf(req.cwd);
  const limits = deps.repos.settings.getLimits();
  if (deps.fetch) await refreshCandidates(deps, deps.fetch, req, cwd, limits);
  // Synchronous: two dispatchers (other processes included) see each other's run rows when they choose. A refusal is
  // returned rather than thrown inside, so the transaction commits the dead runs it swept.
  const claimed = deps.repos.tx(() => {
    try {
      return claim(deps, req, cwd, limits);
    } catch (e) {
      if (e instanceof DispatchRefused) return e;
      throw e;
    }
  });
  if (claimed instanceof DispatchRefused) throw claimed;
  const { run, account, plan } = claimed;

  try {
    deps.onStart?.(run, account);
    const outcome = await runClaude({
      claudePath: deps.claudePath,
      account,
      cwd,
      prompt: req.prompt,
      runId: run.id,
      resume: plan.resume,
      readOnly: req.readOnly,
      timeoutMs: limits.runTimeoutMs,
      onEvent: (e) => {
        try {
          deps.repos.runEvents.add(run.id, e.kind, e.text, deps.now());
        } catch {
          // progress is for display; losing a line must not fail the run
        }
      },
      signal: deps.signal,
      onSpawn: (pid) => {
        try {
          deps.repos.runs.update(run.id, { workerPid: pid, workerPidStart: processStart(pid, deps.ps) });
        } catch {
          // without it a sweep cannot kill this claude if we die; the run itself is fine
        }
      },
    });
    recordOutcome(deps, run.id, account.id, outcome);
  } catch (e) {
    recordCrash(deps, run, e);
  }
  try {
    return deps.repos.runs.get(run.id) ?? run;
  } catch {
    return run;
  }
}

/** Canonical folder (`~` expanded, symlinks resolved, no trailing slash); refuses a missing folder or a file. */
function folderOf(input: string): string {
  const dir = canonicalPath(expandHome(input));
  let isDir: boolean;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    throw new DispatchRefused("bad-cwd", `No such folder: ${input}`);
  }
  if (!isDir) throw new DispatchRefused("bad-cwd", `${input} is not a folder`);
  return dir;
}

const sameName = (accounts: Account[], name: string) => {
  const key = name.trim().toLocaleLowerCase();
  return accounts.filter((a) => a.name.trim().toLocaleLowerCase() === key);
};

/** Asks again for stale quota of the accounts that could take this run; a failed ask leaves the old numbers. */
async function refreshCandidates(deps: DispatchDeps, fetch: UsageFetch, req: DispatchRequest, cwd: string, limits: Limits): Promise<void> {
  const { repos } = deps;
  try {
    let accounts = repos.accounts.list();
    if (req.account !== undefined) {
      const named = sameName(accounts, req.account);
      accounts = named.length === 1 ? named : []; // an unknown or ambiguous name is refused later, in order
    }
    const eligible = accounts.filter(
      (a) => a.accepting && repos.status.get(a.id)?.connection?.state !== "not-logged-in" && folderAllowed(a, cwd),
    );
    await refreshStale(repos, fetch, eligible, limits.quotaStaleMs, deps.now);
  } catch {
    // only means older numbers; the run's note says so
  }
}

interface Claim {
  run: Run;
  account: Account;
  plan: WorkerPlan;
}

/** Runs inside `repos.tx`: the caps, the choice and the new run row are one atomic step. */
function claim(deps: DispatchDeps, req: DispatchRequest, cwd: string, limits: Limits): Claim {
  const { repos } = deps;
  const now = deps.now();
  sweepDeadRuns(repos, now, deps.ps);
  const running = repos.runs.running();
  if (running.length >= limits.maxConcurrent) {
    throw new DispatchRefused("too-many", `Runs in progress: ${running.length}, maximum ${limits.maxConcurrent} at once`);
  }
  const lastHour = repos.runs.countSince(now - HOUR_MS);
  if (lastHour >= limits.maxRunsPerHour) {
    throw new DispatchRefused("too-fast", `Runs delegated in the last 60 minutes: ${lastHour}, maximum ${limits.maxRunsPerHour}`);
  }

  const accounts = repos.accounts.list();
  const forced = req.account === undefined ? undefined : forcedAccount(accounts, req.account);
  const plans = new Map<string, WorkerPlan>();
  const cands: Candidate[] = accounts.map((account) => {
    const plan = planWorker(repos, account.id, cwd, limits, now, req.fresh === true);
    plans.set(account.id, plan);
    return {
      account,
      status: repos.status.get(account.id),
      running: running.filter((r) => r.accountId === account.id).length,
      warm: plan.resume !== undefined,
    };
  });
  const sel = selectAccount(cands, cwd, limits, now, forced?.id);
  if (!sel.ok) {
    const msg = forced ? `Account ${forced.name} cannot take this run` : "No account can take this run";
    throw new DispatchRefused("no-account", msg, sel.exclusions);
  }

  const plan = plans.get(sel.account.id)!;
  const status = cands.find((c) => c.account.id === sel.account.id)?.status;
  const run = repos.runs.insert({
    prompt: req.prompt,
    label: req.label,
    cwd,
    accountId: sel.account.id,
    // A resumed session is linked from the start, so a crash still leaves the worker's session on the row.
    sessionId: plan.resume,
    primaryWorker: plan.primaryWorker,
    readOnly: req.readOnly === true,
    status: "running",
    note: joinNotes(sel.note ?? quotaNote(status, limits, now), folderNote(running, cwd)),
    pid: deps.pid,
    pidStart: deps.pidStart,
    retryOf: req.retryOf,
    createdAt: now,
  });
  return { run, account: sel.account, plan };
}

function forcedAccount(accounts: Account[], name: string): Account {
  const named = sameName(accounts, name);
  if (named.length === 0) throw new DispatchRefused("unknown-account", `No account named "${name.trim()}"`);
  if (named.length > 1) {
    throw new DispatchRefused("unknown-account", `Several accounts are named "${name.trim()}", cannot tell which to use`);
  }
  return named[0]!;
}

/**
 * No folder lock, only a warning. Two workers in one folder may edit the same files; the caller (and the
 * owner, in the app) learns it from the run's note.
 */
function folderNote(running: Run[], cwd: string): string | undefined {
  const ids = running.filter((r) => r.cwd === cwd).map((r) => `#${r.id}`);
  return ids.length === 0 ? undefined : `Also running in this folder: ${ids.join(", ")}`;
}

function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const present = notes.filter((n): n is string => Boolean(n));
  return present.length === 0 ? undefined : present.join(" · ");
}

const NO_NUMBERS = "No quota numbers for this account"; // same words as selectAccount's note

/** Set when the chosen account has no numbers (e.g. --account), or its numbers could not be refreshed in time. */
function quotaNote(s: AccountStatus | undefined, limits: Limits, now: number): string | undefined {
  if (!s || usedPct(s) === undefined) return NO_NUMBERS;
  if (s.quotaAt === undefined) return "Using old quota numbers, age unknown";
  if (now - s.quotaAt <= limits.quotaStaleMs) return undefined;
  const d = new Date(s.quotaAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return `Using old quota numbers from ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Writes the outcome, and what it says about the account, in one transaction. */
function recordOutcome(deps: DispatchDeps, runId: number, accountId: string, out: ClaudeOutcome): void {
  const { repos } = deps;
  const now = deps.now();
  const sessionId = out.sessionId || undefined; // undefined keeps a resumed session's id
  repos.tx(() => {
    switch (out.kind) {
      case "done": {
        const { result, denials, inputTokens, outputTokens, contextTokens } = out;
        repos.runs.update(runId, { status: "done", result, denials, inputTokens, outputTokens, contextTokens, sessionId, finishedAt: now });
        break;
      }
      case "limited":
        repos.runs.update(runId, { status: "limited", error: out.message, sessionId, finishedAt: now });
        markLimited(repos, accountId, out.message, now);
        break;
      case "failed":
        repos.runs.update(runId, { status: "failed", error: out.error, sessionId, finishedAt: now });
        if (/not logged in/i.test(out.error)) {
          // Read now, not before the run: the poller or the app may have written this status meanwhile.
          const current = repos.status.get(accountId) ?? { accountId };
          repos.status.set({ ...current, connection: { state: "not-logged-in", detail: cut(out.error, DETAIL_CAP), checkedAt: now } });
        }
        break;
      case "stopped":
        repos.runs.update(runId, { status: "stopped", sessionId, finishedAt: now });
        break;
    }
  });
}

function recordCrash(deps: DispatchDeps, run: Run, e: unknown): void {
  const error = `Error while delegating: ${e instanceof Error ? e.message : String(e)}`;
  try {
    deps.repos.runs.update(run.id, { status: "failed", error, finishedAt: deps.now() });
  } catch {
    // the store itself is failing; the row is swept as failed once this process is gone
  }
}
