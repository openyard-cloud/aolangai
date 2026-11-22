import { beforeEach, test, expect } from "vitest";
import { callerAccount, type Account } from "@aolangai/core";
import os from "node:os";
import { normalizeConfigDir } from "./accounts.js";
import { DESKTOP_KIND, OTHER_KIND, TITLE_BACKOFF_MS, accountOf, isClaudeCommandLine, parseCwds, parsePs, parseTabTitles, realExec, resetTitleBackoff, scanSessions, sessionHost, sessionKind, sessionName, type Exec, type Proc } from "./sessions.js";

const CLAUDE_BIN = "/Users/x/Library/Application Support/Claude/claude-code/2.1.325/abc/claude.app/Contents/MacOS/claude";
const TERMINAL_APP = "/System/Applications/Utilities/Terminal.app";
const TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
const PS_ARGS = ["-axo", "pid=,ppid=,uid=,tty=,lstart=,comm="];
const UID = 501;

// ---- parsePs

test("parsePs: pid, ppid, tty, lstart (UTC) and a comm with spaces", () => {
  const text = `52956 52955   501 ??       Wed Nov 18 01:40:12 2026     ${CLAUDE_BIN}\n`;
  expect(parsePs(text)).toEqual([{ pid: 52956, ppid: 52955, uid: 501, tty: undefined, startedAt: Date.UTC(2026, 10, 18, 1, 40, 12), comm: CLAUDE_BIN }]);
});

test("parsePs: the tty column is one word; ?? means no tty", () => {
  const [a] = parsePs("10006  9715 501 ttys015 Wed Nov 18 05:27:55 2026     /Users/x/.local/bin/claude\n");
  expect(a).toEqual({ pid: 10006, ppid: 9715, uid: 501, tty: "ttys015", startedAt: Date.UTC(2026, 10, 18, 5, 27, 55), comm: "/Users/x/.local/bin/claude" });
  const [b] = parsePs("10007  9715 0 ??      Wed Nov 18 05:27:55 2026     /Users/x/.local/bin/claude\n");
  expect(b!.tty).toBeUndefined();
});

test("parsePs: garbage lines and empty lines are skipped; a one-digit day is padded", () => {
  const text = ["", "not a process line", "  1     0     0 ??  Sun Nov  8 00:00:05 2026 /sbin/launchd", "12 x 501 ?? Wed Nov 18 01:40:12 2026 bad", "   "].join("\n");
  expect(parsePs(text)).toEqual([{ pid: 1, ppid: 0, uid: 0, tty: undefined, startedAt: Date.UTC(2026, 10, 8, 0, 0, 5), comm: "/sbin/launchd" }]);
});

// ---- sessionKind

const proc = (pid: number, ppid: number, comm: string): Proc => ({ pid, ppid, uid: UID, startedAt: 0, comm });
const table = (...procs: Proc[]) => new Map(procs.map((p) => [p.pid, p]));
const kindOf = (pid: number, ...procs: Proc[]) => {
  const byPid = table(...procs);
  return sessionKind(byPid.get(pid)!, byPid);
};

test("sessionKind: claude ← -zsh ← login ← Terminal is Terminal", () => {
  expect(kindOf(4, proc(1, 0, TERMINAL), proc(2, 1, "login"), proc(3, 2, "-zsh"), proc(4, 3, "claude"))).toBe("Terminal");
});

test("sessionKind: Claude desktop", () => {
  expect(
    kindOf(
      3,
      proc(1, 0, "/Applications/Claude.app/Contents/MacOS/Claude"),
      proc(2, 1, "/Applications/Claude.app/Contents/Helpers/disclaimer"),
      proc(3, 2, CLAUDE_BIN),
    ),
  ).toBe(DESKTOP_KIND);
});

test("sessionKind: VS Code takes the outermost app, not the app nested inside", () => {
  expect(
    kindOf(
      2,
      proc(1, 0, "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"),
      proc(2, 1, "claude"),
    ),
  ).toBe("VS Code");
});

test("sessionKind: iTerm2 shows as iTerm, another app takes the app name", () => {
  expect(kindOf(2, proc(1, 0, "/Applications/iTerm.app/Contents/MacOS/iTerm2"), proc(2, 1, "claude"))).toBe("iTerm");
  expect(kindOf(2, proc(1, 0, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), proc(2, 1, "claude"))).toBe("Ghostty");
});

test("sessionKind: no app among the ancestors is other", () => {
  expect(kindOf(2, proc(1, 1, "tmux"), proc(2, 1, "claude"))).toBe(OTHER_KIND);
  expect(kindOf(2, proc(2, 9, "claude"))).toBe(OTHER_KIND);
});

test("sessionKind: a parent-child loop does not hang", () => {
  expect(kindOf(1, proc(1, 2, "claude"), proc(2, 1, "node"))).toBe(OTHER_KIND);
});

// ---- sessionHost

const hostOf = (pid: number, ...procs: Proc[]) => {
  const byPid = table(...procs);
  return sessionHost(byPid.get(pid)!, byPid);
};

test("sessionHost: kind and path of the outermost app", () => {
  const code = "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)";
  expect(hostOf(2, proc(1, 0, code), proc(2, 1, "claude"))).toEqual({ kind: "VS Code", appPath: "/Applications/Visual Studio Code.app" });
  expect(hostOf(4, proc(1, 0, TERMINAL), proc(2, 1, "login"), proc(3, 2, "-zsh"), proc(4, 3, "claude"))).toEqual({
    kind: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
  });
  expect(hostOf(2, proc(1, 0, "/Applications/Claude.app/Contents/MacOS/Claude"), proc(2, 1, "claude"))).toEqual({
    kind: DESKTOP_KIND,
    appPath: "/Applications/Claude.app",
  });
});

test("sessionHost: tmux and no ancestor is other, without an appPath", () => {
  expect(hostOf(2, proc(1, 1, "tmux"), proc(2, 1, "claude"))).toEqual({ kind: OTHER_KIND });
  expect(hostOf(2, proc(1, 1, "tmux"), proc(2, 1, "claude")).appPath).toBeUndefined();
  expect(hostOf(2, proc(2, 9, "claude"))).toEqual({ kind: OTHER_KIND });
});

// ---- accountOf

const PROFILES = "/h/Library/Application Support/aolangai/profiles";
const ACCOUNTS = [{ id: "d" }, { id: "a", configDir: `${PROFILES}/a` }, { id: "ab", configDir: `${PROFILES}/ab` }];
const CMD = "claude --resume x";

test("accountOf: no CLAUDE_CONFIG_DIR is the default account", () => {
  expect(accountOf(`${CMD} TERM=xterm HOME=/h`, ACCOUNTS)).toBe("d");
});

test("accountOf: matches the longest folder, even when another folder starts the same way", () => {
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${PROFILES}/ab TERM=xterm`, ACCOUNTS)).toBe("ab");
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${PROFILES}/a TERM=xterm`, ACCOUNTS)).toBe("a");
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${PROFILES}/a/`, ACCOUNTS)).toBe("a");
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${PROFILES}/a/ TERM=x`, ACCOUNTS)).toBe("a");
});

test("accountOf: a folder that belongs to no account is unknown", () => {
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${PROFILES}/abc TERM=x`, ACCOUNTS)).toBeUndefined();
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${PROFILES}/a/b TERM=x`, ACCOUNTS)).toBeUndefined();
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=/elsewhere`, ACCOUNTS)).toBeUndefined();
});

test("accountOf: using an API key or token belongs to no account", () => {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${PROFILES}/a ${name}=sk-x`, ACCOUNTS)).toBeUndefined();
    expect(accountOf(`${CMD} ${name}=sk-x TERM=x`, ACCOUNTS)).toBeUndefined();
  }
});

test("accountOf: a variable name that is only part of another name does not count", () => {
  expect(accountOf(`${CMD} MY_ANTHROPIC_API_KEY=x`, ACCOUNTS)).toBe("d");
});

test("accountOf: no default account and no variable is unknown", () => {
  expect(accountOf(`${CMD} TERM=xterm`, ACCOUNTS.slice(1))).toBeUndefined();
});

test("accountOf: with CLAUDE_CONFIG_DIR it is never the default account, even when it equals ~/.claude", () => {
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${normalizeConfigDir(undefined)} TERM=x`, ACCOUNTS)).toBeUndefined();
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${normalizeConfigDir(undefined)}`, ACCOUNTS)).toBeUndefined();
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=/elsewhere TERM=x`, [{ id: "d" }])).toBeUndefined();
});

test("accountOf: an account with an explicit folder (even ~/.claude) still matches by the normalized folder", () => {
  const explicit = [{ id: "d" }, { id: "e", configDir: "~/.claude" }];
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=${normalizeConfigDir(undefined)} TERM=x`, explicit)).toBe("e");
});

test("accountOf: a variable name that appears several times (for example in an argument) is unknown", () => {
  expect(accountOf(`claude CLAUDE_CONFIG_DIR=${PROFILES}/a CLAUDE_CONFIG_DIR=${PROFILES}/a TERM=x`, ACCOUNTS)).toBeUndefined();
  expect(accountOf(`claude -p echo CLAUDE_CONFIG_DIR=${PROFILES}/ab CLAUDE_CONFIG_DIR=${PROFILES}/a`, ACCOUNTS)).toBeUndefined();
});

test("accountOf: a path with accented letters matches intact", () => {
  const viet = [{ id: "d" }, { id: "b", configDir: "/Users/x/Dự án/claude-b" }, { id: "bc", configDir: "/Users/x/Dự án/claude-bc" }];
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=/Users/x/Dự án/claude-b TERM=x`, viet)).toBe("b");
  expect(accountOf(`${CMD} CLAUDE_CONFIG_DIR=/Users/x/Dự án/claude-bc`, viet)).toBe("bc");
});

// ---- accountOf and the CLI's callerAccount agree

test("accountOf and callerAccount give the same account for the same environment", () => {
  const home = os.homedir();
  const accounts = [{ id: "d" }, { id: "w", configDir: "~/.claude-work" }, { id: "a", configDir: `${PROFILES}/a` }, { id: "ab", configDir: `${PROFILES}/ab` }];
  const rows: [Record<string, string>, string | undefined][] = [
    [{}, "d"],
    [{ TERM: "xterm" }, "d"],
    [{ CLAUDE_CONFIG_DIR: `${home}/.claude-work` }, "w"],
    [{ CLAUDE_CONFIG_DIR: `${home}/.claude-work/`, TERM: "x" }, "w"],
    [{ CLAUDE_CONFIG_DIR: `${PROFILES}/a` }, "a"],
    [{ CLAUDE_CONFIG_DIR: `${PROFILES}/ab`, TERM: "x" }, "ab"],
    [{ CLAUDE_CONFIG_DIR: `${PROFILES}/abc` }, undefined],
    [{ CLAUDE_CONFIG_DIR: "/elsewhere" }, undefined],
    [{ CLAUDE_CONFIG_DIR: `${home}/.claude` }, undefined],
    [{ CLAUDE_CONFIG_DIR: "~/.claude-work" }, undefined],
    [{ CLAUDE_CONFIG_DIR: "" }, undefined],
    [{ CLAUDE_CONFIG_DIR: "", TERM: "x" }, undefined],
    [{ ANTHROPIC_API_KEY: "" }, undefined],
    [{ CLAUDE_CONFIG_DIR: `${PROFILES}/a`, CLAUDE_CODE_OAUTH_TOKEN: "t" }, undefined],
    [{ ANTHROPIC_AUTH_TOKEN: "t" }, undefined],
  ];
  for (const [env, want] of rows) {
    const ewwText = [CMD, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)].join(" ");
    expect({ env, app: accountOf(ewwText, accounts) }).toEqual({ env, app: want });
    expect({ env, cli: callerAccount(env, accounts) }).toEqual({ env, cli: want });
  }
});

// ---- parseCwds

test("parseCwds: reads the pid and a path with spaces; a pid without an n line is absent", () => {
  const text = "p10006\nfcwd\nn/Users/x/Projects/a b\np24281\nfcwd\n";
  expect(parseCwds(text)).toEqual(new Map([[10006, "/Users/x/Projects/a b"]]));
});

test("parseCwds: a path with accented letters stays intact", () => {
  expect(parseCwds("p10006\nfcwd\nn/Users/x/Dự án/claude-b\n")).toEqual(new Map([[10006, "/Users/x/Dự án/claude-b"]]));
});

// ---- realExec (against node itself, never ps/lsof/claude)

test("realExec: stdout when it exits 0 or 1; undefined on any other exit, a run error or a signal", async () => {
  const node = (code: string) => realExec(process.execPath, ["-e", code]);
  expect(await node("process.stdout.write('ok')")).toBe("ok");
  expect(await node("process.stdout.write('some'); process.exit(1)")).toBe("some");
  expect(await node("process.stdout.write('x'); process.exit(2)")).toBeUndefined();
  expect(await node("process.kill(process.pid, 'SIGKILL')")).toBeUndefined();
  expect(await realExec("/nonexistent/binary", [])).toBeUndefined();
});

test("realExec: LC_CTYPE=UTF-8, LC_TIME=C, TZ=UTC and no inheriting of the app's environment", async () => {
  const out = await realExec(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"]);
  const env = JSON.parse(out!) as Record<string, string>;
  expect(env).toMatchObject({ LC_CTYPE: "UTF-8", LC_TIME: "C", TZ: "UTC" });
  expect(env.HOME).toBeUndefined();
  expect(env.PATH).toBeUndefined();
});

test("realExec: gives up after 2 seconds", async () => {
  expect(await realExec(process.execPath, ["-e", "setTimeout(() => {}, 20000)"])).toBeUndefined();
}, 10_000);

// ---- scanSessions

const when = (sec: number) => `Wed Nov 18 01:40:${String(sec).padStart(2, "0")} 2026`;
const psLine = (pid: number, ppid: number, sec: number, comm: string, tty = "??", uid = UID) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(uid).padStart(5)} ${tty.padEnd(7)} ${when(sec)}     ${comm}`;
const account = (id: string, configDir?: string): Account => ({ id, name: id, configDir, accepting: true, allowedDirs: [], reservePct: 90 });
const ACCS = [account("d"), account("a", `${PROFILES}/a`)];

const PROCS = [
  psLine(1, 0, 0, "/sbin/launchd", "??", 0),
  psLine(100, 1, 1, TERMINAL),
  psLine(101, 100, 1, "login", "??", 0), // owned by root: still needed for the ancestor walk
  psLine(102, 101, 1, "-zsh"),
  psLine(200, 102, 30, "claude", "ttys015"), // session on account a
  psLine(201, 102, 20, "claude", "ttys003"), // session on the default account
  psLine(202, 203, 31, "claude"), // a claude started by session 200
  psLine(203, 200, 31, "node"),
  psLine(300, 1, 1, "/Applications/Claude.app/Contents/MacOS/Claude"),
  psLine(301, 300, 2, "/Applications/Claude.app/Contents/Helpers/disclaimer"),
  psLine(302, 301, 10, CLAUDE_BIN), // Claude desktop session
  psLine(400, 102, 40, "claude"), // one of our workers
  psLine(500, 1, 3, "/Applications/aolangai.app/Contents/MacOS/aolangai"),
  psLine(501, 500, 41, "claude"), // under this app
  psLine(600, 102, 42, "claude", "ttys020", 502), // another user's claude
].join("\n");

const EWW = [
  `  200 claude --resume s CLAUDE_CONFIG_DIR=${PROFILES}/a TERM=xterm SECRET_TOKEN=abc123`,
  "  201 claude TERM=xterm SECRET_TOKEN=abc123",
].join("\n");
const LSOF = "p200\nfcwd\nn/Users/x/Projects/a b\np201\nfcwd\nn/Users/x/other\np302\nfcwd\nn/Users/x/desk\n";

const T0 = Date.UTC(2026, 10, 18, 2, 0, 0);
beforeEach(() => resetTitleBackoff());

const ARGS = "  203 node /Users/x/mcp/server.js --stdio";

function fakeExec(over: { ps?: string | undefined; eww?: string | undefined; lsof?: string | undefined; osa?: string | undefined; args?: string | undefined } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const has = (k: keyof typeof over) => k in over;
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file === "/bin/ps" && args[0] === "-axo") return has("ps") ? over.ps : PROCS;
    if (file === "/bin/ps" && args[0] === "eww") return has("eww") ? over.eww : EWW;
    if (file === "/bin/ps" && args[0] === "-ww") return has("args") ? over.args : ARGS;
    if (file === "/usr/sbin/lsof") return has("lsof") ? over.lsof : LSOF;
    if (file === "/usr/bin/osascript") return over.osa; // the title lookup fails unless a test gives it an answer
    throw new Error(`unexpected command ${file}`);
  };
  return { exec, calls };
}
const scan = (exec: Exec) => scanSessions({ accounts: ACCS, excludePids: [400], selfPid: 500, uid: UID, exec, now: T0 });

test("scanSessions: exactly 3 sessions, with the right kind, account, cwd and the order by startedAt", async () => {
  const { exec } = fakeExec();
  expect(await scan(exec)).toEqual([
    { pid: 302, kind: DESKTOP_KIND, accountId: undefined, cwd: "/Users/x/desk", startedAt: Date.UTC(2026, 10, 18, 1, 40, 10), tty: undefined, appPath: "/Applications/Claude.app" },
    { pid: 201, kind: "Terminal", accountId: "d", cwd: "/Users/x/other", startedAt: Date.UTC(2026, 10, 18, 1, 40, 20), tty: "ttys003", appPath: TERMINAL_APP },
    { pid: 200, kind: "Terminal", accountId: "a", cwd: "/Users/x/Projects/a b", startedAt: Date.UTC(2026, 10, 18, 1, 40, 30), tty: "ttys015", appPath: TERMINAL_APP },
  ]);
});

test("scanSessions: the same startedAt is ordered by pid", async () => {
  const ps = [psLine(102, 1, 1, "-zsh"), psLine(9, 102, 5, "claude"), psLine(7, 102, 5, "claude")].join("\n");
  const { exec } = fakeExec({ ps, eww: "", lsof: "" });
  expect((await scan(exec))!.map((s) => s.pid)).toEqual([7, 9]);
});

test("scanSessions: the Claude desktop session is not in the ps eww command; the commands use absolute paths", async () => {
  const { exec, calls } = fakeExec();
  await scan(exec);
  const eww = calls.filter((c) => c.args[0] === "eww");
  expect(eww).toHaveLength(1);
  expect(eww[0]!.file).toBe("/bin/ps");
  expect(eww[0]!.args).toEqual(["eww", "-o", "pid=,command=", "-p", "201,200"]);
  expect(calls[0]).toEqual({ file: "/bin/ps", args: PS_ARGS });
  expect(calls.find((c) => c.file === "/usr/sbin/lsof")!.args).toEqual(["-a", "-d", "cwd", "-Fpn", "-p", "302,201,200"]);
});

test("scanSessions: does not return the environment content", async () => {
  const { exec } = fakeExec();
  expect(JSON.stringify(await scan(exec))).not.toContain("abc123");
});

test("scanSessions: without claude gives [] and does not call ps eww or lsof", async () => {
  const { exec, calls } = fakeExec({ ps: psLine(1, 0, 0, "/sbin/launchd") });
  expect(await scan(exec)).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("scanSessions: with only the Claude desktop session, ps eww is not called", async () => {
  const ps = [psLine(300, 1, 1, "/Applications/Claude.app/Contents/MacOS/Claude"), psLine(302, 300, 10, CLAUDE_BIN)].join("\n");
  const { exec, calls } = fakeExec({ ps });
  const out = await scan(exec);
  expect(out!.map((s) => s.kind)).toEqual([DESKTOP_KIND]);
  expect(calls.some((c) => c.args[0] === "eww")).toBe(false);
});

test("scanSessions: when the first ps cannot be read, undefined", async () => {
  expect(await scan(fakeExec({ ps: undefined }).exec)).toBeUndefined();
});

test("scanSessions: when ps eww fails the sessions are still there, accountId empty", async () => {
  const out = await scan(fakeExec({ eww: undefined }).exec);
  expect(out!.map((s) => [s.pid, s.accountId])).toEqual([[302, undefined], [201, undefined], [200, undefined]]);
});

test("scanSessions: when lsof fails the sessions are still there, cwd empty", async () => {
  const out = await scan(fakeExec({ lsof: undefined }).exec);
  expect(out!.map((s) => [s.pid, s.cwd, s.accountId])).toEqual([[302, undefined, undefined], [201, undefined, "d"], [200, undefined, "a"]]);
});

test("scanSessions: a session in ps but missing from ps eww has an empty accountId", async () => {
  const out = await scan(fakeExec({ eww: EWW.split("\n")[0] }).exec);
  expect(out!.find((s) => s.pid === 201)!.accountId).toBeUndefined();
  expect(out!.find((s) => s.pid === 200)!.accountId).toBe("a");
});

test("scanSessions: a session that belongs to no app (tmux) has a tty but no appPath", async () => {
  const ps = [psLine(1, 1, 0, "tmux"), psLine(9, 1, 5, "claude", "ttys007")].join("\n");
  const out = await scan(fakeExec({ ps, eww: "", lsof: "" }).exec);
  expect(out).toEqual([{ pid: 9, kind: OTHER_KIND, accountId: undefined, cwd: undefined, startedAt: Date.UTC(2026, 10, 18, 1, 40, 5), tty: "ttys007", appPath: undefined }]);
});

test("scanSessions: only the app user's own sessions; the ancestors of root are still used to find the kind", async () => {
  const { exec, calls } = fakeExec();
  const out = await scan(exec);
  expect(out!.some((s) => s.pid === 600)).toBe(false);
  // 200 sits under `login` (owned by root) and is still a Terminal session
  expect(out!.find((s) => s.pid === 200)!.kind).toBe("Terminal");
  expect(calls.find((c) => c.args[0] === "eww")!.args[4]).not.toContain("600");
  expect(calls.find((c) => c.file === "/usr/sbin/lsof")!.args[5]).not.toContain("600");
});

test("scanSessions: when the uid is unknown every candidate is kept", async () => {
  const out = await scanSessions({ accounts: ACCS, excludePids: [400], selfPid: 500, uid: undefined, exec: fakeExec().exec, now: T0 });
  expect(out!.map((s) => s.pid)).toContain(600);
});

test("scanSessions: when the first ps returns empty or garbage, undefined (keep the old list)", async () => {
  expect(await scan(fakeExec({ ps: "" }).exec)).toBeUndefined();
  expect(await scan(fakeExec({ ps: "garbage\nnot a process\n" }).exec)).toBeUndefined();
});

test("scanSessions: without accounts ps eww is not called, accountId empty", async () => {
  const { exec, calls } = fakeExec();
  const out = await scanSessions({ accounts: [], excludePids: [400], selfPid: 500, uid: UID, exec, now: T0 });
  expect(calls.some((c) => c.args[0] === "eww")).toBe(false);
  expect(out!.map((s) => [s.pid, s.accountId])).toEqual([[302, undefined], [201, undefined], [200, undefined]]);
  expect(out!.find((s) => s.pid === 200)!.cwd).toBe("/Users/x/Projects/a b");
});

test("scanSessions: Claude desktop re-parented to launchd is still the desktop session, no appPath, no ps eww", async () => {
  const ps = [psLine(1, 0, 0, "/sbin/launchd", "??", 0), psLine(302, 1, 10, CLAUDE_BIN), psLine(9, 1, 20, "claude", "ttys007")].join("\n");
  const { exec, calls } = fakeExec({ ps, eww: "  9 claude TERM=x", lsof: "" });
  const out = await scan(exec);
  expect(out!.find((s) => s.pid === 302)).toEqual({ pid: 302, kind: DESKTOP_KIND, accountId: undefined, cwd: undefined, startedAt: Date.UTC(2026, 10, 18, 1, 40, 10), tty: undefined, appPath: undefined });
  expect(out!.find((s) => s.pid === 9)!.kind).toBe(OTHER_KIND);
  expect(calls.find((c) => c.args[0] === "eww")!.args).toEqual(["eww", "-o", "pid=,command=", "-p", "9"]);
});

// ---- tab titles

test("parseTabTitles: tty is the key, the title is verbatim; lines without a tab or with a bad tty are dropped", () => {
  const m = parseTabTitles("/dev/ttys015\t✳ aolangai · Claude - Personal\n/dev/ttys000\t◑ Tình hình app hiện tại\n/dev/ttys001\tTerminal\ngarbage\n");
  expect([...m.keys()]).toEqual(["ttys015", "ttys000", "ttys001"]);
  expect(m.get("ttys015")).toBe("✳ aolangai · Claude - Personal");
  expect(m.get("ttys000")).toBe("◑ Tình hình app hiện tại");
  expect(m.get("ttys001")).toBe("Terminal");
});

test("parseTabTitles: a tty that is not a tty name is dropped; a title may contain spaces", () => {
  const m = parseTabTitles("/dev/ttys002\ta b  c\n/dev/../etc\tx\n\tno tty\n");
  expect([...m.entries()]).toEqual([["ttys002", "a b  c"]]);
});

test("sessionName: status glyphs are stripped, control characters removed, at most 80 characters", () => {
  expect(sessionName("✳ aolangai · Claude - Personal")).toBe("aolangai · Claude - Personal");
  expect(sessionName("◑ Tình hình app hiện tại")).toBe("Tình hình app hiện tại");
  expect(sessionName("Terminal")).toBeUndefined();
  expect(sessionName("")).toBeUndefined();
  expect(sessionName("⠋ ")).toBeUndefined();
  expect(sessionName("a".repeat(200))).toBe("a".repeat(80));
  expect(sessionName("a\u0007b")).toBe("ab");
});

const TITLES = "/dev/ttys015\t✳ aolangai · Claude - Personal\n/dev/ttys003\t◑ Tình hình\n/dev/ttys020\tnot ours\n";

test("scanSessions: Terminal sessions with a tty get the tab title as name; Claude desktop does not", async () => {
  const { exec, calls } = fakeExec({ osa: TITLES });
  const out = (await scan(exec))!;
  expect(out.map((s) => [s.pid, s.name])).toEqual([[302, undefined], [201, "Tình hình"], [200, "aolangai · Claude - Personal"]]);
  expect(calls.filter((c) => c.file === "/usr/bin/osascript")).toHaveLength(1);
});

test("scanSessions: a VS Code session does not get a name even when its tty has a title", async () => {
  const ps = [psLine(100, 1, 1, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"), psLine(200, 100, 5, "claude", "ttys015")].join("\n");
  const { exec, calls } = fakeExec({ ps, eww: "", lsof: "", osa: TITLES });
  const out = (await scan(exec))!;
  expect(out).toHaveLength(1);
  expect(out[0]!.kind).toBe("VS Code");
  expect(out[0]!.name).toBeUndefined();
  expect(calls.some((c) => c.file === "/usr/bin/osascript")).toBe(false);
});

test("scanSessions: the script is the one terminalTitlesOsascriptArgs builds", async () => {
  const { exec, calls } = fakeExec({ osa: TITLES });
  await scan(exec);
  const osa = calls.find((c) => c.file === "/usr/bin/osascript")!;
  expect(osa.args.filter((_, i) => i % 2 === 1).join("\n")).toContain("custom title of t");
  expect(osa.args.join("\n")).not.toContain("name of");
});

test("scanSessions: no Terminal session means no osascript call", async () => {
  const ps = [psLine(1, 0, 0, "/sbin/launchd", "??", 0), psLine(300, 1, 1, "/Applications/Claude.app/Contents/MacOS/Claude"), psLine(302, 300, 10, CLAUDE_BIN)].join("\n");
  const { exec, calls } = fakeExec({ ps, osa: TITLES });
  expect(await scan(exec)).toHaveLength(1);
  expect(calls.some((c) => c.file === "/usr/bin/osascript")).toBe(false);
});

test("scanSessions: a failed title lookup keeps the sessions and backs off for 5 minutes", async () => {
  const osaCalls = (calls: { file: string }[]) => calls.filter((c) => c.file === "/usr/bin/osascript").length;
  const { exec, calls } = fakeExec({ osa: undefined });
  const first = (await scan(exec))!;
  expect(first.map((s) => s.pid)).toEqual([302, 201, 200]);
  expect(first.every((s) => s.name === undefined)).toBe(true);
  expect(osaCalls(calls)).toBe(1);
  const at = (now: number) => scanSessions({ accounts: ACCS, excludePids: [400], selfPid: 500, uid: UID, exec, now });
  await at(T0 + 60_000);
  expect(osaCalls(calls)).toBe(1);
  await at(T0 + TITLE_BACKOFF_MS - 1);
  expect(osaCalls(calls)).toBe(1);
  await at(T0 + TITLE_BACKOFF_MS + 1);
  expect(osaCalls(calls)).toBe(2);
});

test("scanSessions: an empty or invalid answer also starts the back-off", async () => {
  for (const osa of ["", "garbage\n"]) {
    resetTitleBackoff();
    const { exec, calls } = fakeExec({ osa });
    await scan(exec);
    await scanSessions({ accounts: ACCS, excludePids: [400], selfPid: 500, uid: UID, exec, now: T0 + 60_000 });
    expect(calls.filter((c) => c.file === "/usr/bin/osascript")).toHaveLength(1);
  }
});

test("scanSessions: a good answer does not start a back-off", async () => {
  const { exec, calls } = fakeExec({ osa: TITLES });
  await scan(exec);
  await scanSessions({ accounts: ACCS, excludePids: [400], selfPid: 500, uid: UID, exec, now: T0 + 10_000 });
  expect(calls.filter((c) => c.file === "/usr/bin/osascript")).toHaveLength(2);
});

test("scanSessions: an exec that throws on the title lookup does not fail the scan", async () => {
  const base = fakeExec().exec;
  const exec: Exec = async (file, args) => {
    if (file === "/usr/bin/osascript") throw new Error("boom");
    return base(file, args);
  };
  const out = (await scan(exec))!;
  expect(out.map((s) => s.pid)).toEqual([302, 201, 200]);
  expect(out.every((s) => s.name === undefined)).toBe(true);
});

// ---- Claude Code installed through npm

test("isClaudeCommandLine: Claude Code run by node, by its process title or by npm's binary; other node scripts are not", () => {
  expect(isClaudeCommandLine("claude")).toBe(true); // the title Claude Code gives its process
  expect(isClaudeCommandLine("claude --resume abc")).toBe(true);
  expect(isClaudeCommandLine("node /Users/x/.nvm/versions/node/v22.13.0/bin/claude")).toBe(true);
  expect(isClaudeCommandLine("node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --continue")).toBe(true);
  expect(isClaudeCommandLine("/usr/local/bin/node /x/node_modules/@anthropic-ai/claude-code/cli.mjs")).toBe(true);
  expect(isClaudeCommandLine("node /x/node_modules/@anthropic-ai/claude-code/bin/claude.exe")).toBe(true);
  expect(isClaudeCommandLine("node /Users/x/mcp/server.js --stdio")).toBe(false);
  expect(isClaudeCommandLine("node /Users/x/claude/server.js")).toBe(false);
  expect(isClaudeCommandLine("node server.js /Users/x/bin/claude")).toBe(false); // a path that comes later is an argument
  expect(isClaudeCommandLine("node /x/@anthropic-ai/claude-code/cli.js.map")).toBe(false);
  expect(isClaudeCommandLine("")).toBe(false);
});

const NPM_PROCS = [
  psLine(1, 0, 0, "/sbin/launchd", "??", 0),
  psLine(100, 1, 1, TERMINAL),
  psLine(101, 100, 1, "login", "??", 0),
  psLine(102, 101, 1, "-zsh"),
  psLine(700, 102, 30, "/Users/x/.nvm/versions/node/v22.13.0/bin/node", "ttys015"), // older npm release, renamed to claude
  psLine(701, 700, 31, "node"), // its MCP server
  psLine(702, 102, 32, "/x/node_modules/@anthropic-ai/claude-code/bin/claude.exe", "ttys016"), // npm's binary by its real path
  psLine(703, 102, 33, "node", "ttys017"), // a dev server, not Claude Code
  psLine(704, 102, 34, "node", "ttys018", 502), // another user's node: its command line is not even asked for
].join("\n");
const NPM_ARGS = ["  700 claude", "  701 node /Users/x/mcp/server.js", "  703 node /Users/x/app/node_modules/.bin/vite"].join("\n");

test("scanSessions: Claude Code run by node or as npm's claude.exe is a session; its MCP server and other node processes are not", async () => {
  const { exec, calls } = fakeExec({ ps: NPM_PROCS, args: NPM_ARGS, eww: "", lsof: "" });
  const out = (await scan(exec))!;
  expect(out.map((s) => [s.pid, s.kind, s.tty])).toEqual([
    [700, "Terminal", "ttys015"],
    [702, "Terminal", "ttys016"],
  ]);
  const argsCall = calls.find((c) => c.args[0] === "-ww")!;
  expect(argsCall.args).toEqual(["-ww", "-o", "pid=,args=", "-p", "700,701,703"]);
});

test("scanSessions: no node process, no command-line lookup", async () => {
  const procs = PROCS.split("\n").filter((l) => !/\snode$/.test(l)).join("\n");
  const { exec, calls } = fakeExec({ ps: procs });
  await scan(exec);
  expect(calls.some((c) => c.args[0] === "-ww")).toBe(false);
});

test("scanSessions: when the command lines cannot be read, node sessions are missed and the rest are still listed", async () => {
  for (const args of [undefined, "garbage"]) {
    const { exec } = fakeExec({ ps: NPM_PROCS, args, eww: "", lsof: "" });
    expect((await scan(exec))!.map((s) => s.pid)).toEqual([702]);
  }
  const base = fakeExec({ ps: NPM_PROCS, eww: "", lsof: "" }).exec;
  const throwing: Exec = async (file, args) => {
    if (args[0] === "-ww") throw new Error("boom");
    return base(file, args);
  };
  expect((await scan(throwing))!.map((s) => s.pid)).toEqual([702]);
});
