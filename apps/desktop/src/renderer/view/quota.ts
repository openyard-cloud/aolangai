// Display-only helpers for the quota block of an account's lane. Times are local wall clock.
import type { AccountStatus } from "@aolangai/core";
import { clock, dayMonth } from "./format.js";

export type QuotaLevel = "ok" | "warn" | "danger";
export interface QuotaRow { label: string; pct?: number; level?: QuotaLevel; note: string }

/** Numbers older than this (the poller missed a few rounds) are dimmed. */
export const STALE_MS = 5 * 60_000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 24 * 60 * 60_000;

/**
 * Largest used % among the windows that have a number. Same rule as core's `usedPct`, copied because the renderer
 * must not import values from the core barrel (it drags the whole agent SDK and sqlite into the bundle); the
 * test in quota.test.ts keeps the two in step.
 */
export function usedPct(s: AccountStatus | undefined): number | undefined {
  if (!s) return undefined;
  const nums = [s.fiveHour?.usedPct, s.sevenDay?.usedPct, ...(s.models ?? []).map((m) => m.usedPct)].filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  return nums.length ? Math.max(...nums) : undefined;
}

export function quotaLevel(pct: number): QuotaLevel {
  return pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "18:30" today, "Sat 08:00" within the coming week, "08:00 23 Nov" further out. */
export function resetLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return clock(at);
  if (days > 0 && days < 7) return `${WEEKDAY[new Date(at).getDay()]} ${clock(at)}`;
  return `${clock(at)} ${dayMonth(at)}`;
}

export function quotaRows(s: AccountStatus, now: number): QuotaRow[] {
  const windows = [
    ...(s.fiveHour ? [{ label: "5h", ...s.fiveHour }] : []),
    ...(s.sevenDay ? [{ label: "Week", ...s.sevenDay }] : []),
    ...(s.models ?? []).map((m) => ({ label: m.name, usedPct: m.usedPct, resetsAt: m.resetsAt })),
  ];
  return windows.map((w) => {
    if (w.resetsAt !== undefined && w.resetsAt <= now) return { label: w.label, note: "has reset" };
    return { label: w.label, pct: w.usedPct, level: quotaLevel(w.usedPct), note: w.resetsAt !== undefined ? `reset ${resetLabel(w.resetsAt, now)}` : "" };
  });
}

/** The blocked line; `title` is the full limit text for the tooltip. */
export function limitLine(s: AccountStatus): { text: string; title: string } | null {
  const l = s.limit;
  if (!l) return null;
  const who = l.model ? `${l.model} limited` : "Limited";
  const text = l.until !== undefined ? `${who} until ${clock(l.until)} ${dayMonth(l.until)}` : `${who} (reset time unknown)`;
  return { text, title: l.message };
}

export function isStale(s: AccountStatus, now: number): boolean {
  return s.quotaAt === undefined || now - s.quotaAt > STALE_MS;
}
