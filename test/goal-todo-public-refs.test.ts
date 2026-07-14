import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GoalTodoReferenceResolutionError,
  addGoalTodo,
  completeGoalTodo,
  createHarnessRuntimeState,
  linkGoalTodoDelegation,
  returnGoalTodoClaim,
} from "../.pi/extensions/zob-harness/index.ts";
import {
  canonicalizeHandoffGoalTodos,
  registerGoalRuntimeTools,
} from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ID = "goal-public-refs";
const OTHER_GOAL_ID = "goal-public-refs-other";
const CLAIM_HASH = "c".repeat(64);

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

type TestState = ReturnType<typeof createHarnessRuntimeState>;

type RuntimeSetup = {
  pi: ExtensionAPI;
  state: TestState;
  entries: Array<{ type: string; data: unknown }>;
  tools: Map<string, CapturedTool>;
  first: ReturnType<typeof addGoalTodo>;
  second: ReturnType<typeof addGoalTodo>;
};

function setup(options: { claim?: boolean; claimPolicy?: "parent_review" | "oracle_required"; status?: "planned" | "ready" | "done" } = {}): RuntimeSetup {
  const entries: Array<{ type: string; data: unknown }> = [];
  const tools = new Map<string, CapturedTool>();
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    registerTool(tool: CapturedTool) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  state.runtimeGoal = { goalId: GOAL_ID, revision: 4 } as NonNullable<TestState["runtimeGoal"]>;
  const first = addGoalTodo(pi, state, GOAL_ID, { title: "first", status: options.status ?? "ready" }, "tool");
  const second = addGoalTodo(pi, state, GOAL_ID, { title: "second", status: "ready" }, "tool");
  if (options.claim) {
    linkGoalTodoDelegation(pi, state, GOAL_ID, first.id, { runId: "run-public-ref", status: "running", delegationDepth: 1, validationPolicy: options.claimPolicy ?? "parent_review" }, "delegation");
    returnGoalTodoClaim(pi, state, GOAL_ID, first.id, {
      claimHash: CLAIM_HASH,
      outputHash: "d".repeat(64),
      outputContract: "todo-child-result.v2",
      gatePassed: true,
      childGoalStatus: "ready_for_oracle",
      statusClaim: "done",
      targetReadiness: "ready_for_parent_acceptance",
      acceptanceBlockers: [],
      evidenceRefs: ["test/goal-todo-public-refs.test.ts"],
      validationCommands: ["node --test"],
      noShip: false,
    }, "delegation");
  }
  entries.length = 0;
  registerGoalRuntimeTools(pi, state);
  return { pi, state, entries, tools, first, second };
}

function call(tool: CapturedTool, params: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute("call", params, undefined, undefined, { cwd: process.cwd() });
}

const SINGLE_NODE_TOOLS = [
  "update_goal_todo",
  "resolve_goal_todo",
  "complete_goal_todo",
  "block_goal_todo",
  "split_goal_todo",
  "validate_goal_todo_claim",
  "accept_goal_todo_claim",
  "reject_goal_todo_claim",
] as const;

function paramsFor(toolName: typeof SINGLE_NODE_TOOLS[number], state: TestState): Record<string, unknown> {
  const claimNode = state.goalTodos.nodes.find((node) => node.claim);
  const claimBinding = claimNode?.claim ? {
    expected_claim_hash: claimNode.claim.claimHash,
    expected_attempt_id: claimNode.claim.attemptId,
    expected_validation_policy: claimNode.claim.validationPolicy,
    cas: {
      mutation_id: `public-ref-${toolName}`,
      expected_graph_revision: state.goalTodos.graphRevisions[GOAL_ID],
      expected_todo_revision: claimNode.revision,
    },
  } : {};
  switch (toolName) {
    case "update_goal_todo": return { title: "updated" };
    case "resolve_goal_todo": return { action: "complete" };
    case "complete_goal_todo": return {};
    case "block_goal_todo": return { reason: "bounded blocker" };
    case "split_goal_todo": return { titles: ["child"] };
    case "validate_goal_todo_claim": return {
      verdict: "PASS",
      recommended_action: "accept_claim",
      no_ship: false,
      evidence_refs: ["test/goal-todo-public-refs.test.ts"],
      validation_commands: ["node --test"],
      blocking_issues: [],
      confidence: "HIGH",
      claim_hash: CLAIM_HASH,
      expected_attempt_id: claimNode?.claim?.attemptId,
      expected_validation_policy: "oracle_required",
      output_hash: "e".repeat(64),
      auto_accept: false,
      cas: (claimBinding as { cas?: unknown }).cas,
    };
    case "accept_goal_todo_claim": return claimBinding;
    case "reject_goal_todo_claim": return { ...claimBinding, reason: "parent rejected" };
  }
}

function needsClaim(toolName: string): boolean {
  return toolName === "validate_goal_todo_claim" || toolName === "accept_goal_todo_claim" || toolName === "reject_goal_todo_claim";
}

test("every public single-node schema exposes optional strict todo_id and todo_path fields", () => {
  const { tools } = setup();
  for (const toolName of ["get_goal_todos", ...SINGLE_NODE_TOOLS]) {
    const tool = tools.get(toolName);
    assert.ok(tool, toolName);
    assert.ok(tool.parameters.properties?.todo_id, `${toolName} todo_id schema`);
    assert.ok(tool.parameters.properties?.todo_path, `${toolName} todo_path schema`);
    assert.equal(tool.parameters.required?.includes("todo_id") ?? false, false, `${toolName} todo_id is optional`);
    assert.equal(tool.parameters.required?.includes("todo_path") ?? false, false, `${toolName} todo_path is optional`);
  }
});

for (const toolName of ["get_goal_todos", ...SINGLE_NODE_TOOLS] as const) {
  test(`${toolName} accepts ID-only, path-only, and agreeing dual references`, async () => {
    for (const form of ["id", "path", "dual"] as const) {
      const built = setup({ claim: needsClaim(toolName), claimPolicy: toolName === "validate_goal_todo_claim" ? "oracle_required" : "parent_review" });
      const tool = built.tools.get(toolName)!;
      const base = toolName === "get_goal_todos" ? {} : paramsFor(toolName, built.state);
      const ref = form === "id"
        ? { todo_id: built.first.id }
        : form === "path"
          ? { todo_path: built.first.path }
          : { todo_id: built.first.id, todo_path: built.first.path };
      const result = await call(tool, { ...base, ...ref });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.todo_id, built.first.id);
      assert.equal(result.details.todo_path, built.first.path);
      assert.deepEqual(result.details.canonical_ref, { todo_id: built.first.id, todo_path: built.first.path });
    }
  });

  test(`${toolName} rejects mismatched dual references before mutation`, async () => {
    const built = setup({ claim: needsClaim(toolName), claimPolicy: toolName === "validate_goal_todo_claim" ? "oracle_required" : "parent_review" });
    const tool = built.tools.get(toolName)!;
    const base = toolName === "get_goal_todos" ? {} : paramsFor(toolName, built.state);
    const before = JSON.stringify(built.state.goalTodos);
    await assert.rejects(
      () => call(tool, { ...base, todo_id: built.first.id, todo_path: built.second.path }),
      (error: unknown) => error instanceof GoalTodoReferenceResolutionError
        && error.diagnostic.code === "reference_mismatch"
        && error.diagnostic.retry_policy === "fix_input",
    );
    assert.equal(JSON.stringify(built.state.goalTodos), before);
    assert.equal(built.entries.length, 0);
  });
}

test("public refs fail distinctly for missing, path-as-ID, ID-as-path, stale, cross-goal, and ambiguous inputs", async () => {
  const built = setup();
  const tool = built.tools.get("get_goal_todos")!;
  const other = addGoalTodo(built.pi, built.state, OTHER_GOAL_ID, { title: "other", status: "ready" }, "tool");
  const duplicate = addGoalTodo(built.pi, built.state, GOAL_ID, { title: "duplicate", status: "ready" }, "tool");
  built.state.goalTodos.nodes.find((node) => node.id === duplicate.id)!.path = built.first.path;

  const cases: Array<[Record<string, unknown>, string]> = [
    [{ todo_id: built.first.path }, "invalid_todo_id"],
    [{ todo_path: built.first.id }, "invalid_todo_path"],
    [{ todo_id: "todo_eeeeeeeeeeee" }, "todo_id_not_found"],
    [{ todo_id: other.id }, "todo_id_cross_goal"],
    [{ todo_path: built.first.path }, "todo_path_ambiguous"],
  ];
  for (const [params, code] of cases) {
    await assert.rejects(
      () => call(tool, params),
      (error: unknown) => error instanceof GoalTodoReferenceResolutionError
        && error.diagnostic.code === code
        && error.message.includes("field=")
        && error.message.includes("retry_policy=")
        && error.message.includes("safe_next_actions="),
    );
  }

  const update = built.tools.get("update_goal_todo")!;
  await assert.rejects(
    () => call(update, { title: "missing ref" }),
    (error: unknown) => error instanceof GoalTodoReferenceResolutionError && error.diagnostic.code === "missing_reference",
  );
});

test("CAS hashes canonical target identity so ID and path forms replay one mutation", async () => {
  const built = setup();
  const tool = built.tools.get("update_goal_todo")!;
  const target = built.state.goalTodos.nodes.find((node) => node.id === built.first.id)!;
  const cas = {
    mutation_id: "canonical-ref-replay",
    expected_graph_revision: built.state.goalTodos.graphRevisions[GOAL_ID],
    expected_todo_revision: target.revision,
  };
  const applied = await call(tool, { todo_id: target.id, title: "canonical replay", cas });
  assert.equal((applied.details.cas as { status: string }).status, "applied");
  built.entries.length = 0;
  const replayed = await call(tool, { todo_path: target.path, title: "canonical replay", cas });
  assert.equal((replayed.details.cas as { status: string }).status, "replayed");
  assert.equal(built.entries.length, 0);
});

test("update_goal_todo maps safe status intents and rejects dedicated lifecycle states", async () => {
  const safe: Array<[string, string]> = [
    ["ready", "ready"],
    ["in_progress", "in_progress"],
    ["needs_review", "needs_review"],
    ["needs_oracle", "needs_oracle"],
    ["needs_user", "needs_user"],
  ];
  for (const [requested, expected] of safe) {
    const built = setup({ status: "planned" });
    const result = await call(built.tools.get("update_goal_todo")!, { todo_path: built.first.path, status: requested });
    assert.equal((result.details.node as { status: string }).status, expected);
  }
  for (const requested of ["delegated", "claim_returned", "blocked", "done", "skipped", "planned"]) {
    const built = setup();
    await assert.rejects(
      () => call(built.tools.get("update_goal_todo")!, { todo_id: built.first.id, status: requested }),
      /code=dedicated_transition_required.*safe_next_actions=/,
    );
  }

  const terminal = setup({ status: "done" });
  await assert.rejects(() => call(terminal.tools.get("update_goal_todo")!, { todo_id: terminal.first.id, status: "ready" }), /safe_next_actions=reopen/);
  const claim = setup({ claim: true });
  await assert.rejects(() => call(claim.tools.get("update_goal_todo")!, { todo_id: claim.first.id, status: "needs_oracle" }), /safe_next_actions=accept_claim\|reject_claim\|block/);
  const recovery = setup();
  const recoveryNode = recovery.state.goalTodos.nodes.find((node) => node.id === recovery.first.id)!;
  recoveryNode.status = "delegated";
  recoveryNode.delegation = { runId: "failed-run", delegationDepth: 1, status: "failed" };
  await assert.rejects(() => call(recovery.tools.get("update_goal_todo")!, { todo_id: recovery.first.id, status: "ready" }), /safe_next_actions=recover_delegation/);
});

test("resolve auto claim acceptance requires exact expectation/hash/CAS and returns canonical revisions", async () => {
  const built = setup({ claim: true });
  const tool = built.tools.get("resolve_goal_todo")!;
  const target = built.state.goalTodos.nodes.find((node) => node.id === built.first.id)!;
  await assert.rejects(() => call(tool, { todo_path: target.path, action: "auto" }), /expected_auto_resolution=accept_claim/);
  const cas = {
    mutation_id: "public-auto-accept",
    expected_graph_revision: built.state.goalTodos.graphRevisions[GOAL_ID],
    expected_todo_revision: target.revision,
  };
  const result = await call(tool, {
    todo_path: target.path,
    action: "auto",
    expected_auto_resolution: "accept_claim",
    expected_claim_hash: CLAIM_HASH,
    expected_attempt_id: target.claim?.attemptId,
    expected_validation_policy: target.claim?.validationPolicy,
    cas,
  });
  assert.equal((result.details.node as { status: string }).status, "done");
  assert.equal(result.details.claim_hash, CLAIM_HASH);
  assert.equal((result.details.revisions as { todo_revision: number }).todo_revision, (target.revision ?? 0) + 1);
});

test("validate_goal_todo_claim auto acceptance binds the exact pre-validation CAS revision", async () => {
  const built = setup({ claim: true, claimPolicy: "oracle_required" });
  const target = built.state.goalTodos.nodes.find((node) => node.id === built.first.id)!;
  const result = await call(built.tools.get("validate_goal_todo_claim")!, {
    todo_path: target.path,
    verdict: "PASS",
    recommended_action: "accept_claim",
    no_ship: false,
    evidence_refs: ["test/goal-todo-public-refs.test.ts"],
    validation_commands: ["node --test"],
    blocking_issues: [],
    confidence: "HIGH",
    claim_hash: CLAIM_HASH,
    expected_attempt_id: target.claim?.attemptId,
    expected_validation_policy: "oracle_required",
    output_hash: "e".repeat(64),
    auto_accept: true,
    cas: {
      mutation_id: "public-validate-auto-accept",
      expected_graph_revision: built.state.goalTodos.graphRevisions[GOAL_ID],
      expected_todo_revision: target.revision,
    },
  });
  assert.equal((result.details.node as { status: string }).status, "done");
  assert.equal(result.details.claim_hash, CLAIM_HASH);
  assert.equal((result.details.revisions as { todo_revision: number }).todo_revision, (target.revision ?? 0) + 2);
});

test("terminal reopen requires exact revision CAS, clears old claim metadata, and reports canonical refs", async () => {
  const built = setup({ claim: true });
  let target = built.state.goalTodos.nodes.find((node) => node.id === built.first.id)!;
  completeGoalTodo(built.pi, built.state, GOAL_ID, target.id, {
    expectedClaimHash: CLAIM_HASH,
    expectedAttemptId: target.claim!.attemptId!,
    expectedValidationPolicy: target.claim!.validationPolicy!,
    expectedGraphRevision: built.state.goalTodos.graphRevisions[GOAL_ID],
    expectedTodoRevision: target.revision,
  }, "tool");
  target = built.state.goalTodos.nodes.find((node) => node.id === built.first.id)!;
  const tool = built.tools.get("resolve_goal_todo")!;
  const params = {
    todo_path: target.path,
    action: "reopen",
    reason: "parent-owned new attempt",
    evidence_refs: ["test/goal-todo-public-refs.test.ts"],
  };
  await assert.rejects(() => call(tool, params), /code=cas_required/);
  const result = await call(tool, {
    ...params,
    cas: {
      mutation_id: "public-terminal-reopen",
      expected_graph_revision: built.state.goalTodos.graphRevisions[GOAL_ID],
      expected_todo_revision: target.revision,
    },
  });
  const reopened = result.details.node as { status: string; claim?: unknown; delegation?: unknown };
  assert.equal(reopened.status, "ready");
  assert.equal(reopened.claim, undefined);
  assert.equal(reopened.delegation, undefined);
  assert.equal(result.details.todo_id, target.id);
  assert.equal(result.details.claim_hash, CLAIM_HASH);
});

test("handoff canonical object refs are atomic and legacy raw adapters are explicit", () => {
  const built = setup();
  const canonical = canonicalizeHandoffGoalTodos(built.state, {
    todo_id: built.first.id,
    todo_path: built.first.path,
    todo_refs: [{ todo_id: built.second.id, todo_path: built.second.path }],
    target_type: "zpeer",
    target: "worker",
    custom_message: "transient body",
  });
  assert.deepEqual(canonical.canonicalTodoIds, [built.first.id, built.second.id].sort());
  assert.deepEqual(canonical.compatibilityWarnings, []);

  const legacy = canonicalizeHandoffGoalTodos(built.state, {
    todo_refs: [`todo_${built.first.path}`],
    target_type: "zpeer",
    target: "worker",
    custom_message: "transient body",
  });
  assert.deepEqual(legacy.canonicalTodoIds, [built.first.id]);
  assert.ok(legacy.compatibilityWarnings.some((warning) => warning.includes("deprecated")));

  assert.throws(() => canonicalizeHandoffGoalTodos(built.state, {
    todo_id: built.first.path,
    target_type: "zpeer",
    target: "worker",
    custom_message: "transient body",
  }), /code=batch_resolution_failed.*invalid_todo_id/);
  assert.throws(() => canonicalizeHandoffGoalTodos(built.state, {
    todo_ids: [built.first.path],
    target_type: "zpeer",
    target: "worker",
    custom_message: "transient body",
  }), /code=batch_resolution_failed.*invalid_todo_id/);
  assert.equal(built.entries.some((entry) => entry.type === GOAL_MUTATION_PREPARATION_ENTRY_TYPE), false);
});
