import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultInstallPaths, install, installStatus, shimText, type CliRuntime, type InstallPaths } from "@aolangai/core";
import type { Command } from "../args.js";
import type { Io } from "../io.js";
import { PREFIX } from "../output.js";

// Both src/commands/ and dist/commands/ sit two levels below the package root, so these resolve from either.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_FILE = path.join(PACKAGE_ROOT, "skill", "SKILL.md");
const BUILT_ENTRY = path.join(PACKAGE_ROOT, "dist", "index.js");

/** The CLI file the shim runs: `AOLANGAI_CLI_ENTRY` (tests running from source), else this package's built entry. */
function cliEntry(env: NodeJS.ProcessEnv): string {
  const entry = env.AOLANGAI_CLI_ENTRY ? path.resolve(env.AOLANGAI_CLI_ENTRY) : BUILT_ENTRY;
  if (!fs.existsSync(entry)) throw new Error(`Missing ${entry}. Run npm run build, then install again.`);
  return entry;
}

/** This process as the runtime of the shim: `electron` when it is an Electron binary running as node. */
export function currentRuntime(versions: NodeJS.ProcessVersions = process.versions, execPath: string = process.execPath): CliRuntime {
  return { execPath, electron: Boolean(versions.electron) };
}

export function installCommand(cmd: Extract<Command, { cmd: "install" }>, io: Io, env: NodeJS.ProcessEnv, runtime: CliRuntime = currentRuntime()): number {
  const defaults = defaultInstallPaths();
  const paths: InstallPaths = {
    skillDir: cmd.skillDir !== undefined ? path.resolve(cmd.skillDir) : defaults.skillDir,
    binDir: cmd.binDir !== undefined ? path.resolve(cmd.binDir) : defaults.binDir,
  };
  const skillFile = path.join(paths.skillDir, "SKILL.md");
  const shimFile = path.join(paths.binDir, "aolangai");
  try {
    const skill = fs.readFileSync(SKILL_FILE, "utf8");
    const shim = shimText(runtime, cliEntry(env));
    const before = installStatus(paths, skill, shim);
    if (cmd.check) {
      io.out(`skill: ${before.skill}\ncommand: ${before.shim}\n`);
      return 0;
    }
    if (before.skill === "foreign" || before.shim === "foreign") {
      io.err(`${PREFIX}This file was not created by aolangai, not overwriting: ${before.skill === "foreign" ? skillFile : shimFile}\n`);
      return 2;
    }
    try {
      install(paths, skill, shim);
    } catch (e) {
      io.err(`${PREFIX}Could not write: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    io.err(`${PREFIX}${before.skill === "current" ? "Already up to date" : "Installed skill"}: ${skillFile}\n`);
    io.err(`${PREFIX}${before.shim === "current" ? "Already up to date" : "Installed command"}: ${shimFile}\n`);
    return 0;
  } catch (e) {
    // the skill file or the CLI entry is missing: nothing was written
    io.err(`${PREFIX}${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
