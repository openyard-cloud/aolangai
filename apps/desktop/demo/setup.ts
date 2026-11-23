// Runs before the renderer: reads the query string, installs the demo bridge as `window.aolangai` and, for a static
// demo, stops the clock. Kept in its own module so the import order in main.tsx guarantees it runs first.
import { createDemoBridge } from "./bridge.js";
import { STATIC_NOW, sampleEvents, samplePlans, sampleState } from "./sample.js";

export const SCENES = ["overview", "needs-you", "run", "settings", "setup", "map", "map-detail"] as const;
export type Scene = (typeof SCENES)[number];

export interface DemoParams {
  scene: Scene;
  /** The run to open with scene "run". */
  runId?: number;
  /** Fixed time, no timers of the demo's own: for screenshots. */
  frozen: boolean;
  /** Without the demo bar (only together with `static=1`). */
  bare: boolean;
}

export function readParams(search: string): DemoParams {
  const q = new URLSearchParams(search);
  const scene = (SCENES as readonly string[]).includes(q.get("scene") ?? "") ? (q.get("scene") as Scene) : "overview";
  const id = Number(q.get("id"));
  const frozen = q.get("static") === "1";
  return { scene, ...(Number.isInteger(id) && id > 0 ? { runId: id } : {}), frozen, bare: frozen && q.get("bare") === "1" };
}

export const params = readParams(window.location.search);

const now = params.frozen ? STATIC_NOW : Date.now();
if (params.frozen) Date.now = () => STATIC_NOW; // the window's own clock (durations, "since 09:12") stands still too
if (params.bare) document.documentElement.classList.add("demo-bare");

/** How long the demo bar shows an explanation before it goes back to its standing text. */
const EXPLAIN_MS = 6000;

/**
 * Shows what the real app would do (a button that needs a real machine) in the demo bar for a few seconds; a new
 * explanation replaces the current one. Undefined without a bar (bare mode), so nothing is shown there.
 */
function barExplainer(): ((text: string) => void) | undefined {
  const bar = document.querySelector<HTMLElement>(".demo-bar");
  if (!bar || params.bare) return undefined;
  const standing = bar.textContent ?? "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (text) => {
    clearTimeout(timer);
    bar.textContent = text;
    bar.classList.add("explaining");
    timer = setTimeout(() => {
      bar.textContent = standing;
      bar.classList.remove("explaining");
    }, EXPLAIN_MS);
  };
}
const explain = barExplainer();

window.aolangai = createDemoBridge(sampleState(now, params.scene), {
  ...(params.frozen
    ? { now: () => STATIC_NOW, events: sampleEvents(now) }
    : { events: sampleEvents(now), plans: samplePlans(), refreshQuotaEveryMs: 60_000 }),
  ...(explain ? { explain } : {}),
});
