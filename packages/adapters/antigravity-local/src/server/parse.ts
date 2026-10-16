import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export interface ParsedAntigravityToolCall {
  id: string | null;
  name: string;
  arguments: unknown;
}

export interface ParsedAntigravityToolResult {
  toolCallId: string | null;
  name: string | null;
  content: string;
}

export interface AntigravityUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  thinkingTokens: number;
}

export interface ParsedAntigravityStream {
  sessionId: string | null;
  summary: string;
  status: string | null;
  usage: AntigravityUsage | null;
  toolCalls: ParsedAntigravityToolCall[];
  toolResults: ParsedAntigravityToolResult[];
  errorMessage: string | null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readAntigravityUsage(value: unknown): AntigravityUsage | null {
  const rec = parseObject(value);
  if (Object.keys(rec).length === 0) return null;
  return {
    inputTokens: numberOf(rec.input_tokens),
    outputTokens: numberOf(rec.output_tokens),
    cachedInputTokens: numberOf(rec.cache_read_tokens),
    thinkingTokens: numberOf(rec.thinking_tokens),
  };
}

/**
 * Parse `agy -p ... --output-format stream-json` stdout.
 *
 * Verified event shapes (agy 1.3.5), one JSON object per line:
 * - {"event":"init","conversation_id":"...","init":{"cwd","tools","permission_mode"}}
 * - {"event":"step_update","step_update":{"step_type":"agent_response","state":"ACTIVE|DONE","text_delta":"..."}}
 * - {"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE|DONE","tool_name","tool_info":{"name","parameters","output"}}}
 * - {"event":"result","result":{"conversation_id","status","response","duration_seconds","num_turns","usage"}}
 */
export function parseAntigravityStream(stdout: string): ParsedAntigravityStream {
  let sessionId: string | null = null;
  let summary = "";
  let streamed = "";
  let status: string | null = null;
  let usage: AntigravityUsage | null = null;
  let errorMessage: string | null = null;
  const toolCalls: ParsedAntigravityToolCall[] = [];
  const toolResults: ParsedAntigravityToolResult[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const event = parseJsonLine(line);
    if (!event) continue;
    const kind = asString(event.event, "");

    if (kind === "init") {
      sessionId = asString(event.conversation_id, "") || sessionId;
      continue;
    }

    if (kind === "step_update") {
      const step = parseObject(event.step_update);
      sessionId = asString(step.conversation_id, "") || sessionId;
      const stepType = asString(step.step_type, "");
      const state = asString(step.state, "");
      if (stepType === "agent_response") {
        streamed += asString(step.text_delta, "");
      } else if (stepType === "tool") {
        const info = parseObject(step.tool_info);
        const name = asString(step.tool_name, "") || asString(info.name, "tool");
        const id = `step-${String(step.step_index ?? toolCalls.length)}`;
        if (state === "ACTIVE") {
          toolCalls.push({ id, name, arguments: info.parameters ?? {} });
        } else if (state === "DONE") {
          if (!toolCalls.some((call) => call.id === id)) {
            toolCalls.push({ id, name, arguments: info.parameters ?? {} });
          }
          toolResults.push({
            toolCallId: id,
            name,
            content: typeof info.output === "string" ? info.output : JSON.stringify(info.output ?? ""),
          });
        }
      }
      continue;
    }

    if (kind === "result") {
      const result = parseObject(event.result);
      sessionId = asString(result.conversation_id, "") || sessionId;
      status = asString(result.status, "") || status;
      summary = asString(result.response, "").trim() || summary;
      usage = readAntigravityUsage(result.usage) ?? usage;
      const err = asString(result.error, "") || asString(result.error_message, "");
      if (err) errorMessage = err;
      continue;
    }

    if (kind === "error") {
      errorMessage =
        asString(event.message, "") || asString(parseObject(event.error).message, "") || errorMessage;
    }
  }

  if (!summary) summary = streamed.trim();
  if (status && status !== "SUCCESS" && !errorMessage) {
    errorMessage = `Antigravity run finished with status ${status}`;
  }
  return { sessionId, summary, status, usage, toolCalls, toolResults, errorMessage };
}

/** Parse the single object printed by `--output-format json`. */
export function parseAntigravityJson(stdout: string): ParsedAntigravityStream {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const obj = parseJsonLine(lines[i]!);
    if (obj && "status" in obj && "conversation_id" in obj) {
      return parseAntigravityStream(JSON.stringify({ event: "result", result: obj }));
    }
  }
  return parseAntigravityStream(stdout);
}

const AUTH_PATTERNS = [
  /not logged into antigravity/i,
  /you are not logged in/i,
  /not signed in/i,
  /authentication required/i,
  /please visit the url to log in/i,
  /please (?:log|sign) ?in/i,
  /\b401\b.*unauthenticated/i,
  /permission_denied|unauthenticated/i,
];

export function detectAntigravityAuthRequired(input: { stdout: string; stderr: string }): {
  requiresAuth: boolean;
} {
  const text = `${input.stdout}\n${input.stderr}`;
  return { requiresAuth: AUTH_PATTERNS.some((pattern) => pattern.test(text)) };
}

export function isAntigravityQuotaExhausted(stdout: string, stderr: string): boolean {
  return /quota|rate.?limit|resource_exhausted|429|exhausted/i.test(`${stdout}\n${stderr}`);
}

export function isAntigravitySessionUnrecoverableError(stdout: string, stderr: string): boolean {
  return /conversation .*(not found|does not exist)|could not find conversation|failed to load conversation/i.test(
    `${stdout}\n${stderr}`,
  );
}

export function describeAntigravityFailure(input: {
  errorMessage: string | null;
  stderr: string;
}): string | null {
  const message = input.errorMessage?.trim();
  if (message) return message;
  const line = input.stderr
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? null;
}
