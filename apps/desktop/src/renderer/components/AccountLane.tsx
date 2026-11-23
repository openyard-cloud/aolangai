import type { Account, Run } from "@aolangai/core";
import { reserveWarning, type Lane } from "../view/runs.js";
import { AccountQuota } from "./AccountQuota.js";
import { summarize } from "../view/sessions.js";
import { RunRow } from "./RunRow.js";
import { SessionRow } from "./SessionRow.js";

export interface AccountLaneProps {
  lane: Lane;
  now: number;
  /** Latest worker step per running run id. */
  steps: Record<number, string | undefined>;
  /** The label of the session that asked for a run ("Personal · notes"); undefined when not known. */
  callerLabel?: (r: Run) => string | undefined;
  onToggleAccepting(account: Account): void;
  onLogin(accountId: string): void;
  onOpenTerminal(accountId: string): void;
  onOpenRun(id: number): void;
  onFocusSession(pid: number): void;
  /** Hides one finished run from the lane; the run stays in the store. */
  onHideRun(id: number): void;
  /** Hides every finished run of the account from the lane, also those not shown. */
  onClearFinished(accountId: string): void;
}

/** One account: quota and switches on top, what runs and what just finished underneath. */
export function AccountLane({ lane, now, steps, callerLabel, onToggleAccepting, onLogin, onOpenTerminal, onOpenRun, onFocusSession, onHideRun, onClearFinished }: AccountLaneProps) {
  const { account, status } = lane;
  const conn = status?.connection;
  const reserve = reserveWarning(account, status);
  const dirs = account.allowedDirs.join(", ");
  return (
    <section className={`lane${account.accepting ? "" : " watch-only"}`}>
      <header className="lane-head">
        <div className="lane-name">
          <span className="lane-title" title={account.name}>{account.name}</span>
          {account.model && <span className="lane-model">{account.model}</span>}
        </div>
        <AccountQuota status={status} now={now} />
        <button type="button" className="small" title="Open Terminal and run Claude Code on this account" onClick={() => onOpenTerminal(account.id)}>
          Open Terminal
        </button>
        <label className="switch">
          <input type="checkbox" role="switch" checked={account.accepting} onChange={() => onToggleAccepting(account)} />
          <span>{lane.mode}</span>
        </label>
      </header>
      <div className="lane-notes">
        {dirs !== "" && <div className="lane-note" title={dirs}>Allowed folders: {dirs}</div>}
        {reserve && <div className="lane-note warn">{reserve}</div>}
        {conn?.state === "not-logged-in" && (
          <div className="lane-note warn">
            Not logged in <button className="small" onClick={() => onLogin(account.id)}>Log in</button>
          </div>
        )}
        {conn?.state === "not-installed" && <div className="lane-note bad">Claude Code not installed</div>}
        {conn?.state === "error" && <div className="lane-note bad" title={conn.detail}>{conn.detail ?? "Connection error"}</div>}
        {lane.sessions.length > 0 && <div className="lane-note sessions">{`Open now: ${summarize(lane.sessions)}`}</div>}
      </div>
      {lane.sessions.length > 0 && (
        <div className="session-list">
          {lane.sessions.map((s) => <SessionRow key={s.pid} session={s} now={now} onFocus={onFocusSession} />)}
        </div>
      )}
      <div className="lane-runs">
        {lane.recent.length > 0 && (
          <div className="lane-runs-head">
            <button type="button" className="small" title="Hide every finished run of this account from the lane" onClick={() => onClearFinished(account.id)}>
              Clear finished
            </button>
          </div>
        )}
        {lane.running.map((r) => <RunRow key={r.id} run={r} now={now} step={steps[r.id]} from={callerLabel?.(r)} onOpen={onOpenRun} onHide={onHideRun} />)}
        {lane.recent.map((r) => <RunRow key={r.id} run={r} now={now} from={callerLabel?.(r)} onOpen={onOpenRun} onHide={onHideRun} />)}
        {lane.running.length + lane.recent.length === 0 && <div className="lane-empty">No recent runs</div>}
      </div>
    </section>
  );
}
