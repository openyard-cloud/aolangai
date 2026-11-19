import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Run, RunEvent } from "@aolangai/core";
import { run } from "../testing.js";
import { RunDetail } from "./RunDetail.js";

const at = new Date(2026, 10, 17, 9, 0).getTime();
const NOW = at + 10 * 60_000;
const noop = () => {};
const html = (r: Partial<Run>, events: RunEvent[] | "loading" = [], others: Run[] = []) => {
  const shown = run({ createdAt: at, ...r });
  return renderToStaticMarkup(
    createElement(RunDetail, { run: shown, runs: [shown, ...others], accountName: "Claude B", now: NOW, events: events === "loading" ? undefined : events, onClose: noop, onStop: noop, onRetry: noop, onTerminal: noop, onOpenLink: noop }),
  );
};
const buttons = (h: string) => [...h.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

test("running run: Stop button, no Retry, no Open in Terminal even when it has a session", () => {
  expect(buttons(html({ status: "running" }))).toEqual(["Close", "Stop"]);
  expect(buttons(html({ status: "running", sessionId: "s1" }))).toEqual(["Close", "Stop"]);
});

test("finished run with a session: Open in Terminal, unless a running run uses the same session", () => {
  expect(buttons(html({ id: 1, status: "done", sessionId: "s1" }))).toEqual(["Close", "Retry", "Open in Terminal"]);
  expect(buttons(html({ id: 1, status: "done", sessionId: "s1" }, [], [run({ id: 2, status: "running", sessionId: "s1" })]))).toEqual(["Close", "Retry"]);
});

test("finished run: Retry, no Stop", () => {
  expect(buttons(html({ status: "failed", error: "boom" }))).toEqual(["Close", "Retry"]);
});

test("shows everything: prompt, result, account, session, duration, tokens, denied permissions, note, steps", () => {
  const h = html(
    {
      status: "done",
      label: "add test",
      prompt: "line one\nline two",
      result: "**done** already",
      sessionId: "sess-123",
      finishedAt: at + 125_000,
      inputTokens: 1200,
      outputTokens: 300,
      contextTokens: 5000,
      denials: ["Bash(npm run migrate)"],
      note: "reused a worker",
    },
    [{ id: 1, runId: 1, kind: "tool", text: "Edit login.test.ts", createdAt: at + 1000 }],
  );
  for (const t of ["#1 add test", "line one\nline two", "<strong>done</strong>", "Claude B", "/Users/x/Projects/demo", "sess-123", "09:00", "2 min", "Bash(npm run migrate)", "reused a worker", "Edit login.test.ts", ">tool<", "done · permission denied"]) {
    expect(h).toContain(t);
  }
  expect(h).toMatch(/in 1,200/);
  expect(h).toContain("out 300");
  expect(h).toContain("context 5,000");
});

test("text from the user and the worker does not become HTML: prompt, error, step, label; the result goes through Markdown, which drops raw tags", () => {
  const h = html(
    { status: "failed", label: "<u>label</u>", prompt: "<script>p()</script>", error: "<b>error</b>", result: "ok <img src=x onerror=alert(1)> <b>bold</b>" },
    [{ id: 1, runId: 1, kind: "text", text: "<i>step</i>", createdAt: at }],
  );
  for (const raw of ["<u>label</u>", "<script>", "<b>error</b>", "<i>step</i>", "<img", "<b>bold</b>"]) expect(h).not.toContain(raw);
  for (const esc of ["&lt;u&gt;label", "&lt;script&gt;", "&lt;b&gt;error", "&lt;i&gt;step"]) expect(h).toContain(esc);
});

test("steps still loading, and no steps yet", () => {
  expect(html({}, "loading")).toContain("Loading");
  expect(html({}, [])).toContain("No steps yet");
});
