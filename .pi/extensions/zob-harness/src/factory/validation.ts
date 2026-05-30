import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadAgentsFromDir } from "../agents.js";
import { DEFAULT_RULES } from "../constants.js";
import { validateOutputContractId } from "../output-contracts.js";
import { normalizeAdaptiveDelegationPolicy, validateAdaptiveDelegationPolicy } from "../orchestration/adaptive-delegation.js";
import { validateToolList } from "../safety.js";
import type { FactoryAdaptiveDispatchGate, FactoryAdaptiveDispatchGateInput, FactoryDefinition, FactoryExecutionMode, FactoryInputManifest, FactoryManifestItem, FactoryOracleReview, FactoryRunInput, FactoryStage } from "../types.js";
import { sha256 } from "../utils/hashing.js";
import { parseJsonFile } from "../utils/json.js";
import { isSafeArtifactName, pathMatches, resolveRepoPath, safeFileStem } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";

function isFactoryManifestItem(value: unknown): value is FactoryManifestItem {
  return isRecord(value) && typeof value.id === "string" && typeof value.path === "string";
}

function isFactoryInputManifest(value: unknown): value is FactoryInputManifest {
  return isRecord(value) && typeof value.factory === "string" && Array.isArray(value.items) && value.items.every(isFactoryManifestItem);
}

function isFactoryStage(value: unknown): value is FactoryStage {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.type === "map" || value.type === "reduce" || value.type === "validate") &&
    typeof value.agent === "string" &&
    typeof value.outputContract === "string" &&
    Array.isArray(value.requiredTools) &&
    value.requiredTools.every((tool) => typeof tool === "string") &&
    typeof value.promptTemplate === "string" &&
    (value.expectedOutcome === undefined || typeof value.expectedOutcome === "string") &&
    (value.context === undefined || typeof value.context === "string") &&
    (value.mustDo === undefined || (Array.isArray(value.mustDo) && value.mustDo.every((item) => typeof item === "string"))) &&
    (value.mustNotDo === undefined || (Array.isArray(value.mustNotDo) && value.mustNotDo.every((item) => typeof item === "string")))
  );
}

function isFactoryDefinition(value: unknown): value is FactoryDefinition {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.description === "string" &&
    (value.defaultMode === undefined || value.defaultMode === "smoke" || value.defaultMode === "pilot" || value.defaultMode === "batch") &&
    (value.expectedArtifacts === undefined || (Array.isArray(value.expectedArtifacts) && value.expectedArtifacts.every((artifact) => typeof artifact === "string"))) &&
    (value.requiredStages === undefined || (Array.isArray(value.requiredStages) && value.requiredStages.every((stage) => typeof stage === "string"))) &&
    (value.stages === undefined || (Array.isArray(value.stages) && value.stages.every(isFactoryStage)))
  );
}

const FACTORY_PHASE_SENTINELS: Record<"smoke" | "pilot" | "batch", string> = {
  smoke: "SMOKE_PASSED.sentinel",
  pilot: "PILOT_PASSED.sentinel",
  batch: "BATCH_PASSED.sentinel",
};

export function factoryPhaseSentinelForMode(mode: "smoke" | "pilot" | "batch"): string {
  return FACTORY_PHASE_SENTINELS[mode];
}

const RESERVED_FACTORY_ARTIFACTS = new Set(["DONE.sentinel", "SMOKE_PASSED.sentinel", "PILOT_PASSED.sentinel", "BATCH_PASSED.sentinel", "validation.json", "manifest.json", "ledger.jsonl", "final-report.md", "agentic-plan.json", "telemetry.json", "checkpoints", "outputs"]);

function validateExpectedArtifacts(artifacts: string[] | undefined, source: string): string[] {
  const errors: string[] = [];
  for (const artifact of artifacts ?? []) {
    if (!isSafeArtifactName(artifact)) errors.push(`${source} expected artifact must be a safe basename: ${artifact}`);
    if (RESERVED_FACTORY_ARTIFACTS.has(artifact)) errors.push(`${source} expected artifact uses reserved factory artifact name: ${artifact}`);
  }
  return errors;
}

const KNOWN_FACTORY_REQUIRED_STAGES = new Set([
  "initialized",
  "manifest_loaded",
  "agentic_plan_written",
  "item_processed",
  "patterns_canonicalized",
  "risks_canonicalized",
  "workflow_rules_written",
  "agent_instructions_written",
  "quality_gates_written",
  "dashboard_summary_written",
  "validation",
  "phase_sentinel",
  "sentinel",
]);

function validateFactoryRequiredStages(definition: FactoryDefinition | undefined): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const stage of definition?.requiredStages ?? []) {
    if (!isSafeArtifactName(stage)) errors.push(`Factory required stage must be path-safe: ${stage}`);
    if (seen.has(stage)) errors.push(`Duplicate factory required stage: ${stage}`);
    seen.add(stage);
    if (!KNOWN_FACTORY_REQUIRED_STAGES.has(stage)) errors.push(`Unknown factory required stage: ${stage}`);
  }
  return errors;
}

export function validateFactoryStages(repoRoot: string, definition: FactoryDefinition | undefined): string[] {
  const errors: string[] = [];
  errors.push(...validateFactoryRequiredStages(definition));
  const stages = definition?.stages ?? [];
  const agents = new Map(loadAgentsFromDir(join(repoRoot, ".pi", "agents"), "project").map((agent) => [agent.name.toLowerCase(), agent]));
  const stageNames = new Set<string>();
  for (const stage of stages) {
    if (!isSafeArtifactName(stage.name)) errors.push(`Factory stage name must be path-safe: ${stage.name}`);
    if (stageNames.has(stage.name)) errors.push(`Duplicate factory stage name: ${stage.name}`);
    stageNames.add(stage.name);
    const agent = agents.get(stage.agent.toLowerCase());
    if (!agent) {
      errors.push(`Factory stage '${stage.name}' references unknown agent '${stage.agent}'`);
    } else {
      errors.push(...validateToolList(agent, stage.requiredTools).map((error) => `Factory stage '${stage.name}': ${error}`));
    }
    errors.push(...validateOutputContractId(stage.outputContract).map((error) => `Factory stage '${stage.name}': ${error}`));
    if (stage.promptTemplate.trim().length === 0) errors.push(`Factory stage '${stage.name}' has an empty promptTemplate`);
  }
  if (stages.length > 0 && !stages.some((stage) => stage.type === "map")) errors.push("Factory stages must include at least one map stage");
  return errors;
}

export function loadFactoryDefinition(repoRoot: string, factoryName: string): { definition?: FactoryDefinition; errors: string[] } {
  if (!/^[a-zA-Z0-9._-]+$/.test(factoryName)) return { errors: [`Invalid factory name '${factoryName}'`] };
  const factoryPath = join(repoRoot, ".pi", "factories", factoryName, "factory.json");
  if (!existsSync(factoryPath)) return { errors: [`Factory not found: ${factoryPath}`] };
  try {
    const parsed = parseJsonFile(factoryPath);
    if (!isFactoryDefinition(parsed)) return { errors: [`Invalid factory definition: ${factoryPath}`] };
    if (parsed.name !== factoryName) return { errors: [`Factory definition name '${parsed.name}' does not match requested '${factoryName}'`] };
    return { definition: parsed, errors: [] };
  } catch (error) {
    return { errors: [`Could not parse factory definition '${factoryPath}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function loadFactoryInputManifest(repoRoot: string, inputManifest: string): { manifest?: FactoryInputManifest; manifestPath: string; errors: string[] } {
  const resolved = resolveRepoPath(repoRoot, inputManifest);
  if (resolved.errors.length > 0) return { manifestPath: resolved.path, errors: resolved.errors };
  if (!existsSync(resolved.path)) return { manifestPath: resolved.path, errors: [`Input manifest not found: ${inputManifest}`] };
  try {
    const parsed = parseJsonFile(resolved.path);
    if (!isFactoryInputManifest(parsed)) return { manifestPath: resolved.path, errors: [`Invalid factory input manifest: ${inputManifest}`] };
    return { manifest: parsed, manifestPath: resolved.path, errors: [] };
  } catch (error) {
    return { manifestPath: resolved.path, errors: [`Could not parse input manifest '${inputManifest}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function isFactoryOracleReview(value: unknown): value is FactoryOracleReview {
  if (!isRecord(value)) return false;
  const schema = value.schema;
  const verdict = value.verdict;
  const noShip = value.no_ship;
  const evidence = value.evidence;
  const reviewer = value.reviewer;
  const reviewedRunId = value.reviewedRunId;
  return (
    (schema === undefined || schema === "zob.oracle-review.v1") &&
    (verdict === undefined || verdict === "PASS" || verdict === "FAIL" || verdict === "WARN") &&
    (noShip === undefined || typeof noShip === "boolean") &&
    (evidence === undefined || typeof evidence === "string") &&
    (reviewer === undefined || typeof reviewer === "string") &&
    (reviewedRunId === undefined || typeof reviewedRunId === "string")
  );
}

function loadFactoryOracleReview(repoRoot: string, oracleReviewPath: string | undefined): { review?: FactoryOracleReview; reviewPath?: string; errors: string[] } {
  const errors: string[] = [];
  if (!oracleReviewPath) return { errors: ["promotion requires oracle_review_path referencing a persisted oracle review artifact"] };
  const resolved = resolveRepoPath(repoRoot, oracleReviewPath);
  if (resolved.errors.length > 0) return { reviewPath: resolved.path, errors: resolved.errors.map((error) => `oracle_review_path: ${error}`) };
  for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
    if (pathMatches(oracleReviewPath, protectedPattern, repoRoot, repoRoot)) errors.push(`oracle_review_path references zero-access path: ${protectedPattern}`);
  }
  if (errors.length > 0) return { reviewPath: resolved.path, errors };
  if (!existsSync(resolved.path)) return { reviewPath: resolved.path, errors: [`Referenced oracle review does not exist: ${oracleReviewPath}`] };
  try {
    const parsed = parseJsonFile(resolved.path);
    if (!isFactoryOracleReview(parsed)) return { reviewPath: resolved.path, errors: [`Invalid oracle review artifact: ${oracleReviewPath}`] };
    return { review: parsed, reviewPath: resolved.path, errors: [] };
  } catch (error) {
    return { reviewPath: resolved.path, errors: [`Could not parse oracle review '${oracleReviewPath}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function summarizeFactoryOracleReview(review: FactoryOracleReview | undefined): Record<string, unknown> | undefined {
  if (!review) return undefined;
  return {
    schema: review.schema ?? "zob.oracle-review.v1",
    verdict: review.verdict,
    no_ship: review.no_ship,
    evidence: review.evidence,
    reviewer: review.reviewer ?? "unspecified",
    reviewedRunId: review.reviewedRunId,
  };
}

function validateOracleReviewForPromotion(repoRoot: string, input: FactoryRunInput, reviewedRunId: string | undefined, phase: "pilot" | "batch", prerequisiteField: "prerequisite_smoke_run_id" | "prerequisite_pilot_run_id"): string[] {
  const loaded = loadFactoryOracleReview(repoRoot, input.oracle_review_path);
  const errors = [...loaded.errors];
  const review = loaded.review;
  if (!review) return errors;

  if (review.schema !== "zob.oracle-review.v1") errors.push("oracle review schema must be zob.oracle-review.v1");
  if (review.reviewedRunId !== reviewedRunId) errors.push(`oracle review reviewedRunId must match ${prerequisiteField}`);
  if (review.verdict !== "PASS") errors.push(`${phase} oracle review verdict must be PASS`);
  if (review.no_ship !== false) errors.push(`${phase} oracle review no_ship must be false`);
  if (typeof review.evidence !== "string" || review.evidence.trim().length === 0) errors.push(`${phase} oracle review evidence is required`);

  const inlineGate = input.oracle_gate;
  if (isRecord(inlineGate)) {
    if (inlineGate.verdict !== undefined && inlineGate.verdict !== review.verdict) errors.push("inline oracle_gate verdict conflicts with oracle_review_path");
    if (inlineGate.no_ship !== undefined && inlineGate.no_ship !== review.no_ship) errors.push("inline oracle_gate no_ship conflicts with oracle_review_path");
    if (typeof inlineGate.evidence === "string" && inlineGate.evidence.trim().length > 0 && inlineGate.evidence.trim() !== review.evidence?.trim()) errors.push("inline oracle_gate evidence conflicts with oracle_review_path");
  }

  return errors;
}

function validatePilotGate(repoRoot: string, input: FactoryRunInput, factoryName: string, mode: string, execution: FactoryExecutionMode): string[] {
  const errors: string[] = [];
  if (mode !== "pilot" || execution === "plan_only") return errors;

  const smokeRunId = input.prerequisite_smoke_run_id;
  if (!smokeRunId) {
    errors.push("pilot requires prerequisite_smoke_run_id referencing a completed smoke run");
  } else if (safeFileStem(smokeRunId) !== smokeRunId) {
    errors.push(`prerequisite_smoke_run_id must be path-safe: ${smokeRunId}`);
  } else {
    const smokeRunDir = join(repoRoot, "reports", "factory-runs", smokeRunId);
    const smokeValidationPath = join(smokeRunDir, "validation.json");
    const smokePhaseSentinelPath = join(smokeRunDir, "SMOKE_PASSED.sentinel");
    const smokeDoneSentinelPath = join(smokeRunDir, "DONE.sentinel");
    if (!existsSync(smokeRunDir)) errors.push(`Referenced smoke run does not exist: ${smokeRunId}`);
    if (!existsSync(smokePhaseSentinelPath)) errors.push(`Referenced smoke run is missing SMOKE_PASSED.sentinel: ${smokeRunId}`);
    if (!existsSync(smokeDoneSentinelPath)) errors.push(`Referenced smoke run is missing DONE.sentinel: ${smokeRunId}`);
    if (!existsSync(smokeValidationPath)) {
      errors.push(`Referenced smoke run is missing validation.json: ${smokeRunId}`);
    } else {
      try {
        const smokeValidation = parseJsonFile(smokeValidationPath);
        if (!isRecord(smokeValidation)) {
          errors.push(`Referenced smoke validation is not an object: ${smokeRunId}`);
        } else {
          if (smokeValidation.factory !== factoryName) errors.push(`Referenced smoke run factory does not match '${factoryName}': ${smokeRunId}`);
          if (smokeValidation.mode !== "smoke") errors.push(`Referenced prerequisite run is not mode=smoke: ${smokeRunId}`);
          if (smokeValidation.status !== "passed") errors.push(`Referenced smoke run validation did not pass: ${smokeRunId}`);
          const phaseSentinel = isRecord(smokeValidation.phaseSentinel) ? smokeValidation.phaseSentinel : undefined;
          if (phaseSentinel?.artifact !== "SMOKE_PASSED.sentinel" || phaseSentinel?.written !== true) errors.push(`Referenced smoke validation does not record SMOKE_PASSED.sentinel: ${smokeRunId}`);
          if (smokeValidation.sentinelWritten !== true) errors.push(`Referenced smoke validation does not record DONE.sentinel: ${smokeRunId}`);
        }
      } catch (error) {
        errors.push(`Could not parse referenced smoke validation '${smokeValidationPath}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  errors.push(...validateOracleReviewForPromotion(repoRoot, input, smokeRunId, "pilot", "prerequisite_smoke_run_id"));
  return errors;
}

function validateFactoryBudgetInput(input: FactoryRunInput): string[] {
  const errors: string[] = [];
  const budget = input.budget;
  if (budget === undefined) return errors;
  const numericKeys = ["maxCostUsd", "maxRuns", "maxDurationMs", "maxParallelChildren", "estimatedCostUsd", "estimatedRuns", "estimatedDurationMs", "estimatedParallelChildren"] as const;
  for (const key of numericKeys) {
    const value = budget[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) errors.push(`budget.${key} must be a nonnegative finite number`);
  }
  if (budget.strictEnabled !== undefined && typeof budget.strictEnabled !== "boolean") errors.push("budget.strictEnabled must be boolean");
  if (budget.strictRequested !== undefined && typeof budget.strictRequested !== "boolean") errors.push("budget.strictRequested must be boolean");
  return errors;
}

function isLowerSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function normalizeFactoryAdaptiveDispatchGate(input?: FactoryAdaptiveDispatchGateInput): FactoryAdaptiveDispatchGate | undefined {
  if (!input) return undefined;
  const proofRunId = typeof input.proofRunId === "string" ? input.proofRunId.trim() : "";
  const approvedBy = typeof input.approvedBy === "string" ? input.approvedBy.trim() : "";
  const approvalId = typeof input.approvalId === "string" ? input.approvalId.trim() : "";
  const scope = typeof input.scope === "string" ? input.scope.trim() : "";
  const liveReadOnlyProofEnabled = input.enabled === true && input.liveReadOnlyProofEnabled === true;
  return {
    schema: "zob.factory-adaptive-dispatch-gate.v1",
    enabled: input.enabled === true,
    liveReadOnlyProofEnabled,
    proofRunIdHash: proofRunId ? sha256(proofRunId) : undefined,
    proofReviewHash: typeof input.proofReviewHash === "string" ? input.proofReviewHash : undefined,
    approvedByHash: approvedBy ? sha256(approvedBy) : undefined,
    approvedAt: typeof input.approvedAt === "string" && input.approvedAt.trim().length > 0 ? input.approvedAt.trim() : undefined,
    approvalIdHash: approvalId ? sha256(approvalId) : undefined,
    scopeHash: scope ? sha256(scope) : undefined,
    liveFactoryAdaptiveDispatchEnabled: liveReadOnlyProofEnabled,
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function validateFactoryAdaptiveDispatchGate(gate?: FactoryAdaptiveDispatchGate): string[] {
  const errors: string[] = [];
  if (!gate) return errors;
  if (gate.enabled === true) {
    if (!isLowerSha256(gate.proofRunIdHash)) errors.push("adaptive_factory_dispatch_gate.proofRunId is required and stored as proofRunIdHash");
    if (!isLowerSha256(gate.proofReviewHash)) errors.push("adaptive_factory_dispatch_gate.proofReviewHash must be lowercase sha256 hex");
    if (!isLowerSha256(gate.approvedByHash)) errors.push("adaptive_factory_dispatch_gate.approvedBy is required and stored as approvedByHash");
    if (!isLowerSha256(gate.approvalIdHash)) errors.push("adaptive_factory_dispatch_gate.approvalId is required and stored as approvalIdHash");
    if (typeof gate.approvedAt !== "string" || gate.approvedAt.trim().length === 0) errors.push("adaptive_factory_dispatch_gate.approvedAt is required");
    if (gate.scopeHash !== undefined && !isLowerSha256(gate.scopeHash)) errors.push("adaptive_factory_dispatch_gate.scopeHash must be lowercase sha256 hex");
  }
  if (gate.liveReadOnlyProofEnabled === true && gate.enabled !== true) errors.push("adaptive_factory_dispatch_gate liveReadOnlyProofEnabled requires enabled=true");
  if (gate.liveFactoryAdaptiveDispatchEnabled !== gate.liveReadOnlyProofEnabled) errors.push("adaptive_factory_dispatch_gate liveFactoryAdaptiveDispatchEnabled must equal liveReadOnlyProofEnabled");
  if (gate.productionWritesPerformed !== false || gate.autoApply !== false) errors.push("adaptive_factory_dispatch_gate must keep production writes and auto-apply disabled");
  if (gate.parentOwnedDispatch !== true || gate.childDirectDispatch !== false) errors.push("adaptive_factory_dispatch_gate must preserve parentOwnedDispatch=true and childDirectDispatch=false");
  if (gate.bodyStored !== false || gate.promptBodiesStored !== false || gate.outputBodiesStored !== false) errors.push("adaptive_factory_dispatch_gate must be hash-only with body flags false");
  return errors;
}

function validateFactoryAdaptiveDelegationInput(input: FactoryRunInput, mode: string, execution: FactoryExecutionMode): string[] {
  const policy = normalizeAdaptiveDelegationPolicy(input.adaptive_delegation);
  const gate = normalizeFactoryAdaptiveDispatchGate(input.adaptive_factory_dispatch_gate);
  const errors = [
    ...validateAdaptiveDelegationPolicy(policy).map((error) => `factory adaptive_delegation: ${error}`),
    ...validateFactoryAdaptiveDispatchGate(gate).map((error) => `factory ${error}`),
  ];
  if (!policy.enabled) return errors;
  if (policy.dispatch === true) {
    if (gate?.enabled !== true) errors.push("factory adaptive_delegation live dispatch requires adaptive_factory_dispatch_gate.enabled=true with hash-only proof metadata");
    if (gate?.liveReadOnlyProofEnabled !== true) errors.push("factory adaptive_delegation live dispatch requires adaptive_factory_dispatch_gate.liveReadOnlyProofEnabled=true");
    if (execution !== "agentic") errors.push("factory adaptive_delegation live dispatch proof gate requires execution=agentic");
    if (mode !== "smoke") errors.push("factory adaptive_delegation live dispatch proof gate is smoke-only until a registered proof passes");
    if (policy.mode !== "when_pertinent") errors.push("factory adaptive_delegation live dispatch proof gate requires mode=when_pertinent");
    if (policy.runtimeMaxDepth > 2) errors.push("factory adaptive_delegation live read-only proof runtimeMaxDepth must be <= 2");
    if (policy.maxTotalAgentsWithOracle > 4) errors.push("factory adaptive_delegation live read-only proof maxTotalAgentsWithOracle must be <= 4");
  } else if (policy.mode !== "advisory_only") {
    errors.push("factory adaptive_delegation P8 supports only mode=advisory_only unless a future live proof gate is activated");
  }
  return errors;
}

function validateFactoryModelRoutingInput(input: FactoryRunInput): string[] {
  const errors: string[] = [];
  const routing = input.model_routing;
  if (routing === undefined) return errors;
  if (routing.enabled !== undefined && typeof routing.enabled !== "boolean") errors.push("model_routing.enabled must be boolean");
  if (routing.risk !== undefined && routing.risk !== "low" && routing.risk !== "medium" && routing.risk !== "high") errors.push("model_routing.risk must be low, medium, or high");
  if (routing.contextTokens !== undefined && (typeof routing.contextTokens !== "number" || !Number.isFinite(routing.contextTokens) || routing.contextTokens < 0)) errors.push("model_routing.contextTokens must be a nonnegative finite number");
  if (routing.modelByClass !== undefined) {
    if (!isRecord(routing.modelByClass)) {
      errors.push("model_routing.modelByClass must be an object when provided");
    } else {
      for (const [modelClass, modelName] of Object.entries(routing.modelByClass)) {
        if (!/^[a-zA-Z0-9._-]+$/.test(modelClass)) errors.push(`model_routing.modelByClass key must be path-safe/model-class-safe: ${modelClass}`);
        if (typeof modelName !== "string" || modelName.trim().length === 0) errors.push(`model_routing.modelByClass.${modelClass} must be a non-empty string`);
      }
    }
  }
  return errors;
}

function validateBatchGate(repoRoot: string, input: FactoryRunInput, factoryName: string, mode: string, execution: FactoryExecutionMode): string[] {
  const errors: string[] = [];
  if (mode !== "batch" || execution === "plan_only") return errors;

  const concurrency = input.batch_concurrency;
  if (concurrency === undefined) {
    errors.push("batch requires batch_concurrency as a positive concurrency cap");
  } else if (!Number.isInteger(concurrency) || concurrency < 1) {
    errors.push("batch_concurrency must be a positive integer");
  }

  const pilotRunId = input.prerequisite_pilot_run_id;
  if (!pilotRunId) {
    errors.push("batch requires prerequisite_pilot_run_id referencing a completed pilot run");
  } else if (safeFileStem(pilotRunId) !== pilotRunId) {
    errors.push(`prerequisite_pilot_run_id must be path-safe: ${pilotRunId}`);
  } else {
    const pilotRunDir = join(repoRoot, "reports", "factory-runs", pilotRunId);
    const pilotValidationPath = join(pilotRunDir, "validation.json");
    const pilotPhaseSentinelPath = join(pilotRunDir, "PILOT_PASSED.sentinel");
    const pilotDoneSentinelPath = join(pilotRunDir, "DONE.sentinel");
    if (!existsSync(pilotRunDir)) errors.push(`Referenced pilot run does not exist: ${pilotRunId}`);
    if (!existsSync(pilotPhaseSentinelPath)) errors.push(`Referenced pilot run is missing PILOT_PASSED.sentinel: ${pilotRunId}`);
    if (!existsSync(pilotDoneSentinelPath)) errors.push(`Referenced pilot run is missing DONE.sentinel: ${pilotRunId}`);
    if (!existsSync(pilotValidationPath)) {
      errors.push(`Referenced pilot run is missing validation.json: ${pilotRunId}`);
    } else {
      try {
        const pilotValidation = parseJsonFile(pilotValidationPath);
        if (!isRecord(pilotValidation)) {
          errors.push(`Referenced pilot validation is not an object: ${pilotRunId}`);
        } else {
          if (pilotValidation.factory !== factoryName) errors.push(`Referenced pilot run factory does not match '${factoryName}': ${pilotRunId}`);
          if (pilotValidation.mode !== "pilot") errors.push(`Referenced prerequisite run is not mode=pilot: ${pilotRunId}`);
          if (pilotValidation.status !== "passed") errors.push(`Referenced pilot run validation did not pass: ${pilotRunId}`);
          const phaseSentinel = isRecord(pilotValidation.phaseSentinel) ? pilotValidation.phaseSentinel : undefined;
          if (phaseSentinel?.artifact !== "PILOT_PASSED.sentinel" || phaseSentinel?.written !== true) errors.push(`Referenced pilot validation does not record PILOT_PASSED.sentinel: ${pilotRunId}`);
          if (pilotValidation.sentinelWritten !== true) errors.push(`Referenced pilot validation does not record DONE.sentinel: ${pilotRunId}`);
        }
      } catch (error) {
        errors.push(`Could not parse referenced pilot validation '${pilotValidationPath}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  errors.push(...validateOracleReviewForPromotion(repoRoot, input, pilotRunId, "batch", "prerequisite_pilot_run_id"));
  return errors;
}

export function validateFactoryRunInputs(repoRoot: string, input: FactoryRunInput): string[] {
  const errors: string[] = [];
  const factory = loadFactoryDefinition(repoRoot, input.factory);
  errors.push(...factory.errors);
  errors.push(...validateExpectedArtifacts(factory.definition?.expectedArtifacts, "factory"));
  errors.push(...validateFactoryStages(repoRoot, factory.definition));
  const manifest = loadFactoryInputManifest(repoRoot, input.input_manifest);
  errors.push(...manifest.errors);
  errors.push(...validateExpectedArtifacts(manifest.manifest?.expectedArtifacts, "manifest"));
  if (manifest.manifest && manifest.manifest.factory !== input.factory) errors.push(`Manifest factory '${manifest.manifest.factory}' does not match requested '${input.factory}'`);
  if (input.run_id && safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (input.max_items !== undefined && (!Number.isInteger(input.max_items) || input.max_items < 1)) errors.push("max_items must be a positive integer");
  if (input.batch_concurrency !== undefined && (!Number.isInteger(input.batch_concurrency) || input.batch_concurrency < 1)) errors.push("batch_concurrency must be a positive integer");
  errors.push(...validateFactoryBudgetInput(input));
  errors.push(...validateFactoryModelRoutingInput(input));
  const mode = input.mode ?? factory.definition?.defaultMode ?? "smoke";
  const execution = input.execution ?? "deterministic";
  if (!["smoke", "pilot", "batch"].includes(mode)) errors.push(`Invalid factory mode '${mode}'`);
  if (input.execution !== undefined && !["deterministic", "plan_only", "agentic"].includes(input.execution)) errors.push(`Invalid factory execution '${input.execution}'`);
  errors.push(...validateFactoryAdaptiveDelegationInput(input, mode, execution));
  errors.push(...validatePilotGate(repoRoot, input, input.factory, mode, execution));
  errors.push(...validateBatchGate(repoRoot, input, input.factory, mode, execution));
  for (const item of manifest.manifest?.items ?? []) {
    const itemPath = resolveRepoPath(repoRoot, item.path);
    errors.push(...itemPath.errors.map((error) => `Item '${item.id}': ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(item.path, protectedPattern, repoRoot, repoRoot)) errors.push(`Item '${item.id}' references zero-access path: ${protectedPattern}`);
    }
  }
  return errors;
}

export { FACTORY_PHASE_SENTINELS, loadFactoryOracleReview, summarizeFactoryOracleReview };
