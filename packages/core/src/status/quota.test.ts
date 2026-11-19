import { describe, test, expect } from "vitest";
import { parseLimitMessage, quotaFromUsageResponse } from "./quota.js";

// Trimmed from a real response (a team account).
const RESPONSE = {
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 0, resets_at: "2026-11-16T12:00:00.289442+00:00", limit_dollars: null },
    seven_day: { utilization: 2, resets_at: "2026-11-22T18:00:00.289462+00:00" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-11-22T18:00:00+00:00" }],
  },
};
const withLimits = (rate_limits: Record<string, unknown>) => ({ ...RESPONSE, rate_limits: { ...RESPONSE.rate_limits, ...rate_limits } });

describe("quotaFromUsageResponse", () => {
  test("reads the 5-hour, weekly and per-model windows", () => {
    expect(quotaFromUsageResponse(RESPONSE)).toEqual({
      fiveHour: { usedPct: 0, resetsAt: Date.parse("2026-11-16T12:00:00.289Z") },
      sevenDay: { usedPct: 2, resetsAt: Date.parse("2026-11-22T18:00:00.289Z") },
      models: [{ name: "Fable", usedPct: 0, resetsAt: Date.parse("2026-11-22T18:00:00Z") }],
    });
  });

  test("a full window blocks the account until it resets", () => {
    expect(quotaFromUsageResponse(withLimits({ five_hour: { utilization: 100, resets_at: "2026-11-16T12:00:00Z" } }))?.blocked).toEqual({
      message: "Out of 5-hour quota",
      until: Date.parse("2026-11-16T12:00:00Z"),
    });
    expect(quotaFromUsageResponse(withLimits({ seven_day: { utilization: 100, resets_at: "2026-11-22T18:00:00Z" } }))?.blocked?.message).toBe("Out of weekly quota");
    expect(
      quotaFromUsageResponse(withLimits({ model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-11-22T18:00:00Z" }] }))?.blocked,
    ).toEqual({ message: "Out of weekly quota for Fable", model: "Fable", until: Date.parse("2026-11-22T18:00:00Z") });
  });

  test("no plan limits means no snapshot", () => {
    expect(quotaFromUsageResponse({ ...RESPONSE, rate_limits_available: false })).toBeNull();
    expect(quotaFromUsageResponse({ ...RESPONSE, rate_limits: null })).toBeNull();
    expect(quotaFromUsageResponse(null)).toBeNull();
    expect(quotaFromUsageResponse("x")).toBeNull();
  });

  test("broken windows are dropped or trimmed, never thrown on", () => {
    const q = quotaFromUsageResponse(
      withLimits({
        five_hour: { utilization: null, resets_at: "2026-11-16T12:00:00Z" },
        seven_day: { utilization: 140, resets_at: "junk" },
        model_scoped: [{ display_name: "Fable", utilization: "50", resets_at: null }, { display_name: "Opus", utilization: -3 }, "x", { utilization: 5 }],
      }),
    );
    expect(q?.fiveHour).toBeUndefined();
    expect(q?.sevenDay).toEqual({ usedPct: 100 });
    expect(q?.models).toBeUndefined();
    expect(q?.blocked).toEqual({ message: "Out of weekly quota" });
    expect(quotaFromUsageResponse(withLimits({ model_scoped: "nope" }))?.models).toBeUndefined();
  });
});

describe("parseLimitMessage", () => {
  const FABLE = "You've hit your Fable limit · resets Nov 16 at 1am (Asia/Saigon). Switch to another model to continue.";

  test("model, date, hour and time zone", () => {
    expect(parseLimitMessage(FABLE, Date.parse("2026-11-15T10:28:00Z"))).toEqual({ model: "Fable", until: Date.parse("2026-11-15T18:00:00Z") });
  });

  test("hour only, machine time zone: the next time that hour comes", () => {
    const now = new Date(2026, 10, 15, 22, 10).getTime();
    expect(parseLimitMessage("You've hit your limit · resets 11pm", now)).toEqual({ until: new Date(2026, 10, 15, 23, 0).getTime() });
    const late = new Date(2026, 10, 15, 23, 30).getTime();
    expect(parseLimitMessage("You've hit your limit · resets 11pm", late).until).toBe(new Date(2026, 10, 16, 23, 0).getTime());
  });

  test("minutes with a time zone", () => {
    expect(parseLimitMessage("You've hit your usage limit · resets 5:30pm (Asia/Saigon)", Date.parse("2026-11-16T02:00:00Z"))).toEqual({
      until: Date.parse("2026-11-16T10:30:00Z"),
    });
  });

  test("a date already past this year means next year", () => {
    expect(parseLimitMessage(FABLE, Date.parse("2026-12-20T00:00:00Z")).until).toBe(Date.parse("2027-11-15T18:00:00Z"));
  });

  test("12am and 12pm", () => {
    expect(parseLimitMessage("resets Nov 16 at 12am (UTC)", Date.parse("2026-11-15T00:00:00Z")).until).toBe(Date.parse("2026-11-16T00:00:00Z"));
    expect(parseLimitMessage("resets Nov 16 at 12pm (UTC)", Date.parse("2026-11-15T00:00:00Z")).until).toBe(Date.parse("2026-11-16T12:00:00Z"));
  });

  test("nothing to read", () => {
    expect(parseLimitMessage("rate limit exceeded", Date.now())).toEqual({});
    expect(parseLimitMessage("You've hit your Fable limit · resets 1am (Mars/Base)", Date.now())).toEqual({ model: "Fable" });
  });
});

test("several full windows: the one that resets last blocks, with its model", () => {
  const q = quotaFromUsageResponse(
    withLimits({
      five_hour: { utilization: 100, resets_at: "2026-11-16T12:00:00Z" },
      seven_day: { utilization: 100, resets_at: "2026-11-22T18:00:00Z" },
      model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-11-20T00:00:00Z" }],
    }),
  );
  expect(q?.blocked).toEqual({ message: "Out of weekly quota", until: Date.parse("2026-11-22T18:00:00Z") });
  expect(quotaFromUsageResponse(withLimits({ model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-11-22T18:00:00Z" }] }))?.blocked?.model).toBe("Fable");
});
