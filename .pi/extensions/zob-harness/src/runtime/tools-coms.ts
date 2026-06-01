import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readZobComsV2Policy } from "../coms-v2/policy.js";
import { readZobLiveRegistrySnapshot } from "../coms-v2/registry.js";
import { peerAliasInRoom, refreshZpeerSelf, safeZpeerAlias, safeZpeerRoomId, sendZpeerPrompt, type ZpeerSendMode, type ZpeerSendResult } from "../coms-v2/zpeer.js";
import { buildZobLiveEnvelope } from "../coms-v2/envelope.js";
import { sendZobLocalEnvelope } from "../coms-v2/local-transport.js";
import { appendLiveDeliveredStatus, appendLiveErrorStatus, appendLiveSendRequestedRef } from "../coms-v2/ledger-bridge.js";
import { writeZobComsRedactedCapture } from "../coms-v2/transcript-capture.js";
import type { TeamDefinition } from "../types.js";
import { sha256 } from "../utils/hashing.js";
import {
  ZobComsAckParams,
  ZobComsAwaitParams,
  ZobComsGetParams,
  ZobComsListParams,
  ZobComsReplyParams,
  ZobComsSendParams,
  ZobComsStatusParams,
  ZpeerAskParams,
} from "../schemas.js";
import {
  ackZobComsMessage,
  appendZobComsMessage,
  awaitZobComsMessage,
  getZobComsMessage,
  listZobComsMessages,
  replyZobComsMessage,
  transitionZobComsStatus,
} from "../topology/coms.js";
import { loadTeamDefinition, validateTeamDefinition } from "../topology/teams.js";
import type { HarnessRuntimeState } from "./state.js";

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const ZPEER_AGENT_ASK_RATE_LIMIT_PER_MINUTE = 50;

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
  timeoutMs?: number;
};

function boundedZpeerAskTimeoutMs(mode: ZpeerSendMode, raw: number | undefined): number {
  const fallback = mode === "long" ? 30 * 60 * 1000 : 10 * 60 * 1000;
  const cap = mode === "long" ? 30 * 60 * 1000 : 10 * 60 * 1000;
  return Math.max(1_000, Math.min(cap, Math.floor(raw ?? fallback)));
}

function zpeerAskGuardBlock(state: HarnessRuntimeState, params: ZpeerAskToolParams, selfAlias?: string, currentRoomId = "default"): string | undefined {
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
  const guard = current && now - current.windowStartedMs < windowMs ? current : { windowStartedMs: now, count: 0 };
  if (guard.count >= ZPEER_AGENT_ASK_RATE_LIMIT_PER_MINUTE) return `rate guard blocked: max ${ZPEER_AGENT_ASK_RATE_LIMIT_PER_MINUTE} agent-initiated ZPeer asks per 60s window`;
  if (guard.lastRoomId === roomId && guard.lastTargetAlias === targetAlias && guard.lastMessageHash === messageHash) return "loop guard blocked duplicate room/target/message in ask window";
  state.zobLive.zpeerAskGuard = { windowStartedMs: guard.windowStartedMs, count: guard.count + 1, lastRoomId: roomId, lastTargetAlias: targetAlias, lastMessageHash: messageHash };
  return undefined;
}

function zpeerTerminalKind(status: ZpeerSendResult["status"]): "delivered" | "waiting" | "reply" | "blocked" | "error" | "timeout" | "expired" {
  return status === "reply" || status === "completed" ? "reply" : status === "blocked" ? "blocked" : status === "timeout" ? "timeout" : status === "expired" ? "expired" : status === "error" ? "error" : status === "waiting" ? "waiting" : "delivered";
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
      const guardReason = zpeerAskGuardBlock(state, params, requestedFromAlias, requestedRoomId);
      const emitZpeerAskEvent = (event: { kind: NonNullable<HarnessRuntimeState["zobLive"]["lastEvent"]>["kind"]; status: string; reason?: string; msgId?: string; roomId?: string; taskHash?: string; outputHash?: string }): void => {
        const eventRoomId = event.roomId ?? requestedRoomId;
        const fromAlias = peerAliasInRoom(self, eventRoomId) ?? requestedFromAlias;
        state.zobLive.lastEvent = { kind: event.kind, roomId: eventRoomId, fromAlias, toAlias: targetAlias, status: event.status, reason: event.reason, msgId: event.msgId, taskHash: event.taskHash, outputHash: event.outputHash, at: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false };
        void pi.sendMessage({
          customType: "zob-zpeer-event",
          content: `ZPeer agent-request @${fromAlias ?? "?"} → @${targetAlias} ${event.status}`,
          display: true,
          details: { ...state.zobLive.lastEvent, source: "agent-request", mode, bodyStored: false, localOnly: true, networkEnabled: false },
        }, { triggerTurn: false });
      };
      const taskHash = params.message.trim() ? sha256(params.message) : undefined;
      if (guardReason) {
        const result = { schema: "zob.zpeer-ask-result.v1", status: "blocked", reason: guardReason, targetAlias, taskHash, bodyStored: false };
        emitZpeerAskEvent({ kind: "blocked", status: "blocked", reason: guardReason, taskHash });
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-ask.v1", action: "agent_request_blocked", mode, status: "blocked", reasonHash: sha256(guardReason), targetAliasHash: sha256(targetAlias), roomIdHash: sha256(requestedRoomId), taskHash, reasonInputHash: params.reason ? sha256(params.reason) : undefined, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        return { content: [{ type: "text", text: `zpeer_ask blocked: ${guardReason}` }], details: result };
      }
      const timeoutMs = boundedZpeerAskTimeoutMs(mode, params.timeoutMs);
      let feedbackEmittedTerminal = false;
      const result = await sendZpeerPrompt(ctx.cwd, self, targetAlias, params.message, (msgId) => state.zobLive.pendingReplies.wait(msgId, timeoutMs), {
        mode,
        roomId: params.roomId,
        onFeedback: (feedback) => {
          feedbackEmittedTerminal = feedback.result.status === "waiting" || feedback.result.status === "reply" || feedback.result.status === "completed" || feedback.result.status === "blocked" || feedback.result.status === "error" || feedback.result.status === "timeout" || feedback.result.status === "expired";
          emitZpeerAskEvent({ kind: feedback.kind, roomId: feedback.result.roomId, status: feedback.result.status, reason: feedback.result.reason, msgId: feedback.result.msgId, taskHash: feedback.result.taskHash, outputHash: feedback.result.outputHash });
        },
      });
      if (!feedbackEmittedTerminal) emitZpeerAskEvent({ kind: zpeerTerminalKind(result.status), roomId: result.roomId, status: result.status, reason: result.reason, msgId: result.msgId, taskHash: result.taskHash, outputHash: result.outputHash });
      pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-ask.v1", action: "agent_request", mode, status: result.status, reasonHash: result.reason ? sha256(result.reason) : undefined, msgId: result.msgId, targetAliasHash: result.targetAlias ? sha256(result.targetAlias) : sha256(targetAlias), roomIdHash: sha256(result.roomId ?? requestedRoomId), taskHash: result.taskHash, outputHash: result.outputHash, reasonInputHash: params.reason ? sha256(params.reason) : undefined, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
      const ok = result.status === "reply" || result.status === "completed" || result.status === "waiting" || result.status === "delivered";
      const passiveWaitSuffix = result.status === "waiting" ? " · idle/passive wait: no follow-up turn queued; stop if no other action is actionable" : "";
      return { content: [{ type: "text", text: ok ? `zpeer_ask ${result.status}: @${result.targetAlias ?? targetAlias}${result.outputHash ? ` outputHash=${result.outputHash}` : ""}${passiveWaitSuffix}` : `zpeer_ask ${result.status}: ${result.reason ?? "see metadata"}` }], details: { schema: "zob.zpeer-ask-result.v1", mode, ...result } };
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
