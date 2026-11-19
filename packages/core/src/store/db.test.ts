import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "./db.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-db-")), "test.db");

/** A database as the previous release left it: the first four migrations applied, user_version 4. */
function oldDb(file: string, fill: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 4)) db.exec(m);
  db.exec("PRAGMA user_version = 4");
  fill(db);
  db.close();
}

const profile = (db: DatabaseSync, id: string, name: string, kind: string, configDir: string | null) =>
  db.prepare("INSERT INTO profiles (id, name, kind, config_dir, model) VALUES (?, ?, ?, ?, NULL)").run(id, name, kind, configDir);
const agent = (db: DatabaseSync, id: string, role: string, profileId: string, allowedDirs: string | null) =>
  db
    .prepare("INSERT INTO agents (id, name, role, profile_id, approval_level, can_write, auto_all_when_delegated, allowed_dirs) VALUES (?, ?, ?, ?, 'ask-all', 1, 0, ?)")
    .run(id, id, role, profileId, allowedDirs);

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

test("migration 5 turns claude-subscription profiles into accounts and drops the old table", () => {
  const file = tmpFile();
  oldDb(file, (db) => {
    profile(db, "p1", "Personal", "claude-subscription", "/cfg/a");
    profile(db, "p2", "Boss acc", "claude-subscription", null);
    profile(db, "p3", "Side", "claude-subscription", "/cfg/c");
    profile(db, "p4", "DS", "deepseek", null);
    agent(db, "worker", "worker", "p1", JSON.stringify(["/Users/x/Projects/app"]));
    agent(db, "boss", "boss", "p2", null);
    agent(db, "worker2", "worker", "p3", null);
    db.prepare("INSERT INTO account_status (profile_id, data) VALUES ('p1', '{}')").run();
  });
  const db = openDb(file);
  const rows = db.prepare("SELECT * FROM accounts ORDER BY rowid").all() as Record<string, unknown>[];
  expect(rows.map((r) => [r.id, r.name, r.config_dir ?? null])).toEqual([
    ["p1", "Personal", "/cfg/a"],
    ["p2", "Boss acc", null],
    ["p3", "Side", "/cfg/c"],
  ]);
  expect(rows.map((r) => r.accepting)).toEqual([1, 0, 1]);
  expect(JSON.parse(rows[0]!.allowed_dirs as string)).toEqual(["/Users/x/Projects/app"]);
  expect(JSON.parse(rows[1]!.allowed_dirs as string)).toEqual([]);
  expect(JSON.parse(rows[2]!.allowed_dirs as string)).toEqual([]);
  expect(rows.map((r) => r.reserve_pct)).toEqual([90, 90, 90]);
  expect(rows.every((r) => r.permission_mode === null)).toBe(true);
  for (const t of ["profiles", "agents", "sessions", "messages", "tasks", "events", "approvals"]) expect(tables(db)).not.toContain(t);
  expect(tables(db)).toEqual(expect.arrayContaining(["accounts", "runs", "run_events", "account_status", "settings"]));
  expect(db.prepare("SELECT COUNT(*) AS n FROM account_status").get()).toEqual({ n: 0 });
  expect((db.prepare("PRAGMA table_info(account_status)").all() as { name: string }[]).map((c) => c.name)).toContain("account_id");
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  db.close();
});

test("several agents on one profile: accepting if any is a worker, allowed_dirs is the union, unrestricted wins", () => {
  const file = tmpFile();
  oldDb(file, (db) => {
    for (const id of ["a", "b", "c", "d", "e"]) profile(db, id, id, "claude-subscription", null);
    agent(db, "a1", "worker", "a", JSON.stringify(["/x", "/y"]));
    agent(db, "a2", "worker", "a", JSON.stringify(["/y", "/z"]));
    agent(db, "b1", "worker", "b", JSON.stringify(["/x"]));
    agent(db, "b2", "worker", "b", null);
    agent(db, "c1", "worker", "c", JSON.stringify(["/x"]));
    agent(db, "c2", "worker", "c", "[]");
    agent(db, "d1", "boss", "d", JSON.stringify(["/q"]));
    agent(db, "d2", "worker", "d", JSON.stringify(["/x"]));
    // profile "e" has no agent at all
  });
  const db = openDb(file);
  const by = Object.fromEntries(
    (db.prepare("SELECT * FROM accounts").all() as Record<string, unknown>[]).map((r) => [r.id, { acc: r.accepting, dirs: JSON.parse(r.allowed_dirs as string) as string[] }]),
  );
  expect(by.a).toEqual({ acc: 1, dirs: ["/x", "/y", "/z"] });
  expect(by.b).toEqual({ acc: 1, dirs: [] });
  expect(by.c).toEqual({ acc: 1, dirs: [] });
  expect(by.d).toEqual({ acc: 1, dirs: ["/x"] });
  expect(by.e).toEqual({ acc: 0, dirs: [] });
  db.close();
});

test("a fresh DB has every table and reopens", () => {
  const file = tmpFile();
  openDb(file).close();
  const db = openDb(file);
  expect(tables(db)).toEqual(expect.arrayContaining(["accounts", "runs", "run_events", "account_status", "settings"]));
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  db.close();
});
