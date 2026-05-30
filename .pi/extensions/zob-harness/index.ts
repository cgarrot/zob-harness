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

export { CHRONICLE_STATES } from "./src/chronicle.js";

export type { ChronicleState } from "./src/chronicle.js";

export type {
  ChildStopCondition,
  RuleAppliesTo,
  RuleEnforcementLevel,
  RuleOracleRequirement,
  RulePack,
  RuleResolution,
  RuleResolverInput,
} from "./src/types.js";

export { pathMatches } from "./src/utils/paths.js";

export { parseGoalState, validateGoalState, validateStrictGoalSpecAnchor, parseBillableJobIntake, validateBillableJobIntake } from "./src/goal.js";
export type { StrictGoalSpecAnchor, StrictGoalSpecAnchorKind } from "./src/goal.js";
export { DEFAULT_GOAL_ACTIVATION_MODE, clearRuntimeGoalContinuationState, clearRuntimeGoalContinuationStateFor, formatGoalActivationMode, formatRuntimeGoalSummary, queueRuntimeGoalContinuation, restoreRuntimeGoalFromBranch, resumeRuntimeGoal, runtimeGoalStatusLine } from "./src/goal-runtime.js";
export type { GoalActivationMode, RuntimeGoal, RuntimeGoalStatus, RuntimeGoalOracleStatus, RuntimeGoalOracleVerdict } from "./src/goal-runtime.js";
export { extractModeIntent, looksLikeCompletePlanResponse, stripModeIntentMarkup, validateModeIntent } from "./src/runtime/mode-intent.js";
export type { ZobModeIntent, ZobModeIntentConfidence, ZobModeIntentRisk, ZobModeIntentValidation } from "./src/runtime/mode-intent.js";
export { capturePlanArtifact, extractPlanTitle, shouldCapturePlanResponse } from "./src/runtime/plan-capture.js";
export type { PlanCaptureInput, PlanCaptureResult, PlanIndexEntry } from "./src/runtime/plan-capture.js";
export { ZOB_COMPACTION_CONTINUITY_CONTRACT, ZOB_TOOL_ROUTING_CONTRACT } from "./src/constants.js";
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
} from "./src/goal-todos.js";
export type { GoalRoomTodoReducerAction, GoalRoomTodoReducerDecision, GoalTodoClaimRef, GoalTodoClaimValidationRef, GoalTodoCompletionDiagnostics, GoalTodoNode, GoalTodoOwner, GoalTodoPolicy, GoalTodoPriority, GoalTodoState, GoalTodoStatus, GoalTodoSummary, ResolveGoalTodoAction, TodoClaimValidationResult, TodoSplitRequest, TodoSplitRequestAction, TodoSplitRiskLevel } from "./src/goal-todos.js";
export { importChainRunTodos, importFactoryRunTodos, importOrchestrationRunTodos } from "./src/goal-todo-imports.js";
export type { GoalTodoImportResult } from "./src/goal-todo-imports.js";
export { appendGoalRoomMessage, buildGoalRoomMessage, goalRoomBodyFreeViolations, isGoalRoomMessage, listGoalRoomMessages, validateGoalRoomMessageInput, validateGoalRoomMessageRecord } from "./src/goal-room.js";
export type { GoalRoomAudience, GoalRoomListInput, GoalRoomMessageInput, GoalRoomMessageKind, GoalRoomPriority } from "./src/goal-room.js";
export { buildPromptPackReport, defaultFactoryAgentPromptPacks, promptPackBodyFreeViolations, validatePromptPack } from "./src/prompt-packs.js";
export type { PromptPackContextPolicy, PromptPackDefinition, PromptPackEvalResult, PromptPackEventPolicy, PromptPackReport, PromptPackRole } from "./src/prompt-packs.js";
export { buildFactorySelectorSmokeReport, detectFactoryDemandSignals, loadFactorySelectorCandidates, selectFactoryForDemands } from "./src/factory-selector.js";
export type { FactoryDemandInput, FactoryDemandSignal, FactorySelectionStatus, FactorySelectorCandidateInput, FactorySelectorCandidateScore, FactorySelectorDemandSummary, FactorySelectorResult, FactorySelectorSmokeReport } from "./src/factory-selector.js";
export { buildControlledWorkerPoolPlan, buildLaunchAuthorizedApplySmokeReport, evaluateLaunchAuthorizedApplyGate } from "./src/launch-apply.js";
export type { ApplyGateStatus, ControlledWorkerPoolLane, ControlledWorkerPoolPlan, LaunchAuthorizedApplyGate, LaunchAuthorizedApplyInput, LaunchAuthorizedApplySmokeReport, WorkerPoolLaneKind } from "./src/launch-apply.js";
export { writeFullAutonomyTestRun } from "./src/full-autonomy-test.js";
export type { FullAutonomyTestInput, FullAutonomyTestRun } from "./src/full-autonomy-test.js";
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
} from "./src/interactive-autonomy.js";
export type { InteractiveAutonomyLaunchPolicy, InteractiveAutonomyMode, InteractiveAutonomyPolicy, InteractiveAutonomyRuntimeState, InteractiveAutonomySafetyPolicy, InteractiveAutonomyThresholds, InteractiveLaunchAuthorization, MissionReadinessDecision, MissionReadinessReport, MissionReadinessSignals, MissionReadinessVerdict, MissionRiskLevel } from "./src/interactive-autonomy.js";
export { appendGovernedRequestsToGoalRoom, extractGovernedRequestsFromText, governedRequestBodyFreeViolations, isGovernedRequest, validateGovernedRequest } from "./src/governed-requests.js";
export type { GovernedRequestExtractionResult, GovernedRequestKind, GovernedRequestPriority, GovernedRequestRecord, GovernedRequestRisk } from "./src/governed-requests.js";
export { createWorkspaceClaim, isWorkspaceClaimRecord, isWorkspaceReleaseRecord, listWorkspaceClaims, releaseWorkspaceClaim, workspaceClaimBodyFreeViolations } from "./src/workspace-claims.js";
export type { WorkspaceClaimInput, WorkspaceClaimMode, WorkspaceClaimRecord, WorkspaceClaimsListInput, WorkspaceClaimStatus, WorkspaceConflictWarning, WorkspaceReleaseInput, WorkspaceReleaseRecord } from "./src/workspace-claims.js";
export { decideMergeCandidate, isMergeCandidateRecord, isMergeDecisionRecord, listMergeQueue, mergeQueueBodyFreeViolations, submitMergeCandidate } from "./src/merge-queue.js";
export type { MergeCandidateInput, MergeCandidatePriority, MergeCandidateRecord, MergeCandidateRisk, MergeDecision, MergeDecisionInput, MergeDecisionRecord, MergeQueueListInput } from "./src/merge-queue.js";
export { DEFAULT_PROMOTION_GATES, advancePromotionCandidate, appendPromotionLedger, createPromotionCandidate, promotionCandidateDir, promotionCandidateRef, promotionReportsDir, summarizePromotionCandidates, transitionAllowed, validatePromotionCandidate, writePromotionCandidate } from "./src/promotion/candidate.js";
export { addPromotionComsMessageRef, buildPromotionComsMessageRef, buildPromotionComsThread, validatePromotionComsMessageRef, validatePromotionComsReadiness, validatePromotionComsThread, writePromotionComsThread } from "./src/promotion/coms.js";
export { applyDocumentationPromotionInQuarantine, prepareDocumentationPromotion, validateDocumentationPromotion, validateDocumentationPromotionCandidate } from "./src/promotion/documentation.js";
export { activateFactoryPromotionInQuarantine, prepareFactoryPromotion, validateFactoryPromotionCandidate, validateFactoryPromotionManifest } from "./src/promotion/factory.js";
export { applyTempAgentPromotionInQuarantine, prepareTempAgentPromotion, validateTempAgentCardForPromotion, validateTempAgentPromotionArtifact, validateTempAgentPromotionCandidate } from "./src/promotion/temp-agent.js";
export { markWriteLaneAppliedInQuarantine, prepareWriteLanePromotion, validateWriteLaneDiffMetadata, validateWriteLanePromotionCandidate } from "./src/promotion/write-lane.js";
export type { PromotionApplyScope, PromotionCandidateInput, PromotionCandidateRecord, PromotionComsMessageRef, PromotionComsThreadInput, PromotionComsThreadRecord, PromotionGates, PromotionKind, PromotionStatus, PromotionTransitionInput, PromotionValidationResult } from "./src/promotion/types.js";

export {
  listRulePackPaths,
  loadRulePack,
  loadRulePacks,
  validateRulePack,
  inferRuleProfile,
  resolveRuleProfile,
  formatRuleResolution,
} from "./src/rules.js";

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
} from "./src/safety.js";

export {
  listOutputContracts,
  getOutputContractDefinitions,
  inferOutputContract,
  validateOutputContractId,
  validateOutputContract,
  validateChildOutput,
  applyChildGates,
} from "./src/output-contracts.js";

export { buildChildEnv } from "./src/safety.js";

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
} from "./src/sandbox.js";

export {
  buildAutonomyReadinessAudit,
  writeAutonomyReadinessAuditReport,
  buildFactoryRegistryReadinessAudit,
  writeFactoryRegistryReadinessAuditReport,
} from "./src/autonomy-readiness.js";

export { validateBudgetPolicyConfig, evaluateStrictBudgetDispatchGate, buildBudgetReadinessAudit, writeBudgetReadinessAuditReport } from "./src/budget-policy.js";

export {
  evaluateBudgetPreflightDryRun,
  detectOracleFail,
  summarizeRunawayGuard,
  classifyChildStopCondition,
  classifyChronicleCompletion,
  classifyDelegationChronicleCompletion,
  classifyFactoryChronicleCompletion,
  writeChronicleSnapshot,
} from "./src/chronicle.js";

export { buildCapabilityIndex, buildReuseScoutReport, writeCapabilityIndex, writeReuseScoutReport } from "./src/capabilities.js";

export { buildAutonomousRuntimeDryRun, buildAutonomousRuntimeDryRunFinalReport, buildAutonomousRuntimeDryRunValidation, validateAutonomousReadOnlySmokeRunArtifacts, validateAutonomousRuntimeDryRunArtifacts, writeAutonomousReadOnlySmokeRunReport, writeAutonomousRuntimeDryRunReport } from "./src/autonomous-runtime.js";
export type { AutonomousApplyPolicy, AutonomousBudgetProfile, AutonomousReadOnlySmokeRunInput, AutonomousRisk, AutonomousRuntimeDryRunInput } from "./src/autonomous-runtime.js";

export { buildDaemonReadinessDryRun, writeDaemonReadinessDryRunReport } from "./src/daemon-readiness.js";

export { validateDaemonPolicyConfig, buildDaemonPolicyReadinessAudit, writeDaemonPolicyReadinessAuditReport } from "./src/daemon-policy.js";

export { DEFAULT_DAEMON_RUNTIME_POLICY, DAEMON_RUNTIME_STATUSES, buildDaemonRuntimeState, buildDaemonTickPlan, evaluateDaemonStopCondition, selectNextActionableTodo } from "./src/daemon-runtime.js";
export type { DaemonLoopSnapshot, DaemonLoopStatus, DaemonRuntimeActionKind, DaemonRuntimeAutonomySnapshot, DaemonRuntimePolicy, DaemonRuntimeState, DaemonRuntimeStateInput, DaemonRuntimeStatus, DaemonRuntimeTodoCounts, DaemonRuntimeTodoRef, DaemonStopCondition, DaemonTickPlan } from "./src/daemon-runtime.js";

export {
  evaluateModelRoutingDryRun,
  evaluateModelRoutingDispatchGate,
  writeModelRoutingDryRunReport,
  validateModelRoutingConfig,
  buildModelRoutingReadinessAudit,
  writeModelRoutingReadinessAuditReport,
} from "./src/model-routing.js";

export {
  buildComputePreview,
  resolveComputeProfile,
  validateComputeProfileArtifacts,
  writeComputeProfileReports,
} from "./src/compute-profile.js";
export type { ComputeCapsInput, ComputeDomain, ComputeEffectiveProfile, ComputePreviewConfidence, ComputePreviewInput, ComputeProfileValidationInput, ComputeRequestedProfile } from "./src/compute-profile.js";
export { buildComputeWorkflowShape, validateComputeWorkflowShape } from "./src/compute-workflow-shape.js";
export type { ComputeWorkflowShapeInput } from "./src/compute-workflow-shape.js";

export {
  buildProjectDnaFederatedQueryResult,
  buildProjectDnaQueryResult,
  buildProjectDnaReadinessAudit,
  writeProjectDnaWritebackProposal,
} from "./src/project-dna.js";
export type { ProjectDnaFederatedQueryInput, ProjectDnaQueryInput, ProjectDnaWritebackProposalInput } from "./src/project-dna.js";

export {
  buildDelegationTelemetrySummary,
  writeDelegationTelemetrySummary,
  buildFactoryTelemetrySummary,
  writeFactoryTelemetrySummary,
  buildDailyTelemetrySummary,
  writeDailyTelemetrySummary,
} from "./src/telemetry.js";

export {
  READ_ONLY_QUEUE_JOB_TYPES,
  getQueuePaths,
  ensureQueueDirs,
  validateReadOnlyQueueJob,
  writeQueueLifecycleEvent,
  runQueueDaemonTick,
  buildQueueDashboardSummary,
} from "./src/queue.js";

export { loadTeamDefinition, validateTeamDefinition } from "./src/topology/teams.js";

export {
  listOrchestrationProfiles,
  loadOrchestrationProfile,
  validateOrchestrationProfile,
  teamDefinitionFromOrchestrationProfile,
  validateOrchestrateRunInputs,
} from "./src/topology/orchestration-profiles.js";

export {
  listChainDefinitions,
  loadChainDefinition,
  validateChainDefinition,
  validateChainRunInputs,
  buildChainPlan,
  runChainPlanOnly,
} from "./src/topology/chains.js";

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
} from "./src/topology/coms.js";

export {
  MISSION_CONTROL_COMMANDS,
  validateMissionControlCommandProposal,
  buildMissionControlCommandProposal,
  writeMissionControlCommandProposal,
  buildZobComsTransportReadiness,
  buildZobCommunicationReadinessAudit,
  buildMissionControlSnapshot,
} from "./src/mission-control.js";

export { readZobComsV2Policy, zobComsRegistryEnabled } from "./src/coms-v2/policy.js";
export { buildZobComsProjectId, buildCurrentZobLivePeerCard } from "./src/coms-v2/identity.js";
export { registerCurrentZobLivePeer, touchCurrentZobLivePeer, unregisterCurrentZobLivePeer, writeZobLivePeerCard, readZobLiveRegistrySnapshot } from "./src/coms-v2/registry.js";
export { buildZobLivePresenceSummary, redactZobLivePeerForMissionControl } from "./src/coms-v2/presence.js";
export { buildZobLiveEnvelope, buildZobLiveAckEnvelope, buildZobLivePongEnvelope, buildZobLiveErrorEnvelope, validateZobLiveEnvelope, parseZobLiveEnvelopeLine } from "./src/coms-v2/envelope.js";
export { makeZobLocalEndpoint, bindZobLocalEndpoint, sendZobLocalEnvelope, pingZobLocalEndpoint, pruneZobLocalEndpoint } from "./src/coms-v2/local-transport.js";
export { ZobPendingReplies } from "./src/coms-v2/pending-replies.js";
export { buildZobLiveResponseCapture, buildZobLiveResponseEnvelope } from "./src/coms-v2/response-capture.js";
export { appendLiveSendRequestedRef, appendLiveDeliveredStatus, appendLiveRunningStatus, appendLiveCompletedRef, appendLiveErrorStatus, appendPeerStaleStatus } from "./src/coms-v2/ledger-bridge.js";
export { redactZobComsText, writeZobComsRedactedCapture } from "./src/coms-v2/transcript-capture.js";
export type { ZobLiveEnvelope, ZobLiveEnvelopeType } from "./src/coms-v2/envelope.js";
export type { ZobComsTranscriptCapturePolicy, ZobComsTranscriptMode, ZobComsTranscriptRetentionClass, ZobComsTransportMode, ZobComsV2Policy, ZobLivePeerCard, ZobLivePeerStatus, ZobLivePresenceSummary, ZobLiveRegistrySnapshot } from "./src/coms-v2/types.js";

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
} from "./src/context-gbrain.js";

export { readLatestOrchestrationWidgetSummary, readHarnessReadinessWidgetSummary } from "./src/orchestration/widget-readers.js";

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
} from "./src/orchestration/adaptive-delegation.js";

export { extractLeadPlanWorkerContracts, redactLeadPlanWorkerContractsForPersistence, validateLeadPlanWorkerContracts } from "./src/orchestration/lead-plan.js";

export { writeAdaptiveWorkflowArtifacts, validateAdaptiveWorkflowArtifacts } from "./src/orchestration/adaptive-workflow.js";
export type { AdaptiveWorkflowArtifactsInput, AdaptiveWorkflowArtifactsResult } from "./src/orchestration/adaptive-workflow.js";

export { writeOrchestrationRoomArtifacts } from "./src/orchestration/room.js";

export { runOrchestrateRun } from "./src/orchestration/run.js";

export { buildSupervisedReadonlyNoMockFinalGate, buildSupervisedReadonlyRuntimeInvariants, runSupervisedReadonlyOrchestration } from "./src/orchestration/supervised-readonly.js";

export {
  factoryPhaseSentinelForMode,
  validateFactoryStages,
  loadFactoryDefinition,
  loadFactoryInputManifest,
  normalizeFactoryAdaptiveDispatchGate,
  validateFactoryAdaptiveDispatchGate,
  validateFactoryRunInputs,
} from "./src/factory/validation.js";

export { buildFactoryAgenticPlan } from "./src/factory/agentic-plan.js";

export { buildAgenticFactoryNoMockFinalGate, runFactoryRun } from "./src/factory/run.js";

export {
  runFactoryQuarantineReview,
  runFactoryQuarantineActivate,
  runFactoryQuarantineVerifyActivation,
} from "./src/factory/quarantine.js";

export default function zobHarness(pi: ExtensionAPI): void {
  return zobHarnessRuntime(pi);
}
