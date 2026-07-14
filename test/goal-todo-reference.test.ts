import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  adaptLegacyGoalTodoReference,
  createGoalTodoState,
  resolveCanonicalGoalTodoReference,
  resolveCanonicalGoalTodoReferences,
} from "../.pi/extensions/zob-harness/index.ts";
import type { GoalTodoNode, GoalTodoState } from "../.pi/extensions/zob-harness/index.ts";

const GOAL_A = "goal-a";
const GOAL_B = "goal-b";
const TODO_A = "todo_aaaaaaaaaaaa";
const TODO_B = "todo_bbbbbbbbbbbb";
const TODO_C = "todo_cccccccccccc";
const CROSS_GOAL_TODO = "todo_dddddddddddd";

function node(partial: Pick<GoalTodoNode, "id" | "goalId" | "path"> & Partial<GoalTodoNode>): GoalTodoNode {
  return {
    parentId: undefined,
    depth: partial.path.split(".").length,
    title: partial.id,
    status: "ready",
    owner: "agent",
    required: true,
    priority: "normal",
    acceptanceCriteria: [],
    evidenceRefs: [],
    validationCommands: [],
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function stateWith(nodes: GoalTodoNode[]): GoalTodoState {
  const state = createGoalTodoState();
  state.nodes = nodes;
  return state;
}

const baseState = () => stateWith([
  node({ id: TODO_A, goalId: GOAL_A, path: "1" }),
  node({ id: TODO_B, goalId: GOAL_A, path: "1.2" }),
  node({ id: TODO_C, goalId: GOAL_A, path: "2" }),
  node({ id: CROSS_GOAL_TODO, goalId: GOAL_B, path: "9" }),
]);

test("canonical resolver accepts ID-only, path-only, and agreeing dual references", () => {
  const state = baseState();
  for (const input of [
    { todoId: TODO_B },
    { todoPath: "1.2" },
    { todoId: TODO_B, todoPath: "1.2" },
  ]) {
    const result = resolveCanonicalGoalTodoReference(state, GOAL_A, input);
    assert.equal(result.code, "resolved");
    assert.equal(result.node?.id, TODO_B);
    assert.equal(result.canonicalId, TODO_B);
    assert.equal(result.path, "1.2");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.candidates, [{ canonicalId: TODO_B, goalId: GOAL_A, path: "1.2" }]);
    assert.equal(result.retryPolicy, "none");
  }
});

test("canonical resolver is pure and returns a defensive node clone", () => {
  const state = baseState();
  const before = JSON.stringify(state);
  const result = resolveCanonicalGoalTodoReference(state, GOAL_A, { todoId: TODO_A });
  assert.equal(JSON.stringify(state), before);
  assert.ok(result.node);
  result.node.title = "caller mutation";
  assert.notEqual(state.nodes.find((candidate) => candidate.id === TODO_A)?.title, "caller mutation");
});

test("canonical resolver independently resolves dual refs and rejects disagreement", () => {
  const result = resolveCanonicalGoalTodoReference(baseState(), GOAL_A, { todoId: TODO_A, todoPath: "2" });
  assert.equal(result.node, undefined);
  assert.equal(result.canonicalId, undefined);
  assert.equal(result.code, "reference_mismatch");
  assert.deepEqual(result.errors.map((error) => error.code), ["reference_mismatch"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.canonicalId), [TODO_A, TODO_C]);
  assert.equal(result.retryPolicy, "fix_input");
});

test("canonical resolver distinguishes stale and cross-goal canonical IDs", () => {
  const stale = resolveCanonicalGoalTodoReference(baseState(), GOAL_A, { todoId: "todo_eeeeeeeeeeee" });
  assert.equal(stale.code, "todo_id_not_found");
  assert.deepEqual(stale.candidates, []);
  assert.equal(stale.retryPolicy, "refresh_goal_todos");

  const crossGoal = resolveCanonicalGoalTodoReference(baseState(), GOAL_A, { todoId: CROSS_GOAL_TODO });
  assert.equal(crossGoal.code, "todo_id_cross_goal");
  assert.equal(crossGoal.node, undefined);
  assert.deepEqual(crossGoal.candidates, [{ canonicalId: CROSS_GOAL_TODO, goalId: GOAL_B, path: "9" }]);
  assert.equal(crossGoal.retryPolicy, "refresh_goal_todos");

  const otherGoalPath = resolveCanonicalGoalTodoReference(baseState(), GOAL_A, { todoPath: "9" });
  assert.equal(otherGoalPath.code, "todo_path_not_found");
  assert.deepEqual(otherGoalPath.candidates, []);
});

test("canonical resolver rejects duplicate paths without selecting a first candidate", () => {
  const state = baseState();
  state.nodes.push(node({ id: "todo_ffffffffffff", goalId: GOAL_A, path: "1.2", createdAt: 2 }));
  const result = resolveCanonicalGoalTodoReference(state, GOAL_A, { todoPath: "1.2" });
  assert.equal(result.code, "todo_path_ambiguous");
  assert.equal(result.node, undefined);
  assert.deepEqual(result.candidates.map((candidate) => candidate.canonicalId), [TODO_B, "todo_ffffffffffff"]);
  assert.equal(result.retryPolicy, "select_canonical_id");
});

test("canonical resolver uses strict, separate ID/path syntax and never treats todo_id as a path", () => {
  for (const todoId of ["1.2", "todo_1.2", "todo_AAAAAAAAAAAA", " todo_aaaaaaaaaaaa", "todo_short", ""]) {
    const result = resolveCanonicalGoalTodoReference(baseState(), GOAL_A, { todoId });
    assert.equal(result.code, "invalid_todo_id", `expected invalid_todo_id for ${JSON.stringify(todoId)}`);
    assert.equal(result.node, undefined);
  }
  for (const todoPath of ["todo_1.2", "01.2", "1.0", ".1", "1.", "1..2", " 1.2", ""]) {
    const result = resolveCanonicalGoalTodoReference(baseState(), GOAL_A, { todoPath });
    assert.equal(result.code, "invalid_todo_path", `expected invalid_todo_path for ${JSON.stringify(todoPath)}`);
    assert.equal(result.node, undefined);
  }

  const legacy = adaptLegacyGoalTodoReference("todo_1.2");
  assert.deepEqual(legacy, { todoPath: "1.2" });
  assert.equal(resolveCanonicalGoalTodoReference(baseState(), GOAL_A, { todoId: "todo_1.2" }).code, "invalid_todo_id");
});

test("canonical resolver rejects missing goal or missing references with stable codes", () => {
  assert.equal(resolveCanonicalGoalTodoReference(baseState(), undefined, { todoId: TODO_A }).code, "missing_goal_id");
  assert.equal(resolveCanonicalGoalTodoReference(baseState(), "", { todoId: TODO_A }).code, "missing_goal_id");
  assert.equal(resolveCanonicalGoalTodoReference(baseState(), GOAL_A, {}).code, "missing_reference");
});

test("batch resolver deterministically deduplicates canonical nodes", () => {
  const result = resolveCanonicalGoalTodoReferences(baseState(), GOAL_A, [
    { todoPath: "1.2" },
    { todoId: TODO_A },
    { todoId: TODO_B, todoPath: "1.2" },
    { todoPath: "2" },
  ]);
  assert.equal(result.code, "resolved");
  assert.deepEqual(result.canonicalIds, [TODO_B, TODO_A, TODO_C]);
  assert.deepEqual(result.paths, ["1.2", "1", "2"]);
  assert.deepEqual(result.nodes.map((candidate) => candidate.id), [TODO_B, TODO_A, TODO_C]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.retryPolicy, "none");
});

test("batch resolver fails atomically on mismatch or duplicate-path ambiguity", () => {
  const mismatch = resolveCanonicalGoalTodoReferences(baseState(), GOAL_A, [
    { todoId: TODO_A },
    { todoId: TODO_B, todoPath: "2" },
  ]);
  assert.equal(mismatch.code, "batch_resolution_failed");
  assert.deepEqual(mismatch.nodes, []);
  assert.deepEqual(mismatch.canonicalIds, []);
  assert.ok(mismatch.errors.some((error) => error.code === "reference_mismatch" && error.index === 1));

  const ambiguousState = baseState();
  ambiguousState.nodes.push(node({ id: "todo_ffffffffffff", goalId: GOAL_A, path: "1.2", createdAt: 2 }));
  const ambiguous = resolveCanonicalGoalTodoReferences(ambiguousState, GOAL_A, [
    { todoId: TODO_A },
    { todoPath: "1.2" },
  ]);
  assert.equal(ambiguous.code, "batch_resolution_failed");
  assert.deepEqual(ambiguous.nodes, []);
  assert.ok(ambiguous.errors.some((error) => error.code === "todo_path_ambiguous" && error.index === 1));
});
