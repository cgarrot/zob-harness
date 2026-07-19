import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

import { assertSafeSupervisorId, sha256Canonical, sha256Text } from "../supervisor/canonical.js";
import { assertBodySafe, readJson, writeAtomic } from "../supervisor/store-persistence.js";
import {
  hashWheelLocalMachineLaunchAssignment,
  hashWheelLocalMachineLaunchPlan,
  loadWheelLocalMachineLaunchPlan,
  resolveWheelLocalLaunchDirectory,
  validateWheelLocalMachineLaunchPlan,
} from "./local-machine.js";
import { FileWheelLocalMachineLaunchStore, assertWheelLocalMachineLaunchClaim } from "./session-store.js";
import { inspectWheelPrHandoffWorkspace } from "./workspace-snapshot.js";
import type {
  WheelLocalMachineLaunchClaim,
  WheelLocalMachineLaunchPlan,
  WheelPrHandoffAction,
  WheelPrHandoffAuthority,
  WheelPrHandoffCandidate,
  WheelPrHandoffCommitReceipt,
  WheelPrHandoffValidation,
  WheelPrHandoffWorkspaceSnapshot,
} from "./types.js";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA64 = /^[a-f0-9]{64}$/;
const MAX_HANDOFF_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_HANDOFF_TTL_MS = 4 * 60 * 60 * 1_000;
const FORBIDDEN_HANDOFF_REF = /(^|\/)(?:\.env(?:\.|$)|\.pi\/(?:sessions|agent-sessions)(?:\/|$)|secrets?(?:\/|$)|credentials?(?:\/|$))/i;
const FORBIDDEN_CHANGED_REF = /(^|\/)(?:\.git(?:\/|$)|\.pi(?:\/|$)|reports\/wheel-zob\/local-launches(?:\/|$))/i;
const PR_HANDOFF_ACTIONS: readonly WheelPrHandoffAction[] = Object.freeze([
  "commit",
  "push",
  "create-draft-pr",
  "observe-ci",
  "pr-close",
]);

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function safeRepoRef(value: string): boolean {
  const normalized = value.split("\\").join("/");
  return normalized.length > 0
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && !FORBIDDEN_HANDOFF_REF.test(normalized);
}

function safeChangedRef(value: string): boolean {
  const normalized = value.split("\\").join("/");
  return safeRepoRef(normalized) && !FORBIDDEN_CHANGED_REF.test(normalized);
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) if (!allowedSet.has(key)) errors.push(`${label}.${key} is not allowed`);
  for (const key of required) if (!(key in record)) errors.push(`${label}.${key} is required`);
}

function safeBranchName(value: string): boolean {
  return value.length > 0
    && !value.startsWith("-")
    && !value.endsWith(".")
    && !value.endsWith("/")
    && !value.includes("..")
    && !value.includes("@{")
    && !/[~^:?*[\\\s]/.test(value);
}

function candidatePayload(candidate: WheelPrHandoffCandidate): Omit<WheelPrHandoffCandidate, "candidateHash"> {
  const { candidateHash: _candidateHash, ...payload } = candidate;
  return payload;
}

export function hashWheelPrHandoffCandidate(candidate: WheelPrHandoffCandidate): string {
  return sha256Canonical(candidatePayload(candidate));
}

export function wheelPrHandoffConfirmation(
  candidate: WheelPrHandoffCandidate,
  allowedActions: readonly WheelPrHandoffAction[],
): string {
  return `AUTHORIZE WHEEL PR HANDOFF ${candidate.candidateId} CANDIDATE ${candidate.candidateHash} ACTIONS ${allowedActions.join(",")} HEAD ${candidate.headSha}`;
}

export function validateWheelPrHandoffCandidate(
  candidate: WheelPrHandoffCandidate,
  options: { now?: string; allowExpired?: boolean } = {},
): WheelPrHandoffValidation {
  const errors: string[] = [];
  try {
    assertBodySafe(candidate);
    exactKeys(candidate as unknown as Record<string, unknown>, [
      "schema", "phase", "candidateId", "candidateHash", "launchId", "launchPlanHash", "machineId", "assignmentHash",
      "workspaceClaimId", "machineJournalHeadHash", "machineOwnershipEpoch", "machineControlWorkspaceRootHash", "storyWorkspaceRootHash",
      "priorPreCommitCandidateId", "priorPreCommitCandidateHash", "commitAuthorityId", "commitAuthorityHash", "commitReceiptId", "commitReceiptHash",
      "bundleId", "bundleHash", "sourceSha", "repositoryId", "storyIds",
      "branchName", "baseRef", "baseSha", "headSha", "treeHash", "contentHash", "diffHash", "changedPaths", "evidenceRefs",
      "evidenceHashes", "requestedActions", "preparedAt", "expiresAt", "authorityGranted", "commitEnabled", "pushEnabled",
      "githubEffectsEnabled", "mergeEnabled", "promotionEnabled", "deploymentEnabled", "bodyStored",
    ], "candidate", errors, [
      "schema", "phase", "candidateId", "candidateHash", "launchId", "launchPlanHash", "machineId", "assignmentHash",
      "workspaceClaimId", "machineJournalHeadHash", "machineOwnershipEpoch", "machineControlWorkspaceRootHash", "storyWorkspaceRootHash",
      "bundleId", "bundleHash", "sourceSha", "repositoryId", "storyIds", "branchName", "baseRef", "baseSha", "headSha",
      "treeHash", "contentHash", "diffHash", "changedPaths", "evidenceRefs", "evidenceHashes", "requestedActions", "preparedAt", "expiresAt",
      "authorityGranted", "commitEnabled", "pushEnabled", "githubEffectsEnabled", "mergeEnabled", "promotionEnabled", "deploymentEnabled", "bodyStored",
    ]);
    assertSafeSupervisorId(candidate.candidateId, "candidateId");
    assertSafeSupervisorId(candidate.launchId, "launchId");
    assertSafeSupervisorId(candidate.machineId, "machineId");
    assertSafeSupervisorId(candidate.workspaceClaimId, "workspaceClaimId");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (candidate.schema !== "wheel.zob.pr-handoff-candidate.v1") errors.push("candidate schema is invalid");
  if (candidate.phase !== "pre-commit" && candidate.phase !== "post-commit") errors.push("candidate phase is invalid");
  for (const [label, value] of [
    ["candidateHash", candidate.candidateHash],
    ["launchPlanHash", candidate.launchPlanHash],
    ["assignmentHash", candidate.assignmentHash],
    ["machineJournalHeadHash", candidate.machineJournalHeadHash],
    ["machineControlWorkspaceRootHash", candidate.machineControlWorkspaceRootHash],
    ["storyWorkspaceRootHash", candidate.storyWorkspaceRootHash],
    ["bundleHash", candidate.bundleHash],
    ["contentHash", candidate.contentHash],
    ["diffHash", candidate.diffHash],
  ] as const) if (!SHA64.test(value)) errors.push(`${label} must be a lowercase sha256`);
  if (!Number.isSafeInteger(candidate.machineOwnershipEpoch) || candidate.machineOwnershipEpoch < 1) errors.push("machineOwnershipEpoch must be a positive safe integer");
  if (candidate.machineControlWorkspaceRootHash === candidate.storyWorkspaceRootHash) errors.push("story workspace must differ from the machine control workspace");
  for (const [label, value] of [["sourceSha", candidate.sourceSha], ["baseSha", candidate.baseSha], ["headSha", candidate.headSha], ["treeHash", candidate.treeHash]] as const) {
    if (!GIT_OBJECT_ID.test(value)) errors.push(`${label} must be a lowercase git object id`);
  }
  if (candidate.phase === "pre-commit" && candidate.baseSha !== candidate.headSha) errors.push("pre-commit candidate headSha must equal the current base head");
  if (candidate.phase === "post-commit" && candidate.baseSha === candidate.headSha) errors.push("post-commit candidate headSha must differ from baseSha");
  if (!safeBranchName(candidate.branchName)) errors.push("branchName is unsafe");
  if (candidate.baseRef.length === 0) errors.push("baseRef must be non-empty");
  if (candidate.storyIds.length === 0 || !unique(candidate.storyIds)) errors.push("storyIds must be non-empty and unique");
  if (!unique(candidate.changedPaths) || !candidate.changedPaths.every(safeChangedRef)) errors.push("changedPaths must be unique safe repo-relative source paths");
  if (candidate.changedPaths.length === 0) errors.push("changedPaths must be non-empty");
  if (!unique(candidate.evidenceRefs) || !candidate.evidenceRefs.every(safeRepoRef)) errors.push("evidenceRefs must be unique safe repo-relative refs");
  if (!candidate.evidenceHashes.every((hash) => SHA64.test(hash))) errors.push("evidenceHashes must contain lowercase sha256 values");
  if (candidate.evidenceRefs.length === 0 || candidate.evidenceRefs.length !== candidate.evidenceHashes.length) errors.push("evidenceRefs and evidenceHashes must be non-empty and align one-for-one");
  if (candidate.requestedActions.length === 0 || !unique(candidate.requestedActions) || !candidate.requestedActions.every((action) => PR_HANDOFF_ACTIONS.includes(action))) {
    errors.push("requestedActions must be non-empty, unique, and supported");
  } else if (candidate.phase === "pre-commit" && (candidate.requestedActions.length !== 1 || candidate.requestedActions[0] !== "commit")) {
    errors.push("pre-commit candidate may request only commit");
  } else if (candidate.phase === "post-commit" && candidate.requestedActions.includes("commit")) {
    errors.push("post-commit candidate must not request commit");
  }
  const lineageValues = [
    candidate.priorPreCommitCandidateId,
    candidate.priorPreCommitCandidateHash,
    candidate.commitAuthorityId,
    candidate.commitAuthorityHash,
    candidate.commitReceiptId,
    candidate.commitReceiptHash,
  ];
  if (candidate.phase === "pre-commit" && lineageValues.some((value) => value !== undefined)) errors.push("pre-commit candidate must not carry post-commit lineage");
  if (candidate.phase === "post-commit") {
    if (lineageValues.some((value) => value === undefined)) errors.push("post-commit candidate requires complete pre-commit authority and commit-receipt lineage");
    for (const [label, value] of [
      ["priorPreCommitCandidateId", candidate.priorPreCommitCandidateId],
      ["commitAuthorityId", candidate.commitAuthorityId],
      ["commitReceiptId", candidate.commitReceiptId],
    ] as const) {
      if (typeof value !== "string") continue;
      try { assertSafeSupervisorId(value, label); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    for (const [label, value] of [
      ["priorPreCommitCandidateHash", candidate.priorPreCommitCandidateHash],
      ["commitAuthorityHash", candidate.commitAuthorityHash],
      ["commitReceiptHash", candidate.commitReceiptHash],
    ] as const) if (typeof value !== "string" || !SHA64.test(value)) errors.push(`${label} must be a lowercase sha256`);
  }
  const preparedAt = Date.parse(candidate.preparedAt);
  const expiresAt = Date.parse(candidate.expiresAt);
  if (!Number.isFinite(preparedAt)) errors.push("preparedAt must be an ISO timestamp");
  if (!Number.isFinite(expiresAt) || expiresAt <= preparedAt) errors.push("expiresAt must be after preparedAt");
  else if (expiresAt - preparedAt > MAX_HANDOFF_TTL_MS) errors.push("candidate lifetime exceeds maximum handoff TTL");
  if (!options.allowExpired && Number.isFinite(expiresAt)) {
    const now = Date.parse(options.now ?? new Date().toISOString());
    if (Number.isFinite(now) && expiresAt <= now) errors.push("PR handoff candidate is expired");
  }
  if (candidate.authorityGranted !== false || candidate.commitEnabled !== false || candidate.pushEnabled !== false || candidate.githubEffectsEnabled !== false) {
    errors.push("candidate must not grant commit, push, or GitHub authority");
  }
  if (candidate.mergeEnabled !== false || candidate.promotionEnabled !== false || candidate.deploymentEnabled !== false) {
    errors.push("candidate must not grant merge, promotion, or deployment authority");
  }
  if (candidate.bodyStored !== false) errors.push("candidate bodyStored must be false");
  if (SHA64.test(candidate.candidateHash) && hashWheelPrHandoffCandidate(candidate) !== candidate.candidateHash) errors.push("candidate hash mismatch");
  return {
    schema: "wheel.zob.pr-handoff-validation.v1",
    valid: errors.length === 0,
    errors,
    candidateHash: candidate.candidateHash,
    allowedActions: [],
    mergeEnabled: false,
    promotionEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  };
}

export function prepareWheelPrHandoffCandidate(
  plan: WheelLocalMachineLaunchPlan,
  claim: WheelLocalMachineLaunchClaim,
  input: {
    candidateId: string;
    phase: "pre-commit" | "post-commit";
    storyIds?: string[];
    machineJournalHeadHash: string;
    machineOwnershipEpoch: number;
    storyWorkspaceRootHash: string;
    priorPreCommitCandidateId?: string;
    priorPreCommitCandidateHash?: string;
    commitAuthorityId?: string;
    commitAuthorityHash?: string;
    commitReceiptId?: string;
    commitReceiptHash?: string;
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
    preparedAt?: string;
    ttlMs?: number;
  },
): WheelPrHandoffCandidate {
  const planValidation = validateWheelLocalMachineLaunchPlan(plan, { allowExpired: true });
  if (!planValidation.valid) throw new Error(`invalid local launch plan: ${planValidation.errors.join("; ")}`);
  assertSafeSupervisorId(input.candidateId, "candidateId");
  assertWheelLocalMachineLaunchClaim(claim);
  if (claim.schema !== "wheel.zob.local-machine-launch-claim.v1") throw new Error("workspace claim schema is invalid");
  if (claim.launchId !== plan.launchId || claim.planHash !== plan.planHash) throw new Error("workspace claim is not bound to the local launch plan");
  if (!plan.selectedMachineIds.includes(claim.machineId)) throw new Error("workspace claim machine is not selected in the launch plan");
  const assignment = plan.assignments.find((item) => item.machineId === claim.machineId);
  if (!assignment || assignment.assignmentHash !== claim.assignmentHash || hashWheelLocalMachineLaunchAssignment(assignment) !== claim.assignmentHash) {
    throw new Error("workspace claim assignment binding is invalid");
  }
  if (claim.status !== "running" && claim.status !== "local-ready" && claim.status !== "handoff-candidate") {
    throw new Error("machine claim must be running or locally reviewed before PR handoff");
  }
  if (claim.commitEnabled !== false || claim.pushEnabled !== false || claim.githubEffectsEnabled !== false) throw new Error("workspace claim unexpectedly grants external effects");
  const storyIds = input.storyIds ?? assignment.storyIds;
  if (storyIds.length === 0 || !unique(storyIds) || !storyIds.every((storyId) => assignment.storyIds.includes(storyId))) throw new Error("candidate storyIds must be a non-empty unique subset of the machine assignment");
  const selectedIndexes = storyIds.map((storyId) => assignment.storyIds.indexOf(storyId));
  const expectedBranches = selectedIndexes.map((index) => assignment.storyBranchNames[index]);
  const expectedBases = selectedIndexes.map((index) => assignment.storyBaseRefs[index]);
  if (!expectedBranches.every((branchName) => branchName === input.branchName)) throw new Error("candidate branchName does not match every selected story branch contract");
  if (!expectedBases.every((baseRef) => baseRef === input.baseRef)) throw new Error("candidate baseRef does not match every selected story branch contract");
  if (!SHA64.test(input.machineJournalHeadHash)) throw new Error("machineJournalHeadHash must be a lowercase sha256");
  if (!Number.isSafeInteger(input.machineOwnershipEpoch) || input.machineOwnershipEpoch !== claim.ownershipEpoch) throw new Error("machineOwnershipEpoch must match the current claim epoch");
  if (!SHA64.test(input.storyWorkspaceRootHash)) throw new Error("storyWorkspaceRootHash must be a lowercase sha256");
  if (input.storyWorkspaceRootHash === claim.workspaceRootHash) throw new Error("story workspace must differ from the machine control workspace");
  const preparedAt = input.preparedAt ?? new Date().toISOString();
  const preparedAtMs = Date.parse(preparedAt);
  if (!Number.isFinite(preparedAtMs)) throw new Error("preparedAt must be an ISO timestamp");
  const ttlMs = input.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_HANDOFF_TTL_MS) throw new Error(`ttlMs must be an integer between 1 and ${MAX_HANDOFF_TTL_MS}`);
  const payload: Omit<WheelPrHandoffCandidate, "candidateHash"> = {
    schema: "wheel.zob.pr-handoff-candidate.v1",
    phase: input.phase,
    candidateId: input.candidateId,
    launchId: plan.launchId,
    launchPlanHash: plan.planHash,
    machineId: claim.machineId,
    assignmentHash: claim.assignmentHash,
    workspaceClaimId: claim.claimId,
    machineJournalHeadHash: input.machineJournalHeadHash,
    machineOwnershipEpoch: input.machineOwnershipEpoch,
    machineControlWorkspaceRootHash: claim.workspaceRootHash,
    storyWorkspaceRootHash: input.storyWorkspaceRootHash,
    priorPreCommitCandidateId: input.priorPreCommitCandidateId,
    priorPreCommitCandidateHash: input.priorPreCommitCandidateHash,
    commitAuthorityId: input.commitAuthorityId,
    commitAuthorityHash: input.commitAuthorityHash,
    commitReceiptId: input.commitReceiptId,
    commitReceiptHash: input.commitReceiptHash,
    bundleId: plan.bundleId,
    bundleHash: plan.bundleHash,
    sourceSha: plan.sourceSha,
    repositoryId: plan.repositoryId,
    storyIds: [...storyIds],
    branchName: input.branchName,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    headSha: input.headSha,
    treeHash: input.treeHash,
    contentHash: input.contentHash,
    diffHash: input.diffHash,
    changedPaths: [...input.changedPaths],
    evidenceRefs: [...input.evidenceRefs],
    evidenceHashes: [...input.evidenceHashes],
    requestedActions: [...input.requestedActions],
    preparedAt,
    expiresAt: new Date(preparedAtMs + ttlMs).toISOString(),
    authorityGranted: false,
    commitEnabled: false,
    pushEnabled: false,
    githubEffectsEnabled: false,
    mergeEnabled: false,
    promotionEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  };
  const candidate: WheelPrHandoffCandidate = { ...payload, candidateHash: sha256Canonical(payload) };
  const validation = validateWheelPrHandoffCandidate(candidate, { now: preparedAt });
  if (!validation.valid) throw new Error(`invalid PR handoff candidate: ${validation.errors.join("; ")}`);
  return candidate;
}

export function createWheelPrHandoffAuthority(
  candidate: WheelPrHandoffCandidate,
  input: {
    authorityId: string;
    actorId: string;
    allowedActions: WheelPrHandoffAction[];
    confirmationPhrase: string;
    issuedAt?: string;
    ttlMs?: number;
  },
): WheelPrHandoffAuthority {
  const candidateValidation = validateWheelPrHandoffCandidate(candidate, { allowExpired: true });
  if (!candidateValidation.valid) throw new Error(`invalid PR handoff candidate: ${candidateValidation.errors.join("; ")}`);
  assertSafeSupervisorId(input.authorityId, "authorityId");
  if (input.actorId.trim().length === 0) throw new Error("actorId must be non-empty");
  if (input.allowedActions.length === 0 || !unique(input.allowedActions)) throw new Error("allowedActions must be non-empty and unique");
  if (!input.allowedActions.every((action) => candidate.requestedActions.includes(action))) throw new Error("allowedActions must be a subset of requestedActions");
  const expectedPhrase = wheelPrHandoffConfirmation(candidate, input.allowedActions);
  if (input.confirmationPhrase !== expectedPhrase) throw new Error("PR handoff confirmation phrase does not match the exact candidate, actions, and head");
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) throw new Error("issuedAt must be an ISO timestamp");
  const candidatePreparedAtMs = Date.parse(candidate.preparedAt);
  const candidateExpiresAtMs = Date.parse(candidate.expiresAt);
  if (issuedAtMs < candidatePreparedAtMs || issuedAtMs >= candidateExpiresAtMs) throw new Error("authority must be issued within the candidate lifetime");
  const ttlMs = input.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_HANDOFF_TTL_MS) throw new Error(`ttlMs must be an integer between 1 and ${MAX_HANDOFF_TTL_MS}`);
  return {
    schema: "wheel.zob.pr-handoff-authority.v1",
    phase: candidate.phase,
    authorityId: input.authorityId,
    candidateId: candidate.candidateId,
    candidateHash: candidate.candidateHash,
    launchId: candidate.launchId,
    launchPlanHash: candidate.launchPlanHash,
    machineId: candidate.machineId,
    assignmentHash: candidate.assignmentHash,
    workspaceClaimId: candidate.workspaceClaimId,
    machineJournalHeadHash: candidate.machineJournalHeadHash,
    machineOwnershipEpoch: candidate.machineOwnershipEpoch,
    machineControlWorkspaceRootHash: candidate.machineControlWorkspaceRootHash,
    storyWorkspaceRootHash: candidate.storyWorkspaceRootHash,
    repositoryId: candidate.repositoryId,
    baseRef: candidate.baseRef,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    contentHash: candidate.contentHash,
    diffHash: candidate.diffHash,
    actorIdHash: sha256Text(input.actorId),
    receiptHash: sha256Text(input.confirmationPhrase),
    allowedActions: [...input.allowedActions],
    issuedAt,
    expiresAt: new Date(Math.min(issuedAtMs + ttlMs, candidateExpiresAtMs)).toISOString(),
    mergeEnabled: false,
    promotionEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  };
}

export function validateWheelPrHandoffAuthority(
  candidate: WheelPrHandoffCandidate,
  authority: WheelPrHandoffAuthority,
  options: {
    now?: string;
    currentBaseSha?: string;
    currentHeadSha?: string;
    currentContentHash?: string;
    currentDiffHash?: string;
    currentBranchName?: string;
    currentStoryWorkspaceRootHash?: string;
    currentMachineClaimId?: string;
    currentMachineJournalHeadHash?: string;
    currentMachineOwnershipEpoch?: number;
    currentMachineControlWorkspaceRootHash?: string;
    allowExpired?: boolean;
  } = {},
): WheelPrHandoffValidation {
  const candidateValidation = validateWheelPrHandoffCandidate(candidate, { now: options.now, allowExpired: options.allowExpired });
  const errors = [...candidateValidation.errors];
  try {
    assertBodySafe(authority);
    exactKeys(authority as unknown as Record<string, unknown>, [
      "schema", "phase", "authorityId", "candidateId", "candidateHash", "launchId", "launchPlanHash", "machineId",
      "assignmentHash", "workspaceClaimId", "machineJournalHeadHash", "machineOwnershipEpoch", "machineControlWorkspaceRootHash", "storyWorkspaceRootHash", "repositoryId", "baseRef", "baseSha", "headSha",
      "contentHash", "diffHash", "actorIdHash", "receiptHash", "allowedActions", "issuedAt", "expiresAt", "mergeEnabled",
      "promotionEnabled", "deploymentEnabled", "bodyStored",
    ], "authority", errors);
    assertSafeSupervisorId(authority.authorityId, "authorityId");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (authority.schema !== "wheel.zob.pr-handoff-authority.v1") errors.push("authority schema is invalid");
  if (authority.phase !== candidate.phase) errors.push("authority phase does not match candidate");
  const exactBindings: Array<[string, unknown, unknown]> = [
    ["candidateId", authority.candidateId, candidate.candidateId],
    ["candidateHash", authority.candidateHash, candidate.candidateHash],
    ["launchId", authority.launchId, candidate.launchId],
    ["launchPlanHash", authority.launchPlanHash, candidate.launchPlanHash],
    ["machineId", authority.machineId, candidate.machineId],
    ["assignmentHash", authority.assignmentHash, candidate.assignmentHash],
    ["workspaceClaimId", authority.workspaceClaimId, candidate.workspaceClaimId],
    ["machineJournalHeadHash", authority.machineJournalHeadHash, candidate.machineJournalHeadHash],
    ["machineOwnershipEpoch", authority.machineOwnershipEpoch, candidate.machineOwnershipEpoch],
    ["machineControlWorkspaceRootHash", authority.machineControlWorkspaceRootHash, candidate.machineControlWorkspaceRootHash],
    ["storyWorkspaceRootHash", authority.storyWorkspaceRootHash, candidate.storyWorkspaceRootHash],
    ["repositoryId", authority.repositoryId, candidate.repositoryId],
    ["baseRef", authority.baseRef, candidate.baseRef],
    ["baseSha", authority.baseSha, candidate.baseSha],
    ["headSha", authority.headSha, candidate.headSha],
    ["contentHash", authority.contentHash, candidate.contentHash],
    ["diffHash", authority.diffHash, candidate.diffHash],
  ];
  for (const [label, actual, expected] of exactBindings) if (actual !== expected) errors.push(`authority ${label} does not match candidate`);
  if (!SHA64.test(authority.actorIdHash) || !SHA64.test(authority.receiptHash)) errors.push("authority actorIdHash and receiptHash must be lowercase sha256 values");
  if (authority.allowedActions.length === 0 || !unique(authority.allowedActions) || !authority.allowedActions.every((action) => candidate.requestedActions.includes(action))) {
    errors.push("authority allowedActions must be a non-empty unique subset of candidate requestedActions");
  }
  const expectedReceiptHash = sha256Text(wheelPrHandoffConfirmation(candidate, authority.allowedActions));
  if (authority.receiptHash !== expectedReceiptHash) errors.push("authority receiptHash does not bind the exact candidate, actions, and head");
  const issuedAt = Date.parse(authority.issuedAt);
  const expiresAt = Date.parse(authority.expiresAt);
  const now = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(issuedAt)) errors.push("authority issuedAt must be an ISO timestamp");
  if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) errors.push("authority expiresAt must be after issuedAt");
  if (Number.isFinite(issuedAt) && issuedAt < Date.parse(candidate.preparedAt)) errors.push("authority was issued before candidate preparation");
  if (Number.isFinite(expiresAt) && expiresAt > Date.parse(candidate.expiresAt)) errors.push("authority must not outlive its candidate");
  if (!options.allowExpired && Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt <= now) errors.push("PR handoff authority is expired");
  if (authority.mergeEnabled !== false || authority.promotionEnabled !== false || authority.deploymentEnabled !== false) {
    errors.push("authority must not include merge, promotion, or deployment");
  }
  if (authority.bodyStored !== false) errors.push("authority bodyStored must be false");
  if (options.currentBaseSha !== undefined && options.currentBaseSha !== candidate.baseSha) errors.push("current base sha does not match candidate");
  if (options.currentHeadSha !== undefined && options.currentHeadSha !== candidate.headSha) errors.push("current head sha does not match candidate");
  if (options.currentContentHash !== undefined && options.currentContentHash !== candidate.contentHash) errors.push("current content hash does not match candidate");
  if (options.currentDiffHash !== undefined && options.currentDiffHash !== candidate.diffHash) errors.push("current diff hash does not match candidate");
  if (options.currentBranchName !== undefined && options.currentBranchName !== candidate.branchName) errors.push("current branch does not match candidate");
  if (options.currentStoryWorkspaceRootHash !== undefined && options.currentStoryWorkspaceRootHash !== candidate.storyWorkspaceRootHash) errors.push("current story workspace does not match candidate");
  if (options.currentMachineClaimId !== undefined && options.currentMachineClaimId !== candidate.workspaceClaimId) errors.push("current machine claim does not match candidate");
  if (options.currentMachineJournalHeadHash !== undefined && options.currentMachineJournalHeadHash !== candidate.machineJournalHeadHash) errors.push("current machine journal head does not match candidate");
  if (options.currentMachineOwnershipEpoch !== undefined && options.currentMachineOwnershipEpoch !== candidate.machineOwnershipEpoch) errors.push("current machine ownership epoch does not match candidate");
  if (options.currentMachineControlWorkspaceRootHash !== undefined && options.currentMachineControlWorkspaceRootHash !== candidate.machineControlWorkspaceRootHash) errors.push("current machine control workspace does not match candidate");
  return {
    schema: "wheel.zob.pr-handoff-validation.v1",
    valid: errors.length === 0,
    errors,
    candidateHash: candidate.candidateHash,
    authorityHash: sha256Canonical(authority),
    allowedActions: errors.length === 0 ? [...authority.allowedActions] : [],
    mergeEnabled: false,
    promotionEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  };
}

function commitReceiptPayload(receipt: WheelPrHandoffCommitReceipt): Omit<WheelPrHandoffCommitReceipt, "receiptHash"> {
  const { receiptHash: _receiptHash, ...payload } = receipt;
  return payload;
}

export function hashWheelPrHandoffCommitReceipt(receipt: WheelPrHandoffCommitReceipt): string {
  return sha256Canonical(commitReceiptPayload(receipt));
}

export function validateWheelPrHandoffCommitReceipt(
  receipt: WheelPrHandoffCommitReceipt,
  preCommitCandidate: WheelPrHandoffCandidate,
  commitAuthority: WheelPrHandoffAuthority,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  try {
    assertBodySafe(receipt);
    exactKeys(receipt as unknown as Record<string, unknown>, [
      "schema", "receiptId", "receiptHash", "launchId", "machineId", "workspaceClaimId", "machineJournalHeadHash",
      "machineOwnershipEpoch", "storyWorkspaceRootHash", "storyIds", "branchName", "baseRef", "baseSha", "committedHeadSha",
      "treeHash", "contentHash", "diffHash", "preCommitCandidateId", "preCommitCandidateHash", "commitAuthorityId",
      "commitAuthorityHash", "governedCommitEvidenceRef", "governedCommitEvidenceHash", "recordedAt", "pushEnabled",
      "githubEffectsEnabled", "mergeEnabled", "promotionEnabled", "deploymentEnabled", "bodyStored",
    ], "commitReceipt", errors);
    assertSafeSupervisorId(receipt.receiptId, "receiptId");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (receipt.schema !== "wheel.zob.pr-handoff-commit-receipt.v1") errors.push("commit receipt schema is invalid");
  if (preCommitCandidate.phase !== "pre-commit") errors.push("commit receipt requires a pre-commit candidate");
  if (commitAuthority.phase !== "pre-commit" || !commitAuthority.allowedActions.includes("commit")) errors.push("commit receipt requires commit authority");
  const bindings: Array<[string, unknown, unknown]> = [
    ["launchId", receipt.launchId, preCommitCandidate.launchId],
    ["machineId", receipt.machineId, preCommitCandidate.machineId],
    ["workspaceClaimId", receipt.workspaceClaimId, preCommitCandidate.workspaceClaimId],
    ["machineJournalHeadHash", receipt.machineJournalHeadHash, preCommitCandidate.machineJournalHeadHash],
    ["machineOwnershipEpoch", receipt.machineOwnershipEpoch, preCommitCandidate.machineOwnershipEpoch],
    ["storyWorkspaceRootHash", receipt.storyWorkspaceRootHash, preCommitCandidate.storyWorkspaceRootHash],
    ["storyIds", sha256Canonical(receipt.storyIds), sha256Canonical(preCommitCandidate.storyIds)],
    ["branchName", receipt.branchName, preCommitCandidate.branchName],
    ["baseRef", receipt.baseRef, preCommitCandidate.baseRef],
    ["baseSha", receipt.baseSha, preCommitCandidate.headSha],
    ["contentHash", receipt.contentHash, preCommitCandidate.contentHash],
    ["preCommitCandidateId", receipt.preCommitCandidateId, preCommitCandidate.candidateId],
    ["preCommitCandidateHash", receipt.preCommitCandidateHash, preCommitCandidate.candidateHash],
    ["commitAuthorityId", receipt.commitAuthorityId, commitAuthority.authorityId],
    ["commitAuthorityHash", receipt.commitAuthorityHash, sha256Canonical(commitAuthority)],
  ];
  for (const [label, actual, expected] of bindings) if (actual !== expected) errors.push(`commit receipt ${label} does not match its lineage`);
  for (const [label, value] of [
    ["receiptHash", receipt.receiptHash], ["machineJournalHeadHash", receipt.machineJournalHeadHash], ["storyWorkspaceRootHash", receipt.storyWorkspaceRootHash],
    ["treeHash", receipt.treeHash], ["contentHash", receipt.contentHash], ["diffHash", receipt.diffHash], ["preCommitCandidateHash", receipt.preCommitCandidateHash],
    ["commitAuthorityHash", receipt.commitAuthorityHash], ["governedCommitEvidenceHash", receipt.governedCommitEvidenceHash],
  ] as const) if (!SHA64.test(value) && !(label === "treeHash" && GIT_OBJECT_ID.test(value))) errors.push(`${label} is invalid`);
  if (!GIT_OBJECT_ID.test(receipt.baseSha) || !GIT_OBJECT_ID.test(receipt.committedHeadSha) || receipt.baseSha === receipt.committedHeadSha) errors.push("commit receipt head lineage is invalid");
  if (!safeRepoRef(receipt.governedCommitEvidenceRef)) errors.push("governedCommitEvidenceRef is unsafe");
  const recordedAt = Date.parse(receipt.recordedAt);
  if (!Number.isFinite(recordedAt) || recordedAt < Date.parse(commitAuthority.issuedAt) || recordedAt >= Date.parse(commitAuthority.expiresAt)) errors.push("commit receipt must be recorded during commit authority lifetime");
  if (receipt.pushEnabled !== false || receipt.githubEffectsEnabled !== false || receipt.mergeEnabled !== false || receipt.promotionEnabled !== false || receipt.deploymentEnabled !== false || receipt.bodyStored !== false) {
    errors.push("commit receipt must not grant push, GitHub, merge, promotion, or deployment effects");
  }
  if (SHA64.test(receipt.receiptHash) && hashWheelPrHandoffCommitReceipt(receipt) !== receipt.receiptHash) errors.push("commit receipt hash mismatch");
  return { valid: errors.length === 0, errors };
}

export function persistWheelPrHandoffCommitReceipt(repoRoot: string, receipt: WheelPrHandoffCommitReceipt): { receiptRef: string; replay: boolean } {
  const preCandidate = loadWheelPrHandoffCandidate(repoRoot, receipt.launchId, receipt.preCommitCandidateId, { allowExpired: true });
  const authority = loadWheelPrHandoffAuthority(repoRoot, receipt.launchId, receipt.commitAuthorityId, { allowExpired: true });
  const validation = validateWheelPrHandoffCommitReceipt(receipt, preCandidate, authority);
  if (!validation.valid) throw new Error(`invalid PR handoff commit receipt: ${validation.errors.join("; ")}`);
  const path = resolve(resolveWheelLocalLaunchDirectory(repoRoot, receipt.launchId), "pr-handoffs", `${receipt.receiptId}.commit-receipt.json`);
  const receiptRef = relative(resolve(repoRoot), path).split("\\").join("/");
  if (existsSync(path)) {
    const existing = readJson<WheelPrHandoffCommitReceipt>(path);
    if (existing.receiptHash !== receipt.receiptHash || hashWheelPrHandoffCommitReceipt(existing) !== existing.receiptHash) throw new Error(`commit receipt ${receipt.receiptId} already exists with different or corrupted content`);
    return { receiptRef, replay: true };
  }
  writeAtomic(path, receipt);
  return { receiptRef, replay: false };
}

export function loadWheelPrHandoffCommitReceipt(repoRoot: string, launchId: string, receiptId: string): WheelPrHandoffCommitReceipt {
  assertSafeSupervisorId(launchId, "launchId");
  assertSafeSupervisorId(receiptId, "receiptId");
  const path = resolve(resolveWheelLocalLaunchDirectory(repoRoot, launchId), "pr-handoffs", `${receiptId}.commit-receipt.json`);
  if (!existsSync(path)) throw new Error(`PR handoff commit receipt ${receiptId} does not exist`);
  const receipt = readJson<WheelPrHandoffCommitReceipt>(path);
  const candidate = loadWheelPrHandoffCandidate(repoRoot, launchId, receipt.preCommitCandidateId, { allowExpired: true });
  const authority = loadWheelPrHandoffAuthority(repoRoot, launchId, receipt.commitAuthorityId, { allowExpired: true });
  const validation = validateWheelPrHandoffCommitReceipt(receipt, candidate, authority);
  if (!validation.valid) throw new Error(`invalid PR handoff commit receipt: ${validation.errors.join("; ")}`);
  return receipt;
}

interface GovernedZcommitReceipt {
  schema: "zob.zcommit-receipt.v1";
  receiptHash: string;
  action: "commit";
  status: "ok";
  repositoryRootHash: string;
  baseHeadSha: string;
  committedHeadSha: string;
  treeHash: string;
  branchHash: string;
  eligiblePathHashes: string[];
  handoffCandidateHash: string;
  handoffAuthorityHash: string;
  handoffExpectedBaseSha: string;
  userRequested: true;
  validationOk: true;
  actualGitCommitRun: true;
  actualGitPushRun: false;
  generatedAt: string;
  bodyStored: false;
}

function validateGovernedZcommitReceipt(input: {
  storyWorkspaceRoot: string;
  evidenceRef: string;
  evidenceHash: string;
  candidate: WheelPrHandoffCandidate;
  authority: WheelPrHandoffAuthority;
  snapshot: WheelPrHandoffWorkspaceSnapshot;
}): GovernedZcommitReceipt {
  if (!/^\.pi\/logs\/zcommit-receipts\/(?:[a-f0-9]{40}|[a-f0-9]{64})\.json$/.test(input.evidenceRef)) {
    throw new Error("governed commit evidence must be a .pi/logs/zcommit-receipts/<commit>.json artifact");
  }
  if (!SHA64.test(input.evidenceHash)) throw new Error("governed commit evidence hash must be a lowercase sha256");
  const expectedRef = `.pi/logs/zcommit-receipts/${input.snapshot.headSha}.json`;
  if (input.evidenceRef !== expectedRef) throw new Error("governed zcommit receipt ref must name the exact committed HEAD");
  const root = realpathSync(resolve(input.storyWorkspaceRoot));
  const path = resolve(root, input.evidenceRef);
  if (relative(root, path).split("\\").join("/").startsWith("../") || !existsSync(path)) throw new Error("governed zcommit receipt is missing or outside the story workspace");
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error("governed zcommit receipt path must not traverse symlinks");
  const raw = readFileSync(path, "utf8");
  if (sha256Text(raw) !== input.evidenceHash) throw new Error("governed zcommit receipt file hash mismatch");
  let receipt: GovernedZcommitReceipt;
  try {
    receipt = JSON.parse(raw) as GovernedZcommitReceipt;
  } catch {
    throw new Error("governed zcommit receipt is invalid JSON");
  }
  const errors: string[] = [];
  try {
    assertBodySafe(receipt);
    exactKeys(receipt as unknown as Record<string, unknown>, [
      "schema", "receiptHash", "action", "status", "repositoryRootHash", "baseHeadSha", "committedHeadSha", "treeHash",
      "branchHash", "eligiblePathHashes", "handoffCandidateHash", "handoffAuthorityHash", "handoffExpectedBaseSha",
      "userRequested", "validationOk", "actualGitCommitRun", "actualGitPushRun", "generatedAt", "bodyStored",
    ], "zcommitReceipt", errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const { receiptHash: _receiptHash, ...payload } = receipt;
  const expectedPathHashes = input.candidate.changedPaths.map((pathRef) => sha256Text(pathRef)).sort();
  const bindings: Array<[string, unknown, unknown]> = [
    ["schema", receipt.schema, "zob.zcommit-receipt.v1"],
    ["action", receipt.action, "commit"],
    ["status", receipt.status, "ok"],
    ["repositoryRootHash", receipt.repositoryRootHash, input.snapshot.workspaceRootHash],
    ["baseHeadSha", receipt.baseHeadSha, input.candidate.headSha],
    ["committedHeadSha", receipt.committedHeadSha, input.snapshot.headSha],
    ["treeHash", receipt.treeHash, input.snapshot.treeHash],
    ["branchHash", receipt.branchHash, sha256Text(input.candidate.branchName)],
    ["eligiblePathHashes", sha256Canonical(receipt.eligiblePathHashes), sha256Canonical(expectedPathHashes)],
    ["handoffCandidateHash", receipt.handoffCandidateHash, input.candidate.candidateHash],
    ["handoffAuthorityHash", receipt.handoffAuthorityHash, sha256Canonical(input.authority)],
    ["handoffExpectedBaseSha", receipt.handoffExpectedBaseSha, input.candidate.headSha],
    ["userRequested", receipt.userRequested, true],
    ["validationOk", receipt.validationOk, true],
    ["actualGitCommitRun", receipt.actualGitCommitRun, true],
    ["actualGitPushRun", receipt.actualGitPushRun, false],
    ["bodyStored", receipt.bodyStored, false],
  ];
  for (const [label, actual, expected] of bindings) if (actual !== expected) errors.push(`zcommit receipt ${label} does not match governed commit`);
  if (!SHA64.test(receipt.receiptHash) || sha256Canonical(payload) !== receipt.receiptHash) errors.push("zcommit receipt internal hash mismatch");
  const generatedAt = Date.parse(receipt.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt < Date.parse(input.authority.issuedAt) || generatedAt >= Date.parse(input.authority.expiresAt)) errors.push("zcommit receipt must be generated during commit authority lifetime");
  if (errors.length > 0) throw new Error(`invalid governed zcommit receipt: ${errors.join("; ")}`);
  return receipt;
}

export function recordWheelPrHandoffCommitReceiptFromWorkspace(
  controlRepoRoot: string,
  input: {
    launchId: string;
    receiptId: string;
    preCommitCandidateId: string;
    commitAuthorityId: string;
    storyWorkspaceRoot: string;
    governedCommitEvidenceRef: string;
    governedCommitEvidenceHash: string;
    recordedAt?: string;
  },
): { receipt: WheelPrHandoffCommitReceipt; receiptRef: string; replay: boolean; snapshot: WheelPrHandoffWorkspaceSnapshot } {
  assertSafeSupervisorId(input.receiptId, "receiptId");
  const candidate = loadWheelPrHandoffCandidate(controlRepoRoot, input.launchId, input.preCommitCandidateId);
  const authority = loadWheelPrHandoffAuthority(controlRepoRoot, input.launchId, input.commitAuthorityId);
  const machineStatus = new FileWheelLocalMachineLaunchStore(controlRepoRoot, input.launchId, candidate.machineId).status(input.recordedAt);
  if (!machineStatus.valid || !machineStatus.checkpointCurrent || !machineStatus.ownershipLive || !machineStatus.claim) throw new Error("current machine state is not valid, checkpointed, live, and claimed for commit receipt");
  const machineBindings = [
    machineStatus.claim.claimId === candidate.workspaceClaimId,
    machineStatus.journalHeadHash === candidate.machineJournalHeadHash,
    machineStatus.claim.ownershipEpoch === candidate.machineOwnershipEpoch,
    machineStatus.claim.workspaceRootHash === candidate.machineControlWorkspaceRootHash,
  ];
  if (machineBindings.some((match) => !match)) throw new Error("current machine claim, journal, epoch, or control workspace does not match pre-commit candidate");
  const authorityValidation = validateWheelPrHandoffAuthority(candidate, authority, {
    now: input.recordedAt,
    currentMachineClaimId: machineStatus.claim.claimId,
    currentMachineJournalHeadHash: machineStatus.journalHeadHash,
    currentMachineOwnershipEpoch: machineStatus.claim.ownershipEpoch,
    currentMachineControlWorkspaceRootHash: machineStatus.claim.workspaceRootHash,
  });
  if (!authorityValidation.valid || !authorityValidation.allowedActions.includes("commit")) throw new Error(`commit authority is invalid: ${authorityValidation.errors.join("; ")}`);
  const snapshot = inspectWheelPrHandoffWorkspace(input.storyWorkspaceRoot, { phase: "post-commit", baseSha: candidate.headSha, sourceSha: candidate.sourceSha });
  if (snapshot.workspaceRootHash !== candidate.storyWorkspaceRootHash || snapshot.branchName !== candidate.branchName || snapshot.contentHash !== candidate.contentHash) {
    throw new Error("committed story workspace root, branch, or content does not match the authorized pre-commit candidate");
  }
  validateGovernedZcommitReceipt({
    storyWorkspaceRoot: input.storyWorkspaceRoot,
    evidenceRef: input.governedCommitEvidenceRef,
    evidenceHash: input.governedCommitEvidenceHash,
    candidate,
    authority,
    snapshot,
  });
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const payload: Omit<WheelPrHandoffCommitReceipt, "receiptHash"> = {
    schema: "wheel.zob.pr-handoff-commit-receipt.v1",
    receiptId: input.receiptId,
    launchId: candidate.launchId,
    machineId: candidate.machineId,
    workspaceClaimId: candidate.workspaceClaimId,
    machineJournalHeadHash: candidate.machineJournalHeadHash,
    machineOwnershipEpoch: candidate.machineOwnershipEpoch,
    storyWorkspaceRootHash: candidate.storyWorkspaceRootHash,
    storyIds: [...candidate.storyIds],
    branchName: candidate.branchName,
    baseRef: candidate.baseRef,
    baseSha: candidate.headSha,
    committedHeadSha: snapshot.headSha,
    treeHash: snapshot.treeHash,
    contentHash: snapshot.contentHash,
    diffHash: snapshot.diffHash,
    preCommitCandidateId: candidate.candidateId,
    preCommitCandidateHash: candidate.candidateHash,
    commitAuthorityId: authority.authorityId,
    commitAuthorityHash: sha256Canonical(authority),
    governedCommitEvidenceRef: input.governedCommitEvidenceRef,
    governedCommitEvidenceHash: input.governedCommitEvidenceHash,
    recordedAt,
    pushEnabled: false,
    githubEffectsEnabled: false,
    mergeEnabled: false,
    promotionEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  };
  const receipt: WheelPrHandoffCommitReceipt = { ...payload, receiptHash: sha256Canonical(payload) };
  const validation = validateWheelPrHandoffCommitReceipt(receipt, candidate, authority);
  if (!validation.valid) throw new Error(`invalid PR handoff commit receipt: ${validation.errors.join("; ")}`);
  const persisted = persistWheelPrHandoffCommitReceipt(controlRepoRoot, receipt);
  return { receipt, receiptRef: persisted.receiptRef, replay: persisted.replay, snapshot };
}

export function prepareWheelPrHandoffCandidateFromWorkspace(
  controlRepoRoot: string,
  input: {
    launchId: string;
    machineId: string;
    candidateId: string;
    phase: "pre-commit" | "post-commit";
    storyIds: string[];
    storyWorkspaceRoot: string;
    baseRef: string;
    commitReceiptId?: string;
    evidenceRefs: string[];
    evidenceHashes: string[];
    requestedActions: WheelPrHandoffAction[];
    preparedAt?: string;
    ttlMs?: number;
  },
): {
  candidate: WheelPrHandoffCandidate;
  snapshot: WheelPrHandoffWorkspaceSnapshot;
  candidateRef: string;
  replay: boolean;
} {
  const plan = loadWheelLocalMachineLaunchPlan(controlRepoRoot, input.launchId, { now: input.preparedAt });
  const machineStatus = new FileWheelLocalMachineLaunchStore(controlRepoRoot, input.launchId, input.machineId).status(input.preparedAt);
  if (!machineStatus.valid) throw new Error(`local machine journal is invalid: ${machineStatus.issueCodes.join("; ")}`);
  if (!machineStatus.checkpointCurrent) throw new Error("local machine checkpoint must be current before PR handoff preparation");
  if (!machineStatus.ownershipLive) throw new Error("local machine ownership must be live before PR handoff preparation");
  if (!machineStatus.claim) throw new Error("local machine claim is missing");
  const commitReceipt = input.phase === "post-commit"
    ? (input.commitReceiptId ? loadWheelPrHandoffCommitReceipt(controlRepoRoot, input.launchId, input.commitReceiptId) : undefined)
    : undefined;
  if (input.phase === "post-commit" && !commitReceipt) throw new Error("post-commit PR handoff requires an exact governed commit receipt");
  const baseSha = input.phase === "pre-commit" ? undefined : commitReceipt?.baseSha;
  const snapshot = inspectWheelPrHandoffWorkspace(input.storyWorkspaceRoot, { phase: input.phase, baseSha, sourceSha: plan.sourceSha });
  if (commitReceipt) {
    if (
      commitReceipt.machineId !== input.machineId
      || commitReceipt.workspaceClaimId !== machineStatus.claim.claimId
      || commitReceipt.machineJournalHeadHash !== machineStatus.journalHeadHash
      || commitReceipt.machineOwnershipEpoch !== machineStatus.claim.ownershipEpoch
      || sha256Canonical(commitReceipt.storyIds) !== sha256Canonical(input.storyIds)
      || commitReceipt.branchName !== snapshot.branchName
      || commitReceipt.baseRef !== input.baseRef
      || commitReceipt.storyWorkspaceRootHash !== snapshot.workspaceRootHash
      || commitReceipt.committedHeadSha !== snapshot.headSha
      || commitReceipt.contentHash !== snapshot.contentHash
      || commitReceipt.diffHash !== snapshot.diffHash
    ) throw new Error("post-commit workspace or machine state does not match governed commit receipt");
  }
  const candidateBaseSha = input.phase === "pre-commit" ? snapshot.headSha : commitReceipt?.baseSha;
  if (!candidateBaseSha) throw new Error("post-commit PR handoff requires the exact pre-commit base sha");
  const candidate = prepareWheelPrHandoffCandidate(plan, machineStatus.claim, {
    candidateId: input.candidateId,
    phase: input.phase,
    storyIds: input.storyIds,
    machineJournalHeadHash: machineStatus.journalHeadHash,
    machineOwnershipEpoch: machineStatus.claim.ownershipEpoch,
    storyWorkspaceRootHash: snapshot.workspaceRootHash,
    priorPreCommitCandidateId: commitReceipt?.preCommitCandidateId,
    priorPreCommitCandidateHash: commitReceipt?.preCommitCandidateHash,
    commitAuthorityId: commitReceipt?.commitAuthorityId,
    commitAuthorityHash: commitReceipt?.commitAuthorityHash,
    commitReceiptId: commitReceipt?.receiptId,
    commitReceiptHash: commitReceipt?.receiptHash,
    branchName: snapshot.branchName,
    baseRef: input.baseRef,
    baseSha: candidateBaseSha,
    headSha: snapshot.headSha,
    treeHash: snapshot.treeHash,
    contentHash: snapshot.contentHash,
    diffHash: snapshot.diffHash,
    changedPaths: snapshot.changedPaths,
    evidenceRefs: input.evidenceRefs,
    evidenceHashes: input.evidenceHashes,
    requestedActions: input.requestedActions,
    preparedAt: input.preparedAt,
    ttlMs: input.ttlMs,
  });
  const persisted = persistWheelPrHandoffCandidate(controlRepoRoot, candidate);
  return { candidate, snapshot, candidateRef: persisted.candidateRef, replay: persisted.replay };
}

export interface WheelPrHandoffStatus {
  schema: "wheel.zob.pr-handoff-status.v1";
  launchId: string;
  candidateId: string;
  phase: WheelPrHandoffCandidate["phase"];
  headSha: string;
  contentHash: string;
  candidateCurrent: boolean;
  machineCurrent: boolean;
  authorityId?: string;
  allowedActions: WheelPrHandoffAction[];
  authorityValid: boolean;
  errors: string[];
  bodyStored: false;
}

export function inspectWheelPrHandoffStatus(controlRepoRoot: string, input: {
  launchId: string;
  candidateId: string;
  storyWorkspaceRoot: string;
  authorityId?: string;
  now?: Date;
}): WheelPrHandoffStatus {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const candidate = loadWheelPrHandoffCandidate(controlRepoRoot, input.launchId, input.candidateId, { now: nowIso, allowExpired: true });
  const snapshot = inspectWheelPrHandoffWorkspace(input.storyWorkspaceRoot, {
    phase: candidate.phase,
    baseSha: candidate.phase === "post-commit" ? candidate.baseSha : undefined,
    sourceSha: candidate.sourceSha,
  });
  const candidateCurrent = snapshot.workspaceRootHash === candidate.storyWorkspaceRootHash
    && snapshot.branchName === candidate.branchName
    && snapshot.headSha === candidate.headSha
    && snapshot.contentHash === candidate.contentHash
    && snapshot.diffHash === candidate.diffHash
    && sha256Canonical(snapshot.changedPaths) === sha256Canonical(candidate.changedPaths);
  const machineStatus = new FileWheelLocalMachineLaunchStore(controlRepoRoot, candidate.launchId, candidate.machineId).status(now.toISOString());
  const machineCurrent = machineStatus.valid
    && machineStatus.checkpointCurrent
    && machineStatus.ownershipLive
    && machineStatus.claim?.claimId === candidate.workspaceClaimId
    && machineStatus.journalHeadHash === candidate.machineJournalHeadHash
    && machineStatus.claim?.ownershipEpoch === candidate.machineOwnershipEpoch
    && machineStatus.claim?.workspaceRootHash === candidate.machineControlWorkspaceRootHash;
  const errors: string[] = [
    ...(candidateCurrent ? [] : ["candidate-workspace-not-current"]),
    ...(!machineStatus.valid ? machineStatus.issueCodes : []),
    ...(!machineStatus.checkpointCurrent ? ["machine-checkpoint-not-current"] : []),
    ...(!machineStatus.ownershipLive ? ["machine-ownership-not-live"] : []),
    ...(machineCurrent ? [] : ["machine-authority-lineage-not-current"]),
  ];
  let authority: WheelPrHandoffAuthority | undefined;
  let validation: WheelPrHandoffValidation | undefined;
  if (input.authorityId) {
    try {
      authority = loadWheelPrHandoffAuthority(controlRepoRoot, input.launchId, input.authorityId, { now: nowIso, allowExpired: true });
      validation = validateWheelPrHandoffAuthority(candidate, authority, { now: nowIso });
      errors.push(...validation.errors);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const authorityValid = Boolean(authority && validation?.valid && candidateCurrent && machineCurrent);
  return {
    schema: "wheel.zob.pr-handoff-status.v1",
    launchId: candidate.launchId,
    candidateId: candidate.candidateId,
    phase: candidate.phase,
    headSha: candidate.headSha,
    contentHash: candidate.contentHash,
    candidateCurrent,
    machineCurrent,
    authorityId: authority?.authorityId,
    allowedActions: authorityValid ? validation?.allowedActions ?? [] : [],
    authorityValid,
    errors: [...new Set(errors)],
    bodyStored: false,
  };
}

export function persistWheelPrHandoffCandidate(repoRoot: string, candidate: WheelPrHandoffCandidate): { candidateRef: string; replay: boolean } {
  const validation = validateWheelPrHandoffCandidate(candidate, { allowExpired: true });
  if (!validation.valid) throw new Error(`invalid PR handoff candidate: ${validation.errors.join("; ")}`);
  const directory = resolve(resolveWheelLocalLaunchDirectory(repoRoot, candidate.launchId), "pr-handoffs");
  const path = resolve(directory, `${candidate.candidateId}.candidate.json`);
  const candidateRef = relative(resolve(repoRoot), path).split("\\").join("/");
  if (existsSync(path)) {
    const existing = readJson<WheelPrHandoffCandidate>(path);
    if (existing.candidateHash !== candidate.candidateHash || !validateWheelPrHandoffCandidate(existing, { allowExpired: true }).valid) {
      throw new Error(`PR handoff candidate ${candidate.candidateId} already exists with different or corrupted content`);
    }
    return { candidateRef, replay: true };
  }
  writeAtomic(path, candidate);
  return { candidateRef, replay: false };
}

export function loadWheelPrHandoffCandidate(repoRoot: string, launchId: string, candidateId: string, options: { allowExpired?: boolean; now?: string } = {}): WheelPrHandoffCandidate {
  assertSafeSupervisorId(launchId, "launchId");
  assertSafeSupervisorId(candidateId, "candidateId");
  const path = resolve(resolveWheelLocalLaunchDirectory(repoRoot, launchId), "pr-handoffs", `${candidateId}.candidate.json`);
  if (!existsSync(path)) throw new Error(`PR handoff candidate ${candidateId} does not exist`);
  const candidate = readJson<WheelPrHandoffCandidate>(path);
  const validation = validateWheelPrHandoffCandidate(candidate, options);
  if (!validation.valid) throw new Error(`invalid PR handoff candidate: ${validation.errors.join("; ")}`);
  return candidate;
}

export function authorizeWheelPrHandoffFromWorkspace(
  controlRepoRoot: string,
  input: {
    launchId: string;
    candidateId: string;
    authorityId: string;
    actorId: string;
    allowedActions: WheelPrHandoffAction[];
    confirmationPhrase: string;
    candidateHash: string;
    expectedHeadSha: string;
    storyWorkspaceRoot: string;
    issuedAt?: string;
    ttlMs?: number;
  },
): {
  authority: WheelPrHandoffAuthority;
  validation: WheelPrHandoffValidation;
  authorityRef: string;
  replay: boolean;
} {
  const candidate = loadWheelPrHandoffCandidate(controlRepoRoot, input.launchId, input.candidateId);
  if (input.candidateHash !== candidate.candidateHash) throw new Error("authorization candidate hash is stale or incorrect");
  if (input.expectedHeadSha !== candidate.headSha) throw new Error("authorization expected head is stale or incorrect");
  const machineStatus = new FileWheelLocalMachineLaunchStore(controlRepoRoot, input.launchId, candidate.machineId).status(input.issuedAt);
  if (!machineStatus.valid || !machineStatus.checkpointCurrent || !machineStatus.ownershipLive || !machineStatus.claim) {
    throw new Error("current machine state is not valid, checkpointed, live, and claimed for PR handoff authorization");
  }
  if (
    machineStatus.claim.claimId !== candidate.workspaceClaimId
    || machineStatus.journalHeadHash !== candidate.machineJournalHeadHash
    || machineStatus.claim.ownershipEpoch !== candidate.machineOwnershipEpoch
    || machineStatus.claim.workspaceRootHash !== candidate.machineControlWorkspaceRootHash
  ) throw new Error("current machine claim, journal, epoch, or control workspace does not match candidate");
  const snapshot = inspectWheelPrHandoffWorkspace(input.storyWorkspaceRoot, { phase: candidate.phase, baseSha: candidate.phase === "post-commit" ? candidate.baseSha : undefined, sourceSha: candidate.sourceSha });
  const authority = createWheelPrHandoffAuthority(candidate, {
    authorityId: input.authorityId,
    actorId: input.actorId,
    allowedActions: input.allowedActions,
    confirmationPhrase: input.confirmationPhrase,
    issuedAt: input.issuedAt,
    ttlMs: input.ttlMs,
  });
  const validation = validateWheelPrHandoffAuthority(candidate, authority, {
    now: input.issuedAt,
    currentBaseSha: candidate.baseSha,
    currentHeadSha: snapshot.headSha,
    currentContentHash: snapshot.contentHash,
    currentDiffHash: snapshot.diffHash,
    currentBranchName: snapshot.branchName,
    currentStoryWorkspaceRootHash: snapshot.workspaceRootHash,
    currentMachineClaimId: machineStatus.claim.claimId,
    currentMachineJournalHeadHash: machineStatus.journalHeadHash,
    currentMachineOwnershipEpoch: machineStatus.claim.ownershipEpoch,
    currentMachineControlWorkspaceRootHash: machineStatus.claim.workspaceRootHash,
  });
  if (!validation.valid) throw new Error(`PR handoff authority is invalid: ${validation.errors.join("; ")}`);
  const persisted = persistWheelPrHandoffAuthority(controlRepoRoot, authority);
  return { authority, validation, authorityRef: persisted.authorityRef, replay: persisted.replay };
}

export function persistWheelPrHandoffAuthority(repoRoot: string, authority: WheelPrHandoffAuthority): { authorityRef: string; replay: boolean } {
  const candidate = loadWheelPrHandoffCandidate(repoRoot, authority.launchId, authority.candidateId);
  const validation = validateWheelPrHandoffAuthority(candidate, authority);
  if (!validation.valid) throw new Error(`invalid PR handoff authority: ${validation.errors.join("; ")}`);
  const directory = resolve(resolveWheelLocalLaunchDirectory(repoRoot, authority.launchId), "pr-handoffs");
  const path = resolve(directory, `${authority.authorityId}.authority.json`);
  const authorityRef = relative(resolve(repoRoot), path).split("\\").join("/");
  if (existsSync(path)) {
    const existing = readJson<WheelPrHandoffAuthority>(path);
    if (sha256Canonical(existing) !== sha256Canonical(authority)) throw new Error(`PR handoff authority ${authority.authorityId} already exists with different content`);
    return { authorityRef, replay: true };
  }
  assertBodySafe(authority);
  writeAtomic(path, authority);
  return { authorityRef, replay: false };
}

export function loadWheelPrHandoffAuthority(repoRoot: string, launchId: string, authorityId: string, options: { allowExpired?: boolean; now?: string } = {}): WheelPrHandoffAuthority {
  assertSafeSupervisorId(launchId, "launchId");
  assertSafeSupervisorId(authorityId, "authorityId");
  const path = resolve(resolveWheelLocalLaunchDirectory(repoRoot, launchId), "pr-handoffs", `${authorityId}.authority.json`);
  if (!existsSync(path)) throw new Error(`PR handoff authority ${authorityId} does not exist`);
  const authority = readJson<WheelPrHandoffAuthority>(path);
  assertBodySafe(authority);
  if (authority.schema !== "wheel.zob.pr-handoff-authority.v1" || authority.launchId !== launchId || authority.authorityId !== authorityId) {
    throw new Error("PR handoff authority identity is invalid");
  }
  const candidate = loadWheelPrHandoffCandidate(repoRoot, launchId, authority.candidateId, options);
  const validation = validateWheelPrHandoffAuthority(candidate, authority, options);
  if (!validation.valid) throw new Error(`invalid PR handoff authority: ${validation.errors.join("; ")}`);
  return authority;
}

export function assertWheelLocalPlanUnchanged(plan: WheelLocalMachineLaunchPlan): void {
  if (hashWheelLocalMachineLaunchPlan(plan) !== plan.planHash) throw new Error("local launch plan changed after preparation");
}
