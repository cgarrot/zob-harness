import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HarnessRuntimeState } from "../../../runtime/state.js";
import type { AddGoalTodoInput, GoalTodoChildGoalStatus, GoalTodoClaimTargetReadiness, GoalTodoClaimValidationRef, GoalTodoClaimValidationStatus, GoalTodoDelegationRef, GoalTodoDelegationStatus, GoalTodoEventSource, GoalTodoNode, GoalTodoState, GoalTodoStatus, GoalTodoStatusClaim, ResolveGoalTodoAction, TodoClaimValidationResult } from "../goal-todo-types.js";
import { recordZcommitOwnedPaths, type ZcommitChildChangedPathRef } from "../../git/git-ops.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { OPEN_REQUIRED_STATUSES } from "./constants.js";
import { applyPatchToNode, cloneNode, normalizePatch, unixSeconds } from "./normalize.js";
import { appendGoalTodoEvent, goalNodes, nextTodoId } from "./reducer.js";

export const GOAL_TODO_PATH_PATTERN = /^\d+(?:\.\d+)*$/;
export const DELEGATABLE_GOAL_TODO_STATUSES = new Set<GoalTodoStatus>(["planned", "ready", "in_progress", "needs_review"]);
export const ACTIVE_DELEGATION_STATUSES = new Set<GoalTodoDelegationStatus>(["queued", "running", "claim_returned"]);
export const RECOVERABLE_DELEGATION_STATUSES = new Set<GoalTodoDelegationStatus>(["failed", "rejected"]);

export function hasActiveGoalTodoDelegation(node: GoalTodoNode): boolean {
  return Boolean(node.delegation && ACTIVE_DELEGATION_STATUSES.has(node.delegation.status));
}

export function isRecoverableDelegatedGoalTodoNode(node: GoalTodoNode): boolean {
  return node.status === "delegated" && (!node.delegation || RECOVERABLE_DELEGATION_STATUSES.has(node.delegation.status));
}

export function isDelegatableGoalTodoNode(node: GoalTodoNode): boolean {
  return (DELEGATABLE_GOAL_TODO_STATUSES.has(node.status) || isRecoverableDelegatedGoalTodoNode(node)) && !hasActiveGoalTodoDelegation(node);
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

export function patchGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, patch: Partial<GoalTodoNode>, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const next = applyPatchToNode(existing, patch);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "patch", source, goalId, todoId, patch: normalizePatch(patch), at: unixSeconds() });
  return cloneNode(next);
}

export function goalTodoNeedsSkipEvidence(node: GoalTodoNode): boolean {
  return node.priority === "critical" || Boolean(node.delegation) || node.owner === "factory" || node.owner === "orchestration";
}

export function completeGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { evidenceRefs?: string[]; validationCommands?: string[]; skipped?: boolean; reason?: string; repoRoot?: string } = {}, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const evidenceRefs = [...new Set([...existing.evidenceRefs, ...(input.evidenceRefs ?? [])])];
  const validationCommands = [...new Set([...existing.validationCommands, ...(input.validationCommands ?? [])])];
  const requiredChildren = state.goalTodos.nodes.filter((node) => node.goalId === goalId && node.parentId === todoId && node.required !== false);
  const delegatedCompletionCoveredByChildren = !input.skipped
    && Boolean(existing.delegation && existing.delegation.status !== "accepted")
    && requiredChildren.length > 0
    && requiredChildren.every((node) => node.status === "done" || node.status === "skipped")
    && (evidenceRefs.length > 0 || validationCommands.length > 0 || Boolean(existing.artifacts?.outputHash));
  if (!input.skipped && existing.delegation && existing.delegation.status !== "accepted" && !delegatedCompletionCoveredByChildren) {
    if (existing.status === "claim_returned" || existing.delegation.status === "claim_returned") {
      return acceptGoalTodoClaim(pi, state, goalId, todoId, { evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands, repoRoot: input.repoRoot }, source);
    }
    throw new Error(`Delegated TODO ${todoId} cannot be marked done directly while delegation status is ${existing.delegation.status}. Wait for claim_returned, then use resolve_goal_todo(action=complete|auto) or accept_goal_todo_claim; or reject/block if evidence/no_ship blocks.`);
  }
  if (input.skipped) {
    const reason = input.reason?.trim();
    if (!reason) throw new Error(`skip for TODO ${todoId} requires explicit reason; no default skip reason is allowed.`);
    if (goalTodoNeedsSkipEvidence(existing) && evidenceRefs.length === 0 && validationCommands.length === 0 && !existing.artifacts?.outputHash) {
      throw new Error(`skip for critical/delegated/factory/orchestration TODO ${todoId} requires evidence_refs or validation_commands.`);
    }
  }
  return patchGoalTodo(pi, state, goalId, todoId, {
    status: input.skipped ? "skipped" : "done",
    evidenceRefs,
    validationCommands,
    skipReason: input.skipped ? input.reason?.trim() : existing.skipReason,
    blocker: undefined,
    reviewNoShip: undefined,
    delegation: existing.delegation ? { ...existing.delegation, status: input.skipped ? "rejected" : delegatedCompletionCoveredByChildren ? "accepted" : existing.delegation.status } : undefined,
  }, source);
}

export function blockGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, reason: string, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  return patchGoalTodo(pi, state, goalId, todoId, { status: "blocked", blocker: reason.trim() || "blocked", reviewNoShip: true }, source);
}

export function splitGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, parentId: string, titles: string[], source: GoalTodoEventSource = "tool"): GoalTodoNode[] {
  const parent = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === parentId);
  if (!parent) throw new Error(`Parent TODO not found: ${parentId}`);
  const cleanTitles = titles.map((title) => title.trim()).filter(Boolean);
  if (cleanTitles.length === 0) throw new Error("split_goal_todo requires at least one child title.");
  if (cleanTitles.length + childrenOf(state.goalTodos, goalId, parentId).length > state.goalTodos.policy.maxChildrenPerTodo) throw new Error(`split would exceed maxChildrenPerTodo=${state.goalTodos.policy.maxChildrenPerTodo}`);
  const children = cleanTitles.map((title) => addGoalTodo(pi, state, goalId, { title, parentId, required: true, priority: parent.priority, owner: "agent" }, source));
  appendGoalTodoEvent(pi, state, { version: 1, kind: "split", source, goalId, todoId: parentId, childIds: children.map((child) => child.id), at: unixSeconds() });
  return children;
}

export function linkGoalTodoDelegation(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { runId: string; agent?: string; childGoalId?: string; requestId?: string; delegationDepth?: number; status?: GoalTodoDelegationStatus }, source: GoalTodoEventSource = "delegation"): GoalTodoNode | undefined {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) return undefined;
  const delegation: GoalTodoDelegationRef = {
    runId: input.runId,
    agent: input.agent,
    childGoalId: input.childGoalId,
    requestId: input.requestId,
    delegationDepth: Math.max(0, Math.trunc(input.delegationDepth ?? existing.delegation?.delegationDepth ?? 1)),
    status: input.status ?? "running",
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "delegate_link", source, goalId, todoId, runId: input.runId, delegation, at: unixSeconds() });
  return state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
}

export function returnGoalTodoClaim(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { claimText?: string; claimHash?: string; evidenceRefs?: string[]; validationCommands?: string[]; noShip?: boolean; runId?: string; outputHash?: string; outputContract?: string; gatePassed?: boolean; childGoalStatus?: GoalTodoChildGoalStatus; statusClaim?: GoalTodoStatusClaim; targetReadiness?: GoalTodoClaimTargetReadiness; acceptanceBlockers?: string[]; childChangedPaths?: ZcommitChildChangedPathRef[] }, source: GoalTodoEventSource = "delegation"): GoalTodoNode | undefined {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) return undefined;
  const claimHash = input.claimHash ?? sha256(input.claimText ?? `${goalId}:${todoId}:${Date.now()}`);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_returned", source, goalId, todoId, claimHash, evidenceRefs: input.evidenceRefs ?? [], validationCommands: input.validationCommands ?? [], noShip: input.noShip, runId: input.runId, outputHash: input.outputHash, outputContract: input.outputContract, gatePassed: input.gatePassed, childGoalStatus: input.childGoalStatus, statusClaim: input.statusClaim, targetReadiness: input.targetReadiness, acceptanceBlockers: input.acceptanceBlockers ?? [], childChangedPaths: input.childChangedPaths ?? [], at: unixSeconds() });
  return state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
}

export function requestGoalTodoClaimValidation(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { runId?: string; agent?: string } = {}, source: GoalTodoEventSource = "delegation"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  if (existing.status !== "claim_returned" || existing.delegation?.status !== "claim_returned" || !existing.claim) throw new Error(`TODO ${todoId} has no returned delegated claim to validate.`);
  const validation: GoalTodoClaimValidationRef = {
    runId: input.runId,
    agent: input.agent ?? "oracle",
    status: "running",
    evidenceRefs: [],
    validationCommands: [],
    blockingIssues: [],
    requestedAt: unixSeconds(),
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_validation_requested", source, goalId, todoId, validation, at: unixSeconds() });
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
  if (!claim || !validation) return false;
  if (node.status !== "claim_returned" || node.delegation?.status !== "claim_returned") return false;
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

export function recordGoalTodoClaimValidationResult(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { result: TodoClaimValidationResult; runId?: string; agent?: string; outputHash?: string; autoAccept?: boolean; repoRoot?: string }, source: GoalTodoEventSource = "delegation"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  if (!existing.claim) throw new Error(`TODO ${todoId} has no returned delegated claim to validate.`);
  if (input.result.todoId && input.result.todoId !== todoId) throw new Error(`claim validation todo_id mismatch: ${input.result.todoId} !== ${todoId}`);
  if (input.result.claimHash && input.result.claimHash !== existing.claim.claimHash) throw new Error(`claim validation claim_hash mismatch for TODO ${todoId}`);
  if (input.autoAccept === true && input.result.claimHash !== existing.claim.claimHash) throw new Error(`claim validation requires exact claim_hash for auto-accept of TODO ${todoId}.`);
  const validation: GoalTodoClaimValidationRef = {
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
    validatedAt: unixSeconds(),
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_validation_returned", source, goalId, todoId, validation, evidenceRefs: input.result.evidenceRefs, validationCommands: input.result.validationCommands, noShip: input.result.noShip, at: unixSeconds() });
  const node = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!node) throw new Error(`Goal TODO not found: ${todoId}`);
  if (input.autoAccept === true && isGoalTodoClaimReadyForAutoAccept(node)) return acceptGoalTodoClaim(pi, state, goalId, todoId, { evidenceRefs: input.result.evidenceRefs, validationCommands: input.result.validationCommands, repoRoot: input.repoRoot }, source);
  return cloneNode(node);
}

export function acceptGoalTodoClaim(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { evidenceRefs?: string[]; validationCommands?: string[]; repoRoot?: string } = {}, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  if (existing.validation && existing.validation.status !== "passed") throw new Error(`TODO ${todoId} claim validation is ${existing.validation.status}; wait for oracle PASS/no_ship=false or reject/block.`);
  if (existing.status !== "claim_returned" || existing.delegation?.status !== "claim_returned") throw new Error(`TODO ${todoId} has no returned delegated claim to accept.`);
  const changedPaths = existing.claim?.childChangedPaths ?? [];
  if (changedPaths.length > 0 && !input.repoRoot) throw new Error(`repoRoot is required to accept delegated TODO claim ${todoId} with child changed paths.`);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_accepted", source, goalId, todoId, evidenceRefs: input.evidenceRefs ?? [], validationCommands: input.validationCommands ?? [], at: unixSeconds() });
  if (changedPaths.length > 0) recordZcommitOwnedPaths(state.zcommit, input.repoRoot!, changedPaths, "parent_accepted_child_claim");
  const node = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!node) throw new Error(`Goal TODO not found: ${todoId}`);
  return cloneNode(node);
}

export function rejectGoalTodoClaim(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, reason: string, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_rejected", source, goalId, todoId, reasonHash: sha256(reason), at: unixSeconds() });
  const node = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!node) throw new Error(`Goal TODO not found: ${todoId}`);
  return cloneNode(node);
}

export function nextValidGoalTodoActions(node: GoalTodoNode): ResolveGoalTodoAction[] {
  if (node.status === "done" || node.status === "skipped") return ["reopen"];
  if (node.status === "claim_returned" || node.delegation?.status === "claim_returned") return ["accept_claim", "reject_claim", "block", "reopen"];
  if (node.status === "delegated" || node.delegation?.status === "running" || node.delegation?.status === "queued") return ["block", "reopen"];
  if (node.status === "blocked") return ["reopen", "skip"];
  return ["complete", "block", "skip"];
}

export function resolveGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { action: ResolveGoalTodoAction; evidenceRefs?: string[]; validationCommands?: string[]; reason?: string; repoRoot?: string } = { action: "auto" }, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const action: ResolveGoalTodoAction = input.action === "auto"
    ? existing.status === "claim_returned" || existing.delegation?.status === "claim_returned" ? "accept_claim" : "complete"
    : input.action;
  if (action === "complete") return completeGoalTodo(pi, state, goalId, todoId, { evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands, repoRoot: input.repoRoot }, source);
  if (action === "skip") return completeGoalTodo(pi, state, goalId, todoId, { skipped: true, reason: input.reason, evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands, repoRoot: input.repoRoot }, source);
  if (action === "accept_claim") return acceptGoalTodoClaim(pi, state, goalId, todoId, { evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands, repoRoot: input.repoRoot }, source);
  if (action === "reject_claim") {
    if (!input.reason?.trim()) throw new Error("reject_claim requires reason.");
    return rejectGoalTodoClaim(pi, state, goalId, todoId, input.reason, source);
  }
  if (action === "block") {
    if (!input.reason?.trim()) throw new Error("block requires reason.");
    return blockGoalTodo(pi, state, goalId, todoId, input.reason, source);
  }
  if (action === "reopen") {
    return patchGoalTodo(pi, state, goalId, todoId, {
      status: existing.delegation && existing.delegation.status !== "accepted" ? "delegated" : "ready",
      blocker: undefined,
      skipReason: undefined,
      reviewNoShip: undefined,
      delegation: existing.delegation && existing.delegation.status !== "accepted" ? { ...existing.delegation, status: "running" } : existing.delegation,
    }, source);
  }
  throw new Error(`Unsupported resolve_goal_todo action: ${input.action}`);
}

export function focusGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string | undefined, source: GoalTodoEventSource = "command"): void {
  if (todoId && !state.goalTodos.nodes.some((node) => node.goalId === goalId && node.id === todoId)) throw new Error(`Goal TODO not found: ${todoId}`);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "focus", source, goalId, todoId, at: unixSeconds() });
}
