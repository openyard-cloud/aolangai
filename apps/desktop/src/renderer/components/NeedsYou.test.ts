import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { account, run } from "../testing.js";
import type { Attention } from "../view/runs.js";
import { NeedsYou } from "./NeedsYou.js";

const at = new Date(2026, 10, 17, 9, 58).getTime();
const accounts = [account({ id: "a1", name: "Claude B" })];
const html = (items: Attention[]) =>
  renderToStaticMarkup(createElement(NeedsYou, { items, accounts, onRetry: () => {}, onOpen: () => {}, onOpenSettings: () => {} }));
const r = (o = {}) => run({ id: 12, label: "refactor header", createdAt: at, finishedAt: at, ...o });
const buttons = (h: string) => [...h.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

test("nothing to show means no block", () => {
  expect(html([])).toBe("");
});

test("failed run: Retry button", () => {
  const h = html([{ kind: "failed", run: r({ status: "failed", error: "boom" }) }]);
  expect(h).toContain("Needs you");
  expect(h).toContain("#12 refactor header");
  expect(buttons(h)).toEqual(["Retry"]);
});

test("limited run: Retry button, shows the time and the account name", () => {
  const h = html([{ kind: "limited", run: r({ status: "limited" }) }]);
  expect(h).toContain("Claude B hit its limit at 09:58");
  expect(buttons(h)).toEqual(["Retry"]);
});

test("permission-denied run: View and Open settings.json buttons, lists the denied permissions", () => {
  const h = html([{ kind: "denied", run: r({ denials: ["Bash(npm run migrate)"] }) }]);
  expect(h).toContain("permission denied: Bash(npm run migrate)");
  expect(buttons(h)).toEqual(["View", "Open settings.json"]);
});

test("account over its reserve: shows the percentage, no button", () => {
  const h = html([{ kind: "reserve", account: accounts[0]!, usedPct: 93 }]);
  expect(h).toContain("Claude B used 93%, over the reserve of 90%");
  expect(buttons(h)).toEqual([]);
});

test("each item is one row; error text containing <b> shows as text", () => {
  const h = html([
    { kind: "failed", run: r({ label: "<b>x</b>", status: "failed" }) },
    { kind: "denied", run: r({ id: 13, denials: ["Bash(<i>)"] }) },
  ]);
  expect(h.match(/class="need-row/g)?.length).toBe(2);
  expect(h).not.toContain("<b>x</b>");
  expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(h).toContain("Bash(&lt;i&gt;)");
});

test("run of a deleted account: only the View button (no Retry, no Open settings.json)", () => {
  const gone = { accountId: "deleted" };
  const failed = html([{ kind: "failed", run: r({ status: "failed", ...gone }) }]);
  expect(failed).toContain("deleted account");
  expect(buttons(failed)).toEqual(["View"]);
  expect(buttons(html([{ kind: "limited", run: r({ status: "limited", ...gone }) }]))).toEqual(["View"]);
  expect(buttons(html([{ kind: "denied", run: r({ denials: ["Bash(x)"], ...gone }) }]))).toEqual(["View"]);
});
