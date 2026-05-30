import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "./utils/hashing.js";
import { resolveRepoPath } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";
import { resolveComputeProfile, type ComputeDomain, type ComputeEffectiveProfile, type ComputePreviewInput, type ComputeRequestedProfile } from "./compute-profile.js";

export interface ComputeWorkflowShapeInput extends ComputePreviewInput {
  resolutionPath?: string;
}

const PROFILE_LANES: Record<ComputeEffectiveProfile, Array<{ id: string; agent: string; maxWorkers: number; tools: string[]; outputContract: string; validation: string }>> = {
  low: [
    { id: "deterministic_preview", agent: "agent", maxWorkers: 1, tools: ["read", "grep", "find", "ls"], outputContract: "metadata.v1", validation: "narrow" },
  ],
  medium: [
    { id: "deterministic_preview", agent: "agent", maxWorkers: 1, tools: ["read", "grep", "find", "ls"], outputContract: "metadata.v1", validation: "targeted" },
    { id: "targeted_validation", agent: "qa", maxWorkers: 1, tools: ["read", "grep", "find", "ls", "bash"], outputContract: "oracle.v1", validation: "smoke" },
  ],
  high: [
    { id: "architecture", agent: "explore", maxWorkers: 2, tools: ["read", "grep", "find", "ls"], outputContract: "explore.v1", validation: "cited" },
    { id: "implementation", agent: "implementer", maxWorkers: 2, tools: ["read", "grep", "find", "ls"], outputContract: "implement.v1", validation: "full_local" },
    { id: "validation", agent: "oracle", maxWorkers: 1, tools: ["read", "grep", "find", "ls", "bash"], outputContract: "oracle.v1", validation: "required" },
  ],
  xhigh: [
    { id: "architecture", agent: "explore", maxWorkers: 3, tools: ["read", "grep", "find", "ls"], outputContract: "explore.v1", validation: "cited" },
    { id: "safety", agent: "oracle", maxWorkers: 2, tools: ["read", "grep", "find", "ls"], outputContract: "oracle.v1", validation: "adversarial" },
    { id: "implementation", agent: "implementer", maxWorkers: 4, tools: ["read", "grep", "find", "ls"], outputContract: "implement.v1", validation: "full_plus_adversarial" },
    { id: "benchmark", agent: "qa", maxWorkers: 2, tools: ["read", "grep", "find", "ls", "bash"], outputContract: "qa.v1", validation: "suite" },
  ],
  max: [
    { id: "architecture", agent: "explore", maxWorkers: 4, tools: ["read", "grep", "find", "ls"], outputContract: "explore.v1", validation: "cited" },
    { id: "safety", agent: "oracle", maxWorkers: 4, tools: ["read", "grep", "find", "ls"], outputContract: "oracle.v1", validation: "multi_oracle" },
    { id: "implementation", agent: "implementer", maxWorkers: 8, tools: ["read", "grep", "find", "ls"], outputContract: "implement.v1", validation: "exhaustive_within_scope" },
    { id: "benchmark", agent: "qa", maxWorkers: 4, tools: ["read", "grep", "find", "ls", "bash"], outputContract: "qa.v1", validation: "suite_plus_regression" },
    { id: "human_approval_packet", agent: "planner", maxWorkers: 1, tools: ["read", "grep", "find", "ls"], outputContract: "plan.v1", validation: "human_required" },
  ],
};

function readResolution(repoRoot: string, repoPath: string | undefined): Record<string, unknown> | undefined {
  if (!repoPath) return undefined;
  const resolved = resolveRepoPath(repoRoot, repoPath);
  if (resolved.errors.length > 0 || !existsSync(resolved.path)) return undefined;
  const parsed = JSON.parse(readFileSync(resolved.path, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : undefined;
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function buildComputeWorkflowShape(repoRoot: string, input: ComputeWorkflowShapeInput = {}): Record<string, unknown> {
  const resolution = readResolution(repoRoot, input.resolutionPath) ?? resolveComputeProfile(repoRoot, input);
  const effectiveProfile = resolution.effectiveProfile as ComputeEffectiveProfile;
  const caps = isRecord(resolution.caps) ? resolution.caps : {};
  const maxParallel = numberFrom(caps.maxParallel, 1);
  const maxDepth = numberFrom(caps.maxDelegationDepth, 0);
  const maxAgents = numberFrom(caps.maxAgents, 1);
  const lanes = (PROFILE_LANES[effectiveProfile] ?? PROFILE_LANES.low).map((lane) => ({
    ...lane,
    maxWorkers: Math.min(lane.maxWorkers, maxAgents, maxParallel),
    parentOwnedDispatch: true,
    childDirectDispatch: false,
  }));
  const highScale = effectiveProfile === "max" || maxAgents > 20;
  const scalePolicy = {
    schema: "zob.adaptive-scale-policy.v1",
    requestedScale: highScale ? "large" : "default",
    maxTotalAgents: maxAgents,
    maxParallelAgents: maxParallel,
    maxAgentsPerWave: Math.max(1, Math.min(maxParallel, maxAgents)),
    maxWaves: Math.max(1, Math.ceil(maxAgents / Math.max(1, Math.min(maxParallel, maxAgents)))),
    requiresBudget: caps.strictBudgetRequired === true,
    requiresScaleApproval: highScale,
    requiresOracleAfterWave: highScale || caps.oracleRequired === true,
    duplicateDetectionRequired: true,
    stalePeerBlocksCompletion: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const modelPolicy = {
    schema: "zob.adaptive-model-policy.v1",
    downgradePolicy: "blocked_for_oracle_security",
    laneAssignments: lanes.map((lane) => ({ laneId: lane.id, agent: lane.agent, outputContract: lane.outputContract, modelClass: lane.agent === "oracle" ? "strong_oracle" : lane.agent === "planner" || lane.id === "architecture" ? "strong_reasoning" : lane.agent === "agent" || lane.agent === "explore" ? "cheap_scout" : "balanced_worker", reasonHash: sha256(JSON.stringify({ laneId: lane.id, agent: lane.agent, outputContract: lane.outputContract })) })),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const promptPolicy = {
    schema: "zob.adaptive-prompt-policy-hint.v1",
    rootCanWriteDirectly: false,
    rootDirectWriteToolsBlocked: ["bash", "edit", "write"],
    promptStackHashRequired: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const documentationPolicy = {
    schema: "zob.adaptive-documentation-policy-hint.v1",
    required: true,
    rootDocs: ["AGENTS.md", "README.md"],
    layerDocsRequired: true,
    roleDocPacksRequired: true,
    writebackPolicy: "human_approval_required",
    maxDocsPerAgent: 12,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  return {
    schema: "zob.compute-workflow-shape.v1",
    runId: input.runId,
    domain: (resolution.domain as ComputeDomain | undefined) ?? input.domain ?? "generic",
    requestedProfile: (resolution.requestedProfile as ComputeRequestedProfile | undefined) ?? input.requestedProfile ?? "auto",
    effectiveProfile,
    resolutionHash: sha256(JSON.stringify(resolution)),
    resolutionEmbedded: false,
    caps: { maxAgents, maxDelegationDepth: maxDepth, maxParallel, maxIterations: caps.maxIterations, maxDurationMs: caps.maxDurationMs, maxContextTokens: caps.maxContextTokens },
    lanes,
    promptPolicy,
    modelPolicy,
    scalePolicy,
    documentationPolicy,
    validationLevel: caps.validationLevel,
    oraclePolicy: caps.oraclePolicy,
    benchmarkLevel: caps.benchmarkLevel,
    adaptiveDelegationPolicyHint: resolution.adaptiveDelegationPolicyHint,
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    liveDispatchEnabled: false,
    noExecution: true,
    networkAccessed: false,
    sourceProjectModified: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    noShip: resolution.noShip === true,
    blockers: Array.isArray(resolution.blockers) ? resolution.blockers : [],
    generatedAt: new Date().toISOString(),
  };
}

export function validateComputeWorkflowShape(shape: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(shape)) return ["workflow shape must be a JSON object"];
  if (shape.schema !== "zob.compute-workflow-shape.v1") errors.push("workflow shape schema must be zob.compute-workflow-shape.v1");
  if (shape.parentOwnedDispatch !== true) errors.push("workflow shape parentOwnedDispatch must be true");
  if (shape.childDirectDispatch !== false) errors.push("workflow shape childDirectDispatch must be false");
  if (shape.liveDispatchEnabled !== false) errors.push("workflow shape liveDispatchEnabled must be false");
  if (shape.noExecution !== true) errors.push("workflow shape noExecution must be true");
  if (!Array.isArray(shape.lanes) || shape.lanes.length < 1) errors.push("workflow shape requires at least one lane");
  if (!isRecord(shape.promptPolicy) || shape.promptPolicy.rootCanWriteDirectly !== false) errors.push("workflow shape promptPolicy must keep rootCanWriteDirectly=false");
  if (!isRecord(shape.modelPolicy) || shape.modelPolicy.downgradePolicy !== "blocked_for_oracle_security") errors.push("workflow shape modelPolicy must block oracle/security downgrade");
  if (!isRecord(shape.scalePolicy) || shape.scalePolicy.stalePeerBlocksCompletion !== true || shape.scalePolicy.duplicateDetectionRequired !== true) errors.push("workflow shape scalePolicy must require stale and duplicate safeguards");
  if (!isRecord(shape.documentationPolicy) || shape.documentationPolicy.roleDocPacksRequired !== true || shape.documentationPolicy.writebackPolicy !== "human_approval_required") errors.push("workflow shape documentationPolicy must require role doc packs and human-approved writeback");
  if (Array.isArray(shape.lanes)) {
    for (const [index, lane] of shape.lanes.entries()) {
      if (!isRecord(lane)) {
        errors.push(`lane ${index} must be an object`);
        continue;
      }
      if (lane.parentOwnedDispatch !== true) errors.push(`lane ${index} parentOwnedDispatch must be true`);
      if (lane.childDirectDispatch !== false) errors.push(`lane ${index} childDirectDispatch must be false`);
      if (!Array.isArray(lane.tools)) errors.push(`lane ${index} tools must be an array`);
    }
  }
  return errors;
}
