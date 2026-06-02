import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../../core/utils/hashing.js";
import { isRecord } from "../../core/utils/records.js";
import { advancePromotionCandidate, createPromotionCandidate, promotionCandidateDir, promotionCandidateRef, validatePromotionCandidate, writePromotionCandidate } from "./candidate.js";
import type { PromotionCandidateRecord } from "./types.js";

export interface FactoryPromotionInput {
  candidateId?: string;
  runId: string;
  goalId?: string;
  todoId?: string;
  sourceRef: string;
  factoryName: string;
  manifest: Record<string, unknown>;
}

function safeFactoryName(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value) && !value.includes("..") && value.length > 0;
}

function hasForbiddenRawKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenRawKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => ["body", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch", "transcript"].includes(key) || hasForbiddenRawKeys(child));
}

export function prepareFactoryPromotion(repoRoot: string, input: FactoryPromotionInput): { candidate: PromotionCandidateRecord; manifestRef: string; validationRef: string } {
  if (!safeFactoryName(input.factoryName)) throw new Error(`Unsafe factory name: ${input.factoryName}`);
  if (hasForbiddenRawKeys(input.manifest)) throw new Error("factory promotion manifest metadata must be body-free/hash-only");
  const candidate = createPromotionCandidate({
    candidateId: input.candidateId,
    kind: "factory",
    runId: input.runId,
    goalId: input.goalId,
    todoId: input.todoId,
    sourceRef: input.sourceRef,
    allowedPaths: [`.pi/factories/${input.factoryName}`, `reports/factory-runs/${input.factoryName}`],
    changedPaths: [`.pi/factories/${input.factoryName}/manifest.json`],
    comsThreadRef: input.candidateId ? promotionCandidateRef(input.candidateId, "promotion-coms-thread.json") : undefined,
    metadata: { lane: "factory", factoryName: input.factoryName },
  });
  const candidateDir = promotionCandidateDir(repoRoot, candidate.candidateId);
  mkdirSync(join(candidateDir, "factory"), { recursive: true });
  const manifestRecord = {
    schema: "zob.factory-promotion-manifest-draft.v1",
    candidateId: candidate.candidateId,
    factoryName: input.factoryName,
    manifestHash: sha256(JSON.stringify(input.manifest)),
    manifestMetadata: input.manifest,
    requiresSmoke: true,
    requiresPilot: true,
    requiresOracle: true,
    requiresHumanApproval: true,
    activationSentinelWritten: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const manifestRef = promotionCandidateRef(candidate.candidateId, "factory/manifest-draft.json");
  writeFileSync(join(repoRoot, manifestRef), JSON.stringify(manifestRecord, null, 2), "utf8");
  const validationErrors = validateFactoryPromotionManifest(manifestRecord);
  const validationRef = promotionCandidateRef(candidate.candidateId, "factory/validation.json");
  writeFileSync(join(repoRoot, validationRef), JSON.stringify({ schema: "zob.factory-promotion-validation.v1", candidateId: candidate.candidateId, valid: validationErrors.length === 0, errors: validationErrors, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  const prepared = advancePromotionCandidate(repoRoot, { ...candidate, comsThreadRef: promotionCandidateRef(candidate.candidateId, "promotion-coms-thread.json") }, { toStatus: "prepared", preparedArtifactRef: manifestRef, validationRefs: validationErrors.length === 0 ? [validationRef] : [] });
  writePromotionCandidate(repoRoot, prepared);
  return { candidate: prepared, manifestRef, validationRef };
}

export function activateFactoryPromotionInQuarantine(repoRoot: string, candidate: PromotionCandidateRecord): { candidate: PromotionCandidateRecord; sentinelRef: string } {
  if (candidate.kind !== "factory") throw new Error("candidate kind must be factory");
  if (candidate.status !== "approved") throw new Error("factory activation requires approved candidate");
  const preflightErrors = validateFactoryPromotionCandidate(repoRoot, candidate);
  if (preflightErrors.length > 0) throw new Error(preflightErrors.join("; "));
  const applied = advancePromotionCandidate(repoRoot, candidate, { toStatus: "applied", applyScope: "quarantine_test_directory", applyPerformed: true });
  const sentinelRef = promotionCandidateRef(candidate.candidateId, "factory/ACTIVATED.sentinel");
  writeFileSync(join(repoRoot, sentinelRef), `factory promotion activated in quarantine for ${candidate.candidateId}\n`, "utf8");
  writePromotionCandidate(repoRoot, applied);
  return { candidate: applied, sentinelRef };
}

export function validateFactoryPromotionManifest(artifact: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(artifact)) return ["factory promotion manifest must be an object"];
  if (artifact.schema !== "zob.factory-promotion-manifest-draft.v1") errors.push("factory promotion manifest schema mismatch");
  if (artifact.requiresSmoke !== true || artifact.requiresPilot !== true || artifact.requiresOracle !== true || artifact.requiresHumanApproval !== true) errors.push("factory promotion requires smoke, pilot, oracle, and human approval gates");
  if (artifact.activationSentinelWritten !== false) errors.push("activation sentinel must not be written during preparation");
  if (artifact.bodyStored !== false || artifact.promptBodiesStored !== false || artifact.outputBodiesStored !== false) errors.push("factory promotion manifest must keep body flags false");
  if (hasForbiddenRawKeys(artifact)) errors.push("factory promotion manifest must not include raw body-like keys");
  return errors;
}

export function validateFactoryPromotionCandidate(repoRoot: string, candidate: PromotionCandidateRecord): string[] {
  const errors = validatePromotionCandidate(repoRoot, candidate);
  if (candidate.kind !== "factory") errors.push("candidate kind must be factory");
  if (candidate.productionWritesPerformed !== false || candidate.autoApply !== false) errors.push("factory candidate must not perform production writes or auto-apply");
  if (["oracle_reviewed", "approved", "applied"].includes(candidate.status)) {
    const smokeRef = candidate.validationRefs.find((ref) => ref.endsWith("/factory/smoke.json") || ref.endsWith("factory/smoke.json"));
    const pilotRef = candidate.validationRefs.find((ref) => ref.endsWith("/factory/pilot.json") || ref.endsWith("factory/pilot.json"));
    if (!smokeRef) errors.push("factory promotion requires persisted smoke ref before oracle/approval/apply");
    else if (!existsSync(join(repoRoot, smokeRef))) errors.push(`factory smoke ref does not exist: ${smokeRef}`);
    if (!pilotRef) errors.push("factory promotion requires persisted pilot ref before oracle/approval/apply");
    else if (!existsSync(join(repoRoot, pilotRef))) errors.push(`factory pilot ref does not exist: ${pilotRef}`);
  }
  return errors;
}
