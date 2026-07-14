import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  addGoalTodo,
  createHarnessRuntimeState,
} from "../.pi/extensions/zob-harness/index.ts";
import type { GoalTodoEvent, GoalTodoNode } from "../.pi/extensions/zob-harness/index.ts";
import {
  createGoalTodoState,
  restoreGoalTodosFromBranch,
} from "../.pi/extensions/zob-harness/src/domains/goal/goal-todos/normalize.ts";
import { appendGoalTodoEvent } from "../.pi/extensions/zob-harness/src/domains/goal/goal-todos/reducer.ts";
import {
  appendRuntimeGoalEntry,
  createRuntimeGoal,
  restoreRuntimeGoalFromBranch,
  setEntry,
} from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts";
import { registerGoalRuntimeEvents } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/events.ts";
import { registerGoalRuntimeTools } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const TODO_ENTRY = "zob-goal-todo";
const GOAL_ENTRY = "zob-runtime-goal";

function legacyNode(overrides: Partial<GoalTodoNode> = {}): GoalTodoNode {
  return {
    id: "todo-a",
    goalId: "goal-a",
    path: "1",
    depth: 1,
    title: "legacy task",
    status: "planned",
    owner: "agent",
    required: true,
    priority: "normal",
    acceptanceCriteria: [],
    evidenceRefs: [],
    validationCommands: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function todoEntry(data: Record<string, unknown>): Record<string, unknown> {
  return { customType: TODO_ENTRY, data };
}

function goalEntry(data: Record<string, unknown>): Record<string, unknown> {
  return { customType: GOAL_ENTRY, data };
}

function capturePi() {
  const entries: Array<{ type: string; data: unknown }> = [];
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  return { pi, entries, tools };
}

test("legacy Goal/TODO fixtures replay deterministically with synthesized revisions and event timestamps", () => {
  const fixture = [
    todoEntry({ version: 1, kind: "add", source: "runtime", goalId: "goal-a", node: legacyNode({ createdAt: undefined as unknown as number, updatedAt: undefined as unknown as number }), at: 101 }),
    todoEntry({ version: 1, kind: "patch", source: "runtime", goalId: "goal-a", todoId: "todo-a", patch: { status: "in_progress" }, at: 102 }),
  ];

  const first = restoreGoalTodosFromBranch(fixture);
  const second = restoreGoalTodosFromBranch(fixture);

  assert.deepEqual(first, second);
  assert.equal(first.graphRevisions["goal-a"], 2);
  assert.equal(first.nodes[0]?.revision, 2);
  assert.equal(first.nodes[0]?.createdAt, 101);
  assert.equal(first.nodes[0]?.updatedAt, 102);
  assert.deepEqual(first.revisionDiagnostics, []);
});

test("new Goal/TODO appends persist v2 revision envelopes and increment graph/node once", () => {
  const { pi, entries } = capturePi();
  const state = createGoalTodoState();
  const add: GoalTodoEvent = { version: 1, kind: "add", source: "tool", goalId: "goal-a", node: legacyNode(), at: 100 };
  appendGoalTodoEvent(pi, { goalTodos: state } as never, add);
  const patch: GoalTodoEvent = { version: 1, kind: "patch", source: "tool", goalId: "goal-a", todoId: "todo-a", patch: { status: "ready" }, at: 101 };
  appendGoalTodoEvent(pi, { goalTodos: state } as never, patch);

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => ({ version: (entry.data as Record<string, unknown>).version, graphRevision: (entry.data as Record<string, unknown>).graphRevision, nodeRevision: (entry.data as Record<string, unknown>).nodeRevision })), [
    { version: 2, graphRevision: 1, nodeRevision: 1 },
    { version: 2, graphRevision: 2, nodeRevision: 2 },
  ]);
  assert.equal(state.graphRevisions["goal-a"], 2);
  assert.equal(state.nodes[0]?.revision, 2);
});

test("malformed v2 Goal/TODO revisions permanently block only the affected replay/live stream", () => {
  const state = restoreGoalTodosFromBranch([
    todoEntry({ version: 2, kind: "add", source: "runtime", goalId: "goal-a", node: legacyNode(), graphRevision: 1, nodeRevision: 1, at: 100 }),
    todoEntry({ version: 2, kind: "patch", source: "runtime", goalId: "goal-a", todoId: "todo-a", patch: { status: "done" }, graphRevision: 3, nodeRevision: 2, at: 101 }),
    todoEntry({ version: 2, kind: "patch", source: "runtime", goalId: "goal-a", todoId: "todo-a", patch: { status: "ready" }, graphRevision: 2, nodeRevision: 2, at: 102 }),
    todoEntry({ version: 2, kind: "add", source: "runtime", goalId: "goal-b", node: legacyNode({ id: "todo-b", goalId: "goal-b" }), graphRevision: 1, nodeRevision: 1, at: 103 }),
    todoEntry({ version: 2, kind: "patch", source: "runtime", goalId: "goal-b", todoId: "todo-b", patch: { status: "ready" }, graphRevision: 2, nodeRevision: 2, at: 104 }),
  ]);

  const goalA = state.nodes.find((node) => node.goalId === "goal-a");
  const goalB = state.nodes.find((node) => node.goalId === "goal-b");
  assert.equal(goalA?.status, "planned");
  assert.equal(goalA?.revision, 1);
  assert.equal(state.graphRevisions["goal-a"], 1);
  assert.equal(goalB?.status, "ready");
  assert.equal(goalB?.revision, 2);
  assert.equal(state.graphRevisions["goal-b"], 2);
  assert.equal(state.revisionDiagnostics.length, 1);
  assert.equal(state.revisionDiagnostics[0]?.code, "graph_revision_gap");
  assert.deepEqual(state.restoreBlocked?.["goal-a"], state.revisionDiagnostics[0]);

  const { pi, entries } = capturePi();
  const beforeBlockedAppend = JSON.stringify(state);
  assert.throws(() => appendGoalTodoEvent(pi, { goalTodos: state } as never, { version: 1, kind: "patch", source: "tool", goalId: "goal-a", todoId: "todo-a", patch: { status: "in_progress" }, at: 105 }), /restore-blocked.*expected graphRevision=2, received 3/i);
  assert.equal(JSON.stringify(state), beforeBlockedAppend);
  assert.equal(entries.length, 0);

  appendGoalTodoEvent(pi, { goalTodos: state } as never, { version: 1, kind: "patch", source: "tool", goalId: "goal-b", todoId: "todo-b", patch: { status: "done" }, at: 106 });
  assert.equal(entries.length, 1);
  assert.equal(state.nodes.find((node) => node.goalId === "goal-b")?.status, "done");
  assert.equal(state.graphRevisions["goal-b"], 3);
  assert.equal(state.revisionDiagnostics.length, 1);
});

test("runtime goal legacy replay is deterministic and additive appends increment once", () => {
  const legacy = createRuntimeGoal("legacy objective");
  const fixture = [
    goalEntry({ version: 1, kind: "set", source: "runtime", goal: { ...legacy, revision: undefined, createdAt: 10, updatedAt: 10 }, at: 10 }),
    goalEntry({ version: 1, kind: "set", source: "runtime", goal: { ...legacy, revision: undefined, status: "paused", createdAt: 10, updatedAt: 11 }, at: 11 }),
  ];
  const first = restoreRuntimeGoalFromBranch(fixture);
  const second = restoreRuntimeGoalFromBranch(fixture);
  assert.deepEqual(first, second);
  assert.equal(first?.revision, 2);

  const { pi, entries } = capturePi();
  const state = createHarnessRuntimeState();
  const goal = createRuntimeGoal("new objective");
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
  goal.status = "paused";
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));

  assert.equal(state.runtimeGoal?.revision, 2);
  assert.deepEqual(entries.map((entry) => ({ version: (entry.data as Record<string, unknown>).version, revision: (entry.data as Record<string, unknown>).revision })), [
    { version: 2, revision: 1 },
    { version: 2, revision: 2 },
  ]);
});

test("runtime goal malformed v2 revisions permanently block only the affected replay/live stream", () => {
  const base = { ...createRuntimeGoal("revision diagnostics"), goalId: "goal-a" };
  const restored = restoreRuntimeGoalFromBranch([
    goalEntry({ version: 1, kind: "set", source: "runtime", goal: { ...base, revision: undefined, createdAt: 20, updatedAt: 20 }, at: 20 }),
    goalEntry({ version: 2, kind: "set", source: "runtime", revision: 3, goal: { ...base, revision: 3, status: "paused", createdAt: 20, updatedAt: 21 }, at: 21 }),
    goalEntry({ version: 2, kind: "set", source: "runtime", revision: 2, goal: { ...base, revision: 2, status: "blocked", createdAt: 20, updatedAt: 22 }, at: 22 }),
  ]);

  assert.equal(restored?.status, "active");
  assert.equal(restored?.revision, 1);
  assert.deepEqual(restored?.revisionDiagnostics.map((diagnostic) => diagnostic.code), ["goal_revision_gap"]);
  assert.deepEqual(restored?.restoreBlocked?.["goal-a"], restored?.revisionDiagnostics[0]);

  const { pi, entries } = capturePi();
  const state = createHarnessRuntimeState();
  state.runtimeGoal = restored;
  const beforeBlockedAppend = JSON.stringify(state.runtimeGoal);
  assert.throws(() => appendRuntimeGoalEntry(pi, state, setEntry(restored as NonNullable<typeof restored>, "tool")), /restore-blocked.*expected revision=2, received 3/i);
  assert.equal(JSON.stringify(state.runtimeGoal), beforeBlockedAppend);
  assert.equal(entries.length, 0);

  const unrelated = { ...createRuntimeGoal("unrelated stream"), goalId: "goal-b" };
  appendRuntimeGoalEntry(pi, state, setEntry(unrelated, "tool"));
  assert.equal(state.runtimeGoal?.goalId, "goal-b");
  assert.equal(state.runtimeGoal?.revision, 1);
  assert.equal(entries.length, 1);
  assert.equal(state.runtimeGoal?.restoreBlocked?.["goal-a"]?.code, "goal_revision_gap");

  const beforeRetry = JSON.stringify(state.runtimeGoal);
  assert.throws(() => appendRuntimeGoalEntry(pi, state, setEntry(base, "tool")), /restore-blocked.*expected revision=2, received 3/i);
  assert.equal(JSON.stringify(state.runtimeGoal), beforeRetry);
  assert.equal(entries.length, 1);
});

test("getter tool lifecycle events do not persist or advance runtime goal state", async () => {
  const entries: Array<{ type: string; data: unknown }> = [];
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    on(name: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  const goal = createRuntimeGoal("lifecycle getter purity");
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
  registerGoalRuntimeEvents(pi, state, () => undefined);
  const before = JSON.stringify(state);
  const appendCount = entries.length;
  const handler = handlers.get("tool_execution_end");
  assert.ok(handler);

  await handler({ toolName: "get_goal" }, {});
  await handler({ toolName: "get_goal_todos" }, {});

  assert.equal(entries.length, appendCount);
  assert.equal(JSON.stringify(state), before);
});

test("getters remain pure and expose restore-blocked diagnostics", async () => {
  const { pi, entries, tools } = capturePi();
  const state = createHarnessRuntimeState();
  const goal = { ...createRuntimeGoal("blocked getter"), goalId: "goal-a" };
  state.runtimeGoal = restoreRuntimeGoalFromBranch([
    goalEntry({ version: 1, kind: "set", source: "runtime", goal: { ...goal, revision: undefined }, at: 1 }),
    goalEntry({ version: 2, kind: "set", source: "runtime", revision: 3, goal: { ...goal, revision: 3, status: "paused" }, at: 2 }),
  ]);
  state.goalTodos = restoreGoalTodosFromBranch([
    todoEntry({ version: 2, kind: "add", source: "runtime", goalId: "goal-a", node: legacyNode(), graphRevision: 1, nodeRevision: 1, at: 1 }),
    todoEntry({ version: 2, kind: "patch", source: "runtime", goalId: "goal-a", todoId: "todo-a", patch: { status: "done" }, graphRevision: 3, nodeRevision: 2, at: 2 }),
  ]);
  registerGoalRuntimeTools(pi, state);
  const before = JSON.stringify(state);

  const goalResult = await tools.get("get_goal")?.execute();
  const todosResult = await tools.get("get_goal_todos")?.execute("call", {});

  assert.equal(JSON.stringify(state), before);
  assert.equal(entries.length, 0);
  assert.equal((goalResult as { details: { goal: { status: string; revision: number; restoreBlocked: Record<string, { code: string }> } } }).details.goal.status, "active");
  assert.equal((goalResult as { details: { goal: { status: string; revision: number; restoreBlocked: Record<string, { code: string }> } } }).details.goal.revision, 1);
  assert.equal((goalResult as { details: { goal: { restoreBlocked: Record<string, { code: string }> } } }).details.goal.restoreBlocked["goal-a"]?.code, "goal_revision_gap");
  assert.equal((todosResult as { details: { graphRevision: number; restoreBlocked: { code: string } } }).details.graphRevision, 1);
  assert.equal((todosResult as { details: { restoreBlocked: { code: string } } }).details.restoreBlocked.code, "graph_revision_gap");
});

test("get_goal and get_goal_todos are pure and expose revisions", async () => {
  const { pi, entries, tools } = capturePi();
  const state = createHarnessRuntimeState();
  const goal = createRuntimeGoal("getter purity");
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
  addGoalTodo(pi, state, goal.goalId, { title: "inspect without mutation" }, "tool");
  registerGoalRuntimeTools(pi, state);

  const before = JSON.stringify(state);
  const beforeAppendCount = entries.length;
  const goalUpdatedAt = state.runtimeGoal?.updatedAt;
  const graphRevision = state.goalTodos.graphRevisions[goal.goalId];
  const nodeRevision = state.goalTodos.nodes[0]?.revision;

  const goalResult = await tools.get("get_goal")?.execute();
  const todosResult = await tools.get("get_goal_todos")?.execute("call", {});

  assert.equal(JSON.stringify(state), before);
  assert.equal(entries.length, beforeAppendCount);
  assert.equal(state.runtimeGoal?.updatedAt, goalUpdatedAt);
  assert.equal(state.goalTodos.graphRevisions[goal.goalId], graphRevision);
  assert.equal(state.goalTodos.nodes[0]?.revision, nodeRevision);
  assert.equal(((goalResult as { details: { goal: { revision: number } } }).details.goal.revision), 1);
  assert.equal(((todosResult as { details: { graphRevision: number; nodes: Array<{ revision: number }> } }).details.graphRevision), 1);
  assert.equal(((todosResult as { details: { graphRevision: number; nodes: Array<{ revision: number }> } }).details.nodes[0]?.revision), 1);
});
