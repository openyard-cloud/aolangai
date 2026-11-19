import { useState } from "react";
import type { Account, AccountStatus } from "@aolangai/core";
import { api, type Feedback } from "../../state/store.js";
import { connectionLabel } from "../../view/format.js";
import { AccountForm } from "./AccountForm.js";

type Editing = { kind: "new" } | { kind: "edit"; id: string } | null;

export function AccountsPane({ accounts, statuses, desktopAccountId, feedback }: { accounts: Account[]; statuses: AccountStatus[]; desktopAccountId: string | undefined; feedback: Feedback }) {
  const [editing, setEditing] = useState<Editing>(null);
  const attempt = (p: Promise<unknown>) => void p.catch(feedback.report);
  const check = (a: Account) =>
    attempt(api.checkAccount(a.id).then((c) => feedback.notify(`${a.name}: ${connectionLabel(c)}`)));
  const remove = (a: Account) => {
    if (window.confirm(`Delete account "${a.name}"? Its past runs stay in the history.`)) attempt(api.deleteAccount(a.id));
  };
  const existing = editing?.kind === "edit" ? accounts.find((a) => a.id === editing.id) : undefined;
  return (
    <div className="pane">
      {accounts.length === 0 && <p className="hint">No accounts yet.</p>}
      {accounts.map((a) => {
        const conn = statuses.find((s) => s.accountId === a.id)?.connection;
        return (
          <div key={a.id} className="account-row">
            <div className="account-info">
              <div className="cell-name" title={a.name}>{a.name}</div>
              <div className="hint cell-clip" title={a.configDir ?? "~/.claude"}>{a.configDir ?? "~/.claude (default)"}</div>
              <div className="hint">{a.accepting ? "Accepting work" : "Watch only"}{conn ? ` · ${connectionLabel(conn)}` : ""}</div>
            </div>
            <div className="actions">
              <button onClick={() => check(a)}>Check</button>
              <button onClick={() => attempt(api.loginAccount(a.id))}>Log in</button>
              <button onClick={() => attempt(api.openAccountSettings(a.id))}>Open settings.json</button>
              <button onClick={() => setEditing({ kind: "edit", id: a.id })}>Edit</button>
              <button className="danger" onClick={() => remove(a)}>Delete</button>
            </div>
          </div>
        );
      })}
      <div className="form">
        <label>Claude desktop uses account
          <select value={desktopAccountId ?? ""} onChange={(e) => attempt(api.setDesktopAccount(e.target.value === "" ? null : e.target.value))}>
            <option value="">(not set)</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <p className="hint">The app cannot tell which account Claude desktop is logged in to. If you switch accounts in Claude desktop, change it here too.</p>
      </div>
      {editing === null && <div className="actions"><button className="primary" onClick={() => setEditing({ kind: "new" })}>Add account</button></div>}
      {editing?.kind === "new" && <AccountForm onDone={() => setEditing(null)} />}
      {existing && <AccountForm key={existing.id} existing={existing} onDone={() => setEditing(null)} />}
    </div>
  );
}
