import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildZobLiveAckEnvelope, type ZobLiveEnvelope } from "../.pi/extensions/zob-harness/src/domains/coms/coms-v2/envelope.js";
import { bindZobLocalEndpoint, makeZobLocalEndpoint } from "../.pi/extensions/zob-harness/src/domains/coms/coms-v2/local-transport.js";
import { registerHarnessEvents } from "../.pi/extensions/zob-harness/src/runtime/events.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerMessageRenderer() {},
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
    sendMessage() {},
  };
  return { handlers, entries, pi };
}

function stateFor(msgId: string, endpoint: string, goalStatus: string) {
  const envelope = {
    schema: "zob.live-envelope.v1" as const,
    type: "prompt" as const,
    hops: 0,
    msgId,
    runId: "zpeer:test-room",
    sender: "parent",
    receiver: "child",
    taskHash: hash(`prompt-${msgId}`),
    transientPrompt: `prompt-${msgId}`,
    replyEndpoint: endpoint,
  };
  const inbound = {
    envelope,
    receivedAt: "2026-07-14T00:00:00.000Z",
    turnStartedAt: "2026-07-14T00:00:01.000Z",
    turnBindingSource: "custom_message" as const,
    responseSent: false,
    priority: "normal" as const,
    interruptMode: "none" as const,
    repoRoot: ".",
    boundGoalId: "goal-1",
  };
  return {
    zobLive: {
      inbound: { envelope, receivedAt: inbound.receivedAt, responseSent: false, repoRoot: "." },
      inboundByMsgId: { [msgId]: inbound },
      inboundQueue: [msgId],
      activeInboundMsgId: msgId,
    },
    runtimeGoal: { goalId: "goal-1", status: goalStatus, oracle: { blockerSummary: goalStatus === "blocked" ? "provider error" : undefined } },
  };
}

function assistant(text: string, stopReason = "stop") {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

test("zpeer goal auto reply: active goal defers, complete goal sends final response exactly once", async (t) => {
  const msgId = `goal-complete-${Date.now()}`;
  const endpoint = makeZobLocalEndpoint(`${msgId}-${Math.random()}`);
  const received: ZobLiveEnvelope[] = [];
  const server = await bindZobLocalEndpoint(endpoint, async (envelope) => {
    received.push(envelope);
    return buildZobLiveAckEnvelope(envelope);
  });
  t.after(() => server.close());

  const state = stateFor(msgId, endpoint, "active");
  const harness = eventHarness();
  registerHarnessEvents(harness.pi as never, state as never);
  const agentEnd = harness.handlers.get("agent_end")?.at(-1);
  assert.ok(agentEnd);

  await agentEnd({ messages: [assistant("intermediate")] }, {});
  assert.equal(received.length, 0);
  assert.equal(state.zobLive.activeInboundMsgId, msgId);

  state.runtimeGoal.status = "complete";
  await agentEnd({ messages: [assistant("final goal result")] }, {});
  await agentEnd({ messages: [assistant("duplicate final result")] }, {});

  assert.equal(received.length, 1);
  assert.equal(received[0].type, "response");
  assert.equal(received[0].msgId, msgId);
  assert.equal(received[0].replyToMsgId, msgId);
  assert.equal(received[0].transientResponse, "final goal result");
});

test("zpeer goal auto reply: blocked goal sends one correlated terminal error", async (t) => {
  const msgId = `goal-blocked-${Date.now()}`;
  const endpoint = makeZobLocalEndpoint(`${msgId}-${Math.random()}`);
  const received: ZobLiveEnvelope[] = [];
  const server = await bindZobLocalEndpoint(endpoint, async (envelope) => {
    received.push(envelope);
    return buildZobLiveAckEnvelope(envelope);
  });
  t.after(() => server.close());

  const state = stateFor(msgId, endpoint, "blocked");
  const harness = eventHarness();
  registerHarnessEvents(harness.pi as never, state as never);
  const agentEnd = harness.handlers.get("agent_end")?.at(-1);
  assert.ok(agentEnd);

  await agentEnd({ messages: [assistant("", "error")] }, {});

  assert.equal(received.length, 1);
  assert.equal(received[0].type, "error");
  assert.equal(received[0].msgId, msgId);
  assert.equal(received[0].errorCode, "zpeer_task_blocked");
  assert.equal(state.zobLive.inboundByMsgId[msgId], undefined);
  const durable = harness.entries.find((entry) => (entry.data as { action?: string }).action === "terminal_error");
  assert.ok(durable);
  assert.equal((durable!.data as { bodyStored?: boolean }).bodyStored, false);
  assert.equal(JSON.stringify(durable!.data).includes("provider error"), false);
});
