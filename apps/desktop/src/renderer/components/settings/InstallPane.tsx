import { useState } from "react";
import type { AppInfo, AppInstallStatus } from "../../../shared/api.js";
import { api, type Feedback } from "../../state/store.js";
import { installLabel } from "../../view/format.js";

/** Whether the skill (at ~/.claude and at each account) and the `aolangai` command are in place; one button installs all. */
export function InstallPane({ status, app, accountNames, feedback, onChanged }: { status: AppInstallStatus; app: AppInfo; accountNames: ReadonlyMap<string, string>; feedback: Feedback; onChanged(): void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api.install();
      feedback.notify("Installed the skill and command");
      onChanged();
    } catch (e) {
      feedback.report(e);
    } finally {
      setBusy(false);
    }
  };
  const setOpenAtLogin = (on: boolean) => void api.setOpenAtLogin(on).catch(feedback.report);
  const row = (label: string, where: string, s: Parameters<typeof installLabel>[0], key?: string) => (
    <div className="install-row" key={key}>
      <div><strong>{label}</strong><div className="hint cell-clip" title={where}>{where}</div></div>
      <span className={`install-state ${s}`}>{installLabel(s)}</span>
    </div>
  );
  return (
    <div className="pane">
      <p className="hint">The skill tells the main Claude Code session how to delegate runs, and the aolangai command is what it calls.</p>
      {row("Skill for Claude Code", "~/.claude/skills/aolangai/SKILL.md", status.skill)}
      {status.accounts.map((p) => row(`Skill for ${accountNames.get(p.accountId) ?? p.accountId}`, p.file, p.skill, p.accountId))}
      {row("aolangai command", "~/.local/bin/aolangai", status.shim)}
      <p className="hint">The packaged app installs and updates these files each time it opens.</p>
      <label className="switch">
        <input type="checkbox" role="switch" checked={app.openAtLogin} disabled={!app.packaged} onChange={(e) => setOpenAtLogin(e.target.checked)} />
        Open aolangai at login
      </label>
      {!app.packaged && <p className="hint">Only available in the packaged app.</p>}
      <div className="actions"><button className="primary" disabled={busy} onClick={() => void run()}>Install skill and command</button></div>
    </div>
  );
}
