import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { ingestFleetV5StoryBundle, type WheelStoryExecution } from "../adapters/fleet-v5.js";
import { previewWheelMachineMissionFromFile, readWheelRepoJsonFile } from "../adapters/file-intake.js";
import { validateWheelFleetV5MachineBundle } from "../adapters/machine-bundle.js";
import { planWheelMission } from "../factories/story-pr-close/mission-planner.js";
import { sha256Text } from "./canonical.js";
import {
  createDeterministicFakeWheelSupervisorAuthority,
  createDisabledWheelSupervisorAuthority,
  DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY,
} from "./contracts.js";
import type {
  WheelSupervisorAdmissionInput,
  WheelSupervisorAuthority,
  WheelSupervisorCheckPolicy,
  WheelSupervisorMode,
} from "./types.js";

export const DEFAULT_WHEEL_FAKE_CHECK_POLICY: WheelSupervisorCheckPolicy = Object.freeze({
  requiredCiChecks: [{ name: "CI / Required", issuerHash: sha256Text("wheel-zob-fake-ci-issuer") }],
  prCloseCheck: { name: "ZOB / PR Close", issuerHash: sha256Text("wheel-zob-fake-pr-close-issuer") },
  completionLabel: "needs-review",
  bodyStored: false,
});

export interface WheelSupervisorBundleSummary {
  schema: "wheel.zob.supervisor-bundle-summary.v1";
  prepared: boolean;
  missionId: string;
  bundleId?: string;
  bundleHash?: string;
  sourceSha?: string;
  repositoryId?: string;
  machineIds: string[];
  allocationUnitCount: number;
  storyIds: string[];
  humanGateStoryIds: string[];
  mode: Exclude<WheelSupervisorMode, "live">;
  errors: string[];
  dispatchEnabled: false;
  providerCallsEnabled: false;
  githubEffectsEnabled: false;
  commitEnabled: false;
  pushEnabled: false;
  mergeEnabled: false;
  workflowDispatchEnabled: false;
  deploymentEnabled: false;
  bodyStored: false;
}

export interface WheelPreparedSupervisorMission {
  summary: WheelSupervisorBundleSummary;
  admission?: WheelSupervisorAdmissionInput;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function allocationUnitsForStory(allocationUnitIds: string[], storyId: string): string[] {
  return allocationUnitIds.filter((allocationUnitId) =>
    allocationUnitId === storyId
    || allocationUnitId.split("/").includes(storyId)
    || allocationUnitId.startsWith(`${storyId}-`));
}

function authorityForMode(mode: Exclude<WheelSupervisorMode, "live">): WheelSupervisorAuthority {
  return mode === "disabled" ? createDisabledWheelSupervisorAuthority() : createDeterministicFakeWheelSupervisorAuthority();
}

function emptySummary(missionId: string, mode: Exclude<WheelSupervisorMode, "live">, errors: string[]): WheelSupervisorBundleSummary {
  return {
    schema: "wheel.zob.supervisor-bundle-summary.v1",
    prepared: false,
    missionId,
    machineIds: [],
    allocationUnitCount: 0,
    storyIds: [],
    humanGateStoryIds: [],
    mode,
    errors,
    dispatchEnabled: false,
    providerCallsEnabled: false,
    githubEffectsEnabled: false,
    commitEnabled: false,
    pushEnabled: false,
    mergeEnabled: false,
    workflowDispatchEnabled: false,
    deploymentEnabled: false,
    bodyStored: false,
  };
}

export function resolveWheelSupervisorStateDirectory(repoRoot: string, requestedPath: string): string {
  if (!requestedPath || isAbsolute(requestedPath)) throw new Error("supervisor state directory must be repo-relative");
  const root = resolve(repoRoot);
  const resolved = resolve(root, requestedPath);
  const rel = relative(root, resolved).split("\\").join("/");
  if (rel.startsWith("../") || rel === ".." || !rel.startsWith("reports/wheel-zob/supervisor/")) {
    throw new Error("supervisor state directory must stay under reports/wheel-zob/supervisor/");
  }
  return resolved;
}

export function prepareWheelSupervisorFromMachineBundle(
  repoRoot: string,
  input: {
    missionId: string;
    bundlePath: string;
    machineIds?: string[];
    mode?: Exclude<WheelSupervisorMode, "live">;
    authority?: WheelSupervisorAuthority;
    checkPolicy?: WheelSupervisorCheckPolicy;
    ownerId?: string;
    admittedAt?: string;
  },
): WheelPreparedSupervisorMission {
  const mode = input.mode ?? "disabled";
  const loaded = readWheelRepoJsonFile(repoRoot, input.bundlePath);
  if (loaded.error || loaded.value === undefined) return { summary: emptySummary(input.missionId, mode, [loaded.error ?? "bundle could not be read"]) };
  const validation = validateWheelFleetV5MachineBundle(loaded.value);
  if (!validation.accepted || !validation.value) {
    return { summary: emptySummary(input.missionId, mode, validation.issues.map((issue) => `${issue.path}: ${issue.message}`)) };
  }
  const bundle = validation.value;
  const selectedMachineIds = input.machineIds ?? bundle.machines.map((machine) => machine.machineId);
  const selectedSet = new Set(selectedMachineIds);
  const errors: string[] = [];
  if (selectedMachineIds.length === 0 || selectedSet.size !== selectedMachineIds.length) errors.push("machineIds must be non-empty and unique");
  for (const machineId of selectedMachineIds) {
    if (!bundle.machines.some((machine) => machine.machineId === machineId)) errors.push(`machine ${machineId} is not assigned in bundle ${bundle.bundleId}`);
  }
  if (errors.length > 0) return { summary: emptySummary(input.missionId, mode, errors) };

  for (const machineId of selectedMachineIds) {
    const preview = previewWheelMachineMissionFromFile(repoRoot, { missionId: input.missionId, machineId, bundlePath: input.bundlePath });
    if (!preview.planned) errors.push(...preview.errors.map((error) => `${machineId}: ${error}`));
  }
  if (errors.length > 0) return { summary: emptySummary(input.missionId, mode, [...new Set(errors)]) };

  const selectedMachines = bundle.machines.filter((machine) => selectedSet.has(machine.machineId));
  const loadedStories = selectedMachines.flatMap((machine) => machine.storyPaths.map((storyPath, index) => {
    const story = readWheelRepoJsonFile(repoRoot, storyPath);
    if (story.error || story.value === undefined || story.raw === undefined) {
      errors.push(`${storyPath}: ${story.error ?? "story could not be read"}`);
      return undefined;
    }
    return {
      machineId: machine.machineId,
      allocationUnitIds: allocationUnitsForStory(machine.allocationUnitIds, machine.storyIds[index] as string),
      expectedStoryId: machine.storyIds[index] as string,
      storyPath,
      manifestHash: sha256(story.raw),
      value: story.value,
    };
  })).filter((story): story is NonNullable<typeof story> => story !== undefined);
  for (const loadedStory of loadedStories) {
    if (loadedStory.allocationUnitIds.length === 0) errors.push(`${loadedStory.expectedStoryId}: no allocation unit can be source-bound to the story`);
  }
  if (errors.length > 0) return { summary: emptySummary(input.missionId, mode, errors) };

  const intake = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: bundle.bundleId,
    missionSeed: bundle.bundleHash,
    stories: loadedStories.map((story) => story.value),
  });
  if (!intake.accepted) {
    return { summary: emptySummary(input.missionId, mode, intake.issues.map((issue) => `${issue.path}: ${issue.message}`)) };
  }
  const typedStories = new Map(intake.stories.map((story) => [story.storyId, story]));
  for (const loadedStory of loadedStories) {
    if (!typedStories.has(loadedStory.expectedStoryId)) errors.push(`${loadedStory.storyPath}: expected story ${loadedStory.expectedStoryId} is missing after intake`);
  }
  const plan = planWheelMission({ missionId: input.missionId, intake });
  if (!plan.planned) return { summary: emptySummary(input.missionId, mode, [...errors, ...plan.errors]) };
  if (errors.length > 0) return { summary: emptySummary(input.missionId, mode, errors) };

  const authority = input.authority ?? authorityForMode(mode);
  if (authority.mode !== mode) return { summary: emptySummary(input.missionId, mode, ["authority mode does not match requested supervisor mode"]) };
  const admission: WheelSupervisorAdmissionInput = {
    missionId: input.missionId,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    sourceSha: bundle.source.sourceSha,
    repositoryId: bundle.source.repositoryId,
    checkPolicy: structuredClone(input.checkPolicy ?? DEFAULT_WHEEL_FAKE_CHECK_POLICY),
    stories: loadedStories.map((loadedStory) => ({
      machineId: loadedStory.machineId,
      allocationUnitIds: loadedStory.allocationUnitIds,
      storyPath: loadedStory.storyPath,
      manifestHash: loadedStory.manifestHash,
      manifest: typedStories.get(loadedStory.expectedStoryId) as WheelStoryExecution,
    })),
    protectedPlan: plan.protectedPlan,
    authority,
    budgetPolicy: DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY,
    ownerId: input.ownerId ?? `wheel-supervisor-${input.missionId}`,
    admittedAt: input.admittedAt,
  };
  const summary: WheelSupervisorBundleSummary = {
    ...emptySummary(input.missionId, mode, []),
    prepared: true,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    sourceSha: bundle.source.sourceSha,
    repositoryId: bundle.source.repositoryId,
    machineIds: selectedMachineIds,
    allocationUnitCount: selectedMachines.reduce((total, machine) => total + machine.allocationUnitIds.length, 0),
    storyIds: loadedStories.map((story) => story.expectedStoryId),
    humanGateStoryIds: intake.stories
      .filter((story) => story.signals.humanCheckpoint !== null || story.humanGateRefs.length > 0)
      .map((story) => story.storyId),
  };
  return { summary, admission };
}
