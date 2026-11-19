import { expect, test } from "vitest";
import { account, appState, run, status } from "../testing.js";
import { attentionLine, canOpenTerminal, duration, lanes, latestStep, needsYou, runTitle, statusLabel } from "./runs.js";

const NOW = new Date(2026, 10, 17, 12, 0).getTime();
const HOUR = 3_600_000;

test("lanes: accepting work first, then by name; watch only last", () => {
  const s = appState({
    accounts: [
      account({ id: "m", name: "Main", accepting: false }),
      account({ id: "c", name: "Company" }),
      account({ id: "b", name: "Claude B" }),
    ],
  });
  expect(lanes(s).map((l) => [l.account.name, l.mode])).toEqual([
    ["Claude B", "Accepting work"],
    ["Company", "Accepting work"],
    ["Main", "Watch only"],
  ]);
});

test("lanes: running runs apart, the 5 newest finished runs, the right account, with its status", () => {
  const finished = [1, 2, 3, 4, 5, 6, 7].map((i) => run({ id: i, createdAt: i * 1000, finishedAt: i * 1000 + 500, status: i === 3 ? "failed" : "done" }));
  const s = appState({
    accounts: [account({ id: "a1" }), account({ id: "a2", name: "Zed" })],
    statuses: [status({ accountId: "a1", fiveHour: { usedPct: 12 } })],
    runs: [
      run({ id: 20, status: "running", createdAt: 9000 }),
      run({ id: 21, status: "running", accountId: "a2", createdAt: 9100 }),
      ...finished,
      run({ id: 99, accountId: "gone" }),
    ],
  });
  const [a1, a2] = lanes(s);
  expect(a1.running.map((r) => r.id)).toEqual([20]);
  expect(a1.recent.map((r) => r.id)).toEqual([7, 6, 5, 4, 3]);
  expect(a1.status?.fiveHour?.usedPct).toBe(12);
  expect(a2.running.map((r) => r.id)).toEqual([21]);
  expect(a2.status).toBeUndefined();
  expect(a2.recent).toEqual([]);
});

test("needsYou: failed, limited and permission-denied runs in the last 24 hours", () => {
  const recent = NOW - HOUR;
  const s = appState({
    accounts: [account()],
    runs: [
      run({ id: 1, status: "failed", createdAt: recent, finishedAt: recent }),
      run({ id: 2, status: "limited", createdAt: recent, finishedAt: recent }),
      run({ id: 3, status: "done", denials: ["Bash(npm run migrate)"], createdAt: recent, finishedAt: recent }),
      run({ id: 4, status: "done", createdAt: recent, finishedAt: recent }),
      run({ id: 5, status: "stopped", createdAt: recent, finishedAt: recent }),
      run({ id: 6, status: "running", createdAt: recent }),
      run({ id: 7, status: "done", denials: [], createdAt: recent, finishedAt: recent }),
    ],
  });
  expect(needsYou(s, NOW).map((a) => (a.kind === "reserve" ? "reserve" : `${a.kind}:${a.run.id}`))).toEqual(["failed:1", "limited:2", "denied:3"]);
});

test("needsYou: leaves out a run that has a retry, and runs older than 24 hours", () => {
  const s = appState({
    accounts: [account()],
    runs: [
      run({ id: 10, status: "running", retryOf: 9, createdAt: NOW - 1000 }),
      run({ id: 9, status: "failed", createdAt: NOW - HOUR, finishedAt: NOW - HOUR }),
      run({ id: 8, status: "failed", createdAt: NOW - 25 * HOUR, finishedAt: NOW - 25 * HOUR }),
      run({ id: 7, status: "failed", createdAt: NOW - 23 * HOUR, finishedAt: NOW - 23 * HOUR }),
    ],
  });
  expect(needsYou(s, NOW).map((a) => (a.kind === "reserve" ? 0 : a.run.id))).toEqual([7]);
});

test("needsYou: an account with usedPct >= reservePct (the largest number of its windows)", () => {
  const s = appState({
    accounts: [account({ id: "a", name: "A", reservePct: 90 }), account({ id: "b", name: "B", reservePct: 90 }), account({ id: "c", name: "C", reservePct: 90 })],
    statuses: [
      status({ accountId: "a", fiveHour: { usedPct: 40 }, sevenDay: { usedPct: 90 } }),
      status({ accountId: "b", fiveHour: { usedPct: 89 } }),
      status({ accountId: "c" }),
    ],
  });
  const out = needsYou(s, NOW);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ kind: "reserve", usedPct: 90, account: { id: "a" } });
});

test("duration: seconds, minutes, hours", () => {
  const t0 = 1_000_000;
  expect(duration(run({ createdAt: t0, finishedAt: t0 + 40_000 }), NOW)).toBe("40 s");
  expect(duration(run({ createdAt: t0, finishedAt: t0 + 3 * 60_000 + 20_000 }), NOW)).toBe("3 min");
  expect(duration(run({ createdAt: t0, finishedAt: t0 + 65 * 60_000 }), NOW)).toBe("1 h 5 min");
  expect(duration(run({ createdAt: t0, finishedAt: t0 + 2 * HOUR }), NOW)).toBe("2 h");
  expect(duration(run({ createdAt: NOW - 90_000, status: "running" }), NOW)).toBe("1 min");
  expect(duration(run({ createdAt: NOW + 5000, status: "running" }), NOW)).toBe("0 s");
});

test("runTitle: the label, or the first 60 characters of the prompt on one line", () => {
  expect(runTitle(run({ label: "add login test", prompt: "x" }))).toBe("add login test");
  expect(runTitle(run({ label: "  ", prompt: "read the file" }))).toBe("read the file");
  expect(runTitle(run({ prompt: "a".repeat(100) }))).toBe("a".repeat(60));
  expect(runTitle(run({ prompt: "line one\n\n  line two" }))).toBe("line one line two");
});

test("statusLabel: the status in words, with a permission denied warning", () => {
  expect(statusLabel(run({ status: "running" }))).toBe("running");
  expect(statusLabel(run({ status: "done" }))).toBe("done");
  expect(statusLabel(run({ status: "failed" }))).toBe("failed");
  expect(statusLabel(run({ status: "stopped" }))).toBe("stopped");
  expect(statusLabel(run({ status: "limited" }))).toBe("limited");
  expect(statusLabel(run({ status: "done", denials: ["Bash(x)"] }))).toBe("done · permission denied");
  expect(statusLabel(run({ status: "failed", denials: ["Bash(x)"] }))).toBe("failed");
});

test("latestStep: the last step, one line, at most 120 characters", () => {
  expect(latestStep([])).toBeUndefined();
  const ev = (text: string, id: number) => ({ id, runId: 1, kind: "tool" as const, text, createdAt: id });
  expect(latestStep([ev("a", 1), ev("  Edit login.test.ts\nadd", 2)])).toBe("Edit login.test.ts add");
  expect(latestStep([ev("b".repeat(200), 1)])).toBe("b".repeat(119) + "…");
});

test("attentionLine: one sentence for each kind", () => {
  const accounts = [account({ id: "a1", name: "Claude B" })];
  const at = new Date(2026, 10, 17, 9, 58).getTime();
  const r = (o = {}) => run({ id: 12, label: "refactor header", createdAt: at, finishedAt: at, ...o });
  expect(attentionLine({ kind: "failed", run: r({ status: "failed" }) }, accounts)).toBe("#12 refactor header · Claude B failed at 09:58");
  expect(attentionLine({ kind: "limited", run: r({ status: "limited" }) }, accounts)).toBe("#12 refactor header · Claude B hit its limit at 09:58");
  expect(attentionLine({ kind: "denied", run: r({ denials: ["Bash(npm run migrate)", "Edit(x)"] }) }, accounts)).toBe(
    "#12 refactor header · permission denied: Bash(npm run migrate), Edit(x)",
  );
  expect(attentionLine({ kind: "reserve", account: accounts[0]!, usedPct: 91.6 }, accounts)).toBe("Claude B used 92%, over the reserve of 90%");
});

test("canOpenTerminal: needs a session; not when the run itself is running or another running run uses the same session", () => {
  const done = run({ id: 1, status: "done", sessionId: "s1" });
  expect(canOpenTerminal(done, [done])).toBe(true);
  expect(canOpenTerminal(run({ id: 2, status: "failed" }), [])).toBe(false);
  const running = run({ id: 3, status: "running", sessionId: "s1" });
  expect(canOpenTerminal(running, [running, done])).toBe(false);
  expect(canOpenTerminal(done, [running, done])).toBe(false);
  expect(canOpenTerminal(done, [run({ id: 4, status: "running", sessionId: "s2" }), run({ id: 5, status: "running" }), done])).toBe(true);
  expect(canOpenTerminal(done, [run({ id: 6, status: "done", sessionId: "s1" }), done])).toBe(true);
});
