import { strict as assert } from "node:assert";
import { test } from "node:test";

import { hasPendingUndeliveredZpeerInbound } from "../.pi/extensions/zob-harness/index.ts";

// Regression for end-of-session ZPeer body starvation: an inbound ZPeer prompt
// whose transient body has not yet been delivered to a turn must suppress the
// goal-continuation loop so the body (deliverAs "followUp") can reach a turn slot
// instead of being starved forever by the continuously re-arming continuation.
// The helper only reads state.zobLive.inboundQueue / inboundByMsgId, so a minimal
// cast object is sufficient and keeps the test decoupled from internal types.
type InboundLike = { responseSent: boolean; turnStartedAt?: string };
type StateLike = { zobLive: { inboundQueue?: string[]; inboundByMsgId?: Record<string, InboundLike> } };

function stateWith(queue: string[], byMsgId: Record<string, InboundLike>): unknown {
  return { zobLive: { inboundQueue: queue, inboundByMsgId: byMsgId } };
}

test("zpeer inbound continuation suppression: pending undelivered inbound blocks continuation", () => {
  const state = stateWith(["msg-1"], { "msg-1": { responseSent: false } });
  assert.equal(hasPendingUndeliveredZpeerInbound(state as never), true);
});

test("zpeer inbound continuation suppression: inbound that started a turn no longer blocks", () => {
  const state = stateWith(["msg-1"], { "msg-1": { responseSent: false, turnStartedAt: "2026-07-13T15:03:00.000Z" } });
  assert.equal(hasPendingUndeliveredZpeerInbound(state as never), false);
});

test("zpeer inbound continuation suppression: answered inbound does not block", () => {
  const state = stateWith(["msg-1"], { "msg-1": { responseSent: true } });
  assert.equal(hasPendingUndeliveredZpeerInbound(state as never), false);
});

test("zpeer inbound continuation suppression: empty/absent queue does not block", () => {
  assert.equal(hasPendingUndeliveredZpeerInbound({ zobLive: {} } as never), false);
  assert.equal(hasPendingUndeliveredZpeerInbound({ zobLive: { inboundQueue: [], inboundByMsgId: {} } } as never), false);
});

test("zpeer inbound continuation suppression: one pending among several blocks until all start", () => {
  const state = stateWith(
    ["msg-1", "msg-2", "msg-3"],
    {
      "msg-1": { responseSent: false, turnStartedAt: "2026-07-13T15:03:00.000Z" },
      "msg-2": { responseSent: true },
      "msg-3": { responseSent: false },
    },
  );
  assert.equal(hasPendingUndeliveredZpeerInbound(state as never), true);
});

test("zpeer inbound continuation suppression: all started/answered clears the block", () => {
  const state = stateWith(
    ["msg-1", "msg-2"],
    {
      "msg-1": { responseSent: false, turnStartedAt: "2026-07-13T15:03:00.000Z" },
      "msg-2": { responseSent: true },
    },
  );
  assert.equal(hasPendingUndeliveredZpeerInbound(state as never), false);
});
