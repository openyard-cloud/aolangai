import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, config_dir TEXT, command TEXT,
    args TEXT, env TEXT, secret_ref TEXT, model TEXT
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles(id), instructions TEXT,
    approval_level TEXT NOT NULL, can_write INTEGER NOT NULL, auto_all_when_delegated INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, cwd TEXT NOT NULL, external_id TEXT,
    is_primary INTEGER NOT NULL, state TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_agent_cwd ON sessions(agent_id, cwd);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL, text TEXT NOT NULL,
    task_id INTEGER, chain_id TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER
  );
  CREATE INDEX messages_session ON messages(session_id, created_at);
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_session_id TEXT NOT NULL, to_agent_id TEXT NOT NULL,
    to_session_id TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL, read_only INTEGER NOT NULL,
    depth INTEGER NOT NULL, chain_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT,
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
  );
  CREATE INDEX tasks_status ON tasks(status);
  CREATE TABLE events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX events_session ON events(session_id, created_at);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id INTEGER, kind TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `ALTER TABLE agents ADD COLUMN allowed_dirs TEXT;`,
  `ALTER TABLE sessions ADD COLUMN title TEXT;`,
  `CREATE TABLE account_status (profile_id TEXT PRIMARY KEY, data TEXT NOT NULL);`,
  // 5: accounts, runs and run events replace profiles, agents, sessions, messages, tasks, events and approvals.
  // Only claude-subscription profiles become accounts. An account accepts work when at least one of its agents is a
  // worker. allowed_dirs is the union of the agents' lists (workers only, when it has any: a boss agent's folders say
  // nothing about where delegated work may go); one agent without a list, or no agent at all, means no limit.
  // account_status is dropped and recreated keyed by account_id: quota numbers refill within a minute.
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, config_dir TEXT, model TEXT, accepting INTEGER NOT NULL DEFAULT 0,
    allowed_dirs TEXT NOT NULL DEFAULT '[]', reserve_pct INTEGER NOT NULL DEFAULT 90, permission_mode TEXT
  );
  WITH scope AS (
    SELECT p.id AS account_id, a.allowed_dirs AS allowed_dirs
    FROM profiles p JOIN agents a ON a.profile_id = p.id
    WHERE p.kind = 'claude-subscription'
      AND (a.role = 'worker' OR NOT EXISTS (SELECT 1 FROM agents w WHERE w.profile_id = p.id AND w.role = 'worker'))
  )
  INSERT INTO accounts (id, name, config_dir, model, accepting, allowed_dirs, reserve_pct)
  SELECT p.id, p.name, p.config_dir, p.model,
    EXISTS (SELECT 1 FROM agents a WHERE a.profile_id = p.id AND a.role = 'worker'),
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM scope s WHERE s.account_id = p.id)
        OR EXISTS (SELECT 1 FROM scope s WHERE s.account_id = p.id AND (s.allowed_dirs IS NULL OR json_array_length(s.allowed_dirs) = 0))
      THEN '[]'
      ELSE (SELECT json_group_array(d.value) FROM (
        SELECT DISTINCT j.value AS value FROM scope s, json_each(s.allowed_dirs) j WHERE s.account_id = p.id
      ) d)
    END,
    90
  FROM profiles p WHERE p.kind = 'claude-subscription' ORDER BY p.rowid;
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, label TEXT, cwd TEXT NOT NULL, account_id TEXT NOT NULL,
    session_id TEXT, primary_worker INTEGER NOT NULL, read_only INTEGER NOT NULL, status TEXT NOT NULL,
    result TEXT, error TEXT, denials TEXT, note TEXT, pid INTEGER, pid_start TEXT, retry_of INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, context_tokens INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
  );
  CREATE INDEX runs_status ON runs(status);
  CREATE INDEX runs_account_cwd ON runs(account_id, cwd);
  CREATE TABLE run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX run_events_run ON run_events(run_id, id);
  DROP TABLE account_status;
  CREATE TABLE account_status (account_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  DROP TABLE approvals; DROP TABLE events; DROP TABLE messages; DROP TABLE tasks; DROP TABLE sessions;
  DROP TABLE agents; DROP TABLE profiles;
  `,
  // 6: the claude process of a run, so a run whose dispatcher died can have its orphaned claude killed.
  `ALTER TABLE runs ADD COLUMN worker_pid INTEGER; ALTER TABLE runs ADD COLUMN worker_pid_start TEXT;`,
  // 7: the Claude Code session that called `aolangai run`, for the delegation map.
  `ALTER TABLE runs ADD COLUMN caller_pid INTEGER; ALTER TABLE runs ADD COLUMN caller_started_at INTEGER;
   ALTER TABLE runs ADD COLUMN caller_kind TEXT; ALTER TABLE runs ADD COLUMN caller_account_id TEXT;`,
];

/** Opens (or creates) the database and brings its schema up to date. Use ":memory:" in tests. */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000"); // first: switching to WAL and migrating also wait for another process's write lock
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const userVersion = () => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = userVersion(); v < MIGRATIONS.length; v++) {
    // IMMEDIATE takes the write lock up front (waiting up to busy_timeout), so a second process opening the same
    // file at the same time queues behind this one; it then re-reads the version and skips what is already done.
    db.exec("BEGIN IMMEDIATE");
    try {
      if (userVersion() <= v) {
        db.exec(MIGRATIONS[v]!);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}
