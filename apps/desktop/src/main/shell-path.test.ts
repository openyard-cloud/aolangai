import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyShellPath, loginShell, mergePath, parsePathOutput, PATH_MARK, shellPathArgs, type RunShell } from "./shell-path.js";

const wrap = (p: string) => `${PATH_MARK}${p}${PATH_MARK}`;

test("parsePathOutput takes the PATH between the last two marks, whatever the startup files print around it", () => {
  expect(parsePathOutput(wrap("/a/bin:/usr/bin"))).toBe("/a/bin:/usr/bin");
  expect(parsePathOutput(`Welcome back!\n${wrap("/a/bin:/usr/bin")}\n`)).toBe("/a/bin:/usr/bin");
  // a startup file that prints the mark too does not shift the answer
  expect(parsePathOutput(`${wrap("/stale")}\n${wrap("/real/bin")}`)).toBe("/real/bin");
  expect(parsePathOutput("no marks at all")).toBeUndefined();
  expect(parsePathOutput(`${PATH_MARK}/only/one/mark`)).toBeUndefined();
  expect(parsePathOutput(wrap(""))).toBeUndefined();
  expect(parsePathOutput(wrap("relative:also-relative"))).toBeUndefined();
});

test("mergePath puts the shell's folders first, keeps the app's missing ones, drops duplicates, empty and relative entries", () => {
  expect(mergePath("/nvm/v22/bin:/usr/bin:/bin", "/usr/bin:/bin:/usr/sbin:/sbin")).toBe("/nvm/v22/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  expect(mergePath("/a::.:/a:rel", "/b")).toBe("/a:/b");
  expect(mergePath(undefined, "/usr/bin")).toBe("/usr/bin");
  expect(mergePath("/a", undefined)).toBe("/a");
});

test("loginShell is $SHELL when absolute, otherwise zsh", () => {
  expect(loginShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
  expect(loginShell({ SHELL: "bash" })).toBe("/bin/zsh");
  expect(loginShell({})).toBe("/bin/zsh");
});

test("applyShellPath asks the login shell once and puts its PATH first", async () => {
  const calls: { shell: string; args: string[]; term?: string; timeout: number }[] = [];
  const run: RunShell = async (shell, args, env, timeout) => {
    calls.push({ shell, args, term: env.TERM, timeout });
    return `motd\n${wrap("/Users/x/.nvm/versions/node/v22/bin:/usr/bin:/bin")}`;
  };
  const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  expect(await applyShellPath(env, run)).toBe(true);
  expect(env.PATH).toBe("/Users/x/.nvm/versions/node/v22/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  expect(calls).toEqual([{ shell: "/bin/zsh", args: shellPathArgs(), term: "dumb", timeout: 5000 }]);
});

test("applyShellPath leaves PATH alone when the shell fails, times out, prints no PATH or throws", async () => {
  for (const run of [async () => undefined, async () => "nothing useful", async () => { throw new Error("boom"); }] as RunShell[]) {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    expect(await applyShellPath(env, run)).toBe(false);
    expect(env.PATH).toBe("/usr/bin:/bin");
  }
  const same: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  expect(await applyShellPath(same, async () => wrap("/usr/bin"))).toBe(false);
  expect(same.PATH).toBe("/usr/bin:/bin");
});

test("a real login shell: the PATH its startup file sets reaches the app, and the noise it prints does not", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-shell-"));
  const bin = path.join(home, "vm-bin");
  fs.mkdirSync(bin);
  // zsh reads ~/.zshrc from ZDOTDIR; HOME is not touched so nothing outside the temp folder is read
  fs.writeFileSync(path.join(home, ".zshrc"), `echo "hello from zshrc"\nexport PATH="${bin}:$PATH"\n`);
  try {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", ZDOTDIR: home, PATH: "/usr/bin:/bin" };
    expect(await applyShellPath(env)).toBe(true);
    expect(env.PATH!.split(":")[0]).toBe(bin);
    expect(env.PATH!.split(":")).toContain("/usr/bin");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test("a real shell that hangs is killed after the timeout and PATH stays", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-shell-"));
  fs.writeFileSync(path.join(home, ".zshrc"), "sleep 30\n");
  try {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", ZDOTDIR: home, PATH: "/usr/bin:/bin" };
    const run: RunShell = (shell, args, e) =>
      new Promise((resolve) => {
        import("node:child_process").then(({ execFile }) => {
          execFile(shell, args, { env: e, timeout: 300, killSignal: "SIGKILL" }, (err, out) => resolve(err ? undefined : out));
        });
      });
    const started = Date.now();
    expect(await applyShellPath(env, run)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(env.PATH).toBe("/usr/bin:/bin");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
