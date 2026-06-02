import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "./agents.js";
import { SUPERVISED_READONLY_CHILD_TOOLS } from "../../core/constants.js";
import { validateExplicitModelOverride } from "../models/model-availability.js";
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

const CHILD_THINKING_LEVELS = new Set<string>(["low", "medium", "high", "xhigh"]);

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
      return { status: "failed", outputHash, output: childResult.output, error: gateErrorHash ?? runtimeErrorHash ?? `child_failed:${childResult.exitCode}`, dispatcher: "live_child_pi", mocked: false, sessionPath: childResult.sessionPath, outputContractValidated: childResult.gatePassed !== undefined, gatePassed: childResult.gatePassed };
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
  const result: ChildResult = {
    agent: agent.name,
    task,
    exitCode: 0,
    output: "",
    stderr: "",
    model: modelOverride ?? agent.model,
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

  const tmp = await mkdtemp(join(tmpdir(), "zob-agent-"));
  const agentSessionDir = join(ctx.cwd, ".pi", "agent-sessions");
  mkdirSync(agentSessionDir, { recursive: true });
  const sessionPath = join(agentSessionDir, `${Date.now()}-${process.pid}-${safeFileStem(agent.name)}.jsonl`);
  result.sessionPath = sessionPath;
  emitUpdate?.(result);

  try {
    const childSafetyExtension = join(ctx.cwd, ".pi", "extensions", "zob-child-safety", "index.ts");
    const args = ["--mode", "json", "-p", "--no-extensions"];
    if (existsSync(childSafetyExtension)) args.push("-e", childSafetyExtension);
    args.push("--session", sessionPath);
    const model = modelOverride ?? agent.model;
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

export { createSupervisedReadonlyDispatcher, isFailed, mapWithConcurrency, runChildAgent, validateChildThinkingOverride };
