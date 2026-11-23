import { expect, test } from "vitest";
import { DESKTOP_KIND, OTHER_KIND, hostOf, parsePs, type Proc } from "./procs.js";

test("parsePs: pid, ppid, uid, tty, lstart (UTC) and comm", () => {
  const text = "10006  9715 501 ttys015 Wed Nov 18 05:27:55 2026     /Users/x/.local/bin/claude\n";
  expect(parsePs(text)).toEqual([{ pid: 10006, ppid: 9715, uid: 501, tty: "ttys015", startedAt: Date.UTC(2026, 10, 18, 5, 27, 55), comm: "/Users/x/.local/bin/claude" }]);
});

test("hostOf: a Claude desktop binary re-parented to launchd is still a desktop session", () => {
  const proc = (pid: number, ppid: number, comm: string): Proc => ({ pid, ppid, uid: 501, startedAt: 0, comm });
  const desktopBin = "/Users/x/Library/Application Support/Claude/claude-code/2.1.325/abc/claude.app/Contents/MacOS/claude";
  const byPid = (...ps: Proc[]) => new Map(ps.map((p) => [p.pid, p]));
  expect(hostOf(proc(2, 1, desktopBin), byPid(proc(1, 0, "/sbin/launchd"), proc(2, 1, desktopBin)))).toEqual({ kind: DESKTOP_KIND });
  expect(hostOf(proc(2, 1, "/Users/x/.local/bin/claude"), byPid(proc(1, 0, "/sbin/launchd"), proc(2, 1, "/Users/x/.local/bin/claude")))).toEqual({ kind: OTHER_KIND });
});
