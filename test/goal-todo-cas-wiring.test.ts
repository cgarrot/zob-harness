import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GOAL_MUTATION_RECEIPT_ENTRY_TYPE,
  addGoalTodo,
  completeGoalTodo,
  createHarnessRuntimeState,
  linkGoalTodoDelegation,
  restoreGoalTodosFromBranch,
  returnGoalTodoClaim,
} from "../.pi/extensions/zob-harness/index.ts";
import { registerGoalRuntimeEvents } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/events.ts";
import { registerGoalRuntimeTools } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ID = "goal-cas-wiring";
const TODO_ENTRY_TYPE = "zob-goal-todo";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

type CapturedTool = {
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  execute: (...args: unknown[]) => Promise<ToolResult>;
};

type Entry = { type: string; data: unknown };
type TestState = ReturnType<typeof createHarnessRuntimeState>;
type EventHandler = (...args: unknown[]) => Promise<unknown>;

type ScenarioBuild = {
  pi: ExtensionAPI;
  state: TestState;
  entries: Entry[];
  handlers: Map<string, EventHandler>;
  tool: CapturedTool;
  params: Record<string, unknown>;
  conflict: (params: Record<string, unknown>) => Record<string, unknown>;
  expectedEvents: number;
  targetId?: string;
  graphRevision: number;
  todoRevision?: number;
};

type Scenario = {
  name: string;
  setup: () => ScenarioBuild;
};

function capturePi() {
  const entries: Entry[] = [];
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, EventHandler>();
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, entries, tools, handlers };
}

function baseSetup() {
  const captured = capturePi();
  const state = createHarnessRuntimeState();
  state.runtimeGoal = { goalId: GOAL_ID, revision: 0 } as NonNullable<TestState["runtimeGoal"]>;
  return { ...captured, state };
}

function finishSetup(
  base: ReturnType<typeof baseSetup>,
  toolName: string,
  params: Record<string, unknown>,
  conflict: ScenarioBuild["conflict"],
  expectedEvents: number,
  targetId?: string,
): ScenarioBuild {
  base.entries.length = 0;
  registerGoalRuntimeTools(base.pi, base.state);
  const tool = base.tools.get(toolName);
  assert.ok(tool, `registered tool ${toolName}`);
  const target = targetId ? base.state.goalTodos.nodes.find((node) => node.id === targetId && node.goalId === GOAL_ID) : undefined;
  return {
    pi: base.pi,
    state: base.state,
    entries: base.entries,
    handlers: base.handlers,
    tool,
    params,
    conflict,
    expectedEvents,
    targetId,
    graphRevision: base.state.goalTodos.graphRevisions[GOAL_ID] ?? 0,
    todoRevision: target?.revision,
  };
}

function todoSetup(
  toolName: string,
  params: (todoId: string, state: TestState) => Record<string, unknown>,
  conflict: ScenarioBuild["conflict"],
  configure?: (pi: ExtensionAPI, state: TestState, todoId: string) => void,
): ScenarioBuild {
  const base = baseSetup();
  const node = addGoalTodo(base.pi, base.state, GOAL_ID, { title: "CAS wiring target", status: "ready" }, "tool");
  configure?.(base.pi, base.state, node.id);
  return finishSetup(base, toolName, params(node.id, base.state), conflict, 1, node.id);
}

function returnReadyClaim(pi: ExtensionAPI, state: TestState, todoId: string): void {
  linkGoalTodoDelegation(pi, state, GOAL_ID, todoId, { runId: `run-${todoId}`, status: "running", delegationDepth: 1 }, "delegation");
  returnGoalTodoClaim(pi, state, GOAL_ID, todoId, {
    runId: `run-${todoId}`,
    claimHash: "c".repeat(64),
    outputHash: "d".repeat(64),
    outputContract: "todo-child-result.v2",
    gatePassed: true,
    childGoalStatus: "ready_for_oracle",
    statusClaim: "done",
    targetReadiness: "ready_for_parent_acceptance",
    acceptanceBlockers: [],
    evidenceRefs: ["test/goal-todo-cas-wiring.test.ts"],
    validationCommands: ["node --test"],
    noShip: false,
  }, "delegation");
}

function callTool(build: ScenarioBuild, params: Record<string, unknown>): Promise<ToolResult> {
  return build.tool.execute("call", params, undefined, undefined, { cwd: process.cwd() });
}

function guardFor(build: ScenarioBuild, mutationId: string) {
  return {
    mutation_id: mutationId,
    expected_graph_revision: build.graphRevision,
    ...(build.todoRevision !== undefined ? { expected_todo_revision: build.todoRevision } : {}),
  };
}

function casRecord(result: ToolResult): Record<string, unknown> {
  const cas = result.details.cas;
  assert.ok(cas && typeof cas === "object" && !Array.isArray(cas));
  return cas as Record<string, unknown>;
}

async function assertGuardedToolEndNoPersistence(build: ScenarioBuild, params: Record<string, unknown>, result: ToolResult): Promise<void> {
  registerGoalRuntimeEvents(build.pi, build.state, () => undefined);
  const handler = build.handlers.get("tool_execution_end");
  assert.ok(handler);
  const entriesBefore = build.entries.length;
  const stateBefore = JSON.stringify(build.state);
  await handler({ toolName: build.tool.name, args: params, result }, { ui: { setStatus: () => undefined } });
  assert.equal(build.entries.length, entriesBefore, `${build.tool.name} guarded post-hook emits no entry`);
  assert.equal(JSON.stringify(build.state), stateBefore, `${build.tool.name} guarded post-hook advances no revision/state`);
}

function normalizedContent(result: ToolResult): ToolResult["content"] {
  return result.content.map((item) => ({ ...item, text: item.text.replace(/todo_[A-Za-z0-9]+/g, "todo_<id>") }));
}

const scenarios: Scenario[] = [
  {
    name: "add single",
    setup: () => {
      const base = baseSetup();
      return finishSetup(base, "add_goal_todo", { title: "single CAS item", priority: "high" }, (params) => ({ ...params, title: "changed single CAS item" }), 1);
    },
  },
  {
    name: "add batch",
    setup: () => {
      const base = baseSetup();
      return finishSetup(base, "add_goal_todos", { todos: [{ title: "batch one" }, { title: "batch two", required: false }] }, (params) => {
        const todos = params.todos as Array<Record<string, unknown>>;
        return { ...params, todos: [{ ...todos[0], title: "changed batch one" }, todos[1]] };
      }, 2);
    },
  },
  {
    name: "update",
    setup: () => todoSetup("update_goal_todo", (todoId) => ({ todo_id: todoId, title: "updated by CAS", priority: "high" }), (params) => ({ ...params, title: "conflicting update" })),
  },
  {
    name: "resolve auto",
    setup: () => todoSetup("resolve_goal_todo", (todoId) => ({ todo_id: todoId, action: "auto", evidence_refs: ["test/goal-todo-cas-wiring.test.ts"] }), (params) => ({ ...params, evidence_refs: ["different/ref"] })),
  },
  {
    name: "resolve complete",
    setup: () => todoSetup("resolve_goal_todo", (todoId) => ({ todo_id: todoId, action: "complete", validation_commands: ["node --test"] }), (params) => ({ ...params, validation_commands: ["different command"] })),
  },
  {
    name: "resolve block",
    setup: () => todoSetup("resolve_goal_todo", (todoId) => ({ todo_id: todoId, action: "block", reason: "blocked by CAS test" }), (params) => ({ ...params, reason: "different blocker" })),
  },
  {
    name: "resolve skip",
    setup: () => todoSetup("resolve_goal_todo", (todoId) => ({ todo_id: todoId, action: "skip", reason: "bounded skip" }), (params) => ({ ...params, reason: "different skip" })),
  },
  {
    name: "complete compatibility alias",
    setup: () => todoSetup("complete_goal_todo", (todoId) => ({ todo_id: todoId, evidence_refs: ["test/goal-todo-cas-wiring.test.ts"] }), (params) => ({ ...params, evidence_refs: ["different/ref"] })),
  },
  {
    name: "block compatibility alias",
    setup: () => todoSetup("block_goal_todo", (todoId) => ({ todo_id: todoId, reason: "compatibility blocker" }), (params) => ({ ...params, reason: "different blocker" })),
  },
  {
    name: "split",
    setup: () => {
      const base = baseSetup();
      const parent = addGoalTodo(base.pi, base.state, GOAL_ID, { title: "split parent", status: "in_progress" }, "tool");
      return finishSetup(base, "split_goal_todo", { todo_id: parent.id, titles: ["split one", "split two"] }, (params) => ({ ...params, titles: ["different split"] }), 3, parent.id);
    },
  },
  {
    name: "factory import",
    setup: () => {
      const base = baseSetup();
      return finishSetup(base, "import_factory_todos", { run_id: "cas-wiring-missing-factory" }, (params) => ({ ...params, run_id: "cas-wiring-other-factory" }), 7);
    },
  },
  {
    name: "orchestration import",
    setup: () => {
      const base = baseSetup();
      return finishSetup(base, "import_orchestration_todos", { run_id: "cas-wiring-missing-orchestration" }, (params) => ({ ...params, run_id: "cas-wiring-other-orchestration" }), 9);
    },
  },
  {
    name: "chain import",
    setup: () => {
      const base = baseSetup();
      return finishSetup(base, "import_chain_todos", { run_id: "cas-wiring-missing-chain" }, (params) => ({ ...params, run_id: "cas-wiring-other-chain" }), 5);
    },
  },
];

for (const scenario of scenarios) {
  test(`public mutator CAS apply/replay/conflict/stale and legacy compatibility: ${scenario.name}`, async () => {
    const legacy = scenario.setup();
    const legacyResult = await callTool(legacy, legacy.params);
    assert.equal(legacyResult.isError, undefined);
    assert.equal(legacyResult.details.cas, undefined);
    assert.equal(legacy.entries.filter((entry) => entry.type === TODO_ENTRY_TYPE).length, legacy.expectedEvents);
    assert.equal(legacy.entries.filter((entry) => entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE).length, 0);

    const build = scenario.setup();
    const mutationId = `mutation-${scenario.name.replace(/[^A-Za-z0-9]+/g, "-")}`;
    const cas = guardFor(build, mutationId);
    const guardedParams = { ...build.params, cas };
    const applied = await callTool(build, guardedParams);
    const appliedCas = casRecord(applied);
    assert.equal(applied.isError, undefined);
    assert.equal(appliedCas.status, "applied");
    assert.deepEqual(normalizedContent(applied), normalizedContent(legacyResult), "guarded apply preserves the legacy message");
    assert.equal(build.state.goalTodos.graphRevisions[GOAL_ID], build.graphRevision + build.expectedEvents);

    const phaseEntries = build.entries.filter((entry) => entry.type === GOAL_MUTATION_PREPARATION_ENTRY_TYPE);
    const todoEntries = build.entries.filter((entry) => entry.type === TODO_ENTRY_TYPE);
    const receiptEntries = build.entries.filter((entry) => entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE);
    assert.equal(phaseEntries.length, 1);
    assert.equal((phaseEntries[0]?.data as { phase: string }).phase, "prepared");
    assert.equal(todoEntries.length, build.expectedEvents);
    assert.equal(receiptEntries.length, 1);
    assert.equal(build.entries[0]?.type, GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "prepared persists before mutation events");
    assert.equal(build.entries.at(-1)?.type, GOAL_MUTATION_RECEIPT_ENTRY_TYPE, "applied receipt persists after mutation events");
    assert.deepEqual(todoEntries.map((entry) => (entry.data as { graphRevision: number }).graphRevision), Array.from({ length: build.expectedEvents }, (_value, index) => build.graphRevision + index + 1));

    const receipt = receiptEntries[0]?.data as Record<string, unknown>;
    assert.equal(receipt.phase, "applied");
    assert.equal(receipt.bodyStored, false);
    assert.equal(receipt.eventCount, build.expectedEvents);
    assert.equal(receipt.mutationId, mutationId);
    assert.equal("payload" in receipt, false);
    assert.equal(JSON.stringify(receipt).includes("sourceHashes"), false);
    assert.deepEqual((appliedCas.receipt as Record<string, unknown>).requestHash, receipt.requestHash);
    await assertGuardedToolEndNoPersistence(build, guardedParams, applied);

    build.entries.length = 0;
    const stateAfterApply = JSON.stringify(build.state.goalTodos);
    const replayed = await callTool(build, guardedParams);
    assert.equal(casRecord(replayed).status, "replayed");
    assert.equal(replayed.isError, undefined);
    assert.equal(build.entries.length, 0);
    assert.equal(JSON.stringify(build.state.goalTodos), stateAfterApply);
    await assertGuardedToolEndNoPersistence(build, guardedParams, replayed);

    const conflictParams = build.conflict(guardedParams);
    const conflicted = await callTool(build, conflictParams);
    assert.equal(conflicted.isError, true);
    assert.equal(casRecord(conflicted).status, "conflict");
    assert.deepEqual(casRecord(conflicted).failureCodes, ["mutation_id_conflict"]);
    assert.equal(build.entries.length, 0);
    assert.equal(JSON.stringify(build.state.goalTodos), stateAfterApply);
    await assertGuardedToolEndNoPersistence(build, conflictParams, conflicted);

    const staleParams = { ...build.params, cas: guardFor(build, `${mutationId}-stale`) };
    const stale = await callTool(build, staleParams);
    assert.equal(stale.isError, true);
    assert.equal(casRecord(stale).status, "stale");
    assert.ok((casRecord(stale).failureCodes as string[]).includes("stale_graph_revision"));
    assert.equal(build.entries.length, 0);
    assert.equal(JSON.stringify(build.state.goalTodos), stateAfterApply);
    await assertGuardedToolEndNoPersistence(build, staleParams, stale);
  });
}

test("public terminal reopen fails closed without CAS and succeeds only with exact graph/TODO revisions", async () => {
  const legacy = todoSetup("resolve_goal_todo", (todoId) => ({
    todo_id: todoId,
    action: "reopen",
    reason: "parent-owned retry",
    evidence_refs: ["test/goal-todo-cas-wiring.test.ts"],
  }), (params) => params, (pi, state, todoId) => {
    completeGoalTodo(pi, state, GOAL_ID, todoId, {}, "tool");
  });
  await assert.rejects(() => callTool(legacy, legacy.params), /code=cas_required current=done action=reopen/);
  assert.equal(legacy.entries.length, 0);
  assert.equal(legacy.state.goalTodos.nodes.find((node) => node.id === legacy.targetId)?.status, "done");

  const guarded = todoSetup("resolve_goal_todo", (todoId) => ({
    todo_path: "1",
    action: "reopen",
    reason: "parent-owned retry",
    evidence_refs: ["test/goal-todo-cas-wiring.test.ts"],
  }), (params) => params, (pi, state, todoId) => {
    completeGoalTodo(pi, state, GOAL_ID, todoId, {}, "tool");
  });
  const result = await callTool(guarded, { ...guarded.params, cas: guardFor(guarded, "mutation-reopen-domain-context") });
  assert.equal(casRecord(result).status, "applied");
  assert.equal((result.details.node as { status: string }).status, "ready");
  assert.deepEqual(guarded.entries.map((entry) => [entry.type, (entry.data as { phase?: string }).phase]), [
    [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "prepared"],
    [TODO_ENTRY_TYPE, undefined],
    [GOAL_MUTATION_RECEIPT_ENTRY_TYPE, "applied"],
  ]);
  assert.equal(guarded.state.goalTodos.nodes.find((node) => node.id === guarded.targetId)?.status, "ready");
});

test("mutation-id-only public node update emits a valid canonical todoId/todoRevision receipt pair", async () => {
  const build = todoSetup("update_goal_todo", (todoId) => ({ todo_id: todoId, title: "mutation-id-only update" }), (params) => params);
  const result = await callTool(build, { ...build.params, cas: { mutation_id: "mutation-id-only-node" } });
  assert.equal(casRecord(result).status, "applied");
  const receipt = build.entries.find((entry) => entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE)?.data as Record<string, unknown>;
  assert.equal(receipt.todoId, build.targetId);
  assert.equal(receipt.todoRevision, (build.todoRevision ?? 0) + 1);
  assert.equal(receipt.expectedTodoRevision, undefined);
  assert.equal((receipt.todoId === undefined) === (receipt.todoRevision === undefined), true);
});

test("add_goal_todo receipt outage then restart restores unmatched prepared and blocks duplicate creation", async () => {
  const original = baseSetup();
  registerGoalRuntimeTools(original.pi, original.state);
  const tool = original.tools.get("add_goal_todo");
  assert.ok(tool);
  const mutablePi = original.pi as unknown as { appendEntry: (type: string, data: unknown) => void };
  const append = mutablePi.appendEntry.bind(mutablePi);
  mutablePi.appendEntry = (type, data) => {
    if (type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE) throw new Error("simulated receipt outage");
    append(type, data);
  };
  const params = { title: "created once before outage", cas: { mutation_id: "todo-restart-outage" } };
  const failed = await tool.execute("outage", params, undefined, undefined, { cwd: process.cwd() });
  assert.equal(failed.isError, true);
  assert.deepEqual(casRecord(failed).failureCodes, ["receipt_persistence_failed"]);
  assert.equal(original.entries.filter((entry) => entry.type === GOAL_MUTATION_PREPARATION_ENTRY_TYPE).length, 1);
  assert.equal(original.entries.filter((entry) => entry.type === TODO_ENTRY_TYPE).length, 1);
  assert.equal(original.entries.filter((entry) => entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE).length, 0);
  assert.equal(original.state.goalTodos.nodes.length, 1);

  const branch = original.entries.map((entry) => ({ customType: entry.type, data: entry.data }));
  const restartedCapture = capturePi();
  const restartedState = createHarnessRuntimeState();
  restartedState.runtimeGoal = { goalId: GOAL_ID, revision: 0 } as NonNullable<TestState["runtimeGoal"]>;
  restartedState.goalTodos = restoreGoalTodosFromBranch(branch);
  registerGoalRuntimeTools(restartedCapture.pi, restartedState);
  const restartedTool = restartedCapture.tools.get("add_goal_todo");
  assert.ok(restartedTool);
  assert.equal(restartedState.goalTodos.nodes.length, 1);
  assert.equal(restartedState.goalTodos.nodes[0]?.title, "created once before outage");
  assert.equal(restartedState.goalTodos.graphRevisions[GOAL_ID], 1);
  assert.equal(restartedState.goalTodos.mutationReceipts.inDoubtByGoal[GOAL_ID]?.["todo-restart-outage"]?.phase, "prepared");

  const retry = await restartedTool.execute("retry", params, undefined, undefined, { cwd: process.cwd() });
  assert.equal(retry.isError, true);
  assert.deepEqual(casRecord(retry).failureCodes, ["mutation_in_doubt"]);
  assert.equal(restartedCapture.entries.length, 0);
  assert.equal(restartedState.goalTodos.nodes.length, 1);
  assert.equal(restartedState.goalTodos.graphRevisions[GOAL_ID], 1);
});

test("guarded restore blocks before prepare while pre-apply policy rejection records prepared/aborted only", async () => {
  const blocked = todoSetup("update_goal_todo", (todoId) => ({ todo_id: todoId, title: "must not apply" }), (params) => params);
  blocked.state.goalTodos.restoreBlocked![GOAL_ID] = {
    code: "graph_revision_gap",
    goalId: GOAL_ID,
    eventKind: "patch",
    at: 1,
    message: "test restore block",
  };
  const blockedBefore = JSON.stringify(blocked.state.goalTodos);
  const blockedResult = await callTool(blocked, { ...blocked.params, cas: guardFor(blocked, "mutation-restore-blocked") });
  assert.equal(blockedResult.isError, true);
  assert.equal(casRecord(blockedResult).status, "rejected");
  assert.deepEqual(casRecord(blockedResult).failureCodes, ["state_restore_blocked"]);
  assert.equal(blocked.entries.length, 0);
  assert.equal(JSON.stringify(blocked.state.goalTodos), blockedBefore);

  const rejected = todoSetup("update_goal_todo", (todoId) => ({ todo_id: todoId, status: "done" }), (params) => params);
  const rejectedDomainBefore = JSON.stringify({ nodes: rejected.state.goalTodos.nodes, graphRevisions: rejected.state.goalTodos.graphRevisions });
  await assert.rejects(() => callTool(rejected, { ...rejected.params, cas: guardFor(rejected, "mutation-policy-rejected") }), /cannot mark TODOs done or skipped/);
  assert.deepEqual(rejected.entries.map((entry) => [entry.type, (entry.data as { phase?: string }).phase]), [
    [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "prepared"],
    [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "aborted"],
  ]);
  assert.equal(rejected.entries.some((entry) => entry.type === TODO_ENTRY_TYPE || entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE), false);
  assert.equal(JSON.stringify({ nodes: rejected.state.goalTodos.nodes, graphRevisions: rejected.state.goalTodos.graphRevisions }), rejectedDomainBefore);
  assert.equal(rejected.state.goalTodos.mutationReceipts.protocolByGoal[GOAL_ID]?.["mutation-policy-rejected"]?.phase, "aborted");
});
