import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../store/db.js";
import { createRepos, type Repos } from "../store/repos.js";
import type { Run } from "../types.js";
import { LOST_DISPATCHER, processStart, stopAll, stopRun, sweepDeadRuns } from "./control.js";

const NOW = 1_800_000_000_000;
/** Real `ps` calls in these tests get a generous timeout: under load the production 2 s may pass without an answer. */
const PS = { psTimeoutMs: 15_000 };
const start = (pid: number) => processStart(pid, PS);
/** This process's start time, asked once. */
let myStart: string;
beforeAll(() => {
  myStart = start(process.pid)!;
});

let repos: Repos;
let tmp: string;
let savedTz: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  repos = createRepos(openDb(":memory:"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "control-"));
  savedTz = process.env.TZ;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of children.splice(0)) c.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

/** A pid that existed and has exited. */
function deadPid(): number {
  return spawnSync("true").pid!;
}
/** A live process; `detached` makes it lead its own process group, like a claude worker. */
function sleeper(detached = false): ChildProcess {
  const c = spawn("sleep", ["30"], { stdio: "ignore", detached });
  children.push(c);
  return c;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** A stand-in for ps that logs each call and prints canned `pid pgid start` lines, whatever it is asked. */
function cannedPs(lines: string[]): { psPath: string; calls: () => number } {
  const log = path.join(tmp, "ps.log");
  const psPath = path.join(tmp, "ps");
  fs.writeFileSync(psPath, `#!/bin/sh\necho "$@" >> '${log}'\ncat <<'EOF'\n${lines.join("\n")}\nEOF\n`, { mode: 0o755 });
  return { psPath, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0) };
}
const negativeKills = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([pid]) => (pid as number) <= 1);
function exited(c: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) resolve(c.signalCode);
    else c.once("exit", (_code, sig) => resolve(sig));
  });
}
function runRow(over: Partial<Run> = {}): Run {
  return repos.runs.insert({
    prompt: "p", cwd: "/w", accountId: "a", primaryWorker: true, readOnly: false, status: "running",
    pid: process.pid, pidStart: myStart, createdAt: NOW - 1000, ...over,
  });
}

describe("processStart", () => {
  it("returns the start time of a live process and undefined otherwise", () => {
    const mine = start(process.pid);
    expect(mine).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(start(process.pid)).toBe(mine);
    expect(start(deadPid())).toBeUndefined();
    expect(start(0)).toBeUndefined();
    expect(start(-5)).toBeUndefined();
    expect(start(1.5)).toBeUndefined();
  });

  it("does not depend on the time zone of the caller", () => {
    process.env.TZ = "UTC";
    const utc = start(1);
    process.env.TZ = "America/New_York";
    expect(start(1)).toBe(utc);
    expect(utc).toBeDefined();
  });

  it("is undefined when ps cannot run", () => {
    expect(processStart(process.pid, { psPath: path.join(tmp, "no-ps") })).toBeUndefined();
  });
});

describe("sweepDeadRuns", () => {
  it("fails running rows whose pid is gone or whose start time differs, and leaves the rest", () => {
    const gone = runRow({ pid: deadPid() });
    const reused = runRow({ pidStart: "Mon Jan  1 00:00:00 2001" });
    const noPid = runRow({ pid: undefined, pidStart: undefined });
    const alive = runRow();
    const finished = runRow({ pid: deadPid(), status: "done", finishedAt: NOW - 500 });

    expect(sweepDeadRuns(repos, NOW, PS)).toBe(3);
    for (const r of [gone, reused, noPid]) {
      expect(repos.runs.get(r.id)).toMatchObject({ status: "failed", error: LOST_DISPATCHER, finishedAt: NOW });
    }
    expect(repos.runs.get(alive.id)?.status).toBe("running");
    expect(repos.runs.get(finished.id)).toMatchObject({ status: "done", finishedAt: NOW - 500 });
    expect(sweepDeadRuns(repos, NOW, PS)).toBe(0);
  });

  it("treats every run as alive when ps cannot run", () => {
    const gone = runRow({ pid: deadPid() });
    expect(sweepDeadRuns(repos, NOW, { psPath: path.join(tmp, "no-ps") })).toBe(0);
    expect(repos.runs.get(gone.id)?.status).toBe("running");
  });

  it("asks ps once for all the runs it checks", () => {
    const OLD = "Mon Jan  1 00:00:00 2001";
    const ps = cannedPs([`${process.pid} ${process.pid} ${OLD}`, `4000001 4000001 Tue Jan  2 00:00:00 2001`]);
    const kill = vi.spyOn(process, "kill");
    // Three runs whose dispatcher ps does not list, each with a worker ps lists under another start time (no kill).
    for (const pid of [4000002, 4000003, 4000004]) runRow({ pid, workerPid: 4000001, workerPidStart: OLD });
    const live = runRow({ pidStart: OLD });
    expect(sweepDeadRuns(repos, NOW, { psPath: ps.psPath })).toBe(3);
    expect(ps.calls()).toBe(1);
    expect(repos.runs.get(live.id)?.status).toBe("running");
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills the process group of a live worker whose dispatcher is gone", async () => {
    const w = sleeper(true);
    await new Promise((r) => setTimeout(r, 50));
    const r = runRow({ pid: deadPid(), workerPid: w.pid!, workerPidStart: start(w.pid!)! });
    expect(sweepDeadRuns(repos, NOW, PS)).toBe(1);
    expect(await exited(w)).toBe("SIGKILL");
    expect(repos.runs.get(r.id)).toMatchObject({ status: "failed", error: LOST_DISPATCHER });
  });

  it("signals no worker whose pid is 1 or ours or whose start time differs", async () => {
    const w = sleeper(true);
    await new Promise((r) => setTimeout(r, 50));
    const kill = vi.spyOn(process, "kill");
    runRow({ pid: deadPid(), workerPid: 1, workerPidStart: start(1)! });
    runRow({ pid: deadPid(), workerPid: process.pid, workerPidStart: start(process.pid)! });
    runRow({ pid: deadPid(), workerPid: w.pid!, workerPidStart: "Mon Jan  1 00:00:00 2001" });
    expect(sweepDeadRuns(repos, NOW, PS)).toBe(3);
    expect(kill).not.toHaveBeenCalled();
    expect(negativeKills(kill)).toEqual([]);
    expect(alive(w.pid!)).toBe(true);
  });

  it("does not kill a worker whose dispatcher is alive", async () => {
    const w = sleeper(true);
    await new Promise((r) => setTimeout(r, 50));
    runRow({ workerPid: w.pid!, workerPidStart: start(w.pid!)! });
    expect(sweepDeadRuns(repos, NOW, PS)).toBe(0);
    expect(alive(w.pid!)).toBe(true);
  });
});

describe("stopRun", () => {
  it("says not-running for a finished or unknown run", () => {
    const done = runRow({ status: "done", finishedAt: NOW });
    expect(stopRun(repos, done.id, PS)).toBe("not-running");
    expect(stopRun(repos, 9999, PS)).toBe("not-running");
    expect(repos.runs.get(done.id)?.status).toBe("done");
  });

  it("marks the run failed and says gone when its dispatcher is dead or is another process now", () => {
    const dead = runRow({ pid: deadPid() });
    expect(stopRun(repos, dead.id, PS)).toBe("gone");
    expect(repos.runs.get(dead.id)).toMatchObject({ status: "failed", error: LOST_DISPATCHER });
    expect(repos.runs.get(dead.id)?.finishedAt).toBeTypeOf("number");

    // Our own pid with someone else's start time: must not signal the test runner.
    const reused = runRow({ pidStart: "Mon Jan  1 00:00:00 2001" });
    expect(stopRun(repos, reused.id, PS)).toBe("gone");
    expect(repos.runs.get(reused.id)?.status).toBe("failed");
  });

  it("never signals pid 1 or below", () => {
    for (const pid of [1, 0, -1]) {
      const r = runRow({ pid, pidStart: start(1) ?? "x" });
      expect(stopRun(repos, r.id, PS)).toBe("gone");
      expect(repos.runs.get(r.id)?.status).toBe("failed");
    }
  });

  it("kills a live worker whose dispatcher is gone and says gone", async () => {
    const w = sleeper(true);
    await new Promise((r) => setTimeout(r, 50));
    const r = runRow({ pid: deadPid(), workerPid: w.pid!, workerPidStart: start(w.pid!)! });
    expect(stopRun(repos, r.id, PS)).toBe("gone");
    expect(await exited(w)).toBe("SIGKILL");
    expect(repos.runs.get(r.id)?.status).toBe("failed");
  });

  it("treats the dispatcher as alive when ps cannot run", async () => {
    const c = sleeper();
    await new Promise((r) => setTimeout(r, 50));
    const r = runRow({ pid: c.pid!, pidStart: start(c.pid!)! });
    expect(stopRun(repos, r.id, { psPath: path.join(tmp, "no-ps") })).toBe("signalled");
    expect(await exited(c)).toBe("SIGTERM");
    expect(repos.runs.get(r.id)?.status).toBe("running");
  });

  it("sends SIGTERM to the live dispatcher and leaves the row for it to finish", async () => {
    const c = sleeper();
    await new Promise((r) => setTimeout(r, 50));
    const r = runRow({ pid: c.pid!, pidStart: start(c.pid!)! });
    expect(stopRun(repos, r.id, PS)).toBe("signalled");
    expect(await exited(c)).toBe("SIGTERM");
    expect(repos.runs.get(r.id)?.status).toBe("running");
  });
});

describe("stopAll", () => {
  it("signals every live running run and returns how many", async () => {
    const a = sleeper();
    const b = sleeper();
    await new Promise((r) => setTimeout(r, 50));
    runRow({ pid: a.pid!, pidStart: start(a.pid!)! });
    runRow({ pid: b.pid!, pidStart: start(b.pid!)! });
    const dead = runRow({ pid: deadPid() });
    runRow({ status: "done", finishedAt: NOW });

    expect(stopAll(repos, PS)).toBe(2);
    expect(await exited(a)).toBe("SIGTERM");
    expect(await exited(b)).toBe("SIGTERM");
    expect(repos.runs.get(dead.id)?.status).toBe("failed");
  });
});
