import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DEFAULT_RULES } from "./constants.js";
import { createDiffGateResult, createRollbackMetadata, createSandboxMetadata, validateRuntimeWritePolicy } from "./safety.js";
import { sha256 } from "./utils/hashing.js";
import { parseJsonFile } from "./utils/json.js";
import { pathMatches, resolveRepoPath, safeFileStem, safeRunId } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

export type SandboxWriteAction = "create" | "update";

export interface SandboxWritePlanChange {
  path: string;
  action: SandboxWriteAction;
  contentHash: string;
  reason?: string;
}

export interface SandboxWritePlanInput {
  run_id?: string;
  allowed_paths: string[];
  forbidden_paths?: string[];
  changes: SandboxWritePlanChange[];
  base_ref?: string;
}

export interface SandboxWritePlanResult {
  runId: string;
  runDir: string;
  sandboxRoot: string;
  status: "planned_safe" | "blocked_preflight";
  changedPaths: string[];
  diffHash?: string;
  artifacts: string[];
  errors: string[];
}

export interface SandboxApplyReadinessInput {
  run_id: string;
  oracle_review_path?: string;
  diff_review_gate_path?: string;
  apply_id?: string;
  approval?: {
    approvedBy?: string;
    approvedAt?: string;
    approvalId?: string;
  };
}

export interface SandboxApplyReadinessResult {
  runId: string;
  applyId: string;
  reviewDir: string;
  status: "ready_for_manual_apply" | "blocked_preflight";
  applyReady: boolean;
  applyPerformed: false;
  artifacts: string[];
  errors: string[];
}

export interface SandboxApplySimulationInput {
  run_id: string;
  apply_readiness_path?: string;
  simulation_id?: string;
}

export interface SandboxApplySimulationResult {
  runId: string;
  simulationId: string;
  simulationDir: string;
  targetWorkspace: string;
  status: "simulated_apply_in_temp_workspace" | "blocked_preflight";
  simulatedApplyPerformed: boolean;
  productionWritesPerformed: false;
  autoApply: false;
  artifacts: string[];
  errors: string[];
}

export interface SandboxManualApplyPreflightInput {
  run_id: string;
  apply_readiness_path?: string;
  apply_simulation_path?: string;
  preflight_id?: string;
  confirmation_phrase?: string;
}

export interface SandboxManualApplyPreflightResult {
  runId: string;
  preflightId: string;
  preflightDir: string;
  status: "manual_apply_preflight_passed" | "blocked_preflight";
  manualApplyPreflightPassed: boolean;
  applyPerformed: false;
  productionWritesPerformed: false;
  autoApply: false;
  artifacts: string[];
  errors: string[];
}

export interface SandboxIsolatedExecutionInput {
  run_id: string;
  execution_id?: string;
}

export interface SandboxIsolatedExecutionResult {
  runId: string;
  executionId: string;
  executionDir: string;
  status: "executed_in_sandbox" | "blocked_preflight";
  isolatedExecutionPerformed: boolean;
  productionWritesPerformed: false;
  artifacts: string[];
  errors: string[];
}

export interface SandboxDiffReviewGateInput {
  run_id: string;
  oracle_review_path?: string;
  review_id?: string;
}

export interface SandboxDiffReviewGateResult {
  runId: string;
  reviewId: string;
  reviewDir: string;
  status: "diff_review_passed" | "blocked_preflight";
  reviewPassed: boolean;
  applyReadyUnlocked: boolean;
  applyPerformed: false;
  productionWritesPerformed: false;
  artifacts: string[];
  errors: string[];
}

const HEX_SHA256 = /^[a-f0-9]{64}$/i;
const FORBIDDEN_PLAINTEXT_KEYS = new Set(["task", "prompt", "output", "body", "content", "patch", "diff"]);

function containsForbiddenPlaintextKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenPlaintextKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_PLAINTEXT_KEYS.has(key) || containsForbiddenPlaintextKeys(child));
}

function sandboxLedger(runDir: string, entry: Record<string, unknown>): void {
  appendFileSync(join(runDir, "ledger.jsonl"), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
}

function readRecord(path: string, errors: string[], label: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    errors.push(`${label} is missing: ${path}`);
    return undefined;
  }
  try {
    const parsed = parseJsonFile(path);
    if (!isRecord(parsed)) {
      errors.push(`${label} is not a JSON object: ${path}`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    errors.push(`${label} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function artifactHash(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return sha256(readFileSync(path, "utf8"));
}

function expectedManualApplyPreflightConfirmation(runId: string, preflightId: string): string {
  return `CONFIRM SANDBOX MANUAL APPLY PREFLIGHT ${runId} ${preflightId}`;
}

function normalizeChanges(changes: SandboxWritePlanChange[]): Array<Record<string, unknown>> {
  return changes.map((change) => ({
    path: change.path,
    action: change.action,
    contentHash: change.contentHash,
    ...(change.reason ? { reasonHash: sha256(change.reason) } : {}),
    bodyStored: false,
  }));
}

function changesFromManifest(manifest: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (!manifest || !Array.isArray(manifest.changes)) return [];
  return manifest.changes.filter(isRecord).map((change) => ({
    path: typeof change.path === "string" ? change.path : "unknown",
    action: change.action === "create" || change.action === "update" ? change.action : "unknown",
    contentHash: typeof change.contentHash === "string" ? change.contentHash : undefined,
    reasonHash: typeof change.reasonHash === "string" ? change.reasonHash : undefined,
    bodyStored: false,
  }));
}

function sandboxRootFromManifest(repoRoot: string, runId: string, manifest: Record<string, unknown> | undefined, errors: string[]): string | undefined {
  if (!manifest || typeof manifest.sandboxRoot !== "string") {
    errors.push("sandbox manifest requires sandboxRoot");
    return undefined;
  }
  const resolved = resolveRepoPath(repoRoot, manifest.sandboxRoot);
  errors.push(...resolved.errors.map((error) => `sandboxRoot: ${error}`));
  const requiredPrefix = resolve(repoRoot, ".pi", "tmp", "sandbox-runs", runId);
  if (resolved.path !== requiredPrefix && !resolved.path.startsWith(`${requiredPrefix}/`)) errors.push("sandboxRoot must stay inside this run's .pi/tmp/sandbox-runs workspace");
  return resolved.path;
}

function sameStringSet(left: unknown, right: string[]): boolean {
  if (!Array.isArray(left) || !left.every((item) => typeof item === "string")) return false;
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function isInsidePath(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}/`);
}

function findIsolatedExecutionValidations(sandboxRoot: string | undefined): Array<Record<string, unknown>> {
  if (!sandboxRoot) return [];
  const root = join(sandboxRoot, "isolated-executions");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map((executionId): Record<string, unknown> | undefined => {
      const validationPath = join(root, executionId, "validation.json");
      const sentinelPath = join(root, executionId, "SANDBOX_ISOLATED_EXECUTION_COMPLETE.sentinel");
      if (!existsSync(validationPath)) return undefined;
      try {
        const parsed = parseJsonFile(validationPath);
        if (!isRecord(parsed)) return undefined;
        return {
          executionId,
          validationPath,
          sentinelPath,
          sentinelPresent: existsSync(sentinelPath),
          status: parsed.status,
          isolatedExecutionPerformed: parsed.isolatedExecutionPerformed,
          productionWritesPerformed: parsed.productionWritesPerformed,
          autoApply: parsed.autoApply,
          markerCount: parsed.markerCount,
          errors: parsed.errors,
          bodyStored: false,
        };
      } catch {
        return undefined;
      }
    })
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

export function validateSandboxWritePlanInputs(repoRoot: string, input: SandboxWritePlanInput): string[] {
  const errors: string[] = [];
  if (input.run_id && safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (!Array.isArray(input.allowed_paths) || input.allowed_paths.length === 0) errors.push("sandbox write plan requires non-empty allowed_paths");
  if (!Array.isArray(input.changes) || input.changes.length === 0) errors.push("sandbox write plan requires at least one planned change");
  if (containsForbiddenPlaintextKeys(input)) errors.push("sandbox write plan metadata must not include plaintext task/prompt/output/body/content/patch/diff keys");

  for (const allowedPath of input.allowed_paths ?? []) {
    const resolved = resolveRepoPath(repoRoot, allowedPath);
    errors.push(...resolved.errors.map((error) => `allowed_paths: ${error}`));
  }
  for (const forbiddenPath of input.forbidden_paths ?? []) {
    const resolved = resolveRepoPath(repoRoot, forbiddenPath);
    errors.push(...resolved.errors.map((error) => `forbidden_paths: ${error}`));
  }

  for (const [index, change] of (input.changes ?? []).entries()) {
    const label = `changes[${index}]`;
    if (!change || typeof change !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (change.action !== "create" && change.action !== "update") errors.push(`${label}.action must be create or update; delete/apply is not supported`);
    if (typeof change.path !== "string" || change.path.trim().length === 0) errors.push(`${label}.path is required`);
    if (typeof change.contentHash !== "string" || !HEX_SHA256.test(change.contentHash)) errors.push(`${label}.contentHash must be a sha256 hex hash; plaintext content is not stored`);
    if (typeof change.path === "string") {
      const resolved = resolveRepoPath(repoRoot, change.path);
      errors.push(...resolved.errors.map((error) => `${label}: ${error}`));
      const policy = validateRuntimeWritePolicy({
        targetPath: change.path,
        cwd: repoRoot,
        allowedPaths: input.allowed_paths,
        forbiddenPaths: input.forbidden_paths,
        zeroAccessPaths: DEFAULT_RULES.zeroAccessPaths,
        readOnlyPaths: DEFAULT_RULES.readOnlyPaths,
      });
      errors.push(...policy.violations.map((violation) => `${label}: ${violation}`));
      if (change.action === "update" && !existsSync(resolved.path)) errors.push(`${label}.path does not exist for update: ${change.path}`);
    }
  }

  return errors;
}

export function validateSandboxApplyReadinessInputs(repoRoot: string, input: SandboxApplyReadinessInput): string[] {
  const errors: string[] = [];
  if (!input.run_id || safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  const applyId = input.apply_id ?? "manual-apply-review";
  if (safeFileStem(applyId) !== applyId) errors.push(`apply_id must be path-safe: ${applyId}`);
  if (!input.oracle_review_path) {
    errors.push("sandbox apply readiness requires oracle_review_path");
  } else {
    const resolvedOracle = resolveRepoPath(repoRoot, input.oracle_review_path);
    errors.push(...resolvedOracle.errors.map((error) => `oracle_review_path: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(input.oracle_review_path, protectedPattern, repoRoot, repoRoot)) errors.push(`oracle_review_path references zero-access path: ${protectedPattern}`);
    }
  }
  if (!input.diff_review_gate_path) {
    errors.push("sandbox apply readiness requires diff_review_gate_path");
  } else {
    const resolvedDiffReview = resolveRepoPath(repoRoot, input.diff_review_gate_path);
    errors.push(...resolvedDiffReview.errors.map((error) => `diff_review_gate_path: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(input.diff_review_gate_path, protectedPattern, repoRoot, repoRoot)) errors.push(`diff_review_gate_path references zero-access path: ${protectedPattern}`);
    }
  }
  if (!input.approval || typeof input.approval.approvedBy !== "string" || input.approval.approvedBy.trim().length === 0) errors.push("sandbox apply readiness requires approval.approvedBy");
  if (!input.approval || typeof input.approval.approvedAt !== "string" || input.approval.approvedAt.trim().length === 0) errors.push("sandbox apply readiness requires approval.approvedAt");
  if (!input.approval || typeof input.approval.approvalId !== "string" || input.approval.approvalId.trim().length === 0) errors.push("sandbox apply readiness requires approval.approvalId");
  if (containsForbiddenPlaintextKeys(input)) errors.push("sandbox apply readiness metadata must not include plaintext task/prompt/output/body/content/patch/diff keys");

  const runDir = join(repoRoot, "reports", "sandbox-runs", input.run_id ?? "invalid-run");
  const manifest = readRecord(join(runDir, "manifest.json"), errors, "sandbox manifest");
  const validation = readRecord(join(runDir, "validation.json"), errors, "sandbox validation");
  const diffGate = readRecord(join(runDir, "diff-gate.json"), errors, "diff gate");
  const rollback = readRecord(join(runDir, "rollback-metadata.json"), errors, "rollback metadata");
  const oracleReviewPath = input.oracle_review_path ? resolveRepoPath(repoRoot, input.oracle_review_path).path : undefined;
  const oracleReview = oracleReviewPath ? readRecord(oracleReviewPath, errors, "oracle review") : undefined;
  const diffReviewGatePath = input.diff_review_gate_path ? resolveRepoPath(repoRoot, input.diff_review_gate_path).path : undefined;
  const diffReviewGate = diffReviewGatePath ? readRecord(diffReviewGatePath, errors, "sandbox diff review gate") : undefined;

  if (manifest) {
    if (manifest.schema !== "zob.sandbox-write-plan.v1") errors.push("sandbox manifest schema must be zob.sandbox-write-plan.v1");
    if (manifest.runId !== input.run_id) errors.push("sandbox manifest runId must match input run_id");
    if (manifest.status !== "planned_safe") errors.push("sandbox manifest must be planned_safe before apply readiness");
    if (manifest.autoApply !== false || manifest.noExecution !== true || manifest.humanApprovalRequired !== true) errors.push("sandbox manifest must remain noExecution=true, autoApply=false, humanApprovalRequired=true");
    if (typeof manifest.diffHash !== "string" || !HEX_SHA256.test(manifest.diffHash)) errors.push("sandbox manifest requires sha256 diffHash");
    if (containsForbiddenPlaintextKeys(manifest)) errors.push("sandbox manifest must remain metadata/hash-only");
  }
  if (validation) {
    if (validation.schema !== "zob.sandbox-write-validation.v1") errors.push("sandbox validation schema must be zob.sandbox-write-validation.v1");
    if (validation.status !== "planned_safe") errors.push("sandbox validation must be planned_safe before apply readiness");
    if (Array.isArray(validation.errors) && validation.errors.length > 0) errors.push("sandbox validation must have no errors before apply readiness");
    if (validation.autoApply !== false || validation.noExecution !== true || validation.humanApprovalRequired !== true) errors.push("sandbox validation must remain noExecution=true, autoApply=false, humanApprovalRequired=true");
    if (validation.rollbackPrepared !== true || validation.rollbackApplied !== false) errors.push("sandbox validation requires rollbackPrepared=true and rollbackApplied=false");
    if (validation.sentinel !== "SANDBOX_PLAN_READY.sentinel" || !existsSync(join(runDir, "SANDBOX_PLAN_READY.sentinel"))) errors.push("sandbox plan ready sentinel is required before apply readiness");
    if (containsForbiddenPlaintextKeys(validation)) errors.push("sandbox validation must remain metadata/hash-only");
  }
  if (diffGate) {
    if (diffGate.schema !== "zob.diff-gate-result.v1") errors.push("diff gate schema must be zob.diff-gate-result.v1");
    if (diffGate.allowed !== true || diffGate.applyRequired !== true || diffGate.autoApply !== false) errors.push("diff gate must be allowed=true, applyRequired=true, autoApply=false");
    if (manifest && diffGate.diffHash !== manifest.diffHash) errors.push("diff gate diffHash must match sandbox manifest diffHash");
    if (containsForbiddenPlaintextKeys(diffGate)) errors.push("diff gate must remain metadata/hash-only");
  }
  if (rollback) {
    if (rollback.schema !== "zob.rollback-metadata.v1") errors.push("rollback metadata schema must be zob.rollback-metadata.v1");
    if (rollback.rollbackPrepared !== true || rollback.rollbackApplied !== false || rollback.autoApply !== false) errors.push("rollback metadata must prepare rollback without applying it");
    if (containsForbiddenPlaintextKeys(rollback)) errors.push("rollback metadata must remain metadata/hash-only");
  }
  if (oracleReview) {
    if (oracleReview.schema !== "zob.oracle-review.v1") errors.push("oracle review schema must be zob.oracle-review.v1");
    if (oracleReview.reviewedRunId !== input.run_id) errors.push("oracle review reviewedRunId must match sandbox run_id");
    if (oracleReview.verdict !== "PASS") errors.push("sandbox apply oracle review verdict must be PASS");
    if (oracleReview.no_ship !== false) errors.push("sandbox apply oracle review no_ship must be false");
    if (typeof oracleReview.evidence !== "string" || oracleReview.evidence.trim().length === 0) errors.push("sandbox apply oracle review evidence is required");
  }
  if (diffReviewGate) {
    if (diffReviewGate.schema !== "zob.sandbox-diff-review-gate.v1") errors.push("sandbox diff review gate schema must be zob.sandbox-diff-review-gate.v1");
    if (diffReviewGate.runId !== input.run_id) errors.push("sandbox diff review gate runId must match sandbox run_id");
    if (diffReviewGate.status !== "diff_review_passed" || diffReviewGate.reviewPassed !== true || diffReviewGate.applyReadyUnlocked !== true) errors.push("sandbox diff review gate must pass before apply readiness");
    if (diffReviewGate.autoApply !== false || diffReviewGate.noExecution !== true || diffReviewGate.productionWritesPerformed !== false || diffReviewGate.applyPerformed !== false) errors.push("sandbox diff review gate must remain noExecution=true, autoApply=false, productionWritesPerformed=false, applyPerformed=false");
    if (manifest && diffReviewGate.diffHash !== manifest.diffHash) errors.push("sandbox diff review gate diffHash must match sandbox manifest diffHash");
    if (!sameStringSet(diffReviewGate.changedPaths, changesFromManifest(manifest).map((change) => String(change.path)))) errors.push("sandbox diff review gate changedPaths must match sandbox manifest changes");
    const gates = isRecord(diffReviewGate.gates) ? diffReviewGate.gates : undefined;
    if (!gates || gates.rollbackValidated !== true || gates.oracleReviewPassed !== true || gates.isolatedExecutionValidated !== true) errors.push("sandbox diff review gate requires rollbackValidated, oracleReviewPassed, and isolatedExecutionValidated");
    if (!existsSync(join(dirname(diffReviewGatePath ?? ""), "SANDBOX_DIFF_REVIEW_PASSED.sentinel"))) errors.push("sandbox diff review passed sentinel is required before apply readiness");
    if (containsForbiddenPlaintextKeys(diffReviewGate)) errors.push("sandbox diff review gate must remain metadata/hash-only");
  }

  return errors;
}

export function validateSandboxIsolatedExecutionInputs(repoRoot: string, input: SandboxIsolatedExecutionInput): string[] {
  const errors: string[] = [];
  if (!input.run_id || safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  const executionId = input.execution_id ?? "isolated-execution";
  if (safeFileStem(executionId) !== executionId) errors.push(`execution_id must be path-safe: ${executionId}`);
  if (containsForbiddenPlaintextKeys(input)) errors.push("sandbox isolated execution metadata must not include plaintext task/prompt/output/body/content/patch/diff keys");

  const runDir = join(repoRoot, "reports", "sandbox-runs", input.run_id ?? "invalid-run");
  const manifest = readRecord(join(runDir, "manifest.json"), errors, "sandbox manifest");
  const validation = readRecord(join(runDir, "validation.json"), errors, "sandbox validation");
  const diffGate = readRecord(join(runDir, "diff-gate.json"), errors, "diff gate");
  const rollback = readRecord(join(runDir, "rollback-metadata.json"), errors, "rollback metadata");
  const sandboxRoot = sandboxRootFromManifest(repoRoot, input.run_id ?? "invalid-run", manifest, errors);

  if (manifest) {
    if (manifest.schema !== "zob.sandbox-write-plan.v1") errors.push("sandbox manifest schema must be zob.sandbox-write-plan.v1");
    if (manifest.runId !== input.run_id) errors.push("sandbox manifest runId must match input run_id");
    if (manifest.status !== "planned_safe") errors.push("sandbox manifest must be planned_safe before isolated execution");
    if (manifest.autoApply !== false || manifest.noExecution !== true || manifest.humanApprovalRequired !== true) errors.push("sandbox manifest must remain noExecution=true, autoApply=false, humanApprovalRequired=true before isolated execution");
    if (typeof manifest.diffHash !== "string" || !HEX_SHA256.test(manifest.diffHash)) errors.push("sandbox manifest requires sha256 diffHash before isolated execution");
    if (changesFromManifest(manifest).length === 0) errors.push("sandbox manifest requires at least one change before isolated execution");
    if (containsForbiddenPlaintextKeys(manifest)) errors.push("sandbox manifest must remain metadata/hash-only before isolated execution");
  }
  if (validation) {
    if (validation.schema !== "zob.sandbox-write-validation.v1") errors.push("sandbox validation schema must be zob.sandbox-write-validation.v1");
    if (validation.status !== "planned_safe") errors.push("sandbox validation must be planned_safe before isolated execution");
    if (Array.isArray(validation.errors) && validation.errors.length > 0) errors.push("sandbox validation must have no errors before isolated execution");
    if (validation.autoApply !== false || validation.noExecution !== true || validation.humanApprovalRequired !== true) errors.push("sandbox validation must remain noExecution=true, autoApply=false, humanApprovalRequired=true before isolated execution");
    if (validation.rollbackPrepared !== true || validation.rollbackApplied !== false) errors.push("sandbox validation requires rollbackPrepared=true and rollbackApplied=false before isolated execution");
    if (validation.sentinel !== "SANDBOX_PLAN_READY.sentinel" || !existsSync(join(runDir, "SANDBOX_PLAN_READY.sentinel"))) errors.push("sandbox plan ready sentinel is required before isolated execution");
    if (containsForbiddenPlaintextKeys(validation)) errors.push("sandbox validation must remain metadata/hash-only before isolated execution");
  }
  if (diffGate) {
    if (diffGate.schema !== "zob.diff-gate-result.v1") errors.push("diff gate schema must be zob.diff-gate-result.v1");
    if (diffGate.allowed !== true || diffGate.applyRequired !== true || diffGate.autoApply !== false) errors.push("diff gate must be allowed=true, applyRequired=true, autoApply=false before isolated execution");
    if (manifest && diffGate.diffHash !== manifest.diffHash) errors.push("diff gate diffHash must match sandbox manifest diffHash before isolated execution");
    if (containsForbiddenPlaintextKeys(diffGate)) errors.push("diff gate must remain metadata/hash-only before isolated execution");
  }
  if (rollback) {
    if (rollback.schema !== "zob.rollback-metadata.v1") errors.push("rollback metadata schema must be zob.rollback-metadata.v1");
    if (rollback.rollbackPrepared !== true || rollback.rollbackApplied !== false || rollback.autoApply !== false) errors.push("rollback metadata must prepare rollback without applying it before isolated execution");
    if (containsForbiddenPlaintextKeys(rollback)) errors.push("rollback metadata must remain metadata/hash-only before isolated execution");
  }
  if (sandboxRoot && !existsSync(sandboxRoot)) errors.push("sandboxRoot workspace is missing before isolated execution");

  return errors;
}

export function validateSandboxDiffReviewGateInputs(repoRoot: string, input: SandboxDiffReviewGateInput): string[] {
  const errors: string[] = [];
  if (!input.run_id || safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  const reviewId = input.review_id ?? "oracle-diff-review";
  if (safeFileStem(reviewId) !== reviewId) errors.push(`review_id must be path-safe: ${reviewId}`);
  if (!input.oracle_review_path) {
    errors.push("sandbox diff review gate requires oracle_review_path");
  } else {
    const resolvedOracle = resolveRepoPath(repoRoot, input.oracle_review_path);
    errors.push(...resolvedOracle.errors.map((error) => `oracle_review_path: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(input.oracle_review_path, protectedPattern, repoRoot, repoRoot)) errors.push(`oracle_review_path references zero-access path: ${protectedPattern}`);
    }
  }
  if (containsForbiddenPlaintextKeys(input)) errors.push("sandbox diff review gate metadata must not include plaintext task/prompt/output/body/content/patch/diff keys");

  const runDir = join(repoRoot, "reports", "sandbox-runs", input.run_id ?? "invalid-run");
  const manifest = readRecord(join(runDir, "manifest.json"), errors, "sandbox manifest");
  const validation = readRecord(join(runDir, "validation.json"), errors, "sandbox validation");
  const diffGate = readRecord(join(runDir, "diff-gate.json"), errors, "diff gate");
  const rollback = readRecord(join(runDir, "rollback-metadata.json"), errors, "rollback metadata");
  const sandboxRoot = sandboxRootFromManifest(repoRoot, input.run_id ?? "invalid-run", manifest, errors);
  const oracleReviewPath = input.oracle_review_path ? resolveRepoPath(repoRoot, input.oracle_review_path).path : undefined;
  const oracleReview = oracleReviewPath ? readRecord(oracleReviewPath, errors, "sandbox diff oracle review") : undefined;
  const manifestChangedPaths = changesFromManifest(manifest).map((change) => String(change.path));
  const isolatedExecutions = findIsolatedExecutionValidations(sandboxRoot);
  const validIsolatedExecutions = isolatedExecutions.filter((execution) => execution.status === "executed_in_sandbox" && execution.isolatedExecutionPerformed === true && execution.productionWritesPerformed === false && execution.autoApply === false && execution.sentinelPresent === true && Array.isArray(execution.errors) && execution.errors.length === 0);

  if (manifest) {
    if (manifest.schema !== "zob.sandbox-write-plan.v1") errors.push("sandbox manifest schema must be zob.sandbox-write-plan.v1");
    if (manifest.runId !== input.run_id) errors.push("sandbox manifest runId must match input run_id");
    if (manifest.status !== "planned_safe") errors.push("sandbox manifest must be planned_safe before diff review");
    if (manifest.autoApply !== false || manifest.noExecution !== true || manifest.humanApprovalRequired !== true) errors.push("sandbox manifest must remain noExecution=true, autoApply=false, humanApprovalRequired=true before diff review");
    if (typeof manifest.diffHash !== "string" || !HEX_SHA256.test(manifest.diffHash)) errors.push("sandbox manifest requires sha256 diffHash before diff review");
    if (manifestChangedPaths.length === 0) errors.push("sandbox manifest requires changed paths before diff review");
    if (containsForbiddenPlaintextKeys(manifest)) errors.push("sandbox manifest must remain metadata/hash-only before diff review");
  }
  if (validation) {
    if (validation.schema !== "zob.sandbox-write-validation.v1") errors.push("sandbox validation schema must be zob.sandbox-write-validation.v1");
    if (validation.status !== "planned_safe") errors.push("sandbox validation must be planned_safe before diff review");
    if (Array.isArray(validation.errors) && validation.errors.length > 0) errors.push("sandbox validation must have no errors before diff review");
    if (validation.autoApply !== false || validation.noExecution !== true || validation.humanApprovalRequired !== true) errors.push("sandbox validation must remain noExecution=true, autoApply=false, humanApprovalRequired=true before diff review");
    if (validation.rollbackPrepared !== true || validation.rollbackApplied !== false) errors.push("sandbox validation requires rollbackPrepared=true and rollbackApplied=false before diff review");
    if (validation.sentinel !== "SANDBOX_PLAN_READY.sentinel" || !existsSync(join(runDir, "SANDBOX_PLAN_READY.sentinel"))) errors.push("sandbox plan ready sentinel is required before diff review");
    if (!sameStringSet(validation.changedPaths, manifestChangedPaths)) errors.push("sandbox validation changedPaths must match sandbox manifest changes before diff review");
    if (manifest && validation.diffHash !== manifest.diffHash) errors.push("sandbox validation diffHash must match sandbox manifest diffHash before diff review");
    if (containsForbiddenPlaintextKeys(validation)) errors.push("sandbox validation must remain metadata/hash-only before diff review");
  }
  if (diffGate) {
    if (diffGate.schema !== "zob.diff-gate-result.v1") errors.push("diff gate schema must be zob.diff-gate-result.v1");
    if (diffGate.allowed !== true || diffGate.applyRequired !== true || diffGate.autoApply !== false) errors.push("diff gate must be allowed=true, applyRequired=true, autoApply=false before diff review");
    if (!sameStringSet(diffGate.changedPaths, manifestChangedPaths)) errors.push("diff gate changedPaths must match sandbox manifest changes before diff review");
    if (manifest && diffGate.diffHash !== manifest.diffHash) errors.push("diff gate diffHash must match sandbox manifest diffHash before diff review");
    if (containsForbiddenPlaintextKeys(diffGate)) errors.push("diff gate must remain metadata/hash-only before diff review");
  }
  if (rollback) {
    if (rollback.schema !== "zob.rollback-metadata.v1") errors.push("rollback metadata schema must be zob.rollback-metadata.v1");
    if (rollback.runId !== input.run_id) errors.push("rollback metadata runId must match input run_id");
    if (rollback.rollbackPrepared !== true || rollback.rollbackApplied !== false || rollback.autoApply !== false) errors.push("rollback metadata must prepare rollback without applying it before diff review");
    if (typeof rollback.snapshotPath !== "string" || rollback.snapshotPath.trim().length === 0) errors.push("rollback metadata requires snapshotPath before diff review");
    if (!sameStringSet(rollback.changedPaths, manifestChangedPaths)) errors.push("rollback metadata changedPaths must match sandbox manifest changes before diff review");
    if (containsForbiddenPlaintextKeys(rollback)) errors.push("rollback metadata must remain metadata/hash-only before diff review");
  }
  if (validIsolatedExecutions.length === 0) errors.push("sandbox diff review requires completed isolated execution validation before manual apply review");
  for (const execution of validIsolatedExecutions) {
    if (typeof execution.markerCount === "number" && execution.markerCount !== manifestChangedPaths.length) errors.push("isolated execution markerCount must match sandbox manifest changes before diff review");
    if (containsForbiddenPlaintextKeys(execution)) errors.push("isolated execution validation metadata must remain metadata/hash-only before diff review");
  }
  if (oracleReview) {
    if (oracleReview.schema !== "zob.sandbox-diff-review.v1") errors.push("sandbox diff oracle review schema must be zob.sandbox-diff-review.v1");
    if (oracleReview.reviewedRunId !== input.run_id) errors.push("sandbox diff oracle review reviewedRunId must match sandbox run_id");
    if (oracleReview.verdict !== "PASS") errors.push("sandbox diff oracle review verdict must be PASS");
    if (oracleReview.no_ship !== false) errors.push("sandbox diff oracle review no_ship must be false");
    if (manifest && oracleReview.diffHash !== manifest.diffHash) errors.push("sandbox diff oracle review diffHash must match sandbox manifest diffHash");
    if (oracleReview.rollbackReviewed !== true) errors.push("sandbox diff oracle review requires rollbackReviewed=true");
    if (oracleReview.isolatedExecutionReviewed !== true) errors.push("sandbox diff oracle review requires isolatedExecutionReviewed=true");
    if (typeof oracleReview.evidence !== "string" || oracleReview.evidence.trim().length === 0) errors.push("sandbox diff oracle review evidence is required");
    if (containsForbiddenPlaintextKeys(oracleReview)) errors.push("sandbox diff oracle review must remain metadata/hash-only");
  }

  return errors;
}

export function runSandboxWritePlan(repoRoot: string, input: SandboxWritePlanInput): SandboxWritePlanResult {
  const runId = safeRunId(input.run_id, "sandbox");
  const runDir = join(repoRoot, "reports", "sandbox-runs", runId);
  const sandboxRootRelative = join(".pi", "tmp", "sandbox-runs", runId);
  const sandboxRoot = resolve(repoRoot, sandboxRootRelative);
  const errors = validateSandboxWritePlanInputs(repoRoot, input);
  const normalizedChanges = normalizeChanges(input.changes ?? []);
  const changedPaths = normalizedChanges.map((change) => String(change.path));
  const diffHash = errors.length === 0 ? sha256(JSON.stringify({ changedPaths, changes: normalizedChanges, allowedPaths: input.allowed_paths, forbiddenPaths: input.forbidden_paths ?? [] })) : undefined;
  const status: SandboxWritePlanResult["status"] = errors.length === 0 ? "planned_safe" : "blocked_preflight";
  const artifacts = ["manifest.json", "sandbox-metadata.json", "diff-gate.json", "rollback-metadata.json", "validation.json", "ledger.jsonl"];
  const sentinel = status === "planned_safe" ? "SANDBOX_PLAN_READY.sentinel" : "SANDBOX_BLOCKED.sentinel";

  mkdirSync(runDir, { recursive: true });
  mkdirSync(sandboxRoot, { recursive: true });
  writeFileSync(join(sandboxRoot, "README.md"), ["# ZOB sandbox workspace", "", "This workspace is reserved for isolated write planning.", "Auto-apply is disabled.", ""].join("\n"), "utf8");

  const sandboxMetadata = createSandboxMetadata({
    runId,
    repoRoot,
    sandboxRoot: sandboxRootRelative,
    allowedPaths: input.allowed_paths,
    forbiddenPaths: input.forbidden_paths,
  });
  const diffGate = createDiffGateResult({
    runId,
    diffHash,
    changedPaths,
    allowed: errors.length === 0,
    violations: errors,
  });
  const rollbackMetadata = createRollbackMetadata({
    runId,
    baseRef: input.base_ref,
    snapshotPath: join(sandboxRootRelative, "rollback-snapshot.metadata.json"),
    changedPaths,
  });

  const manifest = {
    schema: "zob.sandbox-write-plan.v1",
    runId,
    sandboxRoot,
    status,
    allowedPaths: input.allowed_paths,
    forbiddenPaths: input.forbidden_paths ?? [],
    changes: normalizedChanges,
    diffHash,
    applyRequired: true,
    autoApply: false,
    noExecution: true,
    humanApprovalRequired: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const validation = {
    schema: "zob.sandbox-write-validation.v1",
    runId,
    status,
    errors,
    changedPaths,
    diffHash,
    sandboxRoot,
    policy: {
      allowedPaths: input.allowed_paths,
      forbiddenPaths: input.forbidden_paths ?? [],
      zeroAccessPaths: DEFAULT_RULES.zeroAccessPaths,
      readOnlyPaths: DEFAULT_RULES.readOnlyPaths,
    },
    diffGate: { allowed: errors.length === 0, applyRequired: true, autoApply: false },
    rollbackPrepared: true,
    rollbackApplied: false,
    autoApply: false,
    noExecution: true,
    humanApprovalRequired: true,
    sentinel,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(runDir, "sandbox-metadata.json"), JSON.stringify(sandboxMetadata, null, 2), "utf8");
  writeFileSync(join(runDir, "diff-gate.json"), JSON.stringify(diffGate, null, 2), "utf8");
  writeFileSync(join(runDir, "rollback-metadata.json"), JSON.stringify(rollbackMetadata, null, 2), "utf8");
  writeFileSync(join(runDir, "validation.json"), JSON.stringify(validation, null, 2), "utf8");
  sandboxLedger(runDir, { event: "sandbox_write_plan", status, changedPaths, diffHash, autoApply: false, noExecution: true });
  writeFileSync(join(runDir, sentinel), `${status} ${new Date().toISOString()}\n`, "utf8");
  artifacts.push(sentinel);

  return { runId, runDir, sandboxRoot, status, changedPaths, diffHash, artifacts, errors };
}

export function runSandboxIsolatedExecution(repoRoot: string, input: SandboxIsolatedExecutionInput): SandboxIsolatedExecutionResult {
  const runId = safeRunId(input.run_id, "sandbox");
  const executionId = safeRunId(input.execution_id, "isolated-execution");
  const runDir = join(repoRoot, "reports", "sandbox-runs", runId);
  const manifestPath = join(runDir, "manifest.json");
  const manifest = existsSync(manifestPath) && isRecord(parseJsonFile(manifestPath)) ? parseJsonFile(manifestPath) as Record<string, unknown> : undefined;
  const sandboxRootErrors: string[] = [];
  const sandboxRoot = sandboxRootFromManifest(repoRoot, runId, manifest, sandboxRootErrors);
  const errors = validateSandboxIsolatedExecutionInputs(repoRoot, { run_id: input.run_id, execution_id: input.execution_id });
  const canWriteSandboxArtifacts = sandboxRootErrors.length === 0 && typeof sandboxRoot === "string" && existsSync(sandboxRoot);
  const executionDir = join(sandboxRoot ?? join(repoRoot, ".pi", "tmp", "sandbox-runs", runId), "isolated-executions", executionId);
  const status: SandboxIsolatedExecutionResult["status"] = errors.length === 0 ? "executed_in_sandbox" : "blocked_preflight";
  const isolatedExecutionPerformed = status === "executed_in_sandbox";
  const changes = changesFromManifest(manifest);
  const changedPaths = changes.map((change) => String(change.path));
  const markerDir = join(executionDir, "change-markers");
  const markerPaths: string[] = [];
  const artifacts: string[] = [];
  const sentinel = isolatedExecutionPerformed ? "SANDBOX_ISOLATED_EXECUTION_COMPLETE.sentinel" : "SANDBOX_ISOLATED_EXECUTION_BLOCKED.sentinel";

  if (canWriteSandboxArtifacts) {
    mkdirSync(executionDir, { recursive: true });
    mkdirSync(markerDir, { recursive: true });
  }
  if (isolatedExecutionPerformed && canWriteSandboxArtifacts) {
    for (const [index, change] of changes.entries()) {
      const markerName = `${String(index + 1).padStart(3, "0")}-${safeFileStem(String(change.path).replace(/[\\/]+/g, "-"))}.metadata.json`;
      const markerPath = join(markerDir, markerName);
      const marker = {
        schema: "zob.sandbox-isolated-change-marker.v1",
        runId,
        executionId,
        path: change.path,
        action: change.action,
        contentHash: change.contentHash,
        reasonHash: change.reasonHash,
        isolatedWorkspaceWrite: true,
        productionWritePerformed: false,
        autoApply: false,
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
        generatedAt: new Date().toISOString(),
      };
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
      markerPaths.push(markerPath);
    }
  }

  const executionReport = {
    schema: "zob.sandbox-isolated-execution.v1",
    runId,
    executionId,
    status,
    isolatedExecutionPerformed,
    isolatedWorkspace: executionDir,
    changedPaths,
    changeCount: changes.length,
    markerPaths,
    diffHash: typeof manifest?.diffHash === "string" ? manifest.diffHash : undefined,
    autoApply: false,
    manualApplyRequired: true,
    humanApprovalRequired: true,
    productionWritesPerformed: false,
    rollbackPrepared: true,
    rollbackApplied: false,
    childDispatchAllowed: false,
    networkAccessed: false,
    liveChildExecution: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const validation = {
    schema: "zob.sandbox-isolated-execution-validation.v1",
    runId,
    executionId,
    status,
    isolatedExecutionPerformed,
    productionWritesPerformed: false,
    autoApply: false,
    manualApplyRequired: true,
    errors,
    changedPaths,
    markerCount: markerPaths.length,
    sentinel,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (containsForbiddenPlaintextKeys(executionReport) || containsForbiddenPlaintextKeys(validation)) errors.push("sandbox isolated execution artifacts must remain metadata/hash-only");

  if (canWriteSandboxArtifacts) {
    writeFileSync(join(executionDir, "execution-report.json"), JSON.stringify(executionReport, null, 2), "utf8");
    writeFileSync(join(executionDir, "validation.json"), JSON.stringify(validation, null, 2), "utf8");
    writeFileSync(join(executionDir, sentinel), `${status} ${new Date().toISOString()}\n`, "utf8");
    artifacts.push("execution-report.json", "validation.json", sentinel);
  }

  return { runId, executionId, executionDir, status, isolatedExecutionPerformed, productionWritesPerformed: false, artifacts, errors };
}

export function runSandboxDiffReviewGate(repoRoot: string, input: SandboxDiffReviewGateInput): SandboxDiffReviewGateResult {
  const runId = safeRunId(input.run_id, "sandbox");
  const reviewId = safeRunId(input.review_id, "oracle-diff-review");
  const runDir = join(repoRoot, "reports", "sandbox-runs", runId);
  const reviewDir = join(runDir, "diff-review", reviewId);
  const errors = validateSandboxDiffReviewGateInputs(repoRoot, input);
  const status: SandboxDiffReviewGateResult["status"] = errors.length === 0 ? "diff_review_passed" : "blocked_preflight";
  const reviewPassed = status === "diff_review_passed";
  const manifestPath = join(runDir, "manifest.json");
  const validationPath = join(runDir, "validation.json");
  const diffGatePath = join(runDir, "diff-gate.json");
  const rollbackPath = join(runDir, "rollback-metadata.json");
  const manifest = existsSync(manifestPath) && isRecord(parseJsonFile(manifestPath)) ? parseJsonFile(manifestPath) as Record<string, unknown> : undefined;
  const validation = existsSync(validationPath) && isRecord(parseJsonFile(validationPath)) ? parseJsonFile(validationPath) as Record<string, unknown> : undefined;
  const diffGate = existsSync(diffGatePath) && isRecord(parseJsonFile(diffGatePath)) ? parseJsonFile(diffGatePath) as Record<string, unknown> : undefined;
  const rollback = existsSync(rollbackPath) && isRecord(parseJsonFile(rollbackPath)) ? parseJsonFile(rollbackPath) as Record<string, unknown> : undefined;
  const sandboxRootErrors: string[] = [];
  const sandboxRoot = sandboxRootFromManifest(repoRoot, runId, manifest, sandboxRootErrors);
  const isolatedExecutions = findIsolatedExecutionValidations(sandboxRoot);
  const oracleReviewPath = input.oracle_review_path ? resolveRepoPath(repoRoot, input.oracle_review_path).path : undefined;
  let oracleReview: Record<string, unknown> | undefined;
  if (oracleReviewPath && existsSync(oracleReviewPath)) {
    try {
      const parsedOracleReview = parseJsonFile(oracleReviewPath);
      if (isRecord(parsedOracleReview)) oracleReview = parsedOracleReview;
    } catch {
      oracleReview = undefined;
    }
  }
  const oracleReviewPassed = oracleReview?.schema === "zob.sandbox-diff-review.v1"
    && oracleReview.reviewedRunId === runId
    && oracleReview.verdict === "PASS"
    && oracleReview.no_ship === false
    && oracleReview.diffHash === manifest?.diffHash
    && oracleReview.rollbackReviewed === true
    && oracleReview.isolatedExecutionReviewed === true
    && typeof oracleReview.evidence === "string"
    && oracleReview.evidence.trim().length > 0;
  const changedPaths = changesFromManifest(manifest).map((change) => String(change.path));
  const reviewGate = {
    schema: "zob.sandbox-diff-review-gate.v1",
    runId,
    reviewId,
    status,
    reviewPassed,
    applyReadyUnlocked: reviewPassed,
    applyPerformed: false,
    autoApply: false,
    manualApplyRequired: true,
    humanApprovalRequired: true,
    productionWritesPerformed: false,
    noExecution: true,
    diffHash: typeof manifest?.diffHash === "string" ? manifest.diffHash : undefined,
    changedPaths,
    evidence: {
      manifest: manifestPath,
      validation: validationPath,
      diffGate: diffGatePath,
      rollback: rollbackPath,
      oracleReview: oracleReviewPath,
      isolatedExecutions: isolatedExecutions.map((execution) => execution.validationPath),
    },
    gates: {
      sandboxPlanReady: manifest?.status === "planned_safe" && validation?.status === "planned_safe",
      diffAllowed: diffGate?.allowed === true,
      rollbackValidated: rollback?.rollbackPrepared === true && rollback?.rollbackApplied === false && rollback?.autoApply === false,
      isolatedExecutionValidated: isolatedExecutions.some((execution) => execution.status === "executed_in_sandbox" && execution.isolatedExecutionPerformed === true && execution.productionWritesPerformed === false && execution.sentinelPresent === true),
      oracleReviewPassed,
    },
    errors,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const reviewValidation = {
    schema: "zob.sandbox-diff-review-validation.v1",
    runId,
    reviewId,
    status,
    reviewPassed,
    applyReadyUnlocked: reviewPassed,
    applyPerformed: false,
    productionWritesPerformed: false,
    autoApply: false,
    manualApplyRequired: true,
    errors,
    sentinel: reviewPassed ? "SANDBOX_DIFF_REVIEW_PASSED.sentinel" : "SANDBOX_DIFF_REVIEW_BLOCKED.sentinel",
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (containsForbiddenPlaintextKeys(reviewGate) || containsForbiddenPlaintextKeys(reviewValidation)) errors.push("sandbox diff review artifacts must remain metadata/hash-only");

  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(reviewDir, "diff-review-gate.json"), JSON.stringify(reviewGate, null, 2), "utf8");
  writeFileSync(join(reviewDir, "validation.json"), JSON.stringify(reviewValidation, null, 2), "utf8");
  const sentinel = reviewPassed ? "SANDBOX_DIFF_REVIEW_PASSED.sentinel" : "SANDBOX_DIFF_REVIEW_BLOCKED.sentinel";
  writeFileSync(join(reviewDir, sentinel), `${status} ${new Date().toISOString()}\n`, "utf8");
  sandboxLedger(runDir, { event: "sandbox_diff_review_gate", reviewId, status, reviewPassed, applyReadyUnlocked: reviewPassed, applyPerformed: false, autoApply: false, productionWritesPerformed: false });

  return { runId, reviewId, reviewDir, status, reviewPassed, applyReadyUnlocked: reviewPassed, applyPerformed: false, productionWritesPerformed: false, artifacts: ["diff-review-gate.json", "validation.json", sentinel], errors };
}

export function runSandboxApplyReadiness(repoRoot: string, input: SandboxApplyReadinessInput): SandboxApplyReadinessResult {
  const runId = safeRunId(input.run_id, "sandbox");
  const applyId = safeRunId(input.apply_id, "manual-apply-review");
  const runDir = join(repoRoot, "reports", "sandbox-runs", runId);
  const reviewDir = join(runDir, "apply-readiness", applyId);
  const errors = validateSandboxApplyReadinessInputs(repoRoot, input);
  const status: SandboxApplyReadinessResult["status"] = errors.length === 0 ? "ready_for_manual_apply" : "blocked_preflight";
  const applyReady = status === "ready_for_manual_apply";
  const artifacts = ["apply-readiness.json", "validation.json", "APPLY_NOT_PERFORMED.sentinel"];
  const manifestPath = join(runDir, "manifest.json");
  const validationPath = join(runDir, "validation.json");
  const diffGatePath = join(runDir, "diff-gate.json");
  const rollbackPath = join(runDir, "rollback-metadata.json");
  const manifest = existsSync(manifestPath) && isRecord(parseJsonFile(manifestPath)) ? parseJsonFile(manifestPath) as Record<string, unknown> : undefined;
  const validation = existsSync(validationPath) && isRecord(parseJsonFile(validationPath)) ? parseJsonFile(validationPath) as Record<string, unknown> : undefined;
  const diffGate = existsSync(diffGatePath) && isRecord(parseJsonFile(diffGatePath)) ? parseJsonFile(diffGatePath) as Record<string, unknown> : undefined;
  const rollback = existsSync(rollbackPath) && isRecord(parseJsonFile(rollbackPath)) ? parseJsonFile(rollbackPath) as Record<string, unknown> : undefined;
  const approval = input.approval ? {
    approvedByHash: input.approval.approvedBy ? sha256(input.approval.approvedBy) : undefined,
    approvedAt: input.approval.approvedAt,
    approvalIdHash: input.approval.approvalId ? sha256(input.approval.approvalId) : undefined,
    bodyStored: false,
  } : undefined;
  const oracleReviewPath = input.oracle_review_path ? resolveRepoPath(repoRoot, input.oracle_review_path).path : undefined;
  let oracleReview: Record<string, unknown> | undefined;
  if (oracleReviewPath && existsSync(oracleReviewPath)) {
    try {
      const parsedOracleReview = parseJsonFile(oracleReviewPath);
      if (isRecord(parsedOracleReview)) oracleReview = parsedOracleReview;
    } catch {
      oracleReview = undefined;
    }
  }
  const diffReviewGatePath = input.diff_review_gate_path ? resolveRepoPath(repoRoot, input.diff_review_gate_path).path : undefined;
  let diffReviewGate: Record<string, unknown> | undefined;
  if (diffReviewGatePath && existsSync(diffReviewGatePath)) {
    try {
      const parsedDiffReviewGate = parseJsonFile(diffReviewGatePath);
      if (isRecord(parsedDiffReviewGate)) diffReviewGate = parsedDiffReviewGate;
    } catch {
      diffReviewGate = undefined;
    }
  }
  const diffReviewGates = isRecord(diffReviewGate?.gates) ? diffReviewGate.gates : undefined;
  const diffReviewPassed = diffReviewGate?.schema === "zob.sandbox-diff-review-gate.v1"
    && diffReviewGate.runId === runId
    && diffReviewGate.status === "diff_review_passed"
    && diffReviewGate.reviewPassed === true
    && diffReviewGate.applyReadyUnlocked === true
    && diffReviewGate.applyPerformed === false
    && diffReviewGate.productionWritesPerformed === false
    && diffReviewGate.autoApply === false
    && diffReviewGate.noExecution === true
    && diffReviewGate.diffHash === manifest?.diffHash
    && diffReviewGates?.rollbackValidated === true
    && diffReviewGates?.oracleReviewPassed === true
    && diffReviewGates?.isolatedExecutionValidated === true;
  const oracleReviewPassed = oracleReview?.schema === "zob.oracle-review.v1"
    && oracleReview.reviewedRunId === runId
    && oracleReview.verdict === "PASS"
    && oracleReview.no_ship === false
    && typeof oracleReview.evidence === "string"
    && oracleReview.evidence.trim().length > 0;
  const readiness = {
    schema: "zob.sandbox-apply-readiness.v1",
    runId,
    applyId,
    status,
    applyReady,
    applyPerformed: false,
    autoApply: false,
    manualApplyRequired: true,
    humanApprovalRequired: true,
    productionWritesPerformed: false,
    noExecution: true,
    changedPaths: Array.isArray(manifest?.changedPaths) ? manifest?.changedPaths : Array.isArray(validation?.changedPaths) ? validation?.changedPaths : [],
    diffHash: typeof manifest?.diffHash === "string" ? manifest.diffHash : undefined,
    evidence: {
      manifest: manifestPath,
      validation: validationPath,
      diffGate: diffGatePath,
      rollback: rollbackPath,
      oracleReview: oracleReviewPath,
      diffReviewGate: diffReviewGatePath,
    },
    gates: {
      sandboxPlanReady: manifest?.status === "planned_safe" && validation?.status === "planned_safe",
      diffAllowed: diffGate?.allowed === true,
      rollbackPrepared: rollback?.rollbackPrepared === true && rollback?.rollbackApplied === false,
      diffReviewPassed,
      oracleReviewPassed,
      approvalPresent: approval !== undefined,
    },
    approval,
    errors,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const readinessValidation = {
    schema: "zob.sandbox-apply-readiness-validation.v1",
    runId,
    applyId,
    status,
    applyReady,
    applyPerformed: false,
    autoApply: false,
    manualApplyRequired: true,
    productionWritesPerformed: false,
    errors,
    sentinel: "APPLY_NOT_PERFORMED.sentinel",
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(reviewDir, "apply-readiness.json"), JSON.stringify(readiness, null, 2), "utf8");
  writeFileSync(join(reviewDir, "validation.json"), JSON.stringify(readinessValidation, null, 2), "utf8");
  writeFileSync(join(reviewDir, "APPLY_NOT_PERFORMED.sentinel"), `apply_not_performed ${new Date().toISOString()}\n`, "utf8");
  sandboxLedger(runDir, { event: "sandbox_apply_readiness", applyId, status, applyReady, applyPerformed: false, autoApply: false });

  return { runId, applyId, reviewDir, status, applyReady, applyPerformed: false, artifacts, errors };
}

export function validateSandboxApplySimulationInputs(repoRoot: string, input: SandboxApplySimulationInput): string[] {
  const errors: string[] = [];
  if (!input.run_id || safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  const simulationId = input.simulation_id ?? "apply-simulation";
  if (safeFileStem(simulationId) !== simulationId) errors.push(`simulation_id must be path-safe: ${simulationId}`);
  if (!input.apply_readiness_path) {
    errors.push("sandbox apply simulation requires apply_readiness_path");
  }
  if (containsForbiddenPlaintextKeys(input)) errors.push("sandbox apply simulation metadata must not include plaintext task/prompt/output/body/content/patch/diff keys");

  const runDir = join(repoRoot, "reports", "sandbox-runs", input.run_id ?? "invalid-run");
  const manifest = readRecord(join(runDir, "manifest.json"), errors, "sandbox manifest");
  const validation = readRecord(join(runDir, "validation.json"), errors, "sandbox validation");
  const diffGate = readRecord(join(runDir, "diff-gate.json"), errors, "diff gate");
  const rollback = readRecord(join(runDir, "rollback-metadata.json"), errors, "rollback metadata");
  const sandboxRoot = sandboxRootFromManifest(repoRoot, input.run_id ?? "invalid-run", manifest, errors);
  const manifestChangedPaths = changesFromManifest(manifest).map((change) => String(change.path));

  let applyReadinessPath: string | undefined;
  let applyReadiness: Record<string, unknown> | undefined;
  let applyReadinessValidation: Record<string, unknown> | undefined;
  if (input.apply_readiness_path) {
    const resolvedApplyReadiness = resolveRepoPath(repoRoot, input.apply_readiness_path);
    errors.push(...resolvedApplyReadiness.errors.map((error) => `apply_readiness_path: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(input.apply_readiness_path, protectedPattern, repoRoot, repoRoot)) errors.push(`apply_readiness_path references zero-access path: ${protectedPattern}`);
    }
    const expectedPrefix = join(repoRoot, "reports", "sandbox-runs", input.run_id ?? "invalid-run", "apply-readiness");
    if (!isInsidePath(expectedPrefix, resolvedApplyReadiness.path)) errors.push("apply_readiness_path must stay inside this run's reports/sandbox-runs apply-readiness directory");
    if (resolvedApplyReadiness.errors.length === 0 && isInsidePath(expectedPrefix, resolvedApplyReadiness.path)) {
      applyReadinessPath = resolvedApplyReadiness.path;
      applyReadiness = readRecord(applyReadinessPath, errors, "sandbox apply readiness");
      applyReadinessValidation = readRecord(join(dirname(applyReadinessPath), "validation.json"), errors, "sandbox apply readiness validation");
      if (!existsSync(join(dirname(applyReadinessPath), "APPLY_NOT_PERFORMED.sentinel"))) errors.push("sandbox apply simulation requires APPLY_NOT_PERFORMED.sentinel from manual apply readiness");
    }
  }

  const readinessEvidence = isRecord(applyReadiness?.evidence) ? applyReadiness.evidence : undefined;
  let diffReviewGate: Record<string, unknown> | undefined;
  if (typeof readinessEvidence?.diffReviewGate === "string") {
    const resolvedDiffReviewGate = resolveRepoPath(repoRoot, readinessEvidence.diffReviewGate);
    errors.push(...resolvedDiffReviewGate.errors.map((error) => `apply_readiness.evidence.diffReviewGate: ${error}`));
    if (resolvedDiffReviewGate.errors.length === 0) diffReviewGate = readRecord(resolvedDiffReviewGate.path, errors, "sandbox diff review gate");
  }
  let oracleReview: Record<string, unknown> | undefined;
  if (typeof readinessEvidence?.oracleReview === "string") {
    const resolvedOracleReview = resolveRepoPath(repoRoot, readinessEvidence.oracleReview);
    errors.push(...resolvedOracleReview.errors.map((error) => `apply_readiness.evidence.oracleReview: ${error}`));
    if (resolvedOracleReview.errors.length === 0) oracleReview = readRecord(resolvedOracleReview.path, errors, "sandbox apply oracle review");
  }

  if (manifest) {
    if (manifest.schema !== "zob.sandbox-write-plan.v1") errors.push("sandbox manifest schema must be zob.sandbox-write-plan.v1 before apply simulation");
    if (manifest.runId !== input.run_id) errors.push("sandbox manifest runId must match input run_id before apply simulation");
    if (manifest.status !== "planned_safe") errors.push("sandbox manifest must be planned_safe before apply simulation");
    if (manifest.autoApply !== false || manifest.noExecution !== true || manifest.humanApprovalRequired !== true) errors.push("sandbox manifest must remain noExecution=true, autoApply=false, humanApprovalRequired=true before apply simulation");
    if (typeof manifest.diffHash !== "string" || !HEX_SHA256.test(manifest.diffHash)) errors.push("sandbox manifest requires sha256 diffHash before apply simulation");
    if (manifestChangedPaths.length === 0) errors.push("sandbox manifest requires changed paths before apply simulation");
    if (containsForbiddenPlaintextKeys(manifest)) errors.push("sandbox manifest must remain metadata/hash-only before apply simulation");
  }
  if (validation) {
    if (validation.schema !== "zob.sandbox-write-validation.v1") errors.push("sandbox validation schema must be zob.sandbox-write-validation.v1 before apply simulation");
    if (validation.status !== "planned_safe") errors.push("sandbox validation must be planned_safe before apply simulation");
    if (Array.isArray(validation.errors) && validation.errors.length > 0) errors.push("sandbox validation must have no errors before apply simulation");
    if (validation.autoApply !== false || validation.noExecution !== true || validation.humanApprovalRequired !== true) errors.push("sandbox validation must remain noExecution=true, autoApply=false, humanApprovalRequired=true before apply simulation");
    if (validation.rollbackPrepared !== true || validation.rollbackApplied !== false) errors.push("sandbox validation requires rollbackPrepared=true and rollbackApplied=false before apply simulation");
    if (!sameStringSet(validation.changedPaths, manifestChangedPaths)) errors.push("sandbox validation changedPaths must match sandbox manifest changes before apply simulation");
    if (manifest && validation.diffHash !== manifest.diffHash) errors.push("sandbox validation diffHash must match sandbox manifest diffHash before apply simulation");
    if (containsForbiddenPlaintextKeys(validation)) errors.push("sandbox validation must remain metadata/hash-only before apply simulation");
  }
  if (diffGate) {
    if (diffGate.schema !== "zob.diff-gate-result.v1") errors.push("diff gate schema must be zob.diff-gate-result.v1 before apply simulation");
    if (diffGate.allowed !== true || diffGate.applyRequired !== true || diffGate.autoApply !== false) errors.push("diff gate must be allowed=true, applyRequired=true, autoApply=false before apply simulation");
    if (!sameStringSet(diffGate.changedPaths, manifestChangedPaths)) errors.push("diff gate changedPaths must match sandbox manifest changes before apply simulation");
    if (manifest && diffGate.diffHash !== manifest.diffHash) errors.push("diff gate diffHash must match sandbox manifest diffHash before apply simulation");
    if (containsForbiddenPlaintextKeys(diffGate)) errors.push("diff gate must remain metadata/hash-only before apply simulation");
  }
  if (rollback) {
    if (rollback.schema !== "zob.rollback-metadata.v1") errors.push("rollback metadata schema must be zob.rollback-metadata.v1 before apply simulation");
    if (rollback.runId !== input.run_id) errors.push("rollback metadata runId must match input run_id before apply simulation");
    if (rollback.rollbackPrepared !== true || rollback.rollbackApplied !== false || rollback.autoApply !== false) errors.push("rollback metadata must prepare rollback without applying it before apply simulation");
    if (typeof rollback.snapshotPath !== "string" || rollback.snapshotPath.trim().length === 0) errors.push("rollback metadata requires snapshotPath before apply simulation");
    if (!sameStringSet(rollback.changedPaths, manifestChangedPaths)) errors.push("rollback metadata changedPaths must match sandbox manifest changes before apply simulation");
    if (containsForbiddenPlaintextKeys(rollback)) errors.push("rollback metadata must remain metadata/hash-only before apply simulation");
  }
  if (!sandboxRoot || !existsSync(sandboxRoot)) errors.push("sandboxRoot workspace is required before apply simulation");

  if (applyReadiness) {
    if (applyReadiness.schema !== "zob.sandbox-apply-readiness.v1") errors.push("sandbox apply readiness schema must be zob.sandbox-apply-readiness.v1 before apply simulation");
    if (applyReadiness.runId !== input.run_id) errors.push("sandbox apply readiness runId must match input run_id before apply simulation");
    if (applyReadiness.status !== "ready_for_manual_apply" || applyReadiness.applyReady !== true) errors.push("sandbox apply readiness must be ready_for_manual_apply before apply simulation");
    if (applyReadiness.applyPerformed !== false || applyReadiness.autoApply !== false || applyReadiness.productionWritesPerformed !== false || applyReadiness.noExecution !== true) errors.push("sandbox apply readiness must not have performed production apply before apply simulation");
    if (manifest && applyReadiness.diffHash !== manifest.diffHash) errors.push("sandbox apply readiness diffHash must match sandbox manifest diffHash before apply simulation");
    if (!sameStringSet(applyReadiness.changedPaths, manifestChangedPaths)) errors.push("sandbox apply readiness changedPaths must match sandbox manifest changes before apply simulation");
    const gates = isRecord(applyReadiness.gates) ? applyReadiness.gates : undefined;
    if (!gates || gates.sandboxPlanReady !== true || gates.diffAllowed !== true || gates.rollbackPrepared !== true || gates.diffReviewPassed !== true || gates.oracleReviewPassed !== true || gates.approvalPresent !== true) errors.push("sandbox apply readiness gates must all pass before apply simulation");
    const approval = isRecord(applyReadiness.approval) ? applyReadiness.approval : undefined;
    if (!approval || typeof approval.approvedByHash !== "string" || !HEX_SHA256.test(approval.approvedByHash) || typeof approval.approvalIdHash !== "string" || !HEX_SHA256.test(approval.approvalIdHash) || "approvedBy" in approval || "approvalId" in approval) errors.push("sandbox apply readiness approval must be hash-only before apply simulation");
    if (!readinessEvidence || typeof readinessEvidence.diffReviewGate !== "string" || typeof readinessEvidence.oracleReview !== "string") errors.push("sandbox apply readiness evidence must include diff review gate and oracle review paths before apply simulation");
    if (containsForbiddenPlaintextKeys(applyReadiness)) errors.push("sandbox apply readiness must remain metadata/hash-only before apply simulation");
  }
  if (applyReadinessValidation) {
    if (applyReadinessValidation.schema !== "zob.sandbox-apply-readiness-validation.v1") errors.push("sandbox apply readiness validation schema must be zob.sandbox-apply-readiness-validation.v1 before apply simulation");
    if (applyReadinessValidation.status !== "ready_for_manual_apply" || applyReadinessValidation.applyReady !== true) errors.push("sandbox apply readiness validation must be ready before apply simulation");
    if (applyReadinessValidation.applyPerformed !== false || applyReadinessValidation.autoApply !== false || applyReadinessValidation.productionWritesPerformed !== false || applyReadinessValidation.noExecution !== true) errors.push("sandbox apply readiness validation must not have performed production apply before apply simulation");
    if (containsForbiddenPlaintextKeys(applyReadinessValidation)) errors.push("sandbox apply readiness validation must remain metadata/hash-only before apply simulation");
  }
  if (diffReviewGate) {
    const gates = isRecord(diffReviewGate.gates) ? diffReviewGate.gates : undefined;
    if (diffReviewGate.schema !== "zob.sandbox-diff-review-gate.v1" || diffReviewGate.runId !== input.run_id || diffReviewGate.status !== "diff_review_passed" || diffReviewGate.reviewPassed !== true || diffReviewGate.applyReadyUnlocked !== true) errors.push("sandbox diff review gate must pass before apply simulation");
    if (diffReviewGate.applyPerformed !== false || diffReviewGate.productionWritesPerformed !== false || diffReviewGate.autoApply !== false || diffReviewGate.noExecution !== true) errors.push("sandbox diff review gate must not have applied production writes before apply simulation");
    if (manifest && diffReviewGate.diffHash !== manifest.diffHash) errors.push("sandbox diff review gate diffHash must match sandbox manifest diffHash before apply simulation");
    if (!gates || gates.rollbackValidated !== true || gates.oracleReviewPassed !== true || gates.isolatedExecutionValidated !== true) errors.push("sandbox diff review gate requires rollback/oracle/isolated execution gates before apply simulation");
    if (containsForbiddenPlaintextKeys(diffReviewGate)) errors.push("sandbox diff review gate must remain metadata/hash-only before apply simulation");
  }
  if (oracleReview) {
    if (oracleReview.schema !== "zob.oracle-review.v1" || oracleReview.reviewedRunId !== input.run_id || oracleReview.verdict !== "PASS" || oracleReview.no_ship !== false) errors.push("sandbox apply oracle review must PASS before apply simulation");
    if (typeof oracleReview.evidence !== "string" || oracleReview.evidence.trim().length === 0) errors.push("sandbox apply oracle review evidence is required before apply simulation");
  }
  if (sandboxRoot) {
    const targetWorkspace = join(sandboxRoot, "apply-simulations", simulationId, "target-workspace");
    if (!isInsidePath(sandboxRoot, targetWorkspace)) errors.push("sandbox apply simulation target workspace must stay inside sandboxRoot");
  }

  return errors;
}

export function runSandboxApplySimulation(repoRoot: string, input: SandboxApplySimulationInput): SandboxApplySimulationResult {
  const runId = safeRunId(input.run_id, "sandbox");
  const simulationId = safeRunId(input.simulation_id, "apply-simulation");
  const runDir = join(repoRoot, "reports", "sandbox-runs", runId);
  const simulationDir = join(runDir, "apply-simulations", simulationId);
  const manifestPath = join(runDir, "manifest.json");
  const manifest = existsSync(manifestPath) && isRecord(parseJsonFile(manifestPath)) ? parseJsonFile(manifestPath) as Record<string, unknown> : undefined;
  const sandboxRootErrors: string[] = [];
  const sandboxRoot = sandboxRootFromManifest(repoRoot, runId, manifest, sandboxRootErrors);
  const fallbackSandboxRoot = join(repoRoot, ".pi", "tmp", "sandbox-runs", runId);
  const targetWorkspace = join(sandboxRoot ?? fallbackSandboxRoot, "apply-simulations", simulationId, "target-workspace");
  const errors = validateSandboxApplySimulationInputs(repoRoot, input);
  const status: SandboxApplySimulationResult["status"] = errors.length === 0 ? "simulated_apply_in_temp_workspace" : "blocked_preflight";
  const simulatedApplyPerformed = status === "simulated_apply_in_temp_workspace";
  const changes = changesFromManifest(manifest);
  const changedPaths = changes.map((change) => String(change.path));
  const markerDir = join(targetWorkspace, "simulated-change-markers");
  const rollbackSnapshotPath = join(targetWorkspace, "rollback-snapshot-simulated.metadata.json");
  const markerPaths: string[] = [];
  const artifacts = ["apply-simulation.json", "validation.json", simulatedApplyPerformed ? "SANDBOX_APPLY_SIMULATED.sentinel" : "SANDBOX_APPLY_SIMULATION_BLOCKED.sentinel"];
  const canWriteTargetWorkspace = simulatedApplyPerformed && sandboxRootErrors.length === 0 && typeof sandboxRoot === "string" && existsSync(sandboxRoot) && isInsidePath(sandboxRoot, targetWorkspace);

  mkdirSync(simulationDir, { recursive: true });
  if (canWriteTargetWorkspace) {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(targetWorkspace, "README.md"), ["# ZOB sandbox apply simulation target", "", "This temp workspace contains metadata-only simulated apply markers.", "Production writes and auto-apply are disabled.", ""].join("\n"), "utf8");
    for (const [index, change] of changes.entries()) {
      const markerName = `${String(index + 1).padStart(3, "0")}-${safeFileStem(String(change.path).replace(/[\\/]+/g, "-"))}.metadata.json`;
      const markerPath = join(markerDir, markerName);
      const marker = {
        schema: "zob.sandbox-apply-simulation-marker.v1",
        runId,
        simulationId,
        targetPath: change.path,
        action: change.action,
        contentHash: change.contentHash,
        reasonHash: change.reasonHash,
        simulatedTempWorkspaceWrite: true,
        productionWritePerformed: false,
        autoApply: false,
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
        generatedAt: new Date().toISOString(),
      };
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
      markerPaths.push(markerPath);
    }
    writeFileSync(rollbackSnapshotPath, JSON.stringify({
      schema: "zob.sandbox-apply-simulation-rollback-snapshot.v1",
      runId,
      simulationId,
      changedPaths,
      diffHash: typeof manifest?.diffHash === "string" ? manifest.diffHash : undefined,
      rollbackPrepared: true,
      rollbackApplied: false,
      productionRollbackRequired: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
      generatedAt: new Date().toISOString(),
    }, null, 2), "utf8");
  }

  const simulation = {
    schema: "zob.sandbox-apply-simulation.v1",
    runId,
    simulationId,
    status,
    simulatedApplyPerformed,
    applyPerformed: false,
    autoApply: false,
    manualApplyRequired: true,
    humanApprovalRequired: true,
    productionWritesPerformed: false,
    tempTargetWorkspace: targetWorkspace,
    tempTargetWorkspaceWritten: canWriteTargetWorkspace,
    tempTargetWorkspaceScoped: typeof sandboxRoot === "string" && isInsidePath(sandboxRoot, targetWorkspace),
    changedPaths,
    changeCount: changes.length,
    markerPaths,
    markerCount: markerPaths.length,
    diffHash: typeof manifest?.diffHash === "string" ? manifest.diffHash : undefined,
    evidence: {
      manifest: manifestPath,
      applyReadiness: input.apply_readiness_path ? resolveRepoPath(repoRoot, input.apply_readiness_path).path : undefined,
      rollbackSnapshot: canWriteTargetWorkspace ? rollbackSnapshotPath : undefined,
    },
    gates: {
      applyReadinessReady: simulatedApplyPerformed,
      rollbackPrepared: simulatedApplyPerformed,
      tempTargetWorkspaceScoped: typeof sandboxRoot === "string" && isInsidePath(sandboxRoot, targetWorkspace),
      productionWritesBlocked: true,
      autoApplyBlocked: true,
    },
    childDispatchAllowed: false,
    networkAccessed: false,
    liveChildExecution: false,
    rollbackPrepared: simulatedApplyPerformed,
    rollbackApplied: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    errors,
    generatedAt: new Date().toISOString(),
  };
  const validation = {
    schema: "zob.sandbox-apply-simulation-validation.v1",
    runId,
    simulationId,
    status,
    simulatedApplyPerformed,
    productionWritesPerformed: false,
    autoApply: false,
    tempTargetWorkspace: targetWorkspace,
    tempTargetWorkspaceWritten: canWriteTargetWorkspace,
    markerCount: markerPaths.length,
    changedPaths,
    errors,
    sentinel: simulatedApplyPerformed ? "SANDBOX_APPLY_SIMULATED.sentinel" : "SANDBOX_APPLY_SIMULATION_BLOCKED.sentinel",
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (containsForbiddenPlaintextKeys(simulation) || containsForbiddenPlaintextKeys(validation)) errors.push("sandbox apply simulation artifacts must remain metadata/hash-only");

  writeFileSync(join(simulationDir, "apply-simulation.json"), JSON.stringify(simulation, null, 2), "utf8");
  writeFileSync(join(simulationDir, "validation.json"), JSON.stringify(validation, null, 2), "utf8");
  const sentinel = simulatedApplyPerformed ? "SANDBOX_APPLY_SIMULATED.sentinel" : "SANDBOX_APPLY_SIMULATION_BLOCKED.sentinel";
  writeFileSync(join(simulationDir, sentinel), `${status} ${new Date().toISOString()}\n`, "utf8");
  sandboxLedger(runDir, { event: "sandbox_apply_simulation", simulationId, status, simulatedApplyPerformed, applyPerformed: false, autoApply: false, productionWritesPerformed: false });

  return { runId, simulationId, simulationDir, targetWorkspace, status, simulatedApplyPerformed, productionWritesPerformed: false, autoApply: false, artifacts, errors };
}

export function validateSandboxManualApplyPreflightInputs(repoRoot: string, input: SandboxManualApplyPreflightInput): string[] {
  const errors: string[] = [];
  if (!input.run_id || safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  const runId = input.run_id ?? "invalid-run";
  const preflightId = input.preflight_id ?? "manual-apply-preflight";
  if (safeFileStem(preflightId) !== preflightId) errors.push(`preflight_id must be path-safe: ${preflightId}`);
  const expectedConfirmation = expectedManualApplyPreflightConfirmation(runId, preflightId);
  if (input.confirmation_phrase !== expectedConfirmation) errors.push(`confirmation_phrase must exactly match: ${expectedConfirmation}`);
  if (containsForbiddenPlaintextKeys(input)) errors.push("sandbox manual apply preflight metadata must not include plaintext task/prompt/output/body/content/patch/diff keys");

  const runDir = join(repoRoot, "reports", "sandbox-runs", runId);
  const manifest = readRecord(join(runDir, "manifest.json"), errors, "sandbox manifest");
  const validation = readRecord(join(runDir, "validation.json"), errors, "sandbox validation");
  const diffGate = readRecord(join(runDir, "diff-gate.json"), errors, "diff gate");
  const rollback = readRecord(join(runDir, "rollback-metadata.json"), errors, "rollback metadata");
  const manifestChanges = changesFromManifest(manifest);
  const manifestChangedPaths = manifestChanges.map((change) => String(change.path));
  const allowedPaths = Array.isArray(manifest?.allowedPaths) ? manifest.allowedPaths.filter((item): item is string => typeof item === "string") : [];
  const forbiddenPaths = Array.isArray(manifest?.forbiddenPaths) ? manifest.forbiddenPaths.filter((item): item is string => typeof item === "string") : [];

  let applyReadinessPath: string | undefined;
  let applyReadiness: Record<string, unknown> | undefined;
  let applyReadinessValidation: Record<string, unknown> | undefined;
  if (!input.apply_readiness_path) {
    errors.push("sandbox manual apply preflight requires apply_readiness_path");
  } else {
    const resolvedApplyReadiness = resolveRepoPath(repoRoot, input.apply_readiness_path);
    errors.push(...resolvedApplyReadiness.errors.map((error) => `apply_readiness_path: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(input.apply_readiness_path, protectedPattern, repoRoot, repoRoot)) errors.push(`apply_readiness_path references zero-access path: ${protectedPattern}`);
    }
    const expectedPrefix = join(repoRoot, "reports", "sandbox-runs", runId, "apply-readiness");
    if (!isInsidePath(expectedPrefix, resolvedApplyReadiness.path)) errors.push("apply_readiness_path must stay inside this run's reports/sandbox-runs apply-readiness directory");
    if (resolvedApplyReadiness.errors.length === 0 && isInsidePath(expectedPrefix, resolvedApplyReadiness.path)) {
      applyReadinessPath = resolvedApplyReadiness.path;
      applyReadiness = readRecord(applyReadinessPath, errors, "sandbox apply readiness");
      applyReadinessValidation = readRecord(join(dirname(applyReadinessPath), "validation.json"), errors, "sandbox apply readiness validation");
      if (!existsSync(join(dirname(applyReadinessPath), "APPLY_NOT_PERFORMED.sentinel"))) errors.push("sandbox manual apply preflight requires APPLY_NOT_PERFORMED.sentinel from apply readiness");
    }
  }

  let applySimulationPath: string | undefined;
  let applySimulation: Record<string, unknown> | undefined;
  let applySimulationValidation: Record<string, unknown> | undefined;
  if (!input.apply_simulation_path) {
    errors.push("sandbox manual apply preflight requires apply_simulation_path");
  } else {
    const resolvedApplySimulation = resolveRepoPath(repoRoot, input.apply_simulation_path);
    errors.push(...resolvedApplySimulation.errors.map((error) => `apply_simulation_path: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(input.apply_simulation_path, protectedPattern, repoRoot, repoRoot)) errors.push(`apply_simulation_path references zero-access path: ${protectedPattern}`);
    }
    const expectedPrefix = join(repoRoot, "reports", "sandbox-runs", runId, "apply-simulations");
    if (!isInsidePath(expectedPrefix, resolvedApplySimulation.path)) errors.push("apply_simulation_path must stay inside this run's reports/sandbox-runs apply-simulations directory");
    if (resolvedApplySimulation.errors.length === 0 && isInsidePath(expectedPrefix, resolvedApplySimulation.path)) {
      applySimulationPath = resolvedApplySimulation.path;
      applySimulation = readRecord(applySimulationPath, errors, "sandbox apply simulation");
      applySimulationValidation = readRecord(join(dirname(applySimulationPath), "validation.json"), errors, "sandbox apply simulation validation");
      if (!existsSync(join(dirname(applySimulationPath), "SANDBOX_APPLY_SIMULATED.sentinel"))) errors.push("sandbox manual apply preflight requires SANDBOX_APPLY_SIMULATED.sentinel from apply simulation");
    }
  }

  if (manifest) {
    if (manifest.schema !== "zob.sandbox-write-plan.v1") errors.push("sandbox manifest schema must be zob.sandbox-write-plan.v1 before manual apply preflight");
    if (manifest.runId !== runId) errors.push("sandbox manifest runId must match input run_id before manual apply preflight");
    if (manifest.status !== "planned_safe") errors.push("sandbox manifest must be planned_safe before manual apply preflight");
    if (manifest.autoApply !== false || manifest.noExecution !== true || manifest.humanApprovalRequired !== true) errors.push("sandbox manifest must remain noExecution=true, autoApply=false, humanApprovalRequired=true before manual apply preflight");
    if (typeof manifest.diffHash !== "string" || !HEX_SHA256.test(manifest.diffHash)) errors.push("sandbox manifest requires sha256 diffHash before manual apply preflight");
    if (manifestChanges.length === 0) errors.push("sandbox manifest requires changed paths before manual apply preflight");
    if (allowedPaths.length === 0) errors.push("sandbox manifest requires non-empty allowedPaths before manual apply preflight");
    if (containsForbiddenPlaintextKeys(manifest)) errors.push("sandbox manifest must remain metadata/hash-only before manual apply preflight");
    for (const [index, change] of manifestChanges.entries()) {
      const targetPath = typeof change.path === "string" ? change.path : String(change.path);
      const policy = validateRuntimeWritePolicy({
        targetPath,
        cwd: repoRoot,
        allowedPaths,
        forbiddenPaths,
        zeroAccessPaths: DEFAULT_RULES.zeroAccessPaths,
        readOnlyPaths: DEFAULT_RULES.readOnlyPaths,
      });
      errors.push(...policy.violations.map((violation) => `manifest.changes[${index}]: ${violation}`));
    }
  }
  if (validation) {
    if (validation.schema !== "zob.sandbox-write-validation.v1") errors.push("sandbox validation schema must be zob.sandbox-write-validation.v1 before manual apply preflight");
    if (validation.status !== "planned_safe") errors.push("sandbox validation must be planned_safe before manual apply preflight");
    if (Array.isArray(validation.errors) && validation.errors.length > 0) errors.push("sandbox validation must have no errors before manual apply preflight");
    if (validation.autoApply !== false || validation.noExecution !== true || validation.humanApprovalRequired !== true) errors.push("sandbox validation must remain noExecution=true, autoApply=false, humanApprovalRequired=true before manual apply preflight");
    if (validation.rollbackPrepared !== true || validation.rollbackApplied !== false) errors.push("sandbox validation requires rollbackPrepared=true and rollbackApplied=false before manual apply preflight");
    if (!sameStringSet(validation.changedPaths, manifestChangedPaths)) errors.push("sandbox validation changedPaths must match sandbox manifest changes before manual apply preflight");
    if (manifest && validation.diffHash !== manifest.diffHash) errors.push("sandbox validation diffHash must match sandbox manifest diffHash before manual apply preflight");
    if (validation.sentinel !== "SANDBOX_PLAN_READY.sentinel" || !existsSync(join(runDir, "SANDBOX_PLAN_READY.sentinel"))) errors.push("sandbox plan ready sentinel is required before manual apply preflight");
    if (containsForbiddenPlaintextKeys(validation)) errors.push("sandbox validation must remain metadata/hash-only before manual apply preflight");
  }
  if (diffGate) {
    if (diffGate.schema !== "zob.diff-gate-result.v1") errors.push("diff gate schema must be zob.diff-gate-result.v1 before manual apply preflight");
    if (diffGate.allowed !== true || diffGate.applyRequired !== true || diffGate.autoApply !== false) errors.push("diff gate must be allowed=true, applyRequired=true, autoApply=false before manual apply preflight");
    if (!sameStringSet(diffGate.changedPaths, manifestChangedPaths)) errors.push("diff gate changedPaths must match sandbox manifest changes before manual apply preflight");
    if (manifest && diffGate.diffHash !== manifest.diffHash) errors.push("diff gate diffHash must match sandbox manifest diffHash before manual apply preflight");
    if (containsForbiddenPlaintextKeys(diffGate)) errors.push("diff gate must remain metadata/hash-only before manual apply preflight");
  }
  if (rollback) {
    if (rollback.schema !== "zob.rollback-metadata.v1") errors.push("rollback metadata schema must be zob.rollback-metadata.v1 before manual apply preflight");
    if (rollback.runId !== runId) errors.push("rollback metadata runId must match input run_id before manual apply preflight");
    if (rollback.rollbackPrepared !== true || rollback.rollbackApplied !== false || rollback.autoApply !== false) errors.push("rollback metadata must prepare rollback without applying it before manual apply preflight");
    if (typeof rollback.snapshotPath !== "string" || rollback.snapshotPath.trim().length === 0) errors.push("rollback metadata requires snapshotPath before manual apply preflight");
    if (!sameStringSet(rollback.changedPaths, manifestChangedPaths)) errors.push("rollback metadata changedPaths must match sandbox manifest changes before manual apply preflight");
    if (containsForbiddenPlaintextKeys(rollback)) errors.push("rollback metadata must remain metadata/hash-only before manual apply preflight");
  }
  if (applyReadiness) {
    const gates = isRecord(applyReadiness.gates) ? applyReadiness.gates : undefined;
    const approval = isRecord(applyReadiness.approval) ? applyReadiness.approval : undefined;
    if (applyReadiness.schema !== "zob.sandbox-apply-readiness.v1") errors.push("sandbox apply readiness schema must be zob.sandbox-apply-readiness.v1 before manual apply preflight");
    if (applyReadiness.runId !== runId) errors.push("sandbox apply readiness runId must match input run_id before manual apply preflight");
    if (applyReadiness.status !== "ready_for_manual_apply" || applyReadiness.applyReady !== true) errors.push("sandbox apply readiness must be ready_for_manual_apply before manual apply preflight");
    if (applyReadiness.applyPerformed !== false || applyReadiness.autoApply !== false || applyReadiness.productionWritesPerformed !== false || applyReadiness.noExecution !== true) errors.push("sandbox apply readiness must not have performed production apply before manual apply preflight");
    if (manifest && applyReadiness.diffHash !== manifest.diffHash) errors.push("sandbox apply readiness diffHash must match sandbox manifest diffHash before manual apply preflight");
    if (!sameStringSet(applyReadiness.changedPaths, manifestChangedPaths)) errors.push("sandbox apply readiness changedPaths must match sandbox manifest changes before manual apply preflight");
    if (!gates || gates.sandboxPlanReady !== true || gates.diffAllowed !== true || gates.rollbackPrepared !== true || gates.diffReviewPassed !== true || gates.oracleReviewPassed !== true || gates.approvalPresent !== true) errors.push("sandbox apply readiness gates must all pass before manual apply preflight");
    if (!approval || typeof approval.approvedByHash !== "string" || !HEX_SHA256.test(approval.approvedByHash) || typeof approval.approvalIdHash !== "string" || !HEX_SHA256.test(approval.approvalIdHash) || "approvedBy" in approval || "approvalId" in approval) errors.push("sandbox apply readiness approval must be hash-only before manual apply preflight");
    if (containsForbiddenPlaintextKeys(applyReadiness)) errors.push("sandbox apply readiness must remain metadata/hash-only before manual apply preflight");
  }
  if (applyReadinessValidation) {
    if (applyReadinessValidation.schema !== "zob.sandbox-apply-readiness-validation.v1") errors.push("sandbox apply readiness validation schema must be zob.sandbox-apply-readiness-validation.v1 before manual apply preflight");
    if (applyReadinessValidation.status !== "ready_for_manual_apply" || applyReadinessValidation.applyReady !== true) errors.push("sandbox apply readiness validation must be ready before manual apply preflight");
    if (applyReadinessValidation.applyPerformed !== false || applyReadinessValidation.autoApply !== false || applyReadinessValidation.productionWritesPerformed !== false || applyReadinessValidation.noExecution !== true) errors.push("sandbox apply readiness validation must not have performed production apply before manual apply preflight");
    if (containsForbiddenPlaintextKeys(applyReadinessValidation)) errors.push("sandbox apply readiness validation must remain metadata/hash-only before manual apply preflight");
  }
  if (applySimulation) {
    const simulationGates = isRecord(applySimulation.gates) ? applySimulation.gates : undefined;
    const simulationEvidence = isRecord(applySimulation.evidence) ? applySimulation.evidence : undefined;
    if (applySimulation.schema !== "zob.sandbox-apply-simulation.v1") errors.push("sandbox apply simulation schema must be zob.sandbox-apply-simulation.v1 before manual apply preflight");
    if (applySimulation.runId !== runId) errors.push("sandbox apply simulation runId must match input run_id before manual apply preflight");
    if (applySimulation.status !== "simulated_apply_in_temp_workspace" || applySimulation.simulatedApplyPerformed !== true) errors.push("sandbox apply simulation must pass before manual apply preflight");
    if (applySimulation.applyPerformed !== false || applySimulation.autoApply !== false || applySimulation.productionWritesPerformed !== false) errors.push("sandbox apply simulation must not have performed production apply before manual apply preflight");
    if (applySimulation.tempTargetWorkspaceScoped !== true || applySimulation.tempTargetWorkspaceWritten !== true) errors.push("sandbox apply simulation must write only a scoped temp target workspace before manual apply preflight");
    if (manifest && applySimulation.diffHash !== manifest.diffHash) errors.push("sandbox apply simulation diffHash must match sandbox manifest diffHash before manual apply preflight");
    if (!sameStringSet(applySimulation.changedPaths, manifestChangedPaths)) errors.push("sandbox apply simulation changedPaths must match sandbox manifest changes before manual apply preflight");
    if (!simulationGates || simulationGates.applyReadinessReady !== true || simulationGates.rollbackPrepared !== true || simulationGates.productionWritesBlocked !== true || simulationGates.autoApplyBlocked !== true) errors.push("sandbox apply simulation gates must pass before manual apply preflight");
    if (applyReadinessPath && simulationEvidence && typeof simulationEvidence.applyReadiness === "string" && resolve(simulationEvidence.applyReadiness) !== resolve(applyReadinessPath)) errors.push("sandbox apply simulation evidence must reference the same apply readiness artifact before manual apply preflight");
    if (containsForbiddenPlaintextKeys(applySimulation)) errors.push("sandbox apply simulation must remain metadata/hash-only before manual apply preflight");
  }
  if (applySimulationValidation) {
    if (applySimulationValidation.schema !== "zob.sandbox-apply-simulation-validation.v1") errors.push("sandbox apply simulation validation schema must be zob.sandbox-apply-simulation-validation.v1 before manual apply preflight");
    if (applySimulationValidation.status !== "simulated_apply_in_temp_workspace" || applySimulationValidation.simulatedApplyPerformed !== true) errors.push("sandbox apply simulation validation must pass before manual apply preflight");
    if (applySimulationValidation.productionWritesPerformed !== false || applySimulationValidation.autoApply !== false) errors.push("sandbox apply simulation validation must not have performed production apply before manual apply preflight");
    if (containsForbiddenPlaintextKeys(applySimulationValidation)) errors.push("sandbox apply simulation validation must remain metadata/hash-only before manual apply preflight");
  }
  return errors;
}

export function runSandboxManualApplyPreflight(repoRoot: string, input: SandboxManualApplyPreflightInput): SandboxManualApplyPreflightResult {
  const runId = safeRunId(input.run_id, "sandbox");
  const preflightId = safeRunId(input.preflight_id, "manual-apply-preflight");
  const runDir = join(repoRoot, "reports", "sandbox-runs", runId);
  const preflightDir = join(runDir, "manual-apply-preflight", preflightId);
  const errors = validateSandboxManualApplyPreflightInputs(repoRoot, input);
  const status: SandboxManualApplyPreflightResult["status"] = errors.length === 0 ? "manual_apply_preflight_passed" : "blocked_preflight";
  const manualApplyPreflightPassed = status === "manual_apply_preflight_passed";
  const canUseValidatedArtifactPaths = errors.length === 0;
  const manifestPath = join(runDir, "manifest.json");
  const validationPath = join(runDir, "validation.json");
  const diffGatePath = join(runDir, "diff-gate.json");
  const rollbackPath = join(runDir, "rollback-metadata.json");
  const manifest = existsSync(manifestPath) && isRecord(parseJsonFile(manifestPath)) ? parseJsonFile(manifestPath) as Record<string, unknown> : undefined;
  const validation = existsSync(validationPath) && isRecord(parseJsonFile(validationPath)) ? parseJsonFile(validationPath) as Record<string, unknown> : undefined;
  const rollback = existsSync(rollbackPath) && isRecord(parseJsonFile(rollbackPath)) ? parseJsonFile(rollbackPath) as Record<string, unknown> : undefined;
  const applyReadinessPath = canUseValidatedArtifactPaths && input.apply_readiness_path ? resolveRepoPath(repoRoot, input.apply_readiness_path).path : undefined;
  const applySimulationPath = canUseValidatedArtifactPaths && input.apply_simulation_path ? resolveRepoPath(repoRoot, input.apply_simulation_path).path : undefined;
  const applyReadiness = canUseValidatedArtifactPaths && applyReadinessPath && existsSync(applyReadinessPath) && isRecord(parseJsonFile(applyReadinessPath)) ? parseJsonFile(applyReadinessPath) as Record<string, unknown> : undefined;
  const applySimulation = canUseValidatedArtifactPaths && applySimulationPath && existsSync(applySimulationPath) && isRecord(parseJsonFile(applySimulationPath)) ? parseJsonFile(applySimulationPath) as Record<string, unknown> : undefined;
  const manifestChanges = changesFromManifest(manifest);
  const changedPaths = manifestChanges.map((change) => String(change.path));
  const confirmationPhraseHash = input.confirmation_phrase ? sha256(input.confirmation_phrase) : undefined;
  const expectedConfirmationHash = sha256(expectedManualApplyPreflightConfirmation(runId, preflightId));
  const approval = isRecord(applyReadiness?.approval) ? applyReadiness.approval : undefined;
  const preflight = {
    schema: "zob.sandbox-manual-apply-preflight.v1",
    runId,
    preflightId,
    status,
    manualApplyPreflightPassed,
    applyPerformed: false,
    realApplyExecuted: false,
    autoApply: false,
    manualApplyRequired: true,
    humanApprovalRequired: true,
    productionWritesPerformed: false,
    noExecution: true,
    executionAllowedByThisTool: false,
    changedPaths,
    changeCount: changedPaths.length,
    diffHash: typeof manifest?.diffHash === "string" ? manifest.diffHash : undefined,
    evidence: {
      manifest: manifestPath,
      validation: validationPath,
      diffGate: diffGatePath,
      rollback: rollbackPath,
      applyReadiness: applyReadinessPath,
      applyReadinessValidation: applyReadinessPath ? join(dirname(applyReadinessPath), "validation.json") : undefined,
      applySimulation: applySimulationPath,
      applySimulationValidation: applySimulationPath ? join(dirname(applySimulationPath), "validation.json") : undefined,
    },
    evidenceHashes: {
      manifest: artifactHash(manifestPath),
      validation: artifactHash(validationPath),
      diffGate: artifactHash(diffGatePath),
      rollback: artifactHash(rollbackPath),
      applyReadiness: artifactHash(applyReadinessPath),
      applyReadinessValidation: applyReadinessPath ? artifactHash(join(dirname(applyReadinessPath), "validation.json")) : undefined,
      applySimulation: artifactHash(applySimulationPath),
      applySimulationValidation: applySimulationPath ? artifactHash(join(dirname(applySimulationPath), "validation.json")) : undefined,
    },
    gates: {
      sandboxPlanReady: manifest?.status === "planned_safe" && validation?.status === "planned_safe",
      diffAllowed: existsSync(diffGatePath),
      rollbackPrepared: rollback?.rollbackPrepared === true && rollback?.rollbackApplied === false,
      applyReadinessReady: canUseValidatedArtifactPaths && applyReadiness?.status === "ready_for_manual_apply" && applyReadiness.applyReady === true,
      applySimulationPassed: canUseValidatedArtifactPaths && applySimulation?.status === "simulated_apply_in_temp_workspace" && applySimulation.simulatedApplyPerformed === true,
      confirmationPhraseMatched: confirmationPhraseHash === expectedConfirmationHash,
      approvalHashOnly: approval !== undefined && typeof approval.approvedByHash === "string" && typeof approval.approvalIdHash === "string" && !("approvedBy" in approval) && !("approvalId" in approval),
      changedPathsStillScoped: errors.every((error) => !error.includes("manifest.changes")),
      productionWritesBlocked: true,
      autoApplyBlocked: true,
    },
    approval: approval ? {
      approvedByHash: approval.approvedByHash,
      approvedAt: approval.approvedAt,
      approvalIdHash: approval.approvalIdHash,
      bodyStored: false,
    } : undefined,
    confirmation: {
      expectedPhraseHash: expectedConfirmationHash,
      suppliedPhraseHash: confirmationPhraseHash,
      matched: confirmationPhraseHash === expectedConfirmationHash,
      rawConfirmationStored: false,
    },
    rollbackPolicy: {
      rollbackPrepared: rollback?.rollbackPrepared === true,
      rollbackApplied: false,
      snapshotPathHash: typeof rollback?.snapshotPath === "string" ? sha256(rollback.snapshotPath) : undefined,
      mainWorkspaceRollbackSnapshotRequiredBeforeRealApply: true,
    },
    manualApplyPolicy: {
      realApplyAllowedByThisPreflight: false,
      futureManualApplyRequiresSeparateExecutor: true,
      futureManualApplyRequiresFreshMainWorkspaceSnapshot: true,
      futureManualApplyRequiresOperatorAtKeyboard: true,
      futureManualApplyRequiresExactDiffHashMatch: true,
      futureManualApplyRequiresRollbackDryRun: true,
      futureManualApplyRequiresPostApplyValidationAndOracle: true,
      autoApplyAllowed: false,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    networkAccessed: false,
    liveChildExecution: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    errors,
    generatedAt: new Date().toISOString(),
  };
  const preflightValidation = {
    schema: "zob.sandbox-manual-apply-preflight-validation.v1",
    runId,
    preflightId,
    status,
    manualApplyPreflightPassed,
    applyPerformed: false,
    realApplyExecuted: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecution: true,
    executionAllowedByThisTool: false,
    errors,
    sentinel: "MANUAL_APPLY_NOT_PERFORMED.sentinel",
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (containsForbiddenPlaintextKeys(preflight) || containsForbiddenPlaintextKeys(preflightValidation)) errors.push("sandbox manual apply preflight artifacts must remain metadata/hash-only");

  mkdirSync(preflightDir, { recursive: true });
  writeFileSync(join(preflightDir, "manual-apply-preflight.json"), JSON.stringify(preflight, null, 2), "utf8");
  writeFileSync(join(preflightDir, "validation.json"), JSON.stringify(preflightValidation, null, 2), "utf8");
  writeFileSync(join(preflightDir, "MANUAL_APPLY_NOT_PERFORMED.sentinel"), `manual_apply_not_performed ${new Date().toISOString()}\n`, "utf8");
  sandboxLedger(runDir, { event: "sandbox_manual_apply_preflight", preflightId, status, manualApplyPreflightPassed, applyPerformed: false, autoApply: false, productionWritesPerformed: false });

  return { runId, preflightId, preflightDir, status, manualApplyPreflightPassed, applyPerformed: false, productionWritesPerformed: false, autoApply: false, artifacts: ["manual-apply-preflight.json", "validation.json", "MANUAL_APPLY_NOT_PERFORMED.sentinel"], errors };
}
