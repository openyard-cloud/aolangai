// Installs the Claude Code skill and the `aolangai` shim. The observer app and the `aolangai install` command share this.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A file that contains this string was written by aolangai and may be replaced; any other file is never touched. */
export const MARKER = "aolangai-managed";

export interface InstallPaths {
  skillDir: string;
  binDir: string;
}
export type FileStatus = "missing" | "current" | "outdated" | "foreign";
export interface InstallStatus {
  skill: FileStatus;
  shim: FileStatus;
}

/** `~/.claude/skills/aolangai` and `~/.local/bin`. */
export function defaultInstallPaths(): InstallPaths {
  const home = os.homedir();
  return { skillDir: path.join(home, ".claude", "skills", "aolangai"), binDir: path.join(home, ".local", "bin") };
}

const SKILL_NAME = "SKILL.md";
const SHIM_NAME = "aolangai";

function fileStatus(file: string, expected: string): FileStatus {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "foreign"; // a directory or an unreadable file is not ours
  }
  if (text === expected) return "current";
  return text.includes(MARKER) ? "outdated" : "foreign";
}

/** Temp file in the same directory, then rename: a crash cannot leave a half-written file at the target. */
function writeAtomic(file: string, text: string, mode: number): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode); // the umask may have narrowed the mode given to writeFileSync
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const foreignError = (file: string) => new Error(`This file was not created by aolangai, not overwriting: ${file}`);

/** State of `<skillDir>/SKILL.md` against `skillText`. */
export function skillStatus(skillDir: string, skillText: string): FileStatus {
  return fileStatus(path.join(skillDir, SKILL_NAME), skillText);
}

/** Writes <skillDir>/SKILL.md unless it is current. Throws if the file there was not written by aolangai. */
export function installSkill(skillDir: string, skillText: string): void {
  const file = path.join(skillDir, SKILL_NAME);
  const s = fileStatus(file, skillText);
  if (s === "foreign") throw foreignError(file);
  if (s !== "current") writeAtomic(file, skillText, 0o644);
}

/** State of `<binDir>/aolangai` against `shim`. */
export function shimStatus(binDir: string, shim: string): FileStatus {
  return fileStatus(path.join(binDir, SHIM_NAME), shim);
}

/** Writes <binDir>/aolangai (executable) unless it is current, and repairs the mode of a current one. Throws if the file there was not written by aolangai. */
export function installShim(binDir: string, shim: string): void {
  const file = path.join(binDir, SHIM_NAME);
  const s = fileStatus(file, shim);
  if (s === "foreign") throw foreignError(file);
  if (s !== "current") writeAtomic(file, shim, 0o755);
  else fs.chmodSync(file, 0o755);
}

export function installStatus(p: InstallPaths, skillText: string, shim: string): InstallStatus {
  return { skill: skillStatus(p.skillDir, skillText), shim: shimStatus(p.binDir, shim) };
}

/** Writes both files. Throws, before writing anything, if either exists without MARKER. */
export function install(p: InstallPaths, skillText: string, shim: string): void {
  const s = installStatus(p, skillText, shim);
  if (s.skill === "foreign") throw foreignError(path.join(p.skillDir, SKILL_NAME));
  if (s.shim === "foreign") throw foreignError(path.join(p.binDir, SHIM_NAME));
  installSkill(p.skillDir, skillText);
  installShim(p.binDir, shim);
}

/** Single-quotes a string for /bin/sh: `'` becomes `'\''`. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** What runs the CLI: a node binary, or an Electron binary that must be told to act as node. */
export interface CliRuntime {
  execPath: string;
  electron: boolean;
}

/** The `aolangai` command file. The node form is byte-for-byte what earlier versions wrote, so an installed one stays current. */
export function shimText(runtime: CliRuntime, cliEntry: string): string {
  const env = runtime.electron ? "ELECTRON_RUN_AS_NODE=1 " : "";
  return `#!/bin/sh\n# ${MARKER}\n${env}exec ${shQuote(runtime.execPath)} ${shQuote(cliEntry)} "$@"\n`;
}
