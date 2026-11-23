#!/usr/bin/env node
// Takes the README and site screenshots from the built browser demo (npm run build:demo) with the installed Google
// Chrome in headless mode. Usage: node scripts/screenshots.mjs [output dir, default docs/screenshots]
// After the four README screenshots it renders scripts/og.html (which shows the new overview.png) into og.png:
// site/og.png by default, or og.png in the output dir when one is given.
//
// Each scene is loaded twice with the same flags: once with --dump-dom, to prove the demo reached its ready flag
// (data-demo-ready on <html>) within the virtual-time budget, and once with --screenshot. Virtual time makes both
// runs identical. Every run gets a fresh profile in a temporary folder, deleted afterwards.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const page = join(root, "site/demo/index.html");
const outDir = resolve(process.argv[2] ?? join(root, "docs/screenshots"));
const ogPage = join(root, "scripts/og.html");
const ogTarget = process.argv[2] ? join(outDir, "og.png") : join(root, "site/og.png");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 2;
/** Below this a PNG of a whole window is surely blank or broken. */
const MIN_BYTES = 60_000;

/**
 * `height` (CSS px) when a scene must end above the default bottom edge: the overview stops just below the collapsed
 * "Outside the lanes" line (bottom at y=897), before the Needs you card (top at y=910), which needs-you.png shows.
 * needs-you.png is 780 so that, scrolled to the bottom, its top edge falls in the gap above the Work lane (nothing cut).
 * The "from ..." line under a run row made the lanes taller; the map scenes are short, so they get a short window.
 */
const SCENES = [
  { file: "overview.png", scene: "overview", query: "scene=overview", height: 904 },
  { file: "needs-you.png", scene: "needs-you", query: "scene=needs-you", height: 780 },
  { file: "run-detail.png", scene: "run", query: "scene=run&id=46" },
  { file: "settings.png", scene: "settings", query: "scene=settings" },
  { file: "map.png", scene: "map", query: "scene=map", height: 640 },
  { file: "map-detail.png", scene: "map-detail", query: "scene=map-detail", height: 360 },
];

/** The link preview picture: one CSS px per pixel, the size Open Graph and Twitter cards expect. */
const OG = { width: 1200, height: 630, scale: 1, minBytes: 30_000 };

const FLAGS = [
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--force-color-profile=srgb",
  // The app follows the system theme, and headless Chrome follows the Mac's: pin light so every machine gets the same.
  "--blink-settings=preferredColorScheme=1",
  "--virtual-time-budget=3000",
];

function fail(message) {
  console.error(`screenshots: ${message}`);
  process.exit(1);
}

/** Runs Chrome on a fresh profile; resolves with its stdout. The profile folder is deleted in every case. */
function runChrome(height, args, { width = WIDTH, scale = SCALE } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "aolangai-shot-"));
  const flags = [`--user-data-dir=${profile}`, `--window-size=${width},${height}`, "--headless=new", `--force-device-scale-factor=${scale}`, ...FLAGS, ...args];
  return new Promise((done, reject) => {
    execFile(chrome, flags, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      rmSync(profile, { recursive: true, force: true });
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else done(stdout);
    });
  });
}

/** Width and height from the IHDR chunk, which always comes first in a PNG. */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.toString("latin1", 1, 4) !== "PNG") return undefined;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

if (!existsSync(chrome)) fail(`Google Chrome not found at ${chrome} (set CHROME_PATH)`);
if (!existsSync(page)) fail("site/demo/index.html is missing: run npm run build:demo first");
mkdirSync(outDir, { recursive: true });

for (const s of SCENES) {
  const height = s.height ?? HEIGHT;
  const url = `${pathToFileURL(page).href}?${s.query}&static=1&bare=1`;
  const dom = await runChrome(height, ["--dump-dom", url]);
  if (!dom.includes(`data-demo-ready="${s.scene}"`)) fail(`${s.file}: the demo did not reach scene "${s.scene}" in time (${url})`);

  const target = join(outDir, s.file);
  rmSync(target, { force: true });
  await runChrome(height, [`--screenshot=${target}`, url]);
  if (!existsSync(target)) fail(`${s.file}: Chrome wrote no file`);
  const bytes = statSync(target).size;
  const size = pngSize(target);
  if (!size) fail(`${s.file}: not a PNG`);
  if (size.width !== WIDTH * SCALE || size.height !== height * SCALE) fail(`${s.file}: ${size.width}x${size.height}, expected ${WIDTH * SCALE}x${height * SCALE}`);
  if (bytes < MIN_BYTES) fail(`${s.file}: only ${bytes} bytes, probably blank`);
  console.log(`${target}  ${size.width}x${size.height}  ${bytes} bytes`);
}

{
  const url = pathToFileURL(ogPage).href;
  const size = { width: OG.width, scale: OG.scale };
  const dom = await runChrome(OG.height, ["--dump-dom", url], size);
  if (!dom.includes('data-og-ready="yes"')) fail(`og.png: ${url} did not draw the overview screenshot`);
  mkdirSync(dirname(ogTarget), { recursive: true });
  rmSync(ogTarget, { force: true });
  await runChrome(OG.height, [`--screenshot=${ogTarget}`, url], size);
  if (!existsSync(ogTarget)) fail("og.png: Chrome wrote no file");
  const bytes = statSync(ogTarget).size;
  const got = pngSize(ogTarget);
  if (!got) fail("og.png: not a PNG");
  if (got.width !== OG.width || got.height !== OG.height) fail(`og.png: ${got.width}x${got.height}, expected ${OG.width}x${OG.height}`);
  if (bytes < OG.minBytes) fail(`og.png: only ${bytes} bytes, probably blank`);
  console.log(`${ogTarget}  ${got.width}x${got.height}  ${bytes} bytes`);
}
