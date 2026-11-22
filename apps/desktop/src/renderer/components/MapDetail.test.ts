import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Run } from "@aolangai/core";
import type { OpenSession } from "../../shared/api.js";
import { account, appState, run } from "../testing.js";
import { MapDetail } from "./MapDetail.js";

const NOW = new Date(2026, 10, 17, 12, 0).getTime();
const HOUR = 3_600_000;
const accounts = [account({ id: "personal", name: "Personal" }), account({ id: "work", name: "Work" }), account({ id: "side", name: "Side project" })];
const notes: OpenSession = { pid: 100, kind: "Terminal", accountId: "personal", tty: "ttys001", name: "notes", startedAt: 5000 };
const app: OpenSession = { pid: 200, kind: "other", accountId: "personal", name: "app", startedAt: 6000 };
const via = (id: number, session: OpenSession, to: string, o: Partial<Run> = {}) =>
  run({ id, accountId: to, callerPid: session.pid, callerStartedAt: session.startedAt, callerKind: session.kind, callerAccountId: "personal", createdAt: NOW - HOUR, ...o });
const state = appState({
  accounts,
  sessions: [notes, app],
  runs: [
    via(47, notes, "work", { label: "parser tests", status: "running" }),
    via(46, notes, "work", { label: "archived_at", createdAt: NOW - 2 * HOUR }),
    via(44, app, "side", { label: "rename outDir", createdAt: NOW - 3 * HOUR }),
    run({ id: 40, accountId: "side", label: "not delegated", createdAt: NOW - HOUR }),
  ],
});
const noop = () => {};
const html = (to?: string) =>
  renderToStaticMarkup(createElement(MapDetail, { state, now: NOW, accountId: "personal", to, onBack: noop, onOpenRun: noop, onFocusSession: noop }));

test("an account's detail: its caller sessions on the left, the runs they started grouped by worker", () => {
  const h = html();
  for (const t of ["← Map", "Runs started from Personal", "Personal · notes", "Personal · app", "on Work", "on Side project", "parser tests", "archived_at", "rename outDir"]) {
    expect(h).toContain(t);
  }
  expect(h).not.toContain("not delegated");
  expect(h.match(/class="run-row /g)).toHaveLength(3);
});

test("Switch to only for a caller session that can be brought forward", () => {
  expect(html().match(/>Switch to</g)).toHaveLength(1);
});

test("an edge's detail: only the runs on that worker", () => {
  const h = html("work");
  expect(h).toContain("Personal → Work");
  expect(h).not.toContain("Runs started from");
  expect(h).toContain("on Work");
  expect(h).not.toContain("on Side project");
  expect(h).not.toContain("rename outDir");
  expect(h).not.toContain("Personal · app");
});
