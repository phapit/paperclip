import { afterEach, describe, expect, it } from "vitest";
import { models as fallbackModels } from "../index.js";
import {
  listAntigravityModels,
  parseAntigravityModels,
  refreshAntigravityModels,
  setAntigravityModelsRunnerForTests,
} from "./models.js";

const OUTPUT = [
  "Fetching available models...",
  "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
  "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
  "gemini-4-argon-medium\tduplicate",
  "not a model row",
  "bad id!\tNope",
  "plain-id\t",
].join("\n");

afterEach(() => setAntigravityModelsRunnerForTests(null));

describe("parseAntigravityModels", () => {
  it("parses id/label rows, skipping banners, duplicates and invalid ids", () => {
    expect(parseAntigravityModels(OUTPUT)).toEqual([
      { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
      { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
      { id: "plain-id", label: "plain-id" },
    ]);
  });
});

describe("listAntigravityModels", () => {
  it("uses discovered models and caches them", async () => {
    let calls = 0;
    setAntigravityModelsRunnerForTests(async () => {
      calls += 1;
      return { code: 0, stdout: OUTPUT };
    });
    const first = await listAntigravityModels();
    const second = await listAntigravityModels();
    expect(first.map((m) => m.id)).toContain("claude-opus-5-5-low");
    expect(second).toBe(first);
    expect(calls).toBe(1);
    await refreshAntigravityModels();
    expect(calls).toBe(2);
  });

  it("falls back to the built-in list when the CLI fails", async () => {
    setAntigravityModelsRunnerForTests(async () => ({ code: 1, stdout: "Authentication required" }));
    expect(await listAntigravityModels()).toEqual(fallbackModels);
  });
});
