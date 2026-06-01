import type { ZcommitChildChangedPathRef } from "./git-ops.js";

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
  childChangedPaths?: ZcommitChildChangedPathRef[];
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
  | { version: 1; kind: "claim_returned"; source: GoalTodoEventSource; goalId: string; todoId: string; claimHash: string; evidenceRefs: string[]; validationCommands: string[]; noShip?: boolean; runId?: string; outputHash?: string; outputContract?: string; gatePassed?: boolean; childGoalStatus?: GoalTodoChildGoalStatus; statusClaim?: GoalTodoStatusClaim; targetReadiness?: GoalTodoClaimTargetReadiness; acceptanceBlockers?: string[]; childChangedPaths?: ZcommitChildChangedPathRef[]; at: number }
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
