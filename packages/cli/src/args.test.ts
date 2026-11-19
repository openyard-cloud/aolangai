import { describe, expect, it } from "vitest";
import { parseCli } from "./args.js";

const err = (argv: string[]) => {
  const p = parseCli(argv);
  if (p.cmd !== "error") throw new Error(`expected a syntax error, got ${JSON.stringify(p)}`);
  return p.message;
};

describe("run", () => {
  it("takes the prompt and defaults every flag", () => {
    expect(parseCli(["run", "do it"])).toEqual({ cmd: "run", prompt: "do it", fromStdin: false, fresh: false, readOnly: false });
  });
  it("reads each flag", () => {
    expect(
      parseCli(["run", "x", "--cwd", "/tmp/p", "--label", "add tests", "--account", "Claude B", "--new", "--read-only", "--retry-of", "14"]),
    ).toEqual({
      cmd: "run", prompt: "x", fromStdin: false, cwd: "/tmp/p", label: "add tests", account: "Claude B", fresh: true, readOnly: true, retryOf: 14,
    });
  });
  it("accepts flags before the prompt", () => {
    expect(parseCli(["run", "--read-only", "x"])).toMatchObject({ cmd: "run", prompt: "x", readOnly: true });
  });
  it("`-` means: read the prompt from stdin", () => {
    expect(parseCli(["run", "-"])).toMatchObject({ cmd: "run", prompt: "", fromStdin: true });
    expect(parseCli(["run", "-", "--cwd", "/tmp"])).toMatchObject({ fromStdin: true, cwd: "/tmp" });
  });
  it("`--` lets a prompt start with dashes", () => {
    expect(parseCli(["run", "--", "--prompt-text"])).toMatchObject({ prompt: "--prompt-text", fromStdin: false });
    expect(parseCli(["run", "--", "-"])).toMatchObject({ prompt: "-", fromStdin: false });
  });
  it("keeps an empty prompt (the command refuses it)", () => {
    expect(parseCli(["run", ""])).toMatchObject({ cmd: "run", prompt: "", fromStdin: false });
  });
  it("a missing prompt is a syntax error", () => {
    expect(err(["run"])).toContain("prompt");
    expect(err(["run", "--new"])).toContain("prompt");
  });
  it("more than one prompt is a syntax error", () => {
    expect(err(["run", "do", "it"])).toContain("single");
  });
  it("an unknown flag is a syntax error", () => {
    expect(err(["run", "x", "--bogus"])).toContain("--bogus");
    expect(err(["run", "--prompt-text"])).toContain("--prompt-text");
  });
  it("a flag without its value is a syntax error", () => {
    expect(err(["run", "x", "--cwd"])).toContain("--cwd");
  });
  it("--retry-of must be a positive integer", () => {
    for (const v of ["0", "-3", "1.5", "abc", "", "1e3", "12x"]) expect(err(["run", "x", "--retry-of", v])).toContain("--retry-of");
  });
});

describe("status", () => {
  it("with and without --json", () => {
    expect(parseCli(["status"])).toEqual({ cmd: "status", json: false });
    expect(parseCli(["status", "--json"])).toEqual({ cmd: "status", json: true });
  });
  it("refuses extra arguments", () => {
    expect(err(["status", "x"])).toBeTruthy();
    expect(err(["status", "--all"])).toContain("--all");
  });
});

describe("stop", () => {
  it("a run id or --all", () => {
    expect(parseCli(["stop", "14"])).toEqual({ cmd: "stop", target: 14 });
    expect(parseCli(["stop", "--all"])).toEqual({ cmd: "stop", target: "all" });
  });
  it("needs exactly one of them", () => {
    expect(err(["stop"])).toContain("run number");
    expect(err(["stop", "1", "--all"])).toBeTruthy();
    expect(err(["stop", "1", "2"])).toBeTruthy();
  });
  it("the id must be a positive integer", () => {
    for (const v of ["0", "abc", "1.5", "#14"]) expect(err(["stop", v])).toContain("run number");
    expect(err(["stop", "-1"])).toContain("-1"); // looks like a flag
  });
});

describe("the rest", () => {
  it("--help, -h and no arguments", () => {
    expect(parseCli(["--help"])).toEqual({ cmd: "help" });
    expect(parseCli(["-h"])).toEqual({ cmd: "help" });
    expect(parseCli([])).toEqual({ cmd: "error", message: "Missing command" });
  });
  it("an unknown command is a syntax error", () => {
    expect(err(["frobnicate"])).toContain("frobnicate");
  });
});

describe("install", () => {
  it("takes no flags by default", () => {
    expect(parseCli(["install"])).toEqual({ cmd: "install", check: false });
  });
  it("reads --check, --skill-dir and --bin-dir", () => {
    expect(parseCli(["install", "--check", "--skill-dir", "/a", "--bin-dir", "/b"])).toEqual({ cmd: "install", check: true, skillDir: "/a", binDir: "/b" });
  });
  it("rejects arguments and unknown flags", () => {
    expect(err(["install", "x"])).toContain("x");
    expect(err(["install", "--bogus"])).toContain("--bogus");
    expect(err(["install", "--skill-dir"])).toContain("--skill-dir");
  });
});
