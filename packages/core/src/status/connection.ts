import type { ConnectionState, ConnectionStatus, Account } from "../types.js";
import { CLAUDE_NOT_FOUND, childEnv } from "../accounts/env.js";

export interface CheckDeps {
  exec(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string }>;
  which(cmd: string): string | null;
}

const status = (state: ConnectionState, detail?: string): ConnectionStatus => ({ state, ...(detail ? { detail } : {}), checkedAt: Date.now() });

/** Checks whether an account can run, without ever sending a prompt to a model. */
export async function checkAccount(account: Account, deps: CheckDeps): Promise<ConnectionStatus> {
  const claude = deps.which("claude");
  if (!claude) return status("not-installed", CLAUDE_NOT_FOUND);
  const env = childEnv(process.env, account);
  try {
    const { stdout } = await deps.exec(claude, ["auth", "status", "--json"], env);
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; subscriptionType?: unknown };
    if (parsed.loggedIn === true) return status("connected", typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined);
    if (parsed.loggedIn === false) return status("not-logged-in");
    return status("error", "Could not read the output of claude auth status");
  } catch (e) {
    return status("error", e instanceof SyntaxError ? "Could not read the output of claude auth status" : e instanceof Error ? e.message : String(e));
  }
}
