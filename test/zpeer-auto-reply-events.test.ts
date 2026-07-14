import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildZobLiveAckEnvelope, type ZobLiveEnvelope } from "../.pi/extensions/zob-harness/src/domains/coms/coms-v2/envelope.js";
import { bindZobLocalEndpoint, makeZobLocalEndpoint } from "../.pi/extensions/zob-harness/src/domains/coms/coms-v2/local-transport.js";
import { registerHarnessEvents } from "../.pi/extensions/zob-harness/src/runtime/events.js";

function taskHash(msgId: string): string {
  return createHash("sha256").update(`prompt-${msgId}`).digest("hex");
}

function inbound(msgId: string, replyEndpoint: string) {
  return {
    envelope: {
      schema: "zob.live-envelope.v1" as const,
      type: "prompt" as const,
      hops: 0,
      msgId,
      runId: "zpeer:test-room",
      sender: "parent",
      receiver: "child",
      taskHash: taskHash(msgId),
      transientPrompt: `prompt-${msgId}`,
      replyEndpoint,
    },
    receivedAt: "2026-07-14T00:00:00.000Z",
    responseSent: false,
    priority: "normal" as const,
    interruptMode: "none" as const,
    repoRoot: ".",
  };
}

function customInboundMessage(msgId: string) {
  return {
    role: "custom",
    customType: "zob-coms-inbound",
    content: `prompt-${msgId}`,
    details: { kind: "zob-coms-inbound", msgId, taskHash: taskHash(msgId) },
  };
}

function assistant(text: string, stopReason = "stop") {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

function eventHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerMessageRenderer() {},
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
  };
  return { handlers, sentMessages, entries, pi };
}

test("zpeer runtime events: agent_end sends one exact msgId-correlated automatic response", async (t) => {
  const msgId = `auto-reply-${Date.now()}`;
  const endpoint = makeZobLocalEndpoint(`${msgId}-${Math.random()}`);
  const received: ZobLiveEnvelope[] = [];
  const server = await bindZobLocalEndpoint(endpoint, async (envelope) => {
    received.push(envelope);
    return buildZobLiveAckEnvelope(envelope);
  });
  t.after(() => server.close());

  const currentInbound = inbound(msgId, endpoint);
  const state = {
    zobLive: {
      inbound: { envelope: currentInbound.envelope, receivedAt: currentInbound.receivedAt, responseSent: false, repoRoot: "." },
      inboundByMsgId: { [msgId]: currentInbound },
      inboundQueue: [msgId],
      activeInboundMsgId: undefined,
    },
    runtimeGoal: undefined,
  };
  const harness = eventHarness();
  registerHarnessEvents(harness.pi as never, state as never);
  const agentEnd = harness.handlers.get("agent_end")?.at(-1);
  assert.ok(agentEnd, "agent_end handler must be registered");

  await agentEnd({ messages: [customInboundMessage(msgId), assistant("final automatic response")] }, {});

  assert.equal(received.length, 1, JSON.stringify(harness.entries));
  assert.equal(received[0].type, "response");
  assert.equal(received[0].msgId, msgId);
  assert.equal(received[0].replyToMsgId, msgId);
  assert.equal(received[0].transientResponse, "final automatic response");
  assert.equal(state.zobLive.inboundByMsgId[msgId], undefined);
  assert.deepEqual(state.zobLive.inboundQueue, []);
  assert.equal(state.zobLive.activeInboundMsgId, undefined);

  const durable = harness.entries.find((entry) => (entry.data as { schema?: string }).schema === "zob.zpeer-auto-reply.v1");
  assert.ok(durable, "automatic response must append body-free evidence");
  assert.equal((durable!.data as { bodyStored?: boolean }).bodyStored, false);
  assert.equal(JSON.stringify(durable!.data).includes("final automatic response"), false);
  assert.ok(harness.sentMessages.some(({ message, options }) =>
    (message as { details?: { msgId?: string } }).details?.msgId === msgId
      && (options as { triggerTurn?: boolean; deliverAs?: string }).triggerTurn === false
      && (options as { deliverAs?: string }).deliverAs === "nextTurn"));
});

test("zpeer runtime events: failed provider output does not send a success envelope", async (t) => {
  const msgId = `auto-error-${Date.now()}`;
  const endpoint = makeZobLocalEndpoint(`${msgId}-${Math.random()}`);
  const received: ZobLiveEnvelope[] = [];
  const server = await bindZobLocalEndpoint(endpoint, async (envelope) => {
    received.push(envelope);
    return buildZobLiveAckEnvelope(envelope);
  });
  t.after(() => server.close());

  const currentInbound = inbound(msgId, endpoint);
  const state = {
    zobLive: {
      inboundByMsgId: { [msgId]: currentInbound },
      inboundQueue: [msgId],
      activeInboundMsgId: undefined,
    },
    runtimeGoal: undefined,
  };
  const harness = eventHarness();
  registerHarnessEvents(harness.pi as never, state as never);
  const agentEnd = harness.handlers.get("agent_end")?.at(-1);
  assert.ok(agentEnd);

  await agentEnd({ messages: [customInboundMessage(msgId), assistant("partial output", "error")] }, {});

  assert.equal(received.length, 0);
  assert.equal(currentInbound.responseSent, false);
  assert.deepEqual(state.zobLive.inboundQueue, [msgId]);
});
