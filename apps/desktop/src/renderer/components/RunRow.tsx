import type { Run } from "@aolangai/core";
import { baseName } from "../view/format.js";
import { duration, runTitle, statusLabel } from "../view/runs.js";

/**
 * One run on a lane. Every piece of text (title, folder, step, caller) is a plain text node: it comes from the worker,
 * the prompt or the session. `from` is the label of the session that asked for the run, when known. With `onHide`, a
 * finished run gets a `×` beside the row (a sibling: a button never sits inside a button) and a running run an empty
 * slot of the same width, so the columns of every row stay lined up.
 */
export function RunRow({ run, now, step, from, onOpen, onHide }: { run: Run; now: number; step?: string; from?: string; onOpen(id: number): void; onHide?(id: number): void }) {
  const title = runTitle(run);
  const folder = baseName(run.cwd);
  const warn = run.status === "done" && (run.denials?.length ?? 0) > 0;
  return (
    <div className="run-line">
      <button type="button" className={`run-row ${run.status}`} onClick={() => onOpen(run.id)} title={`#${run.id} ${title}\n${run.cwd}${from !== undefined ? `\nfrom ${from}` : ""}`}>
        <span className={`run-dot ${warn ? "warn" : run.status}`} aria-hidden />
        <span className="run-title">
          <span className="run-id">#{run.id}</span> {title}
        </span>
        {from !== undefined && <span className="run-from">from {from}</span>}
        <span className="run-folder">{folder}</span>
        <span className="run-time">{duration(run, now)}</span>
        {run.status === "running" ? (
          <span className="run-step">{step ?? "running"}</span>
        ) : (
          <span className={`run-status ${warn ? "warn" : run.status}`}>{statusLabel(run)}</span>
        )}
      </button>
      {onHide &&
        (run.status === "running" ? (
          <span className="run-hide-slot" aria-hidden />
        ) : (
          <button type="button" className="run-hide" aria-label={`Hide run #${run.id}`} title="Hide this run from the lane" onClick={() => onHide(run.id)}>
            ×
          </button>
        ))}
    </div>
  );
}
