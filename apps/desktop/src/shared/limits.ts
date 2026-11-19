import type { Limits } from "@aolangai/core";

/** Every key of `Limits`; the check below fails to compile when one is missing here. */
export const LIMIT_KEYS = [
  "maxConcurrent",
  "runTimeoutMs",
  "maxRunsPerHour",
  "quotaStaleMs",
  "warmBonusPts",
  "inFlightPenaltyPts",
  "workerIdleMs",
  "workerMaxContextTokens",
] as const satisfies readonly (keyof Limits)[];
const _complete: Exclude<keyof Limits, (typeof LIMIT_KEYS)[number]> extends never ? true : never = true;
void _complete;

interface Rule {
  min: number;
  max?: number;
  message: string;
}
// The messages speak in the units of the settings form (minutes, seconds), which is where a person sees them; the form
// rounds those fields to whole milliseconds, so for them only the minimum can fail.
const RULES: Record<(typeof LIMIT_KEYS)[number], Rule> = {
  maxConcurrent: { min: 1, max: 16, message: "Runs at once must be a whole number from 1 to 16." },
  runTimeoutMs: { min: 1000, message: "The maximum time for a run must be more than 0 minutes (at least 1 second)." },
  maxRunsPerHour: { min: 1, message: "The maximum runs delegated in 60 minutes must be a whole number, at least 1." },
  quotaStaleMs: { min: 1000, message: "The age after which quota is asked for again must be at least 1 second." },
  warmBonusPts: { min: 0, max: 100, message: "The warm worker bonus must be a whole number from 0 to 100." },
  inFlightPenaltyPts: { min: 0, max: 100, message: "The penalty for each run in progress must be a whole number from 0 to 100." },
  workerIdleMs: { min: 1000, message: "The time a worker may stay idle must be more than 0 minutes (at least 1 second)." },
  workerMaxContextTokens: { min: 1000, message: "The maximum context of a worker must be a whole number, at least 1000 tokens." },
};

/**
 * The errors of a limits value; empty when it is exactly the eight `Limits` keys with finite integers in
 * range. Takes `unknown`: the main process checks what crossed IPC with it, the settings form checks what was typed.
 */
export function validateLimits(l: unknown): string[] {
  if (typeof l !== "object" || l === null || Array.isArray(l)) return ["The limits are not valid."];
  const errors: string[] = [];
  const known: readonly string[] = LIMIT_KEYS;
  for (const k of Object.keys(l)) if (!known.includes(k)) errors.push(`No such limit "${k}".`);
  for (const k of LIMIT_KEYS) {
    const v = (l as Record<string, unknown>)[k];
    const { min, max = Number.MAX_SAFE_INTEGER, message } = RULES[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) errors.push(message);
  }
  return errors;
}
