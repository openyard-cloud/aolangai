import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Account } from "../types.js";
import { callerAccount, findCaller, type PsRun } from "./caller.js";

const HOME = "/fake/home";
beforeEach(() => vi.stubEnv("HOME", HOME));
afterEach(() => vi.unstubAllEnvs());

interface Row {
  pid: number;
  ppid: number;
  comm: string;
  /** Command line, as `ps -o args=` would print it; only asked for on `node` processes. */
  args?: string;
}

const startOf = (pid: number) => Date.UTC(2026, 10, 18, 5, 0, pid % 60);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function lstart(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** A fake ps over a table; records every call so a test can see what was asked for. */
function fakePs(rows: Row[]): PsRun & { calls: string[][] } {
  const run = ((args: string[]) => {
    run.calls.push(args);
    const row = rows.find((r) => r.pid === Number(args[args.indexOf("-p") + 1]));
    if (!row) return "";
    if (args.includes("-ww")) return row.args === undefined ? "" : `${row.pid} ${row.args}\n`;
    return `${String(row.pid).padStart(6)} ${String(row.ppid).padStart(6)} 501 ttys001 ${lstart(startOf(row.pid))} ${row.comm}\n`;
  }) as PsRun & { calls: string[][] };
  run.calls = [];
  return run;
}

const TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
const CLAUDE = "/Users/x/.local/bin/claude";
const terminalChain = (): Row[] => [
  { pid: 100, ppid: 90, comm: "node" },
  { pid: 90, ppid: 80, comm: "/bin/zsh" },
  { pid: 80, ppid: 70, comm: CLAUDE },
  { pid: 70, ppid: 60, comm: "/bin/zsh" },
  { pid: 60, ppid: 50, comm: "/usr/bin/login" },
  { pid: 50, ppid: 1, comm: TERMINAL },
  { pid: 1, ppid: 0, comm: "/sbin/launchd" },
];
const account = (id: string, configDir?: string): Account => ({ id, name: id, configDir, accepting: true, allowedDirs: [], reservePct: 90 });
const accounts = [account("p"), account("w", "~/.claude-work")];

test("finds the claude two levels up, in Terminal, on the default account", () => {
  const ps = fakePs(terminalChain());
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps })).toEqual({ pid: 80, startedAt: startOf(80), kind: "Terminal", accountId: "p" });
  // The command line of a process is only asked for when it is `node`: here never (self is not a candidate).
  expect(ps.calls.filter((a) => a.includes("-ww"))).toEqual([]);
});

test("reads the account from CLAUDE_CONFIG_DIR", () => {
  const env = { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work/` };
  expect(findCaller({ selfPid: 100, env, accounts, ps: fakePs(terminalChain()) })?.accountId).toBe("w");
});

test("an API key leaves the account unknown", () => {
  const caller = findCaller({ selfPid: 100, env: { ANTHROPIC_API_KEY: "x" }, accounts, ps: fakePs(terminalChain()) });
  expect(caller).toMatchObject({ pid: 80, kind: "Terminal" });
  expect(caller?.accountId).toBeUndefined();
});

test("a node ancestor counts only when its command line is Claude Code", () => {
  const chain = (args: string): Row[] => [
    { pid: 100, ppid: 90, comm: "/bin/zsh" },
    { pid: 90, ppid: 80, comm: "/bin/zsh" },
    { pid: 80, ppid: 50, comm: "/opt/homebrew/bin/node", args },
    { pid: 50, ppid: 1, comm: TERMINAL },
  ];
  const ps = fakePs(chain("node /x/@anthropic-ai/claude-code/cli.js --resume"));
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps })).toMatchObject({ pid: 80, kind: "Terminal" });
  expect(ps.calls.filter((a) => a.includes("-ww"))).toEqual([["-ww", "-o", "pid=,args=", "-p", "80"]]);
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps: fakePs(chain("node server.js")) })).toBeUndefined();
});

test("a Claude desktop caller has no account", () => {
  const rows: Row[] = [
    { pid: 100, ppid: 90, comm: "/bin/zsh" },
    { pid: 90, ppid: 80, comm: CLAUDE },
    { pid: 80, ppid: 50, comm: "/Applications/Claude.app/Contents/MacOS/Claude" },
    { pid: 50, ppid: 1, comm: "/sbin/launchd" },
  ];
  const caller = findCaller({ selfPid: 100, env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` }, accounts, ps: fakePs(rows) });
  expect(caller).toMatchObject({ pid: 90, kind: "Claude desktop" });
  expect(caller?.accountId).toBeUndefined();
});

test("no claude ancestor: undefined", () => {
  const rows = terminalChain().map((r) => (r.pid === 80 ? { ...r, comm: "/usr/bin/vim" } : r));
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps: fakePs(rows) })).toBeUndefined();
});

test("a ppid cycle: undefined", () => {
  const rows: Row[] = [
    { pid: 100, ppid: 90, comm: "/bin/zsh" },
    { pid: 90, ppid: 80, comm: "/bin/zsh" },
    { pid: 80, ppid: 90, comm: "/bin/zsh" },
  ];
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps: fakePs(rows) })).toBeUndefined();
});

test("a ps that returns undefined: undefined", () => {
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps: () => undefined })).toBeUndefined();
});

test("an unknown self pid: undefined", () => {
  expect(findCaller({ selfPid: 999, env: {}, accounts, ps: fakePs(terminalChain()) })).toBeUndefined();
});

test("maxDepth caps the walk: the claude at depth 4 is found with 4, not with 3", () => {
  const rows: Row[] = [
    { pid: 100, ppid: 90, comm: "/bin/zsh" },
    { pid: 90, ppid: 80, comm: "/bin/zsh" },
    { pid: 80, ppid: 70, comm: "/bin/zsh" },
    { pid: 70, ppid: 60, comm: "/bin/zsh" },
    { pid: 60, ppid: 50, comm: CLAUDE },
    { pid: 50, ppid: 1, comm: TERMINAL },
  ];
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps: fakePs(rows), maxDepth: 3 })).toBeUndefined();
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps: fakePs(rows), maxDepth: 4 })).toMatchObject({ pid: 60 });
});

test("ps throwing: undefined", () => {
  const ps: PsRun = () => {
    throw new Error("boom");
  };
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps })).toBeUndefined();
});

test("the walk stops at launchd: pid 1 is never asked for", () => {
  const ps = fakePs(terminalChain().map((r) => (r.pid === 80 ? { ...r, comm: "/usr/bin/vim" } : r)));
  findCaller({ selfPid: 100, env: {}, accounts, ps });
  expect(ps.calls.some((a) => a.includes("-p") && a[a.indexOf("-p") + 1] === "1")).toBe(false);
});

/** A ps over `rows` with a clock that moves 100 ms on every call. */
function slowPs(rows: Row[]) {
  const clock = { t: 0 };
  const inner = fakePs(rows);
  const ps: PsRun = (args) => {
    clock.t += 100;
    return inner(args);
  };
  return { ps, now: () => clock.t, calls: inner.calls };
}

test("the deadline passing before the caller is found: undefined, and no ps call after it", () => {
  const { ps, now, calls } = slowPs(terminalChain());
  // Calls start at 0 and 100 ms; the third (pid 80, the claude) would start at 200 ms, past the 150 ms budget.
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps, now, budgetMs: 150 })).toBeUndefined();
  expect(calls).toHaveLength(2);
});

test("the deadline passing while ancestors are collected: the caller, with the kind from the partial chain", () => {
  const { ps, now, calls } = slowPs(terminalChain());
  // Calls at 0, 100 and 200 ms find the claude (pid 80); its ancestors up to Terminal would need three more.
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps, now, budgetMs: 250 })).toEqual({ pid: 80, startedAt: startOf(80), kind: "other", accountId: "p" });
  expect(calls).toHaveLength(3);
  // With room for the whole chain, the same walk reaches Terminal.
  const roomy = slowPs(terminalChain());
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps: roomy.ps, now: roomy.now, budgetMs: 1000 })?.kind).toBe("Terminal");
});

test("the deadline also bounds the command-line lookup of a node ancestor", () => {
  const rows: Row[] = [
    { pid: 100, ppid: 90, comm: "/bin/zsh" },
    { pid: 90, ppid: 80, comm: "/opt/homebrew/bin/node", args: "node /x/@anthropic-ai/claude-code/cli.js" },
    { pid: 80, ppid: 1, comm: TERMINAL },
  ];
  const { ps, now, calls } = slowPs(rows);
  // Calls at 0 and 100 ms; the `-ww` lookup of pid 90 would start at 200 ms.
  expect(findCaller({ selfPid: 100, env: {}, accounts, ps, now, budgetMs: 150 })).toBeUndefined();
  expect(calls.some((a) => a.includes("-ww"))).toBe(false);
});

test("callerAccount: a present variable counts even when empty or blank", () => {
  expect(callerAccount({ CLAUDE_CONFIG_DIR: "" }, accounts)).toBeUndefined();
  expect(callerAccount({ CLAUDE_CONFIG_DIR: "  " }, accounts)).toBeUndefined();
  expect(callerAccount({ ANTHROPIC_API_KEY: "" }, accounts)).toBeUndefined();
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    expect(callerAccount({ [name]: "x" }, accounts)).toBeUndefined();
  }
  expect(callerAccount({ CLAUDE_CONFIG_DIR: `${HOME}/.elsewhere` }, accounts)).toBeUndefined();
  expect(callerAccount({}, [account("w", "~/.claude-work")])).toBeUndefined();
});

test("callerAccount: CLAUDE_CONFIG_DIR set to ~/.claude is never the account without a configDir", () => {
  expect(callerAccount({ CLAUDE_CONFIG_DIR: `${HOME}/.claude` }, accounts)).toBeUndefined();
  expect(callerAccount({ CLAUDE_CONFIG_DIR: `${HOME}/.claude` }, [...accounts, account("e", "~/.claude")])).toBe("e");
});

test("callerAccount: a literal ~ in the value is not expanded", () => {
  expect(callerAccount({ CLAUDE_CONFIG_DIR: "~/.claude-work" }, accounts)).toBeUndefined();
});
