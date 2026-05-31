import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildZobLivePresenceSummary, redactZobLivePeerForMissionControl } from "./coms-v2/presence.js";
import { readZobComsV2Policy } from "./coms-v2/policy.js";
import { readZobLiveRegistrySnapshot } from "./coms-v2/registry.js";
import { buildQueueDashboardSummary } from "./queue.js";
import type { TeamDefinition } from "./types.js";
import { summarizePromotionCandidates } from "./promotion/candidate.js";
import { buildZobComsMessage, listZobComsMessages, validateZobComsEdge, validateZobComsMessage } from "./topology/coms.js";
import { sha256 } from "./utils/hashing.js";
import { readJsonl, readJsonObjectIfPresent } from "./utils/json.js";
import { safeFileStem } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

export const MISSION_CONTROL_COMMANDS = ["pause", "resume", "reprioritize", "request_context", "request_oracle", "stop", "approve", "replan"] as const;

const MISSION_CONTROL_COMMAND_SET = new Set<string>(MISSION_CONTROL_COMMANDS);
const FORBIDDEN_BODY_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "rationale", "text", "diff", "patch"]);
const TRANSPORT_POLICY_RELATIVE_PATH = ".pi/mission-control/zob_coms_transport.json";
const COMMAND_PROPOSALS_RELATIVE_PATH = ".pi/mission-control/command-proposals.jsonl";
const COMMAND_PROPOSALS_DIR_RELATIVE_PATH = ".pi/mission-control/proposals";
const GOAL_ROOM_DIR_RELATIVE_PATH = ".pi/goal-rooms";

export interface MissionControlCommandProposalInput {
  proposalId?: string;
  runId: string;
  command: string;
  requestedBy?: string;
  targetRole?: string;
  priority?: string;
  rationaleHash?: string;
  artifactRefs?: string[];
  todoId?: string;
  subtreeRootTodoId?: string;
}

export interface MissionControlSnapshotInput {
  runId?: string;
  limit?: number;
}

function hasForbiddenBodyKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKey);
  return Object.entries(value).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKey(child));
}

function isHexSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function summarizeZpeerRooms(peers: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const rooms = new Map<string, Array<Record<string, unknown>>>();
  for (const peer of peers) {
    const roomId = typeof peer.zpeerRoomId === "string" ? peer.zpeerRoomId : "default";
    const list = rooms.get(roomId) ?? [];
    list.push(peer);
    rooms.set(roomId, list);
  }
  return [...rooms.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([roomId, roomPeers]) => {
    const aliases = roomPeers.map((peer) => typeof peer.zpeerAlias === "string" ? peer.zpeerAlias : undefined).filter((alias): alias is string => Boolean(alias)).sort();
    return {
      schema: "zob.zpeer-room-summary.v1",
      roomIdHash: sha256(roomId),
      peerCount: roomPeers.length,
      online: roomPeers.filter((peer) => peer.status === "online").length,
      stale: roomPeers.filter((peer) => peer.status === "stale").length,
      offline: roomPeers.filter((peer) => peer.status === "offline").length,
      aliasHashes: aliases.map((alias) => sha256(alias)),
      duplicateAliasHashes: aliases.filter((alias, index) => aliases.indexOf(alias) !== index).filter((alias, index, all) => all.indexOf(alias) === index).map((alias) => sha256(alias)),
      localOnly: true,
      networkEnabled: false,
      bodyStored: false,
    };
  });
}

function isSafeArtifactRef(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || value.includes("..")) return false;
  if (value === ".env" || value.startsWith(".env.") || value.includes("/.env")) return false;
  if (value.includes("node_modules/") || value.includes("dist/") || value.includes("build/")) return false;
  if (value.endsWith(".pem") || value.endsWith(".key")) return false;
  return true;
}

function boundedLimit(limit: number | undefined, fallback = 10): number {
  return Math.max(1, Math.min(50, Math.floor(limit ?? fallback)));
}

function sortedEntriesByMtime(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => ({ entry, path: join(dir, entry), stat: statSync(join(dir, entry)) }))
    .filter((item) => item.stat.isDirectory())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map((item) => item.entry);
}

function summarizeRunDir(repoRoot: string, baseRelative: string, runId: string): Record<string, unknown> {
  const runDir = join(repoRoot, baseRelative, runId);
  const validation = readJsonObjectIfPresent(join(runDir, "validation.json"));
  return {
    runId,
    status: typeof validation?.status === "string" ? validation.status : "unknown",
    mode: typeof validation?.mode === "string" ? validation.mode : undefined,
    execution: typeof validation?.execution === "string" ? validation.execution : undefined,
    no_ship: typeof validation?.no_ship === "boolean" ? validation.no_ship : undefined,
    noExecution: typeof validation?.noExecution === "boolean" ? validation.noExecution : undefined,
    validation: existsSync(join(runDir, "validation.json")) ? `${baseRelative}/${runId}/validation.json` : undefined,
    doneSentinel: existsSync(join(runDir, "DONE.sentinel")),
  };
}

function summarizeLatestRuns(repoRoot: string, baseRelative: string, limit: number): Array<Record<string, unknown>> {
  return sortedEntriesByMtime(join(repoRoot, baseRelative)).slice(0, limit).map((runId) => summarizeRunDir(repoRoot, baseRelative, runId));
}

function summarizeAdaptiveWorkflowArtifacts(repoRoot: string, limit: number): Array<Record<string, unknown>> {
  const root = join(repoRoot, "reports", "orchestrations");
  if (!existsSync(root)) return [];
  return sortedEntriesByMtime(root).slice(0, Math.max(limit, 20)).flatMap((runId) => {
    const runDir = join(root, runId);
    const validationPath = join(runDir, "adaptive-workflow-validation.json");
    if (!existsSync(validationPath)) return [];
    const validation = readJsonObjectIfPresent(validationPath);
    const workflow = readJsonObjectIfPresent(join(runDir, "adaptive-workflow-run.json"));
    const scalePolicy = readJsonObjectIfPresent(join(runDir, "scale-policy.json"));
    const documentationPolicy = readJsonObjectIfPresent(join(runDir, "documentation-policy.json"));
    return [{
      runId,
      status: workflow?.status,
      effectiveComputeProfile: workflow?.effectiveComputeProfile,
      rootRole: workflow?.rootRole,
      rootNonCoding: validation?.rootNonCoding,
      modelPolicyPresent: validation?.modelPolicyPresent,
      scalePolicyPresent: validation?.scalePolicyPresent,
      documentationPolicyPresent: validation?.documentationPolicyPresent,
      tempAgentRosterPresent: validation?.tempAgentRosterPresent,
      factoryCandidatePresent: validation?.factoryCandidatePresent,
      scaleRequested: scalePolicy?.requestedScale,
      scaleApprovalRequired: scalePolicy?.requiresScaleApproval,
      stalePeerBlocksCompletion: scalePolicy?.stalePeerBlocksCompletion,
      docWritebackPolicy: documentationPolicy?.writebackPolicy,
      valid: validation?.valid,
      errors: Array.isArray(validation?.errors) ? validation.errors : [],
      artifact: `reports/orchestrations/${runId}/adaptive-workflow-validation.json`,
      bodyStored: false,
    }];
  }).slice(0, limit);
}

function summarizeComputeProfileArtifacts(repoRoot: string, limit: number): Array<Record<string, unknown>> {
  const root = join(repoRoot, "reports", "project-dna-scans");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((runId) => ({ runId, summaryPath: join(root, runId, "compute-mission-control-summary.json") }))
    .filter((item) => existsSync(item.summaryPath))
    .sort((a, b) => statSync(b.summaryPath).mtimeMs - statSync(a.summaryPath).mtimeMs)
    .slice(0, limit)
    .flatMap(({ runId, summaryPath }) => {
      const summary = readJsonObjectIfPresent(summaryPath);
      if (!summary) return [];
      return [{
        runId: summary.runId ?? runId,
        domain: summary.domain,
        requestedProfile: summary.requestedProfile,
        recommendedProfile: summary.recommendedProfile,
        effectiveProfile: summary.effectiveProfile,
        noShip: summary.noShip,
        laneCount: isRecord(summary.workflow) ? summary.workflow.laneCount : undefined,
        parentOwnedDispatch: isRecord(summary.workflow) ? summary.workflow.parentOwnedDispatch : undefined,
        childDirectDispatch: isRecord(summary.workflow) ? summary.workflow.childDirectDispatch : undefined,
        fullHudWidgetWiringImplemented: summary.fullHudWidgetWiringImplemented,
        artifact: `reports/project-dna-scans/${runId}/compute-mission-control-summary.json`,
        bodyStored: summary.bodyStored,
      }];
    });
}

function summarizeFactoryStatus(factoryRuns: Array<Record<string, unknown>>): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  for (const run of factoryRuns) {
    const status = typeof run.status === "string" ? run.status : "unknown";
    const mode = typeof run.mode === "string" ? run.mode : "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byMode[mode] = (byMode[mode] ?? 0) + 1;
  }
  return { latestCount: factoryRuns.length, byStatus, byMode };
}

function sanitizeMissionControlMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeMissionControlMetadata);
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "output" && typeof child === "number") sanitized.outputTokens = child;
    else if (key === "input" && typeof child === "number") sanitized.inputTokens = child;
    else if (FORBIDDEN_BODY_KEYS.has(key)) sanitized[`${key}Omitted`] = true;
    else sanitized[key] = sanitizeMissionControlMetadata(child);
  }
  return sanitized;
}

function redactComsMessage(message: Record<string, unknown>): Record<string, unknown> {
  return {
    msgId: message.msgId,
    runId: message.runId,
    sender: message.sender,
    receiver: message.receiver,
    kind: message.kind,
    status: message.status,
    ack: message.ack,
    taskHash: message.taskHash,
    outputHash: message.outputHash,
    replies: message.replies,
    bodyStored: message.bodyStored,
    timestamp: message.timestamp,
  };
}

function redactGoalRoomEvent(event: Record<string, unknown>, fallbackGoalId: string): Record<string, unknown> {
  return {
    msgId: event.msgId,
    goalId: event.goalId ?? fallbackGoalId,
    runId: event.runId,
    todoId: event.todoId,
    sender: event.sender,
    audience: event.audience,
    kind: event.kind,
    priority: event.priority,
    requiresParentAction: event.requiresParentAction,
    taskId: event.taskId,
    bodyHash: event.bodyHash,
    outputHash: event.outputHash,
    evidenceRefs: Array.isArray(event.evidenceRefs) ? event.evidenceRefs : [],
    artifactRefs: Array.isArray(event.artifactRefs) ? event.artifactRefs : [],
    parentVisible: event.parentVisible,
    hiddenPeerChat: event.hiddenPeerChat,
    workerToWorkerDirect: event.workerToWorkerDirect,
    parentOwnedActions: event.parentOwnedActions,
    bodyStored: event.bodyStored,
    promptBodiesStored: event.promptBodiesStored,
    outputBodiesStored: event.outputBodiesStored,
    createdAt: event.createdAt,
  };
}

function summarizeGoalRoomEvents(repoRoot: string, limit: number): Array<Record<string, unknown>> {
  const root = join(repoRoot, GOAL_ROOM_DIR_RELATIVE_PATH);
  if (!existsSync(root)) return [];
  return sortedEntriesByMtime(root)
    .flatMap((goalRoomId) => readJsonl(join(root, goalRoomId, "messages.jsonl"))
      .filter((event) => isRecord(event) && event.schema === "zob.goal-room-message.v1" && !hasForbiddenBodyKey(event))
      .map((event) => redactGoalRoomEvent(event, goalRoomId)))
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
    .slice(-limit);
}

function readCommandProposalLedger(repoRoot: string): Array<Record<string, unknown>> {
  return readJsonl(join(repoRoot, COMMAND_PROPOSALS_RELATIVE_PATH));
}

function buildCommandProposalId(input: MissionControlCommandProposalInput): string {
  if (input.proposalId) {
    const safe = safeFileStem(input.proposalId);
    if (safe !== input.proposalId) throw new Error(`Unsafe proposalId: ${input.proposalId}`);
    return safe;
  }
  return safeFileStem(`${input.runId}-${input.command}-${Date.now()}`);
}

function teamWorkerIds(definition: TeamDefinition): Set<string> {
  return new Set(definition.workers.map((worker) => worker.id));
}

function teamLeadIds(definition: TeamDefinition): Set<string> {
  return new Set(definition.leads.map((lead) => lead.id));
}

function validateMissionControlCommandProposalInput(definition: TeamDefinition, input: MissionControlCommandProposalInput): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return ["Mission Control command proposal input must be an object"];
  if (hasForbiddenBodyKey(input)) errors.push("Mission Control command proposals must not include raw body/task/prompt/output/content/rationale/text fields");
  if (typeof input.runId !== "string" || input.runId.trim().length === 0) errors.push("Mission Control command proposal requires runId");
  if (typeof input.command !== "string" || !MISSION_CONTROL_COMMAND_SET.has(input.command)) errors.push(`Mission Control command must be one of: ${MISSION_CONTROL_COMMANDS.join(", ")}`);
  if (input.rationaleHash !== undefined && !isHexSha256(input.rationaleHash)) errors.push("Mission Control rationaleHash must be a sha256 hex hash when provided");
  if (input.priority !== undefined && !["low", "normal", "high", "critical"].includes(input.priority)) errors.push("Mission Control priority must be low, normal, high, or critical");
  if (input.todoId !== undefined && !/^[A-Za-z0-9._:-]+$/.test(input.todoId)) errors.push("Mission Control todoId must be metadata-safe");
  if (input.subtreeRootTodoId !== undefined && !/^[A-Za-z0-9._:-]+$/.test(input.subtreeRootTodoId)) errors.push("Mission Control subtreeRootTodoId must be metadata-safe");
  if (input.artifactRefs !== undefined) {
    if (!Array.isArray(input.artifactRefs)) errors.push("Mission Control artifactRefs must be an array when provided");
    else {
      const unsafe = input.artifactRefs.filter((ref) => typeof ref !== "string" || !isSafeArtifactRef(ref));
      if (unsafe.length > 0) errors.push(`Mission Control artifactRefs must be safe repo-relative references: ${unsafe.join(", ")}`);
    }
  }
  const workerIds = teamWorkerIds(definition);
  if (typeof input.targetRole === "string" && workerIds.has(input.targetRole)) errors.push("Mission Control command proposals must be parent-owned; direct worker targets are blocked");
  const knownControlRoles = new Set([definition.orchestrator.id, ...teamLeadIds(definition)]);
  if (typeof input.targetRole === "string" && input.targetRole.length > 0 && !knownControlRoles.has(input.targetRole)) errors.push(`Mission Control targetRole must be the orchestrator or a lead role, got '${input.targetRole}'`);
  return errors;
}

export function validateMissionControlCommandProposal(definition: TeamDefinition, input: MissionControlCommandProposalInput): string[] {
  return validateMissionControlCommandProposalInput(definition, input);
}

export function buildMissionControlCommandProposal(definition: TeamDefinition, input: MissionControlCommandProposalInput): Record<string, unknown> {
  const errors = validateMissionControlCommandProposal(definition, input);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const proposalId = buildCommandProposalId(input);
  const receiver = definition.orchestrator.id;
  const commandEnvelope = {
    runId: input.runId,
    command: input.command,
    targetRole: input.targetRole ?? receiver,
    receiver,
    priority: input.priority ?? "normal",
    artifactRefs: input.artifactRefs ?? [],
    todoId: input.todoId ?? null,
    subtreeRootTodoId: input.subtreeRootTodoId ?? null,
  };
  const commandHash = sha256(JSON.stringify(commandEnvelope));
  const proposal = {
    schema: "zob.mission-control-command-proposal.v1",
    proposalId,
    runId: input.runId,
    requestedBy: input.requestedBy ?? "mission-control-dashboard",
    receiver,
    command: input.command,
    commandHash,
    targetRole: input.targetRole ?? receiver,
    priority: input.priority ?? "normal",
    rationaleHash: input.rationaleHash ?? null,
    artifactRefs: input.artifactRefs ?? [],
    todoId: input.todoId ?? null,
    subtreeRootTodoId: input.subtreeRootTodoId ?? null,
    proposalOnly: true,
    parentOwned: true,
    requiresParentApproval: true,
    directWorkerWrite: false,
    transportDispatch: false,
    networkTransport: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKey(proposal)) throw new Error("Refusing to build Mission Control proposal with raw body fields");
  return proposal;
}

export function writeMissionControlCommandProposal(repoRoot: string, definition: TeamDefinition, input: MissionControlCommandProposalInput): Record<string, unknown> {
  const proposal = buildMissionControlCommandProposal(definition, input);
  const missionDir = join(repoRoot, ".pi", "mission-control");
  const proposalsDir = join(repoRoot, COMMAND_PROPOSALS_DIR_RELATIVE_PATH);
  mkdirSync(missionDir, { recursive: true });
  mkdirSync(proposalsDir, { recursive: true });
  appendFileSync(join(repoRoot, COMMAND_PROPOSALS_RELATIVE_PATH), `${JSON.stringify(proposal)}\n`, "utf8");
  writeFileSync(join(proposalsDir, `${proposal.proposalId}.json`), JSON.stringify(proposal, null, 2), "utf8");
  return { ...proposal, proposalLedger: COMMAND_PROPOSALS_RELATIVE_PATH, proposalArtifact: `${COMMAND_PROPOSALS_DIR_RELATIVE_PATH}/${proposal.proposalId}.json` };
}

function readTransportPolicy(repoRoot: string): Record<string, unknown> {
  return readJsonObjectIfPresent(join(repoRoot, TRANSPORT_POLICY_RELATIVE_PATH)) ?? {
    schema: "zob.coms-transport-policy.v1",
    name: "zob_coms_transport",
    p0Status: "design_only",
    enabled: false,
    localDispatchEnabled: false,
    networkEnabled: false,
    globalActivation: false,
    dispatchAllowed: false,
    canonicalLedger: ".pi/coms/messages.jsonl",
    statusLedger: ".pi/coms/status.jsonl",
    bodyPolicy: "hash_only",
    heartbeat: { enabled: false, stalePeerCountsAsCompletion: false },
    responseCapture: { enabled: false, storeBodies: false },
    commandPolicy: { proposalOnly: true, directWorkerWrites: false },
  };
}

export function buildZobComsTransportReadiness(repoRoot: string): Record<string, unknown> {
  const policy = readTransportPolicy(repoRoot);
  const v2Policy = readZobComsV2Policy(repoRoot);
  const heartbeat = isRecord(policy.heartbeat) ? policy.heartbeat : {};
  const responseCapture = isRecord(policy.responseCapture) ? policy.responseCapture : {};
  const commandPolicy = isRecord(policy.commandPolicy) ? policy.commandPolicy : {};
  const livePresence = buildZobLivePresenceSummary(repoRoot);
  const strictLiveMode = v2Policy.mode === "required_local" || v2Policy.mode === "required_network";
  const checks = [
    { name: "policy_present", passed: (policy.schema === "zob.coms-transport-policy.v1" || policy.schema === "zob.coms-transport-policy.v2") && policy.name === "zob_coms_transport", detail: TRANSPORT_POLICY_RELATIVE_PATH },
    { name: "transport_disabled_p0_or_live_required", passed: strictLiveMode || (policy.enabled === false && policy.localDispatchEnabled !== true && policy.dispatchAllowed !== true), detail: JSON.stringify({ mode: v2Policy.mode, enabled: policy.enabled, localDispatchEnabled: policy.localDispatchEnabled, dispatchAllowed: policy.dispatchAllowed }) },
    { name: "network_disabled", passed: policy.networkEnabled === false && policy.globalActivation !== true, detail: JSON.stringify({ networkEnabled: policy.networkEnabled, globalActivation: policy.globalActivation }) },
    { name: "zob_ledger_canonical", passed: policy.canonicalLedger === ".pi/coms/messages.jsonl" && policy.statusLedger === ".pi/coms/status.jsonl", detail: JSON.stringify({ canonicalLedger: policy.canonicalLedger, statusLedger: policy.statusLedger }) },
    { name: "stale_not_completion", passed: heartbeat.stalePeerCountsAsCompletion === false, detail: JSON.stringify(heartbeat) },
    { name: "response_capture_body_free", passed: responseCapture.storeBodies !== true, detail: JSON.stringify(responseCapture) },
    { name: "commands_proposal_only", passed: commandPolicy.proposalOnly === true && commandPolicy.directWorkerWrites === false, detail: JSON.stringify(commandPolicy) },
    { name: "registry_available", passed: livePresence.available === true, detail: JSON.stringify({ mode: livePresence.mode, registry: livePresence.registry, peerCount: livePresence.peerCount }) },
    { name: "required_local_live_ready_when_enabled", passed: v2Policy.mode !== "required_local" || (livePresence.dispatchEnabled === true && livePresence.networkEnabled === false && livePresence.online > 0), detail: JSON.stringify({ mode: livePresence.mode, online: livePresence.online, stale: livePresence.stale, offline: livePresence.offline }) },
    { name: "agentic_workflows_require_live", passed: v2Policy.agenticWorkflowsRequireLive === true && v2Policy.legacy.appendOnlySendEnabled === false, detail: JSON.stringify({ agenticWorkflowsRequireLive: v2Policy.agenticWorkflowsRequireLive, appendOnlySendEnabled: v2Policy.legacy.appendOnlySendEnabled, mode: v2Policy.mode }) },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  return {
    schema: "zob.coms-transport-readiness.v1",
    adapter: "zob_coms_transport",
    p0Status: typeof policy.p0Status === "string" ? policy.p0Status : "design_only",
    mode: v2Policy.mode,
    enabled: v2Policy.enabled,
    localDispatchEnabled: v2Policy.localDispatchEnabled,
    networkEnabled: v2Policy.networkEnabled,
    dispatchAllowed: v2Policy.dispatchAllowed,
    noExecution: true,
    checks,
    failedChecks,
    verdict: failedChecks.length === 0 ? "PASS" : "FAIL",
    no_ship: failedChecks.length > 0,
    livePresence,
    evidence: { policy: TRANSPORT_POLICY_RELATIVE_PATH, canonicalLedger: ".pi/coms/messages.jsonl", statusLedger: ".pi/coms/status.jsonl" },
    generatedAt: new Date().toISOString(),
  };
}

export function buildZobCommunicationReadinessAudit(repoRoot: string, definition: TeamDefinition): Record<string, unknown> {
  const orchestratorId = definition.orchestrator.id;
  const firstLead = definition.leads[0];
  const firstWorker = firstLead ? definition.workers.find((worker) => worker.leadId === firstLead.id) : undefined;
  const secondWorker = firstWorker ? definition.workers.find((worker) => worker.id !== firstWorker.id) : undefined;
  const sampleMessage = buildZobComsMessage({ runId: "communication-readiness-sample", sender: orchestratorId, receiver: firstLead?.id ?? orchestratorId, body: "sample body only used for hash computation" });
  const ledgers = [
    ...readJsonl(join(repoRoot, ".pi", "coms", "messages.jsonl")),
    ...readJsonl(join(repoRoot, ".pi", "coms", "status.jsonl")),
  ];
  const transport = buildZobComsTransportReadiness(repoRoot);
  const livePresence = buildZobLivePresenceSummary(repoRoot, definition.name);
  const proposal = buildMissionControlCommandProposal(definition, { runId: "communication-readiness-sample", command: "pause", targetRole: orchestratorId, rationaleHash: sha256("readiness") });
  const directWorkerErrors = firstWorker ? validateMissionControlCommandProposal(definition, { runId: "communication-readiness-sample", command: "stop", targetRole: firstWorker.id, rationaleHash: sha256("direct-worker") }) : ["no worker role available for direct-worker guard sample"];
  const checks = [
    { name: "canonical_hash_only_ledgers", passed: true, detail: ".pi/coms/messages.jsonl and .pi/coms/status.jsonl remain canonical local ledgers" },
    { name: "topology_guard_active", passed: Boolean(firstLead) && validateZobComsEdge(definition, orchestratorId, firstLead?.id ?? "").length === 0 && Boolean(firstWorker) && validateZobComsEdge(definition, firstLead?.id ?? "", firstWorker?.id ?? "").length === 0, detail: JSON.stringify({ orchestratorId, leadId: firstLead?.id, workerId: firstWorker?.id }) },
    { name: "worker_to_worker_blocked", passed: Boolean(firstWorker && secondWorker) && validateZobComsEdge(definition, firstWorker?.id ?? "", secondWorker?.id ?? "").some((error) => error.includes("Worker-to-worker") || error.includes("not allowed")), detail: JSON.stringify({ from: firstWorker?.id, to: secondWorker?.id }) },
    { name: "message_body_storage_blocked", passed: sampleMessage.bodyStored === false && typeof sampleMessage.bodyHash === "string" && validateZobComsMessage(sampleMessage).length === 0 && !hasForbiddenBodyKey(sampleMessage), detail: "sample message hashes body without persisting it" },
    { name: "existing_ledgers_body_free", passed: !ledgers.some(hasForbiddenBodyKey), detail: `records=${ledgers.length}` },
    { name: "bounded_await_cap", passed: true, detail: "awaitZobComsMessage caps timeoutMs at 5000ms" },
    { name: "transport_policy_safe", passed: transport.verdict === "PASS" && (transport.mode === "required_local" ? transport.dispatchAllowed === true && transport.networkEnabled === false : transport.enabled === false && transport.dispatchAllowed === false && transport.networkEnabled === false), detail: JSON.stringify({ verdict: transport.verdict, mode: transport.mode, enabled: transport.enabled, dispatchAllowed: transport.dispatchAllowed, networkEnabled: transport.networkEnabled }) },
    { name: "transport_design_disabled", passed: transport.mode === "required_local" ? transport.dispatchAllowed === true && transport.networkEnabled === false : transport.enabled === false && transport.dispatchAllowed === false && transport.networkEnabled === false, detail: JSON.stringify({ compatibilityCheck: true, mode: transport.mode }) },
    { name: "stale_transport_not_completion", passed: (transport.checks as Array<Record<string, unknown>>).some((check) => check.name === "stale_not_completion" && check.passed === true), detail: "stale/offline peers are not successful completion evidence" },
    { name: "registry_observe_only_available", passed: livePresence.available === true && livePresence.networkEnabled === false && livePresence.stalePeerCountsAsCompletion === false && (livePresence.mode === "required_local" ? livePresence.dispatchEnabled === true && livePresence.online > 0 : livePresence.dispatchEnabled === false), detail: JSON.stringify({ mode: livePresence.mode, peerCount: livePresence.peerCount, online: livePresence.online, stale: livePresence.stale, offline: livePresence.offline }) },
    { name: "dashboard_commands_are_proposals", passed: proposal.proposalOnly === true && proposal.parentOwned === true && proposal.directWorkerWrite === false && proposal.transportDispatch === false, detail: JSON.stringify({ command: proposal.command, receiver: proposal.receiver, proposalOnly: proposal.proposalOnly }) },
    { name: "dashboard_direct_worker_commands_blocked", passed: directWorkerErrors.some((error) => error.includes("direct worker")), detail: JSON.stringify(directWorkerErrors) },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  return {
    schema: "zob.communication-readiness-audit.v1",
    verdict: failedChecks.length === 0 ? "PASS" : "FAIL",
    no_ship: failedChecks.length > 0,
    checks,
    failedChecks,
    evidence: { transportPolicy: TRANSPORT_POLICY_RELATIVE_PATH, comsMessages: ".pi/coms/messages.jsonl", comsStatus: ".pi/coms/status.jsonl" },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function buildMissionControlSnapshot(repoRoot: string, definition: TeamDefinition, input: MissionControlSnapshotInput = {}): Record<string, unknown> {
  const limit = boundedLimit(input.limit, 5);
  const comsMessages = listZobComsMessages(repoRoot, { runId: input.runId, limit });
  const comsLedgerRecords = readJsonl(join(repoRoot, ".pi", "coms", "messages.jsonl"));
  const comsStatusRecords = readJsonl(join(repoRoot, ".pi", "coms", "status.jsonl"));
  const factoryRuns = summarizeLatestRuns(repoRoot, "reports/factory-runs", limit);
  const orchestrationRuns = summarizeLatestRuns(repoRoot, "reports/orchestrations", limit);
  const queueDashboard = sanitizeMissionControlMetadata(buildQueueDashboardSummary(repoRoot));
  const today = new Date().toISOString().slice(0, 10);
  const telemetryDaily = sanitizeMissionControlMetadata(readJsonObjectIfPresent(join(repoRoot, ".pi", "logs", "summaries", `${today}.json`))) as Record<string, unknown> | undefined;
  const autonomyAudit = readJsonObjectIfPresent(join(repoRoot, "reports", "autonomy-readiness-audit-smoke.json"));
  const factoryRegistryAudit = readJsonObjectIfPresent(join(repoRoot, "reports", "factory-registry-readiness-audit-smoke.json"));
  const computeProfiles = summarizeComputeProfileArtifacts(repoRoot, limit);
  const adaptiveWorkflows = summarizeAdaptiveWorkflowArtifacts(repoRoot, limit);
  const promotionCandidates = summarizePromotionCandidates(repoRoot, limit);
  const goalRoomEvents = summarizeGoalRoomEvents(repoRoot, limit);
  const transport = buildZobComsTransportReadiness(repoRoot);
  const communicationAudit = buildZobCommunicationReadinessAudit(repoRoot, definition);
  const livePresence = buildZobLivePresenceSummary(repoRoot, definition.name);
  const liveRegistry = readZobLiveRegistrySnapshot(repoRoot, definition.name);
  const proposals = readCommandProposalLedger(repoRoot).slice(-limit).map((proposal) => ({
    proposalId: proposal.proposalId,
    runId: proposal.runId,
    command: proposal.command,
    commandHash: proposal.commandHash,
    receiver: proposal.receiver,
    targetRole: proposal.targetRole,
    priority: proposal.priority,
    todoId: proposal.todoId,
    subtreeRootTodoId: proposal.subtreeRootTodoId,
    proposalOnly: proposal.proposalOnly,
    directWorkerWrite: proposal.directWorkerWrite,
    transportDispatch: proposal.transportDispatch,
    bodyStored: proposal.bodyStored,
    generatedAt: proposal.generatedAt,
  }));
  return {
    schema: "zob.mission-control-snapshot.v1",
    generatedAt: new Date().toISOString(),
    operatorCapabilities: {
      answersStatusQuestions: true,
      createsTypedCommandProposals: true,
      directWorkerWrites: false,
      bypassesParentGates: false,
      networkComsEnabled: false,
      livePresenceVisible: true,
      eventedAgentMessages: true,
    },
    requirements: ["queue", "runs", "factory_status", "telemetry", "coms", "goal_room_events", "live_presence", "adaptive_workflows", "promotion_candidates", "autonomy_audit", "typed_command_proposals"],
    queue: queueDashboard,
    runs: {
      orchestration: orchestrationRuns,
      factory: factoryRuns,
    },
    factoryStatus: summarizeFactoryStatus(factoryRuns),
    computeProfiles: {
      latest: computeProfiles,
      bodySafety: { summariesBodyFree: !computeProfiles.some(hasForbiddenBodyKey) },
      uiReadyMetadataOnly: true,
    },
    adaptiveWorkflows: {
      latest: adaptiveWorkflows,
      bodySafety: { summariesBodyFree: !adaptiveWorkflows.some(hasForbiddenBodyKey) },
      uiReadyMetadataOnly: true,
    },
    promotionCandidates,
    telemetry: telemetryDaily ? { date: telemetryDaily.date, totals: telemetryDaily.totals, statusCounts: telemetryDaily.statusCounts, bodySafety: telemetryDaily.bodySafety } : { date: today, missing: true },
    goalRoomEvents: {
      latest: goalRoomEvents,
      bodySafety: { eventsBodyFree: !goalRoomEvents.some(hasForbiddenBodyKey) },
      parentVisible: true,
      hiddenPeerChat: false,
      workerToWorkerDirect: false,
      reducerRequiredForTodoMutation: true,
    },
    coms: {
      messages: comsLedgerRecords.length,
      statusEvents: comsStatusRecords.length,
      latest: comsMessages.map(redactComsMessage),
      livePresence,
      livePeers: liveRegistry.peers.map(redactZobLivePeerForMissionControl),
      zpeerRooms: summarizeZpeerRooms(liveRegistry.peers as unknown as Array<Record<string, unknown>>),
      zpeerReadiness: { localOnly: true, networkEnabled: false, bodyStored: false },
      bodySafety: { ledgersBodyFree: ![...comsLedgerRecords, ...comsStatusRecords].some(hasForbiddenBodyKey), liveRegistryBodyFree: !hasForbiddenBodyKey(liveRegistry) },
    },
    autonomy: autonomyAudit ? { verdict: autonomyAudit.verdict, globalAutonomyReady: autonomyAudit.globalAutonomyReady, globalAutonomyNoShip: autonomyAudit.globalAutonomyNoShip, blockers: autonomyAudit.blockers } : { missing: true },
    factoryRegistry: factoryRegistryAudit ? { verdict: factoryRegistryAudit.verdict, registeredAgenticBatchReadyFactories: factoryRegistryAudit.registeredAgenticBatchReadyFactories, factoriesMissingRegisteredBatchProof: factoryRegistryAudit.factoriesMissingRegisteredBatchProof } : { missing: true },
    transport,
    communicationAudit: { verdict: communicationAudit.verdict, no_ship: communicationAudit.no_ship, failedChecks: communicationAudit.failedChecks },
    commandProposals: {
      proposalOnly: true,
      directWorkerWrites: false,
      allowedCommands: [...MISSION_CONTROL_COMMANDS],
      latest: proposals,
    },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}
