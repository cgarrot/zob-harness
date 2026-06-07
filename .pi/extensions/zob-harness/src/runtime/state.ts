import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { DEFAULT_RULES, MODE_PROMPTS } from "../core/constants.js";
import { classifyModeRegex } from "../domains/intent/intent-classifier.js";
import type { ChildResult, DamageRules, DelegationFailureKind, GoalState, ModeName, QueueTickResult, RuleResolution } from "../types.js";
import { validateGoalState, validateStrictGoalSpecAnchor, type StrictGoalSpecAnchor } from "../domains/goal/goal.js";
import { DEFAULT_GOAL_ACTIVATION_MODE, restoreGoalActivationModeFromBranch, restoreRuntimeGoalFromBranch, type GoalActivationMode, type RuntimeGoal } from "./goal-runtime.js";
import { createGoalTodoState, restoreGoalTodosFromBranch, type GoalTodoState } from "../domains/goal/goal-todos.js";
import { isRecord } from "../core/utils/records.js";
import type { ZobLiveEnvelope } from "../domains/coms/coms-v2/envelope.js";
import type { ZobLocalTransportServer } from "../domains/coms/coms-v2/local-transport.js";
import { ZobPendingReplies } from "../domains/coms/coms-v2/pending-replies.js";
import type { ZobLivePeerCard } from "../domains/coms/coms-v2/types.js";
import { createDelegationMonitorState, trimDelegationRuns, type DelegationMonitorState, type DelegationRunMode, type DelegationRunSource, type DelegationRunStatus, type DelegationRunView } from "./delegation-monitor.js";
import { DEFAULT_DAEMON_RUNTIME_POLICY, type DaemonLoopSnapshot, type DaemonRuntimePolicy, type DaemonRuntimeState, type DaemonTickPlan } from "../domains/autonomy/daemon-runtime.js";
import { createInteractiveAutonomyRuntimeState, restoreInteractiveAutonomyState, type InteractiveAutonomyRuntimeState } from "../domains/autonomy/interactive-autonomy.js";
import type { ZobModeIntent } from "./mode-intent.js";
import type { ZAgentRoomBinding } from "../domains/coms/zagents.js";
import { createZcompactRuntimeState, restoreZcompactStateFromBranch, type ZcompactRuntimeState } from "./auto-compaction.js";
import { createZcommitRuntimeState, recordZcommitOwnedPath, type ZcommitLastCommitRecord, type ZcommitOwnershipSource, type ZcommitRuntimeState, type ZcommitToggleState } from "../domains/git/git-ops.js";

export interface DelegationMouseRuntimeState {
  tui?: TUI;
  enabled: boolean;
  unsubscribe?: () => void;
  opening: boolean;
  overlaySelect?: (runId: string) => boolean;
  overlayClose?: () => boolean;
  overlayScroll?: (direction: "up" | "down", x?: number, y?: number) => boolean;
  mouseReenableTimer?: ReturnType<typeof setTimeout>;
  releasedUntilMs?: number;
  suppressOpenUntilMs?: number;
  mouseReleaseEpoch: number;
  widgetOwner?: symbol;
}

export interface ZobLiveLastEvent {
  kind: "status" | "attempt" | "delivered" | "waiting" | "reply" | "sent" | "completed" | "blocked" | "error" | "timeout" | "expired" | "inbound" | "response_sent" | "heartbeat";
  roomId?: string;
  fromAlias?: string;
  toAlias?: string;
  status: string;
  reason?: string;
  msgId?: string;
  taskHash?: string;
  outputHash?: string;
  at: string;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
}

export interface ZobPassivePeerWaitState {
  schema: "zob.passive-peer-wait.v1";
  status: "waiting";
  msgId?: string;
  roomId?: string;
  targetAlias?: string;
  taskHash?: string;
  startedAt: string;
  startedAtMs: number;
  source: "zpeer_ask";
  suppressGoalContinuation: true;
  bodyStored: false;
  localOnly: true;
  networkEnabled: false;
}

export interface ZobLiveRuntimeState {
  pendingReplies: ZobPendingReplies;
  server?: ZobLocalTransportServer;
  peerCard?: ZobLivePeerCard;
  inbound?: { envelope: ZobLiveEnvelope; receivedAt: string; responseSent: boolean; repoRoot: string };
  lastEvent?: ZobLiveLastEvent;
  passivePeerWait?: ZobPassivePeerWaitState;
  leaseOwned?: boolean;
  leaseStatus?: "owned" | "blocked" | "unavailable";
  leaseBlockReason?: "not_found" | "owner_mismatch" | "expired" | "blocked_live_owner";
  zpeerAskGuard?: { windowStartedMs: number; count: number; lastRoomId?: string; lastTargetAlias?: string; lastMessageHash?: string };
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  lastHeartbeatMs?: number;
}

export interface DaemonHarnessRuntimeState {
  policy: DaemonRuntimePolicy;
  lastStatus?: DaemonRuntimeState;
  lastPlan?: DaemonTickPlan;
  loop: DaemonLoopSnapshot;
  loopTimer?: ReturnType<typeof setTimeout>;
  lastQueueTick?: QueueTickResult;
  updatedAt?: string;
}

export interface ZagentScopedModeRuntimeState {
  active: boolean;
  label?: string;
  teamId?: string;
  modeId?: string;
  baseMode?: ModeName;
  source: string;
  promptRef?: string;
  prompt?: string;
  toolPolicy?: {
    allowedTools?: string[];
    allowedToolsExplicit?: boolean;
  };
  errors: string[];
  blockers: string[];
}

export interface ZagentRuntimeState {
  id?: string;
  team?: string;
  teams?: string[];
  role?: string;
  alias?: string;
  description?: string;
  rooms: ZAgentRoomBinding[];
  activeRoom?: string;
  defaultMode?: ModeName;
  prompt?: string;
  promptRef?: string;
  path?: string;
  errors: string[];
  loadedAt?: string;
  communicationPolicy?: Record<string, unknown>;
  scopedMode?: ZagentScopedModeRuntimeState;
}

export interface BackgroundDelegationRuntimeRun {
  runId: string;
  startedAtMs: number;
  promise: Promise<ChildResult>;
  abortController: AbortController;
  result?: ChildResult;
  error?: string;
}

export interface HarnessRuntimeState {
  activeMode: ModeName;
  currentRules: DamageRules;
  activeGoal?: GoalState;
  goalRequired: boolean;
  goalActivationMode?: GoalActivationMode;
  runtimeGoal?: RuntimeGoal;
  goalTodos: GoalTodoState;
  runtimeGoalContinuationQueuedFor?: string;
  runtimeGoalContinuationScheduledFor?: string;
  runtimeGoalContinuationCompactionFor?: string;
  runtimeGoalContinuationTimer?: ReturnType<typeof setTimeout>;
  runtimeGoalContinuationTurnFor?: string;
  runtimeGoalLastAccountedAtMs?: number;
  activeRuleResolution?: RuleResolution;
  lastUserInputText?: string;
  lastModeIntent?: ZobModeIntent & { at: number; accepted: boolean; validationReason: string };
  delegations: DelegationMonitorState;
  delegationMouse: DelegationMouseRuntimeState;
  zobLive: ZobLiveRuntimeState;
  autonomy: InteractiveAutonomyRuntimeState;
  daemon: DaemonHarnessRuntimeState;
  zcompact: ZcompactRuntimeState;
  zcommit: ZcommitRuntimeState;
  zagent: ZagentRuntimeState;
  backgroundDelegations: Map<string, BackgroundDelegationRuntimeRun>;
}

export function createHarnessRuntimeState(): HarnessRuntimeState {
  return {
    activeMode: "explore",
    currentRules: DEFAULT_RULES,
    activeGoal: undefined,
    goalRequired: false,
    goalActivationMode: DEFAULT_GOAL_ACTIVATION_MODE,
    runtimeGoal: undefined,
    goalTodos: createGoalTodoState(),
    runtimeGoalContinuationQueuedFor: undefined,
    runtimeGoalContinuationScheduledFor: undefined,
    runtimeGoalContinuationCompactionFor: undefined,
    runtimeGoalContinuationTimer: undefined,
    runtimeGoalLastAccountedAtMs: undefined,
    activeRuleResolution: undefined,
    lastUserInputText: undefined,
    lastModeIntent: undefined,
    delegations: createDelegationMonitorState(),
    delegationMouse: { enabled: false, opening: false, mouseReleaseEpoch: 0 },
    zobLive: { pendingReplies: new ZobPendingReplies() },
    autonomy: createInteractiveAutonomyRuntimeState(),
    daemon: {
      policy: { ...DEFAULT_DAEMON_RUNTIME_POLICY, enabled: false },
      loop: {
        schema: "zob.daemon-loop-snapshot.v1",
        status: "stopped",
        tickCount: 0,
        supervised: true,
        bounded: true,
        sessionLocal: true,
        autoStartDaemon: false,
        continuousLoop: false,
        cronEnabled: false,
      },
    },
    zcompact: createZcompactRuntimeState(),
    zcommit: createZcommitRuntimeState(),
    zagent: { rooms: [], errors: [] },
    backgroundDelegations: new Map(),
  };
}

export function strictGoalErrors(state: HarnessRuntimeState): string[] {
  return state.goalRequired ? validateGoalState(state.activeGoal) : [];
}

export function strictGoalSpecErrors(state: HarnessRuntimeState, anchor: Omit<StrictGoalSpecAnchor, "activeGoal">): string[] {
  return validateStrictGoalSpecAnchor({ ...anchor, activeGoal: state.activeGoal });
}

export function asGoalState(value: unknown): GoalState | undefined {
  if (!isRecord(value)) return undefined;
  const goal = {
    originalUserAsk: typeof value.originalUserAsk === "string" ? value.originalUserAsk : "",
    activeGoal: typeof value.activeGoal === "string" ? value.activeGoal : "",
    constraints: typeof value.constraints === "string" ? value.constraints : "",
    expectedOutput: typeof value.expectedOutput === "string" ? value.expectedOutput : "",
    validationEvidence: typeof value.validationEvidence === "string" ? value.validationEvidence : "",
    setAt: typeof value.setAt === "string" ? value.setAt : new Date().toISOString(),
  };
  return validateGoalState(goal).length === 0 ? goal : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTimeMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asDelegationMode(value: string | undefined): DelegationRunMode {
  return value === "parallel" || value === "chain" || value === "single" ? value : "single";
}

function asDelegationSource(value: string | undefined): DelegationRunSource {
  return value === "delegate_task" ? "delegate_task" : "delegate_agent";
}

function asDelegationFailureKind(value: string | undefined): DelegationFailureKind | undefined {
  return value === "preflight" || value === "config" || value === "output_gate" || value === "child_runtime" || value === "aborted" ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.map(String) : undefined;
}

function asZcommitToggle(value: unknown): ZcommitToggleState | undefined {
  return value === "on" || value === "off" ? value : undefined;
}

function asZcommitOwnershipSource(value: unknown): ZcommitOwnershipSource | undefined {
  return value === "local_tool_call" || value === "parent_accepted_child_claim" || value === "compaction_continuity" ? value : undefined;
}

function normalizeZcommitChildChangedPathRefs(value: unknown): DelegationRunView["childChangedPaths"] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.pathHash !== "string" || typeof item.status !== "string") return [];
    return [{ path: item.path, pathHash: item.pathHash, status: item.status, contentHash: typeof item.contentHash === "string" ? item.contentHash : undefined }];
  }).slice(0, 100);
}

function asZcommitLastCommitRecord(value: unknown): ZcommitLastCommitRecord | undefined {
  if (!isRecord(value) || typeof value.hash !== "string" || typeof value.shortHash !== "string" || typeof value.subject !== "string" || !Array.isArray(value.files) || typeof value.createdAt !== "string") return undefined;
  return {
    hash: value.hash,
    shortHash: value.shortHash,
    subject: value.subject,
    files: value.files.map(String),
    remote: typeof value.remote === "string" ? value.remote : undefined,
    branch: typeof value.branch === "string" ? value.branch : undefined,
    createdAt: value.createdAt,
    pushedAt: typeof value.pushedAt === "string" ? value.pushedAt : undefined,
  };
}

function restoreZcommitOwnedPathRefsFromData(state: HarnessRuntimeState, repoRoot: string, data: Record<string, unknown>, fallbackSource: ZcommitOwnershipSource, fallbackAt: string): void {
  const refs = Array.isArray(data.ownedPathRefs) ? data.ownedPathRefs : [];
  for (const value of refs) {
    if (!isRecord(value) || typeof value.path !== "string") continue;
    recordZcommitOwnedPath(state.zcommit, repoRoot, value.path, asZcommitOwnershipSource(value.source) ?? fallbackSource, typeof value.lastOwnedAt === "string" ? value.lastOwnedAt : fallbackAt);
  }
}

function restoreZcommitMetadataFromEntries(state: HarnessRuntimeState, repoRoot: string, entries: unknown[]): void {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.customType !== "zob-zcommit" || !isRecord(entry.data)) continue;
    const data = entry.data as Record<string, unknown>;
    const entryAt = stringField(data, "generatedAt") ?? stringField(entry, "timestamp") ?? new Date().toISOString();
    state.zcommit.autocommit = asZcommitToggle(data.autocommit) ?? state.zcommit.autocommit;
    state.zcommit.autopush = asZcommitToggle(data.autopush) ?? state.zcommit.autopush;
    const lastCommit = asZcommitLastCommitRecord(data.lastCommit);
    if (lastCommit) state.zcommit.lastCommit = lastCommit;
    const lastCommitHash = stringField(data, "lastCommitHash");
    const lastCommitShortHash = stringField(data, "lastCommitShortHash");
    if (!lastCommit && lastCommitHash && lastCommitShortHash) {
      state.zcommit.lastCommit = { hash: lastCommitHash, shortHash: lastCommitShortHash, subject: "restored /zcommit commit", files: [], createdAt: entryAt };
    }
    restoreZcommitOwnedPathRefsFromData(state, repoRoot, data, "local_tool_call", entryAt);
    state.zcommit.updatedAt = entryAt;
  }
}

function restoreDaemonMetadataFromEntries(state: HarnessRuntimeState, entries: unknown[]): void {
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.data)) continue;
    const customType = typeof entry.customType === "string" ? entry.customType : "";
    const data = entry.data as Record<string, unknown>;
    if (customType !== "zob-daemon-runtime" && customType !== "zob-daemon-plan") continue;
    state.daemon.policy = {
      ...state.daemon.policy,
      enabled: false,
      planOnly: true,
      scopedToActiveGoal: true,
      autoStartAllowed: false,
      continuousLoopAllowed: false,
      cronAllowed: false,
      childDispatchAllowed: false,
      queueClaimsAllowed: false,
      todoMutationAllowed: false,
      productionApplyAllowed: false,
    };
    state.daemon.updatedAt = stringField(data, "generatedAt") ?? stringField(entry, "timestamp") ?? state.daemon.updatedAt;
    state.daemon.loop = {
      ...state.daemon.loop,
      status: "stopped",
      stoppedAt: state.daemon.updatedAt,
      autoStartDaemon: false,
      continuousLoop: false,
      cronEnabled: false,
    };
  }
}

function usageField(record: Record<string, unknown>): ChildResult["usage"] | undefined {
  const usage = isRecord(record.usage) ? record.usage : undefined;
  if (!usage) return undefined;
  const numberValue = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    turns: numberValue("turns"),
    input: numberValue("input"),
    output: numberValue("output"),
    cacheRead: numberValue("cacheRead"),
    cacheWrite: numberValue("cacheWrite"),
    cost: numberValue("cost"),
    contextTokens: numberValue("contextTokens"),
  };
}

function restoredStatusFromLedger(event: string | undefined, status: string | undefined): DelegationRunStatus {
  if (event === "preflight_failed" || event === "config_failed") return "preflight_failed";
  if (status === "complete" || status === "completed") return "complete";
  if (status === "aborted") return "aborted";
  if (status === "failed" || status === "incomplete_or_failed" || status === "failed_preflight") return "failed";
  return event === "end" ? "complete" : "running";
}

function restoreDelegationRunsFromEntries(state: HarnessRuntimeState, entries: unknown[]): void {
  const restored = new Map<string, DelegationRunView>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.customType !== "zob-delegation" || !isRecord(entry.data)) continue;
    const data = entry.data as Record<string, unknown>;
    const runId = stringField(data, "runId");
    if (!runId) continue;
    const event = stringField(data, "event");
    const timestampMs = parseTimeMs(stringField(data, "startedAt") ?? stringField(data, "endedAt") ?? stringField(entry, "timestamp"), Date.now());
    const existing = restored.get(runId);
    const source = asDelegationSource(stringField(data, "source") ?? stringField(data, "tool"));
    const mode = asDelegationMode(stringField(data, "delegationMode") ?? stringField(data, "mode"));
    const agent = stringField(data, "agent") ?? existing?.agent ?? "delegate";
    const taskHash = stringField(data, "taskHash");
    const startedAtMs = existing?.startedAtMs ?? parseTimeMs(stringField(data, "startedAt"), Math.max(0, timestampMs - (numberField(data, "latencyMs") ?? 0)));
    const status = restoredStatusFromLedger(event, stringField(data, "status"));
    const restoredRun: DelegationRunView = {
      id: runId,
      parentToolCallId: stringField(data, "parentToolCallId") ?? existing?.parentToolCallId ?? runId,
      source: existing?.source ?? source,
      mode: existing?.mode ?? mode,
      index: numberField(data, "index") ?? existing?.index,
      agent,
      taskPreview: existing?.taskPreview ?? (taskHash ? `task hash ${taskHash.slice(0, 12)}` : "restored delegation"),
      status,
      startedAtMs,
      endedAtMs: parseTimeMs(stringField(data, "endedAt"), timestampMs),
      outputPreview: existing?.outputPreview ?? "",
      stderrPreview: existing?.stderrPreview ?? "",
      sessionPath: stringField(data, "sessionPath") ?? existing?.sessionPath,
      exitCode: numberField(data, "exitCode") ?? existing?.exitCode,
      gatePassed: typeof data.gatePassed === "boolean" ? data.gatePassed : existing?.gatePassed,
      gateErrors: stringArrayField(data, "gateErrors") ?? stringArrayField(data, "errors") ?? existing?.gateErrors,
      failureKind: asDelegationFailureKind(stringField(data, "failureKind")) ?? existing?.failureKind,
      stopReason: stringField(data, "stopReason") ?? existing?.stopReason,
      stopCondition: stringField(data, "stopCondition") ?? existing?.stopCondition,
      errorMessage: Array.isArray(data.errors) ? data.errors.map(String).join("; ") : existing?.errorMessage,
      childChangedPaths: normalizeZcommitChildChangedPathRefs(data.childChangedPathRefs) ?? existing?.childChangedPaths,
      usage: usageField(data) ?? existing?.usage,
      model: stringField(data, "model") ?? existing?.model,
      background: (typeof data.background === "boolean" ? data.background : undefined) ?? existing?.background,
    };
    if (event === "start") restoredRun.endedAtMs = existing?.endedAtMs;
    restored.set(runId, restoredRun);
  }
  if (restored.size === 0) return;
  state.delegations.runs = [...restored.values()].sort((a, b) => b.startedAtMs - a.startedAtMs);
  trimDelegationRuns(state.delegations);
}

export function restoreHarnessState(state: HarnessRuntimeState, ctx: ExtensionContext): void {
  const branch = ctx.sessionManager.getBranch();
  for (const entry of branch) {
    if (!isRecord(entry)) continue;
    const customType = typeof entry.customType === "string" ? entry.customType : "";
    const data = isRecord(entry.data) ? entry.data : undefined;
    if (customType === "zob-mode-state" && data && typeof data.mode === "string" && data.mode in MODE_PROMPTS) state.activeMode = data.mode as ModeName;
    if (customType === "zob-goal") state.activeGoal = asGoalState(data) ?? state.activeGoal;
    if (customType === "zob-job-intake" && data && isRecord(data.goal)) state.activeGoal = asGoalState(data.goal) ?? state.activeGoal;
    if (customType === "zob-job-intake") state.goalRequired = true;
  }
  state.runtimeGoal = restoreRuntimeGoalFromBranch(branch);
  state.goalActivationMode = restoreGoalActivationModeFromBranch(branch) ?? state.goalActivationMode;
  state.goalTodos = restoreGoalTodosFromBranch(branch);
  state.autonomy = restoreInteractiveAutonomyState(ctx.cwd, branch, state.autonomy);
  state.zcompact = restoreZcompactStateFromBranch(branch, state.zcompact);
  restoreDaemonMetadataFromEntries(state, branch);
  restoreZcommitMetadataFromEntries(state, ctx.cwd, branch);
  state.daemon.lastStatus = undefined;
  state.daemon.lastPlan = undefined;
  restoreDelegationRunsFromEntries(state, branch);
}

export function inferModeFromUserIntent(text: string): ModeName | undefined {
  return classifyModeRegex(text);
}


export function bashLooksLikeFileMutation(command: string): boolean {
  return /(^|[^2])>\s*[^&]|>>|\btee\b|\bsed\s+-i\b|\bperl\s+-pi\b|writeFileSync|writeFile\(|write_text\(|open\([^)]*["']w|\bpython3?\b[\s\S]*write|\bnode\b[\s\S]*writeFile/i.test(command);
}
