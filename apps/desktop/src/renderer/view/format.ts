// Display-only helpers for the renderer. Nothing here may drive a decision (approval, routing): it only shapes text.
/**
 * The human-readable part of an error that crossed IPC: Electron wraps what the main process threw as
 * `Error invoking remote method '…': Error: <text>`. Drops the wrapper and the leading `Error: ` / `HubError: `
 * labels, never anything inside the text itself.
 */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (!raw.startsWith("Error invoking remote method")) return raw;
  const text = raw.replace(/^Error invoking remote method '[^']*': /, "").replace(/^(\w*Error: )+/, "");
  return text === "" ? raw : text;
}

export type ToastTone = "error" | "info";
export interface Toast { id: number; text: string; tone: ToastTone }
const MAX_TOASTS = 3;

/** Newest last; the same text again moves to the end instead of stacking. */
export function addToast(list: Toast[], text: string, id: number, tone: ToastTone = "error"): Toast[] {
  return [...list.filter((t) => t.text !== text), { id, text, tone }].slice(-MAX_TOASTS);
}

/** "1 run", "3 runs": the noun with a regular plural. */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** The top bar's count of runs in progress: "1 running", "3 running". */
export const runningCount = (n: number) => `${n} running`;
/** The confirmation of Stop all: "Stop the 1 running run?", "Stop all 2 running runs?". */
export const stopAllQuestion = (n: number) => (n === 1 ? "Stop the 1 running run?" : `Stop all ${n} running runs?`);
/** "1 needs you", "3 need you". */
export const needsYouCount = (n: number) => `${n} ${n === 1 ? "needs" : "need"} you`;

/** Last path segment, for showing a folder compactly (the full path goes in a tooltip). */
export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

const pad = (n: number) => String(n).padStart(2, "0");
/** "09:05", local time. */
export function clock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "18 Nov", local time; from a table, so it reads the same whatever the machine's locale. */
export function dayMonth(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTH[d.getMonth()]}`;
}
const startOfDay = (t: number) => new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime();
/** "09:05" today, "23:59 16 Nov" on another day. */
export function clockOrDate(at: number, now: number): string {
  if (startOfDay(at) === startOfDay(now)) return clock(at);
  return `${clock(at)} ${dayMonth(at)}`;
}
/** "6 Nov 2026 09:05:07", local time; for tooltips. */
export function fullTime(at: number): string {
  const d = new Date(at);
  return `${dayMonth(at)} ${d.getFullYear()} ${clock(at)}:${pad(d.getSeconds())}`;
}

const INSTALL_LABEL = {
  missing: "not installed",
  current: "installed, up to date",
  outdated: "installed, out of date",
  foreign: "This file was not created by aolangai, the app does not overwrite it",
  "no-dir": "no config dir yet",
} as const;
/** What the install pane says about one file (skill or shim); `no-dir` is an account whose config dir does not exist yet. */
export function installLabel(s: keyof typeof INSTALL_LABEL): string {
  return INSTALL_LABEL[s];
}

const CONNECTION_LABEL = {
  connected: "connected",
  "not-logged-in": "not logged in",
  "not-installed": "Claude Code not installed",
  error: "connection error",
} as const;
/** The connection state of an account in words; `detail` (an error text) is appended when there is one. */
export function connectionLabel(c: { state: keyof typeof CONNECTION_LABEL; detail?: string }): string {
  return c.detail ? `${CONNECTION_LABEL[c.state]}: ${c.detail}` : CONNECTION_LABEL[c.state];
}
