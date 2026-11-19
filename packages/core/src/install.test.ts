import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MARKER, defaultInstallPaths, install, installShim, installSkill, installStatus, shimStatus, shimText, skillStatus, type InstallPaths } from "./install.js";

let root: string;
let p: InstallPaths;
const SKILL = `---\nname: aolangai\ndescription: x\n---\n<!-- ${MARKER} -->\ncontent\n`;
const node = (execPath: string) => ({ execPath, electron: false });
const SHIM = shimText(node("/usr/bin/node"), "/opt/aolangai/dist/index.js");
const skillFile = () => path.join(p.skillDir, "SKILL.md");
const shimFile = () => path.join(p.binDir, "aolangai");

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-")));
  p = { skillDir: path.join(root, "claude", "skills", "aolangai"), binDir: path.join(root, "local", "bin") };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("defaultInstallPaths", () => {
  it("points into the home directory", () => {
    expect(defaultInstallPaths()).toEqual({
      skillDir: path.join(os.homedir(), ".claude", "skills", "aolangai"),
      binDir: path.join(os.homedir(), ".local", "bin"),
    });
  });
});

describe("shimText", () => {
  it("has the shebang, the marker and a quoted exec line", () => {
    expect(shimText(node("/usr/bin/node"), "/x/index.js")).toBe(`#!/bin/sh\n# ${MARKER}\nexec '/usr/bin/node' '/x/index.js' "$@"\n`);
  });

  it("the electron form sets ELECTRON_RUN_AS_NODE in front of the exec", () => {
    const execPath = "/Applications/My Apps/it's/aolangai.app/Contents/MacOS/aolangai";
    expect(shimText({ execPath, electron: true }, "/x/index.js")).toBe(
      `#!/bin/sh\n# ${MARKER}\nELECTRON_RUN_AS_NODE=1 exec '/Applications/My Apps/it'\\''s/aolangai.app/Contents/MacOS/aolangai' '/x/index.js' "$@"\n`,
    );
  });

  it("the electron form runs its binary with ELECTRON_RUN_AS_NODE=1, the entry and the arguments intact", () => {
    const dir = path.join(root, "it's a dir");
    fs.mkdirSync(dir);
    const fakeElectron = path.join(dir, "fake electron");
    fs.writeFileSync(fakeElectron, '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
    const entry = path.join(dir, "cli entry.js");
    const bin = path.join(root, "bin");
    install({ skillDir: p.skillDir, binDir: bin }, SKILL, shimText({ execPath: fakeElectron, electron: true }, entry));
    const argv = ["run", "two words  with spaces", "a'b", "$HOME"];
    const r = spawnSync("/bin/sh", [path.join(bin, "aolangai"), ...argv], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(["1", entry, ...argv].join("\n") + "\n");
  });

  it("escapes a single quote", () => {
    expect(shimText(node("/a'b/node"), "/c d/index.js")).toBe(`#!/bin/sh\n# ${MARKER}\nexec '/a'\\''b/node' '/c d/index.js' "$@"\n`);
  });

  it("runs the entry through paths with a space and a single quote, passing arguments intact", () => {
    const dir = path.join(root, "it's a dir");
    fs.mkdirSync(dir);
    const entry = path.join(dir, "stub script.js");
    fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const bin = path.join(root, "bin");
    install({ skillDir: p.skillDir, binDir: bin }, SKILL, shimText(node(process.execPath), entry));
    const r = spawnSync(path.join(bin, "aolangai"), ["run", "two words  with   spaces", "--label", "a'b", "$HOME", ""], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["run", "two words  with   spaces", "--label", "a'b", "$HOME", ""]);
  });

  it("works when the node path has a space too", () => {
    const nodeDir = path.join(root, "my node");
    fs.mkdirSync(nodeDir);
    const nodeBin = path.join(nodeDir, "node");
    fs.symlinkSync(process.execPath, nodeBin);
    const entry = path.join(root, "e.js");
    fs.writeFileSync(entry, "process.stdout.write('ok');\n");
    install(p, SKILL, shimText(node(nodeBin), entry));
    expect(spawnSync(shimFile(), [], { encoding: "utf8" }).stdout).toBe("ok");
  });
});

describe("installStatus", () => {
  it("is missing when nothing is there", () => {
    expect(installStatus(p, SKILL, SHIM)).toEqual({ skill: "missing", shim: "missing" });
  });

  it("is current after install", () => {
    install(p, SKILL, SHIM);
    expect(installStatus(p, SKILL, SHIM)).toEqual({ skill: "current", shim: "current" });
  });

  it("is outdated when the text differs but the marker is there", () => {
    install(p, SKILL, SHIM);
    expect(installStatus(p, SKILL + "extra\n", SHIM)).toEqual({ skill: "outdated", shim: "current" });
    expect(installStatus(p, SKILL, shimText(node("/other/node"), "/x.js"))).toEqual({ skill: "current", shim: "outdated" });
  });

  it("is foreign without the marker, for a directory and for an unreadable file", () => {
    put(skillFile(), "not ours\n");
    fs.mkdirSync(shimFile(), { recursive: true });
    expect(installStatus(p, SKILL, SHIM)).toEqual({ skill: "foreign", shim: "foreign" });
  });

  it("is foreign for an unreadable file", () => {
    put(skillFile(), SKILL);
    fs.chmodSync(skillFile(), 0o000);
    try {
      // root can read anything; only assert where the mode really blocks reading
      const blocked = (() => { try { fs.readFileSync(skillFile()); return false; } catch { return true; } })();
      if (blocked) expect(installStatus(p, SKILL, SHIM).skill).toBe("foreign");
    } finally {
      fs.chmodSync(skillFile(), 0o644);
    }
  });
});

describe("install", () => {
  it("creates the directories and writes both files, the shim executable (755)", () => {
    install(p, SKILL, SHIM);
    expect(fs.readFileSync(skillFile(), "utf8")).toBe(SKILL);
    expect(fs.readFileSync(shimFile(), "utf8")).toBe(SHIM);
    expect(fs.statSync(shimFile()).mode & 0o777).toBe(0o755);
  });

  it("overwrites an outdated file that has the marker", () => {
    put(skillFile(), `<!-- ${MARKER} -->\nold\n`);
    put(shimFile(), `#!/bin/sh\n# ${MARKER}\nexec old\n`);
    install(p, SKILL, SHIM);
    expect(installStatus(p, SKILL, SHIM)).toEqual({ skill: "current", shim: "current" });
    expect(fs.statSync(shimFile()).mode & 0o777).toBe(0o755);
  });

  it("is idempotent and repairs the mode of a current shim", () => {
    install(p, SKILL, SHIM);
    fs.chmodSync(shimFile(), 0o644);
    install(p, SKILL, SHIM);
    expect(fs.statSync(shimFile()).mode & 0o777).toBe(0o755);
  });

  it("refuses a foreign skill file and writes nothing, not even the shim", () => {
    put(skillFile(), "not ours\n");
    expect(() => install(p, SKILL, SHIM)).toThrow(`This file was not created by aolangai, not overwriting: ${skillFile()}`);
    expect(fs.readFileSync(skillFile(), "utf8")).toBe("not ours\n");
    expect(fs.existsSync(p.binDir)).toBe(false);
  });

  it("refuses a foreign shim and leaves the skill file alone", () => {
    put(shimFile(), "#!/bin/sh\necho not ours\n");
    expect(() => install(p, SKILL, SHIM)).toThrow(shimFile());
    expect(fs.readFileSync(shimFile(), "utf8")).toBe("#!/bin/sh\necho not ours\n");
    expect(fs.existsSync(p.skillDir)).toBe(false);
  });

  it("leaves no temporary file behind", () => {
    install(p, SKILL, SHIM);
    install(p, SKILL + "new\n", SHIM);
    expect(fs.readdirSync(p.skillDir)).toEqual(["SKILL.md"]);
    expect(fs.readdirSync(p.binDir)).toEqual(["aolangai"]);
  });

  it("leaves no temporary file when the write fails", () => {
    // the target is a directory with the marker-less name, so rename fails; the check rejects it first, so
    // force a failure another way: a read-only directory
    fs.mkdirSync(p.binDir, { recursive: true });
    fs.mkdirSync(p.skillDir, { recursive: true });
    fs.chmodSync(p.binDir, 0o555);
    try {
      let writable = true;
      try { fs.writeFileSync(path.join(p.binDir, "probe"), ""); } catch { writable = false; }
      if (writable) return; // running as root
      expect(() => install(p, SKILL, SHIM)).toThrow();
    } finally {
      fs.chmodSync(p.binDir, 0o755);
    }
    expect(fs.readdirSync(p.binDir)).toEqual([]);
  });
});

describe("skillStatus and installSkill", () => {
  it("skillStatus is missing, current, outdated or foreign", () => {
    expect(skillStatus(p.skillDir, SKILL)).toBe("missing");
    put(skillFile(), SKILL);
    expect(skillStatus(p.skillDir, SKILL)).toBe("current");
    expect(skillStatus(p.skillDir, SKILL + "extra\n")).toBe("outdated");
    put(skillFile(), "not ours\n");
    expect(skillStatus(p.skillDir, SKILL)).toBe("foreign");
  });

  it("installSkill creates the directories and writes SKILL.md (644)", () => {
    installSkill(p.skillDir, SKILL);
    expect(fs.readFileSync(skillFile(), "utf8")).toBe(SKILL);
    expect(fs.statSync(skillFile()).mode & 0o777).toBe(0o644);
    expect(skillStatus(p.skillDir, SKILL)).toBe("current");
  });

  it("installSkill replaces an outdated file that has the marker and leaves a current one alone", () => {
    put(skillFile(), `<!-- ${MARKER} -->\nold\n`);
    installSkill(p.skillDir, SKILL);
    expect(fs.readFileSync(skillFile(), "utf8")).toBe(SKILL);
    const before = fs.statSync(skillFile()).mtimeMs;
    installSkill(p.skillDir, SKILL);
    expect(fs.statSync(skillFile()).mtimeMs).toBe(before);
  });

  it("installSkill throws for a foreign file and does not change it", () => {
    put(skillFile(), "not ours\n");
    expect(() => installSkill(p.skillDir, SKILL)).toThrow(`This file was not created by aolangai, not overwriting: ${skillFile()}`);
    expect(fs.readFileSync(skillFile(), "utf8")).toBe("not ours\n");
    expect(fs.readdirSync(p.skillDir)).toEqual(["SKILL.md"]);
  });
});

describe("shimStatus and installShim", () => {
  it("shimStatus is missing, current, outdated or foreign", () => {
    expect(shimStatus(p.binDir, SHIM)).toBe("missing");
    put(shimFile(), SHIM);
    expect(shimStatus(p.binDir, SHIM)).toBe("current");
    expect(shimStatus(p.binDir, shimText(node("/other/node"), "/x.js"))).toBe("outdated");
    put(shimFile(), "#!/bin/sh\necho not ours\n");
    expect(shimStatus(p.binDir, SHIM)).toBe("foreign");
  });

  it("installShim writes the command executable (755) and repairs the mode of a current one", () => {
    installShim(p.binDir, SHIM);
    expect(fs.readFileSync(shimFile(), "utf8")).toBe(SHIM);
    expect(fs.statSync(shimFile()).mode & 0o777).toBe(0o755);
    fs.chmodSync(shimFile(), 0o644);
    installShim(p.binDir, SHIM);
    expect(fs.statSync(shimFile()).mode & 0o777).toBe(0o755);
  });

  it("installShim replaces an outdated file that has the marker", () => {
    put(shimFile(), `#!/bin/sh\n# ${MARKER}\nexec old\n`);
    installShim(p.binDir, SHIM);
    expect(shimStatus(p.binDir, SHIM)).toBe("current");
  });

  it("installShim throws for a foreign file and does not change it", () => {
    put(shimFile(), "#!/bin/sh\necho not ours\n");
    expect(() => installShim(p.binDir, SHIM)).toThrow(`This file was not created by aolangai, not overwriting: ${shimFile()}`);
    expect(fs.readFileSync(shimFile(), "utf8")).toBe("#!/bin/sh\necho not ours\n");
  });
});
