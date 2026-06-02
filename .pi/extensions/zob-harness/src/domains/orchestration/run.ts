import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveComputeProfile } from "../compute/compute-profile.js";
import { SUPERVISED_SMOKE_CHILD_TOOLS } from "../../core/constants.js";
import type { OrchestrateExecutionMode, OrchestrateRunInput, OrchestrateRunResult, TeamDefinition } from "../../types.js";
import { mirrorOrchestrationToComs } from "../topology/coms.js";
import { loadOrchestrationProfile, teamDefinitionFromOrchestrationProfile, validateOrchestrateRunInputs } from "../topology/orchestration-profiles.js";
import { loadTeamDefinition } from "../topology/teams.js";
import { sha256 } from "../../core/utils/hashing.js";
import { safeRunId } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import { buildInitialAdaptiveDelegationGovernorState, normalizeAdaptiveDelegationPolicy } from "./adaptive-delegation.js";
import { writeAdaptiveWorkflowArtifacts } from "./adaptive-workflow.js";
import { buildOrchestrationPlan, redactBodyLikeFieldsForPersistence, redactOrchestrationPlanForPersistence } from "./plan.js";
import { buildOrchestrationMessages, buildOrchestrationStatuses, orchestrationLedger, writeOrchestrationMessages, writeOrchestrationRoomArtifacts, writeOrchestrationStatuses } from "./room.js";

export function runOrchestrateRun(repoRoot: string, input: OrchestrateRunInput): OrchestrateRunResult {
  const errors = validateOrchestrateRunInputs(repoRoot, input);
  const runId = safeRunId(input.run_id, "orchestrate");
  const runDir = join(repoRoot, "reports", "orchestrations", runId);
  if (existsSync(runDir) && !input.resume) errors.push(`Orchestration run directory already exists. Use resume=true or choose another run_id: ${runDir}`);
  if (errors.length > 0) return { runId, runDir, status: "failed_preflight", tasks: 0, artifacts: [], errors };

  mkdirSync(runDir, { recursive: true });
  const sentinelPath = join(runDir, "DONE.sentinel");
  if (existsSync(sentinelPath)) unlinkSync(sentinelPath);
  const profile = input.profile ? loadOrchestrationProfile(repoRoot, input.profile) : undefined;
  const team = input.profile ? undefined : loadTeamDefinition(repoRoot, input.team ?? "zob-core");
  const definition = profile?.definition ? teamDefinitionFromOrchestrationProfile(profile.definition) : team?.definition as TeamDefinition;
  const execution: OrchestrateExecutionMode = input.execution ?? "plan_only";
  const adaptiveDelegation = normalizeAdaptiveDelegationPolicy(input.adaptive_delegation);
  const computeProfile = resolveComputeProfile(repoRoot, {
    runId,
    domain: "orchestration",
    requestedProfile: input.compute_profile ?? "auto",
    targetPath: ".pi/teams",
    taskHash: sha256(input.original_user_ask ?? input.goal),
    computeCaps: input.compute_caps,
    riskHints: execution === "supervised_readonly" ? ["durable"] : [],
  });
  const originalUserAsk = input.original_user_ask ?? input.goal;
  const persistedInput = adaptiveDelegation.enabled || input.compute_profile || input.compute_caps ? { ...input, adaptive_delegation: adaptiveDelegation, compute_profile_resolution: computeProfile } : input;
  const plan = buildOrchestrationPlan(definition, input, { runId, runDir, execution });
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.length : 0;
  const adaptiveArtifacts = adaptiveDelegation.enabled ? ["adaptive-delegation-policy.json", "delegation-governor-state.json", "delegation-requests.json", "delegation-decisions.json", "delegation-oracle-decisions.json", "delegation-dispatches.json", "adaptive-delegation-summary.md"] : [];
  const adaptiveWorkflow = writeAdaptiveWorkflowArtifacts({ repoRoot, runDir, runId, definition, profileDefinition: profile?.definition, input, computeProfile, adaptiveDelegation, execution, goal: input.goal, originalUserAsk });
  const adaptiveWorkflowArtifacts = adaptiveWorkflow.artifacts;

  const redactPersistentBodies = execution === "supervised_readonly" || input.profile === "adaptive-chief-vision";
  const manifest = { team: definition, input: persistedInput, sourceTeamPath: team?.teamPath, sourceProfilePath: profile?.profilePath, execution, computeProfile, adaptiveWorkflow: adaptiveWorkflow.context };
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(redactPersistentBodies ? redactBodyLikeFieldsForPersistence(manifest) : manifest, null, 2), "utf8");
  writeFileSync(join(runDir, "compute-profile-resolution.json"), JSON.stringify(computeProfile, null, 2), "utf8");
  const persistedPlan = redactPersistentBodies ? redactOrchestrationPlanForPersistence(plan) : plan;
  writeFileSync(join(runDir, "orchestration-plan.json"), JSON.stringify(persistedPlan, null, 2), "utf8");
  const messages = buildOrchestrationMessages(definition, plan, runId, execution);
  const statuses = buildOrchestrationStatuses(messages, runId, execution);
  writeOrchestrationMessages(runDir, messages);
  writeOrchestrationStatuses(runDir, statuses, runId, execution);
  const comsMirrored = mirrorOrchestrationToComs(repoRoot, definition, messages);
  if (adaptiveDelegation.enabled) {
    const rootGoalHash = sha256(originalUserAsk);
    const governorState = buildInitialAdaptiveDelegationGovernorState({ runId, rootGoalHash, policy: adaptiveDelegation });
    writeFileSync(join(runDir, "adaptive-delegation-policy.json"), JSON.stringify(adaptiveDelegation, null, 2), "utf8");
    writeFileSync(join(runDir, "delegation-governor-state.json"), JSON.stringify(governorState, null, 2), "utf8");
    writeFileSync(join(runDir, "delegation-requests.json"), JSON.stringify({ schema: "zob.delegation-request-set.v1", runId, requests: [], bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
    writeFileSync(join(runDir, "delegation-decisions.json"), JSON.stringify({ schema: "zob.governor-decision-set.v1", runId, decisions: [], bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
    writeFileSync(join(runDir, "delegation-oracle-decisions.json"), JSON.stringify({ schema: "zob.delegation-oracle-decision-set.v1", runId, oracleRequired: 0, decisions: [], liveOracleDispatched: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
    writeFileSync(join(runDir, "delegation-dispatches.json"), JSON.stringify({ schema: "zob.parent-dispatch-contract-set.v1", runId, dispatches: [], dispatchContractsQueued: 0, liveDispatches: 0, adaptiveLiveDispatchEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
    writeFileSync(join(runDir, "adaptive-delegation-summary.md"), [`# Adaptive Delegation Summary`, ``, `- runId: ${runId}`, `- enabled: ${adaptiveDelegation.enabled}`, `- mode: ${adaptiveDelegation.mode}`, `- dispatch: ${adaptiveDelegation.dispatch}`, `- configuredMaxDepth: ${adaptiveDelegation.configuredMaxDepth}`, `- runtimeMaxDepth: ${adaptiveDelegation.runtimeMaxDepth}`, `- parent_owned_dispatch: ${adaptiveDelegation.parentOwnedDispatch}`, `- child_direct_dispatch: ${adaptiveDelegation.childDirectDispatch}`, `- live_dispatches: 0`, `- sentinel: not written`, ``].join("\n"), "utf8");
  }
  const roomArtifacts = writeOrchestrationRoomArtifacts({ runDir, runId, definition, plan: persistedPlan, messages, statuses, execution, goal: input.goal, originalUserAsk, goalId: input.goal_id, rootTodoId: input.todo_id, comsMirrored, adaptiveWorkflow: adaptiveWorkflow.context });
  orchestrationLedger(runDir, { event: "initialized", runId, team: definition.name, execution });
  orchestrationLedger(runDir, { event: "team_loaded", leads: definition.leads.length, workers: definition.workers.length });
  orchestrationLedger(runDir, { event: "plan_written", tasks, execution, noExecution: true });
  orchestrationLedger(runDir, { event: "messages_written", messages: messages.length, execution, noExecution: true });
  orchestrationLedger(runDir, { event: "status_written", statuses: statuses.length, running: 0, execution, noExecution: true });
  orchestrationLedger(runDir, { event: "coms_mirrored", messages: comsMirrored, path: ".pi/coms/messages.jsonl", execution, noExecution: true });
  orchestrationLedger(runDir, { event: "room_written", artifacts: roomArtifacts.artifacts, path: "room/", execution, noExecution: true });
  if (adaptiveDelegation.enabled) orchestrationLedger(runDir, { event: "adaptive_delegation_policy_written", artifacts: adaptiveArtifacts, execution, noExecution: true, dispatch: adaptiveDelegation.dispatch });

  const supervisedSmoke = execution === "supervised_smoke" ? {
    schema: "zob.orchestration-supervised-smoke.v1",
    mode: "read_only",
    parentOwnedPreflight: true,
    parentOwnedDispatch: true,
    workerSpawnsWorker: false,
    allowedTools: [...SUPERVISED_SMOKE_CHILD_TOOLS],
    blockedTools: ["bash", "edit", "write", "delegate_agent", "delegate_task", "orchestrate_run", "factory_run", "factory_quarantine_review", "factory_quarantine_activate", "factory_quarantine_verify_activation"],
    liveChildExecution: false,
    modelRouterUsed: false,
    budgetEnforced: false,
    finalGate: {
      status: "planned_not_executed",
      passed: false,
      reason: "supervised_smoke records parent-owned read-only execution metadata without live child/model execution in smoke validation",
      requiresLiveChildEvidence: true,
    },
  } : undefined;

  const validation = {
    runId,
    team: definition.name,
    execution,
    status: "planned",
    noExecution: true,
    tasks,
    messages: messages.length,
    statuses: statuses.length,
    comsMirrored,
    artifactsPresent: ["manifest.json", "ledger.jsonl", "compute-profile-resolution.json", "orchestration-plan.json", "messages.jsonl", "status.jsonl", "status-snapshot.json", ...adaptiveWorkflowArtifacts, "room/room.json", "room/context-pack.json", "room/evidence-index.json", "final-report.md"].map((artifact) => ({ artifact, exists: artifact === "final-report.md" ? false : existsSync(join(runDir, artifact)) })),
    roomArtifactsPresent: roomArtifacts.artifacts.map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) })),
    room: { schema: "zob.room.v1", path: "room/", contextPack: "room/context-pack.json", evidenceIndex: "room/evidence-index.json", promptBodiesStored: false, outputBodiesStored: false },
    invariants: isRecord(plan.invariants) ? plan.invariants : {},
    todoGraphBinding: input.todo_id ? { goalId: input.goal_id, rootTodoId: input.todo_id, parentOwned: true, bodyStored: false } : undefined,
    supervisedSmoke,
    computeProfile,
    adaptiveDelegation: adaptiveDelegation.enabled ? { schema: "zob.adaptive-delegation-validation.v1", enabled: true, mode: adaptiveDelegation.mode, dispatch: adaptiveDelegation.dispatch, recordDecisionsOnly: adaptiveDelegation.recordDecisionsOnly, configuredMaxDepth: adaptiveDelegation.configuredMaxDepth, runtimeMaxDepth: adaptiveDelegation.runtimeMaxDepth, parentOwnedDispatch: true, childDirectDispatch: false, liveDispatches: 0, advisoryOnly: adaptiveDelegation.dispatch === false, artifacts: adaptiveArtifacts, noExecution: true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false } : { enabled: false },
    adaptiveWorkflow: adaptiveWorkflow.validationSummary,
    budgetEnforced: false,
    modelRouterUsed: false,
    sentinelWritten: existsSync(join(runDir, "DONE.sentinel")),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  writeFileSync(join(runDir, "validation.json"), JSON.stringify(validation, null, 2), "utf8");
  writeFileSync(join(runDir, "final-report.md"), [`# Orchestration Run Report`, ``, `- runId: ${runId}`, `- team: ${definition.name}`, `- status: planned`, `- execution: ${execution}`, `- tasks: ${tasks}`, `- messages: ${messages.length}`, `- statuses: ${statuses.length}`, `- coms_mirrored: ${comsMirrored}`, `- room: room/context-pack.json`, `- running: 0`, `- child_agents_executed: no`, `- supervised_smoke_read_only: ${execution === "supervised_smoke" ? "yes" : "n/a"}`, `- supervised_readonly: ${execution === "supervised_readonly" ? "yes" : "n/a"}`, `- sentinel: not written`, ``].join("\n"), "utf8");
  const finalValidation = { ...validation, artifactsPresent: ["manifest.json", "ledger.jsonl", "compute-profile-resolution.json", "orchestration-plan.json", "messages.jsonl", "status.jsonl", "status-snapshot.json", ...adaptiveWorkflowArtifacts, "room/room.json", "room/messages.jsonl", "room/status.jsonl", "room/decisions.jsonl", "room/blockers.jsonl", "room/context-pack.json", "room/evidence-index.json", ...adaptiveArtifacts, "validation.json", "final-report.md"].map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) })) };
  writeFileSync(join(runDir, "validation.json"), JSON.stringify(finalValidation, null, 2), "utf8");
  orchestrationLedger(runDir, { event: "planned", tasks, sentinel: "not written" });

  return { runId, runDir, status: "planned", tasks, artifacts: ["manifest.json", "ledger.jsonl", "compute-profile-resolution.json", "orchestration-plan.json", "messages.jsonl", "status.jsonl", "status-snapshot.json", ...adaptiveWorkflowArtifacts, ...roomArtifacts.artifacts, ...adaptiveArtifacts, "validation.json", "final-report.md"], errors: [] };
}
