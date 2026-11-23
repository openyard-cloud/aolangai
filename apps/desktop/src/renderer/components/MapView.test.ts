import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Run } from "@aolangai/core";
import type { AppState } from "../../shared/api.js";
import { account, appState, run, status } from "../testing.js";
import { MapView } from "./MapView.js";

const NOW = new Date(2026, 10, 17, 12, 0).getTime();
const HOUR = 3_600_000;
const accounts = [account({ id: "personal", name: "Personal" }), account({ id: "work", name: "Work" }), account({ id: "side", name: "Side project" })];
/** A run delegated from a Terminal session of `from` (undefined: an unknown account), run by `to`. */
const via = (id: number, from: string | undefined, to: string, o: Partial<Run> = {}) =>
  run({ id, accountId: to, callerPid: 100, callerStartedAt: 5000, callerKind: "Terminal", ...(from === undefined ? {} : { callerAccountId: from }), createdAt: NOW - HOUR, ...o });
const sample = [via(1, "personal", "work", { status: "running" }), via(2, "personal", "work", { createdAt: NOW - 2 * HOUR }), via(3, "work", "side", { status: "failed" })];

const html = (s: Partial<AppState>) => renderToStaticMarkup(createElement(MapView, { state: appState({ accounts, ...s }), now: NOW, onOpenAccount: () => {} }));

test("the map: every account, one pill per edge with its counts, live and failed edges", () => {
  const h = html({ runs: sample });
  for (const t of ["Personal", "Work", "Side project", "2 runs · 1 running", "1 run · 1 failed"]) expect(h).toContain(t);
  expect(h).toMatch(/class="edge live"/);
  expect(h).toMatch(/class="edge fail"/);
  expect(h).toContain('viewBox="0 0 720 420"');
  expect(h).not.toContain("No delegated runs");
  expect(h).not.toContain("Unknown caller");
});

test("every node and edge is a focusable button with a label", () => {
  const h = html({ runs: sample });
  expect(h.match(/<g[^>]*role="button"[^>]*tabindex="0"/g)).toHaveLength(3 + 2);
  expect(h).toContain('aria-label="Personal → Work: 2 runs · 1 running"');
});

test("a node shows how many sessions are open and the 5h bar in the lane colours", () => {
  const h = html({
    runs: sample,
    sessions: [{ pid: 1, kind: "Terminal", accountId: "personal", startedAt: NOW }, { pid: 2, kind: "Terminal", accountId: "personal", startedAt: NOW }],
    statuses: [status({ accountId: "personal", fiveHour: { usedPct: 95 } }), status({ accountId: "work", fiveHour: { usedPct: 20 } })],
  });
  expect(h).toContain("2 sessions");
  expect(h).toContain("0 sessions");
  expect(h).toMatch(/class="map-fill danger"/);
  expect(h).toMatch(/class="map-fill ok"/);
});

test("no delegated runs: a line under the map, no edges", () => {
  const h = html({ runs: [run({ id: 1, accountId: "work", createdAt: NOW - HOUR })] });
  expect(h).toContain("No delegated runs in the last 24 hours.");
  expect(h).not.toMatch(/class="edge/);
  expect(h).toContain("Personal");
});

test("a caller of unknown account gets the Unknown caller node", () => {
  expect(html({ runs: [via(1, undefined, "work")] })).toContain("Unknown caller");
});

test("an account delegating to itself: a pill under the node", () => {
  expect(html({ runs: [via(1, "work", "work")] })).toContain("1 to itself");
});

test("account names are text, not markup", () => {
  const h = html({ accounts: [account({ id: "a", name: "<b>A</b>" })] });
  expect(h).not.toContain("<b>A</b>");
  expect(h).toContain("&lt;b&gt;A&lt;/b&gt;");
});
