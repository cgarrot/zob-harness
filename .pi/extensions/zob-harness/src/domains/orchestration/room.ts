import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SUPERVISED_READONLY_CHILD_TOOLS, SUPERVISED_SMOKE_CHILD_TOOLS } from "../../core/constants.js";
import type { OrchestrateExecutionMode, TeamDefinition } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { isRecord } from "../../core/utils/records.js";

function orchestrationLedger(runDir: string, entry: Record<string, unknown>): void {
  appendFileSync(join(runDir, "ledger.jsonl"), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
}

function buildOrchestrationMessages(definition: TeamDefinition, plan: Record<string, unknown>, runId: string, execution: OrchestrateExecutionMode): Array<Record<string, unknown>> {
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.filter(isRecord) : [];
  return tasks.map((task, index) => {
    const taskId = typeof task.id === "string" ? task.id : `task-${index + 1}`;
    const taskType = typeof task.type === "string" ? task.type : "unknown";
    const leadId = typeof task.leadId === "string" ? task.leadId : undefined;
    const workerId = typeof task.workerId === "string" ? task.workerId : undefined;
    const sender = taskType === "lead_plan" ? definition.orchestrator.id : (typeof task.proposedBy === "string" ? task.proposedBy : definition.orchestrator.id);
    const receiver = taskType === "lead_plan" ? (leadId ?? "unknown-lead") : (workerId ?? leadId ?? "unknown-worker");
    const contractFingerprint = JSON.stringify({
      task: typeof task.task === "string" ? task.task : "",
      expected_outcome: typeof task.expected_outcome === "string" ? task.expected_outcome : "",
      required_tools: Array.isArray(task.required_tools) ? task.required_tools : [],
      output_contract: typeof task.output_contract === "string" ? task.output_contract : "",
      must_do: Array.isArray(task.must_do) ? task.must_do : [],
      must_not_do: Array.isArray(task.must_not_do) ? task.must_not_do : [],
      context: typeof task.context === "string" ? task.context : "",
    });
    return {
      schema: "zob.orchestration-message.v1",
      msgId: `${runId}:${taskId}`,
      runId,
      parentId: typeof task.parent === "string" ? task.parent : definition.orchestrator.id,
      sender,
      receiver,
      receiverAgent: typeof task.agent === "string" ? task.agent : "unknown-agent",
      role: typeof task.role === "string" ? task.role : "unknown-role",
      taskId,
      taskType,
      goalId: typeof task.goalId === "string" ? task.goalId : undefined,
      todoId: typeof task.todoId === "string" ? task.todoId : undefined,
      todoRef: isRecord(task.todoRef) ? task.todoRef : undefined,
      taskHash: sha256(contractFingerprint),
      outputHash: null,
      status: "planned",
      ack: "not_sent",
      execution,
      noExecution: true,
      timestamp: new Date().toISOString(),
    };
  });
}

function writeOrchestrationMessages(runDir: string, messages: Array<Record<string, unknown>>): void {
  writeFileSync(join(runDir, "messages.jsonl"), messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length > 0 ? "\n" : ""), "utf8");
}

function buildOrchestrationStatuses(messages: Array<Record<string, unknown>>, runId: string, execution: OrchestrateExecutionMode): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    schema: "zob.orchestration-status.v1",
    event: "status_planned",
    runId,
    msgId: typeof message.msgId === "string" ? message.msgId : "unknown-message",
    parentId: typeof message.parentId === "string" ? message.parentId : "unknown-parent",
    sender: typeof message.sender === "string" ? message.sender : "unknown-sender",
    receiver: typeof message.receiver === "string" ? message.receiver : "unknown-receiver",
    receiverAgent: typeof message.receiverAgent === "string" ? message.receiverAgent : "unknown-agent",
    role: typeof message.role === "string" ? message.role : "unknown-role",
    taskId: typeof message.taskId === "string" ? message.taskId : "unknown-task",
    taskHash: typeof message.taskHash === "string" ? message.taskHash : "",
    outputHash: null,
    status: "planned",
    ack: "not_sent",
    ping: "not_started",
    running: false,
    startedAt: null,
    lastPingAt: null,
    lastAckAt: null,
    completedAt: null,
    execution,
    noExecution: true,
    supervisedSmoke: execution === "supervised_smoke" ? { planned: true, liveChildExecution: false, allowedTools: [...SUPERVISED_SMOKE_CHILD_TOOLS] } : undefined,
    supervisedReadonly: execution === "supervised_readonly" ? { planned: true, parentOwnedDispatch: true, allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS] } : undefined,
    timestamp: new Date().toISOString(),
  }));
}

function writeOrchestrationStatuses(runDir: string, statuses: Array<Record<string, unknown>>, runId: string, execution: OrchestrateExecutionMode): void {
  writeFileSync(join(runDir, "status.jsonl"), statuses.map((status) => JSON.stringify(status)).join("\n") + (statuses.length > 0 ? "\n" : ""), "utf8");
  const latestByMsgId = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < statuses.length; index += 1) {
    const status = statuses[index];
    latestByMsgId.set(typeof status.msgId === "string" ? status.msgId : `unknown-${index}`, status);
  }
  const snapshotStatuses = [...latestByMsgId.values()];
  const byStatus = snapshotStatuses.reduce<Record<string, number>>((counts, status) => {
    const key = typeof status.status === "string" ? status.status : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const byAck = snapshotStatuses.reduce<Record<string, number>>((counts, status) => {
    const key = typeof status.ack === "string" ? status.ack : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const byPing = snapshotStatuses.reduce<Record<string, number>>((counts, status) => {
    const key = typeof status.ping === "string" ? status.ping : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const snapshot = {
    schema: "zob.orchestration-status-snapshot.v1",
    runId,
    execution,
    total: snapshotStatuses.length,
    events: statuses.length,
    byStatus,
    byAck,
    byPing,
    running: snapshotStatuses.filter((status) => status.running === true).length,
    noExecution: snapshotStatuses.every((status) => status.noExecution !== false),
    supervisedSmoke: execution === "supervised_smoke" ? { planned: true, liveChildExecution: false, allowedTools: [...SUPERVISED_SMOKE_CHILD_TOOLS] } : undefined,
    supervisedReadonly: execution === "supervised_readonly" ? { parentOwnedDispatch: true, allowedTools: [...SUPERVISED_READONLY_CHILD_TOOLS] } : undefined,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "status-snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
}

export function writeOrchestrationRoomArtifacts(input: {
  runDir: string;
  runId: string;
  definition: TeamDefinition;
  plan: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  statuses: Array<Record<string, unknown>>;
  execution: OrchestrateExecutionMode;
  goal: string;
  originalUserAsk: string;
  goalId?: string;
  rootTodoId?: string;
  comsMirrored?: number;
  adaptiveWorkflow?: Record<string, unknown>;
}): { roomDir: string; artifacts: string[] } {
  const roomDir = join(input.runDir, "room");
  mkdirSync(roomDir, { recursive: true });
  const participants = [input.definition.orchestrator.id, ...input.definition.leads.map((lead) => lead.id), ...input.definition.workers.map((worker) => worker.id)];
  const roleById = new Map<string, { agent: string; roleType: string; leadId?: string }>();
  roleById.set(input.definition.orchestrator.id, { agent: input.definition.orchestrator.agent, roleType: "orchestrator" });
  for (const lead of input.definition.leads) roleById.set(lead.id, { agent: lead.agent, roleType: "lead" });
  for (const worker of input.definition.workers) roleById.set(worker.id, { agent: worker.agent, roleType: "worker", leadId: worker.leadId });

  const room = {
    schema: "zob.room.v1",
    runId: input.runId,
    goalHash: sha256(input.goal),
    originalUserAskHash: sha256(input.originalUserAsk),
    profile: input.definition.name,
    participants,
    policy: {
      bodyPolicy: "hash_only_by_default",
      allowedEdges: "from team topology",
      networked: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
      parentOwnedPreflight: true,
      parentDispatchOnly: true,
      workerSpawnsWorker: false,
    },
    createdAt: new Date().toISOString(),
  };

  const roomMessages = input.messages.map((message) => {
    const receiver = typeof message.receiver === "string" ? message.receiver : "unknown";
    const sender = typeof message.sender === "string" ? message.sender : "unknown";
    const taskType = typeof message.taskType === "string" ? message.taskType : "task";
    return {
      schema: "zob.room-message.v1",
      msgId: typeof message.msgId === "string" ? message.msgId : `${input.runId}:${sender}:${receiver}`,
      runId: input.runId,
      threadId: taskType,
      goalId: typeof message.goalId === "string" ? message.goalId : input.goalId,
      todoId: typeof message.todoId === "string" ? message.todoId : input.rootTodoId,
      sender,
      receiver,
      type: taskType === "lead_plan" || taskType === "worker_contract" ? "task" : "status",
      status: typeof message.status === "string" ? message.status : "planned",
      summary: `${sender} -> ${receiver}: ${taskType} handoff (${input.execution})`,
      taskHash: typeof message.taskHash === "string" ? message.taskHash : null,
      outputHash: typeof message.outputHash === "string" ? message.outputHash : null,
      artifactRefs: ["orchestration-plan.json", "messages.jsonl", "status.jsonl"],
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
      timestamp: typeof message.timestamp === "string" ? message.timestamp : new Date().toISOString(),
    };
  });

  const roomStatuses = input.statuses.map((status) => ({
    schema: "zob.room-status.v1",
    runId: input.runId,
    msgId: typeof status.msgId === "string" ? status.msgId : "unknown-message",
    actor: typeof status.receiver === "string" ? status.receiver : "unknown-actor",
    status: typeof status.status === "string" ? status.status : "unknown",
    ack: typeof status.ack === "string" ? status.ack : "unknown",
    ping: typeof status.ping === "string" ? status.ping : "unknown",
    running: status.running === true,
    outputHash: typeof status.outputHash === "string" ? status.outputHash : null,
    bodyStored: false,
    timestamp: typeof status.timestamp === "string" ? status.timestamp : new Date().toISOString(),
  }));

  const decisions = [
    {
      schema: "zob.room-decision.v1",
      runId: input.runId,
      decisionId: `${input.runId}:parent-owned-preflight`,
      summary: "Parent-owned preflight and dispatch boundary preserved; worker-to-worker communication remains blocked by default.",
      evidenceRefs: ["orchestration-plan.json", "validation.json"],
      bodyStored: false,
      timestamp: new Date().toISOString(),
    },
  ];

  const blockers = input.statuses
    .filter((status) => status.status === "failed" || status.ping === "blocked")
    .map((status, index) => ({
      schema: "zob.room-blocker.v1",
      runId: input.runId,
      blockerId: `${input.runId}:blocker-${index + 1}`,
      actor: typeof status.receiver === "string" ? status.receiver : "unknown-actor",
      summary: `Blocked or failed status for ${typeof status.taskId === "string" ? status.taskId : "unknown-task"}`,
      status: typeof status.status === "string" ? status.status : "unknown",
      evidenceRefs: ["status.jsonl", "validation.json"],
      bodyStored: false,
      timestamp: typeof status.timestamp === "string" ? status.timestamp : new Date().toISOString(),
    }));

  const latestByRole: Record<string, string> = {};
  for (const participant of participants) {
    const role = roleById.get(participant);
    latestByRole[participant] = `${role?.roleType ?? "role"} ${role?.agent ?? "unknown-agent"}: ${input.execution} planned metadata`;
  }
  const tasks = Array.isArray(input.plan.tasks) ? input.plan.tasks.filter(isRecord) : [];
  const latestStatusByMsgId = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < input.statuses.length; index += 1) {
    const status = input.statuses[index];
    latestStatusByMsgId.set(typeof status.msgId === "string" ? status.msgId : `unknown-${index}`, status);
  }
  const latestStatuses = [...latestStatusByMsgId.values()];
  const contextScope = {
    schema: "zob.context-scope.v1",
    scopeId: `${input.runId}-orchestration-context-scope`,
    runId: input.runId,
    allowedBrains: ["harness-system"],
    allowedSources: ["orchestration-run-artifacts", "zob-harness-orchestration-room"],
    forbiddenSources: [".env", ".env.*", "secrets", "raw-conversation-history", "node_modules", "dist", "build"],
    agentProfile: "orchestration-room",
    maxContextTokens: 4000,
    freshnessPolicy: "current_run_artifacts",
    readPolicy: "bounded_metadata_only",
    writePolicy: "proposal_only",
    citationRequired: true,
    contextPackRequired: true,
    sourceScopeRequired: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const contextCitations = [
    `harness-system:orchestration-run-artifacts:${input.runId}/manifest.json`,
    `harness-system:orchestration-run-artifacts:${input.runId}/validation.json`,
  ];
  const adaptiveWorkflow = isRecord(input.adaptiveWorkflow) ? input.adaptiveWorkflow : undefined;
  const adaptiveWorkflowRefs = Array.isArray(adaptiveWorkflow?.adaptiveWorkflowRefs) ? adaptiveWorkflow.adaptiveWorkflowRefs.filter((ref): ref is string => typeof ref === "string") : [];
  const documentationRefs = ["documentation-policy.json", "guidance-index.json", "docs/layer-doc-pack.json", "docs/role-doc-packs.json", "docs/writeback-proposals.json"].filter((ref) => adaptiveWorkflowRefs.includes(ref));
  const contextPack = {
    schema: "zob.context-pack.v2",
    runId: input.runId,
    profile: input.definition.name,
    goal: "redacted; see goalHash in room.json",
    goalHash: sha256(input.goal),
    currentPhase: input.execution === "plan_only" ? "planning" : input.execution,
    currentState: latestStatuses.some((status) => status.running === true) ? "running" : latestStatuses.some((status) => status.status === "failed") ? "failed" : latestStatuses.some((status) => status.status === "completed") ? "completed" : "planned",
    decisions: decisions.map((decision) => decision.summary),
    openQuestions: tasks.length === 0 ? ["No tasks planned"] : [],
    blockers: blockers.map((blocker) => blocker.summary),
    evidenceRefs: ["manifest.json", "orchestration-plan.json", "messages.jsonl", "status.jsonl", "validation.json", "room/blockers.jsonl", ...adaptiveWorkflowRefs],
    todoGraphBinding: input.rootTodoId ? { goalId: input.goalId, rootTodoId: input.rootTodoId, attachmentPolicy: "messages_delegations_blockers_claims_evidence_attach_to_todo", bodyStored: false } : undefined,
    contextScope,
    contextLoading: { contextScopeRequired: true, boundedContextPack: true, agentLoadsEntireCorpus: false, citationRequired: true, writePolicy: "proposal_only" },
    sourceLocks: [
      { sourceId: "orchestration-run-artifacts", brainId: "harness-system", sourceRoot: `reports/orchestrations/${input.runId}`, sourceRootHash: sha256(`reports/orchestrations/${input.runId}`) },
      { sourceId: "zob-harness-orchestration-room", brainId: "harness-system", sourceRoot: ".pi/extensions/zob-harness/src/orchestration", sourceRootHash: sha256(".pi/extensions/zob-harness/src/orchestration") },
    ],
    citations: contextCitations,
    latestByRole,
    ruleProfile: {
      profile: "orchestration-engineer",
      rulePacks: ["always", "project", "orchestration", "oracle"],
      oracleRequired: true,
      noShipConditions: ["worker-to-worker edge accepted without policy", "networked coms enabled", "DONE.sentinel written without evidence and oracle gate", "plaintext body persisted in coms or room", "documentation policy missing for multi-layer workflow", "model/security downgrade without explicit policy", "large scale without budget/approval/oracle"],
    },
    modelRoutingSummary: adaptiveWorkflow ? { modelPolicyRef: adaptiveWorkflow.modelPolicyRef, scalePolicyRef: adaptiveWorkflow.scalePolicyRef } : {},
    adaptiveWorkflow: adaptiveWorkflow ? {
      refs: adaptiveWorkflowRefs,
      promptPolicyRef: adaptiveWorkflow.promptPolicyRef,
      documentationPolicyRef: adaptiveWorkflow.documentationPolicyRef,
      guidanceIndexRef: adaptiveWorkflow.guidanceIndexRef,
      tempAgentRosterRef: adaptiveWorkflow.tempAgentRosterRef,
      rootNonCoding: adaptiveWorkflow.rootNonCoding,
      parentOwnedDispatch: adaptiveWorkflow.parentOwnedDispatch,
      childDirectDispatch: adaptiveWorkflow.childDirectDispatch,
      bodyStored: false,
    } : undefined,
    documentationRefs,
    roomPolicy: room.policy,
    promptBodiesStored: false,
    outputBodiesStored: false,
    bodyStored: false,
    generatedAt: new Date().toISOString(),
  };

  const evidenceIndex = {
    schema: "zob.evidence-index.v1",
    runId: input.runId,
    artifacts: [
      { artifact: "manifest.json", kind: "manifest", hash: existsSync(join(input.runDir, "manifest.json")) ? sha256(readFileSync(join(input.runDir, "manifest.json"), "utf8")) : null },
      { artifact: "orchestration-plan.json", kind: "plan", hash: existsSync(join(input.runDir, "orchestration-plan.json")) ? sha256(readFileSync(join(input.runDir, "orchestration-plan.json"), "utf8")) : null },
      { artifact: "messages.jsonl", kind: "messages", hash: existsSync(join(input.runDir, "messages.jsonl")) ? sha256(readFileSync(join(input.runDir, "messages.jsonl"), "utf8")) : null },
      { artifact: "status.jsonl", kind: "status", hash: existsSync(join(input.runDir, "status.jsonl")) ? sha256(readFileSync(join(input.runDir, "status.jsonl"), "utf8")) : null },
      { artifact: "validation.json", kind: "validation", hash: existsSync(join(input.runDir, "validation.json")) ? sha256(readFileSync(join(input.runDir, "validation.json"), "utf8")) : null },
      ...adaptiveWorkflowRefs.map((artifact) => ({ artifact, kind: "adaptive_workflow", hash: existsSync(join(input.runDir, artifact)) ? sha256(readFileSync(join(input.runDir, artifact), "utf8")) : null })),
    ],
    comsMirrored: input.comsMirrored ?? 0,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(join(roomDir, "room.json"), JSON.stringify(room, null, 2), "utf8");
  writeFileSync(join(roomDir, "messages.jsonl"), roomMessages.map((message) => JSON.stringify(message)).join("\n") + (roomMessages.length > 0 ? "\n" : ""), "utf8");
  writeFileSync(join(roomDir, "status.jsonl"), roomStatuses.map((status) => JSON.stringify(status)).join("\n") + (roomStatuses.length > 0 ? "\n" : ""), "utf8");
  writeFileSync(join(roomDir, "decisions.jsonl"), decisions.map((decision) => JSON.stringify(decision)).join("\n") + "\n", "utf8");
  writeFileSync(join(roomDir, "blockers.jsonl"), blockers.map((blocker) => JSON.stringify(blocker)).join("\n") + (blockers.length > 0 ? "\n" : ""), "utf8");
  writeFileSync(join(roomDir, "context-pack.json"), JSON.stringify(contextPack, null, 2), "utf8");
  writeFileSync(join(roomDir, "evidence-index.json"), JSON.stringify(evidenceIndex, null, 2), "utf8");
  return { roomDir, artifacts: ["room/room.json", "room/messages.jsonl", "room/status.jsonl", "room/decisions.jsonl", "room/blockers.jsonl", "room/context-pack.json", "room/evidence-index.json"] };
}

export { buildOrchestrationMessages, buildOrchestrationStatuses, orchestrationLedger, writeOrchestrationMessages, writeOrchestrationStatuses };
