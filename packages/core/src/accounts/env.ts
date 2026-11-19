import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Account } from "../types.js";

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), ".claude");

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Sets or removes CLAUDE_CONFIG_DIR. Setting it, even to ~/.claude, makes Claude Code read a different
 * Keychain entry, so the default directory means "leave the variable unset".
 */
export function applyClaudeConfigDir(env: Record<string, string>, configDir: string | undefined): Record<string, string> {
  const dir = configDir ? path.resolve(expandHome(configDir)) : "";
  if (!dir || dir === DEFAULT_CLAUDE_DIR) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

/** Set on every worker; a dispatch that sees it is nested inside a run and is refused. */
export const NEST_ENV = "AOLANGAI_RUN_ID";

/**
 * Never passed on: a `claude` that is itself an Electron app (or starts one) would run as plain node instead of
 * opening, and the CLI that runs on the app's runtime has this set for itself, not for its children.
 */
const ELECTRON_ENV = "ELECTRON_RUN_AS_NODE";

/**
 * The environment of every `claude` process aolangai starts for an account (a worker, a quota ask, an auth check): a
 * clean, standalone Claude Code under that account. `base` without any variable named `CLAUDE_*` or `ANTHROPIC_*`
 * (session identity, login tokens, provider switches, URLs, and the identity and behaviour settings a host such as the
 * Claude desktop app injects; a deny-list cannot keep up with a host that adds names), without `CLAUDECODE`, without
 * aolangai's own run marker, without ELECTRON_RUN_AS_NODE, and with CLAUDE_CONFIG_DIR set for the account (unset for the default ~/.claude).
 * Everything else (PATH, HOME, locale, proxy and certificate variables) is kept.
 */
export function childEnv(base: NodeJS.ProcessEnv, account: Pick<Account, "configDir">): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("CLAUDE_") || k.startsWith("ANTHROPIC_") || k === "CLAUDECODE" || k === NEST_ENV || k === ELECTRON_ENV) continue;
    env[k] = v;
  }
  return applyClaudeConfigDir(env, account.configDir);
}

/** Where `findExecutable` looks after PATH, in order. */
export const CLAUDE_SEARCH_DIRS = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
/** What the command, the app and the connection check say when `claude` is not found; names CLAUDE_SEARCH_DIRS (a test keeps them in step). */
export const CLAUDE_NOT_FOUND = "The claude command was not found on the PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin";

/** Finds an executable on PATH plus the usual macOS install dirs (GUI apps start with a short PATH). */
export function findExecutable(cmd: string): string | null {
  if (cmd.includes("/")) return isExecutable(cmd) ? cmd : null;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...CLAUDE_SEARCH_DIRS];
  for (const d of dirs) {
    const p = path.join(d, cmd);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
