// What the main screen shows, decided without React: every function here is pure and unit-tested.
import type { Account, AccountStatus, Run, RunEvent } from "@aolangai/core";
import type { AppState, OpenSession } from "../../shared/api.js";
import { clock } from "./format.js";
import { usedPct } from "./quota.js";

export interface Lane {
  account: Account;
  status?: AccountStatus;
  mode: "Accepting work" | "Watch only";
  running: Run[];
  recent: Run[];
  /** Open sessions whose accountId is this account, oldest first. */
  sessions: OpenSession[];
}

const RECENT_PER_LANE = 5;
const ATTENTION_WINDOW_MS = 24 * 60 * 60_000;

/** One lane per account, accepting accounts first then by name; `recent` = the 5 newest finished runs. */
export function lanes(s: AppState): Lane[] {
  const statusOf = new Map(s.statuses.map((x) => [x.accountId, x]));
  const accounts = [...s.accounts].sort((a, b) => Number(b.accepting) - Number(a.accepting) || a.name.localeCompare(b.name));
  return accounts.map((account) => {
    const mine = s.runs.filter((r) => r.accountId === account.id);
    const finished = mine.filter((r) => r.status !== "running").sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
    return {
      account,
      status: statusOf.get(account.id),
      mode: account.accepting ? "Accepting work" : "Watch only",
      running: mine.filter((r) => r.status === "running").sort((a, b) => b.createdAt - a.createdAt),
      recent: finished.slice(0, RECENT_PER_LANE),
      sessions: s.sessions.filter((x) => x.accountId === account.id),
    };
  });
}

export type Attention =
  | { kind: "failed" | "limited" | "denied"; run: Run }
  | { kind: "reserve"; account: Account; usedPct: number };

/** Newest first (the order of `s.runs`). Failed, limited and denied runs of the last 24 hours that have no later retry, plus accounts over their reserve. */
export function needsYou(s: AppState, now: number): Attention[] {
  const retried = new Set(s.runs.flatMap((r) => (r.retryOf === undefined ? [] : [r.retryOf])));
  const out: Attention[] = [];
  for (const run of s.runs) {
    if (retried.has(run.id) || now - (run.finishedAt ?? run.createdAt) > ATTENTION_WINDOW_MS) continue;
    if (run.status === "failed" || run.status === "limited") out.push({ kind: run.status, run });
    else if (run.status === "done" && (run.denials?.length ?? 0) > 0) out.push({ kind: "denied", run });
  }
  for (const account of s.accounts) {
    const used = usedPct(s.statuses.find((x) => x.accountId === account.id));
    if (used !== undefined && used >= account.reservePct) out.push({ kind: "reserve", account, usedPct: used });
  }
  return out;
}

/**
 * Whether "Open in Terminal" is offered: the run has a session and no running run (itself included) is on that
 * session, since a Terminal and a worker on one session would both write to it. The main process checks the same.
 */
export function canOpenTerminal(r: Run, runs: Run[]): boolean {
  if (!r.sessionId || r.status === "running") return false;
  return !runs.some((x) => x.status === "running" && x.sessionId === r.sessionId);
}

/** The label, else the first 60 characters of the prompt on one line. */
export function runTitle(r: Run): string {
  const label = r.label?.trim();
  return label ? label : r.prompt.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** "40 s", "3 min", "1 h 5 min"; a running run counts up to `now`. */
export function duration(r: Run, now: number): string {
  const seconds = Math.max(0, Math.floor(((r.finishedAt ?? now) - r.createdAt) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

const STATUS_LABEL = { running: "running", done: "done", failed: "failed", stopped: "stopped", limited: "limited" } as const;
export function statusLabel(r: Run): string {
  const label = STATUS_LABEL[r.status];
  return r.status === "done" && (r.denials?.length ?? 0) > 0 ? `${label} · permission denied` : label;
}

const STEP_MAX = 120;
/** The newest step of a run as one short line; undefined when it has none yet. */
export function latestStep(events: RunEvent[]): string | undefined {
  const last = events[events.length - 1];
  if (!last) return undefined;
  const line = last.text.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  return line.length > STEP_MAX ? `${line.slice(0, STEP_MAX - 1)}…` : line;
}

const reserveText = (used: number, reservePct: number) => `used ${Math.round(used)}%, over the reserve of ${reservePct}%`;
/** The lane's own warning when the account is over its reserve; null otherwise. */
export function reserveWarning(a: Account, status: AccountStatus | undefined): string | null {
  const used = usedPct(status);
  return used !== undefined && used >= a.reservePct ? reserveText(used, a.reservePct) : null;
}

/** One line of the needs-you list. */
export function attentionLine(a: Attention, accounts: Account[]): string {
  if (a.kind === "reserve") return `${a.account.name} ${reserveText(a.usedPct, a.account.reservePct)}`;
  const head = `#${a.run.id} ${runTitle(a.run)}`;
  const who = accounts.find((x) => x.id === a.run.accountId)?.name ?? "deleted account";
  const at = clock(a.run.finishedAt ?? a.run.createdAt);
  if (a.kind === "failed") return `${head} · ${who} failed at ${at}`;
  if (a.kind === "limited") return `${head} · ${who} hit its limit at ${at}`;
  return `${head} · permission denied: ${(a.run.denials ?? []).join(", ")}`;
}
