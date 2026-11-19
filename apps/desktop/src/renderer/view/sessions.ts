// How open Claude Code sessions are worded on screen; pure and unit-tested.
import { DESKTOP_KIND, TERMINAL_KIND, isTtyName, type AppState, type OpenSession } from "../../shared/api.js";

/** "2 Terminal · 1 VS Code": most sessions first, then by name. */
export function summarize(sessions: OpenSession[]): string {
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${kind}`)
    .join(" · ");
}

/**
 * What the "Switch to" button does for this session, as its tooltip; undefined = nothing can be brought forward, no
 * button. Mirrors the main process: a Terminal session with a tty gets its own tab, any other with a known app gets that app.
 */
export function focusHint(s: OpenSession): string | undefined {
  if (s.kind === TERMINAL_KIND && isTtyName(s.tty)) return "Bring the Terminal window of this session to the front";
  if (s.appPath !== undefined) return `Bring ${s.kind} to the front (cannot pick the exact window)`;
  return undefined;
}

/** Sessions that belong to no lane: Claude desktop ones the owner has not assigned, and those whose account is unknown or no longer exists. */
export function outside(s: AppState): { desktop: OpenSession[]; unknown: OpenSession[] } {
  const known = new Set(s.accounts.map((a) => a.id));
  const desktop: OpenSession[] = [];
  const unknown: OpenSession[] = [];
  for (const session of s.sessions) {
    if (session.kind === DESKTOP_KIND) {
      if (session.accountId === undefined) desktop.push(session);
    } else if (session.accountId === undefined || !known.has(session.accountId)) unknown.push(session);
  }
  return { desktop, unknown };
}
