import fs from "node:fs";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { childEnv } from "../accounts/env.js";
import type { Account } from "../types.js";

export type QueryFn = typeof sdkQuery;

/** Asks one account's plan usage; `signal` aborts a hung ask. The answer is untrusted. */
export type UsageFetch = (a: Account, signal: AbortSignal) => Promise<unknown>;

export interface UsageFetcherOptions {
  /** The installed `claude` CLI. */
  claudePath: string;
  /** An empty folder the app owns; never a project folder. */
  cwd: string;
  /** Injected in tests so no Claude process starts. */
  query?: QueryFn;
}

/**
 * Reads an account's plan quota through the Agent SDK: starts Claude Code with the account's
 * config dir, sends no prompt (the prompt stream never yields), asks usage, closes the process. The token stays
 * inside Claude Code. The SDK call is experimental: callers must treat the answer as untrusted and may get errors.
 * `signal` aborts a hung ask: the Claude process is closed and the promise rejects.
 */
export function createUsageFetcher(o: UsageFetcherOptions): UsageFetch {
  const query = o.query ?? sdkQuery;
  return async (account, signal) => {
    const aborted = () => new Error("The quota check was cancelled");
    if (signal.aborted) throw aborted();
    fs.mkdirSync(o.cwd, { recursive: true });
    let end!: () => void;
    const ended = new Promise<void>((r) => (end = r));
    const silent = (async function* () {
      await ended;
    })();
    const q = query({
      prompt: silent,
      options: {
        cwd: o.cwd,
        env: childEnv(process.env, account),
        settingSources: [],
        persistSession: false,
        pathToClaudeCodeExecutable: o.claudePath,
      },
    });
    let onAbort!: () => void;
    const abort = new Promise<never>((_, reject) => (onAbort = () => reject(aborted())));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), abort]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      end();
      q.close();
    }
  };
}
