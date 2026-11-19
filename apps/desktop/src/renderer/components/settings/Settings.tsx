import { useState } from "react";
import type { AppState } from "../../../shared/api.js";
import type { Feedback } from "../../state/store.js";
import { AccountsPane } from "./AccountsPane.js";
import { InstallPane } from "./InstallPane.js";
import { LimitsPane } from "./LimitsPane.js";

export type SettingsTab = "accounts" | "limits" | "install";
const TABS: readonly (readonly [SettingsTab, string])[] = [["accounts", "Accounts"], ["limits", "Limits"], ["install", "App & command"]];

/** Replaces the lanes while open; the top bar's back button returns. */
export function Settings({ state, feedback, initialTab = "accounts", onInstalled }: { state: AppState; feedback: Feedback; initialTab?: SettingsTab; onInstalled(): void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  return (
    <section className="settings">
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === "accounts" && <AccountsPane accounts={state.accounts} statuses={state.statuses} desktopAccountId={state.desktopAccountId} feedback={feedback} />}
      {tab === "limits" && <LimitsPane key={JSON.stringify(state.limits)} limits={state.limits} feedback={feedback} />}
      {tab === "install" && <InstallPane status={state.install} app={state.app} accountNames={new Map(state.accounts.map((a) => [a.id, a.name]))} feedback={feedback} onChanged={onInstalled} />}
    </section>
  );
}
