import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RULES } from "../../core/constants.js";
import type { TeamDefinition } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { readJsonl } from "../../core/utils/json.js";
import { pathMatches } from "../../core/utils/paths.js";
import { newRunId, resolveRepoPath, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export type GoalRoomMessageKind = "QUESTION" | "ANSWER" | "FINDING" | "ACTION_TAKEN" | "ARTIFACT_READY" | "TODO_CLAIM" | "BLOCKER" | "RISK" | "NO_SHIP_ALERT" | "CONTEXT_REQUEST" | "SPLIT_REQUEST" | "DELEGATION_REQUEST" | "ORACLE_REQUEST" | "OWNER_CHANGE_REQUEST" | "OWNER_CHANGE_DECISION" | "HANDOFF" | "DECISION" | "STATUS_UPDATE";
export type GoalRoomAudience = "all" | "parent" | "lead" | "oracle" | "worker";
export type GoalRoomPriority = "low" | "normal" | "high" | "critical";

export interface GoalRoomMessageInput {
  goal_id: string;
  run_id?: string;
  todo_id?: string;
  sender: string;
  audience?: GoalRoomAudience;
  kind: GoalRoomMessageKind;
  priority?: GoalRoomPriority;
  body_hash: string;
  task_id?: string;
  output_hash?: string;
  evidence_refs?: string[];
  artifact_refs?: string[];
  ttl_ms?: number;
  requires_parent_action?: boolean;
  metadata?: Record<string, unknown>;
}

export interface GoalRoomListInput {
  goal_id: string;
  sender?: string;
  kind?: GoalRoomMessageKind;
  todo_id?: string;
  limit?: number;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const MESSAGE_KINDS = new Set<GoalRoomMessageKind>(["QUESTION", "ANSWER", "FINDING", "ACTION_TAKEN", "ARTIFACT_READY", "TODO_CLAIM", "BLOCKER", "RISK", "NO_SHIP_ALERT", "CONTEXT_REQUEST", "SPLIT_REQUEST", "DELEGATION_REQUEST", "ORACLE_REQUEST", "OWNER_CHANGE_REQUEST", "OWNER_CHANGE_DECISION", "HANDOFF", "DECISION", "STATUS_UPDATE"]);
const AUDIENCES = new Set<GoalRoomAudience>(["all", "parent", "lead", "oracle", "worker"]);
const PRIORITIES = new Set<GoalRoomPriority>(["low", "normal", "high", "critical"]);
const FORBIDDEN_PLAINTEXT_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch"]);

function hasForbiddenPlaintextKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenPlaintextKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_PLAINTEXT_KEYS.has(key) || hasForbiddenPlaintextKeys(child));
}

function goalRoomDir(repoRoot: string, goalId: string): string {
  return join(repoRoot, ".pi", "goal-rooms", safeFileStem(goalId));
}

function goalRoomMessagesPath(repoRoot: string, goalId: string): string {
  return join(goalRoomDir(repoRoot, goalId), "messages.jsonl");
}

function knownRoleIds(definition: TeamDefinition): Set<string> {
  return new Set([definition.orchestrator.id, ...definition.leads.map((lead) => lead.id), ...definition.workers.map((worker) => worker.id), "parent", "mission-control"]);
}

function validateRefs(repoRoot: string, refs: string[] | undefined, label: string): string[] {
  const errors: string[] = [];
  for (const ref of refs ?? []) {
    if (typeof ref !== "string" || ref.trim().length === 0) {
      errors.push(`${label} contains an empty ref`);
      continue;
    }
    if (ref.includes("\0")) errors.push(`${label} contains NUL byte: ${ref}`);
    const resolved = resolveRepoPath(repoRoot, ref);
    errors.push(...resolved.errors.map((error) => `${label}: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(ref, protectedPattern, repoRoot, repoRoot)) errors.push(`${label} references zero-access path: ${protectedPattern}`);
    }
  }
  return errors;
}

export function validateGoalRoomMessageInput(repoRoot: string, definition: TeamDefinition, input: GoalRoomMessageInput): string[] {
  const errors: string[] = [];
  if (!input.goal_id || safeFileStem(input.goal_id) !== input.goal_id) errors.push(`goal_id must be path-safe: ${input.goal_id}`);
  if (input.run_id && safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (input.todo_id && safeFileStem(input.todo_id) !== input.todo_id) errors.push(`todo_id must be path-safe: ${input.todo_id}`);
  if (input.task_id && safeFileStem(input.task_id) !== input.task_id) errors.push(`task_id must be path-safe: ${input.task_id}`);
  if (!knownRoleIds(definition).has(input.sender)) errors.push(`Unknown goal-room sender '${input.sender}'`);
  if (!MESSAGE_KINDS.has(input.kind)) errors.push(`Invalid goal-room kind: ${input.kind}`);
  if (input.audience !== undefined && !AUDIENCES.has(input.audience)) errors.push(`Invalid goal-room audience: ${input.audience}`);
  if (input.priority !== undefined && !PRIORITIES.has(input.priority)) errors.push(`Invalid goal-room priority: ${input.priority}`);
  if (!SHA256_HEX.test(input.body_hash)) errors.push("goal-room body_hash must be a sha256 hex hash; raw bodies are not accepted");
  if (input.output_hash !== undefined && !SHA256_HEX.test(input.output_hash)) errors.push("goal-room output_hash must be sha256 hex when provided");
  if (input.ttl_ms !== undefined && (!Number.isFinite(input.ttl_ms) || input.ttl_ms <= 0 || input.ttl_ms > 7 * 24 * 60 * 60 * 1000)) errors.push("goal-room ttl_ms must be positive and <= 7 days");
  if (hasForbiddenPlaintextKeys(input)) errors.push("goal-room input must not contain raw body/task/prompt/output/content/message/text/rationale/diff/patch keys");
  errors.push(...validateRefs(repoRoot, input.evidence_refs, "evidence_refs"));
  errors.push(...validateRefs(repoRoot, input.artifact_refs, "artifact_refs"));
  return errors;
}

export function buildGoalRoomMessage(repoRoot: string, definition: TeamDefinition, input: GoalRoomMessageInput): Record<string, unknown> {
  const errors = validateGoalRoomMessageInput(repoRoot, definition, input);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const createdAt = new Date().toISOString();
  const ttlMs = typeof input.ttl_ms === "number" ? Math.floor(input.ttl_ms) : undefined;
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined;
  return {
    schema: "zob.goal-room-message.v1",
    msgId: newRunId("goalroom"),
    goalId: input.goal_id,
    runId: input.run_id ?? null,
    todoId: input.todo_id ?? null,
    sender: input.sender,
    audience: input.audience ?? "all",
    kind: input.kind,
    priority: input.priority ?? "normal",
    taskId: input.task_id,
    bodyHash: input.body_hash,
    outputHash: input.output_hash ?? null,
    evidenceRefs: input.evidence_refs ?? [],
    artifactRefs: input.artifact_refs ?? [],
    requiresParentAction: input.requires_parent_action === true,
    ttlMs,
    expiresAt,
    parentVisible: true,
    hiddenPeerChat: false,
    workerToWorkerDirect: false,
    parentOwnedActions: true,
    metadata: input.metadata ?? {},
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt,
  };
}

export function validateGoalRoomMessageRecord(message: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (message.schema !== "zob.goal-room-message.v1") errors.push("goal-room message schema must be zob.goal-room-message.v1");
  for (const field of ["msgId", "goalId", "sender", "audience", "kind", "priority", "bodyHash", "createdAt"] as const) {
    if (typeof message[field] !== "string") errors.push(`goal-room message missing string field '${field}'`);
  }
  if (message.bodyStored !== false || message.promptBodiesStored !== false || message.outputBodiesStored !== false) errors.push("goal-room persisted message must keep bodyStored/promptBodiesStored/outputBodiesStored=false");
  if (message.parentVisible !== true || message.hiddenPeerChat !== false || message.workerToWorkerDirect !== false || message.parentOwnedActions !== true) errors.push("goal-room message must be visible and parent-owned, not hidden worker-to-worker chat");
  if (hasForbiddenPlaintextKeys(message)) errors.push("goal-room persisted message must not contain raw body-like keys");
  return errors;
}

export function appendGoalRoomMessage(repoRoot: string, definition: TeamDefinition, input: GoalRoomMessageInput): Record<string, unknown> {
  const message = buildGoalRoomMessage(repoRoot, definition, input);
  const errors = validateGoalRoomMessageRecord(message);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const dir = goalRoomDir(repoRoot, input.goal_id);
  mkdirSync(dir, { recursive: true });
  appendFileSync(goalRoomMessagesPath(repoRoot, input.goal_id), `${JSON.stringify(message)}\n`, "utf8");
  return message;
}

export function listGoalRoomMessages(repoRoot: string, input: GoalRoomListInput): Array<Record<string, unknown>> {
  if (!input.goal_id || safeFileStem(input.goal_id) !== input.goal_id) throw new Error(`goal_id must be path-safe: ${input.goal_id}`);
  if (input.todo_id && safeFileStem(input.todo_id) !== input.todo_id) throw new Error(`todo_id must be path-safe: ${input.todo_id}`);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const messages = readJsonl(goalRoomMessagesPath(repoRoot, input.goal_id))
    .filter((message) => validateGoalRoomMessageRecord(message).length === 0)
    .filter((message) => !input.sender || message.sender === input.sender)
    .filter((message) => !input.kind || message.kind === input.kind)
    .filter((message) => !input.todo_id || message.todoId === input.todo_id);
  return messages.slice(-limit);
}

export function goalRoomBodyFreeViolations(messages: Array<Record<string, unknown>>): string[] {
  return messages.flatMap((message, index) => validateGoalRoomMessageRecord(message).map((error) => `messages[${index}]: ${error}`));
}

export function isGoalRoomMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.schema === "zob.goal-room-message.v1" && validateGoalRoomMessageRecord(value).length === 0;
}
