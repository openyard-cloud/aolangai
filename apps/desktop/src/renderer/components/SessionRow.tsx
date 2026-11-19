import type { OpenSession } from "../../shared/api.js";
import { baseName, clockOrDate } from "../view/format.js";
import { focusHint } from "../view/sessions.js";

/** One open session: kind, name (when known), folder, start time (with the date when it is not today) and, when something can be brought forward, a button. Every text is a plain text node. */
export function SessionRow({ session, now, onFocus }: { session: OpenSession; now: number; onFocus(pid: number): void }) {
  const hint = focusHint(session);
  return (
    <div className="session-row">
      <span className="session-kind">{session.kind}</span>
      {session.name && <span className="session-name" title={session.name}>{session.name}</span>}
      {session.cwd && <span className="session-folder" title={session.cwd}>{baseName(session.cwd)}</span>}
      <span className="session-time">{`since ${clockOrDate(session.startedAt, now)}`}</span>
      <span className="session-action">
        {hint !== undefined && (
          <button type="button" className="small" title={hint} onClick={() => onFocus(session.pid)}>
            Switch to
          </button>
        )}
      </span>
    </div>
  );
}
