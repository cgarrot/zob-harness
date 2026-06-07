import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_RULES } from "../../../core/constants.js";
import { validateRuntimeWritePolicy } from "../safety.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { parseJsonFile } from "../../../core/utils/json.js";
import { pathMatches, resolveRepoPath, safeFileStem, safeRunId } from "../../../core/utils/paths.js";
import { isRecord } from "../../../core/utils/records.js";
import { HEX_SHA256, artifactHash, changesFromManifest, containsForbiddenPlaintextKeys, expectedManualApplyPreflightConfirmation, isInsidePath, readRecord, sameStringSet, sandboxLedger, sandboxRootFromManifest } from "./helpers.js";
import type { SandboxApplySimulationInput, SandboxApplySimulationResult, SandboxManualApplyPreflightInput, SandboxManualApplyPreflightResult } from "./types.js";

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
