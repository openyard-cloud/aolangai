import { test, expect, afterEach, vi } from "vitest";
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepos, openDb, processStart, LOST_DISPATCHER, DEFAULT_LIMITS, shimText, type Account, type CliRuntime, type Repos, type Run } from "@aolangai/core";
import { DESKTOP_KIND, OTHER_KIND, type AppState, type OpenSession } from "../shared/api.js";
import { createApi, dispatch, type ApiDeps, type SpawnedChild } from "./ipc.js";
import { focusTerminalOsascriptArgs, startOsascriptArgs } from "./login.js";

const dirs: string[] = [];
const dbs: Repos["db"][] = [];
const children: { kill(): void }[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: Parameters<ApiDeps["spawn"]>[2];
  stdin: string;
  ended: boolean;
  unref: boolean;
  /** What the fake CLI writes to its stderr, in chunks as given. */
  writeStderr(chunk: string): void;
  /** The fake CLI ends: its streams closed, with this code. */
  close(code: number | null, signal?: NodeJS.Signals | null): void;
  fail(e: Error): void;
}

function setup(o: { node?: string | null; claude?: string | null; cliBuilt?: boolean; runtime?: CliRuntime; packaged?: boolean; openAtLogin?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-ipc-"));
  dirs.push(root);
  const dbPath = path.join(root, "aolangai.db");
  const db = openDb(dbPath);
  dbs.push(db);
  const repos = createRepos(db);
  const entry = path.join(root, "cli", "dist", "index.js");
  if (o.cliBuilt !== false) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// cli");
  }
  const skillFile = path.join(root, "cli", "skill", "SKILL.md");
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, "# skill aolangai-managed\n");
  const found: Record<string, string | null> = { node: o.node === undefined ? "/usr/local/bin/node" : o.node, claude: o.claude === undefined ? "/usr/local/bin/claude" : o.claude };

  const login = { on: o.openAtLogin ?? false, sets: [] as boolean[] };
  const states: AppState[] = [];
  const spawns: SpawnCall[] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const externals: string[] = [];
  const osascripts: string[][] = [];
  const openedApps: string[] = [];
  const execs: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const notices: { title: string; body: string }[] = [];
  /** The folder picker: `choice` is what the owner picks (undefined = cancel); `defaults` the folder it opened on; `recents` the recent folders it was offered. */
  const picker: { choice: string | undefined; defaults: string[]; recents: string[][] } = { choice: undefined, defaults: [], recents: [] };
  const scans: { accounts: Account[]; excludePids: number[] }[] = [];
  const handlers = {
    /** What the fake osascript prints. */
    osascript: (async () => "") as (args: string[]) => Promise<string>,
    scanSessions: (async () => []) as ApiDeps["scanSessions"],
    exec: (async (cmd, args, env) => {
      execs.push({ cmd, args, env });
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) };
    }) as ApiDeps["exec"],
  };
  const deps: ApiDeps = {
    repos,
    dbPath,
    userData: path.join(root, "userData"),
    env: { PATH: "/usr/bin", HOME: "/h", AOLANGAI_RUN_ID: "5" },
    exec: (cmd, args, env) => handlers.exec(cmd, args, env),
    which: (cmd) => found[cmd] ?? null,
    runtime: o.runtime ?? { execPath: "/usr/local/bin/node", electron: false },
    packaged: o.packaged ?? false,
    loginItem: { get: () => login.on, set: (on) => void login.sets.push((login.on = on)) },
    scanSessions: (accounts, excludePids) => {
      scans.push({ accounts, excludePids });
      return handlers.scanSessions(accounts, excludePids);
    },
    spawn(cmd, args, opts) {
      const on: Record<string, ((...a: never[]) => void)[]> = {};
      const onStderr: ((chunk: Buffer) => void)[] = [];
      const call: SpawnCall = {
        cmd, args, opts, stdin: "", ended: false, unref: false,
        writeStderr: (chunk) => onStderr.forEach((cb) => cb(Buffer.from(chunk))),
        close: (code, signal = null) => (on.close ?? []).forEach((cb) => (cb as (c: number | null, s: NodeJS.Signals | null) => void)(code, signal)),
        fail: (e) => (on.error ?? []).forEach((cb) => (cb as (e: Error) => void)(e)),
      };
      spawns.push(call);
      const child: SpawnedChild = {
        stdin: { write: (s) => void (call.stdin += s), end: () => void (call.ended = true), on: () => undefined },
        stderr: { on: (_event: "data", cb: (chunk: Buffer) => void) => void onStderr.push(cb) },
        unref: () => void (call.unref = true),
        on: (event: string, cb: (...a: never[]) => void) => void (on[event] ??= []).push(cb),
      } as SpawnedChild;
      return child;
    },
    openPath: async (p) => {
      opened.push(p);
      return "";
    },
    showItemInFolder: (p) => void revealed.push(p),
    openExternal: async (url) => void externals.push(url),
    runOsascript: async (args) => {
      osascripts.push(args);
      return handlers.osascript(args);
    },
    openApp: async (appPath) => void openedApps.push(appPath),
    pickFolder: async (defaultPath, recent) => {
      picker.defaults.push(defaultPath);
      picker.recents.push(recent);
      return picker.choice;
    },
    cli: { entry, skillFile },
    installPaths: { skillDir: path.join(root, "home", "skills", "aolangai"), binDir: path.join(root, "home", "bin") },
    now: () => 1_000_000,
    emitState: (s) => void states.push(s),
    emitNotice: (n) => void notices.push(n),
  };
  const api = createApi(deps);
  return { root, repos, api, deps, handlers, scans, states, spawns, opened, revealed, externals, osascripts, openedApps, picker, execs, found, entry, notices, login };
}
type Setup = ReturnType<typeof setup>;

const newAccount = (o: Partial<Omit<Account, "id">> = {}): Omit<Account, "id"> => ({ name: "Personal", accepting: true, allowedDirs: [], reservePct: 90, ...o });
const insertAccount = (repos: Repos, o: Partial<Account> = {}): Account => {
  const a: Account = { id: "a1", name: "Personal", accepting: true, allowedDirs: [], reservePct: 90, ...o };
  repos.accounts.insert(a);
  return a;
};
const insertRun = (repos: Repos, o: Partial<Omit<Run, "id">> = {}): Run =>
  repos.runs.insert({ prompt: "do the work", cwd: "/p", accountId: "a1", primaryWorker: true, readOnly: false, status: "done", createdAt: 1, ...o });

// ---- saveAccount

test("saveAccount new: an id is generated, accepting is false even when sent true, reservePct 90, allowedDirs empty when missing", async () => {
  const { api, repos } = setup();
  const a = await api.saveAccount({ ...newAccount({ name: "  Work  " }), reservePct: undefined as unknown as number, allowedDirs: undefined as unknown as string[] });
  expect(a.id).toMatch(/\S/);
  expect(a).toMatchObject({ name: "Work", accepting: false, reservePct: 90, allowedDirs: [] });
  expect(repos.accounts.get(a.id)).toEqual(a);
});

test("saveAccount editing an existing account: keeps the id, overwrites the fields, accepting can be turned on", async () => {
  const { api, repos } = setup();
  const a = await api.saveAccount(newAccount());
  const b = await api.saveAccount({ ...a, accepting: true, reservePct: 75, allowedDirs: ["~/code", "/work"], model: "sonnet" });
  expect(b).toEqual({ ...a, accepting: true, reservePct: 75, allowedDirs: ["~/code", "/work"], model: "sonnet" });
  expect(repos.accounts.list()).toHaveLength(1);
});

test("saveAccount changing the config dir: the old quota and connection are dropped", async () => {
  const { api, repos } = setup();
  const a = await api.saveAccount({ ...newAccount(), configDir: "/tmp/one" });
  repos.status.set({ accountId: a.id, fiveHour: { usedPct: 50 } });
  await api.saveAccount({ ...a, name: "Renamed" });
  expect(repos.status.get(a.id)).toBeDefined();
  await api.saveAccount({ ...a, configDir: "/tmp/two" });
  expect(repos.status.get(a.id)).toBeUndefined();
});

test.each([
  [{ name: "   " }, /name/i],
  [{ reservePct: 101 }, /0 to 100/],
  [{ reservePct: -1 }, /0 to 100/],
  [{ reservePct: 80.5 }, /0 to 100/],
  [{ allowedDirs: ["code"] }, /full path/],
  [{ allowedDirs: ["~x"] }, /full path/],
  [{ configDir: "relative/dir" }, /config dir/i],
])("saveAccount rejects %j", async (bad, re) => {
  const { api, repos } = setup();
  await expect(api.saveAccount({ ...newAccount(), ...bad })).rejects.toThrow(re);
  expect(repos.accounts.list()).toEqual([]);
});

test("saveAccount rejects a duplicate name (ignoring case and surrounding spaces), but editing the account itself is fine", async () => {
  const { api } = setup();
  const a = await api.saveAccount(newAccount({ name: "Personal" }));
  await expect(api.saveAccount(newAccount({ name: " pERSONAL " }))).rejects.toThrow(/already exists/i);
  await expect(api.saveAccount({ ...a, name: "PERSONAL" })).resolves.toMatchObject({ id: a.id, name: "PERSONAL" });
});

test("saveAccount rejects two accounts sharing a config dir (empty and ~/.claude are the same)", async () => {
  const { api } = setup();
  await api.saveAccount(newAccount({ name: "A" }));
  await expect(api.saveAccount(newAccount({ name: "B", configDir: "~/.claude" }))).rejects.toThrow(/config dir/i);
  await expect(api.saveAccount(newAccount({ name: "B", configDir: path.join(os.homedir(), ".claude") + "/" }))).rejects.toThrow(/config dir/i);
  const c = await api.saveAccount(newAccount({ name: "C", configDir: "~/Claude C" }));
  await expect(api.saveAccount(newAccount({ name: "D", configDir: path.join(os.homedir(), "Claude C", "..", "Claude C") }))).rejects.toThrow(/config dir/i);
  expect(c.configDir).toBe("~/Claude C");
});

test('saveAccount new with configDir "auto": <userData>/profiles/<id>, folder not created yet', async () => {
  const { api, deps } = setup();
  const a = await api.saveAccount(newAccount({ configDir: "auto" }));
  expect(a.configDir).toBe(path.join(deps.userData, "profiles", a.id));
  expect(fs.existsSync(a.configDir!)).toBe(false);
});

test("saveAccount sends the new state at once (written over the app's own connection, data_version unchanged)", async () => {
  const { api, states } = setup();
  const a = await api.saveAccount(newAccount());
  expect(states).toHaveLength(1);
  expect(states[0]!.accounts.map((x) => x.id)).toEqual([a.id]);
});

// ---- deleteAccount

test("deleteAccount refuses when the account has a run in progress", async () => {
  const { api, repos } = setup();
  insertAccount(repos);
  insertRun(repos, { status: "running" });
  await expect(api.deleteAccount("a1")).rejects.toThrow(/has runs in progress/);
  expect(repos.accounts.get("a1")).toBeDefined();
});

test("deleteAccount deletes the account and its status row; the account's old runs do not stop it", async () => {
  const { api, repos, states } = setup();
  insertAccount(repos);
  repos.status.set({ accountId: "a1", fiveHour: { usedPct: 10 } });
  insertRun(repos, { status: "done" });
  await api.deleteAccount("a1");
  expect(repos.accounts.get("a1")).toBeUndefined();
  expect(repos.status.get("a1")).toBeUndefined();
  expect(states.at(-1)!.accounts).toEqual([]);
});

// ---- checkAccount

test("checkAccount writes the connection without overwriting a quota written meanwhile", async () => {
  const s = setup();
  insertAccount(s.repos);
  s.repos.status.set({ accountId: "a1", fiveHour: { usedPct: 10 }, quotaAt: 1 });
  s.handlers.exec = async () => {
    // a quota poll lands while `claude auth status` runs
    s.repos.status.set({ accountId: "a1", fiveHour: { usedPct: 77 }, quotaAt: 2, limit: { message: "m", at: 2 } });
    return { code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) };
  };
  const res = await s.api.checkAccount("a1");
  expect(res).toMatchObject({ state: "connected", detail: "max" });
  expect(s.repos.status.get("a1")).toEqual({ accountId: "a1", fiveHour: { usedPct: 77 }, quotaAt: 2, limit: { message: "m", at: 2 }, connection: res });
});

test("checkAccount creates the status row when there is none, and does not recreate the row of an account just deleted", async () => {
  const s = setup();
  insertAccount(s.repos);
  await s.api.checkAccount("a1");
  expect(s.repos.status.get("a1")?.connection?.state).toBe("connected");
  s.handlers.exec = async () => {
    s.repos.accounts.delete("a1");
    s.repos.status.delete("a1");
    return { code: 0, stdout: JSON.stringify({ loggedIn: true }) };
  };
  await s.api.checkAccount("a1");
  expect(s.repos.status.get("a1")).toBeUndefined();
});

test("checkAccount runs the account's claude (right CLAUDE_CONFIG_DIR) and reports not-installed when there is no claude", async () => {
  const s = setup();
  insertAccount(s.repos, { configDir: "/tmp/other" });
  await s.api.checkAccount("a1");
  expect(s.execs[0]).toMatchObject({ cmd: "/usr/local/bin/claude", args: ["auth", "status", "--json"] });
  expect(s.execs[0]!.env.CLAUDE_CONFIG_DIR).toBe("/tmp/other");
  s.found.claude = null;
  await expect(s.api.checkAccount("a1")).resolves.toMatchObject({ state: "not-installed" });
});

test("checkAccount when packaged: a hand-typed config dir that appears after login gets the skill; when not packaged it does not", async () => {
  const s = setup({ packaged: true });
  const dir = configDirIn(s, ".claude-b", false);
  insertAccount(s.repos, { id: "a1", name: "B", configDir: dir });
  s.api.autoInstall(); // the dir does not exist yet, so it is skipped
  expect(fs.existsSync(skillOf(dir))).toBe(false);
  fs.mkdirSync(dir); // what `claude auth login` does
  await expect(s.api.checkAccount("a1")).resolves.toMatchObject({ state: "connected" });
  expect(fs.readFileSync(skillOf(dir), "utf8")).toBe(SKILL_TEXT);

  const u = setup({ packaged: false });
  const dir2 = configDirIn(u, ".claude-b", false);
  insertAccount(u.repos, { id: "a1", name: "B", configDir: dir2 });
  fs.mkdirSync(dir2);
  await u.api.checkAccount("a1");
  expect(fs.existsSync(skillOf(dir2))).toBe(false);
});

test("checkAccount: a failed skill install still returns the right check result", async () => {
  const s = setup({ packaged: true });
  insertAccount(s.repos, { id: "a1", name: "B", configDir: configDirIn(s, "b") });
  fs.rmSync(s.deps.cli.skillFile);
  await expect(s.api.checkAccount("a1")).resolves.toMatchObject({ state: "connected" });
});

test("checkAccount with a missing account: throws", async () => {
  await expect(setup().api.checkAccount("nope")).rejects.toThrow(/No account/);
});

// ---- login, terminal, settings

test("loginAccount opens Terminal running claude auth login; the folder the app makes for the account is created now", async () => {
  const s = setup();
  const a = await s.api.saveAccount(newAccount({ configDir: "auto" }));
  await s.api.loginAccount(a.id);
  expect(s.osascripts).toHaveLength(1);
  expect(s.osascripts[0]![1]).toContain(`CLAUDE_CONFIG_DIR='${a.configDir}' '/usr/local/bin/claude' auth login`);
  expect(fs.statSync(a.configDir!).isDirectory()).toBe(true);
});

test("loginAccount creates no folder outside <userData>/profiles and throws when claude is not installed", async () => {
  const s = setup();
  const other = path.join(s.root, "somewhere");
  insertAccount(s.repos, { configDir: other });
  await s.api.loginAccount("a1");
  expect(fs.existsSync(other)).toBe(false);
  s.found.claude = null;
  await expect(s.api.loginAccount("a1")).rejects.toThrow("The claude command was not found on the PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin");
});

test("openInTerminal refuses when the run has no sessionId", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos);
  await expect(s.api.openInTerminal(r.id)).rejects.toThrow("This run has no session yet");
  expect(s.osascripts).toEqual([]);
});

test("openInTerminal opens Terminal in the run's cwd, claude --resume with the account's config dir", async () => {
  const s = setup();
  insertAccount(s.repos, { configDir: "/tmp/other" });
  const r = insertRun(s.repos, { sessionId: "sess-9", cwd: "/work/my project" });
  await s.api.openInTerminal(r.id);
  expect(s.osascripts).toEqual([
    [
      "-e",
      `tell application "Terminal" to do script "cd '/work/my project' && CLAUDE_CONFIG_DIR='/tmp/other' '/usr/local/bin/claude' --resume 'sess-9'"`,
      "-e",
      'tell application "Terminal" to activate',
    ],
  ]);
});

test("openInTerminal: an account at ~/.claude does not set CLAUDE_CONFIG_DIR; a missing run or account throws", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { sessionId: "s" });
  await s.api.openInTerminal(r.id);
  expect(s.osascripts[0]![1]).not.toContain("CLAUDE_CONFIG_DIR");
  await expect(s.api.openInTerminal(999)).rejects.toThrow(/No run/);
  s.repos.accounts.delete("a1");
  await expect(s.api.openInTerminal(r.id)).rejects.toThrow(/No account/);
});

test("openInTerminal refuses when the run itself is running or another running run uses the same session", async () => {
  const s = setup();
  insertAccount(s.repos);
  const running = insertRun(s.repos, { status: "running", sessionId: "sess-1" });
  await expect(s.api.openInTerminal(running.id)).rejects.toThrow("This session has a run in progress, wait until it finishes, then open it");
  const earlier = insertRun(s.repos, { status: "done", sessionId: "sess-1" });
  await expect(s.api.openInTerminal(earlier.id)).rejects.toThrow("This session has a run in progress, wait until it finishes, then open it");
  expect(s.osascripts).toEqual([]);

  s.repos.runs.update(running.id, { status: "done", finishedAt: 2 });
  insertRun(s.repos, { status: "running", sessionId: "sess-other" });
  await s.api.openInTerminal(earlier.id);
  expect(s.osascripts).toHaveLength(1);
});

// ---- openAccountTerminal

/** A temp folder tree under the test root; returns the absolute path of each name made. */
const mkdirs = (root: string, ...names: string[]) =>
  names.map((n) => {
    const d = path.join(root, n);
    fs.mkdirSync(d, { recursive: true });
    return d;
  });

test("openAccountTerminal: cancelling the dialog opens no Terminal and the promise resolves", async () => {
  const s = setup();
  insertAccount(s.repos, { name: "Claude B" });
  s.picker.choice = undefined;
  await expect(s.api.openAccountTerminal("a1")).resolves.toBeUndefined();
  expect(s.picker.defaults).toHaveLength(1);
  expect(s.osascripts).toEqual([]);
});

test("openAccountTerminal: a valid folder opens Terminal exactly once with the command line of startOsascriptArgs", async () => {
  const s = setup();
  const [dir] = mkdirs(s.root, "du an");
  const a = insertAccount(s.repos, { name: "Claude B", configDir: path.join(s.root, "cfg-b") });
  s.picker.choice = dir!;
  await s.api.openAccountTerminal("a1");
  expect(s.osascripts).toEqual([startOsascriptArgs(a.configDir, "/usr/local/bin/claude", dir!)]);
});

test("openAccountTerminal: a missing account, or claude not found (reported before the dialog shows)", async () => {
  const s = setup();
  await expect(s.api.openAccountTerminal("nope")).rejects.toThrow(/No account/);
  insertAccount(s.repos);
  s.found.claude = null;
  s.picker.choice = s.root;
  await expect(s.api.openAccountTerminal("a1")).rejects.toThrow("The claude command was not found on the PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin");
  expect(s.picker.defaults).toEqual([]);
  expect(s.osascripts).toEqual([]);
});

test("openAccountTerminal: the folder the dialog starts in is the cwd of the newest run on that account, ignoring runs of other accounts", async () => {
  const s = setup();
  const [older, newer, other] = mkdirs(s.root, "old", "new", "other");
  insertAccount(s.repos);
  insertAccount(s.repos, { id: "a2", name: "Other" });
  insertRun(s.repos, { cwd: older!, createdAt: 1 });
  insertRun(s.repos, { cwd: newer!, createdAt: 2 });
  insertRun(s.repos, { cwd: other!, createdAt: 3, accountId: "a2" });
  await s.api.openAccountTerminal("a1");
  expect(s.picker.defaults).toEqual([newer]);
});

test("openAccountTerminal: when the newest run's cwd is gone, the first allowed folder (after ~) is used, then the home folder", async () => {
  const s = setup();
  const [app, app2] = mkdirs(s.root, "app", "app2");
  insertAccount(s.repos, { allowedDirs: [app!, app2!] });
  insertRun(s.repos, { cwd: path.join(s.root, "deleted") });
  await s.api.openAccountTerminal("a1");
  expect(s.picker.defaults).toEqual([app]);

  const t = setup();
  insertAccount(t.repos, { allowedDirs: ["~/aolangai-no-such-folder"] }); // expanded, missing, so skipped
  insertRun(t.repos, { cwd: path.join(t.root, "deleted") });
  await t.api.openAccountTerminal("a1");
  expect(t.picker.defaults).toEqual([os.homedir()]);

  const u = setup();
  insertAccount(u.repos);
  // a file is not a folder
  const file = path.join(u.root, "tep.txt");
  fs.writeFileSync(file, "x");
  insertRun(u.repos, { cwd: file });
  await u.api.openAccountTerminal("a1");
  expect(u.picker.defaults).toEqual([os.homedir()]);
});

test("openAccountTerminal: a folder outside allowedDirs is refused, the message lists allowedDirs as stored", async () => {
  const s = setup();
  const [app, other] = mkdirs(s.root, "app", "other");
  insertAccount(s.repos, { name: "Work", allowedDirs: [app!, "~/nothing-here"] });
  s.picker.choice = other!;
  await expect(s.api.openAccountTerminal("a1")).rejects.toThrow(`Account Work may only work in: ${app}, ~/nothing-here`);
  expect(s.osascripts).toEqual([]);
});

test("openAccountTerminal: a subfolder with a trailing / and a symlink pointing inside allowedDirs are both allowed", async () => {
  const s = setup();
  const [app, con] = mkdirs(s.root, "app", path.join("app", "con"));
  const link = path.join(s.root, "lien-ket");
  fs.symlinkSync(con!, link);
  const outside = mkdirs(s.root, "ngoai")[0]!;
  const escape = path.join(app!, "escape");
  fs.symlinkSync(outside, escape);
  insertAccount(s.repos, { allowedDirs: [app!] });
  for (const chosen of [con + "/", link]) {
    s.picker.choice = chosen;
    await s.api.openAccountTerminal("a1");
  }
  expect(s.osascripts).toHaveLength(2);
  // a symlink inside the allowed folder that points out of it does not count
  s.picker.choice = escape;
  await expect(s.api.openAccountTerminal("a1")).rejects.toThrow(/may only work in/);
  expect(s.osascripts).toHaveLength(2);
});

test("openAccountTerminal: a config dir managed by the app is created, any other config dir is not", async () => {
  const s = setup();
  const [dir] = mkdirs(s.root, "project");
  s.picker.choice = dir!;
  const a = await s.api.saveAccount(newAccount({ configDir: "auto" }));
  expect(fs.existsSync(a.configDir!)).toBe(false);
  await s.api.openAccountTerminal(a.id);
  expect(fs.statSync(a.configDir!).isDirectory()).toBe(true);

  const other = path.join(s.root, ".x-does-not-exist");
  insertAccount(s.repos, { id: "b1", configDir: other });
  await s.api.openAccountTerminal("b1");
  expect(fs.existsSync(other)).toBe(false);
  expect(s.osascripts).toHaveLength(2);
});

test("loginAccount when packaged: the skill goes into the config dir just created, Terminal still opens; when not packaged nothing is written", async () => {
  const s = setup({ packaged: true });
  const a = await s.api.saveAccount(newAccount({ configDir: "auto" }));
  expect(fs.existsSync(a.configDir!)).toBe(false);
  await s.api.loginAccount(a.id);
  expect(fs.readFileSync(skillOf(a.configDir!), "utf8")).toBe(SKILL_TEXT);
  expect(s.osascripts).toHaveLength(1);

  const u = setup({ packaged: false });
  const b = await u.api.saveAccount(newAccount({ configDir: "auto" }));
  await u.api.loginAccount(b.id);
  expect(fs.statSync(b.configDir!).isDirectory()).toBe(true);
  expect(fs.existsSync(skillOf(b.configDir!))).toBe(false);
  expect(u.osascripts).toHaveLength(1);
});

test("loginAccount: a failed skill install still opens the login Terminal", async () => {
  const s = setup({ packaged: true });
  const a = await s.api.saveAccount(newAccount({ configDir: "auto" }));
  fs.rmSync(s.deps.cli.skillFile); // the install has nothing to write, and must not stop the login
  await expect(s.api.loginAccount(a.id)).resolves.toBeUndefined();
  expect(s.osascripts).toHaveLength(1);
});

test("openAccountTerminal when packaged: the skill goes into the config dir just created, Terminal still opens; when not packaged nothing is written", async () => {
  const s = setup({ packaged: true });
  const [dir] = mkdirs(s.root, "project");
  s.picker.choice = dir!;
  const a = await s.api.saveAccount(newAccount({ configDir: "auto" }));
  await s.api.openAccountTerminal(a.id);
  expect(fs.readFileSync(skillOf(a.configDir!), "utf8")).toBe(SKILL_TEXT);
  expect(s.osascripts).toHaveLength(1);

  const u = setup({ packaged: false });
  const [dir2] = mkdirs(u.root, "project");
  u.picker.choice = dir2!;
  const b = await u.api.saveAccount(newAccount({ configDir: "auto" }));
  await u.api.openAccountTerminal(b.id);
  expect(fs.existsSync(skillOf(b.configDir!))).toBe(false);
  expect(u.osascripts).toHaveLength(1);
});

test("openAccountTerminal: writes no row to runs", async () => {
  const s = setup();
  const [dir] = mkdirs(s.root, "project");
  insertAccount(s.repos);
  s.picker.choice = dir!;
  await s.api.openAccountTerminal("a1");
  expect(s.repos.runs.recent(10)).toEqual([]);
});

test("openAccountTerminal: a chosen folder with control characters is refused and osascript is not called", async () => {
  const s = setup();
  const [dir] = mkdirs(s.root, "du\nan");
  insertAccount(s.repos);
  s.picker.choice = dir!;
  await expect(s.api.openAccountTerminal("a1")).rejects.toThrow("The path or name contains control characters, so Terminal cannot open it");
  expect(s.osascripts).toEqual([]);
});

test("openAccountTerminal: an osascript error is passed on", async () => {
  const s = setup();
  const [dir] = mkdirs(s.root, "project");
  insertAccount(s.repos);
  s.picker.choice = dir!;
  const api = createApi({ ...s.deps, runOsascript: async () => Promise.reject(new Error("osascript broke")) });
  await expect(api.openAccountTerminal("a1")).rejects.toThrow("osascript broke");
});

// ---- recent folders

test("openAccountTerminal: a successful open records the folder, the next pickFolder gets it in recent, newest first", async () => {
  const s = setup();
  const [d1, d2] = mkdirs(s.root, "one", "two");
  insertAccount(s.repos);
  s.picker.choice = d1!;
  await s.api.openAccountTerminal("a1");
  expect(s.picker.recents).toEqual([[]]);
  s.picker.choice = d2!;
  await s.api.openAccountTerminal("a1");
  expect(s.picker.recents[1]).toEqual([d1]);
  s.picker.choice = undefined;
  await s.api.openAccountTerminal("a1");
  expect(s.picker.recents[2]).toEqual([d2, d1]);
  expect(s.repos.settings.getRecentDirs("a1")).toEqual([d2, d1]);
});

test("openAccountTerminal: recent holds only folders still on disk; the stored list is not trimmed", async () => {
  const s = setup();
  const [keep, gone] = mkdirs(s.root, "con", "mat");
  const file = path.join(s.root, "tep");
  fs.writeFileSync(file, "x");
  insertAccount(s.repos);
  for (const d of [gone!, file, keep!]) s.repos.settings.addRecentDir("a1", d);
  fs.rmSync(gone!, { recursive: true });
  await s.api.openAccountTerminal("a1");
  expect(s.picker.recents).toEqual([[keep]]);
  expect(s.repos.settings.getRecentDirs("a1")).toEqual([keep, file, gone]);
});

test("openAccountTerminal: recent drops folders outside allowedDirs after the account is edited", async () => {
  const s = setup();
  const [a, b] = mkdirs(s.root, "a", "b");
  insertAccount(s.repos);
  s.picker.choice = a!;
  await s.api.openAccountTerminal("a1");
  s.picker.choice = b!;
  await s.api.openAccountTerminal("a1");
  s.repos.accounts.update({ ...s.repos.accounts.get("a1")!, allowedDirs: [b!] });
  s.picker.choice = undefined;
  await s.api.openAccountTerminal("a1");
  expect(s.picker.recents[2]).toEqual([b]);
});

test("openAccountTerminal: a folder chosen from the menu also goes through the allowedDirs check; when refused nothing is recorded", async () => {
  const s = setup();
  const [a, b] = mkdirs(s.root, "a", "b");
  insertAccount(s.repos, { allowedDirs: [a!] });
  s.picker.choice = b!;
  await expect(s.api.openAccountTerminal("a1")).rejects.toThrow(/may only work in/);
  expect(s.repos.settings.getRecentDirs("a1")).toEqual([]);
});

test("openAccountTerminal: when runOsascript fails the folder is not recorded", async () => {
  const s = setup();
  const [dir] = mkdirs(s.root, "project");
  insertAccount(s.repos);
  s.picker.choice = dir!;
  const api = createApi({ ...s.deps, runOsascript: async () => Promise.reject(new Error("osascript broke")) });
  await expect(api.openAccountTerminal("a1")).rejects.toThrow("osascript broke");
  expect(s.repos.settings.getRecentDirs("a1")).toEqual([]);
});

test("openAccountTerminal: a failure recording the recent folder still resolves, Terminal opened exactly once", async () => {
  const s = setup();
  const [dir] = mkdirs(s.root, "project");
  insertAccount(s.repos);
  s.picker.choice = dir!;
  const settings = { ...s.repos.settings, addRecentDir: () => { throw new Error("store busy"); } };
  const api = createApi({ ...s.deps, repos: { ...s.repos, settings } });
  await expect(api.openAccountTerminal("a1")).resolves.toBeUndefined();
  expect(s.osascripts).toHaveLength(1);
});

test("openAccountTerminal: when the user cancels nothing is recorded", async () => {
  const s = setup();
  insertAccount(s.repos);
  s.picker.choice = undefined;
  await s.api.openAccountTerminal("a1");
  expect(s.repos.settings.getRecentDirs("a1")).toEqual([]);
});

test("openAccountTerminal: a folder with control characters is refused and not recorded", async () => {
  const s = setup();
  const [dir] = mkdirs(s.root, "x\ny");
  insertAccount(s.repos);
  s.picker.choice = dir!;
  await expect(s.api.openAccountTerminal("a1")).rejects.toThrow(/control characters/);
  expect(s.repos.settings.getRecentDirs("a1")).toEqual([]);
});

test("deleteAccount: deletes that account's recent folders, other accounts keep theirs", async () => {
  const s = setup();
  insertAccount(s.repos, { id: "a1" });
  insertAccount(s.repos, { id: "a2", name: "B" });
  s.repos.settings.addRecentDir("a1", "/x");
  s.repos.settings.addRecentDir("a2", "/y");
  await s.api.deleteAccount("a1");
  expect(s.repos.settings.getRecentDirs("a1")).toEqual([]);
  expect(s.repos.settings.getRecentDirs("a2")).toEqual(["/y"]);
});

test("openAccountTerminal is in API_METHODS and dispatch can call it", async () => {
  const { API_METHODS } = await import("../shared/api.js");
  expect(API_METHODS).toContain("openAccountTerminal");
  const calls: unknown[][] = [];
  const api = { openAccountTerminal: async (...a: unknown[]) => void calls.push(a) } as never;
  await dispatch(api, { method: "openAccountTerminal", args: ["a1"] });
  expect(calls).toEqual([["a1"]]);
});

test("openAccountSettings opens settings.json when it exists", async () => {
  const s = setup();
  const dir = path.join(s.root, "cfg");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  insertAccount(s.repos, { configDir: dir });
  await s.api.openAccountSettings("a1");
  expect(s.opened).toEqual([path.join(dir, "settings.json")]);
  expect(s.revealed).toEqual([]);
});

test("openAccountSettings: without settings.json it opens the folder in Finder, no file is created", async () => {
  const s = setup();
  const dir = path.join(s.root, "cfg");
  fs.mkdirSync(dir);
  insertAccount(s.repos, { configDir: dir });
  await s.api.openAccountSettings("a1");
  expect(s.opened).toEqual([]);
  expect(s.revealed).toEqual([dir]);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("openAccountSettings: a config dir that does not exist yet throws and creates nothing", async () => {
  const s = setup();
  const dir = path.join(s.root, "not-yet");
  insertAccount(s.repos, { configDir: dir });
  await expect(s.api.openAccountSettings("a1")).rejects.toThrow(/does not exist yet/);
  expect(fs.existsSync(dir)).toBe(false);
});

test("openAccountSettings throws when the operating system cannot open the file", async () => {
  const s = setup();
  const dir = path.join(s.root, "cfg");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  insertAccount(s.repos, { configDir: dir });
  s.deps.openPath = async () => "no application";
  await expect(createApi(s.deps).openAccountSettings("a1")).rejects.toThrow("no application");
});

// ---- runs

test("getState: at most 200 runs, newest first; has limits and install", async () => {
  const { api, repos } = setup();
  insertAccount(repos);
  for (let i = 0; i < 205; i++) insertRun(repos, { createdAt: i });
  const st = await api.getState();
  expect(st.runs).toHaveLength(200);
  expect(st.runs[0]!.id).toBe(205);
  expect(st.runs[199]!.id).toBe(6);
  expect(st.limits).toEqual(DEFAULT_LIMITS);
  expect(st.accounts.map((a) => a.id)).toEqual(["a1"]);
});

test("runEvents returns the log rows of the run", async () => {
  const { api, repos } = setup();
  insertAccount(repos);
  const r = insertRun(repos);
  repos.runEvents.add(r.id, "tool", "Read a.ts", 5);
  repos.runEvents.add(r.id, "text", "xong", 6);
  expect((await api.runEvents(r.id)).map((e) => e.text)).toEqual(["Read a.ts", "xong"]);
});

test("stopRun calls core's stopRun: a lost dispatcher makes the run failed", async () => {
  const { api, repos, states } = setup();
  insertAccount(repos);
  const r = insertRun(repos, { status: "running", pid: 4_000_000, pidStart: "x" });
  await api.stopRun(r.id);
  expect(repos.runs.get(r.id)).toMatchObject({ status: "failed", error: LOST_DISPATCHER });
  expect(states.at(-1)!.runs[0]!.status).toBe("failed");
});

test("stopRun and stopAll send SIGTERM to the delegating process that is still alive; stopAll returns the number signalled", async () => {
  const { api, repos } = setup();
  insertAccount(repos);
  const child = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  const exited = new Promise<string | null>((resolve) => child.on("exit", (_c, sig) => resolve(sig)));
  const start = processStart(child.pid!, { psTimeoutMs: 15_000 });
  expect(start).toBeDefined();
  insertRun(repos, { status: "running", pid: child.pid, pidStart: start });
  expect(await api.stopAll()).toBe(1);
  expect(await exited).toBe("SIGTERM");
  expect(await api.stopAll()).toBe(0); // the dead dispatcher's run is failed by now
});

test("sweep: a lost dispatcher is marked failed and the state is sent", async () => {
  const { api, repos, states } = setup();
  insertAccount(repos);
  const r = insertRun(repos, { status: "running", pid: 4_000_000, pidStart: "x" });
  expect(api.sweep()).toBe(1);
  expect(repos.runs.get(r.id)).toMatchObject({ status: "failed", finishedAt: 1_000_000 });
  expect(states).toHaveLength(1);
  expect(api.sweep()).toBe(0);
  expect(states).toHaveLength(1);
});

// ---- retryRun

test("retryRun runs the CLI detached: argv, the prompt over stdin, env, unref", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "failed", prompt: "a long prompt\nover several lines", cwd: "/work/p", label: "fix bug", readOnly: true });
  await s.api.retryRun(r.id);
  expect(s.spawns).toHaveLength(1);
  const c = s.spawns[0]!;
  expect(c.cmd).toBe("/usr/local/bin/node");
  expect(c.args).toEqual([s.entry, "run", "-", "--cwd=/work/p", "--label=fix bug", "--read-only", "--retry-of", String(r.id)]);
  expect(c.opts).toMatchObject({ detached: true, stdio: ["pipe", "ignore", "pipe"] });
  expect(c.opts.env.AOLANGAI_DB).toBe(s.deps.dbPath);
  expect(c.opts.env.PATH).toBe("/usr/bin");
  expect(c.opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(c.opts.env.AOLANGAI_RUN_ID).toBeUndefined(); // a retry started by the owner is not nested in a run
  expect(c.stdin).toBe("a long prompt\nover several lines");
  expect(c.ended).toBe(true);
  expect(c.unref).toBe(true);
});

test("retryRun without a label, not read-only: no extra flags", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "limited" });
  await s.api.retryRun(r.id);
  expect(s.spawns[0]!.args).toEqual([s.entry, "run", "-", "--cwd=/p", "--retry-of", String(r.id)]);
});

test("retryRun: a label starting with a dash is not read as a flag by the CLI (one --label=<label> argument)", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "failed", label: "-fix", cwd: "/p" });
  await s.api.retryRun(r.id);
  expect(s.spawns[0]!.args).toEqual([s.entry, "run", "-", "--cwd=/p", "--label=-fix", "--retry-of", String(r.id)]);
});

test("retryRun with the electron runtime: calls the runtime's execPath with ELECTRON_RUN_AS_NODE=1, even when the machine has node", async () => {
  const runtime = { execPath: "/Applications/aolangai.app/Contents/MacOS/aolangai", electron: true };
  const s = setup({ runtime });
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "stopped" });
  await s.api.retryRun(r.id);
  expect(s.spawns[0]!.cmd).toBe(runtime.execPath);
  expect(s.spawns[0]!.opts.env.ELECTRON_RUN_AS_NODE).toBe("1");
});

test("retryRun with the node runtime: no ELECTRON_RUN_AS_NODE, even when the app's env has it", async () => {
  const s = setup();
  s.deps.env = { ...s.deps.env, ELECTRON_RUN_AS_NODE: "1" };
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "stopped" });
  await createApi(s.deps).retryRun(r.id);
  expect(s.spawns[0]!.cmd).toBe("/usr/local/bin/node");
  expect("ELECTRON_RUN_AS_NODE" in s.spawns[0]!.opts.env).toBe(false);
});

test("retryRun refuses a running run, a missing run, and an unbuilt CLI", async () => {
  const s = setup();
  insertAccount(s.repos);
  const running = insertRun(s.repos, { status: "running" });
  await expect(s.api.retryRun(running.id)).rejects.toThrow(/still running/);
  await expect(s.api.retryRun(999)).rejects.toThrow(/No run/);
  const b = setup({ cliBuilt: false });
  insertAccount(b.repos);
  const failed = insertRun(b.repos, { status: "failed" });
  await expect(b.api.retryRun(failed.id)).rejects.toThrow("The aolangai command is not built (packages/cli/dist)");
  expect(b.spawns).toEqual([]);
});

test("retryRun: when the CLI refuses (code 2) the last [aolangai] line of stderr is reported, prefix removed, cut at 160 characters", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "failed" });
  await s.api.retryRun(r.id); // resolves right away, before the CLI ends
  expect(s.notices).toEqual([]);
  const c = s.spawns[0]!;
  c.writeStderr("[aolangai] No account can take ");
  c.writeStderr("this run\n- Claude B: used 93%, over the reserve of 90%\n");
  c.close(2);
  expect(s.notices).toEqual([{ title: "aolangai", body: `Retry of run #${r.id} could not start: No account can take this run` }]);

  await s.api.retryRun(r.id);
  s.spawns[1]!.writeStderr(`[aolangai] No such folder: /p\n[aolangai] ${"x".repeat(300)}\n`);
  s.spawns[1]!.close(2);
  expect(s.notices[1]!.body).toBe(`Retry of run #${r.id} could not start: ${"x".repeat(160)}`);
});

test("retryRun: when the CLI finishes (code 0) nothing is reported", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "failed" });
  await s.api.retryRun(r.id);
  s.spawns[0]!.writeStderr("[aolangai] run #2 · account Personal · new session\n");
  s.spawns[0]!.close(0);
  expect(s.notices).toEqual([]);
});

test("retryRun: code 1 with the retried run already in the store is not reported (that row already shows the error)", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "failed" });
  insertRun(s.repos, { status: "failed", retryOf: r.id }); // an earlier retry of the same run
  await s.api.retryRun(r.id);
  insertRun(s.repos, { status: "failed", retryOf: r.id, error: "broke" }); // the row this retry made
  s.spawns[0]!.writeStderr("[aolangai] run #3 failed: broke\n");
  s.spawns[0]!.close(1);
  expect(s.notices).toEqual([]);
});

test("retryRun: a non-zero code with no new row for this retry is reported; without an [aolangai] line the exit code is given", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "failed" });
  insertRun(s.repos, { status: "failed", retryOf: r.id }); // older: does not count
  await s.api.retryRun(r.id);
  s.spawns[0]!.writeStderr("node: bad option\n");
  s.spawns[0]!.close(1);
  expect(s.notices).toEqual([{ title: "aolangai", body: `Retry of run #${r.id} could not start: exited with code 1` }]);

  await s.api.retryRun(r.id);
  s.spawns[1]!.fail(new Error("spawn node ENOENT"));
  s.spawns[1]!.close(-2);
  expect(s.notices).toHaveLength(2);
  expect(s.notices[1]!.body).toBe(`Retry of run #${r.id} could not start: spawn node ENOENT`);
});

test("retryRun: emitNotice throwing breaks nothing", async () => {
  const s = setup();
  insertAccount(s.repos);
  const r = insertRun(s.repos, { status: "failed" });
  s.deps.emitNotice = () => {
    throw new Error("the window is closed");
  };
  const api = createApi(s.deps);
  await api.retryRun(r.id);
  expect(() => s.spawns[0]!.close(2)).not.toThrow();
});

// ---- limits, install

test("setLimits saves to the store and sends the state", async () => {
  const { api, repos, states } = setup();
  await api.setLimits({ ...DEFAULT_LIMITS, maxConcurrent: 2 });
  expect(repos.settings.getLimits().maxConcurrent).toBe(2);
  expect(states.at(-1)!.limits.maxConcurrent).toBe(2);
});

test("install with an unbuilt CLI: throws", async () => {
  const s = setup({ cliBuilt: false });
  await expect(s.api.install()).rejects.toThrow("The aolangai command is not built (packages/cli/dist)");
});

test("install writes the skill and the command, returns the current status and sends the state", async () => {
  const s = setup();
  expect((await s.api.getState()).install).toEqual({ skill: "missing", shim: "missing", accounts: [] });
  const st = await s.api.install();
  expect(st).toEqual({ skill: "current", shim: "current", accounts: [] });
  const shim = fs.readFileSync(path.join(s.deps.installPaths.binDir, "aolangai"), "utf8");
  expect(shim).toBe(shimText(s.deps.runtime, s.entry));
  expect(fs.readFileSync(path.join(s.deps.installPaths.skillDir, "SKILL.md"), "utf8")).toBe("# skill aolangai-managed\n");
  expect(s.states.at(-1)!.install).toEqual({ skill: "current", shim: "current", accounts: [] });
});

test("install with the electron runtime writes the command in electron form, no node needed on the machine", async () => {
  const runtime = { execPath: "/Applications/aolangai.app/Contents/MacOS/aolangai", electron: true };
  const s = setup({ node: null, runtime });
  expect(await s.api.install()).toEqual({ skill: "current", shim: "current", accounts: [] });
  const shim = fs.readFileSync(path.join(s.deps.installPaths.binDir, "aolangai"), "utf8");
  expect(shim).toBe(shimText(runtime, s.entry));
  expect(shim).toContain("ELECTRON_RUN_AS_NODE=1 exec");
});

test("state: an unbuilt CLI makes install missing without breaking the state build; with a runtime no node is needed", async () => {
  expect((await setup({ cliBuilt: false }).api.getState()).install).toEqual({ skill: "missing", shim: "missing", accounts: [] });
  const s = setup({ node: null });
  expect((await s.api.getState()).install).toEqual({ skill: "missing", shim: "missing", accounts: [] });
  await s.api.install();
  expect((await s.api.getState()).install).toEqual({ skill: "current", shim: "current", accounts: [] });
});

// ---- skill for every account

const SKILL_TEXT = "# skill aolangai-managed\n";
const skillOf = (configDir: string) => path.join(configDir, "skills", "aolangai", "SKILL.md");
/**
 * Makes writing the skill into this config dir fail (the skill folder exists but is read-only). Returns false when
 * the mode does not block writes (running as root), so the caller can skip its assertions.
 */
const blockSkillWrites = (dir: string): boolean => {
  const skillDir = path.dirname(skillOf(dir));
  fs.mkdirSync(skillDir, { recursive: true });
  fs.chmodSync(skillDir, 0o555);
  try {
    fs.writeFileSync(path.join(skillDir, "probe"), "");
    fs.rmSync(path.join(skillDir, "probe"));
    return false;
  } catch {
    return true;
  }
};
/** A config dir named `name` under the test root; created unless `exists` is false. */
const configDirIn = (s: Setup, name: string, exists = true): string => {
  const dir = path.join(s.root, name);
  if (exists) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

test("state: install.accounts follows the account order, no-dir when the folder does not exist, no entry for an account at ~/.claude", async () => {
  const s = setup();
  const one = configDirIn(s, "account one");
  const gone = configDirIn(s, "missing", false);
  const fileAsDir = path.join(s.root, "a file");
  fs.writeFileSync(fileAsDir, "x");
  insertAccount(s.repos, { id: "d0", name: "Default" }); // empty configDir = ~/.claude
  insertAccount(s.repos, { id: "a1", name: "One", configDir: one });
  insertAccount(s.repos, { id: "d1", name: "Default two", configDir: "~/.claude" });
  insertAccount(s.repos, { id: "a2", name: "Two", configDir: gone });
  insertAccount(s.repos, { id: "a3", name: "Three", configDir: fileAsDir });
  expect((await s.api.getState()).install).toEqual({
    skill: "missing",
    shim: "missing",
    accounts: [
      { accountId: "a1", file: skillOf(one), skill: "missing" },
      { accountId: "a2", file: skillOf(gone), skill: "no-dir" },
      { accountId: "a3", file: skillOf(fileAsDir), skill: "no-dir" },
    ],
  });
});

test("state: an account's file shows home as ~ (the fake home is a temp folder, the real home is untouched)", async () => {
  const s = setup();
  const home = fs.realpathSync(configDirIn(s, "fake home"));
  vi.stubEnv("HOME", home);
  try {
    insertAccount(s.repos, { id: "a1", name: "One", configDir: "~/config" });
    insertAccount(s.repos, { id: "a2", name: "Two", configDir: path.join(home, "under home") });
    insertAccount(s.repos, { id: "a3", name: "Three", configDir: "~/.claude" }); // the default one under the fake home
    expect((await s.api.getState()).install.accounts).toEqual([
      { accountId: "a1", file: "~/config/skills/aolangai/SKILL.md", skill: "no-dir" },
      { accountId: "a2", file: "~/under home/skills/aolangai/SKILL.md", skill: "no-dir" },
    ]);
    expect(fs.readdirSync(home)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("state: all four skill statuses of an account", async () => {
  const s = setup();
  const dirs = ["cur", "old", "foreign", "none"].map((n) => configDirIn(s, n));
  dirs.forEach((d, i) => insertAccount(s.repos, { id: `b${i}`, name: `B${i}`, configDir: d }));
  fs.mkdirSync(path.dirname(skillOf(dirs[0]!)), { recursive: true });
  fs.writeFileSync(skillOf(dirs[0]!), SKILL_TEXT);
  fs.mkdirSync(path.dirname(skillOf(dirs[1]!)), { recursive: true });
  fs.writeFileSync(skillOf(dirs[1]!), "# old aolangai-managed\n");
  fs.mkdirSync(path.dirname(skillOf(dirs[2]!)), { recursive: true });
  fs.writeFileSync(skillOf(dirs[2]!), "someone else's\n");
  expect((await s.api.getState()).install.accounts.map((p) => p.skill)).toEqual(["current", "outdated", "foreign", "missing"]);
});

test("state: an unbuilt CLI makes the account's skill missing, a folder that does not exist is still no-dir", async () => {
  const s = setup({ cliBuilt: false });
  insertAccount(s.repos, { id: "a1", name: "One", configDir: configDirIn(s, "present") });
  insertAccount(s.repos, { id: "a2", name: "Two", configDir: configDirIn(s, "absent", false) });
  expect((await s.api.getState()).install.accounts.map((p) => p.skill)).toEqual(["missing", "no-dir"]);
});

test("install writes SKILL.md into a config dir with spaces and accented letters, and does not create a missing config dir", async () => {
  const s = setup();
  const dir = configDirIn(s, "Tài khoản phụ - cá nhân");
  const gone = configDirIn(s, "not logged in", false);
  insertAccount(s.repos, { id: "a1", name: "Second", configDir: dir });
  insertAccount(s.repos, { id: "a2", name: "Not yet", configDir: gone });
  const st = await s.api.install();
  expect(fs.readFileSync(skillOf(dir), "utf8")).toBe(SKILL_TEXT);
  expect(fs.existsSync(gone)).toBe(false);
  expect(st).toEqual({
    skill: "current",
    shim: "current",
    accounts: [
      { accountId: "a1", file: skillOf(dir), skill: "current" },
      { accountId: "a2", file: skillOf(gone), skill: "no-dir" },
    ],
  });
  expect(s.states.at(-1)!.install).toEqual(st);
  expect(fs.readdirSync(dir)).toEqual(["skills"]);
});

test("install: an account with a foreign SKILL.md keeps that file intact and other accounts are still installed", async () => {
  const s = setup();
  const foreign = configDirIn(s, "foreign");
  const other = configDirIn(s, "other");
  fs.mkdirSync(path.dirname(skillOf(foreign)), { recursive: true });
  fs.writeFileSync(skillOf(foreign), "someone else's\n");
  insertAccount(s.repos, { id: "a1", name: "Foreign", configDir: foreign });
  insertAccount(s.repos, { id: "a2", name: "Other", configDir: other });
  const st = await s.api.install();
  expect(fs.readFileSync(skillOf(foreign), "utf8")).toBe("someone else's\n");
  expect(fs.readFileSync(skillOf(other), "utf8")).toBe(SKILL_TEXT);
  expect(st.accounts.map((p) => p.skill)).toEqual(["foreign", "current"]);
});

test("install: a foreign skill file at ~/.claude still installs the command and the accounts, then throws the original error", async () => {
  const s = setup();
  const dir = configDirIn(s, "second");
  insertAccount(s.repos, { id: "a1", name: "Second", configDir: dir });
  const home = path.join(s.deps.installPaths.skillDir, "SKILL.md");
  fs.mkdirSync(s.deps.installPaths.skillDir, { recursive: true });
  fs.writeFileSync(home, "someone else's\n");
  await expect(s.api.install()).rejects.toThrow(`This file was not created by aolangai, not overwriting: ${home}`);
  expect(fs.readFileSync(home, "utf8")).toBe("someone else's\n");
  expect(fs.readFileSync(skillOf(dir), "utf8")).toBe(SKILL_TEXT);
  expect(fs.existsSync(path.join(s.deps.installPaths.binDir, "aolangai"))).toBe(true);
});

test("install: a foreign command file at ~/.local/bin still installs the skill at ~/.claude and the accounts", async () => {
  const s = setup();
  const dir = configDirIn(s, "second");
  insertAccount(s.repos, { id: "a1", name: "Second", configDir: dir });
  const shim = path.join(s.deps.installPaths.binDir, "aolangai");
  fs.mkdirSync(s.deps.installPaths.binDir, { recursive: true });
  fs.writeFileSync(shim, "#!/bin/sh\necho someone else's\n");
  await expect(s.api.install()).rejects.toThrow(`This file was not created by aolangai, not overwriting: ${shim}`);
  expect(fs.readFileSync(shim, "utf8")).toBe("#!/bin/sh\necho someone else's\n");
  expect(fs.readFileSync(path.join(s.deps.installPaths.skillDir, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  expect(fs.readFileSync(skillOf(dir), "utf8")).toBe(SKILL_TEXT);
});

test("install: one account failing to write still installs the other places, then throws 'Could not install the skill for: name: error'; several places are joined by ;", async () => {
  const s = setup();
  const bad1 = configDirIn(s, "bad one");
  const good = configDirIn(s, "good");
  const bad2 = configDirIn(s, "bad two");
  if (!blockSkillWrites(bad1) || !blockSkillWrites(bad2)) return;
  insertAccount(s.repos, { id: "a1", name: "Bad 1", configDir: bad1 });
  insertAccount(s.repos, { id: "a2", name: "Good", configDir: good });
  insertAccount(s.repos, { id: "a3", name: "Bad 2", configDir: bad2 });
  const err = await s.api.install().then(() => undefined, (e: Error) => e);
  expect(err?.message).toMatch(/^Could not install the skill for: Bad 1: .+; Bad 2: .+$/);
  expect(err?.message).not.toContain("Good");
  expect(fs.readFileSync(skillOf(good), "utf8")).toBe(SKILL_TEXT);
  expect(fs.existsSync(path.join(s.deps.installPaths.binDir, "aolangai"))).toBe(true);
});

test("install: a foreign file at ~/.claude plus a failing account throws the foreign file error", async () => {
  const s = setup();
  const bad = configDirIn(s, "bad");
  if (!blockSkillWrites(bad)) return;
  insertAccount(s.repos, { id: "a1", name: "Bad", configDir: bad });
  fs.mkdirSync(s.deps.installPaths.skillDir, { recursive: true });
  fs.writeFileSync(path.join(s.deps.installPaths.skillDir, "SKILL.md"), "someone else's\n");
  await expect(s.api.install()).rejects.toThrow("This file was not created by aolangai, not overwriting");
});

test("autoInstall does nothing when not packaged", async () => {
  const s = setup({ packaged: false });
  const dir = configDirIn(s, "second");
  insertAccount(s.repos, { id: "a1", name: "Second", configDir: dir });
  s.api.autoInstall();
  expect(fs.existsSync(skillOf(dir))).toBe(false);
  expect(fs.existsSync(s.deps.installPaths.skillDir)).toBe(false);
  expect(fs.existsSync(s.deps.installPaths.binDir)).toBe(false);
});

test("autoInstall when packaged: installs the skill, the command file and the accounts' skills", async () => {
  const s = setup({ packaged: true });
  const dir = configDirIn(s, "second");
  const gone = configDirIn(s, "missing", false);
  insertAccount(s.repos, { id: "a1", name: "Second", configDir: dir });
  insertAccount(s.repos, { id: "a2", name: "Not yet", configDir: gone });
  s.api.autoInstall();
  expect(fs.readFileSync(skillOf(dir), "utf8")).toBe(SKILL_TEXT);
  expect(fs.readFileSync(path.join(s.deps.installPaths.skillDir, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  expect(fs.readFileSync(path.join(s.deps.installPaths.binDir, "aolangai"), "utf8")).toBe(shimText(s.deps.runtime, s.entry));
  expect(fs.existsSync(gone)).toBe(false);
});

test("autoInstall never throws: a config dir that is a file, a foreign file, an unbuilt CLI, an unreadable skill", async () => {
  const s = setup({ packaged: true });
  const asFile = path.join(s.root, "a file");
  fs.writeFileSync(asFile, "x");
  insertAccount(s.repos, { id: "a1", name: "File", configDir: asFile });
  fs.mkdirSync(s.deps.installPaths.skillDir, { recursive: true });
  fs.writeFileSync(path.join(s.deps.installPaths.skillDir, "SKILL.md"), "someone else's\n");
  expect(() => s.api.autoInstall()).not.toThrow();
  expect(fs.readFileSync(asFile, "utf8")).toBe("x");
  expect(fs.readFileSync(path.join(s.deps.installPaths.skillDir, "SKILL.md"), "utf8")).toBe("someone else's\n");
  expect(fs.existsSync(path.join(s.deps.installPaths.binDir, "aolangai"))).toBe(true); // the rest was still done
  expect(() => setup({ packaged: true, cliBuilt: false }).api.autoInstall()).not.toThrow();
  fs.rmSync(s.deps.cli.skillFile);
  expect(() => s.api.autoInstall()).not.toThrow();
});

test("saveAccount when packaged installs the skill for the account just saved", async () => {
  const s = setup({ packaged: true });
  const dir = configDirIn(s, "just saved");
  const saved = await s.api.saveAccount(newAccount({ name: "New", configDir: dir }));
  expect(saved.configDir).toBe(dir);
  expect(fs.readFileSync(skillOf(dir), "utf8")).toBe(SKILL_TEXT);
  expect((await s.api.getState()).install.accounts).toEqual([{ accountId: saved.id, file: skillOf(dir), skill: "current" }]);
});

test("saveAccount when not packaged installs nothing", async () => {
  const s = setup({ packaged: false });
  const dir = configDirIn(s, "just saved");
  await s.api.saveAccount(newAccount({ name: "New", configDir: dir }));
  expect(fs.existsSync(skillOf(dir))).toBe(false);
});

test("saveAccount still returns the account and has written the store when the skill install fails", async () => {
  const s = setup({ packaged: true });
  const dir = configDirIn(s, "bad");
  if (!blockSkillWrites(dir)) return;
  const saved = await s.api.saveAccount(newAccount({ name: "Bad", configDir: dir }));
  expect(s.repos.accounts.get(saved.id)).toEqual(saved);
});

test("saveAccount refused installs nothing", async () => {
  const s = setup({ packaged: true });
  const dir = configDirIn(s, "new");
  await expect(s.api.saveAccount(newAccount({ name: "  ", configDir: dir }))).rejects.toThrow();
  expect(fs.existsSync(skillOf(dir))).toBe(false);
});

// ---- state pushes

test("pushState: sends the first time, not again when unchanged, again when changed", async () => {
  const { api, repos, states } = setup();
  api.pushState();
  api.pushState();
  expect(states).toHaveLength(1);
  insertAccount(repos); // a write by "someone else"
  api.pushState();
  expect(states).toHaveLength(2);
  api.pushState();
  expect(states).toHaveLength(2);
});

// ---- open sessions

const session = (o: Partial<OpenSession> = {}): OpenSession => ({ pid: 100, kind: "Terminal", accountId: "a1", cwd: "/p", startedAt: 1, ...o });

test("before the first scan, state.sessions is []", async () => {
  const { api } = setup();
  expect((await api.getState()).sessions).toEqual([]);
});

test("scan: the result replaces the list held and emits a state with those sessions", async () => {
  const { api, handlers, states } = setup();
  const two = [session({ pid: 100 }), session({ pid: 200, kind: "iTerm" })];
  handlers.scanSessions = async () => two;
  await api.scan();
  expect(states.at(-1)?.sessions).toEqual(two);
  expect((await api.getState()).sessions).toEqual(two);
});

test("scan returning undefined: no new emit, the old list is kept", async () => {
  const { api, handlers, states } = setup();
  handlers.scanSessions = async () => [session({ pid: 100 }), session({ pid: 200 })];
  await api.scan();
  const sent = states.length;
  handlers.scanSessions = async () => undefined;
  await api.scan();
  expect(states).toHaveLength(sent);
  expect((await api.getState()).sessions).toHaveLength(2);
});

test("scan: a result equal to the last one is not emitted again", async () => {
  const { api, handlers, states } = setup();
  handlers.scanSessions = async () => [session()];
  await api.scan();
  await api.scan();
  expect(states).toHaveLength(1);
});

test("scan: when scanSessions throws, scan does not reject and the list stays", async () => {
  const { api, handlers, states } = setup();
  handlers.scanSessions = async () => [session({ pid: 100 })];
  await api.scan();
  const sent = states.length;
  handlers.scanSessions = async () => {
    throw new Error("ps broke");
  };
  await expect(api.scan()).resolves.toBeUndefined();
  handlers.scanSessions = () => {
    throw new Error("thrown synchronously");
  };
  await expect(api.scan()).resolves.toBeUndefined();
  expect(states).toHaveLength(sent);
  expect((await api.getState()).sessions).toEqual([session({ pid: 100 })]);
});

test("scan: excludePids are the workerPids of running runs, not the pids of finished runs; accounts come from the store", async () => {
  const { api, repos, scans } = setup();
  const a = insertAccount(repos);
  insertRun(repos, { status: "running", workerPid: 111 });
  insertRun(repos, { status: "running" }); // no worker pid yet
  insertRun(repos, { status: "done", workerPid: 222 });
  insertRun(repos, { status: "failed", workerPid: 333 });
  await api.scan();
  expect(scans).toHaveLength(1);
  expect(scans[0]!.excludePids).toEqual([111]);
  expect(scans[0]!.accounts).toEqual([a]);
});

test("two scans in a row while the first is unfinished call scanSessions once; once it is done a new scan works", async () => {
  const { api, handlers, scans } = setup();
  let release!: (v: OpenSession[]) => void;
  handlers.scanSessions = () => new Promise<OpenSession[]>((r) => (release = r));
  const first = api.scan();
  const second = api.scan();
  expect(second).toBe(first);
  release([]);
  await Promise.all([first, second]);
  expect(scans).toHaveLength(1);
  handlers.scanSessions = async () => [];
  await api.scan();
  expect(scans).toHaveLength(2);
});

test("scan never rejects, even when reading the store throws", async () => {
  const { api, repos, scans } = setup();
  vi.spyOn(repos.runs, "running").mockImplementation(() => {
    throw new Error("SQLITE_BUSY");
  });
  await expect(api.scan()).resolves.toBeUndefined();
  expect(scans).toHaveLength(0);
});

test("a write through the API that changes nothing (setLimits with the same value) is not sent again", async () => {
  const { api, states } = setup();
  await api.setLimits({ ...DEFAULT_LIMITS, maxConcurrent: 3 });
  await api.setLimits({ ...DEFAULT_LIMITS, maxConcurrent: 3 });
  expect(states).toHaveLength(1);
});

test("emitState throwing does not break the API call", async () => {
  const s = setup();
  s.deps.emitState = vi.fn(() => {
    throw new Error("the window is closed");
  });
  await expect(createApi(s.deps).saveAccount(newAccount())).resolves.toBeDefined();
});

test("openExternal opens only http and https; anything else is refused and the shell is not called", async () => {
  const { api, externals } = setup();
  await api.openExternal("https://example.com/a?b=1");
  await api.openExternal("http://localhost:3000/");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "/tmp/relative", "relative/path", "", 42 as unknown as string, undefined as unknown as string]) {
    await expect(api.openExternal(bad)).rejects.toThrow("Only http or https links can be opened");
  }
  expect(externals).toEqual(["https://example.com/a?b=1", "http://localhost:3000/"]);
});

test("API_METHODS matches what createApi returns", async () => {
  const { API_METHODS } = await import("../shared/api.js");
  const { api } = setup();
  for (const m of API_METHODS) expect(typeof api[m]).toBe("function");
});

// ---- account id and "auto" only on create

test("saveAccount with an id that does not exist: throws, does not recreate the account (it may have just been deleted)", async () => {
  const { api, repos } = setup();
  const a = await api.saveAccount(newAccount());
  repos.accounts.delete(a.id);
  await expect(api.saveAccount({ ...a, name: "Edited" })).rejects.toThrow("This account no longer exists (it may have just been deleted)");
  await expect(api.saveAccount({ ...newAccount({ configDir: "auto" }), id: "../../etc" })).rejects.toThrow("This account no longer exists");
  expect(repos.accounts.list()).toEqual([]);
});

test("saveAccount without an id: always generates a new id, two calls make two accounts", async () => {
  const { api, repos } = setup();
  const a = await api.saveAccount(newAccount({ name: "A" }));
  const b = await api.saveAccount(newAccount({ name: "B", configDir: "/tmp/b" }));
  expect(a.id).not.toBe(b.id);
  expect(repos.accounts.list()).toHaveLength(2);
});

test('saveAccount: "auto" only when creating; for an existing account it is an error and changes nothing', async () => {
  const { api, repos } = setup();
  const a = await api.saveAccount({ ...newAccount(), configDir: "/tmp/one" });
  repos.status.set({ accountId: a.id, fiveHour: { usedPct: 5 } });
  await expect(api.saveAccount({ ...a, configDir: "auto" })).rejects.toThrow('"auto" can only be used when creating a new account');
  expect(repos.accounts.get(a.id)!.configDir).toBe("/tmp/one");
  expect(repos.status.get(a.id)).toBeDefined();
});

// ---- setLimits validation

test.each([
  [{ maxConcurrent: Number.NaN }],
  [{ maxConcurrent: "4" }],
  [{ maxConcurrent: 0 }],
  [{ maxRunsPerHour: 0 }],
  [{ runTimeoutMs: 999 }],
  [{ quotaStaleMs: 500 }],
  [{ workerIdleMs: 0 }],
  [{ warmBonusPts: -1 }],
  [{ inFlightPenaltyPts: Number.POSITIVE_INFINITY }],
  [{ workerMaxContextTokens: 999 }],
  [{ extra: 1 }],
])("setLimits rejects %j and does not write", async (bad) => {
  const { api, repos } = setup();
  await expect(api.setLimits({ ...DEFAULT_LIMITS, ...bad } as never)).rejects.toThrow(/\S/);
  expect(repos.settings.getLimits()).toEqual(DEFAULT_LIMITS);
  expect(repos.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'limits'").get()).toEqual({ n: 0 });
});

test("setLimits rejects a missing key and a value that is not an object", async () => {
  const { api } = setup();
  const { maxConcurrent: _drop, ...partial } = DEFAULT_LIMITS;
  await expect(api.setLimits(partial as never)).rejects.toThrow(/\S/);
  await expect(api.setLimits(null as never)).rejects.toThrow(/\S/);
  await expect(api.setLimits([] as never)).rejects.toThrow(/\S/);
});

// ---- focusSession

const VSCODE_APP = "/Applications/Visual Studio Code.app";
const withSessions = async (list: OpenSession[]) => {
  const s = setup();
  s.handlers.scanSessions = async () => list;
  await s.api.scan();
  return s;
};

test("focusSession: a Terminal session with a tty runs osascript exactly once with the select-tab command, no app is opened", async () => {
  const s = await withSessions([session({ pid: 100, tty: "ttys015", appPath: "/System/Applications/Utilities/Terminal.app" })]);
  s.handlers.osascript = async () => "ok\n";
  await expect(s.api.focusSession(100)).resolves.toBeUndefined();
  expect(s.osascripts).toEqual([focusTerminalOsascriptArgs("ttys015")]);
  expect(s.openedApps).toEqual([]);
});

test("focusSession: osascript returning missing reports that the window was not found", async () => {
  const s = await withSessions([session({ pid: 100, tty: "ttys015" })]);
  s.handlers.osascript = async () => "missing\n";
  await expect(s.api.focusSession(100)).rejects.toThrow("The Terminal window of this session was not found");
  expect(s.openedApps).toEqual([]);
});

test("focusSession: when osascript is denied permission the error is passed on verbatim", async () => {
  const s = await withSessions([session({ pid: 100, tty: "ttys015" })]);
  s.handlers.osascript = async () => Promise.reject(new Error("osascript broke"));
  await expect(s.api.focusSession(100)).rejects.toThrow("osascript broke");
  expect(s.openedApps).toEqual([]);
});

test("focusSession: a VS Code session opens the app, no osascript", async () => {
  const s = await withSessions([session({ pid: 100, kind: "VS Code", tty: "ttys002", appPath: VSCODE_APP })]);
  await s.api.focusSession(100);
  expect(s.openedApps).toEqual([VSCODE_APP]);
  expect(s.osascripts).toEqual([]);
});

test("focusSession: a Claude desktop session opens the Claude app", async () => {
  const s = await withSessions([session({ pid: 100, kind: DESKTOP_KIND, accountId: undefined, appPath: "/Applications/Claude.app" })]);
  await s.api.focusSession(100);
  expect(s.openedApps).toEqual(["/Applications/Claude.app"]);
  expect(s.osascripts).toEqual([]);
});

test("focusSession: Terminal without a tty or with an odd tty falls back to opening the Terminal app, the tty never goes into osascript", async () => {
  const term = "/System/Applications/Utilities/Terminal.app";
  const s = await withSessions([
    session({ pid: 100, appPath: term }),
    session({ pid: 101, tty: 'ttys1" & (do shell script "x")', appPath: term }),
  ]);
  await s.api.focusSession(100);
  await s.api.focusSession(101);
  expect(s.openedApps).toEqual([term, term]);
  expect(s.osascripts).toEqual([]);
});

test("focusSession: Terminal without both a tty and an appPath, or another kind, cannot be switched to", async () => {
  const s = await withSessions([session({ pid: 100 }), session({ pid: 101, kind: OTHER_KIND, tty: "ttys009" })]);
  await expect(s.api.focusSession(100)).rejects.toThrow("Cannot switch to this session");
  await expect(s.api.focusSession(101)).rejects.toThrow("Cannot switch to this session");
  expect(s.osascripts).toEqual([]);
  expect(s.openedApps).toEqual([]);
});

test("focusSession: a pid not in the list reports closed, no command runs", async () => {
  const s = await withSessions([session({ pid: 100, tty: "ttys015" })]);
  await expect(s.api.focusSession(999)).rejects.toThrow("This session has closed");
  expect(s.osascripts).toEqual([]);
  expect(s.openedApps).toEqual([]);
});

test("focusSession: when openApp is refused the error is passed on verbatim", async () => {
  const s = await withSessions([session({ pid: 100, kind: "VS Code", appPath: VSCODE_APP })]);
  const api = createApi({ ...s.deps, openApp: async () => Promise.reject(new Error("Could not open this app")) });
  await api.scan();
  await expect(api.focusSession(100)).rejects.toThrow("Could not open this app");
});

test.each([["string", ["12"]], ["negative", [-1]], ["fraction", [1.5]], ["zero", [0]], ["missing argument", []], ["NaN", [NaN]], ["null", [null]]])(
  "dispatch focusSession with pid %s is refused and no command runs",
  async (_name, args) => {
    const s = await withSessions([session({ pid: 12, tty: "ttys015" }), session({ pid: 1, tty: "ttys016" }), session({ pid: 0, tty: "ttys017" })]);
    await expect(dispatch(s.api, { method: "focusSession", args })).rejects.toThrow("Invalid session id");
    expect(s.osascripts).toEqual([]);
    expect(s.openedApps).toEqual([]);
  },
);

test("dispatch focusSession with a valid positive integer reaches the session", async () => {
  const s = await withSessions([session({ pid: 12, tty: "ttys015" })]);
  s.handlers.osascript = async () => "ok\n";
  await dispatch(s.api, { method: "focusSession", args: [12] });
  expect(s.osascripts).toEqual([focusTerminalOsascriptArgs("ttys015")]);
});

// ---- dispatch (the IPC trust boundary)

test("dispatch calls the right method with the right arguments", async () => {
  const calls: unknown[][] = [];
  const api = { stopRun: async (...a: unknown[]) => void calls.push(a), getState: async () => "state" } as never;
  await dispatch(api, { method: "stopRun", args: [7] });
  expect(calls).toEqual([[7]]);
  await expect(dispatch(api, { method: "getState", args: [] })).resolves.toBe("state");
});

test.each([
  ["constructor", { method: "constructor", args: [] }],
  ["__proto__", { method: "__proto__", args: [] }],
  ["toString", { method: "toString", args: [] }],
  ["hasOwnProperty", { method: "hasOwnProperty", args: [] }],
  ["pushState (on the object but not in API_METHODS)", { method: "pushState", args: [] }],
  ["sweep", { method: "sweep", args: [] }],
  ["scan", { method: "scan", args: [] }],
  ["method is not a string", { method: 5, args: [] }],
  ["method is an array", { method: ["getState"], args: [] }],
  ["missing method", { args: [] }],
  ["args is not an array", { method: "getState", args: "x" }],
  ["missing args", { method: "getState" }],
  ["null", null],
  ["string", "getState"],
  ["undefined", undefined],
])("dispatch refuses %s with an error and calls nothing", async (_name, req) => {
  const called: string[] = [];
  const api = new Proxy({}, { get: (_t, k) => (called.push(String(k)), async () => "x") }) as never;
  await expect(dispatch(api, req)).rejects.toThrow(/^Unknown method|^Invalid request/);
  expect(called).toEqual([]);
});

// ---- app (open at login)

test("state.app: packaged, openAtLogin e claudeFound theo deps", async () => {
  const s = setup({ packaged: true, openAtLogin: true });
  expect((await s.api.getState()).app).toEqual({ packaged: true, openAtLogin: true, claudeFound: true });
  s.found.claude = null;
  expect((await s.api.getState()).app.claudeFound).toBe(false);
});

test("state.app.openAtLogin is false when not packaged even if loginItem says on", async () => {
  const s = setup({ packaged: false, openAtLogin: true });
  expect((await s.api.getState()).app).toEqual({ packaged: false, openAtLogin: false, claudeFound: true });
});

test("setOpenAtLogin when packaged: calls loginItem.set, then pushes the state", async () => {
  const s = setup({ packaged: true });
  await s.api.setOpenAtLogin(true);
  expect(s.login.sets).toEqual([true]);
  expect(s.states.at(-1)!.app.openAtLogin).toBe(true);
  await s.api.setOpenAtLogin(false);
  expect(s.login.sets).toEqual([true, false]);
  expect(s.states.at(-1)!.app.openAtLogin).toBe(false);
});

test("setOpenAtLogin: when macOS does not accept the change it throws, the state is still pushed", async () => {
  const s = setup({ packaged: true });
  const api = createApi({ ...s.deps, loginItem: { get: () => false, set: () => undefined } });
  const before = s.states.length;
  await expect(api.setOpenAtLogin(true)).rejects.toThrow("macOS did not accept this change. Check System Settings > General > Login Items.");
  expect(s.states.length).toBeGreaterThan(before);
});

test("setOpenAtLogin when not packaged is refused and changes nothing", async () => {
  const s = setup({ packaged: false });
  await expect(s.api.setOpenAtLogin(true)).rejects.toThrow("Can only be turned on in the packaged app");
  expect(s.login.sets).toEqual([]);
});

test.each([["true"], [1], [null], [undefined]])("setOpenAtLogin with %j is refused and loginItem.set is not called", async (v) => {
  const s = setup({ packaged: true });
  await expect(s.api.setOpenAtLogin(v as never)).rejects.toThrow("Invalid value");
  expect(s.login.sets).toEqual([]);
});

test("dispatch setOpenAtLogin reaches loginItem; an odd value is refused", async () => {
  const s = setup({ packaged: true });
  await dispatch(s.api, { method: "setOpenAtLogin", args: [true] });
  expect(s.login.sets).toEqual([true]);
  await expect(dispatch(s.api, { method: "setOpenAtLogin", args: ["yes"] })).rejects.toThrow("Invalid value");
  expect(s.login.sets).toEqual([true]);
});

// ---- Claude desktop assigned to a lane

const lane = (id: string): Account => ({ id, name: id, accepting: false, allowedDirs: [], reservePct: 90 });
const desktop = (o: Partial<OpenSession> = {}) => session({ pid: 300, kind: DESKTOP_KIND, accountId: undefined, appPath: "/Applications/Claude.app", ...o });

test("setDesktopAccount: after assigning and scanning, the Claude desktop session carries the accountId, the Terminal session is unchanged", async () => {
  const s = setup();
  s.repos.accounts.insert(lane("a1"));
  s.repos.accounts.insert(lane("a2"));
  const terminal = session({ pid: 100, accountId: "a2" });
  s.handlers.scanSessions = async () => [terminal, desktop()];
  await s.api.scan();
  expect((await s.api.getState()).sessions).toEqual([terminal, desktop()]);
  expect((await s.api.getState()).desktopAccountId).toBeUndefined();
  await s.api.setDesktopAccount("a1");
  const state = await s.api.getState();
  expect(state.desktopAccountId).toBe("a1");
  expect(state.sessions).toEqual([terminal, desktop({ accountId: "a1" })]);
  expect(s.states.at(-1)?.sessions[1]?.accountId).toBe("a1");
  await s.api.setDesktopAccount(null);
  const cleared = await s.api.getState();
  expect("desktopAccountId" in cleared).toBe(false);
  expect(cleared.sessions[1]?.accountId).toBeUndefined();
});

test("setDesktopAccount: an odd id, a number and an object are refused and change nothing", async () => {
  const s = setup();
  s.repos.accounts.insert(lane("a1"));
  await s.api.setDesktopAccount("a1");
  for (const bad of ["nope", "", 5, {}, [], undefined, true]) {
    await expect(s.api.setDesktopAccount(bad as never)).rejects.toThrow("This account no longer exists (it may have just been deleted)");
  }
  expect(s.repos.settings.getDesktopAccount()).toBe("a1");
});

test("setDesktopAccount: through dispatch, an odd value is refused", async () => {
  const s = setup();
  s.repos.accounts.insert(lane("a1"));
  await expect(dispatch(s.api, { method: "setDesktopAccount", args: [{ id: "a1" }] })).rejects.toThrow("This account no longer exists");
  await dispatch(s.api, { method: "setDesktopAccount", args: ["a1"] });
  expect(s.repos.settings.getDesktopAccount()).toBe("a1");
});

test("deleteAccount: deleting the assigned account unassigns it and the session goes back to no accountId", async () => {
  const s = setup();
  s.repos.accounts.insert(lane("a1"));
  s.repos.accounts.insert(lane("a2"));
  s.handlers.scanSessions = async () => [desktop()];
  await s.api.scan();
  await s.api.setDesktopAccount("a1");
  await s.api.deleteAccount("a2"); // another account: the choice stays
  expect((await s.api.getState()).desktopAccountId).toBe("a1");
  await s.api.deleteAccount("a1");
  const state = await s.api.getState();
  expect("desktopAccountId" in state).toBe(false);
  expect(state.sessions).toEqual([desktop()]);
  expect(s.repos.settings.getDesktopAccount()).toBeUndefined();
});

test("the store already holds the id of an account that does not exist: treated as unassigned", async () => {
  const s = setup();
  s.repos.accounts.insert(lane("a1"));
  s.repos.settings.setDesktopAccount("ghost");
  s.handlers.scanSessions = async () => [desktop()];
  await s.api.scan();
  const state = await s.api.getState();
  expect("desktopAccountId" in state).toBe(false);
  expect(state.sessions).toEqual([desktop()]);
});

test("focusSession: an assigned Claude desktop session still opens the Claude app", async () => {
  const s = setup();
  s.repos.accounts.insert(lane("a1"));
  s.handlers.scanSessions = async () => [desktop()];
  await s.api.scan();
  await s.api.setDesktopAccount("a1");
  await s.api.focusSession(300);
  expect(s.openedApps).toEqual(["/Applications/Claude.app"]);
});
