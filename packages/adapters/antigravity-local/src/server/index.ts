import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { listAntigravitySkills, syncAntigravitySkills } from "./skills.js";
export { listAntigravityModels, refreshAntigravityModels, parseAntigravityModels } from "./models.js";
export {
  discoverAccountHomes,
  orderAccountCandidates,
  resolveAccountPool,
  resolveAccountsBase,
  ANTIGRAVITY_TOKEN_REL,
} from "./accounts.js";
export { testEnvironment } from "./test.js";
export {
  parseAntigravityStream,
  parseAntigravityJson,
  detectAntigravityAuthRequired,
  describeAntigravityFailure,
  isAntigravityQuotaExhausted,
  isAntigravitySessionUnrecoverableError,
} from "./parse.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSessionId(record: Record<string, unknown>): string | null {
  return (
    readNonEmptyString(record.sessionId) ??
    readNonEmptyString(record.session_id) ??
    readNonEmptyString(record.conversationId) ??
    readNonEmptyString(record.conversation_id)
  );
}

function pickSessionFields(record: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  const cwd = readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir);
  const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
  const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
  const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readSessionId(record);
    return sessionId ? pickSessionFields(record, sessionId) : null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readSessionId(params);
    return sessionId ? pickSessionFields(params, sessionId) : null;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return params ? readSessionId(params) : null;
  },
};
