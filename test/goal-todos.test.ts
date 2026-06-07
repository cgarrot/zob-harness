import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  acceptGoalTodoClaim,
  addGoalTodo,
  blockGoalTodo,
  completeGoalTodo,
  createGoalTodoState,
  createHarnessRuntimeState,
  validateGoalTodoGraph,
} from "../.pi/extensions/zob-harness/index.ts";
import type { GoalTodoNode, GoalTodoState } from "../.pi/extensions/zob-harness/index.ts";

const pi = { appendEntry: () => undefined };

function node(partial: Partial<GoalTodoNode>): GoalTodoNode {
  return {
    goalId: "g",
    id: "x",
    depth: 1,
    path: "1",
    acceptanceCriteria: [],
    evidenceRefs: [],
    validationCommands: [],
    ...partial,
  } as unknown as GoalTodoNode;
}

function graphWith(nodes: GoalTodoNode[]): GoalTodoState {
  const state = createGoalTodoState();
  state.nodes = nodes;
  return state;
}

test("createGoalTodoState: starts empty with parent-owned policy defaults", () => {
  const state = createGoalTodoState();
  assert.deepEqual(state.nodes, []);
  assert.equal(state.policy.maxTodoDepth, 6);
  assert.equal(state.policy.parentOwnedClaims, true);
  assert.equal(state.policy.oracleBeforeGoalComplete, true);
});

test("validateGoalTodoGraph: accepts a well-formed parent/child graph", () => {
  const graph = graphWith([
    node({ id: "a", path: "1" }),
    node({ id: "b", parentId: "a", depth: 2, path: "1.1" }),
  ]);
  assert.deepEqual(validateGoalTodoGraph(graph), []);
});

test("validateGoalTodoGraph: detects duplicate ids", () => {
  const graph = graphWith([node({ id: "dup" }), node({ id: "dup", path: "2" })]);
  assert.ok(validateGoalTodoGraph(graph).some((error) => error.includes("duplicate todo id: dup")));
});

test("validateGoalTodoGraph: detects missing parents", () => {
  const graph = graphWith([node({ id: "child", parentId: "ghost", depth: 2, path: "1.1" })]);
  assert.ok(validateGoalTodoGraph(graph).some((error) => error.includes("references missing parent ghost")));
});

test("validateGoalTodoGraph: detects depth violations", () => {
  const graph = graphWith([node({ id: "deep", depth: 7, path: "1" })]);
  assert.ok(validateGoalTodoGraph(graph).some((error) => error.includes("exceeds maxTodoDepth=6")));
});

test("validateGoalTodoGraph: detects cycles", () => {
  const graph = graphWith([
    node({ id: "a", parentId: "b", path: "1" }),
    node({ id: "b", parentId: "a", path: "2" }),
  ]);
  assert.ok(validateGoalTodoGraph(graph).some((error) => error.includes("todo cycle detected")));
});

test("addGoalTodo: creates a planned, agent-owned node", () => {
  const state = createHarnessRuntimeState();
  const created = addGoalTodo(pi, state, "goal-1", { title: "Task A" });
  assert.equal(created.title, "Task A");
  assert.equal(created.status, "planned");
  assert.equal(created.owner, "agent");
  assert.equal(state.goalTodos.nodes.length, 1);
});

test("addGoalTodo: rejects empty titles and unknown parents", () => {
  const state = createHarnessRuntimeState();
  assert.throws(() => addGoalTodo(pi, state, "goal-1", { title: "   " }), /title is required/);
  assert.throws(() => addGoalTodo(pi, state, "goal-1", { title: "child", parentId: "missing" }), /Parent TODO not found/);
});

test("completeGoalTodo: marks a non-delegated todo done", () => {
  const state = createHarnessRuntimeState();
  const created = addGoalTodo(pi, state, "goal-1", { title: "Task A" });
  const done = completeGoalTodo(pi, state, "goal-1", created.id);
  assert.equal(done.status, "done");
});

test("blockGoalTodo: blocks a todo with the supplied reason", () => {
  const state = createHarnessRuntimeState();
  const created = addGoalTodo(pi, state, "goal-1", { title: "Task A" });
  const blocked = blockGoalTodo(pi, state, "goal-1", created.id, "waiting on upstream");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocker, "waiting on upstream");
});

test("acceptGoalTodoClaim: refuses todos without a returned delegated claim", () => {
  const state = createHarnessRuntimeState();
  const created = addGoalTodo(pi, state, "goal-1", { title: "Task A" });
  assert.throws(() => acceptGoalTodoClaim(pi, state, "goal-1", created.id), /has no returned delegated claim to accept/);
  assert.throws(() => acceptGoalTodoClaim(pi, state, "goal-1", "ghost"), /Goal TODO not found/);
});
