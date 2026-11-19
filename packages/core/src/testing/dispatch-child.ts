// A dispatcher in its own process, for tests that kill it mid-run: node --import tsx dispatch-child.ts <db> <cwd> <claude>
import { openDb } from "../store/db.js";
import { createRepos } from "../store/repos.js";
import { processStart } from "../runs/control.js";
import { dispatch } from "../runs/dispatch.js";

const [dbFile, cwd, claudePath] = process.argv.slice(2) as [string, string, string];
const repos = createRepos(openDb(dbFile));
// A test helper: ps gets a generous timeout so a loaded machine does not leave the run without its start times.
const ps = { psTimeoutMs: 15_000 };
await dispatch(
  { repos, claudePath, env: {}, now: Date.now, pid: process.pid, pidStart: processStart(process.pid, ps) ?? "", ps },
  { prompt: "run of the child process", cwd },
);
