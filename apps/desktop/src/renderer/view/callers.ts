// Which Claude Code session delegated a run, as a label: pure and unit-tested, like the rest of view/.
import type { Run } from "@aolangai/core";
import { DESKTOP_KIND, type AppState, type OpenSession } from "../../shared/api.js";
import { baseName } from "./format.js";

export interface CallerView {
  /** Undefined when the account is not known: an API-key caller, a deleted account, or Claude desktop with no declared account. */
  accountId?: string;
  /** The account's name, else "unknown account". */
  accountName: string;
  /** The open session the run came from; undefined once it has closed. */
  session?: OpenSession;
  /** The session's name, else its folder, else the app it ran in. */
  place: string;
  /** "Personal · notes" */
  label: string;
  /** Identifies one session across runs: a pid alone is reused by the OS. */
  key: string;
}

/** The caller recorded on a run; undefined for runs from before callers were recorded or started outside a session. Same rule as core's callerOfRun. */
export function callerOf(run: Run, s: AppState): CallerView | undefined {
  const { callerPid: pid, callerStartedAt: startedAt, callerKind: kind } = run;
  if (pid === undefined || startedAt === undefined || kind === undefined) return undefined;
  // Claude desktop has no account of its own in the process list; the owner declares it.
  const claimed = kind === DESKTOP_KIND ? s.desktopAccountId : run.callerAccountId;
  const account = claimed === undefined ? undefined : s.accounts.find((a) => a.id === claimed);
  const session = s.sessions.find((x) => x.pid === pid && x.startedAt === startedAt);
  const accountName = account?.name ?? "unknown account";
  const place = session?.name ?? (session?.cwd ? baseName(session.cwd) : undefined) ?? kind;
  return {
    ...(account ? { accountId: account.id } : {}),
    accountName,
    ...(session ? { session } : {}),
    place,
    label: `${accountName} · ${place}`,
    key: `${pid}:${startedAt}`,
  };
}
