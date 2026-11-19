import type { OpenSession } from "../../shared/api.js";
import { count } from "../view/format.js";
import { SessionRow } from "./SessionRow.js";

/**
 * A quiet, collapsed block under the lanes for open sessions that belong to no lane; nothing when there are none.
 * The <details> is uncontrolled: the owner's open or closed choice survives the re-render every scan causes.
 */
export function OutsideSessions({ desktop, unknown, now, onFocus }: { desktop: OpenSession[]; unknown: OpenSession[]; now: number; onFocus(pid: number): void }) {
  const groups = [
    ...(desktop.length > 0 ? [`Claude desktop ${count(desktop.length, "session")}`] : []),
    ...(unknown.length > 0 ? [`unknown account ${count(unknown.length, "session")}`] : []),
  ];
  if (groups.length === 0) return null;
  return (
    <details className="outside-sessions">
      <summary>{`Outside the lanes: ${groups.join(" · ")}`}</summary>
      <div className="session-list">
        {[...desktop, ...unknown].map((s) => <SessionRow key={s.pid} session={s} now={now} onFocus={onFocus} />)}
      </div>
    </details>
  );
}
