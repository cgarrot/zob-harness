import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GOAL_MUTATION_RECEIPT_ENTRY_TYPE,
  addGoalTodo,
  buildRuntimeGoalCompletionProposal,
  completeGoalTodo,
  createHarnessRuntimeState,
  evaluateRuntimeGoalOracleFreshness,
  normalizeRuntimeGoalOracleState,
  restoreRuntimeGoalFromBranch,
} from "../.pi/extensions/zob-harness/index.ts";
import { appendRuntimeGoalEntry, createRuntimeGoal, setEntry } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts";
import { registerGoalRuntimeTools } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ENTRY_TYPE = "zob-runtime-goal";
const GOAL_ID = "goal-oracle-binding-v2";
const RAW_SUMMARY = "RAW oracle summary must never persist";
const RAW_REF = "test/goal-oracle-bindings.test.ts#raw-oracle-evidence";

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
type State = ReturnType<typeof createHarnessRuntimeState>;

type Built = {
  pi: ExtensionAPI;
  entries: Entry[];
  tools: Map<string, CapturedTool>;
  state: State;
};

function capturePi() {
  const entries: Entry[] = [];
  const tools = new Map<string, CapturedTool>();
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    registerTool(tool: CapturedTool) { tools.set(tool.name, tool); },
    sendMessage() { return undefined; },
  } as unknown as ExtensionAPI;
  return { pi, entries, tools };
}

function call(built: Built, name: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = built.tools.get(name);
  assert.ok(tool, `registered ${name}`);
  return tool.execute("oracle-binding-call", params, undefined, undefined, {
    cwd: process.cwd(),
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setStatus: () => undefined },
  });
}

async function proposedGoal(): Promise<Built> {
  const capture = capturePi();
  const state = createHarnessRuntimeState();
  const goal = { ...createRuntimeGoal("exact oracle binding lifecycle"), goalId: GOAL_ID };
  appendRuntimeGoalEntry(capture.pi, state, setEntry(goal, "tool"));
  registerGoalRuntimeTools(capture.pi, state);
  await call({ ...capture, state }, "propose_goal_completion", {
    goal_id: GOAL_ID,
    completion_summary: "all exact oracle requirements are evidenced",
    requirements_checked: ["exact proposal/oracle/root/TODO lineage"],
    evidence_refs: ["test/goal-oracle-bindings.test.ts"],
    validation_commands: ["node --import tsx --test test/goal-oracle-bindings.test.ts"],
    known_risks: [],
    no_ship: false,
    cas: { mutation_id: "oracle-fixture-proposal", expected_goal_revision: 1, expected_graph_revision: 0 },
  });
  capture.entries.length = 0;
  return { ...capture, state };
}

function proposalHash(built: Built): string {
  const hash = built.state.runtimeGoal?.completionProposal?.proposalHash;
  assert.match(hash ?? "", /^[a-f0-9]{64}$/);
  return hash!;
}

function oracleParams(built: Built, mutationId = "oracle-binding-record", overrides: Record<string, unknown> = {}) {
  return {
    verdict: "PASS",
    no_ship: false,
    evidence_summary: RAW_SUMMARY,
    evidence_refs: [RAW_REF],
    expected_proposal_hash: proposalHash(built),
    cas: { mutation_id: mutationId, expected_goal_revision: built.state.runtimeGoal!.revision },
    ...overrides,
  };
}

function completionParams(built: Built, mutationId = "oracle-binding-complete", overrides: Record<string, unknown> = {}) {
  const oracleHash = built.state.runtimeGoal?.oracle.oracleDecisionHash;
  assert.match(oracleHash ?? "", /^[a-f0-9]{64}$/);
  return {
    status: "complete",
    expected_proposal_hash: proposalHash(built),
    expected_oracle_decision_hash: oracleHash,
    cas: { mutation_id: mutationId, expected_goal_revision: built.state.runtimeGoal!.revision },
    ...overrides,
  };
}

function snapshot(built: Built): string {
  return JSON.stringify({ runtimeGoal: built.state.runtimeGoal, goalTodos: built.state.goalTodos, entries: built.entries });
}

async function rejectsZeroEffect(built: Built, toolName: string, params: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const before = snapshot(built);
  await assert.rejects(() => call(built, toolName, params), pattern);
  assert.equal(snapshot(built), before);
}

function assertOracleBodiesAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(RAW_SUMMARY), false);
  assert.equal(serialized.includes(RAW_REF), false);
  assert.equal(serialized.includes("reviewHash"), false);
  assert.equal(serialized.includes("evidence_summary"), false);
}

function oracleFreshness(built: Built) {
  const goal = built.state.runtimeGoal;
  return evaluateRuntimeGoalOracleFreshness({
    goal,
    todoGraphRevision: goal ? built.state.goalTodos.graphRevisions[goal.goalId] ?? 0 : 0,
    todoRestoreBlocked: Boolean(goal && built.state.goalTodos.restoreBlocked?.[goal.goalId]),
    completionDiagnostics: { completionReady: true, effectiveNoShip: false },
  });
}

test("record/completion schemas require exact full hashes and root CAS", () => {
  const capture = capturePi();
  registerGoalRuntimeTools(capture.pi, createHarnessRuntimeState());
  const oracle = capture.tools.get("record_goal_oracle")!;
  const complete = capture.tools.get("update_goal")!;
  for (const [tool, fields] of [
    [oracle, ["expected_proposal_hash", "cas"]],
    [complete, ["expected_proposal_hash", "expected_oracle_decision_hash", "cas"]],
  ] as const) {
    for (const field of fields) assert.equal(tool.parameters.required?.includes(field), true, `${tool.name} requires ${field}`);
    const cas = tool.parameters.properties?.cas as { required?: string[]; additionalProperties?: boolean };
    assert.deepEqual(cas.required?.sort(), ["expected_goal_revision", "mutation_id"]);
    assert.equal(cas.additionalProperties, false);
  }
  for (const field of [
    oracle.parameters.properties?.expected_proposal_hash,
    complete.parameters.properties?.expected_proposal_hash,
    complete.parameters.properties?.expected_oracle_decision_hash,
  ]) {
    assert.equal((field as { pattern?: string }).pattern, "^[a-f0-9]{64}$");
  }
});

test("exact PASS decision is body-free, immutable, exposed in getters, and exact completion/replays append once", async () => {
  const built = await proposedGoal();
  const proposal = built.state.runtimeGoal!.completionProposal!;
  const oracleInput = oracleParams(built);
  const recorded = await call(built, "record_goal_oracle", oracleInput);
  const oracle = built.state.runtimeGoal!.oracle;

  assert.equal(oracle.oracleVersion, 2);
  assert.match(oracle.oracleDecisionHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(oracle.proposalHash, proposal.proposalHash);
  assert.equal(oracle.proposalGoalRevision, proposal.goalRevision);
  assert.equal(oracle.todoGraphRevision, proposal.todoGraphRevision);
  assert.equal(oracle.goalRevision, built.state.runtimeGoal!.revision);
  assert.equal(oracle.verdict, "PASS");
  assert.equal(oracle.noShip, false);
  assert.equal(oracle.evidenceCount, 2);
  assert.equal(oracle.bodyStored, false);
  assert.deepEqual(oracle.evidenceRefs, []);
  assert.equal(Object.keys(oracle).includes("evidenceRefs"), false, "compatibility evidence view is never persisted");
  assert.equal(oracleFreshness(built).code, "fresh");
  assert.equal(recorded.details.oracleDecisionHash, oracle.oracleDecisionHash);
  assertOracleBodiesAbsent(recorded);
  assertOracleBodiesAbsent(built.entries);
  assertOracleBodiesAbsent(built.state.runtimeGoal);

  const oracleEntries = built.entries.length;
  const oracleState = JSON.stringify(built.state);
  const oracleReplay = await call(built, "record_goal_oracle", oracleInput);
  assert.equal((oracleReplay.details.cas as { status: string }).status, "replayed");
  assert.equal(oracleReplay.details.oracleDecisionHash, oracle.oracleDecisionHash);
  assert.equal(built.entries.length, oracleEntries);
  assert.equal(JSON.stringify(built.state), oracleState);

  const getter = await call(built, "get_goal");
  assert.equal(getter.details.proposalHash, proposal.proposalHash);
  assert.equal(getter.details.oracleDecisionHash, oracle.oracleDecisionHash);
  assert.equal(getter.details.oracleGoalRevision, oracle.goalRevision);
  assert.equal(getter.details.oracleFreshnessCode, "fresh");
  assert.match(getter.content[0]!.text, /oracleDecisionHash=.*root\/TODO\/proposal mutations after oracle require reproposal/);
  assertOracleBodiesAbsent(getter);

  built.entries.length = 0;
  const completeInput = completionParams(built);
  const completed = await call(built, "update_goal", completeInput);
  assert.equal(built.state.runtimeGoal?.status, "complete");
  assert.equal(built.state.runtimeGoal?.completionProposal?.proposalHash, proposal.proposalHash);
  assert.equal(built.state.runtimeGoal?.oracle.oracleDecisionHash, oracle.oracleDecisionHash);
  assert.equal(built.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE).length, 1);
  assert.equal((completed.details.oracleFreshness as { code: string }).code, "fresh");
  assertOracleBodiesAbsent(completed);

  const completedEntries = built.entries.length;
  const completedState = JSON.stringify(built.state);
  const completionReplay = await call(built, "update_goal", completeInput);
  assert.equal((completionReplay.details.cas as { status: string }).status, "replayed");
  assert.equal(completionReplay.details.proposalHash, proposal.proposalHash);
  assert.equal(completionReplay.details.oracleDecisionHash, oracle.oracleDecisionHash);
  assert.equal(built.entries.length, completedEntries);
  assert.equal(JSON.stringify(built.state), completedState);

  await rejectsZeroEffect(built, "update_goal", {
    ...completeInput,
    cas: { mutation_id: "new-completion-after-complete", expected_goal_revision: built.state.runtimeGoal!.revision },
  }, /code=GOAL_ALREADY_COMPLETE/);
});

test("truncated/wrong hashes and stale CAS fail before root/TODO mutation while CAS conflict remains deterministic", async () => {
  for (const [field, value, pattern] of [
    ["expected_proposal_hash", proposalHash(await proposedGoal()).slice(0, 12), /code=BINDING_HASH_INVALID/],
    ["expected_proposal_hash", "f".repeat(64), /code=PROPOSAL_HASH_MISMATCH/],
  ] as const) {
    const built = await proposedGoal();
    await rejectsZeroEffect(built, "record_goal_oracle", oracleParams(built, `oracle-${field}-${value.length}`, { [field]: value }), pattern);
  }

  const stale = await proposedGoal();
  const staleResult = await call(stale, "record_goal_oracle", oracleParams(stale, "oracle-stale-cas", {
    cas: { mutation_id: "oracle-stale-cas", expected_goal_revision: stale.state.runtimeGoal!.revision + 1 },
  }));
  assert.equal(staleResult.isError, true);
  assert.deepEqual((staleResult.details.cas as { failureCodes: string[] }).failureCodes, ["stale_goal_revision"]);
  assert.equal(stale.entries.length, 0);

  const conflict = await proposedGoal();
  const exact = oracleParams(conflict, "oracle-cas-conflict");
  await call(conflict, "record_goal_oracle", exact);
  conflict.entries.length = 0;
  const stateAfterApply = JSON.stringify(conflict.state);
  const conflicted = await call(conflict, "record_goal_oracle", { ...exact, evidence_summary: "different transient oracle evidence" });
  assert.equal(conflicted.isError, true);
  assert.deepEqual((conflicted.details.cas as { failureCodes: string[] }).failureCodes, ["mutation_id_conflict"]);
  assert.equal(conflict.entries.length, 0);
  assert.equal(JSON.stringify(conflict.state), stateAfterApply);
});

test("TODO mutation before/after oracle invalidates exact lineage; reproposal clears the old decision", async () => {
  const before = await proposedGoal();
  const beforeTodo = addGoalTodo(before.pi, before.state, GOAL_ID, { title: "pre-oracle mutation", status: "ready" }, "tool");
  completeGoalTodo(before.pi, before.state, GOAL_ID, beforeTodo.id, { evidenceRefs: ["test/goal-oracle-bindings.test.ts"] }, "tool");
  before.entries.length = 0;
  await rejectsZeroEffect(before, "record_goal_oracle", oracleParams(before, "oracle-after-pre-mutation"), /code=PROPOSAL_NOT_FRESH.*todo_graph_revision_mismatch/);

  const after = await proposedGoal();
  await call(after, "record_goal_oracle", oracleParams(after, "oracle-before-post-mutation"));
  const oldOracleHash = after.state.runtimeGoal!.oracle.oracleDecisionHash!;
  const afterTodo = addGoalTodo(after.pi, after.state, GOAL_ID, { title: "post-oracle mutation", status: "ready" }, "tool");
  completeGoalTodo(after.pi, after.state, GOAL_ID, afterTodo.id, { evidenceRefs: ["test/goal-oracle-bindings.test.ts"] }, "tool");
  after.entries.length = 0;
  await rejectsZeroEffect(after, "update_goal", completionParams(after, "complete-after-todo-mutation"), /code=PROPOSAL_NOT_FRESH.*todo_graph_revision_mismatch/);

  const reproposed = await call(after, "propose_goal_completion", {
    goal_id: GOAL_ID,
    completion_summary: "fresh after TODO graph mutation",
    requirements_checked: ["all TODOs remain complete"],
    evidence_refs: ["test/goal-oracle-bindings.test.ts"],
    validation_commands: ["node --import tsx --test test/goal-oracle-bindings.test.ts"],
    known_risks: [],
    no_ship: false,
  });
  assert.notEqual(reproposed.details.proposalHash, after.state.runtimeGoal?.oracle.proposalHash);
  assert.equal(after.state.runtimeGoal?.oracle.status, "needed");
  assert.equal(after.state.runtimeGoal?.oracle.oracleDecisionHash, undefined);
  await rejectsZeroEffect(after, "update_goal", {
    status: "complete",
    expected_proposal_hash: proposalHash(after),
    expected_oracle_decision_hash: oldOracleHash,
    cas: { mutation_id: "complete-with-old-oracle", expected_goal_revision: after.state.runtimeGoal!.revision },
  }, /code=ORACLE_V2_REQUIRED/);
});

test("any root mutation after oracle blocks completion until reproposal and a new review", async () => {
  const built = await proposedGoal();
  await call(built, "record_goal_oracle", oracleParams(built, "oracle-before-root-mutation"));
  const oldProposal = proposalHash(built);
  const oldOracle = built.state.runtimeGoal!.oracle.oracleDecisionHash!;
  appendRuntimeGoalEntry(built.pi, built.state, setEntry(built.state.runtimeGoal!, "runtime"));
  built.entries.length = 0;

  await rejectsZeroEffect(built, "update_goal", completionParams(built, "complete-after-root-mutation"), /code=ORACLE_ROOT_LINEAGE_MISMATCH/);
  const reproposed = await call(built, "propose_goal_completion", {
    goal_id: GOAL_ID,
    completion_summary: "fresh root lineage after accounting mutation",
    requirements_checked: ["root lineage refreshed"],
    evidence_refs: ["test/goal-oracle-bindings.test.ts"],
    validation_commands: ["node --import tsx --test test/goal-oracle-bindings.test.ts"],
    known_risks: [],
    no_ship: false,
  });
  assert.notEqual(reproposed.details.proposalHash, oldProposal);
  assert.equal(built.state.runtimeGoal?.oracle.oracleDecisionHash, undefined);
  assert.notEqual(oldOracle, built.state.runtimeGoal?.oracle.oracleDecisionHash);
});

for (const [label, verdict, noShip, expectedCode] of [
  ["WARN", "WARN", false, "ORACLE_VERDICT_NOT_PASS"],
  ["FAIL", "FAIL", false, "ORACLE_VERDICT_NOT_PASS"],
  ["PASS no_ship", "PASS", true, "ORACLE_NO_SHIP"],
] as const) {
  test(`${label} oracle decision remains immutable but blocks completion with stable guidance`, async () => {
    const built = await proposedGoal();
    await call(built, "record_goal_oracle", oracleParams(built, `oracle-${label.replace(/\s/g, "-")}`, { verdict, no_ship: noShip }));
    const oracleHash = built.state.runtimeGoal!.oracle.oracleDecisionHash!;
    await rejectsZeroEffect(built, "update_goal", {
      status: "complete",
      expected_proposal_hash: proposalHash(built),
      expected_oracle_decision_hash: oracleHash,
      cas: { mutation_id: `complete-${label.replace(/\s/g, "-")}`, expected_goal_revision: built.state.runtimeGoal!.revision },
    }, new RegExp(`code=${expectedCode}.*safe_next_actions=resume_goal_then_propose_goal_completion`));
  });
}

test("legacy oracle restore is readable/body-free but unbound and never gains inferred hashes", async () => {
  const proposal = buildRuntimeGoalCompletionProposal({
    goalId: GOAL_ID,
    goalRevision: 1,
    todoGraphRevision: 0,
    completionSummary: "legacy restore proposal",
    requirementsChecked: [],
    evidenceRefs: [],
    validationCommands: [],
    knownRisks: [],
    noShip: false,
    proposedAt: "2026-01-01T00:00:00.000Z",
  });
  const goal = { ...createRuntimeGoal("legacy oracle restore"), goalId: GOAL_ID, status: "ready_for_oracle" as const, completionProposal: proposal };
  goal.oracle = {
    required: true,
    status: "passed",
    verdict: "PASS",
    noShip: false,
    evidenceRefs: [RAW_REF],
    reviewedAt: "2026-01-01T00:00:01.000Z",
    ...({ reviewHash: "a".repeat(64), blockerSummary: RAW_SUMMARY } as object),
  };
  const restored = restoreRuntimeGoalFromBranch([{
    customType: GOAL_ENTRY_TYPE,
    data: { version: 1, kind: "set", source: "runtime", goal, at: 1 },
  }]);
  assert.ok(restored);
  assert.equal(restored.oracle.legacyUnbound, true);
  assert.equal(restored.oracle.oracleDecisionHash, undefined);
  assert.equal(restored.oracle.proposalHash, undefined);
  assert.deepEqual(restored.oracle.evidenceRefs, []);
  assertOracleBodiesAbsent(restored);

  const capture = capturePi();
  const state = createHarnessRuntimeState();
  state.runtimeGoal = restored;
  registerGoalRuntimeTools(capture.pi, state);
  const built = { ...capture, state };
  await rejectsZeroEffect(built, "update_goal", {
    status: "complete",
    expected_proposal_hash: proposal.proposalHash,
    expected_oracle_decision_hash: "b".repeat(64),
    cas: { mutation_id: "legacy-oracle-complete", expected_goal_revision: restored.revision },
  }, /code=LEGACY_ORACLE_UNBOUND/);

  const normalized = normalizeRuntimeGoalOracleState(goal.oracle, 1);
  assert.equal(normalized.legacyUnbound, true);
  assert.equal(normalized.oracleDecisionHash, undefined);
});

test("root append failure preserves the original Goal copy and exact retry records once", async () => {
  const built = await proposedGoal();
  const originalGoal = built.state.runtimeGoal;
  const originalBytes = JSON.stringify(originalGoal);
  const mutablePi = built.pi as unknown as { appendEntry: (type: string, data: unknown) => void };
  const append = mutablePi.appendEntry.bind(mutablePi);
  let outage = true;
  mutablePi.appendEntry = (type, data) => {
    if (outage && type === GOAL_ENTRY_TYPE) throw new Error("simulated oracle root append outage");
    append(type, data);
  };
  const params = oracleParams(built, "oracle-copy-on-write-outage");

  await assert.rejects(() => call(built, "record_goal_oracle", params), /simulated oracle root append outage/);
  assert.equal(built.state.runtimeGoal, originalGoal);
  assert.equal(JSON.stringify(built.state.runtimeGoal), originalBytes);
  assert.deepEqual(built.entries.map((entry) => [entry.type, (entry.data as { phase?: string }).phase]), [
    [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "prepared"],
    [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "aborted"],
  ]);
  assert.equal(built.entries.some((entry) => entry.type === GOAL_ENTRY_TYPE || entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE), false);

  outage = false;
  const retried = await call(built, "record_goal_oracle", params);
  assert.equal((retried.details.cas as { status: string }).status, "applied");
  assert.equal(built.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE).length, 1);
  assert.equal(built.entries.filter((entry) => entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE).length, 1);
  assertOracleBodiesAbsent(built.entries);
});
