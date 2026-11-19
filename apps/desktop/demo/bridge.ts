// An in-memory stand-in for the main process, so the real window runs in a plain browser on sample data. Nothing
// here touches a machine: methods that would (Terminal, files, Claude Code) only explain, through `explain`, what the
// app does at that point.
import type { Account, ConnectionStatus, Limits, Run, RunEvent } from "@aolangai/core";
import {
  API_METHODS,
  AUTO_CONFIG_DIR,
  DESKTOP_KIND,
  TERMINAL_KIND,
  type AolangaiBridge,
  type ApiMethod,
  type AppApi,
  type AppInstallStatus,
  type AppNotice,
  type AppState,
  type OpenSession,
} from "../src/shared/api.js";
import { validateLimits } from "../src/shared/limits.js";

/** How a running run goes on by itself: one step every `everyMs`, then `done` with `finish` one interval after the last step. */
export interface RunPlan {
  everyMs: number;
  steps: { kind: RunEvent["kind"]; text: string }[];
  finish: Partial<Pick<Run, "result" | "inputTokens" | "outputTokens" | "contextTokens">>;
}

export interface DemoOptions {
  now?: () => number;
  setTimeout?: typeof setTimeout;
  /** Worker steps already taken, per run id. */
  events?: Record<number, RunEvent[]>;
  /** Runs that move on by themselves. Leave out for a demo that stands still (screenshots). */
  plans?: Record<number, RunPlan>;
  /** When set, the quota numbers are "fetched again" this often, as the app's poller does. */
  refreshQuotaEveryMs?: number;
  /** Told what the real app does when a method needs a real machine; one sentence per call. Left out: nothing is shown. */
  explain?: (text: string) => void;
}

export const NOTICE_TITLE = "Demo";
/** A retry is done this long after it starts. */
export const RETRY_MS = 5000;
/** "Open Terminal" adds its session to the lane after this long, as if Terminal had opened. */
export const TERMINAL_DELAY_MS = 1000;

/** What the real app does at each method that needs a real machine; the demo only says so. */
const MACHINE_NOTICE = {
  loginAccount: "In the app this opens Terminal and runs claude auth login for this account.",
  openAccountTerminal: "In the app this opens Terminal in a folder you pick and starts claude on this account.",
  openInTerminal: "In the app this opens Terminal in the run's folder and resumes its session with claude --resume.",
  openAccountSettings: "In the app this opens the account's settings.json in your default editor.",
  focusSession: "In the app this brings the Terminal tab or the app window of this session to the front.",
  install: "In the app this writes the skill into each Claude config dir and the aolangai command into ~/.local/bin.",
  checkAccount: "In the app this runs claude auth status for this account and shows whether it is logged in.",
  openExternal: "In the app this opens the link in your default browser.",
} as const satisfies Partial<Record<ApiMethod, string>>;
export const MACHINE_ONLY = Object.keys(MACHINE_NOTICE) as (keyof typeof MACHINE_NOTICE)[];

const DEMO_HOME = "/Users/you";
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? DEMO_HOME + p.slice(1) : p);
const RETRY_STEPS: RunPlan["steps"] = [
  { kind: "tool", text: "Run: git status" },
  { kind: "text", text: "Picking up where the first attempt stopped." },
  { kind: "tool", text: "Run: npm test" },
];

export function createDemoBridge(sample: AppState, opts: DemoOptions = {}): AolangaiBridge {
  const now = opts.now ?? (() => Date.now());
  const later = (ms: number, cb: () => void) => void (opts.setTimeout ?? setTimeout)(cb, ms);
  const state: AppState = structuredClone(sample);
  const events = new Map<number, RunEvent[]>(Object.entries(structuredClone(opts.events ?? {})).map(([id, list]) => [Number(id), list]));
  let eventSeq = Math.max(0, ...[...events.values()].flat().map((e) => e.id));
  let accountSeq = 0;
  let pidSeq = 80_000;
  let ttySeq = 20;
  const stateListeners = new Set<(s: AppState) => void>();
  const noticeListeners = new Set<(n: AppNotice) => void>();

  /** Calls every listener; one that throws is logged and never keeps the others (or the caller) from going on. */
  const callEach = <T>(listeners: Set<(v: T) => void>, value: () => T) => {
    for (const cb of listeners) {
      try {
        cb(value());
      } catch (e) {
        console.error("aolangai demo: a listener failed", e);
      }
    }
  };
  const push = () => callEach(stateListeners, () => structuredClone(state));
  const notice = (body: string) => callEach(noticeListeners, () => ({ title: NOTICE_TITLE, body }));
  const explain = (text: string) => {
    try {
      opts.explain?.(text);
    } catch (e) {
      console.error("aolangai demo: explain failed", e);
    }
  };
  const accountOrThrow = (id: string): Account => {
    const a = state.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`No account ${id}`);
    return a;
  };
  const runOrThrow = (id: number): Run => {
    const r = state.runs.find((x) => x.id === id);
    if (!r) throw new Error(`No run #${id}`);
    return r;
  };
  const addEvent = (runId: number, step: RunPlan["steps"][number]) => {
    const list = events.get(runId) ?? [];
    list.push({ id: ++eventSeq, runId, kind: step.kind, text: step.text, createdAt: now() });
    events.set(runId, list);
  };

  /** Plays `plan` on a running run; every timer checks the run is still running, so Stop ends it. */
  const play = (runId: number, plan: RunPlan) => {
    const stillRunning = () => state.runs.find((r) => r.id === runId)?.status === "running";
    plan.steps.forEach((step, i) =>
      later(plan.everyMs * (i + 1), () => {
        if (stillRunning()) addEvent(runId, step);
      }),
    );
    later(plan.everyMs * (plan.steps.length + 1), () => {
      if (!stillRunning()) return;
      Object.assign(runOrThrow(runId), plan.finish, { status: "done", finishedAt: now() });
      push();
    });
  };

  const stop = (r: Run) => Object.assign(r, { status: "stopped", finishedAt: now() });
  /** Claude desktop sessions belong to the account the owner declared, or to no lane. */
  const assignDesktop = () => {
    for (const s of state.sessions) if (s.kind === DESKTOP_KIND) s.accountId = state.desktopAccountId;
  };
  const folderAllowed = (a: Account, cwd: string) => a.allowedDirs.length === 0 || a.allowedDirs.some((d) => cwd === expandHome(d) || cwd.startsWith(`${expandHome(d)}/`));

  const api: AppApi = {
    async getState() {
      return structuredClone(state);
    },

    async saveAccount(input) {
      const existing = input.id !== undefined ? state.accounts.find((a) => a.id === input.id) : undefined;
      if (input.id !== undefined && !existing) throw new Error("This account no longer exists (it may have just been deleted)");
      if (input.configDir?.trim() === AUTO_CONFIG_DIR && existing) throw new Error(`"${AUTO_CONFIG_DIR}" can only be used when creating a new account`);
      const id = existing?.id ?? `demo-account-${++accountSeq}`;
      const configDir = input.configDir?.trim() === AUTO_CONFIG_DIR ? `${DEMO_HOME}/Library/Application Support/aolangai/profiles/${id}` : input.configDir?.trim() || undefined;
      const account: Account = {
        id,
        name: input.name.trim(),
        ...(configDir ? { configDir } : {}),
        ...(input.model?.trim() ? { model: input.model.trim() } : {}),
        // A new account never takes work until the owner turns it on, as in the app.
        accepting: existing ? Boolean(input.accepting) : false,
        allowedDirs: [...input.allowedDirs],
        reservePct: input.reservePct,
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      };
      if (existing) state.accounts[state.accounts.indexOf(existing)] = account;
      else state.accounts.push(account);
      const place = state.install.accounts.find((p) => p.accountId === id);
      if (configDir && !place) state.install.accounts.push({ accountId: id, file: `${configDir}/skills/aolangai/SKILL.md`, skill: "no-dir" });
      if (!configDir && place) state.install.accounts.splice(state.install.accounts.indexOf(place), 1);
      push();
      return structuredClone(account);
    },

    async deleteAccount(id) {
      accountOrThrow(id);
      if (state.runs.some((r) => r.accountId === id && r.status === "running")) throw new Error("The account has runs in progress, stop them before deleting it");
      state.accounts = state.accounts.filter((a) => a.id !== id);
      state.statuses = state.statuses.filter((s) => s.accountId !== id);
      state.install.accounts = state.install.accounts.filter((p) => p.accountId !== id);
      if (state.desktopAccountId === id) {
        delete state.desktopAccountId;
        assignDesktop();
      }
      push();
    },

    async checkAccount(id) {
      accountOrThrow(id);
      explain(MACHINE_NOTICE.checkAccount);
      const connection: ConnectionStatus = { state: "connected", checkedAt: now() };
      const status = state.statuses.find((s) => s.accountId === id);
      if (status) status.connection = connection;
      else state.statuses.push({ accountId: id, connection });
      push();
      return connection;
    },

    async loginAccount(id) {
      accountOrThrow(id);
      explain(MACHINE_NOTICE.loginAccount);
    },

    async openAccountTerminal(id) {
      const account = accountOrThrow(id);
      explain(MACHINE_NOTICE.openAccountTerminal);
      const lastCwd = state.runs.find((r) => r.accountId === id)?.cwd;
      const cwd = account.allowedDirs[0] !== undefined ? expandHome(account.allowedDirs[0]) : (lastCwd ?? `${DEMO_HOME}/Projects/app`);
      later(TERMINAL_DELAY_MS, () => {
        if (!state.accounts.some((a) => a.id === id)) return;
        const session: OpenSession = {
          pid: ++pidSeq,
          kind: TERMINAL_KIND,
          accountId: id,
          cwd,
          startedAt: now(),
          tty: `ttys0${++ttySeq}`,
          appPath: "/System/Applications/Utilities/Terminal.app",
          name: "Claude Code",
        };
        state.sessions.push(session);
        push();
      });
    },

    async openAccountSettings(id) {
      accountOrThrow(id);
      explain(MACHINE_NOTICE.openAccountSettings);
    },

    async runEvents(runId) {
      return structuredClone(events.get(runId) ?? []);
    },

    async stopRun(id) {
      const r = state.runs.find((x) => x.id === id);
      if (r?.status !== "running") return;
      stop(r);
      push();
    },

    async stopAll() {
      const running = state.runs.filter((r) => r.status === "running");
      running.forEach(stop);
      if (running.length > 0) push();
      return running.length;
    },

    async retryRun(id) {
      const run = runOrThrow(id);
      if (run.status === "running") throw new Error(`Run #${id} is still running, it cannot be retried yet`);
      // The command picks the account with the most quota left; the demo keeps the same one when it may still take work.
      const takes = (a: Account) => a.accepting && folderAllowed(a, run.cwd);
      const own = state.accounts.find((a) => a.id === run.accountId);
      const account = own && takes(own) ? own : state.accounts.find(takes);
      if (!account) {
        notice(`Retry of run #${id} could not start: No account can take this run`);
        return;
      }
      const newId = Math.max(0, ...state.runs.map((r) => r.id)) + 1;
      const retry: Run = {
        id: newId,
        prompt: run.prompt,
        ...(run.label !== undefined ? { label: run.label } : {}),
        cwd: run.cwd,
        accountId: account.id,
        sessionId: `demo-session-${newId}`,
        primaryWorker: false,
        readOnly: run.readOnly,
        status: "running",
        retryOf: id,
        createdAt: now(),
      };
      state.runs.unshift(retry);
      push();
      play(newId, {
        everyMs: RETRY_MS / (RETRY_STEPS.length + 1),
        steps: RETRY_STEPS,
        finish: { result: "Done on the second try. `npm test` passes.", inputTokens: 12_400, outputTokens: 860, contextTokens: 9_870 },
      });
    },

    async openInTerminal(runId) {
      runOrThrow(runId);
      explain(MACHINE_NOTICE.openInTerminal);
    },

    async setLimits(l: Limits) {
      const errors = validateLimits(l);
      if (errors.length > 0) throw new Error(errors.join(" "));
      state.limits = { ...l };
      push();
    },

    async setDesktopAccount(id) {
      if (id !== null && !state.accounts.some((a) => a.id === id)) throw new Error("This account no longer exists (it may have just been deleted)");
      if (id === null) delete state.desktopAccountId;
      else state.desktopAccountId = id;
      assignDesktop();
      push();
    },

    async install() {
      explain(MACHINE_NOTICE.install);
      const installed: AppInstallStatus = {
        skill: "current",
        shim: "current",
        accounts: state.install.accounts.map((p) => ({ ...p, skill: "current" })),
      };
      state.install = installed;
      push();
      return structuredClone(installed);
    },

    async setOpenAtLogin(on) {
      if (typeof on !== "boolean") throw new Error("Invalid value");
      if (!state.app.packaged) throw new Error("Can only be turned on in the packaged app");
      state.app.openAtLogin = on;
      push();
    },

    async openExternal() {
      explain(MACHINE_NOTICE.openExternal);
    },

    async focusSession() {
      explain(MACHINE_NOTICE.focusSession);
    },
  };

  for (const r of state.runs) {
    const plan = opts.plans?.[r.id];
    if (plan && r.status === "running") play(r.id, plan);
  }
  if (opts.refreshQuotaEveryMs !== undefined) {
    const every = opts.refreshQuotaEveryMs;
    const tick = () => {
      for (const s of state.statuses) if (s.quotaAt !== undefined) s.quotaAt = now();
      push();
      later(every, tick);
    };
    later(every, tick);
  }

  return {
    invoke: ((method: string, ...args: unknown[]) => {
      if (!(API_METHODS as readonly string[]).includes(method)) return Promise.reject(new Error(`Unknown method ${method}`));
      return (api[method as ApiMethod] as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as AolangaiBridge["invoke"],
    onState(cb) {
      stateListeners.add(cb);
      return () => void stateListeners.delete(cb);
    },
    onNotice(cb) {
      noticeListeners.add(cb);
      return () => void noticeListeners.delete(cb);
    },
  };
}
