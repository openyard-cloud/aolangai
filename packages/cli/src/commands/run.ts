import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_NOT_FOUND,
  DispatchRefused,
  createUsageFetcher,
  dispatch,
  findExecutable,
  processStart,
  usedPct,
  type DispatchRequest,
  type Repos,
  type Run,
  type UsageFetch,
} from "@aolangai/core";
import type { Io } from "../io.js";
import { PREFIX, doneStdout, failedLine, failoverLine, limitedLine, refusalLines, startLine, stoppedLine } from "../output.js";

export interface RunOptions {
  prompt: string;
  fromStdin: boolean;
  cwd?: string;
  label?: string;
  account?: string;
  fresh: boolean;
  readOnly: boolean;
  retryOf?: number;
  /** Move a run that hits its account's limit to another account. Off with --no-failover; never with --account. */
  failover: boolean;
}

/** How many times one task moves to another account after a limit. */
export const MAX_FAILOVERS = 2;

/**
 * What the worker on the next account reads before the task. It starts a new session: the files are all it gets
 * from the run that stopped.
 */
export const FAILOVER_PREAMBLE =
  "This task was started by another worker, on another account, which hit its usage limit before it finished. " +
  "This folder may already hold part of that work. Look at its current state first (for example `git status` and " +
  "`git diff`), keep what is done and correct, and finish the rest.\n\n---\n\n";

export interface RunContext {
  repos: Repos;
  io: Io;
  env: NodeJS.ProcessEnv;
  /** The database file; the quota probe folder lives next to it. */
  dbFile: string;
  readStdin(): Promise<string>;
}

export interface IdentityDeps {
  read(pid: number): string | undefined;
  sleep(ms: number): Promise<void>;
}

/**
 * This process's start time as `ps` prints it, recorded on the run so others can tell it is still alive. `ps` may
 * not answer under load: one retry after 200 ms; never an empty value.
 */
export async function ownProcessStart(pid: number, d: IdentityDeps = { read: (p) => processStart(p), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }): Promise<string | undefined> {
  const first = d.read(pid);
  if (first) return first;
  await d.sleep(200);
  return d.read(pid) || undefined;
}

/**
 * TEST ONLY (AOLANGAI_TEST_QUOTA_HANG=<file>): a quota ask that never answers, so a test can send a signal while dispatch
 * is still refreshing quota, without starting the Agent SDK. It touches <file> when the ask begins and rejects when aborted.
 */
function hangingAsk(marker: string): UsageFetch {
  return (_account, signal) =>
    new Promise((_resolve, reject) => {
      fs.writeFileSync(marker, "asking");
      const fail = () => reject(new Error("The quota check was cancelled"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Exit code of `aolangai run`. */
export async function runCommand(o: RunOptions, c: RunContext): Promise<number> {
  const { repos, io } = c;
  const prompt = o.fromStdin ? await c.readStdin() : o.prompt;
  if (prompt.trim() === "") {
    io.err(`${PREFIX}The prompt is empty\n`);
    return 2;
  }
  const claudePath = findExecutable("claude");
  if (!claudePath) {
    io.err(`${PREFIX}${CLAUDE_NOT_FOUND}\n`);
    return 2;
  }
  const pidStart = await ownProcessStart(process.pid);
  if (!pidStart) {
    io.err(`${PREFIX}Could not read this command's own process info (ps)\n`);
    return 2;
  }

  // From here a signal means "stop the run": the handlers stay until we exit, so a second signal while the run is
  // being stopped cannot kill us before its row is recorded.
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  for (const s of SIGNALS) process.on(s, onSignal);

  let fetch: UsageFetch | undefined;
  if (c.env.AOLANGAI_NO_QUOTA_REFRESH !== "1") {
    const ask = c.env.AOLANGAI_TEST_QUOTA_HANG ? hangingAsk(c.env.AOLANGAI_TEST_QUOTA_HANG) : createUsageFetcher({ claudePath, cwd: path.join(path.dirname(c.dbFile), "quota-probe") });
    fetch = (a, signal) => ask(a, AbortSignal.any([signal, abort.signal]));
  }

  const attempt = (over: Partial<DispatchRequest>) =>
    dispatch(
      {
        repos,
        claudePath,
        ...(fetch ? { fetch } : {}),
        env: c.env,
        now: Date.now,
        pid: process.pid,
        pidStart,
        signal: abort.signal,
        onStart: (r, account) => {
          try {
            io.err(startLine({ runId: r.id, accountName: account.name, sessionId: r.sessionId, note: r.note }) + "\n");
          } catch {
            // the notice is only for the caller; the run goes on
          }
        },
      },
      { prompt, cwd: o.cwd ?? process.cwd(), label: o.label || undefined, account: o.account, fresh: o.fresh, readOnly: o.readOnly, retryOf: o.retryOf, ...over },
    );
  const refused = (e: unknown) => {
    if (!(e instanceof DispatchRefused)) throw e;
    const detail = (id: string) => ({ usedPct: usedPct(repos.status.get(id)), reservePct: repos.accounts.get(id)?.reservePct ?? 90 });
    io.err(refusalLines(e.code, e.message, e.exclusions, detail, repos.settings.getLimits(), Date.now()).join("\n") + "\n");
  };
  const accountName = (r: Run) => repos.accounts.get(r.accountId)?.name ?? r.accountId;

  let run: Run;
  try {
    run = await attempt({});
  } catch (e) {
    refused(e);
    return 2;
  }

  // The account that hit its limit is now marked limited, so the next choice leaves it out. The new run is a retry
  // of the one that stopped, in a new session, and the app takes the stopped one out of Needs you.
  const failover = o.failover && o.account === undefined;
  for (let moves = 0; failover && run.status === "limited" && moves < MAX_FAILOVERS && !abort.signal.aborted; moves++) {
    io.err(failoverLine(run.id, accountName(run)) + "\n");
    try {
      run = await attempt({ retryOf: run.id, fresh: true, preamble: FAILOVER_PREAMBLE });
    } catch (e) {
      refused(e);
      io.err(limitedLine(run.id, accountName(run)) + "\n");
      return 3;
    }
  }

  switch (run.status) {
    case "done":
      io.out(doneStdout(run.result, run.denials));
      return 0;
    case "limited":
      io.err(limitedLine(run.id, accountName(run)) + "\n");
      return 3;
    case "stopped":
      io.err(stoppedLine(run.id) + "\n");
      return 130;
    case "failed":
      io.err(failedLine(run.id, run.error ?? "unknown cause") + "\n");
      return 1;
    default:
      io.err(failedLine(run.id, "could not read the result back from the store") + "\n");
      return 1;
  }
}
