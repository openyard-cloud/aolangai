import { execFile } from "node:child_process";
import path from "node:path";

/**
 * An app opened from Finder or at login gets the short PATH of a GUI app (/usr/bin:/bin:/usr/sbin:/sbin), not the one
 * your terminal has. A `claude` or `node` installed under nvm, fnm, volta or asdf is only on the terminal's PATH. The
 * app asks your login shell for its PATH once at startup and puts it in front of its own, so finding `claude`, the
 * workers it starts (and their MCP servers and hooks), and the Terminal buttons all see the same commands you do.
 */

/** Wraps the PATH in the shell's output, which can also hold whatever the shell's startup files print. */
export const PATH_MARK = "__AOLANGAI_PATH__";
/** A shell whose startup files hang or wait for input is given up on after this long. */
export const SHELL_PATH_TIMEOUT_MS = 5000;

/** Arguments for an interactive login shell that prints its PATH between two marks. */
export function shellPathArgs(): string[] {
  return ["-ilc", `printf '%s%s%s' '${PATH_MARK}' "$PATH" '${PATH_MARK}'`];
}

/** The PATH between the last two marks, or undefined when there is none or it holds no absolute folder. */
export function parsePathOutput(out: string): string | undefined {
  const end = out.lastIndexOf(PATH_MARK);
  const start = end < 0 ? -1 : out.lastIndexOf(PATH_MARK, end - 1);
  if (start < 0) return undefined;
  const value = out.slice(start + PATH_MARK.length, end).trim();
  return value.split(path.delimiter).some((d) => d.startsWith("/")) ? value : undefined;
}

/** The shell's folders first, then the app's own ones it lacks; empty and relative entries are dropped. */
export function mergePath(shellPath: string | undefined, current: string | undefined): string {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const part of [shellPath, current]) {
    for (const d of (part ?? "").split(path.delimiter)) {
      if (!d.startsWith("/") || seen.has(d)) continue;
      seen.add(d);
      dirs.push(d);
    }
  }
  return dirs.join(path.delimiter);
}

/** Runs `shell` with `args`; resolves its stdout, or undefined on any error, a non-zero exit or the timeout. */
export type RunShell = (shell: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string | undefined>;

const realRunShell: RunShell = (shell, args, env, timeoutMs) =>
  new Promise((resolve) => {
    const child = execFile(shell, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (err, stdout) =>
      resolve(err ? undefined : stdout),
    );
    child.stdin?.end();
  });

/** The login shell to ask: $SHELL when it is an absolute path, otherwise zsh, the macOS default. */
export function loginShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL?.trim();
  return shell && shell.startsWith("/") ? shell : "/bin/zsh";
}

/**
 * Sets `env.PATH` to the login shell's PATH followed by the folders of the current one it lacks. Leaves `env` as it is
 * when the shell cannot be asked. Resolves whether the PATH changed. Never rejects.
 */
export async function applyShellPath(env: NodeJS.ProcessEnv, run: RunShell = realRunShell): Promise<boolean> {
  try {
    // TERM=dumb keeps prompt themes and terminal setup in the startup files from drawing anything.
    const out = await run(loginShell(env), shellPathArgs(), { ...env, TERM: "dumb" }, SHELL_PATH_TIMEOUT_MS);
    const shellPath = out === undefined ? undefined : parsePathOutput(out);
    if (!shellPath) return false;
    const merged = mergePath(shellPath, env.PATH);
    if (merged === env.PATH) return false;
    env.PATH = merged;
    return true;
  } catch {
    return false;
  }
}
