import { stopAll, stopRun, type Repos } from "@aolangai/core";
import type { Io } from "../io.js";
import { PREFIX, goneLine, notRunningLine, signalledAllLine, signalledLine } from "../output.js";

export function stopCommand(repos: Repos, io: Io, target: number | "all"): number {
  if (target === "all") {
    io.err(signalledAllLine(stopAll(repos)) + "\n");
    return 0;
  }
  if (!repos.runs.get(target)) {
    io.err(`${PREFIX}No run #${target}\n`);
    return 2;
  }
  const r = stopRun(repos, target);
  io.err((r === "signalled" ? signalledLine(target) : r === "gone" ? goneLine(target) : notRunningLine(target)) + "\n");
  return 0;
}
