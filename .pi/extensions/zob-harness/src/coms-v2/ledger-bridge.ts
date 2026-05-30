import type { TeamDefinition } from "../types.js";
import { appendZobComsMessage, replyZobComsMessage, transitionZobComsStatus } from "../topology/coms.js";
import type { ZobLiveEnvelope } from "./envelope.js";

export function appendLiveSendRequestedRef(repoRoot: string, definition: TeamDefinition, envelope: ZobLiveEnvelope): Record<string, unknown> {
  return appendZobComsMessage(repoRoot, definition, {
    runId: envelope.runId ?? "unknown-run",
    sender: envelope.sender ?? definition.orchestrator.id,
    receiver: envelope.receiver ?? definition.orchestrator.id,
    kind: "live_handoff_ref",
    taskId: envelope.msgId,
    taskHash: envelope.taskHash,
    status: "send_requested",
    ack: "not_sent",
    metadata: {
      schema: "zob.coms-live-ref.v1",
      transport: "local_socket",
      liveDelivery: "send_requested",
      hops: envelope.hops,
      transientBodyTransport: true,
      persistBodies: false,
      artifactRefs: envelope.artifactRefs ?? [],
      artifactHashes: envelope.artifactHashes ?? [],
      captureBodyStored: false,
    },
  });
}

export function appendLiveDeliveredStatus(repoRoot: string, msgId: string, actor: string): Record<string, unknown> {
  return transitionZobComsStatus(repoRoot, msgId, actor, "delivered");
}

export function appendLiveRunningStatus(repoRoot: string, msgId: string, actor: string): Record<string, unknown> {
  return transitionZobComsStatus(repoRoot, msgId, actor, "running");
}

export function appendLiveCompletedRef(repoRoot: string, definition: TeamDefinition, parentMsgId: string, envelope: ZobLiveEnvelope): Record<string, unknown> {
  return replyZobComsMessage(repoRoot, definition, parentMsgId, {
    sender: envelope.sender ?? definition.orchestrator.id,
    receiver: envelope.receiver ?? definition.orchestrator.id,
    kind: "live_response_ref",
    taskId: `${envelope.msgId}:response`,
    taskHash: envelope.taskHash,
    outputHash: envelope.outputHash ?? null,
    status: "completed",
    ack: "received",
    metadata: {
      schema: "zob.coms-live-ref.v1",
      transport: "local_socket",
      liveDelivery: "completed",
      hops: envelope.hops,
      transientBodyTransport: true,
      persistBodies: false,
      artifactRefs: envelope.artifactRefs ?? [],
      artifactHashes: envelope.artifactHashes ?? [],
      captureBodyStored: false,
    },
  });
}

export function appendLiveErrorStatus(repoRoot: string, msgId: string, actor: string): Record<string, unknown> {
  return transitionZobComsStatus(repoRoot, msgId, actor, "error");
}

export function appendPeerStaleStatus(repoRoot: string, msgId: string, actor: string): Record<string, unknown> {
  return transitionZobComsStatus(repoRoot, msgId, actor, "stale_blocked");
}
