// Tests in this file set FAKE_CLAUDE_SCRIPT / FAKE_CLAUDE_LOG on process.env, so they run serially (vitest's default).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../store/db.js";
import { createRepos, type Repos } from "../store/repos.js";
import { installFakeClaude, type FakeClaude } from "../testing/fake-claude.js";
import type { Account, AccountStatus, Run } from "../types.js";
import type { UsageFetch } from "../status/quota-poller.js";
import { processStart, sweepDeadRuns } from "./control.js";
import { DispatchRefused, dispatch, type DispatchDeps, type DispatchRequest, type RefuseCode } from "./dispatch.js";

const MIN = 60_000;
const init = (sid: string) => ({ type: "system", subtype: "init", session_id: sid, model: "m" });
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const result = (sid: string, extra: object = {}) => ({
  type: "result", subtype: "success", is_error: false, result: `result ${sid}`, session_id: sid,
  usage: { input_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 0, output_tokens: 7 }, permission_denials: [], ...extra,
});
const sdk = (pct: number) => ({
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: pct, resets_at: "2099-01-01T00:00:00Z" }, seven_day: { utilization: 1, resets_at: "2099-01-01T00:00:00Z" } },
});

/** Real `ps` calls in these tests get a generous timeout: under load the production 2 s may pass without an answer. */
const PS = { psTimeoutMs: 15_000 };
/** This process's start time, asked once. */
let myStart: string;
let fake: FakeClaude;
let work: string;
let proj: string;
let dbFile: string;
let logFile: string;
let repos: Repos;
let savedEnv: NodeJS.ProcessEnv;
const extraDbs: Repos[] = [];
/** Used % the fake usage call reports per account id; a missing id makes the call throw. */
let usage: Record<string, number>;
let asked: string[];

const fetch: UsageFetch = async (a) => {
  asked.push(a.id);
  const pct = usage[a.id];
  if (pct === undefined) throw new Error("cannot ask");
  return sdk(pct);
};

beforeAll(() => {
  fake = installFakeClaude();
  myStart = processStart(process.pid, PS)!;
});
afterAll(() => fake.cleanup());
beforeEach(() => {
  savedEnv = { ...process.env };
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-")));
  proj = path.join(work, "proj");
  fs.mkdirSync(proj);
  dbFile = path.join(work, "a.db");
  logFile = path.join(work, "log.json");
  process.env.FAKE_CLAUDE_LOG = logFile;
  repos = createRepos(openDb(dbFile));
  usage = {};
  asked = [];
  script({ lines: [init("s1"), text("working"), result("s1")] });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  for (const r of [repos, ...extraDbs.splice(0)]) r.db.close();
  fs.rmSync(work, { recursive: true, force: true });
});

function script(s: object): void {
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(s);
}
function fakeLog(): { argv: string[]; pid: number } {
  return JSON.parse(fs.readFileSync(logFile, "utf8")) as { argv: string[]; pid: number };
}
function argv(): string[] {
  return fakeLog().argv;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until<T>(f: () => T | undefined, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
    const v = f();
    if (v !== undefined) return v;
  }
  throw new Error("timed out waiting");
}
function resumed(): string | undefined {
  const a = argv();
  const i = a.indexOf("--resume");
  return i >= 0 ? a[i + 1] : undefined;
}
function addAccount(id: string, over: Partial<Account> = {}): Account {
  const a: Account = { id, name: `Claude ${id.toUpperCase()}`, accepting: true, allowedDirs: [], reservePct: 90, ...over };
  repos.accounts.insert(a);
  return a;
}
/** Fresh numbers, so dispatch does not ask again. */
function quota(id: string, pct: number, over: Partial<AccountStatus> = {}): void {
  repos.status.set({ accountId: id, fiveHour: { usedPct: pct }, quotaAt: Date.now(), ...over });
}
function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return { repos, claudePath: fake.claudePath, fetch, env: {}, now: Date.now, pid: process.pid, pidStart: myStart, ps: PS, ...over };
}
function req(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return { prompt: "do it", cwd: proj, ...over };
}
function row(over: Partial<Run> = {}): Run {
  return repos.runs.insert({
    prompt: "old", cwd: proj, accountId: "a", primaryWorker: true, readOnly: false, status: "done",
    createdAt: Date.now() - 2 * MIN, finishedAt: Date.now() - MIN, ...over,
  });
}
function liveRunning(over: Partial<Run> = {}): Run {
  return row({ status: "running", finishedAt: undefined, pid: process.pid, pidStart: myStart, ...over });
}
function deadPid(): number {
  return spawnSync("true").pid!;
}
const runCount = () => repos.runs.recent(1000).length;
async function refused(p: Promise<unknown>): Promise<DispatchRefused> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(DispatchRefused);
  return e as DispatchRefused;
}
async function refusedWith(p: Promise<unknown>, code: RefuseCode): Promise<DispatchRefused> {
  const e = await refused(p);
  expect(e.code).toBe(code);
  expect(e.message).toBeTruthy();
  return e;
}

describe("dispatch: choosing and running", () => {
  it("runs on the account with the most quota left and records the finished run", async () => {
    addAccount("a");
    addAccount("b");
    usage = { a: 40, b: 10 };
    let started: Run | undefined;
    const run = await dispatch(deps({ onStart: (r, acc) => { started = r; expect(acc.id).toBe("b"); } }), req({ label: "tag", readOnly: true }));
    expect(asked.sort()).toEqual(["a", "b"]);
    expect(started).toMatchObject({ status: "running", accountId: "b", pid: process.pid, cwd: proj });
    expect(run).toMatchObject({
      id: started!.id, accountId: "b", status: "done", result: "result s1", sessionId: "s1", primaryWorker: true, readOnly: true,
      label: "tag", denials: [], inputTokens: 10, outputTokens: 7, contextTokens: 10, pid: process.pid, pidStart: myStart,
    });
    expect(run.finishedAt).toBeTypeOf("number");
    expect(run.note).toBeUndefined();
    expect(repos.runs.get(run.id)).toEqual(run);
    expect(repos.runEvents.list(run.id).map((e) => [e.kind, e.text])).toEqual([["text", "working"]]);
    expect(argv()).toContain("--disallowedTools");
    expect(run.workerPid).toBe(fakeLog().pid);
    expect(run.workerPidStart).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("resumes the folder's worker within 60 minutes, but not with fresh", async () => {
    addAccount("a");
    usage = { a: 10 };
    const first = await dispatch(deps(), req());
    expect(resumed()).toBeUndefined();
    script({ lines: [init("s1"), result("s1")] });
    const second = await dispatch(deps(), req());
    expect(resumed()).toBe(first.sessionId);
    expect(second).toMatchObject({ primaryWorker: true, sessionId: "s1", status: "done" });
    script({ lines: [init("s3"), result("s3")] });
    const third = await dispatch(deps(), req({ fresh: true }));
    expect(resumed()).toBeUndefined();
    expect(third).toMatchObject({ primaryWorker: true, sessionId: "s3" });
  });

  it("does not resume a worker whose context is too big or that has been idle too long; unknown context is fine", async () => {
    addAccount("a");
    quota("a", 10);
    row({ sessionId: "big", contextTokens: 120_000 });
    await dispatch(deps(), req());
    expect(resumed()).toBeUndefined();

    row({ sessionId: "old", contextTokens: 5_000, finishedAt: Date.now() - 61 * MIN });
    await dispatch(deps(), req());
    expect(resumed()).toBeUndefined();

    row({ sessionId: "unknown-ctx" });
    await dispatch(deps(), req());
    expect(resumed()).toBe("unknown-ctx");
  });

  it("opens a side session when the primary worker is busy", async () => {
    addAccount("a");
    quota("a", 10);
    liveRunning({ sessionId: "busy" });
    const run = await dispatch(deps(), req());
    expect(resumed()).toBeUndefined();
    expect(run).toMatchObject({ status: "done", primaryWorker: false, accountId: "a" });
    const fresh = await dispatch(deps(), req({ fresh: true }));
    expect(fresh.primaryWorker).toBe(false);
  });

  it("sees a busy primary that has no session id yet: not warm, and a side session", async () => {
    addAccount("a");
    addAccount("b");
    quota("a", 20);
    quota("b", 10);
    row({ accountId: "a", sessionId: "older" });
    liveRunning({ accountId: "a", sessionId: undefined });
    const run = await dispatch(deps({ fetch: undefined }), req());
    expect(run.accountId).toBe("b"); // a would win as warm (20 <= 10 + 15) if its busy primary were missed
    expect(run.primaryWorker).toBe(true);

    const forced = await dispatch(deps({ fetch: undefined }), req({ account: "claude a" }));
    expect(resumed()).toBeUndefined();
    expect(forced.primaryWorker).toBe(false);
  });

  it("gives the second of two simultaneous runs in one folder a side session", async () => {
    addAccount("a");
    quota("a", 10);
    script({ lines: [init("s1"), result("s1")], delayMs: 300 });
    const runs = await Promise.all([dispatch(deps(), req()), dispatch(deps(), req())]);
    expect(runs.map((r) => r.primaryWorker).sort()).toEqual([false, true]);
    expect(runs.find((r) => !r.primaryWorker)!.id).toBe(Math.max(...runs.map((r) => r.id)));
    expect(resumed()).toBeUndefined();
  });

  it("never resumes a primary that did not finish done", async () => {
    addAccount("a");
    quota("a", 10);
    for (const over of [
      { status: "failed" as const, error: "x" },
      { status: "stopped" as const },
      { status: "limited" as const, error: "You've hit your limit" },
      { status: "failed" as const, error: "The delegating process was lost" },
    ]) {
      row({ sessionId: `not-${over.status}`, ...over });
      const run = await dispatch(deps(), req());
      expect(resumed()).toBeUndefined();
      expect(run.primaryWorker).toBe(true);
    }
  });

  it("prefers an account with a warm worker within 15 points, unless fresh", async () => {
    addAccount("a");
    addAccount("b");
    quota("a", 20);
    quota("b", 10);
    row({ accountId: "a", sessionId: "warm-a", contextTokens: 1000 });
    const warm = await dispatch(deps({ fetch: undefined }), req());
    expect(warm.accountId).toBe("a");
    expect(resumed()).toBe("warm-a");
    const cold = await dispatch(deps({ fetch: undefined }), req({ fresh: true }));
    expect(cold.accountId).toBe("b");
    expect(resumed()).toBeUndefined();
  });

  it("keeps the resumed session id when the result carries none, and stores none for a new session without one", async () => {
    addAccount("a");
    quota("a", 10);
    row({ sessionId: "w1" });
    script({ lines: [{ type: "result", subtype: "success", is_error: false, result: "ok" }] });
    let started: Run | undefined;
    const run = await dispatch(deps({ onStart: (r) => { started = r; } }), req());
    expect(resumed()).toBe("w1");
    expect(started?.sessionId).toBe("w1");
    expect(run).toMatchObject({ status: "done", sessionId: "w1", primaryWorker: true });

    const fresh = await dispatch(deps(), req({ fresh: true }));
    expect(fresh.status).toBe("done");
    expect(fresh.sessionId).toBeUndefined();
  });

  it("matches --account by name, ignoring case and surrounding spaces", async () => {
    addAccount("a");
    addAccount("b");
    usage = { a: 10, b: 80 };
    const run = await dispatch(deps(), req({ account: " claude b " }));
    expect(run.accountId).toBe("b");
    expect(asked).toEqual(["b"]);
  });
});

describe("dispatch: the chosen account's login", () => {
  const OVERRIDES = {
    ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://proxy", ANTHROPIC_MODEL: "m", ANTHROPIC_CUSTOM_HEADERS: "x: y",
    CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CONFIG_DIR: "/main/session/config",
    CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "main", CLAUDE_CODE_ENTRYPOINT: "cli",
    // what a Code session inside the Claude desktop app adds (as observed)
    ...Object.fromEntries(
      [
        "CLAUDE_AGENT_SDK_MCP_NO_PREFIX", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST",
        "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_CODE_DESKTOP_MESSAGE_CARD", "CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR",
        "CLAUDE_CODE_DESKTOP_WORKFLOW_LIMIT_WAIT", "CLAUDE_CODE_DISABLE_CRON", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "CLAUDE_CODE_EAGER_FLUSH",
        "CLAUDE_CODE_EMIT_STARTUP_TIMING", "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES", "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
        "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_CODE_ENTRYPOINT_ON_REQUESTS", "CLAUDE_CODE_HOST_GUARDS_ARTIFACTS_MCP",
        "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_HOST_SHORT_TEMP_DIRS", "CLAUDE_CODE_MCP_APPS_HOST", "CLAUDE_CODE_OAUTH_SCOPES",
        "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_PLUGIN_ATTRIBUTION", "CLAUDE_CODE_RATE_LIMIT_TIER", "CLAUDE_CODE_REPORT_FINDINGS",
        "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH", "CLAUDE_CODE_SDK_READS_SESSION_STATE",
        "CLAUDE_CODE_SESSION_NAME", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SKILL_ATTRIBUTION", "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
        "CLAUDE_CODE_SUBSCRIPTION_TYPE", "CLAUDE_CODE_TERMINAL_MCP_TOOLS", "CLAUDE_CODE_USER_EMAIL", "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
      ].map((n) => [n, "x"]),
    ),
  };

  it("runs claude with exactly the chosen account's config dir and none of the overrides of the calling environment", async () => {
    const dirB = path.join(work, "cfg-b");
    addAccount("a"); // the default ~/.claude
    addAccount("b", { configDir: dirB });
    quota("a", 50);
    quota("b", 10);
    Object.assign(process.env, OVERRIDES);
    const env = () => (JSON.parse(fs.readFileSync(logFile, "utf8")) as { env: Record<string, string> }).env;

    const onB = await dispatch(deps({ fetch: undefined }), req());
    expect(onB.accountId).toBe("b");
    expect(env().CLAUDE_CONFIG_DIR).toBe(dirB);
    for (const k of Object.keys(OVERRIDES)) if (k !== "CLAUDE_CONFIG_DIR") expect(env()[k]).toBeUndefined();
    expect(Object.keys(env()).filter((k) => k.startsWith("CLAUDE_") && k !== "CLAUDE_CONFIG_DIR")).toEqual([]);
    expect(Object.keys(env()).filter((k) => k.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(env().AOLANGAI_RUN_ID).toBe(String(onB.id));

    const onA = await dispatch(deps({ fetch: undefined }), req({ account: "Claude A", fresh: true }));
    expect(onA.accountId).toBe("a");
    for (const k of Object.keys(OVERRIDES)) expect(env()[k]).toBeUndefined();
    expect(Object.keys(env()).filter((k) => k.startsWith("CLAUDE_") || k.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(env().AOLANGAI_RUN_ID).toBe(String(onA.id));
  });

  it("records a run whose claude reports another key source as failed, and does not mark the account limited", async () => {
    addAccount("a");
    quota("a", 10);
    script({ lines: [{ ...init("s1"), apiKeySource: "ANTHROPIC_API_KEY" }, { type: "result", subtype: "success", is_error: true, result: "You've hit your limit", session_id: "s1" }] });
    const run = await dispatch(deps({ fetch: undefined }), req());
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^The worker is not running with this account's login \(apiKeySource: ANTHROPIC_API_KEY\)/);
    expect(repos.status.get("a")?.limit).toBeUndefined();
  });
});

describe("dispatch: guards", () => {
  it("refuses a nested dispatch before anything else and writes no run", async () => {
    addAccount("a");
    await refusedWith(dispatch(deps({ env: { AOLANGAI_RUN_ID: "3" } }), req({ cwd: path.join(work, "nope") })), "nested");
    expect(runCount()).toBe(0);
    expect(asked).toEqual([]);
  });

  it("refuses a missing folder and a file", async () => {
    addAccount("a");
    usage = { a: 10 };
    await refusedWith(dispatch(deps(), req({ cwd: path.join(work, "nope") })), "bad-cwd");
    const file = path.join(work, "f.txt");
    fs.writeFileSync(file, "x");
    await refusedWith(dispatch(deps(), req({ cwd: file })), "bad-cwd");
    expect(runCount()).toBe(0);
  });

  it("treats a trailing slash and a symlink as the real folder, and expands ~", async () => {
    addAccount("a");
    quota("a", 10);
    row({ sessionId: "w1" });
    script({ lines: [init("w2"), result("w2")] });
    const slash = await dispatch(deps(), req({ cwd: proj + "/" }));
    expect(resumed()).toBe("w1");
    expect(slash.cwd).toBe(proj);

    const link = path.join(work, "link");
    fs.symlinkSync(proj, link);
    const viaLink = await dispatch(deps(), req({ cwd: link }));
    expect(resumed()).toBe("w2");
    expect(viaLink.cwd).toBe(proj);

    const home = await dispatch(deps(), req({ cwd: "~" }));
    expect(home.cwd).toBe(fs.realpathSync(os.homedir()));
  });

  it("refuses too-many when 4 runs of live dispatchers are running", async () => {
    addAccount("a");
    quota("a", 10);
    for (let i = 0; i < 4; i++) liveRunning({ primaryWorker: false });
    const e = await refusedWith(dispatch(deps(), req()), "too-many");
    expect(e.message).toContain("4");
    expect(runCount()).toBe(4);
  });

  it("keeps the sweep of dead runs even when it then refuses", async () => {
    addAccount("a");
    quota("a", 10);
    for (let i = 0; i < 4; i++) liveRunning({ primaryWorker: false });
    const dead = liveRunning({ pid: deadPid(), primaryWorker: false });
    await refusedWith(dispatch(deps(), req()), "too-many");
    expect(repos.runs.get(dead.id)?.status).toBe("failed");
  });

  it("sweeps running rows of dead dispatchers, then runs normally", async () => {
    addAccount("a");
    quota("a", 10);
    const dead = [0, 1, 2, 3].map(() => liveRunning({ pid: deadPid(), primaryWorker: false }));
    const run = await dispatch(deps(), req());
    expect(run.status).toBe("done");
    for (const d of dead) expect(repos.runs.get(d.id)).toMatchObject({ status: "failed", error: "The delegating process was lost" });
  });

  it("refuses too-fast at 30 runs of any status in the last 60 minutes; older runs do not count", async () => {
    addAccount("a");
    quota("a", 10);
    const statuses = ["done", "failed", "stopped", "limited"] as const;
    row({ createdAt: Date.now() - 61 * MIN });
    for (let i = 0; i < 29; i++) row({ status: statuses[i % 4], createdAt: Date.now() - 59 * MIN });
    expect((await dispatch(deps(), req())).status).toBe("done"); // 29 recent + this one = 30
    await refusedWith(dispatch(deps(), req()), "too-fast");
    expect(runCount()).toBe(31);
  });

  it("checks too-many before too-fast, and too-fast before the account name", async () => {
    addAccount("a");
    quota("a", 10);
    for (let i = 0; i < 30; i++) row({ createdAt: Date.now() - MIN });
    await refusedWith(dispatch(deps(), req({ account: "none" })), "too-fast");
    for (let i = 0; i < 4; i++) liveRunning({ primaryWorker: false });
    await refusedWith(dispatch(deps(), req({ account: "none" })), "too-many");
  });

  it("refuses no-account with one exclusion per account", async () => {
    addAccount("a", { accepting: false });
    addAccount("b");
    addAccount("c");
    quota("a", 10);
    quota("b", 10, { limit: { message: "limit reached", until: Date.now() + 60 * MIN, at: Date.now() } });
    quota("c", 95);
    const e = await refusedWith(dispatch(deps(), req()), "no-account");
    expect(e.exclusions?.map((x) => [x.accountId, x.reason])).toEqual([["a", "off"], ["b", "blocked"], ["c", "reserve"]]);
    expect(runCount()).toBe(0);
  });

  it("refuses an unknown or ambiguous account name", async () => {
    addAccount("a");
    addAccount("b");
    addAccount("c", { name: "claude b" });
    quota("a", 10);
    await refusedWith(dispatch(deps(), req({ account: "Claude Z" })), "unknown-account");
    const amb = await refusedWith(dispatch(deps(), req({ account: "CLAUDE B" })), "unknown-account");
    expect(amb.message).toMatch(/Several accounts/);
    expect(runCount()).toBe(0);
  });

  it("asks quota only of accounts that could take the run", async () => {
    addAccount("a");
    addAccount("off", { accepting: false });
    addAccount("elsewhere", { allowedDirs: [path.join(work, "other")] });
    addAccount("out");
    repos.status.set({ accountId: "out", connection: { state: "not-logged-in", checkedAt: 1 } });
    usage = { a: 10, off: 10, elsewhere: 10, out: 10 };
    await dispatch(deps(), req());
    expect(asked).toEqual(["a"]);
  });

  it("notes missing numbers for a forced account too", async () => {
    addAccount("a");
    const run = await dispatch(deps({ fetch: undefined }), req({ account: "Claude A" }));
    expect(run.note).toBe("No quota numbers for this account");
  });

  it("runs without asking when there is no fetch", async () => {
    addAccount("a");
    const run = await dispatch(deps({ fetch: undefined }), req());
    expect(run).toMatchObject({ status: "done", note: "No quota numbers for this account" });
  });
});

describe("dispatch: another run in the same folder", () => {
  it("notes the running runs of the same folder, joined to a quota note", async () => {
    addAccount("a");
    quota("a", 10);
    const other = path.join(work, "other");
    fs.mkdirSync(other);
    const three = liveRunning({ primaryWorker: false });
    liveRunning({ cwd: other, primaryWorker: false });
    row({ status: "done" });
    row({ status: "failed", error: "x" });
    const one = await dispatch(deps({ fetch: undefined }), req());
    expect(one.note).toBe(`Also running in this folder: #${three.id}`);

    const five = liveRunning({ primaryWorker: false });
    const two = await dispatch(deps({ fetch: undefined }), req({ cwd: proj + "/" }));
    expect(two.note).toBe(`Also running in this folder: #${three.id}, #${five.id}`);

    repos.status.set({ accountId: "a", fiveHour: { usedPct: 10 } }); // numbers of unknown age: a quota note first
    const joined = await dispatch(deps({ fetch: undefined }), req());
    expect(joined.note).toBe(`Using old quota numbers, age unknown · Also running in this folder: #${three.id}, #${five.id}`);
  });

  it("says nothing when the other run is in another folder, finished, or its dispatcher is dead", async () => {
    addAccount("a");
    quota("a", 10);
    const other = path.join(work, "other");
    fs.mkdirSync(other);
    liveRunning({ cwd: other });
    row({ status: "done" });
    row({ status: "stopped" });
    liveRunning({ pid: deadPid(), primaryWorker: false }); // swept first
    const run = await dispatch(deps({ fetch: undefined }), req());
    expect(run.note).toBeUndefined();
  });
});

describe("dispatch: outcomes", () => {
  it("records a limit, blocks the account, and the next run goes elsewhere", async () => {
    addAccount("a");
    addAccount("b");
    usage = { a: 10, b: 40 };
    script({ lines: [init("s1"), { type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm", session_id: "s1" }] });
    const run = await dispatch(deps(), req());
    expect(run).toMatchObject({ accountId: "a", status: "limited", error: "You've hit your limit · resets 3pm", sessionId: "s1" });
    expect(run.finishedAt).toBeTypeOf("number");
    expect(repos.status.get("a")?.limit?.message).toBe("You've hit your limit · resets 3pm");

    script({ lines: [init("s2"), result("s2")] });
    expect((await dispatch(deps(), req())).accountId).toBe("b");
  });

  it("uses old numbers with a note when the quota ask fails, and does not ask again within 5 minutes", async () => {
    addAccount("a");
    const quotaAt = Date.now() - 10 * MIN;
    repos.status.set({ accountId: "a", fiveHour: { usedPct: 10 }, quotaAt });
    const d = new Date(quotaAt);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const run = await dispatch(deps(), req());
    expect(run).toMatchObject({ status: "done", note: `Using old quota numbers from ${hhmm}` });
    expect(repos.status.get("a")?.pollError).toBeDefined();
    expect(asked).toEqual(["a"]);
    await dispatch(deps(), req());
    expect(asked).toEqual(["a"]);
  });

  it("notes old numbers of unknown age", async () => {
    addAccount("a");
    repos.status.set({ accountId: "a", fiveHour: { usedPct: 10 } });
    const run = await dispatch(deps({ fetch: undefined }), req());
    expect(run.note).toBe("Using old quota numbers, age unknown");
  });

  it("keeps selectAccount's note when the account has no numbers at all", async () => {
    addAccount("a");
    const run = await dispatch(deps(), req());
    expect(run.note).toBe("No quota numbers for this account");
  });

  it("marks the account not logged in on such a failure, keeping status written meanwhile", async () => {
    addAccount("a");
    quota("a", 10);
    script({ lines: [{ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }] });
    const run = await dispatch(deps({ onStart: () => quota("a", 77) }), req());
    expect(run).toMatchObject({ status: "failed", error: "Not logged in · Please run /login" });
    const s = repos.status.get("a");
    expect(s?.connection?.state).toBe("not-logged-in");
    expect(s?.fiveHour?.usedPct).toBe(77);
  });

  it("puts two simultaneous dispatches on two connections onto different accounts", async () => {
    addAccount("a");
    addAccount("b");
    quota("a", 20);
    quota("b", 20);
    const other = createRepos(openDb(dbFile));
    extraDbs.push(other);
    script({ lines: [init("s1"), result("s1")], delayMs: 300 });
    const [x, y] = await Promise.all([dispatch(deps(), req()), dispatch(deps({ repos: other }), req())]);
    expect([x.status, y.status]).toEqual(["done", "done"]);
    expect(new Set([x.accountId, y.accountId])).toEqual(new Set(["a", "b"]));
  });

  it("records stopped when the signal is aborted", async () => {
    addAccount("a");
    quota("a", 10);
    script({ early: [init("s1")], delayMs: 20_000, lines: [result("s1")] });
    const ac = new AbortController();
    const run = await dispatch(deps({ signal: ac.signal, onStart: () => void setTimeout(() => ac.abort(), 300) }), req());
    expect(run.status).toBe("stopped");
    expect(run.finishedAt).toBeTypeOf("number");
  });

  it("records an unexpected error after the row exists on the row instead of throwing", async () => {
    addAccount("a");
    quota("a", 10);
    const run = await dispatch(deps({ onStart: () => { throw new Error("boom"); } }), req());
    expect(run.status).toBe("failed");
    expect(run.error).toContain("boom");
    expect(run.finishedAt).toBeTypeOf("number");
    expect(repos.runs.get(run.id)).toEqual(run);
  });

  it("does not fail the run when an event cannot be written", async () => {
    addAccount("a");
    quota("a", 10);
    repos.db.exec("DROP TABLE run_events");
    const run = await dispatch(deps(), req());
    expect(run).toMatchObject({ status: "done", result: "result s1" });
  });
});

describe("dispatch: a killed dispatcher", () => {
  it("leaves an orphaned worker that the next sweep kills", async () => {
    addAccount("a");
    quota("a", 10);
    // The fake prints everything early, then stays silent: a write after its dispatcher died would end it by EPIPE.
    script({ early: [init("s1"), text("running")], delayMs: 30_000, lines: [result("s1")] });
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const child = spawn(process.execPath, ["--import", tsx, "--no-warnings", path.join(path.dirname(fileURLToPath(import.meta.url)), "../testing/dispatch-child.ts"), dbFile, proj, fake.claudePath], {
      stdio: "ignore",
    });
    let workerPid: number | undefined;
    try {
      const run = await until(() => repos.runs.running().find((r) => r.workerPid !== undefined && r.workerPidStart !== undefined), 15_000);
      await until(() => (repos.runEvents.list(run.id).length > 0 ? true : undefined));
      workerPid = run.workerPid!;
      expect(run.pid).toBe(child.pid);
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL");
      await exited;
      await new Promise((r) => setTimeout(r, 200));
      expect(alive(workerPid)).toBe(true); // nobody killed it: the orphan exists

      expect(sweepDeadRuns(repos, Date.now(), PS)).toBe(1);
      expect(repos.runs.get(run.id)).toMatchObject({ status: "failed", error: "The delegating process was lost" });
      expect(await until(() => (alive(workerPid!) ? undefined : true), 3_000)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      if (workerPid !== undefined && alive(workerPid)) process.kill(-workerPid, "SIGKILL");
    }
  }, 30_000);
});
