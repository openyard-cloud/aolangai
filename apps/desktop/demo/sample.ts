// Invented data for the browser demo. Every time is relative to `now`, so the demo never looks stale; ids are short
// words and numbers, and every path is under /Users/you or ~.
import { DEFAULT_LIMITS, type Account, type AccountStatus, type Run, type RunEvent } from "@aolangai/core";
import { DESKTOP_KIND, TERMINAL_KIND, type AppState, type OpenSession } from "../src/shared/api.js";
import type { RunPlan } from "./bridge.js";

/** The fixed moment of the static demo (screenshots): 19 November 2026, 10:30 local time, a Thursday. */
export const STATIC_NOW = new Date(2026, 10, 19, 10, 30).getTime();

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** `days` after today at hh:mm, local time. */
const dayAt = (now: number, days: number, hh: number, mm = 0) => {
  const d = new Date(startOfDay(now));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hh, mm).getTime();
};

const HOME = "/Users/you";
const APP = `${HOME}/Projects/app`;
const SIDE = `${HOME}/Projects/side`;
const TERMINAL_APP = "/System/Applications/Utilities/Terminal.app";

export const PERSONAL = "personal";
export const WORK = "work";
export const SIDE_PROJECT = "side";

const accounts: Account[] = [
  { id: PERSONAL, name: "Personal", accepting: false, allowedDirs: [], reservePct: 90 },
  { id: WORK, name: "Work", configDir: "~/.claude-work", accepting: true, allowedDirs: [], reservePct: 90 },
  { id: SIDE_PROJECT, name: "Side project", configDir: "~/.claude-side", accepting: true, allowedDirs: ["~/Projects/side"], reservePct: 80 },
];

function statuses(now: number): AccountStatus[] {
  const connection = { state: "connected" as const, checkedAt: now - 12 * MIN };
  return [
    {
      accountId: PERSONAL,
      fiveHour: { usedPct: 47, resetsAt: now + 2 * H + 5 * MIN },
      sevenDay: { usedPct: 91, resetsAt: dayAt(now, 2, 8) },
      quotaAt: now - 50 * S,
      connection,
    },
    {
      accountId: WORK,
      fiveHour: { usedPct: 36, resetsAt: now + 3 * H + 50 * MIN },
      sevenDay: { usedPct: 32, resetsAt: dayAt(now, 4, 9) },
      models: [{ name: "Fable", usedPct: 18, resetsAt: dayAt(now, 4, 9) }],
      quotaAt: now - 40 * S,
      connection,
    },
    {
      accountId: SIDE_PROJECT,
      fiveHour: { usedPct: 4, resetsAt: now + 4 * H + 30 * MIN },
      sevenDay: { usedPct: 12, resetsAt: dayAt(now, 5, 7) },
      quotaAt: now - 70 * S,
      connection,
    },
  ];
}

const lines = (...l: string[]) => l.join("\n");

/** The caller fields of a run delegated from the open sample session with this pid, so the labels resolve to the session's name. */
function from(now: number, pid: number): Pick<Run, "callerPid" | "callerStartedAt" | "callerKind" | "callerAccountId"> {
  const session = sessions(now).find((x) => x.pid === pid);
  if (!session) throw new Error(`No sample session ${pid}`);
  // Claude desktop has no account in the process list: the account comes from desktopAccountId in the state.
  return {
    callerPid: session.pid,
    callerStartedAt: session.startedAt,
    callerKind: session.kind,
    ...(session.kind !== DESKTOP_KIND && session.accountId ? { callerAccountId: session.accountId } : {}),
  };
}

/** Pids of the sample sessions that delegate runs; run 45 has no caller, like a run from before callers were recorded. */
const NOTES_SESSION = 60123;
const APP_SESSION = 60140;
const LOGIN_SESSION = 41388;

function runs(now: number): Run[] {
  const base = { primaryWorker: false, readOnly: false };
  return [
    {
      ...base,
      id: 47,
      label: "parser tests",
      prompt: "Add tests for parse() in src/parser.ts and run npm test. Cover empty input, a trailing comma and nested arrays.",
      cwd: APP,
      accountId: WORK,
      sessionId: "demo-session-47",
      ...from(now, APP_SESSION),
      primaryWorker: true,
      status: "running",
      createdAt: now - 25 * S,
    },
    {
      ...base,
      id: 46,
      label: "archived_at migration",
      prompt: "Add a nullable archived_at column to the projects table, write the migration and run it against the dev database.",
      cwd: APP,
      accountId: WORK,
      sessionId: "demo-session-46",
      ...from(now, NOTES_SESSION),
      status: "done",
      result: lines(
        "The migration is written but **not applied**: running `npm run migrate` was denied.",
        "",
        "- `migrations/0013_add_archived_at.sql` adds `archived_at TIMESTAMP NULL` to `projects`",
        "- `src/models/project.ts` has the new optional field",
        "- `npm run typecheck` passes",
        "",
        "To apply it:",
        "",
        "```sh",
        "npm run migrate",
        "```",
      ),
      denials: ["Bash(npm run migrate)"],
      inputTokens: 61_420,
      outputTokens: 5_118,
      contextTokens: 38_904,
      createdAt: now - 41 * MIN,
      finishedAt: now - 34 * MIN,
    },
    {
      ...base,
      id: 45,
      label: "changelog 2.3.0",
      prompt: "Write the CHANGELOG entry for 2.3.0 from the commits since v2.2.0. Group them as Added, Changed and Fixed.",
      cwd: APP,
      accountId: WORK,
      sessionId: "demo-session-45",
      status: "done",
      result: lines(
        "Added the 2.3.0 entry to `CHANGELOG.md` from 23 commits:",
        "",
        "- **Added**: CSV export, the `--since` flag",
        "- **Changed**: retries back off up to 30 s",
        "- **Fixed**: the date picker on Safari, a crash on empty projects",
      ),
      inputTokens: 22_310,
      outputTokens: 1_874,
      contextTokens: 17_620,
      createdAt: now - 72 * MIN,
      finishedAt: now - 68 * MIN,
    },
    {
      ...base,
      id: 44,
      label: "rename outDir",
      prompt: "Rename the config option outDir to outputDir everywhere. Keep outDir working for now, with a deprecation warning.",
      cwd: SIDE,
      accountId: SIDE_PROJECT,
      sessionId: "demo-session-44",
      ...from(now, NOTES_SESSION),
      status: "done",
      result: lines(
        "Renamed `outDir` to `outputDir` in 14 files, docs included.",
        "",
        "`outDir` still works: `loadConfig()` copies it over and prints",
        "`outDir is deprecated, use outputDir`. Added a test for that. `npm test` passes.",
      ),
      inputTokens: 40_115,
      outputTokens: 6_022,
      contextTokens: 29_480,
      createdAt: now - 95 * MIN,
      finishedAt: now - 86 * MIN,
    },
    {
      ...base,
      id: 43,
      label: "flaky upload test",
      prompt: "The upload e2e test fails about one time in five. Find out why and fix it, then run it 20 times to check.",
      cwd: SIDE,
      accountId: SIDE_PROJECT,
      sessionId: "demo-session-43",
      ...from(now, LOGIN_SESSION),
      status: "failed",
      error: "Timed out after 30 minutes",
      inputTokens: 88_960,
      outputTokens: 7_431,
      contextTokens: 64_200,
      createdAt: now - 160 * MIN,
      finishedAt: now - 130 * MIN,
    },
  ];
}

function sessions(now: number): OpenSession[] {
  return [
    { pid: 41210, kind: TERMINAL_KIND, accountId: WORK, cwd: APP, startedAt: now - 2 * H - 14 * MIN, tty: "ttys003", appPath: TERMINAL_APP, name: "API pagination" },
    { pid: 41388, kind: TERMINAL_KIND, accountId: WORK, cwd: `${HOME}/Projects/api`, startedAt: now - 47 * MIN, tty: "ttys005", appPath: TERMINAL_APP, name: "Fix login redirect" },
    { pid: 52011, kind: "VS Code", accountId: SIDE_PROJECT, cwd: SIDE, startedAt: dayAt(now, -1, 18, 20), appPath: "/Applications/Visual Studio Code.app" },
    { pid: 60123, kind: DESKTOP_KIND, accountId: PERSONAL, cwd: `${HOME}/Projects/notes`, startedAt: now - 3 * H - 5 * MIN, appPath: "/Applications/Claude.app" },
    { pid: 60140, kind: DESKTOP_KIND, accountId: PERSONAL, cwd: APP, startedAt: now - 26 * MIN, appPath: "/Applications/Claude.app" },
    { pid: 70555, kind: "iTerm", cwd: `${HOME}/Projects/scratch`, startedAt: now - 70 * MIN, tty: "ttys008", appPath: "/Applications/iTerm.app" },
  ];
}

/** The whole window's state. `scene` "setup" is a machine with no account yet; every other scene shows the same data. */
export function sampleState(now: number, scene?: string): AppState {
  if (scene === "setup") {
    return {
      accounts: [],
      statuses: [],
      runs: [],
      limits: { ...DEFAULT_LIMITS },
      install: { skill: "missing", shim: "missing", accounts: [] },
      app: { packaged: true, openAtLogin: false, claudeFound: true },
      sessions: [],
    };
  }
  return {
    accounts: accounts.map((a) => ({ ...a, allowedDirs: [...a.allowedDirs] })),
    statuses: statuses(now),
    runs: runs(now),
    limits: { ...DEFAULT_LIMITS },
    install: {
      skill: "current",
      shim: "current",
      accounts: [
        { accountId: WORK, file: "~/.claude-work/skills/aolangai/SKILL.md", skill: "current" },
        { accountId: SIDE_PROJECT, file: "~/.claude-side/skills/aolangai/SKILL.md", skill: "current" },
      ],
    },
    app: { packaged: true, openAtLogin: false, claudeFound: true },
    sessions: sessions(now),
    desktopAccountId: PERSONAL,
  };
}

type Step = [kind: RunEvent["kind"], text: string];
const tool = (text: string): Step => ["tool", text];
const say = (text: string): Step => ["text", text];

/** Steps already taken, per run id; `sampleEvents` spreads them evenly over the run. */
const STEPS: Record<number, Step[]> = {
  47: [
    tool("Read parser.ts"),
    tool("Search: export function parse"),
    tool("Read parser.test.ts"),
    say("The parser has no tests for empty input or trailing commas yet. I'll add cases for those and for nested arrays."),
    tool("Edit parser.test.ts"),
  ],
  46: [
    tool("Search: CREATE TABLE projects"),
    tool("Read 0012_add_project_owner.sql"),
    tool("Write 0013_add_archived_at.sql"),
    tool("Read project.ts"),
    tool("Edit project.ts"),
    tool("Run: npm run migrate"),
    say("npm run migrate was denied, so I'll check the types instead."),
    tool("Run: npm run typecheck"),
    say("The migration and the model change are ready, not applied."),
  ],
  45: [tool("Run: git log --oneline v2.2.0..HEAD"), tool("Read CHANGELOG.md"), tool("Edit CHANGELOG.md")],
  44: [
    tool("Search: outDir"),
    tool("Edit config.ts"),
    tool("Edit build.ts"),
    tool("Edit README.md"),
    tool("Write config.test.ts"),
    tool("Run: npm test"),
  ],
  43: [
    tool("Run: npm run e2e -- upload"),
    tool("Read upload.spec.ts"),
    say("The test clicks Upload before the file input is attached. I'll wait for the input instead of a fixed delay."),
    tool("Edit upload.spec.ts"),
    tool("Run: for i in $(seq 20); do npm run e2e -- upload || break; done"),
  ],
};

/** Worker steps of every sample run, oldest first, with ids that are unique across runs. */
export function sampleEvents(now: number): Record<number, RunEvent[]> {
  const out: Record<number, RunEvent[]> = {};
  let id = 0;
  for (const run of runs(now)) {
    const steps = STEPS[run.id] ?? [];
    const end = run.finishedAt ?? now - 2 * S;
    const span = end - run.createdAt;
    out[run.id] = steps.map(([kind, text], i) => ({
      id: ++id,
      runId: run.id,
      kind,
      text,
      createdAt: Math.round(run.createdAt + (span * (i + 1)) / (steps.length + 1)),
    }));
  }
  return out;
}

/** How the running sample run goes on in the live demo: a step every 4.4 s, done about 40 s after the page opens. */
export function samplePlans(): Record<number, RunPlan> {
  return {
    47: {
      everyMs: 4400,
      steps: [
        tool("Run: npm test -- parser"),
        say("Two of the new tests fail: a trailing comma inside a nested array is read as an empty element."),
        tool("Read parser.ts"),
        tool("Edit parser.ts"),
        tool("Run: npm test -- parser"),
        tool("Run: npm test"),
        say("All 214 tests pass, 9 of them new."),
        say("Done."),
      ].map(([kind, text]) => ({ kind, text })),
      finish: {
        result: lines(
          "Added 9 tests for `parse()` in `src/parser.test.ts`:",
          "",
          "- empty input and whitespace only",
          "- a trailing comma, at the top level and in nested arrays",
          "- arrays nested three levels deep",
          "",
          "They found one bug: a trailing comma inside a nested array gave an empty element. Fixed in `src/parser.ts`. `npm test` passes (214 tests).",
        ),
        inputTokens: 48_210,
        outputTokens: 3_904,
        contextTokens: 31_550,
      },
    },
  };
}
