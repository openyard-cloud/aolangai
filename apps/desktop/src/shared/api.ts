import type { Account, AccountStatus, ConnectionStatus, FileStatus, InstallStatus, Limits, Run, RunEvent } from "@aolangai/core";

/** Where one account's copy of the skill lives. `file` is for display (home shown as ~). */
export interface SkillPlace {
  accountId: string;
  file: string;
  skill: FileStatus | "no-dir";
}
/** The install status plus the skill of every account that has a config dir of its own. */
export interface AppInstallStatus extends InstallStatus {
  accounts: SkillPlace[];
}

/** About the app itself: whether it is the packaged one, its login-item switch, and whether the `claude` command was found. */
export interface AppInfo {
  packaged: boolean;
  /** Always false when not packaged: a development run never registers itself. */
  openAtLogin: boolean;
  claudeFound: boolean;
}

/** Everything the window shows, rebuilt from the shared store. `runs` are the newest 200, newest first. */
export interface AppState {
  accounts: Account[];
  statuses: AccountStatus[];
  runs: Run[];
  limits: Limits;
  install: AppInstallStatus;
  app: AppInfo;
  /** Interactive Claude Code sessions open now, from the last scan; empty until the first scan. */
  sessions: OpenSession[];
  /** The account the owner declared Claude desktop is using; only present when that account exists. Its sessions carry it as accountId. */
  desktopAccountId?: string;
}

/** Something the owner must be told that no run row shows (e.g. a retry the CLI refused): a notification and a toast. */
export interface AppNotice {
  title: string;
  body: string;
}

/** `OpenSession.kind` of a session that runs inside the Claude desktop app. */
export const DESKTOP_KIND = "Claude desktop";
/** `OpenSession.kind` of a session whose host app could not be told. */
export const OTHER_KIND = "other";

/** `OpenSession.kind` of a session that runs in Terminal.app, the only host whose tab can be picked. */
export const TERMINAL_KIND = "Terminal";
const TTY_NAME = /^tty[a-z0-9]+$/;
/** True for a controlling-terminal name as `ps` prints it ("ttys015"); the only form ever put into a Terminal script. */
export const isTtyName = (s: unknown): s is string => typeof s === "string" && TTY_NAME.test(s);

/** An interactive Claude Code process the owner has open; never one of our workers. */
export interface OpenSession {
  pid: number;
  /** "Terminal", "iTerm", "VS Code", "Cursor", "Claude desktop", another app's name, or "other". */
  kind: string;
  /** The lane it belongs to. Undefined: a Claude desktop session, or the account is unknown. */
  accountId?: string;
  cwd?: string;
  /** ms since epoch */
  startedAt: number;
  /** Controlling terminal as ps prints it, e.g. "ttys015"; undefined when the process has none. */
  tty?: string;
  /** Bundle path of the app that hosts the session, e.g. "/Applications/Visual Studio Code.app"; undefined for kind "other". */
  appPath?: string;
  /** What the session is called where it runs (for Terminal: the tab title Claude Code set). */
  name?: string;
}

/** What the renderer may ask the main process. */
export interface AppApi {
  getState(): Promise<AppState>;
  saveAccount(a: Omit<Account, "id"> & { id?: string }): Promise<Account>;
  /** Refuses while the account has a running run. */
  deleteAccount(id: string): Promise<void>;
  checkAccount(id: string): Promise<ConnectionStatus>;
  loginAccount(id: string): Promise<void>;
  /** Asks for a folder, then opens Terminal there on an interactive Claude Code session under this account. */
  openAccountTerminal(id: string): Promise<void>;
  /** Opens <configDir>/settings.json in the default editor. */
  openAccountSettings(id: string): Promise<void>;
  runEvents(runId: number): Promise<RunEvent[]>;
  stopRun(id: number): Promise<void>;
  stopAll(): Promise<number>;
  retryRun(id: number): Promise<void>;
  openInTerminal(runId: number): Promise<void>;
  /** Hides a finished run from its lane and from Needs you (the row stays); resolves with how many runs it hid (0 or 1). */
  hideRun(id: number): Promise<number>;
  /** Hides every finished, not yet hidden run of the account, also those beyond the state's 200; resolves with how many. */
  clearFinished(accountId: string): Promise<number>;
  setLimits(l: Limits): Promise<void>;
  /** Declares which account Claude desktop is logged into (null = none); refused unless it is an existing account. */
  setDesktopAccount(id: string | null): Promise<void>;
  install(): Promise<AppInstallStatus>;
  /** Starts the app at login on or off; refused unless the app is packaged. */
  setOpenAtLogin(on: boolean): Promise<void>;
  /** Opens an http or https link (from a run result) in the default browser; anything else is refused. */
  openExternal(url: string): Promise<void>;
  /** Brings the session's Terminal tab (or, for other apps, the app) to the front. */
  focusSession(pid: number): Promise<void>;
}

/** Every AppApi method that crosses IPC as a request. */
export const API_METHODS = [
  "getState",
  "saveAccount",
  "deleteAccount",
  "checkAccount",
  "loginAccount",
  "openAccountTerminal",
  "openAccountSettings",
  "runEvents",
  "stopRun",
  "stopAll",
  "retryRun",
  "openInTerminal",
  "hideRun",
  "clearFinished",
  "setLimits",
  "setDesktopAccount",
  "install",
  "setOpenAtLogin",
  "openExternal",
  "focusSession",
] as const satisfies readonly (keyof AppApi)[];
export type ApiMethod = (typeof API_METHODS)[number];

/** Main to renderer: a new AppState. */
export const STATE_CHANNEL = "aolangai:state";
/** Main to renderer: an AppNotice to show as a toast. */
export const NOTICE_CHANNEL = "aolangai:notice";
/** Renderer to main: `{ method, args }`. */
export const INVOKE_CHANNEL = "aolangai:invoke";

/** `configDir` value that asks the app to create `<userData>/profiles/<id>` for a new account. */
export const AUTO_CONFIG_DIR = "auto";

/** What the preload exposes as `window.aolangai`. */
export interface AolangaiBridge {
  invoke<M extends ApiMethod>(method: M, ...args: Parameters<AppApi[M]>): ReturnType<AppApi[M]>;
  /** Calls `cb` with every new state; returns the unsubscribe function. */
  onState(cb: (state: AppState) => void): () => void;
  /** Calls `cb` with every notice the main process sends; returns the unsubscribe function. */
  onNotice(cb: (notice: AppNotice) => void): () => void;
}
