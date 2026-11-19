import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface FakeClaude {
  /** Directory holding an executable `claude`; put it first on PATH. */
  dir: string;
  /** The shim's path (`<dir>/claude`), usable as `claudePath`. */
  claudePath: string;
  cleanup(): void;
}

/**
 * Writes an executable `claude` shim into a temp dir. The shim runs fake-claude-bin with the node that runs
 * the tests, stripping TypeScript types on the fly (`--experimental-strip-types`), so there is no build step.
 */
export function installFakeClaude(): FakeClaude {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(here, "fake-claude-bin.ts");
  const bin = fs.existsSync(ts) ? ts : path.join(here, "fake-claude-bin.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const claudePath = path.join(dir, "claude");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(claudePath, `#!/bin/sh\nexec ${q(process.execPath)} --experimental-strip-types --no-warnings ${q(bin)} "$@"\n`, { mode: 0o755 });
  return { dir, claudePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
