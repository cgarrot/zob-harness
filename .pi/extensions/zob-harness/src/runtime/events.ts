import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact, generateBranchSummary, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { EXTERNAL_PACKAGE_TOOLS_CONTRACT, MODE_PROMPTS, ZOB_COMPACTION_CONTINUITY_CONTRACT, ZOB_TOOL_ROUTING_CONTRACT } from "../core/constants.js";
import { buildCurrentZobLivePeerCard } from "../domains/coms/coms-v2/identity.js";
import { buildActiveSearchBackendPromptSnippet } from "../domains/context/context-discovery.js";
import { buildZobLiveAckEnvelope, buildZobLiveErrorEnvelope, buildZobLivePongEnvelope, type ZobLiveEnvelope, type ZpeerInterruptMode, type ZpeerInterruptPriority, type ZpeerInterruptStatus } from "../domains/coms/coms-v2/envelope.js";
import { appendLiveCompletedRef } from "../domains/coms/coms-v2/ledger-bridge.js";
import { bindZobLocalEndpoint, makeZobLocalEndpoint, sendZobLocalEnvelope } from "../domains/coms/coms-v2/local-transport.js";
import { readZobComsV2Policy } from "../domains/coms/coms-v2/policy.js";
import { claimZobLiveTeamAgentLease, pruneExpiredZobLivePeers, registerCurrentZobLivePeer, releaseZobLiveTeamAgentLease, touchCurrentZobLivePeer, unregisterCurrentZobLivePeer, writeZobLivePeerCard } from "../domains/coms/coms-v2/registry.js";
import { clearZpeerNewCarryoverProfile, readZpeerLocalProfile, readZpeerNewCarryoverProfile, writeZpeerLocalProfileFromPeer, writeZpeerNewCarryoverProfile, zpeerProfileIdIsSharedFallback } from "../domains/coms/coms-v2/zpeer-profile.js";
import { buildZpeerPeerRoomSummaries, ensureZpeerFields, refreshZpeerSelf } from "../domains/coms/coms-v2/zpeer.js";
import type { ZpeerRoomMembership } from "../domains/coms/coms-v2/types.js";
import { buildZobLiveResponseEnvelope } from "../domains/coms/coms-v2/response-capture.js";
import { writeZobComsRedactedCapture } from "../domains/coms/coms-v2/transcript-capture.js";
import { formatGoalActivationMode, runtimeGoalStatusLine } from "./goal-runtime.js";
import { formatInteractiveAutonomyPromptHint, formatMissionReadinessForUi, scoreMissionReadiness, toMissionReadinessLedgerEntry } from "../domains/autonomy/interactive-autonomy.js";
import { classifyIntent } from "../domains/intent/intent-classifier.js";
import { formatGoalTodoPromptHint } from "../domains/goal/goal-todos.js";
import { resolveRuleProfile } from "../domains/governance/rules.js";
import { loadDamageRules } from "../domains/governance/safety.js";
import { loadTeamDefinition, validateTeamDefinition } from "../domains/topology/teams.js";
import { loadZagentManifest, loadZteamManifest, loadZteamModePack, readZagentPrompt, resolveZagentRuntimeRoomBindings, resolveZteamScopedMode } from "../domains/coms/zagents.js";
import type { AssistantLikeMessage } from "../types.js";
import { blockedFeedback } from "../core/utils/formatting.js";
import { sha256 } from "../core/utils/hashing.js";
import { buildZcommitPlan, recordZcommitTouchedFile, runGovernedZcommitCommit, runGovernedZcommitPush, type ZcommitCommandResult, type ZcommitOwnedPathRef, type ZcommitPlan } from "../domains/git/git-ops.js";
import { pathMatches } from "../core/utils/paths.js";
import { isRecord, textFromMessage } from "../core/utils/records.js";
import { showDelegationOverlay } from "./delegation-overlay.js";
import { buildDeterministicZobCompactionResult, buildDeterministicZobCompactionSummary, buildZobCompactionInstructions, buildZobCompactionLedgerEntry, withZobCompactionDetails, ZOB_COMPACTION_ENTRY_TYPE, zobCompactionBodyFreeViolations } from "./compaction-policy.js";
import { buildZcompactPreparation, cancelZcompactPending, maybeTriggerZcompact, runZcompactCompactionHook } from "./auto-compaction.js";
import { disposeDelegationMouseSupport } from "./delegation-mouse.js";
import type { HarnessRuntimeState, ZobInboundZpeerMessage, ZobLiveLastEvent } from "./state.js";
import { bashLooksLikeFileMutation, inferModeFromUserIntent, restoreHarnessState } from "./state.js";
import { extractModeIntent, stripModeIntentMarkup, validateModeIntent, type ZobModeIntent } from "./mode-intent.js";
import { capturePlanArtifact } from "./plan-capture.js";
import { redactPlanTodosBlockForDisplay } from "../domains/plan/plan-todos.js";
import { applyMode, renderHarnessWidget } from "./widget.js";
import { createStopRestoreCandidate, markStopRestoreAssistantMessage, markStopRestoreToolVisible } from "./stop-restore.js";

function safelyUpdateZobLivePeer(repoRoot: string, action: "register" | "touch" | "unregister"): void {
  try {
    if (action === "register") registerCurrentZobLivePeer(repoRoot);
    else if (action === "touch") touchCurrentZobLivePeer(repoRoot);
    else unregisterCurrentZobLivePeer(repoRoot);
  } catch {
    // Live presence is observe-only in this phase and must not break the harness runtime.
  }
}

function setZpeerLastEvent(state: HarnessRuntimeState, event: Omit<ZobLiveLastEvent, "at" | "localOnly" | "networkEnabled" | "bodyStored"> & { at?: string }): void {
  state.zobLive.lastEvent = {
    ...event,
    at: event.at ?? new Date().toISOString(),
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
  };
}

function clearPassivePeerWaitForResponse(state: HarnessRuntimeState, envelope: { msgId?: string; runId?: string; sender?: string; type?: string }): void {
  const wait = state.zobLive.passivePeerWait;
  if (!wait || envelope.type !== "response") return;
  if (wait.msgId && envelope.msgId === wait.msgId) {
    state.zobLive.passivePeerWait = undefined;
    return;
  }
  const responseRoomId = envelope.runId?.startsWith("zpeer:") ? envelope.runId.slice("zpeer:".length) : undefined;
  if (!wait.msgId && wait.targetAlias && envelope.sender === wait.targetAlias && (!wait.roomId || !responseRoomId || wait.roomId === responseRoomId)) {
    state.zobLive.passivePeerWait = undefined;
  }
}

function zpeerEnvelopePriority(envelope: ZobLiveEnvelope): ZpeerInterruptPriority {
  return envelope.priority === "urgent" || envelope.priority === "force" ? envelope.priority : "normal";
}

function zpeerEnvelopeInterruptMode(envelope: ZobLiveEnvelope, priority = zpeerEnvelopePriority(envelope)): ZpeerInterruptMode {
  if (envelope.interruptMode === "abort" || envelope.interruptMode === "steer" || envelope.interruptMode === "none") return envelope.interruptMode;
  return priority === "force" ? "abort" : priority === "urgent" ? "steer" : "none";
}

function ensureZpeerInboundState(state: HarnessRuntimeState): void {
  state.zobLive.inboundByMsgId ??= {};
  state.zobLive.inboundQueue ??= [];
}

function recordZpeerInbound(state: HarnessRuntimeState, envelope: ZobLiveEnvelope, repoRoot: string): ZobInboundZpeerMessage {
  ensureZpeerInboundState(state);
  const priority = zpeerEnvelopePriority(envelope);
  const interruptMode = zpeerEnvelopeInterruptMode(envelope, priority);
  const inbound: ZobInboundZpeerMessage = { envelope, receivedAt: new Date().toISOString(), responseSent: false, priority, interruptMode, repoRoot };
  state.zobLive.inboundByMsgId![envelope.msgId] = inbound;
  if (!state.zobLive.inboundQueue!.includes(envelope.msgId)) state.zobLive.inboundQueue!.push(envelope.msgId);
  state.zobLive.inbound = { envelope, receivedAt: inbound.receivedAt, responseSent: false, repoRoot };
  return inbound;
}

function markZpeerInboundTurnStart(state: HarnessRuntimeState, prompt: string): void {
  const byMsgId = state.zobLive.inboundByMsgId;
  const queue = state.zobLive.inboundQueue ?? [];
  if (!byMsgId || queue.length === 0 || !prompt.trim()) return;
  const taskHash = sha256(prompt);
  const msgId = queue.find((candidate) => {
    const inbound = byMsgId[candidate];
    return inbound && !inbound.responseSent && !inbound.turnStartedAt && inbound.envelope.taskHash === taskHash;
  });
  if (!msgId) return;
  const inbound = byMsgId[msgId];
  const now = new Date().toISOString();
  inbound.turnStartedAt = now;
  inbound.injectedAt ??= now;
  state.zobLive.activeInboundMsgId = msgId;
}

function activeZpeerInboundForResponse(state: HarnessRuntimeState): ZobInboundZpeerMessage | undefined {
  const activeMsgId = state.zobLive.activeInboundMsgId;
  if (activeMsgId && state.zobLive.inboundByMsgId?.[activeMsgId]) return state.zobLive.inboundByMsgId[activeMsgId];
  return undefined;
}

function finishZpeerInboundResponse(state: HarnessRuntimeState, msgId: string, responseSent: boolean): void {
  const inbound = state.zobLive.inboundByMsgId?.[msgId];
  if (inbound) inbound.responseSent = responseSent;
  if (state.zobLive.inbound?.envelope.msgId === msgId) state.zobLive.inbound = { ...state.zobLive.inbound, responseSent };
  state.zobLive.activeInboundMsgId = undefined;
  state.zobLive.inboundQueue = (state.zobLive.inboundQueue ?? []).filter((candidate) => candidate !== msgId);
}

function forceAbortAllowedForCurrentState(ctx: ExtensionContext): boolean {
  return typeof ctx.abort === "function" && !ctx.isIdle();
}

function handleInboundZpeerPrompt(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext, repoRoot: string, envelope: ZobLiveEnvelope): ZpeerInterruptStatus | undefined {
  const priority = zpeerEnvelopePriority(envelope);
  const interruptMode = zpeerEnvelopeInterruptMode(envelope, priority);
  let interruptStatus: ZpeerInterruptStatus | undefined = priority === "urgent" ? "urgent_delivered" : undefined;
  if (priority === "force") {
    if (!envelope.interruptReasonHash) {
      interruptStatus = "force_blocked";
    } else if (ctx.isIdle()) {
      interruptStatus = "force_accepted";
    } else if (forceAbortAllowedForCurrentState(ctx)) {
      try {
        ctx.abort();
        interruptStatus = "force_accepted";
      } catch {
        interruptStatus = "force_downgraded";
      }
    } else {
      interruptStatus = "force_downgraded";
    }
  }
  const roomId = envelope.runId?.startsWith("zpeer:") ? envelope.runId.slice("zpeer:".length) : undefined;
  setZpeerLastEvent(state, {
    kind: interruptStatus === "force_blocked" ? "force_blocked" : interruptStatus === "force_accepted" ? "force_accepted" : interruptStatus === "urgent_delivered" ? "urgent_delivered" : "inbound",
    roomId,
    fromAlias: envelope.sender,
    toAlias: envelope.receiver,
    status: interruptStatus ?? "prompt_received",
    msgId: envelope.msgId,
    taskHash: envelope.taskHash,
    priority,
    interruptMode,
    interruptStatus,
  });
  pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-inbound-interrupt.v1", status: interruptStatus ?? "prompt_received", priority, interruptMode, interruptStatus, msgId: envelope.msgId, roomIdHash: roomId ? sha256(roomId) : undefined, senderAliasHash: envelope.sender ? sha256(envelope.sender) : undefined, receiverAliasHash: envelope.receiver ? sha256(envelope.receiver) : undefined, taskHash: envelope.taskHash, interruptReasonHash: envelope.interruptReasonHash, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
  if (interruptStatus === "force_blocked") return interruptStatus;
  const inbound = recordZpeerInbound(state, envelope, repoRoot);
  const deliverAs = priority === "normal" ? "followUp" : "steer";
  void pi.sendMessage({
    customType: "zob-zpeer-event",
    content: priority === "normal" ? "ZPeer inbound prompt received (transient body delivered only to agent turn)" : `ZPeer ${priority} inbound prompt received (transient body delivered only to agent turn)`,
    display: true,
    details: { kind: "inbound", roomId, fromAlias: envelope.sender, toAlias: envelope.receiver, status: interruptStatus ?? "prompt_received", msgId: envelope.msgId, taskHash: envelope.taskHash, priority, interruptMode, interruptStatus, bodyStored: false, localOnly: true, networkEnabled: false },
  }, { triggerTurn: false });
  void pi.sendMessage({
    customType: "zob-coms-inbound",
    content: envelope.transientPrompt ?? "",
    display: false,
    details: { kind: "zob-coms-inbound", msgId: envelope.msgId, runId: envelope.runId, sender: envelope.sender, receiver: envelope.receiver, taskHash: envelope.taskHash, priority: inbound.priority, interruptMode: inbound.interruptMode, interruptStatus, bodyStored: false, localOnly: true, networkEnabled: false },
  }, { triggerTurn: true, deliverAs });
  return interruptStatus;
}

const ZPEER_HEARTBEAT_MIN_INTERVAL_MS = 5_000;

type ActiveZagentState = HarnessRuntimeState["zagent"] & {
  communicationPolicy?: Record<string, unknown>;
  scopedMode?: {
    active: boolean;
    label?: string;
    teamId?: string;
    modeId?: string;
    baseMode?: HarnessRuntimeState["activeMode"];
    source: string;
    promptRef?: string;
    prompt?: string;
    toolPolicy?: {
      allowedTools?: string[];
      allowedToolsExplicit?: boolean;
    };
    errors: string[];
    blockers: string[];
  };
};

function loadActiveZagentById(state: HarnessRuntimeState, repoRoot: string, zagentId: string): void {
  const loaded = loadZagentManifest(repoRoot, zagentId);
  const manifest = loaded.manifest;
  const prompt = readZagentPrompt(repoRoot, manifest.promptRef);
  const resolved = resolveZagentRuntimeRoomBindings(repoRoot, manifest);
  const rooms = resolved.rooms;
  const activeRoom = manifest.activeRoom ?? rooms.find((room) => room.active)?.id ?? manifest.defaultRoom;
  const errors = [...loaded.errors, ...prompt.errors];
  const nextZagent: ActiveZagentState = {
    id: manifest.id,
    team: manifest.team ?? resolved.teamIds[0],
    teams: resolved.teamIds,
    role: manifest.role,
    alias: manifest.alias,
    description: manifest.description,
    rooms,
    activeRoom,
    defaultMode: manifest.defaultMode,
    prompt: prompt.body,
    promptRef: manifest.promptRef,
    path: loaded.path,
    errors,
    loadedAt: new Date().toISOString(),
    communicationPolicy: manifest.communicationPolicy as Record<string, unknown> | undefined,
  };
  state.zagent = nextZagent;
}

function loadActiveZagentFromEnv(state: HarnessRuntimeState, repoRoot: string): void {
  const zagentId = process.env.ZOB_ZAGENT_ID?.trim();
  if (!zagentId) return;
  loadActiveZagentById(state, repoRoot, zagentId);
}

function activeZagentState(state: HarnessRuntimeState): ActiveZagentState | undefined {
  return state.zagent.id ? state.zagent as ActiveZagentState : undefined;
}

function zpeerStableTeamAgentLeaseRequired(zagent: ActiveZagentState | undefined): boolean {
  return Boolean(
    zagent?.id
    || process.env.ZOB_ZAGENT_ID?.trim()
    || process.env.ZOB_ZTEAM_ID?.trim()
    || process.env.ZOB_COMS_ROLE_ID?.trim(),
  );
}

function withZpeerLeaseMode<T extends NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]>>(peer: T, useStableTeamAgentLease: boolean): T {
  return { ...peer, zpeerAdhoc: useStableTeamAgentLease ? undefined : true } as T;
}

function formatScopedZteamModeLabel(scopedMode: ActiveZagentState["scopedMode"]): string | undefined {
  if (!scopedMode?.active || !scopedMode.teamId || !scopedMode.modeId || !scopedMode.baseMode) return undefined;
  return `zob:${scopedMode.baseMode}@${scopedMode.teamId}/${scopedMode.modeId}`;
}

function zagentLockedMode(state: HarnessRuntimeState): { mode: HarnessRuntimeState["activeMode"]; reason: string } | undefined {
  const zagent = activeZagentState(state);
  if (!zagent?.id) return undefined;
  const scopedMode = zagent.scopedMode;
  if (scopedMode?.active && scopedMode.baseMode && (scopedMode.blockers?.length ?? 0) === 0) {
    return { mode: scopedMode.baseMode, reason: `zagent scoped mode ${scopedMode.label ?? scopedMode.modeId ?? scopedMode.baseMode}` };
  }
  if (zagent.defaultMode) return { mode: zagent.defaultMode, reason: `zagent defaultMode ${zagent.defaultMode}` };
  return undefined;
}

export function loadActiveZagentScopedMode(state: HarnessRuntimeState, repoRoot: string): void {
  const zagent = activeZagentState(state);
  if (!zagent?.id) return;
  const loadedZagent = loadZagentManifest(repoRoot, zagent.id);
  const teamId = zagent.team ?? loadedZagent.manifest.team ?? zagent.teams?.[0];
  const loadedTeam = teamId ? loadZteamManifest(repoRoot, teamId) : undefined;
  const modePack = loadedTeam && loadedTeam.errors.length === 0 ? loadZteamModePack(repoRoot, loadedTeam.manifest) : { errors: [] };
  const envModeId = process.env.ZOB_ZTEAM_MODE_ID?.trim() || process.env.ZOB_ZTEAM_MODE?.trim() || undefined;
  const resolution = resolveZteamScopedMode({
    repoRoot,
    zagent: loadedZagent.manifest,
    team: loadedTeam && loadedTeam.errors.length === 0 ? loadedTeam.manifest : undefined,
    modePack: modePack.modePack,
    envModeId,
  });
  const loadErrors = [
    ...loadedZagent.errors,
    ...(loadedTeam?.errors.map((error) => `zteam.${teamId}: ${error}`) ?? []),
    ...modePack.errors.map((error) => `modePack: ${error}`),
  ];
  const blockers = [...modePack.errors, ...resolution.blockers];
  const prompt = blockers.length === 0 && resolution.promptRef ? readZagentPrompt(repoRoot, resolution.promptRef) : undefined;
  const promptErrors = prompt?.errors.map((error) => `scopedMode.promptRef: ${error}`) ?? [];
  const allErrors = [...loadErrors, ...resolution.errors, ...promptErrors];
  zagent.scopedMode = {
    active: blockers.length === 0 && Boolean(resolution.teamId && resolution.modeId && resolution.baseMode),
    teamId: resolution.teamId,
    modeId: resolution.modeId,
    baseMode: resolution.baseMode,
    source: resolution.source,
    promptRef: resolution.promptRef,
    prompt: blockers.length === 0 ? prompt?.body : undefined,
    toolPolicy: resolution.toolPolicy,
    errors: allErrors,
    blockers: [...blockers, ...promptErrors],
  };
  zagent.scopedMode.label = formatScopedZteamModeLabel(zagent.scopedMode);
  zagent.errors = [...new Set([...zagent.errors, ...allErrors])];
}

function zagentRoomIds(zagent: ActiveZagentState): string[] {
  return zagent.rooms.map((room) => room.id).filter((roomId, index, values) => roomId && values.indexOf(roomId) === index);
}

function zagentRoomMemberships(zagent: ActiveZagentState): ZpeerRoomMembership[] | undefined {
  const alias = zagent.alias ?? zagent.id;
  if (!alias) return undefined;
  const joinedAt = zagent.loadedAt ?? new Date().toISOString();
  const memberships = zagent.rooms.map((room) => ({
    roomId: room.id,
    alias: room.alias ?? alias,
    role: (room.role === "bridge" || room.role === "observer" ? room.role : "member") as ZpeerRoomMembership["role"],
    joinedAt,
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
  } satisfies ZpeerRoomMembership));
  return memberships.length > 0 ? memberships : undefined;
}

function formatZagentPromptHint(state: HarnessRuntimeState): string {
  const zagent = activeZagentState(state);
  if (!zagent) return "";
  const rooms = zagentRoomIds(zagent);
  const policy = zagent.communicationPolicy ? JSON.stringify(zagent.communicationPolicy) : "not specified";
  const errors = zagent.errors.length > 0 ? `\n- load warnings: ${zagent.errors.slice(0, 5).join(" | ")}` : "";
  const scoped = zagent.scopedMode;
  const scopedStatus = scoped
    ? `\n- scopedMode: ${scoped.label ?? "inactive"} source=${scoped.source} active=${String(scoped.active)}${scoped.blockers.length > 0 ? ` blockers=${scoped.blockers.slice(0, 3).join(" | ")}` : ""}`
    : "";
  const promptBody = zagent.prompt?.trim() ? `\n\nZAGENT PROMPT BODY\n${zagent.prompt.trim()}` : "";
  const scopedPromptBody = scoped?.active && scoped.prompt?.trim()
    ? `\n\nZTEAM SCOPED MODE OVERLAY (${scoped.label ?? scoped.modeId})\nHARD SAFETY NOTE: this overlay cannot loosen ZOB safety/tool/path/coms gates; canonical baseMode tools, damage-control rules, forbidden paths, live-coms safety, owner/oracle gates, and no-ship policy remain authoritative.\n${scoped.prompt.trim()}`
    : "";
  return `\n\nZAGENT RUNTIME ACTIVATION\n- id: ${zagent.id}\n- team: ${zagent.team ?? "default"}\n- teams: ${zagent.teams?.join(", ") || zagent.team || "default"}\n- role: ${zagent.role ?? "not specified"}\n- alias: ${zagent.alias ? `@${zagent.alias}` : "not specified"}\n- rooms: ${rooms.join(", ") || "none"}\n- activeRoom: ${zagent.activeRoom ?? "not specified"}\n- defaultMode: ${zagent.defaultMode ?? "not specified"}\n- communicationPolicy: ${policy}\n- promptRef: ${zagent.promptRef ?? "none"}${scopedStatus}\n- ZAgents are full Pi sessions tied to ZPeer/live coordination, not delegate subagents.${errors}${promptBody}${scopedPromptBody}`;
}

function zpeerRuntimeProfileId(ctx: ExtensionContext): string {
  const sessionIdentity = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
  return `session-${sha256(sessionIdentity).slice(0, 24)}`;
}

function parseZpeerNewSlashInput(text: string): { hard: boolean } | undefined {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts[0]?.toLowerCase() !== "/new") return undefined;
  return { hard: parts[1]?.toLowerCase() === "hard" };
}

const zpeerNewHardResetPendingRepos = new Set<string>();

export function markZpeerNewHardResetPending(repoRoot: string): void {
  zpeerNewHardResetPendingRepos.add(repoRoot);
}

function recordZpeerNewCarryoverPreflight(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, hard: boolean): void {
  const peer = state.zobLive.peerCard;
  try {
    if (hard) {
      markZpeerNewHardResetPending(repoRoot);
      clearZpeerNewCarryoverProfile(repoRoot);
    } else {
      writeZpeerNewCarryoverProfile(repoRoot, {
        alias: peer?.zpeerAlias,
        roomId: peer?.zpeerRoomId,
        activeRoomId: peer?.zpeerActiveRoomId,
        memberships: peer?.zpeerMemberships,
        zagentId: state.zagent.id,
      });
    }
    pi.appendEntry("zob-znew", {
      schema: "zob.znew-command.v1",
      source: "input_pre_dispatch",
      action: hard ? "new_hard" : "new_soft",
      status: "ok",
      carryoverWritten: !hard,
      carryoverCleared: hard,
      aliasHash: !hard && peer?.zpeerAlias ? sha256(peer.zpeerAlias) : undefined,
      roomIdHash: !hard && peer?.zpeerRoomId ? sha256(peer.zpeerRoomId) : undefined,
      activeRoomIdHash: !hard && peer?.zpeerActiveRoomId ? sha256(peer.zpeerActiveRoomId) : undefined,
      membershipCount: !hard ? peer?.zpeerMemberships?.length ?? 0 : 0,
      zagentIdHash: !hard && state.zagent.id ? sha256(state.zagent.id) : undefined,
      localOnly: true,
      networkEnabled: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    pi.appendEntry("zob-znew", {
      schema: "zob.znew-command.v1",
      source: "input_pre_dispatch",
      action: hard ? "new_hard" : "new_soft",
      status: "blocked_or_failed",
      carryoverWritten: false,
      carryoverCleared: false,
      errorHashes: [sha256(errorText)],
      localOnly: true,
      networkEnabled: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
  }
}

function recordZpeerNewCarryoverOnShutdown(pi: ExtensionAPI, state: HarnessRuntimeState, repoRoot: string, reason: unknown): void {
  if (reason !== "new") return;
  if (zpeerNewHardResetPendingRepos.delete(repoRoot)) {
    pi.appendEntry("zob-znew", {
      schema: "zob.znew-command.v1",
      source: "session_shutdown",
      action: "new_hard",
      status: "ok",
      carryoverWritten: false,
      carryoverCleared: true,
      shutdownReason: "new",
      localOnly: true,
      networkEnabled: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
    return;
  }
  const peer = state.zobLive.peerCard;
  try {
    writeZpeerNewCarryoverProfile(repoRoot, {
      alias: peer?.zpeerAlias,
      roomId: peer?.zpeerRoomId,
      activeRoomId: peer?.zpeerActiveRoomId,
      memberships: peer?.zpeerMemberships,
      zagentId: state.zagent.id,
    });
    pi.appendEntry("zob-znew", {
      schema: "zob.znew-command.v1",
      source: "session_shutdown",
      action: "new_soft",
      status: "ok",
      carryoverWritten: true,
      carryoverCleared: false,
      shutdownReason: "new",
      aliasHash: peer?.zpeerAlias ? sha256(peer.zpeerAlias) : undefined,
      roomIdHash: peer?.zpeerRoomId ? sha256(peer.zpeerRoomId) : undefined,
      activeRoomIdHash: peer?.zpeerActiveRoomId ? sha256(peer.zpeerActiveRoomId) : undefined,
      membershipCount: peer?.zpeerMemberships?.length ?? 0,
      zagentIdHash: state.zagent.id ? sha256(state.zagent.id) : undefined,
      localOnly: true,
      networkEnabled: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    pi.appendEntry("zob-znew", {
      schema: "zob.znew-command.v1",
      source: "session_shutdown",
      action: "new_soft",
      status: "blocked_or_failed",
      carryoverWritten: false,
      carryoverCleared: false,
      shutdownReason: "new",
      errorHashes: [sha256(errorText)],
      localOnly: true,
      networkEnabled: false,
      bodyStored: false,
      generatedAt: new Date().toISOString(),
    });
  }
}

function clearZpeerHeartbeatTimer(state: HarnessRuntimeState): void {
  if (state.zobLive.heartbeatTimer) clearTimeout(state.zobLive.heartbeatTimer);
  state.zobLive.heartbeatTimer = undefined;
}

async function verifyZpeerSelfSocket(endpoint: string): Promise<{ ok: true; atMs: number } | { ok: false; reason: string }> {
  // WS-ZH1: post-bind readiness gate. Prove the local socket actually answers a ping
  // (1s budget, same as peerRespondsToAliasPing) before treating the peer as online.
  // A bound-but-starved handler existsSync-passes yet never replies; this gate keeps
  // such a peer offline until its event loop recovers. Metadata-only: no bodies.
  try {
    const response = await sendZobLocalEnvelope(endpoint, {
      schema: "zob.live-envelope.v1",
      type: "ping",
      msgId: `zpeer-self-ping:${Date.now()}`,
      hops: 0,
      timestamp: new Date().toISOString(),
      bodyStored: false,
    }, { timeoutMs: 1_000 });
    if (response.type === "pong" || response.type === "ack") return { ok: true, atMs: Date.now() };
    return { ok: false, reason: `socket_bind_not_verified: unexpected response type ${response.type}` };
  } catch (error) {
    return { ok: false, reason: `socket_bind_not_verified: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function scheduleZpeerHeartbeat(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext): void {
  const repoRoot = ctx.cwd;
  if (!state.zobLive.server || !state.zobLive.peerCard) return;
  clearZpeerHeartbeatTimer(state);
  const peer = state.zobLive.peerCard;
  const intervalMs = Math.max(ZPEER_HEARTBEAT_MIN_INTERVAL_MS, Math.min(peer.staleAfterMs / 2, 60_000));
  const timer = setTimeout(() => {
    // WS-ZH1: the heartbeat is ping-aware so the readiness gate stays sticky and the
    // peer self-recovers. On each tick we re-verify our own socket before going online;
    // a starved handler keeps the peer offline until it answers, then revives it.
    void (async () => {
      try {
        if (!state.zobLive.server || !state.zobLive.peerCard) return;
        const endpoint = state.zobLive.peerCard.endpoint;
        const verified = endpoint ? await verifyZpeerSelfSocket(endpoint) : { ok: false as const, reason: "socket_bind_not_verified: no local endpoint" };
        if (verified.ok) {
          state.zobLive.peerCard = refreshZpeerSelf(repoRoot, state.zobLive.peerCard, undefined, undefined, undefined, { socketVerifiedAtMs: verified.atMs });
        } else {
          state.zobLive.peerCard = writeZobLivePeerCard(repoRoot, { ...state.zobLive.peerCard, heartbeatAt: new Date().toISOString(), status: "offline" });
        }
        state.zobLive.lastHeartbeatMs = Date.now();
        renderHarnessWidget(pi, state, ctx);
      } catch {
        // Heartbeat/HUD refresh is best-effort and must not break the harness runtime.
      } finally {
        if (state.zobLive.server && state.zobLive.peerCard) scheduleZpeerHeartbeat(pi, state, ctx);
      }
    })();
  }, intervalMs);
  timer.unref?.();
  state.zobLive.heartbeatTimer = timer;
}

function formatZpeerLastEvent(event: ZobLiveLastEvent | undefined): string {
  if (!event) return "none";
  const route = event.fromAlias || event.toAlias ? `${event.fromAlias ? `@${event.fromAlias}` : "?"}→${event.toAlias ? `@${event.toAlias}` : "?"}` : "room";
  const hash = event.outputHash ? ` outputHash=${event.outputHash.slice(0, 12)}` : event.taskHash ? ` taskHash=${event.taskHash.slice(0, 12)}` : "";
  const reason = event.reason ? ` · ${event.reason}` : "";
  return `${event.kind} ${route} ${event.status}${hash}${reason}`;
}

function buildZpeerAwarenessPrompt(state: HarnessRuntimeState, repoRoot: string): string {
  if (!state.zobLive.peerCard) {
    return "\n\nZPEER AWARENESS\n- local peer endpoint: unavailable this turn\n- Use zpeer_ask with mode=\"async\" or /zpeer only when useful or user-requested for peer coordination; avoid spam/loops and do not invent hidden worker-to-worker chat.";
  }
  const summaries = buildZpeerPeerRoomSummaries(repoRoot, state.zobLive.peerCard);
  const activeSummary = summaries.find((summary) => summary.active) ?? summaries[0];
  const memberships = (state.zobLive.peerCard.zpeerMemberships?.length ?? summaries.length) || 1;
  const roomLines = summaries.slice(0, 6).map((summary) => {
    const selfAlias = summary.selfAlias ?? "?";
    const peerAliases = summary.onlineAliases.filter((alias) => alias !== selfAlias).slice(0, 6).map((alias) => `@${alias}`);
    const unavailable = summary.stale + summary.offline;
    const duplicateText = summary.duplicateAliases.length > 0 ? ` liveDuplicates=${summary.duplicateAliases.map((alias) => `@${alias}`).join(",")}` : "";
    return `  - ${summary.active ? "*" : " "} ${summary.roomId}: self=@${selfAlias}; online=${peerAliases.join(",") || "none"}; unavailable=${unavailable} (stale=${summary.stale}, offline=${summary.offline})${duplicateText}`;
  });
  if (summaries.length > 6) roomLines.push(`  - +${summaries.length - 6} more room${summaries.length - 6 === 1 ? "" : "s"}`);
  const activeSelfAlias = activeSummary?.selfAlias ?? "?";
  const activePeerAliases = (activeSummary?.onlineAliases ?? []).filter((alias) => alias !== activeSelfAlias).slice(0, 8).map((alias) => `@${alias}`);
  const activeUnavailable = (activeSummary?.stale ?? 0) + (activeSummary?.offline ?? 0);
  const activeDuplicateLine = activeSummary && activeSummary.duplicateAliases.length > 0 ? `\n- duplicate live aliases: ${activeSummary.duplicateAliases.map((alias) => `@${alias}`).join(", ")}` : "";
  return `\n\nZPEER AWARENESS (transient, rebuilt each turn)\n- active room: ${activeSummary?.roomId ?? "default"}\n- memberships: ${memberships}\n- self: @${activeSelfAlias}\n- online peers: ${activePeerAliases.join(", ") || "none"}\n- unavailable peers: ${activeUnavailable} (stale=${activeSummary?.stale ?? 0}, offline=${activeSummary?.offline ?? 0})${activeDuplicateLine}\n- rooms:\n${roomLines.join("\n") || "  - none"}\n- Use zpeer_ask with explicit roomId when targeting a non-active room.\n- posture: local_socket-only, room-scoped, hash-only durable ledgers, bodyStored=false, networkEnabled=false\n- For non-trivial review/debug/planning peer coordination, agents may use zpeer_ask with mode=\"async\" so the request is visible, governed, and non-blocking; /zpeer remains the interactive command path.\n- Passive wait rule: if the only remaining action is waiting for ZPeer/coms replies, stop the turn and remain idle; do not poll, call tools, or continue just to wait.\n- Use ZPeer only when useful or user-requested; avoid spam, duplicate asks, and reply loops; do not use it for hidden free chat or to bypass topology/safety gates.\n- Raw ZPeer bodies are transient; durable records must remain hash-only/bodyStored=false.\n- last ZPeer event: ${formatZpeerLastEvent(state.zobLive.lastEvent)}`;
}

const SAME_AGENT_MODE_INTENT_PROMPT = [
  "ZOB SAME-AGENT AUTO-MODE INTENT",
  "- If the current ZOB mode does not match the next required action, emit at most one standalone intent line:",
  "  <zob_mode_intent mode=\"explore|plan|implement|oracle|factory|orchestrator|vanilla\" confidence=\"low|medium|high\" risk=\"low|medium|high\" reason=\"short reason\"/>",
  "- This is only a suggestion; the harness validates and applies mode changes.",
  "- Do not claim the mode switched unless the harness reports it.",
  "- SINGLE-PLAN RULE: if you produce a complete plan in this response, do not also emit a plan-mode intent.",
  "- Emit mode=plan only when deferring the actual detailed plan to a follow-up turn; in that case keep this response to a short handoff.",
  "- Never both: full plan content and mode=plan intent in the same response.",
  "- Prefer orchestrator for multi-agent decomposition, Chief Vision coordination, Lead/Worker orchestration, TODO/workgraph routing, and parent-owned dispatch.",
  "- Prefer vanilla when the user explicitly asks for Pi base behavior, Vanilla/Vania, Codex, unrestricted/external commands, or arbitrary shell tools outside ZOB governance.",
  "- Prefer implement for code/file edits, oracle for validation/review/no-ship, factory for reusable repeatable workflows/factories.",
  "- Do not emit an intent for ordinary discussion or when the current mode already fits.",
].join("\n");

function latestAssistantText(event: unknown): string {
  const messages = isRecord(event) && Array.isArray(event.messages) ? event.messages : [];
  const assistantMessages = messages.filter((message): message is AssistantLikeMessage => isRecord(message) && message.role === "assistant");
  return textFromMessage(assistantMessages.at(-1));
}

function stripModeIntentFromMessage<T extends { content?: unknown }>(message: T): T {
  const content = message.content;
  if (typeof content === "string") return { ...message, content: stripModeIntentMarkup(content) };
  if (!Array.isArray(content)) return message;
  const mapped = content.map((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
    return { ...part, text: stripModeIntentMarkup(part.text) };
  }).filter((part) => !(isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length === 0));
  return { ...message, content: mapped.length > 0 ? mapped : "" } as T;
}


function transformAssistantTextMessage<T extends { content?: unknown }>(message: T, transform: (text: string) => string): { message: T; changed: boolean } {
  const content = message.content;
  if (typeof content === "string") {
    const next = transform(content);
    return { message: next === content ? message : { ...message, content: next } as T, changed: next !== content };
  }
  if (!Array.isArray(content)) return { message, changed: false };
  let changed = false;
  const mapped = content.map((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
    const nextText = transform(part.text);
    if (nextText !== part.text) changed = true;
    return { ...part, text: nextText };
  }).filter((part) => !(isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length === 0));
  return { message: changed ? { ...message, content: mapped.length > 0 ? mapped : "" } as T : message, changed };
}

function modeIntentContent(intent: ZobModeIntent, previousMode: string, accepted: boolean, validationReason: string): string {
  const status = accepted ? `${previousMode} → ${intent.mode}` : `${intent.mode} ignored`;
  return `${status} · ${intent.confidence}${intent.risk ? `/${intent.risk}` : ""} · ${intent.reason} · ${validationReason}`;
}

function handleSameAgentModeIntent(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext, intent: ZobModeIntent, assistantText = ""): void {
  const previousMode = state.activeMode;
  const lockedMode = zagentLockedMode(state);
  const validation = lockedMode
    ? { accepted: false, reason: `${lockedMode.reason} locks auto-mode` }
    : validateModeIntent(intent, state.activeMode, state.lastUserInputText ?? "", assistantText);
  state.lastModeIntent = { ...intent, at: Date.now(), accepted: validation.accepted, validationReason: validation.reason };
  if (validation.accepted) {
    applyMode(pi, state, ctx, intent.mode);
    state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
    ctx.ui.notify(`ZOB same-agent auto-mode: ${previousMode} → ${intent.mode} (${intent.confidence}; ${intent.reason})`, "info");
  } else {
    if (lockedMode && state.activeMode !== lockedMode.mode) {
      applyMode(pi, state, ctx, lockedMode.mode, false);
      state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
    } else {
      renderHarnessWidget(pi, state, ctx);
    }
  }
  pi.sendMessage({
    customType: "zob-mode-intent",
    content: modeIntentContent(intent, previousMode, validation.accepted, validation.reason),
    display: true,
    details: { intent, previousMode, accepted: validation.accepted, validationReason: validation.reason, at: new Date().toISOString() },
  }, { triggerTurn: false });
}

async function stopLeaseBlockedLocalEndpoint(state: HarnessRuntimeState, repoRoot: string, peer: NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]>, server: NonNullable<HarnessRuntimeState["zobLive"]["server"]>): Promise<NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]>> {
  clearZpeerHeartbeatTimer(state);
  const offline = writeZobLivePeerCard(repoRoot, { ...peer, heartbeatAt: new Date().toISOString(), status: "offline" });
  try { await server.close(); } catch { /* best-effort duplicate endpoint shutdown */ }
  state.zobLive.server = undefined;
  state.zobLive.leaseOwned = false;
  state.zobLive.leaseStatus = "blocked";
  state.zobLive.leaseBlockReason = "blocked_live_owner";
  return offline;
}

async function startOrRefreshZobLiveRuntime(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext): Promise<void> {
  const repoRoot = ctx.cwd;
  const profileId = zpeerRuntimeProfileId(ctx);
  try { pruneExpiredZobLivePeers(repoRoot); } catch { /* best-effort ghost peer cleanup; live runtime must remain available */ }
  const policy = readZobComsV2Policy(repoRoot);
  if (policy.mode === "off" || policy.mode === "required_network") {
    safelyUpdateZobLivePeer(repoRoot, state.zobLive.peerCard ? "touch" : "register");
    return;
  }
  const team = loadTeamDefinition(repoRoot, "zob-core");
  if (!team.definition && team.errors.some((error) => error.startsWith("Team topology not found:"))) {
    safelyUpdateZobLivePeer(repoRoot, state.zobLive.peerCard ? "touch" : "register");
    return;
  }
  const errors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  if (errors.length > 0 || !team.definition) throw new Error(errors.join("; "));
  const definition = team.definition;
  const zpeerProfile = readZpeerLocalProfile(repoRoot, profileId);
  const explicitZagentId = process.env.ZOB_ZAGENT_ID?.trim();
  const carryoverProfile = !explicitZagentId && !zpeerProfile ? readZpeerNewCarryoverProfile(repoRoot) : undefined;
  if (carryoverProfile?.zagentId && state.zagent.id !== carryoverProfile.zagentId) loadActiveZagentById(state, repoRoot, carryoverProfile.zagentId);
  const sharedZpeerProfile = zpeerProfile ? zpeerProfileIdIsSharedFallback(zpeerProfile.profileId) : false;
  const zagent = activeZagentState(state);
  const useStableTeamAgentLease = zpeerStableTeamAgentLeaseRequired(zagent);
  const zagentMemberships = zagent ? zagentRoomMemberships(zagent) : undefined;
  const zagentActiveRoomId = zagent?.activeRoom ?? zagentMemberships?.find((membership) => membership.roomId)?.roomId;
  const zpeerProfileRoomId = zagentActiveRoomId ?? zpeerProfile?.activeRoomId ?? zpeerProfile?.roomId ?? carryoverProfile?.activeRoomId ?? carryoverProfile?.roomId;
  const zpeerProfileAlias = zagent?.alias ?? (sharedZpeerProfile ? undefined : zpeerProfile?.alias) ?? carryoverProfile?.alias;
  const zpeerProfileMemberships = zagentMemberships ?? (sharedZpeerProfile ? undefined : zpeerProfile?.memberships) ?? carryoverProfile?.memberships;
  if (!state.zobLive.server || !state.zobLive.peerCard) {
    const basePeer = buildCurrentZobLivePeerCard(repoRoot, definition, policy);
    const endpoint = makeZobLocalEndpoint(basePeer.sessionId);
    const server = await bindZobLocalEndpoint(endpoint, async (envelope) => {
      if (envelope.type === "ping") return buildZobLivePongEnvelope(envelope);
      if (envelope.type === "response") {
        const completedActiveWait = state.zobLive.pendingReplies.complete(envelope.msgId, envelope);
        clearPassivePeerWaitForResponse(state, envelope);
        setZpeerLastEvent(state, {
          kind: "reply",
          roomId: envelope.runId?.startsWith("zpeer:") ? envelope.runId.slice("zpeer:".length) : undefined,
          fromAlias: envelope.sender,
          toAlias: envelope.receiver,
          status: "reply",
          msgId: envelope.msgId,
          taskHash: envelope.taskHash,
          outputHash: envelope.outputHash,
        });
        void pi.sendMessage({
          customType: "zob-zpeer-event",
          content: "ZPeer reply received (transient response available; durable records remain hash-only)",
          display: true,
          details: { kind: "reply", roomId: state.zobLive.lastEvent?.roomId, fromAlias: envelope.sender, toAlias: envelope.receiver, status: "reply", msgId: envelope.msgId, taskHash: envelope.taskHash, outputHash: envelope.outputHash, bodyStored: false, localOnly: true, networkEnabled: false },
        }, { triggerTurn: false });
        if (!completedActiveWait && envelope.transientResponse) {
          void pi.sendMessage({
            customType: "zob-zpeer-response",
            content: `ZPeer async reply received from @${envelope.sender ?? "?"} to @${envelope.receiver ?? "?"}. Continue the prior task using this response; do not poll or wait further only for this reply.\n\n${envelope.transientResponse}`,
            display: true,
            details: { msgId: envelope.msgId, fromAlias: envelope.sender, toAlias: envelope.receiver, outputHash: envelope.outputHash, bodyStored: false, localOnly: true, networkEnabled: false },
          }, { triggerTurn: true, deliverAs: "followUp" });
        }
        const parentMsgId = envelope.runId && envelope.receiver && envelope.sender ? `${envelope.runId}:${envelope.receiver}:${envelope.sender}:${envelope.msgId}` : undefined;
        if (parentMsgId) {
          try { appendLiveCompletedRef(repoRoot, definition, parentMsgId, envelope); } catch { /* best-effort ledger correlation; await response still completes */ }
        }
        return buildZobLiveAckEnvelope(envelope);
      }
      if (envelope.type !== "prompt") return buildZobLiveErrorEnvelope(envelope, `Unsupported inbound envelope type: ${envelope.type}`, "unsupported_envelope");
      const interruptStatus = handleInboundZpeerPrompt(pi, state, ctx, repoRoot, envelope);
      return buildZobLiveAckEnvelope(envelope, interruptStatus);
    });
    state.zobLive.server = server;
    // WS-ZH1: prove the freshly bound socket actually answers before claiming online.
    // Cold-start CPU contention can leave a bound-but-starved handler that
    // existsSync-passes yet never replies; without this gate the peer would flip
    // online then offline before the first heartbeat.
    const selfVerification = await verifyZpeerSelfSocket(endpoint);
    const initialStatus = selfVerification.ok ? ("online" as const) : ("offline" as const);
    const peerCard = withZpeerLeaseMode(ensureZpeerFields(repoRoot, {
      ...basePeer,
      team: zagent?.team ?? basePeer.team,
      roleId: zagent?.id ?? basePeer.roleId,
      agent: zagent?.id ?? basePeer.agent,
      transport: "local_socket" as const,
      endpoint,
      endpointHash: sha256(endpoint),
      status: initialStatus,
    }, zpeerProfileRoomId, zpeerProfileAlias, zpeerProfileMemberships), useStableTeamAgentLease);
    if (!selfVerification.ok) {
      // WS-ZH1: socket bound but unresponsive. Stay offline, keep the server bound,
      // and let the ping-aware heartbeat revive this peer once its handler answers.
      state.zobLive.peerCard = writeZobLivePeerCard(repoRoot, peerCard);
      state.zobLive.leaseOwned = false;
      state.zobLive.leaseStatus = useStableTeamAgentLease ? "blocked" : "unavailable";
      state.zobLive.leaseBlockReason = undefined;
      state.zobLive.lastHeartbeatMs = Date.now();
      setZpeerLastEvent(state, {
        kind: "blocked",
        roomId: peerCard.zpeerActiveRoomId ?? peerCard.zpeerRoomId,
        fromAlias: peerCard.zpeerAlias,
        status: "socket_bind_not_verified",
        reason: selfVerification.reason,
      });
      scheduleZpeerHeartbeat(pi, state, ctx);
    } else if (!useStableTeamAgentLease) {
      releaseZobLiveTeamAgentLease(repoRoot, peerCard, { reason: "runtime_adhoc" });
      state.zobLive.peerCard = refreshZpeerSelf(repoRoot, peerCard, undefined, undefined, undefined, { socketVerifiedAtMs: selfVerification.atMs });
      state.zobLive.leaseOwned = false;
      state.zobLive.leaseStatus = "unavailable";
      state.zobLive.leaseBlockReason = undefined;
      state.zobLive.lastHeartbeatMs = Date.now();
      scheduleZpeerHeartbeat(pi, state, ctx);
    } else {
      const leaseClaim = await claimZobLiveTeamAgentLease(repoRoot, peerCard, { reason: "runtime_start" });
      if (leaseClaim.ok) {
        state.zobLive.peerCard = refreshZpeerSelf(repoRoot, peerCard, undefined, undefined, undefined, { socketVerifiedAtMs: selfVerification.atMs });
        state.zobLive.leaseOwned = true;
        state.zobLive.leaseStatus = "owned";
        state.zobLive.leaseBlockReason = undefined;
        state.zobLive.lastHeartbeatMs = Date.now();
        scheduleZpeerHeartbeat(pi, state, ctx);
      } else {
        state.zobLive.peerCard = await stopLeaseBlockedLocalEndpoint(state, repoRoot, peerCard, server);
        setZpeerLastEvent(state, {
          kind: "blocked",
          roomId: state.zobLive.peerCard.zpeerActiveRoomId ?? state.zobLive.peerCard.zpeerRoomId,
          fromAlias: state.zobLive.peerCard.zpeerAlias,
          status: "lease_blocked",
          reason: "stable team-agent lease is held by a responsive live endpoint; duplicate local endpoint stopped and peer marked offline",
        });
      }
    }
    try { writeZpeerLocalProfileFromPeer(repoRoot, state.zobLive.peerCard, profileId); } catch { /* best-effort reload continuity; live runtime must remain available */ }
  } else {
    // WS-ZH1: re-verify the already-bound socket on each refresh so the readiness
    // gate stays sticky (a turn must not resurrect an unresponsive socket as online).
    const refreshVerification = await verifyZpeerSelfSocket(state.zobLive.peerCard.endpoint);
    const refreshStatus = refreshVerification.ok ? ("online" as const) : ("offline" as const);
    const peerCard = withZpeerLeaseMode(ensureZpeerFields(repoRoot, {
      ...state.zobLive.peerCard,
      team: zagent?.team ?? state.zobLive.peerCard.team,
      roleId: zagent?.id ?? state.zobLive.peerCard.roleId,
      agent: zagent?.id ?? state.zobLive.peerCard.agent,
      heartbeatAt: new Date().toISOString(),
      status: refreshStatus,
    }, zpeerProfileRoomId, zpeerProfileAlias, zpeerProfileMemberships), useStableTeamAgentLease);
    if (!refreshVerification.ok) {
      state.zobLive.peerCard = writeZobLivePeerCard(repoRoot, peerCard);
      state.zobLive.leaseOwned = false;
      state.zobLive.leaseStatus = useStableTeamAgentLease ? "blocked" : "unavailable";
      state.zobLive.leaseBlockReason = undefined;
      state.zobLive.lastHeartbeatMs = Date.now();
      setZpeerLastEvent(state, {
        kind: "blocked",
        roomId: peerCard.zpeerActiveRoomId ?? peerCard.zpeerRoomId,
        fromAlias: peerCard.zpeerAlias,
        status: "socket_bind_not_verified",
        reason: refreshVerification.reason,
      });
      scheduleZpeerHeartbeat(pi, state, ctx);
    } else if (!useStableTeamAgentLease) {
      releaseZobLiveTeamAgentLease(repoRoot, peerCard, { reason: "runtime_adhoc" });
      state.zobLive.peerCard = refreshZpeerSelf(repoRoot, peerCard, undefined, undefined, undefined, { socketVerifiedAtMs: refreshVerification.atMs });
      state.zobLive.leaseOwned = false;
      state.zobLive.leaseStatus = "unavailable";
      state.zobLive.leaseBlockReason = undefined;
      state.zobLive.lastHeartbeatMs = Date.now();
      scheduleZpeerHeartbeat(pi, state, ctx);
    } else {
      const leaseClaim = await claimZobLiveTeamAgentLease(repoRoot, peerCard, { reason: "runtime_refresh" });
      if (leaseClaim.ok) {
        state.zobLive.peerCard = refreshZpeerSelf(repoRoot, peerCard, undefined, undefined, undefined, { socketVerifiedAtMs: refreshVerification.atMs });
        state.zobLive.leaseOwned = true;
        state.zobLive.leaseStatus = "owned";
        state.zobLive.leaseBlockReason = undefined;
        state.zobLive.lastHeartbeatMs = Date.now();
        scheduleZpeerHeartbeat(pi, state, ctx);
      } else if (state.zobLive.server) {
        state.zobLive.peerCard = await stopLeaseBlockedLocalEndpoint(state, repoRoot, peerCard, state.zobLive.server);
        setZpeerLastEvent(state, {
          kind: "blocked",
          roomId: state.zobLive.peerCard.zpeerActiveRoomId ?? state.zobLive.peerCard.zpeerRoomId,
          fromAlias: state.zobLive.peerCard.zpeerAlias,
          status: "lease_blocked",
          reason: "stable team-agent lease is held by a responsive live endpoint; duplicate local endpoint stopped and peer marked offline",
        });
      } else {
        state.zobLive.peerCard = writeZobLivePeerCard(repoRoot, { ...peerCard, heartbeatAt: new Date().toISOString(), status: "offline" });
        state.zobLive.leaseOwned = false;
        state.zobLive.leaseStatus = "blocked";
        state.zobLive.leaseBlockReason = "blocked_live_owner";
      }
    }
    try { writeZpeerLocalProfileFromPeer(repoRoot, state.zobLive.peerCard, profileId); } catch { /* best-effort reload continuity; live runtime must remain available */ }
  }
}

async function stopZobLiveRuntime(state: HarnessRuntimeState, ctx: ExtensionContext): Promise<void> {
  const repoRoot = ctx.cwd;
  const profileId = zpeerRuntimeProfileId(ctx);
  try {
    clearZpeerHeartbeatTimer(state);
    if (state.zobLive.peerCard) {
      try { writeZpeerLocalProfileFromPeer(repoRoot, state.zobLive.peerCard, profileId); } catch { /* best-effort shutdown continuity */ }
      releaseZobLiveTeamAgentLease(repoRoot, state.zobLive.peerCard, { reason: "session_shutdown" });
      writeZobLivePeerCard(repoRoot, { ...state.zobLive.peerCard, heartbeatAt: new Date().toISOString(), status: "offline" });
    }
    if (state.zobLive.server) await state.zobLive.server.close();
  } finally {
    state.zobLive = { pendingReplies: state.zobLive.pendingReplies };
  }
}

function notifyWhenUi(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function zcommitOwnedPathLedgerRefs(state: HarnessRuntimeState): Array<Pick<ZcommitOwnedPathRef, "path" | "source" | "pathHash" | "lastOwnedAt">> {
  return Object.values(state.zcommit.ownedPathRefs ?? {}).map((ref) => ({ path: ref.path, source: ref.source, pathHash: ref.pathHash, lastOwnedAt: ref.lastOwnedAt })).sort((a, b) => a.path.localeCompare(b.path));
}

function zcommitContinuityLedgerEntry(action: string, state: HarnessRuntimeState): Record<string, unknown> {
  return {
    schema: "zob.zcommit-continuity.v1",
    bodyStored: false,
    action,
    autocommit: state.zcommit.autocommit,
    autopush: state.zcommit.autopush,
    ownedPathRefs: zcommitOwnedPathLedgerRefs(state),
    generatedAt: new Date().toISOString(),
  };
}

function zcommitAutomationLedgerEntry(action: string, state: HarnessRuntimeState, plan: ZcommitPlan, result?: ZcommitCommandResult): Record<string, unknown> {
  return {
    schema: "zob.zcommit-message-end.v1",
    bodyStored: false,
    action,
    status: result ? (result.ok ? "ok" : "blocked_or_failed") : undefined,
    autocommit: state.zcommit.autocommit,
    autopush: state.zcommit.autopush,
    policyLoaded: plan.policyLoaded,
    selectionMode: plan.selectionMode,
    validationMode: plan.validationMode,
    selectionPathspecHashes: plan.selectionPathspecs.map((pathspec) => sha256(pathspec)),
    dirtyCount: plan.dirtyFiles.length,
    touchedCount: plan.touchedFiles.length,
    eligibleCount: plan.eligible.length,
    excludedCount: plan.excluded.length,
    forbiddenCount: plan.forbidden.length,
    unexpectedStagedCount: plan.unexpectedStaged.length,
    eligiblePathHashes: plan.eligible.map((file) => sha256(file.path)),
    excludedPathHashes: plan.excluded.map((file) => sha256(file.path)),
    ownedPathRefs: zcommitOwnedPathLedgerRefs(state),
    noShip: plan.noShip,
    commitEnabled: plan.commitEnabled,
    pushEnabled: plan.pushEnabled,
    lastCommitHash: state.zcommit.lastCommit?.hash,
    lastCommitShortHash: state.zcommit.lastCommit?.shortHash,
    validationOk: result?.validation?.ok,
    validationCommand: result?.validation?.command,
    errorHashes: result?.errors.map((error) => sha256(error)),
    actualGitCommitRun: result?.actualGitCommitRun ?? false,
    actualGitPushRun: result?.actualGitPushRun ?? false,
    generatedAt: new Date().toISOString(),
  };
}

async function maybeRunZcommitMessageEndAutomation(pi: ExtensionAPI, state: HarnessRuntimeState, ctx: ExtensionContext): Promise<void> {
  if (state.zcommit.autocommit !== "on") return;
  try {
    const plan = buildZcommitPlan(ctx.cwd, state.zcommit);
    const commitResult = runGovernedZcommitCommit(ctx.cwd, state.zcommit);
    pi.appendEntry("zob-zcommit", zcommitAutomationLedgerEntry(commitResult.ok ? "autocommit_created" : "autocommit_blocked", state, commitResult.plan ?? plan, commitResult));
    notifyWhenUi(ctx, `zcommit autocommit: ${commitResult.message}`, commitResult.ok ? "info" : "warning");
    if (commitResult.ok && state.zcommit.autopush === "on") {
      const pushResult = runGovernedZcommitPush(ctx.cwd, state.zcommit, { explicitPush: false });
      pi.appendEntry("zob-zcommit", zcommitAutomationLedgerEntry(pushResult.ok ? "autopush_completed" : "autopush_blocked", state, pushResult.plan, pushResult));
      notifyWhenUi(ctx, `zcommit autopush: ${pushResult.message}`, pushResult.ok ? "info" : "warning");
    }
    renderHarnessWidget(pi, state, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const plan = buildZcommitPlan(ctx.cwd, state.zcommit);
    pi.appendEntry("zob-zcommit", {
      ...zcommitAutomationLedgerEntry("autocommit_error", state, plan),
      status: "blocked_or_failed",
      errorHashes: [sha256(message)],
    });
    notifyWhenUi(ctx, "zcommit autocommit hook failed; see body-free ledger hashes", "warning");
  }
}

async function compactionAuth(ctx: ExtensionContext): Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined> {
  const model = ctx.model;
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  return { apiKey: auth.apiKey, headers: auth.headers };
}

async function sendInboundZobLiveResponse(pi: ExtensionAPI, state: HarnessRuntimeState, event: unknown): Promise<void> {
  const activeInbound = activeZpeerInboundForResponse(state);
  const inbound = activeInbound ?? state.zobLive.inbound;
  if (!inbound || inbound.responseSent || !inbound.envelope.replyEndpoint) return;
  if (state.zobLive.inboundByMsgId && !activeInbound) return;
  const responseText = latestAssistantText(event);
  if (!responseText.trim()) return;
  const policy = readZobComsV2Policy(inbound.repoRoot);
  let responseCapture: ReturnType<typeof writeZobComsRedactedCapture>;
  try {
    responseCapture = writeZobComsRedactedCapture(inbound.repoRoot, policy.transcriptCapture, {
      runId: inbound.envelope.runId,
      msgId: inbound.envelope.msgId,
      sender: inbound.envelope.receiver,
      receiver: inbound.envelope.sender,
      team: inbound.envelope.team,
      kind: "live_exchange",
      taskHash: inbound.envelope.taskHash,
      outputHash: sha256(responseText),
      transientPrompt: inbound.envelope.transientPrompt,
      transientResponse: responseText,
      artifactRefs: inbound.envelope.artifactRefs,
    });
  } catch {
    responseCapture = undefined;
  }
  const artifactRefs = responseCapture ? [...(inbound.envelope.artifactRefs ?? []), responseCapture.artifactRef] : inbound.envelope.artifactRefs;
  const artifactHashes = responseCapture ? [...(inbound.envelope.artifactHashes ?? []), responseCapture.artifactHash] : inbound.envelope.artifactHashes;
  const responseEnvelope = buildZobLiveResponseEnvelope(inbound.envelope, responseText, artifactRefs, artifactHashes);
  await sendZobLocalEnvelope(inbound.envelope.replyEndpoint, responseEnvelope, { timeoutMs: 5_000 });
  finishZpeerInboundResponse(state, inbound.envelope.msgId, true);
  setZpeerLastEvent(state, {
    kind: "response_sent",
    roomId: inbound.envelope.runId?.startsWith("zpeer:") ? inbound.envelope.runId.slice("zpeer:".length) : undefined,
    fromAlias: inbound.envelope.receiver,
    toAlias: inbound.envelope.sender,
    status: "response_sent",
    msgId: inbound.envelope.msgId,
    taskHash: inbound.envelope.taskHash,
    outputHash: responseEnvelope.outputHash,
  });
  void pi.sendMessage({
    customType: "zob-zpeer-event",
    content: "ZPeer response sent (transient response delivered over local socket; durable records remain hash-only)",
    display: true,
    details: { kind: "response_sent", roomId: state.zobLive.lastEvent?.roomId, fromAlias: inbound.envelope.receiver, toAlias: inbound.envelope.sender, status: "response_sent", msgId: inbound.envelope.msgId, taskHash: inbound.envelope.taskHash, outputHash: responseEnvelope.outputHash, priority: activeInbound?.priority, interruptMode: activeInbound?.interruptMode, bodyStored: false, localOnly: true, networkEnabled: false },
  }, { triggerTurn: false });
}

export function registerHarnessEvents(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerMessageRenderer("zob-zpeer-event", (message, { expanded }, theme) => {
    const details = isRecord(message.details) ? message.details : {};
    const kind = typeof details.kind === "string" ? details.kind : "event";
    const roomId = typeof details.roomId === "string" ? details.roomId : "default";
    const fromAlias = typeof details.fromAlias === "string" ? details.fromAlias : undefined;
    const toAlias = typeof details.toAlias === "string" ? details.toAlias : undefined;
    const status = typeof details.status === "string" ? details.status : "unknown";
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    const taskHash = typeof details.taskHash === "string" ? details.taskHash : undefined;
    const outputHash = typeof details.outputHash === "string" ? details.outputHash : undefined;
    const route = fromAlias || toAlias ? `${fromAlias ? `@${fromAlias}` : "?"} → ${toAlias ? `@${toAlias}` : "?"}` : "room status";
    const statusColor = status === "completed" || status === "sent" || status === "prompt_received" || status === "response_sent" ? "success" : status === "blocked" || status === "timeout" || status === "error" ? "warning" : "muted";
    const line = [
      theme.fg("accent", "◆ ZPeer"),
      theme.fg("muted", kind),
      theme.fg("dim", `room ${roomId}`),
      theme.fg("muted", route),
      theme.fg(statusColor, status),
    ].join(theme.fg("dim", " · "));
    const hashes = [taskHash ? `taskHash=${taskHash.slice(0, 12)}` : undefined, outputHash ? `outputHash=${outputHash.slice(0, 12)}` : undefined].filter(Boolean).join(" · ");
    const expandedLine = expanded ? `\n${theme.fg("dim", [reason, hashes, "localOnly=true networkEnabled=false bodyStored=false"].filter(Boolean).join(" · "))}` : reason ? ` ${theme.fg("dim", `(${reason})`)}` : "";
    return new Text(`${line}${expandedLine}`, 0, 0);
  });

  pi.registerMessageRenderer("zob-plan-launch-result", (message, { expanded }, theme) => {
    const details = isRecord(message.details) ? message.details : {};
    const status = typeof details.status === "string" ? details.status : "preview";
    const planId = typeof details.planId === "string" ? details.planId : undefined;
    const planPath = typeof details.planPath === "string" ? details.planPath : undefined;
    const sidecarPath = typeof details.sidecarPath === "string" ? details.sidecarPath : undefined;
    const todoCount = typeof details.todoCount === "number" ? details.todoCount : undefined;
    const errors = Array.isArray(details.errors) ? details.errors.filter((item): item is string => typeof item === "string") : [];
    const content = typeof message.content === "string" ? message.content : "";
    const statusColor = status === "blocked" ? "warning" : status === "launched" ? "success" : "accent";
    const title = status === "blocked" ? "⚠ ZOB plan blocked" : status === "launched" ? "🚀 ZOB plan launched" : "✅ ZOB plan preview";
    const lines = [
      [theme.fg(statusColor, title), planId ? theme.fg("accent", planId) : undefined, todoCount !== undefined ? theme.fg("muted", `${todoCount} TODO${todoCount === 1 ? "" : "s"}`) : undefined].filter(Boolean).join(theme.fg("dim", " · ")),
    ];
    if (planPath) lines.push(`${theme.fg("dim", "plan:")} ${theme.fg("muted", planPath)}`);
    if (sidecarPath) lines.push(`${theme.fg("dim", "sidecar:")} ${theme.fg("muted", sidecarPath)}`);
    if (errors.length > 0) lines.push(theme.fg("warning", errors.join("\n")));
    if (expanded && content) lines.push(theme.fg("dim", content));
    else if (content) {
      const preview = content.split(/\r?\n/).slice(0, 8).join("\n");
      lines.push(theme.fg("dim", preview));
      if (content.split(/\r?\n/).length > 8) lines.push(theme.fg("dim", "… expand for full plan tree"));
    }
    return new Text(lines.join("\n"), 0, 0);
  });

  pi.registerMessageRenderer("zob-mode-intent", (message, { expanded }, theme) => {
    const details = isRecord(message.details) ? message.details : {};
    const intent = isRecord(details.intent) ? details.intent : {};
    const mode = typeof intent.mode === "string" ? intent.mode : "mode";
    const confidence = typeof intent.confidence === "string" ? intent.confidence : "?";
    const risk = typeof intent.risk === "string" ? intent.risk : "low";
    const previousMode = typeof details.previousMode === "string" ? details.previousMode : "current";
    const accepted = details.accepted === true;
    const validationReason = typeof details.validationReason === "string" ? details.validationReason : "validated";
    const reason = typeof intent.reason === "string" ? intent.reason : String(message.content ?? "");
    const icon = accepted ? "◆" : "◇";
    const color = accepted ? "success" : "dim";
    const status = accepted ? `${previousMode} → ${mode}` : `${mode} ignored`;
    const line = [
      theme.fg(color, `${icon} auto-mode`),
      theme.fg(accepted ? "accent" : "muted", status),
      theme.fg(confidence === "high" ? "success" : confidence === "medium" ? "warning" : "dim", confidence),
      theme.fg(risk === "high" ? "warning" : "dim", `risk ${risk}`),
      theme.fg("muted", reason),
    ].join(theme.fg("dim", " · "));
    const expandedLine = expanded ? `\n${theme.fg("dim", validationReason)}` : "";
    return new Text(`${line}${expandedLine}`, 0, 0);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      const delegatesMatch = event.text.trim().match(/^\/(?:delegates?|view[_-]?delegates)(?:\s+(\S+))?$/i);
      if (delegatesMatch) {
        await showDelegationOverlay(ctx, state, delegatesMatch[1]);
        return { action: "handled" as const };
      }
      const znewInput = parseZpeerNewSlashInput(event.text);
      if (znewInput) {
        recordZpeerNewCarryoverPreflight(pi, state, ctx.cwd, znewInput.hard);
        return { action: "continue" as const };
      }
      state.lastUserInputText = event.text;
      const streamingBehavior = (event as { streamingBehavior?: unknown }).streamingBehavior;
      const stopRestoreCandidate = createStopRestoreCandidate({
        text: event.text,
        source: event.source,
        streamingBehavior: streamingBehavior === "steer" || streamingBehavior === "followUp" ? streamingBehavior : undefined,
        leafId: ctx.sessionManager.getLeafId(),
      });
      if (stopRestoreCandidate) state.stopRestoreCandidate = stopRestoreCandidate;
      else if (!streamingBehavior) state.stopRestoreCandidate = undefined;
      if (!event.text.trim().startsWith("/") && state.autonomy.enabled) {
        const readiness = scoreMissionReadiness(event.text, { mode: state.autonomy.mode, policy: state.autonomy.policy });
        state.autonomy.lastReadiness = readiness;
        state.autonomy.lastLaunchAuthorization = readiness.launchAuthorization;
        state.autonomy.updatedAt = readiness.generatedAt;
        pi.appendEntry("zob-mission-readiness", toMissionReadinessLedgerEntry(readiness));
        if (readiness.decision === "auto_launch") ctx.ui.notify(`${formatMissionReadinessForUi(readiness)} · launch authorized in-scope`, "info");
        else if (readiness.decision === "block") ctx.ui.notify(formatMissionReadinessForUi(readiness), "warning");
      }
    }
    if (event.source === "extension" && !event.text.trim()) return { action: "handled" as const };
    if (event.source === "extension") return { action: "continue" as const };
    const intentResult = await classifyIntent(event.text, ctx.cwd, undefined, { model: ctx.model, modelRegistry: ctx.modelRegistry, signal: ctx.signal });
    if (intentResult.provider !== "regex") {
      pi.appendEntry("zob-intent-classifier", {
        schema: "zob.intent-classifier.event.v1",
        provider: intentResult.provider,
        configuredProvider: intentResult.configuredProvider,
        model: intentResult.model,
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        needsClarification: intentResult.needsClarification,
        fallbackReasonHash: intentResult.fallbackReason ? sha256(intentResult.fallbackReason) : undefined,
        reasonHash: sha256(intentResult.reason),
        evidenceHashes: intentResult.evidence.map((item) => sha256(item)),
        inputHash: intentResult.inputHash,
        rawInputStored: false,
        safetyApproved: false,
        at: new Date().toISOString(),
      });
    }
    const intentMode = intentResult.autoSwitch && intentResult.intent !== "unknown" ? intentResult.intent : undefined;
    const nextMode = intentMode ?? inferModeFromUserIntent(event.text);
    const lockedMode = zagentLockedMode(state);
    if (lockedMode) {
      if (state.activeMode !== lockedMode.mode) {
        applyMode(pi, state, ctx, lockedMode.mode, false);
        state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
      }
      return { action: "continue" as const };
    }
    if (!nextMode || nextMode === state.activeMode) return { action: "continue" as const };
    const previousMode = state.activeMode;
    applyMode(pi, state, ctx, nextMode);
    state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
    const fallbackReason = nextMode === "explore"
      ? "read-only exploration intent detected"
      : nextMode === "plan"
        ? "planning/design intent detected"
        : nextMode === "oracle"
          ? "review/validation intent detected"
          : nextMode === "orchestrator"
            ? "orchestration intent detected"
            : nextMode === "factory"
              ? "factory workflow intent detected"
              : nextMode === "vanilla"
                ? "vanilla/Pi base or external-command intent detected"
                : "write/update intent detected";
    const reason = intentResult.provider === "model"
      ? `model intent classifier detected ${nextMode} (${intentResult.confidence.toFixed(2)})`
      : fallbackReason;
    ctx.ui.notify(`ZOB auto-mode: ${previousMode} → ${nextMode} (${reason})`, "info");
    return { action: "continue" as const };
  });

  pi.on("message_start", async (event, ctx) => {
    if (!isRecord(event.message)) return undefined;
    if (event.message.role === "user") {
      const text = textFromMessage(event.message as AssistantLikeMessage);
      const stopRestoreCandidate = createStopRestoreCandidate({
        text,
        source: "interactive",
        leafId: ctx.sessionManager.getLeafId(),
      });
      if (stopRestoreCandidate) state.stopRestoreCandidate = stopRestoreCandidate;
      return undefined;
    }
    if (event.message.role === "assistant") {
      markStopRestoreAssistantMessage(state.stopRestoreCandidate, event.message as AssistantLikeMessage);
    }
    return undefined;
  });

  pi.on("message_update", async (event) => {
    if (isRecord(event.message) && event.message.role === "assistant") {
      markStopRestoreAssistantMessage(state.stopRestoreCandidate, event.message as AssistantLikeMessage);
    }
    return undefined;
  });

  pi.on("tool_execution_start", async () => {
    markStopRestoreToolVisible(state.stopRestoreCandidate);
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (state.activeMode === "vanilla") return { action: "continue" as const };

    let violation: string | undefined;
    let attempted = JSON.stringify(event.input);

    const pathInputs: string[] = [];
    if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      pathInputs.push(event.input.path);
    }
    if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
      pathInputs.push(event.input.path ?? ".");
    }

    for (const inputPath of pathInputs) {
      for (const protectedPattern of state.currentRules.zeroAccessPaths) {
        if (pathMatches(inputPath, protectedPattern, ctx.cwd)) violation = `zero-access path: ${protectedPattern}`;
      }
      if ((event.toolName === "write" || event.toolName === "edit") && state.activeMode === "explore" && !violation) {
        violation = "explore mode is read-only; switch to /zmode implement and use edit/write for file updates";
      }
      if ((event.toolName === "write" || event.toolName === "edit") && !violation) {
        for (const readOnly of state.currentRules.readOnlyPaths) {
          if (pathMatches(inputPath, readOnly, ctx.cwd)) violation = `read-only path: ${readOnly}`;
        }
      }
    }

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      attempted = command;
      if (state.activeMode === "explore" && bashLooksLikeFileMutation(command)) {
        violation = "explore mode is read-only; do not mutate files through bash/python/perl/node patch scripts";
      }
      for (const rule of state.currentRules.bashToolPatterns) {
        if (violation) break;
        if (new RegExp(rule.pattern, "i").test(command)) {
          if (rule.ask && ctx.hasUI) {
            const ok = await ctx.ui.confirm("ZOB damage-control", `${rule.reason}\n\n${command}\n\nAllow?`, { timeout: 30000 });
            if (ok) return;
          }
          violation = rule.reason;
          break;
        }
      }
      if (!violation) {
        for (const protectedPattern of state.currentRules.zeroAccessPaths) {
          if (command.includes(protectedPattern)) violation = `bash references zero-access path: ${protectedPattern}`;
        }
      }
      if (!violation) {
        for (const noDelete of state.currentRules.noDeletePaths) {
          if (command.includes(noDelete) && /\b(rm|mv)\b/.test(command)) violation = `delete/move protected path: ${noDelete}`;
        }
      }
    }

    if (violation) {
      pi.appendEntry("zob-damage-control", { tool: event.toolName, input: event.input, violation, timestamp: Date.now() });
      ctx.ui.notify(`Blocked ${event.toolName}: ${violation}`, "warning");
      return { block: true, reason: blockedFeedback(event.toolName, violation, attempted) };
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      recordZcommitTouchedFile(state.zcommit, ctx.cwd, event.input.path, event.toolName);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isRecord(event.message) || event.message.role !== "assistant") return undefined;
    markStopRestoreAssistantMessage(state.stopRestoreCandidate, event.message as AssistantLikeMessage);
    const text = textFromMessage(event.message as AssistantLikeMessage);
    const visibleText = stripModeIntentMarkup(text);
    let capturedPlanPath: string | undefined;
    try {
      const capture = capturePlanArtifact(ctx.cwd, { assistantText: visibleText, userText: state.lastUserInputText, mode: state.activeMode });
      if (capture.captured && capture.relativePath) {
        capturedPlanPath = capture.relativePath;
        ctx.ui.notify(`ZOB plan saved: ${capture.relativePath}`, "info");
      }
    } catch {
      // Plan capture is best-effort and must not break assistant message handling.
    }
    const intent = extractModeIntent(text);
    if (intent) handleSameAgentModeIntent(pi, state, ctx, intent, text);
    await maybeRunZcommitMessageEndAutomation(pi, state, ctx);
    const transformed = transformAssistantTextMessage(event.message, (partText) => {
      const withoutIntent = stripModeIntentMarkup(partText);
      return redactPlanTodosBlockForDisplay(withoutIntent, { planPath: capturedPlanPath }).text;
    });
    if (!intent && !transformed.changed) return undefined;
    return { message: transformed.message };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const zcompactPending = state.zcompact.pending;
    const compactionReason = zcompactPending ? zcompactPending.reason : event.customInstructions ? "manual" : "threshold";
    const cancelZcompact = (reason: string) => {
      cancelZcompactPending(pi, state.zcompact, reason);
      notifyWhenUi(ctx, `ZOB zcompact cancelled: ${reason}`, "warning");
      return { cancel: true };
    };
    const fallback = (reason: string) => {
      notifyWhenUi(ctx, `ZOB-aware deterministic compaction fallback: ${reason}`, "warning");
      let preparation = event.preparation;
      try {
        preparation = zcompactPending ? buildZcompactPreparation(state, event.preparation, event.branchEntries) : event.preparation;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return cancelZcompact(message);
      }
      return {
        compaction: buildDeterministicZobCompactionResult(state, preparation, {
          reason: compactionReason,
          customInstructions: event.customInstructions,
          fileOps: preparation.fileOps,
        }),
      };
    };
    const auth = await compactionAuth(ctx);
    if ((!ctx.model || !auth) && zcompactPending) return cancelZcompact("model/auth unavailable");
    if (!ctx.model || !auth) return fallback("model/auth unavailable");
    if (zcompactPending) {
      try {
        const compaction = await runZcompactCompactionHook(state, { preparation: event.preparation, branchEntries: event.branchEntries, ctx, apiKey: auth.apiKey, headers: auth.headers, signal: event.signal });
        if (!compaction.summary.trim()) return fallback("model returned empty zcompact summary");
        const violations = zobCompactionBodyFreeViolations(compaction.details);
        if (violations.length > 0) return fallback(`body-free detail violation: ${violations.slice(0, 2).join(", ")}`);
        return { compaction };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fallback(message);
      }
    }
    const customInstructions = buildZobCompactionInstructions(state, {
      reason: compactionReason,
      customInstructions: event.customInstructions,
      fileOps: event.preparation.fileOps,
    });
    try {
      const result = await compact(event.preparation, ctx.model, auth.apiKey, auth.headers, customInstructions, event.signal);
      if (!result.summary.trim()) return fallback("model returned empty summary");
      const compaction = withZobCompactionDetails(state, result, { fileOps: event.preparation.fileOps });
      const violations = zobCompactionBodyFreeViolations(compaction.details);
      if (violations.length > 0) return fallback(`body-free detail violation: ${violations.slice(0, 2).join(", ")}`);
      return { compaction };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fallback(message);
    }
  });

  pi.on("session_compact", async (event) => {
    const ledger = buildZobCompactionLedgerEntry(state, {
      event: "session_compact",
      summary: event.compactionEntry.summary,
      firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
      tokensBefore: event.compactionEntry.tokensBefore,
      fromExtension: event.fromExtension,
    });
    if (zobCompactionBodyFreeViolations(ledger).length === 0) pi.appendEntry(ZOB_COMPACTION_ENTRY_TYPE, ledger);
    if (Object.keys(state.zcommit.ownedPathRefs ?? {}).length > 0) pi.appendEntry("zob-zcommit", zcommitContinuityLedgerEntry("session_compact", state));
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary) return undefined;
    const fallback = (reason: string) => {
      notifyWhenUi(ctx, `ZOB-aware deterministic branch summary fallback: ${reason}`, "warning");
      const summary = buildDeterministicZobCompactionSummary(state, {
        reason: "branch_summary",
        customInstructions: event.preparation.customInstructions,
      });
      const details = buildZobCompactionLedgerEntry(state, {
        event: "session_tree",
        summary,
        fromExtension: true,
      });
      return { summary: { summary, details } };
    };
    const auth = await compactionAuth(ctx);
    if (!ctx.model || !auth) return fallback("model/auth unavailable");
    const customInstructions = buildZobCompactionInstructions(state, {
      reason: "branch_summary",
      customInstructions: event.preparation.customInstructions,
    });
    try {
      const result = await generateBranchSummary(event.preparation.entriesToSummarize, {
        model: ctx.model,
        apiKey: auth.apiKey ?? "",
        headers: auth.headers,
        signal: event.signal,
        customInstructions,
        replaceInstructions: event.preparation.replaceInstructions,
      });
      if (!result.summary?.trim()) return fallback("model returned empty summary");
      const details = buildZobCompactionLedgerEntry(state, {
        event: "session_tree",
        summary: result.summary,
        readFiles: result.readFiles,
        modifiedFiles: result.modifiedFiles,
        fromExtension: true,
      });
      const violations = zobCompactionBodyFreeViolations(details);
      if (violations.length > 0) return fallback(`body-free detail violation: ${violations.slice(0, 2).join(", ")}`);
      return { summary: { summary: result.summary, details } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fallback(message);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    markZpeerInboundTurnStart(state, event.prompt);
    const goalHint = state.activeGoal
      ? `\n\nZOB GOAL GATE\n- ORIGINAL_USER_ASK: ${state.activeGoal.originalUserAsk}\n- ACTIVE_GOAL: ${state.activeGoal.activeGoal}\n- EXPECTED_OUTPUT: ${state.activeGoal.expectedOutput}\n- CONSTRAINTS: ${state.activeGoal.constraints}\n- VALIDATION_EVIDENCE: ${state.activeGoal.validationEvidence}`
      : "\n\nZOB GOAL GATE\n- No active goal set. If the request is broad or multi-step, use /goal_gate first or restate ORIGINAL_USER_ASK / ACTIVE_GOAL explicitly before delegating.";
    const runtimeGoalHint = state.runtimeGoal
      ? `\n\nZOB RUNTIME GOAL\n- ${runtimeGoalStatusLine(state.runtimeGoal)}\n- activation_mode: ${formatGoalActivationMode(state.goalActivationMode)}\n- objective: ${state.runtimeGoal.objective}\n- completion policy: use resolve_goal_todo for TODO transitions; call propose_goal_completion when evidence is complete; update_goal complete is allowed only after oracle PASS/no_ship=false.\n- no_ship model: hard_no_ship blocks completion, review_no_ship is advisory review evidence, effective_no_ship is their union.\n\nZOB GOAL TODOS\n${formatGoalTodoPromptHint(state.goalTodos, state.runtimeGoal.goalId)}`
      : `\n\nZOB RUNTIME GOAL\n- No runtime /goal set. Use /goal <objective> for long-running looped work; use /goal gate for strict scope.\n- activation_mode: ${formatGoalActivationMode(state.goalActivationMode)}\n\nZOB GOAL TODOS\n${formatGoalTodoPromptHint(state.goalTodos, undefined)}`;
    const rules = state.activeRuleResolution;
    const rulesHint = rules
      ? `\n\nZOB RULE PROFILE\n- profile: ${rules.profile}\n- rule packs: ${rules.rulePacks.join(", ") || "none"}\n- required validation: ${rules.requiredValidation.join(" | ") || "not specified"}\n- oracle required: ${String(rules.oracleRequired)}\n- no-ship conditions: ${rules.noShipConditions.slice(0, 6).join(" | ") || "none"}`
      : "\n\nZOB RULE PROFILE\n- Not resolved yet. Use /rules_status for diagnostics when scope is unclear.";
    const autonomyHint = `\n\n${formatInteractiveAutonomyPromptHint(state.autonomy)}`;
    const zagentHint = formatZagentPromptHint(state);
    const zpeerHint = buildZpeerAwarenessPrompt(state, state.zobLive.inbound?.repoRoot ?? process.cwd());
    const activeSearchBackendHint = buildActiveSearchBackendPromptSnippet(ctx.cwd);
    if (state.activeMode === "vanilla") {
      return { systemPrompt: `${event.systemPrompt}\n\n${MODE_PROMPTS.vanilla}` };
    }
    const contractHint = `\n\nZOB HARNESS OPERATING CONTRACT\n- Prefer Explore -> Plan -> Implement -> Oracle for non-trivial work.\n- Use the six-part contract for delegated work: TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT.\n- Do not claim completion without concrete evidence.\n- If output may truncate, prioritize verdict, blockers, and next steps over exhaustive listings.\n\n${SAME_AGENT_MODE_INTENT_PROMPT}\n\n${ZOB_TOOL_ROUTING_CONTRACT}\n\n${ZOB_COMPACTION_CONTINUITY_CONTRACT}\n\n${EXTERNAL_PACKAGE_TOOLS_CONTRACT}\n\n${MODE_PROMPTS[state.activeMode]}${goalHint}${runtimeGoalHint}${rulesHint}${autonomyHint}${zagentHint}${zpeerHint}${activeSearchBackendHint}`;
    return { systemPrompt: `${event.systemPrompt}${contractHint}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    disposeDelegationMouseSupport(state, { force: true });
    state.currentRules = loadDamageRules(ctx.cwd);
    state.delegations.runs = [];
    restoreHarnessState(state, ctx);
    loadActiveZagentFromEnv(state, ctx.cwd);
    loadActiveZagentScopedMode(state, ctx.cwd);
    const scopedMode = activeZagentState(state)?.scopedMode;
    const startupMode = scopedMode ? (scopedMode.baseMode ?? state.zagent.defaultMode ?? "explore") : state.zagent.defaultMode;
    if (startupMode && startupMode !== state.activeMode) {
      applyMode(pi, state, ctx, startupMode, false);
    }
    state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
    await startOrRefreshZobLiveRuntime(pi, state, ctx);
    applyMode(pi, state, ctx, state.activeMode, false);
    renderHarnessWidget(pi, state, ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    await startOrRefreshZobLiveRuntime(pi, state, ctx);
    renderHarnessWidget(pi, state, ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await maybeTriggerZcompact(pi, state, ctx, { source: "turn_end", render: () => renderHarnessWidget(pi, state, ctx) });
    renderHarnessWidget(pi, state, ctx);
  });

  pi.on("agent_end", async (event) => {
    try {
      await sendInboundZobLiveResponse(pi, state, event);
    } catch {
      // Response capture is best-effort until the full live await path is enabled.
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    recordZpeerNewCarryoverOnShutdown(pi, state, ctx.cwd, event.reason);
    if (state.daemon.loopTimer) clearTimeout(state.daemon.loopTimer);
    state.daemon.loopTimer = undefined;
    state.daemon.loop = {
      ...state.daemon.loop,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      blocker: state.daemon.loop.status === "running" ? "session_shutdown" : state.daemon.loop.blocker,
      autoStartDaemon: false,
      continuousLoop: false,
      cronEnabled: false,
    };
    await stopZobLiveRuntime(state, ctx);
    safelyUpdateZobLivePeer(ctx.cwd, "unregister");
    disposeDelegationMouseSupport(state, { force: true });
    ctx.ui.setWidget("zob-harness", undefined);
    ctx.ui.setStatus("zob-mode", undefined);
    ctx.ui.setStatus("zob-usage", undefined);
    ctx.ui.setStatus("zob-zcompact", undefined);
  });
}
