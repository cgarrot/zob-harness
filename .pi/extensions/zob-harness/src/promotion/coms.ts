import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../utils/hashing.js";
import { safeFileStem } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";
import { promotionCandidateDir, promotionCandidateRef } from "./candidate.js";
import type { PromotionCandidateRecord, PromotionComsMessageRef, PromotionComsThreadInput, PromotionComsThreadRecord } from "./types.js";

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const ALLOWED_KINDS = new Set(["STATUS_UPDATE", "FINDING", "RISK", "BLOCKER", "NO_SHIP_ALERT", "CONTEXT_REQUEST", "DELEGATION_REQUEST", "ORACLE_REQUEST", "QUESTION", "ANSWER"]);
const TERMINAL_BAD_STATUSES = new Set(["stale", "offline", "timeout"]);
const FORBIDDEN_BODY_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch", "transcript", "rawContext", "rawPrompt"]);

function hasForbiddenBodyKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKey);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKey(child));
}

function safeMeta(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && safeFileStem(value) === value;
}

export function buildPromotionComsMessageRef(input: Omit<PromotionComsMessageRef, "parentVisible" | "hiddenPeerChat" | "workerToWorkerDirect" | "bodyStored" | "promptBodiesStored" | "outputBodiesStored">): PromotionComsMessageRef {
  return {
    ...input,
    outputHash: input.outputHash ?? null,
    artifactRefs: input.artifactRefs ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    parentVisible: true,
    hiddenPeerChat: false,
    workerToWorkerDirect: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildPromotionComsThread(input: PromotionComsThreadInput): PromotionComsThreadRecord {
  const now = new Date().toISOString();
  return {
    schema: "zob.promotion-coms-thread.v1",
    threadId: input.threadId ?? `pthread_${sha256(`${input.candidateId}:${Date.now()}`).slice(0, 16)}`,
    goalId: input.goalId,
    todoId: input.todoId ?? null,
    candidateId: input.candidateId,
    kind: input.kind,
    messageRefs: input.messageRefs ?? [],
    requiredAcks: input.requiredAcks ?? [],
    stalePolicy: input.stalePolicy ?? "stale_blocks_completion",
    parentVisible: true,
    parentOwnedActions: true,
    hiddenPeerChat: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function addPromotionComsMessageRef(thread: PromotionComsThreadRecord, message: PromotionComsMessageRef): PromotionComsThreadRecord {
  return { ...thread, messageRefs: [...thread.messageRefs, message], updatedAt: new Date().toISOString() };
}

export function validatePromotionComsMessageRef(message: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(message)) return ["promotion coms message ref must be an object"];
  if (hasForbiddenBodyKey(message)) errors.push("promotion coms message ref must not contain raw body-like keys");
  if (!safeMeta(message.msgId)) errors.push("message msgId must be metadata-safe");
  if (typeof message.kind !== "string" || !ALLOWED_KINDS.has(message.kind)) errors.push("message kind is not allowed for promotion coms");
  if (typeof message.sender !== "string" || message.sender.length === 0) errors.push("message sender is required");
  if (typeof message.status !== "string" || !["queued", "acked", "running", "completed", "blocked", "timeout", "stale", "offline"].includes(message.status)) errors.push("message status is invalid");
  if (typeof message.bodyHash !== "string" || !SHA256_HEX.test(message.bodyHash)) errors.push("message bodyHash must be sha256 hex");
  if (message.outputHash !== null && message.outputHash !== undefined && (typeof message.outputHash !== "string" || !SHA256_HEX.test(message.outputHash))) errors.push("message outputHash must be sha256 hex when provided");
  if (!Array.isArray(message.artifactRefs) || !message.artifactRefs.every((ref) => typeof ref === "string")) errors.push("message artifactRefs must be string array");
  if (!Array.isArray(message.evidenceRefs) || !message.evidenceRefs.every((ref) => typeof ref === "string")) errors.push("message evidenceRefs must be string array");
  if (message.status !== "completed" && message.countsAsCompletion === true) errors.push("only completed promotion coms messages may count as completion");
  if (TERMINAL_BAD_STATUSES.has(String(message.status)) && message.countsAsCompletion === true) errors.push("stale/offline/timeout message must not count as completion");
  if (message.parentVisible !== true || message.hiddenPeerChat !== false || message.workerToWorkerDirect !== false) errors.push("promotion coms must be parent-visible and must not be hidden worker-to-worker chat");
  if (message.bodyStored !== false || message.promptBodiesStored !== false || message.outputBodiesStored !== false) errors.push("promotion coms message ref must keep body flags false");
  return errors;
}

export function validatePromotionComsThread(thread: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(thread)) return ["promotion coms thread must be an object"];
  if (hasForbiddenBodyKey(thread)) errors.push("promotion coms thread must not contain raw body-like keys");
  if (thread.schema !== "zob.promotion-coms-thread.v1") errors.push("promotion coms thread schema mismatch");
  if (!safeMeta(thread.threadId)) errors.push("threadId must be metadata-safe");
  if (!safeMeta(thread.goalId)) errors.push("goalId must be metadata-safe");
  if (thread.todoId !== null && thread.todoId !== undefined && !safeMeta(thread.todoId)) errors.push("todoId must be metadata-safe when provided");
  if (!safeMeta(thread.candidateId)) errors.push("candidateId must be metadata-safe");
  if (thread.stalePolicy !== "stale_blocks_completion") errors.push("stalePolicy must be stale_blocks_completion");
  if (thread.parentVisible !== true || thread.parentOwnedActions !== true || thread.hiddenPeerChat !== false) errors.push("promotion coms thread must be parent-visible and parent-owned");
  if (thread.bodyStored !== false || thread.promptBodiesStored !== false || thread.outputBodiesStored !== false) errors.push("promotion coms thread must keep body flags false");
  if (!Array.isArray(thread.messageRefs)) errors.push("messageRefs must be an array");
  else thread.messageRefs.forEach((message, index) => validatePromotionComsMessageRef(message).forEach((error) => errors.push(`messageRefs[${index}]: ${error}`)));
  if (!Array.isArray(thread.requiredAcks) || !thread.requiredAcks.every((ack) => typeof ack === "string")) errors.push("requiredAcks must be string array");
  const acked = new Set(Array.isArray(thread.messageRefs) ? thread.messageRefs.filter(isRecord).filter((message) => message.status === "acked" || message.status === "completed").map((message) => String(message.msgId)) : []);
  for (const requiredAck of Array.isArray(thread.requiredAcks) ? thread.requiredAcks : []) {
    if (!acked.has(requiredAck)) errors.push(`required ack missing: ${requiredAck}`);
  }
  return errors;
}

export function validatePromotionComsReadiness(candidate: PromotionCandidateRecord, thread: PromotionComsThreadRecord): string[] {
  const errors = validatePromotionComsThread(thread);
  if (thread.candidateId !== candidate.candidateId) errors.push("promotion coms thread candidateId must match candidate");
  if (thread.kind !== candidate.kind) errors.push("promotion coms thread kind must match candidate");
  const messageKinds = new Set(thread.messageRefs.map((message) => message.kind));
  if ((candidate.status === "approved" || candidate.status === "applied") && !messageKinds.has("ORACLE_REQUEST")) errors.push("approved/applied promotion requires ORACLE_REQUEST message ref in coms thread");
  if ((candidate.status === "approved" || candidate.status === "applied") && !thread.messageRefs.some((message) => message.kind === "FINDING" || message.kind === "STATUS_UPDATE")) errors.push("approved/applied promotion requires FINDING or STATUS_UPDATE message ref in coms thread");
  if (thread.messageRefs.some((message) => TERMINAL_BAD_STATUSES.has(message.status) && message.countsAsCompletion === true)) errors.push("stale/offline/timeout coms cannot count as promotion completion");
  if (candidate.status === "applied" && !thread.messageRefs.some((message) => message.status === "completed" && message.countsAsCompletion === true)) errors.push("applied promotion requires a completed parent-visible status message");
  return errors;
}

export function writePromotionComsThread(repoRoot: string, thread: PromotionComsThreadRecord): string {
  const errors = validatePromotionComsThread(thread);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const dir = promotionCandidateDir(repoRoot, thread.candidateId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "promotion-coms-thread.json"), JSON.stringify(thread, null, 2), "utf8");
  return promotionCandidateRef(thread.candidateId, "promotion-coms-thread.json");
}
