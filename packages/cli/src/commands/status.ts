import { sweepDeadRuns, type Repos } from "@aolangai/core";
import type { Io } from "../io.js";
import { statusReport, statusText } from "../output.js";

export function statusCommand(repos: Repos, io: Io, json: boolean, now: number = Date.now()): number {
  try {
    // A killed dispatcher must not show up as running for ever.
    sweepDeadRuns(repos, now);
  } catch {
    // listing is still right enough
  }
  const report = statusReport(repos.accounts.list(), repos.status.list(), repos.runs.running(), now);
  io.out(json ? JSON.stringify(report) + "\n" : statusText(report, now).join("\n") + "\n");
  return 0;
}
