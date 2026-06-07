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

export function appendLedgerFile(repoRoot: string, entry: Record<string, unknown>): void {
  const dir = join(repoRoot, ".pi", "logs", "runs");
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
}

export function asDelegationDetails(value: unknown): DelegationDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Partial<DelegationDetails>;
  if ((details.mode !== "single" && details.mode !== "parallel" && details.mode !== "chain") || !Array.isArray(details.results)) return undefined;
  return { mode: details.mode, results: details.results, agents: Array.isArray(details.agents) ? details.agents : [] };
}

export function delegationLedgerMeta(source: "delegate_agent" | "delegate_task", parentToolCallId: string | undefined, delegationMode: DelegationRunMode, index?: number): Record<string, unknown> {
  return { source, parentToolCallId, delegationMode, index };
}

export function delegationCallLabel(args: { agent?: string; task?: string; tasks?: Array<{ agent: string }>; chain?: Array<{ agent: string }> }): string {
  if (args.agent && args.task) return `single → ${args.agent}`;
  if (args.tasks && args.tasks.length > 0) return `parallel ×${args.tasks.length} → ${args.tasks.map((task) => task.agent).join(", ")}`;
  if (args.chain && args.chain.length > 0) return `chain ×${args.chain.length} → ${args.chain.map((step) => step.agent).join(" → ")}`;
  return "invalid parameters";
}

export function classifyConfigOrPreflight(errors: string[]): DelegationFailureKind {
  return errors.some((error) => /unknown agent|unknown output contract|available:/i.test(error)) ? "config" : "preflight";
}

export function toolsEnableWrites(tools: string[] | undefined): boolean {
  return Boolean(tools?.some((tool) => tool === "edit" || tool === "write"));
}

export function captureChildDirtyDelta(repoRoot: string, pathPolicy: { allowedPaths?: string[]; forbiddenPaths?: string[] }, before: ReturnType<typeof captureZcommitChildDirtySnapshot> | undefined): ZcommitChildChangedPathRef[] {
  if (!before) return [];
  const after = captureZcommitChildDirtySnapshot(repoRoot, pathPolicy);
  return diffZcommitChildDirtySnapshots(before, after);
}

export function classifyChildFailure(result: ChildResult): DelegationFailureKind | undefined {
  if (result.stopReason === "aborted") return "aborted";
  if (result.exitCode !== 0 || result.stopReason === "error") return "child_runtime";
  if (result.gatePassed === false) return "output_gate";
  return undefined;
}

export function delegateTaskPreflightHelp(errors: string[]): string {
  const base = `Delegation preflight failed (no child launched):\n- ${errors.join("\n- ")}`;
  const aliasHint = errors.some((error) => /delegate_task field|Conflicting delegate_task fields/i.test(error))
    ? "\n\nHow to fix structured fields: use canonical JSON keys expected_outcome, must_do, must_not_do, original_user_ask, allowed_paths, forbidden_paths, required_tools, output_contract, run_in_background, child_goal, load_skills; safe aliases such as expectedOutcome, mustDo, mustNotDo/must_not/mustNot, originalUserAsk, allowedPaths, forbiddenPaths, requiredTools, outputContract, runInBackground, childGoal, loadSkills are accepted only when they do not conflict."
    : "";
  const missingOriginalUserAsk = errors.some((error) => /ORIGINAL_USER_ASK\/original_user_ask is required/i.test(error));
  if (!missingOriginalUserAsk) return `${base}${aliasHint}`;
  return `${base}${aliasHint}\n\nHow to fix: retry delegate_task with top-level original_user_ask set to the original human request. Putting it only in context or task text is not enough for write-enabled delegations with edit/write tools.`;
}

export function childFailureMessage(kind: DelegationFailureKind | undefined, gateErrors: string[] | undefined, errorMessage: string | undefined): string | undefined {
  if (kind === "output_gate") return `Output contract gate failed; format repair may be enough. Gate errors: ${(gateErrors ?? []).join("; ") || "unknown"}`;
  if (kind === "child_runtime") return errorMessage ?? "Child runtime failed before a valid gated output was produced";
  if (kind === "aborted") return "Child agent aborted";
  return errorMessage;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(leftRecord[key], rightRecord[key]));
}

export function normalizeDelegateTaskParams(input: DelegateTaskAliasInput): { params: DelegateTaskCanonicalInput; errors: string[] } {
  const errors: string[] = [];
  const knownKeys = new Set<keyof DelegateTaskAliasInput>(["agent", "task", "expected_outcome", "expectedOutcome", "required_tools", "requiredTools", "must_do", "mustDo", "must_not_do", "mustNotDo", "must_not", "mustNot", "context", "original_user_ask", "originalUserAsk", "allowed_paths", "allowedPaths", "forbidden_paths", "forbiddenPaths", "output_contract", "outputContract", "child_goal", "childGoal", "run_in_background", "runInBackground", "load_skills", "loadSkills", "cwd", "scope", "model", "thinking"]);
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key as keyof DelegateTaskAliasInput)) errors.push(`Unknown delegate_task field '${key}'; use canonical JSON keys or the documented safe aliases only`);
  }
  const pick = <T>(canonical: keyof DelegateTaskAliasInput, aliases: Array<keyof DelegateTaskAliasInput>, required = false): T | undefined => {
    const entries = [canonical, ...aliases]
      .map((key) => ({ key, value: input[key] }))
      .filter((entry) => entry.value !== undefined);
    if (entries.length === 0) {
      if (required) errors.push(`Missing required delegate_task field '${String(canonical)}' after alias normalization`);
      return undefined;
    }
    const first = entries[0];
    for (const entry of entries.slice(1)) {
      if (!deepEqual(first.value, entry.value)) errors.push(`Conflicting delegate_task fields '${String(first.key)}' and '${String(entry.key)}'; use canonical '${String(canonical)}' or matching aliases only`);
    }
    return first.value as T;
  };

  return {
    params: {
      agent: input.agent,
      task: input.task,
      expected_outcome: pick<string>("expected_outcome", ["expectedOutcome"], true) ?? "",
      required_tools: pick<string[]>("required_tools", ["requiredTools"]),
      must_do: pick<string[]>("must_do", ["mustDo"], true) ?? [],
      must_not_do: pick<string[]>("must_not_do", ["mustNotDo", "must_not", "mustNot"], true) ?? [],
      context: input.context,
      original_user_ask: pick<string>("original_user_ask", ["originalUserAsk"]),
      allowed_paths: pick<string[]>("allowed_paths", ["allowedPaths"]),
      forbidden_paths: pick<string[]>("forbidden_paths", ["forbiddenPaths"]),
      output_contract: pick<string>("output_contract", ["outputContract"]),
      child_goal: pick<ChildGoalInput>("child_goal", ["childGoal"]),
      run_in_background: pick<boolean>("run_in_background", ["runInBackground"]),
      load_skills: pick<string[]>("load_skills", ["loadSkills"]),
      cwd: input.cwd,
      scope: input.scope,
      model: input.model,
      thinking: input.thinking,
    },
    errors,
  };
}

export function childGoalGuidance(childGoal: ChildGoalInput | undefined, parentGoalId: string | undefined, runId: string): string[] {
  if (!childGoal || childGoal.enabled === false || !childGoal.objective?.trim()) return [];
  const childGoalId = parentGoalId ? `child:${parentGoalId}:${runId}` : `child:${runId}`;
  return [
    "ZOB CHILD GOAL:",
    `- CHILD_GOAL_ID: ${childGoalId}`,
    `- OBJECTIVE: ${childGoal.objective.trim()}`,
    childGoal.todo_id ? `- TODO_ID: ${childGoal.todo_id}` : undefined,
    childGoal.parent_todo_id ? `- PARENT_TODO_ID: ${childGoal.parent_todo_id}` : undefined,
    childGoal.todo_path ? `- TODO_PATH: ${childGoal.todo_path}` : undefined,
    childGoal.delegation_depth !== undefined ? `- DELEGATION_DEPTH: ${childGoal.delegation_depth}` : undefined,
    childGoal.request_id ? `- REQUEST_ID: ${childGoal.request_id}` : undefined,
    `- ORACLE_REQUIRED: ${childGoal.oracle_required !== false}`,
    `- MAX_TURNS: ${childGoal.max_turns ?? "parent-managed"}`,
    `- MAX_TOKENS: ${childGoal.max_tokens ?? "parent-managed"}`,
    `- COMPLETION_POLICY: ${childGoal.completion_policy ?? "return_claim"}`,
    childGoal.agentic_validation?.mode ? `- AGENTIC_VALIDATION: ${childGoal.agentic_validation.mode}` : undefined,
    childGoal.agentic_validation?.mode === "oracle_then_auto_accept" ? `- ORACLE_VALIDATION_AGENT: ${childGoal.agentic_validation.oracle_agent ?? "oracle"}` : undefined,
    "- Do not claim global goal completion. Return a child completion claim for parent/oracle review.",
    "- Required child exit field: child_goal_status: ready_for_oracle | incomplete | blocked",
    "- Required child claim fields when ready_for_oracle: evidence_refs, validation_commands, risks, no_ship.",
    "- Child no_ship is advisory/readiness evidence: parent/oracle decides review_no_ship and the runtime computes hard_no_ship/effective_no_ship.",
    childGoal.todo_id ? "- This is a TODO-linked child goal. Do not mark the parent TODO done directly; return TODO_CHILD_RESULT.v2 (v1 remains accepted) fields for parent acceptance." : undefined,
    childGoal.todo_id ? "- TODO_CHILD_RESULT.v2 should include acceptance_blockers and target_readiness: ready_for_parent_acceptance | needs_parent_review | blocked." : undefined,
    childGoal.todo_id ? "- Do not run multiple write-capable workers on this same leaf TODO. If parallel work is needed, ask the parent to split the TODO into subtodos/XDEF leaves and delegate separate leaves/workspaces." : undefined,
    childGoal.todo_id ? "- If explicitly operating under compute high/xhigh/max and this TODO is too broad for your scope/context, return TODO_SPLIT_REQUEST.v1 instead of forcing a poor completion; parent will decide/apply any split." : undefined,
    childGoal.todo_id ? "- TODO_SPLIT_REQUEST.v1 must include deliverable_delivered: yes, todo_id, reason, recommended_action, proposed_subtodos, risk_level, validation_plan, evidence, risks_blockers, no_ship, compliance, and FINAL_MARKER: TODO_SPLIT_REQUEST_END." : undefined,
    childGoal.agentic_validation?.mode === "oracle_then_auto_accept" ? "- After your claim returns, the parent runtime may launch an oracle validation child and auto-accept only on PASS/no_ship=false." : undefined,
    "- Parent/oracle decides acceptance; child must not call update_goal for the parent goal.",
    "",
  ].filter((line): line is string => typeof line === "string");
}

export function appendChildGoalToTask(task: string, childGoal: ChildGoalInput | undefined, parentGoalId: string | undefined, runId: string): string {
  const guidance = childGoalGuidance(childGoal, parentGoalId, runId);
  return guidance.length > 0 ? `${guidance.join("\n")}\n${task}` : task;
}

export function resolveChildGoalTodoRef(state: HarnessRuntimeState, childGoal: ChildGoalInput | undefined): { childGoal: ChildGoalInput | undefined; errors: string[]; node?: GoalTodoNode } {
  if (!childGoal) return { childGoal, errors: [] };
  if (!childGoal.todo_id && !childGoal.todo_path) return { childGoal, errors: [] };
  const goalId = state.runtimeGoal?.goalId;
  const primaryRef = childGoal.todo_id ?? childGoal.todo_path;
  let resolution = resolveGoalTodoReference(state.goalTodos, goalId, primaryRef, childGoal.todo_id ? "child_goal.todo_id" : "child_goal.todo_path", { requireDelegatable: true });
  if (childGoal.todo_id && childGoal.todo_path && !resolution.node) {
    const pathResolution = resolveGoalTodoReference(state.goalTodos, goalId, childGoal.todo_path, "child_goal.todo_path", { requireDelegatable: true });
    if (pathResolution.node && pathResolution.errors.length === 0) resolution = pathResolution;
  }
  const errors = [...resolution.errors];
  if (childGoal.delegation_depth !== undefined && childGoal.delegation_depth > state.goalTodos.policy.maxDelegationDepth) errors.push(`child_goal.delegation_depth exceeds maxDelegationDepth=${state.goalTodos.policy.maxDelegationDepth}`);
  if (!resolution.node || errors.length > 0) return { childGoal: { ...childGoal, todo_id: undefined }, errors };
  return {
    childGoal: {
      ...childGoal,
      todo_id: resolution.node.id,
      todo_path: childGoal.todo_path ?? resolution.node.path,
    },
    errors,
    node: resolution.node,
  };
}

export function linkChildGoalTodoDelegationIfReady(pi: ExtensionAPI, state: HarnessRuntimeState, childGoal: ChildGoalInput | undefined, runId: string, agent?: string): void {
  const goalId = state.runtimeGoal?.goalId;
  if (!goalId || !childGoal?.todo_id) return;
  if (!state.goalTodos.nodes.some((node) => node.goalId === goalId && node.id === childGoal.todo_id)) return;
  linkGoalTodoDelegation(pi, state, goalId, childGoal.todo_id, { runId, agent, requestId: childGoal.request_id, delegationDepth: childGoal.delegation_depth }, "delegation");
}

export function retargetTodoSplitRequestResult(result: ChildResult, childGoal: ChildGoalInput | undefined, repoRoot: string): void {
  const todoId = childGoal?.todo_id;
  if (!todoId) return;
  const splitRequest = extractTodoSplitRequestFromText(result.output || result.stderr || "");
  if (!isActionableTodoSplitRequest(splitRequest, todoId)) return;
  const previousContract = result.outputContract;
  const previousGatePassed = result.gatePassed;
  const previousGateErrors = result.gateErrors;
  result.outputContract = "todo-split-request.v1";
  result.gatePassed = undefined;
  result.gateErrors = undefined;
  applyChildGates(result, { repoRoot });
  if (result.gatePassed !== true) {
    result.outputContract = previousContract;
    result.gatePassed = previousGatePassed;
    result.gateErrors = previousGateErrors;
  }
}

export function recordTodoClaimFromChildResult(pi: ExtensionAPI, state: HarnessRuntimeState, childGoal: ChildGoalInput | undefined, result: ChildResult, meta: { runId?: string; outputHash?: string } = {}): { goalId?: string; todoId?: string; claimHash?: string; validReadyClaim: boolean; node?: GoalTodoNode; splitApplied?: boolean } {
  const goalId = state.runtimeGoal?.goalId;
  const todoId = childGoal?.todo_id;
  if (!goalId || !todoId) return { validReadyClaim: false };
  const text = result.output || result.stderr || "";
  const splitRequest = extractTodoSplitRequestFromText(text);
  if (isActionableTodoSplitRequest(splitRequest, todoId) && result.gatePassed === true && result.outputContract === "todo-split-request.v1") {
    try {
      applyTodoSplitRequest(pi, state, goalId, todoId, splitRequest, "delegation");
      return { goalId, todoId, validReadyClaim: false, splitApplied: true };
    } catch (error) {
      const node = returnGoalTodoClaim(pi, state, goalId, todoId, {
        claimText: `TODO_SPLIT_REQUEST handling failed: ${error instanceof Error ? error.message : String(error)}`,
        evidenceRefs: [],
        validationCommands: [],
        noShip: true,
        runId: meta.runId,
        outputHash: meta.outputHash,
        outputContract: result.outputContract,
        gatePassed: result.gatePassed,
        childChangedPaths: result.childChangedPaths ?? [],
      }, "delegation");
      return { goalId, todoId, claimHash: node?.claim?.claimHash, validReadyClaim: false, node };
    }
  }
  const peerResult = extractTodoPeerResultFromText(text);
  if (peerResult.contract) {
    const peerItem = peerResult.items.find((item) => item.todoId === todoId);
    const peerBlockers = [
      ...(!peerResult.hasFinalMarker ? ["missing_final_marker"] : []),
      ...(peerItem ? [] : [`mismatched_todo_id:${todoId}`]),
      ...(peerItem?.statusClaim ? [] : ["missing_status_claim"]),
      ...(peerItem?.statusClaim === "done" && peerItem.evidenceRefs.length === 0 && peerItem.validationCommands.length === 0 ? ["missing_evidence_for_done"] : []),
      ...(peerItem?.noShip === true ? ["no_ship_true"] : []),
      ...(peerItem?.acceptanceBlockers ?? []),
      ...(peerItem?.risks ?? []).map((risk) => `risk:${risk}`),
    ];
    const peerStatusClaim = peerItem?.statusClaim ?? "blocked";
    const validReadyClaim = !isFailed(result)
      && Boolean(peerItem)
      && peerResult.hasFinalMarker
      && peerStatusClaim === "done"
      && (peerItem!.evidenceRefs.length > 0 || peerItem!.validationCommands.length > 0)
      && peerItem!.noShip !== true
      && peerBlockers.length === 0;
    const node = returnGoalTodoClaim(pi, state, goalId, todoId, {
      claimText: text || `peer returned no ${peerResult.contract} body`,
      evidenceRefs: peerItem?.evidenceRefs ?? [],
      validationCommands: peerItem?.validationCommands ?? [],
      noShip: validReadyClaim ? false : true,
      runId: meta.runId,
      outputHash: meta.outputHash,
      outputContract: peerResult.contract,
      gatePassed: result.gatePassed === true && validReadyClaim,
      childGoalStatus: validReadyClaim ? "ready_for_oracle" : peerStatusClaim === "blocked" ? "blocked" : "incomplete",
      statusClaim: peerStatusClaim,
      targetReadiness: validReadyClaim ? "ready_for_parent_acceptance" : peerStatusClaim === "blocked" ? "blocked" : "needs_parent_review",
      acceptanceBlockers: [...new Set(peerBlockers)],
      childChangedPaths: result.childChangedPaths ?? [],
    }, "delegation");
    return { goalId, todoId, claimHash: node?.claim?.claimHash, validReadyClaim, node };
  }
  const claim = extractTodoClaimFromText(text);
  const validReadyClaim = !isFailed(result)
    && claim.todoId === todoId
    && claim.childGoalStatus === "ready_for_oracle"
    && claim.statusClaim === "done"
    && claim.hasFinalMarker
    && (claim.evidenceRefs.length > 0 || claim.validationCommands.length > 0)
    && claim.noShip !== true;
  const childBlockers = [
    ...(!claim.hasFinalMarker ? ["missing_final_marker"] : []),
    ...(claim.todoId && claim.todoId !== todoId ? [`mismatched_todo_id:${claim.todoId}`] : []),
    ...(claim.statusClaim === "done" && claim.evidenceRefs.length === 0 && claim.validationCommands.length === 0 ? ["missing_evidence_for_done"] : []),
    ...(claim.noShip === true ? ["no_ship_true"] : []),
    ...claim.acceptanceBlockers,
  ];
  const node = returnGoalTodoClaim(pi, state, goalId, todoId, {
    claimText: text || "child returned no TODO_CHILD_RESULT.v1/v2 claim",
    evidenceRefs: claim.evidenceRefs,
    validationCommands: claim.validationCommands,
    noShip: validReadyClaim ? false : true,
    runId: meta.runId,
    outputHash: meta.outputHash,
    outputContract: result.outputContract,
    gatePassed: result.gatePassed,
    childGoalStatus: claim.childGoalStatus,
    statusClaim: claim.statusClaim,
    targetReadiness: claim.targetReadiness,
    acceptanceBlockers: [...new Set(childBlockers)],
    childChangedPaths: result.childChangedPaths ?? [],
  }, "delegation");
  return { goalId, todoId, claimHash: node?.claim?.claimHash, validReadyClaim, node };
}

export function shouldRunAgenticClaimValidation(childGoal: ChildGoalInput | undefined, claimRecord: { validReadyClaim: boolean; node?: GoalTodoNode; splitApplied?: boolean }): boolean {
  const settings = childGoal?.agentic_validation;
  if (!settings || settings.mode !== "oracle_then_auto_accept") return false;
  if (claimRecord.splitApplied || !claimRecord.validReadyClaim || !claimRecord.node?.claim) return false;
  if (claimRecord.node.claim.noShip === true) return false;
  return true;
}

export function formatTodoClaimValidationTask(node: GoalTodoNode, childGoal: ChildGoalInput | undefined): string {
  const claim = node.claim;
  const validationCommands = node.validationCommands.length > 0 ? node.validationCommands.join("\n- ") : "none";
  const evidenceRefs = node.evidenceRefs.length > 0 ? node.evidenceRefs.join("\n- ") : "none";
  const criteria = node.acceptanceCriteria.length > 0 ? node.acceptanceCriteria.join("\n- ") : "none provided";
  const allowedPaths = childGoal?.todo_id ? "Use only repo-local evidence refs, acceptance criteria, and bounded validation commands relevant to this TODO." : "Use bounded repo-local evidence only.";
  return [
    `1. TASK: Validate returned delegated /goal TODO claim ${node.id} without mutating parent-owned TODO state.`,
    "2. EXPECTED OUTCOME: A strict todo-claim-validation.v1 verdict that parent runtime can parse; PASS/no_ship=false/accept_claim only if evidence proves the TODO claim is safe to accept.",
    "3. REQUIRED TOOLS: read, grep, find, ls, bash",
    "4. MUST DO:",
    `- Verify TODO title: ${node.title}`,
    `- Verify acceptance criteria:\n- ${criteria}`,
    `- Inspect evidence_refs from the claim:\n- ${evidenceRefs}`,
    `- Check validation_commands from the claim when safe/non-destructive:\n- ${validationCommands}`,
    "- Treat missing evidence, unsafe commands, failed checks, mismatched todo_id/claim_hash, or unresolved blockers as WARN/FAIL with no_ship=true unless clearly non-blocking.",
    "- Return recommended_action=accept_claim only with verdict=PASS, no_ship=false, confidence HIGH or MEDIUM, and no blocking issues.",
    "- Return exactly the todo-claim-validation.v1 fields and final marker.",
    "5. MUST NOT DO:",
    "- Do not edit files, commit, call parent goal/TODO tools, or mark the TODO done.",
    "- Do not inspect secrets, environment files, keys, or credential stores.",
    "- Do not accept on assertion alone; require concrete repo evidence or command results.",
    "6. CONTEXT:",
    `- goal_id: ${node.goalId}`,
    `- todo_id: ${node.id}`,
    `- todo_path: ${node.path}`,
    `- owner/status: ${node.owner}/${node.status}`,
    `- claim_hash: ${claim?.claimHash ?? "missing"}`,
    `- claim_output_hash: ${claim?.outputHash ?? "none"}`,
    `- claim_output_contract: ${claim?.outputContract ?? "unknown"}`,
    `- claim_gate_passed: ${claim?.gatePassed === true}`,
    `- child_goal_status: ${claim?.childGoalStatus ?? "unknown"}`,
    `- status_claim: ${claim?.statusClaim ?? "unknown"}`,
    `- target_readiness: ${claim?.targetReadiness ?? "unknown"}`,
    `- acceptance_blockers: ${(claim?.acceptanceBlockers ?? []).join("; ") || "none"}`,
    `- claim_no_ship: ${claim?.noShip === true}`,
    `- ${allowedPaths}`,
    "OUTPUT_CONTRACT: todo-claim-validation.v1",
    ...finalFormatGuidance("todo-claim-validation.v1"),
  ].join("\n");
}

export async function runAgenticTodoClaimValidation(input: {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  state: HarnessRuntimeState;
  childGoal: ChildGoalInput | undefined;
  claimRecord: { goalId?: string; todoId?: string; node?: GoalTodoNode; claimHash?: string };
  parentRunId: string;
  appendDelegationLedger: (entry: Record<string, unknown>) => void;
  signal?: AbortSignal;
  modelOverride?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
}): Promise<void> {
  const { ctx, pi, state, childGoal, claimRecord, parentRunId, appendDelegationLedger, signal, modelOverride, allowedPaths, forbiddenPaths } = input;
  const goalId = claimRecord.goalId;
  const todoId = claimRecord.todoId;
  const node = claimRecord.node;
  if (!goalId || !todoId || !node?.claim) return;
  const settings = childGoal?.agentic_validation;
  const agentName = settings?.oracle_agent ?? "oracle";
  const agents = discoverAgents(ctx.cwd, "both");
  const agent = agents.find((candidate) => candidate.name.toLowerCase() === agentName.toLowerCase());
  const validationRunId = newRunId("todo_claim_validation");
  try {
    requestGoalTodoClaimValidation(pi, state, goalId, todoId, { runId: validationRunId, agent: agentName }, "delegation");
  } catch (error) {
    appendDelegationLedger({ event: "todo_claim_validation_request_failed", parentRunId, runId: validationRunId, goalId, todoId, errorHash: sha256(error instanceof Error ? error.message : String(error)), at: new Date().toISOString() });
    return;
  }
  appendDelegationLedger({ event: "todo_claim_validation_start", parentRunId, runId: validationRunId, goalId, todoId, agent: agentName, claimHash: node.claim.claimHash, at: new Date().toISOString() });
  let result: ChildResult;
  if (!agent) {
    result = { agent: agentName, task: "todo_claim_validation", exitCode: 1, output: "", stderr: "", usage: usageEmpty(), failureKind: "config", errorMessage: "Configuration blocked; no child launched: unknown oracle validation agent" };
  } else {
    result = await runChildAgent(
      ctx,
      agent,
      formatTodoClaimValidationTask(node, childGoal),
      ctx.cwd,
      signal,
      modelOverride,
      undefined,
      undefined,
      { allowedPaths, forbiddenPaths },
    );
    result.outputContract = settings?.output_contract ?? "todo-claim-validation.v1";
    applyChildGates(result, { repoRoot: ctx.cwd });
    result.failureKind = classifyChildFailure(result);
  }
  const outputHash = result.output ? sha256(result.output) : undefined;
  let parsed = extractTodoClaimValidationFromText(result.output || result.stderr || "");
  if (!isActionableTodoClaimValidation(parsed, todoId, node.claim.claimHash) || isFailed(result)) {
    parsed = {
      todoId,
      claimHash: node.claim.claimHash,
      verdict: "FAIL",
      recommendedAction: "block",
      evidenceRefs: [],
      validationCommands: [],
      blockingIssues: [result.gateErrors?.join("; ") || result.errorMessage || "oracle validation did not return an actionable PASS/WARN/FAIL claim validation"],
      noShip: true,
      confidence: "LOW",
      hasFinalMarker: false,
    };
  }
  try {
    recordGoalTodoClaimValidationResult(pi, state, goalId, todoId, {
      result: parsed,
      runId: validationRunId,
      agent: agentName,
      outputHash,
      autoAccept: settings?.auto_accept_on_pass !== false,
      repoRoot: ctx.cwd,
    }, "delegation");
  } catch (error) {
    appendDelegationLedger({ event: "todo_claim_validation_record_failed", parentRunId, runId: validationRunId, goalId, todoId, errorHash: sha256(error instanceof Error ? error.message : String(error)), at: new Date().toISOString() });
  }
  appendDelegationLedger({
    event: "todo_claim_validation_end",
    parentRunId,
    runId: validationRunId,
    goalId,
    todoId,
    agent: agentName,
    claimHash: node.claim.claimHash,
    outputHash,
    gatePassed: result.gatePassed,
    verdict: parsed.verdict,
    noShip: parsed.noShip,
    recommendedAction: parsed.recommendedAction,
    autoAcceptRequested: settings?.auto_accept_on_pass !== false,
    status: parsed.verdict === "PASS" && parsed.noShip !== true ? "passed" : "blocked",
    at: new Date().toISOString(),
  });
}

export function finalFormatGuidance(outputContract: string): string[] {
  if (outputContract === "implement.v1") return [
    "FINAL FORMAT (implement.v1):",
    "- gap_verdict: SUFFICIENT or GAP, with no-change evidence or exact missing behavior",
    "- changed_files: paths changed, or no-change evidence",
    "- verification_commands: exact commands run",
    "- results: exact command outcomes",
    "- evidence: concise proof",
    "- risks/blockers: unresolved risks",
    "- compliance: forbidden zones respected, no commits",
    "- final line must be exactly: deliverable_delivered: yes",
  ];
  if (outputContract === "qa.v1") return [
    "FINAL FORMAT (qa.v1):",
    "- verdict: PASS / FAIL / WARN / INCONCLUSIVE",
    "- commands: exact command, cwd, and exit code",
    "- important output: stdout/stderr excerpts or artifact evidence",
    "- reproduction: steps to reproduce",
    "- evidence: concrete verification evidence",
    "- risks/blockers: unresolved risks",
    "- compliance: read-only QA; forbidden zones respected; no commits",
    "- final line must be exactly: deliverable_delivered: yes",
  ];
  if (outputContract === "todo-child-result.v1" || outputContract === "todo-child-result.v2") return [
    `FINAL FORMAT (${outputContract}):`,
    "- deliverable_delivered: yes/no",
    "- todo_id: exact parent TODO id",
    "- child_goal_status: ready_for_oracle | incomplete | blocked",
    "- status_claim: done | incomplete | blocked",
    "- evidence_refs: safe repo-relative evidence refs",
    "- validation_commands: commands run, or none",
    "- risks_blockers: unresolved risks",
    ...(outputContract === "todo-child-result.v2" ? ["- acceptance_blockers: blockers parent must resolve before accepting, or none", "- target_readiness: ready_for_parent_acceptance | needs_parent_review | blocked"] : []),
    "- no_ship: true/false (advisory/readiness evidence for parent review; deliverable_delivered=yes still returns a claim)",
    "- subtodo_delta_proposals: metadata-only subtodo proposals, or none",
    "- compliance: parent-owned claim only; no parent completion",
    `- final line must be exactly: FINAL_MARKER: ${outputContract === "todo-child-result.v2" ? "TODO_CHILD_RESULT_V2_END" : "TODO_CHILD_RESULT_END"}`,
  ];
  if (outputContract === "todo-claim-validation.v1") return [
    "FINAL FORMAT (todo-claim-validation.v1):",
    "- deliverable_delivered: yes",
    "- todo_id: exact parent TODO id",
    "- claim_hash: exact returned claim hash under review",
    "- verdict: PASS | WARN | FAIL",
    "- recommended_action: accept_claim | needs_review | reject_claim | block",
    "- evidence_refs: safe repo-relative evidence refs inspected, or none",
    "- validation_commands: commands run/checked, or none",
    "- blocking_issues: blockers, or none",
    "- no_ship: true/false",
    "- confidence: LOW | MEDIUM | HIGH",
    "- evidence: concise oracle proof; no raw secrets",
    "- risks_blockers: unresolved risks",
    "- compliance: oracle validation only; no parent TODO mutation by child",
    "- final line must be exactly: FINAL_MARKER: TODO_CLAIM_VALIDATION_END",
  ];
  if (outputContract === "todo-split-request.v1") return [
    "FINAL FORMAT (todo-split-request.v1):",
    "- deliverable_delivered: yes",
    "- todo_id: exact parent TODO id",
    "- reason: why the TODO exceeds this child scope/context",
    "- recommended_action: split | replan | factory | needs_user | blocked",
    "- proposed_subtodos: metadata-only bullet list of bounded child TODO titles",
    "- risk_level: low | medium | high",
    "- validation_plan: commands/evidence each child should provide, or none",
    "- evidence: why this split/replan request is justified",
    "- risks_blockers: unresolved risks",
    "- no_ship: true/false",
    "- compliance: parent-owned split request only; no child dispatch or parent TODO mutation",
    "- final line must be exactly: FINAL_MARKER: TODO_SPLIT_REQUEST_END",
  ];
  if (["delegation-request.v1", "oracle-request.v1", "context-request.v1"].includes(outputContract)) {
    const requestType = outputContract === "oracle-request.v1" ? "ORACLE_REQUEST.v1" : outputContract === "context-request.v1" ? "CONTEXT_REQUEST.v1" : "DELEGATION_REQUEST.v1";
    const finalMarker = requestType.replace(".v1", "_END");
    return [
      `FINAL FORMAT (${outputContract}):`,
      "- deliverable_delivered: yes",
      `- request_type: ${requestType}`,
      "- request_id: path-safe unique id",
      "- goal_id: parent goal id if known",
      "- todo_id: parent TODO id if known",
      "- requested_by: your team role id",
      "- requested_action: concise action label only; no raw prompt/body",
      "- priority: low | normal | high | critical",
      "- risk_level: low | medium | high",
      "- body_hash: sha256 hash of the transient request body; do not include raw body/text/prompt/output/content",
      "- agent: target agent role/name if delegation-request.v1, else none",
      "- required_tools: comma-separated tool names or none",
      "- allowed_paths: repo-relative-only paths or none (use reports/... snapshot/context_ref refs for external context)",
      "- forbidden_paths: deny-only paths or none",
      "- context_scope_id: context scope id if context-request.v1, else none",
      "- evidence_refs: safe repo-relative evidence refs or none",
      "- artifact_refs: safe repo-relative artifact refs or none",
      "- no_ship: true/false",
      "- evidence: hash-only/request evidence summary; no secrets/raw bodies",
      "- risks_blockers: unresolved risks",
      "- compliance: governed request only; no child direct dispatch, no parent TODO mutation, parent/governor decides",
      `- final line must be exactly: FINAL_MARKER: ${finalMarker}`,
    ];
  }
  return [
    "FINAL FORMAT:",
    "- result",
    "- evidence",
    "- risks/blockers",
    "- compliance line",
    "- final line must be exactly: deliverable_delivered: yes",
  ];
}

export function hydrateDelegationRunsFromDetails(source: "delegate_agent" | "delegate_task", details: DelegationDetails | undefined, state: HarnessRuntimeState, toolCallId: string | undefined): void {
  if (!details?.results?.length) return;
  const nowMs = Date.now();
  for (const [index, result] of details.results.entries()) {
    if (!result.ledgerRunId) continue;
    const existing = state.delegations.runs.find((run) => run.id === result.ledgerRunId);
    if (!existing) {
      startDelegationRun(state.delegations, {
        id: result.ledgerRunId,
        parentToolCallId: toolCallId ?? result.ledgerRunId,
        source,
        mode: details.mode,
        index,
        agent: result.agent,
        task: result.task || "restored from delegate tool result",
        startedAtMs: nowMs - Math.max(1, index + 1),
      });
    }
    finishDelegationRun(state.delegations, result.ledgerRunId, {
      parentToolCallId: toolCallId ?? existing?.parentToolCallId ?? result.ledgerRunId,
      source,
      mode: details.mode,
      index,
      agent: result.agent,
      model: result.model,
      status: result.stopReason === "aborted" ? "aborted" : isFailed(result) ? "failed" : "complete",
      endedAtMs: existing?.endedAtMs ?? nowMs,
      outputPreview: result.output,
      stderrPreview: result.stderr,
      sessionPath: result.sessionPath,
      exitCode: result.exitCode,
      gatePassed: result.gatePassed,
      gateErrors: result.gateErrors,
      failureKind: result.failureKind,
      stopReason: result.stopReason,
      stopCondition: result.stopCondition,
      errorMessage: result.errorMessage,
      usage: result.usage,
    });
  }
}

export function agentSourcePath(repoRoot: string, filePath: string, source: "project" | "user"): string | undefined {
  if (source !== "project") return undefined;
  const path = relative(repoRoot, filePath).replace(/\\/g, "/");
  if (!path || path.startsWith("../") || path === "..") return undefined;
  return path;
}

export function buildDelegationCatalog(repoRoot: string, scope: AgentScope, includeContractRequirements = false): Record<string, unknown> {
  const agents = discoverAgents(repoRoot, scope).map((agent) => ({
    name: agent.name,
    description: agent.description,
    source: agent.source,
    sourcePath: agentSourcePath(repoRoot, agent.filePath, agent.source),
    tools: agent.tools ?? [],
    model: agent.model,
    thinking: agent.thinking,
    inferredOutputContract: inferOutputContract(agent.name),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const agentNames = new Set(agents.map((agent) => agent.name));
  const contractDefinitions = getOutputContractDefinitions();
  const validOutputContracts = includeContractRequirements
    ? contractDefinitions
    : listOutputContracts();
  const commonRouting = [
    { need: "read-only exploration / facts / file mapping", agent: "explore", outputContract: "explore.v1" },
    { need: "implementation plan / TDD sequence / handoff", agent: "planner", outputContract: "plan.v1" },
    { need: "source edit or bounded implementation", agent: "implementer", outputContract: "implement.v1" },
    { need: "skeptical audit / PASS-WARN-FAIL / no_ship", agent: "oracle", outputContract: "oracle.v1" },
    { need: "verification run / reproduction / QA verdict", agent: "qa", outputContract: "qa.v1" },
    { need: "sourced research / reusable context", agent: "librarian", outputContract: "research.v1" },
    { need: "specification from fuzzy request", agent: "specifier", outputContract: "spec.v1" },
    { need: "clarification gate before planning", agent: "clarifier", outputContract: "clarification.v1" },
    { need: "factory design", agent: "factory", outputContract: "factory.v1" },
  ].filter((hint) => agentNames.has(hint.agent));

  return {
    schema: "zob.delegation-catalog.v1",
    scope,
    agents,
    validOutputContracts,
    commonRouting,
    usageGuidance: {
      chooseAgentFirst: true,
      normallyOmitOutputContract: true,
      outputContractInference: "delegate_task infers output_contract from agent when omitted; delegate_agent always infers from agent.",
      doNotInventOutputContracts: true,
      ifUncertain: "Call zob_delegation_catalog before the first delegation or when agent/contract routing is ambiguous.",
      auditRouting: "For an audit/verdict/no_ship review, use oracle with oracle.v1; do not use planner plus a made-up audit.v1.",
      delegateTaskCanonicalFields: ["expected_outcome", "required_tools", "must_do", "must_not_do", "original_user_ask", "allowed_paths", "forbidden_paths", "output_contract", "run_in_background", "child_goal", "load_skills"],
      delegateTaskSafeAliases: { expected_outcome: ["expectedOutcome"], required_tools: ["requiredTools"], must_do: ["mustDo"], must_not_do: ["mustNotDo", "must_not", "mustNot"], original_user_ask: ["originalUserAsk"], allowed_paths: ["allowedPaths"], forbidden_paths: ["forbiddenPaths"], output_contract: ["outputContract"], run_in_background: ["runInBackground"], child_goal: ["childGoal"], load_skills: ["loadSkills"] },
    },
    noExecution: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function formatDelegationCatalogSummary(catalog: Record<string, unknown>): string {
  const agents = Array.isArray(catalog.agents) ? catalog.agents as Array<Record<string, unknown>> : [];
  const contracts = Array.isArray(catalog.validOutputContracts) ? catalog.validOutputContracts : [];
  const lines = [
    `zob_delegation_catalog: ${agents.length} agents, ${contracts.length} output contracts`,
    "Rule: normally omit delegate_task.output_contract; the harness infers it from agent.",
    "delegate_task canonical JSON keys: expected_outcome, required_tools, must_do, must_not_do, original_user_ask, allowed_paths, forbidden_paths, output_contract, run_in_background, child_goal, load_skills.",
    "Safe aliases are accepted only when non-conflicting: expectedOutcome, requiredTools, mustDo, mustNotDo/must_not/mustNot, originalUserAsk, allowedPaths, forbiddenPaths, outputContract, runInBackground, childGoal, loadSkills.",
    "If you need an audit/verdict/no_ship review, route to oracle/oracle.v1, not planner/audit.v1.",
    "",
    "Agents:",
    ...agents.map((agent) => `- ${agent.name} -> ${agent.inferredOutputContract} tools=${Array.isArray(agent.tools) ? agent.tools.join(",") || "default" : "default"}: ${agent.description ?? ""}`),
    "",
    `Valid output contracts: ${contracts.map((contract) => typeof contract === "string" ? contract : (contract as Record<string, unknown>).id).filter(Boolean).join(", ")}`,
  ];
  return lines.join("\n");
}

export function renderDelegationToolResultText(source: "delegate_agent" | "delegate_task", details: DelegationDetails | undefined, state: HarnessRuntimeState, toolCallId: string | undefined, isPartial: boolean, expanded: boolean, theme: { fg: (color: any, text: string) => string; bold: (text: string) => string }): string {
  hydrateDelegationRunsFromDetails(source, details, state, toolCallId);
  const nowMs = Date.now();
  const monitoredRuns = toolCallId ? state.delegations.runs.filter((run) => run.parentToolCallId === toolCallId) : [];
  const results = details?.results ?? [];
  const okCount = results.filter((result) => !isFailed(result)).length;
  const failCount = results.filter((result) => isFailed(result)).length;
  const blockedCount = results.filter((result) => result.failureKind === "preflight" || result.failureKind === "config").length;
  const gateCount = results.filter((result) => result.failureKind === "output_gate").length;
  const runtimeCount = results.filter((result) => result.failureKind === "child_runtime" || result.failureKind === "aborted").length;
  const runningCount = monitoredRuns.filter((run) => run.status === "queued" || run.status === "running").length;
  const mode = details?.mode ?? (source === "delegate_task" ? "single" : "single");
  const lines = [
    `${theme.fg("toolTitle", theme.bold(source))} ${theme.fg("accent", mode)} ${isPartial ? theme.fg("warning", "running") : theme.fg(failCount > 0 ? "error" : "success", `${okCount}/${results.length || monitoredRuns.length || 1} ok`)}`,
    `${theme.fg("dim", "running")} ${theme.fg(runningCount > 0 ? "warning" : "dim", String(runningCount))} ${theme.fg("dim", "blocked")} ${theme.fg(blockedCount > 0 ? "warning" : "dim", String(blockedCount))} ${theme.fg("dim", "gate")} ${theme.fg(gateCount > 0 ? "warning" : "dim", String(gateCount))} ${theme.fg("dim", "runtime")} ${theme.fg(runtimeCount > 0 ? "error" : "dim", String(runtimeCount))} ${theme.fg("dim", "details")} ${theme.fg("muted", "/zstatus delegations")}`,
  ];

  if (monitoredRuns.length > 0) {
    const maxRows = expanded ? 12 : 5;
    const visibleRuns = monitoredRuns.slice(0, maxRows);
    const hasMore = monitoredRuns.length > maxRows;
    for (const [index, run] of visibleRuns.entries()) {
      const color = run.status === "complete" ? "success" : run.status === "running" || run.status === "queued" || run.failureKind === "preflight" || run.failureKind === "config" || run.failureKind === "output_gate" ? "warning" : "error";
      const prefix = index === visibleRuns.length - 1 && !hasMore ? "└─" : "├─";
      const viewHint = delegateViewLink(run.id);
      const kind = run.failureKind ? ` ${run.failureKind}` : "";
      const badge = delegationSignalBadge(run);
      const badgeText = formatDelegationSignalBadge(badge);
      const modelLabel = formatDelegationModelLabel(run);
      const modelSuffix = modelLabel ? ` ${theme.fg("muted", `(${modelLabel})`)}` : "";
      lines.push(`${theme.fg("dim", prefix)} ${theme.fg(color, `${statusIcon(run.status)} ${run.agent}${kind}`)}${badgeText ? ` ${theme.fg(delegationSignalColor(badge), badgeText)}` : ""}${modelSuffix} ${theme.fg("dim", formatDuration(delegationDurationMs(run, nowMs)))} ${theme.fg("muted", viewHint)}`);
      if (expanded && (run.errorMessage || run.stopReason || run.gateErrors?.length)) lines.push(`   ${theme.fg("dim", run.errorMessage ?? run.gateErrors?.join("; ") ?? run.stopReason ?? "")}`);
    }
    if (hasMore) lines.push(theme.fg("dim", `└─ … ${monitoredRuns.length - maxRows} more child run(s)`));
    return lines.join("\n");
  }

  const maxRows = expanded ? 10 : 4;
  const visibleResults = results.slice(0, maxRows);
  const hasMore = results.length > maxRows;
  for (const [index, result] of visibleResults.entries()) {
    const failed = isFailed(result);
    const color = failed ? (result.failureKind === "preflight" || result.failureKind === "config" || result.failureKind === "output_gate" ? "warning" : "error") : "success";
    const prefix = index === visibleResults.length - 1 && !hasMore ? "└─" : "├─";
    const viewHint = result.ledgerRunId ? delegateViewLink(result.ledgerRunId) : "[view]";
    const kind = result.failureKind ? ` ${result.failureKind}` : "";
    const badge = extractDelegationSignalBadge(result.output);
    const badgeText = formatDelegationSignalBadge(badge);
    const modelLabel = formatDelegationModelLabel(result);
    const modelSuffix = modelLabel ? ` ${theme.fg("muted", `(${modelLabel})`)}` : "";
    lines.push(`${theme.fg("dim", prefix)} ${theme.fg(color, `${failed ? "✗" : "✓"} ${result.agent}${kind}`)}${badgeText ? ` ${theme.fg(delegationSignalColor(badge), badgeText)}` : ""}${modelSuffix} ${theme.fg("dim", result.ledgerRunId ?? "")} ${theme.fg("muted", viewHint)}`);
    if (expanded && result.output.trim()) lines.push(`   ${theme.fg("muted", result.output.split("\n")[0] ?? "")}`);
  }
  if (hasMore) lines.push(theme.fg("dim", `└─ … ${results.length - maxRows} more result(s)`));
  return lines.join("\n");
}
