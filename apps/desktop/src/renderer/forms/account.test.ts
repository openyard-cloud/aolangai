import { expect, test } from "vitest";
import { AUTO_CONFIG_DIR } from "../../shared/api.js";
import { account } from "../testing.js";
import { accountFromDraft, draftFromAccount, emptyDraft, permissionOptions } from "./account.js";

test("new account: default config dir ~/.claude, reserve 90", () => {
  const d = emptyDraft();
  expect(d).toMatchObject({ name: "", configChoice: "default", reservePct: "90", allowedDirs: "", model: "", permissionMode: "", accepting: false });
});

test("accountFromDraft: trims spaces, one folder per line, drops empty lines", () => {
  const r = accountFromDraft({ ...emptyDraft(), name: "  Company ", allowedDirs: " ~/Projects/app \n\n/srv/a\n", model: " fable ", reservePct: "80" }, undefined);
  expect(r.errors).toEqual({});
  expect(r.account).toEqual({ name: "Company", allowedDirs: ["~/Projects/app", "/srv/a"], reservePct: 80, model: "fable", accepting: false });
});

test("accountFromDraft: the default config dir leaves out configDir; auto only for a new account; a path is kept as typed", () => {
  expect(accountFromDraft({ ...emptyDraft(), name: "A" }, undefined).account).not.toHaveProperty("configDir");
  expect(accountFromDraft({ ...emptyDraft(), name: "A", configChoice: "auto" }, undefined).account?.configDir).toBe(AUTO_CONFIG_DIR);
  expect(accountFromDraft({ ...emptyDraft(), name: "A", configChoice: "path", configPath: " ~/.claude-b " }, undefined).account?.configDir).toBe("~/.claude-b");
  const empty = accountFromDraft({ ...emptyDraft(), name: "A", configChoice: "path", configPath: " " }, undefined);
  expect(empty.errors.configPath).toBeDefined();
});

test("accountFromDraft: errors for an empty name and a wrong reserve", () => {
  const r = accountFromDraft({ ...emptyDraft(), name: " ", reservePct: "101" }, undefined);
  expect(r.account).toBeUndefined();
  expect(Object.keys(r.errors).sort()).toEqual(["name", "reservePct"]);
  expect(accountFromDraft({ ...emptyDraft(), name: "A", reservePct: "9.5" }, undefined).errors.reservePct).toBeDefined();
});

test("editing an existing account: keeps the id and the accepting-work switch, never sends auto", () => {
  const existing = account({ id: "x9", accepting: true, configDir: "~/.claude-b", permissionMode: "plan", allowedDirs: ["/a"], model: "m" });
  const d = draftFromAccount(existing);
  expect(d).toMatchObject({ configChoice: "path", configPath: "~/.claude-b", permissionMode: "plan", allowedDirs: "/a", model: "m", reservePct: "90" });
  const r = accountFromDraft({ ...d, name: "Renamed" }, existing);
  expect(r.account).toEqual({ id: "x9", name: "Renamed", configDir: "~/.claude-b", model: "m", accepting: true, allowedDirs: ["/a"], reservePct: 90, permissionMode: "plan" });
  const back = accountFromDraft({ ...d, configChoice: "auto" }, existing);
  expect(back.errors.configChoice).toBeDefined();
  expect(draftFromAccount(account({ configDir: undefined })).configChoice).toBe("default");
});

test("accepting-work switch: an existing account saves the value that was turned on or off", () => {
  const off = account({ id: "x", accepting: false });
  const d = draftFromAccount(off);
  expect(d.accepting).toBe(false);
  expect(accountFromDraft({ ...d, accepting: true }, off).account?.accepting).toBe(true);
  const on = account({ id: "y", accepting: true });
  expect(accountFromDraft({ ...draftFromAccount(on), accepting: false }, on).account?.accepting).toBe(false);
  expect(accountFromDraft(draftFromAccount(on), on).account?.accepting).toBe(true);
});

test("accepting-work switch: a new account always sends false whatever the draft says", () => {
  expect(accountFromDraft({ ...emptyDraft(), name: "A", accepting: true }, undefined).account?.accepting).toBe(false);
});

test("permissionOptions: an unknown stored value is added so the select shows the truth", () => {
  const values = (v: string) => permissionOptions(v).map(([x]) => x);
  expect(values("")).toEqual(["", "acceptEdits", "auto", "default", "plan"]);
  expect(values("plan")).toEqual(["", "acceptEdits", "auto", "default", "plan"]);
  expect(values("bypassPermissions")).toEqual(["", "acceptEdits", "auto", "default", "plan", "bypassPermissions"]);
  const stored = account({ permissionMode: "dontAsk" });
  expect(draftFromAccount(stored).permissionMode).toBe("dontAsk");
  expect(accountFromDraft(draftFromAccount(stored), stored).account?.permissionMode).toBe("dontAsk");
});
