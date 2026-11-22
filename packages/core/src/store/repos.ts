import type { SQLInputValue } from "node:sqlite";
import type { Db } from "./db.js";
import {
  DEFAULT_LIMITS,
  type Account,
  type AccountStatus,
  type Limits,
  type Run,
  type RunEvent,
} from "../types.js";

export interface Repos {
  db: Db;
  accounts: { list(): Account[]; get(id: string): Account | undefined; insert(a: Account): void; update(a: Account): void; delete(id: string): void };
  status: { get(accountId: string): AccountStatus | undefined; set(s: AccountStatus): void; list(): AccountStatus[]; delete(accountId: string): void };
  runs: {
    insert(r: Omit<Run, "id">): Run;
    /** Changes only the fields present (and not undefined) in `patch`. */
    update(id: number, patch: Partial<Run>): void;
    get(id: number): Run | undefined;
    running(): Run[];
    /** Newest first (by id). */
    recent(limit: number): Run[];
    /** Runs with created_at >= ms. */
    countSince(ms: number): number;
    /** Newest finished or running run of (account, cwd) with primaryWorker and a sessionId. */
    lastPrimary(accountId: string, cwd: string): Run | undefined;
    /** Newest running run of (account, cwd) with primaryWorker, with or without a sessionId yet. */
    runningPrimary(accountId: string, cwd: string): Run | undefined;
  };
  runEvents: { add(runId: number, kind: RunEvent["kind"], text: string, at: number): void; list(runId: number): RunEvent[] };
  settings: {
    getLimits(): Limits;
    setLimits(l: Limits): void;
    /** The account the owner says Claude desktop is logged into; nothing checks that it still exists. */
    getDesktopAccount(): string | undefined;
    /** undefined removes the choice. */
    setDesktopAccount(id: string | undefined): void;
    /** Folders the owner last opened a Terminal in on this account, newest first (at most 5); a corrupt stored value reads as empty. */
    getRecentDirs(accountId: string): string[];
    /** Puts dir first (compared as an exact string), drops its older copy, keeps the newest 5. */
    addRecentDir(accountId: string, dir: string): void;
    clearRecentDirs(accountId: string): void;
  };
  /** Runs fn inside BEGIN IMMEDIATE … COMMIT; rolls back and rethrows on error. */
  tx<T>(fn: () => T): T;
}

type ColKind = "text" | "int" | "bool" | "json";
type Columns<T> = { [K in keyof T]-?: ColKind };
type Row = Record<string, unknown>;

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Optional fields are NULL in the database and undefined (never null) in objects; booleans are 0/1; json is text. */
function toDb(kind: ColKind, v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (kind === "bool") return v ? 1 : 0;
  if (kind === "json") return JSON.stringify(v);
  return v as SQLInputValue;
}

function fromDb(kind: ColKind, v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (kind === "bool") return Number(v) === 1;
  if (kind === "json") return JSON.parse(v as string);
  if (kind === "int") return Number(v);
  return v;
}

/** Maps camelCase objects to snake_case columns of one table. */
function mapper<T extends object>(cols: Columns<T>) {
  const keys = Object.keys(cols) as (keyof T & string)[];
  return {
    keys,
    columns: (ks: string[]) => ks.map((k) => `"${snake(k)}"`),
    values: (obj: object, ks: string[]) => ks.map((k) => toDb(cols[k as keyof T], (obj as Row)[k])),
    read(r: Row): T {
      const out: Row = {};
      for (const k of keys) {
        const v = fromDb(cols[k], r[snake(k)]);
        if (v !== undefined) out[k] = v;
      }
      return out as T;
    },
  };
}

/** How many recent Terminal folders are kept per account. */
const RECENT_DIRS_MAX = 5;
const ACCOUNT_COLS: Columns<Account> = {
  id: "text", name: "text", configDir: "text", model: "text", accepting: "bool", allowedDirs: "json", reservePct: "int", permissionMode: "text",
};
const RUN_COLS: Columns<Run> = {
  id: "int", prompt: "text", label: "text", cwd: "text", accountId: "text", sessionId: "text", primaryWorker: "bool", readOnly: "bool",
  status: "text", result: "text", error: "text", denials: "json", note: "text", pid: "int", pidStart: "text",
  workerPid: "int", workerPidStart: "text", retryOf: "int",
  callerPid: "int", callerStartedAt: "int", callerKind: "text", callerAccountId: "text",
  inputTokens: "int", outputTokens: "int", contextTokens: "int", createdAt: "int", finishedAt: "int",
};
const EVENT_COLS: Columns<RunEvent> = { id: "int", runId: "int", kind: "text", text: "text", createdAt: "int" };

export function createRepos(db: Db): Repos {
  const acc = mapper<Account>(ACCOUNT_COLS);
  const runMap = mapper<Run>(RUN_COLS);
  const evMap = mapper<RunEvent>(EVENT_COLS);

  const accountRows = (sql: string, ...p: SQLInputValue[]) => (db.prepare(sql).all(...p) as Row[]).map(acc.read);
  const runRows = (sql: string, ...p: SQLInputValue[]) => (db.prepare(sql).all(...p) as Row[]).map(runMap.read);
  const getRun = (id: number) => runRows("SELECT * FROM runs WHERE id = ?", id)[0];

  const statuses = (sql: string, ...p: SQLInputValue[]) => (db.prepare(sql).all(...p) as { data: string }[]).map((r) => JSON.parse(r.data) as AccountStatus);

  const getSetting = (key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  /** The stored `recentDirs` map; anything that is not a plain object reads as empty, and an entry that is not an array of strings is dropped. */
  const readRecentDirs = (): Record<string, string[]> => {
    const out = Object.create(null) as Record<string, string[]>;
    try {
      const parsed: unknown = JSON.parse(getSetting("recentDirs") ?? "null");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
      for (const [id, dirs] of Object.entries(parsed)) {
        if (Array.isArray(dirs) && dirs.every((d) => typeof d === "string")) out[id] = dirs as string[];
      }
    } catch {
      // not JSON: read as empty
    }
    return out;
  };
  const writeRecentDirs = (all: Record<string, string[]>) =>
    void db.prepare("INSERT INTO settings (key, value) VALUES ('recentDirs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(all));

  return {
    db,
    accounts: {
      list: () => accountRows("SELECT * FROM accounts ORDER BY rowid"),
      get: (id) => accountRows("SELECT * FROM accounts WHERE id = ?", id)[0],
      insert(a) {
        db.prepare(`INSERT INTO accounts (${acc.columns(acc.keys).join(", ")}) VALUES (${acc.keys.map(() => "?").join(", ")})`).run(...acc.values(a, acc.keys));
      },
      /** Replaces every field: optional fields missing from `a` are cleared. */
      update(a) {
        const ks = acc.keys.filter((k) => k !== "id");
        const info = db.prepare(`UPDATE accounts SET ${acc.columns(ks).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...acc.values(a, ks), a.id);
        if (info.changes === 0) throw new Error(`accounts: ${a.id} not found`);
      },
      delete: (id) => void db.prepare("DELETE FROM accounts WHERE id = ?").run(id),
    },
    status: {
      get: (accountId) => statuses("SELECT data FROM account_status WHERE account_id = ?", accountId)[0],
      set: (s) =>
        void db
          .prepare("INSERT INTO account_status (account_id, data) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data")
          .run(s.accountId, JSON.stringify(s)),
      list: () => statuses("SELECT data FROM account_status ORDER BY rowid"),
      delete: (accountId) => void db.prepare("DELETE FROM account_status WHERE account_id = ?").run(accountId),
    },
    runs: {
      insert(r) {
        const ks = runMap.keys.filter((k) => k !== "id" && (r as Row)[k] !== undefined);
        const info = db.prepare(`INSERT INTO runs (${runMap.columns(ks).join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`).run(...runMap.values(r, ks));
        return getRun(Number(info.lastInsertRowid))!;
      },
      update(id, patch) {
        const ks = runMap.keys.filter((k) => k !== "id" && (patch as Row)[k] !== undefined);
        if (ks.length === 0) return;
        db.prepare(`UPDATE runs SET ${runMap.columns(ks).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...runMap.values(patch, ks), id);
      },
      get: getRun,
      running: () => runRows("SELECT * FROM runs WHERE status = 'running' ORDER BY id"),
      recent: (limit) => runRows("SELECT * FROM runs ORDER BY id DESC LIMIT ?", limit),
      countSince: (ms) => Number((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?").get(ms) as { n: number }).n),
      lastPrimary: (accountId, cwd) =>
        runRows("SELECT * FROM runs WHERE account_id = ? AND cwd = ? AND primary_worker = 1 AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1", accountId, cwd)[0],
      runningPrimary: (accountId, cwd) =>
        runRows("SELECT * FROM runs WHERE account_id = ? AND cwd = ? AND primary_worker = 1 AND status = 'running' ORDER BY id DESC LIMIT 1", accountId, cwd)[0],
    },
    runEvents: {
      add: (runId, kind, text, at) =>
        void db.prepare("INSERT INTO run_events (run_id, kind, text, created_at) VALUES (?, ?, ?, ?)").run(runId, kind, text, at),
      list: (runId) => (db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id").all(runId) as Row[]).map(evMap.read),
    },
    settings: {
      getLimits(): Limits {
        const raw = getSetting("limits");
        return { ...DEFAULT_LIMITS, ...(raw ? (JSON.parse(raw) as Partial<Limits>) : {}) };
      },
      setLimits(l) {
        db.prepare("INSERT INTO settings (key, value) VALUES ('limits', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(l));
      },
      getRecentDirs: (accountId) => readRecentDirs()[accountId] ?? [],
      addRecentDir(accountId, dir) {
        const all = readRecentDirs();
        all[accountId] = [dir, ...(all[accountId] ?? []).filter((d) => d !== dir)].slice(0, RECENT_DIRS_MAX);
        writeRecentDirs(all);
      },
      clearRecentDirs(accountId) {
        const all = readRecentDirs();
        if (!(accountId in all)) return;
        delete all[accountId];
        writeRecentDirs(all);
      },
      getDesktopAccount: () => getSetting("desktopAccount"),
      setDesktopAccount(id) {
        if (id === undefined) db.prepare("DELETE FROM settings WHERE key = 'desktopAccount'").run();
        else db.prepare("INSERT INTO settings (key, value) VALUES ('desktopAccount', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
      },
    },
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // the original error matters more than a failed rollback
        }
        throw e;
      }
    },
  };
}
