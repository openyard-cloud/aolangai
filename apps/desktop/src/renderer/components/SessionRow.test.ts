import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OTHER_KIND, type OpenSession } from "../../shared/api.js";
import { clock, clockOrDate } from "../view/format.js";
import { SessionRow } from "./SessionRow.js";

const T = new Date(2026, 10, 17, 12, 27).getTime();
const term: OpenSession = { pid: 7, kind: "Terminal", startedAt: T, cwd: "/Users/x/Projects/demo", tty: "ttys015", accountId: "a1" };
const NOW = T + 3600_000;
const html = (s: OpenSession, onFocus = () => {}, now = NOW) => renderToStaticMarkup(createElement(SessionRow, { session: s, now, onFocus }));

test("session row: kind, last folder name (full path in the title), start time, Switch to button", () => {
  const h = html(term);
  expect(h).toContain('<div class="session-row">');
  expect(h).toContain("Terminal");
  expect(h).toContain(">demo<");
  expect(h).toContain('title="/Users/x/Projects/demo"');
  expect(h).toContain(`since ${clock(T)}`);
  expect(h).toContain('<button type="button" class="small" title="Bring the Terminal window of this session to the front">Switch to</button>');
});

test("an 'other' session has no button", () => {
  const h = html({ ...term, kind: OTHER_KIND });
  expect(h).not.toContain("<button");
  expect(h).not.toContain("Switch to");
});

test("a session opened on another day shows the date", () => {
  const later = T + 2 * 24 * 3600_000;
  const h = html(term, () => {}, later);
  expect(h).toContain(`since ${clockOrDate(T, later)}`);
  expect(h).toContain("12:27 17 Nov");
});

test("a row without a button still has the fixed last cell so the time column lines up", () => {
  const withButton = html(term);
  const without = html({ ...term, kind: OTHER_KIND });
  expect(withButton).toContain('<span class="session-action"><button');
  expect(without).toContain('<span class="session-action"></span>');
});

test("no cwd means no folder part", () => {
  const h = html({ ...term, cwd: undefined });
  expect(h).not.toContain("session-folder");
  expect(h).not.toContain("title=\"/");
  expect(h).toContain(`since ${clock(T)}`);
});

type Node = { type?: unknown; props?: { onClick?: () => void; children?: Node | Node[] } } | string | null | undefined | false;
/** The first element of this type in a React element tree (the row is a plain function component, so it can be called directly). */
function findElement(node: Node | Node[], type: string): Extract<Node, object> | undefined {
  if (Array.isArray(node)) return node.map((n) => findElement(n, type)).find((n) => n !== undefined);
  if (typeof node !== "object" || node === null) return undefined;
  return node.type === type ? node : findElement(node.props?.children, type);
}

test("the button calls onFocus with the session pid", () => {
  const calls: number[] = [];
  const button = findElement(SessionRow({ session: term, now: NOW, onFocus: (pid) => void calls.push(pid) }) as Node, "button");
  button!.props!.onClick!();
  expect(calls).toEqual([7]);
});

test("a folder name containing HTML is just text", () => {
  const h = html({ ...term, cwd: "/x/<img src=x onerror=alert(1)>" });
  expect(h).not.toContain("<img");
  expect(h).toContain("&lt;img");
});

test("with a name: after the kind, before the folder name, in full in the title", () => {
  const h = html({ ...term, name: "aolangai · Claude - Side project" });
  expect(h).toContain('<span class="session-name" title="aolangai · Claude - Side project">aolangai · Claude - Side project</span>');
  expect(h.indexOf("session-kind")).toBeLessThan(h.indexOf("session-name"));
  expect(h.indexOf("session-name")).toBeLessThan(h.indexOf("session-folder"));
});

test("no name means no session-name element", () => {
  expect(html(term)).not.toContain("session-name");
});

test("a name containing HTML is just text", () => {
  const h = html({ ...term, name: "<img src=x onerror=alert(1)>" });
  expect(h).not.toContain("<img");
});
