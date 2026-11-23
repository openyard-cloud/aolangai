import { useState } from "react";
import type { Account } from "@aolangai/core";
import { AccountLane } from "./components/AccountLane.js";
import { MapDetail } from "./components/MapDetail.js";
import { MapView } from "./components/MapView.js";
import { NeedsYou } from "./components/NeedsYou.js";
import { OutsideSessions } from "./components/OutsideSessions.js";
import { RunDetail } from "./components/RunDetail.js";
import { Settings, type SettingsTab } from "./components/settings/Settings.js";
import { SetupCard } from "./components/SetupCard.js";
import { Toasts } from "./components/Toasts.js";
import { useNow, useRunEvents } from "./state/polling.js";
import { api, useAppState, useNotices, useToasts } from "./state/store.js";
import { callerOf } from "./view/callers.js";
import { lanes, needsYou } from "./view/runs.js";
import { count, needsYouCount, runningCount, stopAllQuestion } from "./view/format.js";
import { outside } from "./view/sessions.js";

export function App() {
  const { toasts, feedback, dismiss } = useToasts();
  const { state, refresh } = useAppState(feedback.report);
  useNotices(feedback.report);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [openId, setOpenId] = useState<number>();
  const [view, setView] = useState<"lanes" | "map">("lanes");
  /** The account (or edge) opened on the map; undefined shows the whole map. */
  const [mapFocus, setMapFocus] = useState<{ accountId: string; to?: string }>();
  const running = state?.runs.filter((r) => r.status === "running") ?? [];
  const now = useNow(running.length > 0);
  const opened = state?.runs.find((r) => r.id === openId);
  const { events, steps } = useRunEvents(running.map((r) => r.id), opened?.id, feedback.report);
  const needs = state ? needsYou(state, now) : [];

  /** A call whose failure the human must see; `done` runs with its result after it succeeded. */
  const attempt = <T,>(p: Promise<T>, done?: (result: T) => void) => void p.then(done).catch(feedback.report);
  const stopAll = () => {
    if (window.confirm(stopAllQuestion(running.length))) attempt(api.stopAll());
  };
  const toggleAccepting = (a: Account) => attempt(api.saveAccount({ ...a, accepting: !a.accepting }));
  const retry = (id: number) => attempt(api.retryRun(id), () => feedback.notify(`Sent the retry request for run #${id}`));
  const stop = (id: number) => attempt(api.stopRun(id), () => feedback.notify(`Sent the stop signal to run #${id}`));
  // No toast when nothing changed (the run started again or was already hidden); the state push shows the lane as it is.
  const hideRun = (id: number) => attempt(api.hideRun(id), (n) => n > 0 && feedback.notify(`Hid run #${id}`));
  const clearFinished = (accountId: string) => attempt(api.clearFinished(accountId), (n) => n > 0 && feedback.notify(`Hid ${count(n, "run")}`));

  const focusSession = (pid: number) => attempt(api.focusSession(pid));
  const showMap = () => {
    setView("map");
    setMapFocus(undefined);
  };
  /** "Needs you" lives on the lanes: switch there first, then scroll once they are drawn. */
  const showNeeds = () => {
    setView("lanes");
    requestAnimationFrame(() => document.getElementById("needs-you")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const home = state !== null && settingsTab === null && state.accounts.length > 0;

  return (
    <div className="app">
      <header className="topbar">
        {settingsTab !== null && <button onClick={() => setSettingsTab(null)}>← Back</button>}
        <span className="title">{settingsTab !== null ? "Settings" : "aolangai"}</span>
        <span className="spacer" />
        {state && <span className="running-count">{runningCount(running.length)}</span>}
        {state && settingsTab === null && needs.length > 0 && <span className="running-count" aria-hidden>·</span>}
        {state && settingsTab === null && needs.length > 0 && (
          <button className="link needs-count" onClick={showNeeds}>
            {needsYouCount(needs.length)}
          </button>
        )}
        {home && (
          <div className="view-switch" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "lanes"} onClick={() => setView("lanes")}>Lanes</button>
            <button type="button" aria-pressed={view === "map"} onClick={showMap}>Map</button>
          </div>
        )}
        <button className="danger" disabled={running.length === 0} onClick={stopAll}>Stop all</button>
        {settingsTab === null && <button onClick={() => setSettingsTab("accounts")}>Settings</button>}
      </header>
      <main className="main">
        {state === null && <p className="empty">Loading…</p>}
        {state && settingsTab !== null && <Settings key={settingsTab} state={state} feedback={feedback} initialTab={settingsTab} onInstalled={refresh} />}
        {state && settingsTab === null && state.accounts.length === 0 && <SetupCard state={state} onOpenSettings={setSettingsTab} />}
        {state && home && view === "map" && (
          <div className="map-page">
            {mapFocus ? (
              <MapDetail
                state={state}
                now={now}
                accountId={mapFocus.accountId}
                to={mapFocus.to}
                onBack={() => setMapFocus(undefined)}
                onOpenRun={setOpenId}
                onFocusSession={focusSession}
              />
            ) : (
              <MapView state={state} now={now} onOpenAccount={(accountId, to) => setMapFocus(to === undefined ? { accountId } : { accountId, to })} />
            )}
          </div>
        )}
        {state && home && view === "lanes" && (
          <div className="lanes">
            <SetupCard state={state} onOpenSettings={setSettingsTab} />
            {lanes(state).map((lane) => (
              <AccountLane
                key={lane.account.id}
                lane={lane}
                now={now}
                steps={steps}
                callerLabel={(r) => callerOf(r, state)?.label}
                onToggleAccepting={toggleAccepting}
                onLogin={(id) => attempt(api.loginAccount(id))}
                onOpenTerminal={(id) => attempt(api.openAccountTerminal(id))}
                onOpenRun={setOpenId}
                onFocusSession={focusSession}
                onHideRun={hideRun}
                onClearFinished={clearFinished}
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
          caller={callerOf(opened, state)}
          onClose={() => setOpenId(undefined)}
          onStop={stop}
          onRetry={retry}
          onTerminal={(id) => attempt(api.openInTerminal(id))}
          onOpenLink={(url) => attempt(api.openExternal(url))}
          onFocusSession={focusSession}
        />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
