import type { AppState } from "../../shared/api.js";
import type { SettingsTab } from "../components/settings/Settings.js";

export type SetupStepId = "claude" | "account" | "login" | "accepting" | "install";
export interface SetupStep {
  id: SetupStepId;
  label: string;
  done: boolean;
  /** The settings tab where the step is done; none when it is done elsewhere (or outside the app). */
  tab?: SettingsTab;
  /** A line under a step that is not done, for the steps that have no button to go to. */
  hint?: string;
}

/** The five steps from nothing to a first delegated run, always in this order. */
export function setupSteps(s: AppState): SetupStep[] {
  const loggedOut = s.statuses.some((st) => st.connection?.state === "not-logged-in" && s.accounts.some((a) => a.id === st.accountId));
  // `foreign` (a file we did not write) and `no-dir` (no config dir yet) are not ours to fix, so they do not count.
  const installed = s.install.skill === "current" && s.install.shim === "current" && s.install.accounts.every((p) => p.skill !== "outdated" && p.skill !== "missing");
  return [
    { id: "claude", label: "Install Claude Code (the claude command)", done: s.app.claudeFound, hint: "The claude command was not found on the PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin. Install Claude Code as its instructions say, or link claude into ~/.local/bin, then reopen aolangai so the app notices." },
    { id: "account", label: "Add at least one account", done: s.accounts.length > 0, tab: "accounts" },
    { id: "login", label: "Log in to every account", done: s.accounts.length > 0 && !loggedOut, tab: "accounts" },
    { id: "accepting", label: 'Turn on "Accepting work" for at least one account', done: s.accounts.some((a) => a.accepting), hint: "The switch is on each account's lane in the main window, once the account is added." },
    { id: "install", label: "Install skill and command", done: installed, tab: "install" },
  ];
}
