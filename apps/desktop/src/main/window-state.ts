import fs from "node:fs";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WindowState {
  bounds: Bounds;
  maximized: boolean;
}

/** The smallest window the lanes and the top bar are laid out for. */
export const MIN_SIZE = { width: 900, height: 600 };

/**
 * Where the main window opens. First launch: the whole work area of the primary screen (menu bar and Dock excluded).
 * Later: where the person left it, moved and shrunk onto the screen it was on; the primary screen if that one is gone.
 * `workAreas[0]` is the primary screen.
 */
export function initialWindowState(saved: WindowState | undefined, workAreas: Bounds[]): WindowState {
  const primary = workAreas[0]!;
  const area = saved && bestArea(saved.bounds, workAreas);
  if (!saved || !area) return { bounds: { ...primary }, maximized: false };
  const width = Math.min(Math.max(saved.bounds.width, MIN_SIZE.width), area.width);
  const height = Math.min(Math.max(saved.bounds.height, MIN_SIZE.height), area.height);
  const x = clamp(saved.bounds.x, area.x, area.x + area.width - width);
  const y = clamp(saved.bounds.y, area.y, area.y + area.height - height);
  return { bounds: { x, y, width, height }, maximized: saved.maximized };
}

export function readWindowState(file: string): WindowState | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WindowState> | null;
    const b = v?.bounds;
    if (!b || typeof v.maximized !== "boolean") return undefined;
    if (![b.x, b.y, b.width, b.height].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
    return { bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, maximized: v.maximized };
  } catch {
    return undefined;
  }
}

export function writeWindowState(file: string, s: WindowState): void {
  try {
    fs.writeFileSync(file, JSON.stringify(s));
  } catch {
    // losing the window size is harmless
  }
}

/** The screen the window overlaps most; none if it overlaps no screen. */
function bestArea(b: Bounds, areas: Bounds[]): Bounds | undefined {
  let best: Bounds | undefined;
  let bestOverlap = 0;
  for (const a of areas) {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    const overlap = w > 0 && h > 0 ? w * h : 0;
    if (overlap > bestOverlap) [best, bestOverlap] = [a, overlap];
  }
  return best;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
