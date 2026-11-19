import { test, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { childEnv } from "../accounts/env.js";
import { checkAccount } from "./connection.js";
import type { ConnectionState, Account } from "../types.js";

type ExecResult = { code: number; stdout: string };

function deps(o: { which?: (c: string) => string | null; exec?: () => Promise<ExecResult> } = {}) {
  const execCalls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  return {
    execCalls,
    deps: {
      which: o.which ?? ((c: string) => `/bin/${c}`),
      exec: async (cmd: string, args: string[], env: Record<string, string>) => {
        execCalls.push({ cmd, args, env });
        return o.exec ? o.exec() : { code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) };
      },
    },
  };
}
const account = (p: Partial<Account>): Account => ({ id: "p", name: "P", accepting: false, allowedDirs: [], reservePct: 90, ...p });

test.each<[string, Parameters<typeof deps>[0], ConnectionState, string | undefined]>([
  ["subscription, claude not installed", { which: () => null }, "not-installed", "The claude command was not found on the PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin"],
  ["subscription, logged in", {}, "connected", "max"],
  ["subscription, not logged in", { exec: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }) }) }, "not-logged-in", undefined],
  ["subscription, garbage output", { exec: async () => ({ code: 1, stdout: "oops" }) }, "error", undefined],
])("%s", async (_name, o, state, detail) => {
  const status = await checkAccount(account({}), deps(o).deps);
  expect(status.state).toBe(state);
  if (detail !== undefined) expect(status.detail).toContain(detail);
  expect(status.checkedAt).toEqual(expect.any(Number));
});

test("subscription calls `claude auth status --json` and drops CLAUDE_CONFIG_DIR when using ~/.claude", async () => {
  const d = deps();
  await checkAccount(account({ configDir: path.join(os.homedir(), ".claude") }), d.deps);
  await checkAccount(account({ configDir: "/cfg/b" }), d.deps);
  expect(d.execCalls[0]).toMatchObject({ cmd: "/bin/claude", args: ["auth", "status", "--json"] });
  expect("CLAUDE_CONFIG_DIR" in d.execCalls[0]!.env).toBe(false);
  expect(d.execCalls[1]!.env.CLAUDE_CONFIG_DIR).toBe("/cfg/b");
});

test("`claude auth status` gets the shared child environment: no login override, no session identity", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDECODE: "1", AOLANGAI_RUN_ID: "4" });
    const d = deps();
    const a = account({ configDir: "/cfg/b" });
    await checkAccount(a, d.deps);
    const env = d.execCalls[0]!.env;
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDECODE", "AOLANGAI_RUN_ID"]) expect(env[k]).toBeUndefined();
    expect(env).toEqual(childEnv(process.env, a));
  } finally {
    process.env = saved;
  }
});
