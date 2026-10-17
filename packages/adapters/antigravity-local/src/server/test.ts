import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, asStringArray, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { hasAntigravityToken, resolveAccountPool } from "./accounts.js";
import { detectAntigravityAuthRequired, isAntigravityQuotaExhausted, parseAntigravityJson } from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function clip(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const target = ctx.executionTarget ?? null;
  const done = (): AdapterEnvironmentTestResult => ({
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  });

  const targetIsRemote = target?.kind === "remote";
  if (targetIsRemote) {
    checks.push({
      code: "antigravity_environment_target",
      level: "info",
      message: `Probing inside environment: ${ctx.environmentName ?? describeAdapterExecutionTarget(target)}`,
    });
  }

  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `antigravity-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, { cwd, env: {}, createIfMissing: true });
    checks.push({ code: "antigravity_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "antigravity_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseObject(config.env))) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "antigravity",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({ code: "antigravity_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "antigravity_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install the Antigravity CLI (agy) on the machine that runs Paperclip, or set `command` to its absolute path.",
    });
  }
  if (checks.some((check) => check.level === "error")) return done();

  const accountPool = targetIsRemote ? [] : await resolveAccountPool(config, env);
  if (accountPool.length > 0) {
    const signedIn: string[] = [];
    for (const home of accountPool) {
      if (await hasAntigravityToken(home)) signedIn.push(home);
      else {
        checks.push({
          code: "antigravity_pool_member_not_signed_in",
          level: "warn",
          message: `Account pool profile is not signed in: ${home}`,
          hint: "Run `agy` interactively with that HOME and sign in (see docker/antigravity-login.sh).",
        });
      }
    }
    checks.push({
      code: "antigravity_account_pool",
      level: signedIn.length > 0 ? "info" : "error",
      message: `Account pool: ${signedIn.length}/${accountPool.length} profile(s) signed in; rotation on quota errors is enabled.`,
    });
    if (signedIn.length === 0) return done();
    env.HOME = signedIn[0]!;
  } else if (env.HOME) {
    checks.push({
      code: "antigravity_profile_home",
      level: "info",
      message: `Using isolated profile HOME=${env.HOME}.`,
    });
  } else {
    checks.push({
      code: "antigravity_profile_default",
      level: "info",
      message: targetIsRemote
        ? "No HOME override: the remote environment's default Antigravity profile is used."
        : "No HOME override: this agent uses the server user's default Antigravity profile.",
      hint: "Set HOME (for example /paperclip/antigravity-accounts/acc1) in the agent env to give it its own profile.",
    });
  }

  const version = await runAdapterExecutionTargetProcess(runId, target, command, ["--version"], {
    cwd, env, timeoutSec: 15, graceSec: 5, onLog: async () => {},
  });
  const versionLine = firstNonEmptyLine(version.stdout) || firstNonEmptyLine(version.stderr);
  if (!version.timedOut && (version.exitCode ?? 1) === 0) {
    checks.push({
      code: "antigravity_version_detected",
      level: "info",
      message: `Antigravity CLI detected${versionLine ? `: ${clip(versionLine, 120)}` : "."}`,
    });
  } else {
    checks.push({
      code: "antigravity_version_probe_failed",
      level: "warn",
      message: "`agy --version` did not exit cleanly.",
      ...(versionLine ? { detail: versionLine } : {}),
    });
  }

  const model = asString(config.model, "").trim();
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    return fromExtraArgs.length > 0 ? fromExtraArgs : asStringArray(config.args);
  })();
  const args = ["--output-format", "json", "--dangerously-skip-permissions"];
  if (model) args.push("--model", model);
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push("-p", "Respond with hello.");
  const probe = await runAdapterExecutionTargetProcess(runId, target, command, args, {
    cwd,
    env,
    timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 90)),
    graceSec: 5,
    onLog: async () => {},
  });
  const parsed = parseAntigravityJson(probe.stdout);
  const detail = clip(parsed.errorMessage || firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout));
  const authMeta = detectAntigravityAuthRequired({ stdout: probe.stdout, stderr: probe.stderr });

  if (probe.timedOut) {
    checks.push({
      code: "antigravity_hello_probe_timed_out",
      level: "warn",
      message: "Antigravity hello probe timed out.",
      hint: "If agy is waiting for sign-in, run `agy` interactively once with the same HOME and sign in.",
    });
  } else if ((probe.exitCode ?? 1) === 0 && parsed.status === "SUCCESS") {
    const hasHello = /\bhello\b/i.test(parsed.summary);
    checks.push({
      code: hasHello ? "antigravity_hello_probe_passed" : "antigravity_hello_probe_unexpected_output",
      level: hasHello ? "info" : "warn",
      message: hasHello
        ? "Antigravity hello probe succeeded."
        : "Antigravity probe ran but did not return `hello` as expected.",
      ...(parsed.summary ? { detail: clip(parsed.summary) } : {}),
    });
  } else if (authMeta.requiresAuth) {
    checks.push({
      code: "antigravity_hello_probe_auth_required",
      level: "warn",
      message: "Antigravity CLI is installed, but this profile is not signed in.",
      ...(detail ? { detail } : {}),
      hint: "Run `agy` interactively with the same HOME and sign in with your Google account.",
    });
  } else if (isAntigravityQuotaExhausted(probe.stdout, probe.stderr)) {
    checks.push({
      code: "antigravity_hello_probe_quota",
      level: "warn",
      message: "Antigravity is signed in, but the account is over quota.",
      ...(detail ? { detail } : {}),
    });
  } else {
    checks.push({
      code: "antigravity_hello_probe_failed",
      level: "error",
      message: "Antigravity hello probe failed.",
      ...(detail ? { detail } : {}),
      hint: "Run `agy -p \"Respond with hello.\" --output-format json` manually in this working directory.",
    });
  }
  return done();
}
