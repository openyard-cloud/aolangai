import { useState } from "react";
import type { AppState } from "../../shared/api.js";
import { setupSteps } from "../view/setup.js";
import type { SettingsTab } from "./settings/Settings.js";

const HIDDEN_KEY = "aolangai.setupHidden";

const readHidden = (): boolean => {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
};
const writeHidden = () => {
  try {
    window.localStorage.setItem(HIDDEN_KEY, "1");
  } catch {
    // storage unavailable: the card just comes back next time
  }
};

/** The setup checklist: at the top of the main screen while a step is open; the only thing shown while there is no account. */
export function SetupCard({ state, onOpenSettings }: { state: AppState; onOpenSettings(tab: SettingsTab): void }) {
  const [hidden, setHidden] = useState(readHidden);
  const steps = setupSteps(state);
  const noAccount = state.accounts.length === 0;
  if (steps.every((s) => s.done) || (!noAccount && hidden)) return null;
  const hide = () => {
    writeHidden();
    setHidden(true);
  };
  return (
    <section className="setup-card">
      <h2>aolangai setup</h2>
      {noAccount && <p className="hint">aolangai shows the quota and the open Claude Code sessions of every account you add, in this window and in the menu bar. Delegating work to the account with the most quota left is optional: it needs at least one account set to Accepting work.</p>}
      <ul className="setup-steps">
        {steps.map((s) => (
          <li key={s.id} className={s.done ? "done" : undefined}>
            <span className="setup-mark" role="img" aria-label={s.done ? "done" : "not done"}>{s.done ? "✓" : "○"}</span>
            <span className="setup-label">{s.label}</span>
            {!s.done && s.tab !== undefined && <button onClick={() => onOpenSettings(s.tab!)}>Open</button>}
            {!s.done && s.hint !== undefined && <span className="hint">{s.hint}</span>}
          </li>
        ))}
      </ul>
      {!noAccount && <div className="actions"><button onClick={hide}>Hide</button></div>}
    </section>
  );
}
