import { spawnSync } from "node:child_process";
import type { Repos } from "../store/repos.js";
import type { Run } from "../types.js";

/** The error of a running run whose dispatching process no longer exists. */
export const LOST_DISPATCHER = "The delegating process was lost";

export interface ControlOptions {
  /** Default /bin/ps; tests point it elsewhere. */
  psPath?: string;
  /** Default 2000 ms; the sweep runs while holding the database write lock. */
  psTimeoutMs?: number;
}

const PS_PATH = "/bin/ps";
const PS_TIMEOUT_MS = 2_000;

interface ProcInfo {
  pgid: number;
  start: string;
}
/**
 * What one ps call said about some pids. `undefined` = ps could not answer (missing, timed out, killed, odd exit):
 * every process counts as alive then. Otherwise a pid absent from the map does not exist.
 */
type Snapshot = Map<number, ProcInfo> | undefined;

const validPid = (pid: number | undefined): pid is number => pid !== undefined && Number.isSafeInteger(pid) && pid > 0;

/**
 * One `ps` call for all `pids`. Fixed locale and time zone: a start time recorded by one process must compare equal
 * when another process (with another TZ) reads it.
 */
function snapshot(pids: (number | undefined)[], o: ControlOptions = {}): Snapshot {
  const list = [...new Set(pids.filter(validPid))];
  if (list.length === 0) return new Map();
  const res = spawnSync(o.psPath ?? PS_PATH, ["-o", "pid=,pgid=,lstart=", "-p", list.join(",")], {
    env: { LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: o.psTimeoutMs ?? PS_TIMEOUT_MS,
  });
  // ps exits 1 when none of the pids exists; anything else unusual means we do not know.
  if (res.error || res.signal || (res.status !== 0 && res.status !== 1)) return undefined;
  const out = new Map<number, ProcInfo>();
  for (const line of res.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { pgid: Number(m[2]), start: m[3]! });
  }
  return out;
}

/**
 * Start time of a process as `ps` prints it (C locale, UTC), or undefined when the process does not exist or ps
 * could not answer. With the pid it identifies a process even after pid reuse.
 */
export function processStart(pid: number, o?: ControlOptions): string | undefined {
  return validPid(pid) ? snapshot([pid], o)?.get(pid)?.start : undefined;
}

/** True only when the run's dispatcher is proven gone (or the row cannot name one); ps not answering means alive. */
function dispatcherGone(r: Run, snap: Snapshot): boolean {
  if (r.pid === undefined || r.pidStart === undefined || r.pid <= 1) return true;
  if (!snap) return false;
  return snap.get(r.pid)?.start !== r.pidStart;
}

/**
 * Kills the process group of the run's claude, which outlives a killed dispatcher (it has its own group and its
 * timeout lived in the dispatcher). Only when ps shows the very process that was recorded, still leading its own
 * group, and that group is not ours.
 */
function killOrphan(r: Run, snap: Snapshot): void {
  const pid = r.workerPid;
  if (!snap || pid === undefined || r.workerPidStart === undefined || pid <= 1 || pid === process.pid) return;
  const w = snap.get(pid);
  if (!w || w.start !== r.workerPidStart || w.pgid !== pid) return;
  const own = snap.get(process.pid);
  if (!own || own.pgid === pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

const pidsOf = (runs: Run[]) => [process.pid, ...runs.flatMap((r) => [r.pid, r.workerPid])];

/**
 * Fails the run only if it is still running: the dispatcher may have recorded its outcome and exited between our read
 * and this write, and that outcome must win. One statement, so it needs no transaction (and works inside one).
 */
function markLost(repos: Repos, id: number, now: number): boolean {
  const info = repos.db
    .prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(LOST_DISPATCHER, now, id);
  return Number(info.changes) > 0;
}

/** Marks a run whose dispatcher is gone as failed and kills its orphaned claude. */
function settleLost(repos: Repos, r: Run, snap: Snapshot, now: number): boolean {
  if (!markLost(repos, r.id, now)) return false;
  killOrphan(r, snap);
  return true;
}

/**
 * Fails every running run whose dispatching process is gone (or is another process now) and kills its orphaned
 * claude, so a killed dispatcher neither leaves its run running forever, nor counts against the concurrency cap, nor
 * leaves a claude billing on a session. One ps call for all of them. Returns how many were failed.
 */
export function sweepDeadRuns(repos: Repos, now: number, o?: ControlOptions): number {
  const running = repos.runs.running();
  if (running.length === 0) return 0;
  const snap = snapshot(pidsOf(running), o);
  let n = 0;
  for (const r of running) if (dispatcherGone(r, snap) && settleLost(repos, r, snap, now)) n++;
  return n;
}

function stopWith(repos: Repos, r: Run, snap: Snapshot): "signalled" | "gone" {
  if (dispatcherGone(r, snap)) {
    settleLost(repos, r, snap, Date.now());
    return "gone";
  }
  // ps could not answer: our own pid is never signalled unverified (a bad row must not stop this process).
  if (r.pid === process.pid && !snap) return "gone";
  try {
    process.kill(r.pid!, "SIGTERM");
    return "signalled";
  } catch {
    settleLost(repos, r, snap, Date.now());
    return "gone";
  }
}

/**
 * Asks the dispatching process (never a process group) to stop the run with SIGTERM; it aborts the run and records
 * `stopped` itself. A run whose dispatcher is gone is failed here instead, and its orphaned claude killed.
 */
export function stopRun(repos: Repos, id: number, o?: ControlOptions): "signalled" | "not-running" | "gone" {
  const r = repos.runs.get(id);
  if (!r || r.status !== "running") return "not-running";
  return stopWith(repos, r, snapshot(pidsOf([r]), o));
}

/** Stops every running run; returns how many dispatchers were signalled. */
export function stopAll(repos: Repos, o?: ControlOptions): number {
  const running = repos.runs.running();
  const snap = snapshot(pidsOf(running), o);
  return running.filter((r) => stopWith(repos, r, snap) === "signalled").length;
}
