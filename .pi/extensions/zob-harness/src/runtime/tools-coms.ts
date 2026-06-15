import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readZobComsV2Policy } from "../domains/coms/coms-v2/policy.js";
import { readZobLiveRegistrySnapshot } from "../domains/coms/coms-v2/registry.js";
import { peerAliasInRoom, refreshZpeerSelf, safeZpeerAlias, safeZpeerRoomId, sendZpeerPrompt, type ZpeerSendMode, type ZpeerSendResult } from "../domains/coms/coms-v2/zpeer.js";
import { buildZobLiveEnvelope, type ZpeerInterruptMode, type ZpeerInterruptPriority, type ZpeerInterruptStatus } from "../domains/coms/coms-v2/envelope.js";
import { sendZobLocalEnvelope } from "../domains/coms/coms-v2/local-transport.js";
import { buildZobLiveResponseEnvelope } from "../domains/coms/coms-v2/response-capture.js";
import { appendLiveDeliveredStatus, appendLiveErrorStatus, appendLiveSendRequestedRef } from "../domains/coms/coms-v2/ledger-bridge.js";
import { writeZobComsRedactedCapture } from "../domains/coms/coms-v2/transcript-capture.js";
import type { TeamDefinition } from "../types.js";
import { sha256 } from "../core/utils/hashing.js";
import {
  ZobComsAckParams,
  ZobComsAwaitParams,
  ZobComsGetParams,
  ZobComsListParams,
  ZobComsReplyParams,
  ZobComsSendParams,
  ZobComsStatusParams,
  ZpeerAskParams,
  ZpeerReplyParams,
} from "./schemas.js";
import {
  ackZobComsMessage,
  appendZobComsMessage,
  awaitZobComsMessage,
  getZobComsMessage,
  listZobComsMessages,
  replyZobComsMessage,
  transitionZobComsStatus,
} from "../domains/topology/coms.js";
import { loadTeamDefinition, validateTeamDefinition } from "../domains/topology/teams.js";
import type { HarnessRuntimeState } from "./state.js";

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const ZPEER_AGENT_ASK_RATE_LIMIT_PER_MINUTE = 50;
const ZPEER_AGENT_URGENT_RATE_LIMIT_PER_MINUTE = 10;
const ZPEER_AGENT_FORCE_RATE_LIMIT_PER_MINUTE = 3;

function breakGlassApprovalPresent(): boolean {
  return SHA256_HEX.test(process.env.ZOB_COMS_BREAK_GLASS_APPROVAL_HASH ?? "");
}

function ledgerMutationPolicyBlock(repoRoot: string, toolName: string): { status: "blocked"; reason: string; text: string } | undefined {
  const policy = readZobComsV2Policy(repoRoot);
  if (policy.mode === "off") return { status: "blocked", reason: "transport_off", text: `${toolName} blocked: ZOB coms transport mode is off` };
  if (policy.mode === "break_glass_ledger_only" && !breakGlassApprovalPresent()) return { status: "blocked", reason: "break_glass_approval_missing", text: `${toolName} blocked: break_glass_ledger_only requires ZOB_COMS_BREAK_GLASS_APPROVAL_HASH` };
  return undefined;
}

type ZobComsSendToolParams = {
  runId: string;
  sender: string;
  receiver: string;
  kind?: string;
  taskId?: string;
  taskHash?: string;
  transientBody?: string;
  outputHash?: string;
  status?: string;
  team?: string;
};

type ZpeerAskToolParams = {
  targetAlias: string;
  message: string;
  roomId?: string;
  mode?: ZpeerSendMode;
  reason?: string;
  urgency?: ZpeerInterruptPriority;
  force?: boolean;
  interruptMode?: ZpeerInterruptMode;
  timeoutMs?: number;
  requireResponse?: boolean;
  maxReinjects?: number;
};

type ZpeerReplyToolParams = {
  msgId: string;
  message: string;
};

function boundedZpeerAskTimeoutMs(mode: ZpeerSendMode, raw: number | undefined): number {
  const fallback = mode === "long" ? 30 * 60 * 1000 : 10 * 60 * 1000;
  const cap = mode === "long" ? 30 * 60 * 1000 : 10 * 60 * 1000;
  return Math.max(1_000, Math.min(cap, Math.floor(raw ?? fallback)));
}

function normalizeZpeerInterrupt(params: ZpeerAskToolParams): { priority: ZpeerInterruptPriority; interruptMode: ZpeerInterruptMode; interruptReasonHash?: string; error?: string } {
  const priority: ZpeerInterruptPriority = params.force === true ? "force" : params.urgency ?? "normal";
  const interruptMode: ZpeerInterruptMode = priority === "force" ? "abort" : priority === "urgent" ? "steer" : "none";
  if (params.interruptMode && params.interruptMode !== interruptMode) return { priority, interruptMode, error: `invalid interruptMode '${params.interruptMode}' for urgency '${priority}'` };
  if (priority === "force" && !params.reason?.trim()) return { priority, interruptMode, error: "force interrupt requires reason" };
  return { priority, interruptMode, interruptReasonHash: params.reason?.trim() ? sha256(params.reason) : undefined };
}

function zpeerAskGuardBlock(state: HarnessRuntimeState, params: ZpeerAskToolParams, selfAlias?: string, currentRoomId = "default", priority: ZpeerInterruptPriority = "normal"): string | undefined {
  const targetAlias = safeZpeerAlias(params.targetAlias);
  if (!targetAlias) return "invalid target alias";
  if (selfAlias && targetAlias === selfAlias) return "cannot send to self";
  const roomId = safeZpeerRoomId(params.roomId) ?? currentRoomId;
  if (params.roomId && !safeZpeerRoomId(params.roomId)) return "invalid room id";
  if (/\b(zpeer_ask|\/zpeer)\b/i.test(params.message)) return "loop guard blocked recursive ZPeer instruction";
  const messageHash = sha256(params.message);
  const now = Date.now();
  const windowMs = 60_000;
  const current = state.zobLive.zpeerAskGuard;
  const guard = current && now - current.windowStartedMs < windowMs ? current : { windowStartedMs: now, count: 0, urgentCount: 0, forceCount: 0 };
  const urgentCount = guard.urgentCount ?? 0;
  const forceCount = guard.forceCount ?? 0;
  if (guard.count >= ZPEER_AGENT_ASK_RATE_LIMIT_PER_MINUTE) return `rate guard blocked: max ${ZPEER_AGENT_ASK_RATE_LIMIT_PER_MINUTE} agent-initiated ZPeer asks per 60s window`;
  if (priority === "urgent" && urgentCount >= ZPEER_AGENT_URGENT_RATE_LIMIT_PER_MINUTE) return `rate guard blocked: max ${ZPEER_AGENT_URGENT_RATE_LIMIT_PER_MINUTE} urgent ZPeer asks per 60s window`;
  if (priority === "force" && forceCount >= ZPEER_AGENT_FORCE_RATE_LIMIT_PER_MINUTE) return `rate guard blocked: max ${ZPEER_AGENT_FORCE_RATE_LIMIT_PER_MINUTE} force ZPeer asks per 60s window`;
  if (guard.lastRoomId === roomId && guard.lastTargetAlias === targetAlias && guard.lastMessageHash === messageHash) return "loop guard blocked duplicate room/target/message in ask window";
  state.zobLive.zpeerAskGuard = { windowStartedMs: guard.windowStartedMs, count: guard.count + 1, urgentCount: priority === "urgent" ? urgentCount + 1 : urgentCount, forceCount: priority === "force" ? forceCount + 1 : forceCount, lastRoomId: roomId, lastTargetAlias: targetAlias, lastMessageHash: messageHash };
  return undefined;
}

function zpeerTerminalKind(status: ZpeerSendResult["status"]): "delivered" | "waiting" | "reply" | "blocked" | "error" | "timeout" | "expired" | "required_response_expired" {
  return status === "reply" || status === "completed" ? "reply" : status === "blocked" ? "blocked" : status === "timeout" ? "timeout" : status === "expired" ? "expired" : status === "required_response_expired" ? "required_response_expired" : status === "error" ? "error" : status === "waiting" ? "waiting" : "delivered";
}

function updatePassivePeerWaitState(state: HarnessRuntimeState, result: ZpeerSendResult, fallback: { roomId: string; targetAlias: string }): void {
  if (result.status !== "waiting") {
    state.zobLive.passivePeerWait = undefined;
    return;
  }
  const startedAt = new Date().toISOString();
  state.zobLive.passivePeerWait = {
    schema: "zob.passive-peer-wait.v1",
    status: "waiting",
    msgId: result.msgId,
    roomId: result.roomId ?? fallback.roomId,
    targetAlias: result.targetAlias ?? fallback.targetAlias,
    taskHash: result.taskHash,
    startedAt,
    startedAtMs: Date.now(),
    source: "zpeer_ask",
    suppressGoalContinuation: true,
    bodyStored: false,
    localOnly: true,
    networkEnabled: false,
  };
}

function appendBlockedLiveSend(repoRoot: string, definition: TeamDefinition, params: ZobComsSendToolParams, status: string, reason: string): Record<string, unknown> {
  return appendZobComsMessage(repoRoot, definition, {
    runId: params.runId,
    sender: params.sender,
    receiver: params.receiver,
    kind: params.kind ?? "handoff",
    taskId: params.taskId,
    taskHash: params.taskHash ?? (params.transientBody ? sha256(params.transientBody) : undefined),
    outputHash: params.outputHash ?? null,
    status,
    ack: "not_sent",
    metadata: { schema: "zob.coms-live-block.v1", reasonHash: sha256(reason), liveDelivery: "blocked", persistBodies: false },
  });
}

async function executeRequiredLocalLiveSend(repoRoot: string, definition: TeamDefinition, params: ZobComsSendToolParams): Promise<Record<string, unknown>> {
  const transientBody = typeof params.transientBody === "string" ? params.transientBody : "";
  const taskHash = params.taskHash ?? (transientBody ? sha256(transientBody) : undefined);
  if (!transientBody || !taskHash) {
    return { status: "blocked", reason: "required_local live send requires transientBody or taskHash plus transientBody", message: appendBlockedLiveSend(repoRoot, definition, params, "blocked_live_body_missing", "missing transient live body") };
  }
  const registry = readZobLiveRegistrySnapshot(repoRoot, definition.name);
  const receiver = registry.peers.find((peer) => peer.roleId === params.receiver && peer.status === "online" && peer.transport === "local_socket" && !peer.endpoint.startsWith("pending-"));
  if (!receiver) {
    return { status: "blocked", reason: "receiver unavailable in live registry", message: appendBlockedLiveSend(repoRoot, definition, params, "blocked_peer_unavailable", "receiver unavailable in live registry") };
  }
  const senderPeer = registry.peers.find((peer) => peer.roleId === params.sender && peer.status === "online" && peer.transport === "local_socket" && !peer.endpoint.startsWith("pending-"));
  const policy = readZobComsV2Policy(repoRoot);
  const msgId = params.taskId ?? `${params.runId}:${params.sender}:${params.receiver}:${Date.now()}`;
  let promptCapture: ReturnType<typeof writeZobComsRedactedCapture>;
  try {
    promptCapture = writeZobComsRedactedCapture(repoRoot, policy.transcriptCapture, {
      runId: params.runId,
      msgId,
      sender: params.sender,
      receiver: params.receiver,
      team: definition.name,
      kind: "live_prompt",
      taskHash,
      transientPrompt: transientBody,
    });
  } catch {
    promptCapture = undefined;
  }
  const envelope = buildZobLiveEnvelope({
    type: "prompt",
    msgId,
    runId: params.runId,
    sender: params.sender,
    receiver: params.receiver,
    team: definition.name,
    taskHash,
    replyEndpoint: senderPeer?.endpoint,
    replyEndpointHash: senderPeer?.endpointHash,
    artifactRefs: promptCapture ? [promptCapture.artifactRef] : undefined,
    artifactHashes: promptCapture ? [promptCapture.artifactHash] : undefined,
    transientPrompt: transientBody,
  });
  const liveRef = appendLiveSendRequestedRef(repoRoot, definition, envelope);
  try {
    const ack = await sendZobLocalEnvelope(receiver.endpoint, envelope, { timeoutMs: 5_000 });
    if (ack.type !== "ack") {
      appendLiveErrorStatus(repoRoot, String(liveRef.msgId), params.sender);
      return { status: "error", reason: `expected ack, got ${ack.type}`, message: liveRef, ack };
    }
    const delivered = appendLiveDeliveredStatus(repoRoot, String(liveRef.msgId), params.sender);
    return { status: "delivered", message: delivered, live: { schema: "zob.live-delivery.v1", msgId: envelope.msgId, receiverSessionHash: receiver.sessionHash, ackType: ack.type, bodyStored: false } };
  } catch (error) {
    appendLiveErrorStatus(repoRoot, String(liveRef.msgId), params.sender);
    return { status: "error", reason: error instanceof Error ? error.message : String(error), message: liveRef };
  }
}

export function registerComsTools(pi: ExtensionAPI, state?: HarnessRuntimeState): void {
  pi.registerTool({
    name: "zpeer_ask",
    label: "ZPeer Ask",
    description: "Ask a visible local ZPeer via the governed room-scoped local_socket path. Defaults to mode=async; raw message/reply bodies are transient and durable metadata is hash-only.",
    promptSnippet: "Use zpeer_ask with mode=\"async\" for useful non-trivial peer review/debug/planning coordination; if it returns waiting and nothing else is actionable, stop/idle instead of polling.",
    parameters: ZpeerAskParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state?.zobLive.peerCard) return { content: [{ type: "text", text: "zpeer_ask blocked: current session has not registered a local peer endpoint" }], details: { schema: "zob.zpeer-ask-result.v1", status: "blocked", reason: "local_peer_unavailable", bodyStored: false } };
      const mode = params.mode ?? "async";
      const self = refreshZpeerSelf(ctx.cwd, state.zobLive.peerCard);
      state.zobLive.peerCard = self;
      const targetAlias = safeZpeerAlias(params.targetAlias) ?? params.targetAlias.replace(/^@+/, "");
      const requestedRoomId = safeZpeerRoomId(params.roomId) ?? self.zpeerRoomId ?? "default";
      const requestedFromAlias = peerAliasInRoom(self, requestedRoomId) ?? self.zpeerAlias;
      const interrupt = normalizeZpeerInterrupt(params);
      const guardReason = interrupt.error ?? zpeerAskGuardBlock(state, params, requestedFromAlias, requestedRoomId, interrupt.priority);
      const emitZpeerAskEvent = (event: { kind: NonNullable<HarnessRuntimeState["zobLive"]["lastEvent"]>["kind"]; status: string; reason?: string; msgId?: string; roomId?: string; taskHash?: string; outputHash?: string; interruptStatus?: ZpeerInterruptStatus }): void => {
        const eventRoomId = event.roomId ?? requestedRoomId;
        const fromAlias = peerAliasInRoom(self, eventRoomId) ?? requestedFromAlias;
        state.zobLive.lastEvent = { kind: event.kind, roomId: eventRoomId, fromAlias, toAlias: targetAlias, status: event.status, reason: event.reason, msgId: event.msgId, taskHash: event.taskHash, outputHash: event.outputHash, priority: interrupt.priority, interruptMode: interrupt.interruptMode, interruptStatus: event.interruptStatus, at: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false };
        void pi.sendMessage({
          customType: "zob-zpeer-event",
          content: `ZPeer agent-request @${fromAlias ?? "?"} → @${targetAlias} ${event.status}`,
          display: true,
          details: { ...state.zobLive.lastEvent, source: "agent-request", mode, priority: interrupt.priority, interruptMode: interrupt.interruptMode, bodyStored: false, localOnly: true, networkEnabled: false },
        }, { triggerTurn: false });
      };
      const taskHash = params.message.trim() ? sha256(params.message) : undefined;
      if (guardReason) {
        state.zobLive.passivePeerWait = undefined;
        const interruptStatus: ZpeerInterruptStatus | undefined = interrupt.priority === "force" ? "force_blocked" : undefined;
        const result = { schema: "zob.zpeer-ask-result.v1", status: "blocked", reason: guardReason, targetAlias, taskHash, priority: interrupt.priority, interruptMode: interrupt.interruptMode, interruptStatus, bodyStored: false };
        emitZpeerAskEvent({ kind: "blocked", status: "blocked", reason: guardReason, taskHash, interruptStatus });
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-ask.v1", action: "agent_request_blocked", mode, status: "blocked", priority: interrupt.priority, interruptMode: interrupt.interruptMode, interruptStatus, reasonHash: sha256(guardReason), targetAliasHash: sha256(targetAlias), roomIdHash: sha256(requestedRoomId), taskHash, reasonInputHash: params.reason ? sha256(params.reason) : undefined, interruptReasonHash: interrupt.interruptReasonHash, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        return { content: [{ type: "text", text: `zpeer_ask blocked: ${guardReason}` }], details: result };
      }
      const timeoutMs = boundedZpeerAskTimeoutMs(mode, params.timeoutMs);
      const requireResponse = params.requireResponse === true;
      const maxReinjects = Math.max(0, Math.min(3, Math.floor(params.maxReinjects ?? 1)));
      let feedbackEmittedTerminal = false;
      const result = await sendZpeerPrompt(ctx.cwd, self, targetAlias, params.message, (msgId) => state.zobLive.pendingReplies.wait(msgId, timeoutMs, { requireResponse }), {
        mode,
        roomId: params.roomId,
        priority: interrupt.priority,
        interruptMode: interrupt.interruptMode,
        interruptReasonHash: interrupt.interruptReasonHash,
        requireResponse,
        responseTimeoutMs: timeoutMs,
        maxReinjects,
        onFeedback: (feedback) => {
          feedbackEmittedTerminal = feedback.result.status === "waiting" || feedback.result.status === "reply" || feedback.result.status === "completed" || feedback.result.status === "blocked" || feedback.result.status === "error" || feedback.result.status === "timeout" || feedback.result.status === "expired" || feedback.result.status === "required_response_expired";
          emitZpeerAskEvent({ kind: feedback.kind, roomId: feedback.result.roomId, status: feedback.result.status, reason: feedback.result.reason, msgId: feedback.result.msgId, taskHash: feedback.result.taskHash, outputHash: feedback.result.outputHash, interruptStatus: feedback.result.interruptStatus });
        },
      });
      if (!feedbackEmittedTerminal) emitZpeerAskEvent({ kind: zpeerTerminalKind(result.status), roomId: result.roomId, status: result.status, reason: result.reason, msgId: result.msgId, taskHash: result.taskHash, outputHash: result.outputHash, interruptStatus: result.interruptStatus });
      updatePassivePeerWaitState(state, result, { roomId: requestedRoomId, targetAlias });
      pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-ask.v1", action: "agent_request", mode, status: result.status, priority: interrupt.priority, interruptMode: interrupt.interruptMode, interruptStatus: result.interruptStatus, reasonHash: result.reason ? sha256(result.reason) : undefined, msgId: result.msgId, targetAliasHash: result.targetAlias ? sha256(result.targetAlias) : sha256(targetAlias), roomIdHash: sha256(result.roomId ?? requestedRoomId), taskHash: result.taskHash, outputHash: result.outputHash, reasonInputHash: params.reason ? sha256(params.reason) : undefined, interruptReasonHash: interrupt.interruptReasonHash, requireResponse: requireResponse || undefined, responseRequiredBy: result.responseRequiredBy, responseTimeoutMs: result.responseTimeoutMs, maxReinjects: result.maxReinjects, responseReceived: result.responseReceived, deliveryStatus: result.deliveryStatus, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
      const ok = result.status === "reply" || result.status === "completed" || result.status === "waiting" || result.status === "delivered";
      const passiveWaitSuffix = result.status === "waiting" ? " · idle/passive wait: no follow-up turn queued; stop if no other action is actionable" : "";
      const transientReplyText = (result.status === "reply" || result.status === "completed") && result.transientResponse
        ? `\n\nTransient ZPeer reply (not stored in .pi/coms):\n${result.transientResponse}`
        : "";
      const interruptSuffix = result.interruptStatus ? ` interrupt=${result.interruptStatus}` : interrupt.priority !== "normal" ? ` priority=${interrupt.priority}` : "";
      return { content: [{ type: "text", text: ok ? `zpeer_ask ${result.status}: @${result.targetAlias ?? targetAlias}${interruptSuffix}${result.outputHash ? ` outputHash=${result.outputHash}` : ""}${passiveWaitSuffix}${transientReplyText}` : `zpeer_ask ${result.status}: ${result.reason ?? "see metadata"}${interruptSuffix}` }], details: { schema: "zob.zpeer-ask-result.v1", mode, ...result } };
    },
  });

  pi.registerTool({
    name: "zpeer_reply",
    label: "ZPeer Reply",
    description: "Reply to an active inbound ZPeer message by msgId. Raw reply bodies are transient local-socket payloads only; durable metadata stores hashes/status only.",
    promptSnippet: "Use zpeer_reply({ msgId, message }) when a ZPeer inbound requires an explicit msgId-bound answer after inspection; never reply to a different msgId.",
    parameters: ZpeerReplyParams,
    async execute(_toolCallId, params: ZpeerReplyToolParams, _signal, _onUpdate, ctx) {
      const msgId = params.msgId?.trim();
      const responseText = params.message ?? "";
      const outputHash = responseText.trim() ? sha256(responseText) : undefined;
      const inbound = msgId ? state?.zobLive.inboundByMsgId?.[msgId] : undefined;
      const block = !state ? "zpeer runtime state unavailable" : !msgId ? "msgId is required" : !responseText.trim() ? "message is required" : !inbound ? "no active inbound ZPeer message for msgId" : inbound.responseSent || inbound.requiredResponseStatus === "replied" ? "ZPeer msgId already answered" : inbound.requiredResponseStatus === "expired" ? "ZPeer msgId required response already expired" : !inbound.envelope.replyEndpoint ? "ZPeer inbound msgId has no reply endpoint" : undefined;
      if (block) {
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-reply.v1", action: "reply_blocked", status: "blocked", reasonHash: sha256(block), msgId, outputHash, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        return { content: [{ type: "text", text: `zpeer_reply blocked: ${block}` }], details: { schema: "zob.zpeer-reply-result.v1", status: "blocked", reason: block, msgId, outputHash, bodyStored: false, localOnly: true, networkEnabled: false } };
      }
      if (!state || !inbound || !inbound.envelope.replyEndpoint) return { content: [{ type: "text", text: "zpeer_reply blocked: invalid reply state" }], details: { schema: "zob.zpeer-reply-result.v1", status: "blocked", reason: "invalid_reply_state", msgId, outputHash, bodyStored: false, localOnly: true, networkEnabled: false } };
      const replyEndpoint = inbound.envelope.replyEndpoint;
      try {
        const responseEnvelope = { ...buildZobLiveResponseEnvelope(inbound.envelope, responseText, inbound.envelope.artifactRefs, inbound.envelope.artifactHashes), replyToMsgId: inbound.envelope.msgId, responseHash: outputHash };
        const ack = await sendZobLocalEnvelope(replyEndpoint, responseEnvelope, { timeoutMs: 5_000 });
        if (ack.type !== "ack") throw new Error(`expected ack, got ${ack.type}`);
        if (inbound.watchdogTimer) clearTimeout(inbound.watchdogTimer);
        inbound.responseSent = true;
        inbound.requiredResponseStatus = "replied";
        if (state.zobLive.inboundByMsgId) delete state.zobLive.inboundByMsgId[inbound.envelope.msgId];
        if (state.zobLive.inbound?.envelope.msgId === inbound.envelope.msgId) state.zobLive.inbound = { ...state.zobLive.inbound, responseSent: true };
        state.zobLive.activeInboundMsgId = undefined;
        state.zobLive.inboundQueue = (state.zobLive.inboundQueue ?? []).filter((candidate) => candidate !== inbound.envelope.msgId);
        const roomId = inbound.envelope.runId?.startsWith("zpeer:") ? inbound.envelope.runId.slice("zpeer:".length) : undefined;
        state.zobLive.lastEvent = { kind: "response_sent", roomId, fromAlias: inbound.envelope.receiver, toAlias: inbound.envelope.sender, status: "response_sent", msgId: inbound.envelope.msgId, taskHash: inbound.envelope.taskHash, outputHash, priority: inbound.priority, interruptMode: inbound.interruptMode, at: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false };
        void pi.sendMessage({ customType: "zob-zpeer-event", content: "ZPeer explicit reply sent", display: true, details: { ...state.zobLive.lastEvent } }, { triggerTurn: false });
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-reply.v1", action: "reply", status: "response_sent", msgId: inbound.envelope.msgId, taskHash: inbound.envelope.taskHash, outputHash, priority: inbound.priority, interruptMode: inbound.interruptMode, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        return { content: [{ type: "text", text: `zpeer_reply sent: msgId=${inbound.envelope.msgId} outputHash=${outputHash}` }], details: { schema: "zob.zpeer-reply-result.v1", status: "response_sent", msgId: inbound.envelope.msgId, taskHash: inbound.envelope.taskHash, outputHash, bodyStored: false, localOnly: true, networkEnabled: false } };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-reply.v1", action: "reply_error", status: "error", reasonHash: sha256(reason), msgId, outputHash, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        return { content: [{ type: "text", text: `zpeer_reply error: ${reason}` }], details: { schema: "zob.zpeer-reply-result.v1", status: "error", reasonHash: sha256(reason), msgId, outputHash, bodyStored: false, localOnly: true, networkEnabled: false } };
      }
    },
  });

  pi.registerTool({
    name: "zob_coms_send",
    label: "ZOB Coms Send",
    description: "Send a ZOB coms message. In v2 required_local mode this delivers live first and mirrors hash-only to .pi/coms; outside required live mode it writes a plan_only hash-only reference, not delivery success. No network coms.",
    promptSnippet: "Send a ZOB live/hash-only mailbox message",
    parameters: ZobComsSendParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (errors.length > 0 || !team.definition) return { content: [{ type: "text", text: `zob_coms_send failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const policy = readZobComsV2Policy(ctx.cwd);
        if (policy.mode === "off") return { content: [{ type: "text", text: "zob_coms_send blocked: ZOB coms transport mode is off" }], details: { status: "blocked", reason: "transport_off" } };
        if (policy.mode === "required_network") return { content: [{ type: "text", text: "zob_coms_send blocked: required_network is not enabled in P1; network remains gated" }], details: { status: "blocked", reason: "network_gated", networkEnabled: policy.networkEnabled } };
        if (policy.mode === "required_local") {
          const live = await executeRequiredLocalLiveSend(ctx.cwd, team.definition as TeamDefinition, params);
          const status = typeof live.status === "string" ? live.status : "unknown";
          return { content: [{ type: "text", text: status === "delivered" ? `zob_coms_send delivered: ${(live.message as Record<string, unknown>).msgId}` : `zob_coms_send ${status}: ${live.reason ?? "live delivery failed"}` }], details: live };
        }
        if (policy.mode === "break_glass_ledger_only" && !breakGlassApprovalPresent()) return { content: [{ type: "text", text: "zob_coms_send blocked: break_glass_ledger_only requires ZOB_COMS_BREAK_GLASS_APPROVAL_HASH" }], details: { status: "blocked", reason: "break_glass_approval_missing" } };
        const message = appendZobComsMessage(ctx.cwd, team.definition as TeamDefinition, {
          runId: params.runId,
          sender: params.sender,
          receiver: params.receiver,
          kind: params.kind ?? "plan_only_handoff_ref",
          taskId: params.taskId,
          taskHash: params.taskHash ?? (params.transientBody ? sha256(params.transientBody) : undefined),
          outputHash: params.outputHash ?? null,
          status: params.status ?? "planned",
          metadata: { schema: "zob.coms-plan-only-ref.v1", noExecution: true, liveDelivery: "none", persistBodies: false },
        });
        return { content: [{ type: "text", text: `zob_coms_send planned_ref: ${message.msgId}` }], details: message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_coms_send blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_coms_ack",
    label: "ZOB Coms ACK",
    description: "ACK receipt of a local .pi/coms mailbox message. Appends metadata-only status event; no bodies stored.",
    parameters: ZobComsAckParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const policyBlock = ledgerMutationPolicyBlock(ctx.cwd, "zob_coms_ack");
        if (policyBlock) return { content: [{ type: "text", text: policyBlock.text }], details: policyBlock };
        const message = ackZobComsMessage(ctx.cwd, params.msgId, params.actor);
        return { content: [{ type: "text", text: `zob_coms_ack: ${params.msgId}` }], details: message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_coms_ack blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_coms_status",
    label: "ZOB Coms Status",
    description: "Append a local metadata-only status transition for a .pi/coms message. No bodies stored.",
    parameters: ZobComsStatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const policyBlock = ledgerMutationPolicyBlock(ctx.cwd, "zob_coms_status");
        if (policyBlock) return { content: [{ type: "text", text: policyBlock.text }], details: policyBlock };
        const message = transitionZobComsStatus(ctx.cwd, params.msgId, params.actor, params.status);
        return { content: [{ type: "text", text: `zob_coms_status ${params.status}: ${params.msgId}` }], details: message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_coms_status blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_coms_reply",
    label: "ZOB Coms Reply",
    description: "Append a topology-guarded hash-only local reply correlated to a parent .pi/coms message. No network coms.",
    parameters: ZobComsReplyParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = loadTeamDefinition(ctx.cwd, params.team ?? "zob-core");
      const errors = [...team.errors, ...validateTeamDefinition(ctx.cwd, team.definition)];
      if (errors.length > 0 || !team.definition) return { content: [{ type: "text", text: `zob_coms_reply failed_preflight:\n- ${errors.join("\n- ")}` }], details: { status: "failed_preflight", errors } };
      try {
        const policy = readZobComsV2Policy(ctx.cwd);
        if (policy.mode === "off") return { content: [{ type: "text", text: "zob_coms_reply blocked: ZOB coms transport mode is off" }], details: { status: "blocked", reason: "transport_off" } };
        if (policy.mode === "break_glass_ledger_only" && !breakGlassApprovalPresent()) return { content: [{ type: "text", text: "zob_coms_reply blocked: break_glass_ledger_only requires ZOB_COMS_BREAK_GLASS_APPROVAL_HASH" }], details: { status: "blocked", reason: "break_glass_approval_missing" } };
        const message = replyZobComsMessage(ctx.cwd, team.definition as TeamDefinition, params.msgId, {
          sender: params.sender,
          receiver: params.receiver,
          kind: params.kind ?? "reply",
          taskId: params.taskId,
          taskHash: params.taskHash,
          outputHash: params.outputHash ?? null,
          status: params.status ?? "planned",
        });
        return { content: [{ type: "text", text: `zob_coms_reply planned_ref: ${message.msgId}` }], details: message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `zob_coms_reply blocked: ${message}` }], details: { status: "blocked", errors: [message] } };
      }
    },
  });

  pi.registerTool({
    name: "zob_coms_list",
    label: "ZOB Coms List",
    description: "List local .pi/coms mailbox messages with bounded filters. Bodies are never returned because they are not stored.",
    parameters: ZobComsListParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const messages = listZobComsMessages(ctx.cwd, params);
      return { content: [{ type: "text", text: `zob_coms_list: ${messages.length} message(s)` }], details: { schema: "zob.coms-list.v1", messages } };
    },
  });

  pi.registerTool({
    name: "zob_coms_get",
    label: "ZOB Coms Get",
    description: "Fetch one local .pi/coms mailbox message by id.",
    parameters: ZobComsGetParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const message = getZobComsMessage(ctx.cwd, params.msgId);
      return { content: [{ type: "text", text: message ? `zob_coms_get: ${params.msgId}` : `zob_coms_get: not found ${params.msgId}` }], details: { schema: "zob.coms-get.v1", message } };
    },
  });

  pi.registerTool({
    name: "zob_coms_await",
    label: "ZOB Coms Await",
    description: "Bounded wait for a local .pi/coms mailbox message. Timeout is capped at 5000ms.",
    parameters: ZobComsAwaitParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const policy = readZobComsV2Policy(ctx.cwd);
      if (policy.mode === "required_local" || policy.mode === "required_network") {
        if (typeof params.msgId !== "string" || params.msgId.length === 0) return { content: [{ type: "text", text: "zob_coms_await blocked: required live mode requires msgId; ledger polling fallback is disabled" }], details: { schema: "zob.coms-await-live.v1", status: "blocked", reason: "msgId_required", timedOut: false } };
        if (!state?.zobLive.pendingReplies) return { content: [{ type: "text", text: "zob_coms_await blocked: live pending reply registry unavailable" }], details: { schema: "zob.coms-await-live.v1", status: "blocked", reason: "pending_replies_unavailable", timedOut: false } };
        const timeoutMs = Math.max(25, Math.min(30 * 60 * 1000, Math.floor(params.timeoutMs ?? 30_000)));
        const result = await state.zobLive.pendingReplies.wait(params.msgId, timeoutMs);
        return { content: [{ type: "text", text: result.status === "completed" ? `zob_coms_await live_response: ${params.msgId}` : `zob_coms_await ${result.status}: ${params.msgId}` }], details: { schema: "zob.coms-await-live.v1", timedOut: result.status === "timeout", result } };
      }
      const message = await awaitZobComsMessage(ctx.cwd, params);
      return { content: [{ type: "text", text: message ? `zob_coms_await: ${message.msgId}` : "zob_coms_await: timeout" }], details: { schema: "zob.coms-await.v1", timedOut: !message, message } };
    },
  });
}
