import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialWindowState, MIN_SIZE, readWindowState, writeWindowState } from "./window-state.js";

// A 14" MacBook Pro at its default scale: 1512x982, minus menu bar and Dock.
const laptop = { x: 0, y: 38, width: 1512, height: 944 };
const external = { x: 1512, y: 0, width: 2560, height: 1415 };

test("first launch fills the primary screen's work area", () => {
  expect(initialWindowState(undefined, [laptop])).toEqual({ bounds: laptop, maximized: false });
});

test("a saved window comes back where it was, maximized or not", () => {
  const saved = { bounds: { x: 1600, y: 100, width: 1400, height: 900 }, maximized: true };
  expect(initialWindowState(saved, [laptop, external])).toEqual(saved);
});

test("a window saved on a screen that is gone opens on the primary screen", () => {
  const saved = { bounds: { x: 1600, y: 100, width: 1400, height: 900 }, maximized: false };
  expect(initialWindowState(saved, [laptop])).toEqual({ bounds: laptop, maximized: false });
});

test("a saved window bigger than its screen is shrunk to fit inside it", () => {
  const saved = { bounds: { x: 100, y: 100, width: 2400, height: 1300 }, maximized: false };
  expect(initialWindowState(saved, [laptop])).toEqual({ bounds: laptop, maximized: false });
  const partly = { bounds: { x: 1000, y: 500, width: 1000, height: 700 }, maximized: false };
  expect(initialWindowState(partly, [laptop]).bounds).toEqual({ x: 512, y: 282, width: 1000, height: 700 });
});

test("a saved window is never smaller than the minimum size", () => {
  const saved = { bounds: { x: 10, y: 50, width: 200, height: 100 }, maximized: false };
  expect(initialWindowState(saved, [laptop]).bounds).toEqual({ x: 10, y: 50, ...MIN_SIZE });
});

test("the state file round-trips and a broken file is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-win-"));
  const file = path.join(dir, "window-state.json");
  expect(readWindowState(file)).toBeUndefined();
  const s = { bounds: { x: 1, y: 2, width: 1300, height: 850 }, maximized: true };
  writeWindowState(file, s);
  expect(readWindowState(file)).toEqual(s);
  for (const bad of ["{", "null", '"x"', '{"bounds":{"x":1,"y":2,"width":"big","height":3},"maximized":false}', '{"bounds":{"x":1,"y":2,"width":5,"height":3}}']) {
    fs.writeFileSync(file, bad);
    expect(readWindowState(file)).toBeUndefined();
  }
});
