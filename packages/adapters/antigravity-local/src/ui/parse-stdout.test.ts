import { describe, expect, it } from "vitest";
import { parseAntigravityStdoutLine } from "./parse-stdout.js";
import { buildAntigravityLocalConfig } from "./build-config.js";

const ts = "2026-10-16T00:00:00.000Z";

describe("parseAntigravityStdoutLine", () => {
  it("maps init, text deltas, tool calls and results", () => {
    expect(parseAntigravityStdoutLine(JSON.stringify({ event: "init", conversation_id: "c1" }), ts)).toEqual([
      { kind: "init", ts, model: "antigravity", sessionId: "c1" },
    ]);
    expect(
      parseAntigravityStdoutLine(
        JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Hi" } }),
        ts,
      ),
    ).toEqual([{ kind: "assistant", ts, text: "Hi", delta: true }]);
    expect(
      parseAntigravityStdoutLine(
        JSON.stringify({ event: "step_update", step_update: { step_index: 2, step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls" } } } }),
        ts,
      ),
    ).toEqual([{ kind: "tool_call", ts, name: "run_command", input: { CommandLine: "ls" }, toolUseId: "step-2" }]);
    expect(
      parseAntigravityStdoutLine(
        JSON.stringify({ event: "step_update", step_update: { step_index: 2, step_type: "tool", state: "DONE", tool_name: "run_command", tool_info: { output: "a\n" } } }),
        ts,
      ),
    ).toEqual([{ kind: "tool_result", ts, toolUseId: "step-2", toolName: "run_command", content: "a\n", isError: false }]);
  });

  it("maps the result event and flags failures", () => {
    const ok = parseAntigravityStdoutLine(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done", usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 1 } } }),
      ts,
    );
    expect(ok[0]).toMatchObject({ kind: "result", text: "done", inputTokens: 5, outputTokens: 2, cachedTokens: 1, isError: false });
    const bad = parseAntigravityStdoutLine(JSON.stringify({ event: "result", result: { status: "FAILED" } }), ts);
    expect(bad[0]).toMatchObject({ kind: "result", isError: true });
  });

  it("passes plain text through as stdout", () => {
    expect(parseAntigravityStdoutLine("plain text", ts)).toEqual([{ kind: "stdout", ts, text: "plain text" }]);
    expect(parseAntigravityStdoutLine("   ", ts)).toEqual([]);
  });
});

describe("buildAntigravityLocalConfig", () => {
  it("builds a config with env, model and defaults", () => {
    const config = buildAntigravityLocalConfig({
      cwd: "/work",
      model: "gemini-3.8-flash-medium",
      envVars: "HOME=/paperclip/antigravity-accounts/acc1\n# c\nBAD KEY=1",
      envBindings: {},
      command: "",
      extraArgs: "--mode, auto",
    } as never);
    expect(config).toMatchObject({
      cwd: "/work",
      model: "gemini-3.8-flash-medium",
      timeoutSec: 0,
      graceSec: 15,
      env: { HOME: { type: "plain", value: "/paperclip/antigravity-accounts/acc1" } },
      extraArgs: ["--mode", "auto"],
    });
  });
});
