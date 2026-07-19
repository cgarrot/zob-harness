import type { WheelStoryExecution } from "../adapters/fleet-v5.js";
import { buildWheelThinkingControl } from "../factories/story-pr-close/mission-planner.js";
import { WHEEL_FIXED_ROLE_ROUTES, getWheelModelRoute } from "../model-policy/model-registry.js";
import { sha256Canonical, sha256Text } from "./canonical.js";
import { validateWheelSupervisorAuthority, validateWheelSupervisorBudgetPolicy } from "./contracts.js";
import type {
  WheelSupervisorAdmissionInput,
  WheelSupervisorMissionState,
  WheelSupervisorRole,
  WheelSupervisorRouteAssignment,
  WheelSupervisorStoryState,
} from "./types.js";

function fixedAssignment(role: Extract<WheelSupervisorRole, "pr-close">): WheelSupervisorRouteAssignment {
  const fixed = WHEEL_FIXED_ROLE_ROUTES[role];
  const route = getWheelModelRoute(fixed.routeId);
  if (!route) throw new Error(`fixed route ${fixed.routeId} is missing`);
  const selected = {
    routeId: fixed.routeId,
    family: route.family,
    provider: route.provider,
    messageRoleFormat: route.messageRoleFormat,
    thinkingControl: buildWheelThinkingControl(route, fixed.thinking),
  };
  return {
    role,
    required: true,
    selected,
    candidates: [selected],
    requestedThinking: fixed.thinking,
    independentFromDevelopment: true,
    currentCandidateIndex: 0,
    bodyStored: false,
  };
}

function copiedIndependentAssignment(
  role: Extract<WheelSupervisorRole, "pr-close-source-audit" | "pr-close-evidence-audit">,
  source: WheelSupervisorRouteAssignment,
  forbiddenFamilies: Set<string>,
): WheelSupervisorRouteAssignment {
  const selected = source.candidates.find((candidate) => !forbiddenFamilies.has(candidate.family));
  if (!selected) throw new Error(`${role}: no independent route candidate remains`);
  return {
    ...structuredClone(source),
    role,
    required: true,
    selected: structuredClone(selected),
    candidates: [structuredClone(selected), ...source.candidates.filter((candidate) => candidate.routeId !== selected.routeId).map((candidate) => structuredClone(candidate))],
    independentFromDevelopment: true,
    currentCandidateIndex: 0,
    bodyStored: false,
  };
}

function routeAssignments(input: WheelSupervisorAdmissionInput, storyId: string): WheelSupervisorRouteAssignment[] {
  const planned = input.protectedPlan.stories.find((story) => story.storyId === storyId);
  if (!planned) throw new Error(`${storyId}: protected plan is missing the story`);
  const assignments: WheelSupervisorRouteAssignment[] = planned.roleAssignments.map((assignment) => ({
    role: assignment.rolePool,
    required: assignment.required,
    selected: structuredClone(assignment.selected),
    candidates: structuredClone(assignment.candidates),
    requestedThinking: assignment.requestedThinking,
    independentFromDevelopment: assignment.independentFromDevelopment,
    currentCandidateIndex: 0,
    bodyStored: false,
  }));
  const development = assignments.find((assignment) => assignment.role === "development");
  const qa = assignments.find((assignment) => assignment.role === "qa");
  const blindReview = assignments.find((assignment) => assignment.role === "formal-blind-review");
  if (!development || !qa || !blindReview) throw new Error(`${storyId}: development, QA, and formal blind-review assignments are required`);
  const finalizer = fixedAssignment("pr-close");
  const forbidden = new Set<string>([development.selected.family, finalizer.selected.family]);
  const sourceAudit = copiedIndependentAssignment("pr-close-source-audit", blindReview, forbidden);
  forbidden.add(sourceAudit.selected.family);
  const evidenceAudit = copiedIndependentAssignment("pr-close-evidence-audit", qa, forbidden);
  return [
    ...assignments,
    sourceAudit,
    evidenceAudit,
    finalizer,
  ];
}

function initialStory(
  input: WheelSupervisorAdmissionInput,
  item: WheelSupervisorAdmissionInput["stories"][number],
): WheelSupervisorStoryState {
  const manifest: WheelStoryExecution = item.manifest;
  const humanGateRequired = manifest.signals.humanCheckpoint !== null || manifest.humanGateRefs.length > 0;
  return {
    schema: "wheel.zob.supervisor-story-state.v1",
    storyId: manifest.storyId,
    machineId: item.machineId,
    allocationUnitIds: [...item.allocationUnitIds],
    storyPath: item.storyPath,
    manifestHash: item.manifestHash,
    revision: manifest.revision,
    branchContract: structuredClone(manifest.branchContract),
    stage: "admitted",
    stageRevision: 1,
    dependencies: structuredClone(manifest.dependencies),
    humanGateRefs: [...manifest.humanGateRefs],
    routeAssignments: routeAssignments(input, manifest.storyId),
    attempts: [],
    evidence: [],
    repairRound: 0,
    blockerCodes: humanGateRequired ? ["human-gate-required"] : [],
    lastEventSequence: 0,
    bodyStored: false,
  };
}

function validateRepositoryAndCheckPolicy(input: WheelSupervisorAdmissionInput): string[] {
  const issues: string[] = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryId)) issues.push("repositoryId must be an owner/repository slug");
  if (input.checkPolicy.bodyStored !== false) issues.push("check policy must be body-free");
  if (input.checkPolicy.requiredCiChecks.length === 0) issues.push("at least one required CI check is required");
  const checks = [...input.checkPolicy.requiredCiChecks, input.checkPolicy.prCloseCheck];
  if (new Set(checks.map((check) => check.name)).size !== checks.length) issues.push("check names must be unique");
  if (checks.some((check) => check.name.length === 0 || !/^[a-f0-9]{64}$/.test(check.issuerHash))) issues.push("checks require names and full issuer hashes");
  if (!/^[A-Za-z0-9_.:/ -]+$/.test(input.checkPolicy.completionLabel) || input.checkPolicy.completionLabel.length === 0) issues.push("completionLabel is invalid");
  const branches = input.stories.map((item) => item.manifest.branchContract.branchName);
  if (new Set(branches).size !== branches.length) issues.push("story branch names must be unique");
  for (const item of input.stories) {
    if (item.manifest.branchContract.prTarget !== "develop-staging" || item.manifest.branchContract.draftRequired !== true) {
      issues.push(`${item.manifest.storyId}: supervisor requires a draft PR targeting develop-staging`);
    }
  }
  return issues;
}

export function buildWheelSupervisorInitialState(input: WheelSupervisorAdmissionInput): WheelSupervisorMissionState {
  const issues = [
    ...validateRepositoryAndCheckPolicy(input),
    ...validateWheelSupervisorAuthority(input.authority),
    ...validateWheelSupervisorBudgetPolicy(input.budgetPolicy),
  ];
  if (issues.length > 0) throw new Error(`supervisor admission rejected: ${issues.join("; ")}`);
  if (input.protectedPlan.missionId !== input.missionId) throw new Error("protected plan missionId does not match admission");
  if (input.protectedPlan.bundleId !== input.bundleId) throw new Error("protected plan bundleId does not match admission");
  if (input.protectedPlan.stories.length !== input.stories.length) throw new Error("protected plan story count does not match admission");
  const storyIds = input.stories.map((item) => item.manifest.storyId);
  if (new Set(storyIds).size !== storyIds.length) throw new Error("supervisor admission contains duplicate story IDs");
  const plannedStoryIds = new Set(input.protectedPlan.stories.map((story) => story.storyId));
  for (const storyId of storyIds) if (!plannedStoryIds.has(storyId)) throw new Error(`${storyId}: story is not in the protected plan`);
  const admittedAt = input.admittedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(admittedAt))) throw new Error("admittedAt is invalid");
  const stories = Object.fromEntries(input.stories.map((item) => {
    const state = initialStory(input, item);
    return [state.storyId, state];
  }));
  return {
    schema: "wheel.zob.supervisor-mission-state.v1",
    missionId: input.missionId,
    bundleId: input.bundleId,
    bundleHash: input.bundleHash,
    sourceSha: input.sourceSha,
    repositoryId: input.repositoryId,
    checkPolicy: structuredClone(input.checkPolicy),
    status: "admitted",
    mode: input.authority.mode,
    authorityHash: sha256Canonical(input.authority),
    revision: 0,
    journalSequence: 0,
    journalHeadHash: "0".repeat(64),
    ownershipEpoch: 0,
    ownerIdHash: sha256Text(input.ownerId),
    admittedAt,
    updatedAt: admittedAt,
    budgetPolicy: structuredClone(input.budgetPolicy),
    budgetLedger: {
      reservedAttempts: 0,
      settledAttempts: 0,
      reservedCostUsd: 0,
      settledCostUsd: 0,
      startedAt: admittedAt,
      bodyStored: false,
    },
    stories,
    pendingEffectRequestIds: [],
    noShipReasons: [],
    bodyStored: false,
  };
}
