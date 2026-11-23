import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { openDb } from "./db.js";
import { createRepos } from "./repos.js";
import { DEFAULT_LIMITS, type Account, type AccountStatus, type Run } from "../types.js";

const mem = () => createRepos(openDb(":memory:"));
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-repos-")), "test.db");

const account = (p: Partial<Account> = {}): Account => ({ id: "a1", name: "A", accepting: false, allowedDirs: [], reservePct: 90, ...p });
const run = (p: Partial<Omit<Run, "id">> = {}): Omit<Run, "id"> => ({
  prompt: "do something", cwd: "/p", accountId: "a1", primaryWorker: false, readOnly: false, status: "running", createdAt: 1000, ...p,
});

test("accounts: add, read, update, delete; optional fields are undefined, not null", () => {
  const r = mem();
  r.accounts.insert(account());
  expect(r.accounts.get("a1")).toEqual({ id: "a1", name: "A", accepting: false, allowedDirs: [], reservePct: 90 });
  const full = account({ configDir: "/cfg", model: "opus", accepting: true, allowedDirs: ["/x", "/y"], reservePct: 80, permissionMode: "acceptEdits" });
  r.accounts.update(full);
  expect(r.accounts.get("a1")).toEqual(full);
  r.accounts.update(account()); // clears optional fields
  expect(r.accounts.get("a1")).toEqual(account());
  r.accounts.insert(account({ id: "a2", name: "B" }));
  expect(r.accounts.list().map((a) => a.id)).toEqual(["a1", "a2"]);
  r.accounts.delete("a1");
  expect(r.accounts.get("a1")).toBeUndefined();
  expect(r.accounts.list().map((a) => a.id)).toEqual(["a2"]);
});

test("status: set overwrites, get/list/delete", () => {
  const r = mem();
  const s: AccountStatus = {
    accountId: "a1", fiveHour: { usedPct: 10, resetsAt: 5 }, models: [{ name: "Fable", usedPct: 3 }], quotaAt: 7,
    limit: { message: "hit", at: 8 }, connection: { state: "connected", checkedAt: 9 },
  };
  r.status.set(s);
  expect(r.status.get("a1")).toEqual(s);
  r.status.set({ accountId: "a1", pollError: "error" });
  expect(r.status.get("a1")).toEqual({ accountId: "a1", pollError: "error" });
  r.status.set({ accountId: "a2" });
  expect(r.status.list().map((x) => x.accountId)).toEqual(["a1", "a2"]);
  r.status.delete("a1");
  expect(r.status.get("a1")).toBeUndefined();
  expect(r.status.list()).toHaveLength(1);
});

test("runs.insert then get returns every field, denials is an array", () => {
  const r = mem();
  const full = run({
    label: "tag", sessionId: "s-1", primaryWorker: true, readOnly: true, status: "done", result: "done", error: "e",
    denials: ["Bash: rm", "Edit: /etc"], note: "a note", pid: 123, pidStart: "Mon Nov 17 10:00:00 2026", retryOf: 4,
    inputTokens: 10, outputTokens: 20, contextTokens: 30, finishedAt: 2000,
  });
  const inserted = r.runs.insert(full);
  expect(inserted).toEqual({ id: inserted.id, ...full });
  expect(r.runs.get(inserted.id)).toEqual({ id: inserted.id, ...full });
  const bare = r.runs.insert(run());
  expect(bare.id).toBe(inserted.id + 1);
  expect(r.runs.get(bare.id)).toEqual({ id: bare.id, ...run() });
  expect(r.runs.get(999)).toBeUndefined();
});

test("a run keeps its caller", () => {
  const r = mem();
  const caller = { callerPid: 41, callerStartedAt: 1_700_000_000_000, callerKind: "Terminal", callerAccountId: "a1" };
  const withCaller = r.runs.insert(run(caller));
  expect(r.runs.get(withCaller.id)).toEqual({ id: withCaller.id, ...run(caller) });
  const without = r.runs.get(r.runs.insert(run()).id)!;
  for (const k of Object.keys(caller)) expect(without).not.toHaveProperty(k);
});

test("runs.update changes only the fields in the patch", () => {
  const r = mem();
  const a = r.runs.insert(run({ label: "L" }));
  r.runs.update(a.id, { status: "failed", error: "broken", denials: ["x"], finishedAt: 5, label: undefined });
  expect(r.runs.get(a.id)).toEqual({ id: a.id, ...run({ label: "L", status: "failed", error: "broken", denials: ["x"], finishedAt: 5 }) });
});

test("runs.running returns only running rows; recent is newest first and cut by limit", () => {
  const r = mem();
  const ids = (["running", "done", "running", "limited", "stopped"] as const).map((status) => r.runs.insert(run({ status })).id);
  expect(r.runs.running().map((x) => x.id)).toEqual([ids[0], ids[2]]);
  expect(r.runs.recent(3).map((x) => x.id)).toEqual([ids[4], ids[3], ids[2]]);
  expect(r.runs.recent(100)).toHaveLength(5);
});

test("runs.hide sets hiddenAt on finished runs only, skips running and already hidden ones, returns the count", () => {
  const r = mem();
  const done = r.runs.insert(run({ status: "done" })).id;
  const failed = r.runs.insert(run({ status: "failed" })).id;
  const running = r.runs.insert(run({ status: "running" })).id;
  const hidden = r.runs.insert(run({ status: "stopped", hiddenAt: 7 })).id;
  expect(r.runs.hide([done, failed, running, hidden, 999], 50)).toBe(2);
  expect([done, failed, running, hidden].map((id) => r.runs.get(id)?.hiddenAt)).toEqual([50, 50, undefined, 7]);
  expect(r.runs.hide([done], 60)).toBe(0);
  expect(r.runs.hide([], 60)).toBe(0);
  expect(r.runs.get(done)?.hiddenAt).toBe(50);
});

test("runs.hideFinished hides every finished, not yet hidden run of that account only, returns the count", () => {
  const r = mem();
  const mine = (["done", "failed", "limited", "stopped"] as const).map((status) => r.runs.insert(run({ status })).id);
  const running = r.runs.insert(run({ status: "running" })).id;
  const hidden = r.runs.insert(run({ status: "done", hiddenAt: 7 })).id;
  const other = r.runs.insert(run({ status: "done", accountId: "a2" })).id;
  expect(r.runs.hideFinished("a1", 50)).toBe(4);
  expect(mine.map((id) => r.runs.get(id)?.hiddenAt)).toEqual([50, 50, 50, 50]);
  expect([running, hidden, other].map((id) => r.runs.get(id)?.hiddenAt)).toEqual([undefined, 7, undefined]);
  expect(r.runs.hideFinished("a1", 60)).toBe(0);
  expect(r.runs.hideFinished("nobody", 60)).toBe(0);
});

test("runs.countSince counts by createdAt, including the exact boundary", () => {
  const r = mem();
  for (const createdAt of [100, 200, 300]) r.runs.insert(run({ createdAt }));
  expect(r.runs.countSince(200)).toBe(2);
  expect(r.runs.countSince(301)).toBe(0);
  expect(r.runs.countSince(0)).toBe(3);
});

test("runs.lastPrimary skips primaryWorker=false and rows without sessionId, takes the newest row", () => {
  const r = mem();
  r.runs.insert(run({ primaryWorker: true, sessionId: "old" }));
  const newest = r.runs.insert(run({ primaryWorker: true, sessionId: "new", status: "done" }));
  r.runs.insert(run({ primaryWorker: false, sessionId: "not-primary" }));
  r.runs.insert(run({ primaryWorker: true }));
  r.runs.insert(run({ primaryWorker: true, sessionId: "other-cwd", cwd: "/q" }));
  r.runs.insert(run({ primaryWorker: true, sessionId: "other-acc", accountId: "a2" }));
  expect(r.runs.lastPrimary("a1", "/p")?.id).toBe(newest.id);
  expect(r.runs.lastPrimary("a1", "/p")?.sessionId).toBe("new");
  expect(r.runs.lastPrimary("a1", "/nowhere")).toBeUndefined();
  expect(r.runs.lastPrimary("a3", "/p")).toBeUndefined();
});

test("runEvents: add then list in insertion order, separated by run", () => {
  const r = mem();
  r.runEvents.add(1, "tool", "Read a.ts", 10);
  r.runEvents.add(1, "text", "reading", 11);
  r.runEvents.add(2, "text", "other run", 12);
  const events = r.runEvents.list(1);
  expect(events.map((e) => [e.kind, e.text, e.createdAt, e.runId])).toEqual([["tool", "Read a.ts", 10, 1], ["text", "reading", 11, 1]]);
  expect(events[1]!.id).toBeGreaterThan(events[0]!.id);
  expect(r.runEvents.list(3)).toEqual([]);
});

test("limits: the defaults are the documented numbers; saved then read; a missing key takes the default", () => {
  const r = mem();
  expect(r.settings.getLimits()).toEqual(DEFAULT_LIMITS);
  expect(DEFAULT_LIMITS).toEqual({
    maxConcurrent: 4, runTimeoutMs: 1_800_000, maxRunsPerHour: 30, quotaStaleMs: 120_000,
    warmBonusPts: 15, inFlightPenaltyPts: 5, workerIdleMs: 3_600_000, workerMaxContextTokens: 100_000,
  });
  r.settings.setLimits({ ...DEFAULT_LIMITS, maxConcurrent: 2 });
  expect(r.settings.getLimits()).toEqual({ ...DEFAULT_LIMITS, maxConcurrent: 2 });
  r.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('limits', ?)").run(JSON.stringify({ maxRunsPerHour: 7, maxDepth: 3 }));
  expect(r.settings.getLimits()).toEqual({ ...DEFAULT_LIMITS, maxRunsPerHour: 7, maxDepth: 3 });
});

test("tx commits when done, rolls back and rethrows when the function fails", () => {
  const r = mem();
  expect(r.tx(() => r.runs.insert(run()).id)).toBe(1);
  expect(() =>
    r.tx(() => {
      r.runs.insert(run());
      throw new Error("failed midway");
    }),
  ).toThrow("failed midway");
  expect(r.runs.recent(10)).toHaveLength(1);
  expect(r.runs.insert(run()).id).toBe(2); // connection is usable again after the rollback
});

const HOLD_LOCK = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO settings (key, value) VALUES ('child', 'x')").run();
console.log("locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);
`;

test("two connections on one file: while one holds the write lock the other waits, then writes (no SQLITE_BUSY)", async () => {
  const file = tmpFile();
  const repos = createRepos(openDb(file));
  const child = spawn(process.execPath, ["--no-warnings", "-e", HOLD_LOCK, file], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (d: Buffer) => d.toString().includes("locked") && resolve());
    child.on("exit", () => reject(new Error("child exited before locking")));
  });
  const inserted = repos.runs.insert(run()); // blocks on the child's lock instead of throwing SQLITE_BUSY
  expect(await exited).toBe(0);
  expect(repos.runs.get(inserted.id)).toBeDefined();
  expect(repos.db.prepare("SELECT value FROM settings WHERE key = 'child'").get()).toEqual({ value: "x" });
});

test("settings: Claude desktop account set, read, set to undefined deletes it", () => {
  const r = mem();
  expect(r.settings.getDesktopAccount()).toBeUndefined();
  r.settings.setDesktopAccount("a1");
  expect(r.settings.getDesktopAccount()).toBe("a1");
  r.settings.setDesktopAccount("b2");
  expect(r.settings.getDesktopAccount()).toBe("b2");
  r.settings.setDesktopAccount(undefined);
  expect(r.settings.getDesktopAccount()).toBeUndefined();
  expect(r.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'desktopAccount'").get()).toEqual({ n: 0 });
});

test("settings: recent folders, adding 6 keeps 5, newest first", () => {
  const r = mem();
  expect(r.settings.getRecentDirs("a1")).toEqual([]);
  for (const d of ["/1", "/2", "/3", "/4", "/5", "/6"]) r.settings.addRecentDir("a1", d);
  expect(r.settings.getRecentDirs("a1")).toEqual(["/6", "/5", "/4", "/3", "/2"]);
});

test("settings: adding an old folder again moves it to the front, no duplicates", () => {
  const r = mem();
  for (const d of ["/1", "/2", "/3"]) r.settings.addRecentDir("a1", d);
  r.settings.addRecentDir("a1", "/1");
  expect(r.settings.getRecentDirs("a1")).toEqual(["/1", "/3", "/2"]);
});

test("settings: recent folders of two accounts stay separate; clearRecentDirs clears only one account's", () => {
  const r = mem();
  r.settings.addRecentDir("a1", "/x");
  r.settings.addRecentDir("a2", "/y");
  expect(r.settings.getRecentDirs("a1")).toEqual(["/x"]);
  expect(r.settings.getRecentDirs("a2")).toEqual(["/y"]);
  r.settings.clearRecentDirs("a1");
  expect(r.settings.getRecentDirs("a1")).toEqual([]);
  expect(r.settings.getRecentDirs("a2")).toEqual(["/y"]);
  r.settings.clearRecentDirs("nope"); // nothing stored for it: no error
  expect(r.settings.getRecentDirs("a2")).toEqual(["/y"]);
});

test("settings: a corrupt or malformed recentDirs value reads as empty, the next add writes a clean value", () => {
  const r = mem();
  const put = (v: string) => r.db.prepare("INSERT INTO settings (key, value) VALUES ('recentDirs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
  for (const bad of ["{not json", "null", "[1,2]", '"x"', '{"a1":"/x"}', '{"a1":["/x",3]}', '{"a1":null}']) {
    put(bad);
    expect(r.settings.getRecentDirs("a1")).toEqual([]);
  }
  put('{"a1":["/x",3],"a2":["/y"]}');
  expect(r.settings.getRecentDirs("a2")).toEqual(["/y"]); // one bad entry does not spoil the others
  r.settings.addRecentDir("a1", "/new");
  expect(JSON.parse((r.db.prepare("SELECT value FROM settings WHERE key = 'recentDirs'").get() as { value: string }).value)).toEqual({ a1: ["/new"], a2: ["/y"] });
  put("{not json");
  r.settings.addRecentDir("a1", "/new");
  expect(r.settings.getRecentDirs("a1")).toEqual(["/new"]);
});
