export type WheelPrHandoffAction =
  | "commit"
  | "push"
  | "create-draft-pr"
  | "observe-ci"
  | "pr-close";

export interface WheelLocalLaunchAuthorityBoundary {
  schema: "wheel.zob.local-launch-authority-boundary.v1";
  scope: "local-edit-test-review";
  activationEnabled: false;
  explicitMachineStartRequired: true;
  modelSessionAllowedAfterExplicitStart: true;
  localSourceEditsAllowedAfterExplicitStart: true;
  localTestsAllowedAfterExplicitStart: true;
  localReviewAllowedAfterExplicitStart: true;
  arbitraryNetworkAccessEnabled: false;
  commitEnabled: false;
  pushEnabled: false;
  githubEffectsEnabled: false;
  draftPrEnabled: false;
  workflowDispatchEnabled: false;
  mergeEnabled: false;
  promotionEnabled: false;
  deploymentEnabled: false;
  bodyStored: false;
}

export interface WheelLocalMachineLaunchAssignment {
  schema: "wheel.zob.local-machine-launch-assignment.v1";
  machineId: string;
  assignmentHash: string;
  allocationUnitIds: string[];
  storyIds: string[];
  storyPaths: string[];
  storyManifestHashes: string[];
  storyBranchNames: string[];
  storyBaseRefs: string[];
  dependencyStoryIds: string[];
  humanGateStoryIds: string[];
  linkedWorktreeRequired: true;
  cleanWorktreeRequiredAtInitialClaim: true;
  sessionOwnershipRequired: true;
  recoveryEpochRequired: true;
  stopBeforeCommitRequired: true;
  bodyStored: false;
}

export interface WheelLocalMachineLaunchPlan {
  schema: "wheel.zob.local-machine-launch-plan.v1";
  launchId: string;
  missionId: string;
  bundlePath: string;
  bundleId: string;
  bundleHash: string;
  sourceSha: string;
  repositoryId: string;
  selectedMachineIds: string[];
  allocationUnitCount: number;
  storyIds: string[];
  preparedAt: string;
  expiresAt: string;
  planHash: string;
  assignments: WheelLocalMachineLaunchAssignment[];
  launchMechanism: {
    kind: "existing-pi-or-zagent-session";
    preparationOnly: true;
    processSpawned: false;
    exactPlanHashConfirmationRequired: true;
    presenceReceiptRequiredForZagent: true;
    durablePromptBodyStored: false;
  };
  authorityBoundary: WheelLocalLaunchAuthorityBoundary;
  prHandoff: {
    required: true;
    candidateSchema: "wheel.zob.pr-handoff-candidate.v1";
    authoritySchema: "wheel.zob.pr-handoff-authority.v1";
    exactCandidateHashRequired: true;
    exactBaseAndHeadRequired: true;
    mergeAuthorityIncluded: false;
    promotionAuthorityIncluded: false;
    deploymentAuthorityIncluded: false;
  };
  bodyStored: false;
}

export interface WheelLocalMachineLaunchPreparation {
  schema: "wheel.zob.local-machine-launch-preparation.v1";
  prepared: boolean;
  launchDirectoryRef?: string;
  plan?: WheelLocalMachineLaunchPlan;
  errors: string[];
  confirmationPhrases: Array<{ machineId: string; phrase: string }>;
  processSpawned: false;
  providerCallsMade: false;
  sourceMutationsMade: false;
  gitMutationsMade: false;
  reportArtifactsWritten: boolean;
  githubEffectsMade: false;
  spendIncurred: false;
  bodyStored: false;
}

export type WheelLocalMachineLaunchStatus =
  | "claimed"
  | "started"
  | "running"
  | "local-ready"
  | "handoff-candidate"
  | "blocked";

export interface WheelLocalMachineLaunchClaim {
  schema: "wheel.zob.local-machine-launch-claim.v1";
  claimId: string;
  launchId: string;
  planHash: string;
  machineId: string;
  assignmentHash: string;
  ownerIdHash: string;
  sessionIdHash: string;
  workspaceRootHash: string;
  workspaceHeadSha: string;
  workspaceBranch: string;
  linkedWorktree: true;
  cleanAtInitialClaim: true;
  ownershipEpoch: number;
  claimedAt: string;
  updatedAt: string;
  leaseExpiresAt: string;
  status: WheelLocalMachineLaunchStatus;
  confirmationHash: string;
  zagentPresenceReceiptHash?: string;
  evidenceRefs: string[];
  evidenceHashes: string[];
  blockerHash?: string;
  commitEnabled: false;
  pushEnabled: false;
  githubEffectsEnabled: false;
  bodyStored: false;
}

export type WheelLocalMachineLaunchEventKind =
  | "machine-claimed"
  | "machine-started"
  | "machine-running"
  | "machine-local-ready"
  | "machine-blocked"
  | "machine-recovered"
  | "machine-handoff-candidate";

export interface WheelLocalMachineLaunchEvent {
  schema: "wheel.zob.local-machine-launch-event.v1";
  launchId: string;
  machineId: string;
  sequence: number;
  previousHash: string;
  eventHash: string;
  mutationId: string;
  kind: WheelLocalMachineLaunchEventKind;
  claim: WheelLocalMachineLaunchClaim;
  occurredAt: string;
  bodyStored: false;
}

export interface WheelLocalMachineLaunchStatusReport {
  schema: "wheel.zob.local-machine-launch-status.v1";
  launchId: string;
  machineId: string;
  valid: boolean;
  issueCodes: string[];
  claim?: WheelLocalMachineLaunchClaim;
  eventCount: number;
  journalHeadHash: string;
  checkpointCurrent: boolean;
  recoveryRequired: boolean;
  recoveryReasons: string[];
  ownershipLive: boolean;
  recoveredExpiredOwnerCount: number;
  processSpawned: false;
  commitEnabled: false;
  githubEffectsEnabled: false;
  bodyStored: false;
}

export interface WheelLocalWorkspaceInspection {
  schema: "wheel.zob.local-workspace-inspection.v1";
  repositoryRoot: string;
  workspaceRootHash: string;
  headSha: string;
  branchName: string;
  linkedWorktree: boolean;
  clean: boolean;
  bodyStored: false;
}

export interface WheelPrHandoffCandidate {
  schema: "wheel.zob.pr-handoff-candidate.v1";
  phase: "pre-commit" | "post-commit";
  candidateId: string;
  candidateHash: string;
  launchId: string;
  launchPlanHash: string;
  machineId: string;
  assignmentHash: string;
  workspaceClaimId: string;
  machineJournalHeadHash: string;
  machineOwnershipEpoch: number;
  machineControlWorkspaceRootHash: string;
  storyWorkspaceRootHash: string;
  priorPreCommitCandidateId?: string;
  priorPreCommitCandidateHash?: string;
  commitAuthorityId?: string;
  commitAuthorityHash?: string;
  commitReceiptId?: string;
  commitReceiptHash?: string;
  bundleId: string;
  bundleHash: string;
  sourceSha: string;
  repositoryId: string;
  storyIds: string[];
  branchName: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  treeHash: string;
  contentHash: string;
  diffHash: string;
  changedPaths: string[];
  evidenceRefs: string[];
  evidenceHashes: string[];
  requestedActions: WheelPrHandoffAction[];
  preparedAt: string;
  expiresAt: string;
  authorityGranted: false;
  commitEnabled: false;
  pushEnabled: false;
  githubEffectsEnabled: false;
  mergeEnabled: false;
  promotionEnabled: false;
  deploymentEnabled: false;
  bodyStored: false;
}

export interface WheelPrHandoffCommitReceipt {
  schema: "wheel.zob.pr-handoff-commit-receipt.v1";
  receiptId: string;
  receiptHash: string;
  launchId: string;
  machineId: string;
  workspaceClaimId: string;
  machineJournalHeadHash: string;
  machineOwnershipEpoch: number;
  storyWorkspaceRootHash: string;
  storyIds: string[];
  branchName: string;
  baseRef: string;
  baseSha: string;
  committedHeadSha: string;
  treeHash: string;
  contentHash: string;
  diffHash: string;
  preCommitCandidateId: string;
  preCommitCandidateHash: string;
  commitAuthorityId: string;
  commitAuthorityHash: string;
  governedCommitEvidenceRef: string;
  governedCommitEvidenceHash: string;
  recordedAt: string;
  pushEnabled: false;
  githubEffectsEnabled: false;
  mergeEnabled: false;
  promotionEnabled: false;
  deploymentEnabled: false;
  bodyStored: false;
}

export interface WheelPrHandoffWorkspaceSnapshot {
  schema: "wheel.zob.pr-handoff-workspace-snapshot.v1";
  repositoryRoot: string;
  workspaceRootHash: string;
  branchName: string;
  headSha: string;
  treeHash: string;
  contentHash: string;
  diffHash: string;
  changedPaths: string[];
  clean: boolean;
  linkedWorktree: boolean;
  sourceShaVerified: true;
  bodyStored: false;
}

export interface WheelPrHandoffAuthority {
  schema: "wheel.zob.pr-handoff-authority.v1";
  phase: "pre-commit" | "post-commit";
  authorityId: string;
  candidateId: string;
  candidateHash: string;
  launchId: string;
  launchPlanHash: string;
  machineId: string;
  assignmentHash: string;
  workspaceClaimId: string;
  machineJournalHeadHash: string;
  machineOwnershipEpoch: number;
  machineControlWorkspaceRootHash: string;
  storyWorkspaceRootHash: string;
  repositoryId: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  contentHash: string;
  diffHash: string;
  actorIdHash: string;
  receiptHash: string;
  allowedActions: WheelPrHandoffAction[];
  issuedAt: string;
  expiresAt: string;
  mergeEnabled: false;
  promotionEnabled: false;
  deploymentEnabled: false;
  bodyStored: false;
}

export interface WheelPrHandoffValidation {
  schema: "wheel.zob.pr-handoff-validation.v1";
  valid: boolean;
  errors: string[];
  candidateHash?: string;
  authorityHash?: string;
  allowedActions: WheelPrHandoffAction[];
  mergeEnabled: false;
  promotionEnabled: false;
  deploymentEnabled: false;
  bodyStored: false;
}
