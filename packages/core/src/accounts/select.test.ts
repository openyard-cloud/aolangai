import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type Account, type AccountStatus } from "../types.js";
import { folderAllowed, selectAccount, usedPct, type Candidate } from "./select.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const L = DEFAULT_LIMITS;

function acct(name: string, over: Partial<Account> = {}): Account {
  return { id: name, name, accepting: true, allowedDirs: [], reservePct: 90, ...over };
}
function cand(name: string, pct: number | undefined, over: { running?: number; warm?: boolean; account?: Partial<Account>; status?: Partial<AccountStatus> } = {}): Candidate {
  const status: AccountStatus = {
    accountId: name,
    ...(pct === undefined ? {} : { sevenDay: { usedPct: pct } }),
    ...over.status,
  };
  return { account: acct(name, over.account), status, running: over.running ?? 0, warm: over.warm ?? false };
}
function pick(cands: Candidate[], cwd = "/work", forced?: string) {
  return selectAccount(cands, cwd, L, NOW, forced);
}
function chosen(cands: Candidate[], cwd = "/work", forced?: string): string | undefined {
  const r = pick(cands, cwd, forced);
  return r.ok ? r.account.name : undefined;
}

let tmp: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aolangai-select-")));
  fs.mkdirSync(path.join(tmp, "x", "sub"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "xy"), { recursive: true });
  fs.symlinkSync(path.join(tmp, "x"), path.join(tmp, "link"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("usedPct", () => {
  it("takes the largest number: fiveHour 5, sevenDay 72, models [Fable 13] -> 72", () => {
    expect(
      usedPct({
        accountId: "a",
        fiveHour: { usedPct: 5 },
        sevenDay: { usedPct: 72 },
        models: [{ name: "Fable", usedPct: 13 }],
      }),
    ).toBe(72);
  });
  it("is undefined without status or without any window", () => {
    expect(usedPct(undefined)).toBeUndefined();
    expect(usedPct({ accountId: "a" })).toBeUndefined();
  });
});

describe("selectAccount scoring", () => {
  it("A 40%, B 10% -> B", () => {
    expect(chosen([cand("A", 40), cand("B", 10)])).toBe("B");
  });
  it("reports the raw used % of the chosen account", () => {
    const r = pick([cand("A", 40), cand("B", 10, { running: 1 })]);
    expect(r.ok && r.usedPct).toBe(10);
  });
  it("A 20% running 2 jobs (score 30), B 25% idle -> B", () => {
    expect(chosen([cand("A", 20, { running: 2 }), cand("B", 25)])).toBe("B");
  });
  it("A 30% warm, B 20% cold -> A (gap 10 <= 15)", () => {
    expect(chosen([cand("A", 30, { warm: true }), cand("B", 20)])).toBe("A");
  });
  it("A 40% warm, B 20% -> B (gap 20)", () => {
    expect(chosen([cand("A", 40, { warm: true }), cand("B", 20)])).toBe("B");
  });
  it("several warm accounts: the lowest score among them wins", () => {
    expect(chosen([cand("A", 30, { warm: true }), cand("B", 25, { warm: true }), cand("C", 20)])).toBe("B");
  });
  it("ties go to fewer running, then name", () => {
    expect(chosen([cand("B", 10, { running: 1 }), cand("C", 15)])).toBe("C"); // 15 vs 15, C idle
    expect(chosen([cand("B", 20), cand("A", 20)])).toBe("A");
  });
});

describe("selectAccount exclusions", () => {
  it("A not accepting, B 95% with reserve 90, C blocked until now+1h -> ok false with three reasons", () => {
    const r = pick([
      cand("A", 10, { account: { accepting: false } }),
      cand("B", 95),
      cand("C", 10, { status: { limit: { message: "limit", at: NOW, until: NOW + 60 * MIN } } }),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.exclusions).toEqual([
      { accountId: "A", name: "A", reason: "off" },
      { accountId: "B", name: "B", reason: "reserve" },
      { accountId: "C", name: "C", reason: "blocked", until: NOW + 60 * MIN },
    ]);
  });
  it("a limit whose until is in the past does not exclude", () => {
    const c = cand("A", 10, { status: { limit: { message: "limit", at: NOW - 5 * MIN, until: NOW - 1 } } });
    expect(chosen([c])).toBe("A");
  });
  it("a limit without until, at = now - 61 min does not exclude", () => {
    const c = cand("A", 10, { status: { limit: { message: "limit", at: NOW - 61 * MIN } } });
    expect(chosen([c])).toBe("A");
  });
  it("a limit without until, at = now - 10 min excludes as blocked", () => {
    const c = cand("A", 10, { status: { limit: { message: "limit", at: NOW - 10 * MIN } } });
    const r = pick([c]);
    expect(r).toEqual({ ok: false, exclusions: [{ accountId: "A", name: "A", reason: "blocked" }] });
  });
  it("not-logged-in excludes", () => {
    const c = cand("A", 10, { status: { connection: { state: "not-logged-in", checkedAt: NOW } } });
    const r = pick([c]);
    expect(!r.ok && r.exclusions[0]?.reason).toBe("not-logged-in");
  });
  it("an account gets only the first exclusion that applies (off before reserve)", () => {
    const r = pick([cand("A", 99, { account: { accepting: false } })]);
    expect(r).toEqual({ ok: false, exclusions: [{ accountId: "A", name: "A", reason: "off" }] });
  });
  it("excluded accounts never win even with the best score", () => {
    expect(chosen([cand("A", 1, { account: { accepting: false } }), cand("B", 50)])).toBe("B");
  });
});

describe("selectAccount without numbers", () => {
  it("no account has numbers -> still picks one, with a note", () => {
    const r = pick([cand("A", undefined), cand("B", undefined)]);
    expect(r.ok && r.account.name).toBe("A");
    expect(r.ok && r.note).toBe("No quota numbers for this account");
    expect(r.ok && r.usedPct).toBeUndefined();
  });
  it("A without numbers, B 80% -> B, no note", () => {
    const r = pick([cand("A", undefined), cand("B", 80)]);
    expect(r.ok && r.account.name).toBe("B");
    expect(r.ok && r.note).toBeUndefined();
  });
  it("warm A (no numbers) does not beat B with numbers", () => {
    expect(chosen([cand("A", undefined, { warm: true }), cand("B", 80)])).toBe("B");
  });
  it("without any numbers a warm account beats a cold one, then running, then name", () => {
    expect(chosen([cand("A", undefined), cand("B", undefined, { warm: true })])).toBe("B");
    expect(chosen([cand("A", undefined, { running: 1 }), cand("B", undefined)])).toBe("B");
  });
  it("account without a status at all counts as no numbers", () => {
    const c: Candidate = { account: acct("A"), running: 0, warm: false };
    const r = pick([c]);
    expect(r.ok && r.note).toBeDefined();
  });
});

describe("folderAllowed", () => {
  it("allowedDirs [x] with cwd x/sub/ (trailing slash) -> allowed", () => {
    const a = acct("A", { allowedDirs: [path.join(tmp, "x")] });
    expect(folderAllowed(a, path.join(tmp, "x", "sub") + "/")).toBe(true);
  });
  it("allowedDirs [x] with cwd xy -> not allowed", () => {
    const a = acct("A", { allowedDirs: [path.join(tmp, "x")] });
    expect(folderAllowed(a, path.join(tmp, "xy"))).toBe(false);
    const r = pick([{ ...cand("A", 10), account: a }], path.join(tmp, "xy"));
    expect(!r.ok && r.exclusions[0]?.reason).toBe("folder");
  });
  it("resolves symlinks and does not need the folder to exist", () => {
    const a = acct("A", { allowedDirs: [path.join(tmp, "link")] });
    expect(folderAllowed(a, path.join(tmp, "x", "sub"))).toBe(true);
    expect(folderAllowed(a, path.join(tmp, "x", "not-yet", "deep"))).toBe(true);
  });
  it("an allowed dir written ~/p matches the full path of the home folder", () => {
    const a = acct("A", { allowedDirs: ["~/p"] });
    expect(folderAllowed(a, path.join(os.homedir(), "p", "q"))).toBe(true);
    expect(folderAllowed(a, "~/p/q")).toBe(true);
    expect(folderAllowed(a, path.join(os.homedir(), "other"))).toBe(false);
  });
  it("an empty list means anywhere", () => {
    expect(folderAllowed(acct("A"), "/anywhere/at/all")).toBe(true);
  });
});

describe("selectAccount forced", () => {
  it("forced into a 95% account (above reserve) -> chosen", () => {
    expect(chosen([cand("A", 95), cand("B", 10)], "/work", "A")).toBe("A");
  });
  it("forced into a non-accepting account -> ok false with off", () => {
    const r = pick([cand("A", 10, { account: { accepting: false } }), cand("B", 10)], "/work", "A");
    expect(r).toEqual({ ok: false, exclusions: [{ accountId: "A", name: "A", reason: "off" }] });
  });
  it("forced id not in the list -> ok false, no exclusions", () => {
    expect(pick([cand("A", 10)], "/work", "nope")).toEqual({ ok: false, exclusions: [] });
  });
  it("forced still honours blocked and folder", () => {
    const blocked = cand("A", 10, { status: { limit: { message: "l", at: NOW, until: NOW + MIN } } });
    expect(pick([blocked], "/work", "A").ok).toBe(false);
    const f = { ...cand("A", 10), account: acct("A", { allowedDirs: [path.join(tmp, "x")] }) };
    const r = pick([f], path.join(tmp, "xy"), "A");
    expect(!r.ok && r.exclusions[0]?.reason).toBe("folder");
  });
});
