import { expect, test } from "vitest";
import { DESKTOP_KIND, OTHER_KIND, type OpenSession } from "../../shared/api.js";
import { account, appState } from "../testing.js";
import { lanes } from "./runs.js";
import { focusHint, outside, summarize } from "./sessions.js";

const T = new Date(2026, 10, 17, 12, 27).getTime();
const s = (o: Partial<OpenSession> = {}): OpenSession => ({ pid: 1, kind: "Terminal", accountId: "a1", startedAt: T, ...o });

test("summarize: most sessions first, then by name", () => {
  expect(summarize([s(), s({ pid: 2 }), s({ pid: 3, kind: "VS Code" })])).toBe("2 Terminal · 1 VS Code");
  expect(summarize([s({ kind: "Terminal" }), s({ pid: 2, kind: "iTerm" })])).toBe("1 iTerm · 1 Terminal");
  expect(summarize([])).toBe("");
});

test("focusHint: a Terminal session with a tty picks the exact window", () => {
  expect(focusHint(s({ tty: "ttys015", appPath: "/System/Applications/Utilities/Terminal.app" }))).toBe("Bring the Terminal window of this session to the front");
});

test("focusHint: another app, or Terminal without a tty, only brings the app to the front", () => {
  expect(focusHint(s({ kind: "VS Code", appPath: "/Applications/Visual Studio Code.app" }))).toBe("Bring VS Code to the front (cannot pick the exact window)");
  expect(focusHint(s({ appPath: "/System/Applications/Utilities/Terminal.app" }))).toBe("Bring Terminal to the front (cannot pick the exact window)");
  expect(focusHint(s({ kind: DESKTOP_KIND, appPath: "/Applications/Claude.app", accountId: undefined }))).toBe("Bring Claude desktop to the front (cannot pick the exact window)");
});

test("focusHint: an invalid tty counts as no tty; the other kind has no button", () => {
  expect(focusHint(s({ tty: "../x", appPath: "/System/Applications/Utilities/Terminal.app" }))).toBe("Bring Terminal to the front (cannot pick the exact window)");
  expect(focusHint(s({ kind: OTHER_KIND }))).toBeUndefined();
  expect(focusHint(s({ kind: OTHER_KIND, tty: "ttys015" }))).toBeUndefined();
  expect(focusHint(s())).toBeUndefined();
});

test("outside: desktop, unknown account, and sessions that already have a lane", () => {
  const state = appState({
    accounts: [account({ id: "a1" })],
    sessions: [
      s({ pid: 1, kind: DESKTOP_KIND, accountId: undefined }),
      s({ pid: 2, accountId: undefined }),
      s({ pid: 3, accountId: "gone" }),
      s({ pid: 4, kind: OTHER_KIND, accountId: "a1" }),
    ],
  });
  const out = outside(state);
  expect(out.desktop.map((x) => x.pid)).toEqual([1]);
  expect(out.unknown.map((x) => x.pid)).toEqual([2, 3]);
});

test("lanes: each lane gets only the sessions of its own account", () => {
  const state = appState({
    accounts: [account({ id: "a1", name: "A" }), account({ id: "b1", name: "B" })],
    sessions: [s({ pid: 1, accountId: "a1" }), s({ pid: 2, accountId: "b1" }), s({ pid: 3, accountId: "a1" }), s({ pid: 4, accountId: undefined })],
  });
  const [a, b] = lanes(state);
  expect(a!.sessions.map((x) => x.pid)).toEqual([1, 3]);
  expect(b!.sessions.map((x) => x.pid)).toEqual([2]);
});

test("outside: a Claude desktop session with an accountId belongs to a lane, no longer in Outside the lanes", () => {
  const state = appState({
    accounts: [account({ id: "a1" })],
    sessions: [s({ pid: 1, kind: DESKTOP_KIND, accountId: "a1" }), s({ pid: 2, kind: DESKTOP_KIND, accountId: undefined })],
  });
  const out = outside(state);
  expect(out.desktop.map((x) => x.pid)).toEqual([2]);
  expect(out.unknown).toEqual([]);
});

test("lanes: a Claude desktop session with an accountId goes into that lane", () => {
  const state = appState({
    accounts: [account({ id: "a1", name: "A" }), account({ id: "b1", name: "B" })],
    sessions: [s({ pid: 1, kind: DESKTOP_KIND, accountId: "b1" }), s({ pid: 2, kind: DESKTOP_KIND, accountId: undefined })],
  });
  const [a, b] = lanes(state);
  expect(a!.sessions).toEqual([]);
  expect(b!.sessions.map((x) => x.pid)).toEqual([1]);
  expect(outside(state).desktop.map((x) => x.pid)).toEqual([2]);
});
