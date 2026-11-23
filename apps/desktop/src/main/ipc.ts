import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_NOT_FOUND,
  checkAccount,
  expandHome,
  folderAllowed,
  installShim,
  installSkill,
  installStatus,
  shimText,
  skillStatus,
  stopAll,
  stopRun,
  sweepDeadRuns,
  NEST_ENV,
  type Account,
  type CheckDeps,
  type CliRuntime,
  type InstallPaths,
  type InstallStatus,
  type Repos,
} from "@aolangai/core";
import { API_METHODS, AUTO_CONFIG_DIR, DESKTOP_KIND, TERMINAL_KIND, isTtyName, type AppApi, type AppInstallStatus, type AppNotice, type AppState, type OpenSession, type SkillPlace } from "../shared/api.js";
import { validateLimits } from "../shared/limits.js";
import { cleanAccount, normalizeConfigDir } from "./accounts.js";
import { focusTerminalOsascriptArgs, loginOsascriptArgs, resumeOsascriptArgs, startOsascriptArgs } from "./login.js";

/** The part of a child process the retry needs; a real ChildProcess fits. */
export interface SpawnedChild {
  stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", cb: (e: Error) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  unref(): void;
  on(event: "error", cb: (e: Error) => void): unknown;
  /** After the process exited and its streams closed. */
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface ApiDeps {
  repos: Repos;
  /** Handed to the retry child as AOLANGAI_DB so it uses the same store. */
  dbPath: string;
  /** The app's userData folder (`profiles/<id>` lives under it). */
  userData: string;
  /** The app's own environment (process.env). */
  env: NodeJS.ProcessEnv;
  exec: CheckDeps["exec"];
  /** findExecutable. */
  which(cmd: string): string | null;
  /** What runs the CLI for the installed command and for retries. */
  runtime: CliRuntime;
  /** app.isPackaged: only a packaged app installs the skill and the command by itself. */
  packaged: boolean;
  /** The login item of the app (open at login): `get` reads it, `set` changes it. */
  loginItem: { get(): boolean; set(on: boolean): void };
  spawn(cmd: string, args: string[], opts: { env: Record<string, string>; detached: true; stdio: ["pipe", "ignore", "pipe"] }): SpawnedChild;
  /** shell.openPath: resolves with an error message, "" when it worked. */
  openPath(p: string): Promise<string>;
  showItemInFolder(p: string): void;
  /** shell.openExternal; only ever called with an http or https URL that passed the check in `openExternal`. */
  openExternal(url: string): Promise<void>;
  /** Lists the open interactive Claude Code sessions, skipping `excludePids`; undefined when the process list could not be read. */
  scanSessions(accounts: Account[], excludePids: number[]): Promise<OpenSession[] | undefined>;
  /** Runs `osascript` with these arguments; resolves with what it printed, rejects when it failed. */
  runOsascript(args: string[]): Promise<string>;
  /** Brings an app to the front (`/usr/bin/open -a <appPath>`); rejects when it could not be opened. */
  openApp(appPath: string): Promise<void>;
  /**
   * Folder picker opened on `defaultPath`; resolves undefined when the owner cancels. `recent` are folders to offer
   * first (already checked: existing and allowed for the account); empty means go straight to the dialog.
   */
  pickFolder(defaultPath: string, recent: string[]): Promise<string | undefined>;
  /** The CLI the app installs and runs for retries: its built entry and the skill text. */
  cli: { entry: string; skillFile: string };
  installPaths: InstallPaths;
  now(): number;
  /** Called with every state that differs from the one sent before. */
  emitState(state: AppState): void;
  /** Tells the owner something that happened outside any run row, e.g. a retry the CLI refused. */
  emitNotice(notice: AppNotice): void;
}

export type MainApi = AppApi & {
  /** Rebuilds the state and sends it unless it equals the last one sent. */
  pushState(): void;
  /** Fails runs whose dispatcher died; returns how many. */
  sweep(): number;
  /** Rescans open sessions; pushes when the list changed. Never rejects. */
  scan(): Promise<void>;
  /** Packaged app only: the same installs as `install`, silently. Never throws. */
  autoInstall(): void;
};

const STATE_RUNS = 200;
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
const MISSING: InstallStatus = { skill: "missing", shim: "missing" };
const CLI_NOT_BUILT = "The aolangai command is not built (packages/cli/dist)";
const STDERR_KEEP = 4_096;
const NOTICE_REASON_CAP = 160;
const CLI_PREFIX = "[aolangai] ";
const SESSION_BUSY = "This session has a run in progress, wait until it finishes, then open it";

/** Why the CLI did not run: its last `[aolangai] ` line without the prefix, else how it ended. */
function refusalReason(stderr: string, code: number | null, signal: NodeJS.Signals | null, error?: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(CLI_PREFIX))
    .at(-1)
    ?.slice(CLI_PREFIX.length)
    .trim();
  const reason = line || error || (code === null ? `stopped by signal ${signal ?? "unknown"}` : `exited with code ${code}`);
  return reason.slice(0, NOTICE_REASON_CAP);
}

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** AppApi over the shared store. No electron import: index.ts wires the real shell, tests wire fakes. */
export function createApi(deps: ApiDeps): MainApi {
  const { repos } = deps;
  let lastSent: string | undefined;
  /** The last scan's result; lives only in memory. */
  let sessions: OpenSession[] = [];
  let scanning: Promise<void> | undefined;

  /** The skill text, or undefined when the CLI is not built or its skill file cannot be read. */
  const readSkill = (): string | undefined => {
    if (!isFile(deps.cli.entry)) return undefined;
    try {
      return fs.readFileSync(deps.cli.skillFile, "utf8");
    } catch {
      return undefined;
    }
  };
  /** Where each account's own copy of the skill goes: accounts with a config dir other than ~/.claude, in account order. */
  const skillPlaces = (): { account: Account; dir: string; skillDir: string }[] => {
    const home = normalizeConfigDir(undefined);
    return repos.accounts.list().flatMap((account) => {
      const dir = normalizeConfigDir(account.configDir);
      return dir === home ? [] : [{ account, dir, skillDir: path.join(dir, "skills", "aolangai") }];
    });
  };
  const displayPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
  };
  const installNow = (): AppInstallStatus => {
    const skill = readSkill();
    const base: InstallStatus = skill === undefined ? { ...MISSING } : installStatus(deps.installPaths, skill, shimText(deps.runtime, deps.cli.entry));
    const accounts = skillPlaces().map(({ account, dir, skillDir }): SkillPlace => ({
      accountId: account.id,
      file: displayPath(path.join(skillDir, "SKILL.md")),
      // The app never makes a config dir; the only file it looks at inside one is skills/aolangai/SKILL.md.
      skill: !isDir(dir) ? "no-dir" : skill === undefined ? "missing" : skillStatus(skillDir, skill),
    }));
    return { ...base, accounts };
  };
  /**
   * Skill at ~/.claude, the command, then each account's skill. Every place is tried even when an earlier one failed;
   * a foreign file or a missing config dir at an account is skipped. Throws at the end: the first error of the
   * ~/.claude skill or the command, else the accounts' errors.
   */
  const installEverywhere = (skill: string): void => {
    let first: unknown;
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        first ??= e;
      }
    };
    attempt(() => installSkill(deps.installPaths.skillDir, skill));
    attempt(() => installShim(deps.installPaths.binDir, shimText(deps.runtime, deps.cli.entry)));
    const failed: string[] = [];
    for (const { account, dir, skillDir } of skillPlaces()) {
      if (!isDir(dir) || skillStatus(skillDir, skill) === "foreign") continue;
      try {
        installSkill(skillDir, skill);
      } catch (e) {
        failed.push(`${account.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (first !== undefined) throw first;
    if (failed.length > 0) throw new Error(`Could not install the skill for: ${failed.join("; ")}`);
  };
  const autoInstall = () => {
    if (!deps.packaged) return;
    try {
      const skill = readSkill();
      if (skill !== undefined) installEverywhere(skill);
    } catch {
      // silent: the owner can press the install button to see why
    }
  };
  const buildState = (): AppState => {
    const accounts = repos.accounts.list();
    // The stored id is only believed while that account exists; a stale one counts as not assigned.
    const stored = repos.settings.getDesktopAccount();
    const desktopAccountId = stored !== undefined && accounts.some((a) => a.id === stored) ? stored : undefined;
    return {
      accounts,
      statuses: repos.status.list(),
      runs: repos.runs.recent(STATE_RUNS),
      limits: repos.settings.getLimits(),
      install: installNow(),
      app: { packaged: deps.packaged, openAtLogin: deps.packaged && deps.loginItem.get(), claudeFound: deps.which("claude") !== null },
      // A declaration, not a detection: the scan never learns which account Claude desktop uses.
      sessions: desktopAccountId === undefined ? sessions : sessions.map((s) => (s.kind === DESKTOP_KIND ? { ...s, accountId: desktopAccountId } : s)),
      ...(desktopAccountId === undefined ? {} : { desktopAccountId }),
    };
  };
  const pushState = () => {
    const state = buildState();
    const json = JSON.stringify(state);
    if (json === lastSent) return;
    lastSent = json;
    try {
      deps.emitState(state);
    } catch {
      // the window may be gone; the write that led here has succeeded
    }
  };
  /** Runs a write through the app's own connection, then pushes: data_version does not change for our own commits. */
  const written = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      pushState();
    }
  };

  const accountOrThrow = (id: string): Account => {
    const a = repos.accounts.get(id);
    if (!a) throw new Error(`No account ${id}`);
    return a;
  };
  const runOrThrow = (id: number) => {
    const r = repos.runs.get(id);
    if (!r) throw new Error(`No run #${id}`);
    return r;
  };
  const claudeOrThrow = () => {
    const claude = deps.which("claude");
    if (!claude) throw new Error(CLAUDE_NOT_FOUND);
    return claude;
  };
  const profilesRoot = path.join(deps.userData, "profiles");
  /** Only the folders the app made for itself are created; any other Claude config dir is never touched. */
  const ensureProfileDir = (account: Account) => {
    const dir = normalizeConfigDir(account.configDir);
    if (dir.startsWith(profilesRoot + path.sep)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  };

  /** One scan. Nothing from a failure is kept or logged here: errors may carry process-list text. */
  const scanOnce = async (): Promise<void> => {
    try {
      const workerPids = repos.runs.running().flatMap((r) => (r.workerPid === undefined ? [] : [r.workerPid]));
      const found = await deps.scanSessions(repos.accounts.list(), workerPids);
      if (found === undefined) return;
      sessions = found;
      pushState();
    } catch {
      // keep the previous list; the next tick tries again
    }
  };

  return {
    pushState,
    autoInstall,
    scan() {
      scanning ??= scanOnce().finally(() => {
        scanning = undefined;
      });
      return scanning;
    },
    sweep() {
      const n = sweepDeadRuns(repos, deps.now());
      if (n > 0) pushState();
      return n;
    },

    async getState() {
      return buildState();
    },

    saveAccount: (input) =>
      written(async () => {
        const saved = repos.tx(() => {
          const existing = input.id !== undefined ? repos.accounts.get(input.id) : undefined;
          // An id the store does not know is never adopted: the account may have been deleted meanwhile.
          if (input.id !== undefined && !existing) throw new Error("This account no longer exists (it may have just been deleted)");
          const id = existing?.id ?? randomUUID();
          const wantsAuto = input.configDir?.trim() === AUTO_CONFIG_DIR;
          if (wantsAuto && existing) throw new Error(`"${AUTO_CONFIG_DIR}" can only be used when creating a new account`);
          const others = repos.accounts.list().filter((a) => a.id !== id);
          const cleaned = cleanAccount(wantsAuto ? { ...input, configDir: path.join(profilesRoot, id) } : input, others);
          // A new account never takes work until the owner turns it on.
          const account: Account = { id, ...cleaned, accepting: existing ? Boolean(input.accepting) : false };
          if (existing) {
            repos.accounts.update(account);
            // Another login behind the same account: its old quota, limit and connection no longer apply.
            if (normalizeConfigDir(existing.configDir) !== normalizeConfigDir(account.configDir)) repos.status.delete(id);
          } else {
            repos.accounts.insert(account);
          }
          return repos.accounts.get(id)!;
        });
        autoInstall(); // after the store write; a failed install never fails the save
        return saved;
      }),

    deleteAccount: (id) =>
      written(() =>
        repos.tx(() => {
          accountOrThrow(id);
          if (repos.runs.running().some((r) => r.accountId === id)) {
            throw new Error("The account has runs in progress, stop them before deleting it");
          }
          repos.accounts.delete(id);
          repos.status.delete(id);
          if (repos.settings.getDesktopAccount() === id) repos.settings.setDesktopAccount(undefined);
          repos.settings.clearRecentDirs(id);
        }),
      ),

    async checkAccount(id) {
      const connection = await checkAccount(accountOrThrow(id), { exec: deps.exec, which: deps.which });
      // The check takes a while; re-read the status now so a quota update that landed meanwhile survives.
      await written(() =>
        repos.tx(() => {
          if (!repos.accounts.get(id)) return;
          repos.status.set({ ...(repos.status.get(id) ?? { accountId: id }), connection });
        }),
      );
      autoInstall(); // a config dir typed by hand is created by `claude auth login`, after loginAccount ran; never throws
      return connection;
    },

    async loginAccount(id) {
      const account = accountOrThrow(id);
      const claude = claudeOrThrow();
      ensureProfileDir(account);
      autoInstall(); // the config dir may exist only now; never throws, so it cannot stop the login
      await deps.runOsascript(loginOsascriptArgs(account.configDir, claude));
    },

    async openAccountTerminal(id) {
      const account = accountOrThrow(id);
      const claude = claudeOrThrow();
      const lastCwd = repos.runs.recent(STATE_RUNS).find((r) => r.accountId === id)?.cwd;
      const firstAllowed = account.allowedDirs[0] === undefined ? undefined : expandHome(account.allowedDirs[0]);
      const start = [lastCwd, firstAllowed].find((d): d is string => d !== undefined && isDir(d)) ?? os.homedir();
      const recent = repos.settings.getRecentDirs(id).filter((d) => isDir(d) && folderAllowed(account, d));
      const chosen = await deps.pickFolder(start, recent);
      if (chosen === undefined) return;
      if (!folderAllowed(account, chosen)) throw new Error(`Account ${account.name} may only work in: ${account.allowedDirs.join(", ")}`);
      ensureProfileDir(account);
      autoInstall(); // the config dir may exist only now; never throws, so it cannot stop Terminal from opening
      await deps.runOsascript(startOsascriptArgs(account.configDir, claude, chosen));
      try {
        repos.settings.addRecentDir(id, chosen); // only after Terminal really opened
      } catch {
        // best effort: Terminal is open, so a store failure must not turn into an error (and a second click)
      }
    },

    async openAccountSettings(id) {
      const dir = normalizeConfigDir(accountOrThrow(id).configDir);
      const file = path.join(dir, "settings.json");
      if (isFile(file)) {
        const error = await deps.openPath(file);
        if (error) throw new Error(error);
      } else if (isDir(dir)) {
        deps.showItemInFolder(dir); // never create files inside a Claude config dir
      } else {
        throw new Error(`The config dir does not exist yet (log in to the account first): ${dir}`);
      }
    },

    async openExternal(url) {
      let parsed: URL | undefined;
      try {
        if (typeof url === "string") parsed = new URL(url);
      } catch {
        // falls through to the refusal below
      }
      if (!parsed || !EXTERNAL_PROTOCOLS.has(parsed.protocol)) throw new Error("Only http or https links can be opened");
      await deps.openExternal(parsed.href);
    },

    async focusSession(pid) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid session id");
      const session = sessions.find((s) => s.pid === pid);
      if (!session) throw new Error("This session has closed");
      // Only the tty and app path the scan read are used; the renderer sent nothing but the pid.
      if (session.kind === TERMINAL_KIND && isTtyName(session.tty)) {
        const printed = await deps.runOsascript(focusTerminalOsascriptArgs(session.tty));
        if (printed.trim() === "missing") throw new Error("The Terminal window of this session was not found");
        return;
      }
      if (session.appPath !== undefined) return deps.openApp(session.appPath);
      throw new Error("Cannot switch to this session");
    },

    async runEvents(runId) {
      return repos.runEvents.list(runId);
    },

    stopRun: (id) => written(() => void stopRun(repos, id)),

    stopAll: () => written(() => stopAll(repos)),

    async retryRun(id) {
      const run = runOrThrow(id);
      if (run.status === "running") throw new Error(`Run #${id} is still running, it cannot be retried yet`);
      if (!isFile(deps.cli.entry)) throw new Error(CLI_NOT_BUILT);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(deps.env)) if (v !== undefined && k !== NEST_ENV && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
      env.AOLANGAI_DB = deps.dbPath;
      if (deps.runtime.electron) env.ELECTRON_RUN_AS_NODE = "1";
      // `--flag=value` in one argument: a label or folder starting with "-" is never read as another flag.
      const args = [deps.cli.entry, "run", "-", `--cwd=${run.cwd}`];
      if (run.label) args.push(`--label=${run.label}`);
      if (run.readOnly) args.push("--read-only");
      args.push("--retry-of", String(run.id));
      // A run row this retry makes has a higher id than any row now.
      const newestBefore = repos.runs.recent(1)[0]?.id ?? 0;
      // The command outlives the app window and reports into the same store; the prompt goes in on stdin. Its stderr
      // is read only to tell the owner why it refused: a refusal (exit 2) leaves no row for the app to show.
      const child = deps.spawn(deps.runtime.execPath, args, { env, detached: true, stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      let spawnError: string | undefined;
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-STDERR_KEEP);
      });
      child.on("error", (e) => {
        spawnError ??= e.message;
      });
      child.on("close", (code, signal) => {
        try {
          if (code === 0) return;
          // A run that started and then failed (1), hit a limit (3) or was stopped (130) is a row the app already shows.
          const rowMade = () => repos.db.prepare("SELECT 1 FROM runs WHERE retry_of = ? AND id > ? LIMIT 1").get(id, newestBefore) !== undefined;
          if (code !== 2 && rowMade()) return;
          deps.emitNotice({ title: "aolangai", body: `Retry of run #${id} could not start: ${refusalReason(stderr, code, signal, spawnError)}` });
        } catch {
          // the app may be closing (store or window gone); nothing more to tell
        }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.write(run.prompt);
      child.stdin?.end();
      child.unref();
    },

    async openInTerminal(runId) {
      const run = runOrThrow(runId);
      if (!run.sessionId) throw new Error("This run has no session yet");
      // Two processes on one session (the worker and a Terminal) would both write to it.
      if (run.status === "running" || repos.runs.running().some((r) => r.sessionId === run.sessionId)) throw new Error(SESSION_BUSY);
      const account = accountOrThrow(run.accountId);
      await deps.runOsascript(resumeOsascriptArgs(account.configDir, claudeOrThrow(), run.cwd, run.sessionId));
    },

    hideRun: (id) =>
      written(() => {
        if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid run id");
        return repos.runs.hide([id], deps.now());
      }),

    clearFinished: (accountId) =>
      written(() =>
        repos.tx(() => {
          if (typeof accountId !== "string" || !repos.accounts.get(accountId)) throw new Error("This account no longer exists (it may have just been deleted)");
          return repos.runs.hideFinished(accountId, deps.now());
        }),
      ),

    setLimits: (l) =>
      written(() => {
        const errors = validateLimits(l);
        if (errors.length > 0) throw new Error(errors.join(" "));
        repos.settings.setLimits(l);
      }),

    setDesktopAccount: (id) =>
      written(() =>
        repos.tx(() => {
          if (id === null) return repos.settings.setDesktopAccount(undefined);
          if (typeof id !== "string" || !repos.accounts.get(id)) throw new Error("This account no longer exists (it may have just been deleted)");
          repos.settings.setDesktopAccount(id);
        }),
      ),

    install: () =>
      written(() => {
        if (!isFile(deps.cli.entry)) throw new Error(CLI_NOT_BUILT);
        installEverywhere(fs.readFileSync(deps.cli.skillFile, "utf8"));
        return installNow();
      }),

    setOpenAtLogin: (on) =>
      written(() => {
        if (typeof on !== "boolean") throw new Error("Invalid value");
        if (!deps.packaged) throw new Error("Can only be turned on in the packaged app");
        deps.loginItem.set(on);
        if (deps.loginItem.get() !== on) throw new Error("macOS did not accept this change. Check System Settings > General > Login Items.");
      }),
  };
}

/**
 * The IPC trust boundary: `req` came from the renderer. Only a `{ method, args }` whose method is one of
 * API_METHODS (a plain list, so "constructor" or "__proto__" never match) is called.
 */
export async function dispatch(api: AppApi, req: unknown): Promise<unknown> {
  if (typeof req !== "object" || req === null) throw new Error("Invalid request");
  const { method, args } = req as { method?: unknown; args?: unknown };
  if (typeof method !== "string" || !(API_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown method ${String(method)}`);
  if (!Array.isArray(args)) throw new Error("Invalid request");
  return (api[method as keyof AppApi] as (...a: unknown[]) => unknown)(...args);
}
