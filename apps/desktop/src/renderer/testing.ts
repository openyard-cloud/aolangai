// Builders for renderer tests: small valid values to override field by field.
import { DEFAULT_LIMITS, type Account, type AccountStatus, type Run } from "@aolangai/core";
import type { AppState } from "../shared/api.js";

export const account = (o: Partial<Account> = {}): Account => ({
  id: "a1",
  name: "Claude B",
  accepting: true,
  allowedDirs: [],
  reservePct: 90,
  ...o,
});

export const run = (o: Partial<Run> = {}): Run => ({
  id: 1,
  prompt: "read hello.txt",
  cwd: "/Users/x/Projects/demo",
  accountId: "a1",
  primaryWorker: false,
  readOnly: false,
  status: "done",
  createdAt: 1_000_000,
  ...o,
});

export const status = (o: Partial<AccountStatus> = {}): AccountStatus => ({ accountId: "a1", ...o });

export const appState = (o: Partial<AppState> = {}): AppState => ({
  accounts: [],
  statuses: [],
  runs: [],
  limits: { ...DEFAULT_LIMITS },
  install: { skill: "current", shim: "current", accounts: [] },
  sessions: [],
  app: { packaged: false, openAtLogin: false, claudeFound: true },
  ...o,
});
