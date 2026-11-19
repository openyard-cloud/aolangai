import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the command writes. Tests of the commands replace it. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const stdio: Io = {
  out: (t) => void process.stdout.write(t),
  err: (t) => void process.stderr.write(t),
};

/** `AOLANGAI_DB`, else the app's file under Application Support. */
export function dbPath(env: NodeJS.ProcessEnv): string {
  const set = env.AOLANGAI_DB;
  if (set) return path.resolve(set);
  return path.join(os.homedir(), "Library", "Application Support", "aolangai", "aolangai.db");
}

export function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
