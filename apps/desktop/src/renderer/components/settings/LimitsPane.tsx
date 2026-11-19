import { useState } from "react";
import type { Limits } from "@aolangai/core";
import { draftFromLimits, limitsFromDraft, type LimitKey } from "../../forms/limits.js";
import { api, type Feedback } from "../../state/store.js";

const FIELDS: [LimitKey, string, string?][] = [
  ["maxConcurrent", "Runs at once"],
  ["runTimeoutMs", "Maximum time for a run", "minutes"],
  ["maxRunsPerHour", "Maximum runs delegated in 60 minutes"],
  ["quotaStaleMs", "Ask for quota again when the numbers are older than", "seconds"],
  ["warmBonusPts", "Priority points for a warm worker"],
  ["inFlightPenaltyPts", "Penalty points for each run in progress"],
  ["workerIdleMs", "A worker may stay idle for at most", "minutes"],
  ["workerMaxContextTokens", "Maximum context of a worker", "tokens"],
];

/** The eight numbers of `Limits`. Typed values are checked here with the same rules the main process applies. */
export function LimitsPane({ limits, feedback }: { limits: Limits; feedback: Feedback }) {
  const [draft, setDraft] = useState(() => draftFromLimits(limits));
  const [errors, setErrors] = useState<Partial<Record<LimitKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const r = limitsFromDraft(draft, limits);
    setErrors(r.errors);
    if (!r.limits) return;
    setBusy(true);
    try {
      await api.setLimits(r.limits);
      feedback.notify("Limits saved");
    } catch (e) {
      feedback.report(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pane form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {FIELDS.map(([key, label, unit]) => (
        <label key={key}>
          {label}{unit ? ` (${unit})` : ""}
          <input inputMode="numeric" value={draft[key]} aria-invalid={errors[key] !== undefined} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
          {errors[key] && <span className="field-error">{errors[key]}</span>}
        </label>
      ))}
      <div className="actions"><button type="submit" className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}
