// A scripted stand-in for the `claude` executable, run by tests as a child process.
// FAKE_CLAUDE_SCRIPT (JSON, see Script) says what to print, how long to wait and how to exit.
// FAKE_CLAUDE_LOG (a file path) receives what the fake was started with: argv, env, stdin, pids.
// It imports only node: builtins so it runs with `node --experimental-strip-types`, no build step.
import { spawn } from "node:child_process";
import fs from "node:fs";

interface Script {
  /** Stdout lines, in order: a string is printed as is, anything else as one JSON line. */
  lines?: unknown[];
  /** Printed right after stdin is read, before the delay (e.g. the init line of a run that then hangs). */
  early?: unknown[];
  /** Wait this long (after reading stdin and the early lines, before `lines`). */
  delayMs?: number;
  exitCode?: number;
  /** Written to stderr before the first line. */
  stderr?: string;
  /** Start a long-lived child in the same process group; its pid goes to the log as childPid. */
  spawnChild?: boolean;
  /** The child keeps our stdout open (inherits it), like a leaked background process would. */
  childInheritsStdout?: boolean;
  ignoreSigterm?: boolean;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => stream.write(text, () => resolve()));
}

async function main(): Promise<void> {
  const script: Script = JSON.parse(process.env.FAKE_CLAUDE_SCRIPT ?? "{}");
  if (script.ignoreSigterm) process.on("SIGTERM", () => {});
  const stdin = await readStdin();

  let childPid: number | undefined;
  if (script.spawnChild) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", script.childInheritsStdout ? "inherit" : "ignore", "ignore"],
    });
    child.unref();
    childPid = child.pid;
  }

  if (process.env.FAKE_CLAUDE_LOG) {
    fs.writeFileSync(
      process.env.FAKE_CLAUDE_LOG,
      JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin, cwd: process.cwd(), pid: process.pid, childPid }),
    );
  }

  if (script.stderr) await write(process.stderr, script.stderr);
  for (const line of script.early ?? []) await write(process.stdout, (typeof line === "string" ? line : JSON.stringify(line)) + "\n");
  if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
  for (const line of script.lines ?? []) {
    await write(process.stdout, (typeof line === "string" ? line : JSON.stringify(line)) + "\n");
  }
  process.exit(script.exitCode ?? 0);
}

void main();
