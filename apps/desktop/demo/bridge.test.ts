import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LIMITS } from "@aolangai/core";
import { API_METHODS, DESKTOP_KIND, TERMINAL_KIND, type ApiMethod, type AppNotice, type AppState } from "../src/shared/api.js";
import { callerOf } from "../src/renderer/view/callers.js";
import { mapEdges } from "../src/renderer/view/map.js";
import { lanes, needsYou } from "../src/renderer/view/runs.js";
import { outside } from "../src/renderer/view/sessions.js";
import { MACHINE_ONLY, RETRY_MS, TERMINAL_DELAY_MS, createDemoBridge } from "./bridge.js";
import { STATIC_NOW, sampleEvents, samplePlans, sampleState } from "./sample.js";

const NOW = STATIC_NOW;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** A bridge on the sample with the clock and timers of vitest, plus everything it pushed. */
function setup(o: { plans?: boolean; refreshQuotaEveryMs?: number; explain?: (text: string) => void } = {}) {
  const sample = sampleState(NOW);
  const bridge = createDemoBridge(sample, {
    now: () => Date.now(),
    setTimeout,
    events: sampleEvents(NOW),
    ...(o.plans ? { plans: samplePlans() } : {}),
    ...(o.refreshQuotaEveryMs !== undefined ? { refreshQuotaEveryMs: o.refreshQuotaEveryMs } : {}),
    ...(o.explain ? { explain: o.explain } : {}),
  });
  const states: AppState[] = [];
  const notices: AppNotice[] = [];
  bridge.onState((s) => states.push(s));
  bridge.onNotice((n) => notices.push(n));
  const last = () => states[states.length - 1]!;
  return { sample, bridge, states, notices, last };
}

const runOf = (s: AppState, id: number) => s.runs.find((r) => r.id === id);

describe("the sample", () => {
  test("three accounts with the sample names, modes and quota", () => {
    const s = sampleState(NOW);
    expect(s.accounts.map((a) => [a.name, a.accepting])).toEqual([
      ["Personal", false],
      ["Work", true],
      ["Side project", true],
    ]);
    const status = (name: string) => s.statuses.find((x) => x.accountId === s.accounts.find((a) => a.name === name)!.id)!;
    expect(status("Personal").sevenDay?.usedPct).toBe(91);
    expect([status("Work").fiveHour?.usedPct, status("Work").sevenDay?.usedPct, status("Work").models?.length]).toEqual([36, 32, 1]);
    expect([status("Side project").fiveHour?.usedPct, status("Side project").sevenDay?.usedPct]).toEqual([4, 12]);
    expect(s.accounts.find((a) => a.name === "Side project")!.allowedDirs).toEqual(["~/Projects/side"]);
    expect(s.app).toEqual({ packaged: true, openAtLogin: false, claudeFound: true });
  });

  test("one running run, two done, one failed, one denied; Needs you shows the failed, the denied and the reserve", () => {
    const s = sampleState(NOW);
    const kinds = s.runs.map((r) => (r.status === "done" && r.denials?.length ? "denied" : r.status)).sort();
    expect(kinds).toEqual(["denied", "done", "done", "failed", "running"]);
    expect(needsYou(s, NOW).map((a) => a.kind).sort()).toEqual(["denied", "failed", "reserve"]);
    // newest first, as the real state
    expect(s.runs.map((r) => r.id)).toEqual([...s.runs.map((r) => r.id)].sort((a, b) => b - a));
  });

  test("sessions: two named Terminal ones on Work, VS Code on Side project, two Claude desktop on Personal, one unknown", () => {
    const s = sampleState(NOW);
    const on = (name: string) => s.sessions.filter((x) => x.accountId === s.accounts.find((a) => a.name === name)!.id);
    expect(on("Work").map((x) => [x.kind, Boolean(x.name)])).toEqual([[TERMINAL_KIND, true], [TERMINAL_KIND, true]]);
    expect(on("Side project").map((x) => x.kind)).toEqual(["VS Code"]);
    expect(on("Personal").map((x) => x.kind)).toEqual([DESKTOP_KIND, DESKTOP_KIND]);
    expect(s.desktopAccountId).toBe(s.accounts.find((a) => a.name === "Personal")!.id);
    expect(outside(s)).toMatchObject({ desktop: [], unknown: [{}] });
  });

  test("callers: the runs name the open sessions that delegated them, one comes from a session that has closed, and one has none; the Map has edges to draw", () => {
    const s = sampleState(NOW);
    const label = (id: number) => callerOf(runOf(s, id)!, s)?.label;
    expect([47, 46, 45, 44, 43].map(label)).toEqual([
      "Personal · app",
      "Personal · notes",
      undefined,
      "Personal · notes",
      "Work · Terminal",
    ]);
    const edges = mapEdges(s, NOW);
    expect(edges.length).toBeGreaterThanOrEqual(2);
    // every caller is a known account: the sample has no Unknown caller box
    expect(edges.every((e) => e.from !== "unknown")).toBe(true);
    expect(edges.some((e) => e.running > 0)).toBe(true);
    expect(edges.some((e) => e.failed > 0)).toBe(true);
  });

  test("the setup scene has no account yet", () => {
    const s = sampleState(NOW, "setup");
    expect([s.accounts, s.runs, s.sessions]).toEqual([[], [], []]);
  });

  test("no id looks like a real one and every path is a placeholder", () => {
    const text = JSON.stringify([sampleState(NOW), sampleEvents(NOW), samplePlans()]);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    for (const m of text.matchAll(/\/Users\/([^/"]+)/g)) expect(m[1]).toBe("you");
  });
});

describe("createDemoBridge", () => {
  test("getState returns the sample, as a copy", async () => {
    const { sample, bridge } = setup();
    const got = await bridge.invoke("getState");
    expect(got).toEqual(sample);
    got.accounts.length = 0;
    expect((await bridge.invoke("getState")).accounts).toHaveLength(3);
  });

  test("toggling accepting pushes a state with the change", async () => {
    const { bridge, last } = setup();
    const work = (await bridge.invoke("getState")).accounts.find((a) => a.name === "Work")!;
    const saved = await bridge.invoke("saveAccount", { ...work, accepting: false });
    expect(saved.accepting).toBe(false);
    expect(last().accounts.find((a) => a.id === work.id)!.accepting).toBe(false);
  });

  test("a new account gets an id of its own and starts as Watch only", async () => {
    const { bridge, last } = setup();
    const saved = await bridge.invoke("saveAccount", { name: "Team", accepting: true, allowedDirs: [], reservePct: 90 });
    expect(saved).toMatchObject({ name: "Team", accepting: false });
    expect(last().accounts.map((a) => a.name)).toContain("Team");
    await expect(bridge.invoke("saveAccount", { ...saved, id: "gone" })).rejects.toThrow("no longer exists");
  });

  test("deleteAccount removes an idle account and refuses one with a running run", async () => {
    const { bridge, last } = setup();
    const s = await bridge.invoke("getState");
    const id = (name: string) => s.accounts.find((a) => a.name === name)!.id;
    await expect(bridge.invoke("deleteAccount", id("Work"))).rejects.toThrow("runs in progress");
    await bridge.invoke("deleteAccount", id("Personal"));
    expect(last().accounts.map((a) => a.name)).toEqual(["Work", "Side project"]);
    expect(last().desktopAccountId).toBeUndefined();
  });

  test("runEvents answers with the sample's steps", async () => {
    const { bridge } = setup();
    const running = (await bridge.invoke("getState")).runs.find((r) => r.status === "running")!;
    const events = await bridge.invoke("runEvents", running.id);
    expect(events).toEqual(sampleEvents(NOW)[running.id]);
    expect(events.length).toBeGreaterThan(0);
    expect(await bridge.invoke("runEvents", 9999)).toEqual([]);
  });

  test("the running run gets a step every few seconds and is done after about 40 s", async () => {
    const { bridge, last } = setup({ plans: true });
    const id = (await bridge.invoke("getState")).runs.find((r) => r.status === "running")!.id;
    const before = (await bridge.invoke("runEvents", id)).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await bridge.invoke("runEvents", id)).length).toBeGreaterThan(before);
    // steps are polled by the window, not pushed
    expect(runOf(await bridge.invoke("getState"), id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(35_000);
    const done = runOf(last(), id)!;
    expect(done.status).toBe("done");
    expect(done.result).toBeTruthy();
    expect(done.finishedAt! - NOW).toBeGreaterThan(30_000);
    expect(done.finishedAt! - NOW).toBeLessThan(45_000);
  });

  test("without plans nothing moves on its own (the static demo)", async () => {
    const { bridge, states } = setup();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(states).toEqual([]);
    expect((await bridge.invoke("getState")).runs.filter((r) => r.status === "running")).toHaveLength(1);
  });

  test("refreshQuotaEveryMs keeps the quota numbers fresh", async () => {
    const { last } = setup({ refreshQuotaEveryMs: 60_000 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    for (const st of last().statuses) expect(st.quotaAt).toBe(Date.now());
  });

  test("stopRun turns a running run into stopped and ends its steps", async () => {
    const { bridge, last } = setup({ plans: true });
    const id = (await bridge.invoke("getState")).runs.find((r) => r.status === "running")!.id;
    await bridge.invoke("stopRun", id);
    expect(runOf(last(), id)).toMatchObject({ status: "stopped", finishedAt: NOW });
    const steps = (await bridge.invoke("runEvents", id)).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runOf(last(), id)!.status).toBe("stopped");
    expect((await bridge.invoke("runEvents", id)).length).toBe(steps);
  });

  test("stopAll stops every running run and says how many", async () => {
    const { bridge, last } = setup();
    expect(await bridge.invoke("stopAll")).toBe(1);
    expect(last().runs.filter((r) => r.status === "running")).toEqual([]);
    expect(await bridge.invoke("stopAll")).toBe(0);
  });

  test("retryRun adds a run with retryOf that becomes done after the delay", async () => {
    const { bridge, last } = setup();
    const failed = (await bridge.invoke("getState")).runs.find((r) => r.status === "failed")!;
    await bridge.invoke("retryRun", failed.id);
    const retry = last().runs[0]!;
    expect(retry).toMatchObject({ retryOf: failed.id, status: "running", prompt: failed.prompt, cwd: failed.cwd });
    expect(retry.id).toBeGreaterThan(failed.id);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(runOf(last(), retry.id)!.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect(runOf(last(), retry.id)).toMatchObject({ status: "done", finishedAt: NOW + RETRY_MS });
    expect((await bridge.invoke("runEvents", retry.id)).length).toBeGreaterThan(0);
    // the failed run no longer needs you
    expect(needsYou(last(), Date.now()).map((a) => a.kind)).not.toContain("failed");
  });

  test("retryRun refuses a running run", async () => {
    const { bridge } = setup();
    const running = (await bridge.invoke("getState")).runs.find((r) => r.status === "running")!;
    await expect(bridge.invoke("retryRun", running.id)).rejects.toThrow("still running");
    await expect(bridge.invoke("retryRun", 9999)).rejects.toThrow("No run #9999");
  });

  test("hideRun hides a finished run of the sample: out of its lane and Needs you, still in the state; a running run is not hidden", async () => {
    const { bridge, last } = setup();
    expect(await bridge.invoke("hideRun", 43)).toBe(1);
    expect(runOf(last(), 43)!.hiddenAt).toBe(NOW);
    expect(needsYou(last(), NOW).some((a) => a.kind === "failed")).toBe(false);
    expect(lanes(last()).find((l) => l.account.id === "side")!.recent.map((r) => r.id)).toEqual([44]);
    expect(await bridge.invoke("hideRun", 43)).toBe(0);
    expect(await bridge.invoke("hideRun", 47)).toBe(0);
    expect(runOf(last(), 47)!.hiddenAt).toBeUndefined();
    await expect(bridge.invoke("hideRun", 0)).rejects.toThrow("Invalid run id");
  });

  test("clearFinished hides every finished run of that account only, and says how many", async () => {
    const { bridge, last } = setup();
    expect(await bridge.invoke("clearFinished", "work")).toBe(2);
    const work = lanes(last()).find((l) => l.account.id === "work")!;
    expect(work.recent).toEqual([]);
    expect(work.running.map((r) => r.id)).toEqual([47]);
    expect(lanes(last()).find((l) => l.account.id === "side")!.recent.map((r) => r.id)).toEqual([44, 43]);
    expect(await bridge.invoke("clearFinished", "work")).toBe(0);
    await expect(bridge.invoke("clearFinished", "nobody")).rejects.toThrow("This account no longer exists");
  });

  test("setDesktopAccount(null) moves the Claude desktop sessions out of the lane, and back", async () => {
    const { bridge, last, sample } = setup();
    await bridge.invoke("setDesktopAccount", null);
    expect(last().desktopAccountId).toBeUndefined();
    expect(outside(last()).desktop.map((s) => s.kind)).toEqual([DESKTOP_KIND, DESKTOP_KIND]);
    const work = sample.accounts.find((a) => a.name === "Work")!.id;
    await bridge.invoke("setDesktopAccount", work);
    expect(last().sessions.filter((s) => s.kind === DESKTOP_KIND).map((s) => s.accountId)).toEqual([work, work]);
    await expect(bridge.invoke("setDesktopAccount", "gone")).rejects.toThrow("no longer exists");
  });

  test("setLimits stores valid limits and refuses invalid ones", async () => {
    const { bridge, last } = setup();
    await bridge.invoke("setLimits", { ...DEFAULT_LIMITS, maxConcurrent: 2 });
    expect(last().limits.maxConcurrent).toBe(2);
    await expect(bridge.invoke("setLimits", { ...DEFAULT_LIMITS, maxConcurrent: 0 })).rejects.toThrow();
  });

  test("setOpenAtLogin flips the switch", async () => {
    const { bridge, last } = setup();
    await bridge.invoke("setOpenAtLogin", true);
    expect(last().app.openAtLogin).toBe(true);
  });

  const machineArgs: Record<(typeof MACHINE_ONLY)[number], unknown[]> = {
    loginAccount: ["work"],
    openAccountTerminal: ["work"],
    openInTerminal: [46],
    openAccountSettings: ["work"],
    focusSession: [41210],
    install: [],
    checkAccount: ["work"],
    openExternal: ["https://example.com/docs"],
  };

  test.each(Object.entries(machineArgs))("%s resolves, explains itself once and sends no notice", async (method, args) => {
    const explained: string[] = [];
    const { bridge, notices } = setup({ explain: (t) => explained.push(t) });
    await expect((bridge.invoke as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args)).resolves.not.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(explained).toHaveLength(1);
    expect(explained[0]).toMatch(/^In the app this .+\.$/);
    expect(notices).toEqual([]);
  });

  test.each(Object.entries(machineArgs))("%s still resolves without an explain option", async (method, args) => {
    const { bridge, notices } = setup();
    await expect((bridge.invoke as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args)).resolves.not.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notices).toEqual([]);
  });

  test("a throwing listener does not stop the next one, and the call still resolves", async () => {
    const { bridge } = setup();
    const seen: AppState[] = [];
    bridge.onState(() => {
      throw new Error("listener broke");
    });
    bridge.onState((s) => seen.push(s));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(bridge.invoke("setOpenAtLogin", true)).resolves.toBeUndefined();
    expect(seen.map((s) => s.app.openAtLogin)).toEqual([true]);
    error.mockRestore();
  });

  test("the machine-only list is exactly the methods that need a real Mac", () => {
    expect([...MACHINE_ONLY].sort()).toEqual(Object.keys(machineArgs).sort());
  });

  test("openAccountTerminal adds a Terminal session to that lane after one second", async () => {
    const { bridge, last, states } = setup();
    const side = (await bridge.invoke("getState")).accounts.find((a) => a.name === "Side project")!;
    await bridge.invoke("openAccountTerminal", side.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_DELAY_MS - 1);
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const added = last().sessions.filter((s) => s.accountId === side.id && s.kind === TERMINAL_KIND);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ cwd: "/Users/you/Projects/side", startedAt: NOW + TERMINAL_DELAY_MS });
  });

  test("checkAccount answers with a connection", async () => {
    const { bridge } = setup();
    expect(await bridge.invoke("checkAccount", "work")).toMatchObject({ state: "connected" });
  });

  test("every name in API_METHODS is implemented", async () => {
    const args = {
      getState: [],
      saveAccount: [{ name: "Team", accepting: false, allowedDirs: [], reservePct: 90 }],
      deleteAccount: ["personal"],
      checkAccount: ["work"],
      loginAccount: ["work"],
      openAccountTerminal: ["work"],
      openAccountSettings: ["work"],
      runEvents: [47],
      stopRun: [47],
      stopAll: [],
      retryRun: [43],
      openInTerminal: [46],
      hideRun: [46],
      clearFinished: ["work"],
      setLimits: [DEFAULT_LIMITS],
      setDesktopAccount: [null],
      install: [],
      setOpenAtLogin: [true],
      openExternal: ["https://example.com"],
      focusSession: [41210],
    } satisfies Record<ApiMethod, unknown[]>;
    const { bridge } = setup();
    const call = bridge.invoke as (m: string, ...a: unknown[]) => Promise<unknown>;
    for (const method of API_METHODS) {
      await expect(call(method, ...args[method]), method).resolves.not.toBeInstanceOf(Error);
    }
  });

  test("an unknown method rejects", async () => {
    const { bridge } = setup();
    const call = bridge.invoke as (m: string, ...a: unknown[]) => Promise<unknown>;
    await expect(call("deleteEverything")).rejects.toThrow("Unknown method deleteEverything");
    await expect(call("constructor")).rejects.toThrow("Unknown method constructor");
  });

  test("unsubscribing stops the pushes", async () => {
    const { bridge } = setup();
    const seen: AppState[] = [];
    const off = bridge.onState((s) => seen.push(s));
    off();
    await bridge.invoke("setOpenAtLogin", true);
    expect(seen).toEqual([]);
  });
});
