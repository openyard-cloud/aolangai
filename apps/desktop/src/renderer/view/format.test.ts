import { test, expect } from "vitest";
import { addToast, clock, clockOrDate, connectionLabel, count, dayMonth, errorText, fullTime, installLabel, needsYouCount, runningCount, stopAllQuestion } from "./format.js";

test("errorText drops the IPC prefix Electron adds", () => {
  expect(errorText(new Error("Error invoking remote method 'hub': Error: The folder is locked"))).toBe("The folder is locked");
  expect(errorText(new Error("Error invoking remote method 'hub': HubError: No run #3."))).toBe("No run #3.");
  expect(errorText("broken")).toBe("broken");
});

test("addToast: appends, drops a repeated text, keeps at most 3", () => {
  let list = addToast([], "a", 1);
  list = addToast(list, "b", 2);
  list = addToast(list, "a", 3);
  expect(list.map((t) => t.text)).toEqual(["b", "a"]);
  list = addToast(addToast(list, "c", 4), "d", 5);
  expect(list.map((t) => [t.id, t.text])).toEqual([[3, "a"], [4, "c"], [5, "d"]]);
});

test("clock and fullTime use the machine's local time", () => {
  const at = new Date(2026, 10, 6, 9, 5, 7).getTime();
  expect(clock(at)).toBe("09:05");
  expect(fullTime(at)).toBe("6 Nov 2026 09:05:07");
});

test("errorText: drops everything up to the last 'Error: '", () => {
  expect(errorText(new Error("Error invoking remote method 'aolangai:invoke': Error: The account has runs in progress"))).toBe("The account has runs in progress");
  expect(errorText(new Error("Error invoking remote method 'x': Error: Error: Two layers"))).toBe("Two layers");
  expect(errorText(new Error("No prefix"))).toBe("No prefix");
  expect(errorText("Plain string")).toBe("Plain string");
  expect(errorText(new Error("Error: "))).toBe("Error: "); // nothing left: keep the raw text rather than show an empty toast
});

test("addToast: the default tone is error, it can be info", () => {
  expect(addToast([], "a", 1)[0]).toEqual({ id: 1, text: "a", tone: "error" });
  expect(addToast([], "b", 2, "info")[0]).toEqual({ id: 2, text: "b", tone: "info" });
});

test("installLabel: the four states and no-dir", () => {
  expect(installLabel("missing")).toBe("not installed");
  expect(installLabel("current")).toBe("installed, up to date");
  expect(installLabel("outdated")).toBe("installed, out of date");
  expect(installLabel("foreign")).toBe("This file was not created by aolangai, the app does not overwrite it");
  expect(installLabel("no-dir")).toBe("no config dir yet");
});

test("clockOrDate: the time today, with the date on another day", () => {
  const now = new Date(2026, 10, 17, 12, 0).getTime();
  expect(clockOrDate(new Date(2026, 10, 17, 9, 5).getTime(), now)).toBe("09:05");
  expect(clockOrDate(new Date(2026, 10, 16, 23, 59).getTime(), now)).toBe("23:59 16 Nov");
});

test("runningCount: the top bar's count, never \"runs running\"", () => {
  expect(runningCount(0)).toBe("0 running");
  expect(runningCount(1)).toBe("1 running");
  expect(runningCount(3)).toBe("3 running");
});

test("stopAllQuestion: the confirmation of Stop all, singular and plural", () => {
  expect(stopAllQuestion(1)).toBe("Stop the 1 running run?");
  expect(stopAllQuestion(2)).toBe("Stop all 2 running runs?");
});

test("dayMonth: the day without padding, then a three-letter English month, whatever the locale", () => {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  months.forEach((m, i) => expect(dayMonth(new Date(2026, i, 1, 12).getTime())).toBe(`1 ${m}`));
  expect(dayMonth(new Date(2026, 11, 31, 23, 59).getTime())).toBe("31 Dec");
});

test("connectionLabel: the four states, with the detail when there is one", () => {
  expect(connectionLabel({ state: "connected" })).toBe("connected");
  expect(connectionLabel({ state: "not-logged-in" })).toBe("not logged in");
  expect(connectionLabel({ state: "not-installed" })).toBe("Claude Code not installed");
  expect(connectionLabel({ state: "error", detail: "spawn EACCES" })).toBe("connection error: spawn EACCES");
});

test("count and needsYouCount agree with the number", () => {
  expect(count(1, "run")).toBe("1 run");
  expect(count(0, "run")).toBe("0 runs");
  expect(count(2, "session")).toBe("2 sessions");
  expect(needsYouCount(1)).toBe("1 needs you");
  expect(needsYouCount(3)).toBe("3 need you");
});
