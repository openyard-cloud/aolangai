import type { ClaudeOutcome } from "./claude-run.js";
import { cut, toolText } from "./tool-text.js";

// Claude Code's own wording for a limit that was really hit (SDK USAGE_LIMIT_ERROR_PREFIXES and
// ORG_POLICY_LIMIT_PREFIXES), and for warnings that are not one (USAGE_WARNING_PREFIXES).
const LIMIT_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
  "This service is disabled for your org",
];
const WARNING_PREFIXES = ["You've used", "You're close to"];
const LIMIT_ASSISTANT_ERRORS = new Set(["rate_limit", "billing_error", "account_on_hold"]);
const LIMIT_WORDING = /rate.?limit|usage limit/i;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const startsWithAny = (text: string, prefixes: string[]) => prefixes.some((p) => text.startsWith(p));

/** Input-side tokens of one usage object, or undefined when it has none of the three numbers. */
function inputSide(u: unknown): number | undefined {
  if (!isObj(u)) return undefined;
  const parts = [num(u.input_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens)];
  return parts.some((p) => p !== undefined) ? parts.reduce<number>((a, p) => a + (p ?? 0), 0) : undefined;
}

function denialText(d: unknown): string {
  const item = isObj(d) ? d : {};
  const name = typeof item.tool_name === "string" ? item.tool_name : "tool";
  const input = isObj(item.tool_input) ? item.tool_input : {};
  const pick = name === "Bash" ? input.command : name === "Write" || name === "Edit" ? input.file_path : undefined;
  const arg = typeof pick === "string" ? pick : (JSON.stringify(item.tool_input) ?? "");
  return `${name}(${cut(arg, 80)})`;
}

export interface StreamReader {
  /** Handles one stdout line; anything that is not a known JSON object is ignored. */
  feed(line: string): void;
  /** From the system/init line; known as soon as it arrives. */
  sessionId(): string | undefined;
  /**
   * The init line's `apiKeySource` when it names something other than the account's own login ("none"); undefined
   * while there is no init line, or when it lacks the field or says "none".
   */
  foreignKeySource(): string | undefined;
  /** What the result line says, or undefined while there is none. */
  result(): Extract<ClaudeOutcome, { kind: "done" | "limited" | "failed" }> | undefined;
  /** True when a result line arrived and it is not an error. */
  succeeded(): boolean;
}

export function createStreamReader(onEvent?: (e: { kind: "tool" | "text"; text: string }) => void): StreamReader {
  let sessionId: string | undefined;
  let foreignKeySource: string | undefined;
  let resultLine: Json | undefined;
  let contextTokens: number | undefined;
  let assistantLimitError = false;
  let rejected = false;

  const emit = (kind: "tool" | "text", text: string) => {
    try {
      onEvent?.({ kind, text });
    } catch {
      // A display callback must not break the run.
    }
  };

  function assistant(msg: Json): void {
    const message = isObj(msg.message) ? msg.message : {};
    if (typeof msg.error === "string" && LIMIT_ASSISTANT_ERRORS.has(msg.error)) assistantLimitError = true;
    if (msg.parent_tool_use_id == null) {
      const ctx = inputSide(message.usage);
      if (ctx !== undefined) contextTokens = ctx;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === "tool_use") emit("tool", toolText(block));
      else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) emit("text", cut(block.text.trim(), 200));
    }
  }

  function feed(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    if (msg.type === "system" && msg.subtype === "init") {
      if (typeof msg.session_id === "string" && msg.session_id) sessionId = msg.session_id;
      if (msg.apiKeySource !== undefined && msg.apiKeySource !== "none") {
        foreignKeySource = cut(typeof msg.apiKeySource === "string" ? msg.apiKeySource : JSON.stringify(msg.apiKeySource), 80);
      }
    } else if (msg.type === "assistant") assistant(msg);
    else if (msg.type === "rate_limit_event") {
      if (isObj(msg.rate_limit_info) && msg.rate_limit_info.status === "rejected") rejected = true;
    } else if (msg.type === "result") resultLine = msg;
  }

  function result(): ReturnType<StreamReader["result"]> {
    const r = resultLine;
    if (!r) return undefined;
    const sid = (typeof r.session_id === "string" && r.session_id ? r.session_id : undefined) ?? sessionId;
    const text = typeof r.result === "string" ? r.result : "";
    const errors = Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === "string") : [];

    if (r.is_error === false) {
      const usage = isObj(r.usage) ? r.usage : undefined;
      const inputTokens = inputSide(usage);
      return {
        kind: "done",
        result: text,
        sessionId: sid ?? "",
        denials: Array.isArray(r.permission_denials) ? r.permission_denials.map(denialText) : [],
        inputTokens,
        outputTokens: num(usage?.output_tokens),
        contextTokens,
      };
    }

    const texts = [text, ...errors].filter(Boolean);
    const limitText = texts.find((t) => startsWithAny(t, LIMIT_PREFIXES));
    const wordingText = texts.find((t) => LIMIT_WORDING.test(t) && !startsWithAny(t, WARNING_PREFIXES));
    // Only an explicit is_error: true can be a limit; a result without the flag is just malformed.
    const limited =
      r.is_error === true &&
      (limitText !== undefined ||
        assistantLimitError ||
        rejected ||
        r.terminal_reason === "blocking_limit" ||
        r.api_error_status === 429 ||
        wordingText !== undefined);
    const shown = texts.join("\n") || (r.is_error === true ? `claude reported an error (${typeof r.subtype === "string" ? r.subtype : "unknown"})` : "claude returned an invalid result");
    if (limited) return { kind: "limited", message: limitText ?? wordingText ?? shown, sessionId: sid };
    return { kind: "failed", error: shown, sessionId: sid };
  }

  return {
    feed,
    sessionId: () => sessionId,
    foreignKeySource: () => foreignKeySource,
    result,
    succeeded: () => resultLine?.is_error === false,
  };
}
