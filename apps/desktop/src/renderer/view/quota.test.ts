import { expect, test } from "vitest";
import { usedPct as coreUsedPct, type AccountStatus } from "@aolangai/core";
import { isStale, limitLine, quotaLevel, quotaRows, resetLabel, usedPct } from "./quota.js";

// Local wall-clock times so the tests hold in any time zone. 2026-11-16 is a Monday (Mon).
const at = (d: number, h: number, mi = 0) => new Date(2026, 10, d, h, mi).getTime();
const NOW = at(16, 13, 15);

test("quotaLevel: <70 ok, 70–89 warn, ≥90 danger", () => {
  expect([0, 69.9, 70, 89, 90, 100].map(quotaLevel)).toEqual(["ok", "ok", "warn", "warn", "danger", "danger"]);
});

test("resetLabel: today the time; within 7 days the weekday and time; further out the time and date", () => {
  expect(resetLabel(at(16, 18, 30), NOW)).toBe("18:30");
  expect(resetLabel(at(17, 1, 0), NOW)).toBe("Tue 01:00");
  expect(resetLabel(at(22, 8, 0), NOW)).toBe("Sun 08:00");
  expect(resetLabel(at(21, 8, 5), NOW)).toBe("Sat 08:05");
  expect(resetLabel(at(23, 8, 0), NOW)).toBe("08:00 23 Nov");
  expect(resetLabel(at(16, 9, 0), NOW)).toBe("09:00");
});

test("quotaRows: 5h, Week, then each model; a window past its reset time says it has reset", () => {
  const s: AccountStatus = {
    accountId: "p",
    fiveHour: { usedPct: 15, resetsAt: at(16, 18, 30) },
    sevenDay: { usedPct: 72, resetsAt: at(22, 8, 0) },
    models: [{ name: "Fable", usedPct: 95, resetsAt: at(16, 12, 0) }],
  };
  expect(quotaRows(s, NOW)).toEqual([
    { label: "5h", pct: 15, level: "ok", note: "reset 18:30" },
    { label: "Week", pct: 72, level: "warn", note: "reset Sun 08:00" },
    { label: "Fable", note: "has reset" },
  ]);
  expect(quotaRows({ accountId: "p", fiveHour: { usedPct: 3 } }, NOW)).toEqual([{ label: "5h", pct: 3, level: "ok", note: "" }]);
  expect(quotaRows({ accountId: "p" }, NOW)).toEqual([]);
});

test("limitLine: with model and time, without model, reset time unknown; the tooltip is the full message", () => {
  const msg = "You've hit your Fable limit · resets Nov 17 at 1am (Asia/Saigon).";
  expect(limitLine({ accountId: "p" })).toBeNull();
  expect(limitLine({ accountId: "p", limit: { message: msg, model: "Fable", until: at(17, 1), at: NOW } })).toEqual({ text: "Fable limited until 01:00 17 Nov", title: msg });
  expect(limitLine({ accountId: "p", limit: { message: "Out of 5-hour quota", until: at(16, 18, 30), at: NOW } })?.text).toBe("Limited until 18:30 16 Nov");
  expect(limitLine({ accountId: "p", limit: { message: "rate limit exceeded", at: NOW } })?.text).toBe("Limited (reset time unknown)");
});

test("isStale: no numbers yet, or older than 5 minutes", () => {
  expect(isStale({ accountId: "p" }, NOW)).toBe(true);
  expect(isStale({ accountId: "p", quotaAt: NOW - 5 * 60_000 }, NOW)).toBe(false);
  expect(isStale({ accountId: "p", quotaAt: NOW - 5 * 60_000 - 1 }, NOW)).toBe(true);
});

test("usedPct: same result as core's usedPct (the renderer keeps its own copy)", () => {
  const samples: (AccountStatus | undefined)[] = [
    undefined,
    { accountId: "a" },
    { accountId: "a", fiveHour: { usedPct: 12 } },
    { accountId: "a", fiveHour: { usedPct: 12 }, sevenDay: { usedPct: 40 }, models: [{ name: "Fable", usedPct: 88 }] },
    { accountId: "a", models: [{ name: "Fable", usedPct: Number.NaN }] },
  ];
  for (const s of samples) expect(usedPct(s)).toBe(coreUsedPct(s));
  expect(usedPct(samples[3])).toBe(88);
});
