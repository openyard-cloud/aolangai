import type { Repos } from "../store/repos.js";
import type { Limits } from "../types.js";

/** How a new run on (account, cwd) uses the folder's worker session. */
export interface WorkerPlan {
  /** Session to resume; undefined = a new session. */
  resume?: string;
  primaryWorker: boolean;
}

/**
 * While a primary run of (account, cwd) is running (with or without a session id yet), a new run gets a side
 * session that does not replace it. Otherwise the newest primary with a session is reused when it finished `done` less
 * than `workerIdleMs` ago and its context is below `workerMaxContextTokens` (unknown context counts as small). A
 * failed, stopped, limited or lost primary is never resumed: its claude may still hold the session, or the session is
 * in an unknown state. Anything else, and `fresh`, opens a new session that becomes the primary.
 *
 * Both choosing an account (`warm`) and starting the run use this, so they cannot disagree. Call it inside the
 * dispatch transaction, after dead runs were swept, so "running" is current.
 */
export function planWorker(repos: Repos, accountId: string, cwd: string, limits: Limits, now: number, fresh: boolean): WorkerPlan {
  if (repos.runs.runningPrimary(accountId, cwd)) return { primaryWorker: false };
  if (fresh) return { primaryWorker: true };
  const last = repos.runs.lastPrimary(accountId, cwd);
  if (last?.status !== "done" || !last.sessionId || last.finishedAt === undefined) return { primaryWorker: true };
  const idle = now - last.finishedAt < limits.workerIdleMs;
  const small = last.contextTokens === undefined || last.contextTokens < limits.workerMaxContextTokens;
  return idle && small ? { resume: last.sessionId, primaryWorker: true } : { primaryWorker: true };
}
