import { expect, test } from "vitest";
import { account, appState, run } from "../testing.js";
import { MAP_WINDOW_MS, UNKNOWN_NODE, mapDetail, mapEdges, mapLayout } from "./map.js";

const NOW = new Date(2026, 10, 17, 12, 0).getTime();
const HOUR = 3_600_000;
const accounts = [account({ id: "personal", name: "Personal" }), account({ id: "work", name: "Work" }), account({ id: "side", name: "Side" })];
/** A run delegated from the session `pid` of `from`, run by `to`. */
const via = (id: number, from: string | undefined, to: string, o: Partial<Parameters<typeof run>[0]> = {}) =>
  run({
    id,
    accountId: to,
    callerPid: 100,
    callerStartedAt: 5000,
    callerKind: "Terminal",
    ...(from === undefined ? {} : { callerAccountId: from }),
    createdAt: NOW - HOUR,
    ...o,
  });

test("mapEdges: one edge per (from, to), counting running and failed runs, in account order", () => {
  const s = appState({
    accounts,
    runs: [
      via(1, "personal", "work", { status: "running" }),
      via(2, "personal", "work", { status: "done", createdAt: NOW - 2 * HOUR }),
      via(3, "work", "side", { status: "failed" }),
    ],
  });
  const edges = mapEdges(s, NOW);
  expect(edges.map((e) => ({ from: e.from, to: e.to, running: e.running, failed: e.failed, runs: e.runs.length }))).toEqual([
    { from: "personal", to: "work", running: 1, failed: 0, runs: 2 },
    { from: "work", to: "side", running: 0, failed: 1, runs: 1 },
  ]);
  expect(edges[0].runs.map((r) => r.id)).toEqual([1, 2]);
});

test("mapEdges: a limited run counts as failed", () => {
  const s = appState({ accounts, runs: [via(1, "personal", "work", { status: "limited" }), via(2, "personal", "work", { status: "stopped" })] });
  expect(mapEdges(s, NOW)[0].failed).toBe(1);
});

test("mapEdges: leaves out runs older than 24 hours and runs without a caller", () => {
  const s = appState({
    accounts,
    runs: [
      via(1, "personal", "work", { createdAt: NOW - 25 * HOUR }),
      via(2, "personal", "work", { createdAt: NOW - MAP_WINDOW_MS }),
      run({ id: 3, accountId: "work", createdAt: NOW - HOUR }),
    ],
  });
  expect(mapEdges(s, NOW).map((e) => e.runs.map((r) => r.id))).toEqual([[2]]);
});

test("mapEdges: a caller of unknown account starts at the Unknown node, last in the order", () => {
  const s = appState({
    accounts,
    runs: [via(1, undefined, "work"), via(2, "gone", "personal"), via(3, "work", "personal"), via(4, "personal", "side")],
  });
  expect(mapEdges(s, NOW).map((e) => `${e.from}>${e.to}`)).toEqual(["personal>side", "work>personal", `${UNKNOWN_NODE}>personal`, `${UNKNOWN_NODE}>work`]);
});

test("mapEdges: an account delegating to itself is one self-edge", () => {
  const s = appState({ accounts, runs: [via(1, "work", "work"), via(2, "work", "work")] });
  const edges = mapEdges(s, NOW);
  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ from: "work", to: "work" });
  expect(edges[0].runs).toHaveLength(2);
});

const round = (nodes: { x: number; y: number }[]) => nodes.map((n) => [Math.round(n.x), Math.round(n.y)]);

test("mapLayout: one account sits in the centre", () => {
  const s = appState({ accounts: [account({ id: "a", name: "A" })] });
  expect(round(mapLayout(s, [], 800, 400))).toEqual([[400, 200]]);
});

test("mapLayout: two accounts sit left and right at mid-height, inset by 90 px", () => {
  const s = appState({ accounts: [account({ id: "a", name: "A" }), account({ id: "b", name: "B" })] });
  const nodes = mapLayout(s, [], 800, 400);
  expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
  expect(round(nodes)).toEqual([[90, 200], [710, 200]]);
});

test("mapLayout: three or more go round an ellipse, first at the left, clockwise on screen", () => {
  const s = appState({ accounts });
  const nodes = mapLayout(s, [], 800, 400);
  // Order: accepting accounts by name, so Personal, Side, Work. cx 400, cy 200, rx 310, ry 110.
  expect(nodes.map((n) => n.name)).toEqual(["Personal", "Side", "Work"]);
  expect(round(nodes)).toEqual([[90, 200], [555, 105], [555, 295]]);
  const four = mapLayout(appState({ accounts: [...accounts, account({ id: "z", name: "Zed" })] }), [], 800, 400);
  expect(round(four)).toEqual([[90, 200], [400, 90], [710, 200], [400, 310]]);
});

test("mapLayout: the Unknown node appears only when an edge starts there", () => {
  const without = appState({ accounts, runs: [via(1, "personal", "work")] });
  expect(mapLayout(without, mapEdges(without, NOW), 800, 400).some((n) => n.unknown)).toBe(false);
  const withUnknown = appState({ accounts, runs: [via(1, undefined, "work")] });
  const nodes = mapLayout(withUnknown, mapEdges(withUnknown, NOW), 800, 400);
  expect(nodes).toHaveLength(4);
  expect(nodes[3]).toMatchObject({ id: UNKNOWN_NODE, name: "Unknown", unknown: true });
  expect(nodes.slice(0, 3).every((n) => !n.unknown)).toBe(true);
});

test("mapLayout: no accounts and no unknown edge means no nodes", () => {
  expect(mapLayout(appState(), [], 800, 400)).toEqual([]);
});

test("mapDetail: one group per caller session, newest first, runs split by worker in account order", () => {
  const other = { callerPid: 200, callerStartedAt: 6000 };
  const s = appState({
    accounts,
    runs: [
      via(1, "personal", "work", { createdAt: NOW - 3 * HOUR }),
      via(2, "personal", "side", { createdAt: NOW - 2 * HOUR }),
      via(3, "personal", "work", { createdAt: NOW - 1 * HOUR }),
      via(4, "personal", "work", { ...other, createdAt: NOW - 5 * HOUR }),
      via(5, "work", "side"),
    ],
  });
  const groups = mapDetail(s, NOW, "personal");
  expect(groups.map((g) => g.caller.key)).toEqual(["100:5000", "200:6000"]);
  expect(groups[0].byWorker.map((w) => [w.accountId, w.accountName, w.runs.map((r) => r.id)])).toEqual([
    ["side", "Side", [2]],
    ["work", "Work", [3, 1]],
  ]);
  expect(groups[1].byWorker.map((w) => w.runs.map((r) => r.id))).toEqual([[4]]);
});

test("mapDetail: `to` keeps only that worker's runs and drops groups left empty", () => {
  const s = appState({
    accounts,
    runs: [via(1, "personal", "work"), via(2, "personal", "side"), via(3, "personal", "side", { callerPid: 200, callerStartedAt: 6000 })],
  });
  const groups = mapDetail(s, NOW, "personal", "work");
  expect(groups).toHaveLength(1);
  expect(groups[0].byWorker.map((w) => w.accountId)).toEqual(["work"]);
});

test("mapDetail: the Unknown node collects deleted-account and API-key callers; old runs are left out", () => {
  const s = appState({
    accounts,
    runs: [via(1, undefined, "work"), via(2, "gone", "work", { callerPid: 300, createdAt: NOW - 2 * HOUR }), via(3, "personal", "work"), via(4, undefined, "work", { createdAt: NOW - 30 * HOUR })],
  });
  const groups = mapDetail(s, NOW, UNKNOWN_NODE);
  expect(groups.map((g) => g.caller.key)).toEqual(["100:5000", "300:5000"]);
  expect(groups.flatMap((g) => g.byWorker.flatMap((w) => w.runs.map((r) => r.id)))).toEqual([1, 2]);
});
