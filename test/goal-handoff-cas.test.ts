import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GOAL_MUTATION_RECEIPT_ENTRY_TYPE,
  addGoalTodo,
  buildGoalHandoffCanonicalPayload,
  createGoalMutationReceiptState,
  createHarnessRuntimeState,
  executeGoalHandoffCas,
  hashGoalMutationRequest,
  linkGoalTodoDelegation,
  parseOptionalGoalMutationGuard,
  restoreGoalMutationReceiptsFromBranch,
  type GoalHandoffCasPreflight,
} from "../.pi/extensions/zob-harness/index.ts";
import { registerGoalRuntimeEvents } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/events.ts";
import {
  canonicalizeHandoffGoalTodos,
  executeHandoffGoalTodoEffects,
  registerGoalRuntimeTools,
  type HandoffGoalTodoEffectOverrides,
  type ValidatedHandoffGoalTodoPreflight,
} from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ID = "goal-handoff-cas";
const TARGET_HASH = hashGoalMutationRequest("canonical target");
const ROOM_HASH = hashGoalMutationRequest("canonical room");
const INSTRUCTION_HASH = hashGoalMutationRequest("SECRET_HANDOFF_BODY");
const SENDER_HASH = hashGoalMutationRequest("parent");
const TEAM_HASH = hashGoalMutationRequest("zob-core");

type Counters = {
  canonicalPreflight: number;
  localPreflight: number;
  goalRoom: number;
  live: number;
  delegation: number;
  events: number;
  results: number;
};

type Entry = { customType: string; data: unknown };

type PlanOptions = {
  currentGraphRevision?: number;
  canonicalTodoIds?: string[];
  instructionHash?: string;
  beforeApplyError?: string;
  applyError?: string;
};

function counters(): Counters {
  return { canonicalPreflight: 0, localPreflight: 0, goalRoom: 0, live: 0, delegation: 0, events: 0, results: 0 };
}

function plan(counter: Counters, options: PlanOptions = {}): GoalHandoffCasPreflight<{ delivered: true }> {
  const canonicalTodoIds = options.canonicalTodoIds ?? ["todo-b", "todo-a", "todo-a"];
  const graphRevision = options.currentGraphRevision ?? 4;
  return {
    goalId: GOAL_ID,
    canonicalTodoIds,
    runId: "handoff_canonical_run",
    targetType: "zteam",
    canonicalTargetHash: TARGET_HASH,
    targetHashes: [TARGET_HASH, TARGET_HASH],
    targetRoomHashes: [ROOM_HASH, ROOM_HASH],
    instructionHash: options.instructionHash ?? INSTRUCTION_HASH,
    delegationDepth: 2,
    senderHash: SENDER_HASH,
    goalRoomTeamHash: TEAM_HASH,
    current: { goalRevision: 7, graphRevision },
    beforeApply: () => {
      counter.localPreflight += 1;
      if (options.beforeApplyError) throw new Error(options.beforeApplyError);
    },
    apply: () => {
      counter.goalRoom += canonicalTodoIds.length;
      counter.delegation += canonicalTodoIds.length;
      counter.events += canonicalTodoIds.length;
      counter.live += 1;
      counter.results += 1;
      if (options.applyError) throw new Error(options.applyError);
      return {
        result: { delivered: true as const },
        appliedRevisions: { goalRevision: 7, graphRevision: graphRevision + canonicalTodoIds.length },
        eventCount: canonicalTodoIds.length,
      };
    },
  };
}

function execute(counter: Counters, input: {
  mutationId: string;
  receipts?: ReturnType<typeof createGoalMutationReceiptState>;
  branch?: Entry[];
  options?: PlanOptions;
  expectedGraphRevision?: number;
  expectedTodoRevision?: number;
  receiptFailure?: boolean;
  guard?: false;
}) {
  const receipts = input.receipts ?? createGoalMutationReceiptState();
  const branch = input.branch ?? [];
  return executeGoalHandoffCas({
    guard: input.guard === false ? undefined : parseOptionalGoalMutationGuard({
      mutation_id: input.mutationId,
      ...(input.expectedGraphRevision !== undefined ? { expected_graph_revision: input.expectedGraphRevision } : {}),
      ...(input.expectedTodoRevision !== undefined ? { expected_todo_revision: input.expectedTodoRevision } : {}),
    }),
    receipts,
    preflight: () => {
      counter.canonicalPreflight += 1;
      return plan(counter, input.options);
    },
    persistPreparation: (preparation) => {
      branch.push({ customType: GOAL_MUTATION_PREPARATION_ENTRY_TYPE, data: preparation });
    },
    persistReceipt: (receipt) => {
      if (input.receiptFailure) throw new Error("simulated handoff receipt outage");
      branch.push({ customType: GOAL_MUTATION_RECEIPT_ENTRY_TYPE, data: receipt });
    },
    now: () => 100,
  });
}

function effectSnapshot(counter: Counters): Omit<Counters, "canonicalPreflight" | "localPreflight"> {
  return {
    goalRoom: counter.goalRoom,
    live: counter.live,
    delegation: counter.delegation,
    events: counter.events,
    results: counter.results,
  };
}

function containsForbiddenBodyKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenBodyKey);
  const forbidden = new Set(["body", "task", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch", "custom_message", "target", "target_room"]);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => forbidden.has(key) || containsForbiddenBodyKey(child));
}

test("handoff canonical request is order-independent, deduplicated, effect-complete, and body-free", () => {
  const first = buildGoalHandoffCanonicalPayload(plan(counters()));
  const second = buildGoalHandoffCanonicalPayload(plan(counters(), { canonicalTodoIds: ["todo-a", "todo-b"] }));
  assert.deepEqual(first, second);
  assert.deepEqual(first.canonicalTodoIds, ["todo-a", "todo-b"]);
  assert.deepEqual(first.targetHashes, [TARGET_HASH]);
  assert.deepEqual(first.targetRoomHashes, [ROOM_HASH]);
  assert.equal(first.effectFlags.appendGoalRoom, true);
  assert.equal(first.effectFlags.deliverLive, true);
  assert.equal(first.effectFlags.linkDelegation, true);
  assert.equal(first.effectFlags.appendFailureResult, true);
  assert.equal(JSON.stringify(first).includes("SECRET_HANDOFF_BODY"), false);
  assert.equal(containsForbiddenBodyKey(first), false);
});

test("invalid canonical and local handoff preflight failures append no prepared sentinel", async () => {
  for (const label of ["refs", "run_id", "empty message"]) {
    let preparations = 0;
    await assert.rejects(() => executeGoalHandoffCas({
      guard: parseOptionalGoalMutationGuard({ mutation_id: `invalid-${label.replace(/\W+/g, "-")}` }),
      receipts: createGoalMutationReceiptState(),
      preflight: () => { throw new Error(`invalid ${label}`); },
      persistPreparation: () => { preparations += 1; },
      persistReceipt: () => undefined,
    }), new RegExp(`invalid ${label}`));
    assert.equal(preparations, 0, `${label} rejected before prepared`);
  }

  for (const label of ["target", "team", "sender", "delegation policy"]) {
    const counter = counters();
    let preparations = 0;
    await assert.rejects(() => executeGoalHandoffCas({
      guard: parseOptionalGoalMutationGuard({ mutation_id: `invalid-${label.replace(/\W+/g, "-")}` }),
      receipts: createGoalMutationReceiptState(),
      preflight: () => plan(counter, { beforeApplyError: `invalid ${label}` }),
      persistPreparation: () => { preparations += 1; },
      persistReceipt: () => undefined,
    }), new RegExp(`invalid ${label}`));
    assert.equal(preparations, 0, `${label} rejected before prepared`);
    assert.deepEqual(effectSnapshot(counter), { goalRoom: 0, live: 0, delegation: 0, events: 0, results: 0 });
  }
});

test("guarded handoff success replays with zero Goal Room, live, delegation, event, result, sentinel, or receipt effects", async () => {
  const counter = counters();
  const receipts = createGoalMutationReceiptState();
  const branch: Entry[] = [];
  const applied = await execute(counter, { mutationId: "handoff-replay", receipts, branch, expectedGraphRevision: 4 });
  assert.equal(applied.outcome.status, "applied");
  assert.deepEqual(effectSnapshot(counter), { goalRoom: 3, live: 1, delegation: 3, events: 3, results: 1 });
  assert.deepEqual(branch.map((entry) => entry.customType), [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, GOAL_MUTATION_RECEIPT_ENTRY_TYPE]);
  const receipt = branch[1]?.data as Record<string, unknown>;
  assert.equal(receipt.todoId, undefined, "multi-node handoff remains graph-bound");
  assert.equal(receipt.todoRevision, undefined, "multi-node handoff never fabricates one TODO revision");
  assert.equal((receipt.sideEffect as { state?: string }).state, "completed");

  const beforeReplay = { effects: effectSnapshot(counter), localPreflight: counter.localPreflight, entries: branch.length };
  const replayed = await execute(counter, { mutationId: "handoff-replay", receipts, branch, expectedGraphRevision: 4 });
  assert.equal(replayed.outcome.status, "replayed");
  assert.deepEqual(effectSnapshot(counter), beforeReplay.effects);
  assert.equal(counter.localPreflight, beforeReplay.localPreflight, "exact replay skips local target/team policy validation");
  assert.equal(branch.length, beforeReplay.entries, "exact replay appends no sentinel or receipt");
});

test("delivery failure after prepared remains in_doubt, appends no aborted phase, and never auto-reruns", async () => {
  const counter = counters();
  const receipts = createGoalMutationReceiptState();
  const branch: Entry[] = [];
  await assert.rejects(() => execute(counter, {
    mutationId: "handoff-delivery-failure",
    receipts,
    branch,
    options: { applyError: "live delivery failed after Goal Room and delegation" },
  }), /live delivery failed/);
  assert.deepEqual(branch.map((entry) => [(entry.data as { phase?: string }).phase, entry.customType]), [["prepared", GOAL_MUTATION_PREPARATION_ENTRY_TYPE]]);
  assert.equal(receipts.inDoubtByGoal[GOAL_ID]?.["handoff-delivery-failure"]?.phase, "prepared");
  assert.equal(receipts.protocolByGoal[GOAL_ID]?.["handoff-delivery-failure"]?.phase, "prepared");
  const beforeRetry = effectSnapshot(counter);

  const retry = await execute(counter, { mutationId: "handoff-delivery-failure", receipts, branch });
  assert.equal(retry.outcome.status, "rejected");
  assert.deepEqual(retry.outcome.failureCodes, ["mutation_in_doubt"]);
  assert.deepEqual(effectSnapshot(counter), beforeRetry);
  assert.equal(branch.length, 1);
});

test("delivery failure marks the exact handoff attempt failed, appends hash-only telemetry, rethrows the original error, and remains in_doubt", async () => {
  const entries: Entry[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
  } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  const node = addGoalTodo(pi, state, GOAL_ID, { title: "delivery failure target", status: "ready" }, "tool");
  entries.length = 0;
  const receipts = createGoalMutationReceiptState();
  const deliveryError = new Error("original live delivery failure");
  const runId = "handoff_effect_failure";
  const input = {
    todo_id: node.id,
    target_type: "zpeer" as const,
    target: "worker",
    custom_message: "transient delivery body",
  };
  const validated = {
    goalId: GOAL_ID,
    runId,
    nodes: [node],
    canonicalTodoIds: [node.id],
    normalizedTarget: "worker",
    canonicalTargetHash: TARGET_HASH,
    targetRoomHashes: [ROOM_HASH],
    instructionHash: INSTRUCTION_HASH,
    delegationDepth: 1,
    sender: "parent",
    teamName: "zob-core",
    compatibilityWarnings: [],
    input,
    target: { targetHash: TARGET_HASH, deliveryTarget: "worker", errors: [], peerCount: 1 },
    teamDefinition: {},
    deliveryTargets: [],
  } as unknown as ValidatedHandoffGoalTodoPreflight;
  const overrides: HandoffGoalTodoEffectOverrides = {
    appendGoalRoomMessage: (() => ({ msgId: "goal-room-prepared" })) as NonNullable<HandoffGoalTodoEffectOverrides["appendGoalRoomMessage"]>,
    deliverHandoffLive: (async () => { throw deliveryError; }) as NonNullable<HandoffGoalTodoEffectOverrides["deliverHandoffLive"]>,
  };

  let caught: unknown;
  try {
    await executeGoalHandoffCas({
      guard: parseOptionalGoalMutationGuard({
        mutation_id: "handoff-effect-failure",
        expected_graph_revision: state.goalTodos.graphRevisions[GOAL_ID],
        expected_todo_revision: node.revision,
      }),
      receipts,
      preflight: () => ({
        goalId: GOAL_ID,
        canonicalTodoIds: [node.id],
        runId,
        targetType: "zpeer",
        canonicalTargetHash: TARGET_HASH,
        targetHashes: [TARGET_HASH],
        targetRoomHashes: [ROOM_HASH],
        instructionHash: INSTRUCTION_HASH,
        delegationDepth: 1,
        senderHash: SENDER_HASH,
        goalRoomTeamHash: TEAM_HASH,
        current: {
          graphRevision: state.goalTodos.graphRevisions[GOAL_ID],
          todoRevisions: { [node.id]: node.revision ?? 0 },
        },
        beforeApply: () => undefined,
        apply: async () => {
          const result = await executeHandoffGoalTodoEffects(pi, state, process.cwd(), validated, "tool", overrides);
          return { result, appliedRevisions: {}, eventCount: 0 };
        },
      }),
      persistPreparation: (preparation) => pi.appendEntry(GOAL_MUTATION_PREPARATION_ENTRY_TYPE, preparation),
      persistReceipt: (receipt) => pi.appendEntry(GOAL_MUTATION_RECEIPT_ENTRY_TYPE, receipt),
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, deliveryError, "the original delivery error object is rethrown");
  const failed = state.goalTodos.nodes.find((candidate) => candidate.id === node.id)!;
  assert.equal(failed.status, "delegated");
  assert.equal(failed.delegation?.status, "failed");
  assert.equal(failed.delegation?.runId, runId);
  assert.equal(failed.delegation?.requestId, `handoff:${runId}:${node.id}`);
  assert.equal(failed.claim, undefined);
  assert.equal(receipts.inDoubtByGoal[GOAL_ID]?.["handoff-effect-failure"]?.phase, "prepared");
  assert.equal(entries.some((entry) => entry.customType === GOAL_MUTATION_RECEIPT_ENTRY_TYPE), false);

  const telemetry = entries.find((entry) => entry.customType === "zob-goal-todo-handoff")?.data as Record<string, unknown>;
  assert.ok(telemetry);
  assert.equal(telemetry.deliverySucceeded, false);
  assert.equal(telemetry.delegationFailureMarked, 1);
  assert.equal(telemetry.delegationFailureMarkFailed, 0);
  assert.equal(telemetry.bodyStored, false);
  assert.equal(telemetry.promptBodiesStored, false);
  assert.equal(telemetry.outputBodiesStored, false);
  assert.match(String(telemetry.failureHash), /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes(deliveryError.message), false);
  assert.equal(serialized.includes(input.custom_message), false);
});

test("receipt failure after all handoff effects restores as unmatched prepared and blocks restart retry", async () => {
  const counter = counters();
  const receipts = createGoalMutationReceiptState();
  const branch: Entry[] = [];
  const failed = await execute(counter, { mutationId: "handoff-receipt-outage", receipts, branch, receiptFailure: true });
  assert.equal(failed.outcome.status, "rejected");
  assert.deepEqual(failed.outcome.failureCodes, ["receipt_persistence_failed"]);
  assert.deepEqual(effectSnapshot(counter), { goalRoom: 3, live: 1, delegation: 3, events: 3, results: 1 });
  assert.deepEqual(branch.map((entry) => entry.customType), [GOAL_MUTATION_PREPARATION_ENTRY_TYPE]);

  const restored = restoreGoalMutationReceiptsFromBranch(branch);
  const restartedCounter = counters();
  const restartedEntries: Entry[] = [];
  const retry = await execute(restartedCounter, { mutationId: "handoff-receipt-outage", receipts: restored, branch: restartedEntries });
  assert.equal(retry.outcome.status, "rejected");
  assert.deepEqual(retry.outcome.failureCodes, ["mutation_in_doubt"]);
  assert.deepEqual(effectSnapshot(restartedCounter), { goalRoom: 0, live: 0, delegation: 0, events: 0, results: 0 });
  assert.equal(restartedEntries.length, 0);
});

test("handoff conflict, stale graph, and batch TODO guard fail before every effect", async () => {
  const counter = counters();
  const receipts = createGoalMutationReceiptState();
  await execute(counter, { mutationId: "handoff-conflict", receipts });
  const beforeConflict = effectSnapshot(counter);
  const conflicted = await execute(counter, { mutationId: "handoff-conflict", receipts, options: { instructionHash: hashGoalMutationRequest("different instruction") } });
  assert.equal(conflicted.outcome.status, "conflict");
  assert.deepEqual(conflicted.outcome.failureCodes, ["mutation_id_conflict"]);
  assert.deepEqual(effectSnapshot(counter), beforeConflict);

  const staleCounter = counters();
  const stale = await execute(staleCounter, { mutationId: "handoff-stale", expectedGraphRevision: 3 });
  assert.equal(stale.outcome.status, "stale");
  assert.deepEqual(stale.outcome.failureCodes, ["stale_graph_revision"]);
  assert.deepEqual(effectSnapshot(staleCounter), { goalRoom: 0, live: 0, delegation: 0, events: 0, results: 0 });

  const batchCounter = counters();
  const batchTodoGuard = await execute(batchCounter, { mutationId: "handoff-batch-todo-guard", expectedTodoRevision: 1 });
  assert.equal(batchTodoGuard.outcome.status, "rejected");
  assert.deepEqual(batchTodoGuard.outcome.failureCodes, ["invalid_revision_guard"]);
  assert.deepEqual(effectSnapshot(batchCounter), { goalRoom: 0, live: 0, delegation: 0, events: 0, results: 0 });
});

test("handoff CAS durable metadata is hash-only/body-free and excludes aliases, rooms, messages, outputs, and errors", async () => {
  const counter = counters();
  const branch: Entry[] = [];
  const execution = await execute(counter, { mutationId: "handoff-body-free", branch });
  assert.equal(execution.outcome.status, "applied");
  assert.equal(containsForbiddenBodyKey(branch), false);
  const serialized = JSON.stringify(branch);
  for (const raw of ["SECRET_HANDOFF_BODY", "@worker-alias", "private-room", "simulated handoff receipt outage"]) {
    assert.equal(serialized.includes(raw), false);
  }
  assert.equal(serialized.includes(INSTRUCTION_HASH), false, "prepared/receipt store only the canonical request hash, not payload fields");
  assert.equal((execution.outcome.receipt.sideEffect?.operationHash?.length ?? 0), 64);
});

test("unguarded handoff preserves legacy one-shot behavior and writes no CAS records", async () => {
  const counter = counters();
  const branch: Entry[] = [];
  const legacy = await execute(counter, { mutationId: "ignored-legacy-id", branch, guard: false });
  assert.equal(legacy.outcome.status, "observed");
  assert.deepEqual(effectSnapshot(counter), { goalRoom: 3, live: 1, delegation: 3, events: 3, results: 1 });
  assert.equal(counter.localPreflight, 1);
  assert.equal(branch.length, 0);
});

test("public handoff tool exposes optional shared cas and rejects early invalid inputs without prepared", async () => {
  type CapturedTool = {
    parameters: { properties?: Record<string, unknown>; required?: string[] };
    execute: (...args: unknown[]) => Promise<unknown>;
  };
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    registerTool(tool: CapturedTool & { name: string }) { tools.set(tool.name, tool); },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  state.runtimeGoal = { goalId: GOAL_ID, revision: 0 } as NonNullable<typeof state.runtimeGoal>;
  const node = addGoalTodo(pi, state, GOAL_ID, { title: "handoff CAS target", status: "ready" }, "tool");
  entries.length = 0;
  registerGoalRuntimeTools(pi, state);
  const tool = tools.get("handoff_goal_todo");
  assert.ok(tool);
  assert.equal((tool.parameters.properties?.cas as { type?: string }).type, "object");
  assert.equal(tool.parameters.required?.includes("cas") ?? false, false);

  const base = {
    todo_id: node.id,
    target_type: "zpeer",
    target: "@worker-alias",
    custom_message: "bounded transient instructions",
    cas: { mutation_id: "handoff-tool-invalid" },
  };
  await assert.rejects(() => tool.execute("empty-message", { ...base, custom_message: "" }, undefined, undefined, { cwd: process.cwd() }), /maintainer-authored custom_message/);
  await assert.rejects(() => tool.execute("invalid-ref", { ...base, todo_id: "missing-todo" }, undefined, undefined, { cwd: process.cwd() }), /handoff TODO ref/);
  await assert.rejects(() => tool.execute("invalid-run", { ...base, run_id: "../bad" }, undefined, undefined, { cwd: process.cwd() }), /run_id must be path-safe/);
  assert.equal(entries.some((entry) => entry.type === GOAL_MUTATION_PREPARATION_ENTRY_TYPE), false);

  registerGoalRuntimeEvents(pi, state, () => undefined);
  const handler = handlers.get("tool_execution_end");
  assert.ok(handler);
  const stateBefore = JSON.stringify(state);
  await handler({ toolName: "handoff_goal_todo", args: base, result: { isError: true } }, {});
  assert.equal(entries.some((entry) => entry.type === "zob-runtime-goal"), false, "rejected guarded public handoff does not persist root Goal state in the post-hook");
  assert.equal(JSON.stringify(state), stateBefore);
});

test("guarded handoff tool completion suppresses generic runtime-goal persistence events", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const entries: unknown[] = [];
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  let renders = 0;
  registerGoalRuntimeEvents(pi, state, () => { renders += 1; });
  const handler = handlers.get("tool_execution_end");
  assert.ok(handler);
  await handler({
    toolName: "handoff_goal_todo",
    args: { cas: { mutation_id: "handoff-event-replay" } },
    result: { details: { cas: { status: "replayed" } } },
  }, {});
  assert.equal(entries.length, 0);
  assert.equal(renders, 1);
});

test("tool canonicalization resolves and deduplicates TODO refs before hashing and derives a stable guarded run id", () => {
  const entries: unknown[] = [];
  const pi = { appendEntry(type: string, data: unknown) { entries.push({ type, data }); } } as unknown as ExtensionAPI;
  const state = createHarnessRuntimeState();
  state.runtimeGoal = { goalId: GOAL_ID, revision: 0 } as NonNullable<typeof state.runtimeGoal>;
  const first = addGoalTodo(pi, state, GOAL_ID, { title: "first", status: "ready" }, "tool");
  const second = addGoalTodo(pi, state, GOAL_ID, { title: "second", status: "ready" }, "tool");
  const guard = parseOptionalGoalMutationGuard({ mutation_id: "stable-handoff-run" });
  const input = {
    todo_path: second.path,
    todo_refs: [{ todo_id: first.id }, { todo_id: second.id }],
    target_type: "zpeer" as const,
    target: "@@worker-alias",
    target_room: "control",
    custom_message: "SECRET_HANDOFF_BODY",
  };
  const canonical = canonicalizeHandoffGoalTodos(state, input, guard);
  const repeated = canonicalizeHandoffGoalTodos(state, input, guard);
  linkGoalTodoDelegation(pi, state, GOAL_ID, first.id, { runId: "already-handed-off", status: "queued", delegationDepth: 1 }, "tool");
  const replayCanonical = canonicalizeHandoffGoalTodos(state, input, guard);
  assert.deepEqual(canonical.canonicalTodoIds, [first.id, second.id].sort());
  assert.deepEqual(replayCanonical.canonicalTodoIds, canonical.canonicalTodoIds, "canonical replay identity survives delegated TODO status");
  assert.equal(canonical.runId, repeated.runId);
  assert.match(canonical.runId, /^handoff_[a-f0-9]{24}$/);
  assert.equal(canonical.instructionHash.length, 64);
  assert.equal(canonical.instructionHash === input.custom_message, false);
  assert.equal(canonical.targetRoomHashes[0]?.length, 64);
  assert.equal(canonical.targetRoomHashes.includes("control"), false, "room is represented only by a hash in the CAS payload");
});
