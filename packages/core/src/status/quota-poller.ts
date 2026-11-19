import type { Repos } from "../store/repos.js";
import type { Account, AccountLimit, AccountStatus } from "../types.js";
import { parseLimitMessage, quotaFromUsageResponse } from "./quota.js";
import type { UsageFetch } from "./usage-fetcher.js";

export { type UsageFetch } from "./usage-fetcher.js";

export const POLL_INTERVAL_MS = 60_000;
export const POLL_TIMEOUT_MS = 15_000;
/** An account whose ask failed (e.g. not logged in) is asked again by the poller only after this long. */
export const POLL_BACKOFF_MS = 5 * 60_000;
const ERROR_CAP = 120;

const TIMEOUT = Symbol("timeout");
const CANCELLED = Symbol("cancelled");

const WINDOWS = ["fiveHour", "sevenDay", "models"] as const;

/**
 * Asks one account for its plan quota and stores the answer in `repos.status`. Never throws for a failed or hung ask:
 * the error goes to `pollError` (numbers from before are kept) and the stored status is returned. `signal` abandons
 * the ask (and aborts the one passed to `fetch`) without storing anything.
 *
 * Limit bookkeeping: a full window in the answer sets `limit`. An answer with no full window removes a limit that came
 * from a full window (its `at` equals `quotaAt`: only a poll writes both), or one with no `until` or whose `until` has
 * passed. A limit set by `markLimited` with a future `until` stays: the run's own error is stronger evidence than a poll.
 */
export async function refreshQuota(repos: Repos, fetch: UsageFetch, a: Account, now: () => number = Date.now, signal?: AbortSignal): Promise<AccountStatus> {
  const current = () => repos.status.get(a.id) ?? { accountId: a.id };
  if (signal?.aborted) return current();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCancel: (() => void) | undefined;
  const gate = new Promise<typeof TIMEOUT | typeof CANCELLED>((resolve) => {
    timer = setTimeout(() => (ac.abort(), resolve(TIMEOUT)), POLL_TIMEOUT_MS);
    onCancel = () => (ac.abort(), resolve(CANCELLED));
    signal?.addEventListener("abort", onCancel, { once: true });
  });
  let res: unknown;
  let error: string | undefined;
  try {
    const out = await Promise.race([fetch(a, ac.signal), gate]);
    if (out === CANCELLED) return current();
    if (out === TIMEOUT) error = "Could not get quota: timed out";
    else res = out;
  } catch (e) {
    error = `Could not get quota: ${(e instanceof Error ? e.message : String(e)).slice(0, ERROR_CAP)}`;
  } finally {
    clearTimeout(timer);
    if (onCancel) signal?.removeEventListener("abort", onCancel);
    ac.abort(); // harmless once the ask is over; a timeout or a cancel has already ended the Claude process
  }
  if (signal?.aborted) return current();

  const snap = error ? null : quotaFromUsageResponse(res);
  // An answer with no readable window (the experimental API changed shape) proves nothing about the account.
  const unreadable = snap && !snap.fiveHour && !snap.sevenDay && !snap.models && !snap.blocked;
  const at = now();
  // Re-read, merge and write in one transaction: a limit or a connection another process (a run, the app) committed
  // while the ask was out must not be overwritten by the status read before it.
  return repos.tx(() => {
    const status = current();
    if (!snap || unreadable) {
      const pollError = error ?? (snap ? "Could not read the quota numbers" : "The account has no quota numbers (not logged in?)");
      return save(repos, { ...status, pollError, pollErrorAt: at });
    }

    const { pollError: _, pollErrorAt: _e, fiveHour: _5, sevenDay: _7, models: _m, ...rest } = status;
    const next: AccountStatus = {
      ...rest,
      ...(snap.fiveHour ? { fiveHour: snap.fiveHour } : {}),
      ...(snap.sevenDay ? { sevenDay: snap.sevenDay } : {}),
      ...(snap.models ? { models: snap.models } : {}),
      quotaAt: at,
    };
    if (snap.blocked) {
      const { message, model, until } = snap.blocked;
      next.limit = { message, ...(model ? { model } : {}), ...(until !== undefined ? { until } : {}), at };
    } else if (next.limit && (next.limit.at === status.quotaAt || next.limit.until === undefined || next.limit.until <= at)) {
      delete next.limit;
    }
    // A login made outside the app shows up here before anyone re-checks the connection.
    if (next.connection?.state === "not-logged-in") next.connection = { state: "connected", checkedAt: at };
    return save(repos, next);
  });
}

/**
 * Refreshes, one after another (each ask starts a Claude process), the accounts whose quota is older than `staleMs`.
 * An account whose last ask failed less than `POLL_BACKOFF_MS` ago is skipped, so a broken account does not slow
 * every caller down; its old numbers stay.
 */
export async function refreshStale(repos: Repos, fetch: UsageFetch, accounts: Account[], staleMs: number, now: () => number = Date.now): Promise<void> {
  for (const a of accounts) {
    const s = repos.status.get(a.id);
    const t = now();
    if (s?.pollErrorAt !== undefined && t - s.pollErrorAt < POLL_BACKOFF_MS) continue;
    if (s?.quotaAt === undefined || t - s.quotaAt > staleMs) await refreshQuota(repos, fetch, a, now);
  }
}

/** Marks the account blocked after a run hit a limit; `until` from the text, else the latest reset among full windows. */
export function markLimited(repos: Repos, accountId: string, message: string, now: number): void {
  const status: AccountStatus = repos.status.get(accountId) ?? { accountId };
  const parsed = parseLimitMessage(message, now);
  let until = parsed.until;
  if (until === undefined) {
    const full = [status.fiveHour, status.sevenDay, ...(status.models ?? [])].flatMap((w) => (w && w.usedPct >= 100 && w.resetsAt !== undefined ? [w.resetsAt] : []));
    if (full.length) until = Math.max(...full);
  }
  const limit: AccountLimit = { message: message.slice(0, ERROR_CAP), ...(parsed.model ? { model: parsed.model } : {}), ...(until !== undefined ? { until } : {}), at: now };
  repos.status.set({ ...status, limit });
}

/**
 * Refreshes every account's quota on a timer (for the app). The account list is read on every tick, so accounts added
 * later are picked up. An account whose ask failed is skipped for `POLL_BACKOFF_MS`.
 */
export class QuotaPoller {
  private readonly nextPollAt = new Map<string, number>();
  private loop?: ReturnType<typeof setTimeout>;
  /** Aborts the ask in flight (its Claude process is closed). */
  private inFlight?: AbortController;
  private started = false;
  private stopped = false;

  constructor(
    private readonly repos: Repos,
    private readonly fetch: UsageFetch,
  ) {}

  /** Polls now, then every `intervalMs`. Does nothing after `stop()` or when already started. */
  start(intervalMs = POLL_INTERVAL_MS): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const tick = async () => {
      await this.pollOnce();
      if (!this.stopped) {
        this.loop = setTimeout(() => void tick(), intervalMs);
        (this.loop as { unref?: () => void }).unref?.();
      }
    };
    void tick();
  }

  /** Aborts the ask in flight and prevents further ticks. */
  stop(): void {
    this.stopped = true;
    this.inFlight?.abort();
    if (this.loop) clearTimeout(this.loop);
    this.loop = undefined;
  }

  private async pollOnce(): Promise<void> {
    for (const a of this.repos.accounts.list()) {
      if (this.stopped) return;
      if ((this.nextPollAt.get(a.id) ?? 0) > Date.now()) continue;
      const ac = new AbortController();
      this.inFlight = ac;
      try {
        const res = await refreshQuota(this.repos, this.fetch, a, Date.now, ac.signal);
        if (ac.signal.aborted) return;
        if (res.pollError) this.nextPollAt.set(a.id, Date.now() + POLL_BACKOFF_MS);
        else this.nextPollAt.delete(a.id);
      } catch {
        // the store failed (e.g. locked): try again next tick rather than end the loop
      } finally {
        if (this.inFlight === ac) this.inFlight = undefined;
      }
    }
  }
}

function save(repos: Repos, s: AccountStatus): AccountStatus {
  repos.status.set(s);
  return s;
}
