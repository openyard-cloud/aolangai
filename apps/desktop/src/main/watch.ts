import type { Db } from "@aolangai/core";

/**
 * Calls `onChange` when another connection (the CLI, in another process) committed to the store since the last look:
 * `PRAGMA data_version` changes only for commits made by *other* connections, never for this one's own.
 * Returns the function that stops watching.
 */
export function watchStore(db: Db, intervalMs: number, onChange: () => void): () => void {
  const read = () => (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  let last: number | undefined;
  try {
    last = read();
  } catch {
    // reported by the first tick that can read
  }
  const timer = setInterval(() => {
    try {
      const v = read();
      if (last !== undefined && v !== last) onChange();
      last = v;
    } catch {
      // the store is closing or briefly unreadable: look again next tick
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
