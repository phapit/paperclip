import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printAntigravityStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    console.log(line);
    return;
  }

  const event = asString(parsed.event);
  if (event === "init") {
    console.log(pc.blue(`Antigravity conversation: ${asString(parsed.conversation_id, "unknown")}`));
    return;
  }
  if (event === "step_update") {
    const step = asRecord(parsed.step_update) ?? {};
    const stepType = asString(step.step_type);
    const state = asString(step.state);
    if (stepType === "agent_response") {
      const text = asString(step.text_delta);
      if (text) process.stdout.write(pc.green(text));
      return;
    }
    if (stepType === "tool") {
      const info = asRecord(step.tool_info) ?? {};
      const name = asString(step.tool_name) || asString(info.name, "tool");
      if (state === "ACTIVE") {
        console.log(pc.yellow(`\ntool_call: ${name}`));
        console.log(pc.gray(JSON.stringify(info.parameters ?? {}, null, 2)));
      } else if (state === "DONE") {
        const output = info.output;
        console.log(pc.cyan(`tool_result: ${typeof output === "string" ? output : JSON.stringify(output ?? "")}`));
      }
    }
    return;
  }
  if (event === "result") {
    const result = asRecord(parsed.result) ?? {};
    const status = asString(result.status, "unknown");
    const usage = asRecord(result.usage) ?? {};
    const color = status === "SUCCESS" ? pc.green : pc.red;
    console.log(color(`\nresult: ${status}`));
    console.log(pc.blue(`tokens: in=${String(usage.input_tokens ?? 0)} out=${String(usage.output_tokens ?? 0)}`));
    return;
  }
  if (_debug) console.log(pc.gray(line));
}
