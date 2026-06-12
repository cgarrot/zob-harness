import type { ChildChangedPathRef, ModeName } from "./core/types/core.js";

export type {
  AgentScope,
  AssistantLikeMessage,
  ChildChangedPathRef,
  ChildThinkingLevel,
  HarnessAgent,
  JsonEvent,
  ModeName,
  TextBlock,
} from "./core/types/core.js";

export interface DamageRule {
  pattern: string;
  reason: string;
  ask?: boolean;
}

export interface DamageRules {
  bashToolPatterns: DamageRule[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
  noDeletePaths: string[];
}

export type RuleEnforcementLevel = "advisory" | "warn" | "preflight_fail" | "block" | "no_ship" | "human_approval";
export type RuleOracleRequirement = boolean | "conditional";

export interface RuleAppliesTo {
  paths?: string[];
  modes?: ModeName[];
  task_types?: string[];
  profiles?: string[];
}

export interface RulePack {
  schema: "zob.rule-pack.v1";
  id: string;
  description: string;
  applies_to: RuleAppliesTo;
  must_do: string[];
  must_not_do: string[];
  allowed_tools?: string[];
  required_validation: string[];
  oracle_required: RuleOracleRequirement;
  no_ship_conditions: string[];
  enforcement: RuleEnforcementLevel;
  sourcePath?: string;
}

export interface RuleResolverInput {
  repoRoot: string;
  mode?: ModeName;
  paths?: string[];
  taskText?: string;
  profile?: string;
}

export interface RuleResolution {
  schema: "zob.rule-resolution.v1";
  profile: string;
  rulePacks: string[];
  allowedTools: string[];
  requiredValidation: string[];
  oracleRequired: RuleOracleRequirement;
  noShipConditions: string[];
  mustDo: string[];
  mustNotDo: string[];
  enforcement: RuleEnforcementLevel[];
  errors: string[];
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export type DelegationFailureKind = "preflight" | "config" | "output_gate" | "child_runtime" | "aborted";

export interface ChildResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  cwd?: string;
  model?: string;
  sessionPath?: string;
  ledgerRunId?: string;
  outputContract?: string;
  contractErrors?: string[];
  gateErrors?: string[];
  gatePassed?: boolean;
  failureKind?: DelegationFailureKind;
  stopReason?: string;
  stopCondition?: ChildStopCondition;
  errorMessage?: string;
  childChangedPaths?: ChildChangedPathRef[];
  usage: {
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
  };
}

export interface DelegationDetails {
  mode: "single" | "parallel" | "chain";
  results: ChildResult[];
  agents: string[];
}

export interface GoalState {
  originalUserAsk: string;
  activeGoal: string;
  constraints: string;
  expectedOutput: string;
  validationEvidence: string;
  setAt: string;
}

export interface BudgetSidecar {
  mode: "advisory";
  advisory: true;
  budgetEnforced: false;
  strictRequested: boolean;
  strictEnabled: false;
  raw?: string;
  maxCostUsd?: number;
  maxRuns?: number;
  maxDurationMs?: number;
  maxParallelChildren?: number;
}

export interface BillableJobIntake {
  schema: "zob.billable-job-intake.v1";
  goal: GoalState;
  budget?: BudgetSidecar;
  budgetEnforced: false;
  parsedAt: string;
}

export interface OutputRequirement {
  name: string;
  pattern: string;
  message: string;
}

export interface OutputContract {
  id: string;
  description: string;
  agentNames: string[];
  required: OutputRequirement[];
}

export interface FactoryStage {
  name: string;
  type: "map" | "reduce" | "validate";
  agent: string;
  outputContract: string;
  requiredTools: string[];
  promptTemplate: string;
  expectedOutcome?: string;
  mustDo?: string[];
  mustNotDo?: string[];
  context?: string;
}

export interface FactoryDefinition {
  name: string;
  version: string;
  description: string;
  defaultMode?: "smoke" | "pilot" | "batch";
  expectedArtifacts?: string[];
  requiredStages?: string[];
  stages?: FactoryStage[];
}

export interface FactoryManifestItem {
  id: string;
  path: string;
  metadata?: Record<string, unknown>;
}

export interface FactoryInputManifest {
  factory: string;
  description?: string;
  items: FactoryManifestItem[];
  expectedArtifacts?: string[];
}

export type FactoryExecutionMode = "deterministic" | "plan_only" | "agentic";

export interface FactoryOracleGate {
  verdict?: "PASS" | "FAIL" | "WARN";
  no_ship?: boolean;
  evidence?: string;
  reviewer?: string;
}

export interface FactoryOracleReview {
  schema?: string;
  verdict?: "PASS" | "FAIL" | "WARN";
  no_ship?: boolean;
  evidence?: string;
  reviewer?: string;
  reviewedRunId?: string;
}

export interface FactoryRunBudgetInput extends BudgetPreflightDryRunCaps {
  strictEnabled?: boolean;
  strictRequested?: boolean;
  estimatedCostUsd?: number;
  estimatedRuns?: number;
  estimatedDurationMs?: number;
  estimatedParallelChildren?: number;
}

export type ComputeProfileName = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ComputeCapsInput {
  maxAgents?: number;
  maxDelegationDepth?: number;
  maxParallel?: number;
  maxIterations?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
  maxContextTokens?: number;
  strictBudgetRequired?: boolean;
  oracleRequired?: boolean;
}

export interface FactoryRunModelRoutingInput {
  enabled?: boolean;
  modelByClass?: Record<string, string>;
  risk?: "low" | "medium" | "high" | string;
  contextTokens?: number;
}

export interface FactoryAdaptiveDispatchGateInput {
  enabled?: boolean;
  liveReadOnlyProofEnabled?: boolean;
  proofRunId?: string;
  proofReviewHash?: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalId?: string;
  scope?: string;
}

export interface FactoryAdaptiveDispatchGate {
  schema: "zob.factory-adaptive-dispatch-gate.v1";
  enabled: boolean;
  liveReadOnlyProofEnabled: boolean;
  proofRunIdHash?: string;
  proofReviewHash?: string;
  approvedByHash?: string;
  approvedAt?: string;
  approvalIdHash?: string;
  scopeHash?: string;
  liveFactoryAdaptiveDispatchEnabled: boolean;
  parentOwnedDispatch: true;
  childDirectDispatch: false;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export type AdaptiveDelegationMode = "off" | "advisory_only" | "when_pertinent";
export type AdaptiveDelegationOracleMode = "off" | "conditional" | "always";
export type AdaptiveDelegationRisk = "low" | "medium" | "high";

export interface AdaptiveDelegationSandboxGateInput {
  enabled?: boolean;
  mode?: "off" | "proposal_only";
  sandboxRunId?: string;
  diffReviewGateHash?: string;
  applyReadinessHash?: string;
  approvalHash?: string;
}

export interface AdaptiveDelegationSandboxGate {
  schema: "zob.adaptive-delegation-sandbox-gate.v1";
  enabled: boolean;
  mode: "off" | "proposal_only";
  sandboxRunIdHash?: string;
  diffReviewGateHash?: string;
  applyReadinessHash?: string;
  approvalHash?: string;
  liveWriteDispatchEnabled: false;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface AdaptiveDelegationScaleApprovalInput {
  approvedBy?: string;
  approvedAt?: string;
  approvalId?: string;
  scope?: string;
}

export interface AdaptiveDelegationScaleApproval {
  schema: "zob.adaptive-delegation-scale-approval.v1";
  approvedByHash?: string;
  approvedAt?: string;
  approvalIdHash?: string;
  scopeHash?: string;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface AdaptiveDelegationPolicyInput {
  enabled?: boolean;
  mode?: AdaptiveDelegationMode;
  dispatch?: boolean;
  recordDecisionsOnly?: boolean;
  configuredMaxDepth?: number;
  runtimeMaxDepth?: number;
  rootFanoutMax?: number;
  nodeFanoutMax?: number;
  globalParallelMax?: number;
  maxTotalAgents?: number;
  maxTotalAgentsWithOracle?: number;
  ttlPerRequest?: number;
  minApprovalScore?: number;
  oracle?: AdaptiveDelegationOracleMode;
  strictBudgetRequired?: boolean;
  sandboxGate?: AdaptiveDelegationSandboxGateInput;
  scaleApproval?: AdaptiveDelegationScaleApprovalInput;
}

export interface AdaptiveDelegationPolicy {
  schema: "zob.adaptive-delegation-policy.v1";
  enabled: boolean;
  mode: AdaptiveDelegationMode;
  dispatch: boolean;
  recordDecisionsOnly: boolean;
  configuredMaxDepth: number;
  runtimeMaxDepth: number;
  rootFanoutMax: number;
  nodeFanoutMax: number;
  globalParallelMax: number;
  maxTotalAgents: number;
  maxTotalAgentsWithOracle: number;
  ttlPerRequest: number;
  minApprovalScore: number;
  oracle: AdaptiveDelegationOracleMode;
  strictBudgetRequired: boolean;
  sandboxGate?: AdaptiveDelegationSandboxGate;
  scaleApproval?: AdaptiveDelegationScaleApproval;
  parentOwnedDispatch: true;
  childDirectDispatch: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface DelegationRequestProposal {
  schema: "zob.delegation-request.v1";
  requesterRole: string;
  referentRole: string;
  requestedAgent: string;
  requestedOutputContract: string;
  requiredTools: string[];
  requesterDepth: number;
  targetDepth: number;
  ttlRequested?: number;
  evidenceRefs: string[];
  targetFileSet?: string[];
  estimatedTokensIfAlone?: number;
  estimatedTokensWithDelegation?: number;
  estimatedCostUsd?: number;
  estimatedDurationMs?: number;
  estimatedSuccessIfAlone?: number;
  estimatedSuccessWithDelegation?: number;
  risk: AdaptiveDelegationRisk;
  proposedTaskHash?: string;
  proposedContextHash?: string;
  rationaleHash?: string;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface DelegationScore {
  schema: "zob.delegation-score.v1";
  relevance: number;
  evidenceQuality: number;
  costBenefit: number;
  safety: number;
  novelty: number;
  urgency: number;
  total: number;
  decisionHint: "approve" | "deny" | "defer" | "oracle_required";
  reasons: string[];
}

export interface GovernorDecision {
  schema: "zob.governor-decision.v1";
  parentAssignedRequestId: string;
  parentComputedLineageHash: string;
  parentComputedNormalizedTaskHash: string;
  requesterRole: string;
  referentRole: string;
  requesterDepth: number;
  targetDepth: number;
  ttlRemaining: number;
  hardGateStatus: "passed" | "blocked";
  hardGateErrors: string[];
  score?: DelegationScore;
  status: "approved" | "denied" | "deferred" | "oracle_required" | "blocked";
  dispatchAllowed: boolean;
  noShip: boolean;
  reasons: string[];
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface ParentDispatchContract {
  schema: "zob.parent-dispatch-contract.v1";
  requestId: string;
  runId: string;
  parentTaskId: string;
  agent: string;
  taskHash: string;
  contextHash?: string;
  rationaleHash?: string;
  outputContract: string;
  requiredTools: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  requesterDepth: number;
  targetDepth: number;
  referentRole: string;
  dispatcher: "parent";
  status?: "queued_not_dispatched" | "dispatching" | "completed" | "failed" | "blocked";
  dispatchGate?: string;
  liveDispatched?: boolean;
  mocked?: boolean;
  dispatcherKind?: string;
  outputHash?: string | null;
  outputContractValidated?: boolean;
  bodyStored: false;
  promptBodiesStored?: false;
  outputBodiesStored?: false;
}

export interface AdaptiveDelegationGovernorState {
  schema: "zob.adaptive-delegation-governor-state.v1";
  runId: string;
  rootGoalHash: string;
  policyHash: string;
  totalRequested: number;
  totalApproved: number;
  totalDispatched: number;
  totalDenied: number;
  totalDeferred: number;
  totalOracleRequired: number;
  maxDepthObserved: number;
  fanoutByRequester: Record<string, number>;
  requestIds: string[];
  lineageHashes: string[];
  paused: boolean;
  stopped: boolean;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface FactoryRunInput {
  factory: string;
  input_manifest: string;
  run_id?: string;
  mode?: "smoke" | "pilot" | "batch";
  max_items?: number;
  resume?: boolean;
  execution?: FactoryExecutionMode;
  model?: string;
  prerequisite_smoke_run_id?: string;
  prerequisite_pilot_run_id?: string;
  oracle_review_path?: string;
  batch_concurrency?: number;
  budget?: FactoryRunBudgetInput;
  compute_profile?: ComputeProfileName;
  compute_caps?: ComputeCapsInput;
  model_routing?: FactoryRunModelRoutingInput;
  adaptive_factory_dispatch_gate?: FactoryAdaptiveDispatchGateInput;
  oracle_gate?: FactoryOracleGate;
  adaptive_delegation?: AdaptiveDelegationPolicyInput;
}

export interface FactoryRunResult {
  runId: string;
  runDir: string;
  status: "done" | "planned" | "failed_preflight" | "failed_validation" | "agentic_failed";
  processed: number;
  failed: number;
  artifacts: string[];
  errors: string[];
}

export interface FactoryQuarantineReviewInput {
  run_id: string;
  generated_factory: string;
  review_id?: string;
  oracle_verdict?: "PASS" | "FAIL" | "WARN";
  approval?: {
    approvedBy?: string;
    approvedAt?: string;
    approvalId?: string;
  };
}

export interface FactoryQuarantineReviewResult {
  runId: string;
  reviewId: string;
  reviewDir: string;
  status: "review_required" | "ready_for_manual_activation";
  activationReady: boolean;
  activationPerformed: false;
  generatedFactoryRegistered: boolean;
  localChecksPassed: boolean;
  oraclePassed: boolean;
  approvalPresent: boolean;
  artifacts: string[];
  errors: string[];
}

export interface FactoryQuarantineActivateInput {
  run_id: string;
  generated_factory: string;
  review_id: string;
  confirmation_phrase: string;
  activation_id?: string;
}

export interface FactoryQuarantineActivateResult {
  runId: string;
  reviewId: string;
  activationId: string;
  generatedFactory: string;
  status: "activated" | "failed_preflight";
  activationPerformed: boolean;
  confirmationMatched: boolean;
  targetDir: string;
  journalPath: string;
  copiedFiles: string[];
  errors: string[];
}

export interface FactoryQuarantineVerifyActivationInput {
  run_id: string;
  generated_factory: string;
  activation_id: string;
  verification_id?: string;
}

export interface FactoryQuarantineVerifyActivationResult {
  runId: string;
  activationId: string;
  verificationId: string;
  generatedFactory: string;
  status: "verified" | "failed_preflight" | "failed_verification";
  verificationDir: string;
  journalPath: string;
  factoryRunId: string;
  factoryRunDir: string;
  artifacts: string[];
  errors: string[];
}

export type OrchestrateExecutionMode = "plan_only" | "supervised_smoke" | "supervised_readonly";
export type ChainExecutionMode = "plan_only";

export interface TeamRoleBase {
  id: string;
  agent: string;
  description?: string;
  requiredTools: string[];
  outputContract: string;
  model?: string;
  responsibilities?: string[];
}

export interface TeamLead extends TeamRoleBase {
  workerIds?: string[];
}

export interface TeamWorker extends TeamRoleBase {
  leadId: string;
  taskTemplate?: string;
}

export interface TeamDefinition {
  name: string;
  version: string;
  description: string;
  orchestrator: TeamRoleBase;
  leads: TeamLead[];
  workers: TeamWorker[];
}

export interface OrchestrationModelClass {
  description?: string;
  defaultModel?: string;
  thinking?: string;
  downgradeAllowed?: boolean;
}

export interface OrchestrationProfileRole {
  id: string;
  roleType: "orchestrator" | "lead" | "worker" | "validator" | string;
  agent: string;
  modelClass?: string;
  leadId?: string;
  canDelegateTo?: string[];
  requiredTools?: string[];
  tools?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  outputContract: string;
  rules?: string[];
}

export interface OrchestrationProfilePhase {
  id: string;
  type: string;
  run?: string[];
  required?: boolean;
  requiresOutputContract?: string;
  modelClassOverride?: string;
  noShipOnFail?: boolean;
}

export interface OrchestrationProfileDefinition {
  schema?: string;
  name: string;
  version: string;
  description?: string;
  goalPolicy?: string;
  modelPolicy?: { classes?: Record<string, OrchestrationModelClass> };
  orchestrator: OrchestrationProfileRole;
  roles: OrchestrationProfileRole[];
  edges: Array<[string, string]>;
  phases: OrchestrationProfilePhase[];
  finalReportRole?: string;
  completionGate?: Record<string, unknown>;
}

export interface OrchestrateRunInput {
  team?: string;
  profile?: string;
  goal: string;
  original_user_ask?: string;
  goal_id?: string;
  todo_id?: string;
  run_id?: string;
  execution?: OrchestrateExecutionMode;
  resume?: boolean;
  max_workers?: number;
  compute_profile?: ComputeProfileName;
  compute_caps?: ComputeCapsInput;
  adaptive_delegation?: AdaptiveDelegationPolicyInput;
}

export interface OrchestrateRunResult {
  runId: string;
  runDir: string;
  status: "planned" | "failed_preflight";
  tasks: number;
  artifacts: string[];
  errors: string[];
}

export interface SupervisedReadonlyDispatchContract {
  runId: string;
  msgId: string;
  taskId: string;
  workerId: string;
  leadId: string;
  agent: string;
  task: string;
  expectedOutcome: string;
  requiredTools: string[];
  outputContract: string;
  mustDo: string[];
  mustNotDo: string[];
  context: string;
  allowedTools: string[];
}

export interface SupervisedReadonlyDispatchResult {
  status?: "completed" | "failed";
  outputHash?: string;
  output?: string;
  error?: string;
  dispatcher?: "external_mockable_boundary" | "live_child_pi" | string;
  mocked?: boolean;
  sessionPath?: string;
  outputContractValidated?: boolean;
  gatePassed?: boolean;
}

export type SupervisedReadonlyDispatcher = (contract: SupervisedReadonlyDispatchContract) => SupervisedReadonlyDispatchResult | Promise<SupervisedReadonlyDispatchResult>;

export interface ChainStepDefinition {
  id: string;
  agent: string;
  task: string;
  expectedOutcome: string;
  requiredTools: string[];
  outputContract: string;
  mustDo: string[];
  mustNotDo: string[];
  context: string;
}

export interface ChainDefinition {
  name: string;
  version: string;
  description: string;
  readOnly?: boolean;
  defaultExecution?: ChainExecutionMode;
  steps: ChainStepDefinition[];
}

export interface ChainRunInput {
  chain: string;
  goal: string;
  original_user_ask?: string;
  run_id?: string;
  execution?: ChainExecutionMode;
  resume?: boolean;
}

export interface ChainRunResult {
  runId: string;
  runDir: string;
  status: "planned" | "failed_preflight";
  chain?: string;
  steps: number;
  artifacts: string[];
  errors: string[];
}

export type ZobComsBodyPolicy = "hash_only" | "redacted";

export interface ZobComsMessageInput {
  runId: string;
  sender: string;
  receiver: string;
  kind?: string;
  taskId?: string;
  parentId?: string;
  taskHash?: string;
  outputHash?: string | null;
  status?: string;
  ack?: string;
  metadata?: Record<string, unknown>;
  body?: string;
  bodyPolicy?: ZobComsBodyPolicy;
}

export interface DelegationTelemetryInput {
  runId: string;
  source: "delegate_agent" | "delegate_task";
  mode: ModeName;
  agent: string;
  model?: string;
  cwd?: string;
  tools: string[];
  taskHash?: string;
  outputHash?: string;
  outputContract?: string;
  status: string;
  gatePassed?: boolean;
  gateErrors?: string[];
  failureKind?: DelegationFailureKind;
  assistantTurnSeen?: boolean;
  outputCaptured?: boolean;
  outputValidated?: boolean;
  evidenceChecked?: boolean;
  stopCondition?: ChildStopCondition;
  usage?: ChildResult["usage"];
  latencyMs: number;
  startedAt: string;
  endedAt: string;
  sessionPath?: string;
}

export interface FactoryTelemetryInput {
  runId: string;
  runDir?: string;
  factory: string;
  mode: string;
  execution: FactoryExecutionMode;
  status: string;
  itemCount: number;
  processed: number;
  failed: number;
  expectedArtifacts: string[];
  generatedArtifacts: string[];
  stageCount: number;
  agenticTasks: number;
  failuresByStage: Record<string, number>;
  retryCount: number;
  usage?: ChildResult["usage"];
  wallTimeMs: number;
  startedAt: string;
  endedAt: string;
  errors?: string[];
  budgetEnforced?: boolean;
  modelRouterUsed?: boolean;
}

export interface BudgetPreflightDryRunCaps {
  maxCostUsd?: number;
  maxRuns?: number;
  maxDurationMs?: number;
  maxParallelChildren?: number;
}

export interface BudgetPreflightDryRunInput {
  costUsd?: number;
  runs?: number;
  durationMs?: number;
  parallelChildren?: number;
  caps?: BudgetPreflightDryRunCaps;
  strictRequested?: boolean;
}

export interface ChildStopConditionInput {
  status?: string;
  agent?: string;
  outputContract?: string;
  output?: string;
  assistantTurnSeen?: boolean;
  outputHash?: string;
  outputCaptured?: boolean;
  outputValidated?: boolean;
  evidenceChecked?: boolean;
  timedOut?: boolean;
  blocked?: boolean;
  scopeViolation?: boolean;
  preflightPassed?: boolean;
  agenticFailed?: boolean;
  failLoopExceeded?: boolean;
}

export interface RunawayGuardInput {
  recentStatuses?: string[];
  failures?: number;
  failLoopThreshold?: number;
  budgetWouldExceed?: boolean;
  budgetEnforced?: boolean;
}

export type QueueState = "pending" | "running" | "done" | "failed";
export type ReadOnlyQueueJobType = "docs_watch" | "repo_audit_readonly" | "todo_risk_report" | "session_analysis";

export interface ReadOnlyQueueJob {
  schema?: string;
  id: string;
  type: ReadOnlyQueueJobType | string;
  readOnly?: boolean;
  paths?: string[];
  adapters?: string[];
  budget?: BudgetPreflightDryRunCaps & { strictRequested?: boolean; strictEnabled?: boolean; observedCostUsd?: number; observedRuns?: number; observedDurationMs?: number; observedParallelChildren?: number; estimatedCostUsd?: number; estimatedRuns?: number; estimatedDurationMs?: number; estimatedParallelChildren?: number };
  createdAt?: string;
  attempts?: number;
  maxRetries?: number;
}

export interface QueueTickResult {
  schema: "zob.queue-tick-result.v1";
  claimed: boolean;
  jobId?: string;
  jobType?: string;
  status: "idle" | "done" | "failed";
  claimedPath?: string;
  finalPath?: string;
  errors: string[];
  stopCondition: ChildStopCondition;
  lease?: Record<string, unknown>;
  heartbeat?: Record<string, unknown>;
  staleRecovered?: number;
  killSwitch?: Record<string, unknown>;
  maxWorkers?: number;
  retryPolicy?: Record<string, unknown>;
  strictBudgetGate?: Record<string, unknown>;
  budgetEnforced: boolean;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export type ChildStopCondition =
  | "none"
  | "failed_preflight"
  | "incomplete_no_assistant_turn"
  | "incomplete_no_evidence"
  | "failed_validation"
  | "timeout"
  | "blocked"
  | "scope_violation"
  | "agentic_failed"
  | "oracle_fail"
  | "no_ship"
  | "fail_loop";

export type ChronicleRunKind = "delegation" | "factory" | "orchestration";

export interface ChronicleClassifyInput {
  kind: ChronicleRunKind;
  runId: string;
  status?: string;
  taskHash?: string;
  outputHash?: string;
  evidencePaths?: string[];
  assistantTurnSeen?: boolean;
  outputCaptured?: boolean;
  outputValidated?: boolean;
  evidenceChecked?: boolean;
  stopCondition?: ChildStopCondition;
  preflightPassed?: boolean;
  scopeViolation?: boolean;
  timedOut?: boolean;
  blocked?: boolean;
  agenticFailed?: boolean;
  planned?: boolean;
  budget?: { enforced?: boolean; advisory?: boolean };
  errors?: string[];
}
