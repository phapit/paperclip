import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Global skills root agy discovers for a profile: `<HOME>/.gemini/config/skills`. */
export function antigravitySkillsHomeFor(home: string): string {
  return path.join(path.resolve(home), ".gemini", "config", "skills");
}

/** Skills home for the profile an agent config selects (config env HOME, else the process home). */
export function resolveAntigravitySkillsHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  return antigravitySkillsHomeFor(asString(env.HOME) ?? os.homedir());
}

async function buildSnapshot(config: Record<string, unknown>, skillsHome: string): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "antigravity_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.gemini/config/skills",
    missingDetail: "Configured but not currently linked into the Antigravity skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

/**
 * Link the desired Paperclip skills into one profile's skills home and unlink
 * Paperclip-managed skills that are no longer desired. Foreign entries are left alone.
 */
export async function installAntigravitySkills(
  config: Record<string, unknown>,
  skillsHome: string,
  desiredSkills?: string[],
): Promise<void> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSet = new Set(
    desiredSkills
      ? [...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries), ...desiredSkills]
      : resolveLegacyPaperclipDesiredSkillNames(config, availableEntries),
  );
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    await ensurePaperclipSkillSymlink(available.source, path.join(skillsHome, available.runtimeName));
  }
  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }
}

export async function listAntigravitySkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config, resolveAntigravitySkillsHome(ctx.config));
}

export async function syncAntigravitySkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const skillsHome = resolveAntigravitySkillsHome(ctx.config);
  await installAntigravitySkills(ctx.config, skillsHome, desiredSkills);
  return buildSnapshot(ctx.config, skillsHome);
}
