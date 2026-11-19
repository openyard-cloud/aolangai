import { expect, test } from "vitest";
import { DEFAULT_LIMITS } from "@aolangai/core";
import { draftFromLimits, limitsFromDraft } from "./limits.js";

test("draftFromLimits: minutes, seconds, plain numbers", () => {
  const d = draftFromLimits(DEFAULT_LIMITS);
  expect(d.runTimeoutMs).toBe("30");
  expect(d.workerIdleMs).toBe("60");
  expect(d.quotaStaleMs).toBe("120");
  expect(d.maxConcurrent).toBe("4");
  expect(d.workerMaxContextTokens).toBe("100000");
});

test("limitsFromDraft: converts the units back to milliseconds, no errors", () => {
  const r = limitsFromDraft({ ...draftFromLimits(DEFAULT_LIMITS), runTimeoutMs: "45", quotaStaleMs: "90", maxConcurrent: "6" }, DEFAULT_LIMITS);
  expect(r.errors).toEqual({});
  expect(r.limits).toEqual({ ...DEFAULT_LIMITS, runTimeoutMs: 45 * 60_000, quotaStaleMs: 90_000, maxConcurrent: 6 });
});

test("limitsFromDraft: an error per field, without calling main", () => {
  const r = limitsFromDraft({ ...draftFromLimits(DEFAULT_LIMITS), maxConcurrent: "0", warmBonusPts: "", runTimeoutMs: "abc", workerIdleMs: "1.5" }, DEFAULT_LIMITS);
  expect(Object.keys(r.errors).sort()).toEqual(["maxConcurrent", "runTimeoutMs", "warmBonusPts"]);
  expect(r.errors.maxConcurrent).toContain("from 1 to 16");
  expect(r.limits).toBeUndefined();
});

test("limitsFromDraft: each message speaks in the unit of its field, never in milliseconds", () => {
  const r = limitsFromDraft(
    { ...draftFromLimits(DEFAULT_LIMITS), runTimeoutMs: "0", workerIdleMs: "0.01", quotaStaleMs: "0.5", maxRunsPerHour: "0" },
    DEFAULT_LIMITS,
  );
  expect(r.errors).toEqual({
    runTimeoutMs: "The maximum time for a run must be more than 0 minutes (at least 1 second).",
    workerIdleMs: "The time a worker may stay idle must be more than 0 minutes (at least 1 second).",
    quotaStaleMs: "The age after which quota is asked for again must be at least 1 second.",
    maxRunsPerHour: "The maximum runs delegated in 60 minutes must be a whole number, at least 1.",
  });
  for (const m of Object.values(r.errors)) expect(m).not.toMatch(/millisecond/);
});

test("limitsFromDraft: a fraction of a minute or a second is fine; it is kept to the whole millisecond", () => {
  const r = limitsFromDraft({ ...draftFromLimits(DEFAULT_LIMITS), runTimeoutMs: "0.7", quotaStaleMs: "1.0004", workerIdleMs: "2.5" }, DEFAULT_LIMITS);
  expect(r.errors).toEqual({});
  expect(r.limits).toEqual({ ...DEFAULT_LIMITS, runTimeoutMs: 42_000, quotaStaleMs: 1000, workerIdleMs: 150_000 });
});
