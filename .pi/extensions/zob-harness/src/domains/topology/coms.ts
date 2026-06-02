import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { TeamDefinition, ZobComsMessageInput } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { readJsonl } from "../../core/utils/json.js";

function comsDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "coms");
}

function comsMessagesPath(repoRoot: string): string {
  return join(comsDir(repoRoot), "messages.jsonl");
}

function comsStatusPath(repoRoot: string): string {
  return join(comsDir(repoRoot), "status.jsonl");
}

type ZobComsStatusTransitionOptions = {
  outputHash?: string | null;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function completionEvidencePresent(repoRoot: string, msgId: string, message: Record<string, unknown>, options: ZobComsStatusTransitionOptions): boolean {
  if (nonEmptyString(options.outputHash)) return true;
  if (nonEmptyString(message.outputHash)) return true;
  const messages = readJsonl(comsMessagesPath(repoRoot));
  return messages.some((candidate) => candidate.parentId === msgId && nonEmptyString(candidate.outputHash) && (candidate.status === "completed" || candidate.kind === "live_response_ref" || String(candidate.kind ?? "").endsWith("_reply")));
}

export function validateZobComsEdge(definition: TeamDefinition, sender: string, receiver: string): string[] {
  const errors: string[] = [];
  const orchestratorId = definition.orchestrator.id;
  const leadIds = new Set(definition.leads.map((lead) => lead.id));
  const workerToLead = new Map(definition.workers.map((worker) => [worker.id, worker.leadId]));
  const leadToWorkers = new Map(definition.leads.map((lead) => [lead.id, new Set((lead.workerIds ?? definition.workers.filter((worker) => worker.leadId === lead.id).map((worker) => worker.id)))]));
  const knownIds = new Set([orchestratorId, ...leadIds, ...workerToLead.keys()]);
  if (!knownIds.has(sender)) errors.push(`Unknown coms sender '${sender}'`);
  if (!knownIds.has(receiver)) errors.push(`Unknown coms receiver '${receiver}'`);
  if (errors.length > 0) return errors;
  if (sender === orchestratorId && leadIds.has(receiver)) return [];
  if (leadIds.has(sender) && receiver === orchestratorId) return [];
  if (leadIds.has(sender) && leadToWorkers.get(sender)?.has(receiver)) return [];
  if (workerToLead.has(sender) && workerToLead.get(sender) === receiver) return [];
  if (workerToLead.has(sender) && workerToLead.has(receiver)) errors.push("Worker-to-worker coms are blocked by topology guard");
  else errors.push(`Coms edge not allowed by team topology: ${sender} -> ${receiver}`);
  return errors;
}

export function buildZobComsMessage(input: ZobComsMessageInput): Record<string, unknown> {
  const bodyPolicy = input.bodyPolicy ?? "hash_only";
  const bodyHash = input.body ? sha256(input.body) : undefined;
  return {
    schema: "zob.coms-message.v1",
    msgId: input.taskId ? `${input.runId}:${input.sender}:${input.receiver}:${input.taskId}` : `${input.runId}:${input.sender}:${input.receiver}:${Date.now()}`,
    runId: input.runId,
    parentId: input.parentId,
    sender: input.sender,
    receiver: input.receiver,
    kind: input.kind ?? "handoff",
    taskId: input.taskId,
    taskHash: input.taskHash ?? bodyHash,
    outputHash: input.outputHash ?? null,
    status: input.status ?? "queued",
    ack: input.ack ?? "not_sent",
    bodyPolicy,
    bodyStored: false,
    bodyHash,
    metadata: input.metadata ?? {},
    timestamp: new Date().toISOString(),
  };
}

export function validateZobComsMessage(message: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of ["schema", "msgId", "runId", "sender", "receiver", "kind", "status", "bodyPolicy"]) {
    if (typeof message[field] !== "string") errors.push(`Coms message missing string field '${field}'`);
  }
  if (message.schema !== "zob.coms-message.v1") errors.push("Coms message schema must be zob.coms-message.v1");
  if ("body" in message || "task" in message || "output" in message || "prompt" in message) errors.push("Coms message must not store prompt/task/output bodies");
  if (message.bodyStored !== false) errors.push("Coms message bodyStored must be false");
  if (message.bodyPolicy !== "hash_only" && message.bodyPolicy !== "redacted") errors.push("Coms bodyPolicy must be hash_only or redacted");
  if (message.taskHash !== undefined && message.taskHash !== null && typeof message.taskHash !== "string") errors.push("Coms taskHash must be string/null");
  if (message.outputHash !== undefined && message.outputHash !== null && typeof message.outputHash !== "string") errors.push("Coms outputHash must be string/null");
  if (message.status === "completed" && !nonEmptyString(message.outputHash)) errors.push("Coms completed message requires outputHash evidence");
  return errors;
}

export function appendZobComsMessage(repoRoot: string, definition: TeamDefinition, input: ZobComsMessageInput): Record<string, unknown> {
  const edgeErrors = validateZobComsEdge(definition, input.sender, input.receiver);
  if (edgeErrors.length > 0) throw new Error(edgeErrors.join("; "));
  const message = buildZobComsMessage(input);
  const messageErrors = validateZobComsMessage(message);
  if (messageErrors.length > 0) throw new Error(messageErrors.join("; "));
  mkdirSync(comsDir(repoRoot), { recursive: true });
  appendFileSync(comsMessagesPath(repoRoot), `${JSON.stringify(message)}\n`, "utf8");
  appendFileSync(comsStatusPath(repoRoot), `${JSON.stringify({ schema: "zob.coms-status.v1", event: "message_appended", msgId: message.msgId, runId: message.runId, sender: message.sender, receiver: message.receiver, status: message.status, ack: message.ack, outputHash: message.outputHash ?? null, timestamp: message.timestamp, bodyStored: false })}\n`, "utf8");
  return message;
}

function buildZobComsDerivedMessage(message: Record<string, unknown>, events: Array<Record<string, unknown>>, messages: Array<Record<string, unknown>>): Record<string, unknown> {
  const msgId = String(message.msgId ?? "");
  const ownEvents = events.filter((event) => event.msgId === msgId);
  const latestStatus = [...ownEvents].reverse().find((event) => typeof event.status === "string");
  const latestAck = [...ownEvents].reverse().find((event) => typeof event.ack === "string");
  const replyIds = messages.filter((candidate) => candidate.parentId === msgId).map((candidate) => candidate.msgId).filter((replyId): replyId is string => typeof replyId === "string");
  return {
    ...message,
    status: typeof latestStatus?.status === "string" ? latestStatus.status : message.status,
    ack: typeof latestAck?.ack === "string" ? latestAck.ack : message.ack,
    replyIds,
    replies: replyIds.length,
    lastEvent: ownEvents.length > 0 ? ownEvents[ownEvents.length - 1] : undefined,
  };
}

function appendZobComsStatusEvent(repoRoot: string, event: Record<string, unknown>): Record<string, unknown> {
  if ("body" in event || "task" in event || "output" in event || "prompt" in event || "content" in event || "message" in event || "text" in event || "rationale" in event || "diff" in event || "patch" in event) throw new Error("Coms status event must not store prompt/task/output bodies");
  mkdirSync(comsDir(repoRoot), { recursive: true });
  const record = { schema: "zob.coms-status.v1", timestamp: new Date().toISOString(), ...event, bodyStored: false };
  appendFileSync(comsStatusPath(repoRoot), `${JSON.stringify(record)}\n`, "utf8");
  return getZobComsMessage(repoRoot, String(event.msgId)) ?? record;
}

export function listZobComsMessages(repoRoot: string, filter: { runId?: string; receiver?: string; sender?: string; status?: string; limit?: number } = {}): Array<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 20)));
  const messages = readJsonl(comsMessagesPath(repoRoot));
  const events = readJsonl(comsStatusPath(repoRoot));
  return messages
    .map((message) => buildZobComsDerivedMessage(message, events, messages))
    .filter((message) => !filter.runId || message.runId === filter.runId)
    .filter((message) => !filter.receiver || message.receiver === filter.receiver)
    .filter((message) => !filter.sender || message.sender === filter.sender)
    .filter((message) => !filter.status || message.status === filter.status)
    .slice(-limit);
}

export function getZobComsMessage(repoRoot: string, msgId: string): Record<string, unknown> | undefined {
  const messages = readJsonl(comsMessagesPath(repoRoot));
  const message = messages.find((candidate) => candidate.msgId === msgId);
  return message ? buildZobComsDerivedMessage(message, readJsonl(comsStatusPath(repoRoot)), messages) : undefined;
}

export function ackZobComsMessage(repoRoot: string, msgId: string, actor: string): Record<string, unknown> {
  const message = getZobComsMessage(repoRoot, msgId);
  if (!message) throw new Error(`Coms message not found: ${msgId}`);
  if (message.receiver !== actor) throw new Error(`Coms ACK actor must be receiver: ${actor}`);
  return appendZobComsStatusEvent(repoRoot, { event: "ack", msgId, runId: message.runId, actor, ack: "received", status: "acknowledged" });
}

export function transitionZobComsStatus(repoRoot: string, msgId: string, actor: string, status: string, options: ZobComsStatusTransitionOptions = {}): Record<string, unknown> {
  const message = getZobComsMessage(repoRoot, msgId);
  if (!message) throw new Error(`Coms message not found: ${msgId}`);
  if (message.sender !== actor && message.receiver !== actor) throw new Error(`Coms status actor must be sender or receiver: ${actor}`);
  if (status === "completed" && !completionEvidencePresent(repoRoot, msgId, message, options)) throw new Error("Coms completed status requires outputHash or live response evidence");
  const event: Record<string, unknown> = { event: "status", msgId, runId: message.runId, actor, status };
  if (nonEmptyString(options.outputHash)) event.outputHash = options.outputHash;
  return appendZobComsStatusEvent(repoRoot, event);
}

export function replyZobComsMessage(repoRoot: string, definition: TeamDefinition, msgId: string, input: Omit<ZobComsMessageInput, "runId" | "parentId">): Record<string, unknown> {
  const parent = getZobComsMessage(repoRoot, msgId);
  if (!parent || typeof parent.runId !== "string") throw new Error(`Coms parent message not found: ${msgId}`);
  const reply = appendZobComsMessage(repoRoot, definition, { ...input, runId: parent.runId, parentId: msgId, kind: input.kind ?? "reply" });
  appendZobComsStatusEvent(repoRoot, { event: "reply", msgId, runId: parent.runId, actor: input.sender, replyMsgId: reply.msgId, status: parent.status, outputHash: reply.outputHash ?? null });
  return reply;
}

export async function awaitZobComsMessage(repoRoot: string, filter: { runId?: string; receiver?: string; status?: string; timeoutMs?: number; pollMs?: number } = {}): Promise<Record<string, unknown> | undefined> {
  const timeoutMs = Math.max(0, Math.min(5000, Math.floor(filter.timeoutMs ?? 1000)));
  const pollMs = Math.max(25, Math.min(1000, Math.floor(filter.pollMs ?? 100)));
  const deadline = Date.now() + timeoutMs;
  do {
    const [message] = listZobComsMessages(repoRoot, { runId: filter.runId, receiver: filter.receiver, status: filter.status, limit: 1 });
    if (message) return message;
    if (Date.now() >= deadline) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  return undefined;
}

function mirrorOrchestrationToComs(repoRoot: string, definition: TeamDefinition, messages: Array<Record<string, unknown>>): number {
  let mirrored = 0;
  for (const message of messages) {
    const sender = typeof message.sender === "string" ? message.sender : "";
    const receiver = typeof message.receiver === "string" ? message.receiver : "";
    const edgeErrors = validateZobComsEdge(definition, sender, receiver);
    if (edgeErrors.length > 0) continue;
    appendZobComsMessage(repoRoot, definition, {
      runId: typeof message.runId === "string" ? message.runId : "unknown-run",
      sender,
      receiver,
      kind: "plan_only_handoff",
      taskId: typeof message.taskId === "string" ? message.taskId : undefined,
      parentId: typeof message.parentId === "string" ? message.parentId : undefined,
      taskHash: typeof message.taskHash === "string" ? message.taskHash : undefined,
      outputHash: typeof message.outputHash === "string" ? message.outputHash : null,
      status: typeof message.status === "string" ? message.status : "planned",
      ack: typeof message.ack === "string" ? message.ack : "not_sent",
      metadata: { source: "orchestrate_run", execution: typeof message.execution === "string" ? message.execution : "plan_only", noExecution: true },
    });
    mirrored += 1;
  }
  return mirrored;
}

export { mirrorOrchestrationToComs };
