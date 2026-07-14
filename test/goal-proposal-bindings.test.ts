import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  addGoalTodo,
  buildRuntimeGoalCompletionProposal,
  completeGoalTodo,
  createHarnessRuntimeState,
  evaluateRuntimeGoalCompletionProposalFreshness,
  goalTodoCompletionDiagnostics,
} from "../.pi/extensions/zob-harness/index.ts";
import {
  appendRuntimeGoalEntry,
  createRuntimeGoal,
  restoreRuntimeGoalFromBranch,
  setEntry,
  type RuntimeGoal,
} from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts";
import { registerGoalRuntimeTools } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ENTRY_TYPE = "zob-runtime-goal";
const GOAL_ID = "goal-proposal-v2";
const RAW_SUMMARY = "RAW completion summary must never persist";
const RAW_REQUIREMENT = "RAW requirement body must never persist";
const RAW_EVIDENCE = "test/goal-proposal-bindings.test.ts#raw-evidence";
const RAW_VALIDATION = "node --import tsx --test test/goal-proposal-bindings.test.ts --raw-marker";
const RAW_RISK = "RAW risk body must never persist";

const proposalParams = {
  goal_id: GOAL_ID,
  completion_summary: RAW_SUMMARY,
  requirements_checked: [RAW_REQUIREMENT, "second ordered requirement"],
  evidence_refs: [RAW_EVIDENCE],
  validation_commands: [RAW_VALIDATION],
  known_risks: [RAW_RISK],
  no_ship: false,
};

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface CapturedTool {
  name: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

function capturePi() {
  const entries: Array<{ type: string; data: unknown }> = [];
  const tools = new Map<string, CapturedTool>();
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    sendMessage() {
      return undefined;
    },
  } as unknown as ExtensionAPI;
  return { pi, entries, tools };
}

function callTool(tools: Map<string, CapturedTool>, name: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = tools.get(name);
  assert.ok(tool, `registered ${name}`);
  return tool.execute("goal-proposal-test", params, undefined, undefined, {
    cwd: process.cwd(),
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setStatus: () => undefined },
  });
}

function freshness(state: ReturnType<typeof createHarnessRuntimeState>) {
  const goal = state.runtimeGoal;
  const goalId = goal?.goalId;
  return evaluateRuntimeGoalCompletionProposalFreshness({
    goal,
    todoGraphRevision: goalId ? state.goalTodos.graphRevisions[goalId] ?? 0 : 0,
    todoRestoreBlocked: Boolean(goalId && state.goalTodos.restoreBlocked?.[goalId]),
    completionDiagnostics: goalTodoCompletionDiagnostics(state.goalTodos, goalId),
  });
}

function assertProposalBodiesAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const raw of [RAW_SUMMARY, RAW_REQUIREMENT, RAW_EVIDENCE, RAW_VALIDATION, RAW_RISK]) {
    assert.equal(serialized.includes(raw), false, `body-free value excludes ${raw}`);
  }
  const visit = (candidate: unknown, proposalScope = false): void => {
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    const scoped = proposalScope || record.proposalVersion === 1 || record.proposalVersion === 2;
    for (const [key, child] of Object.entries(record)) {
      if (scoped) assert.equal(["requirementsChecked", "evidenceRefs", "validationCommands", "knownRisks"].includes(key), false, `persisted proposal excludes raw field ${key}`);
      visit(child, scoped || key === "completionProposal");
    }
  };
  visit(value);
}

function legacyProposalGoal(): RuntimeGoal {
  const goal = { ...createRuntimeGoal("legacy proposal restore"), goalId: GOAL_ID };
  goal.status = "ready_for_oracle";
  goal.loop.enabled = false;
  goal.oracle.status = "needed";
  goal.completionProposal = {
    proposedAt: "2026-01-01T00:00:00.000Z",
    summaryHash: "a".repeat(64),
    requirementsChecked: [RAW_REQUIREMENT],
    evidenceRefs: [RAW_EVIDENCE],
    validationCommands: [RAW_VALIDATION],
    knownRisks: [RAW_RISK],
    noShip: false,
  } as unknown as RuntimeGoal["completionProposal"];
  return goal;
}

test("canonical proposal v2 hashes ordered bodies deterministically and exposes hashes/counts only", () => {
  const input = {
    goalId: GOAL_ID,
    goalRevision: 7,
    todoGraphRevision: 11,
    completionSummary: RAW_SUMMARY,
    requirementsChecked: [RAW_REQUIREMENT, "second ordered requirement"],
    evidenceRefs: [RAW_EVIDENCE],
    validationCommands: [RAW_VALIDATION],
    knownRisks: [RAW_RISK],
    noShip: false,
  };
  const first = buildRuntimeGoalCompletionProposal({ ...input, proposedAt: "2026-01-01T00:00:00.000Z" });
  const second = buildRuntimeGoalCompletionProposal({ ...input, proposedAt: "2026-02-01T00:00:00.000Z" });
  const reordered = buildRuntimeGoalCompletionProposal({ ...input, requirementsChecked: [...input.requirementsChecked].reverse() });
  const rebound = buildRuntimeGoalCompletionProposal({ ...input, goalRevision: 8 });

  assert.equal(first.proposalHash, second.proposalHash, "proposedAt is audit metadata, not canonical content identity");
  assert.notEqual(first.proposalHash, reordered.proposalHash, "ordered requirement semantics are preserved");
  assert.notEqual(first.proposalHash, rebound.proposalHash, "bound revisions participate in identity");
  assert.match(first.proposalHash, /^[a-f0-9]{64}$/);
  assert.equal(first.requirementsCount, 2);
  assert.equal(first.evidenceCount, 1);
  assert.equal(first.validationCount, 1);
  assert.equal(first.risksCount, 1);
  assert.deepEqual(first.requirementsChecked, [], "legacy compatibility view cannot reveal bodies");
  assert.equal(Object.keys(first).includes("requirementsChecked"), false);
  assertProposalBodiesAbsent(first);
});

test("proposal apply/replay is transactional, replay preserves original identity, TODO mutation invalidates, and reproposal refreshes", async () => {
  const { pi, entries, tools } = capturePi();
  const state = createHarnessRuntimeState();
  const goal = { ...createRuntimeGoal("proposal v2 lifecycle"), goalId: GOAL_ID };
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
  entries.length = 0;
  registerGoalRuntimeTools(pi, state);

  const guardedParams = {
    ...proposalParams,
    cas: { mutation_id: "proposal-v2-apply", expected_goal_revision: 1, expected_graph_revision: 0 },
  };
  const applied = await callTool(tools, "propose_goal_completion", guardedParams);
  const firstProposal = state.runtimeGoal?.completionProposal;
  assert.equal(applied.isError, undefined);
  assert.ok(firstProposal && firstProposal.proposalVersion === 2);
  assert.equal(firstProposal.goalRevision, 2, "snapshot binds the post-event Goal revision");
  assert.equal(firstProposal.todoGraphRevision, 0);
  assert.equal(applied.details.proposalHash, firstProposal.proposalHash);
  assert.equal(freshness(state).code, "fresh");
  assertProposalBodiesAbsent(entries);
  assertProposalBodiesAbsent(state.runtimeGoal);

  entries.length = 0;
  const replayed = await callTool(tools, "propose_goal_completion", guardedParams);
  assert.equal((replayed.details.cas as { status: string }).status, "replayed");
  assert.equal(replayed.details.proposalHash, firstProposal.proposalHash);
  assert.equal(entries.length, 0, "exact replay emits no events");

  appendRuntimeGoalEntry(pi, state, setEntry(state.runtimeGoal!, "runtime"));
  assert.equal(state.runtimeGoal?.revision, 3);
  assert.equal(freshness(state).code, "fresh", "metadata-only root revision keeps proposal lineage fresh");

  const todo = addGoalTodo(pi, state, GOAL_ID, { title: "post-proposal TODO mutation", status: "ready" }, "tool");
  completeGoalTodo(pi, state, GOAL_ID, todo.id, { evidenceRefs: ["test/goal-proposal-bindings.test.ts"] }, "tool");
  assert.equal(freshness(state).code, "todo_graph_revision_mismatch");
  const beforeBlockedCalls = entries.length;
  await assert.rejects(() => callTool(tools, "record_goal_oracle", {
    verdict: "PASS",
    no_ship: false,
    evidence_summary: "must not bind a stale proposal",
    expected_proposal_hash: firstProposal.proposalHash,
    cas: { mutation_id: "stale-proposal-oracle", expected_goal_revision: state.runtimeGoal!.revision },
  }), /code=PROPOSAL_NOT_FRESH.*freshness=todo_graph_revision_mismatch/);
  await assert.rejects(() => callTool(tools, "update_goal", {
    status: "complete",
    expected_proposal_hash: firstProposal.proposalHash,
    expected_oracle_decision_hash: "f".repeat(64),
    cas: { mutation_id: "stale-proposal-complete", expected_goal_revision: state.runtimeGoal!.revision },
  }), /code=PROPOSAL_NOT_FRESH.*freshness=todo_graph_revision_mismatch/);
  assert.equal(entries.length, beforeBlockedCalls, "stale oracle/completion paths are zero-effect");

  const reproposed = await callTool(tools, "propose_goal_completion", { ...proposalParams, completion_summary: "fresh summary after TODO mutation" });
  const secondProposal = state.runtimeGoal?.completionProposal;
  assert.equal(reproposed.isError, undefined);
  assert.ok(secondProposal && secondProposal.proposalVersion === 2);
  assert.notEqual(secondProposal.proposalHash, firstProposal.proposalHash);
  assert.equal(secondProposal.goalRevision, 4);
  assert.equal(secondProposal.todoGraphRevision, 2);
  assert.equal(freshness(state).code, "fresh");

  entries.length = 0;
  const oldReplay = await callTool(tools, "propose_goal_completion", guardedParams);
  assert.equal((oldReplay.details.cas as { status: string }).status, "replayed");
  assert.equal(oldReplay.details.proposalHash, firstProposal.proposalHash, "receipt returns the original proposal identity after later reproposal");
  assert.notEqual(oldReplay.details.proposalHash, secondProposal.proposalHash);
  assert.equal(oldReplay.details.proposalGoalRevision, 2);
  assert.equal(oldReplay.details.todoGraphRevision, 0);
  assert.equal(entries.length, 0);
});

test("legacy and malformed restored proposals fail closed without retaining raw bodies", () => {
  const legacy = legacyProposalGoal();
  const restoredLegacy = restoreRuntimeGoalFromBranch([{
    customType: GOAL_ENTRY_TYPE,
    data: { version: 1, kind: "set", source: "runtime", goal: legacy, at: 1 },
  }]);
  assert.ok(restoredLegacy?.completionProposal && "legacyUnbound" in restoredLegacy.completionProposal);
  const legacyFreshness = evaluateRuntimeGoalCompletionProposalFreshness({
    goal: restoredLegacy,
    todoGraphRevision: 0,
    completionDiagnostics: { completionReady: true, effectiveNoShip: false },
  });
  assert.equal(legacyFreshness.status, "legacy_unbound");
  assert.equal(legacyFreshness.code, "legacy_unbound");
  assertProposalBodiesAbsent(restoredLegacy);

  const malformedGoal = { ...createRuntimeGoal("malformed proposal restore"), goalId: GOAL_ID, status: "ready_for_oracle" as const, revision: 1 };
  malformedGoal.completionProposal = {
    proposalVersion: 2,
    proposalHash: "b".repeat(64),
    goalId: GOAL_ID,
    goalRevision: 1,
    todoGraphRevision: 0,
    bodyStored: false,
  } as unknown as RuntimeGoal["completionProposal"];
  const restoredMalformed = restoreRuntimeGoalFromBranch([{
    customType: GOAL_ENTRY_TYPE,
    data: { version: 2, kind: "set", source: "runtime", revision: 1, goal: malformedGoal, at: 1 },
  }]);
  assert.ok(restoredMalformed?.completionProposal && "malformed" in restoredMalformed.completionProposal);
  const malformedFreshness = evaluateRuntimeGoalCompletionProposalFreshness({
    goal: restoredMalformed,
    todoGraphRevision: 0,
    completionDiagnostics: { completionReady: true, effectiveNoShip: false },
  });
  assert.equal(malformedFreshness.status, "stale");
  assert.equal(malformedFreshness.code, "malformed_snapshot");
  assert.equal(restoredMalformed?.completionProposal?.noShip, true);
  assertProposalBodiesAbsent(restoredMalformed);
});

test("get_goal and get_goal_todos expose full binding/freshness metadata without mutation or proposal bodies", async () => {
  const { pi, entries, tools } = capturePi();
  const state = createHarnessRuntimeState();
  const goal = { ...createRuntimeGoal("pure proposal getters"), goalId: GOAL_ID };
  appendRuntimeGoalEntry(pi, state, setEntry(goal, "tool"));
  registerGoalRuntimeTools(pi, state);
  await callTool(tools, "propose_goal_completion", proposalParams);
  const proposalHash = state.runtimeGoal?.completionProposal?.proposalHash;
  assert.match(proposalHash ?? "", /^[a-f0-9]{64}$/);

  const before = JSON.stringify(state);
  const entryCount = entries.length;
  const goalResult = await callTool(tools, "get_goal");
  const todosResult = await callTool(tools, "get_goal_todos");

  assert.equal(JSON.stringify(state), before);
  assert.equal(entries.length, entryCount);
  for (const result of [goalResult, todosResult]) {
    assert.equal(result.details.proposalHash, proposalHash);
    assert.equal(result.details.freshnessCode, "fresh");
    assert.equal(result.details.safeReproposeAction, "propose_goal_completion");
    assert.ok(result.content[0]?.text.includes(proposalHash!));
    assertProposalBodiesAbsent(result);
  }
  const publicProposal = (goalResult.details.goal as { completionProposal: Record<string, unknown> }).completionProposal;
  assert.equal(publicProposal.goalRevision, 2);
  assert.equal(publicProposal.todoGraphRevision, 0);
  assert.equal(publicProposal.bodyStored, false);
});

test("freshness evaluator deterministically fails closed on restore and completion diagnostics", () => {
  const proposal = buildRuntimeGoalCompletionProposal({
    goalId: GOAL_ID,
    goalRevision: 1,
    todoGraphRevision: 0,
    completionSummary: RAW_SUMMARY,
    requirementsChecked: [],
    evidenceRefs: [],
    validationCommands: [],
    knownRisks: [],
    noShip: false,
  });
  const goal = { ...createRuntimeGoal("freshness diagnostics"), goalId: GOAL_ID, status: "ready_for_oracle" as const, revision: 1, completionProposal: proposal };
  const base = { goal, todoGraphRevision: 0, completionDiagnostics: { completionReady: true, effectiveNoShip: false } };
  assert.equal(evaluateRuntimeGoalCompletionProposalFreshness(base).code, "fresh");
  assert.equal(evaluateRuntimeGoalCompletionProposalFreshness({ ...base, todoRestoreBlocked: true }).code, "todo_restore_blocked");
  assert.equal(evaluateRuntimeGoalCompletionProposalFreshness({ ...base, completionDiagnostics: { completionReady: false, effectiveNoShip: true } }).code, "completion_diagnostics_no_ship");
  assert.equal(evaluateRuntimeGoalCompletionProposalFreshness({ ...base, completionDiagnostics: { completionReady: false, effectiveNoShip: false } }).code, "completion_diagnostics_not_ready");
});
