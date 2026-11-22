import { useLayoutEffect, useRef, useState } from "react";
import type { AppState } from "../../shared/api.js";
import { callerOf } from "../view/callers.js";
import { UNKNOWN_NODE, mapDetail, mapEdges } from "../view/map.js";
import { focusHint } from "../view/sessions.js";
import { RunRow } from "./RunRow.js";

export interface MapDetailProps {
  state: AppState;
  now: number;
  /** The caller's account id, or UNKNOWN_NODE. */
  accountId: string;
  /** Only the runs on this worker account (an edge was clicked). */
  to?: string;
  onBack(): void;
  onOpenRun(id: number): void;
  onFocusSession(pid: number): void;
}

interface Line { d: string; cls: string }

/**
 * One account (or one edge) of the map opened up: the sessions that asked on the left, the runs they started on the
 * right grouped by the account that ran them, and a line from each session to each of its runs. The lines are drawn
 * from the rows' measured positions, so they follow the layout. Every label is a plain text node.
 */
export function MapDetail({ state, now, accountId, to, onBack, onOpenRun, onFocusSession }: MapDetailProps) {
  const nameOf = (id: string) => (id === UNKNOWN_NODE ? "Unknown caller" : state.accounts.find((a) => a.id === id)?.name ?? "deleted account");
  const from = accountId === UNKNOWN_NODE ? "unknown callers" : nameOf(accountId);
  const title = to !== undefined ? `${nameOf(accountId)} → ${nameOf(to)}` : `Runs started from ${from}`;
  const empty = `No runs started from ${from}${to !== undefined ? ` on ${nameOf(to)}` : ""} in the last 24 hours.`;
  const groups = mapDetail(state, now, accountId, to);
  // The edges give the workers in account order and each one's runs newest first.
  const workers = mapEdges(state, now).filter((e) => e.from === accountId && (to === undefined || e.to === to));
  const pairs = workers.flatMap((w) =>
    w.runs.map((r) => ({
      caller: callerOf(r, state)?.key ?? "",
      run: r.id,
      cls: `link${r.status === "running" ? " live" : ""}${r.status === "failed" || r.status === "limited" ? " fail" : ""}`,
    })),
  );
  const signature = pairs.map((p) => `${p.caller}>${p.run}:${p.cls}`).join(" ");

  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  useLayoutEffect(() => {
    const measure = () => {
      const root = box.current;
      if (!root) return;
      const origin = root.getBoundingClientRect();
      const rectOf = (selector: string) => root.querySelector(selector)?.getBoundingClientRect();
      const next: Line[] = [];
      for (const p of pairs) {
        const a = rectOf(`[data-caller="${CSS.escape(p.caller)}"]`);
        const b = rectOf(`[data-run="${p.run}"]`);
        if (!a || !b) continue;
        const x0 = a.right - origin.left;
        const y0 = a.top + a.height / 2 - origin.top;
        const x1 = b.left - origin.left;
        const y1 = b.top + b.height / 2 - origin.top;
        const cx = (x0 + x1) / 2;
        next.push({ d: `M${x0},${y0} C${cx},${y0} ${cx},${y1} ${x1},${y1}`, cls: p.cls });
      }
      setLines(next);
    };
    measure();
    // The window resizing moves every row; so does the box growing or shrinking for any other reason.
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
    // `signature` stands for `pairs`, which is a new array on every render.
  }, [signature]);

  return (
    <section className="map-detail">
      <header className="map-detail-head">
        <button type="button" onClick={onBack}>← Map</button>
        <h2 title={title}>{title}</h2>
      </header>
      {groups.length === 0 && <p className="hint">{empty}</p>}
      {groups.length > 0 && (
        <div className="map-detail-body" ref={box}>
          <svg className="map-links" aria-hidden>
            {lines.map((l, i) => <path key={i} className={l.cls} d={l.d} />)}
          </svg>
          <div className="map-callers">
            <h3>Sessions that asked</h3>
            {groups.map(({ caller }) => {
              const hint = caller.session && focusHint(caller.session);
              const session = caller.session;
              return (
                <div key={caller.key} className="map-caller" data-caller={caller.key}>
                  <span className="map-caller-label" title={caller.label}>{caller.label}</span>
                  {session && hint !== undefined && (
                    <button type="button" className="small" title={hint} onClick={() => onFocusSession(session.pid)}>
                      Switch to
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="map-workers">
            <h3>Runs they started</h3>
            {workers.map((w) => (
              <div key={w.to} className="map-worker">
                <div className="map-worker-name">on {nameOf(w.to)}</div>
                {w.runs.map((r) => (
                  <div key={r.id} data-run={r.id}>
                    <RunRow run={r} now={now} onOpen={onOpenRun} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
