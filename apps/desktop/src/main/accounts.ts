import os from "node:os";
import path from "node:path";
import { expandHome, type Account } from "@aolangai/core";

const DEFAULT_RESERVE_PCT = 90;
const HOME_PREFIX = /^~(\/|$)/;

/** The directory a configDir value means: empty and `~/.claude` are the same default one. */
export function normalizeConfigDir(configDir: string | undefined): string {
  const dir = configDir?.trim();
  return path.resolve(expandHome(dir ? dir : path.join(os.homedir(), ".claude")));
}

const isAbsoluteOrHome = (p: string) => path.isAbsolute(p) || HOME_PREFIX.test(p);

export type AccountInput = Omit<Account, "id"> & { id?: string };

/**
 * Checks an account the owner typed in (with an error per problem) and returns it cleaned up: trimmed name, defaults for
 * missing fields. `others` are the accounts it must not collide with (every account except itself). Pure: the caller
 * decides the id, resolves "auto" and sets `accepting`.
 */
export function cleanAccount(input: AccountInput, others: Account[]): Omit<Account, "id" | "accepting"> {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("The account needs a name");
  if (others.some((o) => o.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(`An account named "${name}" already exists`);

  const reservePct = input.reservePct ?? DEFAULT_RESERVE_PCT;
  if (!Number.isInteger(reservePct) || reservePct < 0 || reservePct > 100) throw new Error("The reserve must be a whole number from 0 to 100");

  const allowedDirs = (input.allowedDirs ?? []).map((d) => d.trim());
  for (const d of allowedDirs) {
    if (!isAbsoluteOrHome(d)) throw new Error(`The folder "${d}" must be a full path (starting with / or ~)`);
  }

  const configDir = input.configDir?.trim() || undefined;
  if (configDir !== undefined && !isAbsoluteOrHome(configDir)) {
    throw new Error("The config dir must be left empty or be a full path (starting with / or ~)");
  }
  const dir = normalizeConfigDir(configDir);
  const clash = others.find((o) => normalizeConfigDir(o.configDir) === dir);
  if (clash) throw new Error(`Account "${clash.name}" already uses this config dir`);

  const model = input.model?.trim() || undefined;
  const permissionMode = input.permissionMode?.trim() || undefined;
  return {
    name,
    ...(configDir !== undefined ? { configDir } : {}),
    ...(model !== undefined ? { model } : {}),
    allowedDirs,
    reservePct,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
}
