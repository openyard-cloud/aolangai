// Checks the packaged app after `npm run dist`; exits non-zero on the first thing that is wrong. Runs the packaged
// binary only as node (ELECTRON_RUN_AS_NODE=1), never as the app, and only against temp paths.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../release/mac-arm64/aolangai.app", import.meta.url));
const BIN = path.join(APP, "Contents", "MacOS", "aolangai");
const RESOURCES = path.join(APP, "Contents", "Resources");
const CLI_ENTRY = path.join(RESOURCES, "cli", "dist", "index.js");
const SKILL = path.join(RESOURCES, "cli", "skill", "SKILL.md");
const ASAR = path.join(RESOURCES, "app.asar");
/** The SDK's per-platform packages, which carry a bundled `claude`. */
const PLATFORM_SDK = /claude-agent-sdk-(darwin|linux|win32)/;

let failed = false;
const ok = (msg) => console.log(`check-dist: ok   ${msg}`);
const fail = (msg) => {
  console.error(`check-dist: FAIL ${msg}`);
  failed = true;
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

/** Every path inside the app: files on disk, plus the entries packed in app.asar (prefixed with its path). */
function allPaths() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      out.push({ path: p, file: !e.isDirectory() });
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  walk(APP);
  if (fs.existsSync(ASAR)) {
    // asar layout: a pickle whose payload holds the header JSON (length at byte 12, JSON from byte 16).
    const fd = fs.openSync(ASAR, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);
    fs.closeSync(fd);
    const walkAsar = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = path.join(prefix, name);
        out.push({ path: p, file: !child.files });
        if (child.files) walkAsar(child, p);
      }
    };
    walkAsar(JSON.parse(json.toString("utf8")), ASAR);
  }
  return out;
}

function sizeOf(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += sizeOf(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

/** The packaged binary as node, with the given extra env. */
function runCli(args, env) {
  return spawnSync(BIN, [CLI_ENTRY, ...args], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000 });
}

if (!fs.existsSync(path.join(APP, "Contents", "Info.plist"))) {
  fail(`no app at ${APP}`);
  process.exit(1);
}
ok(`app exists: ${APP}`);
check(fs.existsSync(CLI_ENTRY), "Resources/cli/dist/index.js exists");
check(fs.existsSync(SKILL), "Resources/cli/skill/SKILL.md exists");

// Terminal automation from a Finder-launched app needs this key, or macOS refuses without asking.
const plist = path.join(APP, "Contents", "Info.plist");
const appleEvents = spawnSync("/usr/bin/plutil", ["-extract", "NSAppleEventsUsageDescription", "raw", plist], { encoding: "utf8" });
check(appleEvents.status === 0 && appleEvents.stdout.trim() !== "", `Info.plist has NSAppleEventsUsageDescription${appleEvents.status === 0 ? `: ${appleEvents.stdout.trim()}` : ""}`);

// The app icon from build/icon.icns, not Electron's default.
const iconFile = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", plist], { encoding: "utf8" });
const iconName = iconFile.status === 0 ? iconFile.stdout.trim() : "";
const iconPath = path.join(RESOURCES, iconName.endsWith(".icns") ? iconName : `${iconName}.icns`);
const iconSource = new URL("../build/icon.icns", import.meta.url);
check(
  iconName !== "" && fs.existsSync(iconPath) && fs.readFileSync(iconPath).equals(fs.readFileSync(iconSource)),
  `the app icon is build/icon.icns${iconName ? ` (Resources/${path.basename(iconPath)})` : ""}`,
);

const paths = allPaths();
const testingDirs = paths.filter((p) => !p.file && path.basename(p.path) === "testing" && p.path.startsWith(path.join(RESOURCES, "cli") + path.sep));
check(testingDirs.length === 0, `no testing folder under Resources/cli${testingDirs.length ? `: ${testingDirs[0].path}` : ""}`);
const platformSdk = paths.filter((p) => PLATFORM_SDK.test(p.path));
check(platformSdk.length === 0, `no claude-agent-sdk platform package in the app${platformSdk.length ? `: ${platformSdk[0].path}` : ""}`);
const claudeFiles = paths.filter((p) => p.file && /^claude(\.exe)?$/i.test(path.basename(p.path)));
check(claudeFiles.length === 0, `no file named claude in the app${claudeFiles.length ? `: ${claudeFiles[0].path}` : ""}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-check-dist-"));
try {
  const db = path.join(tmp, "store.db");
  const install = runCli(["install", "--check", "--skill-dir", path.join(tmp, "skill"), "--bin-dir", path.join(tmp, "bin")], { AOLANGAI_DB: db });
  console.log(`check-dist: install --check -> exit ${install.status}\n${(install.stdout ?? "").trimEnd()}${install.stderr ? `\n${install.stderr.trimEnd()}` : ""}`);
  const lines = (install.stdout ?? "").split("\n");
  check(lines.includes("skill: missing") && lines.includes("command: missing"), "install --check prints `skill: missing` and `command: missing`");

  // A real install into the temp dir: the shim it writes must run the packaged binary as node, or `aolangai run` would open the app.
  const skillDir = path.join(tmp, "skill");
  const binDir = path.join(tmp, "bin");
  const real = runCli(["install", "--skill-dir", skillDir, "--bin-dir", binDir], { AOLANGAI_DB: db });
  check(real.status === 0, `install (real) exits 0${real.status === 0 ? "" : `: ${real.stderr}`}`);
  const shimFile = path.join(binDir, "aolangai");
  const shimText = fs.existsSync(shimFile) ? fs.readFileSync(shimFile, "utf8") : "";
  console.log(`check-dist: shim head: ${JSON.stringify(shimText.split("\n").slice(0, 3).join("\n"))}`);
  check(shimText.startsWith("#!/bin/sh\n# aolangai-managed\nELECTRON_RUN_AS_NODE=1 exec "), "shim starts with `#!/bin/sh`, the marker and `ELECTRON_RUN_AS_NODE=1 exec `");
  if (shimText) {
    const viaShim = spawnSync(shimFile, ["status"], { env: { ...process.env, AOLANGAI_DB: db }, encoding: "utf8", timeout: 30_000 });
    console.log(`check-dist: shim status -> exit ${viaShim.status}\n${(viaShim.stdout ?? "").trimEnd()}${viaShim.stderr ? `\n${viaShim.stderr.trimEnd()}` : ""}`);
    check(viaShim.status === 0, "the shim runs `status` and exits 0");
  }

  const status = runCli(["status"], { AOLANGAI_DB: db });
  console.log(`check-dist: status -> exit ${status.status}\n${(status.stdout ?? "").trimEnd()}${status.stderr ? `\n${status.stderr.trimEnd()}` : ""}`);
  check(status.status === 0, "status exits 0");

  // The main process imports the SDK's JS from app.asar, resolved from where the main bundle sits.
  const probe = `const r=require("node:module").createRequire(${JSON.stringify(path.join(ASAR, "out", "main", "index.js"))});import(r.resolve("@anthropic-ai/claude-agent-sdk")).then(m=>process.exit(typeof m.query==="function"?0:1),()=>process.exit(1))`;
  const sdk = spawnSync(BIN, ["-e", probe], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000 });
  check(sdk.status === 0, `main process resolves @anthropic-ai/claude-agent-sdk from app.asar${sdk.status === 0 ? "" : `: ${sdk.stderr}`}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`check-dist: app size ${(sizeOf(APP) / 1024 / 1024).toFixed(1)} MB (${execFileSync("du", ["-sh", APP], { encoding: "utf8" }).split("\t")[0]} on disk)`);
if (failed) process.exit(1);
console.log("check-dist: all checks passed");
