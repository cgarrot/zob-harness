import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildZobLiveAckEnvelope, buildZobLiveErrorEnvelope, type ZobLiveEnvelope } from "../.pi/extensions/zob-harness/src/domains/coms/coms-v2/envelope.js";
import { bindZobLocalEndpoint, makeZobLocalEndpoint } from "../.pi/extensions/zob-harness/src/domains/coms/coms-v2/local-transport.js";
import { scheduleZpeerRequiredResponseWatchdog } from "../.pi/extensions/zob-harness/src/runtime/events.js";
import { claimZpeerInboundResponse, releaseZpeerInboundResponseClaim } from "../.pi/extensions/zob-harness/src/runtime/zpeer-auto-reply.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for watchdog state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function watchdogState(msgId: string, replyEndpoint: string) {
  const envelope: ZobLiveEnvelope = {
    schema: "zob.live-envelope.v1",
    type: "prompt",
    msgId,
    runId: "zpeer:test-room",
    sender: "parent",
    receiver: "child",
    taskHash: hash(`prompt-${msgId}`),
    transientPrompt: `prompt-${msgId}`,
    replyEndpoint,
    requireResponse: true,
    responseRequiredBy: new Date(Date.now() + 25).toISOString(),
    responseTimeoutMs: 1_000,
    maxReinjects: 0,
    hops: 0,
    timestamp: new Date().toISOString(),
    bodyStored: false,
  };
  const inbound: any = {
    envelope,
    receivedAt: new Date().toISOString(),
    turnStartedAt: new Date().toISOString(),
    turnBindingSource: "custom_message",
    responseSent: false,
    priority: "normal",
    interruptMode: "none",
    repoRoot: process.cwd(),
    requireResponse: true,
    responseRequiredBy: envelope.responseRequiredBy,
    responseTimeoutMs: 1_000,
    reinjectCount: 0,
    maxReinjects: 0,
    requiredResponseStatus: "owed",
  };
  const state: any = {
    zobLive: {
      inboundByMsgId: { [msgId]: inbound },
      inboundQueue: [msgId],
      activeInboundMsgId: msgId,
    },
  };
  return { state, inbound };
}

function fakePi() {
  const entries: Array<{ type: string; data: any }> = [];
  return {
    entries,
    pi: {
      appendEntry(type: string, data: any) { entries.push({ type, data }); },
      sendMessage() {},
    },
  };
}

test("zpeer watchdog: response claim remains held until delayed ACK", async (t) => {
  const endpoint = makeZobLocalEndpoint(`zpeer-watchdog-delay-${Date.now()}`);
  const received = deferred<ZobLiveEnvelope>();
  const releaseAck = deferred<void>();
  const server = await bindZobLocalEndpoint(endpoint, async (envelope) => {
    received.resolve(envelope);
    await releaseAck.promise;
    return buildZobLiveAckEnvelope(envelope);
  });
  t.after(() => server.close());
  const { state, inbound } = watchdogState("watchdog-delay", endpoint);
  const harness = fakePi();

  scheduleZpeerRequiredResponseWatchdog(harness.pi as never, state, inbound);
  const errorEnvelope = await received.promise;
  assert.equal(errorEnvelope.type, "error");
  assert.equal(inbound.responseInFlight, true);
  assert.equal(inbound.responseClaimSource, "watchdog");
  assert.equal(claimZpeerInboundResponse(state, inbound.envelope.msgId, "auto"), undefined);

  releaseAck.resolve();
  await waitFor(() => inbound.requiredResponseStatus === "expired");
  assert.equal(inbound.responseInFlight, false);
  assert.equal(state.zobLive.activeInboundMsgId, undefined);
});

test("zpeer watchdog: retryable transport failure releases claim before bounded retry", async (t) => {
  const endpoint = makeZobLocalEndpoint(`zpeer-watchdog-fail-${Date.now()}`);
  const server = await bindZobLocalEndpoint(endpoint, async (envelope) =>
    buildZobLiveErrorEnvelope(envelope, "test transport failure", "test_failure"));
  t.after(() => server.close());
  const { state, inbound } = watchdogState("watchdog-fail", endpoint);
  const harness = fakePi();

  scheduleZpeerRequiredResponseWatchdog(harness.pi as never, state, inbound);
  await waitFor(() => harness.entries.some(({ data }) => data.action === "expire_transport_error"));
  if (inbound.watchdogTimer) clearTimeout(inbound.watchdogTimer);

  assert.equal(inbound.responseInFlight, false);
  assert.equal(inbound.requiredResponseStatus, "owed");
  assert.equal(inbound.watchdogTransportFailures, 1);
  assert.ok(inbound.watchdogRetryAt);
  assert.equal(claimZpeerInboundResponse(state, inbound.envelope.msgId, "auto")?.envelope.msgId, inbound.envelope.msgId);
  releaseZpeerInboundResponseClaim(state, inbound.envelope.msgId);
});
