import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentScope, ChildResult, ChildStopCondition, ChildThinkingLevel, DelegationDetails, DelegationFailureKind } from "../../types.js";
import { AwaitDelegationRunParams, DelegateParams, DelegateTaskParams, DelegationCatalogParams, DelegationRunParams } from "../schemas.js";
import { discoverAgents, formatAgentList } from "../../domains/delegation/agents.js";
import { applyTodoSplitRequest, extractTodoClaimFromText, extractTodoClaimValidationFromText, extractTodoPeerResultFromText, extractTodoSplitRequestFromText, isActionableTodoClaimValidation, isActionableTodoSplitRequest, linkGoalTodoDelegation, recordGoalTodoClaimValidationResult, requestGoalTodoClaimValidation, resolveGoalTodoReference, returnGoalTodoClaim, type GoalTodoNode } from "../../domains/goal/goal-todos.js";
import { isFailed, mapWithConcurrency, runChildAgent, validateChildThinkingOverride } from "../../domains/delegation/child-runner.js";
import { classifyChildStopCondition, classifyDelegationChronicleCompletion, outputHasEvidenceMarker } from "../../domains/telemetry/chronicle.js";
import { validateExplicitModelOverride } from "../../domains/models/model-availability.js";
import { applyChildGates, getOutputContractDefinitions, inferOutputContract, listOutputContracts, validateOutputContractId } from "../../domains/delegation/output-contracts.js";
import { captureZcommitChildDirtySnapshot, diffZcommitChildDirtySnapshots, type ZcommitChildChangedPathRef } from "../../domains/git/git-ops.js";
import {
  parseToolList,
  resolveChildCwd,
  validateAllowedPathPolicy,
  validateDelegationWriteScope,
  validateDelegateTaskWriteScope,
  validateForbiddenPathPolicy,
  validateSixPartContract,
  validateToolList,
} from "../../domains/governance/safety.js";
import { usageEmpty, writeDelegationTelemetrySummary } from "../../domains/telemetry/telemetry.js";
import { capOutput, formatChildResultText } from "../../core/utils/formatting.js";
import { sha256 } from "../../core/utils/hashing.js";
import { newRunId } from "../../core/utils/paths.js";
import {
  delegationDurationMs,
  delegationSignalBadge,
  delegationSignalColor,
  extractDelegationSignalBadge,
  finishDelegationRun,
  formatDelegationCwdLabel,
  formatDelegationModelLabel,
  formatDelegationSignalBadge,
  formatDuration,
  hasActiveDelegations,
  startDelegationRun,
  statusIcon,
  updateDelegationRun,
  type DelegationRunMode,
} from "../delegation-monitor.js";
import { delegateViewLink } from "../delegation-mouse.js";
import type { BackgroundDelegationRuntimeRun, HarnessRuntimeState } from "../state.js";
import { strictGoalErrors, strictGoalSpecErrors } from "../state.js";
import { renderHarnessWidget } from "../widget.js";
import type { AgenticClaimValidationInput, ChildGoalInput, DelegateTaskAliasInput, DelegateTaskCanonicalInput } from "./types.js";
import {
  appendLedgerFile,
  bodyFreeDelegationLedgerEntry,
  asDelegationDetails,
  delegationLedgerMeta,
  delegationCallLabel,
  classifyConfigOrPreflight,
  toolsEnableWrites,
  captureChildDirtyDelta,
  classifyChildFailure,
  delegateTaskPreflightHelp,
  childFailureMessage,
  deepEqual,
  normalizeDelegateTaskParams,
  childGoalGuidance,
  appendChildGoalToTask,
  resolveChildGoalTodoRef,
  linkChildGoalTodoDelegationIfReady,
  retargetTodoSplitRequestResult,
  enforceChildGoalClaimCorrelation,
  recordBoundTodoDelegationPreflightFailure,
  recordTodoClaimFromChildResult,
  shouldRunAgenticClaimValidation,
  formatTodoClaimValidationTask,
  runAgenticTodoClaimValidation,
  finalFormatGuidance,
  hydrateDelegationRunsFromDetails,
  agentSourcePath,
  buildDelegationCatalog,
  formatDelegationCatalogSummary,
  renderDelegationToolResultText,
} from "./helpers.js";

function durableErrorRefs(errors: string[] | undefined): string[] {
  return (errors ?? []).map((error) => `sha256:${sha256(error)}`);
}

function durableGateReasonCodes(result: ChildResult): string[] {
  return result.gateIssues?.map((issue) => issue.code) ?? durableErrorRefs(result.gateErrors);
}

export function registerDelegationTools(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerTool({
    name: "zob_delegation_catalog",
    label: "ZOB Delegation Catalog",
    description: "Read-only live catalog of available ZOB specialist agents, their tools/descriptions, inferred output contracts, valid output contract ids, and routing hints. No child dispatch, no execution, no network.",
    promptSnippet: "Inspect available delegation agents and output contracts before choosing delegate_agent/delegate_task",
    promptGuidelines: [
      "Use this before the first delegation when agent or output_contract routing is uncertain.",
      "Choose the agent by desired deliverable; normally omit delegate_task.output_contract so the harness infers it from the agent.",
      "Do not invent output contract ids; use only validOutputContracts returned by this catalog.",
    ],
    parameters: DelegationCatalogParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "project";
      const catalog = buildDelegationCatalog(ctx.cwd, scope, params.include_contract_requirements === true);
      return { content: [{ type: "text", text: formatDelegationCatalogSummary(catalog) }], details: catalog };
    },
  });

  pi.registerTool({
    name: "delegate_agent",
    label: "Delegate Agent",
    description: [
      "Delegate a focused task to ZOB specialist Pi child agents.",
      "Modes: single (agent+task), parallel (tasks[]), chain (chain[] with {previous}).",
      "Use this for explore/plan/oracle/research slices before broad implementation.",
      "Every delegated task must use the exact six-part TASK/EXPECTED OUTCOME/REQUIRED TOOLS/MUST DO/MUST NOT DO/CONTEXT contract.",
    ].join(" "),
    promptSnippet: "Delegate focused work to project specialist agents with isolated child Pi contexts",
    promptGuidelines: [
      "If agent routing is uncertain, call zob_delegation_catalog before the first delegation.",
      "Use delegate_agent for broad discovery, external research, skeptical review, or independent QA before making risky edits.",
      "When using delegate_agent, give each child a bounded six-part contract and a concrete final output shape. The textual REQUIRED TOOLS section is mandatory even when the agent tool allowlist is inferred; delegate_task.required_tools is a separate optional JSON narrowing field.",
      "Optional cwd spawns the child inside that repo-local working directory; tasks[].cwd and chain[].cwd override delegate_agent top-level cwd defaults.",
      "cwd only selects the child working directory; it does not replace allowed_paths or write-scope grants.",
      "If effective tools include edit/write, provide non-empty repo-relative-only allowed_paths; use repo-local reports/... snapshot/context_ref refs for external context.",
    ],
    parameters: DelegateParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("delegate_agent"))} ${theme.fg("accent", delegationCallLabel(args))}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = asDelegationDetails(result.details);
      const toolCallId = (context as { toolCallId?: string }).toolCallId;
      return new Text(renderDelegationToolResultText("delegate_agent", details, state, toolCallId, isPartial, expanded, theme), 0, 0);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const scope = params.scope ?? "project";
      const agents = discoverAgents(ctx.cwd, scope);
      const byName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent]));
      const makeDetails = (mode: DelegationDetails["mode"], results: ChildResult[]): DelegationDetails => ({
        mode,
        results,
        agents: agents.map((agent) => agent.name),
      });

      const modes = Number(Boolean(params.agent && params.task)) + Number((params.tasks?.length ?? 0) > 0) + Number((params.chain?.length ?? 0) > 0);
      if (modes !== 1) {
        return {
          content: [{ type: "text", text: `Provide exactly one mode. Available agents:\n${formatAgentList(agents)}` }],
          details: makeDetails("single", []),
        };
      }

      const appendDelegationLedger = (entry: Record<string, unknown>): void => {
        const bodyFreeEntry = bodyFreeDelegationLedgerEntry(entry);
        appendLedgerFile(ctx.cwd, bodyFreeEntry);
        pi.appendEntry("zob-delegation", bodyFreeEntry);
      };

      const renderDelegationMonitor = (): void => {
        if (ctx.hasUI) renderHarnessWidget(pi, state, ctx);
      };
      let monitorTicker: NodeJS.Timeout | undefined;
      const startMonitorTicker = (): void => {
        if (!ctx.hasUI || monitorTicker) return;
        monitorTicker = setInterval(() => {
          if (hasActiveDelegations(state.delegations)) renderHarnessWidget(pi, state, ctx);
        }, 1000);
        monitorTicker.unref();
      };
      const stopMonitorTicker = (): void => {
        if (monitorTicker) clearInterval(monitorTicker);
        monitorTicker = undefined;
        renderDelegationMonitor();
      };

      const runOne = async (item: { agent: string; task: string; cwd?: string; thinking?: ChildThinkingLevel; child_goal?: ChildGoalInput }, monitor: { mode: DelegationRunMode; index?: number }, update?: (result: ChildResult) => void): Promise<ChildResult> => {
        const runId = newRunId("delegate");
        const requestedChildGoal = item.child_goal ?? params.child_goal;
        const childGoalOutputContract = requestedChildGoal?.todo_id !== undefined || requestedChildGoal?.todo_path !== undefined
          ? "todo-child-result.v2"
          : inferOutputContract(item.agent);
        const childGoalResolution = resolveChildGoalTodoRef(state, requestedChildGoal, runId, childGoalOutputContract);
        const effectiveChildGoal = childGoalResolution.childGoal;
        const taskText = appendChildGoalToTask(item.task, effectiveChildGoal, state.runtimeGoal?.goalId, runId);
        const startedAtMs = Date.now();
        const startedAt = new Date(startedAtMs).toISOString();
        const requestedTools = parseToolList(params.tools);
        const effectiveThinking = item.thinking ?? params.thinking;
        const cwdResult = resolveChildCwd(ctx.cwd, item.cwd ?? params.cwd);
        if (childGoalResolution.errors.length > 0) {
          return {
            agent: item.agent,
            task: taskText,
            exitCode: 1,
            output: delegateTaskPreflightHelp(childGoalResolution.errors),
            stderr: "",
            ledgerRunId: runId,
            contractErrors: childGoalResolution.errors,
            gatePassed: false,
            gateErrors: childGoalResolution.errors,
            preflightDiagnostics: childGoalResolution.diagnostics,
            failureKind: "preflight",
            usage: usageEmpty(),
            cwd: cwdResult.cwd,
          };
        }
        startDelegationRun(state.delegations, {
          id: runId,
          parentToolCallId: toolCallId,
          source: "delegate_agent",
          mode: monitor.mode,
          index: monitor.index,
          agent: item.agent,
          task: taskText,
          startedAtMs,
          cwd: cwdResult.cwd,
        });
        renderDelegationMonitor();
        const agent = byName.get(item.agent.toLowerCase());
        if (!agent) {
          const result: ChildResult = {
            agent: item.agent,
            task: taskText,
            exitCode: 1,
            output: `Unknown agent '${item.agent}'. Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
            stderr: "",
            ledgerRunId: runId,
            gatePassed: false,
            gateErrors: ["unknown agent"],
            failureKind: "config",
            usage: usageEmpty(),
            cwd: cwdResult.cwd,
          };
          recordBoundTodoDelegationPreflightFailure(pi, state, effectiveChildGoal, { runId, agent: item.agent, failureKind: "config", errors: ["unknown_agent"] });
          const endedAtMs = Date.now();
          const endedAt = new Date(endedAtMs).toISOString();
          appendDelegationLedger({
            event: "config_failed",
            runId,
            mode: state.activeMode,
            ...delegationLedgerMeta("delegate_agent", toolCallId, monitor.mode, monitor.index),
            agent: item.agent,
            taskHash: sha256(taskText),
            cwd: cwdResult.cwd,
            tools: requestedTools ?? [],
            errors: ["unknown agent"],
            failureKind: result.failureKind,
            latencyMs: endedAtMs - startedAtMs,
            endedAt,
          });
          writeDelegationTelemetrySummary(ctx.cwd, {
            runId,
            source: "delegate_agent",
            mode: state.activeMode,
            agent: item.agent,
            model: params.model,
            cwd: cwdResult.cwd,
            tools: requestedTools ?? [],
            taskHash: sha256(taskText),
            outputContract: inferOutputContract(item.agent),
            status: "unknown_agent",
            gatePassed: false,
            gateErrors: ["unknown_agent"],
            failureKind: result.failureKind,
            usage: result.usage,
            latencyMs: endedAtMs - startedAtMs,
            startedAt,
            endedAt,
          });
          finishDelegationRun(state.delegations, runId, {
            status: "preflight_failed",
            endedAtMs,
            outputPreview: result.output,
            stderrPreview: result.stderr,
            exitCode: result.exitCode,
            gatePassed: false,
            gateErrors: ["unknown agent"],
            failureKind: result.failureKind,
            errorMessage: "Configuration blocked; no child launched: unknown agent",
            model: params.model,
            cwd: cwdResult.cwd,
          });
          renderDelegationMonitor();
          return result;
        }

        updateDelegationRun(state.delegations, runId, { agent: agent.name, cwd: cwdResult.cwd });
        const effectiveTools = requestedTools ?? agent.tools ?? [];
        const preflightErrors = [
          ...strictGoalErrors(state),
          ...strictGoalSpecErrors(state, { kind: "delegate_write", taskText, requiredTools: effectiveTools }),
          ...childGoalResolution.errors,
          ...validateSixPartContract(taskText),
          ...validateToolList(agent, requestedTools),
          ...cwdResult.errors,
          ...validateAllowedPathPolicy(params.allowed_paths, "allowed_paths", ctx.cwd),
          ...validateForbiddenPathPolicy(params.forbidden_paths, "forbidden_paths", ctx.cwd),
          ...validateDelegationWriteScope("delegate_agent", effectiveTools, params.allowed_paths),
          ...validateExplicitModelOverride(ctx.cwd, params.model).errors,
          ...validateChildThinkingOverride(effectiveThinking, item.thinking ? "tasks[].thinking" : "thinking"),
        ];
        if (preflightErrors.length > 0) {
          const result: ChildResult = {
            agent: agent.name,
            task: taskText,
            exitCode: 1,
            output: `Delegation preflight failed (no child launched):\n- ${preflightErrors.join("\n- ")}`,
            stderr: "",
            ledgerRunId: runId,
            contractErrors: preflightErrors,
            gatePassed: false,
            gateErrors: preflightErrors,
            failureKind: classifyConfigOrPreflight(preflightErrors),
            usage: usageEmpty(),
            cwd: cwdResult.cwd,
          };
          recordBoundTodoDelegationPreflightFailure(pi, state, effectiveChildGoal, { runId, agent: agent.name, failureKind: result.failureKind === "config" ? "config" : "preflight", errors: preflightErrors });
          const endedAtMs = Date.now();
          const endedAt = new Date(endedAtMs).toISOString();
          appendDelegationLedger({
            event: "preflight_failed",
            runId,
            mode: state.activeMode,
            ...delegationLedgerMeta("delegate_agent", toolCallId, monitor.mode, monitor.index),
            agent: agent.name,
            taskHash: sha256(taskText),
            cwd: cwdResult.cwd,
            tools: requestedTools ?? agent.tools ?? [],
            errors: preflightErrors,
            failureKind: result.failureKind,
            latencyMs: endedAtMs - startedAtMs,
          });
          writeDelegationTelemetrySummary(ctx.cwd, {
            runId,
            source: "delegate_agent",
            mode: state.activeMode,
            agent: agent.name,
            model: params.model ?? agent.model,
            cwd: cwdResult.cwd,
            tools: requestedTools ?? agent.tools ?? [],
            taskHash: sha256(taskText),
            outputContract: inferOutputContract(agent.name),
            status: "failed_preflight",
            gatePassed: false,
            gateErrors: durableErrorRefs(preflightErrors),
            failureKind: result.failureKind,
            usage: result.usage,
            latencyMs: endedAtMs - startedAtMs,
            startedAt,
            endedAt,
          });
          finishDelegationRun(state.delegations, runId, {
            status: "preflight_failed",
            endedAtMs,
            outputPreview: result.output,
            stderrPreview: result.stderr,
            exitCode: result.exitCode,
            gatePassed: false,
            gateErrors: preflightErrors,
            failureKind: result.failureKind,
            errorMessage: `${result.failureKind === "config" ? "Configuration blocked" : "Preflight blocked"}; no child launched: ${preflightErrors.join("; ")}`,
            model: params.model ?? agent.model,
            cwd: cwdResult.cwd,
          });
          renderDelegationMonitor();
          return result;
        }

        linkChildGoalTodoDelegationIfReady(pi, state, effectiveChildGoal, runId, agent.name);
        renderDelegationMonitor();
        const outputContract = childGoalOutputContract;
        appendDelegationLedger({
          event: "start",
          runId,
          mode: state.activeMode,
          ...delegationLedgerMeta("delegate_agent", toolCallId, monitor.mode, monitor.index),
          agent: agent.name,
          model: params.model ?? agent.model,
          cwd: cwdResult.cwd,
          tools: requestedTools ?? agent.tools ?? [],
          taskHash: sha256(taskText),
          originalUserAskHash: state.activeGoal ? sha256(state.activeGoal.originalUserAsk) : undefined,
          outputContract,
          startedAt,
        });

        const effectiveChildTools = requestedTools ?? agent.tools ?? [];
        const childPathPolicy = { allowedPaths: params.allowed_paths, forbiddenPaths: params.forbidden_paths };
        const beforeChildDirty = toolsEnableWrites(effectiveChildTools) ? captureZcommitChildDirtySnapshot(ctx.cwd, childPathPolicy) : undefined;
        const result = await runChildAgent(ctx, agent, taskText, cwdResult.cwd, signal, params.model, requestedTools?.join(","), (partial) => {
          partial.cwd = cwdResult.cwd;
          updateDelegationRun(state.delegations, runId, {
            status: partial.stopReason === "aborted" ? "aborted" : "running",
            agent: partial.agent,
            model: partial.model,
            outputPreview: partial.output,
            stderrPreview: partial.stderr,
            sessionPath: partial.sessionPath,
            cwd: cwdResult.cwd,
            stopReason: partial.stopReason,
            errorMessage: partial.errorMessage,
            usage: partial.usage,
          });
          renderDelegationMonitor();
          update?.(partial);
        }, childPathPolicy, effectiveThinking);
        result.cwd = cwdResult.cwd;
        result.childChangedPaths = captureChildDirtyDelta(ctx.cwd, childPathPolicy, beforeChildDirty);
        result.ledgerRunId = runId;
        result.outputContract = outputContract;
        result.contractErrors = [];
        applyChildGates(result, { repoRoot: ctx.cwd, expectedTodoId: effectiveChildGoal?.binding?.expected_claim.todo_id });
        retargetTodoSplitRequestResult(result, effectiveChildGoal, ctx.cwd);
        enforceChildGoalClaimCorrelation(state, effectiveChildGoal, result, runId);
        result.failureKind = classifyChildFailure(result);
        const outputHash = result.output ? sha256(result.output) : undefined;
        const claimRecord = recordTodoClaimFromChildResult(pi, state, effectiveChildGoal, result, { runId, outputHash });
        const endedAtMs = Date.now();
        const endedAt = new Date(endedAtMs).toISOString();
        const status = isFailed(result) ? "incomplete_or_failed" : "complete";
        const assistantTurnSeen = result.usage.turns > 0 || result.output.trim().length > 0;
        const evidenceChecked = result.gatePassed === true && outputHasEvidenceMarker(result.output);
        result.stopCondition = classifyChildStopCondition({
          status,
          agent: agent.name,
          outputContract: result.outputContract,
          output: result.output,
          assistantTurnSeen,
          outputHash,
          outputCaptured: Boolean(outputHash),
          outputValidated: result.gatePassed === true,
          evidenceChecked,
        }).stopCondition as ChildStopCondition;
        appendDelegationLedger({
          event: "end",
          runId,
          mode: state.activeMode,
          ...delegationLedgerMeta("delegate_agent", toolCallId, monitor.mode, monitor.index),
          agent: agent.name,
          model: result.model,
          cwd: cwdResult.cwd,
          tools: requestedTools ?? agent.tools ?? [],
          taskHash: sha256(taskText),
          sessionPath: result.sessionPath,
          exitCode: result.exitCode,
          stopReason: result.stopReason,
          stopCondition: result.stopCondition,
          status,
          outputContract: result.outputContract,
          gatePassed: result.gatePassed,
          gateErrors: result.gateErrors ?? [],
          failureKind: result.failureKind,
          outputHash,
          childChangedPathRefs: result.childChangedPaths,
          childChangedPathHashes: result.childChangedPaths.map((ref) => ref.pathHash),
          chronicle: classifyDelegationChronicleCompletion({
            runId,
            source: "delegate_agent",
            mode: state.activeMode,
            agent: agent.name,
            cwd: cwdResult.cwd,
            tools: requestedTools ?? agent.tools ?? [],
            taskHash: sha256(taskText),
            outputHash,
            outputContract: result.outputContract,
            status,
            stopCondition: result.stopCondition,
            gatePassed: result.gatePassed,
            gateErrors: result.gateErrors ?? [],
            assistantTurnSeen,
            outputCaptured: Boolean(outputHash),
            outputValidated: result.gatePassed === true,
            evidenceChecked,
            usage: result.usage,
            latencyMs: endedAtMs - startedAtMs,
            startedAt,
            endedAt,
            sessionPath: result.sessionPath,
          }),
          usage: result.usage,
          latencyMs: endedAtMs - startedAtMs,
          endedAt,
        });
        writeDelegationTelemetrySummary(ctx.cwd, {
          runId,
          source: "delegate_agent",
          mode: state.activeMode,
          agent: agent.name,
          model: result.model,
          cwd: cwdResult.cwd,
          tools: requestedTools ?? agent.tools ?? [],
          taskHash: sha256(taskText),
          outputHash,
          outputContract: result.outputContract,
          status,
          stopCondition: result.stopCondition,
          gatePassed: result.gatePassed,
          gateErrors: durableGateReasonCodes(result),
          failureKind: result.failureKind,
          assistantTurnSeen,
          outputCaptured: Boolean(outputHash),
          outputValidated: result.gatePassed === true,
          evidenceChecked,
          usage: result.usage,
          latencyMs: endedAtMs - startedAtMs,
          startedAt,
          endedAt,
          sessionPath: result.sessionPath,
        });
        finishDelegationRun(state.delegations, runId, {
          status: result.stopReason === "aborted" ? "aborted" : isFailed(result) ? "failed" : "complete",
          endedAtMs,
          outputPreview: result.output,
          stderrPreview: result.stderr,
          sessionPath: result.sessionPath,
          exitCode: result.exitCode,
          gatePassed: result.gatePassed,
          gateErrors: result.gateErrors ?? [],
          failureKind: result.failureKind,
          stopReason: result.stopReason,
          stopCondition: result.stopCondition,
          errorMessage: childFailureMessage(result.failureKind, result.gateErrors, result.errorMessage),
          childChangedPaths: result.childChangedPaths,
          usage: result.usage,
          model: result.model,
          cwd: cwdResult.cwd,
        });
        if (shouldRunAgenticClaimValidation(effectiveChildGoal, claimRecord)) {
          await runAgenticTodoClaimValidation({ ctx, pi, state, childGoal: effectiveChildGoal, claimRecord, parentRunId: runId, appendDelegationLedger, signal, modelOverride: params.model, allowedPaths: params.allowed_paths, forbiddenPaths: params.forbidden_paths });
        }
        renderDelegationMonitor();
        return result;
      };

      if (params.agent && params.task) {
        startMonitorTicker();
        try {
          const result = await runOne({ agent: params.agent, task: params.task, cwd: params.cwd, thinking: params.thinking, child_goal: params.child_goal }, { mode: "single", index: 0 }, (partial) => {
            onUpdate?.({ content: [{ type: "text", text: partial.output || partial.stderr || "running..." }], details: makeDetails("single", [partial]) });
          });
          return {
            content: [{ type: "text", text: isFailed(result) ? `Agent failed or incomplete:\n\n${formatChildResultText(result)}` : result.output || "(no output)" }],
            details: makeDetails("single", [result]),
          };
        } finally {
          stopMonitorTicker();
        }
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > 8) {
          return { content: [{ type: "text", text: "Too many parallel tasks. Max is 8." }], details: makeDetails("parallel", []) };
        }
        const partials: ChildResult[] = [];
        startMonitorTicker();
        try {
          const results = await mapWithConcurrency(params.tasks, 4, async (task, index) => {
            const result = await runOne(task, { mode: "parallel", index }, (partial) => {
              partials[index] = partial;
              onUpdate?.({ content: [{ type: "text", text: `Parallel delegation running: ${partials.filter(Boolean).length}/${params.tasks?.length ?? 0} updated` }], details: makeDetails("parallel", partials.filter(Boolean)) });
            });
            partials[index] = result;
            return result;
          });
          const successCount = results.filter((result) => !isFailed(result)).length;
          const summaries = results.map((result) => `### ${result.agent} — ${isFailed(result) ? "FAILED/INCOMPLETE" : "OK"}${formatDelegationCwdLabel(result, ctx.cwd) ? ` · ${formatDelegationCwdLabel(result, ctx.cwd)}` : ""}\n\n${capOutput(formatChildResultText(result))}`);
          return {
            content: [{ type: "text", text: `Parallel delegation: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
            details: makeDetails("parallel", results),
          };
        } finally {
          stopMonitorTicker();
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: ChildResult[] = [];
        let previous = "";
        startMonitorTicker();
        try {
          for (const [index, step] of params.chain.entries()) {
            const task = step.task.replace(/\{previous\}/g, previous);
            const result = await runOne({ ...step, task }, { mode: "chain", index }, (partial) => {
              onUpdate?.({ content: [{ type: "text", text: `Chain step ${index + 1}/${params.chain?.length ?? 0}: ${partial.agent}` }], details: makeDetails("chain", [...results, partial]) });
            });
            results.push(result);
            if (isFailed(result)) {
              return {
                content: [{ type: "text", text: `Chain stopped at step ${index + 1} (${result.agent}${formatDelegationCwdLabel(result, ctx.cwd) ? ` · ${formatDelegationCwdLabel(result, ctx.cwd)}` : ""}):\n\n${formatChildResultText(result)}` }],
                details: makeDetails("chain", results),
              };
            }
            previous = result.output;
          }
          return { content: [{ type: "text", text: previous || "(no output)" }], details: makeDetails("chain", results) };
        } finally {
          stopMonitorTicker();
        }
      }

      return { content: [{ type: "text", text: "Invalid delegation parameters." }], details: makeDetails("single", []) };
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: [
      "Strict single-task delegation API for ZOB specialist agents.",
      "Requires the six-part contract fields as structured parameters, validates tools/cwd/paths, logs a ledger entry, and gates child output.",
      "run_in_background starts active-session background execution and returns a run id; get_delegation_run/await_delegation_run inspect it without starting an always-on daemon.",
    ].join(" "),
    promptSnippet: "Delegate one atomic task with a mandatory six-part ZOB contract",
    promptGuidelines: [
      "If agent/output_contract routing is uncertain, call zob_delegation_catalog before the first delegation.",
      "Use delegate_task when you need strict preflight rather than a freeform delegated prompt.",
      "Normally omit output_contract; the harness infers it from the selected agent. Do not invent output contract ids.",
      "Normally omit required_tools; the harness infers the selected agent's declared tools. Only set required_tools to intentionally narrow tools.",
      "Optional cwd spawns the child inside that repo-local working directory; it only selects cwd and does not replace allowed_paths or write-scope grants.",
      "If effective tools include edit/write, set top-level original_user_ask to the original human request; context or task text does not satisfy the strict write preflight gate.",
      "Use canonical JSON keys expected_outcome, must_do, must_not_do, context, original_user_ask, allowed_paths, forbidden_paths; safe aliases are accepted only when non-conflicting.",
      "Accepted aliases: expectedOutcome, mustDo, mustNotDo/must_not/mustNot, originalUserAsk, allowedPaths, forbiddenPaths, requiredTools, outputContract, runInBackground, childGoal, loadSkills.",
      "Always set expected_outcome, must_do, must_not_do, context, repo-relative-only allowed_paths, and deny-only forbidden_paths when known. Use reports/... snapshot/context_ref refs instead of external allowed_paths.",
      "For implementer/QA, require the exact output-contract headings and final line marker so format repair does not look like a failed subagent.",
    ],
    parameters: DelegateTaskParams,
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("delegate_task"))} ${theme.fg("accent", `single → ${args.agent}`)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = asDelegationDetails(result.details);
      const toolCallId = (context as { toolCallId?: string }).toolCallId;
      return new Text(renderDelegationToolResultText("delegate_task", details, state, toolCallId, isPartial, expanded, theme), 0, 0);
    },
    async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
      const normalized = normalizeDelegateTaskParams(rawParams as DelegateTaskAliasInput);
      const params = normalized.params;
      const scope = params.scope ?? "project";
      const agents = discoverAgents(ctx.cwd, scope);
      const agent = agents.find((candidate) => candidate.name.toLowerCase() === params.agent.toLowerCase());
      const runId = newRunId("task");
      const requestedOutputContract = params.output_contract
        ?? (params.child_goal?.todo_id !== undefined || params.child_goal?.todo_path !== undefined ? "todo-child-result.v2" : inferOutputContract(params.agent));
      const childGoalResolution = resolveChildGoalTodoRef(state, params.child_goal, runId, requestedOutputContract);
      const effectiveChildGoal = childGoalResolution.childGoal;
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const cwdResult = resolveChildCwd(ctx.cwd, params.cwd);
      const appendDelegationLedger = (entry: Record<string, unknown>): void => {
        const bodyFreeEntry = bodyFreeDelegationLedgerEntry(entry);
        appendLedgerFile(ctx.cwd, bodyFreeEntry);
        pi.appendEntry("zob-delegation", bodyFreeEntry);
      };
      const renderDelegationMonitor = (): void => {
        if (ctx.hasUI) renderHarnessWidget(pi, state, ctx);
      };
      const notifyBackgroundDelegationSettled = (status: "complete" | "failed", entry: Record<string, unknown>): void => {
        const hashLabel = typeof entry.outputHash === "string" ? ` outputHash=${entry.outputHash}` : typeof entry.errorHash === "string" ? ` errorHash=${entry.errorHash}` : "";
        // Background settlement is evidence/UI metadata only. Do not call
        // pi.sendMessage(triggerTurn=true) from an async background promise:
        // it can race active tool-call turns and corrupt provider function-call
        // state. Parent agents must inspect explicitly with get_delegation_run.
        if (ctx.hasUI) ctx.ui.notify(`delegate_task background ${status}: ${runId}${hashLabel}. Inspect with get_delegation_run.`, status === "complete" ? "info" : "warning");
      };
      let monitorTicker: NodeJS.Timeout | undefined;
      const startMonitorTicker = (): void => {
        if (!ctx.hasUI || monitorTicker) return;
        monitorTicker = setInterval(() => {
          if (hasActiveDelegations(state.delegations)) renderHarnessWidget(pi, state, ctx);
        }, 1000);
        monitorTicker.unref();
      };
      const stopMonitorTicker = (): void => {
        if (monitorTicker) clearInterval(monitorTicker);
        monitorTicker = undefined;
        renderDelegationMonitor();
      };
      if (childGoalResolution.errors.length > 0) {
        const result: ChildResult = {
          agent: params.agent,
          task: params.task,
          exitCode: 1,
          output: delegateTaskPreflightHelp(childGoalResolution.errors),
          stderr: "",
          ledgerRunId: runId,
          contractErrors: childGoalResolution.errors,
          gatePassed: false,
          gateErrors: childGoalResolution.errors,
          preflightDiagnostics: childGoalResolution.diagnostics,
          failureKind: "preflight",
          usage: usageEmpty(),
          cwd: cwdResult.cwd,
        };
        return { content: [{ type: "text", text: formatChildResultText(result) }], details: { mode: "single", results: [result], agents: agents.map((candidate) => candidate.name) } };
      }
      startDelegationRun(state.delegations, {
        id: runId,
        parentToolCallId: toolCallId,
        source: "delegate_task",
        mode: "single",
        index: 0,
        agent: params.agent,
        task: params.task,
        startedAtMs,
        cwd: cwdResult.cwd,
      });
      renderDelegationMonitor();
      startMonitorTicker();

      try {
      if (!agent) {
        const result: ChildResult = {
          agent: params.agent,
          task: params.task,
          exitCode: 1,
          output: `Unknown agent '${params.agent}'. Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`,
          stderr: "",
          ledgerRunId: runId,
          gatePassed: false,
          gateErrors: ["unknown agent"],
          failureKind: "config",
          usage: usageEmpty(),
          cwd: cwdResult.cwd,
        };
        recordBoundTodoDelegationPreflightFailure(pi, state, effectiveChildGoal, { runId, agent: params.agent, failureKind: "config", errors: ["unknown_agent"] });
        const endedAtMs = Date.now();
        const endedAt = new Date(endedAtMs).toISOString();
        appendDelegationLedger({
          event: "config_failed",
          runId,
          mode: state.activeMode,
          ...delegationLedgerMeta("delegate_task", toolCallId, "single", 0),
          agent: params.agent,
          taskHash: sha256(params.task),
          cwd: cwdResult.cwd,
          tools: params.required_tools ?? [],
          errors: ["unknown agent"],
          failureKind: result.failureKind,
          latencyMs: endedAtMs - startedAtMs,
          endedAt,
        });
        writeDelegationTelemetrySummary(ctx.cwd, {
          runId,
          source: "delegate_task",
          mode: state.activeMode,
          agent: params.agent,
          model: params.model,
          cwd: cwdResult.cwd,
          tools: params.required_tools ?? [],
          taskHash: sha256(params.task),
          outputContract: params.output_contract ?? inferOutputContract(params.agent),
          status: "unknown_agent",
          gatePassed: false,
          gateErrors: ["unknown_agent"],
          failureKind: result.failureKind,
          usage: result.usage,
          latencyMs: endedAtMs - startedAtMs,
          startedAt,
          endedAt,
        });
        finishDelegationRun(state.delegations, runId, {
          status: "preflight_failed",
          endedAtMs,
          outputPreview: result.output,
          stderrPreview: result.stderr,
          exitCode: result.exitCode,
          gatePassed: false,
          gateErrors: ["unknown agent"],
          failureKind: result.failureKind,
          errorMessage: "Configuration blocked; no child launched: unknown agent",
          model: params.model,
          cwd: cwdResult.cwd,
        });
        stopMonitorTicker();
        return { content: [{ type: "text", text: formatChildResultText(result) }], details: { mode: "single", results: [result], agents: agents.map((candidate) => candidate.name) } };
      }

      updateDelegationRun(state.delegations, runId, { agent: agent.name, cwd: cwdResult.cwd });
      const effectiveTools = params.required_tools?.length ? params.required_tools : agent.tools ?? [];

      const structuredTask = [
        `ORIGINAL_USER_ASK: ${params.original_user_ask ?? state.activeGoal?.originalUserAsk ?? "Not set"}`,
        params.output_contract || effectiveChildGoal?.binding ? `OUTPUT_CONTRACT: ${requestedOutputContract}` : undefined,
        params.allowed_paths?.length ? `ALLOWED_PATHS: ${params.allowed_paths.join(", ")}` : undefined,
        params.forbidden_paths?.length ? `FORBIDDEN_PATHS: ${params.forbidden_paths.join(", ")}` : undefined,
        ...childGoalGuidance(effectiveChildGoal, state.runtimeGoal?.goalId, runId),
        "",
        `1. TASK: ${params.task}`,
        `2. EXPECTED OUTCOME: ${params.expected_outcome}`,
        `3. REQUIRED TOOLS: ${effectiveTools.join(", ") || "agent default"}`,
        `4. MUST DO:\n${params.must_do.map((item) => `   - ${item}`).join("\n")}`,
        `5. MUST NOT DO:\n${params.must_not_do.map((item) => `   - ${item}`).join("\n")}`,
        `6. CONTEXT: ${params.context}`,
        "",
        ...finalFormatGuidance(requestedOutputContract),
      ]
        .filter((part): part is string => typeof part === "string")
        .join("\n");

      const preflightErrors = [
        ...normalized.errors,
        ...strictGoalErrors(state),
        ...strictGoalSpecErrors(state, { kind: "delegate_write", originalUserAsk: params.original_user_ask, taskText: structuredTask, requiredTools: effectiveTools }),
        ...childGoalResolution.errors,
        ...validateSixPartContract(structuredTask),
        ...validateToolList(agent, params.required_tools),
        ...validateOutputContractId(params.output_contract),
        ...cwdResult.errors,
        ...validateAllowedPathPolicy(params.allowed_paths, "allowed_paths", ctx.cwd),
        ...validateForbiddenPathPolicy(params.forbidden_paths, "forbidden_paths", ctx.cwd),
        ...validateDelegateTaskWriteScope(effectiveTools, params.allowed_paths),
        ...validateExplicitModelOverride(ctx.cwd, params.model).errors,
        ...validateChildThinkingOverride(params.thinking),
      ];
      if ((params.load_skills?.length ?? 0) > 0) preflightErrors.push("load_skills is reserved for a future explicit skill-loading gate; use [] for P0");

      if (preflightErrors.length > 0) {
        const result: ChildResult = {
          agent: agent.name,
          task: structuredTask,
          exitCode: 1,
          output: delegateTaskPreflightHelp(preflightErrors),
          stderr: "",
          ledgerRunId: runId,
          contractErrors: preflightErrors,
          gatePassed: false,
          gateErrors: preflightErrors,
          failureKind: classifyConfigOrPreflight(preflightErrors),
          usage: usageEmpty(),
          cwd: cwdResult.cwd,
        };
        recordBoundTodoDelegationPreflightFailure(pi, state, effectiveChildGoal, { runId, agent: agent.name, failureKind: result.failureKind === "config" ? "config" : "preflight", errors: preflightErrors });
        const endedAtMs = Date.now();
        const endedAt = new Date(endedAtMs).toISOString();
        appendDelegationLedger({
          event: "preflight_failed",
          runId,
          mode: state.activeMode,
          ...delegationLedgerMeta("delegate_task", toolCallId, "single", 0),
          agent: agent.name,
          taskHash: sha256(structuredTask),
          cwd: cwdResult.cwd,
          tools: effectiveTools,
          errors: preflightErrors,
          failureKind: result.failureKind,
          latencyMs: endedAtMs - startedAtMs,
        });
        writeDelegationTelemetrySummary(ctx.cwd, {
          runId,
          source: "delegate_task",
          mode: state.activeMode,
          agent: agent.name,
          model: params.model ?? agent.model,
          cwd: cwdResult.cwd,
          tools: effectiveTools,
          taskHash: sha256(structuredTask),
          outputContract: params.output_contract ?? inferOutputContract(agent.name),
          status: "failed_preflight",
          gatePassed: false,
          gateErrors: durableErrorRefs(preflightErrors),
          failureKind: result.failureKind,
          usage: result.usage,
          latencyMs: endedAtMs - startedAtMs,
          startedAt,
          endedAt,
        });
        finishDelegationRun(state.delegations, runId, {
          status: "preflight_failed",
          endedAtMs,
          outputPreview: result.output,
          stderrPreview: result.stderr,
          exitCode: result.exitCode,
          gatePassed: false,
          gateErrors: preflightErrors,
          failureKind: result.failureKind,
          errorMessage: delegateTaskPreflightHelp(preflightErrors).replace(/\n/g, " "),
          model: params.model ?? agent.model,
          cwd: cwdResult.cwd,
        });
        stopMonitorTicker();
        return { content: [{ type: "text", text: formatChildResultText(result) }], details: { mode: "single", results: [result], agents: agents.map((candidate) => candidate.name) } };
      }

      const runDelegateTaskChild = async (childSignal: AbortSignal | undefined, emitToolUpdates: boolean): Promise<ChildResult> => {
        const outputContract = requestedOutputContract;
        linkChildGoalTodoDelegationIfReady(pi, state, effectiveChildGoal, runId, agent.name);
        renderDelegationMonitor();
        appendDelegationLedger({
          event: "start",
          runId,
          mode: state.activeMode,
          ...delegationLedgerMeta("delegate_task", toolCallId, "single", 0),
          agent: agent.name,
          model: params.model ?? agent.model,
          cwd: cwdResult.cwd,
          tools: effectiveTools,
          taskHash: sha256(structuredTask),
          originalUserAskHash: sha256(params.original_user_ask ?? state.activeGoal?.originalUserAsk ?? ""),
          outputContract,
          background: params.run_in_background === true,
          startedAt,
        });

        const childPathPolicy = { allowedPaths: params.allowed_paths, forbiddenPaths: params.forbidden_paths };
        const beforeChildDirty = toolsEnableWrites(effectiveTools) ? captureZcommitChildDirtySnapshot(ctx.cwd, childPathPolicy) : undefined;
        const result = await runChildAgent(ctx, agent, structuredTask, cwdResult.cwd, childSignal, params.model, effectiveTools.join(","), (partial) => {
          partial.cwd = cwdResult.cwd;
          updateDelegationRun(state.delegations, runId, {
            status: partial.stopReason === "aborted" ? "aborted" : "running",
            agent: partial.agent,
            model: partial.model,
            outputPreview: partial.output,
            stderrPreview: partial.stderr,
            sessionPath: partial.sessionPath,
            cwd: cwdResult.cwd,
            stopReason: partial.stopReason,
            errorMessage: partial.errorMessage,
            usage: partial.usage,
          });
          renderDelegationMonitor();
          if (emitToolUpdates) onUpdate?.({ content: [{ type: "text", text: partial.output || partial.stderr || "running..." }], details: { mode: "single", results: [partial], agents: agents.map((candidate) => candidate.name) } });
        }, childPathPolicy, params.thinking);
        result.cwd = cwdResult.cwd;
        result.childChangedPaths = captureChildDirtyDelta(ctx.cwd, childPathPolicy, beforeChildDirty);
        result.ledgerRunId = runId;
        result.outputContract = outputContract;
        result.contractErrors = [];
        applyChildGates(result, { repoRoot: ctx.cwd, expectedTodoId: effectiveChildGoal?.binding?.expected_claim.todo_id });
        retargetTodoSplitRequestResult(result, effectiveChildGoal, ctx.cwd);
        enforceChildGoalClaimCorrelation(state, effectiveChildGoal, result, runId);
        result.failureKind = classifyChildFailure(result);
        const outputHash = result.output ? sha256(result.output) : undefined;
        const claimRecord = recordTodoClaimFromChildResult(pi, state, effectiveChildGoal, result, { runId, outputHash });
        const endedAtMs = Date.now();
        const endedAt = new Date(endedAtMs).toISOString();
        const status = isFailed(result) ? "incomplete_or_failed" : "complete";
        const assistantTurnSeen = result.usage.turns > 0 || result.output.trim().length > 0;
        const evidenceChecked = result.gatePassed === true && outputHasEvidenceMarker(result.output);
        result.stopCondition = classifyChildStopCondition({
          status,
          agent: agent.name,
          outputContract: result.outputContract,
          output: result.output,
          assistantTurnSeen,
          outputHash,
          outputCaptured: Boolean(outputHash),
          outputValidated: result.gatePassed === true,
          evidenceChecked,
        }).stopCondition as ChildStopCondition;

        appendDelegationLedger({
          event: "end",
          runId,
          mode: state.activeMode,
          ...delegationLedgerMeta("delegate_task", toolCallId, "single", 0),
          agent: agent.name,
          model: result.model,
          cwd: cwdResult.cwd,
          tools: effectiveTools,
          taskHash: sha256(structuredTask),
          sessionPath: result.sessionPath,
          exitCode: result.exitCode,
          stopReason: result.stopReason,
          stopCondition: result.stopCondition,
          status,
          outputContract: result.outputContract,
          gatePassed: result.gatePassed,
          gateErrors: result.gateErrors ?? [],
          failureKind: result.failureKind,
          outputHash,
          childChangedPathRefs: result.childChangedPaths,
          childChangedPathHashes: result.childChangedPaths.map((ref) => ref.pathHash),
          chronicle: classifyDelegationChronicleCompletion({
            runId,
            source: "delegate_task",
            mode: state.activeMode,
            agent: agent.name,
            cwd: cwdResult.cwd,
            tools: effectiveTools,
            taskHash: sha256(structuredTask),
            outputHash,
            outputContract: result.outputContract,
            status,
            stopCondition: result.stopCondition,
            gatePassed: result.gatePassed,
            gateErrors: result.gateErrors ?? [],
            assistantTurnSeen,
            outputCaptured: Boolean(outputHash),
            outputValidated: result.gatePassed === true,
            evidenceChecked,
            usage: result.usage,
            latencyMs: endedAtMs - startedAtMs,
            startedAt,
            endedAt,
            sessionPath: result.sessionPath,
          }),
          usage: result.usage,
          latencyMs: endedAtMs - startedAtMs,
          endedAt,
        });
        writeDelegationTelemetrySummary(ctx.cwd, {
          runId,
          source: "delegate_task",
          mode: state.activeMode,
          agent: agent.name,
          model: result.model,
          cwd: cwdResult.cwd,
          tools: effectiveTools,
          taskHash: sha256(structuredTask),
          outputHash,
          outputContract: result.outputContract,
          status,
          stopCondition: result.stopCondition,
          gatePassed: result.gatePassed,
          gateErrors: durableGateReasonCodes(result),
          failureKind: result.failureKind,
          assistantTurnSeen,
          outputCaptured: Boolean(outputHash),
          outputValidated: result.gatePassed === true,
          evidenceChecked,
          usage: result.usage,
          latencyMs: endedAtMs - startedAtMs,
          startedAt,
          endedAt,
          sessionPath: result.sessionPath,
        });
        finishDelegationRun(state.delegations, runId, {
          status: result.stopReason === "aborted" ? "aborted" : isFailed(result) ? "failed" : "complete",
          endedAtMs,
          outputPreview: result.output,
          stderrPreview: result.stderr,
          sessionPath: result.sessionPath,
          exitCode: result.exitCode,
          gatePassed: result.gatePassed,
          gateErrors: result.gateErrors ?? [],
          failureKind: result.failureKind,
          stopReason: result.stopReason,
          stopCondition: result.stopCondition,
          errorMessage: childFailureMessage(result.failureKind, result.gateErrors, result.errorMessage),
          childChangedPaths: result.childChangedPaths,
          usage: result.usage,
          model: result.model,
          cwd: cwdResult.cwd,
        });
        if (shouldRunAgenticClaimValidation(effectiveChildGoal, claimRecord)) {
          await runAgenticTodoClaimValidation({ ctx, pi, state, childGoal: effectiveChildGoal, claimRecord, parentRunId: runId, appendDelegationLedger, signal: childSignal, modelOverride: params.model, allowedPaths: params.allowed_paths, forbiddenPaths: params.forbidden_paths });
        }
        stopMonitorTicker();

        return result;
      };

      if (params.run_in_background) {
        updateDelegationRun(state.delegations, runId, { background: true });
        renderDelegationMonitor();
        const backgroundController = new AbortController();
        const backgroundPromise = runDelegateTaskChild(backgroundController.signal, false);
        const backgroundRun: BackgroundDelegationRuntimeRun = { runId, startedAtMs, promise: backgroundPromise, abortController: backgroundController };
        state.backgroundDelegations.set(runId, backgroundRun);
        backgroundPromise
          .then((result) => {
            backgroundRun.result = result;
            const settledStatus = isFailed(result) ? "failed" : "complete";
            const settledEntry = {
              event: "background_settled",
              runId,
              mode: state.activeMode,
              ...delegationLedgerMeta("delegate_task", toolCallId, "single", 0),
              agent: agent.name,
              status: settledStatus,
              outputHash: result.output ? sha256(result.output) : undefined,
              errorHash: settledStatus === "failed" ? sha256(childFailureMessage(result.failureKind, result.gateErrors, result.errorMessage) ?? result.stderr ?? result.output ?? "failed") : undefined,
              outputContract: result.outputContract,
              gatePassed: result.gatePassed,
              failureKind: result.failureKind,
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
              endedAt: new Date().toISOString(),
            };
            appendDelegationLedger(settledEntry);
            notifyBackgroundDelegationSettled(settledStatus, settledEntry);
            renderDelegationMonitor();
            return result;
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            backgroundRun.error = message;
            finishDelegationRun(state.delegations, runId, { status: "failed", endedAtMs: Date.now(), errorMessage: message, gatePassed: false, gateErrors: [message], failureKind: "child_runtime", model: params.model ?? agent.model });
            const settledEntry = {
              event: "background_settled",
              runId,
              mode: state.activeMode,
              ...delegationLedgerMeta("delegate_task", toolCallId, "single", 0),
              agent: agent.name,
              status: "failed",
              errorHash: sha256(message),
              failureKind: "child_runtime",
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
              endedAt: new Date().toISOString(),
            };
            appendDelegationLedger(settledEntry);
            notifyBackgroundDelegationSettled("failed", settledEntry);
            renderDelegationMonitor();
          });
        return {
          content: [{ type: "text", text: `delegate_task background started: ${runId}` }],
          details: { mode: "single", background: true, runId, status: "running", results: [], agents: agents.map((candidate) => candidate.name) },
        };
      }

      const result = await runDelegateTaskChild(signal, true);
      return {
        content: [{ type: "text", text: isFailed(result) ? `Task failed or incomplete:

${formatChildResultText(result)}` : result.output || "(no output)" }],
        details: { mode: "single", results: [result], agents: agents.map((candidate) => candidate.name) },
      };
      } finally {
        stopMonitorTicker();
      }
    },
  });


  pi.registerTool({
    name: "get_delegation_run",
    label: "Get Delegation Run",
    description: "Inspect an active-session delegation run, including background delegate_task runs. Metadata/output preview only; no daemon polling.",
    promptSnippet: "Inspect a background delegation run before deciding next TODO action.",
    parameters: DelegationRunParams,
    async execute(_toolCallId, params) {
      const run = state.delegations.runs.find((candidate) => candidate.id === params.run_id);
      const background = state.backgroundDelegations.get(params.run_id);
      const status = run?.status ?? (background?.result ? "complete" : background?.error ? "failed" : background ? "running" : "not_found");
      return {
        content: [{ type: "text", text: `get_delegation_run ${params.run_id}: ${status}` }],
        details: { schema: "zob.delegation-run-status.v1", runId: params.run_id, status, run, background: background ? { startedAtMs: background.startedAtMs, complete: Boolean(background.result), error: background.error } : undefined, result: background?.result },
      };
    },
  });

  pi.registerTool({
    name: "await_delegation_run",
    label: "Await Delegation Run",
    description: "Bounded passive wait for an active-session background delegate_task run. brief keeps the short cap; long_idle allows a longer bounded idle. Does not start a daemon, continuous loop, or wakeup.",
    promptSnippet: "Idle briefly or with long_idle while waiting for a background child when no other TODO is actionable.",
    parameters: AwaitDelegationRunParams,
    async execute(_toolCallId, params) {
      const reply = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });
      const waitMode = params.wait_mode === "long_idle" ? "long_idle" : "brief";
      const maxTimeoutMs = waitMode === "long_idle" ? 300_000 : 30_000;
      const requestedTimeoutMs = Math.floor(params.timeout_ms ?? 5_000);
      const timeoutMs = Math.max(25, Math.min(maxTimeoutMs, Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : 5_000));
      const includeResult = params.include_result !== false;
      const awaitMeta = { waitMode, timeoutMs, maxTimeoutMs };
      const compactResult = (result: ChildResult) => ({
        agent: result.agent,
        exitCode: result.exitCode,
        status: isFailed(result) ? "failed" : "complete",
        outputHash: result.output ? sha256(result.output) : undefined,
        outputContract: result.outputContract,
        gatePassed: result.gatePassed,
        gateErrors: result.gateErrors ?? [],
        failureKind: result.failureKind,
        stopReason: result.stopReason,
        stopCondition: result.stopCondition,
        cwd: result.cwd,
        sessionPath: result.sessionPath,
      });
      const resultDetails = (result: ChildResult) => includeResult ? { result } : { resultSummary: compactResult(result), resultIncluded: false };
      const background = state.backgroundDelegations.get(params.run_id);
      const existingRun = state.delegations.runs.find((candidate) => candidate.id === params.run_id);
      if (!background) {
        const status = existingRun?.status ?? "not_found";
        return reply(`await_delegation_run ${params.run_id}: ${status}`, { schema: "zob.delegation-await.v1", runId: params.run_id, status, timedOut: false, ...awaitMeta, run: existingRun });
      }
      if (background.result) return reply(`await_delegation_run complete: ${params.run_id}`, { schema: "zob.delegation-await.v1", runId: params.run_id, status: "complete", timedOut: false, ...awaitMeta, ...resultDetails(background.result) });
      if (background.error) return reply(`await_delegation_run failed: ${params.run_id}`, { schema: "zob.delegation-await.v1", runId: params.run_id, status: "failed", timedOut: false, ...awaitMeta, error: background.error });
      let timedOut = false;
      try {
        const result = await Promise.race([
          background.promise,
          new Promise<undefined>((resolve) => setTimeout(() => { timedOut = true; resolve(undefined); }, timeoutMs)),
        ]);
        if (timedOut || !result) return reply(`await_delegation_run timeout: ${params.run_id}`, { schema: "zob.delegation-await.v1", runId: params.run_id, status: "running", timedOut: true, ...awaitMeta, run: state.delegations.runs.find((candidate) => candidate.id === params.run_id) });
        background.result = result;
        return reply(`await_delegation_run complete: ${params.run_id}`, { schema: "zob.delegation-await.v1", runId: params.run_id, status: "complete", timedOut: false, ...awaitMeta, ...resultDetails(result) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        background.error = message;
        return reply(`await_delegation_run failed: ${params.run_id}`, { schema: "zob.delegation-await.v1", runId: params.run_id, status: "failed", timedOut: false, ...awaitMeta, error: message });
      }
    },
  });

}
