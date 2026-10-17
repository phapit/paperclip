import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  antigravitySkillsHomeFor,
  installAntigravitySkills,
  listAntigravitySkills,
  resolveAntigravitySkillsHome,
  syncAntigravitySkills,
} from "./skills.js";

let dir: string;
let home: string;
let skillSource: string;

function makeConfig(desired: string[]): Record<string, unknown> {
  return {
    env: { HOME: home },
    paperclipRuntimeSkills: [{ key: "paperclip/probe", runtimeName: "probe", source: skillSource }],
    paperclipSkillSync: { desiredSkills: desired },
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-skills-"));
  home = path.join(dir, "home");
  skillSource = path.join(dir, "src", "probe");
  await fs.mkdir(skillSource, { recursive: true });
  await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: probe\ndescription: probe skill\n---\nbody\n");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("antigravity skills", () => {
  it("resolves the global skills root under the profile HOME", () => {
    expect(antigravitySkillsHomeFor("/p/acc1")).toBe("/p/acc1/.gemini/config/skills");
    expect(resolveAntigravitySkillsHome({ env: { HOME: "/p/acc2" } })).toBe("/p/acc2/.gemini/config/skills");
  });

  it("links desired skills into the profile and reports them as installed", async () => {
    const config = makeConfig(["paperclip/probe"]);
    const snapshot = await syncAntigravitySkills({ agentId: "a", companyId: "c", adapterType: "antigravity_local", config }, [
      "paperclip/probe",
    ]);
    const link = path.join(home, ".gemini", "config", "skills", "probe");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(link)).toBe(await fs.realpath(skillSource));
    expect(snapshot.supported).toBe(true);
    expect(snapshot.entries.find((entry) => entry.key === "paperclip/probe")?.state).toBe("installed");
    const listed = await listAntigravitySkills({ agentId: "a", companyId: "c", adapterType: "antigravity_local", config });
    expect(listed.entries.find((entry) => entry.key === "paperclip/probe")?.state).toBe("installed");
  });

  it("unlinks Paperclip-managed skills that are no longer desired, leaving foreign ones", async () => {
    const root = path.join(home, ".gemini", "config", "skills");
    await installAntigravitySkills(makeConfig(["paperclip/probe"]), root, ["paperclip/probe"]);
    await fs.mkdir(path.join(root, "foreign"), { recursive: true });
    await installAntigravitySkills(makeConfig([]), root, []);
    await expect(fs.lstat(path.join(root, "probe"))).rejects.toThrow();
    expect((await fs.lstat(path.join(root, "foreign"))).isDirectory()).toBe(true);
  });
});
