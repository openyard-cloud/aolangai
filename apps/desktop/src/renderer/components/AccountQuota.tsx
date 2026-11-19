import type { AccountStatus } from "@aolangai/core";
import { clock, fullTime } from "../view/format.js";
import { isStale, limitLine, quotaRows } from "../view/quota.js";

/** Plan quota of one subscription account, on its lane. All text is plain (no HTML). */
export function AccountQuota({ status, now }: { status: AccountStatus | undefined; now: number }) {
  const rows = status ? quotaRows(status, now) : [];
  const limit = status ? limitLine(status) : null;
  const stale = !status || isStale(status, now);
  return (
    <div className={`quota${stale ? " stale" : ""}`}>
      {rows.map((r) => (
        <div key={r.label} className="quota-row">
          <span className="quota-label">{r.label}</span>
          <span className="quota-bar" aria-hidden>
            {r.pct !== undefined && <span className={`quota-fill ${r.level}`} style={{ width: `${r.pct}%` }} />}
          </span>
          <span className="quota-pct">{r.pct !== undefined ? `${Math.round(r.pct)}%` : ""}</span>
          <span className="quota-note">{r.note}</span>
        </div>
      ))}
      {rows.length === 0 && !limit && <div className="quota-meta">No data yet</div>}
      {limit && (
        <div className="quota-limit" title={limit.title}>
          ⛔ {limit.text}
        </div>
      )}
      {(status?.quotaAt !== undefined || status?.pollError) && (
        <div className="quota-meta">
          {status?.quotaAt !== undefined && <span title={fullTime(status.quotaAt)}>updated {clock(status.quotaAt)}</span>}
          {status?.pollError && (
            <span className="quota-error" title={status.pollError}>
              could not get quota
            </span>
          )}
        </div>
      )}
    </div>
  );
}
