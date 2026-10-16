import { spawn } from "node:child_process";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as fallbackModels } from "../index.js";
import {
  discoverAccountHomes,
  hasAntigravityToken,
  resolveAccountsBase,
} from "./accounts.js";

const MODELS_TIMEOUT_MS = 15_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

export type AntigravityModelsRunner = (home: string | null) => Promise<{ code: number | null; stdout: string }>;

/**
 * Parse `agy models`: an optional "Fetching ..." banner, then one
 * `<id>\t<label>` row per model.
 */
export function parseAntigravityModels(stdout: string): AdapterModel[] {
  const seen = new Set<string>();
  const models: AdapterModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("\t")) continue;
    const [rawId, ...rest] = line.split("\t");
    const id = rawId!.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: rest.join("\t").trim() || id });
  }
  return models;
}

function runAgyModels(command: string, home: string | null): ReturnType<AntigravityModelsRunner> {
  return new Promise((resolve) => {
    const env = { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb", ...(home ? { HOME: home } : {}) };
    const child = spawn(command, ["models"], { env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), MODELS_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

let runner: AntigravityModelsRunner | null = null;

/** Profiles worth asking, most likely signed in first. */
async function candidateHomes(): Promise<Array<string | null>> {
  const homes: Array<string | null> = [];
  const own = process.env.HOME?.trim();
  if (own && (await hasAntigravityToken(own))) homes.push(own);
  for (const home of await discoverAccountHomes(resolveAccountsBase())) {
    if (!homes.includes(home)) homes.push(home);
  }
  if (homes.length === 0) homes.push(null);
  return homes;
}

async function discover(): Promise<AdapterModel[]> {
  const run = runner ?? ((home) => runAgyModels("agy", home));
  for (const home of await candidateHomes()) {
    const result = await run(home);
    if (result.code !== 0) continue;
    const models = parseAntigravityModels(result.stdout);
    if (models.length > 0) return models;
  }
  return [];
}

function mergeWithFallback(models: AdapterModel[]): AdapterModel[] {
  return models.length > 0 ? models : fallbackModels.map((model) => ({ ...model }));
}

export async function listAntigravityModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;
  const discovered = await discover();
  if (discovered.length > 0) {
    cached = { expiresAt: now + MODELS_CACHE_TTL_MS, models: discovered };
    return discovered;
  }
  return cached?.models ?? mergeWithFallback([]);
}

export async function refreshAntigravityModels(): Promise<AdapterModel[]> {
  cached = null;
  return listAntigravityModels();
}

export function setAntigravityModelsRunnerForTests(next: AntigravityModelsRunner | null): void {
  runner = next;
  cached = null;
}

