import type { Run } from "@aolangai/core";
import { baseName } from "../view/format.js";
import { duration, runTitle, statusLabel } from "../view/runs.js";

/** One run on a lane. Every piece of text (title, folder, step) is a plain text node: it comes from the worker or the prompt. */
export function RunRow({ run, now, step, onOpen }: { run: Run; now: number; step?: string; onOpen(id: number): void }) {
  const title = runTitle(run);
  const folder = baseName(run.cwd);
  const warn = run.status === "done" && (run.denials?.length ?? 0) > 0;
  return (
    <button className={`run-row ${run.status}`} onClick={() => onOpen(run.id)} title={`#${run.id} ${title}\n${run.cwd}`}>
      <span className={`run-dot ${warn ? "warn" : run.status}`} aria-hidden />
      <span className="run-title">
        <span className="run-id">#{run.id}</span> {title}
      </span>
      <span className="run-folder">{folder}</span>
      <span className="run-time">{duration(run, now)}</span>
      {run.status === "running" ? (
        <span className="run-step">{step ?? "running"}</span>
      ) : (
        <span className={`run-status ${warn ? "warn" : run.status}`}>{statusLabel(run)}</span>
      )}
    </button>
  );
}
