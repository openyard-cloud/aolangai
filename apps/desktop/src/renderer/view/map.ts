// The delegation map: who delegated to whom in the last 24 hours, decided without React.
import type { Run } from "@aolangai/core";
import type { AppState } from "../../shared/api.js";
import { callerOf, type CallerView } from "./callers.js";
import { lanes } from "./runs.js";

export const MAP_WINDOW_MS = 24 * 60 * 60_000;
/** The node for callers whose account is not known; drawn only when some edge starts there. */
export const UNKNOWN_NODE = "unknown";
/** How far the nodes stay from the edge of the drawing, so their labels fit. */
const INSET = 90;

export interface MapEdge {
  /** The caller's account id, or UNKNOWN_NODE. */
  from: string;
  /** The worker's account id. */
  to: string;
  /** Newest first. */
  runs: Run[];
  running: number;
  /** `failed` and `limited` runs. */
  failed: number;
}

export interface MapNode {
  id: string;
  name: string;
  x: number;
  y: number;
  unknown: boolean;
}

export interface DetailGroup {
  caller: CallerView;
  byWorker: { accountId: string; accountName: string; runs: Run[] }[];
}

/** Account ids in lane order; anything else (the Unknown node, a deleted worker) sorts after them. */
function accountOrder(s: AppState): (id: string) => number {
  const ids = lanes(s).map((l) => l.account.id);
  return (id) => {
    const i = ids.indexOf(id);
    return i < 0 ? ids.length : i;
  };
}

const newestFirst = (a: Run, b: Run) => b.createdAt - a.createdAt || b.id - a.id;

/** The caller's account, or UNKNOWN_NODE: a deleted account, an API-key caller and an undeclared desktop all land there. */
const fromOf = (run: Run, s: AppState) => callerOf(run, s)?.accountId ?? UNKNOWN_NODE;

/** Runs of the last 24 hours that record a caller, newest first. A run on a deleted worker account is left out: it has no node to draw, and the lanes hide it too. */
function windowRuns(s: AppState, now: number): Run[] {
  const workers = new Set(s.accounts.map((a) => a.id));
  return s.runs.filter((r) => workers.has(r.accountId) && callerOf(r, s) !== undefined && r.createdAt >= now - MAP_WINDOW_MS).sort(newestFirst);
}

/** One edge per (caller account, worker account), sorted by caller then worker in account order. A self-edge has from === to. */
export function mapEdges(s: AppState, now: number): MapEdge[] {
  const order = accountOrder(s);
  const edges = new Map<string, MapEdge>();
  for (const run of windowRuns(s, now)) {
    const from = fromOf(run, s);
    const key = JSON.stringify([from, run.accountId]);
    let edge = edges.get(key);
    if (!edge) {
      edge = { from, to: run.accountId, runs: [], running: 0, failed: 0 };
      edges.set(key, edge);
    }
    edge.runs.push(run);
    if (run.status === "running") edge.running += 1;
    if (run.status === "failed" || run.status === "limited") edge.failed += 1;
  }
  return [...edges.values()].sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to));
}

/**
 * Every account in lane order, plus the Unknown node when some edge starts there. One node sits in the centre, two
 * left and right at mid-height; three or more are spread evenly on an ellipse, the first at the left and the rest
 * clockwise on screen (y points down, so the angle runs from π downwards).
 */
export function mapLayout(s: AppState, edges: MapEdge[], width: number, height: number): MapNode[] {
  const nodes = lanes(s).map((l) => ({ id: l.account.id, name: l.account.name, unknown: false }));
  if (edges.some((e) => e.from === UNKNOWN_NODE)) nodes.push({ id: UNKNOWN_NODE, name: "Unknown", unknown: true });
  const cx = width / 2;
  const cy = height / 2;
  if (nodes.length === 2) return nodes.map((n, i) => ({ ...n, x: i === 0 ? INSET : width - INSET, y: cy }));
  const rx = width / 2 - INSET;
  const ry = height / 2 - INSET;
  return nodes.map((n, i) => {
    if (nodes.length === 1) return { ...n, x: cx, y: cy };
    const angle = Math.PI - (2 * Math.PI * i) / nodes.length;
    return { ...n, x: cx + rx * Math.cos(angle), y: cy - ry * Math.sin(angle) };
  });
}

/**
 * The window's runs delegated by `accountId` (or UNKNOWN_NODE), and by `to` only when given, grouped by caller
 * session. Groups with the newest run first, workers in account order, runs newest first.
 */
export function mapDetail(s: AppState, now: number, accountId: string, to?: string): DetailGroup[] {
  const order = accountOrder(s);
  const groups = new Map<string, { caller: CallerView; runs: Run[] }>();
  for (const run of windowRuns(s, now)) {
    if (fromOf(run, s) !== accountId || (to !== undefined && run.accountId !== to)) continue;
    const caller = callerOf(run, s) as CallerView;
    const group = groups.get(caller.key) ?? { caller, runs: [] };
    group.runs.push(run);
    groups.set(caller.key, group);
  }
  // windowRuns is newest first, so the Map keeps groups in order of their newest run.
  return [...groups.values()].map(({ caller, runs }) => {
    const workers = [...new Set(runs.map((r) => r.accountId))].sort((a, b) => order(a) - order(b));
    return {
      caller,
      byWorker: workers.map((id) => ({
        accountId: id,
        accountName: s.accounts.find((a) => a.id === id)?.name ?? id,
        runs: runs.filter((r) => r.accountId === id),
      })),
    };
  });
}
