import type { Account } from "@aolangai/core";
import { AUTO_CONFIG_DIR } from "../../shared/api.js";

export type ConfigChoice = "default" | "auto" | "path";
export interface AccountDraft {
  name: string;
  configChoice: ConfigChoice;
  configPath: string;
  model: string;
  /** One folder per line. */
  allowedDirs: string;
  reservePct: string;
  permissionMode: string;
  /** The "Accepting work" switch. Only an existing account can have it on: a new account always starts with it off. */
  accepting: boolean;
}
export type DraftKey = keyof AccountDraft;
export type AccountInput = Omit<Account, "id"> & { id?: string };

export const emptyDraft = (): AccountDraft => ({ name: "", configChoice: "default", configPath: "", model: "", allowedDirs: "", reservePct: "90", permissionMode: "", accepting: false });

export function draftFromAccount(a: Account): AccountDraft {
  return {
    name: a.name,
    configChoice: a.configDir ? "path" : "default",
    configPath: a.configDir ?? "",
    model: a.model ?? "",
    allowedDirs: a.allowedDirs.join("\n"),
    reservePct: String(a.reservePct),
    permissionMode: a.permissionMode ?? "",
    accepting: a.accepting,
  };
}

/**
 * The account to send to the main process, or what is wrong with each field. The main process checks again
 * (duplicate names, absolute paths); this only catches what the form can see. An existing account takes its
 * "Accepting work" from the draft; a new one always sends false, because the main process starts it off whatever is sent.
 */
export function accountFromDraft(d: AccountDraft, existing: Account | undefined): { account?: AccountInput; errors: Partial<Record<DraftKey, string>> } {
  const errors: Partial<Record<DraftKey, string>> = {};
  const name = d.name.trim();
  if (name === "") errors.name = "The account needs a name";
  const reserve = d.reservePct.trim() === "" ? Number.NaN : Number(d.reservePct);
  if (!Number.isInteger(reserve) || reserve < 0 || reserve > 100) errors.reservePct = "The reserve must be a whole number from 0 to 100";
  let configDir: string | undefined;
  if (d.configChoice === "auto") {
    if (existing) errors.configChoice = '"auto" can only be used when creating a new account';
    else configDir = AUTO_CONFIG_DIR;
  } else if (d.configChoice === "path") {
    configDir = d.configPath.trim();
    if (configDir === "") errors.configPath = "Enter the path of the config dir, or choose the default";
  }
  if (Object.keys(errors).length > 0) return { errors };
  const model = d.model.trim();
  const permissionMode = d.permissionMode.trim();
  return {
    errors,
    account: {
      ...(existing ? { id: existing.id } : {}),
      name,
      ...(configDir !== undefined ? { configDir } : {}),
      ...(model !== "" ? { model } : {}),
      accepting: existing ? d.accepting : false,
      allowedDirs: d.allowedDirs.split("\n").map((x) => x.trim()).filter(Boolean),
      reservePct: reserve,
      ...(permissionMode !== "" ? { permissionMode } : {}),
    },
  };
}

const PERMISSION_MODES: [string, string][] = [
  ["", "app default (acceptEdits)"],
  ["acceptEdits", "acceptEdits"],
  ["auto", "auto"],
  ["default", "default"],
  ["plan", "plan"],
];
/** Options of the permission-mode select; a stored value that is not one of the fixed modes is listed too, so the select shows the truth. */
export function permissionOptions(current: string): [string, string][] {
  const stored = current.trim();
  return stored === "" || PERMISSION_MODES.some(([v]) => v === stored) ? PERMISSION_MODES : [...PERMISSION_MODES, [stored, `${stored} (stored value)`]];
}
