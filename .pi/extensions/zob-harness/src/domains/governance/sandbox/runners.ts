import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_RULES } from "../../../core/constants.js";
import { createDiffGateResult, createRollbackMetadata, createSandboxMetadata } from "../safety.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { parseJsonFile } from "../../../core/utils/json.js";
import { resolveRepoPath, safeFileStem, safeRunId } from "../../../core/utils/paths.js";
import { isRecord } from "../../../core/utils/records.js";
import { changesFromManifest, containsForbiddenPlaintextKeys, findIsolatedExecutionValidations, normalizeChanges, sandboxLedger, sandboxRootFromManifest } from "./helpers.js";
import type { SandboxApplyReadinessInput, SandboxApplyReadinessResult, SandboxDiffReviewGateInput, SandboxDiffReviewGateResult, SandboxIsolatedExecutionInput, SandboxIsolatedExecutionResult, SandboxWritePlanInput, SandboxWritePlanResult } from "./types.js";
import { validateSandboxApplyReadinessInputs, validateSandboxDiffReviewGateInputs, validateSandboxIsolatedExecutionInputs, validateSandboxWritePlanInputs } from "./validation.js";

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
