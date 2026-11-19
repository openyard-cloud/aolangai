import { describe, expect, it } from "vitest";
import { ownProcessStart } from "./run.js";

const LSTART = "Mon Nov 17 13:00:00 2026";
const deps = (answers: (string | undefined)[]) => {
  const slept: number[] = [];
  const read: number[] = [];
  return {
    slept,
    read,
    d: {
      read: (pid: number) => (read.push(pid), answers.shift()),
      sleep: async (ms: number) => void slept.push(ms),
    },
  };
};

describe("ownProcessStart", () => {
  it("answers at once when ps does", async () => {
    const t = deps([LSTART]);
    expect(await ownProcessStart(42, t.d)).toBe(LSTART);
    expect(t.slept).toEqual([]);
    expect(t.read).toEqual([42]);
  });
  it("retries once after 200 ms when ps did not answer", async () => {
    const t = deps([undefined, LSTART]);
    expect(await ownProcessStart(42, t.d)).toBe(LSTART);
    expect(t.slept).toEqual([200]);
    expect(t.read).toEqual([42, 42]);
  });
  it("gives up (undefined, never an empty string) after the retry", async () => {
    const t = deps([undefined, undefined, LSTART]);
    expect(await ownProcessStart(42, t.d)).toBeUndefined();
    expect(t.read).toHaveLength(2);
    const empty = deps(["", ""]);
    expect(await ownProcessStart(42, empty.d)).toBeUndefined();
  });
});
