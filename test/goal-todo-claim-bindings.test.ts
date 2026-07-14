import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  addGoalTodo,
  createHarnessRuntimeState,
  linkGoalTodoDelegation,
  returnGoalTodoClaim,
} from "../.pi/extensions/zob-harness/index.ts";
import { registerGoalRuntimeTools } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ID = "goal-claim-bindings";
const CLAIM_HASH = "c".repeat(64);
const OUTPUT_HASH = "d".repeat(64);
const VALIDATION_OUTPUT_HASH = "e".repeat(64);

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

function setup(validationPolicy: "parent_review" | "oracle_required" = "parent_review") {
  const entries: Array<{ type: string; data: unknown }> = [];
  const tools = new Map<string, CapturedTool>();
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    registerTool(tool: CapturedTool) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  state.runtimeGoal = { goalId: GOAL_ID, revision: 7 } as NonNullable<typeof state.runtimeGoal>;
  const todo = addGoalTodo(pi, state, GOAL_ID, { title: "strict claim binding", status: "ready" }, "tool");
  linkGoalTodoDelegation(pi, state, GOAL_ID, todo.id, {
    attemptId: "attempt-binding",
    runId: "run-binding",
    status: "running",
    outputContract: "todo-child-result.v2",
    validationPolicy,
  }, "delegation");
  const graphBeforeClaim = state.goalTodos.graphRevisions[GOAL_ID];
  const todoBeforeClaim = state.goalTodos.nodes.find((node) => node.id === todo.id)!.revision!;
  returnGoalTodoClaim(pi, state, GOAL_ID, todo.id, {
    runId: "run-binding",
    claimHash: CLAIM_HASH,
    outputHash: OUTPUT_HASH,
    outputContract: "todo-child-result.v2",
    gatePassed: true,
    childGoalStatus: "ready_for_oracle",
    statusClaim: "done",
    targetReadiness: "ready_for_parent_acceptance",
    acceptanceBlockers: [],
    evidenceRefs: ["test/goal-todo-claim-bindings.test.ts"],
    validationCommands: ["node --import tsx --test test/goal-todo-claim-bindings.test.ts"],
    noShip: false,
  }, "delegation");
  entries.length = 0;
  registerGoalRuntimeTools(pi, state);
  return { pi, state, entries, tools, todoId: todo.id, graphBeforeClaim, todoBeforeClaim };
}

function node(built: ReturnType<typeof setup>) {
  return built.state.goalTodos.nodes.find((candidate) => candidate.id === built.todoId)!;
}

function cas(built: ReturnType<typeof setup>, mutationId: string) {
  return {
    mutation_id: mutationId,
    expected_graph_revision: built.state.goalTodos.graphRevisions[GOAL_ID],
    expected_todo_revision: node(built).revision,
  };
}

function claimParams(built: ReturnType<typeof setup>, mutationId: string) {
  const claim = node(built).claim!;
  return {
    todo_id: built.todoId,
    expected_claim_hash: claim.claimHash,
    expected_attempt_id: claim.attemptId,
    expected_validation_policy: claim.validationPolicy,
    cas: cas(built, mutationId),
  };
}

function validationParams(built: ReturnType<typeof setup>, mutationId: string, overrides: Record<string, unknown> = {}) {
  const claim = node(built).claim!;
  return {
    todo_id: built.todoId,
    verdict: "PASS",
    recommended_action: "accept_claim",
    no_ship: false,
    evidence_refs: ["test/goal-todo-claim-bindings.test.ts"],
    validation_commands: ["node --import tsx --test test/goal-todo-claim-bindings.test.ts"],
    blocking_issues: [],
    confidence: "HIGH",
    claim_hash: claim.claimHash,
    expected_attempt_id: claim.attemptId,
    expected_validation_policy: "oracle_required",
    output_hash: VALIDATION_OUTPUT_HASH,
    auto_accept: false,
    cas: cas(built, mutationId),
    ...overrides,
  };
}

function call(built: ReturnType<typeof setup>, toolName: string, params: Record<string, unknown>) {
  const tool = built.tools.get(toolName);
  assert.ok(tool, toolName);
  return tool.execute("call", params, undefined, undefined, { cwd: process.cwd() });
}

function snapshot(built: ReturnType<typeof setup>) {
  return JSON.stringify({ goalTodos: built.state.goalTodos, entries: built.entries });
}

async function rejectsZeroEffect(built: ReturnType<typeof setup>, toolName: string, params: Record<string, unknown>, pattern: RegExp) {
  const before = snapshot(built);
  await assert.rejects(() => call(built, toolName, params), pattern);
  assert.equal(snapshot(built), before);
  assert.equal(built.entries.some((entry) => entry.type === GOAL_MUTATION_PREPARATION_ENTRY_TYPE), false);
}

test("claim creation advances exactly once and persists immutable post-claim attempt/revision/policy/output bindings", () => {
  const built = setup("parent_review");
  const current = node(built);
  const claim = current.claim!;
  const attempt = current.delegationAttempts!.at(-1)!;
  assert.equal(built.state.goalTodos.graphRevisions[GOAL_ID], built.graphBeforeClaim + 1);
  assert.equal(current.revision, built.todoBeforeClaim + 1);
  assert.equal(claim.claimVersion, 2);
  assert.equal(claim.claimHash, CLAIM_HASH);
  assert.equal(claim.attemptId, "attempt-binding");
  assert.equal(claim.runId, "run-binding");
  assert.equal(claim.goalRevision, 7);
  assert.equal(claim.graphRevision, built.state.goalTodos.graphRevisions[GOAL_ID]);
  assert.equal(claim.todoRevision, current.revision);
  assert.equal(claim.validationPolicy, "parent_review");
  assert.equal(claim.outputHash, OUTPUT_HASH);
  assert.equal(claim.outputContract, "todo-child-result.v2");
  assert.match(claim.gateHash!, /^[a-f0-9]{64}$/);
  assert.equal(attempt.validationPolicy, claim.validationPolicy);
  assert.equal(attempt.outputHash, claim.outputHash);
  assert.equal(attempt.gateHash, claim.gateHash);
});

test("accept rejects truncated/wrong hashes, attempts, policies, and stale revisions before any append", async () => {
  for (const mutate of [
    (params: ReturnType<typeof claimParams>) => ({ ...params, expected_claim_hash: CLAIM_HASH.slice(0, 12) }),
    (params: ReturnType<typeof claimParams>) => ({ ...params, expected_claim_hash: "f".repeat(64) }),
    (params: ReturnType<typeof claimParams>) => ({ ...params, expected_attempt_id: "attempt-wrong" }),
    (params: ReturnType<typeof claimParams>) => ({ ...params, expected_validation_policy: "oracle_required" }),
    (params: ReturnType<typeof claimParams>) => ({ ...params, cas: { ...params.cas, expected_graph_revision: params.cas.expected_graph_revision - 1 } }),
    (params: ReturnType<typeof claimParams>) => ({ ...params, cas: { ...params.cas, expected_todo_revision: params.cas.expected_todo_revision! - 1 } }),
  ]) {
    const built = setup();
    await rejectsZeroEffect(built, "accept_goal_todo_claim", mutate(claimParams(built, "accept-mismatch")), /(claim|expected|stale|policy|attempt)/i);
  }
});

test("parent_review accepts exact current bindings and exact CAS replay is idempotent with full structured details", async () => {
  const built = setup("parent_review");
  const params = claimParams(built, "accept-exact-replay");
  const applied = await call(built, "accept_goal_todo_claim", params);
  assert.equal((applied.details.node as { status: string }).status, "done");
  assert.equal(applied.details.claimHash, CLAIM_HASH);
  assert.equal(applied.details.attemptId, "attempt-binding");
  assert.equal(applied.details.validationPolicy, "parent_review");
  assert.equal(typeof applied.details.graphRevision, "number");
  assert.equal(typeof applied.details.todoRevision, "number");
  assert.deepEqual(applied.details.nextValidActions, ["resolve_goal_todo:reopen"]);
  assert.equal((applied.details.claim_binding as { claimHash: string }).claimHash, CLAIM_HASH);
  assert.match(applied.content[0]!.text, /full claim hash, bindings, validation status, and next actions are in details/);
  const entriesAfterApply = built.entries.length;
  const replayed = await call(built, "accept_goal_todo_claim", params);
  assert.equal((replayed.details.cas as { status: string }).status, "replayed");
  assert.equal(built.entries.length, entriesAfterApply);
  assert.equal(node(built).delegationAttempts?.at(-1)?.status, "accepted");
});

test("oracle_required cannot accept before exact bound PASS validation", async () => {
  const built = setup("oracle_required");
  await rejectsZeroEffect(built, "accept_goal_todo_claim", claimParams(built, "oracle-early-accept"), /validation\/revision binding mismatch/i);
});

for (const [label, overrides] of [
  ["recommended action", { recommended_action: "needs_review" }],
  ["confidence", { confidence: "LOW" }],
  ["no_ship", { no_ship: true }],
  ["blocking issue", { blocking_issues: ["bounded blocker"] }],
] as const) {
  test(`oracle auto-accept remains blocked by ${label}`, async () => {
    const built = setup("oracle_required");
    const result = await call(built, "validate_goal_todo_claim", validationParams(built, `oracle-${label.replace(/\s/g, "-")}`, { ...overrides, auto_accept: true }));
    assert.notEqual((result.details.node as { status: string }).status, "done");
    assert.notEqual(node(built).delegationAttempts?.at(-1)?.status, "accepted");
  });
}

test("strict oracle PASS persists exact validation bindings/output hash and auto-accepts only that current claim", async () => {
  const built = setup("oracle_required");
  const claim = node(built).claim!;
  const beforeGraph = built.state.goalTodos.graphRevisions[GOAL_ID];
  const beforeTodo = node(built).revision!;
  const result = await call(built, "validate_goal_todo_claim", validationParams(built, "oracle-strict-pass", { auto_accept: true }));
  const current = node(built);
  const validation = current.validation!;
  assert.equal(current.status, "done");
  assert.equal(validation.validationVersion, 1);
  assert.equal(validation.claimHash, claim.claimHash);
  assert.equal(validation.attemptId, claim.attemptId);
  assert.equal(validation.claimRunId, claim.runId);
  assert.equal(validation.claimGraphRevision, claim.graphRevision);
  assert.equal(validation.claimTodoRevision, claim.todoRevision);
  assert.equal(validation.validationPolicy, "oracle_required");
  assert.equal(validation.expectedGraphRevision, beforeGraph);
  assert.equal(validation.expectedTodoRevision, beforeTodo);
  assert.equal(validation.graphRevision, beforeGraph + 1);
  assert.equal(validation.todoRevision, beforeTodo + 1);
  assert.equal(validation.outputHash, VALIDATION_OUTPUT_HASH);
  assert.equal(current.delegationAttempts?.at(-1)?.status, "accepted");
  assert.equal(result.details.validationStatus, "passed");
});

test("validation rejects truncated hash, wrong attempt, and stale revisions with zero effects", async () => {
  for (const overrides of [
    { claim_hash: CLAIM_HASH.slice(0, 12) },
    { expected_attempt_id: "attempt-old" },
    { cas: { mutation_id: "validation-stale", expected_graph_revision: 0, expected_todo_revision: 0 } },
  ]) {
    const built = setup("oracle_required");
    await rejectsZeroEffect(built, "validate_goal_todo_claim", validationParams(built, "validation-mismatch", overrides), /(hash|attempt|stale)/i);
  }
});

test("any intervening graph mutation invalidates parent acceptance and bound oracle validation acceptance", async () => {
  const parent = setup("parent_review");
  addGoalTodo(parent.pi, parent.state, GOAL_ID, { title: "intervening sibling", status: "ready" }, "tool");
  parent.entries.length = 0;
  await rejectsZeroEffect(parent, "accept_goal_todo_claim", claimParams(parent, "parent-after-mutation"), /validation\/revision binding mismatch/i);

  const oracle = setup("oracle_required");
  await call(oracle, "validate_goal_todo_claim", validationParams(oracle, "oracle-record-only", { auto_accept: false }));
  oracle.entries.length = 0;
  addGoalTodo(oracle.pi, oracle.state, GOAL_ID, { title: "post-validation mutation", status: "ready" }, "tool");
  oracle.entries.length = 0;
  await rejectsZeroEffect(oracle, "accept_goal_todo_claim", claimParams(oracle, "oracle-after-mutation"), /validation\/revision binding mismatch/i);
});

test("legacy unbound claims fail closed without synthesized bindings", async () => {
  const built = setup();
  const claim = node(built).claim!;
  delete claim.claimVersion;
  delete claim.attemptId;
  delete claim.graphRevision;
  delete claim.todoRevision;
  delete claim.validationPolicy;
  await rejectsZeroEffect(built, "accept_goal_todo_claim", {
    todo_id: built.todoId,
    expected_claim_hash: CLAIM_HASH,
    expected_attempt_id: "attempt-binding",
    expected_validation_policy: "parent_review",
    cas: cas(built, "legacy-claim"),
  }, /LEGACY_CLAIM_BINDING_REQUIRED/);
});

test("rejection requires a non-empty reason before CAS preparation", async () => {
  const built = setup();
  await rejectsZeroEffect(built, "reject_goal_todo_claim", { ...claimParams(built, "reject-no-reason"), reason: "" }, /non-empty reason/);
});

test("exact rejection preserves attempt history and marks only the referenced current attempt rejected", async () => {
  const built = setup();
  const params = { ...claimParams(built, "reject-exact"), reason: "parent evidence rejection" };
  const result = await call(built, "reject_goal_todo_claim", params);
  assert.equal((result.details.node as { status: string }).status, "blocked");
  assert.equal(node(built).delegationAttempts?.length, 1);
  assert.equal(node(built).delegationAttempts?.[0]?.attemptId, "attempt-binding");
  assert.equal(node(built).delegationAttempts?.[0]?.status, "rejected");
  assert.equal(result.details.claimHash, CLAIM_HASH);
  assert.equal(result.details.attemptId, "attempt-binding");
});
