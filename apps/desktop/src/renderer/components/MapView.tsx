import type { KeyboardEvent } from "react";
import type { AppState } from "../../shared/api.js";
import { count } from "../view/format.js";
import { UNKNOWN_NODE, mapEdges, mapLayout, type MapEdge, type MapNode } from "../view/map.js";
import { quotaRows } from "../view/quota.js";
import { lanes } from "../view/runs.js";

const WIDTH = 720;
const HEIGHT = 420;
/** Half the size of a node box (150×64). */
const HW = 75;
const HH = 32;
const BAR = 100;
/** Account names longer than this are cut with an ellipsis; the full name is the tooltip. */
const NAME_MAX = 18;

export interface MapViewProps {
  state: AppState;
  now: number;
  /** A node opens its account's runs; an edge opens only those `from` delegated `to`. */
  onOpenAccount(id: string, to?: string): void;
}

/** "2 runs · 1 running · 1 failed" */
function edgeText(e: MapEdge): string {
  return [count(e.runs.length, "run"), e.running > 0 && `${e.running} running`, e.failed > 0 && `${e.failed} failed`].filter(Boolean).join(" · ");
}

const short = (name: string) => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name);

/** Where the line from `a` towards `b` leaves `a`'s box. */
function border(a: MapNode, b: MapNode): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.min(dx === 0 ? Infinity : HW / Math.abs(dx), dy === 0 ? Infinity : HH / Math.abs(dy));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** A cubic curve between the two boxes, bent to its left so a pair of opposite edges stays apart; and its midpoint. */
function curve(from: MapNode, to: MapNode): { d: string; mid: { x: number; y: number } } {
  const p0 = border(from, to);
  const p1 = border(to, from);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(40, len * 0.15);
  const nx = (dy / len) * bend;
  const ny = (-dx / len) * bend;
  const c1 = { x: p0.x + dx / 3 + nx, y: p0.y + dy / 3 + ny };
  const c2 = { x: p0.x + (2 * dx) / 3 + nx, y: p0.y + (2 * dy) / 3 + ny };
  const f = (n: number) => n.toFixed(1);
  return {
    d: `M${f(p0.x)},${f(p0.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(p1.x)},${f(p1.y)}`,
    // A cubic's point at t = 0.5.
    mid: { x: (p0.x + 3 * c1.x + 3 * c2.x + p1.x) / 8, y: (p0.y + 3 * c1.y + 3 * c2.y + p1.y) / 8 },
  };
}

/** A rounded label centred on (x, y); its width is guessed from the text, which is short and plain. */
function Pill({ x, y, text, fail }: { x: number; y: number; text: string; fail: boolean }) {
  const w = text.length * 6.2 + 16;
  return (
    <>
      <rect className={`pill${fail ? " fail" : ""}`} x={x - w / 2} y={y - 9} width={w} height={18} rx={9} />
      <text className="pill-text" x={x} y={y + 4} textAnchor="middle">{text}</text>
    </>
  );
}

/** Enter and Space activate a `<g role="button">`, as they do a real button. */
const onKeys = (act: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    act();
  }
};

/**
 * Who delegated to whom in the last 24 hours: one box per account, one arrow per (caller, worker) pair. Names come
 * from the owner and are plain text nodes; nothing here is HTML.
 */
export function MapView({ state, now, onOpenAccount }: MapViewProps) {
  const edges = mapEdges(state, now);
  const nodes = mapLayout(state, edges, WIDTH, HEIGHT);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const laneOf = new Map(lanes(state).map((l) => [l.account.id, l]));
  return (
    <section className="map">
      <svg className="map-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="group" aria-label="Delegation map, last 24 hours">
        <defs>
          {/* One marker per colour: a marker cannot take the colour of the line it ends. */}
          <marker id="map-arrow" className="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
          <marker id="map-arrow-fail" className="arrow fail" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
        </defs>
        {nodes.map((n) => {
          const lane = laneOf.get(n.id);
          const fiveHour = lane?.status ? quotaRows(lane.status, now).find((r) => r.label === "5h") : undefined;
          const label = n.unknown ? "Unknown caller" : n.name;
          const sessions = lane ? count(lane.sessions.length, "session") : undefined;
          const act = () => onOpenAccount(n.id);
          return (
            <g
              key={n.id}
              className={`map-node${n.unknown ? " unknown" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${label}${sessions ? `, ${sessions}` : ""}: show the runs it started`}
              onClick={act}
              onKeyDown={onKeys(act)}
            >
              <title>{label}</title>
              <rect className="node-box" x={n.x - HW} y={n.y - HH} width={HW * 2} height={HH * 2} rx={10} />
              <text className="node-name" x={n.x - HW + 12} y={n.y - 10}>{short(label)}</text>
              {lane && (
                <>
                  <rect className="map-bar" x={n.x - HW + 12} y={n.y + 1} width={BAR} height={5} rx={2.5} />
                  {fiveHour?.pct !== undefined && (
                    <rect className={`map-fill ${fiveHour.level}`} x={n.x - HW + 12} y={n.y + 1} width={(BAR * Math.min(100, Math.max(0, fiveHour.pct))) / 100} height={5} rx={2.5} />
                  )}
                  <text className="node-meta" x={n.x - HW + 12 + BAR + 6} y={n.y + 7}>{fiveHour?.pct !== undefined ? `${Math.round(fiveHour.pct)}%` : "5h"}</text>
                  <text className="node-meta" x={n.x - HW + 12} y={n.y + 22}>{sessions}</text>
                </>
              )}
            </g>
          );
        })}
        {/* Self-edges last: their pill sits under the node, where another edge may arrive, and must stay readable. */}
        {[...edges.filter((e) => e.from !== e.to), ...edges.filter((e) => e.from === e.to)].map((e) => {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return null;
          const fail = e.failed > 0;
          const text = edgeText(e);
          const act = () => onOpenAccount(e.from, e.to);
          const fromName = e.from === UNKNOWN_NODE ? "Unknown caller" : from.name;
          if (from === to) {
            return (
              <g key={`${e.from}>${e.to}`} className="map-edge self" role="button" tabIndex={0} aria-label={`${fromName} to itself: ${text}`} onClick={act} onKeyDown={onKeys(act)}>
                <Pill x={from.x} y={from.y + HH + 14} text={`${e.runs.length} to itself`} fail={fail} />
              </g>
            );
          }
          const { d, mid } = curve(from, to);
          return (
            <g key={`${e.from}>${e.to}`} className="map-edge" role="button" tabIndex={0} aria-label={`${fromName} → ${to.name}: ${text}`} onClick={act} onKeyDown={onKeys(act)}>
              {/* A wide invisible stroke, so the thin line is easy to click. */}
              <path className="edge-hit" d={d} />
              <path className={`edge${e.running > 0 ? " live" : ""}${fail ? " fail" : ""}`} d={d} markerEnd={`url(#${fail ? "map-arrow-fail" : "map-arrow"})`} />
              <Pill x={mid.x} y={mid.y} text={text} fail={fail} />
            </g>
          );
        })}
      </svg>
      {edges.length === 0 && <p className="hint map-empty">No delegated runs in the last 24 hours.</p>}
    </section>
  );
}
