import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildZobLiveAckEnvelope, type ZobLiveEnvelope } from "../.pi/extensions/zob-harness/src/domains/coms/coms-v2/envelope.js";
import { bindZobLocalEndpoint, makeZobLocalEndpoint } from "../.pi/extensions/zob-harness/src/domains/coms/coms-v2/local-transport.js";
import { registerHarnessEvents } from "../.pi/extensions/zob-harness/src/runtime/events.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class FakePi {
  handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();
  entries: Array<{ type: string; data: unknown }> = [];

  on(name: string, handler: (event: any, ctx: any) => Promise<void> | void) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  appendEntry(type: string, data: unknown) {
    this.entries.push({ type, data });
  }

  sendMessage() {}
  registerTool() {}
  registerCommand() {}
  registerMessageRenderer() {}
}

test("zpeer auto reply: concurrent agent_end handlers send exactly one correlated envelope", async (t) => {
  const endpoint = makeZobLocalEndpoint("zpeer-auto-reply-concurrency");
  const responses: ZobLiveEnvelope[] = [];
  const server = await bindZobLocalEndpoint(endpoint, async (envelope) => {
    responses.push(envelope);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return buildZobLiveAckEnvelope(envelope);
  });
  t.after(() => server.close());

  const inboundEnvelope: ZobLiveEnvelope = {
    schema: "zob.live-envelope.v1",
    type: "prompt",
    msgId: "msg-concurrent",
    runId: "zpeer:test-room",
    sender: "parent",
    receiver: "child",
    team: "zob-core",
    taskHash: hash("short task"),
    replyEndpoint: endpoint,
    hops: 0,
    timestamp: new Date().toISOString(),
    bodyStored: false,
  };
  const state: any = {
    cwd: process.cwd(),
    goalRuntime: {},
    delegationRuns: new Map(),
    zpeerAskHistory: new Map(),
    zpeerForceInterruptHistory: [],
    zpeerUrgentInterruptHistory: [],
    lastZpeerStatuses: [],
    zobLive: {
      inboundQueue: [inboundEnvelope.msgId],
      inboundByMsgId: {
        [inboundEnvelope.msgId]: {
          envelope: inboundEnvelope,
          transientPrompt: "short task",
          receivedAt: new Date().toISOString(),
          repoRoot: process.cwd(),
          responseSent: false,
          reinjectCount: 0,
        },
      },
    },
  };
  const pi = new FakePi();
  const ctx = { cwd: process.cwd(), ui: { notify() {}, setStatus() {} }, isIdle: () => true };
  registerHarnessEvents(pi as never, state);
  const agentEndHandlers = pi.handlers.get("agent_end") ?? [];
  const agentEnd = agentEndHandlers.find((handler) => String(handler).includes("sendInboundZobLiveResponse"));
  assert.ok(agentEnd, `automatic reply agent_end handler missing from ${agentEndHandlers.length} handlers`);
  const event = {
    messages: [
      { role: "custom", customType: "zob-coms-inbound", content: "short task", details: { kind: "zob-coms-inbound", msgId: inboundEnvelope.msgId, taskHash: inboundEnvelope.taskHash } },
      { role: "assistant", content: [{ type: "text", text: "final response" }], stopReason: "stop" },
    ],
  };

  await Promise.all([agentEnd!(event, ctx), agentEnd!(event, ctx)]);
  assert.equal(responses.length, 1, JSON.stringify({ entries: pi.entries, live: state.zobLive }));
  assert.equal(responses[0].replyToMsgId, inboundEnvelope.msgId);
  assert.equal(responses[0].msgId, inboundEnvelope.msgId);
  assert.equal(state.zobLive.inboundByMsgId[inboundEnvelope.msgId], undefined);
});
