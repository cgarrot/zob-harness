import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GOAL_MUTATION_RECEIPT_ENTRY_TYPE,
  GoalTodoReferenceResolutionError,
  acceptGoalTodoClaim,
  addGoalTodo,
  createHarnessRuntimeState,
  finalizeGoalTodoDelegationAttempt,
  linkGoalTodoDelegation,
  restoreGoalTodosFromBranch,
  returnGoalTodoClaim,
} from "../.pi/extensions/zob-harness/index.ts";
import { finishDelegationRun, startDelegationRun } from "../.pi/extensions/zob-harness/src/runtime/delegation-monitor.ts";
import { registerGoalRuntimeTools } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ID = "goal-delegation-recovery";
const TODO_ENTRY_TYPE = "zob-goal-todo";
const EVIDENCE_REF = "test/goal-todo-delegation-recovery.test.ts";

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

function setup(status: "failed_runtime" | "cancelled" | "failed_output_gate_semantic" | "liveness_unknown" = "failed_runtime") {
  const entries: Entry[] = [];
  const tools = new Map<string, CapturedTool>();
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    registerTool(tool: CapturedTool) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  state.runtimeGoal = { goalId: GOAL_ID, revision: 7 } as NonNullable<TestState["runtimeGoal"]>;
  const todo = addGoalTodo(pi, state, GOAL_ID, { title: "recover exact delegation", status: "ready" }, "tool");
  const runId = `run-${status}`;
  linkGoalTodoDelegation(pi, state, GOAL_ID, todo.id, { attemptId: `attempt-${status}`, runId, requestId: `request-${status}`, status: "running" }, "delegation");
  finalizeGoalTodoDelegationAttempt(pi, state, GOAL_ID, todo.id, {
    attemptId: `attempt-${status}`,
    runId,
    requestId: `request-${status}`,
    status,
    reasonCode: status === "cancelled" ? "child_aborted"
      : status === "failed_output_gate_semantic" ? "output_gate_semantic"
        : status === "liveness_unknown" ? "liveness_unknown"
          : "child_runtime_failed",
    failureKind: status === "cancelled" ? "aborted"
      : status === "failed_output_gate_semantic" ? "output_gate"
        : status === "failed_runtime" ? "child_runtime"
          : undefined,
    failureHash: status === "failed_runtime" || status === "cancelled" ? "f".repeat(64) : undefined,
    outputHash: status === "failed_output_gate_semantic" ? "d".repeat(64) : undefined,
    gateIssueCodes: status === "failed_output_gate_semantic" ? ["mismatched_todo_id"] : undefined,
    gateIssueCount: status === "failed_output_gate_semantic" ? 1 : undefined,
  }, "delegation");
  registerGoalRuntimeTools(pi, state);
  const tool = tools.get("recover_goal_todo_delegation");
  assert.ok(tool);
  return { pi, state, entries, tools, tool, todoId: todo.id, runId, attemptId: `attempt-${status}` };
}

function node(built: ReturnType<typeof setup>) {
  return built.state.goalTodos.nodes.find((candidate) => candidate.id === built.todoId)!;
}

function recoveryParams(built: ReturnType<typeof setup>, mutationId: string, ref: "id" | "path" | "dual" = "id") {
  const target = node(built);
  const reference = ref === "id"
    ? { todo_id: target.id }
    : ref === "path"
      ? { todo_path: target.path }
      : { todo_id: target.id, todo_path: target.path };
  return {
    ...reference,
    expected_attempt_id: built.attemptId,
    expected_run_id: built.runId,
    reason: "parent verified exact inactive attempt",
    evidence_refs: [EVIDENCE_REF],
    proof_refs: [EVIDENCE_REF],
    cas: {
      mutation_id: mutationId,
      expected_graph_revision: built.state.goalTodos.graphRevisions[GOAL_ID],
      expected_todo_revision: target.revision,
    },
  };
}

function call(built: ReturnType<typeof setup>, params: Record<string, unknown>): Promise<ToolResult> {
  return built.tool.execute("recover-call", params, undefined, undefined, { cwd: process.cwd() });
}

function cas(result: ToolResult): Record<string, unknown> {
  assert.ok(result.details.cas && typeof result.details.cas === "object");
  return result.details.cas as Record<string, unknown>;
}

function clearEntries(built: ReturnType<typeof setup>): void {
  built.entries.length = 0;
}

test("public recovery fails closed with DELEGATION_ACTIVE for an exact live monitor run", async () => {
  const built = setup("failed_runtime");
  startDelegationRun(built.state.delegations, {
    id: built.runId,
    parentToolCallId: "parent-live",
    source: "delegate_task",
    mode: "single",
    agent: "implementer",
    task: "still running",
    startedAtMs: 1_725_000_000_000,
  });
  clearEntries(built);
  const before = JSON.stringify(built.state.goalTodos);
  const result = await call(built, recoveryParams(built, "recover-active"));
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "DELEGATION_ACTIVE");
  assert.equal(result.details.mutated, false);
  assert.equal((result.details.liveness as { status: string }).status, "active");
  assert.equal(built.entries.length, 0);
  assert.equal(JSON.stringify(built.state.goalTodos), before);
});

test("public recovery accepts exact terminal monitor proof for a liveness-unknown attempt", async () => {
  const built = setup("liveness_unknown");
  startDelegationRun(built.state.delegations, {
    id: built.runId,
    parentToolCallId: "parent-terminal",
    source: "delegate_task",
    mode: "single",
    agent: "implementer",
    task: "terminal",
    startedAtMs: 1_725_000_000_000,
  });
  finishDelegationRun(built.state.delegations, built.runId, { status: "failed", endedAtMs: 1_725_000_000_100 });
  clearEntries(built);
  const result = await call(built, recoveryParams(built, "recover-monitor-terminal", "dual"));
  assert.equal(result.isError, undefined);
  assert.equal(cas(result).status, "applied");
  assert.equal((result.details.liveness as { code: string }).code, "monitor_terminal_exact");
  assert.equal(node(built).status, "ready");
  assert.equal(built.state.delegations.runs.length, 1, "recovery does not modify or launch monitor runs");
});

test("restored nonterminal monitor state remains liveness unknown and mutates nothing", async () => {
  const built = setup("liveness_unknown");
  built.state.delegations.runs.push({
    id: built.runId,
    parentToolCallId: built.runId,
    source: "delegate_task",
    mode: "single",
    agent: "implementer",
    taskPreview: "restored delegation",
    status: "running",
    startedAtMs: 1_725_000_000_000,
    outputPreview: "",
    stderrPreview: "",
  });
  clearEntries(built);
  const before = JSON.stringify(built.state.goalTodos);
  const result = await call(built, recoveryParams(built, "recover-restored-unknown"));
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "DELEGATION_LIVENESS_UNKNOWN");
  assert.equal(result.details.retry_policy, "after_authoritative_status");
  assert.equal((result.details.liveness as { code: string }).code, "restored_nonterminal_without_controller");
  assert.equal(built.entries.length, 0);
  assert.equal(JSON.stringify(built.state.goalTodos), before);
});

test("attempt and run mismatches reject before CAS preparation or mutation", async () => {
  for (const mismatch of [
    { expected_attempt_id: "attempt-wrong" },
    { expected_run_id: "run-wrong" },
  ]) {
    const built = setup("failed_runtime");
    clearEntries(built);
    const before = JSON.stringify(built.state.goalTodos);
    const result = await call(built, { ...recoveryParams(built, `recover-mismatch-${Object.keys(mismatch)[0]}`), ...mismatch });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "DELEGATION_ATTEMPT_MISMATCH");
    assert.equal(built.entries.length, 0);
    assert.equal(JSON.stringify(built.state.goalTodos), before);
  }
});

test("durable terminal recovery is exact, body-free, replayable, conflict/stale safe, and enables only later explicit delegation", async () => {
  const built = setup("failed_runtime");
  const branchBeforeRecovery = built.entries.map((entry) => ({ ...entry }));
  const originalAttempts = structuredClone(node(built).delegationAttempts);
  const monitorBefore = JSON.stringify(built.state.delegations);
  const backgroundBefore = built.state.backgroundDelegations.size;
  clearEntries(built);
  const params = recoveryParams(built, "recover-durable-exact", "path");
  const originalGraphRevision = (params.cas as { expected_graph_revision: number }).expected_graph_revision;
  const originalTodoRevision = (params.cas as { expected_todo_revision: number }).expected_todo_revision;

  const applied = await call(built, params);
  assert.equal(applied.isError, undefined);
  assert.equal(cas(applied).status, "applied");
  assert.equal((applied.details.liveness as { code: string }).code, "durable_child_terminal");
  const recovered = node(built);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.owner, "agent");
  assert.equal(recovered.delegation, undefined);
  assert.equal(recovered.claim, undefined);
  assert.equal(recovered.validation, undefined);
  assert.equal(recovered.blocker, undefined);
  assert.equal(recovered.reviewNoShip, undefined);
  assert.deepEqual(recovered.delegationAttempts, originalAttempts, "full attempt history is preserved field-for-field");
  assert.equal(JSON.stringify(built.state.delegations), monitorBefore, "recovery launches no monitor run");
  assert.equal(built.state.backgroundDelegations.size, backgroundBefore, "recovery launches no background child");

  assert.deepEqual(built.entries.map((entry) => entry.type), [
    GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
    TODO_ENTRY_TYPE,
    GOAL_MUTATION_RECEIPT_ENTRY_TYPE,
  ]);
  const event = built.entries.find((entry) => entry.type === TODO_ENTRY_TYPE)?.data as Record<string, unknown>;
  assert.equal(event.kind, "attempt_recovered");
  assert.equal(event.version, 2);
  const recovery = event.recovery as Record<string, unknown>;
  assert.equal(recovery.bodyStored, false);
  assert.equal((recovery.livenessProof as Record<string, unknown>).bodyStored, false);
  assert.equal(recovery.attemptId, built.attemptId);
  assert.equal(recovery.runId, built.runId);
  assert.equal(recovery.expectedGraphRevision, originalGraphRevision);
  assert.equal(recovery.expectedTodoRevision, originalTodoRevision);
  assert.match(String(recovery.reasonHash), /^[a-f0-9]{64}$/);
  assert.match(String(recovery.evidenceRefsHash), /^[a-f0-9]{64}$/);
  assert.match(String(recovery.proofRefsHash), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(event).includes("parent verified exact inactive attempt"), false, "raw reason is never persisted");

  const restored = restoreGoalTodosFromBranch([...branchBeforeRecovery, ...built.entries].map((entry) => ({ customType: entry.type, data: entry.data })));
  const restoredNode = restored.nodes.find((candidate) => candidate.id === built.todoId)!;
  assert.equal(restoredNode.status, "ready");
  assert.equal(restoredNode.delegation, undefined);
  assert.deepEqual(restoredNode.delegationAttempts, originalAttempts);

  built.entries.length = 0;
  const replayed = await call(built, params);
  assert.equal(replayed.isError, undefined);
  assert.equal(cas(replayed).status, "replayed");
  assert.equal(built.entries.length, 0, "exact replay emits no second recovery or receipt");
  assert.deepEqual(node(built).delegationAttempts, originalAttempts);

  const conflicted = await call(built, { ...params, reason: "different recovery reason" });
  assert.equal(conflicted.isError, true);
  assert.equal(cas(conflicted).status, "conflict");
  assert.deepEqual(cas(conflicted).failureCodes, ["mutation_id_conflict"]);
  assert.equal(built.entries.length, 0);

  const stale = await call(built, {
    ...params,
    cas: {
      mutation_id: "recover-durable-stale",
      expected_graph_revision: originalGraphRevision,
      expected_todo_revision: originalTodoRevision,
    },
  });
  assert.equal(stale.isError, true);
  assert.equal(cas(stale).status, "stale");
  assert.ok((cas(stale).failureCodes as string[]).includes("stale_graph_revision"));
  assert.equal(built.entries.length, 0);

  linkGoalTodoDelegation(built.pi, built.state, GOAL_ID, built.todoId, {
    attemptId: "attempt-explicit-later",
    runId: "run-explicit-later",
    requestId: "request-explicit-later",
    status: "running",
  }, "delegation");
  assert.equal(node(built).status, "delegated");
  assert.deepEqual(node(built).delegationAttempts?.map((attempt) => attempt.attemptId), [built.attemptId, "attempt-explicit-later"]);
  assert.equal(built.state.delegations.runs.length, 0, "explicit TODO linkage still does not auto-run a child");
});

test("claim-returned and accepted attempts cannot use delegation recovery", async () => {
  for (const settle of ["claim_returned", "accepted"] as const) {
    const built = setup("failed_runtime");
    // Replace the failed fixture with a fresh claim path on the same TODO only after explicit recovery.
    const firstParams = recoveryParams(built, `recover-before-${settle}`);
    await call(built, firstParams);
    linkGoalTodoDelegation(built.pi, built.state, GOAL_ID, built.todoId, { attemptId: `attempt-${settle}`, runId: `run-${settle}`, status: "running" }, "delegation");
    returnGoalTodoClaim(built.pi, built.state, GOAL_ID, built.todoId, {
      runId: `run-${settle}`,
      claimHash: "c".repeat(64),
      outputHash: "d".repeat(64),
      outputContract: "todo-child-result.v2",
      gatePassed: true,
      childGoalStatus: "ready_for_oracle",
      statusClaim: "done",
      targetReadiness: "ready_for_parent_acceptance",
      acceptanceBlockers: [],
      evidenceRefs: [EVIDENCE_REF],
      validationCommands: ["node --import tsx --test test/goal-todo-delegation-recovery.test.ts"],
      noShip: false,
    }, "delegation");
    if (settle === "accepted") {
      const current = node(built);
      acceptGoalTodoClaim(built.pi, built.state, GOAL_ID, built.todoId, {
        expectedClaimHash: current.claim!.claimHash,
        expectedAttemptId: current.claim!.attemptId!,
        expectedValidationPolicy: current.claim!.validationPolicy!,
        expectedGraphRevision: built.state.goalTodos.graphRevisions[GOAL_ID],
        expectedTodoRevision: current.revision ?? 0,
      });
    }
    const current = node(built);
    built.attemptId = current.delegationAttempts!.at(-1)!.attemptId;
    built.runId = current.delegationAttempts!.at(-1)!.runId;
    clearEntries(built);
    const result = await call(built, recoveryParams(built, `recover-claim-path-${settle}`));
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "DELEGATION_NOT_RECOVERABLE");
    assert.equal(built.entries.length, 0);
  }
});

test("recovery uses strict canonical refs and rejects a mismatched dual reference before mutation", async () => {
  const built = setup("failed_output_gate_semantic");
  const other = addGoalTodo(built.pi, built.state, GOAL_ID, { title: "other", status: "ready" }, "tool");
  clearEntries(built);
  await assert.rejects(
    () => call(built, { ...recoveryParams(built, "recover-ref-mismatch"), todo_id: built.todoId, todo_path: other.path }),
    (error: unknown) => error instanceof GoalTodoReferenceResolutionError && error.diagnostic.code === "reference_mismatch",
  );
  assert.equal(built.entries.length, 0);
});
