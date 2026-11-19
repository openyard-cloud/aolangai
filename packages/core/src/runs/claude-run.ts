import { spawn, type ChildProcess } from "node:child_process";
import { NEST_ENV, childEnv } from "../accounts/env.js";
import type { Account } from "../types.js";
import { createStreamReader } from "./claude-stream.js";

export const DEFAULT_PERMISSION_MODE = "acceptEdits"; // edits allowed, shell only by the account's settings.json rules
export const READ_ONLY_ARGS = ["--disallowedTools", "Edit Write NotebookEdit Bash"]; // one argv element for the tool list
export { NEST_ENV };

export interface ClaudeRunRequest {
  claudePath: string;
  account: Account;
  cwd: string;
  prompt: string;
  runId: number;
  resume?: string;
  readOnly?: boolean;
  timeoutMs: number;
  onEvent?(e: { kind: "tool" | "text"; text: string }): void;
  signal?: AbortSignal;
  /** Called once with the claude process's pid (it leads its own process group) as soon as it exists. */
  onSpawn?(pid: number): void;
  /** How long after SIGTERM before SIGKILL. Default 5000; mainly for tests. */
  killGraceMs?: number;
  /** How long to wait for stdout to close after claude exits. Default 2000; mainly for tests. */
  closeGraceMs?: number;
  /**
   * Starts the run's timeout (`onTimeout` after `ms`) and returns how to cancel it. Default: setTimeout. Tests pass
   * their own so the time runs out when they choose, not while the process is still starting.
   */
  startTimeout?(onTimeout: () => void, ms: number): () => void;
}

export type ClaudeOutcome =
  | { kind: "done"; result: string; sessionId: string; denials: string[]; inputTokens?: number; outputTokens?: number; contextTokens?: number }
  | { kind: "limited"; message: string; sessionId?: string }
  | { kind: "failed"; error: string; sessionId?: string }
  | { kind: "stopped"; sessionId?: string };

export const KILL_GRACE_MS = 5_000;
/** After claude exits, wait this long for its stdout to close before reading on without it (a leaked child may hold it). */
export const CLOSE_GRACE_MS = 2_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const STDERR_KEEP = 4_000;
const STDERR_SHOWN = 500;

/** argv after the executable; the prompt is NOT in argv (it goes to stdin). */
export function claudeArgs(r: Pick<ClaudeRunRequest, "account" | "resume" | "readOnly">): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (r.resume) args.push("--resume", r.resume);
  if (r.account.model) args.push("--model", r.account.model);
  if (r.readOnly) args.push(...READ_ONLY_ARGS);
  else args.push("--permission-mode", r.account.permissionMode || DEFAULT_PERMISSION_MODE);
  return args;
}

/** `childEnv` plus this run's id, which also tells the worker it must not dispatch. */
export function claudeEnv(base: NodeJS.ProcessEnv, account: Account, runId: number): Record<string, string> {
  return { ...childEnv(base, account), [NEST_ENV]: String(runId) };
}

/** A run whose claude does not use the login of the account's config dir: its work is billed elsewhere. */
export function foreignLoginMessage(source: string): string {
  return `The worker is not running with this account's login (apiKeySource: ${source}). Check apiKeyHelper or the env section of that account's settings.json.`;
}

export function timeoutMessage(timeoutMs: number): string {
  const minutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
  return `Timed out after ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** What a finished claude process said, as `decideOutcome` needs it. */
export interface OutcomeFacts {
  /** The process never ran (ENOENT, bad cwd). */
  spawnError?: string;
  /** The init line named a key source other than the account's login. */
  foreignKeySource?: string;
  /** What the result line said, if one arrived. */
  result?: Extract<ClaudeOutcome, { kind: "done" | "limited" | "failed" }>;
  sessionId?: string;
  /** Why we stopped the process, if we did. */
  stopReason?: "timeout" | "abort" | "foreign-login";
  stderrTail: string;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  timeoutMs: number;
}

/**
 * The outcome of a run, by precedence: a process that never ran; a run on another login (whatever it printed was
 * billed elsewhere); a limit result already received (it is what matters for the account, even if a stop cut the run
 * short); a stop, unless a done result was already received; any other result; else stderr or how claude ended.
 */
export function decideOutcome(f: OutcomeFacts): ClaudeOutcome {
  const { sessionId, result: res } = f;
  if (f.spawnError !== undefined) return { kind: "failed", error: `Could not run the claude command: ${f.spawnError}` };
  if (f.foreignKeySource !== undefined) return { kind: "failed", error: foreignLoginMessage(f.foreignKeySource), sessionId };
  if (res?.kind === "limited") return res;
  if (f.stopReason && res?.kind !== "done") {
    return f.stopReason === "abort" ? { kind: "stopped", sessionId } : { kind: "failed", error: timeoutMessage(f.timeoutMs), sessionId };
  }
  if (res) return res;
  const tail = f.stderrTail.trim().slice(-STDERR_SHOWN);
  if (tail) return { kind: "failed", error: tail, sessionId };
  const how = f.exit?.code == null ? `was stopped by signal ${f.exit?.signal ?? "unknown"}` : `exited with code ${f.exit.code}`;
  return { kind: "failed", error: `claude ${how} without returning a result`, sessionId };
}

function startTimer(onTimeout: () => void, ms: number): () => void {
  const t = setTimeout(onTimeout, ms);
  return () => clearTimeout(t);
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs `claude -p` for one account in one folder. Never rejects: every failure is a `failed` outcome. */
export async function runClaude(r: ClaudeRunRequest): Promise<ClaudeOutcome> {
  try {
    if (r.signal?.aborted) return { kind: "stopped" };
    return await supervise(r);
  } catch (e) {
    return { kind: "failed", error: `Could not run the claude command: ${reason(e)}` };
  }
}

function supervise(r: ClaudeRunRequest): Promise<ClaudeOutcome> {
  return new Promise((resolve) => {
    const reader = createStreamReader(r.onEvent);
    let child: ChildProcess;
    try {
      // No shell; its own process group, so a kill reaches whatever claude started.
      child = spawn(r.claudePath, claudeArgs(r), {
        cwd: r.cwd,
        env: claudeEnv(process.env, r.account, r.runId),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ kind: "failed", error: `Could not run the claude command: ${reason(e)}` });
      return;
    }
    if (child.pid !== undefined) {
      try {
        r.onSpawn?.(child.pid);
      } catch {
        // bookkeeping only; the run goes on
      }
    }

    let stopReason: "timeout" | "abort" | "foreign-login" | undefined;
    let spawnError: string | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let stderrTail = "";
    let buffer = "";
    let settled = false;
    let cancelTimeout: (() => void) | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    const stop = (why: NonNullable<typeof stopReason>) => {
      if (stopReason || settled || exit) return;
      stopReason = why;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), r.killGraceMs ?? KILL_GRACE_MS);
    };
    const onAbort = () => stop("abort");

    function finish(): void {
      if (settled) return;
      settled = true;
      cancelTimeout?.();
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      r.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.removeAllListeners();
      child.on("error", () => {}); // a late error after we are done must not crash the process
      if (stopReason) killGroup("SIGKILL"); // stragglers of the group that ignored SIGTERM
      if (buffer && reader.foreignKeySource() === undefined) reader.feed(buffer);
      resolve(outcome());
    }

    function outcome(): ClaudeOutcome {
      return decideOutcome({
        spawnError,
        foreignKeySource: reader.foreignKeySource(),
        result: reader.result(),
        sessionId: reader.sessionId(),
        stopReason,
        stderrTail,
        exit,
        timeoutMs: r.timeoutMs,
      });
    }

    child.on("error", (e) => {
      // Before a pid exists this is a spawn failure (ENOENT, bad cwd); the process never ran.
      if (child.pid === undefined) {
        spawnError = reason(e);
        finish();
      }
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      clearTimeout(killTimer);
      closeTimer = setTimeout(finish, r.closeGraceMs ?? CLOSE_GRACE_MS);
    });
    child.on("close", () => finish());

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        // Once the init line showed another login, nothing after it is read (or shown as progress).
        if (reader.foreignKeySource() === undefined) reader.feed(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      if (reader.foreignKeySource() !== undefined) {
        buffer = "";
        stop("foreign-login");
      }
    });
    child.stdout?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP);
    });
    child.stderr?.on("error", () => {});

    // The prompt goes to stdin, never argv; closing stdin is what tells claude the prompt is complete.
    child.stdin?.on("error", () => {}); // EPIPE when claude exits without reading it
    child.stdin?.end(r.prompt, "utf8");

    cancelTimeout = (r.startTimeout ?? startTimer)(() => stop("timeout"), Math.min(Math.max(r.timeoutMs, 1), MAX_TIMER_MS));
    if (r.signal) {
      if (r.signal.aborted) stop("abort");
      else r.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
