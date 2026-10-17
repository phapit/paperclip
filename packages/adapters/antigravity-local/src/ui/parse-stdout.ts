import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Map one `agy -p ... --output-format stream-json` stdout line to transcript
 * entries. Shapes verified against agy 1.3.5 (init, step_update, result).
 */
export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    parsed = null;
  }
  if (!parsed) return line.trim() ? [{ kind: "stdout", ts, text: line }] : [];

  const event = asString(parsed.event);
  if (event === "init") {
    return [{
      kind: "init",
      ts,
      model: "antigravity",
      sessionId: asString(parsed.conversation_id),
    }];
  }

  if (event === "step_update") {
    const step = asRecord(parsed.step_update) ?? {};
    const stepType = asString(step.step_type);
    const state = asString(step.state);
    if (stepType === "agent_response") {
      const text = asString(step.text_delta);
      return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
    }
    if (stepType === "tool") {
      const info = asRecord(step.tool_info) ?? {};
      const name = asString(step.tool_name) || asString(info.name, "tool");
      const toolUseId = `step-${String(step.step_index ?? "")}`;
      if (state === "ACTIVE") {
        return [{ kind: "tool_call", ts, name, input: info.parameters ?? {}, toolUseId }];
      }
      if (state === "DONE") {
        const output = info.output;
        return [{
          kind: "tool_result",
          ts,
          toolUseId,
          toolName: name,
          content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
          isError: false,
        }];
      }
    }
    return [];
  }

  if (event === "result") {
    const result = asRecord(parsed.result) ?? {};
    const usage = asRecord(result.usage) ?? {};
    const status = asString(result.status);
    const isError = status !== "" && status !== "SUCCESS";
    return [{
      kind: "result",
      ts,
      text: asString(result.response),
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cachedTokens: asNumber(usage.cache_read_tokens),
      costUsd: 0,
      subtype: status || "result",
      isError,
      errors: isError ? [`Antigravity run finished with status ${status}`] : [],
    }];
  }

  return [];
}
