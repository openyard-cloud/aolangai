import { test, expect } from "vitest";
import { DEFAULT_LIMITS } from "@aolangai/core";
import { validateLimits } from "./validate.js";

test("the default limits have no errors", () => {
  expect(validateLimits(DEFAULT_LIMITS)).toEqual([]);
});

test("every limit must be a whole number within its range", () => {
  expect(validateLimits({ ...DEFAULT_LIMITS, maxConcurrent: 0 })).toContain("Runs at once must be a whole number from 1 to 16.");
  expect(validateLimits({ ...DEFAULT_LIMITS, maxConcurrent: 17 })).toContain("Runs at once must be a whole number from 1 to 16.");
  expect(validateLimits({ ...DEFAULT_LIMITS, maxConcurrent: 1.5 })).toContain("Runs at once must be a whole number from 1 to 16.");
  expect(validateLimits({ ...DEFAULT_LIMITS, runTimeoutMs: 999 })).toContain("The maximum time for a run must be more than 0 minutes (at least 1 second).");
  expect(validateLimits({ ...DEFAULT_LIMITS, maxRunsPerHour: Number.NaN })).toContain("The maximum runs delegated in 60 minutes must be a whole number, at least 1.");
  expect(validateLimits({ ...DEFAULT_LIMITS, quotaStaleMs: 999 })).toContain("The age after which quota is asked for again must be at least 1 second.");
  expect(validateLimits({ ...DEFAULT_LIMITS, warmBonusPts: 101 })).toContain("The warm worker bonus must be a whole number from 0 to 100.");
  expect(validateLimits({ ...DEFAULT_LIMITS, inFlightPenaltyPts: -1 })).toContain("The penalty for each run in progress must be a whole number from 0 to 100.");
  expect(validateLimits({ ...DEFAULT_LIMITS, workerIdleMs: 999 })).toContain("The time a worker may stay idle must be more than 0 minutes (at least 1 second).");
  expect(validateLimits({ ...DEFAULT_LIMITS, workerMaxContextTokens: 999 })).toContain("The maximum context of a worker must be a whole number, at least 1000 tokens.");
});

test("the bonus and the penalty may be 0", () => {
  expect(validateLimits({ ...DEFAULT_LIMITS, warmBonusPts: 0, inFlightPenaltyPts: 0 })).toEqual([]);
});
