import { expect, test } from "vitest";
import { callerOfRun, type Run } from "./types.js";

const run = (over: Partial<Run> = {}): Run => ({
  id: 1, prompt: "x", cwd: "/p", accountId: "a", primaryWorker: true, readOnly: false, status: "done", createdAt: 1,
  callerPid: 41, callerStartedAt: 1_700_000_000_000, callerKind: "Terminal", callerAccountId: "a1", ...over,
});

test("callerOfRun: all four fields", () => {
  expect(callerOfRun(run())).toEqual({ pid: 41, startedAt: 1_700_000_000_000, kind: "Terminal", accountId: "a1" });
});

test("callerOfRun: no accountId key when the session's account is unknown", () => {
  const c = callerOfRun(run({ callerAccountId: undefined }));
  expect(c).toEqual({ pid: 41, startedAt: 1_700_000_000_000, kind: "Terminal" });
  expect(c).not.toHaveProperty("accountId");
});

test("callerOfRun: undefined when pid, startedAt or kind is missing", () => {
  expect(callerOfRun(run({ callerPid: undefined }))).toBeUndefined();
  expect(callerOfRun(run({ callerStartedAt: undefined }))).toBeUndefined();
  expect(callerOfRun(run({ callerKind: undefined }))).toBeUndefined();
});
