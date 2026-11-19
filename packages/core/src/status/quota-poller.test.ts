import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openDb } from "../store/db.js";
import { createRepos, type Repos } from "../store/repos.js";
import type { Account } from "../types.js";
import { POLL_BACKOFF_MS, POLL_TIMEOUT_MS, QuotaPoller, markLimited, refreshQuota, refreshStale, type UsageFetch } from "./quota-poller.js";

const NOW = Date.parse("2026-11-15T10:28:00Z");
// Same shape as the real response used in quota.test.ts.
const RESPONSE = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 15, resets_at: "2026-11-15T12:00:00Z" },
    seven_day: { utilization: 2, resets_at: "2026-11-22T18:00:00Z" },
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-11-22T18:00:00Z" }],
  },
};
const withLimits = (rate_limits: Record<string, unknown>) => ({ ...RESPONSE, rate_limits: { ...RESPONSE.rate_limits, ...rate_limits } });
const FULL_5H = withLimits({ five_hour: { utilization: 100, resets_at: "2026-11-15T12:00:00Z" } });
const FABLE = "You've hit your Fable limit · resets Nov 16 at 1am (Asia/Saigon). Switch to another model to continue.";
const FABLE_UNTIL = Date.parse("2026-11-15T18:00:00Z");

const account = (id: string, p: Partial<Account> = {}): Account => ({ id, name: id.toUpperCase(), accepting: false, allowedDirs: [], reservePct: 90, ...p });

function setup(ids: string[] = ["p"]) {
  const repos = createRepos(openDb(":memory:"));
  for (const id of ids) repos.accounts.insert(account(id));
  return repos;
}
const stored = (repos: Repos, id = "p") => repos.status.get(id);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("refreshQuota", () => {
  test("stores the numbers and when they arrived", async () => {
    const repos = setup();
    const res = await refreshQuota(repos, async () => RESPONSE, account("p"));
    expect(res).toEqual(stored(repos));
    expect(res).toEqual({
      accountId: "p",
      fiveHour: { usedPct: 15, resetsAt: Date.parse("2026-11-15T12:00:00Z") },
      sevenDay: { usedPct: 2, resetsAt: Date.parse("2026-11-22T18:00:00Z") },
      models: [{ name: "Fable", usedPct: 0, resetsAt: Date.parse("2026-11-22T18:00:00Z") }],
      quotaAt: NOW,
    });
  });

  test("uses the clock it is given", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => RESPONSE, account("p"), () => 42);
    expect(stored(repos)?.quotaAt).toBe(42);
  });

  test("a failed ask keeps the old numbers, notes the error capped at 120 characters, and never throws", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => RESPONSE, account("p"));
    const res = await refreshQuota(repos, async () => Promise.reject(new Error("x".repeat(300))), account("p"));
    expect(res).toEqual(stored(repos));
    expect(res).toMatchObject({ fiveHour: { usedPct: 15 }, quotaAt: NOW });
    expect(res.pollError).toMatch(/^Could not get quota: x{120}$/);
  });

  test("a failed first ask stores the error alone", async () => {
    const repos = setup();
    const res = await refreshQuota(repos, async () => Promise.reject("boom"), account("p"));
    expect(res).toEqual({ accountId: "p", pollError: "Could not get quota: boom", pollErrorAt: NOW });
  });

  test("a hung ask is aborted after POLL_TIMEOUT_MS and resolves with an error", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => RESPONSE, account("p"));
    let signal!: AbortSignal;
    const done = refreshQuota(repos, (_a, s) => ((signal = s), new Promise(() => {})), account("p"));
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await done;
    expect(signal.aborted).toBe(true);
    expect(res).toMatchObject({ fiveHour: { usedPct: 15 }, pollError: "Could not get quota: timed out" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("an answer with no plan limits is a failure that keeps the old numbers", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => RESPONSE, account("p"));
    const res = await refreshQuota(repos, async () => ({ rate_limits_available: false, rate_limits: null }), account("p"));
    expect(res).toMatchObject({ fiveHour: { usedPct: 15 }, pollError: "The account has no quota numbers (not logged in?)" });
  });

  test("an answer with no readable window is a failure, not a healthy account", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => FULL_5H, account("p"));
    const res = await refreshQuota(repos, async () => ({ rate_limits_available: true, rate_limits: {} }), account("p"));
    expect(res).toMatchObject({ fiveHour: { usedPct: 100 }, pollError: "Could not read the quota numbers" });
    expect(res.limit).toBeDefined();
  });

  test("a good answer clears the error", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => Promise.reject(new Error("x")), account("p"));
    const res = await refreshQuota(repos, async () => RESPONSE, account("p"));
    expect(res.pollError).toBeUndefined();
    expect("pollError" in res).toBe(false);
  });

  test("drops windows the new answer no longer carries", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => RESPONSE, account("p"));
    const res = await refreshQuota(repos, async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } } }), account("p"));
    expect(res.fiveHour).toEqual({ usedPct: 20 });
    expect(res.sevenDay).toBeUndefined();
    expect(res.models).toBeUndefined();
  });

  test("a full window sets a limit until its reset", async () => {
    const repos = setup();
    const res = await refreshQuota(repos, async () => FULL_5H, account("p"));
    expect(res.limit).toEqual({ message: "Out of 5-hour quota", until: Date.parse("2026-11-15T12:00:00Z"), at: NOW });
  });

  test("a full model window keeps its model name in the limit", async () => {
    const repos = setup();
    const res = await refreshQuota(repos, async () => withLimits({ model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-11-20T00:00:00Z" }] }), account("p"));
    expect(res.limit).toMatchObject({ model: "Fable", until: Date.parse("2026-11-20T00:00:00Z") });
  });

  test("a later answer under 100% removes a limit that came from a full window", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => FULL_5H, account("p"));
    vi.advanceTimersByTime(60_000); // the window has not reset yet by the clock
    const res = await refreshQuota(repos, async () => RESPONSE, account("p"));
    expect(res.limit).toBeUndefined();
    expect("limit" in res).toBe(false);
    expect(stored(repos)?.limit).toBeUndefined();
  });

  test("a limit set by a run with a future reset survives a healthy answer", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => RESPONSE, account("p"));
    vi.advanceTimersByTime(1000);
    markLimited(repos, "p", FABLE, Date.now());
    vi.advanceTimersByTime(1000);
    const res = await refreshQuota(repos, async () => RESPONSE, account("p"));
    expect(res.limit).toMatchObject({ model: "Fable", until: FABLE_UNTIL });
    expect(res.quotaAt).toBe(Date.now());
  });

  test("a limit set by a run is replaced by a full window, then goes with it", async () => {
    const repos = setup();
    markLimited(repos, "p", FABLE, NOW);
    vi.advanceTimersByTime(1000);
    expect((await refreshQuota(repos, async () => FULL_5H, account("p"))).limit?.message).toBe("Out of 5-hour quota");
    vi.advanceTimersByTime(1000);
    expect((await refreshQuota(repos, async () => RESPONSE, account("p"))).limit).toBeUndefined();
  });

  test("a limit set by a run is removed once its reset has passed, or when it has no reset", async () => {
    const repos = setup();
    markLimited(repos, "p", FABLE, NOW);
    vi.setSystemTime(FABLE_UNTIL);
    expect((await refreshQuota(repos, async () => RESPONSE, account("p"))).limit).toBeUndefined();

    markLimited(repos, "p", "rate limit exceeded", Date.now());
    expect(stored(repos)?.limit).toBeDefined();
    vi.advanceTimersByTime(1000);
    expect((await refreshQuota(repos, async () => RESPONSE, account("p"))).limit).toBeUndefined();
  });

  test("a failed ask leaves the limit alone", async () => {
    const repos = setup();
    markLimited(repos, "p", FABLE, NOW);
    const res = await refreshQuota(repos, async () => Promise.reject(new Error("x")), account("p"));
    expect(res.limit).toMatchObject({ model: "Fable" });
  });

  test("a good answer marks a not-logged-in account connected, and leaves other states alone", async () => {
    const repos = setup(["p", "q", "r"]);
    repos.status.set({ accountId: "p", connection: { state: "not-logged-in", checkedAt: 1 } });
    repos.status.set({ accountId: "q", connection: { state: "connected", detail: "max", checkedAt: 1 } });
    repos.status.set({ accountId: "r", connection: { state: "error", detail: "x", checkedAt: 1 } });
    for (const id of ["p", "q", "r"]) await refreshQuota(repos, async () => RESPONSE, account(id));
    expect(stored(repos, "p")?.connection).toEqual({ state: "connected", checkedAt: NOW });
    expect(stored(repos, "q")?.connection).toEqual({ state: "connected", detail: "max", checkedAt: 1 });
    expect(stored(repos, "r")?.connection).toEqual({ state: "error", detail: "x", checkedAt: 1 });
  });

  test("a failed ask leaves the connection alone", async () => {
    const repos = setup();
    repos.status.set({ accountId: "p", connection: { state: "not-logged-in", checkedAt: 1 } });
    const res = await refreshQuota(repos, async () => Promise.reject(new Error("x")), account("p"));
    expect(res.connection).toEqual({ state: "not-logged-in", checkedAt: 1 });
  });
});

describe("refreshQuota: one transaction for the write", () => {
  /** Records, for every status read and write, whether it ran inside `repos.tx`. */
  function watched(repos: Repos) {
    let depth = 0;
    const log: string[] = [];
    const tx = repos.tx.bind(repos);
    repos.tx = (fn) => {
      depth++;
      try {
        return tx(fn);
      } finally {
        depth--;
      }
    };
    const { get, set } = repos.status;
    repos.status.get = (id) => (log.push(`get ${depth > 0 ? "in" : "out"}`), get(id));
    repos.status.set = (st) => (log.push(`set ${depth > 0 ? "in" : "out"}`), set(st));
    return log;
  }

  test("re-reads, merges and writes inside one transaction, keeping a limit set while the ask was out", async () => {
    const repos = setup();
    const log = watched(repos);
    const res = await refreshQuota(repos, async () => {
      markLimited(repos, "p", FABLE, NOW); // another process's run hits a limit meanwhile
      log.length = 0;
      return RESPONSE;
    }, account("p"));
    expect(log).toEqual(["get in", "set in"]);
    expect(res.limit).toMatchObject({ message: FABLE, until: FABLE_UNTIL });
    expect(stored(repos)).toEqual(res);
  });

  test("a failed ask writes its error inside a transaction too", async () => {
    const repos = setup();
    const log = watched(repos);
    await refreshQuota(repos, async () => {
      log.length = 0;
      throw new Error("boom");
    }, account("p"));
    expect(log).toEqual(["get in", "set in"]);
  });
});

describe("refreshStale", () => {
  test("asks only the accounts whose numbers are older than staleMs, one after another", async () => {
    const repos = setup(["fresh", "old", "never", "edge"]);
    repos.status.set({ accountId: "fresh", quotaAt: NOW - 1000 });
    repos.status.set({ accountId: "old", quotaAt: NOW - 120_001 });
    repos.status.set({ accountId: "edge", quotaAt: NOW - 120_000 });
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const fetch: UsageFetch = (a) => {
      started.push(a.id);
      return new Promise((r) => releases.push(() => r(RESPONSE)));
    };
    const done = refreshStale(repos, fetch, repos.accounts.list(), 120_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["old"]);
    releases[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["old", "never"]);
    releases[1]!();
    await done;
    expect(started).toEqual(["old", "never"]);
    expect(stored(repos, "old")?.quotaAt).toBe(NOW);
    expect(stored(repos, "fresh")?.quotaAt).toBe(NOW - 1000);
  });

  test("one failing account does not stop the others", async () => {
    const repos = setup(["a", "b"]);
    const seen: string[] = [];
    await refreshStale(
      repos,
      async (a) => {
        seen.push(a.id);
        if (a.id === "a") throw new Error("x");
        return RESPONSE;
      },
      repos.accounts.list(),
      0,
    );
    expect(seen).toEqual(["a", "b"]);
    expect(stored(repos, "a")?.pollError).toBeDefined();
    expect(stored(repos, "b")?.fiveHour?.usedPct).toBe(15);
  });

  test("after a failed ask the account is not asked again for 5 minutes, then it is", async () => {
    const repos = setup(["a", "b"]);
    const seen: string[] = [];
    const fetch: UsageFetch = async (a) => {
      seen.push(a.id);
      if (a.id === "a") throw new Error("x");
      return RESPONSE;
    };
    await refreshStale(repos, fetch, repos.accounts.list(), 0);
    expect(stored(repos, "a")?.pollErrorAt).toBe(NOW);
    expect(seen).toEqual(["a", "b"]);

    vi.setSystemTime(NOW + POLL_BACKOFF_MS - 1);
    await refreshStale(repos, fetch, repos.accounts.list(), 0);
    expect(seen).toEqual(["a", "b", "b"]);

    vi.setSystemTime(NOW + POLL_BACKOFF_MS);
    await refreshStale(repos, fetch, repos.accounts.list(), 0);
    expect(seen).toEqual(["a", "b", "b", "a", "b"]);
  });

  test("uses the clock it is given for staleness and the backoff", async () => {
    const repos = setup(["a"]);
    repos.status.set({ accountId: "a", quotaAt: 1000 });
    const seen: string[] = [];
    const fetch: UsageFetch = async (a) => (seen.push(a.id), RESPONSE);
    await refreshStale(repos, fetch, repos.accounts.list(), 120_000, () => 2000);
    expect(seen).toEqual([]);
    await refreshStale(repos, fetch, repos.accounts.list(), 120_000, () => 1000 + 120_001);
    expect(seen).toEqual(["a"]);
    expect(stored(repos, "a")?.quotaAt).toBe(1000 + 120_001);
  });
});

describe("refreshQuota: pollErrorAt", () => {
  test("a failed, unreadable or timed-out ask sets pollErrorAt; a good answer clears it with pollError", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => { throw new Error("x"); }, account("p"), () => 10);
    expect(stored(repos)?.pollErrorAt).toBe(10);
    await refreshQuota(repos, async () => ({ rate_limits_available: true, rate_limits: {} }), account("p"), () => 20);
    expect(stored(repos)?.pollErrorAt).toBe(20);
    const hung = refreshQuota(repos, () => new Promise(() => {}), account("p"), () => 30);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    await hung;
    expect(stored(repos)?.pollErrorAt).toBe(30);
    await refreshQuota(repos, async () => RESPONSE, account("p"), () => 40);
    expect(stored(repos)?.pollErrorAt).toBeUndefined();
    expect(stored(repos)?.pollError).toBeUndefined();
  });
});

describe("markLimited", () => {
  test("reads the model and the reset time from Claude's text", () => {
    const repos = setup();
    markLimited(repos, "p", FABLE, NOW);
    expect(stored(repos)?.limit).toEqual({ message: FABLE, model: "Fable", until: FABLE_UNTIL, at: NOW });
  });

  test("keeps the numbers already stored", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => RESPONSE, account("p"));
    markLimited(repos, "p", FABLE, NOW);
    expect(stored(repos)).toMatchObject({ fiveHour: { usedPct: 15 }, quotaAt: NOW, limit: { model: "Fable" } });
  });

  test("without a readable reset it uses the latest reset among full windows", async () => {
    const repos = setup();
    await refreshQuota(
      repos,
      async () =>
        withLimits({
          five_hour: { utilization: 100, resets_at: "2026-11-15T12:00:00Z" },
          model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-11-20T00:00:00Z" }],
        }),
      account("p"),
    );
    markLimited(repos, "p", "rate limit exceeded", NOW);
    expect(stored(repos)?.limit).toEqual({ message: "rate limit exceeded", until: Date.parse("2026-11-20T00:00:00Z"), at: NOW });
  });

  test("ignores windows that are not full when falling back", async () => {
    const repos = setup();
    await refreshQuota(repos, async () => RESPONSE, account("p"));
    markLimited(repos, "p", "rate limit exceeded", NOW);
    expect(stored(repos)?.limit).toEqual({ message: "rate limit exceeded", at: NOW });
  });

  test("an account with no status yet gets one", () => {
    const repos = setup();
    markLimited(repos, "p", "rate limit exceeded", NOW);
    expect(stored(repos)).toEqual({ accountId: "p", limit: { message: "rate limit exceeded", at: NOW } });
  });

  test("the stored message is capped at 120 characters", () => {
    const repos = setup();
    markLimited(repos, "p", "y".repeat(500), NOW);
    expect(stored(repos)?.limit?.message).toBe("y".repeat(120));
  });
});

describe("QuotaPoller", () => {
  const INTERVAL = 60_000;

  test("polls now and every interval, never two accounts at once; stop ends it", async () => {
    const repos = setup(["p", "q"]);
    let running = 0;
    let overlap = false;
    const calls: string[] = [];
    const fetch: UsageFetch = async (a) => {
      calls.push(a.id);
      overlap ||= ++running > 1;
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return RESPONSE;
    };
    const poller = new QuotaPoller(repos, fetch);
    poller.start(INTERVAL);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(["p", "q"]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(calls).toEqual(["p", "q", "p", "q"]);
    poller.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(calls.length).toBe(4);
    expect(overlap).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("accounts added later are picked up on the next tick", async () => {
    const repos = setup(["p"]);
    const calls: string[] = [];
    const poller = new QuotaPoller(repos, async (a) => (calls.push(a.id), RESPONSE));
    poller.start(INTERVAL);
    await vi.advanceTimersByTimeAsync(0);
    repos.accounts.insert(account("late"));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(calls).toEqual(["p", "p", "late"]);
    poller.stop();
  });

  test("an account whose ask failed is asked again only after 5 minutes", async () => {
    const repos = setup(["p", "q"]);
    let fail = true;
    const calls: string[] = [];
    const poller = new QuotaPoller(repos, async (a) => {
      calls.push(a.id);
      if (a.id === "p" && fail) throw new Error("spawn claude ENOENT");
      return RESPONSE;
    });
    poller.start(INTERVAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["p", "q"]);
    expect(stored(repos)?.pollError).toBe("Could not get quota: spawn claude ENOENT");
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS - INTERVAL); // ticks at +1..+4 minutes
    expect(calls.filter((c) => c === "p")).toEqual([]);
    expect(calls.filter((c) => c === "q").length).toBe(4);
    fail = false;
    await vi.advanceTimersByTimeAsync(INTERVAL); // +5 minutes
    expect(calls.filter((c) => c === "p")).toEqual(["p"]);
    expect(stored(repos)?.pollError).toBeUndefined();
    poller.stop();
  });

  test("stop aborts the ask in flight and writes nothing afterwards", async () => {
    const repos = setup(["p", "q"]);
    const signals: AbortSignal[] = [];
    let release!: (v: unknown) => void;
    const poller = new QuotaPoller(repos, (_a, signal) => {
      signals.push(signal);
      return new Promise((r) => (release = r));
    });
    poller.start(INTERVAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.length).toBe(1);
    expect(signals[0]!.aborted).toBe(false);
    poller.stop();
    expect(signals[0]!.aborted).toBe(true);
    release(RESPONSE);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(signals.length).toBe(1); // q is never asked
    expect(repos.status.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stop aborts even an ask that ignores its signal", async () => {
    const repos = setup(["p"]);
    const poller = new QuotaPoller(repos, () => new Promise(() => {}));
    poller.start(INTERVAL);
    await vi.advanceTimersByTimeAsync(1000);
    poller.stop();
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS * 2);
    expect(repos.status.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("timers never keep the process alive", () => {
    const repos = setup([]);
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms) as unknown as { unref: () => void };
      const orig = t.unref.bind(t);
      t.unref = () => (unref(), orig());
      return t;
    }) as unknown as typeof setTimeout);
    const poller = new QuotaPoller(repos, async () => RESPONSE);
    poller.start(INTERVAL);
    return vi.advanceTimersByTimeAsync(0).then(() => {
      expect(unref).toHaveBeenCalled();
      poller.stop();
      spy.mockRestore();
    });
  });

  test("start twice does not double the polling", async () => {
    const repos = setup(["p"]);
    const calls: string[] = [];
    const poller = new QuotaPoller(repos, async (a) => (calls.push(a.id), RESPONSE));
    poller.start(INTERVAL);
    poller.start(INTERVAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["p"]);
    poller.stop();
  });
});

