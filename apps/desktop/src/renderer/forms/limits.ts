import type { Limits } from "@aolangai/core";
import { LIMIT_KEYS, validateLimits } from "./validate.js";

export type LimitKey = (typeof LIMIT_KEYS)[number];
export type LimitDraft = Record<LimitKey, string>;
export type LimitErrors = Partial<Record<LimitKey, string>>;

/** What the form shows per unit: minutes for the two timeouts, seconds for the quota age, plain numbers otherwise. */
export const LIMIT_SCALE: Record<LimitKey, number> = {
  maxConcurrent: 1,
  runTimeoutMs: 60_000,
  maxRunsPerHour: 1,
  quotaStaleMs: 1000,
  warmBonusPts: 1,
  inFlightPenaltyPts: 1,
  workerIdleMs: 60_000,
  workerMaxContextTokens: 1,
};

export function draftFromLimits(l: Limits): LimitDraft {
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(l[k] / LIMIT_SCALE[k])])) as LimitDraft;
}

/**
 * Turns what was typed into `Limits`, or says which field is wrong. Each field is checked with the same rules the
 * main process applies (`validateLimits`), against `base` for the other seven, so no round trip is needed.
 */
export function limitsFromDraft(draft: LimitDraft, base: Limits): { limits?: Limits; errors: LimitErrors } {
  const limits = { ...base };
  const errors: LimitErrors = {};
  for (const k of LIMIT_KEYS) {
    const text = draft[k].trim();
    // A field in minutes or seconds may hold a fraction; it is kept to the whole millisecond.
    const typed = text === "" ? Number.NaN : Number(text);
    const value = LIMIT_SCALE[k] === 1 ? typed : Math.round(typed * LIMIT_SCALE[k]);
    const problem = validateLimits({ ...base, [k]: value })[0];
    if (problem !== undefined) errors[k] = problem;
    else limits[k] = value;
  }
  return Object.keys(errors).length > 0 ? { errors } : { limits, errors };
}
