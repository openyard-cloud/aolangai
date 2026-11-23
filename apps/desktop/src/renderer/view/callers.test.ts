import { expect, test } from "vitest";
import { DESKTOP_KIND, type OpenSession } from "../../shared/api.js";
import { account, appState, run } from "../testing.js";
import { callerOf } from "./callers.js";

const session = (o: Partial<OpenSession> = {}): OpenSession => ({ pid: 100, kind: "Terminal", startedAt: 5000, ...o });
const caller = { callerPid: 100, callerStartedAt: 5000, callerKind: "Terminal", callerAccountId: "personal" };
const accounts = [account({ id: "personal", name: "Personal" }), account({ id: "work", name: "Work" })];

test("callerOf: the open session with the same pid and start names the place", () => {
  const s = appState({ accounts, sessions: [session({ name: "notes", cwd: "/Users/x/Projects/demo" })] });
  expect(callerOf(run(caller), s)).toEqual({
    accountId: "personal",
    accountName: "Personal",
    session: s.sessions[0],
    place: "notes",
    label: "Personal · notes",
    key: "100:5000",
  });
});

test("callerOf: a session without a name falls back to its folder", () => {
  const s = appState({ accounts, sessions: [session({ cwd: "/Users/x/Projects/demo" })] });
  expect(callerOf(run(caller), s)?.label).toBe("Personal · demo");
});

test("callerOf: the same pid with another start time is another process, so the place is the kind", () => {
  const s = appState({ accounts, sessions: [session({ startedAt: 9999, name: "notes" })] });
  const c = callerOf(run(caller), s);
  expect(c?.session).toBeUndefined();
  expect(c?.place).toBe("Terminal");
  expect(c?.label).toBe("Personal · Terminal");
});

test("callerOf: a desktop caller takes the account declared for Claude desktop", () => {
  const s = appState({ accounts, desktopAccountId: "work" });
  const c = callerOf(run({ callerPid: 7, callerStartedAt: 8, callerKind: DESKTOP_KIND, callerAccountId: "personal" }), s);
  expect(c).toMatchObject({ accountId: "work", accountName: "Work", place: DESKTOP_KIND, key: "7:8" });
});

test("callerOf: a desktop caller with no declared account is an unknown account", () => {
  const c = callerOf(run({ callerPid: 7, callerStartedAt: 8, callerKind: DESKTOP_KIND }), appState({ accounts }));
  expect(c?.accountId).toBeUndefined();
  expect(c?.accountName).toBe("unknown account");
});

test("callerOf: a deleted account and an API-key caller are both an unknown account", () => {
  const s = appState({ accounts });
  const deleted = callerOf(run({ ...caller, callerAccountId: "gone" }), s);
  expect(deleted?.accountId).toBeUndefined();
  expect(deleted?.label).toBe("unknown account · Terminal");
  const apiKey = callerOf(run({ callerPid: 100, callerStartedAt: 5000, callerKind: "Terminal" }), s);
  expect(apiKey?.accountId).toBeUndefined();
  expect(apiKey?.accountName).toBe("unknown account");
});

test("callerOf: undefined when the run records no caller", () => {
  const s = appState({ accounts });
  expect(callerOf(run(), s)).toBeUndefined();
  expect(callerOf(run({ callerPid: 100, callerKind: "Terminal" }), s)).toBeUndefined();
});
