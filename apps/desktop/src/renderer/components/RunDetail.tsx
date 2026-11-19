import { useEffect, useRef } from "react";
import type { Run, RunEvent } from "@aolangai/core";
import { clockOrDate, fullTime } from "../view/format.js";
import { attachPanel } from "../state/panel.js";
import { canOpenTerminal, duration, runTitle, statusLabel } from "../view/runs.js";
import { Markdown } from "./Markdown.js";

export interface RunDetailProps {
  run: Run;
  /** Every run in the state; a running one on the same session hides "Open in Terminal". */
  runs: Run[];
  accountName: string;
  now: number;
  /** Worker steps, oldest first; undefined while they are still loading. */
  events: RunEvent[] | undefined;
  onClose(): void;
  onStop(id: number): void;
  onRetry(id: number): void;
  onTerminal(id: number): void;
  /** A link clicked in the result; the main process opens only http and https. */
  onOpenLink(url: string): void;
}

const num = (n: number) => n.toLocaleString("en-US");

/**
 * Side panel with everything about one run. The prompt, error, denials, note, label and step text come from the
 * user or the worker: they are plain text nodes (React escapes them); only the result goes through `Markdown`,
 * which drops raw HTML.
 */
export function RunDetail({ run, runs, accountName, now, events, onClose, onStop, onRetry, onTerminal, onOpenLink }: RunDetailProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // The parent re-renders every second while a run is running and passes a new `onClose` each time: the panel must
  // attach once (focus once) and always call the latest handler.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(
    () =>
      attachPanel({
        target: closeRef.current,
        opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        onEscape: () => onCloseRef.current(),
        listen: (cb) => {
          const onKey = (e: KeyboardEvent) => cb(e.key);
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        },
      }),
    [],
  );

  const tokens = [
    run.inputTokens !== undefined && `in ${num(run.inputTokens)}`,
    run.outputTokens !== undefined && `out ${num(run.outputTokens)}`,
    run.contextTokens !== undefined && `context ${num(run.contextTokens)}`,
  ].filter(Boolean);
  const running = run.status === "running";
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="detail" role="dialog" aria-modal="true" aria-label={`Run #${run.id}`}>
        <header className="detail-head">
          <div className="detail-title">
            <h2 title={runTitle(run)}>#{run.id} {runTitle(run)}</h2>
            <span className={`run-status ${run.status}`}>{statusLabel(run)}</span>
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close">Close</button>
        </header>
        <div className="detail-body">
          <dl className="meta">
            <dt>Account</dt><dd>{accountName}</dd>
            <dt>Folder</dt><dd title={run.cwd}>{run.cwd}</dd>
            {run.sessionId && <><dt>Session</dt><dd title={run.sessionId}>{run.sessionId}</dd></>}
            <dt>Started</dt><dd title={fullTime(run.createdAt)}>{clockOrDate(run.createdAt, now)}</dd>
            {run.finishedAt !== undefined && <><dt>Finished</dt><dd title={fullTime(run.finishedAt)}>{clockOrDate(run.finishedAt, now)}</dd></>}
            <dt>Duration</dt><dd>{duration(run, now)}</dd>
            {tokens.length > 0 && <><dt>Tokens</dt><dd>{tokens.join(" · ")}</dd></>}
            {run.retryOf !== undefined && <><dt>Retry of</dt><dd>#{run.retryOf}</dd></>}
          </dl>
          <section><h3>Prompt</h3><p className="plain">{run.prompt}</p></section>
          {run.result && <section><h3>Result</h3><Markdown text={run.result} onOpenLink={onOpenLink} /></section>}
          {run.error && <section className="bad"><h3>Error</h3><p className="plain">{run.error}</p></section>}
          {run.denials && run.denials.length > 0 && (
            <section className="warn">
              <h3>Permission denied</h3>
              <ul>{run.denials.map((d, i) => <li key={i} className="plain">{d}</li>)}</ul>
            </section>
          )}
          {run.note && <section><h3>Note</h3><p className="plain">{run.note}</p></section>}
          <section>
            <h3>Steps the worker took</h3>
            {events === undefined && <p className="hint">Loading…</p>}
            {events?.length === 0 && <p className="hint">No steps yet.</p>}
            <ol className="steps">
              {events?.map((e) => (
                <li key={e.id} className={e.kind}>
                  <span className="step-at">{clockOrDate(e.createdAt, now)}</span>
                  <span className="step-kind">{e.kind === "tool" ? "tool" : "text"}</span>
                  <span className="step-text plain">{e.text}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <footer className="detail-actions actions">
          {running && <button className="danger" onClick={() => onStop(run.id)}>Stop</button>}
          {!running && <button onClick={() => onRetry(run.id)}>Retry</button>}
          {canOpenTerminal(run, runs) && <button onClick={() => onTerminal(run.id)}>Open in Terminal</button>}
        </footer>
      </aside>
    </div>
  );
}
