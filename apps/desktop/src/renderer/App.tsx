import { useState } from "react";
import type { Account } from "@aolangai/core";
import { AccountLane } from "./components/AccountLane.js";
import { NeedsYou } from "./components/NeedsYou.js";
import { OutsideSessions } from "./components/OutsideSessions.js";
import { RunDetail } from "./components/RunDetail.js";
import { Settings, type SettingsTab } from "./components/settings/Settings.js";
import { SetupCard } from "./components/SetupCard.js";
import { Toasts } from "./components/Toasts.js";
import { useNow, useRunEvents } from "./state/polling.js";
import { api, useAppState, useNotices, useToasts } from "./state/store.js";
import { lanes, needsYou } from "./view/runs.js";
import { needsYouCount, runningCount, stopAllQuestion } from "./view/format.js";
import { outside } from "./view/sessions.js";

export function App() {
  const { toasts, feedback, dismiss } = useToasts();
  const { state, refresh } = useAppState(feedback.report);
  useNotices(feedback.report);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [openId, setOpenId] = useState<number>();
  const running = state?.runs.filter((r) => r.status === "running") ?? [];
  const now = useNow(running.length > 0);
  const opened = state?.runs.find((r) => r.id === openId);
  const { events, steps } = useRunEvents(running.map((r) => r.id), opened?.id, feedback.report);
  const needs = state ? needsYou(state, now) : [];

  /** A call whose failure the human must see; `done` runs after it succeeded. */
  const attempt = (p: Promise<unknown>, done?: () => void) => void p.then(done).catch(feedback.report);
  const stopAll = () => {
    if (window.confirm(stopAllQuestion(running.length))) attempt(api.stopAll());
  };
  const toggleAccepting = (a: Account) => attempt(api.saveAccount({ ...a, accepting: !a.accepting }));
  const retry = (id: number) => attempt(api.retryRun(id), () => feedback.notify(`Sent the retry request for run #${id}`));
  const stop = (id: number) => attempt(api.stopRun(id), () => feedback.notify(`Sent the stop signal to run #${id}`));

  const focusSession = (pid: number) => attempt(api.focusSession(pid));

  return (
    <div className="app">
      <header className="topbar">
        {settingsTab !== null && <button onClick={() => setSettingsTab(null)}>← Back</button>}
        <span className="title">{settingsTab !== null ? "Settings" : "aolangai"}</span>
        <span className="spacer" />
        {state && <span className="running-count">{runningCount(running.length)}</span>}
        {state && settingsTab === null && needs.length > 0 && <span className="running-count" aria-hidden>·</span>}
        {state && settingsTab === null && needs.length > 0 && (
          <button className="link needs-count" onClick={() => document.getElementById("needs-you")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            {needsYouCount(needs.length)}
          </button>
        )}
        <button className="danger" disabled={running.length === 0} onClick={stopAll}>Stop all</button>
        {settingsTab === null && <button onClick={() => setSettingsTab("accounts")}>Settings</button>}
      </header>
      <main className="main">
        {state === null && <p className="empty">Loading…</p>}
        {state && settingsTab !== null && <Settings key={settingsTab} state={state} feedback={feedback} initialTab={settingsTab} onInstalled={refresh} />}
        {state && settingsTab === null && state.accounts.length === 0 && <SetupCard state={state} onOpenSettings={setSettingsTab} />}
        {state && settingsTab === null && state.accounts.length > 0 && (
          <div className="lanes">
            <SetupCard state={state} onOpenSettings={setSettingsTab} />
            {lanes(state).map((lane) => (
              <AccountLane
                key={lane.account.id}
                lane={lane}
                now={now}
                steps={steps}
                onToggleAccepting={toggleAccepting}
                onLogin={(id) => attempt(api.loginAccount(id))}
                onOpenTerminal={(id) => attempt(api.openAccountTerminal(id))}
                onOpenRun={setOpenId}
                onFocusSession={focusSession}
              />
            ))}
            <OutsideSessions {...outside(state)} now={now} onFocus={focusSession} />
            <NeedsYou
              items={needs}
              accounts={state.accounts}
              onRetry={retry}
              onOpen={setOpenId}
              onOpenSettings={(id) => attempt(api.openAccountSettings(id))}
            />
          </div>
        )}
      </main>
      {state && opened && (
        <RunDetail
          run={opened}
          runs={state.runs}
          accountName={state.accounts.find((a) => a.id === opened.accountId)?.name ?? "deleted account"}
          now={now}
          events={events[opened.id]}
          onClose={() => setOpenId(undefined)}
          onStop={stop}
          onRetry={retry}
          onTerminal={(id) => attempt(api.openInTerminal(id))}
          onOpenLink={(url) => attempt(api.openExternal(url))}
        />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
