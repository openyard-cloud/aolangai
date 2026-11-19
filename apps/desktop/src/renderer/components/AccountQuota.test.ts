import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountStatus } from "@aolangai/core";
import { AccountQuota } from "./AccountQuota.js";

const at = (d: number, h: number, mi = 0) => new Date(2026, 10, d, h, mi).getTime();
const NOW = at(16, 13, 15);
const html = (status: AccountStatus | undefined) => renderToStaticMarkup(createElement(AccountQuota, { status, now: NOW }));
const FRESH: AccountStatus = {
  accountId: "p",
  fiveHour: { usedPct: 15, resetsAt: at(16, 18, 30) },
  sevenDay: { usedPct: 92, resetsAt: at(22, 8) },
  models: [{ name: "Fable", usedPct: 0, resetsAt: at(22, 1) }],
  quotaAt: NOW - 30_000,
};

test("three bars 5h, Week, Fable with % and reset time; colour level by %", () => {
  const h = html(FRESH);
  expect(h.match(/class="quota-row"/g)?.length).toBe(3);
  expect(h).toContain("15%");
  expect(h).toContain("reset 18:30");
  expect(h).toContain("quota-fill danger");
  expect(h).toContain("width:92%");
  expect(h).toContain("Fable");
  expect(h).toContain("updated 13:14");
  expect(h).not.toContain("stale");
});

test("the limit line; the tooltip is the message as text (not as a tag)", () => {
  const h = html({ ...FRESH, limit: { message: "<b>x</b> hit your Fable limit", model: "Fable", until: at(17, 1), at: NOW } });
  expect(h).toContain("Fable limited until 01:00 17 Nov");
  expect(h).not.toContain("<b>x</b>");
  expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
});

test("old numbers are dimmed; a poll error shows a small line with a tooltip", () => {
  const h = html({ ...FRESH, quotaAt: NOW - 10 * 60_000, pollError: "Could not get quota: spawn ENOENT" });
  expect(h).toContain("quota stale");
  expect(h).toContain("could not get quota");
  expect(h).toContain('title="Could not get quota: spawn ENOENT"');
});

test("no data yet", () => {
  expect(html(undefined)).toContain("No data yet");
  expect(html({ accountId: "p" })).toContain("No data yet");
});
