import type { WheelStoryExecution } from "../adapters/fleet-v5.js";
import type {
  WheelPrivateRouteCandidate,
  WheelProtectedMissionPlan,
  WheelRoleAssignmentPlan,
  WheelThinkingControl,
} from "../factories/story-pr-close/mission-planner.js";
import type {
  WheelFixedRole,
  WheelModelFamily,
  WheelModelRouteId,
  WheelProviderId,
  WheelRandomizedRolePool,
} from "../model-policy/model-registry.js";

export type WheelSupervisorMode = "disabled" | "deterministic-fake" | "live";
export type WheelSupervisorMissionStatus = "admitted" | "running" | "paused" | "needs-human" | "complete" | "failed";

export type WheelSupervisorStoryStage =
  | "admitted"
  | "waiting-dependencies"
  | "planned"
  | "workspace-provisioning"
  | "workspace-ready"
  | "bootstrap-ready"
  | "draft-pr-open"
  | "development"
  | "documentation"
  | "qa"
  | "internal-review"
  | "formal-blind-review"
  | "repository-assurance"
  | "repair"
  | "draft-ci"
  | "pr-close-source-audit"
  | "pr-close-evidence-audit"
  | "pr-close-finalizing"
  | "pr-close-check"
  | "needs-review"
  | "needs-human"
  | "failed";

export type WheelSupervisorRole = WheelRandomizedRolePool | WheelFixedRole | "pr-close-source-audit" | "pr-close-evidence-audit";
export type WheelPrCloseAuditType = "source-integration" | "evidence-qa-ci" | "finalizer";

export type WheelAttemptStatus =
  | "reserved"
  | "launching"
  | "running"
  | "claim-returned"
  | "validating"
  | "accepted"
  | "rejected"
  | "blocked"
  | "failed"
  | "lost"
  | "cancelled"
  | "superseded";

export type WheelFailureClass =
  | "none"
  | "provider-transient"
  | "provider-unavailable"
  | "rate-limit"
  | "capability-mismatch"
  | "model-quality"
  | "validation"
  | "review-finding"
  | "timeout"
  | "permission-denied"
  | "budget-blocked"
  | "human-blocked"
  | "policy-blocked"
  | "unknown";

export interface WheelSupervisorAuthority {
  schema: "wheel.zob.supervisor-authority.v1";
  mode: WheelSupervisorMode;
  activationEnabled: boolean;
  networkEnabled: boolean;
  providerDispatchEnabled: boolean;
  localGitEffectsEnabled: boolean;
  githubEffectsEnabled: boolean;
  commitEnabled: boolean;
  pushEnabled: boolean;
  mergeEnabled: boolean;
  workflowDispatchEnabled: boolean;
  deploymentEnabled: boolean;
  strictBudgetRequired: true;
  activationReceiptHash?: string;
  spendReceiptHash?: string;
  oracleReceiptHash?: string;
  expiresAt?: string;
  bodyStored: false;
}

export interface WheelSupervisorBudgetPolicy {
  schema: "wheel.zob.supervisor-budget-policy.v1";
  maxAttemptsPerTask: number;
  maxRepairRoundsPerStory: number;
  maxParallelStories: number;
  maxParallelModelCalls: number;
  maxDurationMs: number;
  maxCostUsd: number;
  bodyStored: false;
}

export interface WheelSupervisorBudgetLedger {
  reservedAttempts: number;
  settledAttempts: number;
  reservedCostUsd: number;
  settledCostUsd: number;
  startedAt: string;
  bodyStored: false;
}

export interface WheelSupervisorRouteAssignment {
  role: WheelSupervisorRole;
  required: boolean;
  selected: WheelPrivateRouteCandidate;
  candidates: WheelPrivateRouteCandidate[];
  requestedThinking: WheelRoleAssignmentPlan["requestedThinking"];
  independentFromDevelopment: boolean;
  currentCandidateIndex: number;
  bodyStored: false;
}

export interface WheelSupervisorAttempt {
  schema: "wheel.zob.supervisor-attempt.v1";
  attemptId: string;
  storyId: string;
  role: WheelSupervisorRole;
  assignmentId: string;
  status: WheelAttemptStatus;
  routeId: WheelModelRouteId;
  provider: WheelProviderId;
  family: WheelModelFamily;
  thinkingControl: WheelThinkingControl;
  qualityRung: "low" | "high";
  candidateIndex: number;
  attemptOrdinal: number;
  ownershipEpoch: number;
  promptHash: string;
  headSha?: string;
  outputHash?: string;
  claimHash?: string;
  failureClass: WheelFailureClass;
  failureHash?: string;
  startedAt?: string;
  completedAt?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  bodyStored: false;
}

export interface WheelSupervisorWorkspace {
  workspaceId: string;
  workspacePathHash: string;
  branchName: string;
  baseRef: string;
  baseSha: string;
  headSha?: string;
  rollbackRef: string;
  claimId: string;
  clean: boolean;
  bodyStored: false;
}

export interface WheelSupervisorCheckPolicy {
  requiredCiChecks: Array<{ name: string; issuerHash: string }>;
  prCloseCheck: { name: string; issuerHash: string };
  completionLabel: string;
  bodyStored: false;
}

export interface WheelSupervisorPullRequest {
  pullRequestId: string;
  number?: number;
  state: "planned" | "open" | "closed" | "merged";
  isDraft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  checkIds: string[];
  commentIds: string[];
  labels: string[];
  bodyStored: false;
}

export interface WheelSupervisorEvidenceRef {
  evidenceId: string;
  kind: "build" | "test" | "documentation" | "qa" | "review" | "ci" | "pr-close";
  headSha: string;
  status: "current" | "stale" | "invalid" | "superseded";
  artifactHash: string;
  refs: string[];
  bodyStored: false;
}

export type WheelEvidenceKind = WheelSupervisorEvidenceRef["kind"];

export interface WheelPrCloseAuditResult {
  auditType: WheelPrCloseAuditType;
  assignmentId: string;
  attemptId: string;
  routeIdHash: string;
  headSha: string;
  verdict: "pass" | "needs-human" | "fail";
  evidenceRefs: string[];
  outputHash: string;
  bodyStored: false;
}

export interface WheelPrCloseEvidence {
  schema: "wheel.zob.supervisor-pr-close-evidence.v1";
  missionId: string;
  storyId: string;
  storyRevision: number;
  manifestHash: string;
  branchName: string;
  baseRef: "develop-staging";
  baseSha: string;
  headSha: string;
  pullRequestId: string;
  draftRequired: true;
  terminalAcceptable: boolean;
  auditResults: [WheelPrCloseAuditResult, WheelPrCloseAuditResult, WheelPrCloseAuditResult];
  requiredCheckNames: string[];
  observedCheckIds: string[];
  evidenceHash: string;
  bodyStored: false;
}

export interface WheelSupervisorStoryState {
  schema: "wheel.zob.supervisor-story-state.v1";
  storyId: string;
  machineId: string;
  allocationUnitIds: string[];
  storyPath: string;
  manifestHash: string;
  revision: number;
  branchContract: WheelStoryExecution["branchContract"];
  stage: WheelSupervisorStoryStage;
  stageRevision: number;
  dependencies: WheelStoryExecution["dependencies"];
  humanGateRefs: string[];
  routeAssignments: WheelSupervisorRouteAssignment[];
  attempts: WheelSupervisorAttempt[];
  workspace?: WheelSupervisorWorkspace;
  pullRequest?: WheelSupervisorPullRequest;
  externalSnapshot?: WheelStoryExternalSnapshot;
  evidence: WheelSupervisorEvidenceRef[];
  prCloseEvidence?: WheelPrCloseEvidence;
  repairRound: number;
  blockerCodes: string[];
  lastEventSequence: number;
  bodyStored: false;
}

export interface WheelSupervisorMissionState {
  schema: "wheel.zob.supervisor-mission-state.v1";
  missionId: string;
  bundleId: string;
  bundleHash: string;
  sourceSha: string;
  repositoryId: string;
  checkPolicy: WheelSupervisorCheckPolicy;
  status: WheelSupervisorMissionStatus;
  mode: WheelSupervisorMode;
  authorityHash: string;
  revision: number;
  journalSequence: number;
  journalHeadHash: string;
  ownershipEpoch: number;
  ownerIdHash: string;
  admittedAt: string;
  updatedAt: string;
  budgetPolicy: WheelSupervisorBudgetPolicy;
  budgetLedger: WheelSupervisorBudgetLedger;
  stories: Record<string, WheelSupervisorStoryState>;
  pendingEffectRequestIds: string[];
  noShipReasons: string[];
  bodyStored: false;
}

export type WheelSupervisorEventKind =
  | "mission-admitted"
  | "mission-started"
  | "mission-paused"
  | "mission-resumed"
  | "mission-needs-human"
  | "mission-completed"
  | "mission-failed"
  | "story-stage-changed"
  | "story-blocked"
  | "story-head-changed"
  | "story-repair-round"
  | "human-gate-resolved"
  | "workspace-recorded"
  | "pull-request-recorded"
  | "external-snapshot-recorded"
  | "attempt-reserved"
  | "attempt-started"
  | "attempt-completed"
  | "attempt-failed"
  | "effect-requested"
  | "effect-completed"
  | "evidence-recorded"
  | "pr-close-recorded"
  | "checkpoint-written"
  | "ownership-taken";

export interface WheelSupervisorEvent {
  schema: "wheel.zob.supervisor-event.v1";
  missionId: string;
  sequence: number;
  previousHash: string;
  eventHash: string;
  mutationId: string;
  kind: WheelSupervisorEventKind;
  storyId?: string;
  attemptId?: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  ownershipEpoch: number;
  bodyStored: false;
}

export interface WheelSupervisorCheckpoint {
  schema: "wheel.zob.supervisor-checkpoint.v1";
  missionId: string;
  sequence: number;
  journalHeadHash: string;
  projectionHash: string;
  ownershipEpoch: number;
  writtenAt: string;
  state: WheelSupervisorMissionState;
  bodyStored: false;
}

export interface WheelDispatchRequest {
  schema: "wheel.zob.dispatch-request.v1";
  missionId: string;
  storyId: string;
  taskId: string;
  attemptId: string;
  assignmentId: string;
  role: WheelSupervisorRole;
  routeId: WheelModelRouteId;
  provider: WheelProviderId;
  family: WheelModelFamily;
  thinkingControl: WheelThinkingControl;
  messageRoleFormat: "system-developer-user" | "system-user";
  transientPromptBody: string;
  promptHash: string;
  sourceBindings: Record<string, string>;
  requiredTools: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  timeoutMs: number;
  estimatedCostUsd: number;
  idempotencyKey: string;
}

export interface WheelDispatchResult {
  schema: "wheel.zob.dispatch-result.v1";
  attemptId: string;
  assignmentId: string;
  status: "accepted" | "rejected" | "failed" | "blocked";
  failureClass: WheelFailureClass;
  outputHash?: string;
  claimHash?: string;
  evidenceRefs: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  mocked: boolean;
  networkAccessed: boolean;
  providerCalled: boolean;
  bodyStored: false;
}

export interface WheelDispatchAdapter {
  readonly mode: WheelSupervisorMode;
  dispatch(request: WheelDispatchRequest, authority: WheelSupervisorAuthority, signal?: AbortSignal): Promise<WheelDispatchResult>;
}

export type WheelStoryEffectKind =
  | "create-workspace"
  | "create-branch"
  | "bootstrap-commit"
  | "commit-accepted-candidate"
  | "push-accepted-commit"
  | "create-draft-pr"
  | "observe-pr"
  | "observe-ci"
  | "post-check"
  | "post-comment"
  | "project-label";

export interface WheelStoryEffectRequest {
  schema: "wheel.zob.story-effect-request.v1";
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  missionId: string;
  storyId: string;
  repositoryId: string;
  kind: WheelStoryEffectKind;
  branchName: string;
  baseRef: "develop-staging";
  expectedBaseSha: string;
  expectedHeadSha?: string;
  expectedRemoteHeadSha?: string | null;
  expectedPullRequestId?: string;
  manifestHash: string;
  payloadHash: string;
  metadata: Record<string, string>;
  evidenceRefs: string[];
  bodyStored: false;
}

export interface WheelStoryEffectResult {
  schema: "wheel.zob.story-effect-result.v1";
  requestId: string;
  requestHash: string;
  idempotencyKey: string;
  mode: WheelSupervisorMode;
  status: "blocked-disabled" | "simulated" | "performed" | "replayed" | "precondition-failed" | "policy-denied";
  observationRef?: string;
  syntheticHeadSha?: string;
  syntheticPullRequestId?: string;
  syntheticCheckId?: string;
  reasonCodes: string[];
  externalEffectPerformed: boolean;
  localRepositoryWritePerformed: boolean;
  networkAccessed: boolean;
  credentialsAccessed: boolean;
  bodyStored: false;
}

export interface WheelStoryExternalSnapshot {
  schema: "wheel.zob.story-external-snapshot.v1";
  source: "fake" | "live";
  repositoryId: string;
  storyId: string;
  pullRequest?: WheelSupervisorPullRequest;
  checks: Array<{
    checkId: string;
    name: string;
    headSha: string;
    issuerHash: string;
    status: "queued" | "in-progress" | "completed";
    conclusion?: "success" | "failure" | "cancelled" | "neutral" | "skipped";
  }>;
  latestReviews: Array<{ reviewId: string; headSha: string; state: "approved" | "changes-requested" | "commented"; actorHash: string }>;
  observedAt: string;
  networkAccessed: boolean;
  bodyStored: false;
}

export interface WheelStoryEffectBroker {
  readonly mode: WheelSupervisorMode;
  submit(request: WheelStoryEffectRequest, authority: WheelSupervisorAuthority): Promise<WheelStoryEffectResult>;
  observe(storyId: string, authority: WheelSupervisorAuthority): Promise<WheelStoryExternalSnapshot>;
}

export interface WheelSupervisorAdapters {
  dispatch: WheelDispatchAdapter;
  effects: WheelStoryEffectBroker;
}

export interface WheelSupervisorAdmissionInput {
  missionId: string;
  machineId?: string;
  bundleId: string;
  bundleHash: string;
  sourceSha: string;
  repositoryId: string;
  checkPolicy: WheelSupervisorCheckPolicy;
  stories: Array<{
    machineId: string;
    allocationUnitIds: string[];
    storyPath: string;
    manifestHash: string;
    manifest: WheelStoryExecution;
  }>;
  protectedPlan: WheelProtectedMissionPlan;
  authority: WheelSupervisorAuthority;
  budgetPolicy: WheelSupervisorBudgetPolicy;
  ownerId: string;
  admittedAt?: string;
}

export interface WheelSupervisorTickResult {
  schema: "wheel.zob.supervisor-tick-result.v1";
  missionId: string;
  progressedStoryIds: string[];
  blockedStoryIds: string[];
  completedStoryIds: string[];
  pendingStoryIds: string[];
  eventCount: number;
  status: WheelSupervisorMissionStatus;
  externalEffectsPerformed: boolean;
  providerCallsPerformed: boolean;
  bodyStored: false;
}
