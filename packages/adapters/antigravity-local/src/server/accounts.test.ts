import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_TOKEN_REL,
  discoverAccountHomes,
  isAccountCoolingDown,
  markAccountCooldown,
  orderAccountCandidates,
  resetAccountCooldownsForTests,
  resolveAccountPool,
  resolveAccountsBase,
} from "./accounts.js";

let base: string;

async function makeProfile(name: string, signedIn: boolean) {
  const home = path.join(base, name);
  await fs.mkdir(path.dirname(path.join(home, ANTIGRAVITY_TOKEN_REL)), { recursive: true });
  if (signedIn) await fs.writeFile(path.join(home, ANTIGRAVITY_TOKEN_REL), "token");
  return home;
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "agy-accounts-"));
  resetAccountCooldownsForTests();
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("account discovery", () => {
  it("finds only signed-in profiles, sorted, ignoring dot dirs", async () => {
    const b = await makeProfile("b", true);
    const a = await makeProfile("a", true);
    await makeProfile("c", false);
    await makeProfile(".hidden", true);
    expect(await discoverAccountHomes(base)).toEqual([a, b]);
  });

  it("returns an empty list when the base does not exist", async () => {
    expect(await discoverAccountHomes(path.join(base, "missing"))).toEqual([]);
  });

  it("derives the accounts base from env", () => {
    expect(resolveAccountsBase({ PAPERCLIP_ANTIGRAVITY_ACCOUNTS_DIR: "/x/y" })).toBe("/x/y");
    expect(resolveAccountsBase({ PAPERCLIP_HOME: "/data" })).toBe("/data/antigravity-accounts");
  });
});

describe("resolveAccountPool", () => {
  it("keeps absolute paths, dedupes, and drops relative or empty entries", async () => {
    const pool = await resolveAccountPool({ accountHomes: ["/p/one", "/p/one", "rel/path", "", 5, "/p/two"] });
    expect(pool).toEqual(["/p/one", "/p/two"]);
  });

  it("expands auto to every signed-in profile", async () => {
    const a = await makeProfile("a", true);
    const b = await makeProfile("b", true);
    const pool = await resolveAccountPool(
      { accountHomes: ["auto"] },
      { PAPERCLIP_ANTIGRAVITY_ACCOUNTS_DIR: base },
    );
    expect(pool).toEqual([a, b]);
  });

  it("is empty when nothing is configured", async () => {
    expect(await resolveAccountPool({})).toEqual([]);
  });
});

describe("cooldown and ordering", () => {
  it("expires cooldowns", () => {
    markAccountCooldown("/p/one", 1, 1_000);
    expect(isAccountCoolingDown("/p/one", 1_000 + 30_000)).toBe(true);
    expect(isAccountCoolingDown("/p/one", 1_000 + 61_000)).toBe(false);
  });

  it("puts the session owner first and cooling profiles last", () => {
    markAccountCooldown("/p/b", 60);
    expect(orderAccountCandidates(["/p/a", "/p/b", "/p/c"], "/p/c")).toEqual(["/p/c", "/p/a", "/p/b"]);
    expect(orderAccountCandidates(["/p/a", "/p/b", "/p/c"], null)).toEqual(["/p/a", "/p/c", "/p/b"]);
  });

  it("does not prefer a session owner that is cooling down", () => {
    markAccountCooldown("/p/a", 60);
    expect(orderAccountCandidates(["/p/a", "/p/b"], "/p/a")).toEqual(["/p/b", "/p/a"]);
  });
});
