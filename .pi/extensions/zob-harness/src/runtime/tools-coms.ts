import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readZobComsV2Policy } from "../coms-v2/policy.js";
import { readZobLiveRegistrySnapshot } from "../coms-v2/registry.js";
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
