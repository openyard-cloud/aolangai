export interface Focusable {
  focus(): void;
}

/**
 * Behaviour of a side panel that opens over the screen: puts the keyboard focus on `target` once, closes on Escape,
 * and when detached gives the focus back to `opener` (what the user clicked to open it). `onEscape` is called
 * through the caller's latest handler, so a parent that re-renders (and passes a new function) never re-attaches
 * the panel and never steals the focus again. Returns the detach function. DOM-free so it can be tested without one.
 */
export function attachPanel(o: { target: Focusable | null; opener: Focusable | null; onEscape(): void; listen(cb: (key: string) => void): () => void }): () => void {
  o.target?.focus();
  const stop = o.listen((key) => {
    if (key === "Escape") o.onEscape();
  });
  return () => {
    stop();
    o.opener?.focus();
  };
}
