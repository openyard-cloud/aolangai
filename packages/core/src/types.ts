/** A Claude subscription account the dispatcher can run work on. */
export interface Account {
  id: string;
  name: string;
  /** Empty = the default ~/.claude. */
  configDir?: string;
  model?: string;
  /** Takes delegated work. New accounts start false. */
  accepting: boolean;
  /** Folders (and below) it may work in; empty = anywhere. */
  allowedDirs: string[];
  /** Stops taking new work when its used % is at or above this. */
  reservePct: number; // default 90
  /** Passed as --permission-mode; undefined = DEFAULT_PERMISSION_MODE. */
  permissionMode?: string;
}

/** One plan-quota window of an account. Times are ms since epoch. */
export interface QuotaWindow {
  usedPct: number;
  resetsAt?: number;
}
/** The account is blocked (a turn hit a limit, or a window is full) until `until`, if known. */
export interface AccountLimit {
  message: string;
  model?: string;
  until?: number;
  at: number;
}
export type ConnectionState = "not-installed" | "not-logged-in" | "connected" | "error";
export interface ConnectionStatus {
  state: ConnectionState;
  detail?: string;
  checkedAt: number;
}
/** Plan quota, limit state and connection of one account. */
export interface AccountStatus {
  accountId: string;
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  /** Weekly limits per model (e.g. Fable); only the poller reports them. */
  models?: (QuotaWindow & { name: string })[];
  /** When the last quota snapshot arrived (poller or a run). */
  quotaAt?: number;
  /** The last poll failed; numbers are kept from before. */
  pollError?: string;
  /** When the last poll failed; a refresh skips the account for POLL_BACKOFF_MS after it. Cleared by a good answer. */
  pollErrorAt?: number;
  limit?: AccountLimit;
  connection?: ConnectionStatus;
}

export type RunStatus = "running" | "done" | "failed" | "stopped" | "limited";
export interface Run {
  id: number;
  prompt: string;
  label?: string;
  cwd: string;
  accountId: string;
  sessionId?: string;
  primaryWorker: boolean;
  readOnly: boolean;
  status: RunStatus;
  result?: string;
  error?: string;
  denials?: string[];
  note?: string;
  /** The dispatching process (`processStart` of it in pidStart). */
  pid?: number;
  pidStart?: string;
  /** The claude process, leader of its own process group; killed by a sweep when its dispatcher is gone. */
  workerPid?: number;
  workerPidStart?: string;
  retryOf?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  createdAt: number;
  finishedAt?: number;
}
export interface RunEvent {
  id: number;
  runId: number;
  kind: "tool" | "text";
  text: string;
  createdAt: number;
}

export interface Limits {
  maxConcurrent: number;
  runTimeoutMs: number;
  maxRunsPerHour: number;
  quotaStaleMs: number;
  warmBonusPts: number;
  inFlightPenaltyPts: number;
  workerIdleMs: number;
  workerMaxContextTokens: number;
}
export const DEFAULT_LIMITS: Limits = {
  maxConcurrent: 4,
  runTimeoutMs: 30 * 60_000,
  maxRunsPerHour: 30,
  quotaStaleMs: 120_000,
  warmBonusPts: 15,
  inFlightPenaltyPts: 5,
  workerIdleMs: 60 * 60_000,
  workerMaxContextTokens: 100_000,
};
