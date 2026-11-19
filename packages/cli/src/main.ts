import { createRepos, openDb } from "@aolangai/core";
import { parseCli } from "./args.js";
import { installCommand } from "./commands/install.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { dbPath, ensureDir, stdio, type Io } from "./io.js";
import { PREFIX, USAGE } from "./output.js";

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs one command line; resolves with the exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = stdio): Promise<number> {
  const cmd = parseCli(argv);
  if (cmd.cmd === "help") {
    io.out(USAGE);
    return 0;
  }
  if (cmd.cmd === "error") {
    io.err(`${PREFIX}${cmd.message}\n\n${USAGE}`);
    return 2;
  }
  if (cmd.cmd === "install") return installCommand(cmd, io, env); // needs no database

  const dbFile = dbPath(env);
  let db: ReturnType<typeof openDb> | undefined;
  try {
    ensureDir(dbFile);
    db = openDb(dbFile);
    const repos = createRepos(db);
    switch (cmd.cmd) {
      case "status":
        return statusCommand(repos, io, cmd.json);
      case "stop":
        return stopCommand(repos, io, cmd.target);
      case "run":
        return await runCommand(cmd, { repos, io, env, dbFile, readStdin: readAllStdin });
    }
    return 1; // unreachable: every command is handled above
  } catch (e) {
    io.err(`${PREFIX}Unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    try {
      db?.close();
    } catch {
      // exiting anyway
    }
  }
}
