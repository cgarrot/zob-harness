import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GOAL_MUTATION_RECEIPT_ENTRY_TYPE,
  canonicalGoalMutationJson,
  createGoalMutationPreparation,
  createGoalMutationReceipt,
  createGoalMutationReceiptState,
  evaluateGoalMutationCas,
  hashGoalMutationRequest,
  restoreGoalMutationReceiptsFromBranch,
  restoreGoalTodosFromBranch,
} from "../.pi/extensions/zob-harness/index.ts";
import type {
  GoalMutationGuard,
  GoalMutationReceipt,
  GoalMutationReceiptInput,
} from "../.pi/extensions/zob-harness/index.ts";

function receipt(overrides: Partial<GoalMutationReceiptInput> = {}): GoalMutationReceipt {
  return createGoalMutationReceipt({
    goalId: "goal-a",
    guard: {
      mutationId: "mutation-1",
      requestHash: hashGoalMutationRequest({ action: "patch", values: [1, 2] }),
      expectedGoalRevision: 3,
      expectedGraphRevision: 5,
      todoId: "todo-a",
      expectedTodoRevision: 2,
    },
    appliedRevisions: { goalRevision: 4, graphRevision: 6, todoRevision: 3 },
    appliedAt: 100,
    eventCount: 2,
    ...overrides,
  });
}

function receiptEntry(value: unknown): Record<string, unknown> {
  return { customType: GOAL_MUTATION_RECEIPT_ENTRY_TYPE, data: value };
}

function phaseEntry(value: unknown): Record<string, unknown> {
  return { customType: GOAL_MUTATION_PREPARATION_ENTRY_TYPE, data: value };
}

function preparedFor(value: GoalMutationReceipt, recordedAt = value.appliedAt - 1) {
  return createGoalMutationPreparation({
    phase: "prepared",
    goalId: value.goalId,
    mutationId: value.mutationId,
    requestHash: value.requestHash,
    recordedAt,
  });
}

test("canonical Goal mutation JSON sorts object keys recursively and preserves values and array order", () => {
  assert.equal(
    canonicalGoalMutationJson({ z: " keep ", a: { y: 2, x: 1 }, list: [3, { b: true, a: false }] }),
    '{"a":{"x":1,"y":2},"list":[3,{"a":false,"b":true}],"z":" keep "}',
  );
  assert.equal(
    hashGoalMutationRequest({ b: 2, a: 1 }),
    hashGoalMutationRequest({ a: 1, b: 2 }),
  );
  assert.notEqual(hashGoalMutationRequest({ values: [1, 2] }), hashGoalMutationRequest({ values: [2, 1] }));
  assert.notEqual(hashGoalMutationRequest({ value: " x " }), hashGoalMutationRequest({ value: "x" }));
  assert.throws(() => canonicalGoalMutationJson({ value: undefined }), /valid canonical JSON/i);
  assert.throws(() => canonicalGoalMutationJson({ value: Number.NaN }), /finite JSON number/i);
});

test("fresh canonical mutation passes CAS without mutating revisions or receipt indexes", () => {
  const request = { action: "patch", values: [1, 2] };
  const guard: GoalMutationGuard = {
    mutationId: "mutation-1",
    requestHash: hashGoalMutationRequest(request),
    expectedGoalRevision: 3,
    expectedGraphRevision: 5,
    todoId: "todo-a",
    expectedTodoRevision: 2,
  };
  const receipts = createGoalMutationReceiptState();
  const current = { goalRevision: 3, graphRevision: 5, todoRevisions: { "todo-a": 2 } };
  const before = JSON.stringify({ receipts, current });

  const outcome = evaluateGoalMutationCas({ goalId: "goal-a", guard, request, current, receipts });

  assert.equal(outcome.status, "applied");
  assert.equal(outcome.shouldApply, true);
  assert.equal(outcome.emitEvents, true);
  assert.deepEqual(outcome.failureCodes, []);
  assert.equal(JSON.stringify({ receipts, current }), before);
});

test("same mutation id and request hash replays the original receipt before stale checks and emits no events", () => {
  const original = receipt();
  const receipts = restoreGoalMutationReceiptsFromBranch([phaseEntry(preparedFor(original)), receiptEntry(original)]);
  const request = { values: [1, 2], action: "patch" };
  const outcome = evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: {
      mutationId: original.mutationId,
      requestHash: original.requestHash,
      expectedGoalRevision: 0,
      expectedGraphRevision: 0,
      todoId: "todo-a",
      expectedTodoRevision: 0,
    },
    request,
    current: { goalRevision: 4, graphRevision: 6, todoRevisions: { "todo-a": 3 } },
    receipts,
  });

  assert.equal(outcome.status, "replayed");
  assert.equal(outcome.shouldApply, false);
  assert.equal(outcome.emitEvents, false);
  assert.deepEqual(outcome.receipt, original);
  assert.notEqual(outcome.receipt, original);
});

test("same mutation id with a different canonical request hash conflicts", () => {
  const original = receipt();
  const receipts = restoreGoalMutationReceiptsFromBranch([phaseEntry(preparedFor(original)), receiptEntry(original)]);
  const request = { action: "patch", values: [2, 1] };
  const outcome = evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: { mutationId: original.mutationId, requestHash: hashGoalMutationRequest(request) },
    request,
    current: {},
    receipts,
  });

  assert.equal(outcome.status, "conflict");
  assert.equal(outcome.shouldApply, false);
  assert.equal(outcome.emitEvents, false);
  assert.deepEqual(outcome.failureCodes, ["mutation_id_conflict"]);
});

test("new mutation with stale goal, graph, and TODO revisions fails closed without state advancement", () => {
  const request = { action: "patch" };
  const receipts = createGoalMutationReceiptState();
  const current = { goalRevision: 4, graphRevision: 6, todoRevisions: { "todo-a": 3 } };
  const before = JSON.stringify({ receipts, current });
  const outcome = evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: {
      mutationId: "mutation-stale",
      requestHash: hashGoalMutationRequest(request),
      expectedGoalRevision: 3,
      expectedGraphRevision: 5,
      todoId: "todo-a",
      expectedTodoRevision: 2,
    },
    request,
    current,
    receipts,
  });

  assert.equal(outcome.status, "stale");
  assert.equal(outcome.shouldApply, false);
  assert.equal(outcome.emitEvents, false);
  assert.deepEqual(outcome.failureCodes, ["stale_goal_revision", "stale_graph_revision", "stale_todo_revision"]);
  assert.equal(JSON.stringify({ receipts, current }), before);
});

test("non-canonical mutation guards and mismatched request hashes reject without receipts", () => {
  const request = { action: "patch" };
  const invalidId = evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: { mutationId: " mutation-1 ", requestHash: hashGoalMutationRequest(request) },
    request,
    current: {},
  });
  assert.equal(invalidId.status, "rejected");
  assert.deepEqual(invalidId.failureCodes, ["invalid_mutation_id"]);

  const mismatch = evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: { mutationId: "mutation-1", requestHash: "0".repeat(64) },
    request,
    current: {},
  });
  assert.equal(mismatch.status, "rejected");
  assert.deepEqual(mismatch.failureCodes, ["request_hash_mismatch"]);
});

test("receipt restore is deterministic and poisons only malformed or conflicting goal streams", () => {
  const original = receipt();
  const other = receipt({
    goalId: "goal-b",
    guard: { mutationId: "mutation-b", requestHash: hashGoalMutationRequest({ action: "add" }) },
    appliedRevisions: { graphRevision: 1 },
    appliedAt: 200,
    eventCount: 1,
  });
  const conflicting = { ...original, graphRevision: 99 };
  const laterIgnored = receipt({
    guard: { mutationId: "mutation-later", requestHash: hashGoalMutationRequest({ action: "later" }) },
    appliedRevisions: { graphRevision: 7 },
  });
  const entries = [
    phaseEntry(preparedFor(original)),
    receiptEntry(original),
    receiptEntry({ ...original }),
    phaseEntry(preparedFor(other)),
    receiptEntry(other),
    receiptEntry(conflicting),
    phaseEntry(preparedFor(laterIgnored)),
    receiptEntry(laterIgnored),
    receiptEntry({ ...other, goalId: "goal-c", mutationId: " bad " }),
  ];

  const first = restoreGoalMutationReceiptsFromBranch(entries);
  const second = restoreGoalMutationReceiptsFromBranch(entries);

  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.byGoal).sort(), ["goal-a", "goal-b"]);
  assert.deepEqual(Object.keys(first.byGoal["goal-a"] ?? {}), ["mutation-1"]);
  assert.deepEqual(Object.keys(first.byGoal["goal-b"] ?? {}), ["mutation-b"]);
  assert.equal(first.restoreBlocked["goal-a"]?.code, "conflicting_mutation_receipt");
  assert.equal(first.restoreBlocked["goal-c"]?.code, "malformed_mutation_receipt");
  assert.equal(first.restoreBlocked["goal-b"], undefined);
  assert.equal(first.diagnostics.length, 2);

  const replayOther = evaluateGoalMutationCas({
    goalId: "goal-b",
    guard: { mutationId: other.mutationId, requestHash: other.requestHash },
    request: { action: "add" },
    current: {},
    receipts: first,
  });
  assert.equal(replayOther.status, "replayed");

  const blocked = evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: { mutationId: "new-mutation", requestHash: hashGoalMutationRequest({ action: "new" }) },
    request: { action: "new" },
    current: {},
    receipts: first,
  });
  assert.equal(blocked.status, "rejected");
  assert.deepEqual(blocked.failureCodes, ["receipt_stream_poisoned"]);
});

test("unmatched prepared restores as mutation-scoped in_doubt while prepared/aborted permits exact retry", () => {
  const request = { action: "patch" };
  const requestHash = hashGoalMutationRequest(request);
  const prepared = createGoalMutationPreparation({
    phase: "prepared",
    goalId: "goal-a",
    mutationId: "mutation-pending",
    requestHash,
    recordedAt: 10,
  });
  const inDoubt = restoreGoalMutationReceiptsFromBranch([phaseEntry(prepared)]);
  assert.equal(inDoubt.inDoubtByGoal["goal-a"]?.["mutation-pending"]?.phase, "prepared");
  assert.equal(inDoubt.restoreBlocked["goal-a"], undefined);
  assert.deepEqual(evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: { mutationId: "mutation-pending", requestHash },
    request,
    current: {},
    receipts: inDoubt,
  }).failureCodes, ["mutation_in_doubt"]);
  assert.equal(evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: { mutationId: "mutation-other", requestHash },
    request,
    current: {},
    receipts: inDoubt,
  }).status, "applied");

  const aborted = createGoalMutationPreparation({ ...prepared, phase: "aborted", recordedAt: 11 });
  const retryable = restoreGoalMutationReceiptsFromBranch([phaseEntry(prepared), phaseEntry(aborted)]);
  assert.equal(retryable.inDoubtByGoal["goal-a"]?.["mutation-pending"], undefined);
  assert.equal(retryable.byGoal["goal-a"]?.["mutation-pending"], undefined);
  assert.equal(evaluateGoalMutationCas({
    goalId: "goal-a",
    guard: { mutationId: "mutation-pending", requestHash },
    request,
    current: {},
    receipts: retryable,
  }).status, "applied");
});

test("malformed or conflicting phase records poison only their affected goal stream", () => {
  const goodReceipt = receipt({
    goalId: "goal-b",
    guard: { mutationId: "mutation-good", requestHash: hashGoalMutationRequest({ action: "good" }) },
    appliedRevisions: { graphRevision: 1 },
  });
  const badPrepared = createGoalMutationPreparation({
    phase: "prepared",
    goalId: "goal-a",
    mutationId: "mutation-bad",
    requestHash: hashGoalMutationRequest({ action: "bad" }),
    recordedAt: 1,
  });
  const conflictingAbort = createGoalMutationPreparation({
    ...badPrepared,
    phase: "aborted",
    requestHash: hashGoalMutationRequest({ action: "different" }),
    recordedAt: 2,
  });
  const malformed = { ...badPrepared, goalId: "goal-c", payload: { forbidden: "body" } };
  const restored = restoreGoalMutationReceiptsFromBranch([
    phaseEntry(badPrepared),
    phaseEntry(conflictingAbort),
    phaseEntry(malformed),
    phaseEntry(preparedFor(goodReceipt)),
    receiptEntry(goodReceipt),
  ]);

  assert.equal(restored.restoreBlocked["goal-a"]?.code, "conflicting_mutation_phase");
  assert.equal(restored.restoreBlocked["goal-c"]?.code, "malformed_mutation_phase");
  assert.equal(restored.restoreBlocked["goal-b"], undefined);
  assert.deepEqual(restored.byGoal["goal-b"]?.["mutation-good"], goodReceipt);
  assert.equal(JSON.stringify(restored).includes("forbidden"), false);
});

test("legacy phase-less receipts remain replayable without preparation records", () => {
  const current = receipt();
  const { phase: _phase, ...legacy } = current;
  const restored = restoreGoalMutationReceiptsFromBranch([receiptEntry(legacy)]);
  const outcome = evaluateGoalMutationCas({
    goalId: current.goalId,
    guard: { mutationId: current.mutationId, requestHash: current.requestHash },
    request: { action: "patch", values: [1, 2] },
    current: {},
    receipts: restored,
  });
  assert.equal(outcome.status, "replayed");
  assert.equal(outcome.receipt.phase, undefined);
});

test("Goal/TODO branch restore builds the same deterministic receipt index without changing graph revisions", () => {
  const original = receipt();
  const restored = restoreGoalTodosFromBranch([phaseEntry(preparedFor(original)), receiptEntry(original)]);
  assert.deepEqual(restored.mutationReceipts.byGoal["goal-a"]?.["mutation-1"], original);
  assert.deepEqual(restored.graphRevisions, {});
  assert.deepEqual(restored.nodes, []);
});

test("receipt types preserve additive prepared and in-doubt side-effect metadata without dispatch", () => {
  const prepared = receipt({ sideEffect: { state: "prepared", operationHash: "a".repeat(64) } });
  const inDoubt = receipt({ sideEffect: { state: "in_doubt", operationHash: "b".repeat(64) } });
  assert.equal(prepared.sideEffect?.state, "prepared");
  assert.equal(inDoubt.sideEffect?.state, "in_doubt");
  assert.equal(prepared.bodyStored, false);
});
