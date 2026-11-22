import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Run } from "@aolangai/core";
import type { AppState } from "../../shared/api.js";
import { account, appState, run, status } from "../testing.js";
import type { OpenSession } from "../../shared/api.js";
import { lanes } from "../view/runs.js";
import { AccountLane } from "./AccountLane.js";

const at = (h: number, m = 0) => new Date(2026, 10, 17, h, m).getTime();
const NOW = at(12, 0);

function html(s: Partial<AppState>, steps: Record<number, string | undefined> = {}, callerLabel?: (r: Run) => string | undefined): string {
  const lane = lanes(appState(s))[0]!;
  return renderToStaticMarkup(
    createElement(AccountLane, { lane, now: NOW, steps, callerLabel, onToggleAccepting: () => {}, onLogin: () => {}, onOpenTerminal: () => {}, onOpenRun: () => {}, onFocusSession: () => {} }),
  );
}

test("account accepting work: name, model, the 'Accepting work' label, switch on", () => {
  const h = html({ accounts: [account({ name: "Claude B", model: "fable" })] });
  expect(h).toContain("Claude B");
  expect(h).toContain("fable");
  expect(h).toContain(">Accepting work<");
  expect(h).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  expect(h).not.toContain("Watch only");
});

test("account not accepting work shows 'Watch only', switch off", () => {
  const h = html({ accounts: [account({ accepting: false })] });
  expect(h).toContain(">Watch only<");
  expect(h).not.toMatch(/<input[^>]*checked/);
});

test("the 'Allowed folders' line appears only with a restriction, lists every folder, has a tooltip", () => {
  expect(html({ accounts: [account()] })).not.toContain("Allowed folders");
  const h = html({ accounts: [account({ allowedDirs: ["~/Projects/app", "/srv/a"] })] });
  expect(h).toContain("Allowed folders: ~/Projects/app, /srv/a");
  expect(h).toContain('title="~/Projects/app, /srv/a"');
});

test("running run: title, folder, time, newest step; finished run: status", () => {
  const h = html(
    {
      accounts: [account()],
      runs: [
        run({ id: 14, label: "add login test", cwd: "/Users/x/aolangai-thu", status: "running", createdAt: NOW - 3 * 60_000 }),
        run({ id: 13, prompt: "read hello.txt", status: "done", createdAt: NOW - 600_000, finishedAt: NOW - 560_000 }),
        run({ id: 12, prompt: "migrate", status: "done", denials: ["Bash(x)"], createdAt: NOW - 700_000, finishedAt: NOW - 650_000 }),
      ],
    },
    { 14: "editing login.test.ts" },
  );
  expect(h).toContain("#14");
  expect(h).toContain("add login test");
  expect(h).toContain("aolangai-thu");
  expect(h).toContain("3 min");
  expect(h).toContain("editing login.test.ts");
  expect(h).toContain("#13");
  expect(h).toContain("40 s");
  expect(h).toContain(">done<");
  expect(h).toContain("done · permission denied");
  expect(h).not.toContain("No runs yet");
});

test("a lane with no runs", () => {
  expect(html({ accounts: [account()] })).toContain("No runs yet");
});

test("not logged in: has a Log in button; Claude Code not installed; connection error", () => {
  const conn = (state: "not-logged-in" | "not-installed" | "error", detail?: string) =>
    html({ accounts: [account()], statuses: [status({ connection: { state, detail, checkedAt: NOW } })] });
  const a = conn("not-logged-in");
  expect(a).toContain("Not logged in");
  expect(a).toContain(">Log in<");
  const b = conn("not-installed");
  expect(b).toContain("Claude Code not installed");
  expect(b).not.toContain(">Log in<");
  expect(conn("error", "spawn EACCES")).toContain("spawn EACCES");
  const ok = html({ accounts: [account()], statuses: [status({ connection: { state: "connected", checkedAt: NOW } })] });
  expect(ok).not.toContain("Not logged in");
  expect(ok).not.toContain(">Log in<");
});

test("over the reserve, and could not get quota", () => {
  const over = html({ accounts: [account({ reservePct: 70 })], statuses: [status({ sevenDay: { usedPct: 72 }, quotaAt: NOW })] });
  expect(over).toContain("used 72%, over the reserve of 70%");
  const under = html({ accounts: [account({ reservePct: 90 })], statuses: [status({ sevenDay: { usedPct: 72 }, quotaAt: NOW })] });
  expect(under).not.toContain("over the reserve");
  const poll = html({ accounts: [account()], statuses: [status({ pollError: "ENOENT" })] });
  expect(poll).toContain("could not get quota");
  expect(poll).toContain('title="ENOENT"');
});

test("a connection error text containing <b> shows as text, not as a tag", () => {
  const h = html({ accounts: [account()], statuses: [status({ connection: { state: "error", detail: "<b>broken</b>", checkedAt: NOW } })] });
  expect(h).not.toContain("<b>broken</b>");
  expect(h).toContain("&lt;b&gt;broken&lt;/b&gt;");
});

test("a label, prompt or step containing HTML is text too", () => {
  const h = html(
    { accounts: [account()], runs: [run({ id: 3, label: "<img src=x onerror=alert(1)>", status: "running", createdAt: NOW })] },
    { 3: "<script>x</script>" },
  );
  expect(h).not.toContain("<img");
  expect(h).not.toContain("<script>");
  expect(h).toContain("&lt;script&gt;");
});

test("every lane has an Open Terminal button before the switch, whether accepting work or watch only", () => {
  const button = '<button type="button" class="small" title="Open Terminal and run Claude Code on this account">Open Terminal</button>';
  for (const accepting of [true, false]) {
    const h = html({ accounts: [account({ accepting })] });
    expect(h).toContain(button);
    expect(h.indexOf(button)).toBeLessThan(h.indexOf('<label class="switch"'));
  }
});

test("open sessions: an 'Open now' line and one row per session, only when the lane has sessions", () => {
  const term = (pid: number): OpenSession => ({ pid, kind: "Terminal", accountId: "a1", cwd: "/Users/x/p", tty: `ttys00${pid}`, startedAt: NOW });
  const h = html({ accounts: [account()], sessions: [term(1), term(2)] });
  expect(h).toContain("Open now: 2 Terminal");
  expect(h).toContain('class="lane-note sessions"');
  expect(h).not.toContain("Terminal · /Users/x/p");
  expect(h.match(/class="session-row"/g)).toHaveLength(2);
  expect(h.match(/>Switch to</g)).toHaveLength(2);
  const none = html({ accounts: [account()] });
  expect(none).not.toContain("Open now");
  expect(none).not.toContain("session-row");
});

test("a session opened the day before shows the date, relative to the lane's now", () => {
  const old: OpenSession = { pid: 3, kind: "Terminal", accountId: "a1", cwd: "/Users/x/p", tty: "ttys003", startedAt: at(9, 5) - 24 * 3600_000 };
  expect(html({ accounts: [account()], sessions: [old] })).toContain("since 09:05 16 Nov");
});

test("a run row says which session asked for it, as text; none when the caller is not known", () => {
  const runs = [run({ id: 5, status: "done", createdAt: NOW - 60_000, finishedAt: NOW })];
  const h = html({ accounts: [account()], runs }, {}, () => "Personal · notes");
  expect(h).toContain('<span class="run-from">from Personal · notes</span>');
  expect(html({ accounts: [account()], runs }, {}, () => undefined)).not.toContain("run-from");
  expect(html({ accounts: [account()], runs })).not.toContain("run-from");
  const tag = html({ accounts: [account()], runs }, {}, () => "<b>x</b>");
  expect(tag).not.toContain("<b>x</b>");
  expect(tag).toContain("from &lt;b&gt;x&lt;/b&gt;");
});
