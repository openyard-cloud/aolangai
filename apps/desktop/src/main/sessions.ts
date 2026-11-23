import { execFile } from "node:child_process";
import {
  accountForConfigDir,
  hostOf,
  isClaudeBinary,
  isClaudeCommandLine,
  isNode,
  parsePs,
  sessionHost,
  someAncestor,
  usesCredentialVar,
  type Account,
  type Proc,
} from "@aolangai/core";
import { DESKTOP_KIND, OTHER_KIND, TERMINAL_KIND, isTtyName, type OpenSession } from "../shared/api.js";
import { terminalTitlesOsascriptArgs } from "./login.js";

export { DESKTOP_KIND, OTHER_KIND, isClaudeCommandLine, parsePs, sessionHost, type Proc };

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

/** Which app hosts the process. */
export const sessionKind = (proc: Proc, byPid: Map<number, Proc>): string => sessionHost(proc, byPid).kind;

const CONFIG_DIR_VAR = " CLAUDE_CONFIG_DIR=";
const NEXT_VAR = /^ [A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The account an interactive claude runs as, from its `ps eww` text (command line, then environment), with the same
 * rules as the CLI's `callerAccount` (`accountForConfigDir`). Only the value of CLAUDE_CONFIG_DIR is used; for the
 * credential variables just their presence is checked. Undefined: a login that is not a config dir (API key or token),
 * a dir that belongs to no account, or a name that occurs twice (the text is the command line followed by the
 * environment, so an argument can carry it too).
 */
export function accountOf(envText: string, accounts: Pick<Account, "id" | "configDir">[]): string | undefined {
  if (usesCredentialVar((name) => envText.includes(` ${name}=`))) return undefined;
  const at = envText.indexOf(CONFIG_DIR_VAR);
  if (at < 0) return accountForConfigDir(undefined, accounts);
  if (envText.indexOf(CONFIG_DIR_VAR, at + 1) >= 0) return undefined;
  return accountForConfigDir(envText.slice(at + CONFIG_DIR_VAR.length), accounts, (rest) => rest === "" || NEXT_VAR.test(rest));
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
