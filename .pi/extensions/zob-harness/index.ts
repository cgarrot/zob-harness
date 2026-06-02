import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import zobHarnessRuntime from "./src/runtime/zobHarness.js";

export { renderHarnessWidget } from "./src/runtime/widget.js";
export { createHarnessRuntimeState, inferModeFromUserIntent } from "./src/runtime/state.js";

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
  RuleAppliesTo,
  RuleEnforcementLevel,
  RuleOracleRequirement,
  RulePack,
  RuleResolution,
  RuleResolverInput,
} from "./src/types.js";

export { pathMatches } from "./src/core/utils/paths.js";

export { parseGoalState, validateGoalState, validateStrictGoalSpecAnchor, parseBillableJobIntake, validateBillableJobIntake } from "./src/domains/goal/goal.js";
export type { StrictGoalSpecAnchor, StrictGoalSpecAnchorKind } from "./src/domains/goal/goal.js";
export { DEFAULT_GOAL_ACTIVATION_MODE, clearRuntimeGoalContinuationState, clearRuntimeGoalContinuationStateFor, formatGoalActivationMode, formatRuntimeGoalSummary, queueRuntimeGoalContinuation, restoreRuntimeGoalFromBranch, resumeRuntimeGoal, runtimeGoalStatusLine } from "./src/runtime/goal-runtime.js";
export type { GoalActivationMode, RuntimeGoal, RuntimeGoalStatus, RuntimeGoalOracleStatus, RuntimeGoalOracleVerdict } from "./src/runtime/goal-runtime.js";
export { extractModeIntent, looksLikeCompletePlanResponse, stripModeIntentMarkup, validateModeIntent } from "./src/runtime/mode-intent.js";
export type { ZobModeIntent, ZobModeIntentConfidence, ZobModeIntentRisk, ZobModeIntentValidation } from "./src/runtime/mode-intent.js";
export { capturePlanArtifact, extractPlanTitle, shouldCapturePlanResponse } from "./src/runtime/plan-capture.js";
export type { PlanCaptureInput, PlanCaptureResult, PlanIndexEntry } from "./src/runtime/plan-capture.js";
export { ZOB_COMPACTION_CONTINUITY_CONTRACT, ZOB_TOOL_ROUTING_CONTRACT } from "./src/core/constants.js";
export { ZOB_COMPACTION_DETAILS_SCHEMA, ZOB_COMPACTION_ENTRY_TYPE, ZOB_COMPACTION_HARD_CAP_TOKENS, ZOB_COMPACTION_LEDGER_SCHEMA, ZOB_COMPACTION_SUMMARY_SCHEMA, ZOB_COMPACTION_TARGET_TOKENS, buildDeterministicZobCompactionResult, buildDeterministicZobCompactionSummary, buildZobCompactionDetails, buildZobCompactionInstructions, buildZobCompactionLedgerEntry, buildZobCompactionStateCapsule, withZobCompactionDetails, zobCompactionBodyFreeViolations } from "./src/runtime/compaction-policy.js";
export type { ZobCompactionDetails, ZobCompactionFileRefsInput, ZobCompactionInstructionInput, ZobCompactionLedgerEntry, ZobCompactionStateCapsule } from "./src/runtime/compaction-policy.js";
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
export type { GoalRoomTodoReducerAction, GoalRoomTodoReducerDecision, GoalTodoClaimRef, GoalTodoClaimValidationRef, GoalTodoCompletionDiagnostics, GoalTodoNode, GoalTodoOwner, GoalTodoPolicy, GoalTodoPriority, GoalTodoState, GoalTodoStatus, GoalTodoSummary, ResolveGoalTodoAction, TodoClaimValidationResult, TodoSplitRequest, TodoSplitRequestAction, TodoSplitRiskLevel } from "./src/domains/goal/goal-todos.js";
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
  listOutputContracts,
  getOutputContractDefinitions,
  inferOutputContract,
  validateOutputContractId,
  validateOutputContract,
  validateChildOutput,
  applyChildGates,
} from "./src/domains/delegation/output-contracts.js";

export { buildChildEnv } from "./src/domains/governance/safety.js";

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
  return zobHarnessRuntime(pi);
}
