import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { focusTerminalOsascriptArgs, loginOsascriptArgs, openAppOutcome, osascriptOutcome, resumeOsascriptArgs, startOsascriptArgs, terminalTitlesOsascriptArgs } from "./login.js";

test("own config dir: sets CLAUDE_CONFIG_DIR, shell-quoted", () => {
  expect(loginOsascriptArgs("/Users/x/Claude B", "/Users/x/.local/bin/claude")).toEqual([
    "-e",
    `tell application "Terminal" to do script "CLAUDE_CONFIG_DIR='/Users/x/Claude B' '/Users/x/.local/bin/claude' auth login"`,
    "-e",
    'tell application "Terminal" to activate',
  ]);
});

test("~/.claude or empty: CLAUDE_CONFIG_DIR is not set", () => {
  for (const dir of [undefined, path.join(os.homedir(), ".claude")]) {
    expect(loginOsascriptArgs(dir, "claude")[1]).toBe(`tell application "Terminal" to do script "'claude' auth login"`);
  }
});

test("special characters in a path are escaped for both the shell and AppleScript", () => {
  const script = loginOsascriptArgs(`/tmp/a'b"c\\d`, "claude")[1]!;
  expect(script).toBe(`tell application "Terminal" to do script "CLAUDE_CONFIG_DIR='/tmp/a'\\\\''b\\"c\\\\d' 'claude' auth login"`);
});

test("resume: opens Terminal in the run's cwd, runs claude --resume with the account's config dir", () => {
  expect(resumeOsascriptArgs("/Users/x/Claude B", "/Users/x/.local/bin/claude", "/Users/x/dự án", "sess-1")).toEqual([
    "-e",
    `tell application "Terminal" to do script "cd '/Users/x/dự án' && CLAUDE_CONFIG_DIR='/Users/x/Claude B' '/Users/x/.local/bin/claude' --resume 'sess-1'"`,
    "-e",
    'tell application "Terminal" to activate',
  ]);
});

test("resume: ~/.claude or empty does not set CLAUDE_CONFIG_DIR", () => {
  for (const dir of [undefined, "", path.join(os.homedir(), ".claude"), "~/.claude"]) {
    expect(resumeOsascriptArgs(dir, "claude", "/p", "s")[1]).toBe(`tell application "Terminal" to do script "cd '/p' && 'claude' --resume 's'"`);
  }
});

test("resume: a cwd and session id with special characters are escaped for the shell, then for AppleScript", () => {
  const script = resumeOsascriptArgs(undefined, "claude", `/tmp/a'b"c\\d $(x)`, `s'1"; rm -rf ~`)[1]!;
  expect(script).toBe(
    `tell application "Terminal" to do script "cd '/tmp/a'\\\\''b\\"c\\\\d $(x)' && 'claude' --resume 's'\\\\''1\\"; rm -rf ~'"`,
  );
});

// ---- start: a new interactive session on an account

const startCommand = (args: string[]) => args[1]!.replace(/^tell application "Terminal" to do script "/, "").replace(/"$/, "");

test("start: opens Terminal in the cwd, runs claude without a session name; no CLAUDE_CONFIG_DIR without a config dir", () => {
  expect(startOsascriptArgs(undefined, "/usr/local/bin/claude", "/tmp/dự án")).toEqual([
    "-e",
    `tell application "Terminal" to do script "cd '/tmp/dự án' && '/usr/local/bin/claude'"`,
    "-e",
    'tell application "Terminal" to activate',
  ]);
});

test("start: an own config dir sets CLAUDE_CONFIG_DIR (full path) right before claude; ~/.claude does not", () => {
  expect(startCommand(startOsascriptArgs("~/.claude-b", "claude", "/p"))).toBe(
    `cd '/p' && CLAUDE_CONFIG_DIR='${path.join(os.homedir(), ".claude-b")}' 'claude'`,
  );
  expect(startCommand(startOsascriptArgs("~/.claude", "claude", "/p"))).toBe(`cd '/p' && 'claude'`);
});

test("start: really runs the command line, a cwd with ' \" $(x) ` \\ reaches claude intact, claude gets no arguments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-start-"));
  try {
    const cwd = path.join(root, `a'b"c $(touch ${path.join(root, "pwned2").replaceAll("/", ":")}) \`d \\ e`);
    fs.mkdirSync(cwd);
    const stub = path.join(root, "claude-stub");
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\0' "$(pwd -P)" "$@"\n`, { mode: 0o755 });
    // Undo the AppleScript string escaping exactly as AppleScript does, then run what Terminal's shell would run.
    const line = startCommand(startOsascriptArgs(undefined, stub, cwd)).replace(/\\(["\\])/g, "$1");
    const out = execFileSync("/bin/sh", ["-c", line], { encoding: "utf8", cwd: root }).split("\0");
    expect(out).toEqual([fs.realpathSync(cwd), ""]); // the folder, then the empty entry after the last NUL: no argument at all
    expect(fs.readdirSync(root).sort()).toEqual([path.basename(cwd), "claude-stub"].sort()); // $(touch …) never ran
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start: really runs the command line with a CLAUDE_CONFIG_DIR containing ' \" $(x) ` \\ but no line break", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-start-cfg-"));
  try {
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd);
    const stub = path.join(root, "claude-stub");
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\0' "$CLAUDE_CONFIG_DIR" "$@"\n`, { mode: 0o755 });
    const configDir = path.join(root, `cfg 'q' "d" $(touch ${path.join(root, "pwned3")}) \`b\` \\ z · dự án`);
    const line = startCommand(startOsascriptArgs(configDir, stub, cwd)).replace(/\\(["\\])/g, "$1");
    const out = execFileSync("/bin/sh", ["-c", line], { encoding: "utf8" }).split("\0");
    expect(out).toEqual([configDir, ""]);
    expect(fs.existsSync(path.join(root, "pwned3"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- control characters are refused in every Terminal command

const CONTROL_MESSAGE = "The path or name contains control characters, so Terminal cannot open it";
const CONTROLS = ["\n", "\t", "\u0015", "\u0003", "\u007f"];

test("control characters in the cwd, name, config dir, session id or claude path: all three commands refuse", () => {
  for (const c of CONTROLS) {
    expect(() => startOsascriptArgs(undefined, "claude", `/tmp/a${c}b`)).toThrow(CONTROL_MESSAGE);
    expect(() => startOsascriptArgs(`/tmp/cfg${c}`, "claude", "/tmp/a")).toThrow(CONTROL_MESSAGE);
    expect(() => resumeOsascriptArgs(undefined, "claude", `/tmp/a${c}b`, "s")).toThrow(CONTROL_MESSAGE);
    expect(() => resumeOsascriptArgs(undefined, "claude", "/tmp/a", `s${c}`)).toThrow(CONTROL_MESSAGE);
    expect(() => resumeOsascriptArgs(`/tmp/cfg${c}`, "claude", "/tmp/a", "s")).toThrow(CONTROL_MESSAGE);
    expect(() => loginOsascriptArgs(`/tmp/cfg${c}`, "claude")).toThrow(CONTROL_MESSAGE);
    expect(() => loginOsascriptArgs(undefined, `/bin/cl${c}aude`)).toThrow(CONTROL_MESSAGE);
  }
});

test("printable but nasty characters (space, accented letters, ·, ', \", \\, $(), backtick) still produce a command", () => {
  const nasty = `/tmp/Dự án · a'b"c\\d $(x) \`y\``;
  expect(startOsascriptArgs(nasty, "claude", nasty)).toHaveLength(4);
  expect(resumeOsascriptArgs(nasty, "claude", nasty, nasty)).toHaveLength(4);
  expect(loginOsascriptArgs(nasty, "claude")).toHaveLength(4);
});

// ---- exit status of osascript

const OSASCRIPT_MESSAGE =
  "Could not open Terminal. Check that aolangai may control Terminal in System Settings > Privacy & Security > Automation.";

test("osascript exiting with code 0 resolves", async () => {
  await expect(osascriptOutcome({ code: 0, stdout: "ok\n" })).resolves.toBe("ok\n");
});

test("osascript exiting with a non-zero code rejects with the hint about the Automation permission", async () => {
  await expect(osascriptOutcome({ code: 1, stdout: "" })).rejects.toThrow(new Error(OSASCRIPT_MESSAGE));
  await expect(osascriptOutcome({ code: 255, stdout: "" })).rejects.toThrow(OSASCRIPT_MESSAGE);
});

// ---- focusing a Terminal tab

test("focusTerminalOsascriptArgs: the exact script, one line per -e; a window whose tabs cannot be read is skipped", () => {
  expect(focusTerminalOsascriptArgs("ttys015")).toEqual([
    "-e", 'tell application "Terminal"',
    "-e", "repeat with w in windows",
    "-e", "try",
    "-e", "repeat with t in tabs of w",
    "-e", 'if tty of t is "/dev/ttys015" then',
    "-e", "set selected of t to true",
    "-e", "set frontmost of w to true",
    "-e", "activate",
    "-e", 'return "ok"',
    "-e", "end if",
    "-e", "end repeat",
    "-e", "end try",
    "-e", "end repeat",
    "-e", 'return "missing"',
    "-e", "end tell",
  ]);
});

test.each([
  ['ttys015" & (do shell script "x")'],
  ["../x"],
  [""],
  ["TTYS1"],
  ["ttys015\n"],
  ["/dev/ttys015"],
  ["tty"],
])("focusTerminalOsascriptArgs: tty %j is refused, no command is made", (tty) => {
  expect(() => focusTerminalOsascriptArgs(tty)).toThrow();
});

test("open -a: code 0 resolves, a non-zero code rejects with a short message", async () => {
  await expect(openAppOutcome({ code: 0 })).resolves.toBeUndefined();
  await expect(openAppOutcome({ code: 1 })).rejects.toThrow("Could not open this app");
});

test("terminalTitlesOsascriptArgs: exactly the script, one -e per line, and it never reads a window name", () => {
  const args = terminalTitlesOsascriptArgs();
  expect(args).toEqual([
    "-e", 'tell application "Terminal"',
    "-e", 'set out to ""',
    "-e", "repeat with w in windows",
    "-e", "try",
    "-e", "repeat with t in tabs of w",
    "-e", "set out to out & (tty of t) & (character id 9) & (custom title of t) & linefeed",
    "-e", "end repeat",
    "-e", "end try",
    "-e", "end repeat",
    "-e", "return out",
    "-e", "end tell",
  ]);
  for (const line of args) expect(line).not.toContain("name of");
  // Inside the tell block `tab` is Terminal's tab class, not the tab character.
  for (const line of args) expect(line).not.toContain("& tab &");
});
