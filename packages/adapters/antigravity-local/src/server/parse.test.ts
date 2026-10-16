import { describe, expect, it } from "vitest";
import {
  describeAntigravityFailure,
  detectAntigravityAuthRequired,
  isAntigravitySessionUnrecoverableError,
  parseAntigravityJson,
  parseAntigravityStream,
} from "./parse.js";

const CONVERSATION = "98b525df-b45a-462b-acb9-72fdba861148";

const TOOL_RUN = [
  { event: "init", conversation_id: CONVERSATION, init: { cwd: "/tmp/agytest", tools: ["run_command"], permission_mode: "always-proceed" } },
  { event: "step_update", step_update: { conversation_id: CONVERSATION, step_index: 0, state: "DONE", step_type: "user_input" } },
  { event: "step_update", step_update: { conversation_id: CONVERSATION, step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "cat a.txt" } } } },
  { event: "step_update", step_update: { conversation_id: CONVERSATION, step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "cat a.txt" }, output: "hello\r\n" } } },
  { event: "step_update", step_update: { conversation_id: CONVERSATION, step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "The file says " } },
  { event: "step_update", step_update: { conversation_id: CONVERSATION, step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "hello" } },
  { event: "result", result: { conversation_id: CONVERSATION, status: "SUCCESS", response: "The file says hello\n", duration_seconds: 4.7, num_turns: 1, usage: { input_tokens: 26225, output_tokens: 164, thinking_tokens: 76, cache_read_tokens: 10, total_tokens: 26389 } } },
]
  .map((event) => JSON.stringify(event))
  .join("\n");

describe("parseAntigravityStream", () => {
  it("extracts session, summary, usage and tool activity", () => {
    const parsed = parseAntigravityStream(TOOL_RUN);
    expect(parsed.sessionId).toBe(CONVERSATION);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.summary).toBe("The file says hello");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.usage).toEqual({ inputTokens: 26225, outputTokens: 164, cachedInputTokens: 10, thinkingTokens: 76 });
    expect(parsed.toolCalls).toEqual([
      { id: "step-2", name: "run_command", arguments: { CommandLine: "cat a.txt" } },
    ]);
    expect(parsed.toolResults).toEqual([
      { toolCallId: "step-2", name: "run_command", content: "hello\r\n" },
    ]);
  });

  it("falls back to streamed text when no result event arrives", () => {
    const stdout = [
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Hi " } }),
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", state: "DONE", text_delta: "there" } }),
    ].join("\n");
    expect(parseAntigravityStream(stdout).summary).toBe("Hi there");
  });

  it("reports a non-success status as an error", () => {
    const stdout = JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "FAILED", response: "" } });
    expect(parseAntigravityStream(stdout).errorMessage).toContain("FAILED");
  });

  it("ignores non-JSON noise", () => {
    expect(parseAntigravityStream("warning: something\nnot json").summary).toBe("");
  });
});

describe("parseAntigravityJson", () => {
  it("parses the single-object json output", () => {
    const stdout = JSON.stringify({
      conversation_id: "abc",
      status: "SUCCESS",
      response: "ok\n",
      usage: { input_tokens: 13004, output_tokens: 24, thinking_tokens: 23, cache_read_tokens: 0, total_tokens: 13028 },
    });
    const parsed = parseAntigravityJson(stdout);
    expect(parsed.sessionId).toBe("abc");
    expect(parsed.summary).toBe("ok");
    expect(parsed.usage?.inputTokens).toBe(13004);
  });
});

describe("failure detection", () => {
  it("detects missing sign-in", () => {
    expect(detectAntigravityAuthRequired({ stdout: "", stderr: "error getting token source: You are not logged into Antigravity." }).requiresAuth).toBe(true);
    expect(detectAntigravityAuthRequired({ stdout: "fine", stderr: "" }).requiresAuth).toBe(false);
  });

  it("detects an unrecoverable conversation", () => {
    expect(isAntigravitySessionUnrecoverableError("", "could not find conversation abc")).toBe(true);
    expect(isAntigravitySessionUnrecoverableError("", "network down")).toBe(false);
  });

  it("describes failures preferring the parsed message", () => {
    expect(describeAntigravityFailure({ errorMessage: " boom ", stderr: "other" })).toBe("boom");
    expect(describeAntigravityFailure({ errorMessage: null, stderr: "\n first line\nsecond" })).toBe("first line");
    expect(describeAntigravityFailure({ errorMessage: null, stderr: "" })).toBeNull();
  });
});
