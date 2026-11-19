import fs from "node:fs";
import os from "node:os";
import { getEventListeners } from "node:events";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { childEnv } from "../accounts/env.js";
import type { Account } from "../types.js";
import { installFakeClaude, type FakeClaude } from "../testing/fake-claude.js";
import {
  CLOSE_GRACE_MS,
  DEFAULT_PERMISSION_MODE,
  KILL_GRACE_MS,
  READ_ONLY_ARGS,
  claudeArgs,
  claudeEnv,
  decideOutcome,
  runClaude,
  timeoutMessage,
  type ClaudeOutcome,
  type ClaudeRunRequest,
  type OutcomeFacts,
} from "./claude-run.js";
import { toolText } from "./tool-text.js";

const account: Account = { id: "a", name: "A", accepting: true, allowedDirs: [], reservePct: 90 };

const init = (sessionId = "sess-1") => ({ type: "system", subtype: "init", session_id: sessionId, model: "m" });
const usage = (i: number, cr: number, cc: number, o = 1) => ({ input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: o });
const assistant = (block: unknown, u?: object, extra: object = {}) => ({ type: "assistant", message: { content: [block], ...(u ? { usage: u } : {}) }, ...extra });
const toolUse = (name: string, input: object) => ({ type: "tool_use", id: "toolu_1", name, input });
const result = (extra: object = {}) => ({
  type: "result", subtype: "success", is_error: false, result: "The function is named add.", session_id: "sess-1",
  usage: usage(4, 33_807, 13_797, 141), permission_denials: [], ...extra,
});

let fake: FakeClaude;
let work: string;
let logFile: string;
let savedEnv: NodeJS.ProcessEnv;

beforeAll(() => { fake = installFakeClaude(); });
afterAll(() => fake.cleanup());
beforeEach(() => {
  savedEnv = { ...process.env };
  work = fs.mkdtempSync(path.join(os.tmpdir(), "claude-run-"));
  logFile = path.join(work, "log.json");
  process.env.FAKE_CLAUDE_LOG = logFile;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(work, { recursive: true, force: true });
});

function script(s: object): void {
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(s);
}
function req(over: Partial<ClaudeRunRequest> = {}): ClaudeRunRequest {
  return { claudePath: fake.claudePath, account, cwd: work, prompt: "do it", runId: 7, timeoutMs: 20_000, ...over };
}
function log(): { argv: string[]; env: Record<string, string>; stdin: string; cwd: string; pid: number; childPid?: number } {
  return JSON.parse(fs.readFileSync(logFile, "utf8"));
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** Waits up to 5 s for the pid to disappear; returns as soon as it has. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
const okLines = [init(), assistant(toolUse("Read", { file_path: "/p/login.test.ts" }), usage(2, 11_948, 9_911)), result()];

describe("runClaude: normal run", () => {
  it("returns done with result, session, tokens, and reports a tool event", async () => {
    script({ lines: [init(), assistant(toolUse("Read", { file_path: "/p/login.test.ts" }), usage(2, 11_948, 9_911)), { type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, assistant({ type: "text", text: "done" }, usage(21_859, 0, 3_886)), result()] });
    const events: { kind: string; text: string }[] = [];
    const out = await runClaude(req({ onEvent: (e) => events.push(e) }));
    expect(out).toEqual({
      kind: "done", result: "The function is named add.", sessionId: "sess-1", denials: [],
      inputTokens: 4 + 33_807 + 13_797, outputTokens: 141, contextTokens: 21_859 + 3_886,
    });
    expect(events).toEqual([{ kind: "tool", text: "Read login.test.ts" }, { kind: "text", text: "done" }]);
    expect(fs.realpathSync(log().cwd)).toBe(fs.realpathSync(work));
  });

  it("ignores subagent lines for contextTokens and skips thinking blocks", async () => {
    const events: unknown[] = [];
    script({ lines: [
      init(),
      assistant({ type: "text", text: "main" }, usage(100, 0, 0), { parent_tool_use_id: null }),
      assistant({ type: "thinking", thinking: "hmm" }, usage(150, 0, 0)),
      assistant({ type: "text", text: "sub" }, usage(9_000, 0, 0), { parent_tool_use_id: "toolu_9" }),
      result(),
    ] });
    const out = await runClaude(req({ onEvent: (e) => events.push(e) }));
    expect(out).toMatchObject({ kind: "done", contextTokens: 150 });
    expect(events).toEqual([{ kind: "text", text: "main" }, { kind: "text", text: "sub" }]);
  });

  it("leaves token fields undefined when claude gave no usage", async () => {
    script({ lines: [init(), { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-1" }] });
    const out = await runClaude(req());
    expect(out).toEqual({ kind: "done", result: "ok", sessionId: "sess-1", denials: [], inputTokens: undefined, outputTokens: undefined, contextTokens: undefined });
  });

  it("tolerates Warning lines and a broken JSON line", async () => {
    script({ lines: [init(), "Warning: something odd", '{"type":"assistant","message":', "", result()] });
    expect(await runClaude(req())).toMatchObject({ kind: "done", result: "The function is named add." });
  });

  it("is still done when permission_denials is not empty, and renders denials", async () => {
    script({ lines: [init(), result({ permission_denials: [
      { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm run migrate" } },
      { tool_name: "Write", tool_use_id: "t2", tool_input: { file_path: "/p/a.txt", content: "hi" } },
      { tool_name: "WebFetch", tool_use_id: "t3", tool_input: { url: "https://x.y" } },
      { tool_name: "Bash", tool_use_id: "t4", tool_input: { command: "x".repeat(200) } },
    ] })] });
    const out = await runClaude(req());
    expect(out.kind).toBe("done");
    if (out.kind === "done") {
      expect(out.denials.slice(0, 3)).toEqual(["Bash(npm run migrate)", "Write(/p/a.txt)", 'WebFetch({"url":"https://x.y"})']);
      expect(out.denials[3]!.length).toBeLessThanOrEqual("Bash()".length + 80);
    }
  });

  it("does not let a throwing onEvent break the run", async () => {
    script({ lines: okLines });
    const out = await runClaude(req({ onEvent: () => { throw new Error("boom"); } }));
    expect(out.kind).toBe("done");
  });
});

describe("runClaude: prompt, argv, env", () => {
  it("delivers awkward prompts to stdin intact and never in argv", async () => {
    for (const prompt of ["--help\n\"x\" 'y'", "-rf --dangerous", "é ✓ 日本\r\nline2\n", "x".repeat(200_000)]) {
      script({ lines: okLines });
      expect((await runClaude(req({ prompt }))).kind).toBe("done");
      const l = log();
      expect(l.stdin).toBe(prompt);
      expect(l.argv.join("\u0000")).not.toContain(prompt.slice(0, 20));
      expect(l.argv).not.toContain(prompt);
    }
  });

  it("builds argv: defaults, resume, model, permission mode, read-only", () => {
    expect(claudeArgs({ account })).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", DEFAULT_PERMISSION_MODE]);
    expect(DEFAULT_PERMISSION_MODE).toBe("acceptEdits");
    expect(claudeArgs({ account: { ...account, model: "opus", permissionMode: "auto" }, resume: "s-1" })).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--resume", "s-1", "--model", "opus", "--permission-mode", "auto",
    ]);
    const ro = claudeArgs({ account: { ...account, permissionMode: "auto" }, readOnly: true });
    expect(ro).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--disallowedTools", "Edit Write NotebookEdit Bash"]);
    expect(READ_ONLY_ARGS).toEqual(["--disallowedTools", "Edit Write NotebookEdit Bash"]);
    expect(ro).not.toContain("--permission-mode");
  });

  it("passes that argv to the process", async () => {
    script({ lines: okLines });
    await runClaude(req({ resume: "s-9", readOnly: true, account: { ...account, model: "opus" } }));
    expect(log().argv).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--resume", "s-9", "--model", "opus", "--disallowedTools", "Edit Write NotebookEdit Bash"]);
  });

  it("drops CLAUDE_CONFIG_DIR for the default account and sets the absolute dir otherwise", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/somewhere/else";
    script({ lines: okLines });
    await runClaude(req());
    expect(log().env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(log().env.AOLANGAI_RUN_ID).toBe("7");
    await runClaude(req({ account: { ...account, configDir: "~/.claude-b" } }));
    expect(log().env.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), ".claude-b"));
  });

  it("passes the shared child environment: no inherited CLAUDE_* or ANTHROPIC_*, its own run id", async () => {
    const polluted = {
      CLAUDECODE: "1", CLAUDE_PID: "123", CLAUDE_EFFORT: "high", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_MODEL: "claude-x", ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://proxy", CLAUDE_CODE_OAUTH_TOKEN: "o", AOLANGAI_RUN_ID: "99",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
    };
    Object.assign(process.env, polluted);
    script({ lines: okLines });
    await runClaude(req());
    const env = log().env;
    for (const k of Object.keys(polluted)) if (k !== "AOLANGAI_RUN_ID") expect(env[k]).toBeUndefined();
    expect(env.AOLANGAI_RUN_ID).toBe("7");
  });

  it("claudeEnv is childEnv plus the run id", () => {
    const base = { CLAUDE_CODE_EXECPATH: "/x", CLAUDE_CODE_OAUTH_TOKEN: "o", PATH: "/bin", ANTHROPIC_API_KEY: "k", AOLANGAI_RUN_ID: "1" };
    expect(claudeEnv(base, account, 3)).toEqual({ ...childEnv(base, account), AOLANGAI_RUN_ID: "3" });
    expect(claudeEnv(base, account, 3)).toEqual({ PATH: "/bin", AOLANGAI_RUN_ID: "3" });
  });
});

describe("runClaude: outcomes", () => {
  it("fails with the stderr tail when there is no result", async () => {
    script({ lines: [], stderr: "Not logged in", exitCode: 1 });
    const out = await runClaude(req());
    expect(out).toMatchObject({ kind: "failed" });
    expect((out as { error: string }).error).toContain("Not logged in");
  });

  it("keeps only the last 500 chars of a long stderr", async () => {
    script({ lines: [], stderr: "A".repeat(3000) + "FIN", exitCode: 2 });
    const out = (await runClaude(req())) as { kind: "failed"; error: string };
    expect(out.error.endsWith("FIN")).toBe(true);
    expect(out.error.length).toBeLessThanOrEqual(500);
  });

  it("fails on empty output and exit 0", async () => {
    script({ lines: [], exitCode: 0 });
    const out = await runClaude(req());
    expect(out).toEqual({ kind: "failed", error: "claude exited with code 0 without returning a result" });
  });

  it("fails (never throws) on garbage output", async () => {
    script({ lines: ["not json", "{", "[1,2]", "null", '{"type":"result"}', '"str"'] });
    expect(await runClaude(req())).toEqual({ kind: "failed", error: "claude returned an invalid result", sessionId: undefined });
  });

  it("fails with a clear message when claude cannot be started", async () => {
    const out = await runClaude(req({ claudePath: path.join(work, "no-such-claude") }));
    expect(out.kind).toBe("failed");
    expect((out as { error: string }).error).toMatch(/^Could not run the claude command: /);
  });

  it("fails when the folder does not exist", async () => {
    const out = await runClaude(req({ cwd: path.join(work, "missing") }));
    expect(out.kind).toBe("failed");
    expect((out as { error: string }).error).toMatch(/^Could not run the claude command: /);
  });

  describe("limited", () => {
    const errResult = (text: string, extra: object = {}) => result({ is_error: true, result: text, ...extra });
    async function run(lines: unknown[]): Promise<ClaudeOutcome> {
      script({ lines });
      return runClaude(req());
    }

    it("recognises the Fable limit text", async () => {
      const out = await run([init(), errResult("You've hit your Fable limit · resets 1am")]);
      expect(out).toEqual({ kind: "limited", message: "You've hit your Fable limit · resets 1am", sessionId: "sess-1" });
    });

    it.each([
      "You've reached your usage limit",
      "You're out of usage credits",
      "Your org is out of usage · contact your admin",
      "Your seat type doesn't include usage",
      "Your usage allocation has been disabled by your admin",
      "Your group's usage limit is set to $0",
      "Fable 5 requires usage credits",
      "You're out of extra usage",
      "Your seat type doesn't include extra usage",
      "This service is disabled for your org",
    ])("recognises the prefix %s", async (text) => {
      expect((await run([init(), errResult(text)])).kind).toBe("limited");
    });

    it("reads the text from errors[] when result has none", async () => {
      const out = await run([init(), { type: "result", subtype: "error_during_execution", is_error: true, errors: ["You've hit your limit · resets 3pm"], session_id: "sess-1" }]);
      expect(out).toMatchObject({ kind: "limited", message: "You've hit your limit · resets 3pm" });
    });

    it("recognises an assistant error rate_limit with unfamiliar text", async () => {
      const out = await run([init(), assistant({ type: "text", text: "x" }, undefined, { error: "rate_limit" }), errResult("Something odd happened")]);
      expect(out).toMatchObject({ kind: "limited", message: "Something odd happened" });
    });

    it.each(["billing_error", "account_on_hold"])("recognises assistant error %s", async (error) => {
      expect((await run([init(), assistant({ type: "text", text: "x" }, undefined, { error }), errResult("odd")])).kind).toBe("limited");
    });

    it("recognises a rejected rate_limit_event", async () => {
      const out = await run([init(), { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, errResult("odd")]);
      expect(out.kind).toBe("limited");
    });

    it("recognises terminal_reason blocking_limit and api_error_status 429", async () => {
      expect((await run([init(), errResult("odd", { terminal_reason: "blocking_limit" })])).kind).toBe("limited");
      expect((await run([init(), errResult("odd", { api_error_status: 429 })])).kind).toBe("limited");
    });

    it("recognises rate limit wording in the text", async () => {
      expect((await run([init(), errResult("API Error: rate limit exceeded")])).kind).toBe("limited");
    });

    it("keeps the session id when the limit hits before a result line carries it", async () => {
      expect(await run([init("sess-z"), errResult("You've hit your limit", { session_id: undefined })])).toMatchObject({ kind: "limited", sessionId: "sess-z" });
    });

    it("does not call a warning limited, even with is_error true", async () => {
      expect((await run([init(), errResult("You've used 90% of your usage limit")])).kind).toBe("failed");
    });

    it("does not call a warning in a successful result limited", async () => {
      expect((await run([init(), result({ result: "You've used 90% of your limit" })])).kind).toBe("done");
    });

    it("ignores limit signals when the result is not an error", async () => {
      const out = await run([init(), { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, assistant({ type: "text", text: "x" }, undefined, { error: "rate_limit" }), result()]);
      expect(out.kind).toBe("done");
    });

    it("an unrelated error result is failed with its text", async () => {
      expect(await run([init(), errResult("Something broke")])).toEqual({ kind: "failed", error: "Something broke", sessionId: "sess-1" });
    });
  });
});

describe("runClaude: the account's own login", () => {
  const foreign = "The worker is not running with this account's login (apiKeySource: ANTHROPIC_API_KEY). Check apiKeyHelper or the env section of that account's settings.json.";

  it("stops a run whose init line names another key source, fails it, and leaves no process", async () => {
    script({ early: [{ ...init("sess-k"), apiKeySource: "ANTHROPIC_API_KEY" }, assistant({ type: "text", text: "starting" })], delayMs: 10_000, spawnChild: true });
    const events: unknown[] = [];
    const out = await runClaude(req({ onEvent: (e) => events.push(e) }));
    expect(out).toEqual({ kind: "failed", error: foreign, sessionId: "sess-k" });
    expect(events).toEqual([]);
    const l = log();
    expect(await gone(l.pid)).toBe(true);
    expect(await gone(l.childPid!)).toBe(true);
  });

  it("is failed, never limited or done, even when a result follows in the same output", async () => {
    script({ lines: [{ ...init(), apiKeySource: "ANTHROPIC_API_KEY" }, result({ is_error: true, result: "You've hit your limit · resets 3pm" })] });
    expect(await runClaude(req())).toEqual({ kind: "failed", error: foreign, sessionId: "sess-1" });
    script({ lines: [{ ...init(), apiKeySource: "ANTHROPIC_API_KEY" }, result()] });
    expect(await runClaude(req())).toEqual({ kind: "failed", error: foreign, sessionId: "sess-1" });
  });

  it("accepts apiKeySource none and an init line without the field", async () => {
    script({ lines: [{ ...init(), apiKeySource: "none" }, result()] });
    expect((await runClaude(req())).kind).toBe("done");
    script({ lines: [init(), result()] });
    expect((await runClaude(req())).kind).toBe("done");
  });
});

describe("runClaude: stop, timeout, abort", () => {
  it("fails with the minutes when the time runs out, and the fake and its child are dead", async () => {
    // The test decides when the time is up (after the init line arrived), so a slow start of the fake cannot race it.
    script({ early: [init("sess-t"), assistant({ type: "text", text: "running" })], delayMs: 10_000, spawnChild: true });
    let timeUp: (() => void) | undefined;
    let asked: number | undefined;
    const out = await runClaude(req({
      timeoutMs: 600,
      startTimeout: (fire, ms) => {
        timeUp = fire;
        asked = ms;
        return () => {};
      },
      onEvent: () => timeUp?.(),
    }));
    expect(asked).toBe(600);
    expect(out).toEqual({ kind: "failed", error: "Timed out after 1 minute", sessionId: "sess-t" });
    const l = log();
    expect(await gone(l.pid)).toBe(true);
    expect(await gone(l.childPid!)).toBe(true);
  });

  it("cancels the timeout it started once the run is over", async () => {
    script({ lines: okLines });
    let cancelled = 0;
    await runClaude(req({ startTimeout: () => () => void cancelled++ }));
    expect(cancelled).toBe(1);
  });

  it("words the timeout in whole minutes, rounded up", () => {
    expect(timeoutMessage(30 * 60_000)).toBe("Timed out after 30 minutes");
    expect(timeoutMessage(30 * 60_000 + 1)).toBe("Timed out after 31 minutes");
    expect(timeoutMessage(200)).toBe("Timed out after 1 minute");
  });

  it("reports an abort as stopped with the session id, and kills the fake and its child", async () => {
    script({ early: [init("sess-a"), assistant({ type: "text", text: "starting" })], delayMs: 10_000, spawnChild: true });
    const ac = new AbortController();
    const out = await runClaude(req({ signal: ac.signal, onEvent: () => ac.abort() }));
    expect(out).toEqual({ kind: "stopped", sessionId: "sess-a" });
    const l = log();
    expect(await gone(l.pid)).toBe(true);
    expect(await gone(l.childPid!)).toBe(true);
  });

  it("carries the session id into a failed outcome when there is no result", async () => {
    script({ lines: [init("sess-a")] });
    expect(await runClaude(req())).toEqual({ kind: "failed", error: "claude exited with code 0 without returning a result", sessionId: "sess-a" });
  });

  it("does not start claude when already aborted", async () => {
    script({ lines: okLines });
    const ac = new AbortController();
    ac.abort();
    expect(await runClaude(req({ signal: ac.signal }))).toEqual({ kind: "stopped" });
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("SIGKILLs a process that ignores SIGTERM once the grace has passed", async () => {
    script({ early: [init("sess-k"), assistant({ type: "text", text: "go" })], delayMs: 30_000, ignoreSigterm: true, spawnChild: true });
    const ac = new AbortController();
    let t0 = 0;
    const p = runClaude(req({ signal: ac.signal, killGraceMs: 300, onEvent: () => { t0 = Date.now(); ac.abort(); } }));
    expect(await p).toEqual({ kind: "stopped", sessionId: "sess-k" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const l = log();
    expect(await gone(l.pid)).toBe(true);
    expect(await gone(l.childPid!)).toBe(true);
  });

  it("uses 5 s and 2 s as the default graces", () => {
    expect(KILL_GRACE_MS).toBe(5_000);
    expect(CLOSE_GRACE_MS).toBe(2_000);
  });

  it("returns after claude exits even if a leaked child holds stdout open", async () => {
    script({ lines: okLines, spawnChild: true, childInheritsStdout: true });
    let childPid: number | undefined;
    try {
      const out = await runClaude(req({ closeGraceMs: 300 }));
      childPid = log().childPid;
      expect(out.kind).toBe("done");
    } finally {
      childPid ??= log().childPid;
      if (childPid) try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("prefers a limit result received before an abort", async () => {
    // The abort comes from a line printed after the limit result, so the result has surely been read by then.
    const limit = result({ is_error: true, session_id: "sess-l", result: "You've hit your Fable limit · resets 1am" });
    script({ early: [init("sess-l"), limit, assistant({ type: "text", text: "sau" })], delayMs: 10_000, spawnChild: true });
    const ac = new AbortController();
    expect(await runClaude(req({ signal: ac.signal, onEvent: () => ac.abort() }))).toEqual({
      kind: "limited", message: "You've hit your Fable limit · resets 1am", sessionId: "sess-l",
    });
    const l = log();
    expect(await gone(l.pid)).toBe(true);
    expect(await gone(l.childPid!)).toBe(true);
  });

  it("leaves no abort listener and no timer behind after a normal run or a timeout", async () => {
    const tracker = trackTimers();
    try {
      script({ lines: okLines });
      const ac = new AbortController();
      await runClaude(req({ signal: ac.signal, timeoutMs: 20_000 }));
      expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
      expect(tracker.created()).toBeGreaterThan(0);
      expect(tracker.pending()).toBe(0);
      ac.abort(); // after finishing: must be harmless

      script({ early: [init()], delayMs: 10_000 });
      const ac2 = new AbortController();
      expect(await runClaude(req({ signal: ac2.signal, timeoutMs: 300, killGraceMs: 300 }))).toMatchObject({ kind: "failed" });
      expect(getEventListeners(ac2.signal, "abort")).toHaveLength(0);
      expect(tracker.pending()).toBe(0);
    } finally {
      tracker.restore();
    }
  });
});

describe("decideOutcome (what a finished run was)", () => {
  type Res = NonNullable<OutcomeFacts["result"]>;
  const limited: Res = { kind: "limited", message: "You've hit your limit", sessionId: "s" };
  const failed: Res = { kind: "failed", error: "Something broke", sessionId: "s" };
  const done: Res = { kind: "done", result: "ok", sessionId: "s", denials: [] };
  const base = { stderrTail: "", timeoutMs: 30 * 60_000, sessionId: "s" };

  it.each(["abort", "timeout"] as const)("a received limit result wins over %s", (stopReason) => {
    expect(decideOutcome({ ...base, result: limited, stopReason })).toEqual(limited);
  });

  it("a received failed result gives way to the stop", () => {
    expect(decideOutcome({ ...base, result: failed, stopReason: "abort" })).toEqual({ kind: "stopped", sessionId: "s" });
    expect(decideOutcome({ ...base, result: failed, stopReason: "timeout" })).toEqual({ kind: "failed", error: "Timed out after 30 minutes", sessionId: "s" });
  });

  it.each(["abort", "timeout"] as const)("a received done result wins over %s", (stopReason) => {
    expect(decideOutcome({ ...base, result: done, stopReason })).toEqual(done);
  });

  it("no result and a stop: stopped, or the timeout", () => {
    expect(decideOutcome({ ...base, stopReason: "abort" })).toEqual({ kind: "stopped", sessionId: "s" });
    expect(decideOutcome({ ...base, stopReason: "timeout", timeoutMs: 600 })).toEqual({ kind: "failed", error: "Timed out after 1 minute", sessionId: "s" });
  });

  it("another login wins over every result and stop; a spawn error over everything", () => {
    for (const result of [limited, failed, done, undefined]) {
      for (const stopReason of ["abort", "timeout", "foreign-login", undefined] as const) {
        expect(decideOutcome({ ...base, result, stopReason, foreignKeySource: "ANTHROPIC_API_KEY" })).toMatchObject({ kind: "failed", error: expect.stringContaining("apiKeySource: ANTHROPIC_API_KEY") });
        expect(decideOutcome({ ...base, result, stopReason, foreignKeySource: "x", spawnError: "ENOENT" })).toEqual({ kind: "failed", error: "Could not run the claude command: ENOENT" });
      }
    }
  });

  it("no result and no stop: the stderr tail, else how claude ended", () => {
    expect(decideOutcome({ ...base, stderrTail: "  Not logged in \n" })).toEqual({ kind: "failed", error: "Not logged in", sessionId: "s" });
    expect(decideOutcome({ ...base, exit: { code: 0, signal: null } })).toEqual({ kind: "failed", error: "claude exited with code 0 without returning a result", sessionId: "s" });
    expect(decideOutcome({ ...base, exit: { code: null, signal: "SIGKILL" } })).toEqual({ kind: "failed", error: "claude was stopped by signal SIGKILL without returning a result", sessionId: "s" });
  });
});

/** Records timers created through the global setTimeout and which of them were neither cleared nor fired. */
function trackTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  let created = 0;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    created++;
    const t = realSet(() => { live.delete(t); fn(...args); }, ms);
    live.add(t);
    return t;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => {
    live.delete(t);
    realClear(t);
  }) as typeof clearTimeout;
  return {
    created: () => created,
    pending: () => live.size,
    restore: () => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; },
  };
}

describe("toolText", () => {
  it.each([
    [{ name: "Read", input: { file_path: "/a/b/login.test.ts" } }, "Read login.test.ts"],
    [{ name: "Edit", input: { file_path: "/a/b/c.ts" } }, "Edit c.ts"],
    [{ name: "NotebookEdit", input: { notebook_path: "/a/n.ipynb" } }, "Edit n.ipynb"],
    [{ name: "Write", input: { file_path: "/a/new.md" } }, "Write new.md"],
    [{ name: "Bash", input: { command: "git status" } }, "Run: git status"],
    [{ name: "Grep", input: { pattern: "TODO" } }, "Search: TODO"],
    [{ name: "Glob", input: { pattern: "**/*.ts" } }, "Search: **/*.ts"],
    [{ name: "Task", input: { description: "investigate the error" } }, "Delegate to subagent: investigate the error"],
    [{ name: "Agent", input: { description: "investigate the error" } }, "Delegate to subagent: investigate the error"],
    [{ name: "WebFetch", input: { url: "https://x.y" } }, "Web: https://x.y"],
    [{ name: "WebSearch", input: { query: "vitest" } }, "Web: vitest"],
    [{ name: "Skill", input: { skill: "x" } }, "Skill"],
    [{ name: "Read", input: {} }, "Read"],
    [{ name: "Read" }, "Read"],
  ])("%j -> %s", (block, text) => {
    expect(toolText(block)).toBe(text);
  });

  it("cuts a long command to 80 chars on one line", () => {
    const t = toolText({ name: "Bash", input: { command: "echo\n" + "x".repeat(200) } });
    expect(t.startsWith("Run: echo x")).toBe(true);
    expect(t.length).toBeLessThanOrEqual("Run: ".length + 80);
  });
});
