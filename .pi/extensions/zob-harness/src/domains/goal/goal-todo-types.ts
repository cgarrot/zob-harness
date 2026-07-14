import type { ZcommitChildChangedPathRef } from "../git/git-ops.js";

export type GoalTodoStatus = "planned" | "ready" | "in_progress" | "delegated" | "claim_returned" | "needs_review" | "needs_oracle" | "needs_user" | "blocked" | "done" | "skipped";
export type GoalTodoOwner = "agent" | "user" | "oracle" | "subagent" | "factory" | "orchestration";
export type GoalTodoPriority = "low" | "normal" | "high" | "critical";
export type GoalTodoDelegationStatus = "queued" | "running" | "claim_returned" | "accepted" | "rejected" | "failed" | "unknown";
export type GoalTodoDelegationAttemptStatus =
  | "queued"
  | "running"
  | "claim_returned"
  | "accepted"
  | "rejected"
  | "failed_preflight"
  | "failed_runtime"
  | "failed_output_gate_format"
  | "failed_output_gate_semantic"
  | "output_declared_incomplete"
  | "cancelled"
  | "liveness_unknown";
export type GoalTodoDelegationAttemptReasonCode =
  | "queued"
  | "child_started"
  | "claim_returned"
  | "claim_accepted"
  | "claim_rejected"
  | "preflight_config_failed"
  | "preflight_contract_failed"
  | "preflight_policy_failed"
  | "child_runtime_failed"
  | "child_aborted"
  | "output_missing"
  | "output_gate_contract_configuration"
  | "output_gate_format"
  | "output_gate_semantic"
  | "output_declared_incomplete"
  | "output_declared_blocked"
  | "cancelled"
  | "liveness_unknown";
export type GoalTodoDelegationAttemptFailureKind = "preflight" | "config" | "output_gate" | "child_runtime" | "aborted";
export type GoalTodoDelegationLiveness = "live" | "unknown" | "inactive";
export type GoalTodoDelegationLivenessAssessmentStatus = "active" | "inactive" | "unknown";
export type GoalTodoDelegationLivenessProofSource = "current_monitor" | "durable_attempt" | "restored_monitor" | "none";
export type GoalTodoDelegationLivenessProofCode =
  | "monitor_active_exact"
  | "monitor_terminal_exact"
  | "durable_preflight_terminal"
  | "durable_child_terminal"
  | "durable_output_terminal"
  | "restored_nonterminal_without_controller"
  | "nonterminal_without_authoritative_status"
  | "terminal_proof_incomplete"
  | "attempt_id_mismatch"
  | "run_id_mismatch"
  | "monitor_attempt_run_mismatch";
export interface GoalTodoDelegationLivenessProof {
  schema: "zob.goal-todo-delegation-liveness-proof.v1";
  status: GoalTodoDelegationLivenessAssessmentStatus;
  source: GoalTodoDelegationLivenessProofSource;
  code: GoalTodoDelegationLivenessProofCode;
  attemptId: string;
  runId: string;
  attemptStatus: GoalTodoDelegationAttemptStatus;
  monitorStatus?: string;
  proofAt: number;
  proofTimestampHash: string;
  proofHash: string;
  bodyStored: false;
}
export type GoalTodoClaimValidationPolicy = "parent_review" | "oracle_required";

export type GoalTodoReferenceCode =
  | "resolved"
  | "missing_goal_id"
  | "missing_reference"
  | "invalid_todo_id"
  | "invalid_todo_path"
  | "todo_id_not_found"
  | "todo_id_cross_goal"
  | "todo_id_ambiguous"
  | "todo_path_not_found"
  | "todo_path_ambiguous"
  | "reference_mismatch"
  | "batch_resolution_failed";

export type GoalTodoReferenceField = "goal_id" | "todo_id" | "todo_path" | "references" | "batch";
export type GoalTodoReferenceRetryPolicy = "none" | "fix_input" | "refresh_goal_todos" | "select_canonical_id";
export type GoalTodoReferenceSafeNextAction = "provide_canonical_todo_id" | "provide_visible_todo_path" | "make_references_agree" | "refresh_goal_todos" | "select_canonical_todo_id";

export interface GoalTodoCanonicalReferenceInput {
  todoId?: string;
  todoPath?: string;
}

export interface GoalTodoReferenceCandidate {
  canonicalId: string;
  goalId: string;
  path: string;
}

export interface GoalTodoReferenceError {
  code: Exclude<GoalTodoReferenceCode, "resolved" | "batch_resolution_failed">;
  field: GoalTodoReferenceField;
  message: string;
  index?: number;
}

export interface GoalTodoReferenceResolution {
  node?: GoalTodoNode;
  canonicalId?: string;
  path?: string;
  code: Exclude<GoalTodoReferenceCode, "batch_resolution_failed">;
  errors: GoalTodoReferenceError[];
  candidates: GoalTodoReferenceCandidate[];
  retryPolicy: GoalTodoReferenceRetryPolicy;
}

export interface GoalTodoReferenceBatchResolution {
  nodes: GoalTodoNode[];
  canonicalIds: string[];
  paths: string[];
  code: "resolved" | "batch_resolution_failed";
  resolutions: GoalTodoReferenceResolution[];
  errors: GoalTodoReferenceError[];
  candidates: GoalTodoReferenceCandidate[];
  retryPolicy: GoalTodoReferenceRetryPolicy;
}

export interface GoalTodoReferenceDiagnostic {
  schema: "zob.goal-todo-reference-diagnostic.v1";
  code: GoalTodoReferenceCode;
  field: GoalTodoReferenceField;
  retry_policy: GoalTodoReferenceRetryPolicy;
  safe_next_actions: readonly GoalTodoReferenceSafeNextAction[];
  errors: readonly GoalTodoReferenceError[];
  candidates: readonly GoalTodoReferenceCandidate[];
}

export type GoalTodoTransitionAction =
  | "no_op"
  | "update"
  | "mark_ready"
  | "start"
  | "queue_delegation"
  | "mark_delegation_failed"
  | "return_claim"
  | "mark_needs_review"
  | "mark_needs_oracle"
  | "mark_needs_user"
  | "complete"
  | "accept_claim"
  | "reject_claim"
  | "block"
  | "skip"
  | "reopen"
  | "recover_delegation";

export type GoalTodoTransitionGuard =
  | "update_status_preserved"
  | "delegation_absent_or_inactive"
  | "delegation_recovery_not_required"
  | "delegation_absent"
  | "claim_absent"
  | "delegation_returnable"
  | "delegation_claim_returned"
  | "delegation_recoverable"
  | "delegation_not_live"
  | "delegation_liveness_inactive"
  | "delegation_attempt_matches"
  | "delegation_failure_context_present"
  | "claim_present"
  | "claim_gate_passed"
  | "child_status_present"
  | "child_ready_for_oracle"
  | "status_claim_present"
  | "child_claims_done"
  | "target_readiness_present"
  | "target_ready_for_parent_acceptance"
  | "acceptance_blockers_absent"
  | "no_ship_clear"
  | "child_no_ship_false"
  | "resolution_evidence_present"
  | "evidence_present"
  | "resolution_reason_present"
  | "validation_policy_present"
  | "claim_binding_present"
  | "claim_attempt_matches"
  | "claim_goal_revision_matches"
  | "claim_graph_revision_matches"
  | "claim_policy_matches"
  | "validation_binding_matches"
  | "acceptance_policy_satisfied"
  | "claim_hash_matches"
  | "claim_revision_matches"
  | "user_resolved"
  | "cas_bound"
  | "reopen_clears_delegation";

export type GoalTodoTransitionCode =
  | "transition_allowed"
  | "idempotent_noop"
  | "unknown_status"
  | "unknown_action"
  | "invalid_transition"
  | "terminal_status"
  | "active_delegation"
  | "status_patch_forbidden"
  | "delegation_recovery_required"
  | "delegation_must_be_absent"
  | "claim_must_be_cleared"
  | "delegation_not_returnable"
  | "claim_delegation_not_returned"
  | "delegation_not_recoverable"
  | "delegation_liveness_unknown"
  | "delegation_attempt_mismatch"
  | "delegation_failure_context_required"
  | "claim_required"
  | "claim_gate_not_passed"
  | "child_status_required"
  | "child_status_not_ready"
  | "status_claim_required"
  | "child_status_claim_not_done"
  | "target_readiness_required"
  | "target_not_ready"
  | "acceptance_blockers_present"
  | "no_ship_blocked"
  | "evidence_required"
  | "reason_required"
  | "validation_policy_required"
  | "legacy_claim_binding_required"
  | "claim_attempt_mismatch"
  | "claim_goal_revision_mismatch"
  | "claim_graph_revision_mismatch"
  | "claim_policy_mismatch"
  | "claim_validation_binding_mismatch"
  | "claim_validation_not_acceptable"
  | "claim_hash_mismatch"
  | "claim_revision_mismatch"
  | "user_resolution_required"
  | "cas_required"
  | "reopen_reset_required"
  | "dedicated_transition_required"
  | "auto_resolution_mismatch";

export type GoalTodoTransitionRetryPolicy = "none" | "idempotent" | "after_context_change" | "never";

export interface GoalTodoTransitionContext {
  /** For action=update, omission means metadata-only; a value must equal currentStatus. */
  requestedStatus?: GoalTodoStatus;
  delegationStatus?: GoalTodoDelegationStatus;
  delegationLiveness?: GoalTodoDelegationLiveness;
  delegationAttemptMatches?: boolean;
  hasFailureContext?: boolean;
  hasClaim?: boolean;
  claimGatePassed?: boolean;
  childGoalStatus?: GoalTodoChildGoalStatus;
  statusClaim?: GoalTodoStatusClaim;
  targetReadiness?: GoalTodoClaimTargetReadiness;
  hasAcceptanceBlockers?: boolean;
  noShip?: boolean;
  /** Sole evidence-policy input; callers derive it from critical/delegated/factory/orchestration policy. */
  evidenceRequired?: boolean;
  /** Legacy node attributes are informational and never decide evidence policy. */
  critical?: boolean;
  required?: boolean;
  hasEvidence?: boolean;
  hasReason?: boolean;
  validationPolicy?: GoalTodoClaimValidationPolicy;
  claimBindingPresent?: boolean;
  claimAttemptMatches?: boolean;
  claimGoalRevisionMatches?: boolean;
  claimGraphRevisionMatches?: boolean;
  claimPolicyMatches?: boolean;
  validationBindingMatches?: boolean;
  validationStatus?: GoalTodoClaimValidationStatus;
  validationVerdict?: GoalTodoClaimValidationVerdict;
  validationRecommendedAction?: GoalTodoClaimValidationRecommendedAction;
  validationConfidence?: GoalTodoClaimValidationConfidence;
  validationNoShip?: boolean;
  validationHasBlockingIssues?: boolean;
  claimHash?: string;
  expectedClaimHash?: string;
  claimHashMatches?: boolean;
  claimRevision?: number;
  expectedClaimRevision?: number;
  claimRevisionMatches?: boolean;
  userResolved?: boolean;
  /** True only when the mutation carries the required optimistic-concurrency guard. */
  casBound?: boolean;
  /** Must mean the mutation will clear both delegation and claim metadata before reopening. */
  clearDelegationOnReopen?: boolean;
}

export interface GoalTodoTransitionInput {
  currentStatus: string;
  action: string;
  context?: GoalTodoTransitionContext;
}

export interface GoalTodoTransitionRule {
  allowed: boolean;
  nextStatus?: GoalTodoStatus;
  code: Extract<GoalTodoTransitionCode, "transition_allowed" | "idempotent_noop" | "invalid_transition" | "terminal_status">;
  requiredGuards: readonly GoalTodoTransitionGuard[];
}

export type GoalTodoTransitionTable = Readonly<Record<GoalTodoStatus, Readonly<Record<GoalTodoTransitionAction, GoalTodoTransitionRule>>>>;

export interface GoalTodoTransitionDecision {
  allowed: boolean;
  nextStatus?: GoalTodoStatus;
  code: GoalTodoTransitionCode;
  currentStatus: string;
  action: string;
  requiredGuards: readonly GoalTodoTransitionGuard[];
  retryPolicy: GoalTodoTransitionRetryPolicy;
  safeNextActions: readonly GoalTodoTransitionAction[];
}

export interface GoalTodoTransitionDiagnostic {
  schema: "zob.goal-todo-transition-diagnostic.v1";
  code: GoalTodoTransitionCode;
  current: string;
  action: string;
  safe_next_actions: readonly GoalTodoTransitionAction[];
  retry_policy: GoalTodoTransitionRetryPolicy;
  required_guards: readonly GoalTodoTransitionGuard[];
}

/** Operation facts from which the domain derives the engine's canonical transition context. */
export interface GoalTodoTransitionOperationContext {
  requestedStatus?: GoalTodoStatus;
  evidenceRefs?: string[];
  validationCommands?: string[];
  reason?: string;
  prospectiveClaim?: GoalTodoClaimRef;
  validationPolicy?: GoalTodoClaimValidationPolicy;
  expectedValidationPolicy?: GoalTodoClaimValidationPolicy;
  expectedClaimHash?: string;
  expectedAttemptId?: string;
  expectedGoalRevision?: number;
  expectedGraphRevision?: number;
  expectedClaimRevision?: number;
  validationBindingMatches?: boolean;
  userResolved?: boolean;
  casBound?: boolean;
  clearDelegationOnReopen?: boolean;
  delegationLiveness?: GoalTodoDelegationLiveness;
  delegationAttemptMatches?: boolean;
  /** Hash-only context proving this is a concrete failed attempt, never an arbitrary failed link. */
  failureHash?: string;
}

export interface GoalTodoTransitionRuleDiagnostic extends GoalTodoTransitionRule {
  currentStatus: GoalTodoStatus;
  action: GoalTodoTransitionAction;
}

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
  /** Version 2 is the first immutable attempt/revision/policy-bound claim shape. Omission is legacy and fails closed. */
  claimVersion?: 2;
  attemptId?: string;
  runId?: string;
  goalRevision?: number;
  graphRevision?: number;
  todoRevision?: number;
  validationPolicy?: GoalTodoClaimValidationPolicy;
  outputHash?: string;
  outputContract?: string;
  gateHash?: string;
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
  /** Version 1 is the first immutable claim/attempt/revision-bound validation shape. */
  validationVersion?: 1;
  claimHash?: string;
  attemptId?: string;
  claimRunId?: string;
  claimGoalRevision?: number;
  claimGraphRevision?: number;
  claimTodoRevision?: number;
  validationPolicy?: GoalTodoClaimValidationPolicy;
  /** Exact canonical revisions immediately before this validation event. */
  expectedGraphRevision?: number;
  expectedTodoRevision?: number;
  /** Canonical revisions immediately after this validation event. */
  goalRevision?: number;
  graphRevision?: number;
  todoRevision?: number;
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

export type TodoPeerStatusClaim = "done" | "incomplete" | "blocked";

export interface TodoPeerResultItem {
  todoId?: string;
  statusClaim?: TodoPeerStatusClaim;
  evidenceRefs: string[];
  validationCommands: string[];
  risks: string[];
  acceptanceBlockers: string[];
  noShip?: boolean;
  hasFinalMarker: boolean;
}

export interface TodoPeerResultParseResult {
  contract?: "TODO_PEER_RESULT.v1" | "TODO_PEER_BUNDLE_RESULT.v1";
  items: TodoPeerResultItem[];
  hasFinalMarker: boolean;
  errors: string[];
}

export interface GoalTodoDelegationRecovery {
  attemptId: string;
  runId: string;
  boundGoalRevision: number;
  boundGraphRevision: number;
  boundTodoRevision: number;
  expectedGraphRevision: number;
  expectedTodoRevision: number;
  reasonHash: string;
  evidenceRefs: string[];
  evidenceRefsHash: string;
  proofRefs: string[];
  proofRefsHash: string;
  livenessProof: GoalTodoDelegationLivenessProof;
  recoveredAt: number;
  bodyStored: false;
}

export interface GoalTodoClaimResolutionBinding {
  claimVersion: 2;
  claimHash: string;
  attemptId: string;
  claimGoalRevision: number;
  claimGraphRevision: number;
  claimTodoRevision: number;
  expectedGoalRevision: number;
  expectedGraphRevision: number;
  expectedTodoRevision: number;
  validationPolicy: GoalTodoClaimValidationPolicy;
  validationOutputHash?: string;
}

export interface GoalTodoDelegationAttempt {
  /** Safe/content-addressed identity for one child launch; never reused for another attempt. */
  attemptId: string;
  runId: string;
  requestId?: string;
  requestIdHash?: string;
  goalId: string;
  todoId: string;
  todoPath: string;
  parentTodoId?: string;
  boundGoalRevision: number;
  boundGraphRevision: number;
  boundTodoRevision: number;
  agent?: string;
  childGoalId?: string;
  delegationDepth: number;
  status: GoalTodoDelegationAttemptStatus;
  reasonCode: GoalTodoDelegationAttemptReasonCode;
  failureKind?: GoalTodoDelegationAttemptFailureKind;
  outputContract?: string;
  /** Fixed when the attempt launches. Omission means a legacy attempt. */
  validationPolicy?: GoalTodoClaimValidationPolicy;
  outputHash?: string;
  gateHash?: string;
  failureHash?: string;
  gateIssueCodes: string[];
  gateIssueCount: number;
  evidenceRefCount: number;
  validationCommandCount: number;
  queuedAt?: number;
  startedAt?: number;
  finalizedAt?: number;
  updatedAt: number;
  bodyStored: false;
}

/** Compatibility projection only. Canonical lifecycle history is delegationAttempts + revisioned events. */
export interface GoalTodoDelegationRef {
  attemptId?: string;
  runId?: string;
  agent?: string;
  childGoalId?: string;
  requestId?: string;
  delegationDepth: number;
  status: GoalTodoDelegationStatus;
  reasonCode?: GoalTodoDelegationAttemptReasonCode;
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
  /** Immutable attempts are retained; revisioned events append lifecycle updates for a matching attemptId. */
  delegationAttempts?: GoalTodoDelegationAttempt[];
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
  /** Additive optimistic-concurrency foundation; normalized in-memory nodes always expose a positive value. */
  revision?: number;
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

export type GoalTodoRevisionDiagnosticCode = "malformed_v2_revision" | "graph_revision_gap" | "node_revision_gap" | "node_revision_conflict";

export interface GoalTodoRevisionDiagnostic {
  code: GoalTodoRevisionDiagnosticCode;
  goalId: string;
  eventKind: string;
  at: number;
  todoId?: string;
  expectedGraphRevision?: number;
  receivedGraphRevision?: number;
  expectedNodeRevision?: number;
  receivedNodeRevision?: number;
  message: string;
}

export type GoalMutationFailureCode =
  | "invalid_mutation_id"
  | "invalid_request_hash"
  | "invalid_request_body"
  | "request_hash_mismatch"
  | "invalid_revision_guard"
  | "invalid_current_revision"
  | "invalid_tool_name"
  | "invalid_goal_id"
  | "invalid_target_id"
  | "state_restore_blocked"
  | "receipt_stream_poisoned"
  | "preparation_persistence_failed"
  | "preparation_index_failed"
  | "abort_persistence_failed"
  | "abort_index_failed"
  | "mutation_in_doubt"
  | "receipt_persistence_failed"
  | "receipt_index_failed"
  | "invalid_mutation_result"
  | "mutation_id_conflict"
  | "stale_goal_revision"
  | "stale_graph_revision"
  | "stale_todo_revision";

/** Strict public CAS fields. Public tools will consume these additively in a later wiring slice. */
export interface GoalMutationPublicGuard {
  mutationId: string;
  expectedGoalRevision?: number;
  expectedGraphRevision?: number;
  expectedTodoRevision?: number;
}

export interface GoalMutationGuard {
  mutationId: string;
  requestHash: string;
  expectedGoalRevision?: number;
  expectedGraphRevision?: number;
  todoId?: string;
  expectedTodoRevision?: number;
}

export interface GoalMutationCurrentRevisions {
  goalRevision?: number;
  graphRevision?: number;
  todoRevisions?: Record<string, number>;
}

export type GoalMutationSideEffectState = "none" | "prepared" | "in_doubt" | "completed";

export interface GoalMutationSideEffectRef {
  state: GoalMutationSideEffectState;
  operationHash?: string;
}

export const GOAL_MUTATION_PHASE_CODES = {
  prepared: "prepared",
  applied: "applied",
  aborted: "aborted",
} as const;

export type GoalMutationPhase = typeof GOAL_MUTATION_PHASE_CODES[keyof typeof GOAL_MUTATION_PHASE_CODES];
export type GoalMutationPreparationPhase = Exclude<GoalMutationPhase, "applied">;

/** Durable body-free sentinel. It binds only stream identity, mutation identity, and request hash. */
export interface GoalMutationPreparation {
  schema: "zob.goal-mutation-preparation.v1";
  phase: GoalMutationPreparationPhase;
  goalId: string;
  mutationId: string;
  requestHash: string;
  recordedAt: number;
  bodyStored: false;
}

export interface GoalMutationPreparationInput {
  phase: GoalMutationPreparationPhase;
  goalId: string;
  mutationId: string;
  requestHash: string;
  recordedAt: number;
}

export interface GoalMutationProtocolRecord {
  requestHash: string;
  phase: GoalMutationPhase;
  prepared: GoalMutationPreparation;
  terminal?: GoalMutationPreparation | GoalMutationReceipt;
}

export interface GoalMutationReceipt {
  schema: "zob.goal-mutation-receipt.v1";
  /** New receipts are explicit applied records; omitted only by legacy v1 branch entries. */
  phase?: "applied";
  goalId: string;
  mutationId: string;
  requestHash: string;
  expectedGoalRevision?: number;
  expectedGraphRevision?: number;
  todoId?: string;
  expectedTodoRevision?: number;
  goalRevision?: number;
  graphRevision?: number;
  todoRevision?: number;
  eventCount: number;
  sideEffect?: GoalMutationSideEffectRef;
  appliedAt: number;
  bodyStored: false;
}

export interface GoalMutationReceiptInput {
  goalId: string;
  guard: GoalMutationGuard;
  appliedRevisions: {
    goalRevision?: number;
    graphRevision?: number;
    todoRevision?: number;
  };
  eventCount: number;
  appliedAt: number;
  sideEffect?: GoalMutationSideEffectRef;
}

export type GoalMutationReceiptDiagnosticCode =
  | "malformed_mutation_receipt"
  | "conflicting_mutation_receipt"
  | "malformed_mutation_phase"
  | "conflicting_mutation_phase"
  | "mutation_in_doubt"
  | "preparation_persistence_failed"
  | "preparation_index_failed"
  | "abort_persistence_failed"
  | "abort_index_failed"
  | "receipt_persistence_failed"
  | "receipt_index_failed"
  | "invalid_mutation_result";

export interface GoalMutationReceiptDiagnostic {
  code: GoalMutationReceiptDiagnosticCode;
  goalId: string;
  at: number;
  mutationId?: string;
  message: string;
}

export interface GoalMutationReceiptState {
  byGoal: Record<string, Record<string, GoalMutationReceipt>>;
  /** Latest deterministic prepared/applied/aborted protocol state per mutation. */
  protocolByGoal: Record<string, Record<string, GoalMutationProtocolRecord>>;
  /** Unmatched preparations block only their exact goal/mutation retry. */
  inDoubtByGoal: Record<string, Record<string, GoalMutationPreparation>>;
  diagnostics: GoalMutationReceiptDiagnostic[];
  restoreBlocked: Record<string, GoalMutationReceiptDiagnostic>;
}

export interface GoalMutationCasInput {
  goalId: string;
  guard: GoalMutationGuard;
  request: unknown;
  current: GoalMutationCurrentRevisions;
  receipts?: GoalMutationReceiptState;
}

interface GoalMutationCasOutcomeBase {
  ok: boolean;
  shouldApply: boolean;
  emitEvents: boolean;
  mutationId: string;
  requestHash: string;
  failureCodes: GoalMutationFailureCode[];
}

export interface GoalMutationAppliedOutcome extends GoalMutationCasOutcomeBase {
  status: "applied";
  ok: true;
  shouldApply: true;
  emitEvents: true;
  failureCodes: [];
}

export interface GoalMutationReplayedOutcome extends GoalMutationCasOutcomeBase {
  status: "replayed";
  ok: true;
  shouldApply: false;
  emitEvents: false;
  failureCodes: [];
  receipt: GoalMutationReceipt;
}

export interface GoalMutationConflictOutcome extends GoalMutationCasOutcomeBase {
  status: "conflict";
  ok: false;
  shouldApply: false;
  emitEvents: false;
}

export interface GoalMutationStaleOutcome extends GoalMutationCasOutcomeBase {
  status: "stale";
  ok: false;
  shouldApply: false;
  emitEvents: false;
}

export interface GoalMutationRejectedOutcome extends GoalMutationCasOutcomeBase {
  status: "rejected";
  ok: false;
  shouldApply: false;
  emitEvents: false;
}

export type GoalMutationCasOutcome =
  | GoalMutationAppliedOutcome
  | GoalMutationReplayedOutcome
  | GoalMutationConflictOutcome
  | GoalMutationStaleOutcome
  | GoalMutationRejectedOutcome;

export interface GoalMutationCanonicalRequest {
  toolName: string;
  goalId: string;
  resolvedTargetId: string;
  payload: unknown;
}

export interface GoalMutationObservation {
  schema: "zob.goal-mutation-observation.v1";
  code: "cas_guard_absent";
  toolName: string;
  goalId: string;
  resolvedTargetId: string;
  requestHash: string;
  bodyStored: false;
}

export interface GoalMutationExecutionDiagnostic {
  schema: "zob.goal-mutation-execution-diagnostic.v1";
  code: GoalMutationFailureCode;
  status: "stale" | "conflict" | "rejected";
  toolName: string;
  goalId: string;
  resolvedTargetId: string;
  mutationId?: string;
  requestHash?: string;
  bodyStored: false;
}

export interface GoalMutationApplyResult<Result> {
  result: Result;
  appliedRevisions: {
    goalRevision?: number;
    graphRevision?: number;
    todoRevision?: number;
  };
  eventCount: number;
  sideEffect?: GoalMutationSideEffectRef;
}

export type GoalMutationApplyFailureMode = "abort_if_unapplied" | "in_doubt";

export interface GoalMutationExecutionInput<Result> {
  toolName: string;
  goalId: string;
  resolvedTargetId: string;
  /** Canonical node identity when the resolved target is a TODO node. */
  todoId?: string;
  payload: unknown;
  guard?: GoalMutationPublicGuard;
  current: GoalMutationCurrentRevisions;
  receipts: GoalMutationReceiptState;
  restoreBlocked?: boolean;
  /** Pure/local validation hook. Guarded calls run it only after CAS apply authorization and before durable prepared. */
  beforeApply?: () => void | Promise<void>;
  apply: () => GoalMutationApplyResult<Result> | Promise<GoalMutationApplyResult<Result>>;
  /** Required for guarded calls; persists prepared/aborted sentinels before they are indexed. */
  persistPreparation?: (preparation: GoalMutationPreparation) => void | Promise<void>;
  persistReceipt: (receipt: GoalMutationReceipt) => void | Promise<void>;
  /** Runtime wiring reports whether a rejecting callback durably advanced its domain stream. */
  didApply?: () => boolean;
  /** Side-effectful callbacks must remain in_doubt after every post-prepare failure. */
  applyFailureMode?: GoalMutationApplyFailureMode;
  observe?: (observation: GoalMutationObservation) => void | Promise<void>;
  now?: () => number;
}

export interface GoalMutationObservedExecution<Result> {
  status: "observed";
  ok: true;
  requestHash: string;
  result: Result;
  observation: GoalMutationObservation;
}

export interface GoalMutationAppliedExecution<Result> {
  status: "applied";
  ok: true;
  requestHash: string;
  mutationId: string;
  result: Result;
  receipt: GoalMutationReceipt;
}

export interface GoalMutationReplayedExecution {
  status: "replayed";
  ok: true;
  requestHash: string;
  mutationId: string;
  receipt: GoalMutationReceipt;
}

export interface GoalMutationFailedExecution {
  status: "stale" | "conflict" | "rejected";
  ok: false;
  requestHash?: string;
  mutationId?: string;
  failureCodes: GoalMutationFailureCode[];
  diagnostic: GoalMutationExecutionDiagnostic;
}

export type GoalMutationExecutionOutcome<Result> =
  | GoalMutationObservedExecution<Result>
  | GoalMutationAppliedExecution<Result>
  | GoalMutationReplayedExecution
  | GoalMutationFailedExecution;

export interface GoalTodoState {
  nodes: GoalTodoNode[];
  policy: GoalTodoPolicy;
  /** Monotonic revision for each goal's TODO event stream. */
  graphRevisions: Record<string, number>;
  /** Body-free fail-closed replay diagnostics for malformed v2 revision envelopes. */
  revisionDiagnostics: GoalTodoRevisionDiagnostic[];
  /** First malformed v2 diagnostic per poisoned goal stream. Optional for legacy in-memory snapshots. */
  restoreBlocked?: Record<string, GoalTodoRevisionDiagnostic>;
  /** Deterministic body-free prepared/applied/aborted mutation protocol and receipt index. */
  mutationReceipts: GoalMutationReceiptState;
  focusTodoId?: string;
}

export type GoalTodoEventSource = "command" | "tool" | "runtime" | "delegation" | "import";
export type GoalTodoPatchClearField = "parentId" | "descriptionHash" | "delegation" | "claim" | "validation" | "contextScopeId" | "contextPackRef" | "freshness" | "blocker" | "skipReason" | "reviewNoShip";

export type GoalTodoLegacyEvent =
  | { version: 1; kind: "policy_set"; source: GoalTodoEventSource; goalId: string; policy: GoalTodoPolicy; at: number }
  | { version: 1; kind: "add"; source: GoalTodoEventSource; goalId: string; node: GoalTodoNode; at: number }
  | { version: 1; kind: "patch"; source: GoalTodoEventSource; goalId: string; todoId: string; patch: Partial<GoalTodoNode>; clearFields?: GoalTodoPatchClearField[]; at: number }
  | { version: 1; kind: "move"; source: GoalTodoEventSource; goalId: string; todoId: string; parentId?: string; at: number }
  | { version: 1; kind: "split"; source: GoalTodoEventSource; goalId: string; todoId: string; childIds: string[]; at: number }
  | { version: 1; kind: "delegate_link"; source: GoalTodoEventSource; goalId: string; todoId: string; runId: string; delegation: GoalTodoDelegationRef; at: number }
  | { version: 1; kind: "delegation_attempt_started"; source: GoalTodoEventSource; goalId: string; todoId: string; attempt: GoalTodoDelegationAttempt; at: number }
  | { version: 1; kind: "delegation_attempt_finalized"; source: GoalTodoEventSource; goalId: string; todoId: string; attempt: GoalTodoDelegationAttempt; at: number }
  | { version: 1; kind: "attempt_recovered"; source: GoalTodoEventSource; goalId: string; todoId: string; recovery: GoalTodoDelegationRecovery; at: number }
  | { version: 1; kind: "claim_returned"; source: GoalTodoEventSource; goalId: string; todoId: string; claimHash: string; claim?: GoalTodoClaimRef; evidenceRefs: string[]; validationCommands: string[]; noShip?: boolean; runId?: string; outputHash?: string; outputContract?: string; gatePassed?: boolean; childGoalStatus?: GoalTodoChildGoalStatus; statusClaim?: GoalTodoStatusClaim; targetReadiness?: GoalTodoClaimTargetReadiness; acceptanceBlockers?: string[]; childChangedPaths?: ZcommitChildChangedPathRef[]; attempt?: GoalTodoDelegationAttempt; at: number }
  | { version: 1; kind: "claim_validation_requested"; source: GoalTodoEventSource; goalId: string; todoId: string; validation: GoalTodoClaimValidationRef; at: number }
  | { version: 1; kind: "claim_validation_returned"; source: GoalTodoEventSource; goalId: string; todoId: string; validation: GoalTodoClaimValidationRef; evidenceRefs: string[]; validationCommands: string[]; noShip?: boolean; at: number }
  | { version: 1; kind: "claim_accepted"; source: GoalTodoEventSource; goalId: string; todoId: string; binding?: GoalTodoClaimResolutionBinding; evidenceRefs: string[]; validationCommands: string[]; at: number }
  | { version: 1; kind: "claim_rejected"; source: GoalTodoEventSource; goalId: string; todoId: string; binding?: GoalTodoClaimResolutionBinding; reasonHash: string; at: number }
  | { version: 1; kind: "clear_goal_todos"; source: GoalTodoEventSource; goalId: string; at: number }
  | { version: 1; kind: "focus"; source: GoalTodoEventSource; goalId: string; todoId?: string; at: number }
  | { version: 1; kind: "snapshot"; source: GoalTodoEventSource; goalId: string; nodes: GoalTodoNode[]; policy?: GoalTodoPolicy; focusTodoId?: string; at: number };

export type GoalTodoRevisionEvent<E extends GoalTodoLegacyEvent = GoalTodoLegacyEvent> = E extends GoalTodoLegacyEvent
  ? Omit<E, "version"> & { version: 2; graphRevision: number; nodeRevision?: number }
  : never;

export type GoalTodoEvent = GoalTodoLegacyEvent | GoalTodoRevisionEvent;

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
