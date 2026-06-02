import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SUPERVISED_READONLY_CHILD_TOOLS } from "../../core/constants.js";
import { ackZobComsMessage, appendZobComsMessage, getZobComsMessage, listZobComsMessages, replyZobComsMessage, transitionZobComsStatus } from "../topology/coms.js";
import type { AdaptiveDelegationGovernorState, AdaptiveDelegationPolicy, DelegationRequestProposal, GovernorDecision, OrchestrateRunInput, ParentDispatchContract, SupervisedReadonlyDispatcher, SupervisedReadonlyDispatchResult, TeamDefinition } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { parseJsonFile, readJsonl, readJsonObjectIfPresent } from "../../core/utils/json.js";
import { safeRunId } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import {
  ADAPTIVE_DELEGATION_HARD_MAX_DEPTH,
  buildInitialAdaptiveDelegationGovernorState,
  buildParentDispatchContractForDecision,
  decideDelegationRequest,
  extractDelegationRequestsFromText,
  normalizeAdaptiveDelegationPolicy,
  updateGovernorState,
} from "./adaptive-delegation.js";
import { extractLeadPlanWorkerContracts, redactLeadPlanWorkerContractsForPersistence, validateLeadPlanWorkerContracts } from "./lead-plan.js";
import { buildOrchestrationPlan, redactOrchestrationPlanForPersistence } from "./plan.js";
import { runOrchestrateRun } from "./run.js";
import { orchestrationLedger, writeOrchestrationRoomArtifacts, writeOrchestrationStatuses } from "./room.js";
import { loadOrchestrationProfile, teamDefinitionFromOrchestrationProfile } from "../topology/orchestration-profiles.js";
import { loadTeamDefinition } from "../topology/teams.js";

function assertSupervisedReadonlyTools(task: Record<string, unknown>): string[] {
  const tools = Array.isArray(task.required_tools) ? task.required_tools.filter((tool): tool is string => typeof tool === "string") : [];
  const allowed = new Set<string>(SUPERVISED_READONLY_CHILD_TOOLS);
  return tools.filter((tool) => !allowed.has(tool));
}

function ensureSupervisedReadonlyComsMessage(repoRoot: string, definition: TeamDefinition, input: { runId: string; sender: string; receiver: string; taskId: string; taskHash?: string; status?: string }): string {
  const existing = listZobComsMessages(repoRoot, { runId: input.runId, sender: input.sender, receiver: input.receiver, limit: 100 }).find((candidate) => candidate.taskId === input.taskId);
  if (typeof existing?.msgId === "string" && getZobComsMessage(repoRoot, existing.msgId)) return existing.msgId;
  const message = appendZobComsMessage(repoRoot, definition, {
    runId: input.runId,
    sender: input.sender,
    receiver: input.receiver,
    kind: "supervised_readonly_handoff_ref",
    taskId: input.taskId,
    taskHash: input.taskHash,
    status: input.status ?? "planned",
    metadata: { schema: "zob.supervised-readonly-handoff-ref.v1", recovered: true, execution: "supervised_readonly", bodyStored: false, promptBodiesStored: false, outputBodiesStored: false },
  });
  return typeof message.msgId === "string" ? message.msgId : `${input.runId}:${input.sender}:${input.receiver}:${input.taskId}`;
}

type AdaptiveComsRef = {
  sender: string;
  receiver: string;
  kind: string;
  taskId: string;
  taskHash?: string;
  outputHash?: string | null;
  status: string;
  metadata: Record<string, unknown>;
  sourceTaskId?: string;
};

function adaptiveComsRefMsgId(runId: string, ref: AdaptiveComsRef): string {
  return `${runId}:${ref.sender}:${ref.receiver}:${ref.taskId}`;
}

function appendAdaptiveComsRef(repoRoot: string, definition: TeamDefinition, runId: string, ref: AdaptiveComsRef): Record<string, unknown> {
  return appendZobComsMessage(repoRoot, definition, {
    runId,
    sender: ref.sender,
    receiver: ref.receiver,
    kind: ref.kind,
    taskId: ref.taskId,
    taskHash: ref.taskHash,
    outputHash: ref.outputHash,
    status: ref.status,
    metadata: ref.metadata,
  });
}

function ensureAdaptiveComsRefs(repoRoot: string, definition: TeamDefinition, runId: string, refs: AdaptiveComsRef[], errors: Array<Record<string, unknown>>): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = adaptiveComsRefMsgId(runId, ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (getZobComsMessage(repoRoot, key)) continue;
    try {
      appendAdaptiveComsRef(repoRoot, definition, runId, ref);
    } catch (error) {
      errors.push({ sourceTaskId: ref.sourceTaskId ?? ref.taskId, errorHash: sha256(error instanceof Error ? error.message : String(error)), kind: "adaptive_coms_ref_recovery_failed", bodyStored: false });
    }
  }
}

function buildAdaptiveReadonlyTaskText(input: { requestId: string; request: DelegationRequestProposal }): string {
  const evidence = input.request.evidenceRefs.join(", ");
  const targets = (input.request.targetFileSet ?? input.request.evidenceRefs).join(", ");
  return [
    "Parent-owned adaptive read-only dispatch.",
    `Request id: ${input.requestId}.`,
    `Agent: ${input.request.requestedAgent}.`,
    `Output contract: ${input.request.requestedOutputContract}.`,
    `Evidence refs: ${evidence}.`,
    `Target files: ${targets}.`,
    "Use only read-only tools. Do not delegate. Do not write files. Do not access secrets.",
  ].join("\n");
}

function buildAdaptiveProposalGuidance(input: { policy: AdaptiveDelegationPolicy; requesterDepth: number; requesterRole: string; referentRole: string }): string[] {
  if (!input.policy.enabled) return [];
  if (input.requesterDepth >= input.policy.runtimeMaxDepth) {
    return [
      "Adaptive delegation guidance: do not propose further adaptive delegation from this task because requesterDepth is at or beyond runtimeMaxDepth.",
      "Never dispatch children yourself; only the parent/governor may validate and dispatch.",
    ];
  }
  return [
    "Adaptive delegation guidance: if additional read-only help is materially useful, propose it only as metadata inside <delegation_requests>{\"requests\":[...]}</delegation_requests>.",
    `Use requesterRole '${input.requesterRole}', referentRole '${input.referentRole}', requesterDepth ${input.requesterDepth}, and targetDepth ${input.requesterDepth + 1}. targetDepth must be <= ${input.policy.runtimeMaxDepth}.`,
    "Allowed proposal fields: requesterRole, referentRole, requestedAgent, requestedOutputContract, requiredTools, requesterDepth, targetDepth, ttlRequested, evidenceRefs, targetFileSet, estimatedTokensIfAlone, estimatedTokensWithDelegation, estimatedCostUsd, estimatedDurationMs, estimatedSuccessIfAlone, estimatedSuccessWithDelegation, risk, proposedTaskHash, proposedContextHash, rationaleHash.",
    "Never include plaintext body/task/context/prompt/output/content/patch/diff/messages/transcript fields in delegation_requests. Omit *Hash fields unless you already have lowercase sha256 hex values.",
    "Required tools in proposed requests must be read-only and within read, grep, find, ls. Do not request delegation/write tools. Parent/governor computes score, request id, lineage, and dispatch decision; child-provided score or lineage is ignored.",
    "Do not dispatch children yourself; only the parent may dispatch approved adaptive requests.",
  ];
}

function withAdaptiveProposalGuidance(input: { context: string; mustDo: string[]; mustNotDo: string[]; policy: AdaptiveDelegationPolicy; requesterDepth: number; requesterRole: string; referentRole: string }): { context: string; mustDo: string[]; mustNotDo: string[] } {
  const guidance = buildAdaptiveProposalGuidance(input);
  if (guidance.length === 0) return { context: input.context, mustDo: input.mustDo, mustNotDo: input.mustNotDo };
  return {
    context: [input.context, "", ...guidance].join("\n"),
    mustDo: [...input.mustDo, "When proposing adaptive delegation, use only hash/metadata-only <delegation_requests> and cite evidenceRefs"],
    mustNotDo: [...input.mustNotDo, "Do not include plaintext task/context/prompt/output/body/content/diff/patch fields in adaptive delegation proposals", "Do not directly dispatch child agents"],
  };
}

function parseAdaptiveOracleOutput(output: string | undefined): { verdict: "PASS" | "WARN" | "FAIL" | "UNKNOWN"; noShip: boolean; verdictHash: string; bodyStored: false; promptBodiesStored: false; outputBodiesStored: false } {
  const text = output ?? "";
  const verdictMatch = text.match(/<verdict>\s*(PASS|WARN|FAIL)\s*<\/verdict>/i) ?? text.match(/\bverdict\s*[:=]\s*(PASS|WARN|FAIL)\b/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() as "PASS" | "WARN" | "FAIL" : "UNKNOWN";
  const noShipMatch = text.match(/<no_ship>\s*(true|false)\s*<\/no_ship>/i) ?? text.match(/\bno_ship\s*[:=]\s*(true|false)\b/i);
  const noShip = noShipMatch ? noShipMatch[1].toLowerCase() !== "false" : verdict !== "PASS";
  return { verdict, noShip, verdictHash: sha256(`${verdict}:${noShip}`), bodyStored: false, promptBodiesStored: false, outputBodiesStored: false };
}

function buildAdaptiveOracleTaskText(input: { requestId: string; request: DelegationRequestProposal; decision: GovernorDecision; policy?: AdaptiveDelegationPolicy }): string {
  return [
    "Review an adaptive delegation request before any parent dispatch.",
    `Request id: ${input.requestId}.`,
    `Requested agent: ${input.request.requestedAgent}.`,
    `Output contract: ${input.request.requestedOutputContract}.`,
    `Required tools: ${input.request.requiredTools.join(", ")}.`,
    `Requester depth: ${input.request.requesterDepth}; target depth: ${input.request.targetDepth}.`,
    `Active policy runtimeMaxDepth: ${input.policy?.runtimeMaxDepth ?? "unknown"}; configuredMaxDepth: ${input.policy?.configuredMaxDepth ?? "unknown"}; strictBudgetRequired: ${input.policy?.strictBudgetRequired ?? "unknown"}; parentOwnedDispatch: true; childDirectDispatch: false.`,
    `Governor hard gate status: ${input.decision.hardGateStatus}; hard gate errors: ${input.decision.hardGateErrors.join(", ") || "none"}; ttlRemaining: ${input.decision.ttlRemaining}.`,
    `Risk: ${input.request.risk}.`,
    `Evidence refs: ${input.request.evidenceRefs.join(", ")}.`,
    `Parent score: ${input.decision.score?.total ?? "unknown"}.`,
    "Return oracle.v1 with <verdict>PASS|WARN|FAIL</verdict> and <no_ship>true|false</no_ship>.",
    "PASS/no_ship=false means the parent may dispatch this read-only adaptive request. WARN/FAIL/no_ship=true blocks dispatch.",
    "PASS criteria: hard gates passed, requested tools are read/grep/find/ls only, evidenceRefs are repo-relative and non-secret, targetDepth is within runtimeMaxDepth, requested agent/output contract are valid, and the extra read-only exploration is plausibly useful.",
    "Do not fail solely because raw child task/context bodies are not present; this system intentionally persists only hashes and metadata. Fail or WARN if the metadata itself is unsafe, ambiguous, missing evidence, or expands scope.",
    "Do not request writes, do not access secrets, and do not dispatch children.",
  ].join("\n");
}

function buildAdaptiveOracleContext(input: { requestId: string; request: DelegationRequestProposal; decision: GovernorDecision; policy?: AdaptiveDelegationPolicy }): string {
  return [
    `Parent governor marked adaptive request ${input.requestId} as oracle_required.`,
    `Lineage hash: ${input.decision.parentComputedLineageHash}.`,
    `Normalized task hash: ${input.decision.parentComputedNormalizedTaskHash}.`,
    `Reasons hash: ${sha256(input.decision.reasons.join("\n"))}.`,
    `Hard gate status: ${input.decision.hardGateStatus}.`,
    `Hard gate errors: ${input.decision.hardGateErrors.join(", ") || "none"}.`,
    `TTL remaining: ${input.decision.ttlRemaining}.`,
    `Active runtimeMaxDepth: ${input.policy?.runtimeMaxDepth ?? "unknown"}.`,
    `Active configuredMaxDepth: ${input.policy?.configuredMaxDepth ?? "unknown"}.`,
    `Strict budget required: ${input.policy?.strictBudgetRequired ?? "unknown"}.`,
    `Evidence refs: ${input.request.evidenceRefs.join(", ")}.`,
    "Review only the metadata and cited evidence. Raw child bodies are intentionally not persisted.",
  ].join("\n");
}

function buildAdaptiveReadonlyContext(input: { requestId: string; request: DelegationRequestProposal; decision: GovernorDecision; policy?: AdaptiveDelegationPolicy }): string {
  return [
    `Adaptive request ${input.requestId} was approved by the parent governor.`,
    `Parent-computed lineage hash: ${input.decision.parentComputedLineageHash}.`,
    `Parent-computed normalized task hash: ${input.decision.parentComputedNormalizedTaskHash}.`,
    `Evidence refs: ${input.request.evidenceRefs.join(", ")}.`,
    `Target files: ${(input.request.targetFileSet ?? input.request.evidenceRefs).join(", ")}.`,
    `Parent-provided estimate successIfAlone: ${input.request.estimatedSuccessIfAlone ?? "unknown"}; successWithDelegation: ${input.request.estimatedSuccessWithDelegation ?? "unknown"}.`,
    `Parent-provided estimate tokensIfAlone: ${input.request.estimatedTokensIfAlone ?? "unknown"}; tokensWithDelegation: ${input.request.estimatedTokensWithDelegation ?? "unknown"}.`,
    "Use parent-provided estimates as metadata when deciding whether one further read-only proposal is materially useful; do not invent bodies or dispatch children.",
    "Return only the requested output contract with citations/evidence and compliance.",
    ...(input.policy ? buildAdaptiveProposalGuidance({ policy: input.policy, requesterDepth: input.request.targetDepth, requesterRole: input.request.requesterRole, referentRole: input.request.referentRole }) : []),
  ].join("\n");
}

function buildSupervisedReadonlyStatus(message: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "zob.orchestration-status.v1",
    event: "supervised_readonly_status",
    runId: typeof message.runId === "string" ? message.runId : "unknown-run",
    msgId: typeof message.msgId === "string" ? message.msgId : "unknown-message",
    parentId: typeof message.parentId === "string" ? message.parentId : "unknown-parent",
    sender: typeof message.sender === "string" ? message.sender : "unknown-sender",
    receiver: typeof message.receiver === "string" ? message.receiver : "unknown-receiver",
    receiverAgent: typeof message.receiverAgent === "string" ? message.receiverAgent : "unknown-agent",
    role: typeof message.role === "string" ? message.role : "unknown-role",
    taskId: typeof message.taskId === "string" ? message.taskId : "unknown-task",
    taskHash: typeof message.taskHash === "string" ? message.taskHash : "",
    outputHash: null,
    status: "running",
    ack: "received",
    ping: "running",
    running: true,
    startedAt: new Date().toISOString(),
    lastPingAt: new Date().toISOString(),
    lastAckAt: new Date().toISOString(),
    completedAt: null,
    execution: "supervised_readonly",
    noExecution: false,
    supervisedReadonly: { parentOwnedDispatch: true, allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS] },
    timestamp: new Date().toISOString(),
    ...patch,
  };
}

type SupervisedReadonlyNoMockFinalGate = {
  status: "passed_live_no_mock" | "not_ready";
  passed: boolean;
  no_ship: boolean;
  requiresLiveChildEvidence: true;
  requiresNoMocks: true;
  reason: string;
  liveChildExecution: boolean;
  mockedDispatches: number;
  liveDispatches: number;
  outputContractsValidated: boolean;
  childSessionPaths: number;
  profileDynamicRequired?: boolean;
  profileDynamicReady?: boolean;
  dynamicWorkerDispatches?: number;
};

export function buildSupervisedReadonlyRuntimeInvariants(priorInvariants: Record<string, unknown>, input: { liveDispatches: number; noMockReady: boolean }): Record<string, unknown> {
  return {
    ...priorInvariants,
    liveChildExecution: input.liveDispatches > 0,
    noMockReady: input.noMockReady,
  };
}

export function buildSupervisedReadonlyNoMockFinalGate(input: {
  finalStatus: string;
  dispatched: number;
  completed: number;
  failed: number;
  liveDispatches: number;
  mockedDispatches: number;
  outputContractsValidated: number;
  childSessionPaths: number;
  profileDynamicRequired?: boolean;
  profileDynamicReady?: boolean;
  dynamicWorkerDispatches?: number;
}): { noMockReady: boolean; finalGate: SupervisedReadonlyNoMockFinalGate } {
  const profileDynamicSatisfied = input.profileDynamicRequired !== true || input.profileDynamicReady === true;
  const noMockReady = input.finalStatus === "completed"
    && input.dispatched > 0
    && input.completed === input.dispatched
    && input.failed === 0
    && input.liveDispatches === input.dispatched
    && input.mockedDispatches === 0
    && input.outputContractsValidated === input.dispatched
    && input.childSessionPaths === input.liveDispatches
    && profileDynamicSatisfied;
  const reason = noMockReady
    ? "all dispatched workers completed through live_child_pi with output contracts validated and child sessions recorded"
    : input.failed > 0
      ? "one or more supervised_readonly dispatches failed"
      : input.profileDynamicRequired === true && input.profileDynamicReady !== true
        ? "profile dynamic worker dispatch evidence is missing or incomplete"
      : input.mockedDispatches > 0
        ? "mocked dispatches were observed; live_child_pi evidence is required for readiness"
        : input.liveDispatches === 0
          ? "no live_child_pi dispatches were recorded"
          : input.outputContractsValidated !== input.dispatched
            ? "not all dispatched child outputs passed output-contract validation"
            : input.childSessionPaths !== input.liveDispatches
              ? "live child session paths are missing"
              : "dispatcher lifecycle is incomplete for no-mock readiness";

  return {
    noMockReady,
    finalGate: {
      status: noMockReady ? "passed_live_no_mock" : "not_ready",
      passed: noMockReady,
      no_ship: !noMockReady,
      requiresLiveChildEvidence: true,
      requiresNoMocks: true,
      reason,
      liveChildExecution: input.liveDispatches > 0,
      mockedDispatches: input.mockedDispatches,
      liveDispatches: input.liveDispatches,
      outputContractsValidated: input.outputContractsValidated === input.dispatched && input.dispatched > 0,
      childSessionPaths: input.childSessionPaths,
      profileDynamicRequired: input.profileDynamicRequired,
      profileDynamicReady: input.profileDynamicReady,
      dynamicWorkerDispatches: input.dynamicWorkerDispatches,
    },
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function existingAdaptiveResumeResult(repoRoot: string, input: OrchestrateRunInput): Record<string, unknown> | undefined {
  if (input.resume !== true || input.adaptive_delegation?.enabled !== true) return undefined;
  const runId = safeRunId(input.run_id, "orchestrate");
  const runDir = join(repoRoot, "reports", "orchestrations", runId);
  if (!existsSync(runDir)) return undefined;
  const validation = readJsonObjectIfPresent(join(runDir, "validation.json"));
  const dispatches = readJsonObjectIfPresent(join(runDir, "delegation-dispatches.json"));
  const supervised = isRecord(validation?.supervisedReadonly) ? validation.supervisedReadonly : {};
  const adaptive = isRecord(validation?.adaptiveDelegation) ? validation.adaptiveDelegation : {};
  const adaptiveDispatchesExecuted = Math.max(asNumber(adaptive.adaptiveDispatchesExecuted), asNumber(dispatches?.liveDispatches));
  const adaptiveCompleted = Math.max(asNumber(adaptive.adaptiveDispatchesCompleted), asNumber(dispatches?.completed));
  const priorCompleted = validation?.status === "completed" && adaptiveDispatchesExecuted > 0 && adaptiveCompleted === adaptiveDispatchesExecuted;
  if (!priorCompleted) {
    return {
      runId,
      runDir,
      status: "failed_preflight",
      tasks: 0,
      artifacts: [],
      errors: ["adaptive supervised_readonly resume is only allowed for completed runs with completed adaptive dispatch evidence; choose a fresh run_id"],
      dispatched: 0,
      completed: 0,
      failed: 0,
      resumed: false,
      skippedDispatch: true,
    };
  }
  const artifacts = Array.isArray(validation?.artifactsPresent)
    ? validation.artifactsPresent.map((artifact) => isRecord(artifact) && typeof artifact.artifact === "string" ? artifact.artifact : undefined).filter((artifact): artifact is string => typeof artifact === "string")
    : [];
  return {
    runId,
    runDir,
    status: "completed_resume",
    tasks: asNumber(validation?.tasks),
    artifacts,
    errors: [],
    dispatched: asNumber(supervised.dispatched),
    completed: asNumber(supervised.completed),
    failed: asNumber(supervised.failed),
    resumed: true,
    skippedDispatch: true,
    previousAdaptiveDispatches: adaptiveDispatchesExecuted,
    previousAdaptiveLiveChildPiDispatches: asNumber(adaptive.adaptiveLiveChildPiDispatches),
    previousAdaptiveMockedDispatches: asNumber(adaptive.adaptiveDispatchesMocked),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export async function runSupervisedReadonlyOrchestration(repoRoot: string, input: OrchestrateRunInput, dispatcher: SupervisedReadonlyDispatcher): Promise<Record<string, unknown>> {
  const resumeResult = existingAdaptiveResumeResult(repoRoot, input);
  if (resumeResult) return resumeResult;
  const run = runOrchestrateRun(repoRoot, { ...input, execution: "supervised_readonly" });
  if (run.status !== "planned") return { ...run, status: "failed_preflight", dispatched: 0, completed: 0, failed: 0 };

  const profile = input.profile ? loadOrchestrationProfile(repoRoot, input.profile) : undefined;
  const team = input.profile ? undefined : loadTeamDefinition(repoRoot, input.team ?? "zob-core");
  const definition = profile?.definition ? teamDefinitionFromOrchestrationProfile(profile.definition) : team?.definition as TeamDefinition;
  const plan = buildOrchestrationPlan(definition, { ...input, execution: "supervised_readonly" }, { runId: run.runId, runDir: run.runDir, execution: "supervised_readonly" });
  const adaptiveDelegation = normalizeAdaptiveDelegationPolicy(input.adaptive_delegation);
  const adaptiveRootGoalHash = sha256(input.original_user_ask ?? input.goal);
  let adaptiveGovernorState: AdaptiveDelegationGovernorState | undefined = adaptiveDelegation.enabled ? buildInitialAdaptiveDelegationGovernorState({ runId: run.runId, rootGoalHash: adaptiveRootGoalHash, policy: adaptiveDelegation }) : undefined;
  const adaptiveRequests: Array<Record<string, unknown>> = [];
  const adaptiveDecisions: GovernorDecision[] = [];
  const adaptiveDispatchContracts: ParentDispatchContract[] = [];
  const adaptiveDispatchQueue: Array<{ sourceTaskId: string; request: DelegationRequestProposal; decision: GovernorDecision; contract: ParentDispatchContract }> = [];
  const adaptiveOracleQueue: Array<{ sourceTaskId: string; request: DelegationRequestProposal; decision: GovernorDecision }> = [];
  const adaptiveOracleResults: Array<Record<string, unknown>> = [];
  const adaptiveExtractionErrors: Array<Record<string, unknown>> = [];
  let adaptiveOracleDispatchesExecuted = 0;
  let adaptiveOracleDispatchesCompleted = 0;
  let adaptiveOracleDispatchesFailed = 0;
  let adaptiveOracleDispatchesMocked = 0;
  let adaptiveOracleLiveChildPiDispatches = 0;
  let adaptiveOraclePasses = 0;
  let adaptiveOracleWarns = 0;
  let adaptiveOracleFails = 0;
  let adaptiveDispatchesExecuted = 0;
  let adaptiveDispatchesCompleted = 0;
  let adaptiveDispatchesFailed = 0;
  let adaptiveDispatchesMocked = 0;
  let adaptiveLiveChildPiDispatches = 0;
  const adaptiveSeenLineages = new Set<string>();
  const messages = readJsonl(join(run.runDir, "messages.jsonl"));
  const initialStatuses = readJsonl(join(run.runDir, "status.jsonl"));
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.filter(isRecord) : [];
  const taskById = new Map<string, Record<string, unknown>>(tasks.map((task) => [String(task.id ?? ""), task]));
  const dispatchLeadPlans = input.profile !== undefined;
  const leadPlanExtractions: Array<Record<string, unknown>> = [];
  const extractedWorkerContracts: Array<{ leadId: string; sourceTaskId: string; sourceMsgId: string; contract: ReturnType<typeof extractLeadPlanWorkerContracts>["contracts"][number] }> = [];
  const dynamicWorkerDispatches: Array<Record<string, unknown>> = [];
  const lifecycleStatuses: Array<Record<string, unknown>> = [];
  let dispatched = 0;
  let completed = 0;
  let failed = 0;
  let liveDispatches = 0;
  let mockedDispatches = 0;
  let outputContractsValidated = 0;
  const childSessionPaths: string[] = [];
  const dispatcherKinds = new Set<string>();
  const adaptiveComsRefs: AdaptiveComsRef[] = [];

  const recordAdaptiveDelegationProposals = (source: { taskId: string; requesterRole: string; referentRole: string; requesterDepth: number; output?: string }): void => {
    if (!adaptiveDelegation.enabled) return;
    const extraction = extractDelegationRequestsFromText(source.output ?? "");
    for (const error of extraction.errors) adaptiveExtractionErrors.push({ sourceTaskId: source.taskId, errorHash: sha256(error), bodyStored: false });
    for (const proposal of extraction.requests) {
      const request: DelegationRequestProposal = {
        ...proposal,
        requesterRole: source.requesterRole,
        referentRole: source.referentRole,
        requesterDepth: source.requesterDepth,
        targetDepth: Number.isInteger(proposal.targetDepth) ? proposal.targetDepth : source.requesterDepth + 1,
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
      };
      const fanoutForRequester = adaptiveGovernorState?.fanoutByRequester[request.requesterRole] ?? 0;
      const decision = decideDelegationRequest({ repoRoot, runId: run.runId, rootGoalHash: adaptiveRootGoalHash, parentTaskId: source.taskId, request, policy: adaptiveDelegation, seenLineageHashes: adaptiveSeenLineages, totalDispatched: adaptiveGovernorState?.totalDispatched ?? 0, fanoutForRequester });
      adaptiveSeenLineages.add(decision.parentComputedLineageHash);
      const dispatchContract = buildParentDispatchContractForDecision({ runId: run.runId, parentTaskId: source.taskId, request, decision, dispatchGate: adaptiveDelegation.dispatch ? "p4_parent_dispatch_gate_pending" : "p4_live_dispatch_not_enabled" });
      if (dispatchContract) {
        adaptiveDispatchContracts.push(dispatchContract);
        adaptiveDispatchQueue.push({ sourceTaskId: source.taskId, request, decision, contract: dispatchContract });
      }
      if (decision.status === "oracle_required" && decision.hardGateStatus === "passed") adaptiveOracleQueue.push({ sourceTaskId: source.taskId, request, decision });
      const comsRequestMetadata = {
        schema: "zob.delegation-request-ref.v1",
        requestId: decision.parentAssignedRequestId,
        requesterDepth: request.requesterDepth,
        targetDepth: request.targetDepth,
        risk: request.risk,
        evidenceRefs: request.evidenceRefs,
        score: decision.score?.total,
        decisionStatus: decision.status,
        dispatchAllowed: decision.dispatchAllowed,
        dispatchContractQueued: Boolean(dispatchContract),
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
      };
      const decisionComsMetadata = { schema: "zob.delegation-decision-ref.v1", requestId: decision.parentAssignedRequestId, status: decision.status, dispatchAllowed: decision.dispatchAllowed, noShip: decision.noShip, score: decision.score?.total, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false };
      const requestComsRef: AdaptiveComsRef = { sender: request.requesterRole, receiver: request.referentRole, kind: "adaptive_delegation_request_ref", taskId: decision.parentAssignedRequestId, taskHash: decision.parentComputedNormalizedTaskHash, status: "queued", metadata: comsRequestMetadata, sourceTaskId: source.taskId };
      const decisionComsRef: AdaptiveComsRef = { sender: request.referentRole, receiver: request.requesterRole, kind: "adaptive_delegation_decision_ref", taskId: decision.parentAssignedRequestId, taskHash: decision.parentComputedNormalizedTaskHash, outputHash: sha256(decision.status), status: decision.dispatchAllowed ? "approved" : decision.status, metadata: decisionComsMetadata, sourceTaskId: source.taskId };
      adaptiveComsRefs.push(requestComsRef, decisionComsRef);
      let requestMsgId: string | undefined;
      let decisionMsgId: string | undefined;
      try {
        const requestMessage = appendAdaptiveComsRef(repoRoot, definition, run.runId, requestComsRef);
        requestMsgId = typeof requestMessage.msgId === "string" ? requestMessage.msgId : undefined;
        const decisionReply = replyZobComsMessage(repoRoot, definition, requestMsgId ?? String(requestMessage.msgId), { sender: decisionComsRef.sender, receiver: decisionComsRef.receiver, kind: decisionComsRef.kind, taskId: decisionComsRef.taskId, taskHash: decisionComsRef.taskHash, outputHash: decisionComsRef.outputHash, status: decisionComsRef.status, metadata: decisionComsRef.metadata });
        decisionMsgId = typeof decisionReply.msgId === "string" ? decisionReply.msgId : undefined;
      } catch (error) {
        adaptiveExtractionErrors.push({ sourceTaskId: source.taskId, errorHash: sha256(error instanceof Error ? error.message : String(error)), kind: "coms_write_failed", bodyStored: false });
      }
      adaptiveRequests.push({
        schema: request.schema,
        sourceTaskId: source.taskId,
        parentAssignedRequestId: decision.parentAssignedRequestId,
        requestMsgId,
        decisionMsgId,
        requesterRole: request.requesterRole,
        referentRole: request.referentRole,
        requestedAgent: request.requestedAgent,
        requestedOutputContract: request.requestedOutputContract,
        requiredTools: request.requiredTools,
        requesterDepth: request.requesterDepth,
        targetDepth: request.targetDepth,
        evidenceRefs: request.evidenceRefs,
        targetFileSet: request.targetFileSet,
        risk: request.risk,
        proposedTaskHash: request.proposedTaskHash,
        proposedContextHash: request.proposedContextHash,
        rationaleHash: request.rationaleHash,
        parentComputedLineageHash: decision.parentComputedLineageHash,
        parentComputedNormalizedTaskHash: decision.parentComputedNormalizedTaskHash,
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
      });
      adaptiveDecisions.push(decision);
      if (adaptiveGovernorState) adaptiveGovernorState = updateGovernorState(adaptiveGovernorState, decision);
      orchestrationLedger(run.runDir, { event: "adaptive_delegation_decision", requestId: decision.parentAssignedRequestId, sourceTaskId: source.taskId, status: decision.status, dispatchAllowed: decision.dispatchAllowed, targetDepth: decision.targetDepth, sentinel: "not written" });
    }
  };

  for (const message of messages) {
    const taskType = typeof message.taskType === "string" ? message.taskType : "";
    if (dispatchLeadPlans ? taskType !== "lead_plan" : taskType !== "worker_contract") continue;
    const taskId = typeof message.taskId === "string" ? message.taskId : "";
    const task = taskById.get(taskId);
    if (!task) continue;
    const blockedTools = assertSupervisedReadonlyTools(task);
    if (blockedTools.length > 0) {
      failed += 1;
      lifecycleStatuses.push(buildSupervisedReadonlyStatus(message, { event: "supervised_readonly_blocked", status: "failed", running: false, ping: "blocked", completedAt: new Date().toISOString(), errorHash: sha256(blockedTools.join(",")) }));
      orchestrationLedger(run.runDir, { event: "supervised_readonly_blocked", msgId: message.msgId, taskId, blockedToolsHash: sha256(blockedTools.join(",")), sentinel: "not written" });
      continue;
    }

    const orchestrationMsgId = typeof message.msgId === "string" ? message.msgId : "";
    const receiver = typeof message.receiver === "string" ? message.receiver : "";
    const sender = typeof message.sender === "string" ? message.sender : "";
    const msgId = ensureSupervisedReadonlyComsMessage(repoRoot, definition, { runId: run.runId, sender, receiver, taskId, taskHash: typeof task.taskHash === "string" ? task.taskHash : undefined });
    ackZobComsMessage(repoRoot, msgId, receiver);
    transitionZobComsStatus(repoRoot, msgId, receiver, "running");
    lifecycleStatuses.push(buildSupervisedReadonlyStatus(message, { event: "supervised_readonly_acknowledged", status: "acknowledged", running: false, ping: "acknowledged" }));
    lifecycleStatuses.push(buildSupervisedReadonlyStatus(message, { event: "supervised_readonly_running" }));
    orchestrationLedger(run.runDir, { event: "supervised_readonly_dispatch", msgId, taskId, workerId: receiver, leadId: sender, allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS], sentinel: "not written" });
    dispatched += 1;
    const requesterDepthForTask = taskType === "lead_plan" ? 1 : 2;
    const guided = withAdaptiveProposalGuidance({
      context: typeof task.context === "string" ? task.context : "",
      mustDo: Array.isArray(task.must_do) ? task.must_do.filter((item): item is string => typeof item === "string") : [],
      mustNotDo: Array.isArray(task.must_not_do) ? task.must_not_do.filter((item): item is string => typeof item === "string") : [],
      policy: adaptiveDelegation,
      requesterDepth: requesterDepthForTask,
      requesterRole: receiver,
      referentRole: sender,
    });

    let dispatchResult: SupervisedReadonlyDispatchResult;
    try {
      dispatchResult = await dispatcher({
        runId: run.runId,
        msgId,
        taskId,
        workerId: receiver,
        leadId: sender,
        agent: typeof task.agent === "string" ? task.agent : "unknown-agent",
        task: typeof task.task === "string" ? task.task : "",
        expectedOutcome: typeof task.expected_outcome === "string" ? task.expected_outcome : "",
        requiredTools: Array.isArray(task.required_tools) ? task.required_tools.filter((tool): tool is string => typeof tool === "string") : [],
        outputContract: typeof task.output_contract === "string" ? task.output_contract : "",
        mustDo: guided.mustDo,
        mustNotDo: guided.mustNotDo,
        context: guided.context,
        allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS],
      });
    } catch (error) {
      dispatchResult = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }

    const dispatcherKind = typeof dispatchResult.dispatcher === "string" ? dispatchResult.dispatcher : "external_mockable_boundary";
    const mocked = dispatchResult.mocked !== false && dispatcherKind !== "live_child_pi";
    dispatcherKinds.add(dispatcherKind);
    if (mocked) mockedDispatches += 1;
    else liveDispatches += 1;
    if (typeof dispatchResult.sessionPath === "string") childSessionPaths.push(dispatchResult.sessionPath);
    if (dispatchResult.outputContractValidated === true) outputContractsValidated += 1;

    const outputHash = typeof dispatchResult.outputHash === "string" ? dispatchResult.outputHash : (typeof dispatchResult.output === "string" ? sha256(dispatchResult.output) : null);
    const terminalStatus = dispatchResult.status === "failed" ? "failed" : "completed";
    const terminalMsgId = getZobComsMessage(repoRoot, msgId) ? msgId : ensureSupervisedReadonlyComsMessage(repoRoot, definition, { runId: run.runId, sender, receiver, taskId, taskHash: typeof task.taskHash === "string" ? task.taskHash : undefined, status: "running" });
    transitionZobComsStatus(repoRoot, terminalMsgId, receiver, terminalStatus, { outputHash });
    replyZobComsMessage(repoRoot, definition, terminalMsgId, { sender: receiver, receiver: sender, kind: "supervised_readonly_reply", taskId, outputHash, status: terminalStatus });
    lifecycleStatuses.push(buildSupervisedReadonlyStatus(message, { event: `supervised_readonly_${terminalStatus}`, status: terminalStatus, running: false, ping: terminalStatus, outputHash, completedAt: new Date().toISOString(), errorHash: dispatchResult.error ? sha256(dispatchResult.error) : undefined }));
    if (terminalStatus === "completed") completed += 1;
    else failed += 1;
    recordAdaptiveDelegationProposals({ taskId, requesterRole: receiver, referentRole: sender, requesterDepth: requesterDepthForTask, output: dispatchResult.output });

    if (taskType === "lead_plan") {
      const extractionErrors: string[] = [];
      let contracts = [] as ReturnType<typeof extractLeadPlanWorkerContracts>["contracts"];
      if (typeof dispatchResult.output === "string" && dispatchResult.output.trim().length > 0) {
        const extraction = extractLeadPlanWorkerContracts(dispatchResult.output);
        contracts = extraction.contracts;
        extractionErrors.push(...extraction.errors);
        const lead = definition.leads.find((candidate) => candidate.id === receiver);
        extractionErrors.push(...validateLeadPlanWorkerContracts(repoRoot, contracts, { leadId: receiver, allowedWorkerIds: lead?.workerIds, allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS], supervisedReadonly: true }));
      } else {
        extractionErrors.push("Lead plan output body not available for worker contract extraction");
      }
      const readyForWorkerDispatch = terminalStatus === "completed" && dispatchResult.outputContractValidated === true && extractionErrors.length === 0 && contracts.length > 0;
      leadPlanExtractions.push({
        schema: "zob.lead-plan-extraction.v1",
        runId: run.runId,
        leadId: receiver,
        taskId,
        msgId,
        status: terminalStatus,
        outputHash,
        outputContractValidated: dispatchResult.outputContractValidated === true,
        contractCount: contracts.length,
        contracts: redactLeadPlanWorkerContractsForPersistence(contracts),
        errors: extractionErrors,
        readyForWorkerDispatch,
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
      });
      if (readyForWorkerDispatch) {
        for (const contract of contracts) extractedWorkerContracts.push({ leadId: receiver, sourceTaskId: taskId, sourceMsgId: msgId, contract });
      }
    }
  }

  const leadPlanExtractionReady = !dispatchLeadPlans || (leadPlanExtractions.length > 0 && leadPlanExtractions.every((entry) => entry.readyForWorkerDispatch === true));
  const dynamicWorkerDispatchEnabled = dispatchLeadPlans && leadPlanExtractionReady;

  if (dynamicWorkerDispatchEnabled) {
    for (const extracted of extractedWorkerContracts) {
      const workerMessage = messages.find((message) => message.taskType === "worker_contract" && message.receiver === extracted.contract.worker_id && message.sender === extracted.leadId);
      if (!workerMessage) {
        failed += 1;
        dynamicWorkerDispatches.push({
          schema: "zob.dynamic-worker-dispatch.v1",
          runId: run.runId,
          leadId: extracted.leadId,
          workerId: extracted.contract.worker_id,
          sourceTaskId: extracted.sourceTaskId,
          status: "failed_preflight",
          errorHash: sha256(`missing planned worker message:${extracted.leadId}:${extracted.contract.worker_id}`),
          contract: redactLeadPlanWorkerContractsForPersistence([extracted.contract])[0],
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
        });
        continue;
      }

      const taskId = typeof workerMessage.taskId === "string" ? workerMessage.taskId : `${extracted.leadId}-${extracted.contract.worker_id}-dynamic-worker-contract`;
      const orchestrationMsgId = typeof workerMessage.msgId === "string" ? workerMessage.msgId : `${run.runId}:${taskId}`;
      const receiver = extracted.contract.worker_id;
      const sender = extracted.leadId;
      const msgId = ensureSupervisedReadonlyComsMessage(repoRoot, definition, { runId: run.runId, sender, receiver, taskId, taskHash: typeof workerMessage.taskHash === "string" ? workerMessage.taskHash : undefined });
      ackZobComsMessage(repoRoot, msgId, receiver);
      transitionZobComsStatus(repoRoot, msgId, receiver, "running");
      lifecycleStatuses.push(buildSupervisedReadonlyStatus(workerMessage, { event: "supervised_readonly_dynamic_worker_acknowledged", status: "acknowledged", running: false, ping: "acknowledged" }));
      lifecycleStatuses.push(buildSupervisedReadonlyStatus(workerMessage, { event: "supervised_readonly_dynamic_worker_running" }));
      orchestrationLedger(run.runDir, { event: "supervised_readonly_dynamic_worker_dispatch", msgId, taskId, workerId: receiver, leadId: sender, sourceLeadTaskId: extracted.sourceTaskId, allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS], sentinel: "not written" });
      dispatched += 1;
      const guided = withAdaptiveProposalGuidance({
        context: extracted.contract.context,
        mustDo: extracted.contract.must_do,
        mustNotDo: extracted.contract.must_not_do,
        policy: adaptiveDelegation,
        requesterDepth: 2,
        requesterRole: receiver,
        referentRole: sender,
      });

      let dispatchResult: SupervisedReadonlyDispatchResult;
      try {
        dispatchResult = await dispatcher({
          runId: run.runId,
          msgId,
          taskId,
          workerId: receiver,
          leadId: sender,
          agent: extracted.contract.agent,
          task: extracted.contract.task,
          expectedOutcome: extracted.contract.expected_outcome,
          requiredTools: extracted.contract.required_tools,
          outputContract: extracted.contract.output_contract,
          mustDo: guided.mustDo,
          mustNotDo: guided.mustNotDo,
          context: guided.context,
          allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS],
        });
      } catch (error) {
        dispatchResult = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }

      const dispatcherKind = typeof dispatchResult.dispatcher === "string" ? dispatchResult.dispatcher : "external_mockable_boundary";
      const mocked = dispatchResult.mocked !== false && dispatcherKind !== "live_child_pi";
      dispatcherKinds.add(dispatcherKind);
      if (mocked) mockedDispatches += 1;
      else liveDispatches += 1;
      if (typeof dispatchResult.sessionPath === "string") childSessionPaths.push(dispatchResult.sessionPath);
      if (dispatchResult.outputContractValidated === true) outputContractsValidated += 1;

      const outputHash = typeof dispatchResult.outputHash === "string" ? dispatchResult.outputHash : (typeof dispatchResult.output === "string" ? sha256(dispatchResult.output) : null);
      const terminalStatus = dispatchResult.status === "failed" ? "failed" : "completed";
      const terminalMsgId = getZobComsMessage(repoRoot, msgId) ? msgId : ensureSupervisedReadonlyComsMessage(repoRoot, definition, { runId: run.runId, sender, receiver, taskId, taskHash: typeof workerMessage.taskHash === "string" ? workerMessage.taskHash : undefined, status: "running" });
      transitionZobComsStatus(repoRoot, terminalMsgId, receiver, terminalStatus, { outputHash });
      replyZobComsMessage(repoRoot, definition, terminalMsgId, { sender: receiver, receiver: sender, kind: "supervised_readonly_dynamic_worker_reply", taskId, outputHash, status: terminalStatus });
      lifecycleStatuses.push(buildSupervisedReadonlyStatus(workerMessage, { event: `supervised_readonly_dynamic_worker_${terminalStatus}`, status: terminalStatus, running: false, ping: terminalStatus, outputHash, completedAt: new Date().toISOString(), errorHash: dispatchResult.error ? sha256(dispatchResult.error) : undefined }));
      if (terminalStatus === "completed") completed += 1;
      else failed += 1;
      recordAdaptiveDelegationProposals({ taskId, requesterRole: receiver, referentRole: sender, requesterDepth: 2, output: dispatchResult.output });

      dynamicWorkerDispatches.push({
        schema: "zob.dynamic-worker-dispatch.v1",
        runId: run.runId,
        leadId: sender,
        workerId: receiver,
        sourceTaskId: extracted.sourceTaskId,
        taskId,
        msgId,
        status: terminalStatus,
        dispatcher: dispatcherKind,
        mocked,
        outputHash,
        outputContractValidated: dispatchResult.outputContractValidated === true,
        contract: redactLeadPlanWorkerContractsForPersistence([extracted.contract])[0],
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
      });
    }
  }

  if (adaptiveDelegation.enabled && adaptiveDelegation.dispatch) {
    let adaptiveOracleQueueIndex = 0;
    let adaptiveDispatchQueueIndex = 0;
    const processedAdaptiveOracleRequestIds = new Set<string>();
    const processedAdaptiveDispatchRequestIds = new Set<string>();
    while (adaptiveOracleQueueIndex < adaptiveOracleQueue.length || adaptiveDispatchQueueIndex < adaptiveDispatchQueue.length) {
      if (adaptiveDelegation.oracle !== "off") {
        while (adaptiveOracleQueueIndex < adaptiveOracleQueue.length) {
          const queued = adaptiveOracleQueue[adaptiveOracleQueueIndex];
          adaptiveOracleQueueIndex += 1;
          const requestId = queued.decision.parentAssignedRequestId;
          if (processedAdaptiveOracleRequestIds.has(requestId)) continue;
          processedAdaptiveOracleRequestIds.add(requestId);
      const taskId = `adaptive-oracle-${requestId}`;
      const workerId = `adaptive-oracle-${requestId.slice(-8)}`;
      const msgId = `${run.runId}:${taskId}`;
      const syntheticMessage = {
        schema: "zob.orchestration-message.v1",
        runId: run.runId,
        msgId,
        parentId: queued.sourceTaskId,
        sender: queued.request.referentRole,
        receiver: workerId,
        receiverAgent: "oracle",
        role: "adaptive_oracle",
        taskId,
        taskHash: queued.decision.parentComputedNormalizedTaskHash,
      };
      lifecycleStatuses.push(buildSupervisedReadonlyStatus(syntheticMessage, { event: "supervised_readonly_adaptive_oracle_running", status: "running", ping: "running" }));
      orchestrationLedger(run.runDir, { event: "supervised_readonly_adaptive_oracle_dispatch", msgId, taskId, requestId, referentRole: queued.request.referentRole, allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS], sentinel: "not written" });
      dispatched += 1;
      adaptiveOracleDispatchesExecuted += 1;

      let dispatchResult: SupervisedReadonlyDispatchResult;
      try {
        dispatchResult = await dispatcher({
          runId: run.runId,
          msgId,
          taskId,
          workerId,
          leadId: queued.request.referentRole,
          agent: "oracle",
          task: buildAdaptiveOracleTaskText({ requestId, request: queued.request, decision: queued.decision, policy: adaptiveDelegation }),
          expectedOutcome: `Oracle PASS/WARN/FAIL decision for adaptive request ${requestId}.`,
          requiredTools: [...SUPERVISED_READONLY_CHILD_TOOLS],
          outputContract: "oracle.v1",
          mustDo: ["Review metadata and cited evidence", "Return oracle.v1", "Include verdict and no_ship", "Keep review read-only"],
          mustNotDo: ["No writes", "No secret access", "No child delegation", "No network or external side effects"],
          context: buildAdaptiveOracleContext({ requestId, request: queued.request, decision: queued.decision, policy: adaptiveDelegation }),
          allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS],
        });
      } catch (error) {
        dispatchResult = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }

      const dispatcherKind = typeof dispatchResult.dispatcher === "string" ? dispatchResult.dispatcher : "external_mockable_boundary";
      const mocked = dispatchResult.mocked !== false && dispatcherKind !== "live_child_pi";
      dispatcherKinds.add(dispatcherKind);
      if (mocked) {
        mockedDispatches += 1;
        adaptiveOracleDispatchesMocked += 1;
      } else {
        liveDispatches += 1;
        adaptiveOracleLiveChildPiDispatches += 1;
      }
      if (typeof dispatchResult.sessionPath === "string") childSessionPaths.push(dispatchResult.sessionPath);
      if (dispatchResult.outputContractValidated === true) outputContractsValidated += 1;
      const outputHash = typeof dispatchResult.outputHash === "string" ? dispatchResult.outputHash : (typeof dispatchResult.output === "string" ? sha256(dispatchResult.output) : null);
      const oracleResult = parseAdaptiveOracleOutput(dispatchResult.output);
      const terminalStatus = dispatchResult.status === "failed" ? "failed" : "completed";
      const oracleApproved = terminalStatus === "completed" && dispatchResult.outputContractValidated === true && oracleResult.verdict === "PASS" && oracleResult.noShip === false;
      if (oracleApproved) adaptiveOraclePasses += 1;
      else if (oracleResult.verdict === "WARN") adaptiveOracleWarns += 1;
      else adaptiveOracleFails += 1;
      lifecycleStatuses.push(buildSupervisedReadonlyStatus(syntheticMessage, { event: `supervised_readonly_adaptive_oracle_${terminalStatus}`, status: terminalStatus, running: false, ping: terminalStatus, outputHash, completedAt: new Date().toISOString(), errorHash: dispatchResult.error ? sha256(dispatchResult.error) : undefined }));
      if (terminalStatus === "completed") {
        completed += 1;
        adaptiveOracleDispatchesCompleted += 1;
      } else {
        failed += 1;
        adaptiveOracleDispatchesFailed += 1;
      }
      adaptiveOracleResults.push({ schema: "zob.delegation-oracle-decision.v1", requestId, status: oracleApproved ? "oracle_passed" : "oracle_blocked", decisionStatus: queued.decision.status, liveOracleDispatched: true, oracleVerdict: oracleResult.verdict, noShip: !oracleApproved, dispatchApproved: oracleApproved, score: queued.decision.score?.total, reasonsHash: sha256(queued.decision.reasons.join("\n")), outputHash, mocked, dispatcher: dispatcherKind, outputContractValidated: dispatchResult.outputContractValidated === true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
      const oracleComsRef: AdaptiveComsRef = { sender: queued.request.referentRole, receiver: queued.request.requesterRole, kind: "adaptive_delegation_oracle_ref", taskId: `${requestId}:oracle`, taskHash: queued.decision.parentComputedNormalizedTaskHash, outputHash, status: oracleApproved ? "approved" : "blocked", metadata: { schema: "zob.delegation-oracle-ref.v1", requestId, verdict: oracleResult.verdict, noShip: !oracleApproved, dispatchApproved: oracleApproved, mocked, dispatcher: dispatcherKind, outputContractValidated: dispatchResult.outputContractValidated === true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, sourceTaskId: queued.sourceTaskId };
      adaptiveComsRefs.push(oracleComsRef);
      try {
        appendAdaptiveComsRef(repoRoot, definition, run.runId, oracleComsRef);
      } catch (error) {
        adaptiveExtractionErrors.push({ sourceTaskId: queued.sourceTaskId, errorHash: sha256(error instanceof Error ? error.message : String(error)), kind: "adaptive_oracle_coms_write_failed", bodyStored: false });
      }
      if (oracleApproved) {
        const oracleApprovedDecision: GovernorDecision = { ...queued.decision, status: "approved", dispatchAllowed: true, noShip: false, reasons: [...queued.decision.reasons, "oracle_passed"] };
        const oracleDispatchGate = queued.request.targetDepth === ADAPTIVE_DELEGATION_HARD_MAX_DEPTH ? "p7_depth4_oracle_passed" : "p6_oracle_passed";
        const contract = buildParentDispatchContractForDecision({ runId: run.runId, parentTaskId: queued.sourceTaskId, request: queued.request, decision: oracleApprovedDecision, dispatchGate: oracleDispatchGate });
        if (contract) {
          adaptiveDispatchContracts.push(contract);
          adaptiveDispatchQueue.push({ sourceTaskId: queued.sourceTaskId, request: queued.request, decision: oracleApprovedDecision, contract });
          if (adaptiveGovernorState) {
            adaptiveGovernorState = {
              ...adaptiveGovernorState,
              totalApproved: adaptiveGovernorState.totalApproved + 1,
              totalDispatched: adaptiveGovernorState.totalDispatched + 1,
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
            };
          }
        }
      }
        }
      } else {
        adaptiveOracleQueueIndex = adaptiveOracleQueue.length;
      }

      while (adaptiveDispatchQueueIndex < adaptiveDispatchQueue.length) {
        const queued = adaptiveDispatchQueue[adaptiveDispatchQueueIndex];
        adaptiveDispatchQueueIndex += 1;
        if (!queued.decision.dispatchAllowed) continue;
        const requestId = queued.decision.parentAssignedRequestId;
        if (processedAdaptiveDispatchRequestIds.has(requestId)) continue;
        processedAdaptiveDispatchRequestIds.add(requestId);
      const taskId = `adaptive-${requestId}`;
      const workerId = `adaptive-worker-${requestId.slice(-8)}`;
      const msgId = `${run.runId}:${taskId}`;
      const syntheticMessage = {
        schema: "zob.orchestration-message.v1",
        runId: run.runId,
        msgId,
        parentId: queued.sourceTaskId,
        sender: queued.request.referentRole,
        receiver: workerId,
        receiverAgent: queued.request.requestedAgent,
        role: "adaptive_worker",
        taskId,
        taskHash: queued.decision.parentComputedNormalizedTaskHash,
      };
      queued.contract.status = "dispatching";
      queued.contract.dispatchGate = queued.contract.dispatchGate === "p7_depth4_oracle_passed" ? "p7_depth4_oracle_passed" : queued.contract.dispatchGate === "p6_oracle_passed" ? "p6_oracle_passed" : "p4_parent_dispatch_gate_passed";
      queued.contract.liveDispatched = true;
      lifecycleStatuses.push(buildSupervisedReadonlyStatus(syntheticMessage, { event: "supervised_readonly_adaptive_dispatch_running", status: "running", ping: "running" }));
      orchestrationLedger(run.runDir, { event: "supervised_readonly_adaptive_dispatch", msgId, taskId, requestId, referentRole: queued.request.referentRole, requestedAgent: queued.request.requestedAgent, allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS], sentinel: "not written" });
      dispatched += 1;
      adaptiveDispatchesExecuted += 1;

      let dispatchResult: SupervisedReadonlyDispatchResult;
      try {
        dispatchResult = await dispatcher({
          runId: run.runId,
          msgId,
          taskId,
          workerId,
          leadId: queued.request.referentRole,
          agent: queued.request.requestedAgent,
          task: buildAdaptiveReadonlyTaskText({ requestId, request: queued.request }),
          expectedOutcome: `Return ${queued.request.requestedOutputContract} with cited evidence for adaptive request ${requestId}.`,
          requiredTools: queued.request.requiredTools,
          outputContract: queued.request.requestedOutputContract,
          mustDo: ["Use only read-only tools", "Cite evidence refs", "Return the requested output contract", "Preserve hash-only artifacts", ...(queued.request.targetDepth < adaptiveDelegation.runtimeMaxDepth ? ["If parent-provided estimates show high success gain or token reduction, include one safe metadata-only adaptive proposal for the next depth"] : [])],
          mustNotDo: ["No writes", "No secret access", "No child delegation", "No network or external side effects"],
          context: buildAdaptiveReadonlyContext({ requestId, request: queued.request, decision: queued.decision, policy: adaptiveDelegation }),
          allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS],
        });
      } catch (error) {
        dispatchResult = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }

      const dispatcherKind = typeof dispatchResult.dispatcher === "string" ? dispatchResult.dispatcher : "external_mockable_boundary";
      const mocked = dispatchResult.mocked !== false && dispatcherKind !== "live_child_pi";
      dispatcherKinds.add(dispatcherKind);
      if (mocked) {
        mockedDispatches += 1;
        adaptiveDispatchesMocked += 1;
      } else {
        liveDispatches += 1;
        adaptiveLiveChildPiDispatches += 1;
      }
      if (typeof dispatchResult.sessionPath === "string") childSessionPaths.push(dispatchResult.sessionPath);
      if (dispatchResult.outputContractValidated === true) outputContractsValidated += 1;

      const outputHash = typeof dispatchResult.outputHash === "string" ? dispatchResult.outputHash : (typeof dispatchResult.output === "string" ? sha256(dispatchResult.output) : null);
      const terminalStatus = dispatchResult.status === "failed" ? "failed" : "completed";
      queued.contract.status = terminalStatus;
      queued.contract.dispatcherKind = dispatcherKind;
      queued.contract.mocked = mocked;
      queued.contract.outputHash = outputHash;
      queued.contract.outputContractValidated = dispatchResult.outputContractValidated === true;
      lifecycleStatuses.push(buildSupervisedReadonlyStatus(syntheticMessage, { event: `supervised_readonly_adaptive_dispatch_${terminalStatus}`, status: terminalStatus, running: false, ping: terminalStatus, outputHash, completedAt: new Date().toISOString(), errorHash: dispatchResult.error ? sha256(dispatchResult.error) : undefined }));
      if (terminalStatus === "completed") {
        completed += 1;
        adaptiveDispatchesCompleted += 1;
      } else {
        failed += 1;
        adaptiveDispatchesFailed += 1;
      }
      const dispatchComsRef: AdaptiveComsRef = { sender: queued.request.referentRole, receiver: queued.request.requesterRole, kind: "adaptive_delegation_dispatch_ref", taskId: `${requestId}:dispatch`, taskHash: queued.decision.parentComputedNormalizedTaskHash, outputHash, status: terminalStatus, metadata: { schema: "zob.delegation-dispatch-ref.v1", requestId, parentDispatched: true, status: terminalStatus, mocked, dispatcher: dispatcherKind, outputContractValidated: dispatchResult.outputContractValidated === true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, sourceTaskId: queued.sourceTaskId };
      adaptiveComsRefs.push(dispatchComsRef);
      try {
        appendAdaptiveComsRef(repoRoot, definition, run.runId, dispatchComsRef);
      } catch (error) {
        adaptiveExtractionErrors.push({ sourceTaskId: queued.sourceTaskId, errorHash: sha256(error instanceof Error ? error.message : String(error)), kind: "adaptive_dispatch_coms_write_failed", bodyStored: false });
      }
      if (terminalStatus === "completed") {
        recordAdaptiveDelegationProposals({ taskId, requesterRole: queued.request.requesterRole, referentRole: queued.request.referentRole, requesterDepth: queued.request.targetDepth, output: dispatchResult.output });
      }
      }
    }
  }

  if (adaptiveDelegation.enabled) {
    ensureAdaptiveComsRefs(repoRoot, definition, run.runId, adaptiveComsRefs, adaptiveExtractionErrors);
    writeFileSync(join(run.runDir, "delegation-requests.json"), JSON.stringify({
      schema: "zob.delegation-request-set.v1",
      runId: run.runId,
      mode: adaptiveDelegation.mode,
      dispatch: adaptiveDelegation.dispatch,
      requests: adaptiveRequests,
      extractionErrors: adaptiveExtractionErrors,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    }, null, 2), "utf8");
    writeFileSync(join(run.runDir, "delegation-decisions.json"), JSON.stringify({
      schema: "zob.governor-decision-set.v1",
      runId: run.runId,
      decisions: adaptiveDecisions,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    }, null, 2), "utf8");
    const oracleResultIds = new Set(adaptiveOracleResults.map((result) => typeof result.requestId === "string" ? result.requestId : ""));
    const adaptiveOracleAdvisoryDecisions = adaptiveDecisions.filter((decision) => decision.status === "oracle_required" && !oracleResultIds.has(decision.parentAssignedRequestId)).map((decision) => ({
      schema: "zob.delegation-oracle-decision.v1",
      requestId: decision.parentAssignedRequestId,
      status: "oracle_required_advisory",
      decisionStatus: decision.status,
      liveOracleDispatched: false,
      oracleVerdict: "not_dispatched",
      noShip: true,
      score: decision.score?.total,
      reasonsHash: sha256(decision.reasons.join("\n")),
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    }));
    const adaptiveOracleDecisions = [...adaptiveOracleResults, ...adaptiveOracleAdvisoryDecisions];
    writeFileSync(join(run.runDir, "delegation-oracle-decisions.json"), JSON.stringify({
      schema: "zob.delegation-oracle-decision-set.v1",
      runId: run.runId,
      oracleRequired: adaptiveDecisions.filter((decision) => decision.status === "oracle_required").length,
      oracleDispatchesExecuted: adaptiveOracleDispatchesExecuted,
      oracleDispatchesCompleted: adaptiveOracleDispatchesCompleted,
      oracleDispatchesFailed: adaptiveOracleDispatchesFailed,
      oracleDispatchesMocked: adaptiveOracleDispatchesMocked,
      oracleLiveChildPiDispatches: adaptiveOracleLiveChildPiDispatches,
      oraclePasses: adaptiveOraclePasses,
      oracleWarns: adaptiveOracleWarns,
      oracleFails: adaptiveOracleFails,
      decisions: adaptiveOracleDecisions,
      liveOracleDispatched: adaptiveOracleDispatchesExecuted > 0,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    }, null, 2), "utf8");
    writeFileSync(join(run.runDir, "delegation-dispatches.json"), JSON.stringify({
      schema: "zob.parent-dispatch-contract-set.v1",
      runId: run.runId,
      dispatches: adaptiveDispatchContracts,
      dispatchContractsQueued: adaptiveDispatchContracts.length,
      liveDispatches: adaptiveDispatchesExecuted,
      completed: adaptiveDispatchesCompleted,
      failed: adaptiveDispatchesFailed,
      mockedDispatches: adaptiveDispatchesMocked,
      liveChildPiDispatches: adaptiveLiveChildPiDispatches,
      adaptiveLiveDispatchEnabled: adaptiveDelegation.dispatch === true,
      reason: adaptiveDelegation.dispatch ? "adaptive delegation P4 parent-owned dispatch gate enabled; approved contracts executed by parent dispatcher" : "adaptive delegation remains advisory-only; parent-owned P4 dispatch contracts are queued but not executed",
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    }, null, 2), "utf8");
    if (adaptiveGovernorState) writeFileSync(join(run.runDir, "delegation-governor-state.json"), JSON.stringify(adaptiveGovernorState, null, 2), "utf8");
    writeFileSync(join(run.runDir, "adaptive-delegation-summary.md"), [`# Adaptive Delegation Summary`, ``, `- runId: ${run.runId}`, `- enabled: true`, `- mode: ${adaptiveDelegation.mode}`, `- dispatch: ${adaptiveDelegation.dispatch}`, `- requests: ${adaptiveRequests.length}`, `- decisions: ${adaptiveDecisions.length}`, `- dispatch_contracts_queued: ${adaptiveDispatchContracts.length}`, `- adaptive_dispatches_executed: ${adaptiveDispatchesExecuted}`, `- adaptive_dispatches_mocked: ${adaptiveDispatchesMocked}`, `- adaptive_live_child_pi_dispatches: ${adaptiveLiveChildPiDispatches}`, `- oracle_required: ${adaptiveDecisions.filter((decision) => decision.status === "oracle_required").length}`, `- oracle_dispatches_executed: ${adaptiveOracleDispatchesExecuted}`, `- oracle_passes: ${adaptiveOraclePasses}`, `- extraction_errors: ${adaptiveExtractionErrors.length}`, `- adaptive_live_dispatches: ${adaptiveDispatchesExecuted}`, `- live_oracle_dispatches: ${adaptiveOracleDispatchesExecuted}`, `- sentinel: not written`, ``].join("\n"), "utf8");
    orchestrationLedger(run.runDir, { event: "adaptive_delegation_advisory_written", requests: adaptiveRequests.length, decisions: adaptiveDecisions.length, dispatchContractsQueued: adaptiveDispatchContracts.length, adaptiveDispatchesExecuted, extractionErrors: adaptiveExtractionErrors.length, liveDispatches: adaptiveDispatchesExecuted, sentinel: "not written" });
  }

  if (dispatchLeadPlans) {
    writeFileSync(join(run.runDir, "lead-plan-extraction.json"), JSON.stringify({
      schema: "zob.lead-plan-extraction-set.v1",
      runId: run.runId,
      profile: definition.name,
      leadPlansDispatched: leadPlanExtractions.length,
      readyForWorkerDispatch: leadPlanExtractionReady,
      extractions: leadPlanExtractions,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    }, null, 2), "utf8");
    writeFileSync(join(run.runDir, "dynamic-worker-dispatch.json"), JSON.stringify({
      schema: "zob.dynamic-worker-dispatch-set.v1",
      runId: run.runId,
      profile: definition.name,
      gate: {
        leadPlanExtractionReady,
        dynamicWorkerDispatch: dynamicWorkerDispatchEnabled,
        reason: dynamicWorkerDispatchEnabled ? "lead-plan extraction ready; dispatched extracted worker contracts" : "lead-plan extraction not ready; dynamic worker dispatch skipped",
      },
      dispatched: dynamicWorkerDispatches.length,
      dispatches: dynamicWorkerDispatches,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    }, null, 2), "utf8");
  }

  const finalStatuses = [...initialStatuses, ...lifecycleStatuses];
  writeOrchestrationStatuses(run.runDir, finalStatuses, run.runId, "supervised_readonly");
  const roomArtifacts = writeOrchestrationRoomArtifacts({ runDir: run.runDir, runId: run.runId, definition, plan: redactOrchestrationPlanForPersistence(plan), messages, statuses: finalStatuses, execution: "supervised_readonly", goal: input.goal, originalUserAsk: input.original_user_ask ?? input.goal, comsMirrored: messages.length });
  const finalStatus = failed === 0 ? "completed" : "failed";
  const dynamicWorkerDispatchReady = !dispatchLeadPlans || (leadPlanExtractionReady && dynamicWorkerDispatchEnabled && dynamicWorkerDispatches.length > 0 && dynamicWorkerDispatches.every((entry) => entry.status === "completed" && entry.outputContractValidated === true));
  const { noMockReady, finalGate: noMockFinalGate } = buildSupervisedReadonlyNoMockFinalGate({
    finalStatus,
    dispatched,
    completed,
    failed,
    liveDispatches,
    mockedDispatches,
    outputContractsValidated,
    childSessionPaths: childSessionPaths.length,
    profileDynamicRequired: dispatchLeadPlans,
    profileDynamicReady: dynamicWorkerDispatchReady,
    dynamicWorkerDispatches: dynamicWorkerDispatches.length,
  });
  const profileSynthesisFinalGate = dispatchLeadPlans ? {
    schema: "zob.profile-synthesis-final-gate.v1",
    runId: run.runId,
    profile: definition.name,
    synthesisReady: dynamicWorkerDispatchReady && noMockReady,
    finalOracleGate: {
      passed: dynamicWorkerDispatchReady && noMockReady,
      no_ship: !(dynamicWorkerDispatchReady && noMockReady),
      reason: dynamicWorkerDispatchReady && noMockReady
        ? "profile dynamic lead planning, extracted worker dispatch, live no-mock child evidence, and output-contract gates passed"
        : "profile dynamic synthesis/final oracle evidence is incomplete",
    },
    evidence: {
      leadPlanExtractionArtifact: "lead-plan-extraction.json",
      dynamicWorkerDispatchArtifact: "dynamic-worker-dispatch.json",
      finalReportArtifact: "final-report.md",
      validationArtifact: "validation.json",
    },
    counters: {
      leadPlansDispatched: leadPlanExtractions.length,
      dynamicWorkerDispatches: dynamicWorkerDispatches.length,
      liveDispatches,
      mockedDispatches,
      outputContractsValidated,
      childSessionPaths: childSessionPaths.length,
    },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  } : undefined;
  if (profileSynthesisFinalGate) writeFileSync(join(run.runDir, "profile-synthesis-final-gate.json"), JSON.stringify(profileSynthesisFinalGate, null, 2), "utf8");
  const leadPlanExtractionErrors = leadPlanExtractions.flatMap((entry) => Array.isArray(entry.errors) ? entry.errors.filter((error): error is string => typeof error === "string") : []);
  const validationPath = join(run.runDir, "validation.json");
  const priorValidation = parseJsonFile(validationPath);
  const validation = isRecord(priorValidation) ? priorValidation : {};
  const priorInvariants = isRecord(validation.invariants) ? validation.invariants : {};
  const priorArtifactsPresent = Array.isArray(validation.artifactsPresent) ? validation.artifactsPresent.filter(isRecord) : [];
  const artifactsPresent = dispatchLeadPlans
    ? [
      ...priorArtifactsPresent.filter((artifact) => artifact.artifact !== "lead-plan-extraction.json" && artifact.artifact !== "dynamic-worker-dispatch.json" && artifact.artifact !== "profile-synthesis-final-gate.json"),
      { artifact: "lead-plan-extraction.json", exists: existsSync(join(run.runDir, "lead-plan-extraction.json")) },
      { artifact: "dynamic-worker-dispatch.json", exists: existsSync(join(run.runDir, "dynamic-worker-dispatch.json")) },
      { artifact: "profile-synthesis-final-gate.json", exists: existsSync(join(run.runDir, "profile-synthesis-final-gate.json")) },
    ]
    : priorArtifactsPresent;
  writeFileSync(validationPath, JSON.stringify({
    ...validation,
    artifactsPresent,
    status: finalStatus,
    noExecution: false,
    invariants: buildSupervisedReadonlyRuntimeInvariants(priorInvariants, { liveDispatches, noMockReady }),
    supervisedReadonly: {
      parentOwnedPreflight: true,
      parentOwnedDispatch: true,
      workerSpawnsWorker: false,
      allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS],
      dispatched,
      completed,
      failed,
      dispatcher: liveDispatches > 0 && mockedDispatches === 0 ? "live_child_pi" : "external_mockable_boundary",
      dispatchers: [...dispatcherKinds],
      mocked: mockedDispatches > 0,
      mockedDispatches,
      liveDispatches,
      liveChildExecution: liveDispatches > 0,
      childSessionPaths,
      outputContractsValidated: outputContractsValidated === dispatched && dispatched > 0,
      outputContractsValidatedCount: outputContractsValidated,
      noMockReady,
      finalGate: noMockFinalGate,
    },
    dispatcherLifecycle: { dispatched, completed, failed, statusesAppended: lifecycleStatuses.length, repliesCorrelated: dispatched, liveDispatches, mockedDispatches, childSessionPaths },
    profileLeadPlanning: dispatchLeadPlans ? {
      schema: "zob.profile-lead-planning.v1",
      leadPlansDispatched: leadPlanExtractions.length,
      readyForWorkerDispatch: leadPlanExtractionReady,
      extractionArtifact: "lead-plan-extraction.json",
      errors: leadPlanExtractionErrors,
      dynamicWorkerDispatch: dynamicWorkerDispatchEnabled,
      dynamicWorkerDispatchArtifact: "dynamic-worker-dispatch.json",
      dynamicWorkerDispatches: dynamicWorkerDispatches.length,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    } : undefined,
    profileSynthesisFinalGate,
    adaptiveDelegation: adaptiveDelegation.enabled ? { schema: "zob.adaptive-delegation-validation.v1", enabled: true, mode: adaptiveDelegation.mode, dispatch: adaptiveDelegation.dispatch, recordDecisionsOnly: adaptiveDelegation.recordDecisionsOnly, configuredMaxDepth: adaptiveDelegation.configuredMaxDepth, runtimeMaxDepth: adaptiveDelegation.runtimeMaxDepth, parentOwnedDispatch: true, childDirectDispatch: false, requests: adaptiveRequests.length, decisions: adaptiveDecisions.length, dispatchContractsQueued: adaptiveDispatchContracts.length, adaptiveDispatchesExecuted, adaptiveDispatchesCompleted, adaptiveDispatchesFailed, adaptiveDispatchesMocked, adaptiveLiveChildPiDispatches, oracleRequired: adaptiveDecisions.filter((decision) => decision.status === "oracle_required").length, adaptiveOracleDispatchesExecuted, adaptiveOracleDispatchesCompleted, adaptiveOracleDispatchesFailed, adaptiveOracleDispatchesMocked, adaptiveOracleLiveChildPiDispatches, adaptiveOraclePasses, adaptiveOracleWarns, adaptiveOracleFails, extractionErrors: adaptiveExtractionErrors.length, liveDispatches: adaptiveDispatchesExecuted, liveOracleDispatches: adaptiveOracleDispatchesExecuted, advisoryOnly: adaptiveDelegation.dispatch !== true, artifacts: ["adaptive-delegation-policy.json", "delegation-governor-state.json", "delegation-requests.json", "delegation-decisions.json", "delegation-oracle-decisions.json", "delegation-dispatches.json", "adaptive-delegation-summary.md"], noExecution: false, adaptiveLiveDispatchEnabled: adaptiveDelegation.dispatch === true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false } : validation.adaptiveDelegation,
    roomArtifactsPresent: roomArtifacts.artifacts.map((artifact) => ({ artifact, exists: existsSync(join(run.runDir, artifact)) })),
    room: { schema: "zob.room.v1", path: "room/", contextPack: "room/context-pack.json", evidenceIndex: "room/evidence-index.json", promptBodiesStored: false, outputBodiesStored: false },
    sentinelWritten: existsSync(join(run.runDir, "DONE.sentinel")),
  }, null, 2), "utf8");
  writeFileSync(join(run.runDir, "final-report.md"), [`# Orchestration Run Report`, ``, `- runId: ${run.runId}`, `- status: ${finalStatus}`, `- execution: supervised_readonly`, `- dispatched: ${dispatched}`, `- completed: ${completed}`, `- failed: ${failed}`, `- child_agents_executed: ${liveDispatches > 0 && mockedDispatches === 0 ? "live_child_pi" : "mockable_dispatcher"}`, `- mocked_dispatches: ${mockedDispatches}`, `- live_dispatches: ${liveDispatches}`, `- child_session_paths: ${childSessionPaths.length}`, `- no_mock_readiness: ${noMockReady ? "passed" : "failed"}`, `- no_mock_reason: ${noMockFinalGate.reason}`, `- profile_synthesis_final_gate: ${profileSynthesisFinalGate?.finalOracleGate?.passed === true ? "passed" : dispatchLeadPlans ? "failed" : "n/a"}`, `- adaptive_delegation_requests: ${adaptiveDelegation.enabled ? adaptiveRequests.length : "n/a"}`, `- adaptive_delegation_oracle_required: ${adaptiveDelegation.enabled ? adaptiveDecisions.filter((decision) => decision.status === "oracle_required").length : "n/a"}`, `- adaptive_delegation_dispatch_contracts_queued: ${adaptiveDelegation.enabled ? adaptiveDispatchContracts.length : "n/a"}`, `- adaptive_delegation_live_dispatches: ${adaptiveDelegation.enabled ? adaptiveDispatchesExecuted : "n/a"}`, `- adaptive_delegation_mocked_dispatches: ${adaptiveDelegation.enabled ? adaptiveDispatchesMocked : "n/a"}`, `- adaptive_delegation_live_child_pi_dispatches: ${adaptiveDelegation.enabled ? adaptiveLiveChildPiDispatches : "n/a"}`, `- adaptive_delegation_oracle_passes: ${adaptiveDelegation.enabled ? adaptiveOraclePasses : "n/a"}`, `- adaptive_delegation_live_oracle_dispatches: ${adaptiveDelegation.enabled ? adaptiveOracleDispatchesExecuted : "n/a"}`, `- allowed_tools: ${SUPERVISED_READONLY_CHILD_TOOLS.join(",")}`, `- sentinel: not written`, ``].join("\n"), "utf8");
  orchestrationLedger(run.runDir, { event: "supervised_readonly_finished", status: finalStatus, dispatched, completed, failed, profileLeadPlans: leadPlanExtractions.length, leadPlanExtractionReady, dynamicWorkerDispatches: dynamicWorkerDispatches.length, profileSynthesisFinalGatePassed: profileSynthesisFinalGate?.finalOracleGate?.passed, sentinel: "not written" });
  return { ...run, status: finalStatus, dispatched, completed, failed, artifacts: dispatchLeadPlans ? [...run.artifacts, "lead-plan-extraction.json", "dynamic-worker-dispatch.json", "profile-synthesis-final-gate.json"] : run.artifacts, errors: [] };
}
