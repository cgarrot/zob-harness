import type { GoalRoomTodoReducerDecision, GoalTodoArtifacts, GoalTodoClaimRef, GoalTodoClaimValidationRef, GoalTodoDelegationRef, GoalTodoEvent, GoalTodoNode, GoalTodoPolicy, GoalTodoState, GoalTodoStatus } from "../goal-todo-types.js";
import { type ZcommitChildChangedPathRef } from "../../git/git-ops.js";
import { isRecord } from "../../../core/utils/records.js";
import { VALID_CHILD_GOAL_STATUS, VALID_DELEGATION_STATUS, VALID_OWNER, VALID_PRIORITY, VALID_STATUS, VALID_STATUS_CLAIM, VALID_TARGET_READINESS, VALID_VALIDATION_ACTION, VALID_VALIDATION_CONFIDENCE, VALID_VALIDATION_STATUS, VALID_VALIDATION_VERDICT, ZOB_GOAL_TODO_ENTRY_TYPE } from "./constants.js";
import { hasOnlyNoneLike, renumberGoalPaths } from "./operations.js";

export function defaultGoalTodoPolicy(): GoalTodoPolicy {
  return {
    maxTodoDepth: 6,
    maxDelegationDepth: 4,
    maxChildrenPerTodo: 8,
    maxOpenTodos: 80,
    requireEvidenceForCritical: true,
    parentOwnedClaims: true,
    oracleBeforeGoalComplete: true,
  };
}

export function createGoalTodoState(): GoalTodoState {
  return { nodes: [], policy: defaultGoalTodoPolicy() };
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function includesString<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function cloneNode(node: GoalTodoNode): GoalTodoNode {
  return {
    ...node,
    acceptanceCriteria: [...node.acceptanceCriteria],
    evidenceRefs: [...node.evidenceRefs],
    validationCommands: [...node.validationCommands],
    delegation: node.delegation ? { ...node.delegation } : undefined,
    claim: node.claim ? { ...node.claim, acceptanceBlockers: [...node.claim.acceptanceBlockers], childChangedPaths: node.claim.childChangedPaths ? node.claim.childChangedPaths.map((ref) => ({ ...ref })) : undefined } : undefined,
    validation: node.validation ? { ...node.validation, evidenceRefs: [...node.validation.evidenceRefs], validationCommands: [...node.validation.validationCommands], blockingIssues: [...node.validation.blockingIssues] } : undefined,
    artifacts: node.artifacts
      ? {
        reports: node.artifacts.reports ? [...node.artifacts.reports] : undefined,
        checkpoints: node.artifacts.checkpoints ? [...node.artifacts.checkpoints] : undefined,
        sentinels: node.artifacts.sentinels ? [...node.artifacts.sentinels] : undefined,
        taskHash: node.artifacts.taskHash,
        outputHash: node.artifacts.outputHash,
      }
      : undefined,
    citations: node.citations ? [...node.citations] : undefined,
  };
}

export function clonePolicy(policy: GoalTodoPolicy): GoalTodoPolicy {
  return { ...policy };
}

export function normalizePolicy(value: unknown): GoalTodoPolicy | undefined {
  if (!isRecord(value)) return undefined;
  return {
    maxTodoDepth: Math.max(1, Math.trunc(numberField(value, "maxTodoDepth") ?? defaultGoalTodoPolicy().maxTodoDepth)),
    maxDelegationDepth: Math.max(1, Math.trunc(numberField(value, "maxDelegationDepth") ?? defaultGoalTodoPolicy().maxDelegationDepth)),
    maxChildrenPerTodo: Math.max(1, Math.trunc(numberField(value, "maxChildrenPerTodo") ?? defaultGoalTodoPolicy().maxChildrenPerTodo)),
    maxOpenTodos: Math.max(1, Math.trunc(numberField(value, "maxOpenTodos") ?? defaultGoalTodoPolicy().maxOpenTodos)),
    requireEvidenceForCritical: true,
    parentOwnedClaims: true,
    oracleBeforeGoalComplete: true,
  };
}

export function normalizeDelegation(value: unknown): GoalTodoDelegationRef | undefined {
  if (!isRecord(value)) return undefined;
  const status = includesString(VALID_DELEGATION_STATUS, value.status) ? value.status : "running";
  return {
    runId: typeof value.runId === "string" ? value.runId : undefined,
    agent: typeof value.agent === "string" ? value.agent : undefined,
    childGoalId: typeof value.childGoalId === "string" ? value.childGoalId : undefined,
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    delegationDepth: Math.max(0, Math.trunc(numberField(value, "delegationDepth") ?? 0)),
    status,
  };
}

export function normalizeArtifacts(value: unknown): GoalTodoArtifacts | undefined {
  if (!isRecord(value)) return undefined;
  return {
    reports: stringArray(value.reports),
    checkpoints: stringArray(value.checkpoints),
    sentinels: stringArray(value.sentinels),
    taskHash: typeof value.taskHash === "string" ? value.taskHash : undefined,
    outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined,
  };
}

export function normalizeChildChangedPathRefs(value: unknown): ZcommitChildChangedPathRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.pathHash !== "string" || typeof item.status !== "string") return [];
    return [{ path: item.path, pathHash: item.pathHash, status: item.status, contentHash: typeof item.contentHash === "string" ? item.contentHash : undefined }];
  }).slice(0, 100);
}

export function normalizeClaim(value: unknown): GoalTodoClaimRef | undefined {
  if (!isRecord(value) || typeof value.claimHash !== "string") return undefined;
  return {
    claimHash: value.claimHash,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined,
    outputContract: typeof value.outputContract === "string" ? value.outputContract : undefined,
    gatePassed: typeof value.gatePassed === "boolean" ? value.gatePassed : undefined,
    childGoalStatus: includesString(VALID_CHILD_GOAL_STATUS, value.childGoalStatus) ? value.childGoalStatus : undefined,
    statusClaim: includesString(VALID_STATUS_CLAIM, value.statusClaim) ? value.statusClaim : undefined,
    targetReadiness: includesString(VALID_TARGET_READINESS, value.targetReadiness) ? value.targetReadiness : undefined,
    acceptanceBlockers: stringArray(value.acceptanceBlockers),
    noShip: typeof value.noShip === "boolean" ? value.noShip : undefined,
    childChangedPaths: normalizeChildChangedPathRefs(value.childChangedPaths),
    returnedAt: Math.trunc(numberField(value, "returnedAt") ?? unixSeconds()),
  };
}

export function normalizeValidation(value: unknown): GoalTodoClaimValidationRef | undefined {
  if (!isRecord(value)) return undefined;
  const status = includesString(VALID_VALIDATION_STATUS, value.status) ? value.status : undefined;
  if (!status) return undefined;
  return {
    runId: typeof value.runId === "string" ? value.runId : undefined,
    agent: typeof value.agent === "string" ? value.agent : undefined,
    status,
    verdict: includesString(VALID_VALIDATION_VERDICT, value.verdict) ? value.verdict : undefined,
    recommendedAction: includesString(VALID_VALIDATION_ACTION, value.recommendedAction) ? value.recommendedAction : undefined,
    noShip: typeof value.noShip === "boolean" ? value.noShip : undefined,
    outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined,
    evidenceRefs: stringArray(value.evidenceRefs),
    validationCommands: stringArray(value.validationCommands),
    blockingIssues: stringArray(value.blockingIssues),
    confidence: includesString(VALID_VALIDATION_CONFIDENCE, value.confidence) ? value.confidence : undefined,
    requestedAt: typeof value.requestedAt === "number" ? Math.trunc(value.requestedAt) : undefined,
    validatedAt: typeof value.validatedAt === "number" ? Math.trunc(value.validatedAt) : undefined,
  };
}

export function cloneValidation(validation: GoalTodoClaimValidationRef): GoalTodoClaimValidationRef {
  return { ...validation, evidenceRefs: [...validation.evidenceRefs], validationCommands: [...validation.validationCommands], blockingIssues: [...validation.blockingIssues] };
}

export function cloneClaim(claim: GoalTodoClaimRef): GoalTodoClaimRef {
  return { ...claim, acceptanceBlockers: [...claim.acceptanceBlockers] };
}

export function normalizeNode(value: unknown): GoalTodoNode | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.goalId !== "string" || typeof value.title !== "string") return undefined;
  const status = includesString(VALID_STATUS, value.status) ? value.status : "planned";
  const owner = includesString(VALID_OWNER, value.owner) ? value.owner : "agent";
  const priority = includesString(VALID_PRIORITY, value.priority) ? value.priority : "normal";
  const now = unixSeconds();
  return {
    id: value.id,
    goalId: value.goalId,
    parentId: typeof value.parentId === "string" ? value.parentId : undefined,
    path: typeof value.path === "string" && value.path.trim().length > 0 ? value.path : "1",
    depth: Math.max(1, Math.trunc(numberField(value, "depth") ?? 1)),
    title: value.title,
    descriptionHash: typeof value.descriptionHash === "string" ? value.descriptionHash : undefined,
    status,
    owner,
    required: value.required !== false,
    priority,
    acceptanceCriteria: stringArray(value.acceptanceCriteria),
    evidenceRefs: stringArray(value.evidenceRefs),
    validationCommands: stringArray(value.validationCommands),
    delegation: normalizeDelegation(value.delegation),
    claim: normalizeClaim(value.claim),
    validation: normalizeValidation(value.validation),
    artifacts: normalizeArtifacts(value.artifacts),
    contextScopeId: typeof value.contextScopeId === "string" ? value.contextScopeId : undefined,
    contextPackRef: typeof value.contextPackRef === "string" ? value.contextPackRef : undefined,
    citations: stringArray(value.citations),
    freshness: typeof value.freshness === "string" ? value.freshness : undefined,
    blocker: typeof value.blocker === "string" ? value.blocker : undefined,
    skipReason: typeof value.skipReason === "string" ? value.skipReason : undefined,
    reviewNoShip: value.reviewNoShip === true,
    createdAt: Math.trunc(numberField(value, "createdAt") ?? now),
    updatedAt: Math.trunc(numberField(value, "updatedAt") ?? now),
  };
}

export function normalizePatch(value: Partial<GoalTodoNode>): Partial<GoalTodoNode> {
  const patch: Partial<GoalTodoNode> = {};
  if ("parentId" in value && (typeof value.parentId === "string" || value.parentId === undefined)) patch.parentId = value.parentId;
  if (typeof value.path === "string") patch.path = value.path;
  if (typeof value.depth === "number" && Number.isFinite(value.depth)) patch.depth = Math.max(1, Math.trunc(value.depth));
  if (typeof value.title === "string" && value.title.trim().length > 0) patch.title = value.title.trim();
  if ("descriptionHash" in value && (typeof value.descriptionHash === "string" || value.descriptionHash === undefined)) patch.descriptionHash = value.descriptionHash;
  if (includesString(VALID_STATUS, value.status)) patch.status = value.status;
  if (includesString(VALID_OWNER, value.owner)) patch.owner = value.owner;
  if (typeof value.required === "boolean") patch.required = value.required;
  if (includesString(VALID_PRIORITY, value.priority)) patch.priority = value.priority;
  if (Array.isArray(value.acceptanceCriteria)) patch.acceptanceCriteria = value.acceptanceCriteria.filter((item): item is string => typeof item === "string");
  if (Array.isArray(value.evidenceRefs)) patch.evidenceRefs = value.evidenceRefs.filter((item): item is string => typeof item === "string");
  if (Array.isArray(value.validationCommands)) patch.validationCommands = value.validationCommands.filter((item): item is string => typeof item === "string");
  if (value.delegation) patch.delegation = { ...value.delegation };
  if (value.claim) patch.claim = cloneClaim(value.claim);
  else if ("claim" in value && value.claim === undefined) patch.claim = undefined;
  if (value.validation) patch.validation = cloneValidation(value.validation);
  else if ("validation" in value && value.validation === undefined) patch.validation = undefined;
  if (value.artifacts) patch.artifacts = { ...value.artifacts };
  if ("contextScopeId" in value && (typeof value.contextScopeId === "string" || value.contextScopeId === undefined)) patch.contextScopeId = value.contextScopeId;
  if ("contextPackRef" in value && (typeof value.contextPackRef === "string" || value.contextPackRef === undefined)) patch.contextPackRef = value.contextPackRef;
  if (Array.isArray(value.citations)) patch.citations = value.citations.filter((item): item is string => typeof item === "string");
  if ("freshness" in value && (typeof value.freshness === "string" || value.freshness === undefined)) patch.freshness = value.freshness;
  if ("blocker" in value && (typeof value.blocker === "string" || value.blocker === undefined)) patch.blocker = value.blocker;
  if ("skipReason" in value && (typeof value.skipReason === "string" || value.skipReason === undefined)) patch.skipReason = value.skipReason;
  if ("reviewNoShip" in value && (typeof value.reviewNoShip === "boolean" || value.reviewNoShip === undefined)) patch.reviewNoShip = value.reviewNoShip;
  return patch;
}

export function applyPatchToNode(node: GoalTodoNode, patch: Partial<GoalTodoNode>): GoalTodoNode {
  return {
    ...node,
    ...normalizePatch(patch),
    acceptanceCriteria: patch.acceptanceCriteria ? [...patch.acceptanceCriteria] : [...node.acceptanceCriteria],
    evidenceRefs: patch.evidenceRefs ? [...patch.evidenceRefs] : [...node.evidenceRefs],
    validationCommands: patch.validationCommands ? [...patch.validationCommands] : [...node.validationCommands],
    delegation: patch.delegation ? { ...patch.delegation } : patch.delegation === undefined ? node.delegation ? { ...node.delegation } : undefined : undefined,
    claim: patch.claim ? cloneClaim(patch.claim) : patch.claim === undefined ? node.claim ? cloneClaim(node.claim) : undefined : undefined,
    validation: patch.validation ? cloneValidation(patch.validation) : patch.validation === undefined ? node.validation ? cloneValidation(node.validation) : undefined : undefined,
    artifacts: patch.artifacts ? { ...patch.artifacts } : patch.artifacts === undefined ? node.artifacts ? { ...node.artifacts } : undefined : undefined,
    citations: patch.citations ? [...patch.citations] : node.citations ? [...node.citations] : undefined,
    updatedAt: unixSeconds(),
  };
}

export function replaceNode(state: GoalTodoState, node: GoalTodoNode): void {
  const index = state.nodes.findIndex((candidate) => candidate.id === node.id && candidate.goalId === node.goalId);
  if (index >= 0) state.nodes[index] = cloneNode(node);
  else state.nodes.push(cloneNode(node));
}

export function removeGoalNodes(state: GoalTodoState, goalId: string): void {
  state.nodes = state.nodes.filter((node) => node.goalId !== goalId);
  if (state.focusTodoId && !state.nodes.some((node) => node.id === state.focusTodoId)) state.focusTodoId = undefined;
}

export function applyEvent(state: GoalTodoState, event: GoalTodoEvent): void {
  if (event.kind === "policy_set") {
    state.policy = clonePolicy(event.policy);
    return;
  }
  if (event.kind === "clear_goal_todos") {
    removeGoalNodes(state, event.goalId);
    return;
  }
  if (event.kind === "snapshot") {
    removeGoalNodes(state, event.goalId);
    for (const node of event.nodes) replaceNode(state, node);
    if (event.policy) state.policy = clonePolicy(event.policy);
    state.focusTodoId = event.focusTodoId;
    return;
  }
  if (event.kind === "add") {
    replaceNode(state, event.node);
    return;
  }
  if (event.kind === "patch") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) replaceNode(state, applyPatchToNode(existing, event.patch));
    return;
  }
  if (event.kind === "move") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) replaceNode(state, applyPatchToNode(existing, { parentId: event.parentId }));
    renumberGoalPaths(state, event.goalId);
    return;
  }
  if (event.kind === "split") {
    const parent = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (parent) replaceNode(state, applyPatchToNode(parent, { status: "in_progress" }));
    renumberGoalPaths(state, event.goalId);
    return;
  }
  if (event.kind === "delegate_link") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) replaceNode(state, applyPatchToNode(existing, { status: "delegated", owner: "subagent", delegation: event.delegation, blocker: undefined }));
    return;
  }
  if (event.kind === "claim_returned") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) {
      const evidenceRefs = [...new Set([...existing.evidenceRefs, ...event.evidenceRefs])];
      const validationCommands = [...new Set([...existing.validationCommands, ...event.validationCommands])];
      const claim: GoalTodoClaimRef = {
        claimHash: event.claimHash,
        runId: event.runId,
        outputHash: event.outputHash,
        outputContract: event.outputContract,
        gatePassed: event.gatePassed,
        childGoalStatus: event.childGoalStatus,
        statusClaim: event.statusClaim,
        targetReadiness: event.targetReadiness,
        acceptanceBlockers: event.acceptanceBlockers ?? [],
        noShip: event.noShip,
        childChangedPaths: event.childChangedPaths ?? [],
        returnedAt: event.at,
      };
      const claimStatus: GoalTodoStatus = event.statusClaim === "blocked"
        ? "blocked"
        : event.statusClaim === "incomplete" || event.noShip === true || (event.acceptanceBlockers ?? []).length > 0 || event.targetReadiness === "needs_parent_review" || event.targetReadiness === "blocked"
          ? "needs_review"
          : "claim_returned";
      replaceNode(state, applyPatchToNode(existing, {
        status: claimStatus,
        owner: claimStatus === "claim_returned" ? existing.owner : "agent",
        evidenceRefs,
        validationCommands,
        delegation: existing.delegation ? { ...existing.delegation, status: "claim_returned" } : undefined,
        claim,
        artifacts: { ...(existing.artifacts ?? {}), outputHash: event.outputHash ?? event.claimHash },
        blocker: claimStatus === "claim_returned" ? undefined : event.acceptanceBlockers?.[0] ?? (event.noShip === true ? "delegated claim returned advisory no_ship=true; parent review required" : `delegated claim status ${event.statusClaim ?? "needs_review"}; parent review required`),
        reviewNoShip: claimStatus === "claim_returned" ? undefined : true,
      }));
    }
    return;
  }
  if (event.kind === "claim_validation_requested") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) replaceNode(state, applyPatchToNode(existing, {
      status: "needs_oracle",
      owner: "oracle",
      validation: cloneValidation(event.validation),
      blocker: undefined,
      reviewNoShip: undefined,
    }));
    return;
  }
  if (event.kind === "claim_validation_returned") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) {
      const evidenceRefs = [...new Set([...existing.evidenceRefs, ...event.evidenceRefs])];
      const validationCommands = [...new Set([...existing.validationCommands, ...event.validationCommands])];
      const passed = event.validation.status === "passed" && event.validation.verdict === "PASS" && event.validation.noShip === false && hasOnlyNoneLike(event.validation.blockingIssues);
      const warned = event.validation.status === "warn" && event.validation.verdict === "WARN" && event.validation.noShip === false && hasOnlyNoneLike(event.validation.blockingIssues);
      replaceNode(state, applyPatchToNode(existing, {
        status: passed ? "claim_returned" : warned ? "needs_review" : "blocked",
        owner: passed ? "subagent" : warned ? "agent" : existing.owner,
        evidenceRefs,
        validationCommands,
        validation: cloneValidation(event.validation),
        blocker: passed ? undefined : event.validation.blockingIssues[0] ?? `claim validation ${event.validation.verdict ?? "blocked"}`,
        reviewNoShip: passed ? undefined : true,
      }));
    }
    return;
  }
  if (event.kind === "claim_accepted") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) replaceNode(state, applyPatchToNode(existing, {
      status: "done",
      evidenceRefs: [...new Set([...existing.evidenceRefs, ...event.evidenceRefs])],
      validationCommands: [...new Set([...existing.validationCommands, ...event.validationCommands])],
      delegation: existing.delegation ? { ...existing.delegation, status: "accepted" } : undefined,
      blocker: undefined,
      reviewNoShip: undefined,
    }));
    return;
  }
  if (event.kind === "claim_rejected") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) replaceNode(state, applyPatchToNode(existing, {
      status: "blocked",
      delegation: existing.delegation ? { ...existing.delegation, status: "rejected" } : undefined,
      blocker: `claim rejected (${event.reasonHash.slice(0, 12)})`,
      reviewNoShip: true,
    }));
    return;
  }
  if (event.kind === "focus") state.focusTodoId = event.todoId;
}

export function normalizeEvent(value: unknown): GoalTodoEvent | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.kind !== "string" || typeof value.goalId !== "string") return undefined;
  const source = value.source === "tool" || value.source === "runtime" || value.source === "delegation" || value.source === "import" ? value.source : "command";
  const at = Math.trunc(numberField(value, "at") ?? unixSeconds());
  if (value.kind === "policy_set") {
    const policy = normalizePolicy(value.policy);
    return policy ? { version: 1, kind: "policy_set", source, goalId: value.goalId, policy, at } : undefined;
  }
  if (value.kind === "add") {
    const node = normalizeNode(value.node);
    return node ? { version: 1, kind: "add", source, goalId: value.goalId, node, at } : undefined;
  }
  if (value.kind === "patch" && typeof value.todoId === "string" && isRecord(value.patch)) return { version: 1, kind: "patch", source, goalId: value.goalId, todoId: value.todoId, patch: value.patch as Partial<GoalTodoNode>, at };
  if (value.kind === "move" && typeof value.todoId === "string") return { version: 1, kind: "move", source, goalId: value.goalId, todoId: value.todoId, parentId: typeof value.parentId === "string" ? value.parentId : undefined, at };
  if (value.kind === "split" && typeof value.todoId === "string") return { version: 1, kind: "split", source, goalId: value.goalId, todoId: value.todoId, childIds: stringArray(value.childIds), at };
  if (value.kind === "delegate_link" && typeof value.todoId === "string" && typeof value.runId === "string") {
    const delegation = normalizeDelegation(value.delegation);
    return delegation ? { version: 1, kind: "delegate_link", source, goalId: value.goalId, todoId: value.todoId, runId: value.runId, delegation, at } : undefined;
  }
  if (value.kind === "claim_returned" && typeof value.todoId === "string" && typeof value.claimHash === "string") return { version: 1, kind: "claim_returned", source, goalId: value.goalId, todoId: value.todoId, claimHash: value.claimHash, evidenceRefs: stringArray(value.evidenceRefs), validationCommands: stringArray(value.validationCommands), noShip: typeof value.noShip === "boolean" ? value.noShip : undefined, runId: typeof value.runId === "string" ? value.runId : undefined, outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined, outputContract: typeof value.outputContract === "string" ? value.outputContract : undefined, gatePassed: typeof value.gatePassed === "boolean" ? value.gatePassed : undefined, childGoalStatus: includesString(VALID_CHILD_GOAL_STATUS, value.childGoalStatus) ? value.childGoalStatus : undefined, statusClaim: includesString(VALID_STATUS_CLAIM, value.statusClaim) ? value.statusClaim : undefined, targetReadiness: includesString(VALID_TARGET_READINESS, value.targetReadiness) ? value.targetReadiness : undefined, acceptanceBlockers: stringArray(value.acceptanceBlockers), childChangedPaths: normalizeChildChangedPathRefs(value.childChangedPaths), at };
  if (value.kind === "claim_validation_requested" && typeof value.todoId === "string") {
    const validation = normalizeValidation(value.validation);
    return validation ? { version: 1, kind: "claim_validation_requested", source, goalId: value.goalId, todoId: value.todoId, validation, at } : undefined;
  }
  if (value.kind === "claim_validation_returned" && typeof value.todoId === "string") {
    const validation = normalizeValidation(value.validation);
    return validation ? { version: 1, kind: "claim_validation_returned", source, goalId: value.goalId, todoId: value.todoId, validation, evidenceRefs: stringArray(value.evidenceRefs), validationCommands: stringArray(value.validationCommands), noShip: typeof value.noShip === "boolean" ? value.noShip : undefined, at } : undefined;
  }
  if (value.kind === "claim_accepted" && typeof value.todoId === "string") return { version: 1, kind: "claim_accepted", source, goalId: value.goalId, todoId: value.todoId, evidenceRefs: stringArray(value.evidenceRefs), validationCommands: stringArray(value.validationCommands), at };
  if (value.kind === "claim_rejected" && typeof value.todoId === "string" && typeof value.reasonHash === "string") return { version: 1, kind: "claim_rejected", source, goalId: value.goalId, todoId: value.todoId, reasonHash: value.reasonHash, at };
  if (value.kind === "clear_goal_todos") return { version: 1, kind: "clear_goal_todos", source, goalId: value.goalId, at };
  if (value.kind === "focus") return { version: 1, kind: "focus", source, goalId: value.goalId, todoId: typeof value.todoId === "string" ? value.todoId : undefined, at };
  if (value.kind === "snapshot") {
    const nodes = Array.isArray(value.nodes) ? value.nodes.map(normalizeNode).filter((node): node is GoalTodoNode => Boolean(node)) : [];
    return { version: 1, kind: "snapshot", source, goalId: value.goalId, nodes, policy: normalizePolicy(value.policy), focusTodoId: typeof value.focusTodoId === "string" ? value.focusTodoId : undefined, at };
  }
  return undefined;
}

export function restoreGoalTodosFromBranch(entries: Iterable<unknown>): GoalTodoState {
  const state = createGoalTodoState();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.customType !== ZOB_GOAL_TODO_ENTRY_TYPE || !isRecord(entry.data)) continue;
    const event = normalizeEvent(entry.data);
    if (event) applyEvent(state, event);
  }
  return state;
}

export function goalRoomMetadata(message: Record<string, unknown>): Record<string, unknown> {
  return isRecord(message.metadata) ? message.metadata : {};
}

export function reducerStringArray(value: unknown): string[] {
  return stringArray(value).slice(0, 20);
}

export function goalRoomMessageString(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function baseTodoReducerDecision(message: Record<string, unknown>, reasonCodes: string[] = []): GoalRoomTodoReducerDecision {
  return {
    schema: "zob.todo-event-reducer-decision.v1",
    action: "ignore",
    reasonCodes,
    goalId: goalRoomMessageString(message, "goalId"),
    todoId: goalRoomMessageString(message, "todoId"),
    sourceMsgId: goalRoomMessageString(message, "msgId"),
    sourceKind: goalRoomMessageString(message, "kind"),
    runId: goalRoomMessageString(message, "runId"),
    outputHash: goalRoomMessageString(message, "outputHash"),
    evidenceRefs: reducerStringArray(message.evidenceRefs),
    validationCommands: [],
    acceptanceBlockers: [],
    parentOwnedActions: true,
    directMutationByWorker: false,
    reducerRequiredForTodoMutation: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}
