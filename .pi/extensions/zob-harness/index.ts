import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import zobHarnessRuntime from "./src/runtime/zobHarness.js";

export { renderHarnessWidget } from "./src/runtime/widget.js";
export { createHarnessRuntimeState, inferModeFromUserIntent } from "./src/runtime/state.js";
export { FILE_TOOL_RELIABILITY_PROMPT } from "./src/runtime/events.js";

export type {
  AdaptiveDelegationGovernorState,
  AdaptiveDelegationMode,
  AdaptiveDelegationOracleMode,
  AdaptiveDelegationPolicy,
  AdaptiveDelegationPolicyInput,
  AdaptiveDelegationRisk,
  DelegationRequestProposal,
  DelegationScore,
  GovernorDecision,
  ParentDispatchContract,
  SupervisedReadonlyDispatchContract,
  SupervisedReadonlyDispatchResult,
  SupervisedReadonlyDispatcher,
} from "./src/types.js";

export { CHRONICLE_STATES } from "./src/domains/telemetry/chronicle.js";

export type { ChronicleState } from "./src/domains/telemetry/chronicle.js";

export type {
  ChildStopCondition,
  OutputGateIssue,
  OutputGateIssueClassification,
  OutputGateIssueCode,
  RuleAppliesTo,
  RuleEnforcementLevel,
  RuleOracleRequirement,
  RulePack,
  RuleResolution,
  RuleResolverInput,
  ToolFailureAttempt,
  ToolFailureClass,
  ToolFailureReasonCode,
  ToolFailureReplayFixture,
  ToolFailureReplaySummary,
} from "./src/types.js";

export { pathMatches } from "./src/core/utils/paths.js";

export { parseGoalState, validateGoalState, validateStrictGoalSpecAnchor, parseBillableJobIntake, validateBillableJobIntake } from "./src/domains/goal/goal.js";
export type { StrictGoalSpecAnchor, StrictGoalSpecAnchorKind } from "./src/domains/goal/goal.js";
export { DEFAULT_GOAL_ACTIVATION_MODE, clearRuntimeGoalContinuationState, clearRuntimeGoalContinuationStateFor, formatGoalActivationMode, formatRuntimeGoalSummary, hasPendingUndeliveredZpeerInbound, queueRuntimeGoalContinuation, restoreRuntimeGoalFromBranch, resumeRuntimeGoal, runtimeGoalStatusLine } from "./src/runtime/goal-runtime.js";
export type { GoalActivationMode, RuntimeGoal, RuntimeGoalStatus, RuntimeGoalOracleStatus, RuntimeGoalOracleVerdict } from "./src/runtime/goal-runtime.js";
export {
  buildRuntimeGoalCompletionProposal,
  buildRuntimeGoalOracleBinding,
  evaluateRuntimeGoalCompletionProposalFreshness,
  evaluateRuntimeGoalOracleFreshness,
  formatRuntimeGoalCompletionProposal,
  formatRuntimeGoalOracleBinding,
  hashRuntimeGoalCompletionProposal,
  hashRuntimeGoalCompletionProposalArray,
  hashRuntimeGoalOracleDecision,
  hashRuntimeGoalOracleEvidence,
  isRuntimeGoalCompletionProposalV2,
  isRuntimeGoalOracleBindingV2,
  normalizeRuntimeGoalCompletionProposal,
  normalizeRuntimeGoalOracleState,
  publicRuntimeGoal,
  runtimeGoalCompletionProposalPublicDetails,
  runtimeGoalOraclePublicDetails,
} from "./src/runtime/goal-runtime/state.js";
export type {
  BuildRuntimeGoalCompletionProposalInput,
  BuildRuntimeGoalOracleBindingInput,
  EvaluateRuntimeGoalCompletionProposalFreshnessInput,
  EvaluateRuntimeGoalOracleFreshnessInput,
  RuntimeGoalCompletionProposalFreshness,
  RuntimeGoalCompletionProposalFreshnessCode,
  RuntimeGoalCompletionProposalFreshnessStatus,
  RuntimeGoalCompletionProposalLegacy,
  RuntimeGoalCompletionProposalMalformed,
  RuntimeGoalCompletionProposalSafeReproposeAction,
  RuntimeGoalCompletionProposalV2,
  RuntimeGoalEntry,
  RuntimeGoalOracleBindingV2,
  RuntimeGoalOracleFreshness,
  RuntimeGoalOracleFreshnessCode,
  RuntimeGoalOracleFreshnessStatus,
  RuntimeGoalRevisionDiagnostic,
} from "./src/runtime/goal-runtime/state.js";
export { extractModeIntent, looksLikeCompletePlanResponse, stripModeIntentMarkup, validateModeIntent } from "./src/runtime/mode-intent.js";
export type { ZobModeIntent, ZobModeIntentConfidence, ZobModeIntentRisk, ZobModeIntentValidation } from "./src/runtime/mode-intent.js";
export { capturePlanArtifact, extractPlanTitle, listCapturedPlanEntries, shouldCapturePlanResponse, updateCapturedPlanEntry } from "./src/runtime/plan-capture.js";
export type { PlanCaptureInput, PlanCaptureResult, PlanIndexEntry } from "./src/runtime/plan-capture.js";
export { launchCapturedPlan, previewCapturedPlanLaunch, resolveCapturedPlanForLaunch } from "./src/runtime/plan-launch.js";
export type { PlanActiveGoalStrategy, PlanLaunchInput, PlanLaunchResult, PlanLaunchSelector } from "./src/runtime/plan-launch.js";
export { PLAN_TODOS_BLOCK_END, PLAN_TODOS_BLOCK_START, PLAN_TODOS_CANONICAL_SCHEMA, PLAN_TODOS_DISPLAY_CARD_END, PLAN_TODOS_DISPLAY_CARD_START, PLAN_TODOS_INPUT_SCHEMA, PLAN_TODOS_SIDECAR_SCHEMA, buildPlanTodoSidecar, canonicalManifestHash, compileMarkdownPlanTodoManifest, extractAndNormalizePlanTodoManifest, extractPlanTodosJson, formatPlanTodoManifestDisplayCard, formatPlanTodoManifestTree, normalizePlanTodoManifest, planTodoSidecarRelativePath, readPlanTodoSidecar, redactPlanTodosBlockForDisplay, validatePlanTodoSidecar, writePlanTodoSidecar } from "./src/domains/plan/plan-todos.js";
export type { PlanLaunchStatus, PlanTodoCanonicalItem, PlanTodoCanonicalManifest, PlanTodoDisplayCardOptions, PlanTodoDisplayRedactionResult, PlanTodoManifestQuality, PlanTodoManifestResult, PlanTodoManifestSource, PlanTodoSidecar } from "./src/domains/plan/plan-todos.js";
export { ZOB_COMPACTION_CONTINUITY_CONTRACT, ZOB_TOOL_ROUTING_CONTRACT } from "./src/core/constants.js";
export { ZOB_COMPACTION_DETAILS_SCHEMA, ZOB_COMPACTION_ENTRY_TYPE, ZOB_COMPACTION_HARD_CAP_TOKENS, ZOB_COMPACTION_LEDGER_SCHEMA, ZOB_COMPACTION_SUMMARY_SCHEMA, ZOB_COMPACTION_TARGET_TOKENS, buildDeterministicZobCompactionResult, buildDeterministicZobCompactionSummary, buildZobCompactionDetails, buildZobCompactionInstructions, buildZobCompactionLedgerEntry, buildZobCompactionStateCapsule, withZobCompactionDetails, zobCompactionBodyFreeViolations } from "./src/runtime/compaction-policy.js";
export type { ZobCompactionDetails, ZobCompactionFileRefsInput, ZobCompactionInstructionInput, ZobCompactionLedgerEntry, ZobCompactionStateCapsule } from "./src/runtime/compaction-policy.js";
export { assistantMessageHasVisibleOutput, createStopRestoreCandidate, findStopRestoreUserEntryId, markStopRestoreAssistantMessage, markStopRestoreRestored, markStopRestoreToolVisible, shouldRestoreStopPrompt } from "./src/runtime/stop-restore.js";
export type { StopRestoreCandidate, StopRestoreCandidateInput, StopRestoreDecision, StopRestoreDecisionInput, StopRestoreRewindResult } from "./src/runtime/stop-restore.js";
export { isAdaptiveZmodeAlias, renderAdaptiveZmodeTemplate, resolveAdaptiveZmodeEntrypoint, validateAdaptiveZmodeEntrypoint } from "./src/runtime/adaptive-zmode.js";
export type { AdaptiveZmodeAlias, AdaptiveZmodeEntrypoint } from "./src/runtime/adaptive-zmode.js";
export {
  ZOB_GOAL_TODO_ENTRY_TYPE,
  acceptGoalTodoClaim,
  addGoalTodo,
  blockGoalTodo,
  completeGoalTodo,
  applyGoalRoomEventTodoReducer,
  applyTodoSplitRequest,
  createGoalTodoState,
  defaultGoalTodoPolicy,
  extractTodoClaimFromText,
  extractTodoClaimValidationFromText,
  extractTodoSplitRequestFromText,
  formatGoalTodoDiagnostics,
  formatGoalTodoHudLine,
  formatGoalTodoPromptHint,
  formatGoalTodoSummary,
  formatGoalTodoTree,
  goalTodoCompletionBlockers,
  goalTodoCompletionDiagnostics,
  handleGoalTodoTextCommand,
  nextValidGoalTodoActions,
  linkGoalTodoDelegation,
  patchGoalTodo,
  recordGoalTodoClaimValidationResult,
  reduceGoalRoomEventToTodoDecision,
  requestGoalTodoClaimValidation,
  rejectGoalTodoClaim,
  restoreGoalTodosFromBranch,
  returnGoalTodoClaim,
  resolveGoalTodo,
  splitGoalTodo,
  summarizeGoalTodos,
  validateGoalTodoGraph,
} from "./src/domains/goal/goal-todos.js";
export { GoalTodoTransitionError, assertCurrentGoalTodoClaimSettlementBinding, assertCurrentGoalTodoClaimValidationBinding, authorizeGoalTodoTransition, finalizeGoalTodoDelegationAttempt, isCanonicalGoalTodoClaimBinding, markGoalTodoDelegationFailed, recoverGoalTodoDelegation, updateGoalTodo } from "./src/domains/goal/goal-todos/operations.js";
export type { FinalizeGoalTodoDelegationAttemptInput, GoalTodoClaimBindingExpectation, GoalTodoTransitionAuthorization, RecoverGoalTodoDelegationInput } from "./src/domains/goal/goal-todos/operations.js";
export { assessDelegationAttemptLiveness } from "./src/runtime/delegation-monitor.js";
export {
  CANONICAL_GOAL_TODO_ID_PATTERN,
  VISIBLE_GOAL_TODO_PATH_PATTERN,
  GoalTodoReferenceResolutionError,
  adaptLegacyGoalTodoReference,
  goalTodoReferenceDiagnostic,
  resolveCanonicalGoalTodoReference,
  resolveCanonicalGoalTodoReferences,
  throwGoalTodoReferenceResolution,
} from "./src/domains/goal/goal-todos/reference.js";
export type {
  GoalTodoCanonicalReferenceInput,
  GoalTodoReferenceBatchResolution,
  GoalTodoReferenceCandidate,
  GoalTodoReferenceCode,
  GoalTodoReferenceDiagnostic,
  GoalTodoReferenceError,
  GoalTodoReferenceField,
  GoalTodoReferenceResolution,
  GoalTodoReferenceRetryPolicy,
  GoalTodoReferenceSafeNextAction,
} from "./src/domains/goal/goal-todo-types.js";
export type { GoalRoomTodoReducerAction, GoalRoomTodoReducerDecision, GoalTodoClaimRef, GoalTodoClaimValidationRef, GoalTodoCompletionDiagnostics, GoalTodoEvent, GoalTodoNode, GoalTodoOwner, GoalTodoPolicy, GoalTodoPriority, GoalTodoState, GoalTodoStatus, GoalTodoSummary, ResolveGoalTodoAction, TodoClaimValidationResult, TodoSplitRequest, TodoSplitRequestAction, TodoSplitRiskLevel } from "./src/domains/goal/goal-todos.js";
export {
  GOAL_TODO_STATUSES,
  GOAL_TODO_TRANSITION_ACTIONS,
  GOAL_TODO_TRANSITION_TABLE,
  decideGoalTodoTransition,
  getGoalTodoTransitionRule,
  listGoalTodoTransitionRules,
} from "./src/domains/goal/goal-todos/transition-engine.js";
export { GOAL_MUTATION_PHASE_CODES } from "./src/domains/goal/goal-todo-types.js";
export type {
  GoalMutationAppliedExecution,
  GoalMutationAppliedOutcome,
  GoalMutationApplyFailureMode,
  GoalMutationApplyResult,
  GoalMutationCanonicalRequest,
  GoalMutationCasInput,
  GoalMutationCasOutcome,
  GoalMutationConflictOutcome,
  GoalMutationCurrentRevisions,
  GoalMutationExecutionDiagnostic,
  GoalMutationExecutionInput,
  GoalMutationExecutionOutcome,
  GoalMutationFailedExecution,
  GoalMutationFailureCode,
  GoalMutationGuard,
  GoalMutationObservation,
  GoalMutationObservedExecution,
  GoalMutationPhase,
  GoalMutationPreparation,
  GoalMutationPreparationInput,
  GoalMutationPreparationPhase,
  GoalMutationProtocolRecord,
  GoalMutationPublicGuard,
  GoalMutationReceipt,
  GoalMutationReceiptDiagnostic,
  GoalMutationReceiptDiagnosticCode,
  GoalMutationReceiptInput,
  GoalMutationReceiptState,
  GoalMutationRejectedOutcome,
  GoalMutationReplayedExecution,
  GoalMutationReplayedOutcome,
  GoalMutationSideEffectRef,
  GoalMutationSideEffectState,
  GoalMutationStaleOutcome,
  GoalTodoClaimResolutionBinding,
  GoalTodoClaimValidationPolicy,
  GoalTodoDelegationAttempt,
  GoalTodoDelegationAttemptFailureKind,
  GoalTodoDelegationAttemptReasonCode,
  GoalTodoDelegationAttemptStatus,
  GoalTodoDelegationLiveness,
  GoalTodoDelegationLivenessAssessmentStatus,
  GoalTodoDelegationLivenessProof,
  GoalTodoDelegationLivenessProofCode,
  GoalTodoDelegationLivenessProofSource,
  GoalTodoDelegationRecovery,
  GoalTodoLegacyEvent,
  GoalTodoPatchClearField,
  GoalTodoRevisionDiagnostic,
  GoalTodoRevisionDiagnosticCode,
  GoalTodoRevisionEvent,
  GoalTodoTransitionAction,
  GoalTodoTransitionCode,
  GoalTodoTransitionContext,
  GoalTodoTransitionDecision,
  GoalTodoTransitionDiagnostic,
  GoalTodoTransitionGuard,
  GoalTodoTransitionInput,
  GoalTodoTransitionOperationContext,
  GoalTodoTransitionRetryPolicy,
  GoalTodoTransitionRule,
  GoalTodoTransitionRuleDiagnostic,
  GoalTodoTransitionTable,
} from "./src/domains/goal/goal-todo-types.js";
export {
  GOAL_MUTATION_ID_PATTERN,
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GOAL_MUTATION_PREPARATION_SCHEMA,
  GOAL_MUTATION_RECEIPT_ENTRY_TYPE,
  GOAL_MUTATION_RECEIPT_SCHEMA,
  blockGoalMutationReceiptState,
  canonicalGoalMutationJson,
  cloneGoalMutationReceipt,
  cloneGoalMutationReceiptState,
  createGoalMutationPreparation,
  createGoalMutationReceipt,
  createGoalMutationReceiptState,
  evaluateGoalMutationCas,
  finalizeGoalMutationReceiptRestore,
  hashGoalMutationRequest,
  indexGoalMutationPreparation,
  indexGoalMutationReceipt,
  indexGoalMutationReceiptEntry,
  isCanonicalGoalMutationId,
  isCanonicalGoalMutationRequestHash,
  markGoalMutationInDoubt,
  normalizeGoalMutationPreparation,
  normalizeGoalMutationReceipt,
  restoreGoalMutationReceiptsFromBranch,
} from "./src/domains/goal/mutation-cas.js";
export { GoalDelegationRecoveryGuardSchema, GoalMutationGuardProperties, GoalMutationGuardSchema, GoalTodoCanonicalReferenceProperties, GoalTodoCanonicalReferenceSchema, GoalTodoClaimHashSchema, parseOptionalGoalMutationGuard, parseRequiredGoalDelegationRecoveryGuard } from "./src/runtime/goal-runtime/schemas.js";
export { GOAL_MUTATION_TOOL_NAMES, isGoalMutationToolName } from "./src/runtime/goal-runtime/mutation-tools.js";
export type { GoalMutationToolName } from "./src/runtime/goal-runtime/mutation-tools.js";
export { buildGoalMutationCanonicalRequest, executeGoalMutationCas } from "./src/runtime/goal-runtime/mutation-cas.js";
export type { GoalMutationCanonicalRequestInput, GoalMutationCanonicalRequestResult } from "./src/runtime/goal-runtime/mutation-cas.js";
export { GOAL_HANDOFF_EFFECT_FLAGS, buildGoalHandoffCanonicalPayload, executeGoalHandoffCas } from "./src/runtime/goal-runtime/handoff.js";
export type { GoalHandoffCanonicalPayload, GoalHandoffCasExecution, GoalHandoffCasExecutionInput, GoalHandoffCasPreflight } from "./src/runtime/goal-runtime/handoff.js";
export { importChainRunTodos, importFactoryRunTodos, importOrchestrationRunTodos } from "./src/domains/goal/goal-todo-imports.js";
export type { GoalTodoImportResult } from "./src/domains/goal/goal-todo-imports.js";
export { appendGoalRoomMessage, buildGoalRoomMessage, goalRoomBodyFreeViolations, isGoalRoomMessage, listGoalRoomMessages, validateGoalRoomMessageInput, validateGoalRoomMessageRecord } from "./src/domains/goal/goal-room.js";
export type { GoalRoomAudience, GoalRoomListInput, GoalRoomMessageInput, GoalRoomMessageKind, GoalRoomPriority } from "./src/domains/goal/goal-room.js";
export { buildPromptPackReport, defaultFactoryAgentPromptPacks, promptPackBodyFreeViolations, validatePromptPack } from "./src/domains/delegation/prompt-packs.js";
export type { PromptPackContextPolicy, PromptPackDefinition, PromptPackEvalResult, PromptPackEventPolicy, PromptPackReport, PromptPackRole } from "./src/domains/delegation/prompt-packs.js";
export { buildFactorySelectorSmokeReport, detectFactoryDemandSignals, loadFactorySelectorCandidates, selectFactoryForDemands } from "./src/domains/factory/factory-selector.js";
export type { FactoryDemandInput, FactoryDemandSignal, FactorySelectionStatus, FactorySelectorCandidateInput, FactorySelectorCandidateScore, FactorySelectorDemandSummary, FactorySelectorResult, FactorySelectorSmokeReport } from "./src/domains/factory/factory-selector.js";
export { buildControlledWorkerPoolPlan, buildLaunchAuthorizedApplySmokeReport, evaluateLaunchAuthorizedApplyGate } from "./src/domains/governance/launch-apply.js";
export type { ApplyGateStatus, ControlledWorkerPoolLane, ControlledWorkerPoolPlan, LaunchAuthorizedApplyGate, LaunchAuthorizedApplyInput, LaunchAuthorizedApplySmokeReport, WorkerPoolLaneKind } from "./src/domains/governance/launch-apply.js";
export { writeFullAutonomyTestRun } from "./src/domains/autonomy/full-autonomy-test.js";
export type { FullAutonomyTestInput, FullAutonomyTestRun } from "./src/domains/autonomy/full-autonomy-test.js";
export {
  DEFAULT_INTERACTIVE_AUTONOMY_POLICY,
  INTERACTIVE_AUTONOMY_MODES,
  asInteractiveAutonomyMode,
  buildInteractiveLaunchAuthorization,
  createInteractiveAutonomyRuntimeState,
  formatInteractiveAutonomyPromptHint,
  formatInteractiveAutonomyStatus,
  formatMissionReadinessForUi,
  hashInteractiveAutonomyPolicy,
  readInteractiveAutonomyPolicy,
  restoreInteractiveAutonomyState,
  scoreMissionReadiness,
  toAutonomyStateLedgerEntry,
  toMissionReadinessLedgerEntry,
} from "./src/domains/autonomy/interactive-autonomy.js";
export type { InteractiveAutonomyLaunchPolicy, InteractiveAutonomyMode, InteractiveAutonomyPolicy, InteractiveAutonomyRuntimeState, InteractiveAutonomySafetyPolicy, InteractiveAutonomyThresholds, InteractiveLaunchAuthorization, MissionReadinessDecision, MissionReadinessReport, MissionReadinessSignals, MissionReadinessVerdict, MissionRiskLevel } from "./src/domains/autonomy/interactive-autonomy.js";
export { appendGovernedRequestsToGoalRoom, extractGovernedRequestsFromText, governedRequestBodyFreeViolations, isGovernedRequest, validateGovernedRequest } from "./src/domains/governance/governed-requests.js";
export type { GovernedRequestExtractionResult, GovernedRequestKind, GovernedRequestPriority, GovernedRequestRecord, GovernedRequestRisk } from "./src/domains/governance/governed-requests.js";
export { createWorkspaceClaim, isWorkspaceClaimRecord, isWorkspaceReleaseRecord, listWorkspaceClaims, releaseWorkspaceClaim, workspaceClaimBodyFreeViolations } from "./src/domains/governance/workspace-claims.js";
export type { WorkspaceClaimInput, WorkspaceClaimMode, WorkspaceClaimRecord, WorkspaceClaimsListInput, WorkspaceClaimStatus, WorkspaceConflictWarning, WorkspaceReleaseInput, WorkspaceReleaseRecord } from "./src/domains/governance/workspace-claims.js";
export { createWorkerPoolOwnerDecision, createWorkerPoolOwnerRequest, createWorkerPoolPlan, isWorkerPoolPlanRecord, listWorkerPoolPlans, workerPoolBodyFreeViolations } from "./src/domains/governance/worker-pool.js";
export type { WorkerPoolAssignmentInput, WorkerPoolAssignmentRecord, WorkerPoolCommunicationPolicyInput, WorkerPoolCommunicationPolicyMode, WorkerPoolCommunicationPolicyRecord, WorkerPoolConflictRecord, WorkerPoolDecision, WorkerPoolOwnerDecisionInput, WorkerPoolOwnerDecisionRecord, WorkerPoolOwnerRequestInput, WorkerPoolOwnerRequestRecord, WorkerPoolPlanInput, WorkerPoolPlanRecord, WorkerPoolStatusInput } from "./src/domains/governance/worker-pool.js";
export { decideMergeCandidate, isMergeCandidateRecord, isMergeDecisionRecord, listMergeQueue, mergeQueueBodyFreeViolations, submitMergeCandidate } from "./src/domains/governance/merge-queue.js";
export type { MergeCandidateInput, MergeCandidatePriority, MergeCandidateRecord, MergeCandidateRisk, MergeDecision, MergeDecisionInput, MergeDecisionRecord, MergeQueueListInput } from "./src/domains/governance/merge-queue.js";
export {
  GENERIC_WORKLIST_REDUCER_ID,
  buildDirective,
  evaluateEvidenceForDirective,
  genericWorklistReducer,
  listWorklistReducerIds,
  registerWorklistReducer,
  resolveWorklistReducer,
} from "./src/domains/worklist/reducer-contract.js";
export type { BuildDirectiveInput, WorklistReducer } from "./src/domains/worklist/reducer-contract.js";
// WS-EH1: the typed evidence pillar (canonical-evidence-model PART II). The
// EvidenceContract + registry + shapes + body-free validator. Backward compatible
// (WorklistDeps.evidence is now EvidenceInput with optional gates/deps).
export {
  emptyEvidenceInput,
  evidenceBodyFreeViolations,
  gateVerdictIsValid,
  listEvidenceContractIds,
  normalizeEvidenceInput,
  registerEvidenceContract,
  resolveEvidenceContract,
} from "./src/domains/worklist/evidence-contract.js";
export type {
  DepEntry,
  EvidenceContract,
  EvidenceInput,
  EvidenceKind,
  EvidenceVerdict,
  GateEntry,
  TaskView,
} from "./src/domains/worklist/evidence-contract.js";
export {
  FORBIDDEN_PLAINTEXT_KEYS,
  WORKLIST_DIRECTIVE_SCHEMA,
  WORKLIST_EVENT_SCHEMA,
  WORKLIST_LEASE_SCHEMA,
  WORKLIST_PROJECTION_SCHEMA,
  directiveHash,
} from "./src/domains/worklist/types.js";
export type {
  Directive,
  ProjectedDirective,
  WorklistDeps,
  WorklistEvent,
  WorklistEventInput,
  WorklistLease,
  WorklistLeaseStatus,
  WorklistProjection,
  WorklistValidation,
} from "./src/domains/worklist/types.js";
export {
  appendWorklistEvent,
  claimWorklistDirective,
  isWorklistEvent,
  isWorklistLease,
  listWorklistDirectives,
  listWorklistEvents,
  listWorklistLeases,
  openWorklistStore,
  projectWorklist,
  recoverStaleWorklistLeases,
  satisfyWorklistDirective,
  validateWorklist,
  worklistBodyFreeViolations,
} from "./src/domains/worklist/store.js";
export type { WorklistClaimOptions, WorklistStore, WorklistStoreOptions } from "./src/domains/worklist/store.js";
export {
  DEFAULT_RESEND_INTERVAL_MS,
  DIRECTIVE_DELIVERY_REASON_DIRECTIVE_SATISFIED,
  DIRECTIVE_DELIVERY_REASON_IN_FLIGHT,
  DIRECTIVE_DELIVERY_REASON_NEW,
  DIRECTIVE_DELIVERY_REASON_NO_HASH,
  DIRECTIVE_DELIVERY_REASON_REDELIVER,
  DIRECTIVE_DELIVERY_REASON_SEEN_ACTED,
  DIRECTIVE_READY_NOTIFICATION_SCHEMA,
  WORKLIST_DIRECTIVE_DELIVERY_ACTED_SCHEMA,
  WORKLIST_DIRECTIVE_DELIVERY_LEDGER_SCHEMA,
  deliverDirectiveNotification,
  deliverDirectives,
  listDeliveries,
  loadDirectiveDeliveryLedger,
  markDirectiveActed,
  markDirectiveDeliveredActed,
  planDirectiveDelivery,
  reconcileDirectiveLedger,
  recordDirectiveDelivery,
} from "./src/domains/worklist/delivery.js";
export type {
  DeliverDirectiveNotificationOptions,
  DirectiveDeliveryLedger,
  DirectiveDeliveryPlan,
  DirectiveDeliveryRecord,
  DirectiveDeliveryResult,
  DirectiveReadyNotification,
} from "./src/domains/worklist/delivery.js";
export {
  DECISION_TIMEOUT_DEFAULT_MS,
  ESCALATE_TO_HUMAN_DEFAULT_MS,
  ESCALATE_TO_LLM_DEFAULT_MS,
  ESCALATION_LEVEL_ACT_NOW,
  ESCALATION_LEVEL_AUTO,
  ESCALATION_LEVEL_HUMAN_BLOCK,
  ESCALATION_LEVEL_NUDGE_LLM,
  ESCALATION_LEVEL_WAIT,
  WATCHDOG_ESCALATION_SCHEMA,
  WATCHDOG_EVALUATION_SCHEMA,
  WATCHDOG_TICK_RESULT_SCHEMA,
  computeWatchdogEscalation,
  evaluateWorklistWatchdog,
  listWatchdogEscalations,
  runWorklistWatchdogTick,
} from "./src/domains/worklist/watchdog.js";
export type {
  WatchdogBudgets,
  WatchdogEscalation,
  WatchdogEscalationEntry,
  WatchdogEscalationEvent,
  WatchdogEvaluation,
  WatchdogTickDeps,
  WatchdogTickResult,
} from "./src/domains/worklist/watchdog.js";
export {
  DAG_STATUSES,
  WORKLIST_DAG_SCHEMA,
  WORKLIST_DAG_STATE_SCHEMA,
  buildDag,
  buildDagOrThrow,
  butterflySeedNext,
  computeDownstreamImpact,
  dagBodyFreeViolations,
  dagFingerprint,
  dependencySatisfied,
  detectCycle,
  isCrossScopeRef,
  nodeDepsSatisfied,
  parseCrossScopeRef,
  readyNodes,
  readDagState,
  resolveCrossScopeDependency,
  writeDagState,
} from "./src/domains/worklist/dag.js";
export type {
  CrossScopeResolver,
  DagBuildResult,
  DagGraph,
  DagNode,
  DagNodeInput,
  DagNodeStatus,
  DagState,
  DownstreamImpact,
} from "./src/domains/worklist/dag.js";
export { registerWorklistTools } from "./src/runtime/tools-worklist.js";
// WS-PH1 (environment-precondition PART II keystone): the typed EnvironmentContract
// pillar (the 4th pillar alongside computeWorklist/EvidenceContract). The contract
// shape + registry + PURE primitives (no node:fs/node:child_process); the body +
// snapshotEnvironment IO are project-registered (WS-PH4). Metadata-only / body-free
// / network-disabled: Precondition/PreconditionVerdict/EnvironmentSnapshot carry
// paths, counts, channel names, command strings only; FORBIDDEN_PLAINTEXT_KEYS
// applies (reused from the worklist domain).
export {
  commandPresent,
  dirEmpty,
  pathWritable,
  toolchainInstalled,
} from "./src/domains/environment/primitives.js";
export type {
  CommandPresentResult,
  DirEmptyResult,
  PathWritableResult,
  ToolchainInstalledResult,
} from "./src/domains/environment/primitives.js";
export {
  environmentBodyFreeViolations,
  listEnvironmentContractIds,
  registerEnvironmentContract,
  resolveEnvironmentContract,
} from "./src/domains/environment/environment-contract.js";
export type {
  EnvironmentContract,
  PreconditionScope,
} from "./src/domains/environment/environment-contract.js";
export type {
  CheckPhase,
  EnvironmentSnapshot,
  Precondition,
  PreconditionKind,
  PreconditionVerdict,
} from "./src/domains/environment/types.js";
// WS-PH2 (environment-precondition PART II): the launch-time gate primitive.
// runLaunchGate snapshots once, evaluates all check_phase:"launch" preconditions,
// returns { ok, verdicts, fix_packet, shouldStart } with shouldStart === ok BY
// CONSTRUCTION (fail-closed, no opt-out). Pure over (contract, snapshot); never
// starts anything itself (mechanism in harness, action in app). Idempotent +
// re-runnable (re-snapshots on re-call). Metadata-only / body-free / network-
// disabled. No node:fs/node:child_process (the purity grep returns nothing).
export { runLaunchGate } from "./src/domains/environment/launch-gate.js";
export type {
  FixPacketEntry,
  LaunchGateOptions,
  LaunchGateResult,
} from "./src/domains/environment/launch-gate.js";
// WS-PH3 (environment-precondition PART II — SAFETY-CRITICAL slice): the auto-resolve
// framework. applyAutoResolve applies ONLY allowlisted + REVERSIBLE strategies;
// REFUSES reversible:false ALWAYS (structurally unresolvable); SKIPS requires_network
// unless options.network===true; dispatches via PROJECT-REGISTERED
// ResolutionStrategyFn (the harness NEVER hardcodes a shell command); REFUSES
// missing-strategy + no-allowlist-match (fail-safe); DRY-RUN-FIRST (after_state:null,
// io.exec guarded). Incapable-by-construction of irreversible ops: the allowlist
// filter rejects reversible:false BEFORE dispatch. node:fs is used ONLY for the
// audit-log writer (appendFileSync); no node:child_process / direct spawn.
// Metadata-only / body-free / network-disabled (environmentBodyFreeViolations per entry).
export { AUTO_RESOLVE_AUDIT_SCHEMA, applyAutoResolve, registerResolutionStrategy } from "./src/domains/environment/auto-resolve.js";
export type {
  AutoResolveAllowlist,
  AutoResolveAuditEntry,
  AutoResolveEntry,
  AutoResolveIO,
  AutoResolveOptions,
  AutoResolveOutcome,
  AutoResolveResult,
  AutoResolveVerdict,
  ResolutionStrategyFn,
} from "./src/domains/environment/auto-resolve.js";
// WS-CH1 (capability-validation PART II keystone): the typed CapabilityContract
// pillar (the 5th pillar alongside computeWorklist/EvidenceContract/EnvironmentContract).
// The contract shape + registry + PURE primitives (no node:fs/node:child_process); the
// body + readManifest IO + the role->required-tools map are project-registered (WS-CH3).
// Metadata-only / body-free / network-disabled: AgentManifest/RoleRequirement/
// CapabilityVerdict carry agent ids, tool names, mode names, manifest paths, fixCommand
// strings only; FORBIDDEN_PLAINTEXT_KEYS applies (reused from the worklist domain).
// CRITICAL SAFETY: NO auto-resolve on the contract (manifest edit = security-sensitive =
// operator-gated, unlike Round 4 env auto-resolve).
export {
  buildFixPacket,
  compareCapability,
  manifestHasTool,
  modePermitsWrite,
  requiredToolsForRole,
} from "./src/domains/capability/primitives.js";
export type { CapabilityFixPacketEntry } from "./src/domains/capability/primitives.js";
export {
  capabilityBodyFreeViolations,
  listCapabilityContractIds,
  registerCapabilityContract,
  resolveCapabilityContract,
} from "./src/domains/capability/capability-contract.js";
export type { CapabilityContract } from "./src/domains/capability/capability-contract.js";
export type {
  AgentManifest,
  CapabilityVerdict,
  RoleName,
  RoleRequirement,
} from "./src/domains/capability/types.js";
// WS-CH2 (capability-validation PART II): the launch-time gate primitive + the
// runtime nudge-backoff/gap primitives. runCapabilityGate reads each manifest once
// (via the contract's readManifest), evaluates every agent against its role's
// requirement, returns { ok, verdicts, fix_packet, shouldStart } with
// shouldStart === ok BY CONSTRUCTION (fail-closed, no opt-out). Pure over
// (contract, agentIds); never starts anything itself (mechanism in harness, action
// in app). Idempotent + re-runnable (re-reads manifests on re-call). The nudge-
// policy primitives compose the supervisor anti-spam policy: planBackoffNudge
// (60s→2m→5m→15m cap + the structural capability_gap_stop), detectCapabilityGap
// (gates escalation — slow-but-capable stays gap===false), capabilityGapFixPacket
// (the metadata-only alert_no_ship fix packet), transitionOnCapabilityGap (forces
// the terminal capability_gap:true stop once gap===true). Metadata-only /
// body-free / network-disabled. No node:fs/node:child_process (the purity grep
// returns nothing). CRITICAL SAFETY: NO auto-resolve (manifest edit = security-
// sensitive = operator-gated, intentional divergence from Round 4 env auto-resolve).
export { runCapabilityGate } from "./src/domains/capability/launch-gate.js";
// NOTE: aliased as CapabilityLaunchGateOptions / CapabilityLaunchGateResult to
// avoid a name collision with the WS-PH2 environment pillar's identically-named
// LaunchGateOptions / LaunchGateResult exports above (index.ts ~L330). Both
// shapes exist; consumers pick the capability gate via the `Capability*` prefix.
export type {
  LaunchGateOptions as CapabilityLaunchGateOptions,
  LaunchGateResult as CapabilityLaunchGateResult,
} from "./src/domains/capability/launch-gate.js";
export {
  DEFAULT_NUDGE_SCHEDULE,
  NUDGE_BACKOFF_CAP_MS,
  capabilityGapFixPacket,
  detectCapabilityGap,
  planBackoffNudge,
  transitionOnCapabilityGap,
} from "./src/domains/capability/nudge-policy.js";
export type {
  CapabilityGapAction,
  CapabilityGapFixPacket,
  CapabilityGapTransition,
  DetectCapabilityGapInput,
  DriverRecord,
  GapResult,
  NudgePlan,
  NudgeSchedule,
  PlanBackoffNudgeInput,
} from "./src/domains/capability/nudge-policy.js";
export { DEFAULT_PROMOTION_GATES, advancePromotionCandidate, appendPromotionLedger, createPromotionCandidate, promotionCandidateDir, promotionCandidateRef, promotionReportsDir, summarizePromotionCandidates, transitionAllowed, validatePromotionCandidate, writePromotionCandidate } from "./src/domains/promotion/candidate.js";
export { addPromotionComsMessageRef, buildPromotionComsMessageRef, buildPromotionComsThread, validatePromotionComsMessageRef, validatePromotionComsReadiness, validatePromotionComsThread, writePromotionComsThread } from "./src/domains/promotion/coms.js";
export { applyDocumentationPromotionInQuarantine, prepareDocumentationPromotion, validateDocumentationPromotion, validateDocumentationPromotionCandidate } from "./src/domains/promotion/documentation.js";
export { activateFactoryPromotionInQuarantine, prepareFactoryPromotion, validateFactoryPromotionCandidate, validateFactoryPromotionManifest } from "./src/domains/promotion/factory.js";
export { applyTempAgentPromotionInQuarantine, prepareTempAgentPromotion, validateTempAgentCardForPromotion, validateTempAgentPromotionArtifact, validateTempAgentPromotionCandidate } from "./src/domains/promotion/temp-agent.js";
export { markWriteLaneAppliedInQuarantine, prepareWriteLanePromotion, validateWriteLaneDiffMetadata, validateWriteLanePromotionCandidate } from "./src/domains/promotion/write-lane.js";
export type { PromotionApplyScope, PromotionCandidateInput, PromotionCandidateRecord, PromotionComsMessageRef, PromotionComsThreadInput, PromotionComsThreadRecord, PromotionGates, PromotionKind, PromotionStatus, PromotionTransitionInput, PromotionValidationResult } from "./src/domains/promotion/types.js";

export {
  listRulePackPaths,
  loadRulePack,
  loadRulePacks,
  validateRulePack,
  inferRuleProfile,
  resolveRuleProfile,
  formatRuleResolution,
} from "./src/domains/governance/rules.js";

export {
  validateSixPartContract,
  parseToolList,
  validateToolList,
  resolveChildCwd,
  validateAllowedPathPolicy,
  validateForbiddenPathPolicy,
  validatePathPolicy,
  parsePathListEnv,
  validateRuntimeWritePolicy,
  validateDelegationWriteScope,
  validateDelegateTaskWriteScope,
  createSandboxMetadata,
  createDiffGateResult,
  createRollbackMetadata,
} from "./src/domains/governance/safety.js";

export {
  OUTPUT_GATE_ISSUE_CODES,
  listOutputContracts,
  getOutputContractDefinitions,
  getOutputContractFinalMarker,
  inferOutputContract,
  validateOutputContractId,
  validateOutputContract,
  validateOutputContractIssues,
  validateChildOutput,
  validateChildOutputIssues,
  applyChildGates,
} from "./src/domains/delegation/output-contracts.js";

export { createChildSessionPath } from "./src/domains/delegation/child-runner.js";

export { buildChildEnv } from "./src/domains/governance/safety.js";

export {
  DEFAULT_CONTENT_READ_BUDGET_BYTES,
  FILE_TOOL_PREFLIGHT_FIELDS,
  FILE_TOOL_PREFLIGHT_REASON_CODES,
  FILE_TOOL_PREFLIGHT_RETRY_POLICIES,
  FILE_TOOL_PREFLIGHT_SAFE_NEXT_ACTIONS,
  FILE_TOOL_PREFLIGHT_TOOLS,
  FILE_TOOL_PREFLIGHT_VERDICTS,
  createFileToolPreflightRuntimeState,
  fileToolPreflightBodyLikeFieldViolations,
  persistFileToolPreflightDecision,
  preflightFileToolCall,
  validateFileToolPreflightDecision,
  validateFileToolPreflightLedgerEntry,
} from "./src/domains/governance/file-tool-preflight.js";
export type {
  FileToolPreflightCall,
  FileToolPreflightDecision,
  FileToolPreflightField,
  FileToolPreflightIo,
  FileToolPreflightLedgerEntry,
  FileToolPreflightPolicy,
  FileToolPreflightReasonCode,
  FileToolPreflightRecordResult,
  FileToolPreflightRetryPolicy,
  FileToolPreflightRuntimeState,
  FileToolPreflightSafeNextAction,
  FileToolPreflightTool,
  FileToolPreflightVerdict,
} from "./src/domains/governance/file-tool-preflight.js";

export {
  FULL_READ_DEFAULT_IO,
  FULL_READ_DEFAULT_POLICY,
  FULL_READ_SCHEMA,
  classifyPathForbiddenGenerated,
  classifyPathSecret,
  evaluateFullRead,
  fullReadBodyFreeViolations,
  runFullRead,
} from "./src/domains/files/full-read.js";
export type {
  FullReadContextUsage,
  FullReadDecision,
  FullReadDetails,
  FullReadEncoding,
  FullReadEvaluation,
  FullReadFacts,
  FullReadIo,
  FullReadPolicy,
  FullReadReasonCode,
  FullReadRunInput,
  FullReadRunResult,
  FullReadStat,
} from "./src/domains/files/full-read.js";

export {
  DEFAULT_RUN_ARTIFACT,
  RESPONSE_RECEIVE_SCHEMA,
  RUN_ARTIFACT_DIRS,
  isPathSafeArtifactName,
  isPathSafeRunId,
  receiveFullResponse,
  resolveRunArtifact,
  responseReceiveBodyFreeViolations,
  runDirRelative,
} from "./src/domains/files/response-receive.js";
export type {
  ResponseReceiveDetails,
  ResponseReceiveInput,
  ResponseReceiveReasonCode,
  ResponseReceiveResult,
  ResponseReceiveRunType,
  ResponseReceiveSource,
  RunArtifactResolution,
} from "./src/domains/files/response-receive.js";

export {
  validateSandboxWritePlanInputs,
  runSandboxWritePlan,
  validateSandboxIsolatedExecutionInputs,
  runSandboxIsolatedExecution,
  validateSandboxDiffReviewGateInputs,
  runSandboxDiffReviewGate,
  validateSandboxApplyReadinessInputs,
  runSandboxApplyReadiness,
  validateSandboxApplySimulationInputs,
  runSandboxApplySimulation,
  validateSandboxManualApplyPreflightInputs,
  runSandboxManualApplyPreflight,
} from "./src/domains/governance/sandbox.js";

export {
  buildAutonomyReadinessAudit,
  writeAutonomyReadinessAuditReport,
  buildFactoryRegistryReadinessAudit,
  writeFactoryRegistryReadinessAuditReport,
} from "./src/domains/autonomy/autonomy-readiness.js";

export { validateBudgetPolicyConfig, evaluateStrictBudgetDispatchGate, buildBudgetReadinessAudit, writeBudgetReadinessAuditReport } from "./src/domains/governance/budget-policy.js";

export {
  evaluateBudgetPreflightDryRun,
  detectOracleFail,
  summarizeRunawayGuard,
  classifyChildStopCondition,
  classifyChronicleCompletion,
  classifyDelegationChronicleCompletion,
  classifyFactoryChronicleCompletion,
  writeChronicleSnapshot,
} from "./src/domains/telemetry/chronicle.js";

export {
  TOOL_FAILURE_CLASSES,
  TOOL_FAILURE_REASON_CODES,
  TOOL_FAILURE_TAXONOMY_REVISION,
  replayToolFailureAttempts,
  replayToolFailureFixtures,
  fileToolPreflightFingerprint,
  toolFailureBodyLikeFieldViolations,
  toolFailureIncidentKey,
  validateToolFailureReplayFixture,
} from "./src/domains/telemetry/tool-failures.js";

export { buildCapabilityIndex, buildReuseScoutReport, writeCapabilityIndex, writeReuseScoutReport } from "./src/domains/delegation/capabilities.js";

export { buildAutonomousRuntimeDryRun, buildAutonomousRuntimeDryRunFinalReport, buildAutonomousRuntimeDryRunValidation, validateAutonomousReadOnlySmokeRunArtifacts, validateAutonomousRuntimeDryRunArtifacts, writeAutonomousReadOnlySmokeRunReport, writeAutonomousRuntimeDryRunReport } from "./src/domains/autonomy/autonomous-runtime.js";
export type { AutonomousApplyPolicy, AutonomousBudgetProfile, AutonomousReadOnlySmokeRunInput, AutonomousRisk, AutonomousRuntimeDryRunInput } from "./src/domains/autonomy/autonomous-runtime.js";

export { buildDaemonReadinessDryRun, writeDaemonReadinessDryRunReport } from "./src/domains/autonomy/daemon-readiness.js";

export { validateDaemonPolicyConfig, buildDaemonPolicyReadinessAudit, writeDaemonPolicyReadinessAuditReport } from "./src/domains/autonomy/daemon-policy.js";

export { DEFAULT_DAEMON_RUNTIME_POLICY, DAEMON_RUNTIME_STATUSES, buildDaemonRuntimeState, buildDaemonTickPlan, evaluateDaemonStopCondition, selectNextActionableTodo } from "./src/domains/autonomy/daemon-runtime.js";
export type { DaemonLoopSnapshot, DaemonLoopStatus, DaemonRuntimeActionKind, DaemonRuntimeAutonomySnapshot, DaemonRuntimePolicy, DaemonRuntimeState, DaemonRuntimeStateInput, DaemonRuntimeStatus, DaemonRuntimeTodoCounts, DaemonRuntimeTodoRef, DaemonStopCondition, DaemonTickPlan } from "./src/domains/autonomy/daemon-runtime.js";

export {
  evaluateModelRoutingDryRun,
  evaluateModelRoutingDispatchGate,
  writeModelRoutingDryRunReport,
  validateModelRoutingConfig,
  buildModelRoutingReadinessAudit,
  writeModelRoutingReadinessAuditReport,
} from "./src/domains/models/model-routing.js";

export {
  buildComputePreview,
  resolveComputeProfile,
  validateComputeProfileArtifacts,
  writeComputeProfileReports,
} from "./src/domains/compute/compute-profile.js";
export type { ComputeCapsInput, ComputeDomain, ComputeEffectiveProfile, ComputePreviewConfidence, ComputePreviewInput, ComputeProfileValidationInput, ComputeRequestedProfile } from "./src/domains/compute/compute-profile.js";
export { buildComputeWorkflowShape, validateComputeWorkflowShape } from "./src/domains/compute/compute-workflow-shape.js";
export type { ComputeWorkflowShapeInput } from "./src/domains/compute/compute-workflow-shape.js";

export {
  buildProjectDnaFederatedQueryResult,
  buildProjectDnaQueryResult,
  buildProjectDnaReadinessAudit,
  writeProjectDnaWritebackProposal,
} from "./src/domains/project-dna/project-dna.js";
export type { ProjectDnaFederatedQueryInput, ProjectDnaQueryInput, ProjectDnaWritebackProposalInput } from "./src/domains/project-dna/project-dna.js";

export {
  buildDelegationTelemetrySummary,
  writeDelegationTelemetrySummary,
  buildFactoryTelemetrySummary,
  writeFactoryTelemetrySummary,
  buildDailyTelemetrySummary,
  writeDailyTelemetrySummary,
} from "./src/domains/telemetry/telemetry.js";

export {
  READ_ONLY_QUEUE_JOB_TYPES,
  getQueuePaths,
  ensureQueueDirs,
  validateReadOnlyQueueJob,
  writeQueueLifecycleEvent,
  runQueueDaemonTick,
  buildQueueDashboardSummary,
} from "./src/domains/telemetry/queue.js";

export { loadTeamDefinition, validateTeamDefinition } from "./src/domains/topology/teams.js";

export {
  listOrchestrationProfiles,
  loadOrchestrationProfile,
  validateOrchestrationProfile,
  teamDefinitionFromOrchestrationProfile,
  validateOrchestrateRunInputs,
} from "./src/domains/topology/orchestration-profiles.js";

export {
  listChainDefinitions,
  loadChainDefinition,
  validateChainDefinition,
  validateChainRunInputs,
  buildChainPlan,
  runChainPlanOnly,
} from "./src/domains/topology/chains.js";

export {
  validateZobComsEdge,
  buildZobComsMessage,
  validateZobComsMessage,
  appendZobComsMessage,
  listZobComsMessages,
  getZobComsMessage,
  ackZobComsMessage,
  transitionZobComsStatus,
  replyZobComsMessage,
  awaitZobComsMessage,
} from "./src/domains/topology/coms.js";

export {
  MISSION_CONTROL_COMMANDS,
  validateMissionControlCommandProposal,
  buildMissionControlCommandProposal,
  writeMissionControlCommandProposal,
  buildZobComsTransportReadiness,
  buildZobCommunicationReadinessAudit,
  buildMissionControlSnapshot,
} from "./src/domains/coms/mission-control.js";

export { readZobComsV2Policy, zobComsRegistryEnabled } from "./src/domains/coms/coms-v2/policy.js";
export { buildZobComsProjectId, buildCurrentZobLivePeerCard } from "./src/domains/coms/coms-v2/identity.js";
export { registerCurrentZobLivePeer, touchCurrentZobLivePeer, unregisterCurrentZobLivePeer, writeZobLivePeerCard, readZobLiveRegistrySnapshot } from "./src/domains/coms/coms-v2/registry.js";
export { buildZobLivePresenceSummary, redactZobLivePeerForMissionControl } from "./src/domains/coms/coms-v2/presence.js";
export { buildZobLiveEnvelope, buildZobLiveAckEnvelope, buildZobLivePongEnvelope, buildZobLiveErrorEnvelope, validateZobLiveEnvelope, parseZobLiveEnvelopeLine } from "./src/domains/coms/coms-v2/envelope.js";
export { makeZobLocalEndpoint, bindZobLocalEndpoint, sendZobLocalEnvelope, pingZobLocalEndpoint, pruneZobLocalEndpoint } from "./src/domains/coms/coms-v2/local-transport.js";
export { ZobPendingReplies } from "./src/domains/coms/coms-v2/pending-replies.js";
export { buildZobLiveResponseCapture, buildZobLiveResponseEnvelope } from "./src/domains/coms/coms-v2/response-capture.js";
export { appendLiveSendRequestedRef, appendLiveDeliveredStatus, appendLiveRunningStatus, appendLiveCompletedRef, appendLiveErrorStatus, appendPeerStaleStatus } from "./src/domains/coms/coms-v2/ledger-bridge.js";
export { redactZobComsText, writeZobComsRedactedCapture } from "./src/domains/coms/coms-v2/transcript-capture.js";
export { annotateZpeerStatus, isZpeerTerminalStatus, shouldAcceptZpeerStatusUpdate, zpeerStatusRank } from "./src/domains/coms/coms-v2/zpeer-status.js";
export type { ZobLiveEnvelope, ZobLiveEnvelopeType } from "./src/domains/coms/coms-v2/envelope.js";
export type { ZobComsTranscriptCapturePolicy, ZobComsTranscriptMode, ZobComsTranscriptRetentionClass, ZobComsTransportMode, ZobComsV2Policy, ZobLivePeerCard, ZobLivePeerStatus, ZobLivePresenceSummary, ZobLiveRegistrySnapshot } from "./src/domains/coms/coms-v2/types.js";

export {
  buildContextBrainSourceRegistry,
  buildDefaultContextScope,
  validateContextScope,
  buildBrainLookupResult,
  validateBrainLookupResult,
  buildContextPack,
  validateContextPack,
  buildContextWritebackProposal,
  validateContextWritebackProposal,
  writeContextWritebackProposal,
  buildContextGbrainReadinessAudit,
  writeContextGbrainReadinessAuditReport,
} from "./src/domains/context/context-gbrain.js";

export { readLatestOrchestrationWidgetSummary, readHarnessReadinessWidgetSummary } from "./src/domains/orchestration/widget-readers.js";

export {
  ADAPTIVE_DELEGATION_DEFAULT_MAX_TOTAL_AGENTS,
  ADAPTIVE_DELEGATION_HARD_MAX_DEPTH,
  ADAPTIVE_DELEGATION_HARD_MAX_TOTAL_AGENTS_WITH_ORACLE,
  buildInitialAdaptiveDelegationGovernorState,
  buildParentDispatchContractForDecision,
  computeAdaptiveDelegationDuplicateSignature,
  computeAdaptiveDelegationLineageHash,
  computeAdaptiveDelegationNormalizedTaskHash,
  computeAdaptiveDelegationRequestId,
  decideDelegationRequest,
  extractDelegationRequestsFromText,
  normalizeAdaptiveDelegationPolicy,
  scoreDelegationRequest,
  updateGovernorState,
  validateAdaptiveDelegationEvidenceRefs,
  validateAdaptiveDelegationPolicy,
  validateDelegationRequestHardGates,
} from "./src/domains/orchestration/adaptive-delegation.js";

export { extractLeadPlanWorkerContracts, redactLeadPlanWorkerContractsForPersistence, validateLeadPlanWorkerContracts } from "./src/domains/orchestration/lead-plan.js";

export { writeAdaptiveWorkflowArtifacts, validateAdaptiveWorkflowArtifacts } from "./src/domains/orchestration/adaptive-workflow.js";
export type { AdaptiveWorkflowArtifactsInput, AdaptiveWorkflowArtifactsResult } from "./src/domains/orchestration/adaptive-workflow.js";

export { writeOrchestrationRoomArtifacts } from "./src/domains/orchestration/room.js";

export { runOrchestrateRun } from "./src/domains/orchestration/run.js";

export { buildSupervisedReadonlyNoMockFinalGate, buildSupervisedReadonlyRuntimeInvariants, runSupervisedReadonlyOrchestration } from "./src/domains/orchestration/supervised-readonly.js";

export {
  factoryPhaseSentinelForMode,
  validateFactoryStages,
  loadFactoryDefinition,
  loadFactoryInputManifest,
  normalizeFactoryAdaptiveDispatchGate,
  validateFactoryAdaptiveDispatchGate,
  validateFactoryRunInputs,
} from "./src/domains/factory/validation.js";

export { buildFactoryAgenticPlan } from "./src/domains/factory/agentic-plan.js";

export { buildAgenticFactoryNoMockFinalGate, runFactoryRun } from "./src/domains/factory/run.js";

export {
  runFactoryQuarantineReview,
  runFactoryQuarantineActivate,
  runFactoryQuarantineVerifyActivation,
} from "./src/domains/factory/quarantine.js";

export default function zobHarness(pi: ExtensionAPI): void {
  zobHarnessRuntime(pi);
}
