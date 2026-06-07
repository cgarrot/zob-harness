import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_RULES } from "../../../core/constants.js";
import { validateRuntimeWritePolicy } from "../safety.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { pathMatches, resolveRepoPath, safeFileStem } from "../../../core/utils/paths.js";
import { isRecord } from "../../../core/utils/records.js";
import { HEX_SHA256, changesFromManifest, containsForbiddenPlaintextKeys, findIsolatedExecutionValidations, readRecord, sameStringSet, sandboxRootFromManifest } from "./helpers.js";
import type { SandboxApplyReadinessInput, SandboxDiffReviewGateInput, SandboxIsolatedExecutionInput, SandboxWritePlanInput } from "./types.js";

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
