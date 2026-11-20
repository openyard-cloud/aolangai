import { parseArgs } from "node:util";

export type Command =
  | { cmd: "run"; prompt: string; fromStdin: boolean; cwd?: string; label?: string; account?: string; fresh: boolean; readOnly: boolean; retryOf?: number; failover: boolean }
  | { cmd: "status"; json: boolean }
  | { cmd: "stop"; target: number | "all" }
  | { cmd: "install"; check: boolean; skillDir?: string; binDir?: string }
  | { cmd: "help" }
  | { cmd: "error"; message: string };

const fail = (message: string): Command => ({ cmd: "error", message });
const POSITIVE_INT = /^[1-9]\d*$/;

interface Parsed {
  values: Record<string, string | boolean | undefined>;
  /** Positionals in order; `literal` is true after a `--`, where a lone `-` is text and not "read stdin". */
  positionals: { value: string; literal: boolean }[];
}

/** Strict parse of one command's arguments; a bad flag comes back as a message. */
function parseFlags(args: string[], options: NonNullable<Parameters<typeof parseArgs>[0]>["options"]): Parsed | string {
  try {
    const { values, tokens } = parseArgs({ args, options, allowPositionals: true, strict: true, tokens: true });
    const positionals: Parsed["positionals"] = [];
    let literal = false;
    for (const t of tokens) {
      if (t.kind === "option-terminator") literal = true;
      else if (t.kind === "positional") positionals.push({ value: t.value, literal });
    }
    return { values, positionals };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const flag = /'(-[^']*?)(?: <value>)?'/.exec(msg)?.[1] ?? "";
    const code = (e as { code?: string }).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return `Unknown flag ${flag}`;
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") return `Flag ${flag} needs a value`;
    return msg;
  }
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

/** Reads the command line (without node and the script). Never throws. */
export function parseCli(argv: string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined) return fail("Missing command");
  if (name === "--help" || name === "-h") return { cmd: "help" };

  if (name === "run") {
    const p = parseFlags(rest, {
      cwd: { type: "string" },
      label: { type: "string" },
      account: { type: "string" },
      new: { type: "boolean" },
      "read-only": { type: "boolean" },
      "no-failover": { type: "boolean" },
      "retry-of": { type: "string" },
      help: { type: "boolean", short: "h" },
    });
    if (typeof p === "string") return fail(p);
    if (p.values.help) return { cmd: "help" };
    if (p.positionals.length === 0) return fail('Missing prompt: aolangai run "<prompt>" or aolangai run -');
    if (p.positionals.length > 1) return fail("The prompt must be a single argument: put it in quotes or use aolangai run -");
    const retry = str(p.values["retry-of"]);
    if (retry !== undefined && !(POSITIVE_INT.test(retry) && Number.isSafeInteger(Number(retry)))) {
      return fail(`--retry-of needs a run number that is a positive integer, got "${retry}"`);
    }
    const prompt = p.positionals[0]!;
    const fromStdin = prompt.value === "-" && !prompt.literal;
    const cmd: Command = { cmd: "run", prompt: fromStdin ? "" : prompt.value, fromStdin, fresh: p.values.new === true, readOnly: p.values["read-only"] === true, failover: p.values["no-failover"] !== true };
    const cwd = str(p.values.cwd);
    const label = str(p.values.label);
    const account = str(p.values.account);
    if (cwd !== undefined) cmd.cwd = cwd;
    if (label !== undefined) cmd.label = label;
    if (account !== undefined) cmd.account = account;
    if (retry !== undefined) cmd.retryOf = Number(retry);
    return cmd;
  }

  if (name === "status") {
    const p = parseFlags(rest, { json: { type: "boolean" }, help: { type: "boolean", short: "h" } });
    if (typeof p === "string") return fail(p);
    if (p.values.help) return { cmd: "help" };
    if (p.positionals.length > 0) return fail(`aolangai status takes no argument "${p.positionals[0]!.value}"`);
    return { cmd: "status", json: p.values.json === true };
  }

  if (name === "stop") {
    const p = parseFlags(rest, { all: { type: "boolean" }, help: { type: "boolean", short: "h" } });
    if (typeof p === "string") return fail(p);
    if (p.values.help) return { cmd: "help" };
    const all = p.values.all === true;
    if (all) return p.positionals.length > 0 ? fail("Use a run number or --all, not both") : { cmd: "stop", target: "all" };
    if (p.positionals.length === 0) return fail("Missing run number: aolangai stop <run number> or aolangai stop --all");
    if (p.positionals.length > 1) return fail("aolangai stop takes one run number");
    const id = p.positionals[0]!.value;
    if (!POSITIVE_INT.test(id) || !Number.isSafeInteger(Number(id))) return fail(`The run number must be a positive integer, got "${id}"`);
    return { cmd: "stop", target: Number(id) };
  }

  if (name === "install") {
    const p = parseFlags(rest, {
      check: { type: "boolean" },
      "skill-dir": { type: "string" },
      "bin-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    });
    if (typeof p === "string") return fail(p);
    if (p.values.help) return { cmd: "help" };
    if (p.positionals.length > 0) return fail(`aolangai install takes no argument "${p.positionals[0]!.value}"`);
    const cmd: Command = { cmd: "install", check: p.values.check === true };
    const skillDir = str(p.values["skill-dir"]);
    const binDir = str(p.values["bin-dir"]);
    if (skillDir !== undefined) cmd.skillDir = skillDir;
    if (binDir !== undefined) cmd.binDir = binDir;
    return cmd;
  }

  return fail(`Unknown command "${name}"`);
}
