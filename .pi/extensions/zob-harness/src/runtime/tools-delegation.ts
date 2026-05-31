import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentScope, ChildResult, ChildStopCondition, DelegationDetails, DelegationFailureKind } from "../types.js";
import { AwaitDelegationRunParams, DelegateParams, DelegateTaskParams, DelegationCatalogParams, DelegationRunParams } from "../schemas.js";
import { discoverAgents, formatAgentList } from "../agents.js";
import { applyTodoSplitRequest, extractTodoClaimFromText, extractTodoClaimValidationFromText, extractTodoSplitRequestFromText, isActionableTodoClaimValidation, isActionableTodoSplitRequest, linkGoalTodoDelegation, recordGoalTodoClaimValidationResult, requestGoalTodoClaimValidation, resolveGoalTodoReference, returnGoalTodoClaim, type GoalTodoNode } from "../goal-todos.js";
import { isFailed, mapWithConcurrency, runChildAgent } from "../child-runner.js";
import { classifyChildStopCondition, classifyDelegationChronicleCompletion, outputHasEvidenceMarker } from "../chronicle.js";
import { applyChildGates, getOutputContractDefinitions, inferOutputContract, listOutputContracts, validateOutputContractId } from "../output-contracts.js";
import {
  parseToolList,
  resolveChildCwd,
  validateAllowedPathPolicy,
  validateDelegationWriteScope,
  validateDelegateTaskWriteScope,
  validateForbiddenPathPolicy,
  validateSixPartContract,
  validateToolList,
} from "../safety.js";
import { usageEmpty, writeDelegationTelemetrySummary } from "../telemetry.js";
import { capOutput, formatChildResultText } from "../utils/formatting.js";
import { sha256 } from "../utils/hashing.js";
import { newRunId } from "../utils/paths.js";
import {
  delegationDurationMs,
  delegationSignalBadge,
  delegationSignalColor,
  extractDelegationSignalBadge,
  finishDelegationRun,
  formatDelegationSignalBadge,
  formatDuration,
  hasActiveDelegations,
  startDelegationRun,
  statusIcon,
  updateDelegationRun,
  type DelegationRunMode,
} from "./delegation-monitor.js";
import { delegateViewLink } from "./delegation-mouse.js";
import type { BackgroundDelegationRuntimeRun, HarnessRuntimeState } from "./state.js";
import { strictGoalErrors, strictGoalSpecErrors } from "./state.js";
import { renderHarnessWidget } from "./widget.js";

function appendLedgerFile(repoRoot: string, entry: Record<string, unknown>): void {
  const dir = join(repoRoot, ".pi", "logs", "runs");
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
}

function asDelegationDetails(value: unknown): DelegationDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Partial<DelegationDetails>;
  if ((details.mode !== "single" && details.mode !== "parallel" && details.mode !== "chain") || !Array.isArray(details.results)) return undefined;
  return { mode: details.mode, results: details.results, agents: Array.isArray(details.agents) ? details.agents : [] };
}

function delegationLedgerMeta(source: "delegate_agent" | "delegate_task", parentToolCallId: string | undefined, delegationMode: DelegationRunMode, index?: number): Record<string, unknown> {
  return { source, parentToolCallId, delegationMode, index };
}

function delegationCallLabel(args: { agent?: string; task?: string; tasks?: Array<{ agent: string }>; chain?: Array<{ agent: string }> }): string {
  if (args.agent && args.task) return `single → ${args.agent}`;
  if (args.tasks && args.tasks.length > 0) return `parallel ×${args.tasks.length} → ${args.tasks.map((task) => task.agent).join(", ")}`;
  if (args.chain && args.chain.length > 0) return `chain ×${args.chain.length} → ${args.chain.map((step) => step.agent).join(" → ")}`;
  return "invalid parameters";
}

function classifyConfigOrPreflight(errors: string[]): DelegationFailureKind {
  return errors.some((error) => /unknown agent|unknown output contract|available:/i.test(error)) ? "config" : "preflight";
}

function classifyChildFailure(result: ChildResult): DelegationFailureKind | undefined {
  if (result.stopReason === "aborted") return "aborted";
  if (result.exitCode !== 0 || result.stopReason === "error") return "child_runtime";
  if (result.gatePassed === false) return "output_gate";
  return undefined;
}

function delegateTaskPreflightHelp(errors: string[]): string {
  const base = `Delegation preflight failed (no child launched):\n- ${errors.join("\n- ")}`;
  const aliasHint = errors.some((error) => /delegate_task field|Conflicting delegate_task fields/i.test(error))
    ? "\n\nHow to fix structured fields: use canonical JSON keys expected_outcome, must_do, must_not_do, original_user_ask, allowed_paths, forbidden_paths, required_tools, output_contract, run_in_background, child_goal, load_skills; safe aliases such as expectedOutcome, mustDo, mustNotDo/must_not/mustNot, originalUserAsk, allowedPaths, forbiddenPaths, requiredTools, outputContract, runInBackground, childGoal, loadSkills are accepted only when they do not conflict."
    : "";
  const missingOriginalUserAsk = errors.some((error) => /ORIGINAL_USER_ASK\/original_user_ask is required/i.test(error));
  if (!missingOriginalUserAsk) return `${base}${aliasHint}`;
  return `${base}${aliasHint}\n\nHow to fix: retry delegate_task with top-level original_user_ask set to the original human request. Putting it only in context or task text is not enough for write-enabled delegations with edit/write tools.`;
}

function childFailureMessage(kind: DelegationFailureKind | undefined, gateErrors: string[] | undefined, errorMessage: string | undefined): string | undefined {
  if (kind === "output_gate") return `Output contract gate failed; format repair may be enough. Gate errors: ${(gateErrors ?? []).join("; ") || "unknown"}`;
  if (kind === "child_runtime") return errorMessage ?? "Child runtime failed before a valid gated output was produced";
  if (kind === "aborted") return "Child agent aborted";
  return errorMessage;
}

type AgenticClaimValidationInput = {
  mode?: "off" | "oracle_then_auto_accept";
  oracle_agent?: string;
  auto_accept_on_pass?: boolean;
  output_contract?: string;
};

type ChildGoalInput = {
  enabled?: boolean;
  objective?: string;
  todo_id?: string;
  parent_todo_id?: string;
  todo_path?: string;
  delegation_depth?: number;
  request_id?: string;
  oracle_required?: boolean;
  max_turns?: number;
  max_tokens?: number;
  completion_policy?: "return_claim" | "oracle_before_complete";
  agentic_validation?: AgenticClaimValidationInput;
};

type DelegateTaskAliasInput = {
  agent: string;
  task: string;
  expected_outcome?: string;
  expectedOutcome?: string;
  required_tools?: string[];
  requiredTools?: string[];
  must_do?: string[];
  mustDo?: string[];
  must_not_do?: string[];
  mustNotDo?: string[];
  must_not?: string[];
  mustNot?: string[];
  context: string;
  original_user_ask?: string;
  originalUserAsk?: string;
  allowed_paths?: string[];
  allowedPaths?: string[];
  forbidden_paths?: string[];
  forbiddenPaths?: string[];
  output_contract?: string;
  outputContract?: string;
  child_goal?: ChildGoalInput;
  childGoal?: ChildGoalInput;
  run_in_background?: boolean;
  runInBackground?: boolean;
  load_skills?: string[];
  loadSkills?: string[];
  cwd?: string;
  scope?: AgentScope;
  model?: string;
};

type DelegateTaskCanonicalInput = Omit<DelegateTaskAliasInput,
  | "expectedOutcome"
  | "requiredTools"
  | "mustDo"
  | "mustNotDo"
  | "must_not"
  | "mustNot"
  | "originalUserAsk"
  | "allowedPaths"
  | "forbiddenPaths"
  | "outputContract"
  | "childGoal"
  | "runInBackground"
  | "loadSkills"
> & {
  expected_outcome: string;
  must_do: string[];
  must_not_do: string[];
};

function deepEqual(left: unknown, right: unknown): boolean {
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

function normalizeDelegateTaskParams(input: DelegateTaskAliasInput): { params: DelegateTaskCanonicalInput; errors: string[] } {
  const errors: string[] = [];
  const knownKeys = new Set<keyof DelegateTaskAliasInput>(["agent", "task", "expected_outcome", "expectedOutcome", "required_tools", "requiredTools", "must_do", "mustDo", "must_not_do", "mustNotDo", "must_not", "mustNot", "context", "original_user_ask", "originalUserAsk", "allowed_paths", "allowedPaths", "forbidden_paths", "forbiddenPaths", "output_contract", "outputContract", "child_goal", "childGoal", "run_in_background", "runInBackground", "load_skills", "loadSkills", "cwd", "scope", "model"]);
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
    },
    errors,
  };
}

function childGoalGuidance(childGoal: ChildGoalInput | undefined, parentGoalId: string | undefined, runId: string): string[] {
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

function appendChildGoalToTask(task: string, childGoal: ChildGoalInput | undefined, parentGoalId: string | undefined, runId: string): string {
  const guidance = childGoalGuidance(childGoal, parentGoalId, runId);
  return guidance.length > 0 ? `${guidance.join("\n")}\n${task}` : task;
}

function resolveChildGoalTodoRef(state: HarnessRuntimeState, childGoal: ChildGoalInput | undefined): { childGoal: ChildGoalInput | undefined; errors: string[]; node?: GoalTodoNode } {
  if (!childGoal) return { childGoal, errors: [] };
  const requestedRef = childGoal.todo_id ?? childGoal.todo_path;
  if (!requestedRef) return { childGoal, errors: [] };
  const goalId = state.runtimeGoal?.goalId;
  const resolution = resolveGoalTodoReference(state.goalTodos, goalId, requestedRef, childGoal.todo_id ? "child_goal.todo_id" : "child_goal.todo_path", { requireDelegatable: true });
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

function linkChildGoalTodoDelegationIfReady(pi: ExtensionAPI, state: HarnessRuntimeState, childGoal: ChildGoalInput | undefined, runId: string, agent?: string): void {
  const goalId = state.runtimeGoal?.goalId;
  if (!goalId || !childGoal?.todo_id) return;
  if (!state.goalTodos.nodes.some((node) => node.goalId === goalId && node.id === childGoal.todo_id)) return;
  linkGoalTodoDelegation(pi, state, goalId, childGoal.todo_id, { runId, agent, requestId: childGoal.request_id, delegationDepth: childGoal.delegation_depth }, "delegation");
}

function retargetTodoSplitRequestResult(result: ChildResult, childGoal: ChildGoalInput | undefined, repoRoot: string): void {
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

function recordTodoClaimFromChildResult(pi: ExtensionAPI, state: HarnessRuntimeState, childGoal: ChildGoalInput | undefined, result: ChildResult, meta: { runId?: string; outputHash?: string } = {}): { goalId?: string; todoId?: string; claimHash?: string; validReadyClaim: boolean; node?: GoalTodoNode; splitApplied?: boolean } {
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
      }, "delegation");
      return { goalId, todoId, claimHash: node?.claim?.claimHash, validReadyClaim: false, node };
    }
  }
  const claim = extractTodoClaimFromText(text);
  const validReadyClaim = !isFailed(result)
    && claim.todoId === todoId
    && claim.childGoalStatus === "ready_for_oracle"
    && claim.statusClaim === "done"
    && claim.hasFinalMarker;
  const node = returnGoalTodoClaim(pi, state, goalId, todoId, {
    claimText: text || "child returned no TODO_CHILD_RESULT.v1/v2 claim",
    evidenceRefs: claim.evidenceRefs,
    validationCommands: claim.validationCommands,
    noShip: validReadyClaim ? claim.noShip === true : true,
    runId: meta.runId,
    outputHash: meta.outputHash,
    outputContract: result.outputContract,
    gatePassed: result.gatePassed,
    childGoalStatus: claim.childGoalStatus,
    statusClaim: claim.statusClaim,
    targetReadiness: claim.targetReadiness,
    acceptanceBlockers: claim.acceptanceBlockers,
  }, "delegation");
  return { goalId, todoId, claimHash: node?.claim?.claimHash, validReadyClaim, node };
}

function shouldRunAgenticClaimValidation(childGoal: ChildGoalInput | undefined, claimRecord: { validReadyClaim: boolean; node?: GoalTodoNode; splitApplied?: boolean }): boolean {
  const settings = childGoal?.agentic_validation;
  if (!settings || settings.mode !== "oracle_then_auto_accept") return false;
  if (claimRecord.splitApplied || !claimRecord.validReadyClaim || !claimRecord.node?.claim) return false;
  if (claimRecord.node.claim.noShip === true) return false;
  return true;
}

function formatTodoClaimValidationTask(node: GoalTodoNode, childGoal: ChildGoalInput | undefined): string {
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

async function runAgenticTodoClaimValidation(input: {
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

function finalFormatGuidance(outputContract: string): string[] {
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

function hydrateDelegationRunsFromDetails(source: "delegate_agent" | "delegate_task", details: DelegationDetails | undefined, state: HarnessRuntimeState, toolCallId: string | undefined): void {
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

function agentSourcePath(repoRoot: string, filePath: string, source: "project" | "user"): string | undefined {
  if (source !== "project") return undefined;
  const path = relative(repoRoot, filePath).replace(/\\/g, "/");
  if (!path || path.startsWith("../") || path === "..") return undefined;
  return path;
}

function buildDelegationCatalog(repoRoot: string, scope: AgentScope, includeContractRequirements = false): Record<string, unknown> {
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

function formatDelegationCatalogSummary(catalog: Record<string, unknown>): string {
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

function renderDelegationToolResultText(source: "delegate_agent" | "delegate_task", details: DelegationDetails | undefined, state: HarnessRuntimeState, toolCallId: string | undefined, isPartial: boolean, expanded: boolean, theme: { fg: (color: any, text: string) => string; bold: (text: string) => string }): string {
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
      lines.push(`${theme.fg("dim", prefix)} ${theme.fg(color, `${statusIcon(run.status)} ${run.agent}${kind}`)}${badgeText ? ` ${theme.fg(delegationSignalColor(badge), badgeText)}` : ""} ${theme.fg("dim", formatDuration(delegationDurationMs(run, nowMs)))} ${theme.fg("muted", viewHint)}`);
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
    lines.push(`${theme.fg("dim", prefix)} ${theme.fg(color, `${failed ? "✗" : "✓"} ${result.agent}${kind}`)}${badgeText ? ` ${theme.fg(delegationSignalColor(badge), badgeText)}` : ""} ${theme.fg("dim", result.ledgerRunId ?? "")} ${theme.fg("muted", viewHint)}`);
    if (expanded && result.output.trim()) lines.push(`   ${theme.fg("muted", result.output.split("\n")[0] ?? "")}`);
  }
  if (hasMore) lines.push(theme.fg("dim", `└─ … ${results.length - maxRows} more result(s)`));
  return lines.join("\n");
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
      "Every delegated task should use the six-part TASK/EXPECTED OUTCOME/TOOLS/MUST DO/MUST NOT/CONTEXT contract.",
    ].join(" "),
    promptSnippet: "Delegate focused work to project specialist agents with isolated child Pi contexts",
    promptGuidelines: [
      "If agent routing is uncertain, call zob_delegation_catalog before the first delegation.",
      "Use delegate_agent for broad discovery, external research, skeptical review, or independent QA before making risky edits.",
      "When using delegate_agent, give each child a bounded six-part contract and a concrete final output shape.",
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
        appendLedgerFile(ctx.cwd, entry);
        pi.appendEntry("zob-delegation", entry);
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

      const runOne = async (item: { agent: string; task: string; cwd?: string; child_goal?: ChildGoalInput }, monitor: { mode: DelegationRunMode; index?: number }, update?: (result: ChildResult) => void): Promise<ChildResult> => {
        const runId = newRunId("delegate");
        const childGoalResolution = resolveChildGoalTodoRef(state, item.child_goal ?? params.child_goal);
        const effectiveChildGoal = childGoalResolution.childGoal;
        const taskText = appendChildGoalToTask(item.task, effectiveChildGoal, state.runtimeGoal?.goalId, runId);
        const startedAtMs = Date.now();
        const startedAt = new Date(startedAtMs).toISOString();
        const requestedTools = parseToolList(params.tools);
        startDelegationRun(state.delegations, {
          id: runId,
          parentToolCallId: toolCallId,
          source: "delegate_agent",
          mode: monitor.mode,
          index: monitor.index,
          agent: item.agent,
          task: taskText,
          startedAtMs,
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
          };
          const endedAtMs = Date.now();
          const endedAt = new Date(endedAtMs).toISOString();
          appendDelegationLedger({
            event: "config_failed",
            runId,
            mode: state.activeMode,
            ...delegationLedgerMeta("delegate_agent", toolCallId, monitor.mode, monitor.index),
            agent: item.agent,
            taskHash: sha256(taskText),
            cwd: resolveChildCwd(ctx.cwd, item.cwd).cwd,
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
            cwd: resolveChildCwd(ctx.cwd, item.cwd).cwd,
            tools: requestedTools ?? [],
            taskHash: sha256(taskText),
            outputContract: inferOutputContract(item.agent),
            status: "unknown_agent",
            gatePassed: false,
            gateErrors: ["unknown agent"],
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
          });
          recordTodoClaimFromChildResult(pi, state, effectiveChildGoal, result);
          renderDelegationMonitor();
          return result;
        }

        updateDelegationRun(state.delegations, runId, { agent: agent.name });
        const cwdResult = resolveChildCwd(ctx.cwd, item.cwd);
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
          };
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
            gateErrors: preflightErrors,
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
          });
          recordTodoClaimFromChildResult(pi, state, effectiveChildGoal, result);
          renderDelegationMonitor();
          return result;
        }

        linkChildGoalTodoDelegationIfReady(pi, state, effectiveChildGoal, runId, agent.name);
        renderDelegationMonitor();
        const outputContract = inferOutputContract(agent.name);
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

        const result = await runChildAgent(ctx, agent, taskText, cwdResult.cwd, signal, params.model, requestedTools?.join(","), (partial) => {
          updateDelegationRun(state.delegations, runId, {
            status: partial.stopReason === "aborted" ? "aborted" : "running",
            agent: partial.agent,
            outputPreview: partial.output,
            stderrPreview: partial.stderr,
            sessionPath: partial.sessionPath,
            stopReason: partial.stopReason,
            errorMessage: partial.errorMessage,
            usage: partial.usage,
          });
          renderDelegationMonitor();
          update?.(partial);
        }, { allowedPaths: params.allowed_paths, forbiddenPaths: params.forbidden_paths });
        result.ledgerRunId = runId;
        result.outputContract = outputContract;
        result.contractErrors = [];
        applyChildGates(result, { repoRoot: ctx.cwd });
        retargetTodoSplitRequestResult(result, effectiveChildGoal, ctx.cwd);
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
          gateErrors: result.gateErrors ?? [],
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
          usage: result.usage,
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
          const result = await runOne({ agent: params.agent, task: params.task, child_goal: params.child_goal }, { mode: "single", index: 0 }, (partial) => {
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
          const summaries = results.map((result) => `### ${result.agent} — ${isFailed(result) ? "FAILED/INCOMPLETE" : "OK"}\n\n${capOutput(formatChildResultText(result))}`);
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
                content: [{ type: "text", text: `Chain stopped at step ${index + 1} (${result.agent}):\n\n${formatChildResultText(result)}` }],
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
      const childGoalResolution = resolveChildGoalTodoRef(state, params.child_goal);
      const effectiveChildGoal = childGoalResolution.childGoal;
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const appendDelegationLedger = (entry: Record<string, unknown>): void => {
        appendLedgerFile(ctx.cwd, entry);
        pi.appendEntry("zob-delegation", entry);
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
      startDelegationRun(state.delegations, {
        id: runId,
        parentToolCallId: toolCallId,
        source: "delegate_task",
        mode: "single",
        index: 0,
        agent: params.agent,
        task: params.task,
        startedAtMs,
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
        };
        const endedAtMs = Date.now();
        const endedAt = new Date(endedAtMs).toISOString();
        appendDelegationLedger({
          event: "config_failed",
          runId,
          mode: state.activeMode,
          ...delegationLedgerMeta("delegate_task", toolCallId, "single", 0),
          agent: params.agent,
          taskHash: sha256(params.task),
          cwd: resolveChildCwd(ctx.cwd, params.cwd).cwd,
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
          cwd: resolveChildCwd(ctx.cwd, params.cwd).cwd,
          tools: params.required_tools ?? [],
          taskHash: sha256(params.task),
          outputContract: params.output_contract ?? inferOutputContract(params.agent),
          status: "unknown_agent",
          gatePassed: false,
          gateErrors: ["unknown agent"],
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
        });
        recordTodoClaimFromChildResult(pi, state, effectiveChildGoal, result);
        stopMonitorTicker();
        return { content: [{ type: "text", text: formatChildResultText(result) }], details: { mode: "single", results: [result], agents: agents.map((candidate) => candidate.name) } };
      }

      updateDelegationRun(state.delegations, runId, { agent: agent.name });
      const requestedOutputContract = params.output_contract ?? inferOutputContract(agent.name);
      const effectiveTools = params.required_tools?.length ? params.required_tools : agent.tools ?? [];

      const structuredTask = [
        `ORIGINAL_USER_ASK: ${params.original_user_ask ?? state.activeGoal?.originalUserAsk ?? "Not set"}`,
        params.output_contract ? `OUTPUT_CONTRACT: ${params.output_contract}` : undefined,
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

      const cwdResult = resolveChildCwd(ctx.cwd, params.cwd);
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
        };
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
          gateErrors: preflightErrors,
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
        });
        recordTodoClaimFromChildResult(pi, state, effectiveChildGoal, result);
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
          startedAt,
        });

        const result = await runChildAgent(ctx, agent, structuredTask, cwdResult.cwd, childSignal, params.model, effectiveTools.join(","), (partial) => {
          updateDelegationRun(state.delegations, runId, {
            status: partial.stopReason === "aborted" ? "aborted" : "running",
            agent: partial.agent,
            outputPreview: partial.output,
            stderrPreview: partial.stderr,
            sessionPath: partial.sessionPath,
            stopReason: partial.stopReason,
            errorMessage: partial.errorMessage,
            usage: partial.usage,
          });
          renderDelegationMonitor();
          if (emitToolUpdates) onUpdate?.({ content: [{ type: "text", text: partial.output || partial.stderr || "running..." }], details: { mode: "single", results: [partial], agents: agents.map((candidate) => candidate.name) } });
        }, { allowedPaths: params.allowed_paths, forbiddenPaths: params.forbidden_paths });
        result.ledgerRunId = runId;
        result.outputContract = outputContract;
        result.contractErrors = [];
        applyChildGates(result, { repoRoot: ctx.cwd });
        retargetTodoSplitRequestResult(result, effectiveChildGoal, ctx.cwd);
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
          gateErrors: result.gateErrors ?? [],
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
          usage: result.usage,
        });
        if (shouldRunAgenticClaimValidation(effectiveChildGoal, claimRecord)) {
          await runAgenticTodoClaimValidation({ ctx, pi, state, childGoal: effectiveChildGoal, claimRecord, parentRunId: runId, appendDelegationLedger, signal: childSignal, modelOverride: params.model, allowedPaths: params.allowed_paths, forbiddenPaths: params.forbidden_paths });
        }
        stopMonitorTicker();

        return result;
      };

      if (params.run_in_background) {
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
            finishDelegationRun(state.delegations, runId, { status: "failed", endedAtMs: Date.now(), errorMessage: message, gatePassed: false, gateErrors: [message], failureKind: "child_runtime" });
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
