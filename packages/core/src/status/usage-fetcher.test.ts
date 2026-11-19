import { afterEach, beforeEach, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv } from "../accounts/env.js";
import { createUsageFetcher, type QueryFn } from "./usage-fetcher.js";
import type { Account } from "../types.js";

const claudePath = "/bin/claude-real";
const saved = { ...process.env };
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "inherited-key";
  process.env.CLAUDECODE = "1";
  process.env.CLAUDE_CONFIG_DIR = "/inherited/config";
});
afterEach(() => {
  process.env = { ...saved };
});

const account = (p: Partial<Account> = {}): Account => ({ id: "p", name: "P", accepting: false, allowedDirs: [], reservePct: 90, ...p });

function fakeQuery(usage: () => Promise<unknown>) {
  const calls: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }[] = [];
  let closed = 0;
  const query = ((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    calls.push(args);
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (o: unknown) => {
        calls.at(-1)!.options.usageOpts = o;
        return usage();
      },
      close: () => void closed++,
    };
  }) as unknown as QueryFn;
  return { query, calls, closed: () => closed };
}

const cwd = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-probe-")), "probe");

test("asks usage with no prompt, no saved session and no project settings, then closes", async () => {
  const f = fakeQuery(async () => ({ rate_limits_available: true }));
  const dir = cwd();
  const fetch = createUsageFetcher({ claudePath, cwd: dir, query: f.query });
  expect(await fetch(account({ configDir: "/cfg/b" }), new AbortController().signal)).toEqual({ rate_limits_available: true });
  const { options, prompt } = f.calls[0]!;
  expect(options).toMatchObject({ cwd: dir, settingSources: [], persistSession: false, pathToClaudeCodeExecutable: "/bin/claude-real", usageOpts: { skipBehaviors: true } });
  const env = options.env as Record<string, string>;
  expect(env.CLAUDE_CONFIG_DIR).toBe("/cfg/b");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CLAUDECODE).toBeUndefined();
  expect(fs.existsSync(dir)).toBe(true);
  expect(f.closed()).toBe(1);
  // the prompt never yields a message; it ends once the ask is over
  expect(await prompt[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
});

test("default ~/.claude leaves CLAUDE_CONFIG_DIR unset", async () => {
  const f = fakeQuery(async () => ({}));
  await createUsageFetcher({ claudePath, cwd: cwd(), query: f.query })(account(), new AbortController().signal);
  expect((f.calls[0]!.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBeUndefined();
});

test("the prompt stays silent while the ask is pending", async () => {
  let answer!: (v: unknown) => void;
  const f = fakeQuery(() => new Promise((r) => (answer = r)));
  const pending = createUsageFetcher({ claudePath, cwd: cwd(), query: f.query })(account(), new AbortController().signal);
  const next = f.calls[0]!.prompt[Symbol.asyncIterator]().next();
  const raced = await Promise.race([next.then(() => "yielded"), new Promise((r) => setTimeout(() => r("silent"), 20))]);
  expect(raced).toBe("silent");
  answer({});
  await pending;
  expect(await next).toEqual({ done: true, value: undefined });
});

test("closes the query when the ask fails", async () => {
  const f = fakeQuery(async () => {
    throw new Error("boom");
  });
  await expect(createUsageFetcher({ claudePath, cwd: cwd(), query: f.query })(account(), new AbortController().signal)).rejects.toThrow("boom");
  expect(f.closed()).toBe(1);
});

test("aborting a hung ask closes the query once and rejects", async () => {
  const f = fakeQuery(() => new Promise(() => {}));
  const ac = new AbortController();
  const pending = createUsageFetcher({ claudePath, cwd: cwd(), query: f.query })(account(), ac.signal);
  await new Promise((r) => setTimeout(r, 5));
  expect(f.closed()).toBe(0);
  ac.abort();
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(f.closed()).toBe(1);
});

test("an already aborted signal never starts Claude", async () => {
  const f = fakeQuery(async () => ({}));
  const ac = new AbortController();
  ac.abort();
  await expect(createUsageFetcher({ claudePath, cwd: cwd(), query: f.query })(account(), ac.signal)).rejects.toThrow(/cancelled/);
  expect(f.calls.length).toBe(0);
});

test("the quota ask gets the shared child environment: no login override, no session identity", async () => {
  Object.assign(process.env, { CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_SESSION_ID: "s", AOLANGAI_RUN_ID: "4" });
  const f = fakeQuery(async () => ({}));
  const a = account({ configDir: "/cfg/b" });
  await createUsageFetcher({ claudePath, cwd: cwd(), query: f.query })(a, new AbortController().signal);
  const env = f.calls[0]!.options.env as Record<string, string>;
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_SESSION_ID", "AOLANGAI_RUN_ID"]) expect(env[k]).toBeUndefined();
  expect(env).toEqual(childEnv(process.env, a));
});
