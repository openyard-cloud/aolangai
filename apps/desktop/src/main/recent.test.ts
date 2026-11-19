import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPick, recentLabel } from "./recent.js";

test("recentLabel: last folder name, em dash, path with the home folder written as ~", () => {
  expect(recentLabel("/Users/x/Projects/dự án", "/Users/x")).toBe("dự án — ~/Projects/dự án");
});

test("recentLabel: a folder outside home keeps its full path", () => {
  expect(recentLabel("/opt/work/app", "/Users/x")).toBe("app — /opt/work/app");
});

test("recentLabel: the home folder itself gives x — ~", () => {
  expect(recentLabel("/Users/x", "/Users/x")).toBe("x — ~");
});

test("recentLabel: only a real prefix counts (a sibling whose name starts with the home folder's name is not under it)", () => {
  const home = "/Users/x";
  const sibling = home + "y/p"; // shares the prefix "/Users/x" without being inside it
  expect(recentLabel(sibling, home)).toBe(`p — ${sibling}`);
});

test("recentLabel: a trailing / on the path and on the home folder", () => {
  expect(recentLabel("/Users/x/p/", "/Users/x/")).toBe("p — ~/p");
});

test("recentLabel: the root folder has no last name, so the path itself is used", () => {
  expect(recentLabel("/", "/Users/x")).toBe("/ — /");
});

describe("createPick", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  /** Records how the pick ended, without waiting on it. */
  const watch = (p: Promise<string | undefined>) => {
    const out: { value?: string | undefined; error?: unknown; done: boolean } = { done: false };
    p.then(
      (v) => Object.assign(out, { value: v, done: true }),
      (e) => Object.assign(out, { error: e, done: true }),
    );
    return out;
  };

  test("choose before close: the chosen value; the later close changes nothing", async () => {
    const pick = createPick<string>(100);
    const out = watch(pick.promise);
    pick.choose("/a");
    pick.closed();
    await vi.advanceTimersByTimeAsync(500);
    expect(out).toEqual({ value: "/a", done: true });
  });

  test("close before choose, the choice coming within the delay: the chosen value", async () => {
    const pick = createPick<string>(100);
    const out = watch(pick.promise);
    pick.closed();
    await vi.advanceTimersByTimeAsync(50);
    pick.choose("/a");
    await vi.advanceTimersByTimeAsync(500);
    expect(out).toEqual({ value: "/a", done: true });
  });

  test("close alone: undefined after the delay, not before", async () => {
    const pick = createPick<string>(100);
    const out = watch(pick.promise);
    pick.closed();
    await vi.advanceTimersByTimeAsync(99);
    expect(out.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual({ value: undefined, done: true });
  });

  test("a second choose, or a close, after resolution changes nothing", async () => {
    const pick = createPick<string>(100);
    const out = watch(pick.promise);
    pick.choose("/a");
    pick.choose("/b");
    pick.closed();
    await vi.advanceTimersByTimeAsync(500);
    expect(out).toEqual({ value: "/a", done: true });
    const later = createPick<string>(100);
    const laterOut = watch(later.promise);
    later.closed();
    await vi.advanceTimersByTimeAsync(100);
    later.choose("/b");
    later.closed();
    await vi.advanceTimersByTimeAsync(500);
    expect(laterOut).toEqual({ value: undefined, done: true });
  });

  test("choose with a promise: the close does not cut it short, and its value is the pick", async () => {
    const pick = createPick<string>(100);
    const out = watch(pick.promise);
    let finish!: (v: string | undefined) => void;
    pick.choose(new Promise<string | undefined>((r) => (finish = r)));
    pick.closed();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.done).toBe(false);
    finish("/dialog");
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toEqual({ value: "/dialog", done: true });
  });

  test("choose with a promise that resolves undefined (dialog cancelled): undefined", async () => {
    const pick = createPick<string>(100);
    const out = watch(pick.promise);
    pick.choose(Promise.resolve(undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toEqual({ value: undefined, done: true });
  });

  test("choose with a rejected promise (dialog threw): the pick rejects instead of hanging", async () => {
    const pick = createPick<string>(100);
    const out = watch(pick.promise);
    const boom = new Error("the dialog broke");
    pick.choose(Promise.reject(boom));
    pick.closed();
    await vi.advanceTimersByTimeAsync(500);
    expect(out).toEqual({ error: boom, done: true });
  });
});
