import { isRecord } from "../core/utils/records.js";
import type { HarnessRuntimeState, ZobInboundZpeerMessage } from "./state.js";

export type ZpeerAutoReplyDecision =
  | { kind: "none"; reason: "no_active_inbound" | "ambiguous_inbound" | "assistant_error" | "empty_response" | "expired_inbound" }
  | { kind: "defer"; msgId: string; reason: "goal_active" | "goal_not_terminal" }
  | { kind: "response"; msgId: string; responseText: string }
  | { kind: "error"; msgId: string; errorCode: "zpeer_task_blocked"; errorMessage: "ZPeer task blocked before completion" };

interface ZpeerMessageBinding {
  msgId: string;
  taskHash: string;
}

function messageBinding(message: unknown): ZpeerMessageBinding | undefined {
  if (!isRecord(message) || message.customType !== "zob-coms-inbound" || !isRecord(message.details)) return undefined;
  const kind = message.details.kind;
  if (kind !== "zob-coms-inbound" && kind !== "zpeer-required-response-reminder") return undefined;
  const msgId = typeof message.details.msgId === "string" ? message.details.msgId.trim() : "";
  if (!msgId) return undefined;
  const taskHash = typeof message.details.taskHash === "string" ? message.details.taskHash.trim() : "";
  return taskHash ? { msgId, taskHash } : undefined;
}

function unansweredInbound(state: HarnessRuntimeState, msgId: string): ZobInboundZpeerMessage | undefined {
  const inbound = state.zobLive.inboundByMsgId?.[msgId];
  if (!inbound || inbound.responseSent || inbound.requiredResponseStatus === "replied") return undefined;
  return inbound;
}

function bindExactInbound(state: HarnessRuntimeState, binding: ZpeerMessageBinding): string | undefined {
  const inbound = unansweredInbound(state, binding.msgId);
  if (!inbound || inbound.requiredResponseStatus === "expired" || inbound.requiredResponseStatus === "cancelled") return undefined;
  if (!inbound.envelope.taskHash || binding.taskHash !== inbound.envelope.taskHash) return undefined;
  const activeMsgId = state.zobLive.activeInboundMsgId;
  const active = activeMsgId ? unansweredInbound(state, activeMsgId) : undefined;
  if (activeMsgId && activeMsgId !== binding.msgId && active?.turnBindingSource === "custom_message") return undefined;
  const now = new Date().toISOString();
  inbound.turnStartedAt ??= now;
  inbound.injectedAt ??= now;
  inbound.turnBindingSource = "custom_message";
  state.zobLive.activeInboundMsgId = binding.msgId;
  return binding.msgId;
}

export function bindZpeerInboundFromMessage(state: HarnessRuntimeState, message: unknown): string | undefined {
  const binding = messageBinding(message);
  return binding ? bindExactInbound(state, binding) : undefined;
}

function inboundBindingMessages(event: unknown): Record<string, unknown>[] {
  const messages = isRecord(event) && Array.isArray(event.messages) ? event.messages : [];
  return messages.filter((message): message is Record<string, unknown> => {
    if (!isRecord(message) || message.customType !== "zob-coms-inbound" || !isRecord(message.details)) return false;
    return message.details.kind === "zob-coms-inbound" || message.details.kind === "zpeer-required-response-reminder";
  });
}

function uniqueAgentEventBindings(event: unknown): ZpeerMessageBinding[] {
  const byMsgId = new Map<string, ZpeerMessageBinding>();
  for (const message of inboundBindingMessages(event)) {
    const binding = messageBinding(message);
    if (binding) byMsgId.set(binding.msgId, binding);
  }
  return [...byMsgId.values()];
}

function eventHasMalformedInboundBinding(event: unknown): boolean {
  return inboundBindingMessages(event).some((message) => !messageBinding(message));
}

function invalidateActiveBindingOnIntegrityFailure(state: HarnessRuntimeState, event: unknown): void {
  const activeMsgId = state.zobLive.activeInboundMsgId;
  if (!activeMsgId) return;
  const active = unansweredInbound(state, activeMsgId);
  if (!active) return;
  for (const message of inboundBindingMessages(event)) {
    const details = isRecord(message.details) ? message.details : undefined;
    const msgId = details && typeof details.msgId === "string" ? details.msgId.trim() : "";
    const taskHash = details && typeof details.taskHash === "string" ? details.taskHash.trim() : "";
    if (msgId === activeMsgId && (!taskHash || taskHash !== active.envelope.taskHash)) {
      active.turnBindingSource = undefined;
      state.zobLive.activeInboundMsgId = undefined;
      return;
    }
  }
}

export function bindZpeerInboundFromAgentEvent(state: HarnessRuntimeState, event: unknown): string | undefined {
  invalidateActiveBindingOnIntegrityFailure(state, event);
  if (eventHasMalformedInboundBinding(event)) return undefined;
  const bindings = uniqueAgentEventBindings(event).filter((binding) => unansweredInbound(state, binding.msgId));
  const activeMsgId = state.zobLive.activeInboundMsgId;
  const active = activeMsgId ? unansweredInbound(state, activeMsgId) : undefined;
  const provenActive = active?.turnBindingSource === "custom_message" ? active : undefined;
  if (bindings.length > 1) return undefined;
  if (bindings.length === 1) {
    if (provenActive && bindings[0].msgId !== activeMsgId) return undefined;
    return bindExactInbound(state, bindings[0]);
  }
  return provenActive ? activeMsgId : undefined;
}

export function bindActiveZpeerInboundToGoal(state: HarnessRuntimeState, goalId: string): string | undefined {
  const activeMsgId = state.zobLive.activeInboundMsgId;
  if (!activeMsgId || !goalId.trim()) return undefined;
  const inbound = unansweredInbound(state, activeMsgId);
  if (!inbound) return undefined;
  inbound.boundGoalId = goalId;
  return activeMsgId;
}

function latestAssistantMessage(event: unknown): Record<string, unknown> | undefined {
  const messages = isRecord(event) && Array.isArray(event.messages) ? event.messages : [];
  return messages.filter((message): message is Record<string, unknown> => isRecord(message) && message.role === "assistant").at(-1);
}

function assistantText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

export function selectZpeerAutoReply(state: HarnessRuntimeState, event: unknown): ZpeerAutoReplyDecision {
  invalidateActiveBindingOnIntegrityFailure(state, event);
  if (eventHasMalformedInboundBinding(event)) return { kind: "none", reason: "ambiguous_inbound" };
  const bindings = uniqueAgentEventBindings(event).filter((binding) => unansweredInbound(state, binding.msgId));
  if (bindings.length > 1) return { kind: "none", reason: "ambiguous_inbound" };
  const activeMsgId = bindZpeerInboundFromAgentEvent(state, event);
  if (!activeMsgId) return { kind: "none", reason: "no_active_inbound" };
  const inbound = unansweredInbound(state, activeMsgId);
  if (!inbound) return { kind: "none", reason: "no_active_inbound" };
  if (inbound.requiredResponseStatus === "expired" || inbound.requiredResponseStatus === "cancelled") return { kind: "none", reason: "expired_inbound" };

  if (inbound.boundGoalId) {
    const goal = state.runtimeGoal;
    if (!goal || goal.goalId !== inbound.boundGoalId) return { kind: "defer", msgId: activeMsgId, reason: "goal_not_terminal" };
    if (goal.status === "active" || goal.status === "ready_for_oracle") return { kind: "defer", msgId: activeMsgId, reason: "goal_active" };
    if (goal.status === "blocked" || goal.status === "paused" || goal.status === "oracle_failed" || goal.status === "budget_limited") {
      return { kind: "error", msgId: activeMsgId, errorCode: "zpeer_task_blocked", errorMessage: "ZPeer task blocked before completion" };
    }
  }

  const assistant = latestAssistantMessage(event);
  if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") return { kind: "none", reason: "assistant_error" };
  const responseText = assistantText(assistant).trim();
  if (!responseText) return { kind: "none", reason: "empty_response" };
  return { kind: "response", msgId: activeMsgId, responseText };
}

export function claimZpeerInboundResponse(
  state: HarnessRuntimeState,
  msgId: string,
  source: "auto" | "tool" | "command" | "watchdog",
): ZobInboundZpeerMessage | undefined {
  const inbound = unansweredInbound(state, msgId);
  if (!inbound || inbound.responseInFlight || inbound.requiredResponseStatus === "expired" || inbound.requiredResponseStatus === "cancelled") return undefined;
  inbound.responseInFlight = true;
  inbound.responseClaimSource = source;
  return inbound;
}

export function releaseZpeerInboundResponseClaim(state: HarnessRuntimeState, msgId: string): void {
  const inbound = state.zobLive.inboundByMsgId?.[msgId];
  if (!inbound || inbound.responseSent) return;
  inbound.responseInFlight = false;
  inbound.responseClaimSource = undefined;
}

export function finalizeZpeerInboundResponseState(
  state: HarnessRuntimeState,
  msgId: string,
  options: { responseSent: boolean; remove: boolean },
): boolean {
  const inbound = state.zobLive.inboundByMsgId?.[msgId];
  if (!inbound || inbound.responseSent || inbound.requiredResponseStatus === "replied") return false;
  if (inbound.watchdogTimer) clearTimeout(inbound.watchdogTimer);
  inbound.watchdogTimer = undefined;
  inbound.responseInFlight = false;
  inbound.responseClaimSource = undefined;
  inbound.responseSent = options.responseSent;
  if (options.responseSent) inbound.requiredResponseStatus = "replied";
  if (state.zobLive.inbound?.envelope.msgId === msgId) state.zobLive.inbound = { ...state.zobLive.inbound, responseSent: options.responseSent };
  if (state.zobLive.activeInboundMsgId === msgId) state.zobLive.activeInboundMsgId = undefined;
  state.zobLive.inboundQueue = (state.zobLive.inboundQueue ?? []).filter((candidate) => candidate !== msgId);
  if (options.remove && state.zobLive.inboundByMsgId) delete state.zobLive.inboundByMsgId[msgId];
  return true;
}
