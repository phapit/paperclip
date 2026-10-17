import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAccountCooldownsForTests } from "./accounts.js";
import { execute } from "./execute.js";

let dir: string;
let fakeAgy: string;
let callLog: string;

const SUCCESS = JSON.stringify({ event: "result", result: { conversation_id: "conv-ok", status: "SUCCESS", response: "done", usage: { input_tokens: 3, output_tokens: 2 } } });
const QUOTA = JSON.stringify({ event: "result", result: { conversation_id: "conv-bad", status: "FAILED", response: "", error: "RESOURCE_EXHAUSTED: quota exceeded" } });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-rotation-"));
  callLog = path.join(dir, "calls.log");
  fakeAgy = path.join(dir, "agy");
  // Fake agy: profile "exhausted-*" is out of quota, everything else succeeds.
  await fs.writeFile(
    fakeAgy,
    `#!/usr/bin/env bash
args="$*"; echo "$HOME|\${args%% -p *}" >> ${JSON.stringify(callLog)}
case "$HOME" in
  *exhausted*) echo '${QUOTA}'; exit 1 ;;
  *) echo '${SUCCESS}'; exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  resetAccountCooldownsForTests();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeCtx(config: Record<string, unknown>, runtime: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: { id: "a1", companyId: "c1", name: "T", adapterType: "antigravity_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null, ...runtime },
    config: { command: fakeAgy, cwd: dir, promptTemplate: "hi", timeoutSec: 30, ...config },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  } as never;
}

async function calls(): Promise<string[]> {
  return (await fs.readFile(callLog, "utf8")).trim().split("\n");
}

describe("execute account rotation", () => {
  it("switches to the next profile when the first is out of quota", async () => {
    const result = await execute(makeCtx({ accountHomes: [path.join(dir, "exhausted-1"), path.join(dir, "good-2")] }));
    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("conv-ok");
    expect(result.sessionParams).toMatchObject({ accountHome: path.join(dir, "good-2") });
    const log = await calls();
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("exhausted-1");
    expect(log[1]).toContain("good-2");
  });

  it("skips a profile that is cooling down on the next run", async () => {
    const pool = [path.join(dir, "exhausted-1"), path.join(dir, "good-2")];
    await execute(makeCtx({ accountHomes: pool }));
    await fs.rm(callLog);
    await execute(makeCtx({ accountHomes: pool }));
    const log = await calls();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("good-2");
  });

  it("resumes the conversation only inside the profile that owns it", async () => {
    const good = path.join(dir, "good-2");
    await execute(
      makeCtx(
        { accountHomes: [path.join(dir, "exhausted-1"), good] },
        { sessionId: "conv-ok", sessionParams: { sessionId: "conv-ok", cwd: dir, accountHome: good } },
      ),
    );
    const log = await calls();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("good-2");
    expect(log[0]).toContain("--conversation conv-ok");
  });

  it("reports quota exhaustion when every profile is out", async () => {
    const result = await execute(
      makeCtx({ accountHomes: [path.join(dir, "exhausted-1"), path.join(dir, "exhausted-2")] }),
    );
    expect(result.errorCode).toBe("antigravity_quota_exhausted");
    expect(result.errorMessage).toContain("All 2 Antigravity account(s) are out of quota");
    expect(await calls()).toHaveLength(2);
  });

  it("behaves as a single profile without accountHomes", async () => {
    const result = await execute(makeCtx({ env: { HOME: path.join(dir, "exhausted-solo") } }));
    expect(result.errorCode).toBe("antigravity_quota_exhausted");
    expect(await calls()).toHaveLength(1);
  });
});
