import { useState } from "react";
import type { Account } from "@aolangai/core";
import { accountFromDraft, draftFromAccount, emptyDraft, permissionOptions, type AccountDraft, type DraftKey } from "../../forms/account.js";
import { errorText } from "../../view/format.js";
import { api } from "../../state/store.js";

/** Add or edit one account. The main process checks again and its message is shown under the form. */
export function AccountForm({ existing, onDone }: { existing?: Account; onDone(saved: boolean): void }) {
  const [draft, setDraft] = useState<AccountDraft>(() => (existing ? draftFromAccount(existing) : emptyDraft()));
  const [errors, setErrors] = useState<Partial<Record<DraftKey, string>>>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = <K extends DraftKey>(k: K, v: AccountDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const err = (k: DraftKey) => errors[k] && <span className="field-error">{errors[k]}</span>;

  const submit = async () => {
    const r = accountFromDraft(draft, existing);
    setErrors(r.errors);
    setFailure(undefined);
    if (!r.account) return;
    setBusy(true);
    try {
      await api.saveAccount(r.account);
      onDone(true);
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h3>{existing ? `Edit account ${existing.name}` : "Add account"}</h3>
      <label>Name<input value={draft.name} onChange={(e) => set("name", e.target.value)} autoFocus />{err("name")}</label>
      <fieldset>
        <legend>Claude Code config dir</legend>
        <label className="inline"><input type="radio" checked={draft.configChoice === "default"} onChange={() => set("configChoice", "default")} />default (~/.claude)</label>
        {!existing && (
          <label className="inline"><input type="radio" checked={draft.configChoice === "auto"} onChange={() => set("configChoice", "auto")} />let the app create its own folder (auto)</label>
        )}
        <label className="inline"><input type="radio" checked={draft.configChoice === "path"} onChange={() => set("configChoice", "path")} />another path</label>
        {draft.configChoice === "path" && <input value={draft.configPath} placeholder="~/.claude-b" onChange={(e) => set("configPath", e.target.value)} />}
        {err("configChoice")}{err("configPath")}
      </fieldset>
      <label>Model (leave empty for the account's default model)<input value={draft.model} onChange={(e) => set("model", e.target.value)} /></label>
      <label>Allowed folders, one per line (leave empty for anywhere)
        <textarea rows={3} value={draft.allowedDirs} placeholder="~/Projects/app" onChange={(e) => set("allowedDirs", e.target.value)} />
      </label>
      <label>Reserve (%): at this used percentage or above, the account stops taking new runs
        <input inputMode="numeric" value={draft.reservePct} onChange={(e) => set("reservePct", e.target.value)} />{err("reservePct")}
      </label>
      <label>Worker permission mode
        <select value={draft.permissionMode} onChange={(e) => set("permissionMode", e.target.value)}>
          {permissionOptions(draft.permissionMode).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
      {existing ? (
        <label className="inline">
          <input type="checkbox" role="switch" checked={draft.accepting} onChange={(e) => set("accepting", e.target.checked)} />
          Accepting work (off = Watch only)
        </label>
      ) : (
        <p className="hint">A new account starts with "Accepting work" off (Watch only). Turn the switch on in its lane after logging in.</p>
      )}
      {failure && <p className="field-error">{failure}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>Save</button>
        <button type="button" onClick={() => onDone(false)}>Cancel</button>
      </div>
    </form>
  );
}
