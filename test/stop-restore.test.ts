import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assistantMessageHasVisibleOutput,
  createStopRestoreCandidate,
  findStopRestoreUserEntryId,
  markStopRestoreAssistantMessage,
  markStopRestoreToolVisible,
  shouldRestoreStopPrompt,
} from "../.pi/extensions/zob-harness/index.ts";

test("stop restore: restores active prompt when foreground is aborted before assistant output", () => {
  const candidate = createStopRestoreCandidate({ text: "Do the slow thing", source: "interactive", leafId: "leaf-1", nowMs: 1_000 });
  assert.ok(candidate);
  const decision = shouldRestoreStopPrompt(candidate, {
    foregroundAbortRequested: true,
    idleBeforeStop: false,
    pendingMessagesBeforeStop: false,
    nowMs: 2_000,
  });
  assert.equal(decision.restore, true);
  assert.equal(decision.reason, "foreground_aborted_before_assistant_output");
  assert.equal(decision.promptText, "Do the slow thing");
});

test("stop restore: lets Pi own queued-message restoration", () => {
  const candidate = createStopRestoreCandidate({ text: "Do the slow thing", source: "interactive", nowMs: 1_000 });
  const decision = shouldRestoreStopPrompt(candidate, {
    foregroundAbortRequested: true,
    idleBeforeStop: false,
    pendingMessagesBeforeStop: true,
    nowMs: 2_000,
  });
  assert.equal(decision.restore, false);
  assert.equal(decision.reason, "pending_messages_restored_by_pi");
});

test("stop restore: does not restore after assistant text output", () => {
  const candidate = createStopRestoreCandidate({ text: "Do the slow thing", source: "interactive", nowMs: 1_000 });
  markStopRestoreAssistantMessage(candidate, { role: "assistant", content: [{ type: "text", text: "Started" }] });
  const decision = shouldRestoreStopPrompt(candidate, {
    foregroundAbortRequested: true,
    idleBeforeStop: false,
    pendingMessagesBeforeStop: false,
    nowMs: 2_000,
  });
  assert.equal(decision.restore, false);
  assert.equal(decision.reason, "assistant_output_observed");
  assert.equal(decision.assistantOutputObserved, true);
});

test("stop restore: treats tool calls and tool execution as visible output", () => {
  assert.equal(assistantMessageHasVisibleOutput({ role: "assistant", content: [{ type: "toolCall", id: "1", name: "read" }] }), true);
  const candidate = createStopRestoreCandidate({ text: "Do the slow thing", source: "interactive", nowMs: 1_000 });
  markStopRestoreToolVisible(candidate);
  const decision = shouldRestoreStopPrompt(candidate, {
    foregroundAbortRequested: true,
    idleBeforeStop: false,
    pendingMessagesBeforeStop: false,
    nowMs: 2_000,
  });
  assert.equal(decision.restore, false);
  assert.equal(decision.reason, "assistant_output_observed");
});

test("stop restore: ignores slash commands, extension inputs, and queued streaming inputs", () => {
  assert.equal(createStopRestoreCandidate({ text: "/zstatus", source: "interactive" }), undefined);
  assert.equal(createStopRestoreCandidate({ text: "internal", source: "extension" }), undefined);
  assert.equal(createStopRestoreCandidate({ text: "queued", source: "interactive", streamingBehavior: "followUp" }), undefined);
});

test("stop restore: finds the active user entry for checkpoint rewind", () => {
  const candidate = createStopRestoreCandidate({ text: "Do the slow thing", source: "interactive", leafId: "checkpoint", nowMs: 1_000 });
  assert.ok(candidate);
  const entries = [
    { type: "message", id: "old", parentId: "checkpoint", message: { role: "user", content: [{ type: "text", text: "Older branch" }] } },
    { type: "message", id: "target", parentId: "checkpoint", message: { role: "user", content: [{ type: "text", text: "Do the slow thing" }] } },
    { type: "message", id: "assistant", parentId: "target", message: { role: "assistant", content: [{ type: "text", text: "Operation aborted" }] } },
  ];
  assert.equal(findStopRestoreUserEntryId(candidate, entries), "target");
});

test("stop restore: supports root checkpoint rewinds via the user entry", () => {
  const candidate = createStopRestoreCandidate({ text: "First message", source: "interactive", leafId: null, nowMs: 1_000 });
  assert.ok(candidate);
  const entries = [
    { type: "message", id: "first-user", parentId: null, message: { role: "user", content: [{ type: "text", text: "First message" }] } },
  ];
  assert.equal(findStopRestoreUserEntryId(candidate, entries), "first-user");
});
