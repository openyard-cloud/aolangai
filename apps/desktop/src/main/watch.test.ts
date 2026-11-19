import { test, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepos, openDb, type Db } from "@aolangai/core";
import { watchStore } from "./watch.js";

// Fake timers: each tick runs when the test advances the clock, and the sqlite calls in it are synchronous, so no
// assertion depends on how fast a real interval fires.
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  vi.useRealTimers();
});

function twoConnections(): { mine: Db; other: Db } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-watch-"));
  const file = path.join(dir, "a.db");
  const mine = openDb(file);
  const other = openDb(file);
  cleanup.push(() => {
    for (const d of [mine, other]) {
      try {
        d.close();
      } catch {
        // already closed by the test
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { mine, other };
}

test("reports when another connection (a CLI process) writes to the store; reports nothing when nothing changed", () => {
  const { mine, other } = twoConnections();
  let changes = 0;
  cleanup.push(watchStore(mine, 10, () => void changes++));
  vi.advanceTimersByTime(50);
  expect(changes).toBe(0);
  createRepos(other).accounts.insert({ id: "x", name: "X", accepting: false, allowedDirs: [], reservePct: 90 });
  vi.advanceTimersByTime(9);
  expect(changes).toBe(0); // not before the next tick
  vi.advanceTimersByTime(1);
  expect(changes).toBe(1);
  vi.advanceTimersByTime(50);
  expect(changes).toBe(1);
});

test("a write by the watching connection itself is not reported (the app sends the state itself after writing)", () => {
  const { mine } = twoConnections();
  let changes = 0;
  cleanup.push(watchStore(mine, 10, () => void changes++));
  createRepos(mine).settings.setLimits({ ...createRepos(mine).settings.getLimits(), maxConcurrent: 1 });
  vi.advanceTimersByTime(50);
  expect(changes).toBe(0);
});

test("stop ends the watching", () => {
  const { mine, other } = twoConnections();
  let changes = 0;
  watchStore(mine, 10, () => void changes++)();
  createRepos(other).settings.setLimits({ ...createRepos(other).settings.getLimits(), maxConcurrent: 1 });
  vi.advanceTimersByTime(50);
  expect(changes).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("a read error (closed store) does not crash the process", () => {
  const { mine } = twoConnections();
  let changes = 0;
  cleanup.push(watchStore(mine, 10, () => void changes++));
  mine.close();
  expect(() => vi.advanceTimersByTime(50)).not.toThrow();
  expect(changes).toBe(0);
});
