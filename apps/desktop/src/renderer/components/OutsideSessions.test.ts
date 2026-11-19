import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DESKTOP_KIND, type OpenSession } from "../../shared/api.js";
import { OutsideSessions } from "./OutsideSessions.js";

const T = new Date(2026, 10, 17, 12, 27).getTime();
const desk = (pid: number): OpenSession => ({ pid, kind: DESKTOP_KIND, startedAt: T, cwd: `/Users/x/d${pid}`, appPath: "/Applications/Claude.app" });
const term: OpenSession = { pid: 9, kind: "Terminal", startedAt: T, cwd: "/Users/x/t", tty: "ttys001" };
const html = (desktop: OpenSession[], unknown: OpenSession[]) => renderToStaticMarkup(createElement(OutsideSessions, { desktop, unknown, now: T + 2 * 24 * 3600_000, onFocus: () => {} }));

test("desktop and unknown account: one closed <details>, the summary is the summary line, one row per session in order", () => {
  const h = html([desk(1), desk(2), desk(3), desk(4)], [term]);
  expect(h.match(/<details/g)).toHaveLength(1);
  expect(h).toContain('<details class="outside-sessions">');
  expect(h).not.toMatch(/<details[^>]*\sopen/);
  expect(h).toContain("<summary>Outside the lanes: Claude desktop 4 sessions · unknown account 1 session</summary>");
  expect(h.match(/class="session-row"/g)).toHaveLength(5);
  const order = ["d1", "d2", "d3", "d4", "t"].map((n) => h.indexOf(`title="/Users/x/${n}"`));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(h).not.toContain("Terminal · ");
});

test("a session opened on another day shows the date", () => {
  expect(html([desk(1)], [])).toContain("since 12:27 17 Nov");
});

test("only desktop means no 'unknown account'", () => {
  const h = html([desk(1)], []);
  expect(h).toContain("Outside the lanes: Claude desktop 1 session");
  expect(h).not.toContain("unknown account");
});

test("both empty renders nothing", () => {
  expect(html([], [])).toBe("");
});
