import os from "node:os";
import path from "node:path";
import { expandHome } from "../accounts/env.js";

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

/** Host kind of a session that runs in the Claude desktop app. Equal to the desktop app's shared constant (a test checks it). */
export const DESKTOP_KIND = "Claude desktop";
/** Host kind of a session whose ancestors include no app. Equal to the desktop app's shared constant (a test checks it). */
export const OTHER_KIND = "other";

/** The directory a configDir value means: empty and `~/.claude` are the same default one. */
export function normalizeConfigDir(configDir: string | undefined): string {
  const dir = configDir?.trim();
  return path.resolve(expandHome(dir ? dir : path.join(os.homedir(), ".claude")));
}

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
export const isClaudeBinary = (p: Proc): boolean => CLAUDE_BINARIES.has(path.basename(p.comm));
export const isNode = (p: Proc): boolean => path.basename(p.comm) === "node";

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

/** Visits the ancestors of `proc`, nearest first, stopping at a missing parent or a loop; stops early when `visit` returns true. */
export function someAncestor(proc: Proc, byPid: Map<number, Proc>, visit: (p: Proc) => boolean): boolean {
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

export const DESKTOP_BINARY_DIR = "/Library/Application Support/Claude/claude-code/";

/** `sessionHost`, plus: a Claude desktop binary re-parented to launchd has no app among its ancestors but is still a desktop session. */
export function hostOf(proc: Proc, byPid: Map<number, Proc>): { kind: string; appPath?: string } {
  const host = sessionHost(proc, byPid);
  return host.kind === OTHER_KIND && proc.comm.includes(DESKTOP_BINARY_DIR) ? { kind: DESKTOP_KIND } : host;
}
