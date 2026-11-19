import fs from "node:fs";
import path from "node:path";

/**
 * Absolute, normalized path with symlinks resolved on the longest existing prefix
 * (so `/tmp/x/new-file` and `/private/tmp/x/new-file` compare equal on macOS).
 */
export function canonicalPath(p: string, base = process.cwd()): string {
  let head = path.resolve(base, p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(base, p);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** True when `child` is `dir` itself or lies inside it, after canonicalization. */
export function isInside(dir: string, child: string): boolean {
  const d = canonicalPath(dir);
  const c = canonicalPath(child, d);
  return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}
