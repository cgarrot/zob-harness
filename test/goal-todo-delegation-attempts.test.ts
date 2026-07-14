import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ZOB_GOAL_TODO_ENTRY_TYPE,
  acceptGoalTodoClaim,
  addGoalTodo,
  applyChildGates,
  assessDelegationAttemptLiveness,
  createHarnessRuntimeState,
  recoverGoalTodoDelegation,
  rejectGoalTodoClaim,
  restoreGoalTodosFromBranch,
} from "../.pi/extensions/zob-harness/index.ts";
import {
  enforceChildGoalClaimCorrelation,
  linkChildGoalTodoDelegationIfReady,
  recordBoundTodoDelegationPreflightFailure,
  recordTodoClaimFromChildResult,
  resolveChildGoalTodoRef,
} from "../.pi/extensions/zob-harness/src/runtime/tools-delegation/helpers.ts";
import { registerDelegationTools } from "../.pi/extensions/zob-harness/src/runtime/tools-delegation/register.ts";
import type { ChildResult } from "../.pi/extensions/zob-harness/src/types.ts";

const GOAL_ID = "goal-delegation-attempts";

type Entry = { customType: string; data: unknown };

function setup() {
  const entries: Entry[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
  } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  state.runtimeGoal = {
    goalId: GOAL_ID,
    objective: "durable attempts",
    status: "active",
    revision: 4,
  } as NonNullable<typeof state.runtimeGoal>;
  const todo = addGoalTodo(pi, state, GOAL_ID, { title: "attempt leaf", status: "ready" });
  return { pi, state, entries, todo };
}

function output(todoId: string, options: {
  childStatus?: "ready_for_oracle" | "incomplete" | "blocked";
  statusClaim?: "done" | "incomplete" | "blocked";
  readiness?: "ready_for_parent_acceptance" | "needs_parent_review" | "blocked";
  noShip?: boolean;
  blockers?: string;
} = {}): string {
  return [
    "TODO_CHILD_RESULT.v2",
    "deliverable_delivered: yes",
    `todo_id: ${todoId}`,
    `child_goal_status: ${options.childStatus ?? "ready_for_oracle"}`,
    `status_claim: ${options.statusClaim ?? "done"}`,
    "evidence: bounded refs",
    "evidence_refs:",
    "- test/goal-todo-delegation-attempts.test.ts",
    "validation_commands:",
    "- node --import tsx --test test/goal-todo-delegation-attempts.test.ts",
    "risks_blockers: none",
    `acceptance_blockers: ${options.blockers ?? "none"}`,
    `target_readiness: ${options.readiness ?? "ready_for_parent_acceptance"}`,
    "subtodo_delta_proposals: none",
    `no_ship: ${options.noShip === true ? "true" : "false"}`,
    "compliance: parent-owned claim only",
    "FINAL_MARKER: TODO_CHILD_RESULT_V2_END",
  ].join("\n");
}

function childResult(text: string, overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    agent: "implementer",
    task: "bounded attempt",
    exitCode: 0,
    output: text,
    stderr: "",
    outputContract: "todo-child-result.v2",
    usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2 },
    ...overrides,
  };
}

function begin(setupState: ReturnType<typeof setup>, runId: string) {
  const childGoal = resolveChildGoalTodoRef(setupState.state, {
    objective: runId,
    todo_id: setupState.todo.id,
    request_id: `request-${runId}`,
    delegation_depth: 1,
  }, runId, "todo-child-result.v2").childGoal;
  assert.ok(childGoal?.binding);
  linkChildGoalTodoDelegationIfReady(setupState.pi, setupState.state, childGoal, runId, "implementer");
  return childGoal;
}

function finish(setupState: ReturnType<typeof setup>, childGoal: ReturnType<typeof begin>, runId: string, result: ChildResult) {
  applyChildGates(result, { expectedTodoId: setupState.todo.id });
  enforceChildGoalClaimCorrelation(setupState.state, childGoal, result, runId);
  return recordTodoClaimFromChildResult(setupState.pi, setupState.state, childGoal, result, { runId });
}

function canonicalNode(setupState: ReturnType<typeof setup>) {
  return setupState.state.goalTodos.nodes.find((node) => node.id === setupState.todo.id)!;
}

function exactClaimBinding(setupState: ReturnType<typeof setup>) {
  const node = canonicalNode(setupState);
  assert.ok(node.claim?.claimHash && node.claim.attemptId && node.claim.validationPolicy);
  return {
    expectedClaimHash: node.claim.claimHash,
    expectedAttemptId: node.claim.attemptId,
    expectedValidationPolicy: node.claim.validationPolicy,
    expectedGraphRevision: setupState.state.goalTodos.graphRevisions[GOAL_ID],
    expectedTodoRevision: node.revision ?? 0,
  };
}

function recoverLatest(setupState: ReturnType<typeof setup>): void {
  const node = canonicalNode(setupState);
  const attempt = node.delegationAttempts?.at(-1);
  assert.ok(attempt);
  const proof = assessDelegationAttemptLiveness(setupState.state.delegations, attempt);
  assert.equal(proof.status, "inactive");
  recoverGoalTodoDelegation(setupState.pi, setupState.state, GOAL_ID, node.id, {
    expectedAttemptId: attempt.attemptId,
    expectedRunId: attempt.runId,
    expectedGraphRevision: setupState.state.goalTodos.graphRevisions[GOAL_ID],
    expectedTodoRevision: node.revision ?? 0,
    reason: "explicit test recovery",
    evidenceRefs: ["test/goal-todo-delegation-attempts.test.ts"],
    proofRefs: ["test/goal-todo-delegation-attempts.test.ts"],
    livenessProof: proof,
  });
}

function assertNoPseudoClaim(setupState: ReturnType<typeof setup>): void {
  const node = canonicalNode(setupState);
  assert.equal(node.claim, undefined);
  assert.notEqual(node.status, "claim_returned");
  assert.notEqual(node.status, "needs_review");
  assert.notEqual(node.delegation?.status, "claim_returned");
}

test("preflight, runtime, format, semantic, and declared-incomplete outcomes finalize body-free attempts with zero pseudo-claims", () => {
  const preflight = setup();
  const preflightGoal = resolveChildGoalTodoRef(preflight.state, { objective: "preflight", todo_id: preflight.todo.id }, "attempt-preflight", "todo-child-result.v2").childGoal;
  recordBoundTodoDelegationPreflightFailure(preflight.pi, preflight.state, preflightGoal, {
    runId: "attempt-preflight",
    agent: "implementer",
    failureKind: "preflight",
    errors: ["SENSITIVE PREFLIGHT BODY MUST NOT PERSIST"],
  });
  assert.equal(canonicalNode(preflight).delegationAttempts?.at(-1)?.status, "failed_preflight");
  assert.equal(canonicalNode(preflight).delegationAttempts?.at(-1)?.reasonCode, "preflight_policy_failed");
  assertNoPseudoClaim(preflight);
  const preflightEvent = preflight.entries.at(-1)?.data as Record<string, unknown>;
  assert.equal(preflightEvent.kind, "delegation_attempt_finalized");
  assert.equal(JSON.stringify(preflightEvent).includes("SENSITIVE PREFLIGHT BODY MUST NOT PERSIST"), false);
  assert.equal((preflightEvent.attempt as { bodyStored: boolean }).bodyStored, false);

  const runtime = setup();
  const runtimeGoal = begin(runtime, "attempt-runtime");
  finish(runtime, runtimeGoal, "attempt-runtime", childResult(output(runtime.todo.id), {
    exitCode: 1,
    stopReason: "error",
    errorMessage: "SENSITIVE RUNTIME ERROR MUST NOT PERSIST",
  }));
  assert.equal(canonicalNode(runtime).delegationAttempts?.at(-1)?.status, "failed_runtime");
  assert.equal(canonicalNode(runtime).delegationAttempts?.at(-1)?.reasonCode, "child_runtime_failed");
  assert.equal(JSON.stringify(runtime.entries.at(-1)?.data).includes("SENSITIVE RUNTIME ERROR MUST NOT PERSIST"), false);
  assertNoPseudoClaim(runtime);

  const format = setup();
  const formatGoal = begin(format, "attempt-format");
  finish(format, formatGoal, "attempt-format", childResult(`todo_id: ${format.todo.id}\ndeliverable_delivered: yes`));
  assert.equal(canonicalNode(format).delegationAttempts?.at(-1)?.status, "failed_output_gate_format");
  assert.ok((canonicalNode(format).delegationAttempts?.at(-1)?.gateIssueCount ?? 0) > 0);
  assertNoPseudoClaim(format);

  const semantic = setup();
  const semanticGoal = begin(semantic, "attempt-semantic");
  finish(semantic, semanticGoal, "attempt-semantic", childResult(output("todo_ffffffffffff")));
  assert.equal(canonicalNode(semantic).delegationAttempts?.at(-1)?.status, "failed_output_gate_semantic");
  assert.equal(canonicalNode(semantic).delegationAttempts?.at(-1)?.reasonCode, "output_gate_semantic");
  assertNoPseudoClaim(semantic);

  const incomplete = setup();
  const incompleteGoal = begin(incomplete, "attempt-incomplete");
  const incompleteResult = childResult(output(incomplete.todo.id, {
    childStatus: "incomplete",
    statusClaim: "incomplete",
    readiness: "needs_parent_review",
  }));
  finish(incomplete, incompleteGoal, "attempt-incomplete", incompleteResult);
  assert.equal(incompleteResult.gatePassed, true, "declared incomplete is a semantic outcome, not a format failure");
  assert.equal(canonicalNode(incomplete).delegationAttempts?.at(-1)?.status, "output_declared_incomplete");
  assertNoPseudoClaim(incomplete);
});

test("delegate_agent and delegate_task persist bound preflight failures without launching or claiming", async () => {
  const built = setup();
  const tools = new Map<string, any>();
  const pi = {
    appendEntry(customType: string, data: unknown) { built.entries.push({ customType, data }); },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  registerDelegationTools(pi, built.state);
  const cwd = mkdtempSync(join(tmpdir(), "zob-attempt-preflight-"));
  const ctx = { cwd, hasUI: false } as never;

  const agentResult = await tools.get("delegate_agent").execute("agent-preflight", {
    agent: "missing-agent",
    task: "bounded",
    child_goal: { objective: "agent preflight", todo_id: built.todo.id },
  }, undefined, undefined, ctx);
  assert.equal(agentResult.details.results[0].failureKind, "config");
  assert.equal(canonicalNode(built).delegationAttempts?.at(-1)?.status, "failed_preflight");
  assertNoPseudoClaim(built);
  recoverLatest(built);

  const taskResult = await tools.get("delegate_task").execute("task-preflight", {
    agent: "missing-agent",
    task: "bounded",
    expected_outcome: "none",
    must_do: ["stay bounded"],
    must_not_do: ["do not launch"],
    context: "bounded",
    child_goal: { objective: "task preflight", todo_id: built.todo.id },
  }, undefined, undefined, ctx);
  assert.equal(taskResult.details.results[0].failureKind, "config");
  assert.deepEqual(canonicalNode(built).delegationAttempts?.map((attempt) => attempt.status), ["failed_preflight", "failed_preflight"]);
  assert.equal(new Set(canonicalNode(built).delegationAttempts?.map((attempt) => attempt.attemptId)).size, 2);
  assertNoPseudoClaim(built);
  const ledgers = built.entries.filter((entry) => entry.customType === "zob-delegation").map((entry) => entry.data as Record<string, unknown>);
  assert.ok(ledgers.length >= 2);
  assert.ok(ledgers.every((entry) => entry.bodyStored === false && entry.promptBodiesStored === false && entry.outputBodiesStored === false));
  assert.ok(ledgers.every((entry) => !("errors" in entry) && !("gateErrors" in entry)));
});

test("only an exact gate-passed parent-ready result creates one canonical claim", () => {
  const built = setup();
  const childGoal = begin(built, "attempt-valid");
  const record = finish(built, childGoal, "attempt-valid", childResult(output(built.todo.id)));
  const node = canonicalNode(built);
  assert.equal(record.validReadyClaim, true);
  assert.equal(node.status, "claim_returned");
  assert.equal(node.claim?.runId, "attempt-valid");
  assert.equal(node.claim?.gatePassed, true);
  assert.equal(node.delegationAttempts?.length, 1);
  assert.equal(node.delegationAttempts?.[0]?.status, "claim_returned");
  assert.equal(node.delegation?.status, "claim_returned");
  assert.equal(node.delegation?.attemptId, "attempt-valid");
});

test("claim acceptance and rejection settle the same attempt without erasing history", () => {
  const accepted = setup();
  const acceptedGoal = begin(accepted, "attempt-accepted");
  finish(accepted, acceptedGoal, "attempt-accepted", childResult(output(accepted.todo.id)));
  acceptGoalTodoClaim(accepted.pi, accepted.state, GOAL_ID, accepted.todo.id, exactClaimBinding(accepted));
  assert.equal(canonicalNode(accepted).delegationAttempts?.[0]?.status, "accepted");
  assert.equal(canonicalNode(accepted).delegation?.status, "accepted");

  const rejected = setup();
  const rejectedGoal = begin(rejected, "attempt-rejected");
  finish(rejected, rejectedGoal, "attempt-rejected", childResult(output(rejected.todo.id)));
  rejectGoalTodoClaim(rejected.pi, rejected.state, GOAL_ID, rejected.todo.id, { ...exactClaimBinding(rejected), reason: "parent-owned rejection" });
  assert.equal(canonicalNode(rejected).delegationAttempts?.[0]?.status, "rejected");
  assert.equal(canonicalNode(rejected).delegation?.status, "rejected");
  assert.equal(canonicalNode(rejected).delegationAttempts?.length, 1);
});

test("sequential attempts remain distinct and stale output cannot update the latest attempt or create a claim", () => {
  const built = setup();
  const staleGoal = resolveChildGoalTodoRef(built.state, { objective: "first", todo_id: built.todo.id }, "attempt-old", "todo-child-result.v2").childGoal;
  recordBoundTodoDelegationPreflightFailure(built.pi, built.state, staleGoal, {
    runId: "attempt-old",
    agent: "implementer",
    failureKind: "preflight",
    errors: ["bounded failure"],
  });
  assert.equal(canonicalNode(built).status, "delegated");
  recoverLatest(built);
  assert.equal(canonicalNode(built).status, "ready");

  const latestGoal = begin(built, "attempt-new");
  const duplicate = resolveChildGoalTodoRef(built.state, { objective: "parallel", todo_id: built.todo.id }, "attempt-parallel");
  assert.equal(duplicate.diagnostics[0]?.code, "active_delegation");
  const beforeStale = JSON.stringify(canonicalNode(built).delegationAttempts);
  const beforeEntries = built.entries.length;
  const staleResult = childResult(output(built.todo.id));
  applyChildGates(staleResult, { expectedTodoId: built.todo.id });
  enforceChildGoalClaimCorrelation(built.state, staleGoal, staleResult, "attempt-old");
  const staleRecord = recordTodoClaimFromChildResult(built.pi, built.state, staleGoal, staleResult, { runId: "attempt-old" });
  assert.equal(staleRecord.validReadyClaim, false);
  assert.equal(JSON.stringify(canonicalNode(built).delegationAttempts), beforeStale);
  assert.equal(built.entries.length, beforeEntries);
  assert.equal(canonicalNode(built).delegationAttempts?.at(-1)?.attemptId, "attempt-new");
  assert.equal(canonicalNode(built).delegationAttempts?.at(-1)?.status, "running");
  assert.equal(canonicalNode(built).claim, undefined);

  finish(built, latestGoal, "attempt-new", childResult(output(built.todo.id)));
  assert.deepEqual(canonicalNode(built).delegationAttempts?.map((attempt) => attempt.attemptId), ["attempt-old", "attempt-new"]);
  assert.deepEqual(canonicalNode(built).delegationAttempts?.map((attempt) => attempt.status), ["failed_preflight", "claim_returned"]);
});

test("attempt replay is deterministic, preserves all attempts, and migrates legacy delegate_link without rewriting history", () => {
  const built = setup();
  const first = resolveChildGoalTodoRef(built.state, { objective: "first", todo_id: built.todo.id }, "attempt-one", "todo-child-result.v2").childGoal;
  recordBoundTodoDelegationPreflightFailure(built.pi, built.state, first, {
    runId: "attempt-one",
    agent: "implementer",
    failureKind: "config",
    errors: ["unknown agent"],
  });
  recoverLatest(built);
  const second = begin(built, "attempt-two");
  finish(built, second, "attempt-two", childResult(`todo_id: ${built.todo.id}\ndeliverable_delivered: yes`));

  const restoredA = restoreGoalTodosFromBranch(built.entries);
  const restoredB = restoreGoalTodosFromBranch(built.entries);
  const attemptsA = restoredA.nodes.find((node) => node.id === built.todo.id)?.delegationAttempts;
  const attemptsB = restoredB.nodes.find((node) => node.id === built.todo.id)?.delegationAttempts;
  assert.deepEqual(attemptsA, attemptsB);
  assert.deepEqual(attemptsA?.map((attempt) => attempt.status), ["failed_preflight", "failed_output_gate_format"]);
  assert.ok(attemptsA?.every((attempt) => attempt.bodyStored === false));

  const legacyEntries: Entry[] = [built.entries[0], {
    customType: ZOB_GOAL_TODO_ENTRY_TYPE,
    data: {
      version: 1,
      kind: "delegate_link",
      source: "delegation",
      goalId: GOAL_ID,
      todoId: built.todo.id,
      runId: "legacy-run",
      delegation: { runId: "legacy-run", requestId: "legacy-request", delegationDepth: 1, status: "running" },
      at: 17,
    },
  }];
  const legacyA = restoreGoalTodosFromBranch(legacyEntries).nodes.find((node) => node.id === built.todo.id)!;
  const legacyB = restoreGoalTodosFromBranch(legacyEntries).nodes.find((node) => node.id === built.todo.id)!;
  assert.equal(legacyA.delegationAttempts?.length, 1);
  assert.equal(legacyA.delegationAttempts?.[0]?.status, "running");
  assert.equal(legacyA.delegationAttempts?.[0]?.bodyStored, false);
  assert.equal(legacyA.delegationAttempts?.[0]?.attemptId, legacyB.delegationAttempts?.[0]?.attemptId);
  assert.equal(legacyA.delegation?.status, "running");

  const invalidLegacyClaimEntries: Entry[] = [...legacyEntries, {
    customType: ZOB_GOAL_TODO_ENTRY_TYPE,
    data: {
      version: 1,
      kind: "claim_returned",
      source: "delegation",
      goalId: GOAL_ID,
      todoId: built.todo.id,
      claimHash: "c".repeat(64),
      runId: "legacy-run",
      outputContract: "todo-child-result.v2",
      gatePassed: true,
      childGoalStatus: "incomplete",
      statusClaim: "incomplete",
      targetReadiness: "needs_parent_review",
      acceptanceBlockers: [],
      noShip: false,
      evidenceRefs: ["test/goal-todo-delegation-attempts.test.ts"],
      validationCommands: [],
      at: 18,
    },
  }];
  const invalidLegacyClaim = restoreGoalTodosFromBranch(invalidLegacyClaimEntries).nodes.find((node) => node.id === built.todo.id)!;
  assert.equal(invalidLegacyClaim.claim, undefined);
  assert.equal(invalidLegacyClaim.status, "delegated");
  assert.equal(invalidLegacyClaim.delegationAttempts?.[0]?.status, "output_declared_incomplete");
  assert.equal(invalidLegacyClaim.delegation?.status, "failed");
});
