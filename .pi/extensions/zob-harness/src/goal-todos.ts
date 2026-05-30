import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { HarnessRuntimeState } from "./runtime/state.js";
import { sha256 } from "./utils/hashing.js";
import { isRecord } from "./utils/records.js";

export const ZOB_GOAL_TODO_ENTRY_TYPE = "zob-goal-todo";

export type GoalTodoStatus = "planned" | "ready" | "in_progress" | "delegated" | "claim_returned" | "needs_review" | "needs_oracle" | "needs_user" | "blocked" | "done" | "skipped";
export type GoalTodoOwner = "agent" | "user" | "oracle" | "subagent" | "factory" | "orchestration";
export type GoalTodoPriority = "low" | "normal" | "high" | "critical";
export type GoalTodoDelegationStatus = "queued" | "running" | "claim_returned" | "accepted" | "rejected" | "failed";
export type TodoSplitRequestAction = "split" | "replan" | "factory" | "needs_user" | "blocked";
export type TodoSplitRiskLevel = "low" | "medium" | "high";
export type GoalTodoChildGoalStatus = "ready_for_oracle" | "incomplete" | "blocked";
export type GoalTodoStatusClaim = "done" | "incomplete" | "blocked";
export type GoalTodoClaimTargetReadiness = "ready_for_parent_acceptance" | "needs_parent_review" | "blocked";
export type GoalTodoClaimValidationStatus = "queued" | "running" | "passed" | "warn" | "failed" | "blocked";
export type GoalTodoClaimValidationVerdict = "PASS" | "WARN" | "FAIL";
export type GoalTodoClaimValidationRecommendedAction = "accept_claim" | "needs_review" | "reject_claim" | "block";
export type GoalTodoClaimValidationConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface GoalTodoClaimRef {
  claimHash: string;
  runId?: string;
  outputHash?: string;
  outputContract?: string;
  gatePassed?: boolean;
  childGoalStatus?: GoalTodoChildGoalStatus;
  statusClaim?: GoalTodoStatusClaim;
  targetReadiness?: GoalTodoClaimTargetReadiness;
  acceptanceBlockers: string[];
  noShip?: boolean;
  returnedAt: number;
}

export interface GoalTodoClaimValidationRef {
  runId?: string;
  agent?: string;
  status: GoalTodoClaimValidationStatus;
  verdict?: GoalTodoClaimValidationVerdict;
  recommendedAction?: GoalTodoClaimValidationRecommendedAction;
  noShip?: boolean;
  outputHash?: string;
  evidenceRefs: string[];
  validationCommands: string[];
  blockingIssues: string[];
  confidence?: GoalTodoClaimValidationConfidence;
  requestedAt?: number;
  validatedAt?: number;
}

export interface TodoClaimValidationResult {
  todoId?: string;
  claimHash?: string;
  verdict?: GoalTodoClaimValidationVerdict;
  recommendedAction?: GoalTodoClaimValidationRecommendedAction;
  evidenceRefs: string[];
  validationCommands: string[];
  blockingIssues: string[];
  noShip?: boolean;
  confidence?: GoalTodoClaimValidationConfidence;
  hasFinalMarker: boolean;
}

export interface TodoSplitRequest {
  todoId?: string;
  reason?: string;
  recommendedAction?: TodoSplitRequestAction;
  proposedSubtodos: string[];
  riskLevel?: TodoSplitRiskLevel;
  validationPlan: string[];
  noShip?: boolean;
  hasFinalMarker: boolean;
}

export interface GoalTodoDelegationRef {
  runId?: string;
  agent?: string;
  childGoalId?: string;
  requestId?: string;
  delegationDepth: number;
  status: GoalTodoDelegationStatus;
}

export interface GoalTodoArtifacts {
  reports?: string[];
  checkpoints?: string[];
  sentinels?: string[];
  taskHash?: string;
  outputHash?: string;
}

export interface GoalTodoNode {
  id: string;
  goalId: string;
  parentId?: string;
  path: string;
  depth: number;
  title: string;
  descriptionHash?: string;
  status: GoalTodoStatus;
  owner: GoalTodoOwner;
  required: boolean;
  priority: GoalTodoPriority;
  acceptanceCriteria: string[];
  evidenceRefs: string[];
  validationCommands: string[];
  delegation?: GoalTodoDelegationRef;
  claim?: GoalTodoClaimRef;
  validation?: GoalTodoClaimValidationRef;
  artifacts?: GoalTodoArtifacts;
  contextScopeId?: string;
  contextPackRef?: string;
  citations?: string[];
  freshness?: string;
  blocker?: string;
  skipReason?: string;
  /** Advisory review no_ship evidence returned by a child/oracle; parent resolution decides final state. */
  reviewNoShip?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GoalTodoPolicy {
  maxTodoDepth: number;
  maxDelegationDepth: number;
  maxChildrenPerTodo: number;
  maxOpenTodos: number;
  requireEvidenceForCritical: true;
  parentOwnedClaims: true;
  oracleBeforeGoalComplete: true;
}

export interface GoalTodoState {
  nodes: GoalTodoNode[];
  policy: GoalTodoPolicy;
  focusTodoId?: string;
}

export type GoalTodoEventSource = "command" | "tool" | "runtime" | "delegation" | "import";

export type GoalTodoEvent =
  | { version: 1; kind: "policy_set"; source: GoalTodoEventSource; goalId: string; policy: GoalTodoPolicy; at: number }
  | { version: 1; kind: "add"; source: GoalTodoEventSource; goalId: string; node: GoalTodoNode; at: number }
  | { version: 1; kind: "patch"; source: GoalTodoEventSource; goalId: string; todoId: string; patch: Partial<GoalTodoNode>; at: number }
  | { version: 1; kind: "move"; source: GoalTodoEventSource; goalId: string; todoId: string; parentId?: string; at: number }
  | { version: 1; kind: "split"; source: GoalTodoEventSource; goalId: string; todoId: string; childIds: string[]; at: number }
  | { version: 1; kind: "delegate_link"; source: GoalTodoEventSource; goalId: string; todoId: string; runId: string; delegation: GoalTodoDelegationRef; at: number }
  | { version: 1; kind: "claim_returned"; source: GoalTodoEventSource; goalId: string; todoId: string; claimHash: string; evidenceRefs: string[]; validationCommands: string[]; noShip?: boolean; runId?: string; outputHash?: string; outputContract?: string; gatePassed?: boolean; childGoalStatus?: GoalTodoChildGoalStatus; statusClaim?: GoalTodoStatusClaim; targetReadiness?: GoalTodoClaimTargetReadiness; acceptanceBlockers?: string[]; at: number }
  | { version: 1; kind: "claim_validation_requested"; source: GoalTodoEventSource; goalId: string; todoId: string; validation: GoalTodoClaimValidationRef; at: number }
  | { version: 1; kind: "claim_validation_returned"; source: GoalTodoEventSource; goalId: string; todoId: string; validation: GoalTodoClaimValidationRef; evidenceRefs: string[]; validationCommands: string[]; noShip?: boolean; at: number }
  | { version: 1; kind: "claim_accepted"; source: GoalTodoEventSource; goalId: string; todoId: string; evidenceRefs: string[]; validationCommands: string[]; at: number }
  | { version: 1; kind: "claim_rejected"; source: GoalTodoEventSource; goalId: string; todoId: string; reasonHash: string; at: number }
  | { version: 1; kind: "clear_goal_todos"; source: GoalTodoEventSource; goalId: string; at: number }
  | { version: 1; kind: "focus"; source: GoalTodoEventSource; goalId: string; todoId?: string; at: number }
  | { version: 1; kind: "snapshot"; source: GoalTodoEventSource; goalId: string; nodes: GoalTodoNode[]; policy?: GoalTodoPolicy; focusTodoId?: string; at: number };

export type GoalRoomTodoReducerAction = "ignore" | "return_claim" | "mark_needs_review" | "block";

export interface GoalRoomTodoReducerDecision {
  schema: "zob.todo-event-reducer-decision.v1";
  action: GoalRoomTodoReducerAction;
  reasonCodes: string[];
  goalId?: string;
  todoId?: string;
  sourceMsgId?: string;
  sourceKind?: string;
  runId?: string;
  claimHash?: string;
  outputHash?: string;
  evidenceRefs: string[];
  validationCommands: string[];
  noShip?: boolean;
  childGoalStatus?: GoalTodoChildGoalStatus;
  statusClaim?: GoalTodoStatusClaim;
  targetReadiness?: GoalTodoClaimTargetReadiness;
  acceptanceBlockers: string[];
  parentOwnedActions: true;
  directMutationByWorker: false;
  reducerRequiredForTodoMutation: true;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface GoalTodoSummary {
  goalId?: string;
  total: number;
  required: number;
  done: number;
  skipped: number;
  open: number;
  active: number;
  blocked: number;
  delegated: number;
  claimReturned: number;
  validationQueued: number;
  validationRunning: number;
  validationPassed: number;
  validationFailed: number;
  needsUser: number;
  needsOracle: number;
  nextAgent?: GoalTodoNode;
  nextUser?: GoalTodoNode;
}

export interface AddGoalTodoInput {
  title: string;
  parentId?: string;
  owner?: GoalTodoOwner;
  required?: boolean;
  priority?: GoalTodoPriority;
  status?: GoalTodoStatus;
  acceptanceCriteria?: string[];
  evidenceRefs?: string[];
  validationCommands?: string[];
  descriptionHash?: string;
}

export interface GoalTodoCommandResult {
  ok: boolean;
  message: string;
  node?: GoalTodoNode;
}

export type ResolveGoalTodoAction = "auto" | "complete" | "accept_claim" | "reject_claim" | "block" | "skip" | "reopen";

export interface GoalTodoCompletionDiagnostics {
  completionReady: boolean;
  hardNoShip: boolean;
  reviewNoShip: boolean;
  effectiveNoShip: boolean;
  completionBlockers: string[];
  nextValidActions: Record<string, ResolveGoalTodoAction[]>;
}

const OPEN_REQUIRED_STATUSES = new Set<GoalTodoStatus>(["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user", "blocked"]);
const ACTIVE_STATUSES = new Set<GoalTodoStatus>(["ready", "in_progress", "delegated", "claim_returned", "needs_review"]);
const ACTIONABLE_STATUSES = new Set<GoalTodoStatus>(["planned", "ready", "in_progress", "needs_review", "needs_user", "needs_oracle", "blocked"]);
const VALID_STATUS: readonly GoalTodoStatus[] = ["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user", "blocked", "done", "skipped"];
const VALID_OWNER: readonly GoalTodoOwner[] = ["agent", "user", "oracle", "subagent", "factory", "orchestration"];
const VALID_PRIORITY: readonly GoalTodoPriority[] = ["low", "normal", "high", "critical"];
const VALID_DELEGATION_STATUS: readonly GoalTodoDelegationStatus[] = ["queued", "running", "claim_returned", "accepted", "rejected", "failed"];
const VALID_CHILD_GOAL_STATUS: readonly GoalTodoChildGoalStatus[] = ["ready_for_oracle", "incomplete", "blocked"];
const VALID_STATUS_CLAIM: readonly GoalTodoStatusClaim[] = ["done", "incomplete", "blocked"];
const VALID_TARGET_READINESS: readonly GoalTodoClaimTargetReadiness[] = ["ready_for_parent_acceptance", "needs_parent_review", "blocked"];
const VALID_VALIDATION_STATUS: readonly GoalTodoClaimValidationStatus[] = ["queued", "running", "passed", "warn", "failed", "blocked"];
const VALID_VALIDATION_VERDICT: readonly GoalTodoClaimValidationVerdict[] = ["PASS", "WARN", "FAIL"];
const VALID_VALIDATION_ACTION: readonly GoalTodoClaimValidationRecommendedAction[] = ["accept_claim", "needs_review", "reject_claim", "block"];
const VALID_VALIDATION_CONFIDENCE: readonly GoalTodoClaimValidationConfidence[] = ["LOW", "MEDIUM", "HIGH"];
const SHA256_HEX = /^[a-f0-9]{64}$/i;

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

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function includesString<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cloneNode(node: GoalTodoNode): GoalTodoNode {
  return {
    ...node,
    acceptanceCriteria: [...node.acceptanceCriteria],
    evidenceRefs: [...node.evidenceRefs],
    validationCommands: [...node.validationCommands],
    delegation: node.delegation ? { ...node.delegation } : undefined,
    claim: node.claim ? { ...node.claim, acceptanceBlockers: [...node.claim.acceptanceBlockers] } : undefined,
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

function clonePolicy(policy: GoalTodoPolicy): GoalTodoPolicy {
  return { ...policy };
}

function normalizePolicy(value: unknown): GoalTodoPolicy | undefined {
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

function normalizeDelegation(value: unknown): GoalTodoDelegationRef | undefined {
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

function normalizeArtifacts(value: unknown): GoalTodoArtifacts | undefined {
  if (!isRecord(value)) return undefined;
  return {
    reports: stringArray(value.reports),
    checkpoints: stringArray(value.checkpoints),
    sentinels: stringArray(value.sentinels),
    taskHash: typeof value.taskHash === "string" ? value.taskHash : undefined,
    outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined,
  };
}

function normalizeClaim(value: unknown): GoalTodoClaimRef | undefined {
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
    returnedAt: Math.trunc(numberField(value, "returnedAt") ?? unixSeconds()),
  };
}

function normalizeValidation(value: unknown): GoalTodoClaimValidationRef | undefined {
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

function cloneValidation(validation: GoalTodoClaimValidationRef): GoalTodoClaimValidationRef {
  return { ...validation, evidenceRefs: [...validation.evidenceRefs], validationCommands: [...validation.validationCommands], blockingIssues: [...validation.blockingIssues] };
}

function cloneClaim(claim: GoalTodoClaimRef): GoalTodoClaimRef {
  return { ...claim, acceptanceBlockers: [...claim.acceptanceBlockers] };
}

function normalizeNode(value: unknown): GoalTodoNode | undefined {
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

function normalizePatch(value: Partial<GoalTodoNode>): Partial<GoalTodoNode> {
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

function applyPatchToNode(node: GoalTodoNode, patch: Partial<GoalTodoNode>): GoalTodoNode {
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

function replaceNode(state: GoalTodoState, node: GoalTodoNode): void {
  const index = state.nodes.findIndex((candidate) => candidate.id === node.id && candidate.goalId === node.goalId);
  if (index >= 0) state.nodes[index] = cloneNode(node);
  else state.nodes.push(cloneNode(node));
}

function removeGoalNodes(state: GoalTodoState, goalId: string): void {
  state.nodes = state.nodes.filter((node) => node.goalId !== goalId);
  if (state.focusTodoId && !state.nodes.some((node) => node.id === state.focusTodoId)) state.focusTodoId = undefined;
}

function applyEvent(state: GoalTodoState, event: GoalTodoEvent): void {
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
        returnedAt: event.at,
      };
      replaceNode(state, applyPatchToNode(existing, {
        status: "claim_returned",
        evidenceRefs,
        validationCommands,
        delegation: existing.delegation ? { ...existing.delegation, status: "claim_returned" } : undefined,
        claim,
        artifacts: { ...(existing.artifacts ?? {}), outputHash: event.outputHash ?? event.claimHash },
        blocker: event.noShip === true ? "delegated claim returned advisory no_ship=true; parent review required" : undefined,
        reviewNoShip: event.noShip === true,
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

function normalizeEvent(value: unknown): GoalTodoEvent | undefined {
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
  if (value.kind === "claim_returned" && typeof value.todoId === "string" && typeof value.claimHash === "string") return { version: 1, kind: "claim_returned", source, goalId: value.goalId, todoId: value.todoId, claimHash: value.claimHash, evidenceRefs: stringArray(value.evidenceRefs), validationCommands: stringArray(value.validationCommands), noShip: typeof value.noShip === "boolean" ? value.noShip : undefined, runId: typeof value.runId === "string" ? value.runId : undefined, outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined, outputContract: typeof value.outputContract === "string" ? value.outputContract : undefined, gatePassed: typeof value.gatePassed === "boolean" ? value.gatePassed : undefined, childGoalStatus: includesString(VALID_CHILD_GOAL_STATUS, value.childGoalStatus) ? value.childGoalStatus : undefined, statusClaim: includesString(VALID_STATUS_CLAIM, value.statusClaim) ? value.statusClaim : undefined, targetReadiness: includesString(VALID_TARGET_READINESS, value.targetReadiness) ? value.targetReadiness : undefined, acceptanceBlockers: stringArray(value.acceptanceBlockers), at };
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

function goalRoomMetadata(message: Record<string, unknown>): Record<string, unknown> {
  return isRecord(message.metadata) ? message.metadata : {};
}

function reducerStringArray(value: unknown): string[] {
  return stringArray(value).slice(0, 20);
}

function goalRoomMessageString(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function baseTodoReducerDecision(message: Record<string, unknown>, reasonCodes: string[] = []): GoalRoomTodoReducerDecision {
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

export function reduceGoalRoomEventToTodoDecision(message: Record<string, unknown>): GoalRoomTodoReducerDecision {
  const decision = baseTodoReducerDecision(message);
  const kind = goalRoomMessageString(message, "kind");
  const bodyHash = goalRoomMessageString(message, "bodyHash");
  const metadata = goalRoomMetadata(message);
  decision.validationCommands = reducerStringArray(metadata.validationCommands);
  decision.acceptanceBlockers = reducerStringArray(metadata.acceptanceBlockers);
  decision.noShip = typeof metadata.noShip === "boolean" ? metadata.noShip : kind === "NO_SHIP_ALERT" ? true : undefined;
  decision.childGoalStatus = includesString(VALID_CHILD_GOAL_STATUS, metadata.childGoalStatus) ? metadata.childGoalStatus : undefined;
  decision.statusClaim = includesString(VALID_STATUS_CLAIM, metadata.statusClaim) ? metadata.statusClaim : undefined;
  decision.targetReadiness = includesString(VALID_TARGET_READINESS, metadata.targetReadiness) ? metadata.targetReadiness : undefined;
  decision.outputHash = goalRoomMessageString(message, "outputHash") ?? metadataString(metadata, "outputHash");

  if (message.schema !== "zob.goal-room-message.v1") decision.reasonCodes.push("invalid_schema");
  if (message.parentOwnedActions !== true || message.workerToWorkerDirect !== false || message.hiddenPeerChat !== false) decision.reasonCodes.push("not_parent_owned_visible_event");
  if (message.bodyStored !== false || message.promptBodiesStored !== false || message.outputBodiesStored !== false) decision.reasonCodes.push("not_body_free");
  if (!decision.goalId) decision.reasonCodes.push("missing_goal_id");
  if (!decision.todoId) decision.reasonCodes.push("missing_todo_id");
  if (!bodyHash || !SHA256_HEX.test(bodyHash)) decision.reasonCodes.push("missing_body_hash");
  if (kind && !["TODO_CLAIM", "BLOCKER", "NO_SHIP_ALERT", "ORACLE_REQUEST", "HANDOFF", "DECISION", "STATUS_UPDATE", "ACTION_TAKEN", "ARTIFACT_READY", "FINDING", "RISK"].includes(kind)) decision.reasonCodes.push("unsupported_kind");
  if (decision.reasonCodes.length > 0) return decision;
  const validBodyHash = bodyHash as string;

  if (kind === "TODO_CLAIM") {
    const artifactRefs = reducerStringArray(message.artifactRefs);
    const evidenceRefs = [...new Set([...decision.evidenceRefs, ...artifactRefs])];
    decision.action = "return_claim";
    decision.claimHash = validBodyHash;
    decision.outputHash = decision.outputHash && SHA256_HEX.test(decision.outputHash) ? decision.outputHash : validBodyHash;
    decision.evidenceRefs = evidenceRefs;
    decision.statusClaim = decision.statusClaim ?? "done";
    decision.childGoalStatus = decision.childGoalStatus ?? "ready_for_oracle";
    decision.targetReadiness = decision.targetReadiness ?? (decision.noShip === true || decision.acceptanceBlockers.length > 0 ? "needs_parent_review" : "ready_for_parent_acceptance");
    if (evidenceRefs.length === 0) decision.acceptanceBlockers = [...new Set([...decision.acceptanceBlockers, "missing_evidence_refs"] )];
    if (decision.acceptanceBlockers.length > 0 && decision.noShip !== true) decision.noShip = true;
    return decision;
  }

  if (kind === "BLOCKER" || kind === "NO_SHIP_ALERT") {
    decision.action = "block";
    decision.claimHash = validBodyHash;
    decision.noShip = true;
    decision.acceptanceBlockers = [...new Set([...decision.acceptanceBlockers, `${kind.toLowerCase()}_${validBodyHash.slice(0, 12)}`])];
    return decision;
  }

  if (message.requiresParentAction === true) {
    decision.action = "mark_needs_review";
    decision.claimHash = validBodyHash;
    decision.acceptanceBlockers = [...new Set([...decision.acceptanceBlockers, `parent_action_required_${validBodyHash.slice(0, 12)}`])];
    return decision;
  }

  decision.reasonCodes.push("status_only_no_todo_mutation");
  return decision;
}

export function applyGoalRoomEventTodoReducer(pi: ExtensionAPI, state: HarnessRuntimeState, message: Record<string, unknown>): { decision: GoalRoomTodoReducerDecision; node?: GoalTodoNode } {
  const decision = reduceGoalRoomEventToTodoDecision(message);
  const activeGoalId = state.runtimeGoal?.goalId;
  if (!activeGoalId || activeGoalId !== decision.goalId || !decision.todoId) return { decision };
  if (decision.action === "return_claim" && decision.claimHash) {
    const node = returnGoalTodoClaim(pi, state, activeGoalId, decision.todoId, {
      claimHash: decision.claimHash,
      evidenceRefs: decision.evidenceRefs,
      validationCommands: decision.validationCommands,
      noShip: decision.noShip,
      runId: decision.runId,
      outputHash: decision.outputHash,
      outputContract: metadataString(goalRoomMetadata(message), "outputContract") ?? "agent-event.v1",
      gatePassed: decision.noShip !== true && decision.acceptanceBlockers.length === 0,
      childGoalStatus: decision.childGoalStatus,
      statusClaim: decision.statusClaim,
      targetReadiness: decision.targetReadiness,
      acceptanceBlockers: decision.acceptanceBlockers,
    }, "runtime");
    return { decision, node: node ? cloneNode(node) : undefined };
  }
  if (decision.action === "block") {
    const node = blockGoalTodo(pi, state, activeGoalId, decision.todoId, `goal-room ${decision.sourceKind ?? "event"} ${decision.claimHash?.slice(0, 12) ?? "hash"} requires parent review`, "runtime");
    return { decision, node: cloneNode(node) };
  }
  if (decision.action === "mark_needs_review") {
    const node = patchGoalTodo(pi, state, activeGoalId, decision.todoId, { status: "needs_review", owner: "agent", blocker: `goal-room event ${decision.claimHash?.slice(0, 12) ?? "hash"} requires parent action`, reviewNoShip: decision.noShip === true }, "runtime");
    return { decision, node: cloneNode(node) };
  }
  return { decision };
}

export function appendGoalTodoEvent(pi: ExtensionAPI, state: HarnessRuntimeState, event: GoalTodoEvent): GoalTodoEvent {
  pi.appendEntry(ZOB_GOAL_TODO_ENTRY_TYPE, event);
  applyEvent(state.goalTodos, event);
  return event;
}

function nextTodoId(): string {
  return `todo_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function goalNodes(todoState: GoalTodoState, goalId: string): GoalTodoNode[] {
  return todoState.nodes.filter((node) => node.goalId === goalId).map(cloneNode);
}

function childrenOf(todoState: GoalTodoState, goalId: string, parentId: string | undefined): GoalTodoNode[] {
  return goalNodes(todoState, goalId)
    .filter((node) => (node.parentId ?? undefined) === parentId)
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }) || left.createdAt - right.createdAt);
}

function parentPath(todoState: GoalTodoState, goalId: string, parentId: string | undefined): string | undefined {
  if (!parentId) return undefined;
  return todoState.nodes.find((node) => node.goalId === goalId && node.id === parentId)?.path;
}

function nextPathForParent(todoState: GoalTodoState, goalId: string, parentId: string | undefined): string {
  const parent = parentPath(todoState, goalId, parentId);
  const count = childrenOf(todoState, goalId, parentId).length + 1;
  return parent ? `${parent}.${count}` : String(count);
}

function depthForParent(todoState: GoalTodoState, goalId: string, parentId: string | undefined): number {
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

function goalTodoNeedsSkipEvidence(node: GoalTodoNode): boolean {
  return node.priority === "critical" || Boolean(node.delegation) || node.owner === "factory" || node.owner === "orchestration";
}

export function completeGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { evidenceRefs?: string[]; validationCommands?: string[]; skipped?: boolean; reason?: string } = {}, source: GoalTodoEventSource = "tool"): GoalTodoNode {
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
      return acceptGoalTodoClaim(pi, state, goalId, todoId, { evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands }, source);
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

export function linkGoalTodoDelegation(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { runId: string; agent?: string; childGoalId?: string; requestId?: string; delegationDepth?: number }, source: GoalTodoEventSource = "delegation"): GoalTodoNode | undefined {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) return undefined;
  const delegation: GoalTodoDelegationRef = {
    runId: input.runId,
    agent: input.agent,
    childGoalId: input.childGoalId,
    requestId: input.requestId,
    delegationDepth: Math.max(0, Math.trunc(input.delegationDepth ?? existing.delegation?.delegationDepth ?? 1)),
    status: "running",
  };
  appendGoalTodoEvent(pi, state, { version: 1, kind: "delegate_link", source, goalId, todoId, runId: input.runId, delegation, at: unixSeconds() });
  return state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
}

export function returnGoalTodoClaim(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { claimText?: string; claimHash?: string; evidenceRefs?: string[]; validationCommands?: string[]; noShip?: boolean; runId?: string; outputHash?: string; outputContract?: string; gatePassed?: boolean; childGoalStatus?: GoalTodoChildGoalStatus; statusClaim?: GoalTodoStatusClaim; targetReadiness?: GoalTodoClaimTargetReadiness; acceptanceBlockers?: string[] }, source: GoalTodoEventSource = "delegation"): GoalTodoNode | undefined {
  const existing = state.goalTodos.nodes.find((node) => node.goalId === goalId && node.id === todoId);
  if (!existing) return undefined;
  const claimHash = input.claimHash ?? sha256(input.claimText ?? `${goalId}:${todoId}:${Date.now()}`);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_returned", source, goalId, todoId, claimHash, evidenceRefs: input.evidenceRefs ?? [], validationCommands: input.validationCommands ?? [], noShip: input.noShip, runId: input.runId, outputHash: input.outputHash, outputContract: input.outputContract, gatePassed: input.gatePassed, childGoalStatus: input.childGoalStatus, statusClaim: input.statusClaim, targetReadiness: input.targetReadiness, acceptanceBlockers: input.acceptanceBlockers ?? [], at: unixSeconds() });
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

function validationStatusFromResult(input: TodoClaimValidationResult): GoalTodoClaimValidationStatus {
  if (input.noShip === true || !hasOnlyNoneLike(input.blockingIssues)) return "blocked";
  if (input.verdict === "PASS" && input.noShip === false) return "passed";
  if (input.verdict === "WARN" && input.noShip === false) return "warn";
  return "failed";
}

function hasOnlyNoneLike(items: string[]): boolean {
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

export function recordGoalTodoClaimValidationResult(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { result: TodoClaimValidationResult; runId?: string; agent?: string; outputHash?: string; autoAccept?: boolean }, source: GoalTodoEventSource = "delegation"): GoalTodoNode {
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
  if (input.autoAccept === true && isGoalTodoClaimReadyForAutoAccept(node)) return acceptGoalTodoClaim(pi, state, goalId, todoId, { evidenceRefs: input.result.evidenceRefs, validationCommands: input.result.validationCommands }, source);
  return cloneNode(node);
}

export function acceptGoalTodoClaim(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { evidenceRefs?: string[]; validationCommands?: string[] } = {}, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  if (existing.validation && existing.validation.status !== "passed") throw new Error(`TODO ${todoId} claim validation is ${existing.validation.status}; wait for oracle PASS/no_ship=false or reject/block.`);
  if (existing.status !== "claim_returned" || existing.delegation?.status !== "claim_returned") throw new Error(`TODO ${todoId} has no returned delegated claim to accept.`);
  appendGoalTodoEvent(pi, state, { version: 1, kind: "claim_accepted", source, goalId, todoId, evidenceRefs: input.evidenceRefs ?? [], validationCommands: input.validationCommands ?? [], at: unixSeconds() });
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

export function resolveGoalTodo(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, input: { action: ResolveGoalTodoAction; evidenceRefs?: string[]; validationCommands?: string[]; reason?: string } = { action: "auto" }, source: GoalTodoEventSource = "tool"): GoalTodoNode {
  const existing = state.goalTodos.nodes.find((candidate) => candidate.goalId === goalId && candidate.id === todoId);
  if (!existing) throw new Error(`Goal TODO not found: ${todoId}`);
  const action: ResolveGoalTodoAction = input.action === "auto"
    ? existing.status === "claim_returned" || existing.delegation?.status === "claim_returned" ? "accept_claim" : "complete"
    : input.action;
  if (action === "complete") return completeGoalTodo(pi, state, goalId, todoId, { evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands }, source);
  if (action === "skip") return completeGoalTodo(pi, state, goalId, todoId, { skipped: true, reason: input.reason, evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands }, source);
  if (action === "accept_claim") return acceptGoalTodoClaim(pi, state, goalId, todoId, { evidenceRefs: input.evidenceRefs, validationCommands: input.validationCommands }, source);
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

export function summarizeGoalTodos(todoState: GoalTodoState, goalId?: string): GoalTodoSummary {
  const nodes = goalId ? goalNodes(todoState, goalId) : todoState.nodes.map(cloneNode);
  const done = nodes.filter((node) => node.status === "done").length;
  const skipped = nodes.filter((node) => node.status === "skipped").length;
  const open = nodes.filter((node) => OPEN_REQUIRED_STATUSES.has(node.status)).length;
  const active = nodes.filter((node) => ACTIVE_STATUSES.has(node.status)).length;
  const blocked = nodes.filter((node) => node.status === "blocked").length;
  const delegated = nodes.filter((node) => node.status === "delegated" || node.delegation?.status === "running" || node.delegation?.status === "queued").length;
  const claimReturned = nodes.filter((node) => node.status === "claim_returned").length;
  const validationQueued = nodes.filter((node) => node.validation?.status === "queued").length;
  const validationRunning = nodes.filter((node) => node.validation?.status === "running").length;
  const validationPassed = nodes.filter((node) => node.validation?.status === "passed").length;
  const validationFailed = nodes.filter((node) => node.validation?.status === "failed" || node.validation?.status === "blocked" || node.validation?.status === "warn").length;
  const needsUser = nodes.filter((node) => node.status === "needs_user").length;
  const needsOracle = nodes.filter((node) => node.status === "needs_oracle").length;
  const nextAgent = nodes.find((node) => node.owner === "agent" && (node.status === "ready" || node.status === "planned" || node.status === "in_progress"));
  const nextUser = nodes.find((node) => ACTIONABLE_STATUSES.has(node.status) && (node.owner === "user" || node.status === "needs_user"));
  return {
    goalId,
    total: nodes.length,
    required: nodes.filter((node) => node.required).length,
    done,
    skipped,
    open,
    active,
    blocked,
    delegated,
    claimReturned,
    validationQueued,
    validationRunning,
    validationPassed,
    validationFailed,
    needsUser,
    needsOracle,
    nextAgent,
    nextUser,
  };
}

export function formatGoalTodoSummary(summary: GoalTodoSummary): string {
  if (summary.total === 0) return "todos unset";
  const closed = summary.done + summary.skipped;
  const validation = summary.validationQueued + summary.validationRunning > 0 ? ` · validation ${summary.validationQueued + summary.validationRunning}` : summary.validationFailed > 0 ? ` · validation_alerts ${summary.validationFailed}` : "";
  return `todos ${closed}/${summary.total} · open ${summary.open} · active ${summary.active} · blocked ${summary.blocked} · delegated ${summary.delegated} · claims ${summary.claimReturned}${validation}`;
}

export function formatGoalTodoHudLine(todoState: GoalTodoState, goalId: string | undefined): string {
  if (!goalId) return "todos unset";
  const summary = summarizeGoalTodos(todoState, goalId);
  const next = summary.nextAgent ? ` · next agent ${summary.nextAgent.path} ${summary.nextAgent.title}` : summary.nextUser ? ` · next user ${summary.nextUser.path} ${summary.nextUser.title}` : "";
  return `${formatGoalTodoSummary(summary)}${next}`;
}

export function formatGoalTodoPromptHint(todoState: GoalTodoState, goalId: string | undefined): string {
  if (!goalId) return "- goal_todos: no active runtime goal";
  const summary = summarizeGoalTodos(todoState, goalId);
  if (summary.total === 0) return "- goal_todos: none set; create TODOs for long, multi-step goal work when appropriate";
  return [
    `- goal_todos: ${formatGoalTodoSummary(summary)}`,
    summary.nextAgent ? `- next_agent_todo: ${summary.nextAgent.path} ${summary.nextAgent.title}` : undefined,
    summary.nextUser ? `- next_user_todo: ${summary.nextUser.path} ${summary.nextUser.title}` : undefined,
    summary.claimReturned > 0 ? "- delegated_claims: claim_returned TODOs require parent evidence checks or agentic validation; use resolve_goal_todo(action=auto|complete|accept_claim), complete_goal_todo, /goal todo done, or accept_goal_todo_claim to accept returned claims" : undefined,
    summary.validationQueued + summary.validationRunning > 0 ? `- claim_validation: ${summary.validationQueued + summary.validationRunning} oracle validation(s) queued/running; auto-accept only after PASS/no_ship=false` : undefined,
    "- completion rule: use resolve_goal_todo for done/skip/claim/block/reopen transitions; required TODOs must be done/skipped with evidence before propose_goal_completion",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function formatGoalTodoTree(todoState: GoalTodoState, goalId: string | undefined): string {
  if (!goalId) return "No active runtime goal; goal TODOs require a goalId.";
  const nodes = goalNodes(todoState, goalId);
  if (nodes.length === 0) return "No goal TODOs set. Use /goal todo add <title>.";
  const icon = (node: GoalTodoNode): string => {
    if (node.status === "done") return "✓";
    if (node.status === "skipped") return "↷";
    if (node.status === "blocked") return "▲";
    if (node.status === "delegated") return "⇄";
    if (node.status === "claim_returned") return "◇";
    if (node.status === "needs_user") return "?";
    if (node.status === "needs_oracle") return "◆";
    if (node.status === "in_progress") return "●";
    return "○";
  };
  const diagnostics = goalTodoCompletionDiagnostics(todoState, goalId);
  const lines = [formatGoalTodoSummary(summarizeGoalTodos(todoState, goalId)), formatGoalTodoDiagnostics(diagnostics)];
  const walk = (parentId: string | undefined, indent = ""): void => {
    const children = childrenOf(todoState, goalId, parentId);
    children.forEach((node, index) => {
      const last = index === children.length - 1;
      const branch = indent ? (last ? "└─" : "├─") : "";
      const required = node.required ? "req" : "opt";
      const delegation = node.delegation?.runId ? ` · run ${node.delegation.runId}` : "";
      const claim = node.claim?.claimHash ? ` · claim ${node.claim.claimHash.slice(0, 12)}` : "";
      const validation = node.validation ? ` · validation ${node.validation.status}${node.validation.verdict ? `/${node.validation.verdict}` : ""}${node.validation.runId ? ` ${node.validation.runId}` : ""}` : "";
      const blocker = node.blocker ? ` · blocker ${node.blocker}` : "";
      lines.push(`${indent}${branch}${icon(node)} ${node.path} ${node.title} [${node.status}/${node.owner}/${required}/${node.priority}] · id ${node.id}${delegation}${claim}${validation}${blocker}`);
      walk(node.id, `${indent}${last ? "  " : "│ "}`);
    });
  };
  walk(undefined);
  return lines.join("\n");
}

export function goalTodoCompletionBlockers(todoState: GoalTodoState, goalId: string | undefined): string[] {
  if (!goalId) return [];
  const nodes = goalNodes(todoState, goalId);
  if (nodes.length === 0) return [];
  const blockers: string[] = [];
  for (const node of nodes) {
    if (node.required && OPEN_REQUIRED_STATUSES.has(node.status)) blockers.push(`todo ${node.path} '${node.title}' is required and ${node.status}`);
    if (node.required && node.status === "skipped" && !node.skipReason?.trim()) blockers.push(`todo ${node.path} '${node.title}' skipped without explicit reason`);
    const evidenceRequired = todoState.policy.requireEvidenceForCritical && (node.priority === "critical" || Boolean(node.delegation) || node.owner === "factory" || node.owner === "orchestration");
    if (node.status === "done" && evidenceRequired && node.evidenceRefs.length === 0 && node.validationCommands.length === 0 && !node.artifacts?.outputHash) blockers.push(`todo ${node.path} '${node.title}' done without evidence`);
    if (node.status === "skipped" && evidenceRequired && node.evidenceRefs.length === 0 && node.validationCommands.length === 0 && !node.artifacts?.outputHash) blockers.push(`todo ${node.path} '${node.title}' skipped without evidence`);
    if (node.status === "done" && node.delegation && node.delegation.status !== "accepted") blockers.push(`todo ${node.path} '${node.title}' delegated claim is not parent-accepted`);
    if (node.status === "done") {
      const openChildren = nodes.filter((candidate) => candidate.parentId === node.id && candidate.required && OPEN_REQUIRED_STATUSES.has(candidate.status));
      if (openChildren.length > 0) blockers.push(`todo ${node.path} '${node.title}' is done but has open required child TODOs`);
    }
  }
  blockers.push(...validateGoalTodoGraph(todoState, goalId));
  return blockers;
}

export function goalTodoCompletionDiagnostics(todoState: GoalTodoState, goalId: string | undefined): GoalTodoCompletionDiagnostics {
  const nodes = goalId ? goalNodes(todoState, goalId) : [];
  const completionBlockers = goalTodoCompletionBlockers(todoState, goalId);
  const reviewNoShip = nodes.some((node) => node.reviewNoShip === true);
  const hardNoShip = completionBlockers.length > 0;
  return {
    completionReady: completionBlockers.length === 0 && !reviewNoShip,
    hardNoShip,
    reviewNoShip,
    effectiveNoShip: hardNoShip || reviewNoShip,
    completionBlockers,
    nextValidActions: Object.fromEntries(nodes.map((node) => [node.id, nextValidGoalTodoActions(node)])),
  };
}

export function formatGoalTodoDiagnostics(diagnostics: GoalTodoCompletionDiagnostics): string {
  const blockers = diagnostics.completionBlockers.slice(0, 3).join(" | ") || "none";
  return `completion_ready=${diagnostics.completionReady} · hard_no_ship=${diagnostics.hardNoShip} · review_no_ship=${diagnostics.reviewNoShip} · effective_no_ship=${diagnostics.effectiveNoShip} · completion_blockers=${blockers}`;
}

export function extractTodoClaimFromText(text: string): { todoId?: string; childGoalStatus?: GoalTodoChildGoalStatus; statusClaim?: GoalTodoStatusClaim; evidenceRefs: string[]; validationCommands: string[]; noShip?: boolean; hasFinalMarker: boolean; subtodoDeltaProposals: string[]; acceptanceBlockers: string[]; targetReadiness?: GoalTodoClaimTargetReadiness; risksBlockers: string[] } {
  const todoIdMatch = text.match(/todo_id\s*[:=]\s*([^\s]+)/i);
  const statusMatch = text.match(/child_goal_status\s*[:=]\s*(ready_for_oracle|incomplete|blocked)/i);
  const statusClaimMatch = text.match(/status_claim\s*[:=]\s*(done|incomplete|blocked)/i);
  const noShipMatch = text.match(/no_ship\s*[:=]\s*(true|yes|false|no)/i);
  const targetReadinessRaw = text.match(/target_readiness\s*[:=]\s*(ready_for_parent_acceptance|needs_parent_review|blocked)/i)?.[1]?.toLowerCase();
  const lines = text.split(/\r?\n/);
  const collectAfter = (label: RegExp): string[] => {
    const result: string[] = [];
    let collecting = false;
    for (const line of lines) {
      if (label.test(line)) {
        collecting = true;
        const inline = line.split(/[:=]/).slice(1).join(":").trim();
        if (inline && !/^\s*$/.test(inline)) result.push(inline.replace(/^[-*]\s*/, ""));
        continue;
      }
      if (collecting) {
        if (/^[A-Za-z_ -]+\s*[:=]/.test(line) && !/^\s*[-*]/.test(line)) break;
        const item = line.trim().replace(/^[-*]\s*/, "");
        if (item) result.push(item);
      }
    }
    return result.filter((item) => item.length > 0);
  };
  return {
    todoId: todoIdMatch?.[1]?.trim(),
    childGoalStatus: statusMatch?.[1]?.toLowerCase() as GoalTodoChildGoalStatus | undefined,
    statusClaim: statusClaimMatch?.[1]?.toLowerCase() as GoalTodoStatusClaim | undefined,
    evidenceRefs: collectAfter(/^\s*evidence_refs\s*[:=]/i),
    validationCommands: collectAfter(/^\s*validation_commands\s*[:=]/i),
    noShip: noShipMatch ? /^(true|yes)$/i.test(noShipMatch[1]) : undefined,
    targetReadiness: targetReadinessRaw as GoalTodoClaimTargetReadiness | undefined,
    acceptanceBlockers: collectAfter(/^\s*acceptance_blockers\s*[:=]/i).filter((item) => !/^(none|n\/a|null)$/i.test(item)),
    risksBlockers: collectAfter(/^\s*risks_blockers\s*[:=]/i),
    hasFinalMarker: /FINAL_MARKER\s*:\s*(TODO_CHILD_RESULT_END|TODO_CHILD_RESULT_V2_END)|TODO_CHILD_RESULT_END|TODO_CHILD_RESULT_V2_END/.test(text),
    subtodoDeltaProposals: collectAfter(/^\s*subtodo_delta_proposals\s*[:=]/i),
  };
}

function collectLabeledLines(text: string, label: RegExp): string[] {
  const result: string[] = [];
  let collecting = false;
  for (const line of text.split(/\r?\n/)) {
    if (label.test(line)) {
      collecting = true;
      const inline = line.split(/[:=]/).slice(1).join(":").trim();
      if (inline) result.push(inline.replace(/^[-*]\s*/, ""));
      continue;
    }
    if (collecting) {
      const labelLine = /^\s*(?:[-*]\s*)?[A-Za-z_ -]+\s*[:=]/.test(line);
      const indentedBulletItem = /^\s{2,}[-*]\s+/.test(line);
      if (labelLine && !indentedBulletItem) break;
      const item = line.trim().replace(/^[-*]\s*/, "");
      if (item) result.push(item);
    }
  }
  return result.map((item) => item.trim()).filter((item) => item.length > 0 && !/^(none|n\/a|null)$/i.test(item));
}

function extractLabeledScalar(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*[:=]\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

export function extractTodoClaimValidationFromText(text: string): TodoClaimValidationResult {
  const todoIdMatch = text.match(/todo_id\s*[:=]\s*([^\s]+)/i);
  const claimHashMatch = text.match(/claim_hash\s*[:=]\s*([a-f0-9]{64})/i);
  const verdictRaw = extractLabeledScalar(text, "verdict")?.toUpperCase();
  const actionRaw = extractLabeledScalar(text, "recommended_action")?.toLowerCase().replace(/[ -]/g, "_");
  const noShipMatch = text.match(/no_ship\s*[:=]\s*(true|yes|false|no)/i);
  const confidenceRaw = extractLabeledScalar(text, "confidence")?.toUpperCase();
  return {
    todoId: todoIdMatch?.[1]?.trim(),
    claimHash: claimHashMatch?.[1]?.trim(),
    verdict: verdictRaw === "PASS" || verdictRaw === "WARN" || verdictRaw === "FAIL" ? verdictRaw : undefined,
    recommendedAction: actionRaw === "accept_claim" || actionRaw === "needs_review" || actionRaw === "reject_claim" || actionRaw === "block" ? actionRaw : undefined,
    evidenceRefs: collectLabeledLines(text, /^\s*(?:[-*]\s*)?evidence_refs\s*[:=]/i),
    validationCommands: collectLabeledLines(text, /^\s*(?:[-*]\s*)?validation_commands\s*[:=]/i),
    blockingIssues: collectLabeledLines(text, /^\s*(?:[-*]\s*)?blocking_issues\s*[:=]/i),
    noShip: noShipMatch ? /^(true|yes)$/i.test(noShipMatch[1]) : undefined,
    confidence: confidenceRaw === "LOW" || confidenceRaw === "MEDIUM" || confidenceRaw === "HIGH" ? confidenceRaw : undefined,
    hasFinalMarker: /FINAL_MARKER\s*:\s*TODO_CLAIM_VALIDATION_END|TODO_CLAIM_VALIDATION_END/.test(text),
  };
}

export function isActionableTodoClaimValidation(result: TodoClaimValidationResult, todoId: string, claimHash?: string): boolean {
  return result.todoId === todoId
    && result.hasFinalMarker
    && Boolean(result.verdict)
    && Boolean(result.recommendedAction)
    && Boolean(result.confidence)
    && result.noShip !== undefined
    && (!claimHash || result.claimHash === claimHash);
}

export function extractTodoSplitRequestFromText(text: string): TodoSplitRequest {
  const todoIdMatch = text.match(/todo_id\s*[:=]\s*([^\s]+)/i);
  const actionRaw = extractLabeledScalar(text, "recommended_action")?.toLowerCase().replace(/[ -]/g, "_");
  const riskRaw = extractLabeledScalar(text, "risk_level")?.toLowerCase();
  const noShipMatch = text.match(/no_ship\s*[:=]\s*(true|yes|false|no)/i);
  return {
    todoId: todoIdMatch?.[1]?.trim(),
    reason: extractLabeledScalar(text, "reason"),
    recommendedAction: actionRaw === "split" || actionRaw === "replan" || actionRaw === "factory" || actionRaw === "needs_user" || actionRaw === "blocked" ? actionRaw : undefined,
    proposedSubtodos: collectLabeledLines(text, /^\s*(?:[-*]\s*)?proposed_subtodos\s*[:=]/i),
    riskLevel: riskRaw === "low" || riskRaw === "medium" || riskRaw === "high" ? riskRaw : undefined,
    validationPlan: collectLabeledLines(text, /^\s*(?:[-*]\s*)?validation_plan\s*[:=]/i),
    noShip: noShipMatch ? /^(true|yes)$/i.test(noShipMatch[1]) : undefined,
    hasFinalMarker: /FINAL_MARKER\s*:\s*TODO_SPLIT_REQUEST_END|TODO_SPLIT_REQUEST_END/.test(text),
  };
}

export function isActionableTodoSplitRequest(request: TodoSplitRequest, todoId: string): boolean {
  return request.todoId === todoId
    && request.hasFinalMarker
    && request.recommendedAction === "split"
    && request.noShip !== true
    && request.proposedSubtodos.length > 0;
}

export function applyTodoSplitRequest(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string, todoId: string, request: TodoSplitRequest, source: GoalTodoEventSource = "delegation"): GoalTodoNode[] {
  if (!isActionableTodoSplitRequest(request, todoId)) throw new Error(`TODO split request for ${todoId} is not actionable.`);
  const titles = request.proposedSubtodos.map((title) => title.trim()).filter(Boolean);
  const children = splitGoalTodo(pi, state, goalId, todoId, titles, source);
  completeGoalTodo(pi, state, goalId, todoId, { skipped: true, reason: `decomposed into ${children.length} child TODO(s) by TODO_SPLIT_REQUEST`, validationCommands: request.validationPlan }, source);
  return children;
}

function parseOptionValue(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function stripKnownOptions(text: string): string {
  return text
    .replace(/(^|\s)--parent\s+\S+/g, " ")
    .replace(/(^|\s)--owner\s+\S+/g, " ")
    .replace(/(^|\s)--priority\s+\S+/g, " ")
    .replace(/(^|\s)--optional\b/g, " ")
    .replace(/(^|\s)--required\b/g, " ")
    .replace(/(^|\s)--evidence\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function handleGoalTodoTextCommand(pi: ExtensionAPI, state: HarnessRuntimeState, goalId: string | undefined, text: string): GoalTodoCommandResult {
  if (!goalId) return { ok: false, message: "Goal TODOs require an active runtime goal. Use /goal <objective> first." };
  const trimmed = text.trim();
  if (!trimmed || trimmed === "list" || trimmed === "tree" || trimmed === "status") return { ok: true, message: formatGoalTodoTree(state.goalTodos, goalId) };
  if (trimmed === "next") {
    const summary = summarizeGoalTodos(state.goalTodos, goalId);
    const next = summary.nextAgent ?? summary.nextUser;
    return { ok: true, message: next ? `${next.id} ${next.path} ${next.title} [${next.status}/${next.owner}]` : "No next goal TODO found." };
  }
  const [command = "", ...rest] = trimmed.split(/\s+/);
  const body = rest.join(" ").trim();
  const tokens = rest;
  try {
    if (command === "add") {
      const ownerRaw = parseOptionValue(tokens, "--owner");
      const priorityRaw = parseOptionValue(tokens, "--priority");
      const parentId = parseOptionValue(tokens, "--parent");
      const owner = includesString(VALID_OWNER, ownerRaw) ? ownerRaw : "agent";
      const priority = includesString(VALID_PRIORITY, priorityRaw) ? priorityRaw : "normal";
      const required = tokens.includes("--optional") ? false : true;
      const title = stripKnownOptions(body);
      const node = addGoalTodo(pi, state, goalId, { title, parentId, owner, priority, required }, "command");
      return { ok: true, message: `added TODO ${node.id} ${node.path}: ${node.title}`, node };
    }
    if (command === "done" || command === "skip") {
      const todoId = rest[0];
      if (!todoId) return { ok: false, message: `Usage: /goal todo ${command} <todoId> [evidence/reason]` };
      const evidence = rest.slice(1).join(" ").replace(/^--evidence\s+/, "").trim();
      const node = resolveGoalTodo(pi, state, goalId, todoId, { action: command === "skip" ? "skip" : "complete", evidenceRefs: evidence ? [evidence] : [], reason: evidence }, "command");
      return { ok: true, message: `${command === "skip" ? "skipped" : "done"} TODO ${node.path}: ${node.title}`, node };
    }
    if (command === "block" || command === "user") {
      const todoId = rest[0];
      const reason = rest.slice(1).join(" ").trim();
      if (!todoId || !reason) return { ok: false, message: `Usage: /goal todo ${command} <todoId> <reason>` };
      const node = command === "user"
        ? patchGoalTodo(pi, state, goalId, todoId, { status: "needs_user", owner: "user", blocker: reason, reviewNoShip: true }, "command")
        : resolveGoalTodo(pi, state, goalId, todoId, { action: "block", reason }, "command");
      return { ok: true, message: `updated TODO ${node.path}: ${node.status}`, node };
    }
    if (command === "start") {
      const todoId = rest[0];
      if (!todoId) return { ok: false, message: "Usage: /goal todo start <todoId>" };
      const node = patchGoalTodo(pi, state, goalId, todoId, { status: "in_progress", owner: "agent" }, "command");
      return { ok: true, message: `started TODO ${node.path}: ${node.title}`, node };
    }
    if (command === "focus") {
      const todoId = rest[0];
      focusGoalTodo(pi, state, goalId, todoId, "command");
      return { ok: true, message: todoId ? `focused TODO ${todoId}` : "cleared TODO focus" };
    }
    if (command === "split") {
      const todoId = rest[0];
      const titles = rest.slice(1).join(" ").split(";").map((item) => item.trim()).filter(Boolean);
      if (!todoId || titles.length === 0) return { ok: false, message: "Usage: /goal todo split <todoId> child A; child B" };
      const nodes = splitGoalTodo(pi, state, goalId, todoId, titles, "command");
      return { ok: true, message: `split TODO ${todoId} into ${nodes.length} child TODO(s)` };
    }
    if (command === "accept-claim" || command === "accept") {
      const todoId = rest[0];
      if (!todoId) return { ok: false, message: `Usage: /goal todo ${command} <todoId> [evidence]` };
      const evidence = rest.slice(1).join(" ").trim();
      const node = resolveGoalTodo(pi, state, goalId, todoId, { action: "accept_claim", evidenceRefs: evidence ? [evidence] : [] }, "command");
      return { ok: true, message: `accepted claim for TODO ${node.path}: ${node.title}`, node };
    }
    if (command === "reject-claim" || command === "reject") {
      const todoId = rest[0];
      const reason = rest.slice(1).join(" ").trim();
      if (!todoId || !reason) return { ok: false, message: `Usage: /goal todo ${command} <todoId> <reason>` };
      const node = resolveGoalTodo(pi, state, goalId, todoId, { action: "reject_claim", reason }, "command");
      return { ok: true, message: `rejected claim for TODO ${node.path}: ${node.title}`, node };
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: false, message: "Usage: /goal todo [tree|next|add|done|block|skip|user|start|focus|split|accept-claim|reject-claim]; primary API tool is resolve_goal_todo" };
}
