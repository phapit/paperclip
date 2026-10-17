import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Where agy keeps the OAuth token, relative to the profile HOME. */
export const ANTIGRAVITY_TOKEN_REL = path.join(".gemini", "antigravity-cli", "antigravity-oauth-token");

export const DEFAULT_QUOTA_COOLDOWN_MIN = 60;

const cooldowns = new Map<string, number>();

function readTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveAccountsBase(env: Record<string, string | undefined> = {}): string {
  const explicit =
    readTrimmed(env.PAPERCLIP_ANTIGRAVITY_ACCOUNTS_DIR) || readTrimmed(process.env.PAPERCLIP_ANTIGRAVITY_ACCOUNTS_DIR);
  if (explicit) return path.resolve(explicit);
  const home = readTrimmed(env.PAPERCLIP_HOME) || readTrimmed(process.env.PAPERCLIP_HOME) || os.homedir();
  return path.join(path.resolve(home), "antigravity-accounts");
}

export async function hasAntigravityToken(home: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(home, ANTIGRAVITY_TOKEN_REL));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Every `<base>/<name>` profile that already has a sign-in token, sorted by name. */
export async function discoverAccountHomes(base: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(base);
  } catch {
    return [];
  }
  const homes: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    const home = path.join(base, name);
    if (await hasAntigravityToken(home)) homes.push(home);
  }
  return homes;
}

/**
 * Resolve the account pool from `accountHomes`. Entries are absolute HOME paths;
 * the literal "auto" expands to every signed-in profile under the accounts base.
 * Empty means a single profile (the agent's HOME) with no rotation.
 */
export async function resolveAccountPool(
  config: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Promise<string[]> {
  const raw = Array.isArray(config.accountHomes) ? config.accountHomes : [];
  const pool: string[] = [];
  const push = (value: string) => {
    const resolved = path.resolve(value);
    if (!pool.includes(resolved)) pool.push(resolved);
  };
  for (const item of raw) {
    const value = readTrimmed(item);
    if (!value) continue;
    if (value === "auto") {
      for (const home of await discoverAccountHomes(resolveAccountsBase(env))) push(home);
    } else if (path.isAbsolute(value)) {
      push(value);
    }
  }
  return pool;
}

export function markAccountCooldown(home: string, minutes: number, now = Date.now()): void {
  cooldowns.set(path.resolve(home), now + Math.max(1, minutes) * 60_000);
}

export function isAccountCoolingDown(home: string, now = Date.now()): boolean {
  const until = cooldowns.get(path.resolve(home));
  if (until === undefined) return false;
  if (until <= now) {
    cooldowns.delete(path.resolve(home));
    return false;
  }
  return true;
}

export function resetAccountCooldownsForTests(): void {
  cooldowns.clear();
}

/**
 * Order candidate profiles for a run: the profile that owns the saved
 * conversation first (when usable), then the rest in configured order.
 * Profiles that are cooling down after a quota error go last, so they are
 * still tried when every account is exhausted.
 */
export function orderAccountCandidates(
  pool: string[],
  savedHome: string | null,
  now = Date.now(),
): string[] {
  const resolvedSaved = savedHome ? path.resolve(savedHome) : null;
  const ready: string[] = [];
  const cooling: string[] = [];
  for (const home of pool) {
    (isAccountCoolingDown(home, now) ? cooling : ready).push(home);
  }
  const first = resolvedSaved && ready.includes(resolvedSaved) ? [resolvedSaved] : [];
  return [...first, ...ready.filter((home) => home !== resolvedSaved), ...cooling];
}
