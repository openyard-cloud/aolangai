// Reads plan quota out of what Claude reports. Every input is untrusted and may change shape (the SDK usage call is
// experimental): anything that is not the expected type is dropped, never thrown on.
import type { QuotaWindow } from "../types.js";

export interface QuotaSnapshot {
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  models?: (QuotaWindow & { name: string })[];
  blocked?: { message: string; model?: string; until?: number };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clampPct = (n: number) => Math.min(100, Math.max(0, n));

function windowOf(pct: unknown, resetsAt: number | undefined): QuotaWindow | undefined {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0) return undefined;
  return { usedPct: clampPct(pct), ...(resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {}) };
}

const isoMs = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
const optMs = (n: number) => (Number.isNaN(n) ? undefined : n);

/** Response of the Agent SDK's usage call (utilization 0..100, resets_at ISO). */
export function quotaFromUsageResponse(res: unknown): QuotaSnapshot | null {
  if (!isObject(res) || res.rate_limits_available !== true || !isObject(res.rate_limits)) return null;
  const rl = res.rate_limits;
  const sdkWindow = (w: unknown) => (isObject(w) ? windowOf(w.utilization, optMs(isoMs(w.resets_at))) : undefined);
  const out: QuotaSnapshot = {};
  const full: NonNullable<QuotaSnapshot["blocked"]>[] = [];
  const fiveHour = sdkWindow(rl.five_hour);
  if (fiveHour) {
    out.fiveHour = fiveHour;
    if (fiveHour.usedPct >= 100) full.push({ message: "Out of 5-hour quota", ...(fiveHour.resetsAt ? { until: fiveHour.resetsAt } : {}) });
  }
  const sevenDay = sdkWindow(rl.seven_day);
  if (sevenDay) {
    out.sevenDay = sevenDay;
    if (sevenDay.usedPct >= 100) full.push({ message: "Out of weekly quota", ...(sevenDay.resetsAt ? { until: sevenDay.resetsAt } : {}) });
  }
  if (Array.isArray(rl.model_scoped)) {
    const models: (QuotaWindow & { name: string })[] = [];
    for (const m of rl.model_scoped) {
      if (!isObject(m) || typeof m.display_name !== "string" || !m.display_name) continue;
      const w = sdkWindow(m);
      if (!w) continue;
      models.push({ name: m.display_name, ...w });
      if (w.usedPct >= 100) full.push({ message: `Out of weekly quota for ${m.display_name}`, model: m.display_name, ...(w.resetsAt ? { until: w.resetsAt } : {}) });
    }
    if (models.length) out.models = models;
  }
  // Several full windows: the account is usable only once the last of them resets.
  const last = full.reduce<(typeof full)[number] | undefined>((a, b) => (!a || (b.until ?? Infinity) > (a.until ?? Infinity) ? b : a), undefined);
  if (last) out.blocked = last;
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESETS = /resets (?:([A-Za-z]{3}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?: \(([^)]+)\))?/i;

/** Offset (ms) of `timeZone` from UTC at instant `t`; throws RangeError for an unknown zone. */
function zoneOffset(t: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0; // "GMT" alone
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
}

/** Epoch ms of a wall-clock time in `timeZone` (or the machine's zone when undefined). */
function wallTime(y: number, mo: number, d: number, h: number, mi: number, timeZone: string | undefined): number {
  if (!timeZone) return new Date(y, mo, d, h, mi).getTime();
  const guess = Date.UTC(y, mo, d, h, mi);
  let t = guess - zoneOffset(guess, timeZone);
  t = guess - zoneOffset(t, timeZone); // second pass settles a DST edge
  return t;
}

/** Wall-clock parts of instant `t` in `timeZone` (or the machine's zone). */
function partsAt(t: number, timeZone: string | undefined): { y: number; mo: number; d: number } {
  if (!timeZone) {
    const dt = new Date(t);
    return { y: dt.getFullYear(), mo: dt.getMonth(), d: dt.getDate() };
  }
  const dt = new Date(t + zoneOffset(t, timeZone));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate() };
}

/**
 * Best effort on Claude Code's limit text, e.g. "You've hit your Fable limit · resets Nov 16 at 1am (Asia/Saigon)".
 * `until` is the next such time after `now`; missing when the text or the time zone cannot be read.
 */
export function parseLimitMessage(message: string, now: number): { model?: string; until?: number } {
  const out: { model?: string; until?: number } = {};
  const model = /hit your (.+?) limit/i.exec(message)?.[1]?.trim();
  if (model && model.toLowerCase() !== "usage") out.model = model;
  const m = RESETS.exec(message);
  if (!m) return out;
  const [, mon, day, hour, minute, ampm, zone] = m;
  const h12 = Number(hour);
  const mi = Number(minute ?? 0);
  if (h12 < 1 || h12 > 12 || mi > 59) return out;
  const h = (h12 % 12) + (ampm!.toLowerCase() === "pm" ? 12 : 0);
  try {
    const today = partsAt(now, zone);
    if (mon) {
      const mo = MONTHS.indexOf(mon.toLowerCase());
      if (mo < 0) return out;
      let t = wallTime(today.y, mo, Number(day), h, mi, zone);
      if (t <= now) t = wallTime(today.y + 1, mo, Number(day), h, mi, zone);
      out.until = t;
    } else {
      let t = wallTime(today.y, today.mo, today.d, h, mi, zone);
      if (t <= now) t = wallTime(today.y, today.mo, today.d + 1, h, mi, zone);
      out.until = t;
    }
  } catch {
    // unknown time zone: no reset time
  }
  return out;
}
