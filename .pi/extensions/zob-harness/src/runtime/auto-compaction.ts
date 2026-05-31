import { randomUUID } from "node:crypto";
import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { compact, estimateTokens, findCutPoint } from "@earendil-works/pi-coding-agent";

import { sha256 } from "../utils/hashing.js";
import { isRecord } from "../utils/records.js";
import { buildZobCompactionInstructions, withZobCompactionDetails, ZOB_COMPACTION_TARGET_TOKENS, type ZobCompactionDetails } from "./compaction-policy.js";
import type { HarnessRuntimeState } from "./state.js";

export const ZCOMPACT_ENTRY_TYPE = "zob-zcompact";
export const ZCOMPACT_CONFIG_SCHEMA = "zob.zcompact-config.v1";
export const ZCOMPACT_RUN_SCHEMA = "zob.zcompact-run.v1";
export const ZCOMPACT_AUTO_MARKER = "ZOB_ZCOMPACT_AUTO";

export type ZcompactMode = "off" | "observe" | "auto";
export type ZcompactRunReason = "auto_threshold" | "manual_trigger";
export type ZcompactDecisionAction = "off" | "wait" | "would_compact" | "started" | "skipped" | "deferred" | "blocked";

type CompactPreparation = Parameters<typeof compact>[0];
type CompactMessage = CompactPreparation["messagesToSummarize"][number];

export interface ZcompactUsageSnapshot {
  at: string;
  tokens?: number;
  contextWindow?: number;
  percent?: number;
}

export interface ZcompactDecision {
  at: string;
  action: ZcompactDecisionAction;
  reason: string;
  usage?: ZcompactUsageSnapshot;
}

export interface ZcompactPendingRun {
  runId: string;
  reason: ZcompactRunReason;
  startedAt: string;
  contextTokens: number;
  contextWindow: number;
  percentBefore: number;
  keepRecentTokens: number;
  estimatedSummarizedTokens: number;
  triggerPercent: number;
  compactOldestFraction: number;
  targetAfterPercent: number;
}

export interface ZcompactRunRecord extends ZcompactPendingRun {
  status: "running" | "completed" | "failed" | "cancelled";
  completedAt?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  estimatedSummaryTokens?: number;
  estimatedNetSavedTokens?: number;
  summaryHash?: string;
  error?: string;
}

export interface ZcompactRuntimeState {
  mode: ZcompactMode;
  triggerPercent: number;
  compactOldestFraction: number;
  targetAfterPercent: number;
  minSummarizableTokens: number;
  cooldownMs: number;
  running: boolean;
  pending?: ZcompactPendingRun;
  lastRun?: ZcompactRunRecord;
  lastDecision?: ZcompactDecision;
  lastUsage?: ZcompactUsageSnapshot;
}

export function createZcompactRuntimeState(): ZcompactRuntimeState {
  return {
    mode: "off",
    triggerPercent: 60,
    compactOldestFraction: 0.25,
    targetAfterPercent: 25,
    minSummarizableTokens: 8_000,
    cooldownMs: 120_000,
    running: false,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return finiteNumber(record[key]);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safePercent(value: number, fallback: number): number {
  return clamp(Number.isFinite(value) ? value : fallback, 1, 95);
}

function safeFraction(value: number, fallback: number): number {
  return clamp(Number.isFinite(value) ? value : fallback, 0.05, 0.8);
}

function parseMaybePercentOrFraction(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/%$/, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 1 ? parsed / 100 : parsed;
}

function parseMaybePercent(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/%$/, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatPercent(value: number | undefined, digits = 1): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}%` : "n/a";
}

function formatTokenCount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const safe = Math.max(0, Math.floor(value));
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}k`;
  return `${(safe / 1_000_000).toFixed(1)}m`;
}

function usageSnapshot(ctx: ExtensionContext): ZcompactUsageSnapshot {
  const usage = ctx.getContextUsage();
  const tokens = finiteNumber(usage?.tokens);
  const contextWindow = finiteNumber(usage?.contextWindow);
  const percent = finiteNumber(usage?.percent);
  return { at: nowIso(), ...(tokens !== undefined ? { tokens } : {}), ...(contextWindow !== undefined ? { contextWindow } : {}), ...(percent !== undefined ? { percent } : {}) };
}

function usageIsKnown(usage: ZcompactUsageSnapshot): usage is ZcompactUsageSnapshot & { tokens: number; contextWindow: number; percent: number } {
  return typeof usage.tokens === "number" && typeof usage.contextWindow === "number" && typeof usage.percent === "number";
}

function decision(state: ZcompactRuntimeState, action: ZcompactDecisionAction, reason: string, usage?: ZcompactUsageSnapshot): ZcompactDecision {
  const record = { at: nowIso(), action, reason, ...(usage ? { usage } : {}) };
  state.lastDecision = record;
  if (usage) state.lastUsage = usage;
  return record;
}

function msSince(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? Date.now() - time : undefined;
}

function shouldNotifyDecision(state: ZcompactRuntimeState, action: ZcompactDecisionAction): boolean {
  if (state.lastDecision?.action !== action) return true;
  const age = msSince(state.lastDecision.at);
  return age === undefined || age > Math.min(state.cooldownMs, 30_000);
}

function zcompactSettingsEntry(state: ZcompactRuntimeState, reason: string): Record<string, unknown> {
  return {
    schema: ZCOMPACT_CONFIG_SCHEMA,
    policyVersion: 2,
    event: "config",
    mode: state.mode,
    triggerPercent: state.triggerPercent,
    compactOldestFraction: state.compactOldestFraction,
    targetAfterPercent: state.targetAfterPercent,
    minSummarizableTokens: state.minSummarizableTokens,
    cooldownMs: state.cooldownMs,
    reason,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: nowIso(),
  };
}

function zcompactRunEntry(run: ZcompactRunRecord, event: "start" | "complete" | "failed" | "cancelled"): Record<string, unknown> {
  return {
    schema: ZCOMPACT_RUN_SCHEMA,
    policyVersion: 2,
    event,
    runId: run.runId,
    reason: run.reason,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    contextTokens: run.contextTokens,
    contextWindow: run.contextWindow,
    percentBefore: run.percentBefore,
    keepRecentTokens: run.keepRecentTokens,
    estimatedSummarizedTokens: run.estimatedSummarizedTokens,
    estimatedSummaryTokens: run.estimatedSummaryTokens,
    estimatedNetSavedTokens: run.estimatedNetSavedTokens,
    firstKeptEntryId: run.firstKeptEntryId,
    tokensBefore: run.tokensBefore,
    summaryHash: run.summaryHash,
    errorHash: run.error ? sha256(run.error) : undefined,
    triggerPercent: run.triggerPercent,
    compactOldestFraction: run.compactOldestFraction,
    targetAfterPercent: run.targetAfterPercent,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: nowIso(),
  };
}

function appendConfig(pi: ExtensionAPI, state: ZcompactRuntimeState, reason: string): void {
  pi.appendEntry(ZCOMPACT_ENTRY_TYPE, zcompactSettingsEntry(state, reason));
}

function appendRun(pi: ExtensionAPI, run: ZcompactRunRecord, event: "start" | "complete" | "failed" | "cancelled"): void {
  pi.appendEntry(ZCOMPACT_ENTRY_TYPE, zcompactRunEntry(run, event));
}

export function restoreZcompactStateFromBranch(branch: unknown[], current: ZcompactRuntimeState = createZcompactRuntimeState()): ZcompactRuntimeState {
  const restored: ZcompactRuntimeState = { ...current, running: false, pending: undefined };
  let latestConfigPolicyVersion: number | undefined;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.customType !== ZCOMPACT_ENTRY_TYPE || !isRecord(entry.data)) continue;
    const data = entry.data as Record<string, unknown>;
    const schema = stringField(data, "schema");
    if (schema === ZCOMPACT_CONFIG_SCHEMA) {
      latestConfigPolicyVersion = numberField(data, "policyVersion");
      const mode = stringField(data, "mode");
      if (mode === "off" || mode === "observe" || mode === "auto") restored.mode = mode;
      restored.triggerPercent = safePercent(numberField(data, "triggerPercent") ?? restored.triggerPercent, restored.triggerPercent);
      restored.compactOldestFraction = safeFraction(numberField(data, "compactOldestFraction") ?? restored.compactOldestFraction, restored.compactOldestFraction);
      restored.targetAfterPercent = safePercent(numberField(data, "targetAfterPercent") ?? restored.targetAfterPercent, restored.targetAfterPercent);
      restored.minSummarizableTokens = Math.max(0, Math.trunc(numberField(data, "minSummarizableTokens") ?? restored.minSummarizableTokens));
      restored.cooldownMs = Math.max(0, Math.trunc(numberField(data, "cooldownMs") ?? restored.cooldownMs));
      continue;
    }
    if (schema !== ZCOMPACT_RUN_SCHEMA) continue;
    const runId = stringField(data, "runId");
    const reason = stringField(data, "reason");
    const status = stringField(data, "status");
    if (!runId || (reason !== "auto_threshold" && reason !== "manual_trigger")) continue;
    const run: ZcompactRunRecord = {
      runId,
      reason,
      status: status === "completed" || status === "failed" || status === "cancelled" ? status : "running",
      startedAt: stringField(data, "startedAt") ?? stringField(data, "generatedAt") ?? nowIso(),
      completedAt: stringField(data, "completedAt"),
      contextTokens: Math.max(0, Math.trunc(numberField(data, "contextTokens") ?? 0)),
      contextWindow: Math.max(1, Math.trunc(numberField(data, "contextWindow") ?? 1)),
      percentBefore: numberField(data, "percentBefore") ?? 0,
      keepRecentTokens: Math.max(1, Math.trunc(numberField(data, "keepRecentTokens") ?? 1)),
      estimatedSummarizedTokens: Math.max(0, Math.trunc(numberField(data, "estimatedSummarizedTokens") ?? 0)),
      estimatedSummaryTokens: numberField(data, "estimatedSummaryTokens"),
      estimatedNetSavedTokens: numberField(data, "estimatedNetSavedTokens"),
      triggerPercent: numberField(data, "triggerPercent") ?? restored.triggerPercent,
      compactOldestFraction: numberField(data, "compactOldestFraction") ?? restored.compactOldestFraction,
      targetAfterPercent: numberField(data, "targetAfterPercent") ?? restored.targetAfterPercent,
      firstKeptEntryId: stringField(data, "firstKeptEntryId"),
      tokensBefore: numberField(data, "tokensBefore"),
      summaryHash: stringField(data, "summaryHash"),
    };
    restored.lastRun = run;
  }
  if (latestConfigPolicyVersion === undefined && restored.triggerPercent === 50 && restored.targetAfterPercent === 38 && restored.compactOldestFraction === 0.25) {
    restored.triggerPercent = 60;
    restored.targetAfterPercent = 25;
  }
  return restored;
}

export function zcompactHelpText(): string {
  return [
    "# ZOB zcompact",
    "",
    "Session-local proactive compaction for long coding-agent conversations.",
    "",
    "Commands:",
    "/zcompact status              # show current usage and settings",
    "/zcompact observe             # report what would compact at the threshold, no mutation",
    "/zcompact on                  # auto-compact when context reaches the threshold",
    "/zcompact off                 # disable proactive compaction",
    "/zcompact threshold 60        # set trigger percent",
    "/zcompact target 25           # compact enough to return near 25% context",
    "/zcompact fraction 25         # minimum oldest batch when target needs less",
    "/zcompact trigger             # compact now using current target, even below threshold",
    "",
    "Safety:",
    "- summary is a continuity index, not evidence",
    "- recent messages remain in clear text according to the fraction",
    "- ledgers store metadata/hashes only, not prompt/output bodies",
  ].join("\n");
}

export function formatZcompactHudLine(state: ZcompactRuntimeState, ctx: ExtensionContext): string {
  const usage = usageSnapshot(ctx);
  state.lastUsage = usage;
  const usageText = usageIsKnown(usage)
    ? `${formatPercent(usage.percent)} ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)}`
    : "usage n/a";
  const modeText = state.running ? "running" : state.mode;
  const last = state.lastRun
    ? ` · last ${state.lastRun.status}${typeof state.lastRun.estimatedNetSavedTokens === "number" ? ` saved≈${formatTokenCount(state.lastRun.estimatedNetSavedTokens)}` : ""}`
    : "";
  return `ctx ${usageText} · zcompact ${modeText}@${formatPercent(state.triggerPercent, 0)}→${formatPercent(state.targetAfterPercent, 0)} minOld≈${formatPercent(state.compactOldestFraction * 100, 0)}${last}`;
}

export function formatZcompactStatus(state: ZcompactRuntimeState, ctx: ExtensionContext): string {
  const usage = usageSnapshot(ctx);
  state.lastUsage = usage;
  const lines = [
    `zcompact: ${state.running ? "running" : state.mode}`,
    usageIsKnown(usage)
      ? `context: ${formatPercent(usage.percent)} ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)} tokens`
      : "context: usage unavailable",
    `trigger: ${formatPercent(state.triggerPercent, 0)}`,
    `target after: ~${formatPercent(state.targetAfterPercent, 0)} of context; compact enough older messages to return near target`,
    `minimum batch: oldest ~${formatPercent(state.compactOldestFraction * 100, 0)} when target needs less; cooldown: ${Math.round(state.cooldownMs / 1000)}s`,
    `min summarizable: ${formatTokenCount(state.minSummarizableTokens)} tokens`,
  ];
  if (state.pending) {
    lines.push(`pending: ${state.pending.runId} ${state.pending.reason} keepRecent=${formatTokenCount(state.pending.keepRecentTokens)} summarize≈${formatTokenCount(state.pending.estimatedSummarizedTokens)}`);
  }
  if (state.lastRun) {
    lines.push(`last: ${state.lastRun.status} ${state.lastRun.reason} at ${state.lastRun.completedAt ?? state.lastRun.startedAt}`);
    lines.push(`last tokens: before=${formatTokenCount(state.lastRun.tokensBefore ?? state.lastRun.contextTokens)} keepRecent=${formatTokenCount(state.lastRun.keepRecentTokens)} summary≈${formatTokenCount(state.lastRun.estimatedSummaryTokens)} netSaved≈${formatTokenCount(state.lastRun.estimatedNetSavedTokens)}`);
    if (state.lastRun.summaryHash) lines.push(`last summaryHash: ${state.lastRun.summaryHash.slice(0, 16)}`);
  }
  if (state.lastDecision) lines.push(`last decision: ${state.lastDecision.action} · ${state.lastDecision.reason}`);
  return lines.join("\n");
}

function zcompactBudgetForTarget(input: { availableEntryTokens: number; contextTokens: number; contextWindow: number; targetAfterPercent: number; compactOldestFraction: number }): { keepRecentTokens: number; estimatedSummarizedTokens: number } {
  const safeAvailable = Math.max(1, Math.floor(input.availableEntryTokens));
  const maxKeep = Math.max(1, safeAvailable - 1);
  const targetTotalTokens = Math.max(1, Math.floor(input.contextWindow * (input.targetAfterPercent / 100)));
  const nonCompactableTokens = Math.max(0, Math.floor(input.contextTokens) - safeAvailable);
  const targetKeepRecentTokens = Math.floor(targetTotalTokens - nonCompactableTokens - ZOB_COMPACTION_TARGET_TOKENS);
  const minimumBatchKeepRecentTokens = Math.floor(safeAvailable * (1 - input.compactOldestFraction));
  const desiredKeepRecentTokens = Math.min(targetKeepRecentTokens, minimumBatchKeepRecentTokens);
  const keepRecentTokens = Math.max(1, Math.min(maxKeep, desiredKeepRecentTokens));
  return { keepRecentTokens, estimatedSummarizedTokens: Math.max(0, safeAvailable - keepRecentTokens) };
}

function buildPendingRun(state: ZcompactRuntimeState, usage: ZcompactUsageSnapshot & { tokens: number; contextWindow: number; percent: number }, reason: ZcompactRunReason): ZcompactPendingRun {
  const budget = zcompactBudgetForTarget({ availableEntryTokens: usage.tokens, contextTokens: usage.tokens, contextWindow: usage.contextWindow, targetAfterPercent: state.targetAfterPercent, compactOldestFraction: state.compactOldestFraction });
  return {
    runId: randomUUID(),
    reason,
    startedAt: nowIso(),
    contextTokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percentBefore: usage.percent,
    keepRecentTokens: budget.keepRecentTokens,
    estimatedSummarizedTokens: budget.estimatedSummarizedTokens,
    triggerPercent: state.triggerPercent,
    compactOldestFraction: state.compactOldestFraction,
    targetAfterPercent: state.targetAfterPercent,
  };
}

function zcompactCustomInstructions(pending: ZcompactPendingRun): string {
  return [
    ZCOMPACT_AUTO_MARKER,
    `run_id: ${pending.runId}`,
    `reason: ${pending.reason}`,
    `trigger_percent: ${pending.triggerPercent}`,
    `compact_oldest_fraction: ${pending.compactOldestFraction}`,
    `target_after_percent: ${pending.targetAfterPercent}`,
    `keep_recent_tokens: ${pending.keepRecentTokens}`,
    "Summarize only the older compacted span; preserve the latest retained messages as the immediate source of truth.",
    "Keep the summary as a continuity index with refs/hashes/statuses and do not paste raw tool outputs, prompts, diffs, secrets, or full file bodies.",
  ].join("\n");
}

function finishRun(pi: ExtensionAPI, state: ZcompactRuntimeState, result: CompactionResult | undefined, status: "completed" | "failed" | "cancelled", error?: string): ZcompactRunRecord | undefined {
  const pending = state.pending;
  if (!pending) {
    state.running = false;
    return undefined;
  }
  const estimatedSummaryTokens = result?.summary ? Math.ceil(result.summary.length / 4) : undefined;
  const run: ZcompactRunRecord = {
    ...pending,
    status,
    completedAt: nowIso(),
    firstKeptEntryId: result?.firstKeptEntryId,
    tokensBefore: result?.tokensBefore,
    estimatedSummaryTokens,
    estimatedNetSavedTokens: typeof estimatedSummaryTokens === "number" ? Math.max(0, pending.estimatedSummarizedTokens - estimatedSummaryTokens) : undefined,
    summaryHash: result?.summary ? sha256(result.summary) : undefined,
    error,
  };
  state.lastRun = run;
  state.running = false;
  state.pending = undefined;
  appendRun(pi, run, status === "completed" ? "complete" : status === "failed" ? "failed" : "cancelled");
  return run;
}

export async function maybeTriggerZcompact(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext, options: { force?: boolean; bypassCooldown?: boolean; reason?: ZcompactRunReason; source?: string; render?: () => void } = {}): Promise<boolean> {
  const zcompact = state.zcompact;
  const usage = usageSnapshot(ctx);
  zcompact.lastUsage = usage;

  if (!options.force && zcompact.mode === "off") {
    decision(zcompact, "off", "zcompact disabled", usage);
    return false;
  }
  if (!usageIsKnown(usage)) {
    decision(zcompact, "skipped", "context usage unavailable", usage);
    return false;
  }
  if (!options.force && usage.percent < zcompact.triggerPercent) {
    decision(zcompact, "wait", `context below threshold (${formatPercent(usage.percent)} < ${formatPercent(zcompact.triggerPercent)})`, usage);
    return false;
  }
  if (zcompact.running || zcompact.pending) {
    decision(zcompact, "deferred", "zcompact already running", usage);
    return false;
  }
  if (state.runtimeGoalContinuationCompactionFor) {
    decision(zcompact, "deferred", "runtime goal compaction already running", usage);
    return false;
  }
  const pending = buildPendingRun(zcompact, usage, options.reason ?? (options.force ? "manual_trigger" : "auto_threshold"));
  if (!options.force && pending.estimatedSummarizedTokens < zcompact.minSummarizableTokens) {
    decision(zcompact, "skipped", `summarizable span too small (${formatTokenCount(pending.estimatedSummarizedTokens)} < ${formatTokenCount(zcompact.minSummarizableTokens)})`, usage);
    return false;
  }
  const cooldownAge = msSince(zcompact.lastRun?.completedAt);
  if (!options.force && !options.bypassCooldown && cooldownAge !== undefined && cooldownAge < zcompact.cooldownMs) {
    decision(zcompact, "deferred", `cooldown active (${Math.ceil((zcompact.cooldownMs - cooldownAge) / 1000)}s remaining)`, usage);
    return false;
  }
  if (!options.force && (!ctx.isIdle() || ctx.hasPendingMessages())) {
    decision(zcompact, "deferred", "agent busy or queued messages pending", usage);
    return false;
  }
  if (!options.force && zcompact.mode === "observe") {
    const notify = shouldNotifyDecision(zcompact, "would_compact");
    decision(zcompact, "would_compact", `would compact toward ${formatPercent(zcompact.targetAfterPercent, 0)} now; use /zcompact on to enable`, usage);
    if (notify && ctx.hasUI) ctx.ui.notify(`zcompact observe: context ${formatPercent(usage.percent)} >= ${formatPercent(zcompact.triggerPercent)}; would summarize ≈${formatTokenCount(pending.estimatedSummarizedTokens)} and keep recent ≈${formatTokenCount(pending.keepRecentTokens)} clear.`, "info");
    options.render?.();
    return false;
  }

  zcompact.pending = pending;
  zcompact.running = true;
  const run: ZcompactRunRecord = { ...pending, status: "running" };
  zcompact.lastRun = run;
  appendRun(pi, run, "start");
  decision(zcompact, "started", `${pending.reason} started`, usage);
  if (ctx.hasUI) ctx.ui.notify(`zcompact: compacting toward ${formatPercent(pending.targetAfterPercent, 0)} context; summarizing older ≈${formatTokenCount(pending.estimatedSummarizedTokens)} and keeping recent ≈${formatTokenCount(pending.keepRecentTokens)} clear.`, "info");
  options.render?.();
  ctx.compact({
    customInstructions: zcompactCustomInstructions(pending),
    onComplete: (result) => {
      const completed = finishRun(pi, zcompact, result, "completed");
      if (completed && ctx.hasUI) ctx.ui.notify(`zcompact complete: net saved≈${formatTokenCount(completed.estimatedNetSavedTokens)} summaryHash=${completed.summaryHash?.slice(0, 12) ?? "n/a"}`, "info");
      options.render?.();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      finishRun(pi, zcompact, undefined, "failed", message);
      if (ctx.hasUI) ctx.ui.notify(`zcompact failed: ${message}`, "warning");
      options.render?.();
    },
  });
  return true;
}

function timestampMs(value: string | undefined): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function messageFromEntryForCompaction(entry: SessionEntry): CompactMessage | undefined {
  if (entry.type === "compaction") return undefined;
  if (entry.type === "message") return entry.message as CompactMessage;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: timestampMs(entry.timestamp),
    } as CompactMessage;
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: timestampMs(entry.timestamp),
    } as CompactMessage;
  }
  return undefined;
}

function latestCompactionIndex(entries: SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") return index;
  }
  return -1;
}

function estimateEntryRangeTokens(entries: SessionEntry[], start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    const message = messageFromEntryForCompaction(entries[index]);
    if (message) total += estimateTokens(message);
  }
  return total;
}

function applyDynamicZcompactBudget(state: HarnessRuntimeState, availableEntryTokens: number): void {
  const pending = state.zcompact.pending;
  if (!pending) return;
  const budget = zcompactBudgetForTarget({ availableEntryTokens, contextTokens: pending.contextTokens, contextWindow: pending.contextWindow, targetAfterPercent: pending.targetAfterPercent, compactOldestFraction: pending.compactOldestFraction });
  pending.keepRecentTokens = budget.keepRecentTokens;
  pending.estimatedSummarizedTokens = budget.estimatedSummarizedTokens;
  const running = state.zcompact.lastRun;
  if (running?.runId === pending.runId && running.status === "running") {
    running.keepRecentTokens = pending.keepRecentTokens;
    running.estimatedSummarizedTokens = pending.estimatedSummarizedTokens;
  }
}

function cloneFileOps(fileOps: CompactPreparation["fileOps"]): CompactPreparation["fileOps"] {
  return {
    read: new Set(fileOps.read),
    written: new Set(fileOps.written),
    edited: new Set(fileOps.edited),
  };
}

export function buildZcompactPreparation(state: HarnessRuntimeState, base: CompactPreparation, branchEntries: SessionEntry[]): CompactPreparation {
  const pending = state.zcompact.pending;
  if (!pending) return base;
  const prevCompactionIndex = latestCompactionIndex(branchEntries);
  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const previous = branchEntries[prevCompactionIndex];
    if (previous?.type === "compaction") {
      previousSummary = previous.summary;
      const firstKeptEntryIndex = branchEntries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
      boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
    }
  }
  const boundaryEnd = branchEntries.length;
  const availableEntryTokens = estimateEntryRangeTokens(branchEntries, boundaryStart, boundaryEnd);
  applyDynamicZcompactBudget(state, availableEntryTokens);
  if (pending.estimatedSummarizedTokens < state.zcompact.minSummarizableTokens) throw new Error(`zcompact compactable span too small (${formatTokenCount(pending.estimatedSummarizedTokens)} < ${formatTokenCount(state.zcompact.minSummarizableTokens)})`);
  const cutPoint = findCutPoint(branchEntries, boundaryStart, boundaryEnd, pending.keepRecentTokens);
  const firstKeptEntry = branchEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) throw new Error("zcompact could not find a dynamic kept-entry boundary");
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  if (historyEnd < boundaryStart) throw new Error("zcompact dynamic cut point is before the compaction boundary");
  const messagesToSummarize: CompactPreparation["messagesToSummarize"] = [];
  for (let index = boundaryStart; index < historyEnd; index += 1) {
    const message = messageFromEntryForCompaction(branchEntries[index]);
    if (message) messagesToSummarize.push(message);
  }
  const turnPrefixMessages: CompactPreparation["turnPrefixMessages"] = [];
  if (cutPoint.isSplitTurn) {
    for (let index = cutPoint.turnStartIndex; index < cutPoint.firstKeptEntryIndex; index += 1) {
      const message = messageFromEntryForCompaction(branchEntries[index]);
      if (message) turnPrefixMessages.push(message);
    }
  }
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) throw new Error("zcompact dynamic summarization span is empty");
  return {
    ...base,
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    previousSummary,
    fileOps: cloneFileOps(base.fileOps),
    settings: { ...base.settings, keepRecentTokens: pending.keepRecentTokens },
  };
}

export function cancelZcompactPending(pi: ExtensionAPI, state: ZcompactRuntimeState, error: string): ZcompactRunRecord | undefined {
  return finishRun(pi, state, undefined, "failed", error);
}

export async function runZcompactCompactionHook(state: HarnessRuntimeState, input: { preparation: CompactPreparation; branchEntries: SessionEntry[]; ctx: ExtensionContext; apiKey?: string; headers?: Record<string, string>; signal: AbortSignal }): Promise<CompactionResult<ZobCompactionDetails>> {
  const pending = state.zcompact.pending;
  const preparation = buildZcompactPreparation(state, input.preparation, input.branchEntries);
  const customInstructions = buildZobCompactionInstructions(state, {
    reason: pending?.reason ?? "auto_threshold",
    customInstructions: pending ? zcompactCustomInstructions(pending) : ZCOMPACT_AUTO_MARKER,
    fileOps: preparation.fileOps,
  });
  if (!input.ctx.model) throw new Error("model unavailable");
  const result = await compact(preparation, input.ctx.model, input.apiKey, input.headers, customInstructions, input.signal);
  return withZobCompactionDetails(state, result, { fileOps: preparation.fileOps });
}

export async function handleZcompactCommand(pi: ExtensionAPI, state: HarnessRuntimeState, args: string, ctx: ExtensionContext, render: () => void): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const requested = (parts[0] ?? "status").toLowerCase();
  const zcompact = state.zcompact;
  if (requested === "help" || requested === "--help" || requested === "-h") {
    ctx.ui.setEditorText(zcompactHelpText());
    ctx.ui.notify("ZOB zcompact help inserted.", "info");
    return;
  }
  if (requested === "status" || requested.length === 0) {
    render();
    ctx.ui.notify(formatZcompactStatus(zcompact, ctx), "info");
    return;
  }
  if (requested === "on" || requested === "auto") {
    zcompact.mode = "auto";
    appendConfig(pi, zcompact, "command_on");
    render();
    ctx.ui.notify(`zcompact auto enabled: trigger ${formatPercent(zcompact.triggerPercent, 0)} → target ${formatPercent(zcompact.targetAfterPercent, 0)}`, "info");
    await maybeTriggerZcompact(pi, state, ctx, { source: "command_on", bypassCooldown: true, render });
    return;
  }
  if (requested === "off" || requested === "disable" || requested === "disabled") {
    zcompact.mode = "off";
    appendConfig(pi, zcompact, "command_off");
    render();
    ctx.ui.notify("zcompact disabled", "warning");
    return;
  }
  if (requested === "observe" || requested === "dry-run" || requested === "dryrun") {
    zcompact.mode = "observe";
    appendConfig(pi, zcompact, "command_observe");
    render();
    ctx.ui.notify(`zcompact observe enabled: will report at ${formatPercent(zcompact.triggerPercent, 0)} without compacting`, "info");
    await maybeTriggerZcompact(pi, state, ctx, { source: "command_observe", render });
    return;
  }
  if (requested === "threshold") {
    const value = parseMaybePercent(parts[1]);
    if (value === undefined) {
      ctx.ui.notify("Use /zcompact threshold 60", "warning");
      return;
    }
    zcompact.triggerPercent = safePercent(value, zcompact.triggerPercent);
    appendConfig(pi, zcompact, "command_threshold");
    render();
    ctx.ui.notify(`zcompact trigger set to ${formatPercent(zcompact.triggerPercent, 0)}`, "info");
    if (zcompact.mode !== "off") await maybeTriggerZcompact(pi, state, ctx, { source: "command_threshold", bypassCooldown: true, render });
    return;
  }
  if (requested === "target" || requested === "target-after" || requested === "target_after") {
    const value = parseMaybePercent(parts[1]);
    if (value === undefined) {
      ctx.ui.notify("Use /zcompact target 25", "warning");
      return;
    }
    zcompact.targetAfterPercent = safePercent(value, zcompact.targetAfterPercent);
    appendConfig(pi, zcompact, "command_target");
    render();
    ctx.ui.notify(`zcompact target after set to ${formatPercent(zcompact.targetAfterPercent, 0)}`, "info");
    if (zcompact.mode !== "off") await maybeTriggerZcompact(pi, state, ctx, { source: "command_target", bypassCooldown: true, render });
    return;
  }
  if (requested === "fraction" || requested === "oldest" || requested === "compact") {
    const value = parseMaybePercentOrFraction(parts[1]);
    if (value === undefined) {
      ctx.ui.notify("Use /zcompact fraction 25", "warning");
      return;
    }
    zcompact.compactOldestFraction = safeFraction(value, zcompact.compactOldestFraction);
    appendConfig(pi, zcompact, "command_fraction");
    render();
    ctx.ui.notify(`zcompact minimum batch set to oldest ~${formatPercent(zcompact.compactOldestFraction * 100, 0)}; target remains ${formatPercent(zcompact.targetAfterPercent, 0)}`, "info");
    if (zcompact.mode !== "off") await maybeTriggerZcompact(pi, state, ctx, { source: "command_fraction", bypassCooldown: true, render });
    return;
  }
  if (requested === "trigger" || requested === "now") {
    const started = await maybeTriggerZcompact(pi, state, ctx, { force: true, reason: "manual_trigger", source: "command", render });
    if (!started) ctx.ui.notify(`zcompact trigger did not start: ${zcompact.lastDecision?.reason ?? "see status"}`, "warning");
    return;
  }
  ctx.ui.notify("Unknown /zcompact command. Use /zcompact help|status|observe|on|off|threshold|target|fraction|trigger.", "warning");
}

export function zcompactConfigSummary(state: ZcompactRuntimeState): Record<string, unknown> {
  return {
    mode: state.mode,
    triggerPercent: state.triggerPercent,
    compactOldestFraction: state.compactOldestFraction,
    targetAfterPercent: state.targetAfterPercent,
    minSummarizableTokens: state.minSummarizableTokens,
    cooldownMs: state.cooldownMs,
    running: state.running,
    hasPending: Boolean(state.pending),
    lastRunStatus: state.lastRun?.status,
    lastDecisionAction: state.lastDecision?.action,
    bodyStored: false,
  };
}
