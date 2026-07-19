import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { assertSafeSupervisorId, sha256Canonical } from "../supervisor/canonical.js";
import { prepareWheelSupervisorFromMachineBundle } from "../supervisor/launcher-preparation.js";
import { assertBodySafe, readJson, writeAtomic } from "../supervisor/store-persistence.js";
import type { WheelSupervisorAdmissionInput } from "../supervisor/types.js";
import type {
  WheelLocalLaunchAuthorityBoundary,
  WheelLocalMachineLaunchAssignment,
  WheelLocalMachineLaunchPlan,
  WheelLocalMachineLaunchPreparation,
} from "./types.js";

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const MAX_LAUNCH_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_LAUNCH_TTL_MS = 24 * 60 * 60 * 1_000;

export const WHEEL_LOCAL_LAUNCH_AUTHORITY_BOUNDARY: WheelLocalLaunchAuthorityBoundary = Object.freeze({
  schema: "wheel.zob.local-launch-authority-boundary.v1",
  scope: "local-edit-test-review",
  activationEnabled: false,
  explicitMachineStartRequired: true,
  modelSessionAllowedAfterExplicitStart: true,
  localSourceEditsAllowedAfterExplicitStart: true,
  localTestsAllowedAfterExplicitStart: true,
  localReviewAllowedAfterExplicitStart: true,
  arbitraryNetworkAccessEnabled: false,
  commitEnabled: false,
  pushEnabled: false,
  githubEffectsEnabled: false,
  draftPrEnabled: false,
  workflowDispatchEnabled: false,
  mergeEnabled: false,
  promotionEnabled: false,
  deploymentEnabled: false,
  bodyStored: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) if (!allowedSet.has(key)) errors.push(`${label}.${key} is not allowed`);
  for (const key of allowed) if (!(key in record)) errors.push(`${label}.${key} is required`);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function safeRepoRef(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

function planPayload(plan: WheelLocalMachineLaunchPlan): Omit<WheelLocalMachineLaunchPlan, "planHash"> {
  const { planHash: _planHash, ...payload } = plan;
  return payload;
}

function assignmentPayload(
  assignment: WheelLocalMachineLaunchAssignment,
): Omit<WheelLocalMachineLaunchAssignment, "assignmentHash"> {
  const { assignmentHash: _assignmentHash, ...payload } = assignment;
  return payload;
}

export function hashWheelLocalMachineLaunchPlan(plan: WheelLocalMachineLaunchPlan): string {
  return sha256Canonical(planPayload(plan));
}

export function hashWheelLocalMachineLaunchAssignment(assignment: WheelLocalMachineLaunchAssignment): string {
  return sha256Canonical(assignmentPayload(assignment));
}

export function wheelLocalMachineStartConfirmation(plan: WheelLocalMachineLaunchPlan, machineId: string): string {
  return `START WHEEL LOCAL ${plan.launchId} MACHINE ${machineId} PLAN ${plan.planHash}`;
}

export function resolveWheelLocalLaunchDirectory(repoRoot: string, launchId: string): string {
  assertSafeSupervisorId(launchId, "launchId");
  const root = resolve(repoRoot);
  const resolved = resolve(root, "reports", "wheel-zob", "local-launches", launchId);
  const rel = relative(root, resolved).split("\\").join("/");
  if (rel.startsWith("../") || rel === ".." || !rel.startsWith("reports/wheel-zob/local-launches/")) {
    throw new Error("local launch directory must stay under reports/wheel-zob/local-launches/");
  }
  return resolved;
}

export function validateWheelLocalMachineLaunchPlan(
  value: unknown,
  options: { now?: string; allowExpired?: boolean } = {},
): { valid: boolean; errors: string[]; value?: WheelLocalMachineLaunchPlan } {
  const errors: string[] = [];
  try {
    assertBodySafe(value);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(value)) {
    errors.push("launch plan must be an object");
    return { valid: false, errors };
  }
  exactKeys(value, [
    "schema", "launchId", "missionId", "bundlePath", "bundleId", "bundleHash", "sourceSha", "repositoryId",
    "selectedMachineIds", "allocationUnitCount", "storyIds", "preparedAt", "expiresAt", "planHash", "assignments",
    "launchMechanism", "authorityBoundary", "prHandoff", "bodyStored",
  ], "launchPlan", errors);
  if (value.schema !== "wheel.zob.local-machine-launch-plan.v1") errors.push("launch plan schema is invalid");
  for (const key of ["launchId", "missionId", "bundlePath", "bundleId", "bundleHash", "sourceSha", "repositoryId", "preparedAt", "expiresAt", "planHash"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) errors.push(`${key} must be a non-empty string`);
  }
  if (typeof value.launchId === "string") {
    try {
      assertSafeSupervisorId(value.launchId, "launchId");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (typeof value.bundlePath === "string" && !safeRepoRef(value.bundlePath)) errors.push("bundlePath must be a safe repo-relative ref");
  if (typeof value.bundleHash === "string" && !SHA64.test(value.bundleHash)) errors.push("bundleHash must be a lowercase sha256");
  if (typeof value.sourceSha === "string" && !SHA40.test(value.sourceSha)) errors.push("sourceSha must be a lowercase git sha");
  if (typeof value.planHash === "string" && !SHA64.test(value.planHash)) errors.push("planHash must be a lowercase sha256");
  if (!stringArray(value.selectedMachineIds) || value.selectedMachineIds.length === 0) {
    errors.push("selectedMachineIds must be a non-empty string array");
  } else {
    if (!unique(value.selectedMachineIds)) errors.push("selectedMachineIds must be unique");
    for (const machineId of value.selectedMachineIds) {
      try {
        assertSafeSupervisorId(machineId, "machineId");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (!Number.isSafeInteger(value.allocationUnitCount) || (value.allocationUnitCount as number) < 1) errors.push("allocationUnitCount must be a positive safe integer");
  if (!stringArray(value.storyIds) || value.storyIds.length === 0 || !unique(value.storyIds)) errors.push("storyIds must be non-empty and unique");
  if (!Array.isArray(value.assignments) || value.assignments.length === 0) errors.push("assignments must be non-empty");
  const preparedAt = typeof value.preparedAt === "string" ? Date.parse(value.preparedAt) : Number.NaN;
  const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
  if (!Number.isFinite(preparedAt)) errors.push("preparedAt must be an ISO timestamp");
  if (!Number.isFinite(expiresAt) || expiresAt <= preparedAt) errors.push("expiresAt must be after preparedAt");
  else if (expiresAt - preparedAt > MAX_LAUNCH_TTL_MS) errors.push("launch plan lifetime exceeds the maximum TTL");
  if (!options.allowExpired && Number.isFinite(expiresAt)) {
    const now = Date.parse(options.now ?? new Date().toISOString());
    if (Number.isFinite(now) && expiresAt <= now) errors.push("launch plan is expired");
  }
  if (value.bodyStored !== false) errors.push("bodyStored must be false");
  if (isRecord(value.launchMechanism)) {
    exactKeys(value.launchMechanism, ["kind", "preparationOnly", "processSpawned", "exactPlanHashConfirmationRequired", "presenceReceiptRequiredForZagent", "durablePromptBodyStored"], "launchMechanism", errors);
    if (value.launchMechanism.kind !== "existing-pi-or-zagent-session") errors.push("launchMechanism.kind is invalid");
    for (const enabled of ["preparationOnly", "exactPlanHashConfirmationRequired", "presenceReceiptRequiredForZagent"] as const) {
      if (value.launchMechanism[enabled] !== true) errors.push(`launchMechanism.${enabled} must be true`);
    }
    if (value.launchMechanism.processSpawned !== false || value.launchMechanism.durablePromptBodyStored !== false) errors.push("launchMechanism must keep process spawn and durable prompt bodies false");
  } else errors.push("launchMechanism is required");
  if (isRecord(value.authorityBoundary)) {
    exactKeys(value.authorityBoundary, [
      "schema", "scope", "activationEnabled", "explicitMachineStartRequired", "modelSessionAllowedAfterExplicitStart",
      "localSourceEditsAllowedAfterExplicitStart", "localTestsAllowedAfterExplicitStart", "localReviewAllowedAfterExplicitStart",
      "arbitraryNetworkAccessEnabled", "commitEnabled", "pushEnabled", "githubEffectsEnabled", "draftPrEnabled",
      "workflowDispatchEnabled", "mergeEnabled", "promotionEnabled", "deploymentEnabled", "bodyStored",
    ], "authorityBoundary", errors);
    if (value.authorityBoundary.schema !== "wheel.zob.local-launch-authority-boundary.v1" || value.authorityBoundary.scope !== "local-edit-test-review") errors.push("authorityBoundary identity is invalid");
    for (const enabled of ["explicitMachineStartRequired", "modelSessionAllowedAfterExplicitStart", "localSourceEditsAllowedAfterExplicitStart", "localTestsAllowedAfterExplicitStart", "localReviewAllowedAfterExplicitStart"] as const) {
      if (value.authorityBoundary[enabled] !== true) errors.push(`authorityBoundary.${enabled} must be true`);
    }
    for (const disabled of ["activationEnabled", "arbitraryNetworkAccessEnabled", "commitEnabled", "pushEnabled", "githubEffectsEnabled", "draftPrEnabled", "workflowDispatchEnabled", "mergeEnabled", "promotionEnabled", "deploymentEnabled", "bodyStored"] as const) {
      if (value.authorityBoundary[disabled] !== false) errors.push(`authorityBoundary.${disabled} must be false`);
    }
  } else errors.push("authorityBoundary is required");
  if (isRecord(value.prHandoff)) {
    exactKeys(value.prHandoff, ["required", "candidateSchema", "authoritySchema", "exactCandidateHashRequired", "exactBaseAndHeadRequired", "mergeAuthorityIncluded", "promotionAuthorityIncluded", "deploymentAuthorityIncluded"], "prHandoff", errors);
    if (value.prHandoff.required !== true || value.prHandoff.exactCandidateHashRequired !== true || value.prHandoff.exactBaseAndHeadRequired !== true) errors.push("prHandoff exact authority gates must be true");
    if (value.prHandoff.candidateSchema !== "wheel.zob.pr-handoff-candidate.v1" || value.prHandoff.authoritySchema !== "wheel.zob.pr-handoff-authority.v1") errors.push("prHandoff schemas are invalid");
    if (value.prHandoff.mergeAuthorityIncluded !== false || value.prHandoff.promotionAuthorityIncluded !== false || value.prHandoff.deploymentAuthorityIncluded !== false) errors.push("prHandoff must exclude merge, promotion, and deployment authority");
  } else errors.push("prHandoff is required");

  if (errors.length === 0) {
    try {
      const typed = value as unknown as WheelLocalMachineLaunchPlan;
    if (typed.assignments.length !== typed.selectedMachineIds.length) errors.push("assignments must match selectedMachineIds one-for-one");
    if (typed.assignments.map((assignment) => assignment.machineId).join("\n") !== typed.selectedMachineIds.join("\n")) errors.push("assignments must preserve selectedMachineIds order");
    for (const assignment of typed.assignments) {
      exactKeys(assignment as unknown as Record<string, unknown>, [
        "schema", "machineId", "assignmentHash", "allocationUnitIds", "storyIds", "storyPaths", "storyManifestHashes",
        "storyBranchNames", "storyBaseRefs", "dependencyStoryIds", "humanGateStoryIds", "linkedWorktreeRequired",
        "cleanWorktreeRequiredAtInitialClaim", "sessionOwnershipRequired", "recoveryEpochRequired", "stopBeforeCommitRequired", "bodyStored",
      ], `assignment.${assignment.machineId}`, errors);
      if (assignment.schema !== "wheel.zob.local-machine-launch-assignment.v1") errors.push(`${assignment.machineId}: assignment schema is invalid`);
      if (!typed.selectedMachineIds.includes(assignment.machineId)) errors.push(`${assignment.machineId}: assignment is not selected`);
      if (!SHA64.test(assignment.assignmentHash)) errors.push(`${assignment.machineId}: assignmentHash must be a lowercase sha256`);
      else if (hashWheelLocalMachineLaunchAssignment(assignment) !== assignment.assignmentHash) errors.push(`${assignment.machineId}: assignment hash mismatch`);
      if (
        assignment.storyIds.length === 0
        || !unique(assignment.storyIds)
        || assignment.storyIds.length !== assignment.storyPaths.length
        || assignment.storyIds.length !== assignment.storyManifestHashes.length
        || assignment.storyIds.length !== assignment.storyBranchNames.length
        || assignment.storyIds.length !== assignment.storyBaseRefs.length
      ) errors.push(`${assignment.machineId}: story ids, paths, hashes, branches, and bases must align one-for-one`);
      if (assignment.allocationUnitIds.length === 0 || !unique(assignment.allocationUnitIds)) errors.push(`${assignment.machineId}: allocationUnitIds must be non-empty and unique`);
      if (!assignment.storyPaths.every(safeRepoRef)) errors.push(`${assignment.machineId}: storyPaths must be safe repo-relative refs`);
      if (!assignment.storyManifestHashes.every((hash) => SHA64.test(hash))) errors.push(`${assignment.machineId}: story manifest hashes must be lowercase sha256 values`);
      if (!unique(assignment.dependencyStoryIds) || !unique(assignment.humanGateStoryIds) || !assignment.humanGateStoryIds.every((storyId) => assignment.storyIds.includes(storyId))) {
        errors.push(`${assignment.machineId}: dependency and human-gate story ids must be unique and human gates must be assigned`);
      }
      if (
        assignment.linkedWorktreeRequired !== true
        || assignment.cleanWorktreeRequiredAtInitialClaim !== true
        || assignment.sessionOwnershipRequired !== true
        || assignment.recoveryEpochRequired !== true
        || assignment.stopBeforeCommitRequired !== true
      ) errors.push(`${assignment.machineId}: workspace, ownership, recovery, and stop-before-commit gates must be enabled`);
      if (assignment.bodyStored !== false) errors.push(`${assignment.machineId}: bodyStored must be false`);
    }
    const flattenedStoryIds = typed.assignments.flatMap((assignment) => assignment.storyIds);
    if (flattenedStoryIds.join("\n") !== typed.storyIds.join("\n")) errors.push("storyIds must exactly match assignment queue order");
    const allocationUnitCount = typed.assignments.reduce((total, assignment) => total + assignment.allocationUnitIds.length, 0);
    if (allocationUnitCount !== typed.allocationUnitCount) errors.push("allocationUnitCount must equal assignment allocation units");
      if (hashWheelLocalMachineLaunchPlan(typed) !== typed.planHash) errors.push("launch plan hash mismatch");
      if (errors.length === 0) return { valid: true, errors: [], value: typed };
    } catch (error) {
      errors.push(`launch plan structure is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { valid: false, errors };
}

function assignmentForMachine(
  admission: WheelSupervisorAdmissionInput,
  machineId: string,
  humanGateStoryIds: readonly string[],
): WheelLocalMachineLaunchAssignment {
  const stories = admission.stories.filter((story) => story.machineId === machineId);
  const payload: Omit<WheelLocalMachineLaunchAssignment, "assignmentHash"> = {
    schema: "wheel.zob.local-machine-launch-assignment.v1",
    machineId,
    allocationUnitIds: stories.flatMap((story) => story.allocationUnitIds),
    storyIds: stories.map((story) => story.manifest.storyId),
    storyPaths: stories.map((story) => story.storyPath),
    storyManifestHashes: stories.map((story) => story.manifestHash),
    storyBranchNames: stories.map((story) => story.manifest.branchContract.branchName),
    storyBaseRefs: stories.map((story) => story.manifest.branchContract.prTarget),
    dependencyStoryIds: [...new Set(stories.flatMap((story) => story.manifest.dependencies.map((dependency) => dependency.storyId)))].sort(),
    humanGateStoryIds: stories.map((story) => story.manifest.storyId).filter((storyId) => humanGateStoryIds.includes(storyId)),
    linkedWorktreeRequired: true,
    cleanWorktreeRequiredAtInitialClaim: true,
    sessionOwnershipRequired: true,
    recoveryEpochRequired: true,
    stopBeforeCommitRequired: true,
    bodyStored: false,
  };
  return { ...payload, assignmentHash: sha256Canonical(payload) };
}

function failure(errors: string[]): WheelLocalMachineLaunchPreparation {
  return {
    schema: "wheel.zob.local-machine-launch-preparation.v1",
    prepared: false,
    errors,
    confirmationPhrases: [],
    processSpawned: false,
    providerCallsMade: false,
    sourceMutationsMade: false,
    gitMutationsMade: false,
    reportArtifactsWritten: false,
    githubEffectsMade: false,
    spendIncurred: false,
    bodyStored: false,
  };
}

export function prepareWheelLocalMachineLaunch(
  repoRoot: string,
  input: {
    launchId: string;
    missionId: string;
    bundlePath: string;
    machineIds: string[];
    preparedAt?: string;
    ttlMs?: number;
  },
): WheelLocalMachineLaunchPreparation {
  try {
    assertSafeSupervisorId(input.launchId, "launchId");
    assertSafeSupervisorId(input.missionId, "missionId");
  } catch (error) {
    return failure([error instanceof Error ? error.message : String(error)]);
  }
  if (input.machineIds.length === 0 || !unique(input.machineIds)) return failure(["machineIds must be non-empty and unique"]);
  const preparedAt = input.preparedAt ?? new Date().toISOString();
  const preparedAtMs = Date.parse(preparedAt);
  if (!Number.isFinite(preparedAtMs)) return failure(["preparedAt must be an ISO timestamp"]);
  const ttlMs = input.ttlMs ?? DEFAULT_LAUNCH_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LAUNCH_TTL_MS) return failure([`ttlMs must be an integer between 1 and ${MAX_LAUNCH_TTL_MS}`]);

  const prepared = prepareWheelSupervisorFromMachineBundle(repoRoot, {
    missionId: input.missionId,
    bundlePath: input.bundlePath,
    machineIds: input.machineIds,
    mode: "disabled",
    admittedAt: preparedAt,
  });
  if (!prepared.summary.prepared || !prepared.admission) return failure(prepared.summary.errors);
  const admission = prepared.admission;
  const assignments = input.machineIds.map((machineId) => assignmentForMachine(admission, machineId, prepared.summary.humanGateStoryIds));
  const payload: Omit<WheelLocalMachineLaunchPlan, "planHash"> = {
    schema: "wheel.zob.local-machine-launch-plan.v1",
    launchId: input.launchId,
    missionId: input.missionId,
    bundlePath: input.bundlePath,
    bundleId: admission.bundleId,
    bundleHash: admission.bundleHash,
    sourceSha: admission.sourceSha,
    repositoryId: admission.repositoryId,
    selectedMachineIds: [...input.machineIds],
    allocationUnitCount: prepared.summary.allocationUnitCount,
    storyIds: assignments.flatMap((assignment) => assignment.storyIds),
    preparedAt,
    expiresAt: new Date(preparedAtMs + ttlMs).toISOString(),
    assignments,
    launchMechanism: {
      kind: "existing-pi-or-zagent-session",
      preparationOnly: true,
      processSpawned: false,
      exactPlanHashConfirmationRequired: true,
      presenceReceiptRequiredForZagent: true,
      durablePromptBodyStored: false,
    },
    authorityBoundary: structuredClone(WHEEL_LOCAL_LAUNCH_AUTHORITY_BOUNDARY),
    prHandoff: {
      required: true,
      candidateSchema: "wheel.zob.pr-handoff-candidate.v1",
      authoritySchema: "wheel.zob.pr-handoff-authority.v1",
      exactCandidateHashRequired: true,
      exactBaseAndHeadRequired: true,
      mergeAuthorityIncluded: false,
      promotionAuthorityIncluded: false,
      deploymentAuthorityIncluded: false,
    },
    bodyStored: false,
  };
  const plan: WheelLocalMachineLaunchPlan = { ...payload, planHash: sha256Canonical(payload) };
  const validation = validateWheelLocalMachineLaunchPlan(plan, { now: preparedAt });
  if (!validation.valid) return failure(validation.errors);
  return {
    schema: "wheel.zob.local-machine-launch-preparation.v1",
    prepared: true,
    launchDirectoryRef: `reports/wheel-zob/local-launches/${input.launchId}`,
    plan,
    errors: [],
    confirmationPhrases: input.machineIds.map((machineId) => ({ machineId, phrase: wheelLocalMachineStartConfirmation(plan, machineId) })),
    processSpawned: false,
    providerCallsMade: false,
    sourceMutationsMade: false,
    gitMutationsMade: false,
    reportArtifactsWritten: false,
    githubEffectsMade: false,
    spendIncurred: false,
    bodyStored: false,
  };
}

export function persistWheelLocalMachineLaunchPlan(repoRoot: string, plan: WheelLocalMachineLaunchPlan): { planRef: string; replay: boolean } {
  const validation = validateWheelLocalMachineLaunchPlan(plan, { allowExpired: true });
  if (!validation.valid) throw new Error(`invalid local launch plan: ${validation.errors.join("; ")}`);
  const directory = resolveWheelLocalLaunchDirectory(repoRoot, plan.launchId);
  const path = resolve(directory, "launch-plan.json");
  const planRef = relative(resolve(repoRoot), path).split("\\").join("/");
  if (existsSync(path)) {
    const existing = readJson<unknown>(path);
    const checked = validateWheelLocalMachineLaunchPlan(existing, { allowExpired: true });
    if (!checked.valid || checked.value?.planHash !== plan.planHash) throw new Error(`local launch ${plan.launchId} already exists with different or corrupted content`);
    return { planRef, replay: true };
  }
  assertBodySafe(plan);
  writeAtomic(path, plan);
  return { planRef, replay: false };
}

export function loadWheelLocalMachineLaunchPlan(
  repoRoot: string,
  launchId: string,
  options: { now?: string; allowExpired?: boolean } = {},
): WheelLocalMachineLaunchPlan {
  const path = resolve(resolveWheelLocalLaunchDirectory(repoRoot, launchId), "launch-plan.json");
  if (!existsSync(path)) throw new Error(`local launch ${launchId} does not exist`);
  const validation = validateWheelLocalMachineLaunchPlan(readJson<unknown>(path), options);
  if (!validation.valid || !validation.value) throw new Error(`invalid local launch ${launchId}: ${validation.errors.join("; ")}`);
  return validation.value;
}
