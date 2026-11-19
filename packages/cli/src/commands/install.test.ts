import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MARKER } from "@aolangai/core";
import { main } from "../main.js";
import { currentRuntime, installCommand } from "./install.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = path.join(here, "../../skill/SKILL.md");

let root: string;
let skillDir: string;
let binDir: string;
let env: NodeJS.ProcessEnv;
let out: string;
let err: string;
const io = { out: (t: string) => void (out += t), err: (t: string) => void (err += t) };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-install-")));
  skillDir = path.join(root, "skills", "aolangai");
  binDir = path.join(root, "bin");
  const entry = path.join(root, "entry.js");
  fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  // AOLANGAI_DB points into the temp dir: install must not need it, and must never open the real one
  env = { ...process.env, AOLANGAI_CLI_ENTRY: entry, AOLANGAI_DB: path.join(root, "nope", "a.db") };
  out = "";
  err = "";
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const dirs = () => ["--skill-dir", skillDir, "--bin-dir", binDir];

describe("aolangai install", () => {
  it("installs the skill and the shim, reports on stderr, exit 0", async () => {
    expect(await main(["install", ...dirs()], env, io)).toBe(0);
    expect(out).toBe("");
    expect(err).toBe(`[aolangai] Installed skill: ${path.join(skillDir, "SKILL.md")}\n[aolangai] Installed command: ${path.join(binDir, "aolangai")}\n`);
    expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8")).toBe(fs.readFileSync(SKILL_FILE, "utf8"));
    const shim = fs.readFileSync(path.join(binDir, "aolangai"), "utf8");
    expect(shim).toBe(`#!/bin/sh\n# ${MARKER}\nexec '${process.execPath}' '${env.AOLANGAI_CLI_ENTRY}' "$@"\n`);
    expect(fs.statSync(path.join(binDir, "aolangai")).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(root, "nope"))).toBe(false);
  });

  it("the installed shim runs the CLI entry with the arguments given", async () => {
    await main(["install", ...dirs()], env, io);
    const r = spawnSync(path.join(binDir, "aolangai"), ["status", "--json"], { encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual(["status", "--json"]);
  });

  it("a second install says both are already current", async () => {
    await main(["install", ...dirs()], env, io);
    err = "";
    expect(await main(["install", ...dirs()], env, io)).toBe(0);
    expect(err).toBe(`[aolangai] Already up to date: ${path.join(skillDir, "SKILL.md")}\n[aolangai] Already up to date: ${path.join(binDir, "aolangai")}\n`);
  });

  it("updates an outdated file that has the marker", async () => {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `<!-- ${MARKER} -->\nold\n`);
    expect(await main(["install", ...dirs()], env, io)).toBe(0);
    expect(err).toContain(`Installed skill: ${path.join(skillDir, "SKILL.md")}`);
    expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8")).toBe(fs.readFileSync(SKILL_FILE, "utf8"));
  });

  it("refuses a foreign file: error on stderr, exit 2, nothing written", async () => {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "aolangai"), "#!/bin/sh\necho not ours\n");
    expect(await main(["install", ...dirs()], env, io)).toBe(2);
    expect(out).toBe("");
    expect(err).toBe(`[aolangai] This file was not created by aolangai, not overwriting: ${path.join(binDir, "aolangai")}\n`);
    expect(fs.readFileSync(path.join(binDir, "aolangai"), "utf8")).toBe("#!/bin/sh\necho not ours\n");
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it("refuses when the CLI entry does not exist, writing nothing", async () => {
    const missing = path.join(root, "missing.js");
    expect(await main(["install", ...dirs()], { ...env, AOLANGAI_CLI_ENTRY: missing }, io)).toBe(2);
    expect(err).toContain(missing);
    expect(fs.existsSync(skillDir)).toBe(false);
    expect(fs.existsSync(binDir)).toBe(false);
  });
});

describe("currentRuntime", () => {
  it("is electron exactly when process.versions.electron has a value", () => {
    expect(currentRuntime({ ...process.versions, electron: "45.0.0" }, "/a/b")).toEqual({ execPath: "/a/b", electron: true });
    expect(currentRuntime({ ...process.versions }, "/a/b")).toEqual({ execPath: "/a/b", electron: false });
    expect(currentRuntime({ ...process.versions, electron: "" }, "/a/b")).toEqual({ execPath: "/a/b", electron: false });
  });

  it("defaults to this process", () => {
    expect(currentRuntime()).toEqual({ execPath: process.execPath, electron: Boolean(process.versions.electron) });
  });
});

describe("aolangai install with an electron runtime", () => {
  it("writes the electron form of the shim", () => {
    const execPath = "/Applications/aolangai.app/Contents/MacOS/aolangai";
    expect(installCommand({ cmd: "install", check: false, skillDir, binDir }, io, env, { execPath, electron: true })).toBe(0);
    expect(fs.readFileSync(path.join(binDir, "aolangai"), "utf8")).toBe(
      `#!/bin/sh\n# ${MARKER}\nELECTRON_RUN_AS_NODE=1 exec '${execPath}' '${env.AOLANGAI_CLI_ENTRY}' "$@"\n`,
    );
  });
});

describe("aolangai install --check", () => {
  it("prints the statuses on stdout, exit 0, writes nothing", async () => {
    expect(await main(["install", "--check", ...dirs()], env, io)).toBe(0);
    expect(out).toBe("skill: missing\ncommand: missing\n");
    expect(err).toBe("");
    expect(fs.existsSync(skillDir)).toBe(false);
    expect(fs.existsSync(binDir)).toBe(false);
  });

  it("says current after an install, outdated and foreign as they are", async () => {
    await main(["install", ...dirs()], env, io);
    out = "";
    await main(["install", "--check", ...dirs()], env, io);
    expect(out).toBe("skill: current\ncommand: current\n");

    fs.appendFileSync(path.join(skillDir, "SKILL.md"), "extra\n");
    fs.writeFileSync(path.join(binDir, "aolangai"), "#!/bin/sh\n");
    out = "";
    expect(await main(["install", "--check", ...dirs()], env, io)).toBe(0);
    expect(out).toBe("skill: outdated\ncommand: foreign\n");
  });
});

describe("SKILL.md", () => {
  const text = fs.readFileSync(SKILL_FILE, "utf8");

  it("is a Claude Code skill: frontmatter first, then the marker", () => {
    const m = /^---\nname: aolangai\ndescription: (.+)\n---\n<!-- aolangai-managed -->\n/.exec(text);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/subagent/i);
    expect(m![1]).toMatch(/account/i);
  });

  it("triggers on a bare request to delegate to a subagent, on moving work to another account, on spreading tokens, and on a large independent piece of work", () => {
    const description = /^---\nname: aolangai\ndescription: (.+)\n---/.exec(text)![1]!;
    expect(description).toMatch(/delegate work to a subagent[,.]/i);
    expect(description).toMatch(/another account/i);
    expect(description).toMatch(/secondary account/i);
    expect(description).toMatch(/spread tokens across several accounts/i);
    expect(description).toMatch(/large, independent piece of work/i);
    // a YAML plain scalar: no ": " that would end it early
    expect(description).not.toContain(": ");
  });

  it("names the command by its absolute path in every example", () => {
    expect(text).toContain("~/.local/bin/aolangai run");
    expect(text).toContain("~/.local/bin/aolangai status");
    expect(text).toContain("~/.local/bin/aolangai stop");
    // no bare `aolangai run` / `aolangai status` that would depend on PATH
    expect(text.replace(/~\/\.local\/bin\/aolangai/g, "")).not.toMatch(/(^|[\s`"'(])aolangai (run|status|stop)\b/m);
  });

  it("explains each exit code the CLI uses", () => {
    for (const code of ["0", "1", "2", "3", "130"]) expect(text).toContain(`\n- \`${code}\`: `);
  });

  it("covers the points a delegating session needs", () => {
    for (const s of ["--cwd", "--label", "--read-only", "--new", "--account", "run -", "Permission denied", "stdout", "background"]) expect(text).toContain(s);
  });

  it("tells a worker (AOLANGAI_RUN_ID set) to do its own task, near the top", () => {
    const worker = "If the environment variable AOLANGAI_RUN_ID is set, you are the worker: do the task you were given yourself and do not call aolangai.";
    expect(text).toContain(worker);
    expect(text.indexOf(worker)).toBeLessThan(text.indexOf("## Delegate"));
  });

  it("keeps the timeout (exit 1, after the run started) apart from the refusals (exit 2)", () => {
    const rails = text.split("\n").filter((l) => l.includes("30 minutes"));
    expect(rails.length).toBeGreaterThan(0);
    for (const l of rails) expect(l).not.toContain("exit code 2");
    expect(text).toMatch(/30 minutes[^\n]*exit code 1/);
  });

  it("after a refusal: holds back only when the user asked to delegate, does the work when delegating was its own idea; says what to check after exit 1", () => {
    expect(text).toMatch(/- `2`: [^\n]*If the user asked you to delegate, tell them why it was refused and do not do the work yourself unless they say so\./);
    expect(text).toMatch(/- `2`: [^\n]*If delegating was your own idea, do the work yourself\./);
    // the skill speaks to "you" only
    expect(text).not.toMatch(/main session/i);
    expect(text).toMatch(/- `1`: [^\n]*git status/);
    expect(text).toMatch(/- `1`: [^\n]*more than once[^\n]*user/);
  });

  it("says the guard numbers are defaults the user can change in Settings → Limits", () => {
    expect(text).toMatch(/By default at most 4 runs at once and 30 runs in 60 minutes[^\n]*\*\*Settings → Limits\*\*/);
    expect(text).toMatch(/By default each run lasts at most 30 minutes/);
  });

  it("sends a prompt with quotes, $ or backticks through stdin", () => {
    expect(text).toMatch(/whenever the prompt contains quotes, `\$` or backticks, use `run -`/);
  });

  it("says what to do when the command is missing: tell the user and do the work yourself", () => {
    expect(text).toMatch(/If `~\/\.local\/bin\/aolangai` does not exist[^\n]*exit code 127[^\n]*tell the user[^\n]*do the work yourself\./);
  });

  it("stays short", () => {
    expect(text.split("\n").length).toBeLessThanOrEqual(60);
  });
});
