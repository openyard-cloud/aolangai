import { describe, test, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Account } from "../types.js";
import { applyClaudeConfigDir, CLAUDE_NOT_FOUND, CLAUDE_SEARCH_DIRS, childEnv, findExecutable } from "./env.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

test("a custom config dir sets CLAUDE_CONFIG_DIR and keeps the rest of the env", () => {
  expect(applyClaudeConfigDir({ KEEP_ME: "1", CLAUDE_CONFIG_DIR: "/old" }, "/cfg/b")).toEqual({ KEEP_ME: "1", CLAUDE_CONFIG_DIR: "/cfg/b" });
});

test("a config dir starting with ~ is expanded", () => {
  expect(applyClaudeConfigDir({}, "~/cfg/b").CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), "cfg/b"));
});

test.each([[undefined], [""], ["~/.claude"], [path.join(os.homedir(), ".claude")], [path.join(os.homedir(), ".claude") + "/"]])(
  "the default ~/.claude (%s) removes CLAUDE_CONFIG_DIR, even an inherited one",
  (configDir) => {
    expect("CLAUDE_CONFIG_DIR" in applyClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/inherited/config", KEEP_ME: "1" }, configDir)).toBe(false);
  },
);

test("CLAUDE_NOT_FOUND says that claude was not found and names every folder findExecutable searches, in order", () => {
  expect(CLAUDE_NOT_FOUND).toBe("The claude command was not found on the PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin");
  const named = CLAUDE_SEARCH_DIRS.map((d) => (d.startsWith(os.homedir() + "/") ? "~" + d.slice(os.homedir().length) : d));
  let from = 0;
  for (const d of named) {
    const at = CLAUDE_NOT_FOUND.indexOf(d, from);
    expect(at, d).toBeGreaterThan(-1);
    from = at + d.length;
  }
});

test("findExecutable finds a command on PATH and by absolute path, and refuses non-executables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-bin-"));
  const exe = path.join(dir, "fake-tool");
  fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  const plain = path.join(dir, "plain-file");
  fs.writeFileSync(plain, "x", { mode: 0o644 });
  process.env.PATH = dir;
  expect(findExecutable("fake-tool")).toBe(exe);
  expect(findExecutable(exe)).toBe(exe);
  expect(findExecutable(plain)).toBeNull();
  expect(findExecutable("plain-file")).toBeNull();
  expect(findExecutable("definitely-not-installed-aolangai")).toBeNull();
});

describe("childEnv", () => {
  const acct = (configDir?: string): Account => ({ id: "a", name: "A", accepting: true, allowedDirs: [], reservePct: 90, ...(configDir !== undefined ? { configDir } : {}) });

  /** The names a Code session inside the Claude desktop app runs with (as observed), plus other credential names. */
  const CLAUDE_NAMES = [
    "CLAUDE_AGENT_SDK_MCP_NO_PREFIX", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST",
    "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_CODE_DESKTOP_MESSAGE_CARD", "CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR",
    "CLAUDE_CODE_DESKTOP_WORKFLOW_LIMIT_WAIT", "CLAUDE_CODE_DISABLE_CRON", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "CLAUDE_CODE_EAGER_FLUSH",
    "CLAUDE_CODE_EMIT_STARTUP_TIMING", "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES", "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_ENTRYPOINT_ON_REQUESTS",
    "CLAUDE_CODE_HOST_GUARDS_ARTIFACTS_MCP", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_HOST_SHORT_TEMP_DIRS", "CLAUDE_CODE_MCP_APPS_HOST",
    "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_PLUGIN_ATTRIBUTION",
    "CLAUDE_CODE_RATE_LIMIT_TIER", "CLAUDE_CODE_REPORT_FINDINGS", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
    "CLAUDE_CODE_SDK_READS_SESSION_STATE", "CLAUDE_CODE_SESSION_NAME", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SKILL_ATTRIBUTION",
    "CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "CLAUDE_CODE_SUBSCRIPTION_TYPE", "CLAUDE_CODE_TERMINAL_MCP_TOOLS", "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
    // credential and provider names the earlier deny-list missed or covered
    "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_SESSIONS_OAUTH_TOKEN",
    "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_PID", "CLAUDE_EFFORT",
    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL",
    "CLAUDE_",
    "CLAUDECODE", "AOLANGAI_RUN_ID",
  ];
  const ORDINARY = {
    PATH: "/home/u/.local/bin:/bin", HOME: "/h", LANG: "vi_VN.UTF-8", HTTPS_PROXY: "http://p:1", HTTP_PROXY: "http://p:1", NO_PROXY: "localhost",
    NODE_EXTRA_CA_CERTS: "/ca.pem", SSL_CERT_FILE: "/ca.pem", MY_VAR: "1", AOLANGAI_DB: "/db", FAKE_CLAUDE_LOG: "/log",
    // near misses: not CLAUDE_ / ANTHROPIC_ prefixed, not CLAUDECODE
    XCLAUDE_FOO: "1", CLAUDEX: "1", claude_lower: "1", XANTHROPIC_FOO: "1", ANTHROPICX: "1",
  };
  const polluted = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(CLAUDE_NAMES.map((n) => [n, "x"])),
    CLAUDE_CONFIG_DIR: "/inherited/elsewhere",
    ...ORDINARY,
    UNDEF: undefined,
  });

  test("an account with a custom config dir gets exactly the ordinary variables plus its own CLAUDE_CONFIG_DIR", () => {
    expect(Object.keys(childEnv(polluted(), acct("/cfg/b"))).sort()).toEqual([...Object.keys(ORDINARY), "CLAUDE_CONFIG_DIR"].sort());
    expect(childEnv(polluted(), acct("/cfg/b"))).toEqual({ ...ORDINARY, CLAUDE_CONFIG_DIR: "/cfg/b" });
  });

  test("the default account gets exactly the ordinary variables, and no key starting with CLAUDE_ or ANTHROPIC_", () => {
    const env = childEnv(polluted(), acct());
    expect(env).toEqual(ORDINARY);
    expect(Object.keys(env).filter((k) => k.startsWith("CLAUDE_") || k.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(childEnv(polluted(), acct("~/.claude"))).toEqual(ORDINARY);
  });

  test("a name is removed only when it starts with CLAUDE_ or ANTHROPIC_, or is CLAUDECODE or AOLANGAI_RUN_ID", () => {
    for (const k of ["CLAUDE_X", "CLAUDE_CODE_FUTURE_HOST_FLAG", "ANTHROPIC_X", "CLAUDECODE", "AOLANGAI_RUN_ID"]) expect(k in childEnv({ [k]: "1", PATH: "/bin" }, acct())).toBe(false);
    for (const k of ["CLAUDEX", "XCLAUDE_FOO", "CLAUDECODE2", "ANTHROPIC", "CLAUDE", "AOLANGAI_RUN_ID_X", "AOLANGAI_DB"]) expect(childEnv({ [k]: "1" }, acct())).toEqual({ [k]: "1" });
  });

  test("ELECTRON_RUN_AS_NODE is removed so a child that is an Electron app does not start as plain node", () => {
    const env = childEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/x" }, {});
    expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
    expect(env.PATH).toBe("/x");
  });

  test("ignores undefined values", () => {
    expect(childEnv({ A: undefined, B: "1" }, acct())).toEqual({ B: "1" });
  });

  test("a custom config dir is set; the default ~/.claude removes even an inherited CLAUDE_CONFIG_DIR", () => {
    expect(childEnv({ CLAUDE_CONFIG_DIR: "/inherited" }, acct("/cfg/b"))).toEqual({ CLAUDE_CONFIG_DIR: "/cfg/b" });
    expect(childEnv({ CLAUDE_CONFIG_DIR: "/inherited" }, acct("~/cfg/b")).CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), "cfg/b"));
    expect(childEnv({ CLAUDE_CONFIG_DIR: "/inherited" }, acct())).toEqual({});
    expect(childEnv({ CLAUDE_CONFIG_DIR: "/inherited" }, acct("~/.claude"))).toEqual({});
  });

  test("does not change the base it was given", () => {
    const base = { ANTHROPIC_API_KEY: "k", PATH: "/bin" };
    childEnv(base, acct("/cfg"));
    expect(base).toEqual({ ANTHROPIC_API_KEY: "k", PATH: "/bin" });
  });
});
