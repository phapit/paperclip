import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
} from "@paperclipai/adapter-utils/execution-target";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import {
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  isPaperclipSkillSourceMissing,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  DEFAULT_QUOTA_COOLDOWN_MIN,
  isAccountCoolingDown,
  markAccountCooldown,
  orderAccountCandidates,
  resolveAccountPool,
} from "./accounts.js";
import { antigravitySkillsHomeFor, installAntigravitySkills } from "./skills.js";
import {
  describeAntigravityFailure,
  detectAntigravityAuthRequired,
  isAntigravityQuotaExhausted,
  isAntigravitySessionUnrecoverableError,
  parseAntigravityStream,
} from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

/** Headless-safe environment: no colors, no TTY assumptions. User values win. */
function buildAntigravityHeadlessEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  if (!next.CI?.trim()) next.CI = "1";
  if (!next.NO_COLOR?.trim()) next.NO_COLOR = "1";
  if (!next.TERM?.trim()) next.TERM = "dumb";
  return next;
}

function buildAntigravityRuntimeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...buildAntigravityHeadlessEnv(env) })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const keys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (keys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${keys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

function readTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type AttemptResult = {
  proc: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
  parsed: ReturnType<typeof parseAntigravityStream>;
  home: string | null;
  resumed: boolean;
};

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "agy");
  const model = asString(config.model, "").trim();
  const effort = asString(config.effort, "").trim().toLowerCase();
  const quotaCooldownMin = Math.max(1, asNumber(config.quotaCooldownMin, DEFAULT_QUOTA_COOLDOWN_MIN));

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const envConfig = parseObject(config.env);

  const hasExplicitApiKey = readTrimmed(envConfig.PAPERCLIP_API_KEY).length > 0;
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId = readTrimmed(context.taskId) || readTrimmed(context.issueId) || null;
  const wakeReason = readTrimmed(context.wakeReason) || null;
  const wakeCommentId = readTrimmed(context.wakeCommentId) || readTrimmed(context.commentId) || null;
  const approvalId = readTrimmed(context.approvalId) || null;
  const approvalStatus = readTrimmed(context.approvalStatus) || null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  const refreshWorkspaceEnv = () =>
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
      executionTargetIsRemote,
      executionCwd: effectiveExecutionCwd,
    });
  refreshWorkspaceEnv();
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;
  // User-configured env (HOME, AGY_ACCOUNT, GOOGLE_APPLICATION_CREDENTIALS, ...) selects the profile.
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(executionTarget, asNumber(config.timeoutSec, 0));
  const graceSec = asNumber(config.graceSec, 20);
  const runtimeEnv = buildAntigravityRuntimeEnv(env);
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    return fromExtraArgs.length > 0 ? fromExtraArgs : asStringArray(config.args);
  })();

  // Account pool (local only): profile HOMEs to rotate through on quota errors.
  const accountPool = executionTargetIsRemote ? [] : await resolveAccountPool(config, env);

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, skillEntries);
  const desiredSkillEntries = skillEntries.filter(
    (entry) => desiredSkillNames.includes(entry.key) && !isPaperclipSkillSourceMissing(entry),
  );

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let localSkillsStageDir: string | null = null;
  let remoteSkillsAssetDir: string | null = null;
  let managedRemoteHomeDir: string | null = null;
  const cleanupTasks: Array<() => Promise<unknown>> = [];

  if (executionTargetIsRemote) {
    try {
      if (desiredSkillEntries.length > 0) {
        localSkillsStageDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-skills-"));
        const stage = path.join(localSkillsStageDir, "skills");
        await fs.mkdir(stage, { recursive: true });
        for (const entry of desiredSkillEntries) {
          await fs.symlink(entry.source, path.join(stage, entry.runtimeName));
        }
        localSkillsStageDir = stage;
      }
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and Antigravity runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const prepared = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "antigravity",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: localSkillsStageDir
          ? [{ key: "skills", localDir: localSkillsStageDir, followSymlinks: true }]
          : [],
      });
      restoreRemoteWorkspace = () => prepared.restoreWorkspace((line) => onLog("stdout", line));
      effectiveExecutionCwd = prepared.workspaceRemoteDir ?? effectiveExecutionCwd;
      refreshWorkspaceEnv();
      if (adapterExecutionTargetUsesManagedHome(executionTarget) && prepared.runtimeRootDir) {
        managedRemoteHomeDir = prepared.runtimeRootDir;
        env.HOME = managedRemoteHomeDir;
      }
      remoteSkillsAssetDir = prepared.assetDirs.skills ?? null;
    } catch (error) {
      await Promise.allSettled([
        restoreRemoteWorkspace?.(),
        localSkillsStageDir
          ? fs.rm(path.dirname(localSkillsStageDir), { recursive: true, force: true }).catch(() => undefined)
          : Promise.resolve(),
      ]);
      throw error;
    }
  }
  if (localSkillsStageDir) {
    const stageParent = path.dirname(localSkillsStageDir);
    cleanupTasks.push(() => fs.rm(stageParent, { recursive: true, force: true }).catch(() => undefined));
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);

  // Deliver desired skills into the profile's global skills root, which agy discovers.
  const deliverSkillsLocal = async (home: string | null) => {
    if (desiredSkillEntries.length === 0) return;
    try {
      await installAntigravitySkills(config, antigravitySkillsHomeFor(home ?? env.HOME ?? os.homedir()));
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to prepare Antigravity skills: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };
  if (executionTargetIsRemote && remoteSkillsAssetDir && desiredSkillEntries.length > 0) {
    const homeExpr = managedRemoteHomeDir ? JSON.stringify(managedRemoteHomeDir) : '"$HOME"';
    const assets = JSON.stringify(remoteSkillsAssetDir);
    await runAdapterExecutionTargetShellCommand(
      runId,
      runtimeExecutionTarget,
      `ROOT=${homeExpr}/.gemini/config/skills; mkdir -p "$ROOT" && for d in ${assets}/*; do [ -e "$d" ] || continue; rm -rf "$ROOT/$(basename "$d")"; cp -a "$d" "$ROOT/"; done`,
      { cwd, env, timeoutSec, graceSec, onLog },
    );
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeSessionHome = asString(runtimeSessionParams.accountHome, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Antigravity conversation "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const contents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const commandNotes: string[] = [
    "Prompt is passed to agy via -p for non-interactive execution.",
    "Added --output-format stream-json and --dangerously-skip-permissions for unattended runs.",
  ];
  if (accountPool.length > 0) {
    commandNotes.push(`Account pool of ${accountPool.length} profile(s); rotates on quota errors (cooldown ${quotaCooldownMin} min).`);
  } else if (hasNonEmptyEnvValue(env, "HOME")) {
    commandNotes.push(`Using profile HOME=${env.HOME}.`);
  }
  if (desiredSkillEntries.length > 0) {
    commandNotes.push(`Delivering ${desiredSkillEntries.length} Paperclip skill(s) to <HOME>/.gemini/config/skills.`);
  }
  if (!executionTargetIsRemote && instructionsFilePath) {
    commandNotes.push(`Added --add-dir ${path.dirname(instructionsFilePath)} for sibling instruction files.`);
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);

  const buildArgs = (resumeSessionId: string | null, prompt: string) => {
    const args = ["--output-format", "stream-json", "--dangerously-skip-permissions"];
    if (resumeSessionId) args.push("--conversation", resumeSessionId);
    if (model) args.push("--model", model);
    if (EFFORTS.has(effort)) args.push("--effort", effort);
    if (!executionTargetIsRemote && instructionsFilePath) args.push("--add-dir", path.dirname(instructionsFilePath));
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("-p", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null, home: string | null): Promise<AttemptResult> => {
    await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeSessionId) });
    const sections = selectPaperclipPromptSections(context, {
      resumedSession: Boolean(resumeSessionId),
      includeCommunicationGuidance: false,
    });
    const bootstrapPrompt = !resumeSessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
    const renderedPrompt =
      (Boolean(resumeSessionId) && sections.wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData);
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeSessionId) }),
      joinPromptSections([
        instructionsPrefix,
        bootstrapPrompt,
        sections.wakePrompt,
        sections.taskContextNote,
        sessionHandoffNote,
        paperclipEnvNote,
        apiAccessNote,
        renderedPrompt,
      ]),
    ]);
    const args = buildArgs(resumeSessionId, prompt);
    const invocationEnv = buildAntigravityHeadlessEnv(home ? { ...env, HOME: home } : env);
    if (onMeta) {
      await onMeta({
        adapterType: "antigravity_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes,
        commandArgs: args.map((value, index) => (index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value)),
        env: buildInvocationEnvForLogs(invocationEnv, {
          runtimeEnv: buildAntigravityRuntimeEnv(invocationEnv),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        }),
        prompt,
        promptMetrics: {
          promptChars: prompt.length,
          instructionsChars: instructionsPrefix.length,
          bootstrapPromptChars: bootstrapPrompt.length,
          wakePromptChars: sections.wakePrompt.length,
          taskContextChars: sections.taskContextNote.length,
          sessionHandoffChars: sessionHandoffNote.length,
          runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
          heartbeatPromptChars: renderedPrompt.length,
        },
        context,
      });
    }
    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      onProcessStopped: providerStop.beginInvocation(),
      cwd,
      env: invocationEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog,
    });
    return { proc, parsed: parseAntigravityStream(proc.stdout), home, resumed: Boolean(resumeSessionId) };
  };

  const toResult = (attempt: AttemptResult, clearSessionOnMissingSession = false): AdapterExecutionResult => {
    const { proc, parsed } = attempt;
    const authMeta = detectAntigravityAuthRequired({ stdout: proc.stdout, stderr: proc.stderr });
    const quota = isAntigravityQuotaExhausted(proc.stdout, proc.stderr);
    const usage = parsed.usage
      ? {
          inputTokens: parsed.usage.inputTokens,
          outputTokens: parsed.usage.outputTokens,
          cachedInputTokens: parsed.usage.cachedInputTokens,
        }
      : undefined;
    const base = {
      usageComplete: true,
      costStatus: "unpriced" as const,
      usageBasis: "per_run" as const,
      provider: "google",
      biller: "google",
      model: model || null,
      billingType: "subscription" as const,
      costUsd: null,
      ...(usage ? { usage } : {}),
    };
    if (proc.timedOut) {
      return {
        ...base,
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth ? "antigravity_auth_required" : null,
        clearSession: clearSessionOnMissingSession,
      };
    }
    const failedByStatus = Boolean(parsed.status && parsed.status !== "SUCCESS");
    const failed = proc.exitCode === null || proc.exitCode !== 0 || failedByStatus;
    const message =
      describeAntigravityFailure({ errorMessage: parsed.errorMessage, stderr: proc.stderr }) ||
      firstNonEmptyLine(proc.stdout) ||
      (proc.signal
        ? `Antigravity was terminated by signal ${proc.signal}`
        : `Antigravity exited with code ${proc.exitCode ?? -1}`);
    // Only fall back to the saved conversation when this attempt actually resumed it.
    const resolvedSessionId = parsed.sessionId ?? (attempt.resumed ? (runtimeSessionId || runtime.sessionId || null) : null);
    const accountHome = attempt.home ?? (runtimeSessionHome || null);
    const sessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd: effectiveExecutionCwd,
          ...(accountHome && accountPool.length > 0 ? { accountHome } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(executionTargetIsRemote
            ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget) }
            : {}),
        } as Record<string, unknown>)
      : null;
    return {
      ...base,
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: failed ? message : null,
      errorCode: proc.errorCode
        ? proc.errorCode
        : failed && authMeta.requiresAuth
          ? "antigravity_auth_required"
          : failed && quota
            ? "antigravity_quota_exhausted"
            : null,
      sessionId: resolvedSessionId,
      sessionParams,
      sessionDisplayId: resolvedSessionId,
      resultJson: {
        toolCalls: parsed.toolCalls,
        toolResults: parsed.toolResults,
        status: parsed.status,
        ...(accountPool.length > 0 && attempt.home ? { accountHome: attempt.home } : {}),
        ...(failed ? { stderr: proc.stderr } : {}),
      },
      summary: parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const isFailure = (attempt: AttemptResult) =>
    attempt.proc.exitCode === null ||
    attempt.proc.exitCode !== 0 ||
    Boolean(attempt.parsed.status && attempt.parsed.status !== "SUCCESS");

  try {
    const candidates: Array<string | null> =
      accountPool.length > 0 ? orderAccountCandidates(accountPool, runtimeSessionHome || null) : [null];
    let last: AttemptResult | null = null;
    let clearSession = false;
    for (let index = 0; index < candidates.length; index += 1) {
      const home = candidates[index]!;
      // A conversation only exists inside the profile that created it.
      const ownsSession =
        sessionId && (home === null || accountPool.length === 0 || path.resolve(home) === path.resolve(runtimeSessionHome || ""));
      const resumeId = ownsSession ? sessionId : null;
      if (accountPool.length > 0 && home) {
        if (index > 0) {
          await onLog("stdout", `[paperclip] Switching Antigravity account to profile ${home}.\n`);
        }
        await deliverSkillsLocal(home);
      } else if (!executionTargetIsRemote) {
        await deliverSkillsLocal(null);
      }

      let attempt = await runAttempt(resumeId, home);
      if (
        resumeId &&
        !attempt.proc.timedOut &&
        (attempt.proc.exitCode ?? 0) !== 0 &&
        isAntigravitySessionUnrecoverableError(attempt.proc.stdout, attempt.proc.stderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Antigravity conversation "${resumeId}" is unavailable; retrying with a fresh conversation.\n`,
        );
        attempt = await runAttempt(null, home);
        clearSession = true;
      }
      last = attempt;

      const quotaHit =
        isFailure(attempt) &&
        !attempt.proc.timedOut &&
        isAntigravityQuotaExhausted(attempt.proc.stdout, attempt.proc.stderr);
      if (quotaHit && home && index < candidates.length - 1) {
        markAccountCooldown(home, quotaCooldownMin);
        await onLog(
          "stdout",
          `[paperclip] Antigravity quota exhausted for profile ${home}; cooling down for ${quotaCooldownMin} min.\n`,
        );
        continue;
      }
      if (quotaHit && home) markAccountCooldown(home, quotaCooldownMin);
      break;
    }
    const finalAttempt = last!;
    const result = toResult(finalAttempt, clearSession);
    if (
      accountPool.length > 0 &&
      result.errorCode === "antigravity_quota_exhausted" &&
      candidates.every((home) => !home || isAccountCoolingDown(home))
    ) {
      result.errorMessage = `All ${accountPool.length} Antigravity account(s) are out of quota. ${result.errorMessage ?? ""}`.trim();
    }
    return result;
  } finally {
    try {
      await providerStop.collectBeforeRestore();
    } finally {
      await Promise.all([
        restoreRemoteWorkspace?.(),
        ...cleanupTasks.map((task) => task()),
      ]);
    }
  }
}
