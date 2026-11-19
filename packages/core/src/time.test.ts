import { expect, test } from "vitest";
import { limitedUntil } from "./time.js";

// Local-time constructors, so the expectations hold in any time zone.
const now = new Date(2026, 10, 18, 9, 30).getTime();

test("limitedUntil: the time alone when the limit ends today", () => {
  expect(limitedUntil(new Date(2026, 10, 18, 14, 5).getTime(), now)).toBe("limited until 14:05");
  expect(limitedUntil(new Date(2026, 10, 18, 23, 59).getTime(), now)).toBe("limited until 23:59");
});

test("limitedUntil: the day and a three-letter month first when it ends on another day", () => {
  expect(limitedUntil(new Date(2026, 10, 19, 0, 0).getTime(), now)).toBe("limited until 19 Nov 00:00");
  expect(limitedUntil(new Date(2026, 10, 25, 7, 5).getTime(), now)).toBe("limited until 25 Nov 07:05");
  expect(limitedUntil(new Date(2027, 0, 2, 8, 0).getTime(), now)).toBe("limited until 2 Jan 08:00");
  // the same time of day a year later is not "today"
  expect(limitedUntil(new Date(2027, 10, 18, 14, 5).getTime(), now)).toBe("limited until 18 Nov 14:05");
});
