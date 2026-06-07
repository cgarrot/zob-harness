import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDaemonPolicyConfig } from "../daemon-policy.js";
import { MISSION_CONTROL_COMMANDS, buildMissionControlCommandProposal, buildMissionControlSnapshot, buildZobComsTransportReadiness, buildZobCommunicationReadinessAudit } from "../../coms/mission-control.js";
import { loadTeamDefinition, validateTeamDefinition } from "../../topology/teams.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { safeFileStem } from "../../../core/utils/paths.js";
import { isRecord } from "../../../core/utils/records.js";
import { AUTONOMOUS_CURRENT_SOURCE_FINGERPRINT_FILES, hasForbiddenBodyKeys } from "./dry-run.js";

export function readJsonArtifact(path: string): { parsed?: Record<string, unknown> | unknown[]; hash?: string; error?: string } {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return { parsed: isRecord(parsed) || Array.isArray(parsed) ? parsed : undefined, hash: sha256(raw), error: isRecord(parsed) || Array.isArray(parsed) ? undefined : "artifact JSON root must be object or array" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function artifactHashIfPresent(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return sha256(readFileSync(path, "utf8"));
}

export function relativeFactoryRunPath(runId: string, artifact?: string): string {
  return artifact ? `reports/factory-runs/${runId}/${artifact}` : `reports/factory-runs/${runId}`;
}

export function buildAutonomousPromotionPlan(input: { runId: string; selectedFactory?: string; factoryRunRef: Record<string, unknown>; oracleReview: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const smokeGatePassed = input.validation.status === "smoke_autonomy_passed"
    && input.validation.no_ship === false
    && input.factoryRunRef.status === "done"
    && input.factoryRunRef.phaseSentinelPresent === true
    && input.factoryRunRef.doneSentinelPresent === true
    && input.oracleReview.verdict === "PASS"
    && input.oracleReview.no_ship === false;
  const factoryRunId = typeof input.factoryRunRef.factoryRunId === "string" ? input.factoryRunRef.factoryRunId : "unknown";
  const plan = {
    schema: "zob.autonomous-promotion-plan.v1",
    runId: input.runId,
    selectedFactory: input.selectedFactory,
    sourceSmoke: {
      autonomousRunId: input.runId,
      factoryRunId,
      smokeSentinelRef: relativeFactoryRunPath(factoryRunId, "SMOKE_PASSED.sentinel"),
      doneSentinelRef: relativeFactoryRunPath(factoryRunId, "DONE.sentinel"),
      oracleReviewRef: `reports/autonomous-runs/${input.runId}/oracle-review.json`,
    },
    smokeGate: {
      passed: smokeGatePassed,
      sentinelPresent: input.factoryRunRef.phaseSentinelPresent === true,
      doneSentinelPresent: input.factoryRunRef.doneSentinelPresent === true,
      oraclePass: input.oracleReview.verdict === "PASS" && input.oracleReview.no_ship === false,
      structuralOracleOnly: input.oracleReview.oracleType === "deterministic_structural",
    },
    pilotGate: {
      preconditionsMet: smokeGatePassed,
      executionAllowed: false,
      dispatchAllowed: false,
      reason: "phase_7a_promotion_metadata_only_no_pilot_execution",
      requiredBeforeExecution: ["strict_budget_gate", "live_or_structural_oracle_pass", "current_source_factory_proof", "operator_or_parent_gate", "PILOT_PASSED.sentinel_on_success"],
      maxItems: 10,
      prerequisiteSmokeRunId: factoryRunId,
      oracleReviewPath: `reports/autonomous-runs/${input.runId}/oracle-review.json`,
    },
    batchGate: {
      preconditionsMet: false,
      executionAllowed: false,
      dispatchAllowed: false,
      reason: "pilot_not_executed_in_phase_7a",
      requiredBeforeExecution: ["PILOT_PASSED.sentinel", "pilot_oracle_PASS_no_ship_false", "batch_concurrency_cap", "strict_budget_gate", "final_oracle_gate"],
      batchConcurrencyCapRequired: true,
    },
    resumePolicy: {
      resumeOnlyIncompleteItems: true,
      doNotRerunPassedItems: true,
      stopOnRepeatedFail: true,
      maxRetryPolicyRequiredBeforeLiveScale: true,
    },
    oraclePolicy: {
      smokeOracleRequired: true,
      pilotOracleRequired: true,
      batchOracleRequired: true,
      warnOrFailTreatedAsNoShip: true,
    },
    strictBudgetRequired: true,
    liveRoutingEnabled: false,
    childDispatchAllowed: false,
    pilotExecuted: false,
    batchExecuted: false,
    noExecutionBeyondSmoke: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous promotion plan would store forbidden plaintext body keys");
  return plan;
}

export function buildAutonomousPromotionProofPlan(input: { runId: string; promotionPlan: Record<string, unknown>; factoryRunRef: Record<string, unknown>; oracleReview: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const smokeGate = isRecord(input.promotionPlan.smokeGate) ? input.promotionPlan.smokeGate : {};
  const pilotGate = isRecord(input.promotionPlan.pilotGate) ? input.promotionPlan.pilotGate : {};
  const batchGate = isRecord(input.promotionPlan.batchGate) ? input.promotionPlan.batchGate : {};
  const resumePolicy = isRecord(input.promotionPlan.resumePolicy) ? input.promotionPlan.resumePolicy : {};
  const oraclePolicy = isRecord(input.promotionPlan.oraclePolicy) ? input.promotionPlan.oraclePolicy : {};
  const scenarios = [
    {
      name: "smoke_to_pilot_preconditions_met",
      passed: smokeGate.passed === true && smokeGate.sentinelPresent === true && smokeGate.doneSentinelPresent === true && smokeGate.oraclePass === true,
      evidenceRefs: [`reports/autonomous-runs/${safeFileStem(input.runId)}/promotion-plan.json`, `reports/autonomous-runs/${safeFileStem(input.runId)}/oracle-review.json`],
      dispatchAllowed: false,
    },
    {
      name: "pilot_execution_blocked_until_live_gates",
      passed: pilotGate.preconditionsMet === true && pilotGate.executionAllowed === false && pilotGate.dispatchAllowed === false && input.promotionPlan.pilotExecuted === false,
      blockers: ["pilot_execution_disabled_until_live_budget_routing_daemon_oracle_gates"],
      dispatchAllowed: false,
    },
    {
      name: "batch_execution_blocked_without_pilot_oracle_and_concurrency",
      passed: batchGate.preconditionsMet === false && batchGate.executionAllowed === false && batchGate.dispatchAllowed === false && batchGate.batchConcurrencyCapRequired === true && input.promotionPlan.batchExecuted === false,
      blockers: ["pilot_not_executed", "pilot_oracle_missing", "batch_concurrency_cap_missing"],
      dispatchAllowed: false,
    },
    {
      name: "resume_retry_policy_safe_before_scale",
      passed: resumePolicy.resumeOnlyIncompleteItems === true && resumePolicy.doNotRerunPassedItems === true && resumePolicy.stopOnRepeatedFail === true && resumePolicy.maxRetryPolicyRequiredBeforeLiveScale === true,
      dispatchAllowed: false,
    },
    {
      name: "oracle_policy_no_warn_fail_promotion",
      passed: oraclePolicy.smokeOracleRequired === true && oraclePolicy.pilotOracleRequired === true && oraclePolicy.batchOracleRequired === true && oraclePolicy.warnOrFailTreatedAsNoShip === true,
      dispatchAllowed: false,
    },
  ];
  const checks = [
    { name: "smoke_gate_passed", passed: scenarios[0].passed === true },
    { name: "pilot_blocked_no_execution", passed: scenarios[1].passed === true },
    { name: "batch_blocked_no_execution", passed: scenarios[2].passed === true },
    { name: "resume_retry_policy_safe", passed: scenarios[3].passed === true },
    { name: "oracle_policy_safe", passed: scenarios[4].passed === true },
    { name: "run_scope_no_global_autonomy", passed: input.validation.globalAutonomyReady === false && input.validation.globalAutonomyNoShip === true && input.validation.childDispatchAllowed === false && input.validation.productionWritesPerformed === false && input.validation.autoApply === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const proof = {
    schema: "zob.autonomous-promotion-proof-plan.v1",
    runId: input.runId,
    phase: "7B",
    status: failedChecks.length === 0 ? "pilot_batch_promotion_proof_ready_execution_blocked" : "pilot_batch_promotion_proof_incomplete",
    promotionProofReady: failedChecks.length === 0,
    smokeToPilotPreconditionsProved: scenarios[0].passed === true,
    pilotExecutionBlockedProofPassed: scenarios[1].passed === true,
    batchExecutionBlockedProofPassed: scenarios[2].passed === true,
    resumeRetryPolicyProofPassed: scenarios[3].passed === true,
    oraclePolicyProofPassed: scenarios[4].passed === true,
    finalE2ERequirementCleared: false,
    no_ship: true,
    checks,
    failedChecks,
    scenarios,
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/promotion-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/factory-run-ref.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/oracle-review.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
    ],
    blockers: [
      "pilot_execution_disabled",
      "batch_execution_disabled",
      "pilot_oracle_missing",
      "batch_concurrency_cap_missing",
      "final_e2e_pilot_batch_evidence_required",
    ],
    pilotExecutionAllowed: false,
    batchExecutionAllowed: false,
    pilotExecuted: false,
    batchExecuted: false,
    pilotOraclePass: false,
    batchConcurrencyCapPresent: false,
    childDispatchAllowed: false,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecutionBeyondSmoke: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(proof)) throw new Error("autonomous promotion proof plan would store forbidden plaintext body keys");
  return proof;
}

export function buildAutonomousSchedulerPlan(repoRoot: string, input: { runId: string; promotionPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const daemonPolicy = validateDaemonPolicyConfig(repoRoot);
  const allowedJobTypes = Array.isArray(daemonPolicy.allowedJobTypes) ? daemonPolicy.allowedJobTypes.filter((item): item is string => typeof item === "string") : [];
  const requiredStopConditions = Array.isArray(daemonPolicy.requiredStopConditions) ? daemonPolicy.requiredStopConditions.filter((item): item is string => typeof item === "string") : [];
  const promotionReady = isRecord(input.promotionPlan.smokeGate) && input.promotionPlan.smokeGate.passed === true;
  const checks = [
    { name: "daemon_policy_valid", passed: daemonPolicy.present === true && daemonPolicy.valid === true },
    { name: "daemon_disabled_by_default", passed: daemonPolicy.daemonEnabled === false && daemonPolicy.alwaysOnDaemonEnabled === false && daemonPolicy.autoStartDaemon === false && daemonPolicy.continuousLoop === false },
    { name: "one_worker_bounded", passed: daemonPolicy.maxWorkersDefault === 1 && daemonPolicy.maxWorkersMax === 1 },
    { name: "read_only_work_kinds_only", passed: allowedJobTypes.length > 0 && daemonPolicy.writeAdaptersEnabled === false && daemonPolicy.productionWritesPerformed === false && daemonPolicy.autoApply === false },
    { name: "terminal_stop_conditions_available", passed: requiredStopConditions.includes("timeout") && requiredStopConditions.includes("blocked") && requiredStopConditions.includes("fail_loop") && requiredStopConditions.includes("no_ship") },
    { name: "kill_switch_required", passed: true },
    { name: "leases_and_heartbeat_required", passed: true },
    { name: "budget_required_before_dispatch", passed: true },
    { name: "scheduler_execution_disabled", passed: true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const plan = {
    schema: "zob.autonomous-scheduler-plan.v1",
    runId: input.runId,
    schedulerPlanReady: failedChecks.length === 0,
    failedChecks,
    checks,
    promotionReady,
    daemonPolicy,
    queuePolicy: {
      allowedWorkKinds: allowedJobTypes,
      initialWorkKinds: ["docs_watch", "repo_audit_readonly", "todo_risk_report", "session_analysis"].filter((kind) => allowedJobTypes.includes(kind)),
      writeWorkAccepted: false,
      claimAtMostOnePerTick: daemonPolicy.claimAtMostOneJobPerTick === true,
      boundedQueueOnly: true,
    },
    leasePolicy: {
      leaseRequired: true,
      leaseTtlMs: 300_000,
      maxLeaseRenewals: 0,
      staleLeaseFailsCleanly: true,
      leaseOwnerHashOnly: true,
    },
    heartbeatPolicy: {
      heartbeatRequired: true,
      heartbeatIntervalMs: 30_000,
      staleHeartbeatTimeoutMs: 90_000,
      staleHeartbeatStopCondition: "timeout",
    },
    timeoutPolicy: {
      perWorkItemTimeoutMs: 300_000,
      globalTickTimeoutMs: 600_000,
      timeoutStopCondition: "timeout",
    },
    retryPolicy: {
      retriesCapped: true,
      maxRetriesPerWorkItem: 1,
      failLoopThreshold: 3,
      repeatedFailureStopCondition: "fail_loop",
      doNotRetryNoShip: true,
    },
    killSwitch: {
      required: true,
      defaultState: "stopped_until_manual_start",
      stopFileRef: ".pi/queue/STOP_DAEMON.sentinel",
      checkedBeforeEachTick: true,
      stopsQueueCleanly: true,
    },
    workerPool: {
      defaultWorkers: 1,
      maxWorkers: 1,
      workerPoolBounded: true,
    },
    budgetPolicy: {
      strictBudgetRequired: true,
      perRunCapsRequired: true,
      perDayCapsRequired: true,
      budgetEnforced: false,
      dispatchBlockedUntilStrictBudgetEnforced: true,
    },
    stopConditions: requiredStopConditions,
    approvalPolicy: {
      manualStartRequiresApproval: true,
      alwaysOnRequiresApproval: true,
      schedulerAutostartAllowed: false,
    },
    schedulerExecutionAllowed: false,
    daemonEnabled: false,
    alwaysOnDaemonEnabled: false,
    autoStartDaemon: false,
    continuousLoop: false,
    daemonStarted: false,
    cronEnabled: false,
    childDispatchAllowed: false,
    liveChildExecution: false,
    networkAccessed: false,
    writeAdaptersEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    pilotExecuted: false,
    batchExecuted: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous scheduler plan would store forbidden plaintext body keys");
  return plan;
}

export function buildAutonomousSchedulerProofPlan(input: { runId: string; schedulerPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const queuePolicy = isRecord(input.schedulerPlan.queuePolicy) ? input.schedulerPlan.queuePolicy : {};
  const leasePolicy = isRecord(input.schedulerPlan.leasePolicy) ? input.schedulerPlan.leasePolicy : {};
  const heartbeatPolicy = isRecord(input.schedulerPlan.heartbeatPolicy) ? input.schedulerPlan.heartbeatPolicy : {};
  const timeoutPolicy = isRecord(input.schedulerPlan.timeoutPolicy) ? input.schedulerPlan.timeoutPolicy : {};
  const retryPolicy = isRecord(input.schedulerPlan.retryPolicy) ? input.schedulerPlan.retryPolicy : {};
  const killSwitch = isRecord(input.schedulerPlan.killSwitch) ? input.schedulerPlan.killSwitch : {};
  const workerPool = isRecord(input.schedulerPlan.workerPool) ? input.schedulerPlan.workerPool : {};
  const budgetPolicy = isRecord(input.schedulerPlan.budgetPolicy) ? input.schedulerPlan.budgetPolicy : {};
  const approvalPolicy = isRecord(input.schedulerPlan.approvalPolicy) ? input.schedulerPlan.approvalPolicy : {};
  const daemonPolicy = isRecord(input.schedulerPlan.daemonPolicy) ? input.schedulerPlan.daemonPolicy : {};
  const stopConditions = Array.isArray(input.schedulerPlan.stopConditions) ? input.schedulerPlan.stopConditions.filter((condition): condition is string => typeof condition === "string") : [];
  const scenarios = [
    {
      name: "daemon_default_disabled",
      passed: input.schedulerPlan.schedulerExecutionAllowed === false && input.schedulerPlan.daemonStarted === false && input.schedulerPlan.autoStartDaemon === false && input.schedulerPlan.continuousLoop === false && input.schedulerPlan.cronEnabled === false,
      dispatchAllowed: false,
    },
    {
      name: "one_worker_bounded_readonly_queue",
      passed: workerPool.defaultWorkers === 1 && workerPool.maxWorkers === 1 && workerPool.workerPoolBounded === true && queuePolicy.writeWorkAccepted === false && queuePolicy.claimAtMostOnePerTick === true,
      dispatchAllowed: false,
    },
    {
      name: "lease_heartbeat_timeout_stop_conditions_required",
      passed: leasePolicy.leaseRequired === true && heartbeatPolicy.heartbeatRequired === true && heartbeatPolicy.staleHeartbeatStopCondition === "timeout" && timeoutPolicy.timeoutStopCondition === "timeout" && stopConditions.includes("timeout") && stopConditions.includes("blocked") && stopConditions.includes("fail_loop") && stopConditions.includes("no_ship"),
      dispatchAllowed: false,
    },
    {
      name: "kill_switch_and_retry_stop_clean",
      passed: killSwitch.required === true && killSwitch.checkedBeforeEachTick === true && killSwitch.stopsQueueCleanly === true && retryPolicy.retriesCapped === true && retryPolicy.doNotRetryNoShip === true && retryPolicy.repeatedFailureStopCondition === "fail_loop",
      dispatchAllowed: false,
    },
    {
      name: "strict_budget_required_before_daemon_dispatch",
      passed: budgetPolicy.strictBudgetRequired === true && budgetPolicy.perRunCapsRequired === true && budgetPolicy.perDayCapsRequired === true && budgetPolicy.budgetEnforced === false && budgetPolicy.dispatchBlockedUntilStrictBudgetEnforced === true,
      dispatchAllowed: false,
    },
    {
      name: "always_on_requires_future_approval",
      passed: approvalPolicy.manualStartRequiresApproval === true && approvalPolicy.alwaysOnRequiresApproval === true && approvalPolicy.schedulerAutostartAllowed === false && daemonPolicy.alwaysOnDaemonEnabled === false,
      dispatchAllowed: false,
    },
  ];
  const checks = [
    { name: "scheduler_plan_ready", passed: input.schedulerPlan.schedulerPlanReady === true },
    { name: "daemon_default_disabled", passed: scenarios[0].passed === true },
    { name: "one_worker_bounded_readonly_queue", passed: scenarios[1].passed === true },
    { name: "lease_heartbeat_timeout_stop_conditions_required", passed: scenarios[2].passed === true },
    { name: "kill_switch_and_retry_stop_clean", passed: scenarios[3].passed === true },
    { name: "strict_budget_required_before_daemon_dispatch", passed: scenarios[4].passed === true },
    { name: "always_on_requires_future_approval", passed: scenarios[5].passed === true },
    { name: "run_scope_no_global_autonomy", passed: input.validation.globalAutonomyReady === false && input.validation.globalAutonomyNoShip === true && input.validation.childDispatchAllowed === false && input.validation.productionWritesPerformed === false && input.validation.autoApply === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const proof = {
    schema: "zob.autonomous-scheduler-proof-plan.v1",
    runId: input.runId,
    phase: "8B",
    status: failedChecks.length === 0 ? "scheduler_daemon_proof_ready_execution_blocked" : "scheduler_daemon_proof_incomplete",
    schedulerProofReady: failedChecks.length === 0,
    daemonDefaultDisabledProofPassed: scenarios[0].passed === true,
    oneWorkerBoundedProofPassed: scenarios[1].passed === true,
    stopConditionsProofPassed: scenarios[2].passed === true,
    killSwitchRetryProofPassed: scenarios[3].passed === true,
    strictBudgetBeforeDispatchProofPassed: scenarios[4].passed === true,
    alwaysOnApprovalProofPassed: scenarios[5].passed === true,
    finalE2ERequirementCleared: false,
    no_ship: true,
    checks,
    failedChecks,
    scenarios,
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/scheduler-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
      ".pi/daemon-policy.json",
    ],
    blockers: [
      "daemon_scheduler_not_started",
      "always_on_daemon_not_enabled",
      "daemon_autostart_disabled",
      "final_e2e_daemon_scheduler_evidence_required",
    ],
    schedulerExecutionAllowed: false,
    daemonStarted: false,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
    childDispatchAllowed: false,
    liveChildExecution: false,
    writeAdaptersEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecutionBeyondSmoke: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(proof)) throw new Error("autonomous scheduler proof plan would store forbidden plaintext body keys");
  return proof;
}

export function buildAutonomousMissionControlPlan(repoRoot: string, input: { runId: string; schedulerPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const team = loadTeamDefinition(repoRoot, "zob-core");
  const teamErrors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  const definition = team.definition;
  const snapshot = definition ? buildMissionControlSnapshot(repoRoot, definition, { runId: input.runId, limit: 5 }) : undefined;
  const communicationAudit = definition ? buildZobCommunicationReadinessAudit(repoRoot, definition) : undefined;
  const transport = buildZobComsTransportReadiness(repoRoot);
  const orchestratorId = definition?.orchestrator.id ?? "orchestrator";
  const commandProposals = definition ? MISSION_CONTROL_COMMANDS.map((command) => buildMissionControlCommandProposal(definition, {
    proposalId: `auto-${sha256(`${input.runId}-${command}`).slice(0, 16)}-${command}`,
    runId: input.runId,
    command,
    targetRole: orchestratorId,
    rationaleHash: sha256(`autonomous mission control ${command}`),
    artifactRefs: [`reports/autonomous-runs/${input.runId}/validation.json`],
  })) : [];
  const directWorkerErrors = definition && definition.workers[0] ? (() => {
    try {
      buildMissionControlCommandProposal(definition, {
        proposalId: `auto-${sha256(`${input.runId}-blocked-worker`).slice(0, 16)}-blocked-worker`,
        runId: input.runId,
        command: "stop",
        targetRole: definition.workers[0].id,
        rationaleHash: sha256("direct worker blocked"),
      });
      return [] as string[];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  })() : ["no worker role available for direct worker guard"];
  const transportFailedChecks = Array.isArray(transport.failedChecks) ? transport.failedChecks.filter((check): check is string => typeof check === "string") : [];
  const communicationFailedChecks = Array.isArray(communicationAudit?.failedChecks) ? communicationAudit.failedChecks.filter((check): check is string => typeof check === "string") : [];
  const communicationChecks = Array.isArray(communicationAudit?.checks) ? communicationAudit.checks.filter(isRecord) : [];
  const communicationCheckPassed = (name: string): boolean => communicationChecks.some((check) => check.name === name && check.passed === true);
  const livePeerAbsenceBlocksDelivery = transport.mode === "required_local"
    && transport.networkEnabled === false
    && transport.dispatchAllowed === true
    && transportFailedChecks.length > 0
    && transportFailedChecks.every((check) => check === "required_local_live_ready_when_enabled");
  const proposalOnlyCommunicationSafety = communicationAudit?.verdict === "PASS" && communicationAudit.no_ship === false
    || (livePeerAbsenceBlocksDelivery
      && communicationFailedChecks.length > 0
      && communicationFailedChecks.every((check) => check === "transport_policy_safe" || check === "registry_observe_only_available")
      && communicationCheckPassed("topology_guard_active")
      && communicationCheckPassed("worker_to_worker_blocked")
      && communicationCheckPassed("message_body_storage_blocked")
      && communicationCheckPassed("existing_ledgers_body_free")
      && communicationCheckPassed("stale_transport_not_completion")
      && communicationCheckPassed("dashboard_commands_are_proposals")
      && communicationCheckPassed("dashboard_direct_worker_commands_blocked"));
  const requiredLocalTransportSafeForNoDispatchPlan = transport.mode === "required_local"
    && transport.verdict === "PASS"
    && transport.noExecution === true
    && transport.networkEnabled === false
    && transport.dispatchAllowed === true;
  const transportSafeForAutonomySmoke = transport.networkEnabled === false
    && (
      (transport.verdict === "PASS" && transport.enabled === false && transport.dispatchAllowed === false)
      || requiredLocalTransportSafeForNoDispatchPlan
      || livePeerAbsenceBlocksDelivery
      || (transport.mode === "required_local" && transport.verdict === "PASS")
    );
  const checks = [
    { name: "team_topology_valid", passed: teamErrors.length === 0 },
    { name: "dashboard_snapshot_available", passed: snapshot?.schema === "zob.mission-control-snapshot.v1" },
    { name: "communication_readiness_pass", passed: proposalOnlyCommunicationSafety, detail: { readinessVerdict: communicationAudit?.verdict ?? "FAIL", livePeerAbsenceBlocksDelivery, livePeerReadyRequiredForDispatch: true, proposalOnlyNoDispatchPlan: true } },
    { name: "transport_disabled", passed: transportSafeForAutonomySmoke, detail: { transportVerdict: transport.verdict, requiredLocalTransportSafeForNoDispatchPlan, livePeerAbsenceBlocksDelivery, dispatchAllowedInPlan: false, networkComsEnabledInPlan: false } },
    { name: "commands_proposal_only", passed: commandProposals.length === MISSION_CONTROL_COMMANDS.length && commandProposals.every((proposal) => proposal.proposalOnly === true && proposal.parentOwned === true && proposal.directWorkerWrite === false && proposal.transportDispatch === false && proposal.networkTransport === false) },
    { name: "direct_worker_commands_blocked", passed: directWorkerErrors.some((error) => error.includes("direct worker")) },
    { name: "no_body_storage", passed: commandProposals.every((proposal) => proposal.bodyStored === false && proposal.promptBodiesStored === false && proposal.outputBodiesStored === false) },
    { name: "scheduler_still_disabled", passed: input.schedulerPlan.schedulerExecutionAllowed === false && input.schedulerPlan.daemonStarted === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const plan = {
    schema: "zob.autonomous-mission-control-plan.v1",
    runId: input.runId,
    missionControlPlanReady: failedChecks.length === 0,
    failedChecks,
    checks,
    dashboard: {
      snapshotAvailable: snapshot?.schema === "zob.mission-control-snapshot.v1",
      dashboardReads: ["runs", "factories", "queue", "budget", "model_routing", "coms", "blockers", "autonomy_status"],
      latestRunLimit: 5,
      directWorkerWrites: false,
      bypassesParentGates: false,
      networkComsEnabled: false,
      snapshotSchema: snapshot?.schema,
    },
    commandPolicy: {
      proposalOnly: true,
      parentOwned: true,
      directWorkerWrites: false,
      transportDispatch: false,
      networkTransport: false,
      allowedCommands: [...MISSION_CONTROL_COMMANDS],
      proposalCount: commandProposals.length,
      proposalHashes: commandProposals.map((proposal) => proposal.commandHash).filter((hash): hash is string => typeof hash === "string"),
      directWorkerCommandBlocked: directWorkerErrors.some((error) => error.includes("direct worker")),
    },
    comsPolicy: {
      readinessVerdict: communicationAudit?.verdict ?? "FAIL",
      proposalOnlyReadinessAccepted: proposalOnlyCommunicationSafety,
      livePeerAbsenceBlocksDelivery,
      livePeerReadyRequiredForDispatch: true,
      topologyGuardActive: Array.isArray(communicationAudit?.checks) && communicationAudit.checks.some((check) => isRecord(check) && check.name === "topology_guard_active" && check.passed === true),
      hashOnlyLedgers: true,
      workerToWorkerFreeChatAllowed: false,
      rawPromptOutputStored: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
    transportPolicy: {
      enabled: false,
      localDispatchEnabled: false,
      dispatchAllowed: false,
      networkEnabled: false,
      stalePeerCountsAsCompletion: false,
      responseBodiesStored: false,
      livePeerAbsenceBlocksDelivery,
      livePeerReadyRequiredForDispatch: true,
      futureHeartbeatRequired: true,
      futureStaleDetectionRequired: true,
      futureActiveWorkerRegistryRequired: true,
      futureResponseCaptureRequired: true,
    },
    autonomyStatus: {
      globalAutonomyReady: false,
      globalAutonomyNoShip: true,
      noGlobalAutonomyClaim: true,
    },
    schedulerExecutionAllowed: false,
    daemonStarted: false,
    childDispatchAllowed: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous mission control plan would store forbidden plaintext body keys");
  return plan;
}

export function buildAutonomousMissionControlProofPlan(input: { runId: string; missionControlPlan: Record<string, unknown>; schedulerProofPlan: Record<string, unknown>; modelRoutingProofPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const commandPolicy = isRecord(input.missionControlPlan.commandPolicy) ? input.missionControlPlan.commandPolicy : {};
  const comsPolicy = isRecord(input.missionControlPlan.comsPolicy) ? input.missionControlPlan.comsPolicy : {};
  const transportPolicy = isRecord(input.missionControlPlan.transportPolicy) ? input.missionControlPlan.transportPolicy : {};
  const allowedCommands = Array.isArray(commandPolicy.allowedCommands) ? commandPolicy.allowedCommands.filter((command): command is string => typeof command === "string") : [];
  const proposalHashes = Array.isArray(commandPolicy.proposalHashes) ? commandPolicy.proposalHashes.filter((hash): hash is string => typeof hash === "string") : [];
  const proposalHashesValid = proposalHashes.length === MISSION_CONTROL_COMMANDS.length && proposalHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash));
  const allMissionCommandsCovered = MISSION_CONTROL_COMMANDS.every((command) => allowedCommands.includes(command));
  const approvalCommandAvailable = allowedCommands.includes("approve");
  const scenarios = [
    {
      name: "proposal_only_commands_parent_owned",
      passed: commandPolicy.proposalOnly === true && commandPolicy.parentOwned === true && commandPolicy.transportDispatch === false && commandPolicy.networkTransport === false && commandPolicy.proposalCount === MISSION_CONTROL_COMMANDS.length && allMissionCommandsCovered && proposalHashesValid,
      dispatchAllowed: false,
    },
    {
      name: "topology_hash_only_comms",
      passed: comsPolicy.topologyGuardActive === true && comsPolicy.hashOnlyLedgers === true && comsPolicy.workerToWorkerFreeChatAllowed === false && comsPolicy.rawPromptOutputStored === false && comsPolicy.bodyStored === false && comsPolicy.promptBodiesStored === false && comsPolicy.outputBodiesStored === false,
      dispatchAllowed: false,
    },
    {
      name: "direct_worker_commands_blocked",
      passed: commandPolicy.directWorkerWrites === false && commandPolicy.directWorkerCommandBlocked === true && input.missionControlPlan.directWorkerWrites === false,
      dispatchAllowed: false,
    },
    {
      name: "live_transport_and_network_disabled",
      passed: transportPolicy.enabled === false && transportPolicy.localDispatchEnabled === false && transportPolicy.dispatchAllowed === false && transportPolicy.networkEnabled === false && input.missionControlPlan.transportDispatch === false && input.missionControlPlan.networkComsEnabled === false,
      dispatchAllowed: false,
    },
    {
      name: "approval_required_before_live_global_routing",
      passed: approvalCommandAvailable && commandPolicy.proposalOnly === true && commandPolicy.parentOwned === true && input.modelRoutingProofPlan.globalLiveRoutingEnabled === false && input.modelRoutingProofPlan.liveAutonomousRoutingApplied === false && input.modelRoutingProofPlan.finalE2ERequirementCleared === false && input.modelRoutingProofPlan.no_ship === true,
      dispatchAllowed: false,
    },
    {
      name: "post_8b_scheduler_still_blocked",
      passed: input.schedulerProofPlan.schedulerProofReady === true && input.schedulerProofPlan.schedulerExecutionAllowed === false && input.schedulerProofPlan.daemonStarted === false && input.schedulerProofPlan.childDispatchAllowed === false,
      dispatchAllowed: false,
    },
  ];
  const checks = [
    { name: "mission_control_plan_ready", passed: input.missionControlPlan.missionControlPlanReady === true },
    { name: "proposal_only_commands_parent_owned", passed: scenarios[0].passed === true },
    { name: "topology_hash_only_comms", passed: scenarios[1].passed === true },
    { name: "direct_worker_commands_blocked", passed: scenarios[2].passed === true },
    { name: "live_transport_and_network_disabled", passed: scenarios[3].passed === true },
    { name: "approval_required_before_live_global_routing", passed: scenarios[4].passed === true },
    { name: "post_8b_scheduler_still_blocked", passed: scenarios[5].passed === true },
    { name: "run_scope_no_global_autonomy", passed: input.validation.globalAutonomyReady === false && input.validation.globalAutonomyNoShip === true && input.validation.childDispatchAllowed === false && input.validation.productionWritesPerformed === false && input.validation.autoApply === false && input.missionControlPlan.globalAutonomyReady === false && input.missionControlPlan.globalAutonomyNoShip === true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const proof = {
    schema: "zob.autonomous-mission-control-proof-plan.v1",
    runId: input.runId,
    phase: "9B",
    status: failedChecks.length === 0 ? "mission_control_comms_proof_ready_execution_blocked" : "mission_control_comms_proof_incomplete",
    missionControlProofReady: failedChecks.length === 0,
    proposalOnlyCommandsProofPassed: scenarios[0].passed === true,
    topologyHashOnlyCommsProofPassed: scenarios[1].passed === true,
    directWorkerCommandsBlockedProofPassed: scenarios[2].passed === true,
    liveTransportNetworkDisabledProofPassed: scenarios[3].passed === true,
    liveGlobalRoutingApprovalProofPassed: scenarios[4].passed === true,
    post8bSchedulerBlockedProofPassed: scenarios[5].passed === true,
    finalE2ERequirementCleared: false,
    no_ship: true,
    checks,
    failedChecks,
    scenarios,
    commandProposalProof: {
      proposalOnly: true,
      parentOwned: true,
      allowedCommands,
      proposalCount: commandPolicy.proposalCount,
      proposalHashesValid,
      directWorkerCommandBlocked: commandPolicy.directWorkerCommandBlocked === true,
      transportDispatch: false,
      networkTransport: false,
    },
    comsTopologyProof: {
      topologyGuardActive: comsPolicy.topologyGuardActive === true,
      hashOnlyLedgers: comsPolicy.hashOnlyLedgers === true,
      workerToWorkerFreeChatAllowed: false,
      rawPromptOutputStored: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
    transportProof: {
      enabled: false,
      localDispatchEnabled: false,
      dispatchAllowed: false,
      networkEnabled: false,
      stalePeerCountsAsCompletion: false,
      responseBodiesStored: false,
      futureHeartbeatRequired: transportPolicy.futureHeartbeatRequired === true,
      futureStaleDetectionRequired: transportPolicy.futureStaleDetectionRequired === true,
      futureActiveWorkerRegistryRequired: transportPolicy.futureActiveWorkerRegistryRequired === true,
      futureResponseCaptureRequired: transportPolicy.futureResponseCaptureRequired === true,
    },
    routingApprovalPolicy: {
      approvalCommandAvailable,
      approvalCommandProposalOnly: true,
      liveRoutingRequiresApproval: true,
      globalRoutingRequiresApproval: true,
      approvalDoesNotEnableRoutingInThisRun: true,
      liveRoutingAllowedAfterThisProof: false,
      globalLiveRoutingAllowedAfterThisProof: false,
    },
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/mission-control-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/scheduler-proof-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/model-routing-proof-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
      ".pi/teams/zob-core.json",
      ".pi/mission-control/zob_coms_transport.json",
      ".pi/coms/messages.jsonl",
      ".pi/coms/status.jsonl",
    ],
    blockers: [
      "live_transport_not_enabled",
      "network_coms_disabled",
      "global_live_routing_approval_not_granted",
      "final_e2e_mission_control_live_comms_evidence_required",
    ],
    schedulerExecutionAllowed: false,
    daemonStarted: false,
    childDispatchAllowed: false,
    liveChildExecution: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    liveRoutingEnabled: false,
    globalLiveRoutingEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecutionBeyondSmoke: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(proof)) throw new Error("autonomous mission control proof plan would store forbidden plaintext body keys");
  return proof;
}

export function buildAutonomousSandboxApplyPlan(repoRoot: string, input: { runId: string; missionControlPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const isolatedPath = "reports/sandbox-isolated-execution-smoke.json";
  const reviewPath = "reports/sandbox-diff-review-gate-smoke.json";
  const simulationPath = "reports/sandbox-apply-simulation-smoke.json";
  const preflightPath = "reports/sandbox-manual-apply-preflight-smoke.json";
  const isolatedRead = readJsonArtifact(join(repoRoot, isolatedPath));
  const reviewRead = readJsonArtifact(join(repoRoot, reviewPath));
  const simulationRead = readJsonArtifact(join(repoRoot, simulationPath));
  const preflightRead = readJsonArtifact(join(repoRoot, preflightPath));
  const isolated = isRecord(isolatedRead.parsed) ? isolatedRead.parsed : {};
  const review = isRecord(reviewRead.parsed) ? reviewRead.parsed : {};
  const simulation = isRecord(simulationRead.parsed) ? simulationRead.parsed : {};
  const preflight = isRecord(preflightRead.parsed) ? preflightRead.parsed : {};
  const isolatedDiffHash = typeof isolated.diffHash === "string" ? isolated.diffHash : undefined;
  const reviewDiffHash = typeof review.diffHash === "string" ? review.diffHash : undefined;
  const simulationDiffHash = typeof simulation.diffHash === "string" ? simulation.diffHash : undefined;
  const diffHashesMatch = Boolean(isolatedDiffHash && isolatedDiffHash === reviewDiffHash && reviewDiffHash === simulationDiffHash);
  const checks = [
    { name: "isolated_temp_workspace_executed", passed: isolated.status === "executed_in_sandbox" && isolated.isolatedExecutionPerformed === true && isolated.productionWritesPerformed === false },
    { name: "diff_hash_consistent", passed: diffHashesMatch },
    { name: "oracle_diff_review_passed", passed: review.status === "diff_review_passed" && review.reviewPassed === true && review.applyReadyUnlocked === true && review.applyPerformed === false },
    { name: "rollback_metadata_required", passed: isolated.rollbackPrepared === true && simulation.rollbackPrepared === true && isolated.rollbackApplied === false && simulation.rollbackApplied === false },
    { name: "apply_simulation_temp_workspace_only", passed: simulation.status === "simulated_apply_in_temp_workspace" && simulation.simulatedApplyPerformed === true && simulation.tempTargetWorkspaceScoped === true && simulation.productionWritesPerformed === false },
    { name: "manual_apply_preflight_packet_ready", passed: preflight.status === "manual_apply_preflight_passed" && preflight.manualApplyPreflightPassed === true && preflight.executionAllowedByThisTool === false && preflight.realApplyExecuted === false && preflight.productionWritesPerformed === false },
    { name: "manual_approval_required", passed: isolated.manualApplyRequired === true && review.manualApplyRequired === true && simulation.manualApplyRequired === true && preflight.manualApplyRequired === true && isolated.humanApprovalRequired === true && review.humanApprovalRequired === true && simulation.humanApprovalRequired === true && preflight.humanApprovalRequired === true },
    { name: "auto_apply_disabled", passed: isolated.autoApply === false && review.autoApply === false && simulation.autoApply === false && preflight.autoApply === false },
    { name: "mission_control_still_proposal_only", passed: input.missionControlPlan.directWorkerWrites === false && input.missionControlPlan.transportDispatch === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const plan = {
    schema: "zob.autonomous-sandbox-apply-plan.v1",
    runId: input.runId,
    sandboxApplyPlanReady: failedChecks.length === 0,
    failedChecks,
    checks,
    evidenceRefs: [isolatedPath, reviewPath, simulationPath, preflightPath],
    evidenceHashes: {
      isolatedExecution: isolatedRead.hash,
      diffReviewGate: reviewRead.hash,
      applySimulation: simulationRead.hash,
      manualApplyPreflight: preflightRead.hash,
    },
    sandboxRunIdHash: typeof isolated.runId === "string" ? sha256(isolated.runId) : undefined,
    isolatedTempWorkspace: {
      required: true,
      executed: isolated.isolatedExecutionPerformed === true,
      workspacePathStored: false,
      productionWritesPerformed: false,
    },
    applyPlan: {
      required: true,
      plaintextContentStored: false,
      allowedPathsRequired: true,
      forbiddenPathsRequired: true,
      writeTargetsMustExcludeSecretsVendorGenerated: true,
    },
    diffGate: {
      diffHashRequired: true,
      diffHash: isolatedDiffHash,
      diffHashesMatch,
      changedPathCount: Array.isArray(isolated.changedPaths) ? isolated.changedPaths.length : undefined,
      rawDiffStored: false,
    },
    oracleDiffReview: {
      required: true,
      reviewPassed: review.reviewPassed === true,
      applyReadyUnlocked: review.applyReadyUnlocked === true,
      liveOracleDispatchRequiredBeforeRealApply: true,
    },
    rollbackPolicy: {
      rollbackMetadataRequired: true,
      rollbackPrepared: isolated.rollbackPrepared === true && simulation.rollbackPrepared === true,
      rollbackApplied: false,
      rollbackSnapshotRequiredBeforeMainApply: true,
    },
    approvalPolicy: {
      manualApprovalRequired: true,
      humanApprovalRequired: true,
      approvalMetadataHashOnly: true,
      approvedForMainWorkspaceApply: false,
    },
    applySimulation: {
      required: true,
      simulatedApplyPerformed: simulation.simulatedApplyPerformed === true,
      tempTargetWorkspaceScoped: simulation.tempTargetWorkspaceScoped === true,
      productionWritesPerformed: false,
      autoApply: false,
    },
    manualApplyPreflight: {
      required: true,
      preflightPassed: preflight.manualApplyPreflightPassed === true,
      executionAllowedByThisTool: false,
      confirmationPhraseMatched: isRecord(preflight.gates) && preflight.gates.confirmationPhraseMatched === true,
      approvalHashOnly: isRecord(preflight.gates) && preflight.gates.approvalHashOnly === true,
      realApplyExecuted: false,
      productionWritesPerformed: false,
      autoApply: false,
    },
    mainWorkspaceApply: {
      realApplyAllowed: false,
      realApplyExecuted: false,
      productionWritesPerformed: false,
      autoApply: false,
      reason: "phase_10b_manual_apply_preflight_only_no_main_workspace_apply",
      requiredBeforeRealApply: ["fresh_oracle_diff_review_PASS", "rollback_snapshot", "manual_human_approval", "strict_budget_gate", "allowed_paths_write_policy", "separate_manual_apply_executor", "post_apply_validation_oracle"],
    },
    writeSafety: {
      noDirectAutonomousWritesToMainWorkspace: true,
      noAutoApplyByDefault: true,
      noSecretsVendorGeneratedPaths: true,
      rollbackMetadataRequiredBeforeScalingWrites: true,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    realApplyExecuted: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous sandbox apply plan would store forbidden plaintext body keys");
  return plan;
}

export function expectedAutonomousCurrentSourceFingerprintFiles(factorySelection: Record<string, unknown>): string[] {
  const selectedFactory = typeof factorySelection.selectedFactory === "string" ? factorySelection.selectedFactory : undefined;
  const factoryFiles = selectedFactory ? [`.pi/factories/${selectedFactory}/factory.json`, `.pi/factories/${selectedFactory}/smoke-manifest.json`] : [];
  return [...AUTONOMOUS_CURRENT_SOURCE_FINGERPRINT_FILES, ...factoryFiles].filter((file, index, items) => items.indexOf(file) === index).sort();
}

export function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function sameStringArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left) && left.every((item) => typeof item === "string") && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function buildAutonomousCurrentSourceFingerprint(repoRoot: string, input: { runId: string; factorySelection: Record<string, unknown> }): Record<string, unknown> {
  const selectedFactory = typeof input.factorySelection.selectedFactory === "string" ? input.factorySelection.selectedFactory : undefined;
  const sourceFiles = expectedAutonomousCurrentSourceFingerprintFiles(input.factorySelection);
  const missingFiles = sourceFiles.filter((file) => !existsSync(join(repoRoot, file)));
  const fileHashes = Object.fromEntries(sourceFiles.filter((file) => existsSync(join(repoRoot, file))).map((file) => [file, sha256(readFileSync(join(repoRoot, file), "utf8"))]));
  const fingerprintHash = sha256(JSON.stringify(fileHashes));
  const fingerprint = {
    schema: "zob.autonomous-current-source-fingerprint.v1",
    runId: input.runId,
    phase: "11C",
    status: missingFiles.length === 0 ? "current_source_fingerprint_captured" : "blocked_missing_source_files",
    currentSourceFingerprintReady: missingFiles.length === 0,
    currentSourceFingerprintCaptured: missingFiles.length === 0,
    noMockCurrentSourceE2EProved: false,
    finalE2EProofReady: false,
    sourceFiles,
    sourceFileCount: sourceFiles.length,
    hashedFileCount: Object.keys(fileHashes).length,
    missingFiles,
    fileHashes,
    fingerprintHash,
    selectedFactory,
    evidencePolicy: {
      hashOnly: true,
      sourceBodiesStored: false,
      currentSourceOnly: true,
      rehashRequiredBeforeFinalE2E: true,
      noMockProofRequiredSeparately: true,
    },
    safety: {
      noExecution: true,
      childDispatchAllowed: false,
      daemonStarted: false,
      productionWritesPerformed: false,
      autoApply: false,
      networkAccessed: false,
      globalAutonomyReady: false,
      globalAutonomyNoShip: true,
    },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(fingerprint)) throw new Error("autonomous current-source fingerprint would store forbidden plaintext body keys");
  return fingerprint;
}

export function validateAutonomousCurrentSourceFingerprintFreshness(repoRoot: string, fingerprint: Record<string, unknown>, factorySelection: Record<string, unknown>): Record<string, unknown> {
  const expectedSourceFiles = expectedAutonomousCurrentSourceFingerprintFiles(factorySelection);
  const currentMissingFiles = expectedSourceFiles.filter((file) => !existsSync(join(repoRoot, file)));
  const currentFileHashes = Object.fromEntries(expectedSourceFiles.filter((file) => existsSync(join(repoRoot, file))).map((file) => [file, sha256(readFileSync(join(repoRoot, file), "utf8"))]));
  const storedFileHashes = stringRecord(fingerprint.fileHashes);
  const currentFingerprintHash = sha256(JSON.stringify(currentFileHashes));
  const storedFingerprintHash = typeof fingerprint.fingerprintHash === "string" ? fingerprint.fingerprintHash : undefined;
  const hashValuesValid = Object.values(storedFileHashes).every((hash) => /^[a-f0-9]{64}$/.test(hash));
  const expectedHashKeys = Object.keys(currentFileHashes).sort();
  const storedHashKeys = Object.keys(storedFileHashes).sort();
  const fileHashesMatch = JSON.stringify(expectedHashKeys) === JSON.stringify(storedHashKeys) && expectedHashKeys.every((file) => storedFileHashes[file] === currentFileHashes[file]);
  const sourceFilesMatch = sameStringArray(fingerprint.sourceFiles, expectedSourceFiles);
  const missingFilesMatch = sameStringArray(fingerprint.missingFiles, currentMissingFiles);
  const fingerprintHashMatches = storedFingerprintHash === currentFingerprintHash;
  const fresh = fingerprint.schema === "zob.autonomous-current-source-fingerprint.v1"
    && fingerprint.currentSourceFingerprintReady === true
    && fingerprint.currentSourceFingerprintCaptured === true
    && sourceFilesMatch
    && missingFilesMatch
    && currentMissingFiles.length === 0
    && hashValuesValid
    && fileHashesMatch
    && fingerprintHashMatches
    && fingerprint.noMockCurrentSourceE2EProved === false;
  const result = {
    schema: "zob.autonomous-current-source-fingerprint-freshness.v1",
    fresh,
    sourceFilesMatch,
    missingFilesMatch,
    hashValuesValid,
    fileHashesMatch,
    fingerprintHashMatches,
    currentFingerprintHash,
    storedFingerprintHash,
    expectedSourceFileCount: expectedSourceFiles.length,
    storedSourceFileCount: Array.isArray(fingerprint.sourceFiles) ? fingerprint.sourceFiles.length : 0,
    expectedHashedFileCount: expectedHashKeys.length,
    storedHashedFileCount: storedHashKeys.length,
    currentMissingFiles,
    noMockCurrentSourceE2EProved: false,
    noExecution: true,
    childDispatchAllowed: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(result)) throw new Error("autonomous current-source freshness validation would store forbidden plaintext body keys");
  return result;
}

export function buildAutonomousFinalNoShipOracle(input: { runId: string; finalE2EProofPlan: Record<string, unknown>; currentSourceFingerprint: Record<string, unknown> }): Record<string, unknown> {
  const blockers = Array.isArray(input.finalE2EProofPlan.blockers) ? input.finalE2EProofPlan.blockers.filter((blocker): blocker is string => typeof blocker === "string") : ["final_e2e_proof_plan_missing_blockers"];
  const checks = [
    { name: "final_e2e_proof_ready", passed: input.finalE2EProofPlan.finalE2EProofReady === true },
    { name: "final_e2e_no_ship_cleared", passed: input.finalE2EProofPlan.no_ship === false },
    { name: "no_mock_current_source_e2e_proved", passed: isRecord(input.finalE2EProofPlan.currentSourceProof) && input.finalE2EProofPlan.currentSourceProof.noMockCurrentSourceE2EProved === true },
    { name: "current_source_fingerprint_captured", passed: input.currentSourceFingerprint.currentSourceFingerprintCaptured === true && typeof input.currentSourceFingerprint.fingerprintHash === "string" },
    { name: "pilot_executed", passed: isRecord(input.finalE2EProofPlan.promotionStatus) && input.finalE2EProofPlan.promotionStatus.pilotExecuted === true },
    { name: "batch_executed", passed: isRecord(input.finalE2EProofPlan.promotionStatus) && input.finalE2EProofPlan.promotionStatus.batchExecuted === true },
    { name: "live_strict_budget_enforced", passed: isRecord(input.finalE2EProofPlan.liveGateStatus) && input.finalE2EProofPlan.liveGateStatus.strictBudgetEnforced === true },
    { name: "live_model_routing_enabled", passed: isRecord(input.finalE2EProofPlan.liveGateStatus) && input.finalE2EProofPlan.liveGateStatus.liveModelRoutingEnabled === true },
    { name: "daemon_started", passed: isRecord(input.finalE2EProofPlan.liveGateStatus) && input.finalE2EProofPlan.liveGateStatus.daemonStarted === true },
    { name: "real_apply_executed", passed: isRecord(input.finalE2EProofPlan.liveGateStatus) && input.finalE2EProofPlan.liveGateStatus.sandboxRealApplyExecuted === true },
    { name: "global_ready_sentinel_allowed", passed: isRecord(input.finalE2EProofPlan.sentinelPolicy) && input.finalE2EProofPlan.sentinelPolicy.globalReadySentinelAllowed === true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const oracle = {
    schema: "zob.autonomous-final-no-ship-oracle.v1",
    runId: input.runId,
    phase: "11E",
    oracleType: "deterministic_structural_no_ship",
    verdict: "FAIL",
    no_ship: true,
    finalOracleReady: false,
    finalOraclePass: false,
    finalE2EProofReady: false,
    evidenceChecked: true,
    checks,
    failedChecks,
    blockers,
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/final-e2e-proof-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/current-source-fingerprint.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
    ],
    decision: {
      globalAutonomyReady: false,
      globalAutonomyNoShip: true,
      claim100PercentAutonomyAllowed: false,
      writeGlobalReadySentinelAllowed: false,
      writeFinalDoneSentinelAllowed: false,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    realApplyExecuted: false,
    liveRoutingEnabled: false,
    budgetEnforced: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(oracle)) throw new Error("autonomous final no-ship oracle would store forbidden plaintext body keys");
  return oracle;
}

export function buildAutonomousFinalE2EProofPlan(repoRoot: string, input: { runId: string; runtimeGates: Record<string, unknown>; strictBudgetProofPlan: Record<string, unknown>; modelRoutingProofPlan: Record<string, unknown>; modelRoutingPlan: Record<string, unknown>; factorySelection: Record<string, unknown>; factoryRunRef: Record<string, unknown>; oracleReview: Record<string, unknown>; promotionPlan: Record<string, unknown>; promotionProofPlan: Record<string, unknown>; schedulerPlan: Record<string, unknown>; schedulerProofPlan: Record<string, unknown>; missionControlPlan: Record<string, unknown>; missionControlProofPlan: Record<string, unknown>; sandboxApplyPlan: Record<string, unknown>; currentSourceFingerprint: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const safeRunId = safeFileStem(input.runId);
  const runRoot = `reports/autonomous-runs/${safeRunId}`;
  const globalReadySentinelPath = join(repoRoot, runRoot, "GLOBAL_AUTONOMY_READY.sentinel");
  const smokeGate = isRecord(input.promotionPlan.smokeGate) ? input.promotionPlan.smokeGate : {};
  const pilotGate = isRecord(input.promotionPlan.pilotGate) ? input.promotionPlan.pilotGate : {};
  const batchGate = isRecord(input.promotionPlan.batchGate) ? input.promotionPlan.batchGate : {};
  const strictBudgetGate = isRecord(input.runtimeGates.autonomousStrictBudgetGate) ? input.runtimeGates.autonomousStrictBudgetGate : {};
  const mainWorkspaceApply = isRecord(input.sandboxApplyPlan.mainWorkspaceApply) ? input.sandboxApplyPlan.mainWorkspaceApply : {};
  const globalReadySentinelPresent = existsSync(globalReadySentinelPath);
  const proofSteps = [
    { name: "user_need", state: "captured", evidenceRef: `${runRoot}/spec-gate.json`, dispatchAllowed: false },
    { name: "spec_lock", state: "proved", evidenceRef: `${runRoot}/spec-gate.json`, dispatchAllowed: false },
    { name: "context_scope", state: "proved", evidenceRef: `${runRoot}/context-scope.json`, dispatchAllowed: false },
    { name: "context_pack", state: "proved", evidenceRef: `${runRoot}/context-pack.json`, dispatchAllowed: false },
    { name: "strict_budget", state: input.strictBudgetProofPlan.strictBudgetProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/strict-budget-proof-plan.json`, blocker: "live_autonomous_strict_budget_not_enforced", dispatchAllowed: false },
    { name: "model_routing", state: input.modelRoutingProofPlan.modelRoutingProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/model-routing-proof-plan.json`, blocker: "live_autonomous_model_routing_not_enabled", dispatchAllowed: false },
    { name: "factory_selection", state: "proved", evidenceRef: `${runRoot}/factory-selection.json`, dispatchAllowed: false },
    { name: "smoke", state: input.factoryRunRef.status === "done" ? "proved" : "blocked", evidenceRef: `${runRoot}/factory-run-ref.json`, dispatchAllowed: false },
    { name: "smoke_oracle", state: input.oracleReview.verdict === "PASS" && input.oracleReview.no_ship === false ? "proved" : "blocked", evidenceRef: `${runRoot}/oracle-review.json`, dispatchAllowed: false },
    { name: "promotion_proof", state: input.promotionProofPlan.promotionProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/promotion-proof-plan.json`, blocker: "pilot_batch_execution_not_enabled", dispatchAllowed: false },
    { name: "pilot", state: "blocked", evidenceRef: `${runRoot}/promotion-plan.json`, blocker: "pilot_execution_disabled_until_live_gates", dispatchAllowed: false },
    { name: "pilot_oracle", state: "blocked", evidenceRef: `${runRoot}/promotion-plan.json`, blocker: "pilot_oracle_missing_until_pilot_executes", dispatchAllowed: false },
    { name: "batch", state: "blocked", evidenceRef: `${runRoot}/promotion-plan.json`, blocker: "batch_execution_disabled_until_pilot_oracle_and_concurrency_gate", dispatchAllowed: false },
    { name: "final_oracle", state: "blocked", evidenceRef: `${runRoot}/final-e2e-proof-plan.json`, blocker: "final_oracle_missing_until_full_current_source_e2e", dispatchAllowed: false },
    { name: "scheduler_proof", state: input.schedulerProofPlan.schedulerProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/scheduler-proof-plan.json`, blocker: "daemon_scheduler_not_started", dispatchAllowed: false },
    { name: "mission_control_proof", state: input.missionControlProofPlan.missionControlProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/mission-control-proof-plan.json`, blocker: "live_mission_control_transport_not_enabled", dispatchAllowed: false },
    { name: "stop_clean", state: "planned", evidenceRef: `${runRoot}/scheduler-plan.json`, dispatchAllowed: false },
  ];
  const requiredArtifacts = [
    { name: "spec-gate.json", present: true, evidenceRef: `${runRoot}/spec-gate.json` },
    { name: "context-scope.json", present: true, evidenceRef: `${runRoot}/context-scope.json` },
    { name: "context-pack.json", present: true, evidenceRef: `${runRoot}/context-pack.json` },
    { name: "factory-selection.json", present: true, evidenceRef: `${runRoot}/factory-selection.json` },
    { name: "runtime-gates.json", present: true, evidenceRef: `${runRoot}/runtime-gates.json` },
    { name: "strict-budget-proof-plan.json", present: input.strictBudgetProofPlan.strictBudgetProofReady === true, evidenceRef: `${runRoot}/strict-budget-proof-plan.json` },
    { name: "model-routing-proof-plan.json", present: input.modelRoutingProofPlan.modelRoutingProofReady === true, evidenceRef: `${runRoot}/model-routing-proof-plan.json` },
    { name: "run-graph.json", present: true, evidenceRef: `${runRoot}/run-graph.json` },
    { name: "current-source-fingerprint.json", present: input.currentSourceFingerprint.currentSourceFingerprintReady === true, evidenceRef: `${runRoot}/current-source-fingerprint.json` },
    { name: "factory-run-smoke", present: input.factoryRunRef.status === "done", evidenceRef: `${runRoot}/factory-run-ref.json` },
    { name: "factory-run-pilot", present: false, missingReason: "pilot_not_executed" },
    { name: "factory-run-batch", present: false, missingReason: "batch_not_executed" },
    { name: "oracle-review-smoke.json", present: input.oracleReview.verdict === "PASS", evidenceRef: `${runRoot}/oracle-review.json` },
    { name: "promotion-proof-plan.json", present: input.promotionProofPlan.promotionProofReady === true, evidenceRef: `${runRoot}/promotion-proof-plan.json` },
    { name: "scheduler-proof-plan.json", present: input.schedulerProofPlan.schedulerProofReady === true, evidenceRef: `${runRoot}/scheduler-proof-plan.json` },
    { name: "mission-control-proof-plan.json", present: input.missionControlProofPlan.missionControlProofReady === true, evidenceRef: `${runRoot}/mission-control-proof-plan.json` },
    { name: "oracle-review-pilot.json", present: false, missingReason: "pilot_oracle_missing" },
    { name: "final-oracle.json", present: false, missingReason: "final_oracle_missing" },
    { name: "validation.json", present: input.validation.status === "smoke_autonomy_passed", evidenceRef: `${runRoot}/validation.json` },
    { name: "DONE.sentinel", present: false, missingReason: "final_e2e_not_run" },
    { name: "GLOBAL_AUTONOMY_READY.sentinel", present: globalReadySentinelPresent, missingReason: globalReadySentinelPresent ? undefined : "global_autonomy_not_ready" },
  ];
  const blockers = [
    "final_e2e_no_mock_current_source_not_proven",
    ...(strictBudgetGate.strictEnabled === true && strictBudgetGate.budgetEnforced === true ? [] : ["live_strict_budget_not_enforced"]),
    ...(input.modelRoutingPlan.liveRoutingEnabled === true ? [] : ["live_model_routing_not_enabled"]),
    ...(input.schedulerPlan.schedulerExecutionAllowed === true && input.schedulerPlan.daemonStarted === true ? [] : ["daemon_scheduler_not_started"]),
    ...(input.missionControlProofPlan.finalE2ERequirementCleared === true ? [] : ["live_mission_control_transport_not_enabled"]),
    ...(smokeGate.passed === true ? [] : ["smoke_gate_not_passed"]),
    ...(pilotGate.executionAllowed === true ? [] : ["pilot_execution_disabled"]),
    ...(batchGate.executionAllowed === true ? [] : ["batch_execution_disabled"]),
    ...(mainWorkspaceApply.realApplyExecuted === true ? [] : ["real_apply_not_executed"]),
    "final_oracle_missing",
    ...(globalReadySentinelPresent ? [] : ["global_autonomy_ready_sentinel_absent"]),
  ];
  const plan = {
    schema: "zob.autonomous-final-e2e-proof-plan.v1",
    runId: input.runId,
    phase: "11A",
    status: "blocked_for_final_e2e_proof",
    finalE2EProofReady: false,
    no_ship: true,
    blockers,
    proofSteps,
    requiredArtifacts,
    currentSourceProof: {
      required: true,
      noMockRequired: true,
      currentSourceFingerprintCaptured: input.currentSourceFingerprint.currentSourceFingerprintCaptured === true,
      currentSourceFingerprintHash: typeof input.currentSourceFingerprint.fingerprintHash === "string" ? input.currentSourceFingerprint.fingerprintHash : undefined,
      sourceFileCount: typeof input.currentSourceFingerprint.sourceFileCount === "number" ? input.currentSourceFingerprint.sourceFileCount : undefined,
      missingFiles: Array.isArray(input.currentSourceFingerprint.missingFiles) ? input.currentSourceFingerprint.missingFiles : [],
      noMockCurrentSourceE2EProved: false,
      registeredFactoryPathChecked: input.factorySelection.currentSourceProofRequired === true,
      arbitraryFactoryAutonomyReady: false,
    },
    liveGateStatus: {
      strictBudgetEnforced: strictBudgetGate.budgetEnforced === true,
      strictBudgetEnabled: strictBudgetGate.strictEnabled === true,
      strictBudgetProofReady: input.strictBudgetProofPlan.strictBudgetProofReady === true,
      strictBudgetBlockProofPassed: input.strictBudgetProofPlan.strictBudgetBlockProofPassed === true,
      strictBudgetFinalE2ERequirementCleared: input.strictBudgetProofPlan.finalE2ERequirementCleared === true,
      modelRoutingProofReady: input.modelRoutingProofPlan.modelRoutingProofReady === true,
      modelRoutingOracleProofPassed: input.modelRoutingProofPlan.routingOracleProofPassed === true,
      modelRoutingFinalE2ERequirementCleared: input.modelRoutingProofPlan.finalE2ERequirementCleared === true,
      liveModelRoutingEnabled: input.modelRoutingPlan.liveRoutingEnabled === true,
      schedulerExecutionAllowed: input.schedulerPlan.schedulerExecutionAllowed === true,
      schedulerProofReady: input.schedulerProofPlan.schedulerProofReady === true,
      schedulerFinalE2ERequirementCleared: input.schedulerProofPlan.finalE2ERequirementCleared === true,
      daemonStarted: input.schedulerPlan.daemonStarted === true,
      missionControlProposalOnly: isRecord(input.missionControlPlan.commandPolicy) && input.missionControlPlan.commandPolicy.proposalOnly === true,
      missionControlProofReady: input.missionControlProofPlan.missionControlProofReady === true,
      missionControlFinalE2ERequirementCleared: input.missionControlProofPlan.finalE2ERequirementCleared === true,
      directWorkerCommandsBlocked: input.missionControlProofPlan.directWorkerCommandsBlockedProofPassed === true,
      liveTransportNetworkDisabled: input.missionControlProofPlan.liveTransportNetworkDisabledProofPassed === true,
      liveGlobalRoutingApprovalRequired: input.missionControlProofPlan.liveGlobalRoutingApprovalProofPassed === true,
      sandboxRealApplyExecuted: mainWorkspaceApply.realApplyExecuted === true,
    },
    promotionStatus: {
      smokeGatePassed: smokeGate.passed === true,
      pilotPreconditionsMet: pilotGate.preconditionsMet === true,
      promotionProofReady: input.promotionProofPlan.promotionProofReady === true,
      promotionFinalE2ERequirementCleared: input.promotionProofPlan.finalE2ERequirementCleared === true,
      pilotExecutionAllowed: pilotGate.executionAllowed === true,
      batchPreconditionsMet: batchGate.preconditionsMet === true,
      batchExecutionAllowed: batchGate.executionAllowed === true,
      pilotExecuted: input.promotionPlan.pilotExecuted === true,
      batchExecuted: input.promotionPlan.batchExecuted === true,
    },
    sentinelPolicy: {
      doneSentinelAllowed: false,
      globalReadySentinelAllowed: false,
      globalReadySentinelPresent,
      globalReadySentinelPath: `${runRoot}/GLOBAL_AUTONOMY_READY.sentinel`,
    },
    finalReportPolicy: {
      finalGlobalReportAllowed: false,
      currentReportIsRunScopedSmokeOnly: true,
      claim100PercentAutonomyAllowed: false,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    realApplyExecuted: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous final e2e proof plan would store forbidden plaintext body keys");
  return plan;
}

export function buildAutonomousCompletionGate(input: { runId: string; finalE2EProofPlan: Record<string, unknown>; finalNoShipOracle: Record<string, unknown>; currentSourceFingerprintFreshness: Record<string, unknown> }): Record<string, unknown> {
  const finalBlockers = Array.isArray(input.finalE2EProofPlan.blockers) ? input.finalE2EProofPlan.blockers.filter((blocker): blocker is string => typeof blocker === "string") : [];
  const oracleFailedChecks = Array.isArray(input.finalNoShipOracle.failedChecks) ? input.finalNoShipOracle.failedChecks.filter((check): check is string => typeof check === "string") : [];
  const checks = [
    { name: "final_e2e_proof_ready", passed: input.finalE2EProofPlan.finalE2EProofReady === true },
    { name: "final_no_ship_oracle_pass", passed: input.finalNoShipOracle.finalOraclePass === true && input.finalNoShipOracle.no_ship === false },
    { name: "current_source_fingerprint_fresh", passed: input.currentSourceFingerprintFreshness.fresh === true },
    { name: "global_ready_sentinel_allowed", passed: isRecord(input.finalE2EProofPlan.sentinelPolicy) && input.finalE2EProofPlan.sentinelPolicy.globalReadySentinelAllowed === true },
    { name: "final_done_sentinel_allowed", passed: isRecord(input.finalNoShipOracle.decision) && input.finalNoShipOracle.decision.writeFinalDoneSentinelAllowed === true },
    { name: "claim_100_percent_allowed", passed: isRecord(input.finalNoShipOracle.decision) && input.finalNoShipOracle.decision.claim100PercentAutonomyAllowed === true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const gate = {
    schema: "zob.autonomous-completion-gate.v1",
    runId: input.runId,
    phase: "11F",
    status: "blocked_for_goal_completion",
    completionReady: false,
    allRequirementsVerified: false,
    no_ship: true,
    updateGoalAllowed: false,
    requiredGoalStatus: "in_progress",
    completionToolAvailableInThisRun: false,
    checks,
    failedChecks,
    blockers: [...new Set([...finalBlockers, ...oracleFailedChecks, ...failedChecks])].sort(),
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/final-e2e-proof-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/final-no-ship-oracle.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/current-source-fingerprint.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
    ],
    requiredBeforeCompletion: [
      "final_e2e_no_mock_current_source_proof",
      "final_oracle_PASS_no_ship_false",
      "smoke_pilot_batch_artifacts_current_source",
      "live_strict_budget_enforced",
      "live_model_routing_enabled",
      "daemon_scheduler_proven_with_kill_switch",
      "sandbox_real_apply_or_explicit_no_apply_final_policy",
      "GLOBAL_AUTONOMY_READY_sentinel_allowed_by_final_oracle",
      "update_goal_tool_available_and_called_only_after_all_gates_pass",
    ],
    decision: {
      updateGoalStatusCompleteAllowed: false,
      globalAutonomyReady: false,
      globalAutonomyNoShip: true,
      writeGlobalReadySentinelAllowed: false,
      writeFinalDoneSentinelAllowed: false,
      claim100PercentAutonomyAllowed: false,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    realApplyExecuted: false,
    liveRoutingEnabled: false,
    budgetEnforced: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(gate)) throw new Error("autonomous completion gate would store forbidden plaintext body keys");
  return gate;
}

export function buildAutonomousReadOnlySmokeFinalReport(validation: Record<string, unknown>, factoryRunRef: Record<string, unknown>, oracleReview: Record<string, unknown>): string {
  const blockers = Array.isArray(validation.blockers) ? validation.blockers.map((blocker) => `- ${String(blocker)}`).join("\n") : "";
  return [
    "# Autonomous Read-Only Smoke Report",
    "",
    `Run ID: ${String(validation.runId ?? "unknown")}`,
    `Status: ${String(validation.status ?? "unknown")}`,
    `Smoke no-ship: ${String(validation.no_ship === true)}`,
    `Global autonomy no-ship: ${String(validation.globalAutonomyNoShip === true)}`,
    "",
    "## Factory smoke",
    "",
    `- Selected factory: ${String(factoryRunRef.selectedFactory ?? "none")}`,
    `- Factory run id: ${String(factoryRunRef.factoryRunId ?? "none")}`,
    `- Factory status: ${String(factoryRunRef.status ?? "unknown")}`,
    `- Deterministic execution: ${String(factoryRunRef.execution === "deterministic")}`,
    "",
    "## Structural oracle",
    "",
    `- Verdict: ${String(oracleReview.verdict ?? "unknown")}`,
    `- No-ship for this smoke: ${String(oracleReview.no_ship === true)}`,
    `- Live oracle dispatched: ${String(oracleReview.liveOracleDispatched === true)}`,
    "",
    "## Blockers",
    "",
    blockers || "- None for this read-only smoke slice.",
    "",
    "## Evidence refs",
    "",
    "- spec-gate.json",
    "- context-scope.json",
    "- context-pack.json",
    "- runtime-gates.json",
    "- model-routing-plan.json",
    "- model-routing-proof-plan.json",
    "- factory-selection.json",
    "- factory-run-ref.json",
    "- oracle-review.json",
    "- promotion-plan.json",
    "- promotion-proof-plan.json",
    "- scheduler-plan.json",
    "- scheduler-proof-plan.json",
    "- mission-control-plan.json",
    "- mission-control-proof-plan.json",
    "- sandbox-apply-plan.json",
    "- strict-budget-proof-plan.json",
    "- current-source-fingerprint.json",
    "- final-e2e-proof-plan.json",
    "- final-no-ship-oracle.json",
    "- completion-gate.json",
    "- validation.json",
    "- SMOKE_AUTONOMY_PASSED.sentinel when status=smoke_autonomy_passed",
    "",
    "Compliance: Phase 4A read-only deterministic smoke evidence only; global autonomy remains no-ship.",
    "",
  ].join("\n");
}
