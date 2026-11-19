import type { Account, AccountStatus, Limits } from "../types.js";
import { canonicalPath, isInside } from "../guards/paths.js";
import { expandHome } from "./env.js";

export type ExclusionReason = "off" | "blocked" | "not-logged-in" | "folder" | "reserve";
export interface Exclusion {
  accountId: string;
  name: string;
  reason: ExclusionReason;
  until?: number;
}
export interface Candidate {
  account: Account;
  status?: AccountStatus;
  running: number;
  warm: boolean;
}
export type Selection =
  | { ok: true; account: Account; usedPct?: number; note?: string }
  | { ok: false; exclusions: Exclusion[] };

/** A limit without a known end is assumed to hold for this long after it was seen. */
const UNKNOWN_LIMIT_MS = 60 * 60_000;

/** Largest used % among the windows that have a number; undefined when none has. */
export function usedPct(s: AccountStatus | undefined): number | undefined {
  if (!s) return undefined;
  const nums = [s.fiveHour?.usedPct, s.sevenDay?.usedPct, ...(s.models ?? []).map((m) => m.usedPct)].filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  return nums.length ? Math.max(...nums) : undefined;
}

/** `cwd` and the allowed dirs are compared after canonicalPath; empty list = anywhere. */
export function folderAllowed(a: Account, cwd: string): boolean {
  if (a.allowedDirs.length === 0) return true;
  const dir = canonicalPath(expandHome(cwd));
  return a.allowedDirs.some((d) => isInside(canonicalPath(expandHome(d)), dir));
}

function limitActive(limit: NonNullable<AccountStatus["limit"]>, now: number): boolean {
  return limit.until !== undefined ? limit.until > now : now - limit.at < UNKNOWN_LIMIT_MS;
}

/** The first reason that applies, in this order: off, limited, not logged in, folder, reserve; `skipReserve` is for --account. */
function exclusionOf(c: Candidate, cwd: string, now: number, skipReserve: boolean): Exclusion | undefined {
  const { account, status } = c;
  const base = { accountId: account.id, name: account.name };
  if (!account.accepting) return { ...base, reason: "off" };
  if (status?.limit && limitActive(status.limit, now)) {
    return { ...base, reason: "blocked", ...(status.limit.until !== undefined ? { until: status.limit.until } : {}) };
  }
  if (status?.connection?.state === "not-logged-in") return { ...base, reason: "not-logged-in" };
  if (!folderAllowed(account, cwd)) return { ...base, reason: "folder" };
  const used = usedPct(status);
  if (!skipReserve && used !== undefined && used >= account.reservePct) return { ...base, reason: "reserve" };
  return undefined;
}

interface Ranked {
  cand: Candidate;
  used?: number;
  score?: number;
}

/** Lower is better: fewer running, then name. */
function byRunningThenName(a: Ranked, b: Ranked): number {
  return a.cand.running - b.cand.running || a.cand.account.name.localeCompare(b.cand.account.name);
}
function byScore(a: Ranked, b: Ranked): number {
  return (a.score as number) - (b.score as number) || byRunningThenName(a, b);
}

/** `forced` = id of the account named by --account (the caller resolves the name). */
export function selectAccount(cands: Candidate[], cwd: string, limits: Limits, now: number, forced?: string): Selection {
  if (forced !== undefined) {
    const c = cands.find((x) => x.account.id === forced);
    if (!c) return { ok: false, exclusions: [] };
    const ex = exclusionOf(c, cwd, now, true);
    if (ex) return { ok: false, exclusions: [ex] };
    const used = usedPct(c.status);
    return { ok: true, account: c.account, ...(used !== undefined ? { usedPct: used } : {}) };
  }

  const exclusions: Exclusion[] = [];
  const ranked: Ranked[] = [];
  for (const cand of cands) {
    const ex = exclusionOf(cand, cwd, now, false);
    if (ex) {
      exclusions.push(ex);
      continue;
    }
    const used = usedPct(cand.status);
    ranked.push(used === undefined ? { cand } : { cand, used, score: used + cand.running * limits.inFlightPenaltyPts });
  }
  if (ranked.length === 0) return { ok: false, exclusions };

  const withNumbers = ranked.filter((r) => r.score !== undefined).sort(byScore);
  let best: Ranked;
  if (withNumbers.length > 0) {
    const lowest = withNumbers[0]!.score as number;
    const warm = withNumbers.filter((r) => r.cand.warm && (r.score as number) <= lowest + limits.warmBonusPts);
    best = warm[0] ?? withNumbers[0]!;
  } else {
    best = ranked.sort((a, b) => Number(b.cand.warm) - Number(a.cand.warm) || byRunningThenName(a, b))[0]!;
  }

  return {
    ok: true,
    account: best.cand.account,
    ...(best.used !== undefined ? { usedPct: best.used } : { note: "No quota numbers for this account" }),
  };
}
