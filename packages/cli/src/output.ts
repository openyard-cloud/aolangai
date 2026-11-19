// Everything the command prints, as pure functions. Lines starting with `[aolangai]` go to stderr; stdout is only the
// worker's answer (and the denials paragraph) and the output of `status`. Another program reads these strings.
import path from "node:path";
import { limitedUntil, usedPct, type Account, type AccountStatus, type Exclusion, type Limits, type QuotaWindow, type RefuseCode, type Run } from "@aolangai/core";

export const PREFIX = "[aolangai] ";

export const USAGE = `Usage:
  aolangai run "<prompt>" | -  [--cwd <folder>] [--label <label>] [--account <name>] [--new] [--read-only]
  aolangai status [--json]
  aolangai stop <run number> | --all
  aolangai install [--check]

  run      delegate a run to the account with the most quota left; the worker's result goes to stdout.
           "-" reads the prompt from stdin; if the prompt starts with "-", put "--" before it.
  status   the accounts (accepting work or not, quota) and the runs in progress; --json for machines.
  stop     stop one run, or all runs with --all.
  install  install the skill for Claude Code (~/.claude/skills/aolangai) and the command ~/.local/bin/aolangai;
           --check only prints the status and writes nothing.

Exit codes: 0 done · 1 run failed · 2 refused or bad usage · 3 account hit its limit mid-run · 130 stopped
`;

const two = (n: number) => String(n).padStart(2, "0");
/** `1 run`, `3 runs`. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** One line: line breaks become single spaces. */
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** Local time, 24-hour `HH:MM`. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** `40 seconds`, `3 minutes`, `1 hour 5 minutes`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return count(s, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return count(m, "minute");
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? count(h, "hour") : `${count(h, "hour")} ${count(m % 60, "minute")}`;
}

// ---- run ----

export function startLine(o: { runId: number; accountName: string; sessionId?: string; note?: string }): string {
  const session = o.sessionId ? `continuing session ${o.sessionId.slice(0, 8)}` : "new session";
  const note = o.note ? ` · ${oneLine(o.note)}` : "";
  return `${PREFIX}run #${o.runId} · account ${oneLine(o.accountName)} · ${session}${note}`;
}

/** What `run` prints on stdout for a finished run: the answer, then the denials; empty when there is neither. */
export function doneStdout(result: string | undefined, denials: string[] | undefined): string {
  const answer = (result ?? "").replace(/\s+$/, "");
  const parts: string[] = [];
  if (answer) parts.push(answer + "\n");
  if (denials && denials.length > 0) parts.push(`${answer ? "\n" : ""}${PREFIX}Permission denied: ${denials.join("; ")}\n`);
  return parts.join("");
}

export const failedLine = (runId: number, error: string) => `${PREFIX}run #${runId} failed: ${oneLine(error)}`;
export const limitedLine = (runId: number, accountName: string) =>
  `${PREFIX}run #${runId} stopped because account ${oneLine(accountName)} hit its limit. Retry to run on another account.`;
export const stoppedLine = (runId: number) => `${PREFIX}run #${runId} stopped`;

export interface AccountDetail {
  usedPct?: number;
  reservePct: number;
}

function exclusionText(e: Exclusion, detail: AccountDetail, now: number): string {
  switch (e.reason) {
    case "blocked":
      return e.until !== undefined ? limitedUntil(e.until, now) : "limited";
    case "folder":
      return "not allowed in this folder";
    case "off":
      return "not accepting";
    case "reserve":
      return detail.usedPct !== undefined
        ? `used ${Math.round(detail.usedPct)}%, over the reserve of ${detail.reservePct}%`
        : `over the reserve of ${detail.reservePct}%`;
    case "not-logged-in":
      return "not logged in";
  }
}

/** The stderr lines of a refused run. `detail` looks an account up for the numbers an exclusion needs; `now` decides whether a limit's end needs its day. */
export function refusalLines(code: RefuseCode, message: string, exclusions: Exclusion[] | undefined, detail: (accountId: string) => AccountDetail, limits: Pick<Limits, "maxConcurrent" | "maxRunsPerHour">, now: number): string[] {
  switch (code) {
    case "nested":
      return [`${PREFIX}A worker cannot delegate further`];
    // The cap was reached, so the count equals the cap; the numbers come from the store's limits, not from core's wording.
    case "too-many":
      return [`${PREFIX}${count(limits.maxConcurrent, "run")} in progress (maximum ${limits.maxConcurrent})`];
    case "too-fast":
      return [`${PREFIX}${count(limits.maxRunsPerHour, "run")} delegated in the last 60 minutes (maximum ${limits.maxRunsPerHour})`];
    case "no-account":
      return [`${PREFIX}${oneLine(message)}`, ...(exclusions ?? []).map((e) => `- ${oneLine(e.name)}: ${exclusionText(e, detail(e.accountId), now)}`)];
    case "bad-cwd":
    case "unknown-account":
      return [`${PREFIX}${oneLine(message)}`];
  }
}

// ---- stop ----

export const signalledLine = (id: number) => `${PREFIX}Sent the stop signal to run #${id}`;
export const notRunningLine = (id: number) => `${PREFIX}run #${id} is not running`;
export const goneLine = (id: number) => `${PREFIX}run #${id}: the delegating process was lost, marked as failed`;
export const signalledAllLine = (n: number) => `${PREFIX}Sent the stop signal to ${count(n, "run")}`;

// ---- status ----

export interface StatusAccount {
  id: string;
  name: string;
  accepting: boolean;
  usedPct: number | null;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  models: (QuotaWindow & { name: string })[];
  limit: { message: string; until: number | null } | null;
  running: number;
}
export interface StatusRun {
  id: number;
  accountId: string;
  account: string;
  cwd: string;
  label: string | null;
  startedAt: number;
}
/** The JSON `status --json` prints. */
export interface StatusReport {
  accounts: StatusAccount[];
  running: StatusRun[];
}

/** A limit without a known end counts for this long after it was seen (same rule as account selection). */
const UNKNOWN_LIMIT_MS = 60 * 60_000;

function activeLimit(s: AccountStatus | undefined, now: number): StatusAccount["limit"] {
  const l = s?.limit;
  if (!l) return null;
  const active = l.until !== undefined ? l.until > now : now - l.at < UNKNOWN_LIMIT_MS;
  return active ? { message: l.message, until: l.until ?? null } : null;
}

export function statusReport(accounts: Account[], statuses: AccountStatus[], running: Run[], now: number): StatusReport {
  const byId = new Map(statuses.map((s) => [s.accountId, s]));
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  return {
    accounts: accounts.map((a) => {
      const s = byId.get(a.id);
      return {
        id: a.id,
        name: a.name,
        accepting: a.accepting,
        usedPct: usedPct(s) ?? null,
        fiveHour: s?.fiveHour ?? null,
        sevenDay: s?.sevenDay ?? null,
        models: s?.models ?? [],
        limit: activeLimit(s, now),
        running: running.filter((r) => r.accountId === a.id).length,
      };
    }),
    running: running.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      account: names.get(r.accountId) ?? r.accountId,
      cwd: r.cwd,
      label: r.label ?? null,
      startedAt: r.createdAt,
    })),
  };
}

const pct = (w: { usedPct: number }) => `${Math.round(w.usedPct)}%`;

/** `status` lines: one per account, then one per running run. */
export function statusText(report: StatusReport, now: number): string[] {
  const lines: string[] = [];
  for (const a of report.accounts) {
    const quota = [
      a.fiveHour ? `5h ${pct(a.fiveHour)}` : undefined,
      a.sevenDay ? `week ${pct(a.sevenDay)}` : undefined,
      ...a.models.map((m) => `${oneLine(m.name)} ${pct(m)}`),
    ].filter((x): x is string => x !== undefined);
    const fields = [
      oneLine(a.name),
      a.accepting ? "accepting" : "not accepting",
      quota.length > 0 ? quota.join(" · ") : "no data yet",
    ];
    if (a.limit) fields.push(a.limit.until !== null ? limitedUntil(a.limit.until, now) : "limited");
    fields.push(`running ${a.running}`);
    lines.push(fields.join("  "));
  }
  if (report.accounts.length === 0) lines.push("No accounts yet");
  for (const r of report.running) {
    const label = r.label ? ` "${oneLine(r.label)}"` : "";
    lines.push(`#${r.id} ${oneLine(r.account)} ${path.basename(r.cwd)} ${duration(now - r.startedAt)}${label}`);
  }
  return lines;
}
