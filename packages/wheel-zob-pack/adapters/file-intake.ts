import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { ingestFleetV5StoryBundle, type WheelValidationIssue } from "./fleet-v5.js";
import {
  computeWheelFleetV5MachineBundleHash,
  validateWheelFleetV5MachineBundle,
} from "./machine-bundle.js";
import { planWheelMission, type WheelMissionPlanningResult } from "../factories/story-pr-close/mission-planner.js";

const FORBIDDEN_PATH_SEGMENTS = new Set([".git", ".env", ".ssh", ".aws", ".gnupg", "node_modules", "dist", "build", "sessions", "agent-sessions"]);
const FORBIDDEN_SECRET_SEGMENT = /(^|[._-])(secret|secrets|credential|credentials|private[-_]?key|api[-_]?key)([._-]|$)/i;
const FORBIDDEN_KEY_EXTENSION = /\.(?:pem|key|p12|pfx|jks)$/i;

export interface WheelStoryFileValidationResult {
  schema: "wheel.zob.story-file-validation.v1";
  valid: boolean;
  storyId?: string;
  revision?: number;
  issues: WheelValidationIssue[];
  bodyStored: false;
}

export interface WheelMissionFilePreviewResult {
  schema: "wheel.zob.mission-file-preview.v1";
  planned: boolean;
  errors: string[];
  result?: WheelMissionPlanningResult;
  bodyStored: false;
}

export interface WheelMachineMissionFilePreviewResult {
  schema: "wheel.zob.machine-mission-file-preview.v1";
  planned: boolean;
  errors: string[];
  bundleId?: string;
  bundleHash?: string;
  machineId?: string;
  allocationUnitIds: string[];
  storyIds: string[];
  storyPaths: string[];
  humanGateStoryIds: string[];
  result?: WheelMissionPlanningResult;
  bodyStored: false;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forbiddenRepoRelativePath(rel: string): boolean {
  const segments = rel.split(/[\\/]/).filter(Boolean);
  const lowered = segments.map((segment) => segment.toLowerCase());
  const insidePiPrivateSession = lowered[0] === ".pi" && (lowered[1] === "sessions" || lowered[1] === "agent-sessions");
  const forbiddenSegment = segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase()) || segment.toLowerCase().startsWith(".env.") || FORBIDDEN_SECRET_SEGMENT.test(segment));
  return insidePiPrivateSession || forbiddenSegment || FORBIDDEN_KEY_EXTENSION.test(rel);
}

function safeRepoFile(repoRoot: string, requestedPath: string): { path?: string; error?: string } {
  const normalizedInput = requestedPath.startsWith("@") ? requestedPath.slice(1) : requestedPath;
  if (!normalizedInput || isAbsolute(normalizedInput)) return { error: "path must be non-empty and repo-relative" };
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(resolvedRoot, normalizedInput);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: "path must stay inside repository root" };
  if (forbiddenRepoRelativePath(rel)) return { error: "path is forbidden by Wheel pack policy" };
  try {
    const realRoot = realpathSync(resolvedRoot);
    const realPath = realpathSync(resolvedPath);
    const realRel = relative(realRoot, realPath);
    if (realRel.startsWith("..") || isAbsolute(realRel)) return { error: "resolved path must stay inside repository root" };
    if (forbiddenRepoRelativePath(realRel)) return { error: "resolved path is forbidden by Wheel pack policy" };
    return { path: realPath };
  } catch {
    return { error: "path could not be safely resolved" };
  }
}

export function readWheelRepoJsonFile(repoRoot: string, requestedPath: string): { value?: unknown; raw?: string; error?: string } {
  const safe = safeRepoFile(repoRoot, requestedPath);
  if (!safe.path) return { error: safe.error };
  try {
    const raw = readFileSync(safe.path, "utf8");
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function validateWheelStoryFile(repoRoot: string, storyPath: string): WheelStoryFileValidationResult {
  const loaded = readWheelRepoJsonFile(repoRoot, storyPath);
  if (loaded.error || loaded.value === undefined) {
    return { schema: "wheel.zob.story-file-validation.v1", valid: false, issues: [{ path: "storyPath", code: "type", message: loaded.error ?? "story file could not be read" }], bodyStored: false };
  }
  const intake = ingestFleetV5StoryBundle({ schema: "wheel.zob.fleet-v5-bundle.v1", bundleId: "wheel-zob-file-validation", missionSeed: "wheel-zob-file-validation-seed", stories: [loaded.value] });
  return {
    schema: "wheel.zob.story-file-validation.v1",
    valid: intake.accepted,
    storyId: intake.storyIds[0],
    revision: intake.stories[0]?.revision,
    issues: intake.issues,
    bodyStored: false,
  };
}

export function previewWheelMissionFromFiles(
  repoRoot: string,
  input: { missionId: string; bundleId?: string; storyPaths: string[]; maxOutputPriceUsdPerMillion?: number },
): WheelMissionFilePreviewResult {
  const errors: string[] = [];
  const stories: unknown[] = [];
  const rawHashes: string[] = [];
  if (input.storyPaths.length === 0) errors.push("at least one story path is required");
  if (input.storyPaths.length > 100) errors.push("at most 100 story paths are allowed");
  if (errors.length > 0) return { schema: "wheel.zob.mission-file-preview.v1", planned: false, errors, bodyStored: false };
  for (const storyPath of input.storyPaths) {
    const loaded = readWheelRepoJsonFile(repoRoot, storyPath);
    if (loaded.error || loaded.value === undefined || loaded.raw === undefined) errors.push(`${storyPath}: ${loaded.error ?? "story file could not be read"}`);
    else {
      stories.push(loaded.value);
      rawHashes.push(sha256(loaded.raw));
    }
  }
  if (errors.length > 0) return { schema: "wheel.zob.mission-file-preview.v1", planned: false, errors, bodyStored: false };
  const missionSeed = sha256(`${input.missionId}:${rawHashes.sort().join(":")}`);
  const intake = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: input.bundleId ?? input.missionId,
    missionSeed,
    stories,
  });
  if (!intake.accepted) {
    return {
      schema: "wheel.zob.mission-file-preview.v1",
      planned: false,
      errors: intake.issues.map((item) => `${item.path}: ${item.message}`),
      bodyStored: false,
    };
  }
  const result = planWheelMission({
    missionId: input.missionId,
    intake,
    eligibility: typeof input.maxOutputPriceUsdPerMillion === "number" ? { maxOutputPriceUsdPerMillion: input.maxOutputPriceUsdPerMillion } : undefined,
  });
  return {
    schema: "wheel.zob.mission-file-preview.v1",
    planned: result.planned,
    errors: result.planned ? [] : result.errors,
    result,
    bodyStored: false,
  };
}

export function previewWheelMachineMissionFromFile(
  repoRoot: string,
  input: {
    missionId: string;
    machineId: string;
    bundlePath: string;
    maxOutputPriceUsdPerMillion?: number;
  },
): WheelMachineMissionFilePreviewResult {
  const failure = (errors: string[]): WheelMachineMissionFilePreviewResult => ({
    schema: "wheel.zob.machine-mission-file-preview.v1",
    planned: false,
    errors,
    allocationUnitIds: [],
    storyIds: [],
    storyPaths: [],
    humanGateStoryIds: [],
    bodyStored: false,
  });

  const loadedBundle = readWheelRepoJsonFile(repoRoot, input.bundlePath);
  if (loadedBundle.error || loadedBundle.value === undefined) {
    return failure([`${input.bundlePath}: ${loadedBundle.error ?? "machine bundle could not be read"}`]);
  }
  const validation = validateWheelFleetV5MachineBundle(loadedBundle.value);
  if (!validation.accepted || !validation.value) {
    return failure(validation.issues.map((item) => `${item.path}: ${item.message}`));
  }
  const bundle = validation.value;
  const assignment = bundle.machines.find((machine) => machine.machineId === input.machineId);
  if (!assignment) return failure([`machine ${input.machineId} is not assigned in bundle ${bundle.bundleId}`]);

  const errors: string[] = [];
  const sourceFiles = [
    { path: bundle.source.allocationRef, expectedHash: bundle.source.allocationSha256, label: "allocation" },
    { path: bundle.source.signalsRef, expectedHash: bundle.source.signalsSha256, label: "signals" },
  ];
  for (const sourceFile of sourceFiles) {
    const loaded = readWheelRepoJsonFile(repoRoot, sourceFile.path);
    if (loaded.error || loaded.raw === undefined) errors.push(`${sourceFile.label} source ${sourceFile.path}: ${loaded.error ?? "could not be read"}`);
    else if (sha256(loaded.raw) !== sourceFile.expectedHash) errors.push(`${sourceFile.label} source hash does not match ${sourceFile.path}`);
  }

  const allAssignments = bundle.machines.flatMap((machine) => machine.storyPaths.map((storyPath, index) => ({
    machineId: machine.machineId,
    expectedStoryId: machine.storyIds[index] as string,
    storyPath,
  })));
  const storyValues = new Map<string, unknown>();
  const storyFileHashes: Record<string, string> = {};
  for (const item of allAssignments) {
    const loaded = readWheelRepoJsonFile(repoRoot, item.storyPath);
    if (loaded.error || loaded.value === undefined || loaded.raw === undefined) {
      errors.push(`${item.storyPath}: ${loaded.error ?? "story file could not be read"}`);
      continue;
    }
    const actualStoryId = isRecord(loaded.value) && typeof loaded.value.storyId === "string" ? loaded.value.storyId : undefined;
    if (actualStoryId !== item.expectedStoryId) {
      errors.push(`${item.storyPath}: expected storyId ${item.expectedStoryId}, found ${actualStoryId ?? "missing"}`);
    }
    storyValues.set(item.storyPath, loaded.value);
    storyFileHashes[item.storyPath] = sha256(loaded.raw);
  }
  if (errors.length > 0) return failure(errors);

  const computedBundleHash = computeWheelFleetV5MachineBundleHash(bundle, storyFileHashes);
  if (computedBundleHash !== bundle.bundleHash) return failure(["machine bundle hash does not match its source and story files"]);

  const allIntake = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: bundle.bundleId,
    missionSeed: bundle.bundleHash,
    stories: allAssignments.map((item) => storyValues.get(item.storyPath)),
  });
  if (!allIntake.accepted) return failure(allIntake.issues.map((item) => `${item.path}: ${item.message}`));

  const selectedStories = assignment.storyPaths.map((storyPath) => storyValues.get(storyPath));
  const selectedIntake = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: `${bundle.bundleId}-${assignment.machineId}`,
    missionSeed: sha256(`${bundle.bundleHash}:${input.missionId}:${assignment.machineId}`),
    stories: selectedStories,
  });
  if (!selectedIntake.accepted) return failure(selectedIntake.issues.map((item) => `${item.path}: ${item.message}`));

  const result = planWheelMission({
    missionId: input.missionId,
    intake: selectedIntake,
    eligibility: typeof input.maxOutputPriceUsdPerMillion === "number"
      ? { maxOutputPriceUsdPerMillion: input.maxOutputPriceUsdPerMillion }
      : undefined,
  });
  return {
    schema: "wheel.zob.machine-mission-file-preview.v1",
    planned: result.planned,
    errors: result.planned ? [] : result.errors,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    machineId: assignment.machineId,
    allocationUnitIds: [...assignment.allocationUnitIds],
    storyIds: [...assignment.storyIds],
    storyPaths: [...assignment.storyPaths],
    humanGateStoryIds: selectedIntake.stories
      .filter((story) => story.signals.humanCheckpoint !== null || story.humanGateRefs.length > 0)
      .map((story) => story.storyId),
    result,
    bodyStored: false,
  };
}
