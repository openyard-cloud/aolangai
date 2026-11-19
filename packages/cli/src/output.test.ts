import { describe, expect, it } from "vitest";
import type { Account, AccountStatus, Exclusion, Run } from "@aolangai/core";
import {
  clock,
  doneStdout,
  duration,
  failedLine,
  goneLine,
  limitedLine,
  notRunningLine,
  refusalLines,
  signalledAllLine,
  signalledLine,
  startLine,
  statusReport,
  statusText,
  stoppedLine,
} from "./output.js";

const at = (h: number, m: number) => new Date(2030, 0, 15, h, m, 0).getTime();
const MIN = 60_000;

describe("clock and duration", () => {
  it("clock is local, 24-hour, zero padded", () => {
    expect(clock(at(14, 0))).toBe("14:00");
    expect(clock(at(7, 5))).toBe("07:05");
    expect(clock(at(0, 9))).toBe("00:09");
    expect(clock(at(23, 59))).toBe("23:59");
  });
  it("duration in seconds, minutes, hours and minutes", () => {
    expect(duration(0)).toBe("0 seconds");
    expect(duration(40_000)).toBe("40 seconds");
    expect(duration(59_999)).toBe("59 seconds");
    expect(duration(60_000)).toBe("1 minute");
    expect(duration(3 * MIN + 20_000)).toBe("3 minutes");
    expect(duration(59 * MIN)).toBe("59 minutes");
    expect(duration(65 * MIN)).toBe("1 hour 5 minutes");
    expect(duration(60 * MIN)).toBe("1 hour");
    expect(duration(125 * MIN)).toBe("2 hours 5 minutes");
    expect(duration(-5000)).toBe("0 seconds");
  });
});

describe("run lines", () => {
  it("start: new session, resumed session, note", () => {
    expect(startLine({ runId: 14, accountName: "Claude B" })).toBe("[aolangai] run #14 · account Claude B · new session");
    expect(startLine({ runId: 14, accountName: "Claude B", sessionId: "11111111-2222-3333-4444-555555555555" })).toBe(
      "[aolangai] run #14 · account Claude B · continuing session 11111111",
    );
    expect(startLine({ runId: 3, accountName: "A", note: "Using old quota numbers from 13:40" })).toBe(
      "[aolangai] run #3 · account A · new session · Using old quota numbers from 13:40",
    );
    expect(startLine({ runId: 3, accountName: "A", sessionId: "abcdef0123", note: "n" })).toBe("[aolangai] run #3 · account A · continuing session abcdef01 · n");
  });
  it("start keeps one line even if the note has line breaks", () => {
    expect(startLine({ runId: 1, accountName: "A", note: "a\nb" })).not.toContain("\n");
  });

  it("done: the answer and one final newline", () => {
    expect(doneStdout("all done", undefined)).toBe("all done\n");
    expect(doneStdout("all done\n\n\n", [])).toBe("all done\n");
    expect(doneStdout("line 1\nline 2  ", undefined)).toBe("line 1\nline 2\n");
  });
  it("done: leading whitespace of the answer is kept", () => {
    expect(doneStdout("  indented\ntwo", undefined)).toBe("  indented\ntwo\n");
  });
  it("done: denials after a blank line", () => {
    expect(doneStdout("result", ["Bash(npm run migrate)", "Edit(a.ts)"])).toBe(
      "result\n\n[aolangai] Permission denied: Bash(npm run migrate); Edit(a.ts)\n",
    );
  });
  it("done: no answer and no denials prints nothing; denials alone stand alone", () => {
    expect(doneStdout(undefined, undefined)).toBe("");
    expect(doneStdout("", [])).toBe("");
    expect(doneStdout("", ["Bash(x)"])).toBe("[aolangai] Permission denied: Bash(x)\n");
  });

  it("failed, limited, stopped", () => {
    expect(failedLine(14, "Timed out after 30 minutes")).toBe("[aolangai] run #14 failed: Timed out after 30 minutes");
    expect(failedLine(14, "line 1\n  line 2\r\nline 3")).toBe("[aolangai] run #14 failed: line 1 line 2 line 3");
    expect(limitedLine(14, "Claude B")).toBe("[aolangai] run #14 stopped because account Claude B hit its limit. Retry to run on another account.");
    expect(stoppedLine(14)).toBe("[aolangai] run #14 stopped");
  });
});

describe("refusals", () => {
  const none = () => ({ reservePct: 90 });
  const limits = { maxConcurrent: 4, maxRunsPerHour: 30 };
  const now = at(9, 0);
  it("simple codes", () => {
    expect(refusalLines("too-many", "x", undefined, none, limits, now)).toEqual(["[aolangai] 4 runs in progress (maximum 4)"]);
    expect(refusalLines("too-fast", "x", undefined, none, limits, now)).toEqual(["[aolangai] 30 runs delegated in the last 60 minutes (maximum 30)"]);
    expect(refusalLines("nested", "Delegating is not allowed from inside a run", undefined, none, limits, now)).toEqual([
      "[aolangai] A worker cannot delegate further",
    ]);
  });
  it("too-many and too-fast take their numbers from the limits, never from the message", () => {
    const custom = { maxConcurrent: 2, maxRunsPerHour: 10 };
    expect(refusalLines("too-many", "Runs in progress: 7, maximum 9", undefined, none, custom, now)).toEqual(["[aolangai] 2 runs in progress (maximum 2)"]);
    expect(refusalLines("too-fast", "no numbers here", undefined, none, custom, now)).toEqual(["[aolangai] 10 runs delegated in the last 60 minutes (maximum 10)"]);
  });
  it("bad-cwd and unknown-account use the core message", () => {
    expect(refusalLines("bad-cwd", "No such folder: /x", undefined, none, limits, now)).toEqual(["[aolangai] No such folder: /x"]);
    expect(refusalLines("unknown-account", 'No account named "Z"', undefined, none, limits, now)).toEqual(['[aolangai] No account named "Z"']);
    expect(refusalLines("unknown-account", 'Several accounts are named "Z", cannot tell which to use', undefined, none, limits, now)).toEqual([
      '[aolangai] Several accounts are named "Z", cannot tell which to use',
    ]);
  });
  it("no-account lists one line per account", () => {
    const ex: Exclusion[] = [
      { accountId: "b", name: "Claude B", reason: "blocked", until: at(14, 0) },
      { accountId: "c", name: "Company", reason: "folder" },
      { accountId: "d", name: "Default", reason: "off" },
      { accountId: "x", name: "X", reason: "reserve" },
      { accountId: "y", name: "Y", reason: "not-logged-in" },
      { accountId: "z", name: "Z", reason: "blocked" },
    ];
    const lookup = (id: string) => (id === "x" ? { usedPct: 92.6, reservePct: 90 } : { reservePct: 90 });
    expect(refusalLines("no-account", "No account can take this run", ex, lookup, limits, now)).toEqual([
      "[aolangai] No account can take this run",
      "- Claude B: limited until 14:00",
      "- Company: not allowed in this folder",
      "- Default: not accepting",
      "- X: used 93%, over the reserve of 90%",
      "- Y: not logged in",
      "- Z: limited",
    ]);
  });
  it("a limit that ends on another day names the day: limited until 16 Jan 14:00", () => {
    const ex: Exclusion[] = [
      { accountId: "b", name: "B", reason: "blocked", until: at(14, 0) + 24 * 60 * MIN },
      { accountId: "c", name: "C", reason: "blocked", until: new Date(2030, 1, 3, 7, 5).getTime() },
      { accountId: "d", name: "D", reason: "blocked", until: at(23, 59) },
    ];
    expect(refusalLines("no-account", "m", ex, none, limits, now)).toEqual([
      "[aolangai] m",
      "- B: limited until 16 Jan 14:00",
      "- C: limited until 3 Feb 07:05",
      "- D: limited until 23:59",
    ]);
  });
  it("reserve without a number still reads sensibly", () => {
    expect(refusalLines("no-account", "m", [{ accountId: "x", name: "X", reason: "reserve" }], () => ({ reservePct: 85 }), limits, now)).toEqual([
      "[aolangai] m",
      "- X: over the reserve of 85%",
    ]);
  });
  it("no-account with no accounts at all is just the message", () => {
    expect(refusalLines("no-account", "No account can take this run", [], none, limits, now)).toEqual(["[aolangai] No account can take this run"]);
  });
});

describe("stop lines", () => {
  it("one line per result", () => {
    expect(signalledLine(14)).toBe("[aolangai] Sent the stop signal to run #14");
    expect(notRunningLine(14)).toBe("[aolangai] run #14 is not running");
    expect(goneLine(14)).toBe("[aolangai] run #14: the delegating process was lost, marked as failed");
    expect(signalledAllLine(3)).toBe("[aolangai] Sent the stop signal to 3 runs");
    expect(signalledAllLine(0)).toBe("[aolangai] Sent the stop signal to 0 runs");
    expect(signalledAllLine(1)).toBe("[aolangai] Sent the stop signal to 1 run");
  });
});

describe("status", () => {
  const acct = (id: string, name: string, over: Partial<Account> = {}): Account => ({ id, name, accepting: true, allowedDirs: [], reservePct: 90, ...over });
  const run = (id: number, accountId: string, over: Partial<Run> = {}): Run => ({
    id, prompt: "p", cwd: "/Users/x/Projects/aolangai-test", accountId, primaryWorker: true, readOnly: false, status: "running", createdAt: 0, ...over,
  });
  const now = at(12, 0);

  it("one line per account, then the running runs", () => {
    const accounts = [acct("b", "Claude B"), acct("a", "Default", { accepting: false })];
    const statuses: AccountStatus[] = [{ accountId: "b", fiveHour: { usedPct: 12 }, sevenDay: { usedPct: 3 } }];
    const running = [run(14, "b", { label: "add login tests", createdAt: now - 3 * MIN - 5000 })];
    const text = statusText(statusReport(accounts, statuses, running, now), now);
    expect(text).toEqual([
      "Claude B  accepting  5h 12% · week 3%  running 1",
      "Default  not accepting  no data yet  running 0",
      '#14 Claude B aolangai-test 3 minutes "add login tests"',
    ]);
  });
  it("windows without data are omitted; percentages are rounded; models listed", () => {
    const accounts = [acct("b", "B"), acct("c", "C"), acct("d", "D")];
    const statuses: AccountStatus[] = [
      { accountId: "b", sevenDay: { usedPct: 3.4 } },
      { accountId: "c", fiveHour: { usedPct: 0 }, models: [{ name: "Fable", usedPct: 40.5 }] },
      { accountId: "d", quotaAt: now },
    ];
    expect(statusText(statusReport(accounts, statuses, [], now), now)).toEqual([
      "B  accepting  week 3%  running 0",
      "C  accepting  5h 0% · Fable 41%  running 0",
      "D  accepting  no data yet  running 0",
    ]);
  });
  it("a blocked account shows until when; an expired limit shows nothing", () => {
    const accounts = [acct("b", "B"), acct("c", "C"), acct("d", "D"), acct("e", "E")];
    const statuses: AccountStatus[] = [
      { accountId: "b", fiveHour: { usedPct: 100 }, limit: { message: "m", until: at(14, 0), at: now - MIN } },
      { accountId: "c", fiveHour: { usedPct: 10 }, limit: { message: "m", until: now - MIN, at: now - 60 * MIN } },
      { accountId: "d", fiveHour: { usedPct: 10 }, limit: { message: "m", at: now - MIN } },
      { accountId: "e", fiveHour: { usedPct: 10 }, limit: { message: "m", at: now - 90 * MIN } },
    ];
    expect(statusText(statusReport(accounts, statuses, [], now), now)).toEqual([
      "B  accepting  5h 100%  limited until 14:00  running 0",
      "C  accepting  5h 10%  running 0",
      "D  accepting  5h 10%  limited  running 0",
      "E  accepting  5h 10%  running 0",
    ]);
  });
  it("a limit that ends on another day names the day", () => {
    const statuses: AccountStatus[] = [{ accountId: "b", sevenDay: { usedPct: 100 }, limit: { message: "m", until: new Date(2030, 0, 18, 8, 0).getTime(), at: now - MIN } }];
    expect(statusText(statusReport([acct("b", "B")], statuses, [], now), now)).toEqual(["B  accepting  week 100%  limited until 18 Jan 08:00  running 0"]);
  });
  it("a run without a label has no quoted part; a lost account falls back to its id; newlines in labels are flattened", () => {
    const text = statusText(
      statusReport([acct("b", "B")], [], [run(1, "b", { createdAt: now - 40_000 }), run(2, "gone", { createdAt: now - 65 * MIN, label: "a\nb" })], now),
      now,
    );
    expect(text.slice(1)).toEqual(["#1 B aolangai-test 40 seconds", '#2 gone aolangai-test 1 hour 5 minutes "a b"']);
  });
  it("no accounts", () => {
    expect(statusText(statusReport([], [], [], now), now)).toEqual(["No accounts yet"]);
  });
  it("the json model has stable field names", () => {
    const accounts = [acct("b", "Claude B")];
    const statuses: AccountStatus[] = [
      {
        accountId: "b",
        fiveHour: { usedPct: 12, resetsAt: now + MIN },
        sevenDay: { usedPct: 3 },
        models: [{ name: "Fable", usedPct: 40 }],
        limit: { message: "m", until: now + 10 * MIN, at: now },
      },
    ];
    const running = [run(14, "b", { label: "x", createdAt: now - MIN })];
    expect(statusReport(accounts, statuses, running, now)).toEqual({
      accounts: [
        {
          id: "b",
          name: "Claude B",
          accepting: true,
          usedPct: 40,
          fiveHour: { usedPct: 12, resetsAt: now + MIN },
          sevenDay: { usedPct: 3 },
          models: [{ name: "Fable", usedPct: 40 }],
          limit: { message: "m", until: now + 10 * MIN },
          running: 1,
        },
      ],
      running: [{ id: 14, accountId: "b", account: "Claude B", cwd: "/Users/x/Projects/aolangai-test", label: "x", startedAt: now - MIN }],
    });
  });
  it("the json model uses null, never a missing field, for what is unknown", () => {
    const r = statusReport([acct("b", "B")], [], [run(1, "b")], now);
    expect(r.accounts[0]).toEqual({ id: "b", name: "B", accepting: true, usedPct: null, fiveHour: null, sevenDay: null, models: [], limit: null, running: 1 });
    expect(r.running[0]!.label).toBeNull();
  });
});
