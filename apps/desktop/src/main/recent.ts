
const trimSlashes = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);

/** `<last folder name> — <path, with the home folder written as ~>`. Only a real prefix of the path counts as home. */
export function recentLabel(dir: string, home: string): string {
  const d = trimSlashes(dir);
  const h = trimSlashes(home);
  const shown = d === h ? "~" : h !== "/" && d.startsWith(`${h}/`) ? `~${d.slice(h.length)}` : d;
  const name = d.slice(d.lastIndexOf("/") + 1) || d;
  return `${name} — ${shown}`;
}

/** On macOS a popup menu's close callback can fire before the click handler, so "closed" waits this long for a click. */
export const CLOSE_GRACE_MS = 100;

/**
 * One folder pick that ends exactly once. `choose` (a value, or a promise of one such as the folder dialog) takes the
 * pick; only the first call counts, and a rejected promise rejects the pick. `closed` (the menu went away) answers
 * `undefined` after `delayMs`, but only if nothing was chosen by then.
 */
export function createPick<T>(delayMs: number = CLOSE_GRACE_MS) {
  let chosen = false;
  let settle!: (v: T | undefined | PromiseLike<T | undefined>) => void;
  const promise = new Promise<T | undefined>((resolve) => (settle = resolve));
  return {
    promise,
    choose(v: T | undefined | PromiseLike<T | undefined>) {
      if (chosen) return;
      chosen = true;
      settle(v);
    },
    closed() {
      setTimeout(() => {
        if (!chosen) settle(undefined);
      }, delayMs);
    },
  };
}
