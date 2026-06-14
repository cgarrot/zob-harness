import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactPath, artifactRef, firstExistingArtifactPath } from "../../../core/artifact-roots.js";
import { runFactoryRun } from "../../factory/run.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { safeFileStem } from "../../../core/utils/paths.js";
import { isRecord } from "../../../core/utils/records.js";
import type { AutonomousReadOnlySmokeRunInput, AutonomousRuntimeDryRunInput } from "./types.js";
import { buildAutonomousModelRoutingProofPlan, buildAutonomousRuntimeDryRun, buildAutonomousRuntimeDryRunFinalReport, buildAutonomousRuntimeDryRunValidation, buildAutonomousStrictBudgetProofPlan, hasForbiddenBodyKeys } from "./dry-run.js";
import { artifactHashIfPresent, buildAutonomousCompletionGate, buildAutonomousCurrentSourceFingerprint, buildAutonomousFinalE2EProofPlan, buildAutonomousFinalNoShipOracle, buildAutonomousMissionControlPlan, buildAutonomousMissionControlProofPlan, buildAutonomousPromotionPlan, buildAutonomousPromotionProofPlan, buildAutonomousReadOnlySmokeFinalReport, buildAutonomousSandboxApplyPlan, buildAutonomousSchedulerPlan, buildAutonomousSchedulerProofPlan, readJsonArtifact, relativeFactoryRunPath, validateAutonomousCurrentSourceFingerprintFreshness } from "./smoke-run.js";

export function writeAutonomousRuntimeDryRunReport(repoRoot: string, input: AutonomousRuntimeDryRunInput): Record<string, unknown> {
  const report = buildAutonomousRuntimeDryRun(repoRoot, input);
  const runId = String(report.runId);
  const safeRunId = safeFileStem(runId);
  const runDir = artifactPath(repoRoot, "reports", "autonomous-runs", safeRunId);
  mkdirSync(runDir, { recursive: true });
  const specGatePath = join(runDir, "spec-gate.json");
  const contextScopePath = join(runDir, "context-scope.json");
  const contextLookupPath = join(runDir, "context-lookup.json");
  const contextPackPath = join(runDir, "context-pack.json");
  const runtimeGatesPath = join(runDir, "runtime-gates.json");
  const modelRoutingPlanPath = join(runDir, "model-routing-plan.json");
  const runGraphPath = join(runDir, "run-graph.json");
  const factorySelectionPath = join(runDir, "factory-selection.json");
  const proofPlanPath = join(runDir, "proof-plan.json");
  const reportPath = join(runDir, "dry-run-report.json");
  const validationPath = join(runDir, "validation.json");
  const finalReportPath = join(runDir, "final-report.md");
  writeFileSync(specGatePath, `${JSON.stringify(report.specGate, null, 2)}\n`);
  const contextPlan = isRecord(report.contextPlan) ? report.contextPlan : {};
  const contextScope = isRecord(contextPlan.contextScope) ? contextPlan.contextScope : {};
  writeFileSync(contextScopePath, `${JSON.stringify(contextScope, null, 2)}\n`);
  writeFileSync(contextLookupPath, `${JSON.stringify(contextPlan.lookupResults ?? [], null, 2)}\n`);
  writeFileSync(contextPackPath, `${JSON.stringify(contextPlan.contextPack ?? {}, null, 2)}\n`);
  writeFileSync(runtimeGatesPath, `${JSON.stringify(report.runtimeGates, null, 2)}\n`);
  writeFileSync(modelRoutingPlanPath, `${JSON.stringify(report.modelRoutingPlan, null, 2)}\n`);
  writeFileSync(runGraphPath, `${JSON.stringify(report.runGraph, null, 2)}\n`);
  writeFileSync(factorySelectionPath, `${JSON.stringify(report.factorySelection, null, 2)}\n`);
  writeFileSync(proofPlanPath, `${JSON.stringify(report.proofPlan, null, 2)}\n`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const validation = buildAutonomousRuntimeDryRunValidation(report);
  writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  writeFileSync(finalReportPath, buildAutonomousRuntimeDryRunFinalReport(report));
  if (report.status === "dry_run_plan_ready") writeFileSync(join(runDir, "DRY_RUN_READY.sentinel"), "dry-run-ready\n");
  return {
    ...report,
    specGatePath: artifactRef("reports", "autonomous-runs", safeRunId, "spec-gate.json"),
    contextScopePath: artifactRef("reports", "autonomous-runs", safeRunId, "context-scope.json"),
    contextLookupPath: artifactRef("reports", "autonomous-runs", safeRunId, "context-lookup.json"),
    contextPackPath: artifactRef("reports", "autonomous-runs", safeRunId, "context-pack.json"),
    runtimeGatesPath: artifactRef("reports", "autonomous-runs", safeRunId, "runtime-gates.json"),
    modelRoutingPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "model-routing-plan.json"),
    runGraphPath: artifactRef("reports", "autonomous-runs", safeRunId, "run-graph.json"),
    factorySelectionPath: artifactRef("reports", "autonomous-runs", safeRunId, "factory-selection.json"),
    proofPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "proof-plan.json"),
    reportPath: artifactRef("reports", "autonomous-runs", safeRunId, "dry-run-report.json"),
    validationPath: artifactRef("reports", "autonomous-runs", safeRunId, "validation.json"),
    finalReportPath: artifactRef("reports", "autonomous-runs", safeRunId, "final-report.md"),
    sentinelPath: report.status === "dry_run_plan_ready" ? artifactRef("reports", "autonomous-runs", safeRunId, "DRY_RUN_READY.sentinel") : undefined,
  };
}
export function writeAutonomousReadOnlySmokeRunReport(repoRoot: string, input: AutonomousReadOnlySmokeRunInput): Record<string, unknown> {
  const runId = safeFileStem(input.runId ?? `autonomous-readonly-smoke-${sha256(input.userNeed || "missing-spec").slice(0, 12)}`);
  const safeRunId = safeFileStem(runId);
  const runDir = artifactPath(repoRoot, "reports", "autonomous-runs", safeRunId);
  const smokeAutonomySentinelPath = join(runDir, "SMOKE_AUTONOMY_PASSED.sentinel");
  if (existsSync(smokeAutonomySentinelPath)) throw new Error(`Autonomous smoke run already passed; choose a fresh run_id to avoid stale sentinel reuse: ${runId}`);
  const dryRun = writeAutonomousRuntimeDryRunReport(repoRoot, {
    ...input,
    runId,
    applyPolicy: input.applyPolicy ?? "no_apply",
    budgetProfile: input.budgetProfile ?? "strict_requested",
  });
  const factorySelection = isRecord(dryRun.factorySelection) ? dryRun.factorySelection : {};
  const selectedFactory = typeof factorySelection.selectedFactory === "string" ? factorySelection.selectedFactory : undefined;
  const manifestPath = selectedFactory ? `.pi/factories/${selectedFactory}/smoke-manifest.json` : undefined;
  const factoryRunId = safeFileStem(input.factoryRunId ?? `autonomous-smoke-${safeRunId}`);
  const factoryRunAlreadyExists = existsSync(firstExistingArtifactPath(repoRoot, "reports", "factory-runs", factoryRunId));
  const blockers = [
    ...(dryRun.status === "dry_run_plan_ready" ? [] : ["dry_run_not_ready"]),
    ...(isRecord(dryRun.validation) && Array.isArray(dryRun.validation.blockers) ? dryRun.validation.blockers.filter((blocker): blocker is string => typeof blocker === "string") : []),
    ...(isRecord(dryRun.specGate) && dryRun.specGate.applyPolicy === "no_apply" ? [] : ["apply_policy_must_be_no_apply_for_readonly_smoke"]),
    ...(isRecord(dryRun.specGate) && dryRun.specGate.budgetProfile === "strict_requested" ? [] : ["strict_requested_budget_required_for_readonly_smoke"]),
    ...(isRecord(dryRun.runtimeGates) && dryRun.runtimeGates.childDispatchAllowed === false && dryRun.runtimeGates.daemonStarted === false && dryRun.runtimeGates.productionWritesPerformed === false && dryRun.runtimeGates.autoApply === false ? [] : ["runtime_gates_not_readonly_safe"]),
    ...(isRecord(dryRun.modelRoutingPlan) && dryRun.modelRoutingPlan.routingPlanReady === true && dryRun.modelRoutingPlan.liveRoutingEnabled === false && dryRun.modelRoutingPlan.childDispatchAllowed === false ? [] : ["model_routing_plan_not_readonly_safe"]),
    ...(selectedFactory ? [] : ["factory_selection_missing"]),
    ...(factorySelection.selectionStatus === "existing_factory_selected" ? [] : ["selected_factory_must_be_existing_for_readonly_smoke"]),
    ...(manifestPath && existsSync(join(repoRoot, manifestPath)) ? [] : ["selected_factory_smoke_manifest_missing"]),
    ...(factoryRunAlreadyExists ? ["factory_run_id_already_exists"] : []),
  ];
  const shouldRunFactory = blockers.length === 0 && selectedFactory !== undefined && manifestPath !== undefined;
  const factoryRunResult = shouldRunFactory ? runFactoryRun(repoRoot, {
    factory: selectedFactory,
    input_manifest: manifestPath,
    run_id: factoryRunId,
    mode: "smoke",
    max_items: 1,
    execution: "deterministic",
    budget: { strictRequested: true, strictEnabled: false, maxRuns: 1, estimatedRuns: 1, maxParallelChildren: 1, estimatedParallelChildren: 1 },
    model_routing: { enabled: false, risk: input.risk ?? "medium", contextTokens: input.maxContextTokens },
  }) : undefined;
  const factoryRunDir = firstExistingArtifactPath(repoRoot, "reports", "factory-runs", factoryRunId);
  const factoryValidationPath = join(factoryRunDir, "validation.json");
  const factoryValidationRead = readJsonArtifact(factoryValidationPath);
  const factoryValidation = isRecord(factoryValidationRead.parsed) ? factoryValidationRead.parsed : {};
  const phaseSentinelPresent = existsSync(join(factoryRunDir, "SMOKE_PASSED.sentinel"));
  const doneSentinelPresent = existsSync(join(factoryRunDir, "DONE.sentinel"));
  const factoryRunRef = {
    schema: "zob.autonomous-readonly-smoke-factory-run-ref.v1",
    runId,
    selectedFactory,
    manifestPath,
    factoryRunId,
    factoryRunPath: relativeFactoryRunPath(factoryRunId),
    status: factoryRunResult?.status ?? "not_started",
    processed: factoryRunResult?.processed ?? 0,
    failed: factoryRunResult?.failed ?? 0,
    execution: "deterministic",
    mode: "smoke",
    reportsOnlyWrites: true,
    productionWritesPerformed: false,
    autoApply: false,
    childDispatchAllowed: false,
    liveChildDispatches: 0,
    daemonStarted: false,
    phaseSentinel: "SMOKE_PASSED.sentinel",
    phaseSentinelPresent,
    doneSentinelPresent,
    validationPath: relativeFactoryRunPath(factoryRunId, "validation.json"),
    validationHash: factoryValidationRead.hash,
    artifactHashes: {
      validation: factoryValidationRead.hash,
      smokeSentinel: artifactHashIfPresent(join(factoryRunDir, "SMOKE_PASSED.sentinel")),
      doneSentinel: artifactHashIfPresent(join(factoryRunDir, "DONE.sentinel")),
      telemetry: artifactHashIfPresent(join(factoryRunDir, "telemetry.json")),
      agenticPlan: artifactHashIfPresent(join(factoryRunDir, "agentic-plan.json")),
    },
    artifacts: factoryRunResult?.artifacts ?? [],
    errors: factoryRunResult?.errors ?? [],
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const oracleChecks = [
    { name: "dry_run_ready", passed: dryRun.status === "dry_run_plan_ready" },
    { name: "context_pack_cited", passed: isRecord(dryRun.contextPlan) && dryRun.contextPlan.contextPackValid === true },
    { name: "runtime_gates_readonly", passed: isRecord(dryRun.runtimeGates) && dryRun.runtimeGates.childDispatchAllowed === false && dryRun.runtimeGates.daemonStarted === false && dryRun.runtimeGates.productionWritesPerformed === false && dryRun.runtimeGates.autoApply === false },
    { name: "model_routing_plan_readonly", passed: isRecord(dryRun.modelRoutingPlan) && dryRun.modelRoutingPlan.routingPlanReady === true && dryRun.modelRoutingPlan.liveRoutingEnabled === false && dryRun.modelRoutingPlan.childDispatchAllowed === false },
    { name: "factory_selection_existing", passed: factorySelection.selectionStatus === "existing_factory_selected" && Boolean(selectedFactory) },
    { name: "factory_smoke_done", passed: factoryRunResult?.status === "done" && factoryRunResult.processed === 1 && factoryRunResult.failed === 0 },
    { name: "factory_validation_passed", passed: factoryValidation.status === "passed" },
    { name: "smoke_sentinel_present", passed: phaseSentinelPresent },
    { name: "done_sentinel_present", passed: doneSentinelPresent },
  ];
  const structuralOraclePassed = blockers.length === 0 && oracleChecks.every((check) => check.passed === true);
  const oracleReview = {
    schema: "zob.autonomous-readonly-smoke-oracle-review.v1",
    runId,
    oracleType: "deterministic_structural",
    verdict: structuralOraclePassed ? "PASS" : "FAIL",
    no_ship: !structuralOraclePassed,
    liveOracleDispatched: false,
    evidenceChecked: true,
    checks: oracleChecks,
    failedChecks: oracleChecks.filter((check) => check.passed !== true).map((check) => check.name),
    evidenceRefs: [
      artifactRef("reports", "autonomous-runs", safeRunId, "spec-gate.json"),
      artifactRef("reports", "autonomous-runs", safeRunId, "context-pack.json"),
      artifactRef("reports", "autonomous-runs", safeRunId, "runtime-gates.json"),
      artifactRef("reports", "autonomous-runs", safeRunId, "model-routing-plan.json"),
      artifactRef("reports", "autonomous-runs", safeRunId, "factory-selection.json"),
      artifactRef("reports", "autonomous-runs", safeRunId, "factory-run-ref.json"),
      relativeFactoryRunPath(factoryRunId, "validation.json"),
      relativeFactoryRunPath(factoryRunId, "SMOKE_PASSED.sentinel"),
      relativeFactoryRunPath(factoryRunId, "DONE.sentinel"),
    ],
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const validation = {
    schema: "zob.autonomous-readonly-smoke-validation.v1",
    runId,
    status: structuralOraclePassed ? "smoke_autonomy_passed" : "blocked",
    passed: structuralOraclePassed,
    no_ship: !structuralOraclePassed,
    smokeRunNoShip: !structuralOraclePassed,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    blockers: [...blockers, ...oracleChecks.filter((check) => check.passed !== true).map((check) => check.name)],
    warnings: ["phase_4a_deterministic_structural_oracle_only", "global_autonomy_no_ship", "reports_only_writes"],
    dryRunReady: dryRun.status === "dry_run_plan_ready",
    selectedFactory,
    factoryRunId,
    factoryRunStatus: factoryRunResult?.status ?? "not_started",
    oracleVerdict: oracleReview.verdict,
    oracleNoShip: oracleReview.no_ship,
    reportsOnlyWrites: true,
    deterministicExecution: true,
    childDispatchAllowed: false,
    liveChildDispatches: 0,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    liveRoutingEnabled: false,
    globalLiveRoutingEnabled: false,
    sentinel: structuralOraclePassed ? "SMOKE_AUTONOMY_PASSED.sentinel" : undefined,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const promotionPlan = buildAutonomousPromotionPlan({ runId, selectedFactory, factoryRunRef, oracleReview, validation });
  const promotionProofPlan = buildAutonomousPromotionProofPlan({ runId, promotionPlan, factoryRunRef, oracleReview, validation });
  const schedulerPlan = buildAutonomousSchedulerPlan(repoRoot, { runId, promotionPlan, validation });
  const schedulerProofPlan = buildAutonomousSchedulerProofPlan({ runId, schedulerPlan, validation });
  const missionControlPlan = buildAutonomousMissionControlPlan(repoRoot, { runId, schedulerPlan, validation });
  const strictBudgetProofPlan = buildAutonomousStrictBudgetProofPlan({ runId, runtimeGates: isRecord(dryRun.runtimeGates) ? dryRun.runtimeGates : {}, validation });
  const modelRoutingProofPlan = buildAutonomousModelRoutingProofPlan({ runId, modelRoutingPlan: isRecord(dryRun.modelRoutingPlan) ? dryRun.modelRoutingPlan : {}, validation });
  const missionControlProofPlan = buildAutonomousMissionControlProofPlan({ runId, missionControlPlan, schedulerProofPlan, modelRoutingProofPlan, validation });
  const sandboxApplyPlan = buildAutonomousSandboxApplyPlan(repoRoot, { runId, missionControlPlan, validation });
  const currentSourceFingerprint = buildAutonomousCurrentSourceFingerprint(repoRoot, { runId, factorySelection });
  const finalE2EProofPlan = buildAutonomousFinalE2EProofPlan(repoRoot, {
    runId,
    runtimeGates: isRecord(dryRun.runtimeGates) ? dryRun.runtimeGates : {},
    strictBudgetProofPlan,
    modelRoutingProofPlan,
    modelRoutingPlan: isRecord(dryRun.modelRoutingPlan) ? dryRun.modelRoutingPlan : {},
    factorySelection,
    factoryRunRef,
    oracleReview,
    promotionPlan,
    promotionProofPlan,
    schedulerPlan,
    schedulerProofPlan,
    missionControlPlan,
    missionControlProofPlan,
    sandboxApplyPlan,
    currentSourceFingerprint,
    validation,
  });
  const finalNoShipOracle = buildAutonomousFinalNoShipOracle({ runId, finalE2EProofPlan, currentSourceFingerprint });
  const currentSourceFingerprintFreshness = validateAutonomousCurrentSourceFingerprintFreshness(repoRoot, currentSourceFingerprint, factorySelection);
  const completionGate = buildAutonomousCompletionGate({ runId, finalE2EProofPlan, finalNoShipOracle, currentSourceFingerprintFreshness });
  if (hasForbiddenBodyKeys(factoryRunRef) || hasForbiddenBodyKeys(oracleReview) || hasForbiddenBodyKeys(promotionPlan) || hasForbiddenBodyKeys(promotionProofPlan) || hasForbiddenBodyKeys(schedulerPlan) || hasForbiddenBodyKeys(schedulerProofPlan) || hasForbiddenBodyKeys(missionControlPlan) || hasForbiddenBodyKeys(missionControlProofPlan) || hasForbiddenBodyKeys(sandboxApplyPlan) || hasForbiddenBodyKeys(strictBudgetProofPlan) || hasForbiddenBodyKeys(modelRoutingProofPlan) || hasForbiddenBodyKeys(currentSourceFingerprint) || hasForbiddenBodyKeys(finalE2EProofPlan) || hasForbiddenBodyKeys(finalNoShipOracle) || hasForbiddenBodyKeys(completionGate) || hasForbiddenBodyKeys(validation)) throw new Error("autonomous readonly smoke artifacts would store forbidden plaintext body keys");
  const factoryRunRefPath = join(runDir, "factory-run-ref.json");
  const oracleReviewPath = join(runDir, "oracle-review.json");
  const promotionPlanPath = join(runDir, "promotion-plan.json");
  const promotionProofPlanPath = join(runDir, "promotion-proof-plan.json");
  const schedulerPlanPath = join(runDir, "scheduler-plan.json");
  const schedulerProofPlanPath = join(runDir, "scheduler-proof-plan.json");
  const missionControlPlanPath = join(runDir, "mission-control-plan.json");
  const missionControlProofPlanPath = join(runDir, "mission-control-proof-plan.json");
  const sandboxApplyPlanPath = join(runDir, "sandbox-apply-plan.json");
  const strictBudgetProofPlanPath = join(runDir, "strict-budget-proof-plan.json");
  const modelRoutingProofPlanPath = join(runDir, "model-routing-proof-plan.json");
  const currentSourceFingerprintPath = join(runDir, "current-source-fingerprint.json");
  const finalE2EProofPlanPath = join(runDir, "final-e2e-proof-plan.json");
  const finalNoShipOraclePath = join(runDir, "final-no-ship-oracle.json");
  const completionGatePath = join(runDir, "completion-gate.json");
  const validationPath = join(runDir, "validation.json");
  const finalReportPath = join(runDir, "final-report.md");
  writeFileSync(factoryRunRefPath, `${JSON.stringify(factoryRunRef, null, 2)}\n`);
  writeFileSync(oracleReviewPath, `${JSON.stringify(oracleReview, null, 2)}\n`);
  writeFileSync(promotionPlanPath, `${JSON.stringify(promotionPlan, null, 2)}\n`);
  writeFileSync(promotionProofPlanPath, `${JSON.stringify(promotionProofPlan, null, 2)}\n`);
  writeFileSync(schedulerPlanPath, `${JSON.stringify(schedulerPlan, null, 2)}\n`);
  writeFileSync(schedulerProofPlanPath, `${JSON.stringify(schedulerProofPlan, null, 2)}\n`);
  writeFileSync(missionControlPlanPath, `${JSON.stringify(missionControlPlan, null, 2)}\n`);
  writeFileSync(missionControlProofPlanPath, `${JSON.stringify(missionControlProofPlan, null, 2)}\n`);
  writeFileSync(sandboxApplyPlanPath, `${JSON.stringify(sandboxApplyPlan, null, 2)}\n`);
  writeFileSync(strictBudgetProofPlanPath, `${JSON.stringify(strictBudgetProofPlan, null, 2)}\n`);
  writeFileSync(modelRoutingProofPlanPath, `${JSON.stringify(modelRoutingProofPlan, null, 2)}\n`);
  writeFileSync(currentSourceFingerprintPath, `${JSON.stringify(currentSourceFingerprint, null, 2)}\n`);
  writeFileSync(finalE2EProofPlanPath, `${JSON.stringify(finalE2EProofPlan, null, 2)}\n`);
  writeFileSync(finalNoShipOraclePath, `${JSON.stringify(finalNoShipOracle, null, 2)}\n`);
  writeFileSync(completionGatePath, `${JSON.stringify(completionGate, null, 2)}\n`);
  writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  writeFileSync(finalReportPath, buildAutonomousReadOnlySmokeFinalReport(validation, factoryRunRef, oracleReview));
  if (structuralOraclePassed) writeFileSync(smokeAutonomySentinelPath, "smoke-autonomy-passed\n");
  return {
    ...dryRun,
    status: validation.status,
    no_ship: validation.no_ship,
    smokeRunNoShip: validation.smokeRunNoShip,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    factoryRunRef,
    oracleReview,
    promotionPlan,
    promotionProofPlan,
    schedulerPlan,
    schedulerProofPlan,
    missionControlPlan,
    missionControlProofPlan,
    sandboxApplyPlan,
    strictBudgetProofPlan,
    modelRoutingProofPlan,
    currentSourceFingerprint,
    finalE2EProofPlan,
    finalNoShipOracle,
    completionGate,
    validation,
    factoryRunRefPath: artifactRef("reports", "autonomous-runs", safeRunId, "factory-run-ref.json"),
    oracleReviewPath: artifactRef("reports", "autonomous-runs", safeRunId, "oracle-review.json"),
    promotionPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "promotion-plan.json"),
    promotionProofPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "promotion-proof-plan.json"),
    schedulerPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "scheduler-plan.json"),
    schedulerProofPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "scheduler-proof-plan.json"),
    missionControlPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "mission-control-plan.json"),
    missionControlProofPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "mission-control-proof-plan.json"),
    sandboxApplyPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "sandbox-apply-plan.json"),
    strictBudgetProofPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "strict-budget-proof-plan.json"),
    modelRoutingProofPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "model-routing-proof-plan.json"),
    currentSourceFingerprintPath: artifactRef("reports", "autonomous-runs", safeRunId, "current-source-fingerprint.json"),
    finalE2EProofPlanPath: artifactRef("reports", "autonomous-runs", safeRunId, "final-e2e-proof-plan.json"),
    finalNoShipOraclePath: artifactRef("reports", "autonomous-runs", safeRunId, "final-no-ship-oracle.json"),
    completionGatePath: artifactRef("reports", "autonomous-runs", safeRunId, "completion-gate.json"),
    validationPath: artifactRef("reports", "autonomous-runs", safeRunId, "validation.json"),
    finalReportPath: artifactRef("reports", "autonomous-runs", safeRunId, "final-report.md"),
    smokeSentinelPath: structuralOraclePassed ? artifactRef("reports", "autonomous-runs", safeRunId, "SMOKE_AUTONOMY_PASSED.sentinel") : undefined,
  };
}
