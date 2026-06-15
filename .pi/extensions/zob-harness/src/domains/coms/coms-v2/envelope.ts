import { sha256 } from "../../../core/utils/hashing.js";
import { isRecord } from "../../../core/utils/records.js";

const FORBIDDEN_PERSISTED_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "rationale", "text", "diff", "patch"]);
const ENVELOPE_TYPES = new Set(["ping", "pong", "prompt", "ack", "response", "error"]);
const ZPEER_PRIORITIES = new Set(["normal", "urgent", "force"]);
const ZPEER_INTERRUPT_MODES = new Set(["none", "steer", "abort"]);
const ZPEER_INTERRUPT_STATUSES = new Set(["none", "urgent_delivered", "force_accepted", "force_downgraded", "force_blocked", "force_timeout"]);

export type ZobLiveEnvelopeType = "ping" | "pong" | "prompt" | "ack" | "response" | "error";
export type ZpeerInterruptPriority = "normal" | "urgent" | "force";
export type ZpeerInterruptMode = "none" | "steer" | "abort";
export type ZpeerInterruptStatus = "none" | "urgent_delivered" | "force_accepted" | "force_downgraded" | "force_blocked" | "force_timeout";

export interface ZobLiveEnvelope {
  schema: "zob.live-envelope.v1";
  type: ZobLiveEnvelopeType;
  msgId: string;
  runId?: string;
  sender?: string;
  receiver?: string;
  team?: string;
  hops: number;
  taskHash?: string;
  contextHash?: string;
  outputHash?: string;
  artifactRefs?: string[];
  artifactHashes?: string[];
  replyEndpoint?: string;
  replyEndpointHash?: string;
  transientPrompt?: string;
  transientResponse?: string;
  priority?: ZpeerInterruptPriority;
  interruptRequested?: boolean;
  interruptMode?: ZpeerInterruptMode;
  interruptReasonHash?: string;
  interruptStatus?: ZpeerInterruptStatus;
  errorCode?: string;
  errorHash?: string;
  timestamp: string;
  bodyStored: false;
}

function hasForbiddenExactKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenExactKey);
  return Object.entries(value).some(([key, child]) => FORBIDDEN_PERSISTED_KEYS.has(key) || hasForbiddenExactKey(child));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function buildZobLiveEnvelope(input: Omit<ZobLiveEnvelope, "schema" | "timestamp" | "bodyStored" | "hops"> & { hops?: number }): ZobLiveEnvelope {
  return {
    schema: "zob.live-envelope.v1",
    hops: input.hops ?? 0,
    timestamp: new Date().toISOString(),
    bodyStored: false,
    ...input,
  };
}

export function buildZobLiveAckEnvelope(request: ZobLiveEnvelope, interruptStatus?: ZpeerInterruptStatus): ZobLiveEnvelope {
  return buildZobLiveEnvelope({
    type: "ack",
    msgId: request.msgId,
    runId: request.runId,
    sender: request.receiver,
    receiver: request.sender,
    team: request.team,
    hops: request.hops,
    taskHash: request.taskHash,
    priority: request.priority,
    interruptRequested: request.interruptRequested,
    interruptMode: request.interruptMode,
    interruptReasonHash: request.interruptReasonHash,
    interruptStatus: interruptStatus ?? request.interruptStatus,
  });
}

export function buildZobLivePongEnvelope(request: ZobLiveEnvelope): ZobLiveEnvelope {
  return buildZobLiveEnvelope({
    type: "pong",
    msgId: request.msgId,
    runId: request.runId,
    sender: request.receiver,
    receiver: request.sender,
    team: request.team,
    hops: request.hops,
  });
}

export function buildZobLiveErrorEnvelope(request: Partial<ZobLiveEnvelope>, error: string, code = "transport_error"): ZobLiveEnvelope {
  return buildZobLiveEnvelope({
    type: "error",
    msgId: typeof request.msgId === "string" ? request.msgId : `error-${Date.now()}`,
    runId: request.runId,
    sender: request.receiver,
    receiver: request.sender,
    team: request.team,
    hops: typeof request.hops === "number" ? request.hops : 0,
    errorCode: code,
    errorHash: sha256(error),
  });
}

export function validateZobLiveEnvelope(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["ZOB live envelope must be an object"];
  if (value.schema !== "zob.live-envelope.v1") errors.push("ZOB live envelope schema must be zob.live-envelope.v1");
  if (typeof value.type !== "string" || !ENVELOPE_TYPES.has(value.type)) errors.push("ZOB live envelope type is invalid");
  if (typeof value.msgId !== "string" || value.msgId.trim().length === 0) errors.push("ZOB live envelope requires msgId");
  if (typeof value.hops !== "number" || !Number.isFinite(value.hops) || value.hops < 0 || value.hops > 5) errors.push("ZOB live envelope hops must be 0..5");
  if (value.bodyStored !== false) errors.push("ZOB live envelope bodyStored must be false");
  if (typeof value.timestamp !== "string") errors.push("ZOB live envelope requires timestamp");
  if (hasForbiddenExactKey(value)) errors.push("ZOB live envelope must not use persisted raw-body key names");
  if (value.artifactRefs !== undefined && !isStringArray(value.artifactRefs)) errors.push("ZOB live envelope artifactRefs must be string[] when provided");
  if (value.artifactHashes !== undefined && !isStringArray(value.artifactHashes)) errors.push("ZOB live envelope artifactHashes must be string[] when provided");
  if (value.priority !== undefined && (typeof value.priority !== "string" || !ZPEER_PRIORITIES.has(value.priority))) errors.push("ZOB live envelope priority is invalid");
  if (value.interruptRequested !== undefined && typeof value.interruptRequested !== "boolean") errors.push("ZOB live envelope interruptRequested must be boolean when provided");
  if (value.interruptMode !== undefined && (typeof value.interruptMode !== "string" || !ZPEER_INTERRUPT_MODES.has(value.interruptMode))) errors.push("ZOB live envelope interruptMode is invalid");
  if (value.interruptReasonHash !== undefined && (typeof value.interruptReasonHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.interruptReasonHash))) errors.push("ZOB live envelope interruptReasonHash must be sha256 hex when provided");
  if (value.interruptStatus !== undefined && (typeof value.interruptStatus !== "string" || !ZPEER_INTERRUPT_STATUSES.has(value.interruptStatus))) errors.push("ZOB live envelope interruptStatus is invalid");
  if (value.type === "prompt") {
    if (typeof value.sender !== "string" || typeof value.receiver !== "string") errors.push("ZOB live prompt envelope requires sender and receiver");
    if (typeof value.taskHash !== "string") errors.push("ZOB live prompt envelope requires taskHash");
    if (typeof value.transientPrompt !== "string" || value.transientPrompt.length === 0) errors.push("ZOB live prompt envelope requires transientPrompt");
  }
  if (value.type === "response" && typeof value.outputHash !== "string" && typeof value.transientResponse !== "string") errors.push("ZOB live response envelope requires outputHash or transientResponse");
  return errors;
}

export function parseZobLiveEnvelopeLine(line: string): { envelope?: ZobLiveEnvelope; errors: string[] } {
  try {
    const parsed = JSON.parse(line) as unknown;
    const errors = validateZobLiveEnvelope(parsed);
    return errors.length === 0 ? { envelope: parsed as ZobLiveEnvelope, errors } : { errors };
  } catch (error) {
    return { errors: [`Could not parse ZOB live envelope: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
