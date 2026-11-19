import { applyClaudeConfigDir } from "@aolangai/core";
import { isTtyName } from "../shared/api.js";

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const appleScriptString = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** `CLAUDE_CONFIG_DIR='…' ` for a custom dir; ~/.claude leaves the variable unset (setting it, even to ~/.claude, makes Claude Code look for a different login). */
function configEnvPrefix(configDir: string | undefined): string {
  const env = applyClaudeConfigDir({}, configDir);
  return env.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${shellQuote(env.CLAUDE_CONFIG_DIR)} ` : "";
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Runs one shell command line in a new Terminal window and brings Terminal to the front.
 * Terminal types the line into the shell's line editor, so a control character (^U, ^C, tab, newline) would discard or
 * alter the command even inside single quotes: refuse such a line here, the one place every Terminal command passes.
 */
const terminalArgs = (command: string): string[] => {
  if (CONTROL_CHARS.test(command)) throw new Error("The path or name contains control characters, so Terminal cannot open it");
  return [
    "-e",
    `tell application "Terminal" to do script "${appleScriptString(command)}"`,
    "-e",
    'tell application "Terminal" to activate',
  ];
};

/** Resolves with osascript's stdout when it exited 0; otherwise rejects (macOS denied control of Terminal, or the prompt timed out). */
export async function osascriptOutcome(result: { code: number; stdout: string }): Promise<string> {
  if (result.code !== 0) {
    throw new Error("Could not open Terminal. Check that aolangai may control Terminal in System Settings > Privacy & Security > Automation.");
  }
  return result.stdout;
}

/** Resolves when `open -a` exited 0; otherwise rejects. */
export async function openAppOutcome(result: { code: number }): Promise<void> {
  if (result.code !== 0) throw new Error("Could not open this app");
}

/**
 * osascript arguments that select the Terminal tab whose tty is `tty` and bring its window to the front; the script
 * prints "ok", or "missing" when no tab has that tty. A window whose tabs cannot be read (not a terminal window) is skipped. Only a name like "ttys015" is accepted, so nothing the caller
 * did not validate can reach AppleScript; the script types nothing into any shell.
 */
export function focusTerminalOsascriptArgs(tty: string): string[] {
  if (!isTtyName(tty)) throw new Error("Invalid tty name");
  const lines = [
    'tell application "Terminal"',
    "repeat with w in windows",
    "try",
    "repeat with t in tabs of w",
    `if tty of t is "${appleScriptString(`/dev/${tty}`)}" then`,
    "set selected of t to true",
    "set frontmost of w to true",
    "activate",
    'return "ok"',
    "end if",
    "end repeat",
    "end try",
    "end repeat",
    'return "missing"',
    "end tell",
  ];
  return lines.flatMap((line) => ["-e", line]);
}

/**
 * osascript arguments that print one line per Terminal tab: "<tty>\t<custom title>". A window that cannot be read is skipped.
 * Only the tty and the custom title of a tab are read, never a window name (which can hold the environment of the process in the tab).
 */
export function terminalTitlesOsascriptArgs(): string[] {
  const lines = [
    'tell application "Terminal"',
    'set out to ""',
    "repeat with w in windows",
    "try",
    "repeat with t in tabs of w",
    // Not `tab`: inside the tell block that word is Terminal's tab class, not the tab character.
    "set out to out & (tty of t) & (character id 9) & (custom title of t) & linefeed",
    "end repeat",
    "end try",
    "end repeat",
    "return out",
    "end tell",
  ];
  return lines.flatMap((line) => ["-e", line]);
}

/**
 * osascript arguments that open Terminal on `claude auth login`. The login runs in Claude Code's own flow;
 * the app never sees the token.
 */
export function loginOsascriptArgs(configDir: string | undefined, claudePath: string): string[] {
  return terminalArgs(`${configEnvPrefix(configDir)}${shellQuote(claudePath)} auth login`);
}

/** osascript arguments that open Terminal in the run's folder and resume its session with the account's config dir. */
export function resumeOsascriptArgs(configDir: string | undefined, claudePath: string, cwd: string, sessionId: string): string[] {
  return terminalArgs(`cd ${shellQuote(cwd)} && ${configEnvPrefix(configDir)}${shellQuote(claudePath)} --resume ${shellQuote(sessionId)}`);
}

/**
 * osascript arguments that open Terminal in `cwd` and start an interactive claude on the account. No session name is
 * passed: a fixed name stops Claude Code from titling the tab after the work, and the app shows that title per session.
 */
export function startOsascriptArgs(configDir: string | undefined, claudePath: string, cwd: string): string[] {
  return terminalArgs(`cd ${shellQuote(cwd)} && ${configEnvPrefix(configDir)}${shellQuote(claudePath)}`);
}
