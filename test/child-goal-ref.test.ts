import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyChildGates, createHarnessRuntimeState } from "../.pi/extensions/zob-harness/index.ts";
import { registerDelegationTools } from "../.pi/extensions/zob-harness/src/runtime/tools-delegation/register.ts";
import {
  enforceChildGoalClaimCorrelation,
  linkChildGoalTodoDelegationIfReady,
  recordTodoClaimFromChildResult,
  resolveChildGoalTodoRef,
} from "../.pi/extensions/zob-harness/src/runtime/tools-delegation/helpers.ts";
import type { ChildResult } from "../.pi/extensions/zob-harness/src/types.ts";

const GOAL_A = "goal-child-a";
const GOAL_B = "goal-child-b";
const ROOT = "todo_aaaaaaaaaaaa";
const CHILD = "todo_bbbbbbbbbbbb";
const OTHER = "todo_cccccccccccc";
const CROSS_GOAL = "todo_dddddddddddd";
const AMBIGUOUS = "todo_eeeeeeeeeeee";
const ACTIVE = "todo_111111111111";
const DONE = "todo_222222222222";

function node(input: {
  id: string;
  path: string;
  goalId?: string;
  parentId?: string;
  status?: "ready" | "delegated" | "done";
  delegation?: { runId: string; delegationDepth: number; status: "running" };
  revision?: number;
}) {
  return {
    id: input.id,
    goalId: input.goalId ?? GOAL_A,
    parentId: input.parentId,
    path: input.path,
    depth: input.path.split(".").length,
    title: input.id,
    status: input.status ?? "ready",
    owner: "agent" as const,
    required: true,
    priority: "normal" as const,
    acceptanceCriteria: [],
    evidenceRefs: [],
    validationCommands: [],
    delegation: input.delegation,
    revision: input.revision ?? 3,
    createdAt: 1,
    updatedAt: 1,
  };
}

function state() {
  const runtime = createHarnessRuntimeState();
  runtime.runtimeGoal = {
    goalId: GOAL_A,
    objective: "strict child refs",
    status: "active",
    gateValid: true,
    gateRequired: false,
    oracle: { required: false, status: "none", evidenceRefs: [] },
    usage: { tokensUsed: 0, activeSeconds: 0, iterations: 0, toolCalls: 0 },
    loop: { enabled: true, maxTurns: 10, turnsUsed: 0 },
    revision: 7,
    revisionDiagnostics: [],
    createdAt: 1,
    updatedAt: 1,
  } as typeof runtime.runtimeGoal;
  runtime.goalTodos.graphRevisions[GOAL_A] = 9;
  runtime.goalTodos.graphRevisions[GOAL_B] = 2;
  runtime.goalTodos.nodes = [
    node({ id: ROOT, path: "1" }),
    node({ id: CHILD, path: "1.1", parentId: ROOT }),
    node({ id: OTHER, path: "2" }),
    node({ id: AMBIGUOUS, path: "2" }),
    node({ id: CROSS_GOAL, path: "1", goalId: GOAL_B }),
    node({ id: ACTIVE, path: "3", status: "delegated", delegation: { runId: "existing-run", delegationDepth: 1, status: "running" } }),
    node({ id: DONE, path: "4", status: "done" }),
  ];
  return runtime;
}

function todoOutput(todoId: string): string {
  return [
    "TODO_CHILD_RESULT.v2",
    "deliverable_delivered: yes",
    `todo_id: ${todoId}`,
    "child_goal_status: ready_for_oracle",
    "status_claim: done",
    "evidence: linked refs below",
    "evidence_refs:",
    "- test/child-goal-ref.test.ts",
    "validation_commands:",
    "- node --import tsx --test test/child-goal-ref.test.ts",
    "risks_blockers: none",
    "acceptance_blockers: none",
    "target_readiness: ready_for_parent_acceptance",
    "subtodo_delta_proposals: none",
    "no_ship: false",
    "compliance: parent-owned claim only",
    "FINAL_MARKER: TODO_CHILD_RESULT_V2_END",
  ].join("\n");
}

function childResult(output: string): ChildResult {
  return {
    agent: "implementer",
    task: "bounded child",
    exitCode: 0,
    output,
    stderr: "",
    outputContract: "todo-child-result.v2",
    usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2 },
  };
}

function fakePi(entries: Array<{ type: string; entry: unknown }>) {
  return {
    appendEntry(type: string, entry: unknown) {
      entries.push({ type, entry });
    },
  } as never;
}

test("child_goal canonical resolver accepts only strict ID/path/agreeing dual refs and binds revisions", () => {
  const runtime = state();
  const before = JSON.stringify(runtime.goalTodos);
  for (const input of [
    { todo_id: CHILD },
    { todo_path: "1.1" },
    { todo_id: CHILD, todo_path: "1.1" },
    { todo_id: CHILD, todo_path: "1.1", parent_todo_id: ROOT },
  ]) {
    const resolved = resolveChildGoalTodoRef(runtime, { objective: "child", ...input }, "attempt-1", "todo-child-result.v2");
    assert.deepEqual(resolved.errors, []);
    assert.equal(resolved.childGoal?.todo_id, CHILD);
    assert.equal(resolved.childGoal?.todo_path, "1.1");
    assert.equal(resolved.childGoal?.parent_todo_id, ROOT);
    assert.deepEqual(resolved.childGoal?.binding, {
      schema: "zob.child-goal-binding.v1",
      goal_id: GOAL_A,
      goal_revision: 7,
      graph_revision: 9,
      todo_id: CHILD,
      todo_path: "1.1",
      todo_revision: 3,
      parent_todo_id: ROOT,
      delegation_attempt_id: "attempt-1",
      validation_policy: "parent_review",
      expected_claim: {
        goal_id: GOAL_A,
        todo_id: CHILD,
        todo_path: "1.1",
        todo_revision: 3,
        delegation_attempt_id: "attempt-1",
        validation_policy: "parent_review",
        output_contract: "todo-child-result.v2",
      },
    });
  }
  const root = resolveChildGoalTodoRef(runtime, { objective: "root", todo_id: ROOT }, "attempt-root");
  assert.deepEqual(root.errors, []);
  assert.equal(root.childGoal?.parent_todo_id, undefined, "omitted parent is the explicit root-parent relation");
  assert.equal(JSON.stringify(runtime.goalTodos), before, "canonical preflight must be pure");
});

test("child_goal canonical resolver returns stable structured diagnostics without fallback", () => {
  const cases: Array<[string, { todo_id?: string; todo_path?: string; parent_todo_id?: string }, string, string]> = [
    ["ID/path mismatch", { todo_id: CHILD, todo_path: "1" }, "reference_mismatch", "references"],
    ["path used as ID", { todo_id: "1.1" }, "invalid_todo_id", "todo_id"],
    ["ID used as path", { todo_path: CHILD }, "invalid_todo_path", "todo_path"],
    ["stale ID", { todo_id: "todo_ffffffffffff" }, "todo_id_not_found", "todo_id"],
    ["cross-goal ID", { todo_id: CROSS_GOAL }, "todo_id_cross_goal", "todo_id"],
    ["ambiguous path", { todo_path: "2" }, "todo_path_ambiguous", "todo_path"],
    ["parent mismatch", { todo_id: CHILD, parent_todo_id: OTHER }, "parent_todo_mismatch", "parent_todo_id"],
    ["parent path rejected as ID", { todo_id: CHILD, parent_todo_id: "1" }, "invalid_todo_id", "parent_todo_id"],
    ["active same-leaf delegation", { todo_id: ACTIVE }, "active_delegation", "todo_id"],
    ["closed TODO", { todo_id: DONE }, "todo_not_delegatable", "todo_id"],
  ];
  for (const [label, input, code, field] of cases) {
    const runtime = state();
    const before = JSON.stringify(runtime.goalTodos);
    const resolved = resolveChildGoalTodoRef(runtime, { objective: label, ...input }, `attempt-${code}`);
    assert.equal(resolved.node, undefined, label);
    assert.equal(resolved.diagnostics[0]?.code, code, label);
    assert.equal(resolved.diagnostics[0]?.field, field, label);
    assert.ok(resolved.diagnostics[0]?.retry_policy, label);
    assert.ok((resolved.diagnostics[0]?.safe_next_actions.length ?? 0) > 0, label);
    assert.match(resolved.errors[0] ?? "", new RegExp(`code=${code}.*field=${field}.*retry_policy=.*safe_next_actions=.*candidates=`), label);
    assert.equal(JSON.stringify(runtime.goalTodos), before, `${label} must not mutate state`);
  }

  const noGoal = state();
  noGoal.runtimeGoal = undefined;
  assert.equal(resolveChildGoalTodoRef(noGoal, { objective: "no goal", todo_path: "1.1" }, "attempt-no-goal").diagnostics[0]?.code, "missing_goal_id");
});

test("unbound child_goal remains valid and strips any caller-supplied internal binding", () => {
  const runtime = state();
  runtime.runtimeGoal = undefined;
  const resolved = resolveChildGoalTodoRef(runtime, { objective: "unbound", binding: { spoofed: true } as never }, "attempt-unbound");
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.childGoal?.todo_id, undefined);
  assert.equal(resolved.childGoal?.todo_path, undefined);
  assert.equal(resolved.childGoal?.binding, undefined);
});

test("TODO output gate requires the exact bound canonical todo_id", () => {
  const exact = childResult(todoOutput(CHILD));
  applyChildGates(exact, { expectedTodoId: CHILD });
  assert.equal(exact.gatePassed, true);

  for (const wrong of ["1.1", ROOT, "todo_ffffffffffff"]) {
    const result = childResult(todoOutput(wrong));
    applyChildGates(result, { expectedTodoId: CHILD });
    assert.equal(result.gatePassed, false, wrong);
    assert.ok(result.gateIssues?.some((issue) => issue.classification === "output_gate_semantic" && issue.code === "mismatched_todo_id"), wrong);
  }
});

test("mismatched child result writes no claim; exact attempt-bound result returns one parent-owned claim", () => {
  const runtime = state();
  runtime.goalTodos.nodes = runtime.goalTodos.nodes.filter((candidate) => candidate.id !== AMBIGUOUS);
  const entries: Array<{ type: string; entry: unknown }> = [];
  const pi = fakePi(entries);
  const resolution = resolveChildGoalTodoRef(runtime, { objective: "claim", todo_id: CHILD, todo_path: "1.1", parent_todo_id: ROOT }, "attempt-claim");
  const bound = resolution.childGoal;
  assert.ok(bound?.binding);
  linkChildGoalTodoDelegationIfReady(pi, runtime, bound, "attempt-claim", "implementer");
  const afterLinkEntries = entries.length;

  const wrong = childResult(todoOutput("1.1"));
  applyChildGates(wrong, { expectedTodoId: bound?.binding?.expected_claim.todo_id });
  enforceChildGoalClaimCorrelation(runtime, bound, wrong, "attempt-claim");
  const rejected = recordTodoClaimFromChildResult(pi, runtime, bound, wrong, { runId: "attempt-claim" });
  assert.equal(rejected.validReadyClaim, false);
  assert.equal(entries.length, afterLinkEntries + 1, "semantic mismatch must append only a failed attempt event");
  assert.equal((entries.at(-1)?.entry as { kind?: string }).kind, "delegation_attempt_finalized");
  assert.equal(runtime.goalTodos.nodes.find((candidate) => candidate.id === CHILD)?.claim, undefined);

  const exactRuntime = state();
  exactRuntime.goalTodos.nodes = exactRuntime.goalTodos.nodes.filter((candidate) => candidate.id !== AMBIGUOUS);
  const exactEntries: Array<{ type: string; entry: unknown }> = [];
  const exactPi = fakePi(exactEntries);
  const exactBound = resolveChildGoalTodoRef(exactRuntime, { objective: "exact claim", todo_id: CHILD }, "attempt-exact").childGoal;
  linkChildGoalTodoDelegationIfReady(exactPi, exactRuntime, exactBound, "attempt-exact", "implementer");
  const exact = childResult(todoOutput(CHILD));
  applyChildGates(exact, { expectedTodoId: exactBound?.binding?.expected_claim.todo_id });
  enforceChildGoalClaimCorrelation(exactRuntime, exactBound, exact, "attempt-exact");
  assert.equal(exact.gatePassed, true);
  const accepted = recordTodoClaimFromChildResult(exactPi, exactRuntime, exactBound, exact, { runId: "attempt-exact" });
  assert.equal(accepted.validReadyClaim, true);
  assert.equal(accepted.todoId, CHILD);
  assert.equal(exactRuntime.goalTodos.nodes.find((candidate) => candidate.id === CHILD)?.claim?.runId, "attempt-exact");
});

test("bound claim correlation rejects stale node revisions and wrong delegation attempts", () => {
  const setup = () => {
    const runtime = state();
    runtime.goalTodos.nodes = runtime.goalTodos.nodes.filter((candidate) => candidate.id !== AMBIGUOUS);
    const entries: Array<{ type: string; entry: unknown }> = [];
    const pi = fakePi(entries);
    const bound = resolveChildGoalTodoRef(runtime, { objective: "correlate", todo_id: CHILD }, "correlation-run").childGoal;
    linkChildGoalTodoDelegationIfReady(pi, runtime, bound, "correlation-run", "implementer");
    const result = childResult(todoOutput(CHILD));
    applyChildGates(result, { expectedTodoId: CHILD });
    return { runtime, bound, result };
  };

  const wrongAttempt = setup();
  enforceChildGoalClaimCorrelation(wrongAttempt.runtime, wrongAttempt.bound, wrongAttempt.result, "other-run");
  assert.ok(wrongAttempt.result.gateIssues?.some((issue) => issue.code === "mismatched_delegation_attempt" && issue.classification === "output_gate_semantic"));

  const stale = setup();
  const node = stale.runtime.goalTodos.nodes.find((candidate) => candidate.id === CHILD)!;
  node.revision = (node.revision ?? 0) + 1;
  enforceChildGoalClaimCorrelation(stale.runtime, stale.bound, stale.result, "correlation-run");
  assert.ok(stale.result.gateIssues?.some((issue) => issue.code === "stale_child_goal_binding" && issue.classification === "output_gate_semantic"));
});

test("parallel sibling bindings stay collision-free while same-leaf double dispatch is blocked", () => {
  const runtime = state();
  runtime.goalTodos.nodes = runtime.goalTodos.nodes.filter((candidate) => candidate.id !== AMBIGUOUS);
  const entries: Array<{ type: string; entry: unknown }> = [];
  const pi = fakePi(entries);

  const first = resolveChildGoalTodoRef(runtime, { objective: "first", todo_id: CHILD }, "parallel-1").childGoal;
  linkChildGoalTodoDelegationIfReady(pi, runtime, first, "parallel-1", "implementer");
  const duplicate = resolveChildGoalTodoRef(runtime, { objective: "duplicate", todo_path: "1.1" }, "parallel-2");
  assert.equal(duplicate.diagnostics[0]?.code, "active_delegation");

  const sibling = resolveChildGoalTodoRef(runtime, { objective: "sibling", todo_id: ROOT }, "parallel-2").childGoal;
  linkChildGoalTodoDelegationIfReady(pi, runtime, sibling, "parallel-2", "qa");
  assert.equal(runtime.goalTodos.nodes.find((candidate) => candidate.id === CHILD)?.delegation?.runId, "parallel-1");
  assert.equal(runtime.goalTodos.nodes.find((candidate) => candidate.id === ROOT)?.delegation?.runId, "parallel-2");

  const firstResult = childResult(todoOutput(CHILD));
  applyChildGates(firstResult, { expectedTodoId: CHILD });
  enforceChildGoalClaimCorrelation(runtime, first, firstResult, "parallel-1");
  assert.equal(firstResult.gatePassed, true, "unrelated sibling graph revisions must not stale an exact node/attempt binding");
});

test("delegate_task and delegate_agent single/parallel/chain return child-ref diagnostics with zero runtime mutation", async () => {
  const runtime = state();
  const tools = new Map<string, any>();
  const entries: unknown[] = [];
  registerDelegationTools({
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    appendEntry(_type: string, entry: unknown) {
      entries.push(entry);
    },
  } as never, runtime);
  const cwd = mkdtempSync(join(tmpdir(), "zob-child-ref-zero-launch-"));
  const ctx = { cwd, hasUI: false } as never;
  const invalidChildGoal = { objective: "invalid", todo_id: "1.1" };
  const beforeTodos = JSON.stringify(runtime.goalTodos);
  const beforeRuns = JSON.stringify(runtime.delegations);

  const delegateTask = tools.get("delegate_task");
  const childGoalSchema = delegateTask.parameters.properties.child_goal;
  assert.equal(childGoalSchema.properties.todo_id.pattern, "^todo_[a-f0-9]{12}$");
  assert.equal(childGoalSchema.properties.parent_todo_id.pattern, "^todo_[a-f0-9]{12}$");
  assert.equal(childGoalSchema.properties.todo_path.pattern, "^[1-9]\\d*(?:\\.[1-9]\\d*)*$");
  const taskResult = await delegateTask.execute("task-call", {
    agent: "implementer",
    task: "bounded",
    expected_outcome: "none",
    must_do: ["none"],
    must_not_do: ["none"],
    context: "none",
    child_goal: invalidChildGoal,
  }, undefined, undefined, ctx);
  assert.equal(taskResult.details.results[0].preflightDiagnostics[0].code, "invalid_todo_id");

  const delegateAgent = tools.get("delegate_agent");
  const modes = [
    { agent: "implementer", task: "bounded", child_goal: invalidChildGoal },
    { tasks: [{ agent: "implementer", task: "bounded", child_goal: invalidChildGoal }, { agent: "qa", task: "bounded", child_goal: invalidChildGoal }] },
    { chain: [{ agent: "implementer", task: "bounded", child_goal: invalidChildGoal }, { agent: "qa", task: "{previous}", child_goal: invalidChildGoal }] },
  ];
  for (const params of modes) {
    const result = await delegateAgent.execute("agent-call", params, undefined, undefined, ctx);
    assert.ok(result.details.results.every((item: ChildResult) => item.preflightDiagnostics?.[0]?.code === "invalid_todo_id"));
  }

  assert.equal(JSON.stringify(runtime.goalTodos), beforeTodos);
  assert.equal(JSON.stringify(runtime.delegations), beforeRuns);
  assert.deepEqual(entries, []);
  assert.deepEqual(readdirSync(cwd), [], "reference preflight must not write delegation ledgers or child session state");
});
