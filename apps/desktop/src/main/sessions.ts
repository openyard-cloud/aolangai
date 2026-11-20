import { execFile } from "node:child_process";
import path from "node:path";
import type { Account } from "@aolangai/core";
import { DESKTOP_KIND, OTHER_KIND, TERMINAL_KIND, isTtyName, type OpenSession } from "../shared/api.js";
import { normalizeConfigDir } from "./accounts.js";
import { terminalTitlesOsascriptArgs } from "./login.js";

export { DESKTOP_KIND, OTHER_KIND };

export interface Proc {
  pid: number;
  ppid: number;
  /** Owner of the process. */
  uid: number;
  /** Controlling terminal as ps prints it ("ttys015"); undefined for "??". */
  tty?: string;
  /** ms since epoch */
  startedAt: number;
  comm: string;
}

/** Runs a command; stdout on exit 0 or 1, undefined on spawn error, signal, timeout or any other exit. */
export type Exec = (file: string, args: string[]) => Promise<string | undefined>;

/** Exit 1 counts as success: `ps -p` and `lsof` use it when only some of the asked-for pids exist. */
export const realExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { env: { LC_CTYPE: "UTF-8", LC_TIME: "C", TZ: "UTC" }, timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // A spawn error has a string code, a signal or timeout kill has a null one.
      resolve(!err || (err as { code?: unknown }).code === 1 ? stdout : undefined);
    });
  });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// pid ppid uid tty <weekday month day hh:mm:ss year> comm, from `ps -o lstart=` (English month names via LC_TIME=C, always UTC here).
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+?)\s*$/;

/** Parses `ps -axo pid=,ppid=,uid=,tty=,lstart=,comm=`; lines that are not a process are skipped. */
export function parsePs(text: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = PS_LINE.exec(line);
    const month = m ? MONTHS.indexOf(m[5]!) : -1;
    if (!m || month < 0) continue;
    const startedAt = Date.UTC(Number(m[10]), month, Number(m[6]), Number(m[7]), Number(m[8]), Number(m[9]));
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), tty: m[4] === "??" ? undefined : m[4], startedAt, comm: m[11]! });
  }
  return procs;
}

/** Claude Code's own binary: `claude` from the installer or Homebrew, `claude.exe` when npm's copy is started by its real path. */
const CLAUDE_BINARIES = new Set(["claude", "claude.exe"]);
const isClaudeBinary = (p: Proc) => CLAUDE_BINARIES.has(path.basename(p.comm));
const isNode = (p: Proc) => path.basename(p.comm) === "node";

/**
 * Whether a `node` process is Claude Code, from its command line (`ps -o args=`): older npm releases run as
 * `node …/bin/claude` or `node …/@anthropic-ai/claude-code/cli.js`, and Claude Code renames its process to `claude`.
 * Only the program and its first argument are looked at, so a script that merely takes a path with "claude" in it
 * later on does not count.
 */
export function isClaudeCommandLine(args: string): boolean {
  const [program, script] = args.trim().split(/\s+/);
  return [program, script].some((t) => t !== undefined && (CLAUDE_BINARIES.has(path.basename(t)) || /\/@anthropic-ai\/claude-code\/cli\.m?js$/.test(t)));
}

const ARGS_LINE = /^\s*(\d+)\s(.*)$/;

/** The pids among `nodes` whose command line is Claude Code's. Empty when the command lines cannot be read. */
async function claudeNodes(nodes: Proc[], exec: Exec): Promise<Set<number>> {
  const found = new Set<number>();
  if (nodes.length === 0) return found;
  let text: string | undefined;
  try {
    text = await exec("/bin/ps", ["-ww", "-o", "pid=,args=", "-p", nodes.map((p) => p.pid).join(",")]);
  } catch {
    text = undefined;
  }
  for (const line of (text ?? "").split("\n")) {
    const m = ARGS_LINE.exec(line);
    if (m && isClaudeCommandLine(m[2]!)) found.add(Number(m[1]));
  }
  return found;
}

/** Visits the ancestors of `proc`, nearest first, stopping at a missing parent or a loop; stops early when `visit` returns true. */
function someAncestor(proc: Proc, byPid: Map<number, Proc>, visit: (p: Proc) => boolean): boolean {
  const seen = new Set([proc.pid]);
  for (let p = byPid.get(proc.ppid); p && !seen.has(p.pid); p = byPid.get(p.ppid)) {
    if (visit(p)) return true;
    seen.add(p.pid);
  }
  return false;
}

// The path up to the end of the first (outermost) `.app` directory, and that app's name.
const APP_IN_PATH = /^(.*?\/([^/]+)\.app)\//;

/** Kind and bundle path of the first ancestor that lives in an app: the outermost `.app` of its path. */
export function sessionHost(proc: Proc, byPid: Map<number, Proc>): { kind: string; appPath?: string } {
  let host: { kind: string; appPath?: string } = { kind: OTHER_KIND };
  someAncestor(proc, byPid, (p) => {
    const m = APP_IN_PATH.exec(p.comm);
    if (!m) return false;
    const app = m[2]!;
    const kind = app === "Claude" ? DESKTOP_KIND : app === "Visual Studio Code" ? "VS Code" : app === "iTerm" || app === "iTerm2" ? "iTerm" : app;
    host = { kind, appPath: m[1]! };
    return true;
  });
  return host;
}

/** Which app hosts the process. */
export const sessionKind = (proc: Proc, byPid: Map<number, Proc>): string => sessionHost(proc, byPid).kind;

const SECRET_VARS = [" ANTHROPIC_API_KEY=", " ANTHROPIC_AUTH_TOKEN=", " CLAUDE_CODE_OAUTH_TOKEN="];
const CONFIG_DIR_VAR = " CLAUDE_CONFIG_DIR=";
const NEXT_VAR = /^ [A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The account an interactive claude runs as, from its `ps eww` text (command line, then environment). Only the value of
 * CLAUDE_CONFIG_DIR is used; for the credential variables just their presence is checked. Undefined: a login that is not
 * a config dir (API key or token), a dir that belongs to no account, or a name that occurs twice (the text is the command
 * line followed by the environment, so an argument can carry it too). With the variable set, Claude Code uses another
 * Keychain entry than the default login, so the account without a configDir is never a candidate then.
 */
export function accountOf(envText: string, accounts: Pick<Account, "id" | "configDir">[]): string | undefined {
  if (SECRET_VARS.some((v) => envText.includes(v))) return undefined;
  const at = envText.indexOf(CONFIG_DIR_VAR);
  if (at < 0) {
    const dflt = normalizeConfigDir(undefined);
    return accounts.find((a) => normalizeConfigDir(a.configDir) === dflt)?.id;
  }
  if (envText.indexOf(CONFIG_DIR_VAR, at + 1) >= 0) return undefined;
  const value = envText.slice(at + CONFIG_DIR_VAR.length);
  const byDirLength = accounts
    .filter((a) => a.configDir?.trim())
    .map((a) => ({ id: a.id, dir: normalizeConfigDir(a.configDir) }))
    .sort((x, y) => y.dir.length - x.dir.length);
  for (const { id, dir } of byDirLength) {
    if (!value.startsWith(dir)) continue;
    let rest = value.slice(dir.length);
    if (rest.startsWith("/")) rest = rest.slice(1);
    if (rest === "" || NEXT_VAR.test(rest)) return id;
  }
  return undefined;
}

/** Parses `lsof -Fpn` output (p<pid>, then f/n fields): pid to its working directory. */
export function parseCwds(text: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = /^\d+$/.test(line.slice(1)) ? Number(line.slice(1)) : undefined;
    else if (line.startsWith("n") && pid !== undefined && !cwds.has(pid)) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

export interface ScanInput {
  accounts: Account[];
  /** Pids of the workers this app started. */
  excludePids: number[];
  /** This app's own pid: its descendants are not the owner's sessions. */
  selfPid: number;
  /** The app user's uid: only that user's claude processes are sessions. Undefined keeps every candidate. */
  uid: number | undefined;
  exec: Exec;
  /** ms since epoch; drives the 5-minute back-off of the title lookup. */
  now: number;
}

/** After a failed or empty title lookup, how long to leave Terminal alone. */
export const TITLE_BACKOFF_MS = 5 * 60_000;
let titleBackoffFrom: number | undefined;
/** Forgets the back-off (for tests). */
export function resetTitleBackoff(): void {
  titleBackoffFrom = undefined;
}

/** Tab titles by tty name ("ttys015"), from the output of terminalTitlesOsascriptArgs. Lines without a tab or with a bad tty are dropped. */
export function parseTabTitles(text: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const dev = line.slice(0, tab);
    const tty = dev.startsWith("/dev/") ? dev.slice(5) : "";
    if (isTtyName(tty)) titles.set(tty, line.slice(tab + 1));
  }
  return titles;
}

/** A tab title as a session name: status glyphs stripped, control characters removed, at most 80 characters; undefined when nothing is left or it is just "Terminal". */
export function sessionName(title: string): string | undefined {
  const name = Array.from(title.replace(/\p{Cc}/gu, "").replace(/^[^\p{L}\p{N}]+/u, ""))
    .slice(0, 80)
    .join("")
    .trim();
  return name === "" || name === TERMINAL_KIND ? undefined : name;
}

/** The tab titles of Terminal, or undefined when the lookup is backed off, fails or yields no usable line. Never throws. */
async function terminalTitles(exec: Exec, now: number): Promise<Map<string, string> | undefined> {
  if (titleBackoffFrom !== undefined && now - titleBackoffFrom < TITLE_BACKOFF_MS) return undefined;
  let titles: Map<string, string> | undefined;
  try {
    const text = await exec("/usr/bin/osascript", terminalTitlesOsascriptArgs());
    titles = text === undefined ? undefined : parseTabTitles(text);
  } catch {
    titles = undefined;
  }
  if (!titles || titles.size === 0) {
    titleBackoffFrom = now;
    return undefined;
  }
  titleBackoffFrom = undefined;
  return titles;
}

const EWW_LINE = /^\s*(\d+)\s(.*)$/;

/**
 * Maps each pid in `ps eww` output to its account. The environment text is read here and dropped at once: only the
 * resulting account id leaves this function.
 */
function accountsFromEww(text: string, accounts: Account[]): Map<number, string | undefined> {
  const result = new Map<number, string | undefined>();
  for (const line of text.split("\n")) {
    const m = EWW_LINE.exec(line);
    if (m) result.set(Number(m[1]), accountOf(m[2]!, accounts));
  }
  return result;
}

const DESKTOP_BINARY_DIR = "/Library/Application Support/Claude/claude-code/";

/** `sessionHost`, plus: a Claude desktop binary re-parented to launchd has no app among its ancestors but is still a desktop session. */
function hostOf(proc: Proc, byPid: Map<number, Proc>): { kind: string; appPath?: string } {
  const host = sessionHost(proc, byPid);
  return host.kind === OTHER_KIND && proc.comm.includes(DESKTOP_BINARY_DIR) ? { kind: DESKTOP_KIND } : host;
}

/** The interactive Claude Code sessions the owner has open. Undefined = the process list could not be read; the caller keeps its previous list. */
export async function scanSessions({ accounts, excludePids, selfPid, uid, exec, now }: ScanInput): Promise<OpenSession[] | undefined> {
  const psText = await exec("/bin/ps", ["-axo", "pid=,ppid=,uid=,tty=,lstart=,comm="]);
  if (psText === undefined) return undefined;
  const procs = parsePs(psText);
  // An answer without a single process is not a process list: keep the previous one.
  if (procs.length === 0) return undefined;
  // The whole table stays, whoever owns a process: root-owned ancestors such as `login` are needed for the walks below.
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const mine = (p: Proc) => uid === undefined || p.uid === uid;
  const nodeClaudes = await claudeNodes(procs.filter((p) => isNode(p) && mine(p)), exec);
  const isClaude = (p: Proc) => isClaudeBinary(p) || nodeClaudes.has(p.pid);
  const sessions = [...byPid.values()]
    .filter((p) => isClaude(p) && mine(p) && !excludePids.includes(p.pid) && !someAncestor(p, byPid, (a) => a.pid === selfPid || isClaude(a)))
    .map((p) => ({ proc: p, ...hostOf(p, byPid) }))
    .sort((a, b) => a.proc.startedAt - b.proc.startedAt || a.proc.pid - b.proc.pid);
  if (sessions.length === 0) return [];

  // The environment is never read for Claude desktop sessions (they have no lane), nor when there is no account to match.
  const envPids = accounts.length === 0 ? [] : sessions.filter((s) => s.kind !== DESKTOP_KIND).map((s) => s.proc.pid);
  const [ewwText, lsofText] = await Promise.all([
    envPids.length ? exec("/bin/ps", ["eww", "-o", "pid=,command=", "-p", envPids.join(",")]) : undefined,
    exec("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", sessions.map((s) => s.proc.pid).join(",")]),
  ]);
  const accountIds = ewwText === undefined ? new Map<number, string | undefined>() : accountsFromEww(ewwText, accounts);
  const cwds = lsofText === undefined ? new Map<number, string>() : parseCwds(lsofText);

  // Only Terminal tabs have a title to read, and only a session with a tty can be matched to one.
  const hasTerminalTty = sessions.some((s) => s.kind === TERMINAL_KIND && s.proc.tty !== undefined);
  const titles = hasTerminalTty ? await terminalTitles(exec, now) : undefined;

  return sessions.map(({ proc, kind, appPath }) => {
    const title = kind === TERMINAL_KIND && proc.tty !== undefined ? titles?.get(proc.tty) : undefined;
    const name = title === undefined ? undefined : sessionName(title);
    return {
      pid: proc.pid,
      kind,
      accountId: kind === DESKTOP_KIND ? undefined : accountIds.get(proc.pid),
      cwd: cwds.get(proc.pid),
      startedAt: proc.startedAt,
      tty: proc.tty,
      appPath,
      ...(name !== undefined && { name }),
    };
  });
}
