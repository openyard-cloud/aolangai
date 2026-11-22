import { spawnSync } from "node:child_process";
import type { Account, Caller } from "../types.js";
import { DESKTOP_KIND, hostOf, isClaudeBinary, isClaudeCommandLine, isNode, normalizeConfigDir, parsePs, type Proc } from "./procs.js";

/** Runs `/bin/ps` with the args; its stdout, or undefined when it could not run. */
export type PsRun = (args: string[]) => string | undefined;

/** Exit 1 counts as success: `ps -p` uses it when the asked-for pid does not exist. English month names (LC_TIME=C) and UTC, as `parsePs` expects; the same env as the app's session scan, so both read a path the same way. */
export const realPs: PsRun = (args) => {
  const r = spawnSync("/bin/ps", args, { encoding: "utf8", env: { LC_CTYPE: "UTF-8", LC_TIME: "C", TZ: "UTC" }, timeout: 2000, maxBuffer: 1024 * 1024 });
  // A spawn error or a timeout kill leaves no exit status.
  return r.status === 0 || r.status === 1 ? r.stdout : undefined;
};

/** Variables that make Claude Code log in without the account's config dir. */
const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * The account a Claude Code session runs on, from the environment it passed down to us. Only whether a credential
 * variable is set is looked at, never its value; with one set the account cannot be told from the config dir.
 */
export function callerAccount(env: NodeJS.ProcessEnv, accounts: Pick<Account, "id" | "configDir">[]): string | undefined {
  if (CREDENTIAL_VARS.some((name) => env[name])) return undefined;
  const dir = normalizeConfigDir(env.CLAUDE_CONFIG_DIR);
  return accounts.find((a) => normalizeConfigDir(a.configDir) === dir)?.id;
}

const PROC_FORMAT = "pid=,ppid=,uid=,tty=,lstart=,comm=";
const ARGS_LINE = /^\s*(\d+)\s(.*)$/;

/** The process `pid`, or undefined when ps does not know it. */
function lookup(ps: PsRun, pid: number): Proc | undefined {
  return parsePs(ps(["-o", PROC_FORMAT, "-p", String(pid)]) ?? "").find((p) => p.pid === pid);
}

/** Whether `proc` is Claude Code: its binary, or a `node` whose command line (program and first argument only) is Claude Code's. */
function isClaudeCode(ps: PsRun, proc: Proc): boolean {
  if (isClaudeBinary(proc)) return true;
  if (!isNode(proc)) return false;
  for (const line of (ps(["-ww", "-o", "pid=,args=", "-p", String(proc.pid)]) ?? "").split("\n")) {
    const m = ARGS_LINE.exec(line);
    if (m && Number(m[1]) === proc.pid) return isClaudeCommandLine(m[2]!);
  }
  return false;
}

/**
 * The nearest Claude Code process above `selfPid`, with what it runs in and the account it uses; undefined when
 * there is none. The account comes from `env` (this process inherited it from that session) and is unknown for
 * a desktop session, whose environment is not ours. Never reads another process's environment.
 * `maxDepth` caps the pids looked up above `selfPid`, the caller's own ancestors (for its host) included.
 */
export function findCaller(o: { selfPid: number; env: NodeJS.ProcessEnv; accounts: Account[]; ps?: PsRun; maxDepth?: number }): Caller | undefined {
  try {
    const ps = o.ps ?? realPs;
    const self = lookup(ps, o.selfPid);
    if (!self) return undefined;
    const byPid = new Map<number, Proc>();
    const seen = new Set([o.selfPid]);
    let caller: Proc | undefined;
    let pid = self.ppid;
    for (let step = 0; step < (o.maxDepth ?? 32) && pid > 1 && !seen.has(pid); step++) {
      seen.add(pid);
      const proc = lookup(ps, pid);
      if (!proc) break;
      byPid.set(proc.pid, proc);
      // Past the caller, ancestors are only collected, so `hostOf` can tell where it runs.
      if (!caller && isClaudeCode(ps, proc)) caller = proc;
      pid = proc.ppid;
    }
    if (!caller) return undefined;
    const { kind } = hostOf(caller, byPid);
    return { pid: caller.pid, startedAt: caller.startedAt, kind, accountId: kind === DESKTOP_KIND ? undefined : callerAccount(o.env, o.accounts) };
  } catch {
    return undefined;
  }
}
