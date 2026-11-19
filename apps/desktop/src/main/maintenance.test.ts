import { test, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepos, openDb } from "@aolangai/core";
import { startMaintenance } from "./maintenance.js";
import { createApi, type ApiDeps } from "./ipc.js";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

const fakeApi = (sweep: () => number, scan: () => Promise<void> = async () => {}) => {
  const calls = { sweep: 0, push: 0, scan: 0 };
  return {
    calls,
    api: {
      sweep: () => (calls.sweep++, sweep()),
      pushState: () => void calls.push++,
      scan: () => (calls.scan++, scan()),
    },
  };
};

test("start: sweep and push run at once; a sweep error does not block push and does not throw", () => {
  const logs: string[] = [];
  const { api, calls } = fakeApi(() => {
    throw new Error("SQLITE_BUSY");
  });
  const m = startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: (s) => logs.push(s) });
  expect(calls).toEqual({ sweep: 1, push: 1, scan: 1 });
  expect(logs).toEqual(["[aolangai] SQLITE_BUSY"]);
  m.stop();
});

test("the timer survives errors: later ticks still run, the same error is logged once, a different error is logged too", () => {
  const logs: string[] = [];
  let n = 0;
  const { api, calls } = fakeApi(() => {
    n++;
    if (n <= 3) throw new Error("SQLITE_BUSY");
    if (n === 4) throw new Error("other");
    return 0;
  });
  const m = startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: (s) => logs.push(s) });
  vi.advanceTimersByTime(1000); // 2: busy
  vi.advanceTimersByTime(1000); // 3: busy
  vi.advanceTimersByTime(1000); // 4: other
  vi.advanceTimersByTime(1000); // 5: ok
  expect(calls.sweep).toBe(5);
  expect(logs).toEqual(["[aolangai] SQLITE_BUSY", "[aolangai] other"]);
  m.stop();
});

test("an error that repeats after recovery is logged again", () => {
  const logs: string[] = [];
  let n = 0;
  const { api } = fakeApi(() => {
    n++;
    if (n === 1 || n === 3) throw new Error("busy");
    return 0;
  });
  const m = startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: (s) => logs.push(s) });
  vi.advanceTimersByTime(2000);
  expect(logs).toEqual(["[aolangai] busy", "[aolangai] busy"]);
  m.stop();
});

test("guarded pushState (for the watcher) does not throw and logs", () => {
  const logs: string[] = [];
  const api = { sweep: () => 0, pushState: () => { throw new Error("could not build the state"); }, scan: async () => {} };
  const m = startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: (s) => logs.push(s) });
  expect(() => m.pushState()).not.toThrow();
  expect(logs).toEqual(["[aolangai] could not build the state"]);
  m.stop();
});

test("stop stops the ticks", () => {
  const { api, calls } = fakeApi(() => 0);
  startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: () => {} }).stop();
  vi.advanceTimersByTime(5000);
  expect(calls.sweep).toBe(1);
});

test("with the real createApi on a closed store: sweep throws, the loop stays alive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-maint-"));
  const db = openDb(path.join(root, "a.db"));
  const repos = createRepos(db);
  const api = createApi({ repos, userData: root, now: () => 1, emitState: () => {} } as unknown as ApiDeps);
  db.close();
  const logs: string[] = [];
  const m = startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: (s) => logs.push(s) });
  vi.advanceTimersByTime(3000);
  expect(logs).toHaveLength(2); // the startup sweep and the startup push each fail once; the ticks repeat the sweep's message
  expect(logs.every((l) => l.startsWith("[aolangai] "))).toBe(true);
  m.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test("scan runs at once on start and after every sessionsMs; stop ends it", async () => {
  const { api, calls } = fakeApi(() => 0);
  const m = startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: () => {} });
  expect(calls.scan).toBe(1);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(calls.scan).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls.scan).toBe(2);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls.scan).toBe(3);
  m.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls.scan).toBe(3);
});

test("scan rejects: the timer does not die, the same error is logged once", async () => {
  const logs: string[] = [];
  const { api, calls } = fakeApi(() => 0, async () => {
    throw new Error("scan broke");
  });
  const m = startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: (s) => logs.push(s) });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls.scan).toBe(3);
  expect(logs).toEqual(["[aolangai] scan broke"]);
  m.stop();
});

test("scan throwing synchronously does not throw out either", async () => {
  const logs: string[] = [];
  const api = { sweep: () => 0, pushState: () => {}, scan: (() => { throw new Error("synchronous"); }) as () => Promise<void> };
  expect(() => startMaintenance(api, { intervalMs: 1000, sessionsMs: 10_000, log: (s) => logs.push(s) }).stop()).not.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(logs).toEqual(["[aolangai] synchronous"]);
});
