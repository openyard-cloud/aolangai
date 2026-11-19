import { test, expect } from "vitest";
import { DEFAULT_LIMITS } from "@aolangai/core";
import { LIMIT_KEYS, validateLimits } from "./limits.js";

test("the default limits have no errors and LIMIT_KEYS has every key of Limits", () => {
  expect(validateLimits(DEFAULT_LIMITS)).toEqual([]);
  expect([...LIMIT_KEYS].sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
});

test("every value must be a finite integer within the allowed range", () => {
  const bad = (o: object) => validateLimits({ ...DEFAULT_LIMITS, ...o });
  expect(bad({ maxConcurrent: 0 })).toHaveLength(1);
  expect(bad({ maxConcurrent: 17 })).toHaveLength(1);
  expect(bad({ maxConcurrent: 1.5 })).toHaveLength(1);
  expect(bad({ maxConcurrent: "4" })).toHaveLength(1);
  expect(bad({ maxRunsPerHour: Number.NaN })).toHaveLength(1);
  expect(bad({ runTimeoutMs: 999 })).toHaveLength(1);
  expect(bad({ quotaStaleMs: 999 })).toHaveLength(1);
  expect(bad({ workerIdleMs: 999 })).toHaveLength(1);
  expect(bad({ workerMaxContextTokens: 999 })).toHaveLength(1);
  expect(bad({ warmBonusPts: -1 })).toHaveLength(1);
  expect(bad({ inFlightPenaltyPts: Number.POSITIVE_INFINITY })).toHaveLength(1);
  expect(bad({ runTimeoutMs: 1000, quotaStaleMs: 1000, workerIdleMs: 1000, workerMaxContextTokens: 1000, warmBonusPts: 0, inFlightPenaltyPts: 0 })).toEqual([]);
});

test("an unknown key, a missing key and a value that is not an object are rejected", () => {
  expect(validateLimits({ ...DEFAULT_LIMITS, extra: 1 })).toHaveLength(1);
  const { maxConcurrent: _d, ...partial } = DEFAULT_LIMITS;
  expect(validateLimits(partial)).toHaveLength(1);
  for (const v of [null, undefined, [], "x", 5]) expect(validateLimits(v)).toHaveLength(1);
});
