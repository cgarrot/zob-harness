import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GoalMutationGuardSchema,
  buildGoalMutationCanonicalRequest,
  createGoalMutationReceiptState,
  executeGoalMutationCas,
  hashGoalMutationRequest,
  parseOptionalGoalMutationGuard,
  restoreGoalMutationReceiptsFromBranch,
} from "../.pi/extensions/zob-harness/index.ts";

test("shared optional CAS guard schema and parser are strict and non-coercing", () => {
  assert.equal(GoalMutationGuardSchema.type, "object");
  assert.equal(parseOptionalGoalMutationGuard({}), undefined);
  assert.deepEqual(parseOptionalGoalMutationGuard({
    mutation_id: "mutation-1",
    expected_goal_revision: 0,
    expected_graph_revision: 2,
    expected_todo_revision: 3,
  }), {
    mutationId: "mutation-1",
    expectedGoalRevision: 0,
    expectedGraphRevision: 2,
    expectedTodoRevision: 3,
  });

  for (const invalid of [
    { mutation_id: " bad " },
    { expected_goal_revision: 0 },
    { mutation_id: "mutation-1", expected_goal_revision: "0" },
    { mutation_id: "mutation-1", expected_graph_revision: -1 },
    { mutation_id: "mutation-1", expected_todo_revision: 1.5 },
    { mutation_id: "mutation-1", expected_todo_revision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => parseOptionalGoalMutationGuard(invalid), /invalid Goal mutation guard/i);
  }
});

test("canonical request hashing binds tool, goal, resolved target, and payload before mutation", () => {
  const first = buildGoalMutationCanonicalRequest({
    toolName: "update_goal_todo",
    goalId: "goal-a",
    resolvedTargetId: "todo-a",
    payload: { z: 2, a: 1 },
  });
  const second = buildGoalMutationCanonicalRequest({
    payload: { a: 1, z: 2 },
    resolvedTargetId: "todo-a",
    goalId: "goal-a",
    toolName: "update_goal_todo",
  });

  assert.equal(first.requestHash, second.requestHash);
  assert.notEqual(first.requestHash, buildGoalMutationCanonicalRequest({ ...first.request, resolvedTargetId: "todo-b" }).requestHash);
  assert.deepEqual(Object.keys(first.request).sort(), ["goalId", "payload", "resolvedTargetId", "toolName"]);
});

test("absent guard observes body-free metadata and invokes the legacy callback unchanged without a receipt", async () => {
  const receipts = createGoalMutationReceiptState();
  let applies = 0;
  let persists = 0;
  const observations: unknown[] = [];
  const legacyResult = { ok: true, message: "legacy result" };

  const outcome = await executeGoalMutationCas({
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: { secretBody: "must-not-be-observed" },
    current: { goalRevision: 1 },
    receipts,
    apply: () => {
      applies += 1;
      return { result: legacyResult, appliedRevisions: { goalRevision: 2 }, eventCount: 1 };
    },
    persistReceipt: () => { persists += 1; },
    observe: (observation) => { observations.push(observation); },
    now: () => 100,
  });

  assert.equal(outcome.status, "observed");
  assert.equal(outcome.result, legacyResult);
  assert.equal(applies, 1);
  assert.equal(persists, 0);
  assert.equal(observations.length, 1);
  assert.equal(JSON.stringify(observations).includes("must-not-be-observed"), false);
  assert.deepEqual(Object.keys(receipts.byGoal), []);
  assert.equal((observations[0] as { bodyStored: boolean }).bodyStored, false);
});

test("present guard prepares, applies, and persists exactly once, then exact replay skips every callback", async () => {
  const receipts = createGoalMutationReceiptState();
  const payload = { title: "bounded update" };
  let applies = 0;
  let persists = 0;
  const phases: string[] = [];
  const base = {
    toolName: "update_goal_todo",
    goalId: "goal-a",
    resolvedTargetId: "todo-a",
    todoId: "todo-a",
    payload,
    guard: parseOptionalGoalMutationGuard({
      mutation_id: "mutation-1",
      expected_goal_revision: 1,
      expected_graph_revision: 2,
      expected_todo_revision: 3,
    }),
    current: { goalRevision: 1, graphRevision: 2, todoRevisions: { "todo-a": 3 } },
    receipts,
    apply: () => {
      applies += 1;
      return {
        result: { ok: true },
        appliedRevisions: { goalRevision: 2, graphRevision: 3, todoRevision: 4 },
        eventCount: 2,
      };
    },
    persistPreparation: (preparation: { phase: string }) => { phases.push(preparation.phase); },
    persistReceipt: () => { persists += 1; },
    now: () => 100,
  } as const;

  const applied = await executeGoalMutationCas(base);
  assert.equal(applied.status, "applied");
  assert.equal(applies, 1);
  assert.equal(persists, 1);
  assert.deepEqual(phases, ["prepared"]);
  assert.equal(applied.receipt.phase, "applied");
  assert.equal(applied.receipt.bodyStored, false);
  assert.equal(JSON.stringify(applied.receipt).includes("bounded update"), false);

  const replayed = await executeGoalMutationCas({ ...base, current: { goalRevision: 99, graphRevision: 99, todoRevisions: { "todo-a": 99 } } });
  assert.equal(replayed.status, "replayed");
  assert.deepEqual(replayed.receipt, applied.receipt);
  assert.notEqual(replayed.receipt, applied.receipt);
  assert.equal(applies, 1);
  assert.equal(persists, 1);
  assert.deepEqual(phases, ["prepared"]);
});

test("stale and conflicting guards never invoke preparation, mutation, or receipt callbacks", async () => {
  const receipts = createGoalMutationReceiptState();
  let applies = 0;
  let prepares = 0;
  let persists = 0;
  const apply = () => {
    applies += 1;
    return { result: true, appliedRevisions: {}, eventCount: 0 };
  };
  const persistPreparation = () => { prepares += 1; };
  const persistReceipt = () => { persists += 1; };

  const stale = await executeGoalMutationCas({
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: { status: "paused" },
    guard: parseOptionalGoalMutationGuard({ mutation_id: "mutation-stale", expected_goal_revision: 1 }),
    current: { goalRevision: 2 },
    receipts,
    apply,
    persistPreparation,
    persistReceipt,
  });
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.failureCodes, ["stale_goal_revision"]);

  const request = buildGoalMutationCanonicalRequest({ toolName: "update_goal", goalId: "goal-a", resolvedTargetId: "goal-a", payload: { status: "active" } });
  receipts.byGoal["goal-a"] = {
    "mutation-conflict": {
      schema: "zob.goal-mutation-receipt.v1",
      goalId: "goal-a",
      mutationId: "mutation-conflict",
      requestHash: hashGoalMutationRequest({ different: true }),
      eventCount: 1,
      appliedAt: 1,
      bodyStored: false,
    },
  };
  assert.notEqual(receipts.byGoal["goal-a"]["mutation-conflict"].requestHash, request.requestHash);
  const conflict = await executeGoalMutationCas({
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: { status: "active" },
    guard: parseOptionalGoalMutationGuard({ mutation_id: "mutation-conflict" }),
    current: {},
    receipts,
    apply,
    persistPreparation,
    persistReceipt,
  });
  assert.equal(conflict.status, "conflict");
  assert.deepEqual(conflict.failureCodes, ["mutation_id_conflict"]);
  assert.equal(applies, 0);
  assert.equal(prepares, 0);
  assert.equal(persists, 0);
});

test("receipt outage leaves durable prepared unmatched so restart blocks only the exact in_doubt retry", async () => {
  const branch: Array<{ customType: string; data: unknown }> = [];
  const receipts = createGoalMutationReceiptState();
  let applies = 0;
  const base = {
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: { status: "paused" },
    guard: parseOptionalGoalMutationGuard({ mutation_id: "mutation-fail" }),
    current: {},
    apply: () => {
      applies += 1;
      return { result: true, appliedRevisions: { goalRevision: 1 }, eventCount: 1 };
    },
    now: () => 100,
  } as const;

  const failed = await executeGoalMutationCas({
    ...base,
    receipts,
    persistPreparation: (preparation) => { branch.push({ customType: GOAL_MUTATION_PREPARATION_ENTRY_TYPE, data: preparation }); },
    persistReceipt: () => { throw new Error("storage body must not escape"); },
  });
  assert.equal(failed.status, "rejected");
  assert.deepEqual(failed.failureCodes, ["receipt_persistence_failed"]);
  assert.equal(applies, 1);
  assert.equal(receipts.inDoubtByGoal["goal-a"]?.["mutation-fail"]?.phase, "prepared");
  assert.equal(receipts.restoreBlocked["goal-a"], undefined);
  assert.equal(JSON.stringify(receipts.diagnostics).includes("storage body must not escape"), false);

  const restored = restoreGoalMutationReceiptsFromBranch(branch);
  assert.equal(restored.inDoubtByGoal["goal-a"]?.["mutation-fail"]?.phase, "prepared");
  assert.equal(restored.diagnostics.some((diagnostic) => diagnostic.code === "mutation_in_doubt"), true);
  const blockedRetry = await executeGoalMutationCas({
    ...base,
    receipts: restored,
    persistPreparation: () => { throw new Error("retry must not prepare"); },
    persistReceipt: () => { throw new Error("retry must not persist"); },
  });
  assert.equal(blockedRetry.status, "rejected");
  assert.deepEqual(blockedRetry.failureCodes, ["mutation_in_doubt"]);
  assert.equal(applies, 1);

  const other = await executeGoalMutationCas({
    ...base,
    guard: parseOptionalGoalMutationGuard({ mutation_id: "other-mutation" }),
    receipts: restored,
    persistPreparation: () => undefined,
    persistReceipt: () => undefined,
  });
  assert.equal(other.status, "applied", "in_doubt blocks only the affected mutation, not the whole goal stream");
  assert.equal(applies, 2);
});

test("prepare persistence failure invokes no mutation callback", async () => {
  let applies = 0;
  let receiptsPersisted = 0;
  const outcome = await executeGoalMutationCas({
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: { status: "paused" },
    guard: parseOptionalGoalMutationGuard({ mutation_id: "prepare-outage" }),
    current: {},
    receipts: createGoalMutationReceiptState(),
    apply: () => {
      applies += 1;
      return { result: true, appliedRevisions: { goalRevision: 1 }, eventCount: 1 };
    },
    persistPreparation: () => { throw new Error("prepare sink unavailable"); },
    persistReceipt: () => { receiptsPersisted += 1; },
    now: () => 100,
  });

  assert.equal(outcome.status, "rejected");
  assert.deepEqual(outcome.failureCodes, ["preparation_persistence_failed"]);
  assert.equal(applies, 0);
  assert.equal(receiptsPersisted, 0);
  assert.equal(JSON.stringify(outcome).includes("prepare sink unavailable"), false);
});

test("pre-apply callback rejection appends aborted and permits an exact safe retry", async () => {
  const receipts = createGoalMutationReceiptState();
  const phases: string[] = [];
  let reject = true;
  let applies = 0;
  const input = {
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: { status: "paused" },
    guard: parseOptionalGoalMutationGuard({ mutation_id: "callback-reject" }),
    current: {},
    receipts,
    apply: () => {
      applies += 1;
      if (reject) throw new Error("policy rejected before event");
      return { result: true, appliedRevisions: { goalRevision: 1 }, eventCount: 1 };
    },
    persistPreparation: (preparation: { phase: string }) => { phases.push(preparation.phase); },
    persistReceipt: () => undefined,
    didApply: () => false,
    now: () => 100,
  } as const;

  await assert.rejects(() => executeGoalMutationCas(input), /policy rejected before event/);
  assert.deepEqual(phases, ["prepared", "aborted"]);
  assert.equal(receipts.byGoal["goal-a"]?.["callback-reject"], undefined);
  assert.equal(receipts.protocolByGoal["goal-a"]?.["callback-reject"]?.phase, "aborted");
  assert.equal(receipts.inDoubtByGoal["goal-a"]?.["callback-reject"], undefined);

  reject = false;
  const retried = await executeGoalMutationCas(input);
  assert.equal(retried.status, "applied");
  assert.equal(applies, 2);
  assert.deepEqual(phases, ["prepared", "aborted", "prepared"]);
});

test("abort persistence failure stays in_doubt and blocks callback retry", async () => {
  const receipts = createGoalMutationReceiptState();
  let applies = 0;
  const input = {
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: { status: "paused" },
    guard: parseOptionalGoalMutationGuard({ mutation_id: "abort-outage" }),
    current: {},
    receipts,
    apply: () => {
      applies += 1;
      throw new Error("rejected before event");
    },
    persistPreparation: (preparation: { phase: string }) => {
      if (preparation.phase === "aborted") throw new Error("abort sink unavailable");
    },
    persistReceipt: () => undefined,
    didApply: () => false,
    now: () => 100,
  } as const;

  const failed = await executeGoalMutationCas(input);
  assert.equal(failed.status, "rejected");
  assert.deepEqual(failed.failureCodes, ["abort_persistence_failed"]);
  assert.equal(receipts.inDoubtByGoal["goal-a"]?.["abort-outage"]?.phase, "prepared");

  const retry = await executeGoalMutationCas(input);
  assert.equal(retry.status, "rejected");
  assert.deepEqual(retry.failureCodes, ["mutation_in_doubt"]);
  assert.equal(applies, 1);
});

test("mutation-id-only node execution binds canonical todoId and todoRevision as a pair", async () => {
  let applies = 0;
  const outcome = await executeGoalMutationCas({
    toolName: "update_goal_todo",
    goalId: "goal-a",
    resolvedTargetId: "todo-a",
    todoId: "todo-a",
    payload: { title: "mutation-id-only" },
    guard: parseOptionalGoalMutationGuard({ mutation_id: "node-binding" }),
    current: { graphRevision: 1, todoRevisions: { "todo-a": 1 } },
    receipts: createGoalMutationReceiptState(),
    apply: () => {
      applies += 1;
      return { result: true, appliedRevisions: { graphRevision: 2, todoRevision: 2 }, eventCount: 1 };
    },
    persistPreparation: () => undefined,
    persistReceipt: () => undefined,
    now: () => 100,
  });

  assert.equal(outcome.status, "applied");
  assert.equal(applies, 1);
  assert.equal(outcome.receipt.todoId, "todo-a");
  assert.equal(outcome.receipt.todoRevision, 2);
  assert.equal(outcome.receipt.expectedTodoRevision, undefined);
});

test("guarded restore-blocked state fails closed before observation, mutation, or receipt persistence", async () => {
  let applies = 0;
  let observes = 0;
  let prepares = 0;
  let persists = 0;
  const outcome = await executeGoalMutationCas({
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: {},
    guard: parseOptionalGoalMutationGuard({ mutation_id: "mutation-restore-blocked" }),
    current: {},
    receipts: createGoalMutationReceiptState(),
    restoreBlocked: true,
    apply: () => {
      applies += 1;
      return { result: true, appliedRevisions: {}, eventCount: 0 };
    },
    persistPreparation: () => { prepares += 1; },
    persistReceipt: () => { persists += 1; },
    observe: () => { observes += 1; },
  });

  assert.equal(outcome.status, "rejected");
  assert.deepEqual(outcome.failureCodes, ["state_restore_blocked"]);
  assert.equal(applies, 0);
  assert.equal(observes, 0);
  assert.equal(prepares, 0);
  assert.equal(persists, 0);
});

test("unguarded compatibility ignores CAS restore gates and returns the legacy result by identity", async () => {
  const legacyResult = { ok: true, text: "legacy restore diagnostic" };
  let applies = 0;
  const outcome = await executeGoalMutationCas({
    toolName: "update_goal",
    goalId: "goal-a",
    resolvedTargetId: "goal-a",
    payload: {},
    current: {},
    receipts: createGoalMutationReceiptState(),
    restoreBlocked: true,
    apply: () => {
      applies += 1;
      return { result: legacyResult, appliedRevisions: {}, eventCount: 0 };
    },
    persistReceipt: () => { throw new Error("unguarded calls must not persist receipts"); },
  });

  assert.equal(outcome.status, "observed");
  assert.equal(outcome.result, legacyResult);
  assert.equal(applies, 1);
});
