import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  bindActiveZpeerInboundToGoal,
  bindZpeerInboundFromAgentEvent,
  bindZpeerInboundFromMessage,
  claimZpeerInboundResponse,
  finalizeZpeerInboundResponseState,
  releaseZpeerInboundResponseClaim,
  selectZpeerAutoReply,
} from "../.pi/extensions/zob-harness/src/runtime/zpeer-auto-reply.js";

function inbound(msgId: string, taskHash = `hash-${msgId}`) {
  return {
    envelope: {
      schema: "zob.live-envelope.v1" as const,
      type: "prompt" as const,
      msgId,
      runId: "zpeer:test-room",
      sender: "parent",
      receiver: "child",
      taskHash,
      transientPrompt: `prompt-${msgId}`,
      replyEndpoint: `/tmp/${msgId}.sock`,
    },
    receivedAt: "2026-07-14T00:00:00.000Z",
    responseSent: false,
    priority: "normal" as const,
    interruptMode: "none" as const,
    repoRoot: ".",
  };
}

function stateWith(...msgIds: string[]) {
  return {
    zobLive: {
      inboundByMsgId: Object.fromEntries(msgIds.map((msgId) => [msgId, inbound(msgId)])),
      inboundQueue: [...msgIds],
      activeInboundMsgId: undefined as string | undefined,
    },
    runtimeGoal: undefined as undefined | { goalId: string; status: string; oracle?: { blockerSummary?: string } },
  };
}

function customInboundMessage(msgId: string, taskHash = `hash-${msgId}`) {
  return {
    role: "custom",
    customType: "zob-coms-inbound",
    content: `prompt-${msgId}`,
    details: { kind: "zob-coms-inbound", msgId, taskHash },
  };
}

function assistant(text: string, stopReason = "stop") {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

test("zpeer auto reply: exact custom-message msgId binds without relying on event.prompt", () => {
  const state = stateWith("msg-1");

  assert.equal(bindZpeerInboundFromMessage(state as never, customInboundMessage("msg-1")), "msg-1");
  assert.equal(state.zobLive.activeInboundMsgId, "msg-1");
  assert.equal(state.zobLive.inboundByMsgId["msg-1"].turnStartedAt !== undefined, true);
});

test("zpeer auto reply: taskHash mismatch and unknown msgId fail closed", () => {
  const state = stateWith("msg-1");

  assert.equal(bindZpeerInboundFromMessage(state as never, customInboundMessage("msg-1", "wrong-hash")), undefined);
  assert.equal(bindZpeerInboundFromMessage(state as never, customInboundMessage("missing")), undefined);
  assert.equal(state.zobLive.activeInboundMsgId, undefined);
});

test("zpeer auto reply: proven active binding still rejects missing or mismatched taskHash events", () => {
  const state = stateWith("msg-1");
  assert.equal(bindZpeerInboundFromMessage(state as never, customInboundMessage("msg-1")), "msg-1");

  assert.deepEqual(selectZpeerAutoReply(state as never, {
    messages: [customInboundMessage("msg-1", "wrong-hash"), assistant("wrongly selected")],
  }), { kind: "none", reason: "no_active_inbound" });
  assert.equal(state.zobLive.activeInboundMsgId, undefined);
  assert.equal(bindZpeerInboundFromMessage(state as never, customInboundMessage("msg-1")), "msg-1");

  const missingHash = customInboundMessage("msg-1") as { details: { taskHash?: string } };
  delete missingHash.details.taskHash;
  assert.deepEqual(selectZpeerAutoReply(state as never, {
    messages: [missingHash, assistant("selected without hash")],
  }), { kind: "none", reason: "ambiguous_inbound" });
  assert.equal(state.zobLive.activeInboundMsgId, undefined);
});

test("zpeer auto reply: agent_end fallback binds one exact custom inbound and returns its final text", () => {
  const state = stateWith("msg-1");
  const event = { messages: [customInboundMessage("msg-1"), assistant("final answer")] };

  assert.equal(bindZpeerInboundFromAgentEvent(state as never, event), "msg-1");
  assert.deepEqual(selectZpeerAutoReply(state as never, event), {
    kind: "response",
    msgId: "msg-1",
    responseText: "final answer",
  });
});

test("zpeer auto reply: multiple unanswered custom inbounds are ambiguous and do not bind", () => {
  const state = stateWith("msg-1", "msg-2");
  const event = {
    messages: [customInboundMessage("msg-1"), customInboundMessage("msg-2"), assistant("ambiguous answer")],
  };

  assert.equal(bindZpeerInboundFromAgentEvent(state as never, event), undefined);
  assert.equal(state.zobLive.activeInboundMsgId, undefined);
  assert.deepEqual(selectZpeerAutoReply(state as never, event), { kind: "none", reason: "ambiguous_inbound" });
});

test("zpeer auto reply: taskHash-only legacy activation cannot consume an unrelated assistant result", () => {
  const state = stateWith("msg-1");
  state.zobLive.activeInboundMsgId = "msg-1";
  state.zobLive.inboundByMsgId["msg-1"].turnStartedAt = "2026-07-14T00:00:01.000Z";

  assert.deepEqual(selectZpeerAutoReply(state as never, { messages: [assistant("unbound assistant result")] }), {
    kind: "none",
    reason: "no_active_inbound",
  });
  assert.equal(state.zobLive.inboundByMsgId["msg-1"].responseSent, false);
});

test("zpeer auto reply: response transport uses one atomic in-flight claim", () => {
  const state = stateWith("msg-1");
  bindZpeerInboundFromMessage(state as never, customInboundMessage("msg-1"));

  assert.ok(claimZpeerInboundResponse(state as never, "msg-1", "auto"));
  assert.equal(claimZpeerInboundResponse(state as never, "msg-1", "tool"), undefined);
  assert.equal(state.zobLive.inboundByMsgId["msg-1"].responseClaimSource, "auto");

  releaseZpeerInboundResponseClaim(state as never, "msg-1");
  assert.ok(claimZpeerInboundResponse(state as never, "msg-1", "tool"));
  assert.equal(state.zobLive.inboundByMsgId["msg-1"].responseClaimSource, "tool");
});

test("zpeer auto reply: provider error with partial text never becomes a success response", () => {
  const state = stateWith("msg-1");
  bindZpeerInboundFromMessage(state as never, customInboundMessage("msg-1"));

  assert.deepEqual(selectZpeerAutoReply(state as never, { messages: [assistant("partial", "error")] }), {
    kind: "none",
    reason: "assistant_error",
  });
  assert.equal(state.zobLive.inboundByMsgId["msg-1"].responseSent, false);
});

test("zpeer auto reply: goal-bound inbound defers while active and replies only when complete", () => {
  const state = stateWith("msg-1");
  bindZpeerInboundFromMessage(state as never, customInboundMessage("msg-1"));
  assert.equal(bindActiveZpeerInboundToGoal(state as never, "goal-1"), "msg-1");

  state.runtimeGoal = { goalId: "goal-1", status: "active" };
  assert.deepEqual(selectZpeerAutoReply(state as never, { messages: [assistant("intermediate")] }), {
    kind: "defer",
    msgId: "msg-1",
    reason: "goal_active",
  });

  state.runtimeGoal.status = "complete";
  assert.deepEqual(selectZpeerAutoReply(state as never, { messages: [assistant("goal complete")] }), {
    kind: "response",
    msgId: "msg-1",
    responseText: "goal complete",
  });
});

test("zpeer auto reply: blocked goal produces a correlated terminal error decision", () => {
  const state = stateWith("msg-1");
  bindZpeerInboundFromMessage(state as never, customInboundMessage("msg-1"));
  bindActiveZpeerInboundToGoal(state as never, "goal-1");
  state.runtimeGoal = { goalId: "goal-1", status: "blocked", oracle: { blockerSummary: "provider error" } };

  assert.deepEqual(selectZpeerAutoReply(state as never, { messages: [assistant("", "error")] }), {
    kind: "error",
    msgId: "msg-1",
    errorCode: "zpeer_task_blocked",
    errorMessage: "ZPeer task blocked before completion",
  });
});

test("zpeer auto reply: finalization is idempotent and never clears another active msgId", () => {
  const state = stateWith("msg-1", "msg-2");
  state.zobLive.activeInboundMsgId = "msg-2";

  assert.equal(finalizeZpeerInboundResponseState(state as never, "msg-1", { responseSent: true, remove: true }), true);
  assert.equal(finalizeZpeerInboundResponseState(state as never, "msg-1", { responseSent: true, remove: true }), false);
  assert.equal(state.zobLive.activeInboundMsgId, "msg-2");
  assert.deepEqual(state.zobLive.inboundQueue, ["msg-2"]);
  assert.equal(state.zobLive.inboundByMsgId["msg-1"], undefined);
});
