import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import type { ChildResult, DelegationFailureKind } from "../types.js";
import type { GoalTodoDelegationAttempt, GoalTodoDelegationLivenessProof, GoalTodoDelegationLivenessProofCode, GoalTodoDelegationLivenessProofSource } from "../domains/goal/goal-todo-types.js";
import { sha256 } from "../core/utils/hashing.js";
import { isRecord } from "../core/utils/records.js";

export type DelegationRunSource = "delegate_agent" | "delegate_task";
export type DelegationRunMode = "single" | "parallel" | "chain";
export type DelegationRunStatus = "queued" | "running" | "preflight_failed" | "complete" | "failed" | "aborted";
export type DelegationSortMode = "active" | "latest" | "duration" | "agent";
export type DelegationVerdict = "pass" | "warn" | "fail" | "inconclusive";
export type DelegationConfidence = "high" | "medium" | "low";

export interface DelegationSignalBadge {
  verdict?: DelegationVerdict;
  confidence?: DelegationConfidence;
}

export interface DelegationRunView {
  id: string;
  parentToolCallId: string;
  source: DelegationRunSource;
  mode: DelegationRunMode;
  index?: number;
  agent: string;
  taskPreview: string;
  status: DelegationRunStatus;
  startedAtMs: number;
  endedAtMs?: number;
  outputPreview: string;
  stderrPreview: string;
  cwd?: string;
  sessionPath?: string;
  exitCode?: number;
  gatePassed?: boolean;
  gateErrors?: string[];
  failureKind?: DelegationFailureKind;
  stopReason?: string;
  stopCondition?: string;
  errorMessage?: string;
  childChangedPaths?: ChildResult["childChangedPaths"];
  usage?: ChildResult["usage"];
  model?: string;
  background?: boolean;
  /** Session-local authority marker. Restored ledger projections intentionally omit it. */
  authoritativeCurrentRuntime?: true;
}

export interface DelegationMonitorState {
  runs: DelegationRunView[];
  maxRuns: number;
}

export interface DelegationGroupView {
  parentToolCallId: string;
  source: DelegationRunSource;
  mode: DelegationRunMode;
  startedAtMs: number;
  running: number;
  complete: number;
  failed: number;
  runs: DelegationRunView[];
}

export interface DelegationSummary {
  total: number;
  queued: number;
  running: number;
  complete: number;
  failed: number;
  preflightFailed: number;
  aborted: number;
}

const PREVIEW_LIMIT = 48_000;
const TRANSCRIPT_MAX_BYTES = 240_000;
const TRANSCRIPT_MAX_LINES = 1_200;
const WIDGET_COMPLETE_TTL_MS = 30_000;
const WIDGET_FAILURE_TTL_MS = 120_000;
const WIDGET_BACKGROUND_COMPLETE_TTL_MS = 10 * 60_000;
const WIDGET_BACKGROUND_FAILURE_TTL_MS = 30 * 60_000;

function capPreview(text: string | undefined, limit = PREVIEW_LIMIT): string {
  const value = text ?? "";
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.6);
  const tail = Math.max(0, limit - head);
  return `${value.slice(0, head)}\n\n[… ${value.length - limit} chars omitted from delegation preview …]\n\n${value.slice(-tail)}`;
}

function taskPreview(task: string, limit = 180): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function terminalRank(status: DelegationRunStatus): number {
  switch (status) {
    case "running": return 0;
    case "queued": return 1;
    case "failed": return 2;
    case "preflight_failed": return 3;
    case "aborted": return 4;
    case "complete": return 5;
  }
}

function isTerminalStatus(status: DelegationRunStatus): boolean {
  return status === "preflight_failed" || status === "complete" || status === "failed" || status === "aborted";
}

function normalizeRepoLocalPath(path: string): string {
  return resolve(path);
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRepoLocalPath(root);
  const normalizedCandidate = normalizeRepoLocalPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "thinking" && typeof part.thinking === "string") parts.push(`[thinking]\n${part.thinking}`);
    else if (part.type === "toolCall") {
      const name = typeof part.name === "string" ? part.name : "tool";
      const args = isRecord(part.arguments) ? JSON.stringify(part.arguments) : "{}";
      parts.push(`[tool call: ${name}] ${args}`);
    }
  }
  return parts.join("\n");
}

function readCappedFile(path: string, size: number, maxBytes: number): string {
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const headBytes = Math.floor(maxBytes * 0.55);
  const tailBytes = Math.max(0, maxBytes - headBytes);
  const head = Buffer.alloc(headBytes);
  const tail = Buffer.alloc(tailBytes);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, headBytes, 0);
    readSync(fd, tail, 0, tailBytes, Math.max(0, size - tailBytes));
  } finally {
    closeSync(fd);
  }
  return `${head.toString("utf8")}\n{\"type\":\"custom\",\"customType\":\"zob-transcript-truncated\",\"data\":{\"omittedBytes\":${size - maxBytes}}}\n${tail.toString("utf8")}`;
}

function formatSessionEntry(line: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  if (parsed.type === "session") {
    const cwd = typeof parsed.cwd === "string" ? ` cwd=${parsed.cwd}` : "";
    return [`[session]${cwd}`];
  }

  if (parsed.type === "message" && isRecord(parsed.message)) {
    const message = parsed.message;
    const role = typeof message.role === "string" ? message.role : "message";
    const text = textFromContent(message.content);
    if (role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
      const isError = message.isError === true ? " error" : "";
      return [`[tool result: ${toolName}${isError}]`, ...(text ? text.split("\n") : ["(no text content)"])];
    }
    return [`[${role}]`, ...(text ? text.split("\n") : ["(no text content)"])];
  }

  if (parsed.type === "custom" && typeof parsed.customType === "string") {
    return [`[custom: ${parsed.customType}] ${JSON.stringify(parsed.data ?? {})}`];
  }

  if (parsed.type === "custom_message") {
    const customType = typeof parsed.customType === "string" ? parsed.customType : "custom";
    const text = textFromContent(parsed.content);
    return [`[custom message: ${customType}]`, ...(text ? text.split("\n") : ["(no text content)"])];
  }

  if (parsed.type === "model_change") {
    const provider = typeof parsed.provider === "string" ? parsed.provider : "";
    const model = typeof parsed.modelId === "string" ? parsed.modelId : "";
    return [`[model] ${provider}/${model}`.replace(/^\[model\] \/?/, "[model] ")];
  }

  if (parsed.type === "thinking_level_change" && typeof parsed.thinkingLevel === "string") return [`[thinking] ${parsed.thinkingLevel}`];
  if (parsed.type === "compaction" && typeof parsed.summary === "string") return ["[compaction]", parsed.summary];
  if (parsed.type === "branch_summary" && typeof parsed.summary === "string") return ["[branch summary]", parsed.summary];

  return [];
}

export function createDelegationMonitorState(maxRuns = 60): DelegationMonitorState {
  return { runs: [], maxRuns };
}

export function delegationDurationMs(run: DelegationRunView, nowMs = Date.now()): number {
  return Math.max(0, (run.endedAtMs ?? nowMs) - run.startedAtMs);
}

export function formatDuration(durationMs: number): string {
  const safe = Math.max(0, Math.floor(durationMs));
  const tenths = Math.floor((safe % 1000) / 100);
  const totalSeconds = Math.floor(safe / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
}

export function formatDelegationCost(cost: number | undefined): string {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return "$0.0000";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 1) return `$${cost.toFixed(4)}`;
  if (cost < 10) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function delegationCost(run: DelegationRunView | undefined): number {
  return run?.usage?.cost ?? 0;
}

function formatTokenCount(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}k`;
  return `${(safe / 1_000_000).toFixed(1)}m`;
}

export function formatDelegationCostLabel(run: DelegationRunView | undefined): string {
  if (run?.usage) return formatDelegationCost(run.usage.cost);
  if (run?.status === "queued" || run?.status === "running") return "cost pending";
  return "cost unavailable";
}

export function formatDelegationContextLabel(run: DelegationRunView | undefined): string {
  if (run?.usage) return `ctx ${formatTokenCount(run.usage.contextTokens)} tok`;
  if (run?.status === "queued" || run?.status === "running") return "ctx pending";
  return "ctx unavailable";
}

export function formatDelegationModelLabel(run: DelegationRunView | { model?: string } | undefined, limit = 48): string {
  if (!run?.model) return "";
  const value = run.model.replace(/^\//, "").trim();
  if (!value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function delegationCwdValue(run: DelegationRunView | ChildResult | { cwd?: string } | undefined, repoRoot: string): string | undefined {
  if (!run?.cwd) return undefined;
  const resolvedRoot = resolve(repoRoot);
  const resolvedCwd = resolve(run.cwd);
  const rel = resolvedCwd === resolvedRoot ? "." : relative(resolvedRoot, resolvedCwd);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
  return inside ? rel || "." : resolvedCwd;
}

function truncateLabel(label: string, limit: number): string {
  return label.length <= limit ? label : `${label.slice(0, limit - 1)}…`;
}

export function formatDelegationCwdLabel(run: DelegationRunView | ChildResult | { cwd?: string } | undefined, repoRoot: string, limit = 48): string {
  const value = delegationCwdValue(run, repoRoot);
  return value ? truncateLabel(`cwd ${value}`, limit) : "";
}

export function formatDelegationWorkspaceLabel(run: DelegationRunView | ChildResult | { cwd?: string } | undefined, repoRoot: string, limit = 72): string {
  const value = delegationCwdValue(run, repoRoot);
  return value ? truncateLabel(`workspace · ${value}`, limit) : "";
}

function stripSignalControlSequences(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function normalizeVerdict(value: string | undefined): DelegationVerdict | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "pass") return "pass";
  if (normalized === "warn" || normalized === "warning") return "warn";
  if (normalized === "fail" || normalized === "failed") return "fail";
  if (normalized === "inconclusive") return "inconclusive";
  return undefined;
}

function normalizeConfidence(value: string | undefined): DelegationConfidence | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "high") return "high";
  if (normalized === "medium" || normalized === "med") return "medium";
  if (normalized === "low") return "low";
  return undefined;
}

export function extractDelegationSignalBadge(text: string | undefined): DelegationSignalBadge | undefined {
  if (!text?.trim()) return undefined;
  const source = stripSignalControlSequences(text.slice(0, 48_000));
  const verdictMatch = source.match(/<verdict>\s*(PASS|WARN|WARNING|FAIL|FAILED|INCONCLUSIVE)\s*<\/verdict>/i)
    ?? source.match(/(?:^|\n)\s*(?:[-*]\s*)?verdict\s*[:=]\s*(PASS|WARN|WARNING|FAIL|FAILED|INCONCLUSIVE)\b/i);
  const confidenceMatch = source.match(/<confidence>\s*(HIGH|MEDIUM|MED|LOW)\s*<\/confidence>/i)
    ?? source.match(/(?:^|\n)\s*(?:[-*]\s*)?confidence\s*[:=]\s*(HIGH|MEDIUM|MED|LOW)\b/i);
  const verdict = normalizeVerdict(verdictMatch?.[1]);
  const confidence = normalizeConfidence(confidenceMatch?.[1]);
  return verdict || confidence ? { verdict, confidence } : undefined;
}

export function delegationSignalBadge(run: DelegationRunView | undefined): DelegationSignalBadge | undefined {
  return extractDelegationSignalBadge(run?.outputPreview);
}

export function formatDelegationSignalBadge(badge: DelegationSignalBadge | undefined): string {
  if (!badge) return "";
  const verdict = badge.verdict === "pass"
    ? "✓ PASS"
    : badge.verdict === "warn"
      ? "⚠ WARN"
      : badge.verdict === "fail"
        ? "✗ FAIL"
        : badge.verdict === "inconclusive"
          ? "? INC"
          : "";
  const confidence = badge.confidence === "high" ? "H" : badge.confidence === "medium" ? "M" : badge.confidence === "low" ? "L" : "";
  return [verdict, confidence ? `◆ ${confidence}` : ""].filter(Boolean).join(" ");
}

export function delegationSignalColor(badge: DelegationSignalBadge | undefined): "success" | "warning" | "error" | "muted" {
  if (badge?.verdict === "pass") return "success";
  if (badge?.verdict === "warn" || badge?.verdict === "inconclusive") return "warning";
  if (badge?.verdict === "fail") return "error";
  if (badge?.confidence === "high") return "success";
  if (badge?.confidence === "medium") return "warning";
  if (badge?.confidence === "low") return "error";
  return "muted";
}

export function statusIcon(status: DelegationRunStatus): string {
  switch (status) {
    case "queued": return "○";
    case "running": return "●";
    case "preflight_failed": return "▲";
    case "complete": return "✓";
    case "failed": return "✗";
    case "aborted": return "■";
  }
}

export function summarizeDelegations(state: DelegationMonitorState): DelegationSummary {
  const summary: DelegationSummary = { total: state.runs.length, queued: 0, running: 0, complete: 0, failed: 0, preflightFailed: 0, aborted: 0 };
  for (const run of state.runs) {
    if (run.status === "queued") summary.queued++;
    else if (run.status === "running") summary.running++;
    else if (run.status === "complete") summary.complete++;
    else if (run.status === "failed") summary.failed++;
    else if (run.status === "preflight_failed") summary.preflightFailed++;
    else if (run.status === "aborted") summary.aborted++;
  }
  return summary;
}

export function hasActiveDelegations(state: DelegationMonitorState): boolean {
  return state.runs.some((run) => run.status === "queued" || run.status === "running");
}

const TERMINAL_MONITOR_STATUSES = new Set<DelegationRunStatus>(["preflight_failed", "complete", "failed", "aborted"]);

function buildDelegationLivenessProof(input: {
  status: GoalTodoDelegationLivenessProof["status"];
  source: GoalTodoDelegationLivenessProofSource;
  code: GoalTodoDelegationLivenessProofCode;
  attempt: GoalTodoDelegationAttempt;
  proofAt: number;
  monitorStatus?: DelegationRunStatus;
}): GoalTodoDelegationLivenessProof {
  const proofAt = Math.max(0, Math.trunc(input.proofAt));
  const proofTimestampHash = sha256(String(proofAt));
  const proofHash = sha256(JSON.stringify([
    input.status,
    input.source,
    input.code,
    input.attempt.attemptId,
    input.attempt.runId,
    input.attempt.status,
    input.monitorStatus ?? "",
    proofAt,
    proofTimestampHash,
    input.attempt.boundGoalRevision,
    input.attempt.boundGraphRevision,
    input.attempt.boundTodoRevision,
  ]));
  return {
    schema: "zob.goal-todo-delegation-liveness-proof.v1",
    status: input.status,
    source: input.source,
    code: input.code,
    attemptId: input.attempt.attemptId,
    runId: input.attempt.runId,
    attemptStatus: input.attempt.status,
    ...(input.monitorStatus ? { monitorStatus: input.monitorStatus } : {}),
    proofAt,
    proofTimestampHash,
    proofHash,
    bodyStored: false,
  };
}

function durableAttemptProofCode(attempt: GoalTodoDelegationAttempt): GoalTodoDelegationLivenessProofCode | undefined {
  if (attempt.finalizedAt === undefined) return undefined;
  if (attempt.status === "failed_preflight" && attempt.failureHash) return "durable_preflight_terminal";
  if ((attempt.status === "failed_runtime" || attempt.status === "cancelled") && attempt.failureHash) return "durable_child_terminal";
  if ((attempt.status === "failed_output_gate_format" || attempt.status === "failed_output_gate_semantic") && (attempt.gateHash || attempt.outputHash)) return "durable_output_terminal";
  if (attempt.status === "output_declared_incomplete" && attempt.outputHash) return "durable_output_terminal";
  return undefined;
}

/**
 * Pure, fail-closed liveness assessment for one exact durable TODO attempt.
 * Missing controllers, PIDs, elapsed time, and restored active-looking monitor rows never prove inactivity.
 */
export function assessDelegationAttemptLiveness(
  state: DelegationMonitorState,
  attempt: GoalTodoDelegationAttempt,
  expected: { attemptId: string; runId: string } = { attemptId: attempt.attemptId, runId: attempt.runId },
): GoalTodoDelegationLivenessProof {
  if (expected.attemptId !== attempt.attemptId) {
    return buildDelegationLivenessProof({ status: "unknown", source: "none", code: "attempt_id_mismatch", attempt, proofAt: attempt.updatedAt });
  }
  if (expected.runId !== attempt.runId) {
    return buildDelegationLivenessProof({ status: "unknown", source: "none", code: "run_id_mismatch", attempt, proofAt: attempt.updatedAt });
  }

  const monitorByAttemptId = attempt.attemptId !== attempt.runId
    ? state.runs.find((run) => run.id === attempt.attemptId)
    : undefined;
  if (monitorByAttemptId) {
    return buildDelegationLivenessProof({ status: "unknown", source: "current_monitor", code: "monitor_attempt_run_mismatch", attempt, monitorStatus: monitorByAttemptId.status, proofAt: monitorByAttemptId.endedAtMs ?? monitorByAttemptId.startedAtMs });
  }

  const monitor = state.runs.find((run) => run.id === attempt.runId);
  const monitorActive = monitor?.status === "queued" || monitor?.status === "running";
  if (monitor && monitorActive && monitor.authoritativeCurrentRuntime === true) {
    return buildDelegationLivenessProof({ status: "active", source: "current_monitor", code: "monitor_active_exact", attempt, monitorStatus: monitor.status, proofAt: monitor.startedAtMs });
  }
  if (monitor && TERMINAL_MONITOR_STATUSES.has(monitor.status)) {
    return buildDelegationLivenessProof({ status: "inactive", source: "current_monitor", code: "monitor_terminal_exact", attempt, monitorStatus: monitor.status, proofAt: monitor.endedAtMs ?? monitor.startedAtMs });
  }

  const durableCode = durableAttemptProofCode(attempt);
  if (durableCode) {
    return buildDelegationLivenessProof({ status: "inactive", source: "durable_attempt", code: durableCode, attempt, monitorStatus: monitor?.status, proofAt: attempt.finalizedAt ?? attempt.updatedAt });
  }
  if (monitor && monitorActive) {
    return buildDelegationLivenessProof({ status: "unknown", source: "restored_monitor", code: "restored_nonterminal_without_controller", attempt, monitorStatus: monitor.status, proofAt: monitor.startedAtMs });
  }
  const terminalLooking = !["queued", "running", "claim_returned", "accepted", "rejected", "liveness_unknown"].includes(attempt.status);
  return buildDelegationLivenessProof({
    status: "unknown",
    source: "none",
    code: terminalLooking ? "terminal_proof_incomplete" : "nonterminal_without_authoritative_status",
    attempt,
    proofAt: attempt.finalizedAt ?? attempt.updatedAt,
  });
}

export function listDelegationRuns(state: DelegationMonitorState, sort: DelegationSortMode = "active", nowMs = Date.now()): DelegationRunView[] {
  const runs = [...state.runs];
  runs.sort((a, b) => {
    if (sort === "agent") return a.agent.localeCompare(b.agent) || b.startedAtMs - a.startedAtMs;
    if (sort === "duration") return delegationDurationMs(b, nowMs) - delegationDurationMs(a, nowMs) || b.startedAtMs - a.startedAtMs;
    if (sort === "latest") return b.startedAtMs - a.startedAtMs || (a.index ?? 0) - (b.index ?? 0);
    return terminalRank(a.status) - terminalRank(b.status) || b.startedAtMs - a.startedAtMs || (a.index ?? 0) - (b.index ?? 0);
  });
  return runs;
}

export function shouldShowRunInWidget(run: DelegationRunView, nowMs = Date.now()): boolean {
  if (run.status === "queued" || run.status === "running") return true;
  if (!run.endedAtMs) return false;
  const ageMs = Math.max(0, nowMs - run.endedAtMs);
  if (run.background) {
    if (run.status === "complete") return ageMs <= WIDGET_BACKGROUND_COMPLETE_TTL_MS;
    return ageMs <= WIDGET_BACKGROUND_FAILURE_TTL_MS;
  }
  if (run.status === "complete") return ageMs <= WIDGET_COMPLETE_TTL_MS;
  return ageMs <= WIDGET_FAILURE_TTL_MS;
}

export function listWidgetDelegationRuns(state: DelegationMonitorState, nowMs = Date.now()): DelegationRunView[] {
  return state.runs.filter((run) => shouldShowRunInWidget(run, nowMs));
}

export function buildDelegationGroups(state: DelegationMonitorState, sort: DelegationSortMode = "active", nowMs = Date.now()): DelegationGroupView[] {
  const groupsById = new Map<string, DelegationGroupView>();
  for (const run of state.runs) {
    const existing = groupsById.get(run.parentToolCallId);
    const group = existing ?? {
      parentToolCallId: run.parentToolCallId,
      source: run.source,
      mode: run.mode,
      startedAtMs: run.startedAtMs,
      running: 0,
      complete: 0,
      failed: 0,
      runs: [],
    };
    group.startedAtMs = Math.min(group.startedAtMs, run.startedAtMs);
    group.runs.push(run);
    groupsById.set(run.parentToolCallId, group);
  }

  const groups = [...groupsById.values()].map((group) => {
    group.running = group.runs.filter((run) => run.status === "queued" || run.status === "running").length;
    group.complete = group.runs.filter((run) => run.status === "complete").length;
    group.failed = group.runs.filter((run) => run.status === "failed" || run.status === "preflight_failed" || run.status === "aborted").length;
    group.runs = group.mode === "chain"
      ? [...group.runs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      : listDelegationRuns({ runs: group.runs, maxRuns: group.runs.length }, sort, nowMs);
    return group;
  });

  groups.sort((a, b) => {
    if (a.running !== b.running) return b.running - a.running;
    if (a.failed !== b.failed) return b.failed - a.failed;
    return b.startedAtMs - a.startedAtMs;
  });

  return groups;
}

export function buildWidgetDelegationGroups(state: DelegationMonitorState, sort: DelegationSortMode = "active", nowMs = Date.now()): DelegationGroupView[] {
  const visibleRuns = listWidgetDelegationRuns(state, nowMs);
  return buildDelegationGroups({ runs: visibleRuns, maxRuns: state.maxRuns }, sort, nowMs);
}

export function startDelegationRun(state: DelegationMonitorState, input: {
  id: string;
  parentToolCallId: string;
  source: DelegationRunSource;
  mode: DelegationRunMode;
  index?: number;
  agent: string;
  task: string;
  startedAtMs: number;
  cwd?: string;
}): DelegationRunView {
  const existingIndex = state.runs.findIndex((run) => run.id === input.id);
  const run: DelegationRunView = {
    id: input.id,
    parentToolCallId: input.parentToolCallId,
    source: input.source,
    mode: input.mode,
    index: input.index,
    agent: input.agent,
    taskPreview: taskPreview(input.task),
    status: "running",
    startedAtMs: input.startedAtMs,
    outputPreview: "",
    stderrPreview: "",
    cwd: input.cwd,
    authoritativeCurrentRuntime: true,
  };
  if (existingIndex >= 0) state.runs[existingIndex] = run;
  else state.runs.push(run);
  trimDelegationRuns(state);
  return run;
}

export function updateDelegationRun(state: DelegationMonitorState, id: string, patch: Partial<Omit<DelegationRunView, "id" | "startedAtMs">>): DelegationRunView | undefined {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) return undefined;
  if (patch.parentToolCallId !== undefined) run.parentToolCallId = patch.parentToolCallId;
  if (patch.source !== undefined) run.source = patch.source;
  if (patch.mode !== undefined) run.mode = patch.mode;
  if (patch.index !== undefined) run.index = patch.index;
  if (patch.agent !== undefined) run.agent = patch.agent;
  if (patch.taskPreview !== undefined) run.taskPreview = patch.taskPreview;
  if (patch.status !== undefined) run.status = patch.status;
  if (patch.endedAtMs !== undefined) run.endedAtMs = patch.endedAtMs;
  if (patch.outputPreview !== undefined) run.outputPreview = capPreview(patch.outputPreview);
  if (patch.stderrPreview !== undefined) run.stderrPreview = capPreview(patch.stderrPreview);
  if (patch.cwd !== undefined) run.cwd = patch.cwd;
  if (patch.sessionPath !== undefined) run.sessionPath = patch.sessionPath;
  if (patch.exitCode !== undefined) run.exitCode = patch.exitCode;
  if (patch.gatePassed !== undefined) run.gatePassed = patch.gatePassed;
  if (patch.gateErrors !== undefined) run.gateErrors = patch.gateErrors;
  if (patch.failureKind !== undefined) run.failureKind = patch.failureKind;
  if (patch.stopReason !== undefined) run.stopReason = patch.stopReason;
  if (patch.stopCondition !== undefined) run.stopCondition = patch.stopCondition;
  if (patch.errorMessage !== undefined) run.errorMessage = patch.errorMessage;
  if (patch.usage !== undefined) run.usage = patch.usage;
  if (patch.model !== undefined) run.model = patch.model;
  if (patch.background !== undefined) run.background = patch.background;
  return run;
}

export function finishDelegationRun(state: DelegationMonitorState, id: string, patch: Partial<Omit<DelegationRunView, "id" | "startedAtMs">> & { endedAtMs: number; status: DelegationRunStatus }): DelegationRunView | undefined {
  const next = { ...patch };
  if (patch.outputPreview !== undefined) next.outputPreview = capPreview(patch.outputPreview);
  if (patch.stderrPreview !== undefined) next.stderrPreview = capPreview(patch.stderrPreview);
  return updateDelegationRun(state, id, next);
}

export function trimDelegationRuns(state: DelegationMonitorState): void {
  if (state.runs.length <= state.maxRuns) return;
  const terminal = state.runs.filter((run) => isTerminalStatus(run.status)).sort((a, b) => a.startedAtMs - b.startedAtMs);
  const toRemove = new Set<string>();
  while (state.runs.length - toRemove.size > state.maxRuns && terminal.length > 0) {
    const next = terminal.shift();
    if (next) toRemove.add(next.id);
  }
  if (state.runs.length - toRemove.size > state.maxRuns) {
    for (const run of [...state.runs].sort((a, b) => a.startedAtMs - b.startedAtMs)) {
      if (state.runs.length - toRemove.size <= state.maxRuns) break;
      toRemove.add(run.id);
    }
  }
  state.runs = state.runs.filter((run) => !toRemove.has(run.id));
}

export function readChildTranscript(sessionPath: string | undefined, options: { repoRoot?: string; maxBytes?: number; maxLines?: number } = {}): string[] {
  if (!sessionPath) return [];
  const resolved = resolve(sessionPath);
  if (options.repoRoot && !isInside(options.repoRoot, resolved)) return [`[blocked] child session path is outside repo root: ${sessionPath}`];
  if (!existsSync(resolved)) return [`[missing] child session file not found: ${sessionPath}`];

  const maxBytes = options.maxBytes ?? TRANSCRIPT_MAX_BYTES;
  const maxLines = options.maxLines ?? TRANSCRIPT_MAX_LINES;
  const size = statSync(resolved).size;
  const source = readCappedFile(resolved, size, maxBytes);
  const rendered: string[] = [];

  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    const entryLines = formatSessionEntry(line);
    if (entryLines.length === 0) continue;
    if (rendered.length > 0) rendered.push("");
    rendered.push(...entryLines);
    if (rendered.length >= maxLines) {
      rendered.push(`[… transcript capped at ${maxLines} lines …]`);
      break;
    }
  }

  if (rendered.length === 0) return [`[empty] no renderable child conversation entries in ${sessionPath}`];
  if (size > maxBytes) rendered.unshift(`[… child session capped to ${maxBytes} bytes from ${size} bytes …]`, "");
  return rendered;
}

export function buildDelegationLogLines(run: DelegationRunView | undefined, repoRoot: string): string[] {
  if (!run) return ["No delegation selected."];
  const transcript = readChildTranscript(run.sessionPath, { repoRoot });
  const transcriptReady = transcript.length > 0 && !transcript[0]?.startsWith("[missing]");

  const lines = [
    `[delegation ${run.id}]`,
    `agent: ${run.agent}`,
    run.model ? `model: ${run.model}` : undefined,
    formatDelegationWorkspaceLabel(run, repoRoot) || undefined,
    `status: ${run.status}`,
    `duration: ${formatDuration(delegationDurationMs(run))}`,
    run.sessionPath ? `session: ${run.sessionPath}` : "session: not captured yet",
    `cost: ${formatDelegationCostLabel(run)}`,
    `context: ${formatDelegationContextLabel(run)}`,
    run.usage ? `usage: turns=${run.usage.turns} input=${run.usage.input} output=${run.usage.output} cacheRead=${run.usage.cacheRead} cacheWrite=${run.usage.cacheWrite} context=${run.usage.contextTokens}` : undefined,
    run.failureKind ? `failureKind: ${run.failureKind}` : undefined,
    run.gateErrors?.length ? `gateErrors: ${run.gateErrors.join("; ")}` : undefined,
    "",
    "[task preview]",
    run.taskPreview || "(empty)",
  ].filter((line): line is string => typeof line === "string");

  if (run.outputPreview.trim()) lines.push("", "[assistant output preview]", ...run.outputPreview.split("\n").slice(0, 20));
  if (run.stderrPreview.trim()) lines.push("", "[stderr preview]", ...run.stderrPreview.split("\n").slice(0, 20));
  if (transcriptReady) lines.push("", "[conversation]", ...transcript);
  else if (transcript.length > 0) lines.push("", ...transcript);
  if (!transcriptReady && !run.outputPreview.trim() && !run.stderrPreview.trim()) lines.push("", "No output captured yet.");
  return lines;
}
