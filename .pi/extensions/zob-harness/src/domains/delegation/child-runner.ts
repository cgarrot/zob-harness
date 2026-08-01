import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "./agents.js";
import { SUPERVISED_READONLY_CHILD_TOOLS } from "../../core/constants.js";
import { validateExplicitModelOverride } from "../models/model-availability.js";
import { resolveChildProviderExtension } from "../models/child-provider-extension.js";
import { applyChildGates } from "./output-contracts.js";
import { buildChildEnv } from "../governance/safety.js";
import { updateUsage, usageEmpty } from "../telemetry/telemetry.js";
import type { ChildResult, ChildThinkingLevel, HarnessAgent, SupervisedReadonlyDispatchContract, SupervisedReadonlyDispatcher } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { parseJsonLine, textFromMessage } from "../../core/utils/records.js";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

function childModelPattern(ctx: ExtensionContext, agent: HarnessAgent, modelOverride: string | undefined): string | undefined {
  if (modelOverride?.trim()) return modelOverride.trim();
  if (agent.model?.trim()) return agent.model.trim();
  const model = ctx.model;
  if (!model?.provider || !model.id) return undefined;
  return `${model.provider}/${model.id}`;
}

function providerFromModelPattern(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const [provider] = model.split("/");
  return provider && provider !== model ? provider : undefined;
}

export function buildIsolatedChildArgs(input: {
  providerExtension?: string;
  codexFastModeExtension?: string;
  childSafetyExtension?: string;
}): string[] {
  const args = ["--mode", "json", "-p", "--no-extensions"];
  const extensions = [...new Set([
    input.providerExtension,
    input.codexFastModeExtension,
    input.childSafetyExtension,
  ].filter((value): value is string => Boolean(value)))];
  for (const extension of extensions) args.push("-e", extension);
  return args;
}

export type ChildModelProbeResult = { ok: boolean; reason?: string };
export type ChildModelProbeRequest = {
  repoRoot: string;
  model: string;
  providerExtension?: string;
  signal?: AbortSignal;
};
type ChildModelListRun = { code: number; stdout: string; stderr: string; timedOut: boolean };
type ChildModelListRunner = (input: Omit<ChildModelProbeRequest, "signal">) => Promise<ChildModelListRun>;
type ChildModelProbeReadable = {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
};
export type ChildModelProbeProcess = {
  stdout: ChildModelProbeReadable;
  stderr: ChildModelProbeReadable;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
};
export type ChildModelProbeSpawner = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => ChildModelProbeProcess;

const CHILD_MODEL_PROBE_TTL_MS = 60_000;
const CHILD_MODEL_PROBE_TIMEOUT_MS = 30_000;
const CHILD_MODEL_PROBE_KILL_GRACE_MS = 5_000;
const CHILD_MODEL_PROBE_OUTPUT_LIMIT = 128 * 1024;

export function modelListHasExactModel(output: string, expectedModel: string): boolean {
  const separator = expectedModel.indexOf("/");
  const expectedProvider = separator === -1 ? undefined : expectedModel.slice(0, separator);
  const expectedId = separator === -1 ? expectedModel : expectedModel.slice(separator + 1);
  return output.split(/\r?\n/).some((line) => {
    const [provider, model] = line.trim().split(/\s+/);
    if (!provider || !model || provider === "provider") return false;
    return expectedProvider ? provider === expectedProvider && model === expectedId : model === expectedId;
  });
}

export async function runChildModelListProbe(input: Omit<ChildModelProbeRequest, "signal">, options: {
  spawnChild?: ChildModelProbeSpawner;
  timeoutMs?: number;
  killGraceMs?: number;
} = {}): Promise<ChildModelListRun> {
  const args = ["--no-extensions"];
  if (input.providerExtension) args.push("-e", input.providerExtension);
  args.push("--list-models", input.model);
  const invocation = getPiInvocation(args);
  const spawnChild = options.spawnChild ?? ((spawnInput) => spawn(spawnInput.command, spawnInput.args, {
    cwd: spawnInput.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnInput.env,
  }));
  return new Promise<ChildModelListRun>((resolveProbe) => {
    const child = spawnChild({
      command: invocation.command,
      args: invocation.args,
      cwd: input.repoRoot,
      env: buildChildEnv(input.repoRoot),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const appendBounded = (current: string, chunk: string): string => `${current}${chunk}`.slice(-CHILD_MODEL_PROBE_OUTPUT_LIMIT);
    const finish = (result: ChildModelListRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveProbe(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? CHILD_MODEL_PROBE_KILL_GRACE_MS);
      killTimer.unref();
    }, options.timeoutMs ?? CHILD_MODEL_PROBE_TIMEOUT_MS);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => finish({ code: 1, stdout, stderr: appendBounded(stderr, error.message), timedOut }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr, timedOut }));
  });
}

function waitForSharedProbe(shared: Promise<ChildModelProbeResult>, signal: AbortSignal | undefined): Promise<ChildModelProbeResult> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.resolve({ ok: false, reason: "child model availability probe aborted" });
  return new Promise<ChildModelProbeResult>((resolveWaiter) => {
    let settled = false;
    const finish = (result: ChildModelProbeResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolveWaiter(result);
    };
    const abort = (): void => finish({ ok: false, reason: "child model availability probe aborted" });
    signal.addEventListener("abort", abort, { once: true });
    void shared.then(finish);
  });
}

export function createChildModelAvailabilityProbe(options: {
  runner?: ChildModelListRunner;
  cacheTtlMs?: number;
  now?: () => number;
} = {}): (input: ChildModelProbeRequest) => Promise<ChildModelProbeResult> {
  const runner = options.runner ?? runChildModelListProbe;
  const cacheTtlMs = options.cacheTtlMs ?? CHILD_MODEL_PROBE_TTL_MS;
  const now = options.now ?? Date.now;
  const successCache = new Map<string, number>();
  const inFlight = new Map<string, Promise<ChildModelProbeResult>>();
  return async (input) => {
    if (input.signal?.aborted) return { ok: false, reason: "child model availability probe aborted" };
    const cacheKey = JSON.stringify([input.repoRoot, input.model, input.providerExtension ?? ""]);
    const expiresAt = successCache.get(cacheKey) ?? 0;
    if (expiresAt > now()) return { ok: true };
    successCache.delete(cacheKey);

    let shared = inFlight.get(cacheKey);
    if (!shared) {
      shared = runner({ repoRoot: input.repoRoot, model: input.model, providerExtension: input.providerExtension }).then((run) => {
        if (run.timedOut) return { ok: false, reason: "child model availability probe timed out" };
        const diagnostic = `${run.stdout}\n${run.stderr}`.trim();
        if (run.code !== 0) return { ok: false, reason: diagnostic || `child model availability probe exited ${run.code}` };
        if (!modelListHasExactModel(run.stdout, input.model)) {
          return { ok: false, reason: `exact model '${input.model}' was not present in child model listing` };
        }
        successCache.set(cacheKey, now() + cacheTtlMs);
        return { ok: true };
      }).finally(() => inFlight.delete(cacheKey));
      inFlight.set(cacheKey, shared);
    }
    return waitForSharedProbe(shared, input.signal);
  };
}

const probeChildModelAvailability = createChildModelAvailabilityProbe();

function resolveCodexFastModeExtension(ctx: ExtensionContext, model: string | undefined): string | undefined {
  const provider = providerFromModelPattern(model) ?? ctx.model?.provider;
  const usesCodexProvider = provider === "openai-codex" || provider === "codex-auto" || provider?.startsWith("codex-") === true;
  if (!usesCodexProvider) return undefined;
  const extensionPath = join(getAgentDir(), "extensions", "codex-fast-mode.ts");
  return existsSync(extensionPath) ? extensionPath : undefined;
}

const CHILD_THINKING_LEVELS = new Set<string>(["low", "medium", "high", "xhigh"]);

function createChildSessionPath(
  agentSessionDir: string,
  agentName: string,
  options: { now?: number; pid?: number; uniqueSuffix?: string } = {},
): string {
  const now = options.now ?? Date.now();
  const pid = options.pid ?? process.pid;
  const uniqueSuffix = options.uniqueSuffix ?? randomUUID();
  return join(agentSessionDir, `${now}-${pid}-${safeFileStem(agentName)}-${safeFileStem(uniqueSuffix)}.jsonl`);
}

function validateChildThinkingOverride(thinking: string | undefined, fieldName = "thinking"): string[] {
  if (thinking === undefined) return [];
  return CHILD_THINKING_LEVELS.has(thinking) ? [] : [`${fieldName} must be one of low, medium, high, xhigh`];
}

function resolveChildThinking(agent: HarnessAgent, thinkingOverride: ChildThinkingLevel | undefined): string | undefined {
  return thinkingOverride ?? agent.thinking;
}

function formatSupervisedReadonlyTask(contract: SupervisedReadonlyDispatchContract): string {
  const outputContractGuidance = contract.outputContract === "lead-plan.v1"
    ? [
      "For lead-plan.v1, include parseable JSON inside <worker_contracts>...</worker_contracts>.",
      "Use this exact JSON shape: {\"worker_contracts\":[{\"worker_id\":\"...\",\"lead_id\":\"...\",\"agent\":\"...\",\"task\":\"...\",\"expected_outcome\":\"...\",\"required_tools\":[\"read\",\"grep\",\"find\",\"ls\"],\"output_contract\":\"explore.v1\",\"must_do\":[\"...\"],\"must_not_do\":[\"...\"],\"context\":\"...\",\"allowed_paths\":[\"repo-relative/path\"],\"forbidden_paths\":[\"repo-relative/path\",\"~/secret-dir\",\"/absolute/deny-only/path\"],\"model_class\":\"cheap_scout\"}]}",
      "allowed_paths must be repo-relative only; do not include absolute paths, home paths, or paths starting with '~'. forbidden_paths are deny-only patterns and may be repo-local, absolute, or home-relative; broad roots are rejected.",
      "Also include literal lead-plan fields: lead_id, phase, required_tools, allowed_paths, forbidden_paths, output_contract, model_class, evidence_needed, no_ship_criteria, evidence, risks/blockers, compliance.",
    ].join("\n")
    : "Return the required contract sections.";
  return [
    `1. TASK: ${contract.task}`,
    `2. EXPECTED OUTCOME: ${contract.expectedOutcome}`,
    `3. REQUIRED TOOLS: ${contract.requiredTools.join(", ")}`,
    `4. MUST DO:\n- ${contract.mustDo.join("\n- ")}`,
    `5. MUST NOT DO:\n- ${[...contract.mustNotDo, "Do not delegate to other workers", "Do not use tools outside read, grep, find, ls"].join("\n- ")}`,
    `6. CONTEXT: ${contract.context}`,
    `OUTPUT_CONTRACT: ${contract.outputContract}`,
    outputContractGuidance,
    `Final line must be exactly: deliverable_delivered: yes`,
  ].join("\n");
}

function createSupervisedReadonlyDispatcher(ctx: ExtensionContext, signal: AbortSignal | undefined, modelOverride: string | undefined, emitUpdate: ((result: ChildResult) => void) | undefined): SupervisedReadonlyDispatcher {
  return async (contract) => {
    const agents = discoverAgents(ctx.cwd, "project");
    const agent = agents.find((candidate) => candidate.name.toLowerCase() === contract.agent.toLowerCase());
    if (!agent) return { status: "failed", error: `agent_not_found:${sha256(contract.agent)}` };

    const childResult = await runChildAgent(ctx, agent, formatSupervisedReadonlyTask(contract), ctx.cwd, signal, modelOverride, SUPERVISED_READONLY_CHILD_TOOLS.join(","), emitUpdate);
    childResult.outputContract = contract.outputContract;
    applyChildGates(childResult, { repoRoot: ctx.cwd });

    const outputHash = childResult.output ? sha256(childResult.output) : undefined;
    if (isFailed(childResult)) {
      const gateErrorHash = childResult.gateErrors && childResult.gateErrors.length > 0 ? sha256(childResult.gateErrors.join("\n")) : undefined;
      const runtimeErrorHash = childResult.errorMessage ? sha256(childResult.errorMessage) : undefined;
      return { status: "failed", outputHash, output: childResult.output, error: runtimeErrorHash ?? gateErrorHash ?? `child_failed:${childResult.exitCode}`, dispatcher: "live_child_pi", mocked: false, sessionPath: childResult.sessionPath, outputContractValidated: childResult.gatePassed !== undefined, gatePassed: childResult.gatePassed };
    }

    return { status: "completed", outputHash, output: childResult.output, dispatcher: "live_child_pi", mocked: false, sessionPath: childResult.sessionPath, outputContractValidated: childResult.gatePassed !== undefined, gatePassed: childResult.gatePassed };
  };
}

async function runChildAgent(
  ctx: ExtensionContext,
  agent: HarnessAgent,
  task: string,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  modelOverride: string | undefined,
  toolsOverride: string | undefined,
  emitUpdate: ((result: ChildResult) => void) | undefined,
  pathPolicy?: { allowedPaths?: string[]; forbiddenPaths?: string[]; sandboxRoot?: string },
  thinkingOverride?: ChildThinkingLevel,
): Promise<ChildResult> {
  const resolvedModel = childModelPattern(ctx, agent, modelOverride);
  const result: ChildResult = {
    agent: agent.name,
    task,
    exitCode: 0,
    output: "",
    stderr: "",
    model: resolvedModel,
    usage: usageEmpty(),
  };

  const modelOverrideValidation = validateExplicitModelOverride(ctx.cwd, modelOverride);
  if (!modelOverrideValidation.ok) {
    return {
      ...result,
      exitCode: 1,
      output: `Delegation preflight failed (no child launched):\n- ${modelOverrideValidation.errors.join("\n- ")}`,
      gatePassed: false,
      gateErrors: modelOverrideValidation.errors,
      contractErrors: modelOverrideValidation.errors,
      failureKind: "config",
      errorMessage: `Configuration blocked; no child launched: ${modelOverrideValidation.errors.join("; ")}`,
    };
  }

  const provider = providerFromModelPattern(resolvedModel);
  const trustAwareContext = ctx as ExtensionContext & { isProjectTrusted?: () => boolean };
  const providerExtension = resolveChildProviderExtension({
    repoRoot: ctx.cwd,
    agentDir: getAgentDir(),
    provider,
    projectTrusted: trustAwareContext.isProjectTrusted?.() === true,
  });
  if (providerExtension.errors.length > 0) {
    return {
      ...result,
      exitCode: 1,
      output: `Delegation preflight failed (no child launched):\n- ${providerExtension.errors.join("\n- ")}`,
      gatePassed: false,
      gateErrors: providerExtension.errors,
      contractErrors: providerExtension.errors,
      failureKind: "config",
      errorMessage: `Configuration blocked; no child launched: ${providerExtension.errors.join("; ")}`,
    };
  }

  if (resolvedModel) {
    const modelProbe = await probeChildModelAvailability({
      repoRoot: ctx.cwd,
      model: resolvedModel,
      providerExtension: providerExtension.source,
      signal,
    });
    if (!modelProbe.ok) {
      const remediation = providerExtension.source
        ? `approved provider extension '${providerExtension.source}' was loaded, but the exact model is unavailable; verify the current model id and provider authentication`
        : `no approved local provider extension was found for '${provider ?? "unknown"}'; switch the parent/session to a built-in model and omit model, or configure an approved local child provider extension`;
      const errors = [`child model '${resolvedModel}' is unavailable under the isolated --no-extensions launcher: ${modelProbe.reason ?? "model not listed"}; ${remediation}`];
      return {
        ...result,
        exitCode: 1,
        output: `Delegation preflight failed (no child launched):\n- ${errors.join("\n- ")}`,
        gatePassed: false,
        gateErrors: errors,
        contractErrors: errors,
        failureKind: "config",
        errorMessage: `Configuration blocked; no child launched: ${errors.join("; ")}`,
      };
    }
  }

  const tmp = await mkdtemp(join(tmpdir(), "zob-agent-"));
  const agentSessionDir = join(ctx.cwd, ".pi", "agent-sessions");
  mkdirSync(agentSessionDir, { recursive: true });
  const sessionPath = createChildSessionPath(agentSessionDir, agent.name);
  result.sessionPath = sessionPath;
  emitUpdate?.(result);

  try {
    const childSafetyExtension = join(ctx.cwd, ".pi", "extensions", "zob-child-safety", "index.ts");
    const childCodexFastModeExtension = resolveCodexFastModeExtension(ctx, resolvedModel);
    const args = buildIsolatedChildArgs({
      providerExtension: providerExtension.source,
      codexFastModeExtension: childCodexFastModeExtension,
      childSafetyExtension: existsSync(childSafetyExtension) ? childSafetyExtension : undefined,
    });
    args.push("--session", sessionPath);
    const model = resolvedModel;
    if (model) args.push("--model", model);
    const thinking = resolveChildThinking(agent, thinkingOverride);
    if (thinking) args.push("--thinking", thinking);
    const tools = toolsOverride ?? agent.tools?.join(",");
    if (tools) args.push("--tools", tools);
    args.push("--append-system-prompt", agent.prompt);
    args.push(task);

    await new Promise<void>((resolvePromise) => {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildChildEnv(ctx.cwd, pathPolicy),
      });

      let stdoutBuffer = "";
      let finalText = "";
      let wasAborted = false;

      const processLine = (line: string): void => {
        const event = parseJsonLine(line);
        if (!event) return;

        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta ?? "";
          finalText += delta;
          result.output = finalText;
          emitUpdate?.(result);
        }

        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = textFromMessage(event.message);
          if (text) {
            finalText = text;
            result.output = text;
          }
          result.stopReason = event.message.stopReason;
          result.errorMessage = event.message.errorMessage;
          if (event.message.model) result.model = `${event.message.provider ?? ""}/${event.message.model}`.replace(/^\//, "");
          updateUsage(result, event.message);
          emitUpdate?.(result);
        }

        if (event.type === "agent_end" && Array.isArray(event.messages)) {
          const assistantMessages = event.messages.filter((message) => message.role === "assistant");
          const last = assistantMessages.at(-1);
          const text = textFromMessage(last);
          if (text) result.output = text;
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        result.stderr += chunk;
        emitUpdate?.(result);
      });

      const abortChild = (): void => {
        wasAborted = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000).unref();
      };

      if (signal?.aborted) abortChild();
      else signal?.addEventListener("abort", abortChild, { once: true });

      child.on("error", (error) => {
        result.exitCode = 1;
        result.errorMessage = error.message;
        resolvePromise();
      });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", abortChild);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        result.exitCode = code ?? (wasAborted ? 130 : 0);
        if (wasAborted) {
          result.stopReason = "aborted";
          result.errorMessage = "Child agent aborted";
        }
        resolvePromise();
      });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  return result;
}

function isFailed(result: ChildResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.gatePassed === false;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(undefined).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export { createChildSessionPath, createSupervisedReadonlyDispatcher, isFailed, mapWithConcurrency, runChildAgent, validateChildThinkingOverride };
