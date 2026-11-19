import { limitedUntil, usedPct, type AccountStatus, type Run } from "@aolangai/core";
import type { AppState } from "../shared/api.js";

export interface Notice {
  title: string;
  body: string;
}

const TITLE = "aolangai";
const ERROR_CAP = 80;

const notice = (body: string): Notice => ({ title: TITLE, body });
const statusOf = (s: AppState, accountId: string): AccountStatus | undefined => s.statuses.find((x) => x.accountId === accountId);

/** What a run newly became. A run already in that state in `prev` was announced before. */
function runNotice(r: Run, was: Run | undefined, next: AppState, limitedSeen: Set<string>): Notice | undefined {
  if (r.status === "failed" && was?.status !== "failed") return notice(`Run #${r.id} failed: ${(r.error ?? "").slice(0, ERROR_CAP)}`.trimEnd());
  if (r.status === "limited" && was?.status !== "limited") {
    if (limitedSeen.has(r.accountId)) return undefined; // several runs of one account hit the same limit: say it once
    limitedSeen.add(r.accountId);
    const name = next.accounts.find((a) => a.id === r.accountId)?.name ?? r.accountId;
    return notice(`Account ${name} hit its limit`);
  }
  const denial = r.denials?.[0];
  if (r.status === "done" && denial !== undefined && !(was?.status === "done" && was.denials?.length)) {
    return notice(`Run #${r.id} finished, permission denied: ${denial}`);
  }
  return undefined;
}

/**
 * Notices for what changed between two states: a run failed, hit a limit or finished with permission
 * denials; an account crossed from below to at-or-above its reserve. Nothing for a normal `done`, for `stopped`,
 * or for anything already true in `prev`. An account whose quota was unknown in `prev` never counts as crossing.
 */
export function noticesFor(prev: AppState, next: AppState): Notice[] {
  const out: Notice[] = [];
  const before = new Map(prev.runs.map((r) => [r.id, r]));
  const limitedSeen = new Set<string>();
  // Oldest first: the order things happened in.
  for (const r of [...next.runs].reverse()) {
    const n = runNotice(r, before.get(r.id), next, limitedSeen);
    if (n) out.push(n);
  }
  for (const a of next.accounts) {
    const was = usedPct(statusOf(prev, a.id));
    const now = usedPct(statusOf(next, a.id));
    if (was !== undefined && now !== undefined && was < a.reservePct && now >= a.reservePct) {
      out.push(notice(`Account ${a.name} has used ${Math.round(now)}%, over the reserve of ${a.reservePct}%`));
    }
  }
  return out;
}

/** The tray title: how many runs are running, nothing at all when none is. */
export function trayTitle(state: AppState): string {
  const running = state.runs.filter((r) => r.status === "running").length;
  return running > 0 ? String(running) : "";
}

const UNKNOWN_LIMIT_MS = 60 * 60_000;
/** One menu line per account: line breaks and tabs in a name become a space. */
const oneLine = (s: string) => s.replace(/\s*[\r\n\t\u2028\u2029]+\s*/g, " ");

/**
 * The quota lines of the tray menu, one per account in `state.accounts` order: `<name>  5h N% · week N% · limited until HH:MM`
 * (`limited until 18 Nov HH:MM` when the limit ends on another day).
 * Same rounding, clock and limit rule as the command's status text; no per-model windows, no running count.
 */
export function trayQuotaLines(state: AppState, now: number): string[] {
  return state.accounts.map((a) => {
    const s = statusOf(state, a.id);
    const limit = s?.limit;
    const limited = limit !== undefined && (limit.until !== undefined ? limit.until > now : now - limit.at < UNKNOWN_LIMIT_MS);
    const parts = [
      s?.fiveHour ? `5h ${Math.round(s.fiveHour.usedPct)}%` : undefined,
      s?.sevenDay ? `week ${Math.round(s.sevenDay.usedPct)}%` : undefined,
      limited ? (limit.until !== undefined ? limitedUntil(limit.until, now) : "limited") : undefined,
    ].filter((x): x is string => x !== undefined);
    return `${oneLine(a.name)}  ${parts.length > 0 ? parts.join(" · ") : "no data yet"}`;
  });
}

/** Feeds states in order; the first one only becomes the baseline (nothing is announced for what was already true). */
export function createNoticeGate(): (state: AppState) => Notice[] {
  let prev: AppState | undefined;
  return (state) => {
    const notices = prev ? noticesFor(prev, state) : [];
    prev = state;
    return notices;
  };
}
