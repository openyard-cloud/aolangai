import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

/** Binary files by extension; any other file with a NUL byte in its first kilobytes counts as binary too. */
const BINARY = new Set([".png", ".ico", ".icns", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".woff", ".woff2", ".pdf", ".zip"]);
const SNIFF_BYTES = 8192;

function isBinary(file: string, bytes: Uint8Array): boolean {
  return BINARY.has(extname(file).toLowerCase()) || bytes.subarray(0, SNIFF_BYTES).includes(0);
}

/** Tests, the lockfile and the root README are the only text that may contain Vietnamese. */
function skipped(file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return name.endsWith(".test.ts") || name.endsWith(".test.tsx") || name === "package-lock.json" || file === "README.md";
}

/** A letter only Vietnamese has (ă â đ ê ô ơ ư), or any letter with a Vietnamese tone mark (U+1EA0 to U+1EF9). */
const VIETNAMESE = /[ăâđêôơưĂÂĐÊÔƠƯẠ-ỹ]/u;

test("no tracked source file has Vietnamese text", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f !== "" && !skipped(f));
  // a broken file list must not pass for a clean tree
  expect(files.length).toBeGreaterThan(0);
  expect(files).toContain("packages/cli/src/output.ts");
  const offending: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(join(root, file));
    if (isBinary(file, bytes)) continue;
    bytes
      .toString("utf8")
      .split("\n")
      .forEach((line, i) => {
        if (VIETNAMESE.test(line)) offending.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  expect(offending, `Vietnamese text found (translate it, or move it into a test):\n${offending.join("\n")}`).toEqual([]);
});

test("the filters: only the root README is skipped; binary by extension or by a NUL byte", () => {
  expect(skipped("README.md")).toBe(true);
  expect(skipped("docs/README.md")).toBe(false);
  expect(skipped("apps/desktop/README.md")).toBe(false);
  expect(skipped("a/b.test.ts")).toBe(true);
  expect(skipped("package-lock.json")).toBe(true);
  expect(skipped("a/b.ts")).toBe(false);
  const text = new TextEncoder().encode("plain text");
  expect(isBinary("a/b.webp", text)).toBe(true);
  expect(isBinary("a/b.JPEG", text)).toBe(true);
  expect(isBinary("a/b.txt", text)).toBe(false);
  expect(isBinary("a/b.dat", new Uint8Array([0x89, 0x50, 0x00, 0x47]))).toBe(true);
  // a NUL far past the sniffed head does not count
  const late = new Uint8Array(SNIFF_BYTES + 10).fill(0x61);
  late[SNIFF_BYTES + 5] = 0;
  expect(isBinary("a/b.txt", late)).toBe(false);
});
