/** Shortens text to at most `max` characters, ending in an ellipsis when it was cut. */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function str(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : undefined;
}

/** One short line for a `tool_use` block ("Read login.test.ts", "Run: git status"). Display only. */
export function toolText(block: { name?: unknown; input?: unknown }): string {
  const name = typeof block.name === "string" && block.name ? block.name : "tool";
  const input = block.input;
  const file = (key: string) => str(input, key);
  switch (name) {
    case "Read": {
      const p = file("file_path");
      return p ? `Read ${baseName(p)}` : name;
    }
    case "Edit": {
      const p = file("file_path");
      return p ? `Edit ${baseName(p)}` : name;
    }
    case "NotebookEdit": {
      const p = file("notebook_path") ?? file("file_path");
      return p ? `Edit ${baseName(p)}` : name;
    }
    case "Write": {
      const p = file("file_path");
      return p ? `Write ${baseName(p)}` : name;
    }
    case "Bash": {
      const c = file("command");
      return c ? `Run: ${cut(oneLine(c), 80)}` : name;
    }
    case "Grep":
    case "Glob": {
      const p = file("pattern");
      return p ? `Search: ${cut(oneLine(p), 80)}` : name;
    }
    case "Task":
    case "Agent": {
      const d = file("description");
      return d ? `Delegate to subagent: ${cut(oneLine(d), 80)}` : name;
    }
    case "WebFetch":
    case "WebSearch": {
      const w = file("url") ?? file("query");
      return w ? `Web: ${cut(oneLine(w), 80)}` : name;
    }
    default:
      return name;
  }
}
