import path from "node:path";
import type { CliRuntime } from "@aolangai/core";

/**
 * What runs the `aolangai` command for the installed shim and for retries. The packaged app always uses its own binary
 * as node, so it needs no Node on the machine. In development the app's Electron binary is the dev one, so a node found
 * on the machine is preferred and Electron-as-node is only the fallback.
 */
export function cliRuntime(o: { packaged: boolean; execPath: string; node: string | null }): CliRuntime {
  if (!o.packaged && o.node) return { execPath: o.node, electron: false };
  return { execPath: o.execPath, electron: true };
}

/**
 * Where the `aolangai` command and the skill text live. The packaged app ships the CLI package as real files in
 * `Resources/cli` (same shape as the package, since `install` finds the skill relative to its own file); in development
 * it is the `@aolangai/cli` workspace package at `devRoot`.
 */
export function cliPaths(o: { packaged: boolean; resourcesPath: string; devRoot: string }): { entry: string; skillFile: string } {
  const root = o.packaged ? path.join(o.resourcesPath, "cli") : o.devRoot;
  return { entry: path.join(root, "dist", "index.js"), skillFile: path.join(root, "skill", "SKILL.md") };
}
