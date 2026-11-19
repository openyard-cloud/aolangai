import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Keeps the personal details that can be found mechanically out of the tracked tree: a home-directory path, an
// e-mail address, a machine-specific id. Real account names and folder names cannot be described by a shape; those
// are a matter of review. Failures list file:line and the kind of problem, never the matched text.

const root = dirname(fileURLToPath(import.meta.url));

/** Binary files are decided by extension. */
const BINARY = new Set([".png", ".ico", ".icns", ".jpg", ".gif", ".woff", ".woff2", ".pdf", ".zip"]);

function skipped(file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return name === "package-lock.json" || BINARY.has(extname(file).toLowerCase());
}

function isTest(file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return /\.test\.[cm]?[jt]sx?$/.test(name);
}

/** Users that stand for nobody in particular. */
const PLACEHOLDER_USERS = new Set(["x", "me", "you", "user", "someone", "a", "b", "shared"]);

/** Requires a dotted domain with a letters-only top level, so `name@scope/package` and `pkg@1.2.3` do not match. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const HOME_PATH = /\/Users\/([A-Za-z0-9._-]+)/g;

/** The kinds of problem found on one line. */
function problemsInLine(line: string, inTestFile: boolean): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(HOME_PATH)) {
    if (!PLACEHOLDER_USERS.has(m[1]!.toLowerCase())) found.push("home-directory path with a real-looking user name");
  }
  for (const m of line.matchAll(EMAIL)) {
    const address = m[0].toLowerCase();
    if (address !== "noreply@anthropic.com" && !address.endsWith("@example.com")) found.push("e-mail address");
  }
  if (!inTestFile && UUID.test(line)) found.push("UUID-shaped id outside a test file");
  return found;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f !== "" && !skipped(f));
}

test("no tracked file has a home-directory path, an e-mail address or a machine id of a real person", () => {
  const files = trackedFiles();
  // a vacuous pass (git failed, wrong root) would scan nothing
  expect(files.length).toBeGreaterThan(50);
  expect(files).toContain("package.json");
  expect(files).toContain("language.test.ts");
  const offending: string[] = [];
  for (const file of files) {
    const inTestFile = isTest(file);
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const kind of new Set(problemsInLine(line, inTestFile))) offending.push(`${file}:${i + 1}: ${kind}`);
      });
  }
  expect(offending, `Personal details found (replace them with invented values):\n${offending.join("\n")}`).toEqual([]);
});

test("the matcher: placeholders pass, real-looking values are reported", () => {
  // the samples are assembled at run time so this file does not contain them itself
  const home = "/Users/";
  const at = "@";
  expect(problemsInLine(`${home}x/Projects/app and ${home}me and ${home}Shared/y`, false)).toEqual([]);
  expect(problemsInLine(`cwd ${home}${"bob"}/code`, false)).toEqual(["home-directory path with a real-looking user name"]);
  expect(problemsInLine(`noreply${at}anthropic.com, a${at}example.com, "@aolangai/core", "name${at}scope/pkg", "react${at}18.3.1"`, false)).toEqual([]);
  expect(problemsInLine(`mail ${"bob"}${at}${"corp"}.io`, false)).toEqual(["e-mail address"]);
  const id = ["11111111", "1111", "2222", "3333", "444444444444"].join("-");
  expect(problemsInLine(`session ${id}`, false)).toEqual(["UUID-shaped id outside a test file"]);
  expect(problemsInLine(`session ${id}`, true)).toEqual([]);
  expect(isTest("a/b.test.ts")).toBe(true);
  expect(isTest("a/b.ts")).toBe(false);
});
