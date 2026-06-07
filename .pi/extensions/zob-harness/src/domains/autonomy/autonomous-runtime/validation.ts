import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../../core/utils/hashing.js";
import { safeFileStem } from "../../../core/utils/paths.js";
import { isRecord } from "../../../core/utils/records.js";
import { hasForbiddenBodyKeys, hashes } from "./dry-run.js";
import { artifactHashIfPresent, readJsonArtifact, validateAutonomousCurrentSourceFingerprintFreshness } from "./smoke-run.js";

export function validateAutonomousRuntimeDryRunArtifacts(repoRoot: string, runId: string): Record<string, unknown> {
  const safeRunId = safeFileStem(runId);
  const runDir = join(repoRoot, "reports", "autonomous-runs", safeRunId);
  const requiredArtifacts = ["spec-gate.json", "context-scope.json", "context-lookup.json", "context-pack.json", "runtime-gates.json", "model-routing-plan.json", "run-graph.json", "factory-selection.json", "proof-plan.json", "dry-run-report.json", "validation.json", "final-report.md", "DRY_RUN_READY.sentinel"];
  const jsonArtifacts = requiredArtifacts.filter((name) => name.endsWith(".json"));
  const parsedArtifacts: Record<string, Record<string, unknown> | unknown[]> = {};
  const artifactMetadata = requiredArtifacts.map((name) => {
    const artifactPath = join(runDir, name);
    const present = existsSync(artifactPath);
    if (!present) return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, bodyStored: false };
    if (!name.endsWith(".json")) {
      const raw = readFileSync(artifactPath, "utf8");
      return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, hash: sha256(raw), bodyStored: false };
    }
    const read = readJsonArtifact(artifactPath);
    if (read.parsed) parsedArtifacts[name] = read.parsed;
    return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, hash: read.hash, schema: isRecord(read.parsed) ? read.parsed.schema : undefined, error: read.error, bodyStored: false };
  });
  const artifact = (name: string): Record<string, unknown> => isRecord(parsedArtifacts[name]) ? parsedArtifacts[name] as Record<string, unknown> : {};
  const arrayArtifact = (name: string): unknown[] => Array.isArray(parsedArtifacts[name]) ? parsedArtifacts[name] as unknown[] : [];
  const report = artifact("dry-run-report.json");
  const validation = artifact("validation.json");
  const specGate = artifact("spec-gate.json");
  const contextScope = artifact("context-scope.json");
  const contextLookups = arrayArtifact("context-lookup.json");
  const contextPack = artifact("context-pack.json");
  const runtimeGates = artifact("runtime-gates.json");
  const modelRoutingPlan = artifact("model-routing-plan.json");
  const runGraph = artifact("run-graph.json");
  const factorySelection = artifact("factory-selection.json");
  const proofPlan = artifact("proof-plan.json");
  const proofStages = Array.isArray(proofPlan.stages) ? proofPlan.stages.filter(isRecord) : [];
  const graphEdges = Array.isArray(runGraph.edges) ? runGraph.edges.filter(isRecord) : [];
  const graphNodes = Array.isArray(runGraph.nodes) ? runGraph.nodes.filter(isRecord) : [];
  const modelRoutes = Array.isArray(modelRoutingPlan.routes) ? modelRoutingPlan.routes.filter(isRecord) : [];
  const lookupPlan = isRecord(report.contextPlan) && isRecord(report.contextPlan.lookupPlan) ? report.contextPlan.lookupPlan : {};
  const factoryReadiness = isRecord(factorySelection.factoryReadiness) ? factorySelection.factoryReadiness : {};
  const jsonBodyFree = jsonArtifacts.every((name) => {
    const parsed = parsedArtifacts[name];
    return parsed !== undefined && !hasForbiddenBodyKeys(parsed);
  });
  const checks = [
    { name: "required_artifacts_present", passed: artifactMetadata.every((item) => item.present === true), detail: { requiredArtifacts } },
    { name: "json_artifacts_parse", passed: artifactMetadata.filter((item) => item.name.endsWith(".json")).every((item) => !item.error), detail: { jsonArtifacts } },
    { name: "artifact_schemas", passed: specGate.schema === "zob.autonomous-spec-gate.v1" && contextScope.schema === "zob.context-scope.v1" && contextPack.schema === "zob.context-pack.v1" && runtimeGates.schema === "zob.autonomous-runtime-gates.v1" && modelRoutingPlan.schema === "zob.autonomous-model-routing-plan.v1" && runGraph.schema === "zob.autonomous-run-graph.v1" && factorySelection.schema === "zob.autonomous-factory-selection.v1" && proofPlan.schema === "zob.autonomous-proof-plan.v1" && report.schema === "zob.autonomous-runtime-dry-run.v1" && validation.schema === "zob.autonomous-runtime-dry-run-validation.v1", detail: "expected autonomous dry-run artifact schemas" },
    { name: "spec_gate_scope_locked", passed: specGate.specLocked === true && specGate.allowedPathsRequired === true && specGate.pathGatePassed === true && specGate.applyPolicyRequired === true && specGate.applyPolicyProvided === true && specGate.budgetProfileRequired === true && specGate.budgetProfileProvided === true && specGate.autonomousStrictBudgetRequired === true && specGate.autonomousStrictBudgetSatisfied === true && Array.isArray(specGate.allowedPaths) && specGate.allowedPaths.length > 0 && Array.isArray(specGate.forbiddenPaths) && specGate.forbiddenPaths.length > 0, detail: "autonomous spec lock requires safe bounded allowed_paths, forbidden_paths, explicit apply_policy, and explicit strict_requested budget_profile" },
    { name: "dry_run_safety_flags", passed: report.noExecution === true && report.childDispatchAllowed === false && report.daemonStarted === false && report.productionWritesPerformed === false && report.autoApply === false && report.networkAccessed === false && report.globalAutonomyReady === false && report.globalAutonomyNoShip === true, detail: "report safety posture" },
    { name: "validation_safety_flags", passed: validation.passed === true && validation.noExecution === true && validation.childDispatchAllowed === false && validation.networkAccessed === false && validation.globalAutonomyNoShip === true && validation.sentinel === "DRY_RUN_READY.sentinel", detail: "validation safety posture" },
    { name: "context_lookup_pack_cited_bounded", passed: contextLookups.length > 0 && contextLookups.every((lookup) => isRecord(lookup) && lookup.schema === "zob.brain-lookup-result.v1" && lookup.queryStored === false && lookup.citationRequired === true) && Array.isArray(contextPack.citations) && contextPack.citations.length > 0 && isRecord(contextPack.loadingRules) && contextPack.loadingRules.boundedContextOnly === true && contextPack.loadingRules.agentLoadsEntireCorpus === false, detail: { lookupCount: contextLookups.length, citationCount: Array.isArray(contextPack.citations) ? contextPack.citations.length : 0 } },
    { name: "gbrain_disabled", passed: lookupPlan.gbrainImportEnabled === false && lookupPlan.gbrainEmbedEnabled === false && lookupPlan.gbrainSyncEnabled === false && lookupPlan.gbrainWriteEnabled === false, detail: "P0 dry-run does not import/embed/sync/write GBrain" },
    { name: "runtime_gates_no_execution", passed: runtimeGates.passed === true && isRecord(runtimeGates.autonomousStrictBudgetGate) && runtimeGates.autonomousStrictBudgetGate.strictRequested === true && runtimeGates.autonomousStrictBudgetGate.strictEnabled === false && runtimeGates.autonomousStrictBudgetGate.budgetEnforced === false && runtimeGates.noExecution === true && runtimeGates.childDispatchAllowed === false && runtimeGates.globalBudgetEnforced === false && runtimeGates.globalModelRoutingEnabled === false && runtimeGates.daemonStarted === false && runtimeGates.productionWritesPerformed === false && runtimeGates.autoApply === false && runtimeGates.networkAccessed === false, detail: "runtime gates require strict budget intent while remaining disabled/proposal-only" },
    { name: "model_routing_plan_safe", passed: modelRoutingPlan.routingPlanReady === true && modelRoutingPlan.liveRoutingEnabled === false && modelRoutingPlan.globalLiveRoutingEnabled === false && modelRoutingPlan.modelRouterUsed === false && modelRoutingPlan.routingApplied === false && modelRoutingPlan.childDispatchAllowed === false && modelRoutingPlan.noExecution === true && modelRoutes.some((route) => route.stage === "context_reuse_scout" && route.recommendedModelClass === "cheap_scout") && modelRoutes.some((route) => route.oracleCritical === true && route.recommendedModelClass === "strong_oracle") && modelRoutes.every((route) => route.noExecution === true && route.modelRouterUsed === false && route.routingApplied === false && route.childDispatchAllowed === false), detail: { routeCount: modelRoutes.length, failedChecks: modelRoutingPlan.failedChecks } },
    { name: "run_graph_parent_owned_no_dispatch", passed: runGraph.status === "dry_run_graph_ready" && runGraph.parentOwned === true && runGraph.noExecution === true && runGraph.childDispatchAllowed === false && graphNodes.some((node) => node.id === "model_routing_plan") && graphNodes.some((node) => node.id === "registered_factory_current_source_proof") && graphEdges.length > 0 && graphEdges.every((edge) => edge.parentOwned === true && edge.dispatchAllowed === false), detail: { nodes: graphNodes.length, edges: graphEdges.length } },
    { name: "factory_selection_requires_current_source_proof", passed: factorySelection.currentSourceProofRequired === true && typeof factoryReadiness.registeredBatchReady === "boolean" && factorySelection.proofBeforeExecutionRequired === (factoryReadiness.registeredBatchReady !== true), detail: { selectedFactory: factorySelection.selectedFactory, registeredBatchReady: factoryReadiness.registeredBatchReady } },
    { name: "proof_plan_has_required_gates", passed: ["context_lookup_and_pack", "runtime_gates_preflight", "model_routing_plan", "registered_factory_current_source_proof", "smoke_oracle", "pilot_oracle", "batch"].every((name) => proofStages.some((stage) => stage.name === name)) && proofStages.every((stage) => stage.name === "spec_lock" || stage.dispatchAllowed === false || stage.dispatchAllowed === undefined), detail: { stages: proofStages.map((stage) => stage.name) } },
    { name: "json_artifacts_body_free", passed: jsonBodyFree, detail: "no forbidden plaintext body keys in JSON artifacts" },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  const result = {
    schema: "zob.autonomous-runtime-dry-run-artifact-validation.v1",
    runId: safeRunId,
    valid: failedChecks.length === 0,
    failedChecks,
    checks,
    artifacts: artifactMetadata,
    noExecution: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(result)) throw new Error("autonomous dry-run artifact validation would store forbidden plaintext body keys");
  return result;
}
export function validateAutonomousReadOnlySmokeRunArtifacts(repoRoot: string, runId: string): Record<string, unknown> {
  const safeRunId = safeFileStem(runId);
  const runDir = join(repoRoot, "reports", "autonomous-runs", safeRunId);
  const requiredArtifacts = ["spec-gate.json", "context-scope.json", "context-pack.json", "runtime-gates.json", "model-routing-plan.json", "model-routing-proof-plan.json", "factory-selection.json", "factory-run-ref.json", "oracle-review.json", "promotion-plan.json", "promotion-proof-plan.json", "scheduler-plan.json", "scheduler-proof-plan.json", "mission-control-plan.json", "mission-control-proof-plan.json", "sandbox-apply-plan.json", "strict-budget-proof-plan.json", "current-source-fingerprint.json", "final-e2e-proof-plan.json", "final-no-ship-oracle.json", "completion-gate.json", "validation.json", "final-report.md", "SMOKE_AUTONOMY_PASSED.sentinel"];
  const jsonArtifacts = requiredArtifacts.filter((name) => name.endsWith(".json"));
  const parsedArtifacts: Record<string, Record<string, unknown>> = {};
  const artifacts = requiredArtifacts.map((name) => {
    const artifactPath = join(runDir, name);
    const present = existsSync(artifactPath);
    if (!present) return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, bodyStored: false };
    if (!name.endsWith(".json")) return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, hash: artifactHashIfPresent(artifactPath), bodyStored: false };
    const read = readJsonArtifact(artifactPath);
    if (isRecord(read.parsed)) parsedArtifacts[name] = read.parsed;
    return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, hash: read.hash, schema: isRecord(read.parsed) ? read.parsed.schema : undefined, error: read.error, bodyStored: false };
  });
  const artifact = (name: string): Record<string, unknown> => parsedArtifacts[name] ?? {};
  const runtimeGates = artifact("runtime-gates.json");
  const modelRoutingPlan = artifact("model-routing-plan.json");
  const modelRoutingProofPlan = artifact("model-routing-proof-plan.json");
  const factorySelection = artifact("factory-selection.json");
  const factoryRunRef = artifact("factory-run-ref.json");
  const oracleReview = artifact("oracle-review.json");
  const promotionPlan = artifact("promotion-plan.json");
  const promotionProofPlan = artifact("promotion-proof-plan.json");
  const schedulerPlan = artifact("scheduler-plan.json");
  const schedulerProofPlan = artifact("scheduler-proof-plan.json");
  const missionControlPlan = artifact("mission-control-plan.json");
  const missionControlProofPlan = artifact("mission-control-proof-plan.json");
  const sandboxApplyPlan = artifact("sandbox-apply-plan.json");
  const strictBudgetProofPlan = artifact("strict-budget-proof-plan.json");
  const currentSourceFingerprint = artifact("current-source-fingerprint.json");
  const finalE2EProofPlan = artifact("final-e2e-proof-plan.json");
  const finalNoShipOracle = artifact("final-no-ship-oracle.json");
  const completionGate = artifact("completion-gate.json");
  const validation = artifact("validation.json");
  const currentSourceFingerprintFreshness = validateAutonomousCurrentSourceFingerprintFreshness(repoRoot, currentSourceFingerprint, factorySelection);
  const factoryRunId = typeof factoryRunRef.factoryRunId === "string" ? factoryRunRef.factoryRunId : "unknown";
  const factoryRunDir = join(repoRoot, "reports", "factory-runs", factoryRunId);
  const finalDoneSentinelPath = join(runDir, "DONE.sentinel");
  const globalReadySentinelPath = join(runDir, "GLOBAL_AUTONOMY_READY.sentinel");
  const finalDoneSentinelPresent = existsSync(finalDoneSentinelPath);
  const globalReadySentinelPresent = existsSync(globalReadySentinelPath);
  const checks = [
    { name: "required_artifacts_present", passed: artifacts.every((item) => item.present === true), detail: { requiredArtifacts } },
    { name: "json_artifacts_parse", passed: artifacts.filter((item) => item.name.endsWith(".json")).every((item) => !item.error), detail: { jsonArtifacts } },
    { name: "artifact_schemas", passed: factoryRunRef.schema === "zob.autonomous-readonly-smoke-factory-run-ref.v1" && oracleReview.schema === "zob.autonomous-readonly-smoke-oracle-review.v1" && promotionPlan.schema === "zob.autonomous-promotion-plan.v1" && promotionProofPlan.schema === "zob.autonomous-promotion-proof-plan.v1" && schedulerPlan.schema === "zob.autonomous-scheduler-plan.v1" && schedulerProofPlan.schema === "zob.autonomous-scheduler-proof-plan.v1" && missionControlPlan.schema === "zob.autonomous-mission-control-plan.v1" && missionControlProofPlan.schema === "zob.autonomous-mission-control-proof-plan.v1" && sandboxApplyPlan.schema === "zob.autonomous-sandbox-apply-plan.v1" && strictBudgetProofPlan.schema === "zob.autonomous-strict-budget-proof-plan.v1" && modelRoutingProofPlan.schema === "zob.autonomous-model-routing-proof-plan.v1" && currentSourceFingerprint.schema === "zob.autonomous-current-source-fingerprint.v1" && finalE2EProofPlan.schema === "zob.autonomous-final-e2e-proof-plan.v1" && finalNoShipOracle.schema === "zob.autonomous-final-no-ship-oracle.v1" && completionGate.schema === "zob.autonomous-completion-gate.v1" && validation.schema === "zob.autonomous-readonly-smoke-validation.v1", detail: "expected Phase 4A/5B/6B/7B/8B/9A/9B/10B/11F smoke artifact schemas" },
    { name: "runtime_and_model_gates_safe", passed: runtimeGates.childDispatchAllowed === false && runtimeGates.daemonStarted === false && runtimeGates.productionWritesPerformed === false && runtimeGates.autoApply === false && modelRoutingPlan.liveRoutingEnabled === false && modelRoutingPlan.globalLiveRoutingEnabled === false && modelRoutingPlan.childDispatchAllowed === false, detail: "runtime/model routing gates remain disabled" },
    { name: "model_routing_proof_plan_gate_only", passed: modelRoutingProofPlan.status === "model_routing_dispatch_gate_proof_ready_global_default_blocked" && modelRoutingProofPlan.modelRoutingProofReady === true && modelRoutingProofPlan.routingDefaultDisabledProofPassed === true && modelRoutingProofPlan.routingOracleProofPassed === true && modelRoutingProofPlan.routingHighContextProofPassed === true && modelRoutingProofPlan.routingSecurityNoDowngradeProofPassed === true && modelRoutingProofPlan.selectedModelsStored === false && modelRoutingProofPlan.selectedModelHashesOnly === true && modelRoutingProofPlan.finalE2ERequirementCleared === false && modelRoutingProofPlan.no_ship === true && Array.isArray(modelRoutingProofPlan.scenarios) && modelRoutingProofPlan.scenarios.some((scenario) => isRecord(scenario) && scenario.name === "routing_oracle_applies_when_enabled" && scenario.selectedModelClass === "strong_oracle" && typeof scenario.selectedModelHash === "string" && scenario.selectedModelStored === false) && modelRoutingProofPlan.globalLiveRoutingEnabled === false && modelRoutingProofPlan.liveAutonomousRoutingApplied === false && modelRoutingProofPlan.modelRouterUsed === false && modelRoutingProofPlan.routingApplied === false && modelRoutingProofPlan.childDispatchAllowed === false && modelRoutingProofPlan.noExecution === true && modelRoutingProofPlan.globalAutonomyReady === false && modelRoutingProofPlan.globalAutonomyNoShip === true, detail: "Phase 6B proves model routing dispatch gate class selection without enabling global/live routing" },
    { name: "factory_selection_existing", passed: factorySelection.selectionStatus === "existing_factory_selected" && typeof factorySelection.selectedFactory === "string", detail: { selectedFactory: factorySelection.selectedFactory } },
    { name: "factory_smoke_completed", passed: factoryRunRef.status === "done" && factoryRunRef.execution === "deterministic" && factoryRunRef.phaseSentinelPresent === true && factoryRunRef.doneSentinelPresent === true && existsSync(join(factoryRunDir, "SMOKE_PASSED.sentinel")) && existsSync(join(factoryRunDir, "DONE.sentinel")), detail: { factoryRunId } },
    { name: "structural_oracle_passed", passed: oracleReview.verdict === "PASS" && oracleReview.no_ship === false && oracleReview.liveOracleDispatched === false, detail: { oracleType: oracleReview.oracleType } },
    { name: "promotion_plan_smoke_to_pilot_gate", passed: isRecord(promotionPlan.smokeGate) && promotionPlan.smokeGate.passed === true && isRecord(promotionPlan.pilotGate) && promotionPlan.pilotGate.preconditionsMet === true && promotionPlan.pilotGate.executionAllowed === false && promotionPlan.pilotGate.dispatchAllowed === false && isRecord(promotionPlan.batchGate) && promotionPlan.batchGate.preconditionsMet === false && promotionPlan.batchGate.batchConcurrencyCapRequired === true && promotionPlan.globalAutonomyNoShip === true, detail: "Phase 7A promotion gates are metadata-only and do not execute pilot/batch" },
    { name: "promotion_proof_plan_execution_blocked", passed: promotionProofPlan.status === "pilot_batch_promotion_proof_ready_execution_blocked" && promotionProofPlan.promotionProofReady === true && promotionProofPlan.smokeToPilotPreconditionsProved === true && promotionProofPlan.pilotExecutionBlockedProofPassed === true && promotionProofPlan.batchExecutionBlockedProofPassed === true && promotionProofPlan.resumeRetryPolicyProofPassed === true && promotionProofPlan.oraclePolicyProofPassed === true && promotionProofPlan.finalE2ERequirementCleared === false && promotionProofPlan.no_ship === true && promotionProofPlan.pilotExecutionAllowed === false && promotionProofPlan.batchExecutionAllowed === false && promotionProofPlan.pilotExecuted === false && promotionProofPlan.batchExecuted === false && promotionProofPlan.childDispatchAllowed === false && promotionProofPlan.noExecutionBeyondSmoke === true && promotionProofPlan.globalAutonomyReady === false && promotionProofPlan.globalAutonomyNoShip === true, detail: "Phase 7B proves pilot/batch promotion prerequisites and blocked execution without running pilot/batch" },
    { name: "scheduler_plan_disabled_bounded", passed: schedulerPlan.schedulerPlanReady === true && schedulerPlan.schedulerExecutionAllowed === false && schedulerPlan.daemonStarted === false && schedulerPlan.autoStartDaemon === false && schedulerPlan.continuousLoop === false && schedulerPlan.childDispatchAllowed === false && isRecord(schedulerPlan.killSwitch) && schedulerPlan.killSwitch.required === true && isRecord(schedulerPlan.workerPool) && schedulerPlan.workerPool.maxWorkers === 1 && isRecord(schedulerPlan.retryPolicy) && schedulerPlan.retryPolicy.retriesCapped === true && isRecord(schedulerPlan.budgetPolicy) && schedulerPlan.budgetPolicy.strictBudgetRequired === true && schedulerPlan.globalAutonomyNoShip === true, detail: "Phase 8A scheduler plan is bounded and disabled by default" },
    { name: "scheduler_proof_plan_execution_blocked", passed: schedulerProofPlan.status === "scheduler_daemon_proof_ready_execution_blocked" && schedulerProofPlan.schedulerProofReady === true && schedulerProofPlan.daemonDefaultDisabledProofPassed === true && schedulerProofPlan.oneWorkerBoundedProofPassed === true && schedulerProofPlan.stopConditionsProofPassed === true && schedulerProofPlan.killSwitchRetryProofPassed === true && schedulerProofPlan.strictBudgetBeforeDispatchProofPassed === true && schedulerProofPlan.alwaysOnApprovalProofPassed === true && schedulerProofPlan.finalE2ERequirementCleared === false && schedulerProofPlan.no_ship === true && schedulerProofPlan.schedulerExecutionAllowed === false && schedulerProofPlan.daemonStarted === false && schedulerProofPlan.autoStartDaemon === false && schedulerProofPlan.continuousLoop === false && schedulerProofPlan.childDispatchAllowed === false && schedulerProofPlan.productionWritesPerformed === false && schedulerProofPlan.autoApply === false && schedulerProofPlan.noExecutionBeyondSmoke === true && schedulerProofPlan.globalAutonomyReady === false && schedulerProofPlan.globalAutonomyNoShip === true, detail: "Phase 8B proves daemon/scheduler policy and blocked execution without starting daemon" },
    { name: "mission_control_plan_proposal_only", passed: missionControlPlan.missionControlPlanReady === true && missionControlPlan.transportDispatch === false && missionControlPlan.networkComsEnabled === false && missionControlPlan.directWorkerWrites === false && missionControlPlan.childDispatchAllowed === false && isRecord(missionControlPlan.commandPolicy) && missionControlPlan.commandPolicy.proposalOnly === true && missionControlPlan.commandPolicy.directWorkerWrites === false && missionControlPlan.commandPolicy.directWorkerCommandBlocked === true && isRecord(missionControlPlan.comsPolicy) && missionControlPlan.comsPolicy.topologyGuardActive === true && missionControlPlan.comsPolicy.hashOnlyLedgers === true && missionControlPlan.globalAutonomyNoShip === true, detail: "Phase 9A Mission Control/coms plan is proposal-only and transport-disabled" },
    { name: "mission_control_proof_plan_execution_blocked", passed: missionControlProofPlan.status === "mission_control_comms_proof_ready_execution_blocked" && missionControlProofPlan.missionControlProofReady === true && missionControlProofPlan.proposalOnlyCommandsProofPassed === true && missionControlProofPlan.topologyHashOnlyCommsProofPassed === true && missionControlProofPlan.directWorkerCommandsBlockedProofPassed === true && missionControlProofPlan.liveTransportNetworkDisabledProofPassed === true && missionControlProofPlan.liveGlobalRoutingApprovalProofPassed === true && missionControlProofPlan.post8bSchedulerBlockedProofPassed === true && missionControlProofPlan.finalE2ERequirementCleared === false && missionControlProofPlan.no_ship === true && missionControlProofPlan.childDispatchAllowed === false && missionControlProofPlan.daemonStarted === false && missionControlProofPlan.directWorkerWrites === false && missionControlProofPlan.transportDispatch === false && missionControlProofPlan.networkComsEnabled === false && missionControlProofPlan.liveRoutingEnabled === false && missionControlProofPlan.globalLiveRoutingEnabled === false && missionControlProofPlan.productionWritesPerformed === false && missionControlProofPlan.autoApply === false && missionControlProofPlan.globalAutonomyReady === false && missionControlProofPlan.globalAutonomyNoShip === true, detail: "Phase 9B proves proposal-only commands, topology/hash-only comms, blocked direct-worker commands, disabled transport/network, and approval-required live/global routing" },
    { name: "sandbox_apply_plan_metadata_only", passed: sandboxApplyPlan.sandboxApplyPlanReady === true && sandboxApplyPlan.productionWritesPerformed === false && sandboxApplyPlan.autoApply === false && sandboxApplyPlan.realApplyExecuted === false && sandboxApplyPlan.childDispatchAllowed === false && sandboxApplyPlan.globalAutonomyNoShip === true && isRecord(sandboxApplyPlan.isolatedTempWorkspace) && sandboxApplyPlan.isolatedTempWorkspace.required === true && sandboxApplyPlan.isolatedTempWorkspace.executed === true && isRecord(sandboxApplyPlan.diffGate) && sandboxApplyPlan.diffGate.diffHashRequired === true && sandboxApplyPlan.diffGate.diffHashesMatch === true && isRecord(sandboxApplyPlan.oracleDiffReview) && sandboxApplyPlan.oracleDiffReview.required === true && sandboxApplyPlan.oracleDiffReview.reviewPassed === true && isRecord(sandboxApplyPlan.rollbackPolicy) && sandboxApplyPlan.rollbackPolicy.rollbackMetadataRequired === true && sandboxApplyPlan.rollbackPolicy.rollbackPrepared === true && isRecord(sandboxApplyPlan.approvalPolicy) && sandboxApplyPlan.approvalPolicy.manualApprovalRequired === true && sandboxApplyPlan.approvalPolicy.approvedForMainWorkspaceApply === false && isRecord(sandboxApplyPlan.manualApplyPreflight) && sandboxApplyPlan.manualApplyPreflight.required === true && sandboxApplyPlan.manualApplyPreflight.preflightPassed === true && sandboxApplyPlan.manualApplyPreflight.executionAllowedByThisTool === false && sandboxApplyPlan.manualApplyPreflight.realApplyExecuted === false && isRecord(sandboxApplyPlan.mainWorkspaceApply) && sandboxApplyPlan.mainWorkspaceApply.realApplyAllowed === false && sandboxApplyPlan.mainWorkspaceApply.realApplyExecuted === false && sandboxApplyPlan.mainWorkspaceApply.productionWritesPerformed === false, detail: "Phase 10B sandbox/apply plan requires temp workspace, diff hash, oracle review, rollback, manual approval, and manual apply preflight while blocking real apply" },
    { name: "strict_budget_proof_plan_gate_only", passed: strictBudgetProofPlan.status === "strict_budget_dispatch_gate_proof_ready_global_default_blocked" && strictBudgetProofPlan.strictBudgetProofReady === true && strictBudgetProofPlan.strictBudgetAllowProofPassed === true && strictBudgetProofPlan.strictBudgetBlockProofPassed === true && strictBudgetProofPlan.strictBudgetDefaultDisabledProofPassed === true && strictBudgetProofPlan.finalE2ERequirementCleared === false && strictBudgetProofPlan.no_ship === true && Array.isArray(strictBudgetProofPlan.scenarios) && strictBudgetProofPlan.scenarios.some((scenario) => isRecord(scenario) && scenario.name === "strict_gate_blocks_exceedance_pre_dispatch" && scenario.wouldBlockDispatch === true && scenario.gateChildDispatchAllowed === false && scenario.dispatchDecision === "block") && strictBudgetProofPlan.globalStrictBudgetEnabled === false && strictBudgetProofPlan.globalBudgetEnforced === false && strictBudgetProofPlan.liveAutonomousBudgetEnforced === false && strictBudgetProofPlan.budgetEnforced === false && strictBudgetProofPlan.strictEnabled === false && strictBudgetProofPlan.childDispatchAllowed === false && strictBudgetProofPlan.noExecution === true && strictBudgetProofPlan.globalAutonomyReady === false && strictBudgetProofPlan.globalAutonomyNoShip === true, detail: "Phase 5B proves strict dispatch gate allow/block/default-disabled behavior without clearing final live strict-budget requirement" },
    { name: "current_source_fingerprint_hash_only", passed: currentSourceFingerprint.status === "current_source_fingerprint_captured" && currentSourceFingerprint.currentSourceFingerprintReady === true && currentSourceFingerprint.currentSourceFingerprintCaptured === true && currentSourceFingerprint.noMockCurrentSourceE2EProved === false && typeof currentSourceFingerprint.fingerprintHash === "string" && /^[a-f0-9]{64}$/.test(currentSourceFingerprint.fingerprintHash) && Array.isArray(currentSourceFingerprint.sourceFiles) && currentSourceFingerprint.sourceFiles.length > 0 && isRecord(currentSourceFingerprint.fileHashes) && Object.values(currentSourceFingerprint.fileHashes).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) && Array.isArray(currentSourceFingerprint.missingFiles) && currentSourceFingerprint.missingFiles.length === 0 && isRecord(currentSourceFingerprint.evidencePolicy) && currentSourceFingerprint.evidencePolicy.hashOnly === true && currentSourceFingerprint.evidencePolicy.sourceBodiesStored === false && isRecord(currentSourceFingerprint.safety) && currentSourceFingerprint.safety.noExecution === true && currentSourceFingerprint.safety.globalAutonomyNoShip === true, detail: "Phase 11C current-source fingerprint captures hash-only source evidence without proving final no-mock E2E" },
    { name: "current_source_fingerprint_fresh", passed: currentSourceFingerprintFreshness.fresh === true && currentSourceFingerprintFreshness.fileHashesMatch === true && currentSourceFingerprintFreshness.fingerprintHashMatches === true && currentSourceFingerprintFreshness.sourceFilesMatch === true && currentSourceFingerprintFreshness.missingFilesMatch === true && currentSourceFingerprintFreshness.currentMissingFiles && Array.isArray(currentSourceFingerprintFreshness.currentMissingFiles) && currentSourceFingerprintFreshness.currentMissingFiles.length === 0, detail: "Phase 11D validator recomputes current source hashes and fails stale/tampered fingerprints" },
    { name: "final_e2e_proof_plan_no_ship", passed: finalE2EProofPlan.status === "blocked_for_final_e2e_proof" && finalE2EProofPlan.finalE2EProofReady === false && finalE2EProofPlan.no_ship === true && Array.isArray(finalE2EProofPlan.blockers) && finalE2EProofPlan.blockers.includes("live_strict_budget_not_enforced") && finalE2EProofPlan.blockers.includes("live_model_routing_not_enabled") && finalE2EProofPlan.blockers.includes("pilot_execution_disabled") && finalE2EProofPlan.blockers.includes("batch_execution_disabled") && finalE2EProofPlan.blockers.includes("final_oracle_missing") && isRecord(finalE2EProofPlan.sentinelPolicy) && finalE2EProofPlan.sentinelPolicy.globalReadySentinelAllowed === false && finalE2EProofPlan.sentinelPolicy.globalReadySentinelPresent === false && isRecord(finalE2EProofPlan.currentSourceProof) && finalE2EProofPlan.currentSourceProof.currentSourceFingerprintCaptured === true && typeof finalE2EProofPlan.currentSourceProof.currentSourceFingerprintHash === "string" && finalE2EProofPlan.currentSourceProof.noMockCurrentSourceE2EProved === false && finalE2EProofPlan.globalAutonomyReady === false && finalE2EProofPlan.globalAutonomyNoShip === true && finalE2EProofPlan.childDispatchAllowed === false && finalE2EProofPlan.productionWritesPerformed === false && finalE2EProofPlan.autoApply === false, detail: "Phase 11C final E2E proof plan references current-source fingerprint while preserving no-ship" },
    { name: "final_no_ship_oracle_blocks_global_autonomy", passed: finalNoShipOracle.verdict === "FAIL" && finalNoShipOracle.no_ship === true && finalNoShipOracle.finalOracleReady === false && finalNoShipOracle.finalOraclePass === false && Array.isArray(finalNoShipOracle.failedChecks) && finalNoShipOracle.failedChecks.includes("final_e2e_proof_ready") && finalNoShipOracle.failedChecks.includes("no_mock_current_source_e2e_proved") && isRecord(finalNoShipOracle.decision) && finalNoShipOracle.decision.globalAutonomyReady === false && finalNoShipOracle.decision.globalAutonomyNoShip === true && finalNoShipOracle.decision.writeGlobalReadySentinelAllowed === false && finalNoShipOracle.globalAutonomyReady === false && finalNoShipOracle.globalAutonomyNoShip === true && finalNoShipOracle.childDispatchAllowed === false && finalNoShipOracle.productionWritesPerformed === false && finalNoShipOracle.autoApply === false, detail: "Phase 11E deterministic final no-ship oracle blocks global autonomy until final E2E proof" },
    { name: "completion_gate_blocks_goal_completion", passed: completionGate.status === "blocked_for_goal_completion" && completionGate.completionReady === false && completionGate.allRequirementsVerified === false && completionGate.no_ship === true && completionGate.updateGoalAllowed === false && completionGate.requiredGoalStatus === "in_progress" && Array.isArray(completionGate.failedChecks) && completionGate.failedChecks.includes("final_e2e_proof_ready") && isRecord(completionGate.decision) && completionGate.decision.updateGoalStatusCompleteAllowed === false && completionGate.decision.globalAutonomyReady === false && completionGate.decision.globalAutonomyNoShip === true && completionGate.decision.writeGlobalReadySentinelAllowed === false && completionGate.globalAutonomyReady === false && completionGate.globalAutonomyNoShip === true && completionGate.childDispatchAllowed === false && completionGate.productionWritesPerformed === false && completionGate.autoApply === false, detail: "Phase 11F completion gate blocks update_goal complete until every final requirement is verified" },
    { name: "final_global_sentinels_absent", passed: finalDoneSentinelPresent === false && globalReadySentinelPresent === false, detail: { doneSentinelPresent: finalDoneSentinelPresent, globalReadySentinelPresent } },
    { name: "validation_passed_scope_limited", passed: validation.passed === true && validation.status === "smoke_autonomy_passed" && validation.no_ship === false && validation.globalAutonomyReady === false && validation.globalAutonomyNoShip === true && validation.childDispatchAllowed === false && validation.productionWritesPerformed === false && validation.autoApply === false, detail: "run-scoped smoke pass without global autonomy" },
    { name: "json_artifacts_body_free", passed: jsonArtifacts.every((name) => isRecord(parsedArtifacts[name]) && !hasForbiddenBodyKeys(parsedArtifacts[name])), detail: "no forbidden plaintext body keys" },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const result = {
    schema: "zob.autonomous-readonly-smoke-artifact-validation.v1",
    runId: safeRunId,
    valid: failedChecks.length === 0,
    failedChecks,
    checks,
    artifacts,
    finalGlobalSentinels: {
      doneSentinelPresent: finalDoneSentinelPresent,
      globalReadySentinelPresent,
      doneSentinelAllowed: false,
      globalReadySentinelAllowed: false,
    },
    currentSourceFingerprintFreshness,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    childDispatchAllowed: false,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    liveRoutingEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(result)) throw new Error("autonomous readonly smoke validation would store forbidden plaintext body keys");
  return result;
}
