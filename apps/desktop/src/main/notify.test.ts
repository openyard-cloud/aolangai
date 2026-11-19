import { test, expect } from "vitest";
import { DEFAULT_LIMITS, type Account, type AccountStatus, type Run } from "@aolangai/core";
import type { AppState } from "../shared/api.js";
import { createNoticeGate, noticesFor, trayQuotaLines, trayTitle } from "./notify.js";

const account = (o: Partial<Account> = {}): Account => ({ id: "a1", name: "Personal", accepting: true, allowedDirs: [], reservePct: 90, ...o });
const run = (o: Partial<Run> = {}): Run => ({
  id: 7, prompt: "p", cwd: "/p", accountId: "a1", primaryWorker: true, readOnly: false, status: "running", createdAt: 1, ...o,
});
const status = (usedPct: number): AccountStatus => ({ accountId: "a1", fiveHour: { usedPct } });
const state = (o: Partial<AppState> = {}): AppState => ({
  accounts: [account()], statuses: [], runs: [], limits: DEFAULT_LIMITS, install: { skill: "current", shim: "current", accounts: [] }, app: { packaged: false, openAtLogin: false, claudeFound: true }, sessions: [], ...o,
});

test("run becomes failed: notice with the error, cut at 80 characters", () => {
  const long = "x".repeat(200);
  const n = noticesFor(state({ runs: [run()] }), state({ runs: [run({ status: "failed", error: long })] }));
  expect(n).toEqual([{ title: "aolangai", body: `Run #7 failed: ${"x".repeat(80)}` }]);
});

test("failed run without an error: still announced, no word undefined", () => {
  const n = noticesFor(state({ runs: [run()] }), state({ runs: [run({ status: "failed" })] }));
  expect(n).toHaveLength(1);
  expect(n[0]!.body).toMatch(/^Run #7 failed/);
  expect(n[0]!.body).not.toContain("undefined");
});

test("run becomes limited: notice that the account hit its limit (account name)", () => {
  const n = noticesFor(state({ runs: [run()] }), state({ runs: [run({ status: "limited" })] }));
  expect(n).toEqual([{ title: "aolangai", body: "Account Personal hit its limit" }]);
});

test("limited run of a deleted account: the id replaces the name, nothing throws", () => {
  const n = noticesFor(state({ runs: [run({ accountId: "gone" })] }), state({ runs: [run({ accountId: "gone", status: "limited" })] }));
  expect(n).toEqual([{ title: "aolangai", body: "Account gone hit its limit" }]);
});

test("done run with denials: permission denied notice with the first denial", () => {
  const n = noticesFor(state({ runs: [run()] }), state({ runs: [run({ status: "done", denials: ["Bash: rm -rf x", "Edit: y"] })] }));
  expect(n).toEqual([{ title: "aolangai", body: "Run #7 finished, permission denied: Bash: rm -rf x" }]);
});

test("normal done run, done with empty denials, and stopped run: no notice", () => {
  const prev = state({ runs: [run(), run({ id: 8 }), run({ id: 9 })] });
  const next = state({
    runs: [run({ status: "done" }), run({ id: 8, status: "done", denials: [] }), run({ id: 9, status: "stopped" })],
  });
  expect(noticesFor(prev, next)).toEqual([]);
});

test("run already in that state in prev: not announced again", () => {
  const failed = run({ status: "failed", error: "e" });
  const limited = run({ id: 8, status: "limited" });
  const denied = run({ id: 9, status: "done", denials: ["d"] });
  const s = state({ runs: [failed, limited, denied] });
  expect(noticesFor(s, s)).toEqual([]);
});

test("new run already failed (not in prev): still announced", () => {
  const n = noticesFor(state(), state({ runs: [run({ status: "failed", error: "e" })] }));
  expect(n).toEqual([{ title: "aolangai", body: "Run #7 failed: e" }]);
});

test("account just crossed reservePct: notice that it has used N%, over the reserve, in the lane's words", () => {
  const n = noticesFor(state({ statuses: [status(80)] }), state({ statuses: [status(92.4)] }));
  expect(n).toEqual([{ title: "aolangai", body: "Account Personal has used 92%, over the reserve of 90%" }]);
});

test("exactly reservePct counts as crossing; already above the reserve is not announced again", () => {
  expect(noticesFor(state({ statuses: [status(89)] }), state({ statuses: [status(90)] }))).toHaveLength(1);
  expect(noticesFor(state({ statuses: [status(90)] }), state({ statuses: [status(95)] }))).toEqual([]);
  expect(noticesFor(state({ statuses: [status(95)] }), state({ statuses: [status(95)] }))).toEqual([]);
});

test("dropping below and crossing again: announced again", () => {
  const a = state({ statuses: [status(95)] });
  const b = state({ statuses: [status(10)] });
  expect(noticesFor(a, b)).toEqual([]);
  expect(noticesFor(b, a)).toHaveLength(1);
});

test("no quota numbers before (new account, app just opened): no notice", () => {
  expect(noticesFor(state({ statuses: [] }), state({ statuses: [status(99)] }))).toEqual([]);
});

test("several changes at once: one notice per change", () => {
  // runs are newest first, as in AppState; notices come oldest first
  const prev = state({ runs: [run({ id: 8 }), run()], statuses: [status(10)] });
  const next = state({ runs: [run({ id: 8, status: "limited" }), run({ status: "failed", error: "e" })], statuses: [status(95)] });
  expect(noticesFor(prev, next).map((n) => n.body)).toEqual(["Run #7 failed: e", "Account Personal hit its limit", "Account Personal has used 95%, over the reserve of 90%"]);
});

test("several runs of one account hit the limit at once: one notice per account", () => {
  const prev = state({ accounts: [account(), account({ id: "a2", name: "Work" })], runs: [run({ id: 4, accountId: "a2" }), run({ id: 3 }), run({ id: 2 }), run({ id: 1 })] });
  const next = state({
    accounts: prev.accounts,
    runs: [run({ id: 4, accountId: "a2", status: "limited" }), run({ id: 3, status: "limited" }), run({ id: 2, status: "limited" }), run({ id: 1, status: "limited" })],
  });
  expect(noticesFor(prev, next).map((n) => n.body)).toEqual(["Account Personal hit its limit", "Account Work hit its limit"]);
});

test("tray: empty title when no run is running, the number of running runs otherwise", () => {
  expect(trayTitle(state())).toBe("");
  expect(trayTitle(state({ runs: [run({ status: "done" }), run({ id: 8, status: "failed" })] }))).toBe("");
  expect(trayTitle(state({ runs: [run(), run({ id: 8 }), run({ id: 9, status: "done" })] }))).toBe("2");
});

test("notice gate: the first state gives no notice, later states do", () => {
  const gate = createNoticeGate();
  const failed = state({ runs: [run({ status: "failed", error: "e" })] });
  expect(gate(failed)).toEqual([]); // already failed when the app started
  expect(gate(state({ runs: [run({ status: "failed", error: "e" }), run({ id: 8, status: "failed", error: "f" })] }))).toEqual([{ title: "aolangai", body: "Run #8 failed: f" }]);
  expect(gate(failed)).toEqual([]);
});

// Quota lines of the menu-bar menu. Clock text depends on the zone, so expected times are built from local-time Dates.
const HOUR = 60 * 60_000;
const NOW = new Date(2026, 10, 18, 12, 0).getTime();
const at = (h: number, m: number) => new Date(2026, 10, 18, h, m).getTime();
const quotaState = (statuses: AccountStatus[], accounts = [account()]) => state({ accounts, statuses });

test("trayQuotaLines: account with both windows, percentages rounded", () => {
  const s = quotaState([{ accountId: "a1", fiveHour: { usedPct: 41.6 }, sevenDay: { usedPct: 7.4 } }]);
  expect(trayQuotaLines(s, NOW)).toEqual(["Personal  5h 42% · week 7%"]);
});

test("trayQuotaLines: only the 7-day window; per-model windows are not shown", () => {
  const s = quotaState([{ accountId: "a1", sevenDay: { usedPct: 30 }, models: [{ name: "Fable", usedPct: 99 }] }]);
  expect(trayQuotaLines(s, NOW)).toEqual(["Personal  week 30%"]);
});

test("trayQuotaLines: no data yet (no status, or an empty status)", () => {
  expect(trayQuotaLines(quotaState([]), NOW)).toEqual(["Personal  no data yet"]);
  expect(trayQuotaLines(quotaState([{ accountId: "a1" }]), NOW)).toEqual(["Personal  no data yet"]);
});

test("trayQuotaLines: limited with a reopening time, after the windows", () => {
  const limit = { message: "m", until: at(14, 5), at: NOW - 1000 };
  const s = quotaState([{ accountId: "a1", fiveHour: { usedPct: 100 }, sevenDay: { usedPct: 50 }, limit }]);
  expect(trayQuotaLines(s, NOW)).toEqual(["Personal  5h 100% · week 50% · limited until 14:05"]);
});

test("trayQuotaLines: a limit that ends on another day names the day", () => {
  const limit = { message: "m", until: new Date(2026, 10, 21, 8, 0).getTime(), at: NOW - 1000 };
  const s = quotaState([{ accountId: "a1", sevenDay: { usedPct: 100 }, limit }]);
  expect(trayQuotaLines(s, NOW)).toEqual(["Personal  week 100% · limited until 21 Nov 08:00"]);
});

test("trayQuotaLines: limited without a reopening time, still in effect under an hour", () => {
  const s = quotaState([{ accountId: "a1", fiveHour: { usedPct: 100 }, limit: { message: "m", at: NOW - 59 * 60_000 } }]);
  expect(trayQuotaLines(s, NOW)).toEqual(["Personal  5h 100% · limited"]);
});

test("trayQuotaLines: only a limit, no windows: no data yet is not printed", () => {
  const s = quotaState([{ accountId: "a1", limit: { message: "m", at: NOW - 1000 } }]);
  expect(trayQuotaLines(s, NOW)).toEqual(["Personal  limited"]);
});

test("trayQuotaLines: limit past its reopening time, or without one and over an hour old: no longer shown", () => {
  const expired = quotaState([{ accountId: "a1", fiveHour: { usedPct: 10 }, limit: { message: "m", until: NOW - 1, at: NOW - HOUR } }]);
  expect(trayQuotaLines(expired, NOW)).toEqual(["Personal  5h 10%"]);
  const stale = quotaState([{ accountId: "a1", limit: { message: "m", at: NOW - HOUR } }]);
  expect(trayQuotaLines(stale, NOW)).toEqual(["Personal  no data yet"]);
});

test("trayQuotaLines: no accounts gives an empty array; several accounts keep the state.accounts order", () => {
  expect(trayQuotaLines(state({ accounts: [] }), NOW)).toEqual([]);
  const s = state({
    accounts: [account({ id: "b", name: "B" }), account({ id: "a", name: "A" })],
    statuses: [{ accountId: "a", fiveHour: { usedPct: 1 } }],
  });
  expect(trayQuotaLines(s, NOW)).toEqual(["B  no data yet", "A  5h 1%"]);
});

test("trayQuotaLines: a line break or tab in a name becomes a space, one line per account", () => {
  const s = state({ accounts: [account({ name: "Two\nlines\t\ttab\r\nmore" })], statuses: [{ accountId: "a1", fiveHour: { usedPct: 5 } }] });
  const [line, ...rest] = trayQuotaLines(s, NOW);
  expect(rest).toEqual([]);
  expect(line).toBe("Two lines tab more  5h 5%");
});
