// Runs the command as a child process from source (node --import tsx), against a temp database and the fake claude.
// Tests set FAKE_CLAUDE_* on process.env, so they run serially (vitest's default).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRepos, openDb, processStart, type Account, type Repos, type Run } from "@aolangai/core";
import { installFakeClaude, type FakeClaude } from "../../core/src/testing/fake-claude.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "index.ts");
// The child resolves @aolangai/core to its source through the `paths` of this tsconfig, so no build is needed.
const TSCONFIG = path.join(here, "../tsconfig.test.json");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const init = (sid: string) => ({ type: "system", subtype: "init", session_id: sid, model: "m" });
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const result = (sid: string, r: string, extra: object = {}) => ({
  type: "result", subtype: "success", is_error: false, result: r, session_id: sid,
  usage: { input_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 0, output_tokens: 7 }, permission_denials: [], ...extra,
});

interface Out {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
interface Started {
  child: ChildProcess;
  done: Promise<Out>;
}

let fake: FakeClaude;
let work: string;
let proj: string;
let dbFile: string;
let logFile: string;
let repos: Repos;
let env: NodeJS.ProcessEnv;
let children: ChildProcess[];
let savedEnv: NodeJS.ProcessEnv;

beforeAll(() => { fake = installFakeClaude(); });
afterAll(() => fake.cleanup());
beforeEach(() => {
  savedEnv = { ...process.env };
  children = [];
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")));
  proj = path.join(work, "proj");
  fs.mkdirSync(proj);
  dbFile = path.join(work, "a.db");
  logFile = path.join(work, "log.json");
  env = { ...process.env };
  delete env.AOLANGAI_RUN_ID;
  Object.assign(env, {
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
    AOLANGAI_DB: dbFile,
    AOLANGAI_NO_QUOTA_REFRESH: "1",
    FAKE_CLAUDE_LOG: logFile,
    TSX_TSCONFIG_PATH: TSCONFIG,
  });
  script({ lines: [init("s1"), text("working"), result("s1", "result s1")] });
  repos = createRepos(openDb(dbFile));
  account("a");
});
afterEach(async () => {
  for (const r of repos.runs.recent(50)) {
    for (const pid of [r.workerPid, r.pid]) if (pid !== undefined && pid !== process.pid && r.status === "running") kill(-pid, "SIGKILL");
  }
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  repos.db.close();
  fs.rmSync(work, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

function script(s: object): void {
  env.FAKE_CLAUDE_SCRIPT = JSON.stringify(s);
}
function account(id: string, over: Partial<Account> = {}): Account {
  const a: Account = { id, name: `Claude ${id.toUpperCase()}`, accepting: true, allowedDirs: [], reservePct: 90, ...over };
  repos.accounts.insert(a);
  repos.status.set({ accountId: id, fiveHour: { usedPct: 10 }, sevenDay: { usedPct: 2 }, quotaAt: Date.now() });
  return a;
}
function kill(pid: number, sig: NodeJS.Signals | 0): void {
  try { process.kill(pid, sig); } catch { /* gone */ }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until<T>(f: () => T | undefined, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
    const v = f();
    if (v !== undefined) return v;
  }
  throw new Error("timed out waiting");
}

function start(args: string[], o: { stdin?: string; keepStdin?: boolean; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Started {
  const child = spawn(process.execPath, ["--import", TSX, ENTRY, ...args], { env: o.env ?? env, cwd: o.cwd ?? proj, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin.on("error", () => {});
  if (!o.keepStdin) child.stdin.end(o.stdin ?? "");
  const done = new Promise<Out>((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}
const cli = (args: string[], o?: Parameters<typeof start>[1]) => start(args, o).done;

/** Starts a run that hangs in the fake claude, and waits until its claude is running. */
async function startHanging(args: string[] = ["run", "long job"]): Promise<{ s: Started; run: Run }> {
  script({ early: [init("s1"), text("running")], delayMs: 30_000, lines: [result("s1", "done")] });
  const s = start(args);
  const run = await until(() => repos.runs.running().find((r) => r.workerPid !== undefined && r.workerPidStart !== undefined), 15_000);
  return { s, run };
}

describe("run", () => {
  it("prints the answer on stdout, the notice on stderr, exits 0 and records the run", async () => {
    const r = await cli(["run", "do it", "--label", "try"]);
    expect(r.stdout).toBe("result s1\n");
    expect(r.stderr).toBe("[aolangai] run #1 · account Claude A · new session\n");
    expect(r.code).toBe(0);
    expect(repos.runs.get(1)).toMatchObject({ status: "done", result: "result s1", label: "try", cwd: proj, accountId: "a" });
  });

  it("the start line warns when another run is active in the same folder", async () => {
    const other = repos.runs.insert({
      prompt: "other", cwd: proj, accountId: "a", primaryWorker: true, readOnly: false, status: "running",
      pid: process.pid, pidStart: processStart(process.pid, { psTimeoutMs: 15_000 })!, createdAt: Date.now(),
    });
    const r = await cli(["run", "do it"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`[aolangai] run #${other.id + 1} · account Claude A · new session · Also running in this folder: #${other.id}\n`);
  });

  it("uses --cwd, and the current directory by default", async () => {
    const other = path.join(work, "other");
    fs.mkdirSync(other);
    await cli(["run", "x", "--cwd", other]);
    await cli(["run", "x"], { cwd: proj });
    expect(repos.runs.get(1)?.cwd).toBe(other);
    expect(repos.runs.get(2)?.cwd).toBe(proj);
  });

  it("the second run in a folder resumes the first one's session", async () => {
    await cli(["run", "x"]);
    const r = await cli(["run", "y"]);
    expect(r.stderr).toBe("[aolangai] run #2 · account Claude A · continuing session s1\n");
  });

  it("a prompt from stdin reaches claude intact: dashes, quotes, newlines, no argv", async () => {
    const prompt = `--the-prompt -x\n"double quote" 'single quote' \`command\` $HOME \\n\n\n  indented\n`;
    const r = await cli(["run", "-"], { stdin: prompt });
    expect(r.code).toBe(0);
    const log = JSON.parse(fs.readFileSync(logFile, "utf8")) as { argv: string[]; stdin: string };
    expect(log.stdin).toBe(prompt);
    expect(log.argv.join(" ")).not.toContain("the-prompt");
    expect(repos.runs.get(1)?.prompt).toBe(prompt);
  });

  it("a 300 KB prompt from stdin reaches claude intact", async () => {
    const prompt = Array.from({ length: 6000 }, (_, i) => `line ${i} --flag "quote" ${"x".repeat(35)}`).join("\n");
    expect(prompt.length).toBeGreaterThan(300_000);
    const r = await cli(["run", "-"], { stdin: prompt });
    expect(r.code).toBe(0);
    expect((JSON.parse(fs.readFileSync(logFile, "utf8")) as { stdin: string }).stdin).toBe(prompt);
  });

  it("a prompt after -- may start with dashes", async () => {
    await cli(["run", "--", "--prompt-text"]);
    expect((JSON.parse(fs.readFileSync(logFile, "utf8")) as { stdin: string }).stdin).toBe("--prompt-text");
  });

  it("an empty prompt (argument or stdin) exits 2 and starts nothing", async () => {
    const a = await cli(["run", ""]);
    const b = await cli(["run", "-"], { stdin: " \n\n" });
    for (const r of [a, b]) {
      expect(r).toMatchObject({ code: 2, stdout: "" });
      expect(r.stderr).toBe("[aolangai] The prompt is empty\n");
    }
    expect(repos.runs.recent(5)).toEqual([]);
  });

  it("a long answer is printed whole", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `result line ${i} ${"y".repeat(40)}`).join("\n");
    script({ lines: [init("s1"), result("s1", big)] });
    const r = await cli(["run", "x"]);
    expect(r.stdout).toBe(big + "\n");
  });

  it("denials follow the answer on stdout", async () => {
    script({ lines: [init("s1"), result("s1", "result\n", { permission_denials: [{ tool_name: "Bash", tool_input: { command: "npm run migrate" } }] })] });
    const r = await cli(["run", "x"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("result\n\n[aolangai] Permission denied: Bash(npm run migrate)\n");
  });

  it("a failed run: one stderr line, exit 1, nothing on stdout", async () => {
    script({ lines: [init("s1")], exitCode: 1, stderr: "broken" });
    const r = await cli(["run", "x"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[aolangai\] run #1 · account Claude A · new session\n\[aolangai\] run #1 failed: .*broken.*\n$/);
    expect(repos.runs.get(1)?.status).toBe("failed");
  });

  const LIMIT = { lines: [init("s1"), { type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm", session_id: "s1" }] };
  const MOVING = (n: number, name: string) => `[aolangai] run #${n} stopped because account ${name} hit its limit. Moving the task to another account.\n`;
  const NOT_TAKEN = (n: number, name: string) => `[aolangai] run #${n} stopped because account ${name} hit its limit. No other account took it over.\n`;

  it("a limit hit mid-run with no other account: exit 3, the account is blocked, the reasons are printed", async () => {
    script(LIMIT);
    const r = await cli(["run", "x"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(MOVING(1, "Claude A"));
    expect(r.stderr).toMatch(/No account can take this run\n- Claude A: limited until /);
    expect(r.stderr.endsWith(NOT_TAKEN(1, "Claude A"))).toBe(true);
    expect(repos.runs.get(1)?.status).toBe("limited");
    expect(repos.runs.recent(10)).toHaveLength(1);
  });

  it("a limit hit mid-run moves the task to the next account, in a new session, told to check the folder first", async () => {
    const dirB = path.join(work, "cfg-b");
    account("b", { configDir: dirB });
    script({ byConfigDir: { "": LIMIT, [dirB]: { lines: [init("s2"), text("finishing"), result("s2", "done on B")] } } });
    const r = await cli(["run", "add tests", "--label", "tests"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("done on B\n");
    expect(r.stderr).toBe(
      "[aolangai] run #1 · account Claude A · new session\n" + MOVING(1, "Claude A") + "[aolangai] run #2 · account Claude B · new session\n",
    );
    const [first, second] = [repos.runs.get(1)!, repos.runs.get(2)!];
    expect(first.status).toBe("limited");
    expect(repos.status.get("a")?.limit).toBeDefined();
    expect(second).toMatchObject({ status: "done", accountId: "b", retryOf: 1, label: "tests", prompt: "add tests" });
    const log = JSON.parse(fs.readFileSync(logFile, "utf8"));
    expect(log.env.CLAUDE_CONFIG_DIR).toBe(dirB);
    expect(log.stdin).toMatch(/^This task was started by another worker, on another account, which hit its usage limit/);
    expect(log.stdin).toMatch(/git status/);
    expect(log.stdin.endsWith("\n\n---\n\nadd tests")).toBe(true);
  });

  it("a task moves at most twice, so at most three accounts are tried", async () => {
    for (const id of ["b", "c", "d"]) account(id, { configDir: path.join(work, `cfg-${id}`) });
    script(LIMIT);
    const r = await cli(["run", "x"]);
    expect(r.code).toBe(3);
    expect(repos.runs.recent(10).map((x) => [x.id, x.accountId, x.status, x.retryOf])).toEqual([
      [3, "c", "limited", 2],
      [2, "b", "limited", 1],
      [1, "a", "limited", undefined],
    ]);
    expect(r.stderr).toContain(MOVING(1, "Claude A"));
    expect(r.stderr).toContain(MOVING(2, "Claude B"));
    expect(r.stderr.endsWith(NOT_TAKEN(3, "Claude C"))).toBe(true);
    expect(repos.status.get("d")?.limit).toBeUndefined();
  });

  it("--no-failover and --account keep the task on the account that hit its limit", async () => {
    account("b", { configDir: path.join(work, "cfg-b") });
    script(LIMIT);
    const off = await cli(["run", "x", "--no-failover"]);
    expect(off.code).toBe(3);
    expect(off.stderr).not.toContain("Moving the task");
    expect(off.stderr.endsWith(NOT_TAKEN(1, "Claude A"))).toBe(true);
    const named = await cli(["run", "y", "--account", "claude b"]);
    expect(named.code).toBe(3);
    expect(named.stderr).not.toContain("Moving the task");
    expect(repos.runs.recent(10).map((x) => x.accountId)).toEqual(["b", "a"]);
  });

  it("--retry-of fills retryOf; a bad value exits 2", async () => {
    await cli(["run", "x", "--retry-of", "7"]);
    expect(repos.runs.get(1)?.retryOf).toBe(7);
    for (const v of ["0", "abc", "1.5", "-2"]) {
      const r = await cli(["run", "x", "--retry-of", v]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--retry-of");
    }
    expect(repos.runs.recent(10)).toHaveLength(1);
  });

  it("--read-only and --new are passed on", async () => {
    await cli(["run", "x"]);
    const r = await cli(["run", "y", "--new", "--read-only"]);
    expect(r.stderr).toContain("new session");
    expect(repos.runs.get(2)?.readOnly).toBe(true);
  });

  it("nothing on stderr mentions the experimental sqlite warning", async () => {
    const r = await cli(["run", "x"]);
    expect(r.stderr).not.toContain("ExperimentalWarning");
    expect(r.stderr).not.toContain("--trace-warnings");
  });
});

describe("refusals (exit 2)", () => {
  it("no account takes the work: the reasons, one per account", async () => {
    repos.accounts.update({ ...repos.accounts.get("a")!, accepting: false });
    account("b", { allowedDirs: ["/nowhere"] });
    account("c", { reservePct: 50 });
    repos.status.set({ accountId: "c", fiveHour: { usedPct: 93 }, quotaAt: Date.now() });
    const until1 = Date.now() + 3_600_000;
    account("d");
    repos.status.set({ accountId: "d", fiveHour: { usedPct: 100 }, limit: { message: "m", until: until1, at: Date.now() }, quotaAt: Date.now() });
    const d = new Date(until1);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    // an hour from now may be tomorrow: then the line names the day ("16 Jan 00:30")
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
    const until = d.getDate() === new Date().getDate() ? hhmm : `${d.getDate()} ${month} ${hhmm}`;
    const r = await cli(["run", "x"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      [
        "[aolangai] No account can take this run",
        "- Claude A: not accepting",
        "- Claude B: not allowed in this folder",
        "- Claude C: used 93%, over the reserve of 50%",
        `- Claude D: limited until ${until}`,
        "",
      ].join("\n"),
    );
    expect(repos.runs.recent(5)).toEqual([]);
  });

  it("no accounts at all", async () => {
    repos.accounts.delete("a");
    const r = await cli(["run", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("[aolangai] No account can take this run\n");
  });

  it("--account that matches no account, or two accounts, is refused clearly", async () => {
    account("b", { name: "Trùng" });
    account("c", { name: " trùng " });
    const none = await cli(["run", "x", "--account", "Nobody"]);
    const two = await cli(["run", "x", "--account", "TRÙNG"]);
    expect(none).toMatchObject({ code: 2, stdout: "", stderr: '[aolangai] No account named "Nobody"\n' });
    expect(two).toMatchObject({ code: 2, stdout: "", stderr: '[aolangai] Several accounts are named "TRÙNG", cannot tell which to use\n' });
    expect(repos.runs.recent(5)).toEqual([]);
  });

  it("--account picks that account by name, whatever its quota", async () => {
    account("b", { name: "Company" });
    repos.status.set({ accountId: "b", fiveHour: { usedPct: 95 }, quotaAt: Date.now() });
    const r = await cli(["run", "x", "--account", "company"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("account Company");
  });

  it("--account of an account that cannot take the work says why", async () => {
    account("b", { name: "Company", accepting: false });
    const r = await cli(["run", "x", "--account", "Company"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("[aolangai] Account Company cannot take this run\n- Company: not accepting\n");
  });

  it("a folder that does not exist", async () => {
    const r = await cli(["run", "x", "--cwd", path.join(work, "missing")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^\[aolangai\] No such folder: .*missing\n$/);
  });

  it("too many runs at once", async () => {
    repos.settings.setLimits({ ...repos.settings.getLimits(), maxConcurrent: 1 });
    const { s, run } = await startHanging();
    const r = await cli(["run", "y"]);
    expect(r).toMatchObject({ code: 2, stdout: "", stderr: "[aolangai] 1 run in progress (maximum 1)\n" });
    s.child.kill("SIGTERM");
    await s.done;
  });

  it("too many runs in the last hour", async () => {
    repos.settings.setLimits({ ...repos.settings.getLimits(), maxRunsPerHour: 1 });
    await cli(["run", "x"]);
    const r = await cli(["run", "y"]);
    expect(r).toMatchObject({ code: 2, stderr: "[aolangai] 1 run delegated in the last 60 minutes (maximum 1)\n" });
  });

  it("from inside a worker", async () => {
    const r = await cli(["run", "x"], { env: { ...env, AOLANGAI_RUN_ID: "5" } });
    expect(r).toMatchObject({ code: 2, stdout: "", stderr: "[aolangai] A worker cannot delegate further\n" });
  });

  const noClaude = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].some((d) => fs.existsSync(path.join(d, "claude")));
  it.skipIf(noClaude)("claude is not installed", async () => {
    const home = path.join(work, "home");
    fs.mkdirSync(home);
    const r = await cli(["run", "x"], { env: { ...env, HOME: home, PATH: path.join(work, "empty") } });
    expect(r).toMatchObject({ code: 2, stdout: "", stderr: "[aolangai] The claude command was not found on the PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin or /bin\n" });
    expect(repos.runs.recent(5)).toEqual([]);
  });
});

describe("stopping a run", () => {
  it("SIGTERM mid-run: exit 130, the row is stopped, the claude is gone", async () => {
    const { s, run } = await startHanging();
    expect(run.pid).toBe(s.child.pid);
    const worker = run.workerPid!;
    expect(alive(worker)).toBe(true);
    s.child.kill("SIGTERM");
    const r = await s.done;
    expect(r.code).toBe(130);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("[aolangai] run #1 stopped\n");
    expect(repos.runs.get(run.id)).toMatchObject({ status: "stopped" });
    expect(repos.runs.get(run.id)?.finishedAt).toBeDefined();
    await until(() => (alive(worker) ? undefined : true));
  });

  for (const sig of ["SIGINT", "SIGHUP"] as const) {
    it(`${sig} stops it the same way`, async () => {
      const { s, run } = await startHanging();
      s.child.kill(sig);
      expect((await s.done).code).toBe(130);
      expect(repos.runs.get(run.id)?.status).toBe("stopped");
      await until(() => (alive(run.workerPid!) ? undefined : true));
    });
  }

  it("a second signal while stopping neither crashes nor exits before the row is recorded", async () => {
    const { s, run } = await startHanging();
    s.child.kill("SIGTERM");
    s.child.kill("SIGINT");
    s.child.kill("SIGTERM");
    const r = await s.done;
    expect(r.code).toBe(130);
    expect(r.signal).toBeNull();
    expect(repos.runs.get(run.id)?.status).toBe("stopped");
    await until(() => (alive(run.workerPid!) ? undefined : true));
  });

  it("`stop <id>` makes the dispatcher stop the run", async () => {
    const { s, run } = await startHanging();
    const st = await cli(["stop", String(run.id)]);
    expect(st).toMatchObject({ code: 0, stdout: "", stderr: `[aolangai] Sent the stop signal to run #${run.id}\n` });
    expect((await s.done).code).toBe(130);
    expect(repos.runs.get(run.id)?.status).toBe("stopped");
  });

  it("`stop --all` signals every running dispatcher", async () => {
    const a = await startHanging();
    account("b");
    const second = start(["run", "second job", "--new"]);
    await until(() => (repos.runs.running().length === 2 ? true : undefined), 15_000);
    const st = await cli(["stop", "--all"]);
    expect(st).toMatchObject({ code: 0, stdout: "", stderr: "[aolangai] Sent the stop signal to 2 runs\n" });
    expect((await a.s.done).code).toBe(130);
    expect((await second.done).code).toBe(130);
    expect(repos.runs.running()).toEqual([]);
  });

  it("`stop` of a run that is not running, or of nothing", async () => {
    await cli(["run", "x"]);
    expect(await cli(["stop", "1"])).toMatchObject({ code: 0, stdout: "", stderr: "[aolangai] run #1 is not running\n" });
    expect(await cli(["stop", "--all"])).toMatchObject({ code: 0, stdout: "", stderr: "[aolangai] Sent the stop signal to 0 runs\n" });
  });

  it("`stop` of a run whose dispatcher is gone marks it failed", async () => {
    const dead = spawnSync("true").pid!;
    const row = repos.runs.insert({
      prompt: "orphan", cwd: proj, accountId: "a", primaryWorker: true, readOnly: false, status: "running",
      pid: dead, pidStart: processStart(process.pid, { psTimeoutMs: 15_000 })!, createdAt: Date.now(),
    });
    const r = await cli(["stop", String(row.id)]);
    expect(r).toMatchObject({ code: 0, stdout: "", stderr: `[aolangai] run #${row.id}: the delegating process was lost, marked as failed\n` });
    expect(repos.runs.get(row.id)?.status).toBe("failed");
  });

  it("`stop` of an unknown run id exits 2", async () => {
    const r = await cli(["stop", "99"]);
    expect(r).toMatchObject({ code: 2, stdout: "", stderr: "[aolangai] No run #99\n" });
  });

  it("`stop` with bad syntax exits 2", async () => {
    for (const args of [["stop"], ["stop", "abc"], ["stop", "1", "--all"]]) {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^\[aolangai\] /);
    }
  });
});

describe("a signal while the quota is being asked", () => {
  /** An accepting account whose numbers are stale, so dispatch asks; the test seam makes the ask hang. */
  function staleAccount(id: string, pct: number): void {
    repos.status.set({ accountId: id, fiveHour: { usedPct: pct }, quotaAt: Date.now() - 10 * 60_000 });
  }
  async function startAsking(): Promise<Started> {
    const marker = path.join(work, "asking");
    delete env.AOLANGAI_NO_QUOTA_REFRESH;
    env.AOLANGAI_TEST_QUOTA_HANG = marker;
    const s = start(["run", "a job"]);
    await until(() => (fs.existsSync(marker) ? true : undefined), 15_000);
    expect(repos.runs.recent(5)).toEqual([]); // no row yet: dispatch is still asking
    return s;
  }

  it("SIGTERM before the run row exists: exit 130, a stopped row, claude never started", async () => {
    staleAccount("a", 10);
    const s = await startAsking();
    s.child.kill("SIGTERM");
    const r = await s.done;
    expect(r.code).toBe(130);
    expect(r.signal).toBeNull();
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("[aolangai] run #1 stopped\n");
    const row = repos.runs.get(1)!;
    expect(row).toMatchObject({ status: "stopped", accountId: "a" });
    expect(row.finishedAt).toBeDefined();
    expect(row.workerPid).toBeUndefined();
    expect(fs.existsSync(logFile)).toBe(false); // the fake claude was never started
    expect(repos.runs.running()).toEqual([]);
  });

  it("SIGTERM during the ask, then a refusal: exit 2 with the refusal text and no row", async () => {
    // Stale numbers that put the account over its reserve: after the (cancelled) ask dispatch refuses.
    staleAccount("a", 95);
    const s = await startAsking();
    s.child.kill("SIGTERM");
    const r = await s.done;
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(["[aolangai] No account can take this run", "- Claude A: used 95%, over the reserve of 90%", ""].join("\n"));
    expect(repos.runs.recent(5)).toEqual([]);
    expect(fs.existsSync(logFile)).toBe(false);
  });
});

describe("status", () => {
  it("lists every account, then what is running", async () => {
    account("b", { name: "Off", accepting: false });
    repos.status.delete("b");
    const { s, run } = await startHanging();
    repos.runs.update(run.id, { label: "add login tests", createdAt: Date.now() - 3 * 60_000 - 1000 });
    const r = await cli(["status"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      [
        "Claude A  accepting  5h 10% · week 2%  running 1",
        "Off  not accepting  no data yet  running 0",
        `#${run.id} Claude A proj 3 minutes "add login tests"`,
        "",
      ].join("\n"),
    );
    s.child.kill("SIGTERM");
    await s.done;
  });

  it("--json prints one parseable object with stable fields", async () => {
    account("b", { name: "Off", accepting: false });
    const r = await cli(["status", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.endsWith("}\n")).toBe(true);
    const j = JSON.parse(r.stdout) as { accounts: Record<string, unknown>[]; running: unknown[] };
    expect(Object.keys(j)).toEqual(["accounts", "running"]);
    expect(j.accounts).toHaveLength(2);
    expect(j.accounts[0]).toMatchObject({
      id: "a", name: "Claude A", accepting: true, usedPct: 10, fiveHour: { usedPct: 10 }, sevenDay: { usedPct: 2 }, models: [], limit: null, running: 0,
    });
    expect(j.accounts[1]).toMatchObject({ id: "b", accepting: false });
    expect(j.running).toEqual([]);
  });

  it("works on an empty store, and creates it if missing", async () => {
    const fresh = path.join(work, "new", "x.db");
    const r = await cli(["status"], { env: { ...env, AOLANGAI_DB: fresh } });
    expect(r).toMatchObject({ code: 0, stdout: "No accounts yet\n", stderr: "" });
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("does not print the experimental sqlite warning", async () => {
    const r = await cli(["status"]);
    expect(r.stderr).not.toContain("ExperimentalWarning");
    expect(r.stderr).toBe("");
  });

  it("other warnings still print, through the entry's own printer", async () => {
    // The preloaded file waits until index.ts has installed its listener (named printWarning), then emits a warning, so
    // the line below can only come from that listener: Node's default printer would add a "--trace-warnings" hint.
    const warn = path.join(work, "warn.mjs");
    fs.writeFileSync(
      warn,
      `const t = setInterval(() => {
  if (process.listeners("warning").some((l) => l.name === "printWarning")) {
    clearInterval(t);
    process.emitWarning("another warning", "CustomWarning");
  }
}, 1);
`,
    );
    // `run -` waits for stdin, which keeps the process alive until the warning has been printed.
    const s = start(["run", "-"], { keepStdin: true, env: { ...env, NODE_OPTIONS: `--import ${pathToFileURL(warn).href}` } });
    const line = `(node:${s.child.pid}) CustomWarning: another warning\n`;
    let seen = "";
    s.child.stderr!.on("data", (d: Buffer) => (seen += d.toString()));
    await until(() => (seen.includes("CustomWarning") ? true : undefined), 8_000).catch(() => undefined);
    s.child.stdin!.end();
    const r = await s.done;
    expect(r.stderr).toBe(line + "[aolangai] The prompt is empty\n");
    expect(r.stderr).not.toContain("trace-warnings");
    expect(r.stderr).not.toContain("ExperimentalWarning");
    expect(r.code).toBe(2);
  });
});

describe("ELECTRON_RUN_AS_NODE", () => {
  it("is removed from the process environment at startup, so claude and other children never inherit it", async () => {
    // The preload records the variable as the process starts and again as it exits.
    const probe = path.join(work, "probe.mjs");
    const out = path.join(work, "probe.json");
    fs.writeFileSync(
      probe,
      `import fs from "node:fs";
const first = process.env.ELECTRON_RUN_AS_NODE;
process.on("exit", () => fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ first, last: process.env.ELECTRON_RUN_AS_NODE ?? null })));
`,
    );
    const r = await cli(["status"], { env: { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: `--import ${pathToFileURL(probe).href}` } });
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ first: "1", last: null });
  });
});

describe("usage", () => {
  it("--help prints the usage on stdout, exit 0", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^Usage:/);
    expect(r.stdout).toContain("aolangai run");
    expect(r.stdout).toContain("aolangai status");
    expect(r.stdout).toContain("aolangai stop");
    expect(r.stdout).toContain("aolangai install");
  });
  it("no arguments: usage on stderr, exit 2", async () => {
    const r = await cli([]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  });
  it("an unknown command: the problem, then usage, on stderr, exit 2", async () => {
    const r = await cli(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[aolangai\] .*frobnicate.*\n/);
    expect(r.stderr).toContain("Usage:");
  });
  it("a syntax error in run: exit 2, nothing started", async () => {
    for (const args of [["run"], ["run", "x", "--bogus"], ["run", "a", "b"]]) {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
    }
    expect(repos.runs.recent(5)).toEqual([]);
  });
});
