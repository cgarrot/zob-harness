import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HarnessRuntimeState } from "../../../runtime/state.js";
import type { AddGoalTodoInput, GoalTodoChildGoalStatus, GoalTodoClaimRef, GoalTodoClaimTargetReadiness, GoalTodoClaimValidationPolicy, GoalTodoClaimValidationRef, GoalTodoClaimValidationStatus, GoalTodoClaimResolutionBinding, GoalTodoDelegationAttempt, GoalTodoDelegationAttemptFailureKind, GoalTodoDelegationAttemptReasonCode, GoalTodoDelegationAttemptStatus, GoalTodoDelegationLivenessProof, GoalTodoDelegationRecovery, GoalTodoDelegationRef, GoalTodoDelegationStatus, GoalTodoEventSource, GoalTodoNode, GoalTodoPatchClearField, GoalTodoState, GoalTodoStatus, GoalTodoStatusClaim, GoalTodoTransitionAction, GoalTodoTransitionContext, GoalTodoTransitionDecision, GoalTodoTransitionDiagnostic, GoalTodoTransitionOperationContext, ResolveGoalTodoAction, TodoClaimValidationResult } from "../goal-todo-types.js";
import { recordZcommitOwnedPaths, type ZcommitChildChangedPathRef } from "../../git/git-ops.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { OPEN_REQUIRED_STATUSES } from "./constants.js";
import { applyPatchToNode, cloneNode, normalizePatch, safeDelegationAttemptId, unixSeconds } from "./normalize.js";
import { appendGoalTodoEvent, goalNodes, nextTodoId } from "./reducer.js";
import { decideGoalTodoTransition } from "./transition-engine.js";

export const GOAL_TODO_PATH_PATTERN = /^\d+(?:\.\d+)*$/;
export const DELEGATABLE_GOAL_TODO_STATUSES = new Set<GoalTodoStatus>(["planned", "ready", "in_progress", "needs_review"]);
export const ACTIVE_DELEGATION_STATUSES = new Set<GoalTodoDelegationStatus>(["queued", "running", "claim_returned"]);
export const RECOVERABLE_DELEGATION_STATUSES = new Set<GoalTodoDelegationStatus>(["failed", "rejected", "unknown"]);
export const RECOVERABLE_DELEGATION_ATTEMPT_STATUSES = new Set<GoalTodoDelegationAttemptStatus>([
  "failed_preflight",
  "failed_runtime",
  "failed_output_gate_format",
  "failed_output_gate_semantic",
  "output_declared_incomplete",
  "cancelled",
  "liveness_unknown",
]);

const GOAL_TODO_TRANSITION_AUTHORIZATION = Symbol("zob.goal-todo-transition-authorization.v1");
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const CANONICAL_CLAIM_OUTPUT_CONTRACTS = new Set(["todo-child-result.v1", "todo-child-result.v2", "agent-event.v1"]);
const ACTIVE_ATTEMPT_STATUSES = new Set<GoalTodoDelegationAttemptStatus>(["queued", "running", "claim_returned"]);
const SAFE_METADATA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const GOAL_TODO_PATCH_CLEAR_FIELDS = ["parentId", "descriptionHash", "delegation", "claim", "validation", "contextScopeId", "contextPackRef", "freshness", "blocker", "skipReason", "reviewNoShip"] as const satisfies readonly GoalTodoPatchClearField[];

export interface GoalTodoTransitionAuthorization {
  readonly schema: "zob.goal-todo-transition-authorization.v1";
  readonly nodeId: string;
  readonly nodeRevision: number;
  readonly action: GoalTodoTransitionAction;
  readonly decision: GoalTodoTransitionDecision;
  readonly diagnostic: GoalTodoTransitionDiagnostic;
  readonly [GOAL_TODO_TRANSITION_AUTHORIZATION]: true;
}

export class GoalTodoTransitionError extends Error {
  readonly diagnostic: GoalTodoTransitionDiagnostic;

  constructor(diagnostic: GoalTodoTransitionDiagnostic, humanPrefix = "Goal/TODO transition rejected") {
    super(`${humanPrefix}: code=${diagnostic.code}${diagnostic.code === "legacy_claim_binding_required" ? " legacy_code=LEGACY_CLAIM_BINDING_REQUIRED" : ""} current=${diagnostic.current} action=${diagnostic.action} retry_policy=${diagnostic.retry_policy} safe_next_actions=${diagnostic.safe_next_actions.join("|") || "none"}`);
    this.name = "GoalTodoTransitionError";
    this.diagnostic = diagnostic;
  }
}

function transitionDiagnostic(decision: GoalTodoTransitionDecision): GoalTodoTransitionDiagnostic {
  return Object.freeze({
    schema: "zob.goal-todo-transition-diagnostic.v1",
    code: decision.code,
    current: decision.currentStatus,
    action: decision.action,
    safe_next_actions: Object.freeze([...decision.safeNextActions]),
    retry_policy: decision.retryPolicy,
    required_guards: Object.freeze([...decision.requiredGuards]),
  });
}

function validBoundRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isCanonicalGoalTodoClaimBinding(claim: GoalTodoClaimRef | undefined): claim is GoalTodoClaimRef & {
  claimVersion: 2;
  attemptId: string;
  runId: string;
  goalRevision: number;
  graphRevision: number;
  todoRevision: number;
  validationPolicy: GoalTodoClaimValidationPolicy;
  outputHash: string;
  outputContract: string;
  gateHash: string;
} {
  return Boolean(claim
    && claim.claimVersion === 2
    && SHA256_HEX.test(claim.claimHash)
    && typeof claim.attemptId === "string"
    && SAFE_METADATA_ID.test(claim.attemptId)
    && typeof claim.runId === "string"
    && SAFE_METADATA_ID.test(claim.runId)
    && validBoundRevision(claim.goalRevision)
    && validBoundRevision(claim.graphRevision)
    && validBoundRevision(claim.todoRevision)
    && (claim.validationPolicy === "parent_review" || claim.validationPolicy === "oracle_required")
    && typeof claim.outputHash === "string"
    && SHA256_HEX.test(claim.outputHash)
    && typeof claim.outputContract === "string"
    && CANONICAL_CLAIM_OUTPUT_CONTRACTS.has(claim.outputContract)
    && typeof claim.gateHash === "string"
    && SHA256_HEX.test(claim.gateHash)
    && claim.gatePassed === true);
}

function currentGoalRevision(state: HarnessRuntimeState, goalId: string): number {
  return state.runtimeGoal?.goalId === goalId ? state.runtimeGoal.revision : 0;
}

function isCanonicalValidationBinding(validation: GoalTodoClaimValidationRef | undefined, claim: GoalTodoClaimRef, requireOutput: boolean): boolean {
  return Boolean(validation
    && validation.validationVersion === 1
    && validation.claimHash === claim.claimHash
    && validation.attemptId === claim.attemptId
    && validation.claimRunId === claim.runId
    && validation.claimGoalRevision === claim.goalRevision
    && validation.claimGraphRevision === claim.graphRevision
    && validation.claimTodoRevision === claim.todoRevision
    && validation.validationPolicy === claim.validationPolicy
    && validBoundRevision(validation.expectedGraphRevision)
    && validBoundRevision(validation.expectedTodoRevision)
    && validBoundRevision(validation.goalRevision)
    && validBoundRevision(validation.graphRevision)
    && validBoundRevision(validation.todoRevision)
    && (!requireOutput || (typeof validation.outputHash === "string" && SHA256_HEX.test(validation.outputHash))));
}

function claimResolutionBinding(claim: GoalTodoClaimRef, expected: { goalRevision: number; graphRevision: number; todoRevision: number }, validation?: GoalTodoClaimValidationRef): GoalTodoClaimResolutionBinding {
  if (!isCanonicalGoalTodoClaimBinding(claim)) throw new Error("LEGACY_CLAIM_BINDING_REQUIRED");
  return {
    claimVersion: 2,
    claimHash: claim.claimHash,
    attemptId: claim.attemptId,
    claimGoalRevision: claim.goalRevision,
    claimGraphRevision: claim.graphRevision,
    claimTodoRevision: claim.todoRevision,
    expectedGoalRevision: expected.goalRevision,
    expectedGraphRevision: expected.graphRevision,
    expectedTodoRevision: expected.todoRevision,
    validationPolicy: claim.validationPolicy,
    ...(validation?.outputHash ? { validationOutputHash: validation.outputHash } : {}),
  };
}

/** The sole domain authorization helper for live Goal/TODO status mutations. */
export function authorizeGoalTodoTransition(node: GoalTodoNode, action: GoalTodoTransitionAction, operation: GoalTodoTransitionOperationContext = {}): GoalTodoTransitionAuthorization {
  const claim = operation.prospectiveClaim ?? node.claim;
  const validation = node.validation;
  const latestAttempt = node.delegationAttempts?.at(-1);
  const delegationStatus = latestAttempt && node.status !== "delegated" && !ACTIVE_ATTEMPT_STATUSES.has(latestAttempt.status)
    ? undefined
    : node.delegation?.status;
  const evidenceRefs = [...new Set([...node.evidenceRefs, ...(operation.evidenceRefs ?? [])])];
  const validationCommands = [...new Set([...node.validationCommands, ...(operation.validationCommands ?? [])])];
  const hasEvidence = evidenceRefs.length > 0
    || validationCommands.length > 0
    || Boolean(operation.prospectiveClaim?.outputHash)
    || Boolean(node.artifacts?.outputHash);
  const context: GoalTodoTransitionContext = {
    requestedStatus: operation.requestedStatus,
    delegationStatus,
    delegationLiveness: operation.delegationLiveness,
    delegationAttemptMatches: operation.delegationAttemptMatches,
    hasFailureContext: typeof operation.failureHash === "string" && SHA256_HEX.test(operation.failureHash),
    hasClaim: Boolean(claim && SHA256_HEX.test(claim.claimHash)),
    claimGatePassed: claim?.gatePassed === true && Boolean(claim.outputContract && CANONICAL_CLAIM_OUTPUT_CONTRACTS.has(claim.outputContract)),
    childGoalStatus: claim?.childGoalStatus,
    statusClaim: claim?.statusClaim,
    targetReadiness: claim?.targetReadiness,
    hasAcceptanceBlockers: claim ? !hasOnlyNoneLike(claim.acceptanceBlockers) : undefined,
    noShip: claim?.noShip ?? (node.reviewNoShip === true ? true : undefined),
    evidenceRequired: goalTodoNeedsSkipEvidence(node),
    critical: node.priority === "critical",
    required: node.required,
    hasEvidence,
    hasReason: Boolean(operation.reason?.trim()),
    validationPolicy: claim?.validationPolicy,
    claimBindingPresent: isCanonicalGoalTodoClaimBinding(claim),
    claimAttemptMatches: Boolean(claim?.attemptId && operation.expectedAttemptId && claim.attemptId === operation.expectedAttemptId && latestAttempt?.attemptId === operation.expectedAttemptId && latestAttempt.runId === claim.runId && operation.delegationAttemptMatches !== false),
    claimGoalRevisionMatches: Number.isSafeInteger(claim?.goalRevision) && claim?.goalRevision === operation.expectedGoalRevision,
    claimGraphRevisionMatches: claim?.validationPolicy === "oracle_required" ? operation.validationBindingMatches === true : Number.isSafeInteger(claim?.graphRevision) && claim?.graphRevision === operation.expectedGraphRevision,
    claimPolicyMatches: Boolean(claim?.validationPolicy && claim.validationPolicy === operation.expectedValidationPolicy),
    validationBindingMatches: operation.validationBindingMatches,
    validationStatus: validation?.status,
    validationVerdict: validation?.verdict,
    validationRecommendedAction: validation?.recommendedAction,
    validationConfidence: validation?.confidence,
    validationNoShip: validation?.noShip,
    validationHasBlockingIssues: validation ? !hasOnlyNoneLike(validation.blockingIssues) : undefined,
    claimHash: claim?.claimHash,
    expectedClaimHash: operation.expectedClaimHash,
    claimRevision: node.revision ?? 0,
    expectedClaimRevision: operation.expectedClaimRevision,
    userResolved: operation.userResolved,
    casBound: operation.casBound,
    clearDelegationOnReopen: operation.clearDelegationOnReopen,
  };
  const decision = decideGoalTodoTransition({ currentStatus: node.status, action, context });
  const diagnostic = transitionDiagnostic(decision);
  if (!decision.allowed) throw new GoalTodoTransitionError(diagnostic);
  return Object.freeze({
    schema: "zob.goal-todo-transition-authorization.v1",
    nodeId: node.id,
    nodeRevision: node.revision ?? 0,
    action,
    decision,
    diagnostic,
    [GOAL_TODO_TRANSITION_AUTHORIZATION]: true as const,
  });
}

function isCurrentGoalTodoAuthorization(node: GoalTodoNode, authorization: GoalTodoTransitionAuthorization | undefined): authorization is GoalTodoTransitionAuthorization {
  return Boolean(authorization
    && authorization[GOAL_TODO_TRANSITION_AUTHORIZATION] === true
    && authorization.nodeId === node.id
    && authorization.nodeRevision === (node.revision ?? 0)
    && authorization.decision.allowed);
}

export function hasActiveGoalTodoDelegation(node: GoalTodoNode): boolean {
  return Boolean(node.delegation && ACTIVE_DELEGATION_STATUSES.has(node.delegation.status));
}

export function isRecoverableDelegatedGoalTodoNode(node: GoalTodoNode): boolean {
  return node.status === "delegated" && (!node.delegation || RECOVERABLE_DELEGATION_STATUSES.has(node.delegation.status));
}

export function isDelegatableGoalTodoNode(node: GoalTodoNode): boolean {
  const canonical = DELEGATABLE_GOAL_TODO_STATUSES.has(node.status) && !node.delegation && !node.claim;
  const legacyRecoverable = isRecoverableDelegatedGoalTodoNode(node) && (node.delegationAttempts?.length ?? 0) === 0 && !node.claim;
  return (canonical || legacyRecoverable) && !hasActiveGoalTodoDelegation(node);
}

export function goalTodoRefHint(nodes: GoalTodoNode[]): string {
  if (nodes.length === 0) return "none";
  return nodes
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }) || left.createdAt - right.createdAt)
    .slice(0, 8)
    .map((node) => `${node.path}=${node.id}`)
    .join(", ");
}

export function legacyTodoPathFromRef(ref: string): string | undefined {
  const match = ref.match(/^todo_(\d+(?:\.\d+)*)$/);
  return match?.[1];
}

export function resolveGoalTodoReference(todoState: GoalTodoState, goalId: string | undefined, todoRef: string | undefined, label = "goal TODO ref", options: { requireDelegatable?: boolean } = {}): { node?: GoalTodoNode; matchedBy?: "id" | "path" | "legacy_path"; errors: string[] } {
  if (!todoRef?.trim()) return { errors: [] };
  if (!goalId) return { errors: [`${label} requires an active runtime goal`] };
  const ref = todoRef.trim();
  const allNodes = goalNodes(todoState, goalId);
  const nodes = options.requireDelegatable ? allNodes.filter(isDelegatableGoalTodoNode) : allNodes;
  const exact = nodes.find((node) => node.id === ref);
  if (exact) return { node: exact, matchedBy: "id", errors: [] };

  const legacyPath = legacyTodoPathFromRef(ref);
  const pathRef = GOAL_TODO_PATH_PATTERN.test(ref) ? ref : legacyPath;
  const inactiveMatch = options.requireDelegatable
    ? allNodes.find((node) => node.id === ref || (pathRef !== undefined && node.path === pathRef))
    : undefined;
  const inactiveNote = inactiveMatch
    ? hasActiveGoalTodoDelegation(inactiveMatch)
      ? ` It matches inactive TODO ${inactiveMatch.path} (${inactiveMatch.status}/${inactiveMatch.delegation?.status}) with active delegated work; do not double-delegate the same leaf. Wait for queued/running work, accept/reject/reopen a returned claim, or split into subtodos for parallel agents/workspaces.`
      : ` It matches inactive TODO ${inactiveMatch.path} (${inactiveMatch.status}${inactiveMatch.delegation ? `/${inactiveMatch.delegation.status}` : ""}); refresh active refs from get_goal_todos, reopen/resolve it first, or split into subtodos before parallel delegation.`
    : "";
  if (pathRef) {
    const matches = nodes.filter((node) => node.path === pathRef);
    if (matches.length === 1) return { node: matches[0], matchedBy: legacyPath ? "legacy_path" : "path", errors: [] };
    if (matches.length > 1) return { errors: [`${label} is ambiguous: ${ref} matched ${matches.length} active TODOs with path ${pathRef}; use a canonical TODO id from get_goal_todos.`] };
    const legacyNote = legacyPath && !inactiveNote ? ` It looks like legacy shorthand for visible TODO path ${legacyPath}, but that path is not active on this goal.` : "";
    return { errors: [`${label} not found: ${ref}.${inactiveNote}${legacyNote} Use a canonical active TODO id from get_goal_todos, or set child_goal.todo_path to a unique active visible path; for parallel work split the parent into subtodos and delegate separate leaves. Active TODO refs: ${goalTodoRefHint(nodes)}`] };
  }

  return { errors: [`${label} not found: ${ref}.${inactiveNote} Use a canonical active TODO id from get_goal_todos, or set child_goal.todo_path to a unique active visible path; for parallel work split the parent into subtodos and delegate separate leaves. Active TODO refs: ${goalTodoRefHint(nodes)}`] };
}

export function childrenOf(todoState: GoalTodoState, goalId: string, parentId: string | undefined): GoalTodoNode[] {
  return goalNodes(todoState, goalId)
    .filter((node) => (node.parentId ?? undefined) === parentId)
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }) || left.createdAt - right.createdAt);
}

export function parentPath(todoState: GoalTodoState, goalId: string, parentId: string | undefined): string | undefined {
  if (!parentId) return undefined;
  return todoState.nodes.find((node) => node.goalId === goalId && node.id === parentId)?.path;
}

export function nextPathForParent(todoState: GoalTodoState, goalId: string, parentId: string | undefined): string {
  const parent = parentPath(todoState, goalId, parentId);
  const count = childrenOf(todoState, goalId, parentId).length + 1;
  return parent ? `${parent}.${count}` : String(count);
}

export function depthForParent(todoState: GoalTodoState, goalId: string, parentId: string | undefined): number {
  if (!parentId) return 1;
  const parent = todoState.nodes.find((node) => node.goalId === goalId && node.id === parentId);
  return (parent?.depth ?? 0) + 1;
}

export function renumberGoalPaths(todoState: GoalTodoState, goalId: string): void {
  const visit = (parentId: string | undefined, prefix: string | undefined, depth: number): void => {
    const children = childrenOf(todoState, goalId, parentId).sort((left, right) => left.createdAt - right.createdAt || left.title.localeCompare(right.title));
    children.forEach((child, index) => {
      const path = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      const existing = todoState.nodes.find((node) => node.goalId === goalId && node.id === child.id);
      if (existing) {
        existing.path = path;
        existing.depth = depth;
        existing.updatedAt = unixSeconds();
      }
      visit(child.id, path, depth + 1);
    });
  };
  visit(undefined, undefined, 1);
}

export function validateGoalTodoGraph(todoState: GoalTodoState, goalId?: string): string[] {
  const errors: string[] = [];
  const nodes = goalId ? goalNodes(todoState, goalId) : todoState.nodes.map(cloneNode);
  const byId = new Map<string, GoalTodoNode>();
  for (const node of nodes) {
    if (byId.has(`${node.goalId}:${node.id}`)) errors.push(`duplicate todo id: ${node.id}`);
    byId.set(`${node.goalId}:${node.id}`, node);
    if (node.depth > todoState.policy.maxTodoDepth) errors.push(`todo ${node.path} exceeds maxTodoDepth=${todoState.policy.maxTodoDepth}`);
    if (node.delegation && node.delegation.delegationDepth > todoState.policy.maxDelegationDepth) errors.push(`todo ${node.path} exceeds maxDelegationDepth=${todoState.policy.maxDelegationDepth}`);
    const attemptIds = new Set<string>();
    for (const attempt of node.delegationAttempts ?? []) {
      if (attemptIds.has(attempt.attemptId)) errors.push(`todo ${node.path} has duplicate delegation attempt ${attempt.attemptId}`);
      attemptIds.add(attempt.attemptId);
      if (attempt.goalId !== node.goalId || attempt.todoId !== node.id) errors.push(`todo ${node.path} has mismatched delegation attempt binding ${attempt.attemptId}`);
      if (attempt.bodyStored !== false) errors.push(`todo ${node.path} delegation attempt ${attempt.attemptId} is not body-free`);
      if (attempt.delegationDepth > todoState.policy.maxDelegationDepth) errors.push(`todo ${node.path} attempt ${attempt.attemptId} exceeds maxDelegationDepth=${todoState.policy.maxDelegationDepth}`);
    }
  }
  for (const node of nodes) {
    if (node.parentId && !byId.has(`${node.goalId}:${node.parentId}`)) errors.push(`todo ${node.id} references missing parent ${node.parentId}`);
    const seen = new Set<string>();
    let cursor: GoalTodoNode | undefined = node;
    while (cursor?.parentId) {
      if (seen.has(cursor.id)) {
        errors.push(`todo cycle detected at ${cursor.id}`);
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(`${cursor.goalId}:${cursor.parentId}`);
    }
  }
  const open = nodes.filter((node) => OPEN_REQUIRED_STATUSES.has(node.status));
  if (open.length > todoState.policy.maxOpenTodos) errors.push(`open todo cap exceeded: ${open.length}/${todoState.policy.maxOpenTodos}`);
  for (const node of nodes) {
    const childCount = nodes.filter((candidate) => candidate.parentId === node.id && candidate.goalId === node.goalId).length;
    if (childCount > todoState.policy.maxChildrenPerTodo) errors.push(`todo ${node.path} exceeds maxChildrenPerTodo=${todoState.policy.maxChildrenPerTodo}`);
  }
  return errors;
}

export function addGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, input: AddGoalTodoInput, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const title = input.title.trim();
  if (!title) throw new Error("Goal TODO title is required.");
  const depth = depthForParent(state.goalTodos, goalId, input.parentId);
  if (depth > state.goalTodos.policy.maxTodoDepth) throw new Error(`Goal TODO depth exceeds maxTodoDepth=${state.goalTodos.policy.maxTodoDepth}.`);
  if (input.parentId && !state.goalTodos.nodes.some((node) => node.goalId === goalId && node.id === input.parentId)) throw new Error(`Parent TODO not found: ${input.parentId}`);
  const node: GoalTodoNode = {
    id: nextTodoId(),
    goalId,
    parentId: input.parentId,
    path: nextPathForParent(state.goalTodos, goalId, input.parentId),
    depth,
    title,
    descriptionHash: input.descriptionHash,
    status: input.status ?? "planned",
    owner: input.owner ?? "agent",
    required: input.required !== false,
    priority: input.priority ?? "normal",
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    validationCommands: input.validationCommands ?? [],
    createdAt: unixSeconds(),
    updatedAt: unixSeconds(),
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "add", source, goalId, node, at: unixSeconds() });
  return cloneNode(node);
}

export function patchGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, patch: Partial<GoalTodoNode>, source: GoalTodoEventSource = "tool", authorization?: GoalTodoTransitionAuthorization): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const normalized = normalizePatch(patch);
  const requestedStatus = normalized.status;
  const statusChanges = requestedStatus !== undefined && requestedStatus !== existing.status;
  const clearsReviewNoShip = existing.reviewNoShip === true && "reviewNoShip" in normalized && normalized.reviewNoShip !== true;

  if (!statusChanges) authorizeGoalTodoTransition(existing, "update", { requestedStatus });
  if (statusChanges && (!isCurrentGoalTodoAuthorization(existing, authorization) || authorization.decision.nextStatus !== requestedStatus)) {
    authorizeGoalTodoTransition(existing, "update", { requestedStatus });
  }
  if (clearsReviewNoShip && (!statusChanges || !isCurrentGoalTodoAuthorization(existing, authorization))) {
    authorizeGoalTodoTransition(existing, "update", { requestedStatus: existing.status === "done" ? "ready" : "done" });
  }

  const clearFields = GOAL_TODO_PATCH_CLEAR_FIELDS.filter((field) => field in normalized && normalized[field] === undefined);
  const next = applyPatchToNode(existing, normalized);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "patch", source, goalId, todoId, patch: normalized, clearFields: [...clearFields], at: unixSeconds() });
  return cloneNode(next);
}

const SAFE_STATUS_INTENT_ACTIONS: Partial<Record<GoalTodoStatus, GoalTodoTransitionAction>> = {
  ready: "mark_ready",
  in_progress: "start",
  needs_review: "mark_needs_review",
  needs_oracle: "mark_needs_oracle",
  needs_user: "mark_needs_user",
};

const DEDICATED_STATUS_INTENT_ACTIONS: Partial<Record<GoalTodoStatus, GoalTodoTransitionAction>> = {
  delegated: "queue_delegation",
  claim_returned: "return_claim",
  blocked: "block",
  done: "complete",
  skipped: "skip",
};

function rejectDedicatedStatusIntent(node: GoalTodoNode, requestedStatus: GoalTodoStatus, explicitSafeActions?: readonly GoalTodoTransitionAction[]): never {
  const dedicatedAction = DEDICATED_STATUS_INTENT_ACTIONS[requestedStatus];
  const safeActions = explicitSafeActions ?? (dedicatedAction ? [dedicatedAction] : []);
  const diagnostic: GoalTodoTransitionDiagnostic = Object.freeze({
    schema: "zob.goal-todo-transition-diagnostic.v1",
    code: "dedicated_transition_required",
    current: node.status,
    action: safeActions[0] ?? dedicatedAction ?? "update",
    safe_next_actions: Object.freeze([...safeActions]),
    retry_policy: "never",
    required_guards: Object.freeze([]),
  });
  const guidance = requestedStatus === "done" || requestedStatus === "skipped"
    ? "update_goal_todo cannot mark TODOs done or skipped; use resolve_goal_todo"
    : `update_goal_todo cannot request status=${requestedStatus}; use the dedicated Goal/TODO transition tool`;
  throw new GoalTodoTransitionError(diagnostic, guidance);
}

/** Map the public metadata/status request to one explicit domain action; unsafe lifecycle intents never become raw patches. */
export function updateGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, patch: Partial<GoalTodoNode>, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const requestedStatus = patch.status;
  if (requestedStatus === undefined || requestedStatus === existing.status) return patchGoalTodo(pi, state, goalId, todoId, patch, source);
  if (existing.status === "done" || existing.status === "skipped") rejectDedicatedStatusIntent(existing, requestedStatus, ["reopen"]);
  if (existing.status === "blocked") rejectDedicatedStatusIntent(existing, requestedStatus, ["reopen", "skip"]);
  if (existing.status === "delegated") rejectDedicatedStatusIntent(existing, requestedStatus, existing.delegation && ["failed", "rejected", "unknown"].includes(existing.delegation.status) ? ["recover_delegation"] : ["block"]);
  if ((existing.status === "claim_returned" || existing.status === "needs_review" || existing.status === "needs_oracle") && (existing.claim || existing.delegation)) {
    rejectDedicatedStatusIntent(existing, requestedStatus, ["accept_claim", "reject_claim", "block"]);
  }
  if (existing.delegation && ["failed", "rejected", "unknown"].includes(existing.delegation.status)) rejectDedicatedStatusIntent(existing, requestedStatus, ["recover_delegation"]);
  const action = SAFE_STATUS_INTENT_ACTIONS[requestedStatus];
  if (!action) rejectDedicatedStatusIntent(existing, requestedStatus);
  const authorization = authorizeGoalTodoTransition(existing, action, {
    evidenceRefs: patch.evidenceRefs,
    validationCommands: patch.validationCommands,
  });
  return patchGoalTodo(pi, state, goalId, todoId, { ...patch, status: authorization.decision.nextStatus }, source, authorization);
}

export function goalTodoNeedsSkipEvidence(node: GoalTodoNode): boolean {
  return node.priority === "critical" || Boolean(node.delegation) || node.owner === "factory" || node.owner === "orchestration";
}

export function completeGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { evidenceRefs?: string[]; validationCommands?: string[]; skipped?: boolean; reason?: string; repoRoot?: string; expectedValidationPolicy?: GoalTodoClaimValidationPolicy; expectedClaimHash?: string; expectedAttemptId?: string; expectedGraphRevision?: number; expectedTodoRevision?: number; userResolved?: boolean } = {}, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  if (!input.skipped && existing.status === "done") {
    if ((existing.delegation && existing.delegation.status !== "accepted") || (existing.claim && existing.delegation?.status !== "accepted")) authorizeGoalTodoTransition(existing, "complete");
    return cloneNode(existing);
  }
  if (!input.skipped && (existing.status === "claim_returned" || existing.status === "needs_oracle" || existing.delegation?.status === "claim_returned")) {
    if (!input.expectedClaimHash || !input.expectedAttemptId || input.expectedGraphRevision === undefined || input.expectedTodoRevision === undefined || !input.expectedValidationPolicy) throw new Error(`claim acceptance requires exact claim/attempt/policy/graph/TODO bindings for ${todoId}`);
    return acceptGoalTodoClaim(pi, state, goalId, todoId, {
      evidenceRefs: input.evidenceRefs,
      validationCommands: input.validationCommands,
      repoRoot: input.repoRoot,
      expectedValidationPolicy: input.expectedValidationPolicy,
      expectedClaimHash: input.expectedClaimHash,
      expectedAttemptId: input.expectedAttemptId,
      expectedGraphRevision: input.expectedGraphRevision,
      expectedTodoRevision: input.expectedTodoRevision,
    }, source);
  }

  const evidenceRefs = [...new Set([...existing.evidenceRefs, ...(input.evidenceRefs ?? [])])];
  const validationCommands = [...new Set([...existing.validationCommands, ...(input.validationCommands ?? [])])];
  const action: GoalTodoTransitionAction = input.skipped ? "skip" : "complete";
  const reason = input.reason?.trim();
  const authorization = authorizeGoalTodoTransition(existing, action, {
    evidenceRefs: input.evidenceRefs,
    validationCommands: input.validationCommands,
    reason,
    userResolved: input.userResolved,
  });
  return patchGoalTodo(pi, state, goalId, todoId, {
    status: authorization.decision.nextStatus,
    evidenceRefs,
    validationCommands,
    skipReason: input.skipped ? reason : existing.skipReason,
    blocker: undefined,
    reviewNoShip: undefined,
  }, source, authorization);
}

export function blockGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, reason: string, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const cleanReason = reason.trim();
  const authorization = authorizeGoalTodoTransition(existing, "block", { reason: cleanReason });
  return patchGoalTodo(pi, state, goalId, todoId, { status: authorization.decision.nextStatus, blocker: cleanReason, reviewNoShip: true }, source, authorization);
}

export function splitGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, parentId: string, titles: string[], source: GoalTodoEventSource = "tool"): GoalTodoNode[] {
  const parent = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === parentId);
  if (!parent) throw new Error(`Parent TODO not found: ${parentId}`);
  const cleanTitles = titles.map((title) => title.trim()).filter(Boolean);
  if (cleanTitles.length === 0) throw new Error("split_goal_todo requires at least one child title.");
  if (cleanTitles.length + childrenOf(state.goalTodos, goalId, parentId).length > state.goalTodos.policy.maxChildrenPerTodo) throw new Error(`split would exceed maxChildrenPerTodo=${state.goalTodos.policy.maxChildrenPerTodo}`);
  authorizeGoalTodoTransition(parent, "start");
  const children = cleanTitles.map((title) => addGoalTodo(pi, state, goalId, { title, parentId, required: true, priority: parent.priority, owner: "agent" }, source));
  appendGoalTodoEvent(pi, state, { version: 1, kind: "split", source, goalId, todoId: parentId, childIds: children.map((child) => child.id), at: unixSeconds() });
  return children;
}

function safeOptionalMetadataId(value: string | undefined, prefix: string): string | undefined {
  if (!value?.trim()) return undefined;
  return SAFE_METADATA_ID.test(value.trim()) ? value.trim() : safeDelegationAttemptId(value, prefix);
}

function cleanGateIssueCodes(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => /^[a-z0-9_]+$/.test(value)))].slice(0, 32);
}

function buildAttemptGateHash(input: { status: GoalTodoDelegationAttemptStatus; reasonCode: GoalTodoDelegationAttemptReasonCode; outputContract?: string; gateIssueCodes: string[]; gateIssueCount: number }): string | undefined {
  if (input.gateIssueCount === 0 && input.gateIssueCodes.length === 0 && !input.status.startsWith("failed_output_gate")) return undefined;
  return sha256(JSON.stringify([input.status, input.reasonCode, input.outputContract ?? "", input.gateIssueCodes, input.gateIssueCount]));
}

export interface FinalizeGoalTodoDelegationAttemptInput {
  attemptId: string;
  runId: string;
  requestId?: string;
  agent?: string;
  childGoalId?: string;
  delegationDepth?: number;
  status: Extract<GoalTodoDelegationAttemptStatus, "failed_preflight" | "failed_runtime" | "failed_output_gate_format" | "failed_output_gate_semantic" | "output_declared_incomplete" | "cancelled" | "liveness_unknown">;
  reasonCode: GoalTodoDelegationAttemptReasonCode;
  failureKind?: GoalTodoDelegationAttemptFailureKind;
  outputContract?: string;
  validationPolicy?: GoalTodoClaimValidationPolicy;
  outputHash?: string;
  failureHash?: string;
  gateIssueCodes?: string[];
  gateIssueCount?: number;
  evidenceRefCount?: number;
  validationCommandCount?: number;
}

export function linkGoalTodoDelegation(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { attemptId?: string; runId: string; agent?: string; childGoalId?: string; requestId?: string; delegationDepth?: number; status?: GoalTodoDelegationStatus; outputContract?: string; validationPolicy?: GoalTodoClaimValidationPolicy }, source: GoalTodoEventSource = "delegation"): GoalTodoNode | undefined {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) return undefined;
  const status = input.status ?? "running";
  if (status !== "queued" && status !== "running") throw new Error(`Goal TODO delegation link requires queued or running status; received ${status}.`);
  authorizeGoalTodoTransition(existing, "queue_delegation");
  const at = unixSeconds();
  const attemptId = safeDelegationAttemptId(input.attemptId ?? input.runId, "attempt");
  const runId = safeDelegationAttemptId(input.runId, "run");
  const requestId = safeOptionalMetadataId(input.requestId, "request");
  const attempt: GoalTodoDelegationAttempt = {
    attemptId,
    runId,
    requestId,
    requestIdHash: input.requestId ? sha256(input.requestId) : undefined,
    goalId,
    todoId,
    todoPath: existing.path,
    parentTodoId: existing.parentId,
    boundGoalRevision: state.runtimeGoal?.goalId === goalId ? state.runtimeGoal.revision : 0,
    boundGraphRevision: (state.goalTodos.graphRevisions[goalId] ?? 0) + 1,
    boundTodoRevision: (existing.revision ?? 0) + 1,
    agent: safeOptionalMetadataId(input.agent, "agent"),
    childGoalId: safeOptionalMetadataId(input.childGoalId, "child_goal"),
    delegationDepth: Math.max(0, Math.trunc(input.delegationDepth ?? existing.delegation?.delegationDepth ?? 1)),
    status,
    reasonCode: status === "queued" ? "queued" : "child_started",
    outputContract: safeOptionalMetadataId(input.outputContract, "contract"),
    validationPolicy: input.validationPolicy ?? "parent_review",
    gateIssueCodes: [],
    gateIssueCount: 0,
    evidenceRefCount: 0,
    validationCommandCount: 0,
    queuedAt: at,
    startedAt: status === "running" ? at : undefined,
    updatedAt: at,
    bodyStored: false,
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "delegation_attempt_started", source, goalId, todoId, attempt, at });
  const linked = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  return linked ? cloneNode(linked) : undefined;
}

/** Finalize only the exact latest bound attempt. A failed preflight may create its first and only terminal snapshot. */
export function finalizeGoalTodoDelegationAttempt(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: FinalizeGoalTodoDelegationAttemptInput, source: GoalTodoEventSource = "delegation"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  if (existing.claim) throw new Error(`delegation_attempt_has_claim: ${todoId}`);
  const attemptId = safeDelegationAttemptId(input.attemptId, "attempt");
  const runId = safeDelegationAttemptId(input.runId, "run");
  const latest = existing.delegationAttempts?.at(-1);
  const latestMatches = latest?.attemptId === attemptId && latest.runId === runId;
  if (latest && !latestMatches && (ACTIVE_ATTEMPT_STATUSES.has(latest.status) || input.status !== "failed_preflight")) throw new Error(`delegation_attempt_mismatch: expected ${latest.attemptId}/${latest.runId}; received ${attemptId}/${runId}`);
  const currentAttempt = latestMatches ? latest : undefined;
  if (currentAttempt && !ACTIVE_ATTEMPT_STATUSES.has(currentAttempt.status)) throw new Error(`delegation_attempt_finalized: ${currentAttempt.attemptId}/${currentAttempt.status}`);
  if (!currentAttempt && input.status !== "failed_preflight") throw new Error(`delegation_attempt_missing: ${attemptId}/${runId}`);
  if (currentAttempt && input.requestId && currentAttempt.requestIdHash !== sha256(input.requestId)) throw new Error(`delegation_attempt_request_mismatch: ${attemptId}`);
  const at = unixSeconds();
  const requestId = currentAttempt?.requestId ?? safeOptionalMetadataId(input.requestId, "request");
  const gateIssueCodes = cleanGateIssueCodes(input.gateIssueCodes);
  const gateIssueCount = Math.max(gateIssueCodes.length, Math.max(0, Math.trunc(input.gateIssueCount ?? 0)));
  const outputContract = safeOptionalMetadataId(input.outputContract ?? currentAttempt?.outputContract, "contract");
  const attempt: GoalTodoDelegationAttempt = {
    ...(currentAttempt ?? {
      attemptId,
      runId,
      goalId,
      todoId,
      todoPath: existing.path,
      parentTodoId: existing.parentId,
      boundGoalRevision: state.runtimeGoal?.goalId === goalId ? state.runtimeGoal.revision : 0,
      boundGraphRevision: (state.goalTodos.graphRevisions[goalId] ?? 0) + 1,
      boundTodoRevision: (existing.revision ?? 0) + 1,
      delegationDepth: Math.max(0, Math.trunc(input.delegationDepth ?? 1)),
      validationPolicy: input.validationPolicy ?? "parent_review",
      gateIssueCodes: [],
      gateIssueCount: 0,
      evidenceRefCount: 0,
      validationCommandCount: 0,
      updatedAt: at,
      bodyStored: false as const,
    }),
    attemptId,
    runId,
    requestId,
    requestIdHash: input.requestId ? sha256(input.requestId) : currentAttempt?.requestIdHash,
    agent: safeOptionalMetadataId(input.agent, "agent") ?? currentAttempt?.agent,
    childGoalId: safeOptionalMetadataId(input.childGoalId, "child_goal") ?? currentAttempt?.childGoalId,
    status: input.status,
    reasonCode: input.reasonCode,
    failureKind: input.failureKind,
    outputContract,
    outputHash: input.outputHash && SHA256_HEX.test(input.outputHash) ? input.outputHash : undefined,
    failureHash: input.failureHash && SHA256_HEX.test(input.failureHash) ? input.failureHash : undefined,
    gateIssueCodes,
    gateIssueCount,
    gateHash: buildAttemptGateHash({ status: input.status, reasonCode: input.reasonCode, outputContract, gateIssueCodes, gateIssueCount }),
    evidenceRefCount: Math.max(0, Math.trunc(input.evidenceRefCount ?? 0)),
    validationCommandCount: Math.max(0, Math.trunc(input.validationCommandCount ?? 0)),
    finalizedAt: at,
    updatedAt: at,
    bodyStored: false,
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "delegation_attempt_finalized", source, goalId, todoId, attempt, at });
  const finalized = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!finalized) throw new Error(`Goal TODO not found after attempt finalization: ${todoId}`);
  return cloneNode(finalized);
}

function recoveryRefsHash(refs: string[]): string {
  return sha256(JSON.stringify([...new Set(refs.map((ref) => ref.trim()).filter(Boolean))].sort()));
}

function validInactiveLivenessProof(proof: GoalTodoDelegationLivenessProof, attempt: GoalTodoDelegationAttempt): boolean {
  const inactiveCodes = new Set(["monitor_terminal_exact", "durable_preflight_terminal", "durable_child_terminal", "durable_output_terminal"]);
  const expectedProofHash = sha256(JSON.stringify([
    proof.status,
    proof.source,
    proof.code,
    attempt.attemptId,
    attempt.runId,
    attempt.status,
    proof.monitorStatus ?? "",
    proof.proofAt,
    proof.proofTimestampHash,
    attempt.boundGoalRevision,
    attempt.boundGraphRevision,
    attempt.boundTodoRevision,
  ]));
  return proof.schema === "zob.goal-todo-delegation-liveness-proof.v1"
    && proof.status === "inactive"
    && inactiveCodes.has(proof.code)
    && proof.attemptId === attempt.attemptId
    && proof.runId === attempt.runId
    && proof.attemptStatus === attempt.status
    && proof.bodyStored === false
    && Number.isSafeInteger(proof.proofAt)
    && proof.proofAt >= 0
    && proof.proofTimestampHash === sha256(String(proof.proofAt))
    && proof.proofHash === expectedProofHash;
}

export interface RecoverGoalTodoDelegationInput {
  expectedAttemptId: string;
  expectedRunId: string;
  expectedGraphRevision: number;
  expectedTodoRevision: number;
  reason: string;
  evidenceRefs: string[];
  proofRefs: string[];
  livenessProof: GoalTodoDelegationLivenessProof;
}

/** Recover exactly one inactive failed/cancelled/liveness-unknown attempt without dispatching or rewriting history. */
export function recoverGoalTodoDelegation(
  pi: ExtensionAPI,
  state: HarnessRuntimeState,
  goalId: string,
  todoId: string,
  input: RecoverGoalTodoDelegationInput,
  source: GoalTodoEventSource = "tool",
): { node: GoalTodoNode; recovery: GoalTodoDelegationRecovery } {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const latest = existing.delegationAttempts?.at(-1);
  if (!latest
    || latest.attemptId !== input.expectedAttemptId
    || latest.runId !== input.expectedRunId
    || existing.delegation?.attemptId !== input.expectedAttemptId
    || existing.delegation?.runId !== input.expectedRunId) {
    throw new Error(`delegation_attempt_mismatch: expected exact latest ${input.expectedAttemptId}/${input.expectedRunId}`);
  }
  if (existing.status !== "delegated" || existing.claim || !RECOVERABLE_DELEGATION_ATTEMPT_STATUSES.has(latest.status)) {
    throw new Error(`delegation_attempt_not_recoverable: ${latest.attemptId}/${latest.status}/${existing.status}`);
  }
  if ((state.goalTodos.graphRevisions[goalId] ?? 0) !== input.expectedGraphRevision || (existing.revision ?? 0) !== input.expectedTodoRevision) {
    throw new Error(`delegation_recovery_revision_mismatch: expected graph/todo ${input.expectedGraphRevision}/${input.expectedTodoRevision}`);
  }
  if (!validInactiveLivenessProof(input.livenessProof, latest)) throw new Error(`delegation_liveness_not_inactive: ${input.livenessProof.status}/${input.livenessProof.code}`);
  const reason = input.reason.trim();
  const evidenceRefs = [...new Set(input.evidenceRefs.map((ref) => ref.trim()).filter(Boolean))].sort();
  const proofRefs = [...new Set(input.proofRefs.map((ref) => ref.trim()).filter(Boolean))].sort();
  if (!reason) throw new Error("delegation_recovery_reason_required");
  if (evidenceRefs.length === 0 || proofRefs.length === 0) throw new Error("delegation_recovery_evidence_required");

  authorizeGoalTodoTransition(existing, "recover_delegation", {
    delegationLiveness: "inactive",
    delegationAttemptMatches: true,
    reason,
    evidenceRefs,
  });
  const recoveredAt = unixSeconds();
  const recovery: GoalTodoDelegationRecovery = {
    attemptId: latest.attemptId,
    runId: latest.runId,
    boundGoalRevision: latest.boundGoalRevision,
    boundGraphRevision: latest.boundGraphRevision,
    boundTodoRevision: latest.boundTodoRevision,
    expectedGraphRevision: input.expectedGraphRevision,
    expectedTodoRevision: input.expectedTodoRevision,
    reasonHash: sha256(reason),
    evidenceRefs,
    evidenceRefsHash: recoveryRefsHash(evidenceRefs),
    proofRefs,
    proofRefsHash: recoveryRefsHash(proofRefs),
    livenessProof: { ...input.livenessProof, bodyStored: false },
    recoveredAt,
    bodyStored: false,
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "attempt_recovered", source, goalId, todoId, recovery, at: recoveredAt });
  const recovered = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!recovered) throw new Error(`Goal TODO not found after delegation recovery: ${todoId}`);
  return { node: cloneNode(recovered), recovery };
}

/** Mark only the existing exact queued/running attempt failed; this never creates or re-queues a delegation. */
export function markGoalTodoDelegationFailed(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { runId: string; requestId: string; failureHash: string }, source: GoalTodoEventSource = "delegation"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const delegationAttemptMatches = input.runId.length > 0
    && input.requestId.length > 0
    && existing.delegation?.runId === input.runId
    && existing.delegation.requestId === input.requestId;
  authorizeGoalTodoTransition(existing, "mark_delegation_failed", {
    delegationAttemptMatches,
    failureHash: input.failureHash,
  });
  return finalizeGoalTodoDelegationAttempt(pi, state, goalId, todoId, {
    attemptId: existing.delegation?.attemptId ?? input.runId,
    runId: input.runId,
    requestId: input.requestId,
    status: "failed_runtime",
    reasonCode: "child_runtime_failed",
    failureKind: "child_runtime",
    failureHash: input.failureHash,
  }, source);
}

export function returnGoalTodoClaim(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { claimText?: string; claimHash?: string; evidenceRefs?: string[]; validationCommands?: string[]; noShip?: boolean; runId?: string; outputHash?: string; outputContract?: string; gatePassed?: boolean; childGoalStatus?: GoalTodoChildGoalStatus; statusClaim?: GoalTodoStatusClaim; targetReadiness?: GoalTodoClaimTargetReadiness; acceptanceBlockers?: string[]; childChangedPaths?: ZcommitChildChangedPathRef[] }, source: GoalTodoEventSource = "delegation"): GoalTodoNode | undefined {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) return undefined;
  const latestAttempt = existing.delegationAttempts?.at(-1);
  const runId = input.runId ?? latestAttempt?.runId;
  if (!latestAttempt || !runId || latestAttempt.runId !== runId || (latestAttempt.status !== "queued" && latestAttempt.status !== "running")) {
    throw new Error(`delegation_attempt_mismatch: canonical claim requires exact latest queued/running attempt for ${todoId}`);
  }
  const claimHash = input.claimHash ?? (input.claimText !== undefined ? sha256(input.claimText) : "");
  if (input.gatePassed !== true || input.childGoalStatus !== "ready_for_oracle" || input.statusClaim !== "done" || input.targetReadiness !== "ready_for_parent_acceptance" || !hasOnlyNoneLike(input.acceptanceBlockers ?? []) || input.noShip !== false) {
    authorizeGoalTodoTransition(existing, "return_claim", {
      evidenceRefs: input.evidenceRefs,
      validationCommands: input.validationCommands,
      prospectiveClaim: {
        claimHash,
        runId,
        outputHash: input.outputHash,
        outputContract: input.outputContract,
        gatePassed: input.gatePassed,
        childGoalStatus: input.childGoalStatus,
        statusClaim: input.statusClaim,
        targetReadiness: input.targetReadiness,
        acceptanceBlockers: input.acceptanceBlockers ?? [],
        noShip: input.noShip,
        returnedAt: unixSeconds(),
      },
    });
  }
  const outputHash = input.outputHash ?? claimHash;
  const outputContract = safeOptionalMetadataId(input.outputContract, "contract");
  if (!SHA256_HEX.test(claimHash) || !SHA256_HEX.test(outputHash)) throw new Error(`canonical claim requires exact full sha256 claim/output hashes for ${todoId}`);
  if (!outputContract || !CANONICAL_CLAIM_OUTPUT_CONTRACTS.has(outputContract)) throw new Error(`canonical claim requires an approved output contract for ${todoId}`);
  if (!latestAttempt.validationPolicy) throw new Error(`LEGACY_CLAIM_BINDING_REQUIRED: delegation attempt ${latestAttempt.attemptId} has no launch-fixed validation policy`);
  if (latestAttempt.outputContract && latestAttempt.outputContract !== outputContract) throw new Error(`claim output contract mismatch: expected ${latestAttempt.outputContract}; received ${outputContract}`);
  const gateHash = sha256(JSON.stringify(["claim_returned", outputContract, true, []]));
  const returnedAt = unixSeconds();
  const acceptanceBlockers = hasOnlyNoneLike(input.acceptanceBlockers ?? []) ? [] : [...new Set(input.acceptanceBlockers ?? [])];
  const prospectiveClaim: GoalTodoClaimRef = {
    claimVersion: 2,
    claimHash,
    attemptId: latestAttempt.attemptId,
    runId,
    goalRevision: currentGoalRevision(state, goalId),
    graphRevision: (state.goalTodos.graphRevisions[goalId] ?? 0) + 1,
    todoRevision: (existing.revision ?? 0) + 1,
    validationPolicy: latestAttempt.validationPolicy,
    outputHash,
    outputContract,
    gateHash,
    gatePassed: input.gatePassed,
    childGoalStatus: input.childGoalStatus,
    statusClaim: input.statusClaim,
    targetReadiness: input.targetReadiness,
    acceptanceBlockers,
    noShip: input.noShip,
    childChangedPaths: input.childChangedPaths ?? [],
    returnedAt,
  };
  authorizeGoalTodoTransition(existing, "return_claim", {
    evidenceRefs: input.evidenceRefs,
    validationCommands: input.validationCommands,
    prospectiveClaim,
  });
  const attempt: GoalTodoDelegationAttempt = {
    ...latestAttempt,
    status: "claim_returned",
    reasonCode: "claim_returned",
    failureKind: undefined,
    outputContract,
    outputHash,
    gateHash,
    gateIssueCodes: [],
    gateIssueCount: 0,
    evidenceRefCount: (input.evidenceRefs ?? []).length,
    validationCommandCount: (input.validationCommands ?? []).length,
    finalizedAt: undefined,
    updatedAt: returnedAt,
    bodyStored: false,
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_returned", source, goalId, todoId, claimHash, claim: prospectiveClaim, evidenceRefs: input.evidenceRefs ?? [], validationCommands: input.validationCommands ?? [], noShip: input.noShip, runId, outputHash, outputContract, gatePassed: input.gatePassed, childGoalStatus: input.childGoalStatus, statusClaim: input.statusClaim, targetReadiness: input.targetReadiness, acceptanceBlockers, childChangedPaths: input.childChangedPaths ?? [], attempt, at: returnedAt });
  return state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
}

export function requestGoalTodoClaimValidation(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { runId?: string; agent?: string } = {}, source: GoalTodoEventSource = "delegation"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const claim = existing.claim;
  const latestAttempt = existing.delegationAttempts?.at(-1);
  if (!isCanonicalGoalTodoClaimBinding(claim)) throw new Error(`LEGACY_CLAIM_BINDING_REQUIRED: TODO ${todoId}`);
  if (claim.validationPolicy !== "oracle_required") throw new Error(`claim validation policy mismatch: TODO ${todoId} is ${claim.validationPolicy}`);
  if (!latestAttempt || latestAttempt.attemptId !== claim.attemptId || latestAttempt.runId !== claim.runId || latestAttempt.status !== "claim_returned") throw new Error(`claim validation attempt mismatch for TODO ${todoId}`);
  const graphRevision = state.goalTodos.graphRevisions[goalId] ?? 0;
  const todoRevision = existing.revision ?? 0;
  if (claim.goalRevision !== currentGoalRevision(state, goalId) || claim.graphRevision !== graphRevision || claim.todoRevision !== todoRevision) throw new Error(`claim validation stale binding for TODO ${todoId}`);
  authorizeGoalTodoTransition(existing, "mark_needs_oracle");
  const requestedAt = unixSeconds();
  const validation: GoalTodoClaimValidationRef = {
    validationVersion: 1,
    claimHash: claim.claimHash,
    attemptId: claim.attemptId,
    claimRunId: claim.runId,
    claimGoalRevision: claim.goalRevision,
    claimGraphRevision: claim.graphRevision,
    claimTodoRevision: claim.todoRevision,
    validationPolicy: claim.validationPolicy,
    expectedGraphRevision: graphRevision,
    expectedTodoRevision: todoRevision,
    goalRevision: claim.goalRevision,
    graphRevision: graphRevision + 1,
    todoRevision: todoRevision + 1,
    runId: input.runId,
    agent: input.agent ?? "oracle",
    status: "running",
    evidenceRefs: [],
    validationCommands: [],
    blockingIssues: [],
    requestedAt,
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_validation_requested", source, goalId, todoId, validation, at: requestedAt });
  const node = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!node) throw new Error(`Goal TODO not found: ${todoId}`);
  return cloneNode(node);
}

export function validationStatusFromResult(input: TodoClaimValidationResult): GoalTodoClaimValidationStatus {
  if (input.noShip === true || !hasOnlyNoneLike(input.blockingIssues)) return "blocked";
  if (input.verdict === "PASS" && input.noShip === false) return "passed";
  if (input.verdict === "WARN" && input.noShip === false) return "warn";
  return "failed";
}

export function hasOnlyNoneLike(items: string[]): boolean {
  return items.length === 0 || items.every((item) => /^(none|no|n\/a|null)$/i.test(item.trim()));
}

export function isGoalTodoClaimReadyForAutoAccept(node: GoalTodoNode): boolean {
  const claim = node.claim;
  const validation = node.validation;
  if (!isCanonicalGoalTodoClaimBinding(claim) || !validation || !isCanonicalValidationBinding(validation, claim, true)) return false;
  if (claim.validationPolicy !== "oracle_required" || validation.todoRevision !== (node.revision ?? 0)) return false;
  if ((node.status !== "claim_returned" && node.status !== "needs_oracle") || node.delegation?.status !== "claim_returned") return false;
  if (claim.gatePassed !== true || claim.childGoalStatus !== "ready_for_oracle" || claim.statusClaim !== "done") return false;
  if (claim.noShip === true || validation.noShip === true) return false;
  if (claim.targetReadiness !== "ready_for_parent_acceptance") return false;
  if (!hasOnlyNoneLike(claim.acceptanceBlockers)) return false;
  if (validation.status !== "passed" || validation.verdict !== "PASS" || validation.noShip !== false) return false;
  if (validation.recommendedAction !== "accept_claim") return false;
  if (validation.confidence !== "HIGH" && validation.confidence !== "MEDIUM") return false;
  if (!hasOnlyNoneLike(validation.blockingIssues)) return false;
  return node.evidenceRefs.length > 0 || node.validationCommands.length > 0 || Boolean(node.artifacts?.outputHash);
}

export function recordGoalTodoClaimValidationResult(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { result: TodoClaimValidationResult; runId?: string; agent?: string; outputHash: string; autoAccept?: boolean; repoRoot?: string; expectedClaimHash: string; expectedAttemptId: string; expectedGraphRevision: number; expectedTodoRevision: number; expectedValidationPolicy: GoalTodoClaimValidationPolicy }, source: GoalTodoEventSource = "delegation"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const claim = existing.claim;
  const latestAttempt = existing.delegationAttempts?.at(-1);
  if (!isCanonicalGoalTodoClaimBinding(claim)) throw new Error(`LEGACY_CLAIM_BINDING_REQUIRED: TODO ${todoId}`);
  if (input.result.todoId !== todoId) throw new Error(`claim validation todo_id mismatch: ${input.result.todoId ?? "missing"} !== ${todoId}`);
  if (input.result.claimHash !== claim.claimHash || input.expectedClaimHash !== claim.claimHash) throw new Error(`claim validation claim_hash mismatch for TODO ${todoId}`);
  if (input.expectedAttemptId !== claim.attemptId || latestAttempt?.attemptId !== claim.attemptId || latestAttempt.runId !== claim.runId || latestAttempt.status !== "claim_returned") throw new Error(`claim validation attempt mismatch for TODO ${todoId}`);
  if (input.expectedValidationPolicy !== claim.validationPolicy || claim.validationPolicy !== "oracle_required") throw new Error(`claim validation policy mismatch for TODO ${todoId}`);
  if (!SHA256_HEX.test(input.outputHash)) throw new Error(`claim validation output_hash must be an exact full sha256 for TODO ${todoId}`);
  const graphRevision = state.goalTodos.graphRevisions[goalId] ?? 0;
  const todoRevision = existing.revision ?? 0;
  if (input.expectedGraphRevision !== graphRevision || input.expectedTodoRevision !== todoRevision) throw new Error(`claim validation stale graph/todo revisions for TODO ${todoId}`);
  if (claim.goalRevision !== currentGoalRevision(state, goalId)) throw new Error(`claim validation stale goal revision for TODO ${todoId}`);
  if (existing.validation) {
    if (existing.validation.status !== "running" || !isCanonicalValidationBinding(existing.validation, claim, false)
      || existing.validation.goalRevision !== currentGoalRevision(state, goalId)
      || existing.validation.graphRevision !== graphRevision
      || existing.validation.todoRevision !== todoRevision) throw new Error(`claim validation stale or already settled binding for TODO ${todoId}`);
  } else if (claim.graphRevision !== graphRevision || claim.todoRevision !== todoRevision) {
    throw new Error(`claim validation cannot rebind stale claim revisions for TODO ${todoId}`);
  }
  authorizeGoalTodoTransition(existing, "update", { requestedStatus: existing.status });
  const validatedAt = unixSeconds();
  const validation: GoalTodoClaimValidationRef = {
    validationVersion: 1,
    claimHash: claim.claimHash,
    attemptId: claim.attemptId,
    claimRunId: claim.runId,
    claimGoalRevision: claim.goalRevision,
    claimGraphRevision: claim.graphRevision,
    claimTodoRevision: claim.todoRevision,
    validationPolicy: claim.validationPolicy,
    expectedGraphRevision: graphRevision,
    expectedTodoRevision: todoRevision,
    goalRevision: claim.goalRevision,
    graphRevision: graphRevision + 1,
    todoRevision: todoRevision + 1,
    runId: input.runId ?? existing.validation?.runId,
    agent: input.agent ?? existing.validation?.agent ?? "oracle",
    status: validationStatusFromResult(input.result),
    verdict: input.result.verdict,
    recommendedAction: input.result.recommendedAction,
    noShip: input.result.noShip,
    outputHash: input.outputHash,
    evidenceRefs: input.result.evidenceRefs,
    validationCommands: input.result.validationCommands,
    blockingIssues: input.result.blockingIssues,
    confidence: input.result.confidence,
    requestedAt: existing.validation?.requestedAt,
    validatedAt,
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_validation_returned", source, goalId, todoId, validation, evidenceRefs: input.result.evidenceRefs, validationCommands: input.result.validationCommands, noShip: input.result.noShip, at: validatedAt });
  const node = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!node) throw new Error(`Goal TODO not found: ${todoId}`);
  if (input.autoAccept === true && isGoalTodoClaimReadyForAutoAccept(node)) return acceptGoalTodoClaim(pi, state, goalId, todoId, {
    evidenceRefs: input.result.evidenceRefs,
    validationCommands: input.result.validationCommands,
    repoRoot: input.repoRoot,
    expectedValidationPolicy: "oracle_required",
    expectedClaimHash: claim.claimHash,
    expectedAttemptId: claim.attemptId,
    expectedGraphRevision: validation.graphRevision!,
    expectedTodoRevision: validation.todoRevision!,
  }, source);
  return cloneNode(node);
}

export interface GoalTodoClaimBindingExpectation {
  expectedClaimHash: string;
  expectedAttemptId: string;
  expectedGraphRevision: number;
  expectedTodoRevision: number;
  expectedValidationPolicy: GoalTodoClaimValidationPolicy;
}

function exactCurrentClaimBinding(state: HarnessRuntimeState, goalId: string, existing: GoalTodoNode, input: GoalTodoClaimBindingExpectation, requirePassedValidation: boolean): { claim: GoalTodoClaimRef & { claimVersion: 2; attemptId: string; runId: string; goalRevision: number; graphRevision: number; todoRevision: number; validationPolicy: GoalTodoClaimValidationPolicy; outputHash: string; outputContract: string; gateHash: string }; validationBindingMatches: boolean } {
  const claim = existing.claim;
  if (!claim) {
    authorizeGoalTodoTransition(existing, requirePassedValidation ? "accept_claim" : "reject_claim", { reason: requirePassedValidation ? undefined : "binding_preflight" });
    throw new Error(`claim required for TODO ${existing.id}`);
  }
  if (!isCanonicalGoalTodoClaimBinding(claim)) throw new Error(`LEGACY_CLAIM_BINDING_REQUIRED: TODO ${existing.id}`);
  const goalRevision = currentGoalRevision(state, goalId);
  const graphRevision = state.goalTodos.graphRevisions[goalId] ?? 0;
  const todoRevision = existing.revision ?? 0;
  if (input.expectedGraphRevision !== graphRevision || input.expectedTodoRevision !== todoRevision) throw new Error(`claim stale graph/todo revisions for TODO ${existing.id}`);
  if (input.expectedClaimHash !== claim.claimHash) throw new Error(`claim hash mismatch for TODO ${existing.id}`);
  if (input.expectedValidationPolicy !== claim.validationPolicy) throw new Error(`claim validation policy mismatch for TODO ${existing.id}`);
  if (claim.goalRevision !== goalRevision) throw new Error(`claim stale goal revision for TODO ${existing.id}`);
  const latestAttempt = existing.delegationAttempts?.at(-1);
  const attemptExact = input.expectedAttemptId === claim.attemptId
    && latestAttempt?.attemptId === claim.attemptId
    && latestAttempt.runId === claim.runId
    && latestAttempt.status === "claim_returned"
    && latestAttempt.outputHash === claim.outputHash
    && latestAttempt.outputContract === claim.outputContract
    && latestAttempt.gateHash === claim.gateHash
    && latestAttempt.validationPolicy === claim.validationPolicy
    && existing.delegation?.attemptId === claim.attemptId
    && existing.delegation.runId === claim.runId;
  if (!attemptExact) throw new Error(`claim attempt/output/gate binding mismatch for TODO ${existing.id}`);
  const validationBindingMatches = claim.validationPolicy === "parent_review"
    ? claim.graphRevision === graphRevision && claim.todoRevision === todoRevision
    : existing.validation
      ? isCanonicalValidationBinding(existing.validation, claim, requirePassedValidation)
        && existing.validation.goalRevision === goalRevision
        && existing.validation.graphRevision === graphRevision
        && existing.validation.todoRevision === todoRevision
      : !requirePassedValidation && claim.graphRevision === graphRevision && claim.todoRevision === todoRevision;
  if (!validationBindingMatches) throw new Error(`claim validation/revision binding mismatch for TODO ${existing.id}`);
  authorizeGoalTodoTransition(existing, requirePassedValidation ? "accept_claim" : "reject_claim", {
    reason: requirePassedValidation ? undefined : "binding_preflight",
    expectedClaimHash: input.expectedClaimHash,
    expectedAttemptId: input.expectedAttemptId,
    expectedGoalRevision: goalRevision,
    expectedGraphRevision: graphRevision,
    expectedClaimRevision: input.expectedTodoRevision,
    expectedValidationPolicy: input.expectedValidationPolicy,
    validationBindingMatches,
    delegationAttemptMatches: attemptExact,
  });
  return { claim, validationBindingMatches };
}

export function assertCurrentGoalTodoClaimSettlementBinding(state: HarnessRuntimeState, goalId: string, todoId: string, input: GoalTodoClaimBindingExpectation, requirePassedValidation: boolean): void {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  exactCurrentClaimBinding(state, goalId, existing, input, requirePassedValidation);
}

export function assertCurrentGoalTodoClaimValidationBinding(state: HarnessRuntimeState, goalId: string, todoId: string, input: GoalTodoClaimBindingExpectation & { outputHash: string }): void {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const claim = existing.claim;
  const latestAttempt = existing.delegationAttempts?.at(-1);
  if (!isCanonicalGoalTodoClaimBinding(claim)) throw new Error(`LEGACY_CLAIM_BINDING_REQUIRED: TODO ${todoId}`);
  if (input.expectedClaimHash !== claim.claimHash) throw new Error(`claim validation claim_hash mismatch for TODO ${todoId}`);
  if (input.expectedAttemptId !== claim.attemptId || latestAttempt?.attemptId !== claim.attemptId || latestAttempt.runId !== claim.runId || latestAttempt.status !== "claim_returned") throw new Error(`claim validation attempt mismatch for TODO ${todoId}`);
  if (input.expectedValidationPolicy !== "oracle_required" || claim.validationPolicy !== "oracle_required") throw new Error(`claim validation policy mismatch for TODO ${todoId}`);
  if (!SHA256_HEX.test(input.outputHash)) throw new Error(`claim validation output_hash must be an exact full sha256 for TODO ${todoId}`);
  const graphRevision = state.goalTodos.graphRevisions[goalId] ?? 0;
  const todoRevision = existing.revision ?? 0;
  if (input.expectedGraphRevision !== graphRevision || input.expectedTodoRevision !== todoRevision || claim.goalRevision !== currentGoalRevision(state, goalId)) throw new Error(`claim validation stale binding for TODO ${todoId}`);
  if (existing.validation) {
    if (existing.validation.status !== "running" || !isCanonicalValidationBinding(existing.validation, claim, false)
      || existing.validation.goalRevision !== currentGoalRevision(state, goalId)
      || existing.validation.graphRevision !== graphRevision
      || existing.validation.todoRevision !== todoRevision) throw new Error(`claim validation stale or already settled binding for TODO ${todoId}`);
  } else if (claim.graphRevision !== graphRevision || claim.todoRevision !== todoRevision) throw new Error(`claim validation cannot rebind stale claim revisions for TODO ${todoId}`);
}

export function acceptGoalTodoClaim(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: GoalTodoClaimBindingExpectation & { evidenceRefs?: string[]; validationCommands?: string[]; repoRoot?: string }, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const { claim, validationBindingMatches } = exactCurrentClaimBinding(state, goalId, existing, input, true);
  authorizeGoalTodoTransition(existing, "accept_claim", {
    evidenceRefs: input.evidenceRefs,
    validationCommands: input.validationCommands,
    expectedClaimHash: input.expectedClaimHash,
    expectedAttemptId: input.expectedAttemptId,
    expectedGoalRevision: currentGoalRevision(state, goalId),
    expectedGraphRevision: input.expectedGraphRevision,
    expectedClaimRevision: input.expectedTodoRevision,
    expectedValidationPolicy: input.expectedValidationPolicy,
    validationBindingMatches,
  });
  const changedPaths = claim.childChangedPaths ?? [];
  if (changedPaths.length > 0 && !input.repoRoot) throw new Error(`repoRoot is required to accept delegated TODO claim ${todoId} with child changed paths.`);
  const binding = claimResolutionBinding(claim, { goalRevision: currentGoalRevision(state, goalId), graphRevision: input.expectedGraphRevision, todoRevision: input.expectedTodoRevision }, existing.validation);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_accepted", source, goalId, todoId, binding, evidenceRefs: input.evidenceRefs ?? [], validationCommands: input.validationCommands ?? [], at: unixSeconds() });
  if (changedPaths.length > 0) recordZcommitOwnedPaths(state.zcommit, input.repoRoot!, changedPaths, "parent_accepted_child_claim");
  const node = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!node) throw new Error(`Goal TODO not found: ${todoId}`);
  return cloneNode(node);
}

export function rejectGoalTodoClaim(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: GoalTodoClaimBindingExpectation & { reason: string }, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const cleanReason = input.reason.trim();
  const { claim, validationBindingMatches } = exactCurrentClaimBinding(state, goalId, existing, input, false);
  authorizeGoalTodoTransition(existing, "reject_claim", {
    reason: cleanReason,
    expectedClaimHash: input.expectedClaimHash,
    expectedAttemptId: input.expectedAttemptId,
    expectedGoalRevision: currentGoalRevision(state, goalId),
    expectedGraphRevision: input.expectedGraphRevision,
    expectedClaimRevision: input.expectedTodoRevision,
    expectedValidationPolicy: input.expectedValidationPolicy,
    validationBindingMatches,
  });
  const binding = claimResolutionBinding(claim, { goalRevision: currentGoalRevision(state, goalId), graphRevision: input.expectedGraphRevision, todoRevision: input.expectedTodoRevision }, existing.validation);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_rejected", source, goalId, todoId, binding, reasonHash: sha256(cleanReason), at: unixSeconds() });
  const node = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!node) throw new Error(`Goal TODO not found: ${todoId}`);
  return cloneNode(node);
}

export function nextValidGoalTodoActions(node: GoalTodoNode): ResolveGoalTodoAction[] {
  if (node.status === "done" || node.status === "skipped") return ["reopen"];
  if (node.status === "claim_returned") return ["accept_claim", "reject_claim", "block"];
  if (node.status === "needs_review") return ["reject_claim", "block"];
  if (node.status === "needs_oracle") return ["accept_claim", "reject_claim", "block"];
  if (node.status === "delegated") return ["block"];
  if (node.status === "blocked") return ["reopen", "skip"];
  return ["complete", "block", "skip"];
}

export function resolveGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { action: ResolveGoalTodoAction; evidenceRefs?: string[]; validationCommands?: string[]; reason?: string; repoRoot?: string; expectedValidationPolicy?: GoalTodoClaimValidationPolicy; expectedAutoResolution?: "complete" | "accept_claim"; expectedClaimHash?: string; expectedAttemptId?: string; expectedGraphRevision?: number; expectedTodoRevision?: number; casBound?: boolean; userResolved?: boolean } = { action: "auto" }, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const autoAccept = input.action === "auto" && (existing.status === "claim_returned" || existing.status === "needs_oracle" || existing.delegation?.status === "claim_returned");
  const actualAutoResolution: GoalTodoTransitionAction = autoAccept ? "accept_claim" : "complete";
  if (input.action === "auto" && ((autoAccept && input.expectedAutoResolution !== "accept_claim") || (input.expectedAutoResolution !== undefined && input.expectedAutoResolution !== actualAutoResolution))) {
    const diagnostic: GoalTodoTransitionDiagnostic = Object.freeze({
      schema: "zob.goal-todo-transition-diagnostic.v1",
      code: "auto_resolution_mismatch",
      current: existing.status,
      action: "no_op",
      safe_next_actions: Object.freeze([actualAutoResolution]),
      retry_policy: "never",
      required_guards: Object.freeze([]),
    });
    throw new GoalTodoTransitionError(diagnostic, `resolve_goal_todo action=auto for TODO ${todoId} requires expected_auto_resolution=${actualAutoResolution}`);
  }
  if (input.action === "auto" && !autoAccept && (existing.delegation || existing.claim)) {
    authorizeGoalTodoTransition(existing, "complete", { evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands });
  }
  const action: ResolveGoalTodoAction = autoAccept ? "accept_claim" : input.action === "auto" ? "complete" : input.action;
  if (action === "complete") return completeGoalTodo(pi, state, goalId, todoId, { evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands, repoRoot: input.repoRoot, userResolved: input.userResolved }, source);
  if (action === "skip") return completeGoalTodo(pi, state, goalId, todoId, { skipped: true, reason: input.reason, evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands, repoRoot: input.repoRoot, userResolved: input.userResolved }, source);
  if (action === "accept_claim") {
    if (!input.expectedClaimHash || !input.expectedAttemptId || input.expectedGraphRevision === undefined || input.expectedTodoRevision === undefined || !input.expectedValidationPolicy) throw new Error(`claim acceptance requires exact claim/attempt/policy/graph/TODO bindings for ${todoId}`);
    return acceptGoalTodoClaim(pi, state, goalId, todoId, {
      evidenceRefs: input.evidenceRefs,
      validationCommands: input.validationCommands,
      repoRoot: input.repoRoot,
      expectedValidationPolicy: input.expectedValidationPolicy,
      expectedClaimHash: input.expectedClaimHash,
      expectedAttemptId: input.expectedAttemptId,
      expectedGraphRevision: input.expectedGraphRevision,
      expectedTodoRevision: input.expectedTodoRevision,
    }, source);
  }
  if (action === "reject_claim") {
    if (!input.expectedClaimHash || !input.expectedAttemptId || input.expectedGraphRevision === undefined || input.expectedTodoRevision === undefined || !input.expectedValidationPolicy) throw new Error(`claim rejection requires exact claim/attempt/policy/graph/TODO bindings for ${todoId}`);
    return rejectGoalTodoClaim(pi, state, goalId, todoId, {
      reason: input.reason ?? "",
      expectedClaimHash: input.expectedClaimHash,
      expectedAttemptId: input.expectedAttemptId,
      expectedGraphRevision: input.expectedGraphRevision,
      expectedTodoRevision: input.expectedTodoRevision,
      expectedValidationPolicy: input.expectedValidationPolicy,
    }, source);
  }
  if (action === "block") return blockGoalTodo(pi, state, goalId, todoId, input.reason ?? "", source);
  if (action === "reopen") {
    const authorization = authorizeGoalTodoTransition(existing, "reopen", {
      evidenceRefs: input.evidenceRefs,
      validationCommands: input.validationCommands,
      reason: input.reason,
      userResolved: input.userResolved,
      casBound: input.casBound,
      clearDelegationOnReopen: true,
    });
    return patchGoalTodo(pi, state, goalId, todoId, {
      status: authorization.decision.nextStatus,
      owner: "agent",
      evidenceRefs: [...new Set([...existing.evidenceRefs, ...(input.evidenceRefs ?? [])])],
      validationCommands: [...new Set([...existing.validationCommands, ...(input.validationCommands ?? [])])],
      blocker: undefined,
      skipReason: undefined,
      reviewNoShip: undefined,
      delegation: undefined,
      claim: undefined,
      validation: undefined,
    }, source, authorization);
  }
  throw new Error(`Unsupported resolve_goal_todo action: ${input.action}`);
}

export function focusGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string | undefined, source: GoalTodoEventSource = "command"): void {
  if (todoId && !state.goalTodos.nodes.some((node) => node.goalId === goalId && node.id === todoId)) throw new Error(`Goal TODO not found: ${todoId}`);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "focus", source, goalId, todoId, at: unixSeconds() });
}
