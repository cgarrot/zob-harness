import type { AssistantLikeMessage } from "../types.js";
import { sha256 } from "../core/utils/hashing.js";
import { isRecord } from "../core/utils/records.js";

export type StopRestoreInputSource = "interactive" | "rpc";
export type StopRestoreStreamingBehavior = "steer" | "followUp";

export interface StopRestoreCandidate {
  schema: "zob.stop-restore-candidate.v1";
  promptText: string;
  promptHash: string;
  source: StopRestoreInputSource;
  inputAtMs: number;
  leafId: string | null;
  assistantStarted: boolean;
  assistantVisibleOutput: boolean;
  toolVisibleOutput: boolean;
  restoredAtMs?: number;
}

export interface StopRestoreCandidateInput {
  text: string;
  source: string;
  streamingBehavior?: StopRestoreStreamingBehavior;
  leafId?: string | null;
  nowMs?: number;
}

export interface StopRestoreDecisionInput {
  foregroundAbortRequested: boolean;
  idleBeforeStop: boolean;
  pendingMessagesBeforeStop: boolean;
  nowMs?: number;
  maxCandidateAgeMs?: number;
}

export interface StopRestoreDecision {
  restore: boolean;
  reason: string;
  promptText?: string;
  promptHash?: string;
  assistantOutputObserved: boolean;
}

export interface StopRestoreRewindResult {
  attempted: boolean;
  succeeded: boolean;
  reason: string;
  targetEntryId?: string;
}

const DEFAULT_MAX_CANDIDATE_AGE_MS = 30 * 60 * 1000;

function restorablePromptText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith("/");
}

export function createStopRestoreCandidate(input: StopRestoreCandidateInput): StopRestoreCandidate | undefined {
  if (input.source !== "interactive" && input.source !== "rpc") return undefined;
  if (input.streamingBehavior) return undefined;
  if (!restorablePromptText(input.text)) return undefined;
  return {
    schema: "zob.stop-restore-candidate.v1",
    promptText: input.text,
    promptHash: sha256(input.text),
    source: input.source,
    inputAtMs: input.nowMs ?? Date.now(),
    leafId: input.leafId ?? null,
    assistantStarted: false,
    assistantVisibleOutput: false,
    toolVisibleOutput: false,
  };
}

export function assistantMessageHasVisibleOutput(message: AssistantLikeMessage | undefined): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    if (!isRecord(part)) return false;
    if (part.type === "text") return typeof part.text === "string" && part.text.trim().length > 0;
    if (part.type === "thinking") return typeof part.thinking === "string" && part.thinking.trim().length > 0;
    if (part.type === "toolCall") return true;
    return false;
  });
}

export function markStopRestoreAssistantMessage(candidate: StopRestoreCandidate | undefined, message: AssistantLikeMessage | undefined): void {
  if (!candidate || candidate.restoredAtMs) return;
  candidate.assistantStarted = true;
  if (assistantMessageHasVisibleOutput(message)) candidate.assistantVisibleOutput = true;
}

export function markStopRestoreToolVisible(candidate: StopRestoreCandidate | undefined): void {
  if (!candidate || candidate.restoredAtMs) return;
  candidate.toolVisibleOutput = true;
}

function textFromEntryContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function findStopRestoreUserEntryId(candidate: StopRestoreCandidate | undefined, entries: unknown[]): string | undefined {
  if (!candidate) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message" || typeof entry.id !== "string") continue;
    const parentId = typeof entry.parentId === "string" ? entry.parentId : entry.parentId === null ? null : undefined;
    if (parentId !== candidate.leafId) continue;
    if (!isRecord(entry.message) || entry.message.role !== "user") continue;
    if (textFromEntryContent(entry.message.content) === candidate.promptText) return entry.id;
  }
  return undefined;
}

export function markStopRestoreRestored(candidate: StopRestoreCandidate | undefined, nowMs = Date.now()): void {
  if (!candidate) return;
  candidate.restoredAtMs = nowMs;
}

export function shouldRestoreStopPrompt(candidate: StopRestoreCandidate | undefined, input: StopRestoreDecisionInput): StopRestoreDecision {
  const assistantOutputObserved = Boolean(candidate?.assistantVisibleOutput || candidate?.toolVisibleOutput);
  if (!candidate) return { restore: false, reason: "no_candidate", assistantOutputObserved };
  if (!input.foregroundAbortRequested) return { restore: false, reason: "foreground_idle", assistantOutputObserved };
  if (input.idleBeforeStop) return { restore: false, reason: "idle_before_stop", assistantOutputObserved };
  if (input.pendingMessagesBeforeStop) return { restore: false, reason: "pending_messages_restored_by_pi", assistantOutputObserved };
  if (candidate.restoredAtMs) return { restore: false, reason: "already_restored", promptHash: candidate.promptHash, assistantOutputObserved };
  if (!restorablePromptText(candidate.promptText)) return { restore: false, reason: "non_restorable_prompt", promptHash: candidate.promptHash, assistantOutputObserved };
  if (assistantOutputObserved) return { restore: false, reason: "assistant_output_observed", promptHash: candidate.promptHash, assistantOutputObserved };
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxCandidateAgeMs ?? DEFAULT_MAX_CANDIDATE_AGE_MS;
  if (nowMs - candidate.inputAtMs > maxAgeMs) return { restore: false, reason: "candidate_stale", promptHash: candidate.promptHash, assistantOutputObserved };
  return {
    restore: true,
    reason: "foreground_aborted_before_assistant_output",
    promptText: candidate.promptText,
    promptHash: candidate.promptHash,
    assistantOutputObserved,
  };
}
