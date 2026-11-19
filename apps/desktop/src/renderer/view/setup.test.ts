import { expect, test } from "vitest";
import { CLAUDE_NOT_FOUND } from "@aolangai/core";
import { account, appState, status } from "../testing.js";
import { setupSteps } from "./setup.js";

const doneOf = (s: ReturnType<typeof appState>) => Object.fromEntries(setupSteps(s).map((x) => [x.id, x.done]));

test("empty state: claude follows claudeFound, the other four steps are not done; always five steps in order", () => {
  const empty = appState({ install: { skill: "missing", shim: "missing", accounts: [] } });
  expect(setupSteps(empty).map((x) => x.id)).toEqual(["claude", "account", "login", "accepting", "install"]);
  expect(doneOf(empty)).toEqual({ claude: true, account: false, login: false, accepting: false, install: false });
  const noClaude = appState({ install: empty.install, app: { packaged: true, openAtLogin: false, claudeFound: false } });
  expect(doneOf(noClaude).claude).toBe(false);
});

test("the Claude Code hint says where aolangai looked, as the command and the main process do, and that aolangai must be reopened", () => {
  const hint = setupSteps(appState()).find((x) => x.id === "claude")!.hint!;
  expect(hint.startsWith(`${CLAUDE_NOT_FOUND}.`)).toBe(true);
  expect(hint).toMatch(/link claude into ~\/\.local\/bin/);
  expect(hint).toMatch(/then reopen aolangai/);
});

test("the Accepting work hint is true with or without a lane on screen", () => {
  const hint = setupSteps(appState()).find((x) => x.id === "accepting")!.hint!;
  expect(hint).not.toMatch(/below|above/);
  expect(hint).toMatch(/lane/);
});

test("everything in place: all five steps done", () => {
  const s = appState({
    accounts: [account({ id: "a1" })],
    statuses: [status({ accountId: "a1", connection: { state: "connected", checkedAt: 1 } })],
  });
  expect(doneOf(s)).toEqual({ claude: true, account: true, login: true, accepting: true, install: true });
});

test("label and tab of each step", () => {
  expect(setupSteps(appState()).map((x) => [x.label, x.tab])).toEqual([
    ["Install Claude Code (the claude command)", undefined],
    ["Add at least one account", "accounts"],
    ["Log in to every account", "accounts"],
    ['Turn on "Accepting work" for at least one account', undefined],
    ["Install skill and command", "install"],
  ]);
});

test("one account not-logged-in: login is not done; an account not checked yet does not count as logged out", () => {
  const two = [account({ id: "a1" }), account({ id: "a2" })];
  const bad = appState({ accounts: two, statuses: [status({ accountId: "a2", connection: { state: "not-logged-in", checkedAt: 1 } })] });
  expect(doneOf(bad).login).toBe(false);
  expect(doneOf(appState({ accounts: two })).login).toBe(true);
});

test("accepting: needs at least one account accepting work", () => {
  const s = appState({ accounts: [account({ accepting: false })] });
  expect(doneOf(s).accepting).toBe(false);
  expect(doneOf(appState({ accounts: [account({ accepting: false }), account({ id: "a2", accepting: true })] })).accepting).toBe(true);
});

test("install: not done when the skill or the shim is not current", () => {
  expect(doneOf(appState({ install: { skill: "outdated", shim: "current", accounts: [] } })).install).toBe(false);
  expect(doneOf(appState({ install: { skill: "current", shim: "missing", accounts: [] } })).install).toBe(false);
});

test("install: not done when an account's skill is outdated or missing; foreign or no-dir still counts as done", () => {
  const place = (skill: "current" | "outdated" | "missing" | "foreign" | "no-dir") => appState({ install: { skill: "current", shim: "current", accounts: [{ accountId: "a1", file: "~/x", skill }] } });
  expect(doneOf(place("outdated")).install).toBe(false);
  expect(doneOf(place("missing")).install).toBe(false);
  expect(doneOf(place("foreign")).install).toBe(true);
  expect(doneOf(place("no-dir")).install).toBe(true);
  expect(doneOf(place("current")).install).toBe(true);
});

test("hint: only the two steps without a button (claude, accepting) have a hint", () => {
  expect(setupSteps(appState()).map((x) => [x.id, x.hint])).toEqual([
    ["claude", "The claude command was not found on the PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin. Install Claude Code as its instructions say, or link claude into ~/.local/bin, then reopen aolangai so the app notices."],
    ["account", undefined],
    ["login", undefined],
    ["accepting", "The switch is on each account's lane in the main window, once the account is added."],
    ["install", undefined],
  ]);
});
