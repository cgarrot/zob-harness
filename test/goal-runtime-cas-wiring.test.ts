import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GOAL_MUTATION_PREPARATION_ENTRY_TYPE,
  GOAL_MUTATION_RECEIPT_ENTRY_TYPE,
  buildRuntimeGoalCompletionProposal,
  buildRuntimeGoalOracleBinding,
  createHarnessRuntimeState,
  restoreGoalTodosFromBranch,
} from "../.pi/extensions/zob-harness/index.ts";
import {
  appendRuntimeGoalEntry,
  createRuntimeGoal,
  restoreRuntimeGoalFromBranch,
  setEntry,
  type RuntimeGoal,
} from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts";
import { handleGoalCommand } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/commands.ts";
import { registerGoalRuntimeEvents } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/events.ts";
import { registerGoalRuntimeTools } from "../.pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts";

const GOAL_ENTRY_TYPE = "zob-runtime-goal";
const GOAL_ID = "goal-root-cas";
const STRUCTURED_CREATE_OBJECTIVE = [
  "ORIGINAL_USER_ASK: create a guarded root goal",
  "ACTIVE_GOAL: prove transactional root creation",
  "EXPECTED_OUTPUT: one persisted runtime goal",
  "CONSTRAINTS: append before publication",
  "VALIDATION_EVIDENCE: root lifecycle outage tests",
].join("\n");

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

type Capture = {
  pi: ExtensionAPI;
  entries: Entry[];
  tools: Map<string, CapturedTool>;
  handlers: Map<string, EventHandler>;
  sentMessages: unknown[];
};

type ScenarioBuild = Capture & {
  state: TestState;
  tool: CapturedTool;
  params: Record<string, unknown>;
  conflict: (params: Record<string, unknown>) => Record<string, unknown>;
  revision: number;
};

type Scenario = {
  name: string;
  toolName: string;
  setup: () => ScenarioBuild;
  requiresExactCas?: boolean;
};

function capturePi(): Capture {
  const entries: Entry[] = [];
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, EventHandler>();
  const sentMessages: unknown[] = [];
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
    sendMessage(message: unknown) {
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;
  return { pi, entries, tools, handlers, sentMessages };
}

function proposal() {
  return buildRuntimeGoalCompletionProposal({
    goalId: GOAL_ID,
    goalRevision: 1,
    todoGraphRevision: 0,
    completionSummary: "all bounded requirements are evidenced",
    requirementsChecked: ["root CAS requirement"],
    evidenceRefs: ["test/goal-runtime-cas-wiring.test.ts"],
    validationCommands: ["node --import tsx --test test/goal-runtime-cas-wiring.test.ts"],
    knownRisks: [],
    noShip: false,
    proposedAt: "2026-01-01T00:00:00.000Z",
  });
}

function persistedGoal(configure?: (goal: RuntimeGoal) => void): { capture: Capture; state: TestState } {
  const capture = capturePi();
  const state = createHarnessRuntimeState();
  const goal = { ...createRuntimeGoal("root CAS lifecycle"), goalId: GOAL_ID };
  configure?.(goal);
  appendRuntimeGoalEntry(capture.pi, state, setEntry(goal, "tool"));
  capture.entries.length = 0;
  return { capture, state };
}

function finishSetup(capture: Capture, state: TestState, toolName: string, params: Record<string, unknown>, conflict: ScenarioBuild["conflict"]): ScenarioBuild {
  registerGoalRuntimeTools(capture.pi, state);
  const tool = capture.tools.get(toolName);
  assert.ok(tool, `registered ${toolName}`);
  return {
    ...capture,
    state,
    tool,
    params,
    conflict,
    revision: state.runtimeGoal?.revision ?? 0,
  };
}

function createSetup(): ScenarioBuild {
  const capture = capturePi();
  const state = createHarnessRuntimeState();
  return finishSetup(capture, state, "create_goal", {
    objective: STRUCTURED_CREATE_OBJECTIVE,
    max_turns: 7,
  }, (params) => ({ ...params, objective: "conflicting root creation" }));
}

function resumeSetup(): ScenarioBuild {
  const { capture, state } = persistedGoal((goal) => {
    goal.status = "paused";
    goal.loop.enabled = false;
    goal.oracle.blockerSummary = "safe resume required";
  });
  return finishSetup(capture, state, "resume_goal", {
    goal_id: GOAL_ID,
    resume_reason: "validated safe resume",
    additional_turns: 3,
    queue_continuation: false,
  }, (params) => ({ ...params, resume_reason: "different resume effect" }));
}

function proposalSetup(): ScenarioBuild {
  const { capture, state } = persistedGoal();
  return finishSetup(capture, state, "propose_goal_completion", {
    goal_id: GOAL_ID,
    completion_summary: "all bounded requirements are evidenced",
    requirements_checked: ["root CAS requirement"],
    evidence_refs: ["test/goal-runtime-cas-wiring.test.ts"],
    validation_commands: ["node --import tsx --test test/goal-runtime-cas-wiring.test.ts"],
    known_risks: [],
    no_ship: false,
  }, (params) => ({ ...params, completion_summary: "different completion effect" }));
}

function oracleSetup(): ScenarioBuild {
  const completionProposal = proposal();
  const { capture, state } = persistedGoal((goal) => {
    goal.status = "ready_for_oracle";
    goal.loop.enabled = false;
    goal.oracle.status = "needed";
    goal.completionProposal = completionProposal;
  });
  return finishSetup(capture, state, "record_goal_oracle", {
    verdict: "PASS",
    no_ship: false,
    evidence_summary: "oracle verified the proposal",
    evidence_refs: ["test/goal-runtime-cas-wiring.test.ts"],
    expected_proposal_hash: completionProposal.proposalHash,
  }, (params) => ({ ...params, evidence_summary: "different oracle effect" }));
}

function updateSetup(): ScenarioBuild {
  const completionProposal = proposal();
  const oracle = buildRuntimeGoalOracleBinding({
    proposalHash: completionProposal.proposalHash,
    proposalGoalRevision: completionProposal.goalRevision,
    todoGraphRevision: completionProposal.todoGraphRevision,
    goalRevision: 1,
    verdict: "PASS",
    noShip: false,
    evidenceSummary: "oracle verified the proposal",
    evidenceRefs: ["test/goal-runtime-cas-wiring.test.ts"],
    reviewedAt: "2026-01-01T00:00:01.000Z",
  });
  const { capture, state } = persistedGoal((goal) => {
    goal.status = "ready_for_oracle";
    goal.loop.enabled = false;
    goal.completionProposal = completionProposal;
    goal.oracle = oracle;
  });
  return finishSetup(capture, state, "update_goal", {
    status: "complete",
    expected_proposal_hash: completionProposal.proposalHash,
    expected_oracle_decision_hash: oracle.oracleDecisionHash,
  }, (params) => ({ ...params, status: "not-complete" }));
}

function callTool(build: ScenarioBuild, params: Record<string, unknown>): Promise<ToolResult> {
  return build.tool.execute("call-root-cas", params, undefined, undefined, {
    cwd: process.cwd(),
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setStatus: () => undefined },
  });
}

function guard(mutationId: string, revision: number) {
  return { mutation_id: mutationId, expected_goal_revision: revision };
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

function jsonClone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function primeContinuationState(state: TestState): void {
  const continuationGoalId = state.runtimeGoal?.goalId ?? "pre-create-continuation";
  state.runtimeGoalContinuationQueuedFor = continuationGoalId;
  state.runtimeGoalContinuationScheduledFor = continuationGoalId;
  state.runtimeGoalContinuationCompactionFor = continuationGoalId;
  state.runtimeGoalContinuationTurnFor = continuationGoalId;
}

type ContinuationSnapshot = {
  queuedFor?: string;
  scheduledFor?: string;
  compactionFor?: string;
  turnFor?: string;
  sentMessages: number;
};

function continuationSnapshot(state: TestState, sentMessages: unknown[]): ContinuationSnapshot {
  return {
    queuedFor: state.runtimeGoalContinuationQueuedFor,
    scheduledFor: state.runtimeGoalContinuationScheduledFor,
    compactionFor: state.runtimeGoalContinuationCompactionFor,
    turnFor: state.runtimeGoalContinuationTurnFor,
    sentMessages: sentMessages.length,
  };
}

function assertSuccessfulContinuationEffect(build: ScenarioBuild, toolName: string, before: ContinuationSnapshot): void {
  if (toolName === "create_goal") {
    assert.equal(build.state.runtimeGoalContinuationQueuedFor, build.state.runtimeGoal?.goalId, "create queues only after the root append succeeds");
    assert.equal(build.sentMessages.length, before.sentMessages + 1);
    assert.deepEqual(build.state.activeGoal, build.state.runtimeGoal?.gate, "create publishes activeGoal only after the root append succeeds");
    return;
  }
  assert.deepEqual(continuationSnapshot(build.state, build.sentMessages), {
    queuedFor: undefined,
    scheduledFor: undefined,
    compactionFor: undefined,
    turnFor: undefined,
    sentMessages: before.sentMessages,
  }, `${toolName} clears continuation only after the root append succeeds`);
}

function installRuntimeGoalAppendOutage(build: ScenarioBuild): () => void {
  const mutablePi = build.pi as unknown as { appendEntry: (type: string, data: unknown) => void };
  const append = mutablePi.appendEntry.bind(mutablePi);
  let outage = true;
  mutablePi.appendEntry = (type, data) => {
    if (outage && type === GOAL_ENTRY_TYPE) throw new Error("simulated root append outage");
    append(type, data);
  };
  return () => {
    outage = false;
  };
}

function assertAbortedProtocol(build: ScenarioBuild, mutationId: string): void {
  assert.deepEqual(build.entries.map((entry) => [entry.type, (entry.data as { phase?: string }).phase]), [
    [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "prepared"],
    [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "aborted"],
  ]);
  assert.equal(build.entries.some((entry) => entry.type === GOAL_ENTRY_TYPE || entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE), false);
  const protocols = Object.values(build.state.goalTodos.mutationReceipts.protocolByGoal)
    .map((byMutation) => byMutation?.[mutationId])
    .filter((preparation) => preparation !== undefined);
  assert.equal(protocols.length, 1);
  assert.equal(protocols[0]?.phase, "aborted");
}

const scenarios: Scenario[] = [
  { name: "create", toolName: "create_goal", setup: createSetup },
  { name: "resume", toolName: "resume_goal", setup: resumeSetup },
  { name: "propose completion", toolName: "propose_goal_completion", setup: proposalSetup },
  { name: "record oracle", toolName: "record_goal_oracle", setup: oracleSetup, requiresExactCas: true },
  { name: "final complete update", toolName: "update_goal", setup: updateSetup, requiresExactCas: true },
];

const rootMutators = scenarios.map((scenario) => scenario.toolName);

test("root Goal lifecycle mutators expose CAS and oracle/completion require exact CAS", () => {
  const capture = capturePi();
  registerGoalRuntimeTools(capture.pi, createHarnessRuntimeState());
  for (const name of rootMutators) {
    const tool = capture.tools.get(name);
    assert.ok(tool, `registered ${name}`);
    assert.equal((tool.parameters.properties?.cas as { type?: string } | undefined)?.type, "object", `${name} cas schema`);
    const exact = name === "record_goal_oracle" || name === "update_goal";
    assert.equal(tool.parameters.required?.includes("cas") ?? false, exact, `${name} exact CAS requirement`);
  }
  assert.deepEqual((capture.tools.get("update_goal")?.parameters.properties?.status as { enum?: string[] }).enum, ["complete"]);
});

for (const scenario of scenarios) {
  test(`root lifecycle CAS apply/replay/conflict/stale and legacy compatibility: ${scenario.name}`, async () => {
    const legacy = scenario.setup();
    if (scenario.requiresExactCas) {
      await assert.rejects(() => callTool(legacy, legacy.params), /invalid (?:root Goal mutation guard|Goal mutation guard: expected an object)/);
      assert.equal(legacy.entries.length, 0);
      assert.equal(legacy.state.runtimeGoal?.revision, legacy.revision);
    } else {
      const legacyResult = await callTool(legacy, legacy.params);
      assert.equal(legacyResult.isError, undefined);
      assert.equal(legacyResult.details.cas, undefined);
      assert.equal(legacy.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE).length, 1);
      assert.equal(legacy.entries.filter((entry) => entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE).length, 0);
      assert.equal(legacy.state.runtimeGoal?.revision, legacy.revision + 1);
    }

    const build = scenario.setup();
    const mutationId = `root-${scenario.toolName}`;
    const guardedParams = { ...build.params, cas: guard(mutationId, build.revision) };
    const applied = await callTool(build, guardedParams);
    assert.equal(applied.isError, undefined);
    assert.equal(casRecord(applied).status, "applied");
    assert.equal(build.state.runtimeGoal?.revision, build.revision + 1);

    const phaseEntries = build.entries.filter((entry) => entry.type === GOAL_MUTATION_PREPARATION_ENTRY_TYPE);
    const rootEntries = build.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE);
    const receiptEntries = build.entries.filter((entry) => entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE);
    assert.equal(phaseEntries.length, 1);
    assert.equal((phaseEntries[0]?.data as { phase: string }).phase, "prepared");
    assert.equal(rootEntries.length, 1);
    assert.equal(receiptEntries.length, 1);
    assert.equal(build.entries[0]?.type, GOAL_MUTATION_PREPARATION_ENTRY_TYPE, "prepared precedes the root append");
    assert.equal(build.entries.at(-1)?.type, GOAL_MUTATION_RECEIPT_ENTRY_TYPE, "applied receipt follows the successful root append");
    const receipt = receiptEntries[0]?.data as Record<string, unknown>;
    assert.equal(receipt.phase, "applied");
    assert.equal(receipt.bodyStored, false);
    assert.equal(receipt.eventCount, 1);
    assert.equal(receipt.goalRevision, build.revision + 1);
    assert.equal(receipt.mutationId, mutationId);
    assert.equal("payload" in receipt, false);
    assert.equal(JSON.stringify(receipt).includes("evidence_summary"), false);

    const appliedGoalId = build.state.runtimeGoal?.goalId;
    assert.equal(receipt.goalId, appliedGoalId);
    await assertGuardedToolEndNoPersistence(build, guardedParams, applied);
    build.entries.length = 0;
    const stateAfterApply = JSON.stringify(build.state);
    const sendsAfterApply = build.sentMessages.length;

    const replayed = await callTool(build, guardedParams);
    assert.equal(replayed.isError, undefined);
    assert.equal(casRecord(replayed).status, "replayed");
    assert.equal(replayed.details.goalId, appliedGoalId, "replay returns the original persisted identity");
    assert.equal(build.entries.length, 0);
    assert.equal(JSON.stringify(build.state), stateAfterApply);
    assert.equal(build.sentMessages.length, sendsAfterApply, "replay does not repeat continuation side effects");
    await assertGuardedToolEndNoPersistence(build, guardedParams, replayed);

    const conflictParams = build.conflict(guardedParams);
    const conflicted = await callTool(build, conflictParams);
    assert.equal(conflicted.isError, true);
    assert.equal(casRecord(conflicted).status, "conflict");
    assert.deepEqual(casRecord(conflicted).failureCodes, ["mutation_id_conflict"]);
    assert.equal(build.entries.length, 0);
    assert.equal(JSON.stringify(build.state), stateAfterApply);
    await assertGuardedToolEndNoPersistence(build, conflictParams, conflicted);

    const staleBuild = scenario.setup();
    const staleParams = { ...staleBuild.params, cas: guard(`${mutationId}-stale`, staleBuild.revision + 1) };
    const stale = await callTool(staleBuild, staleParams);
    assert.equal(stale.isError, true);
    assert.equal(casRecord(stale).status, "stale");
    assert.deepEqual(casRecord(stale).failureCodes, ["stale_goal_revision"]);
    assert.equal(staleBuild.entries.length, 0);
    assert.equal(staleBuild.state.runtimeGoal?.revision ?? 0, staleBuild.revision);
    await assertGuardedToolEndNoPersistence(staleBuild, staleParams, stale);
  });
}

for (const scenario of scenarios) {
  test(`root append outage is transactional and exact guarded retry applies once: ${scenario.name}`, async () => {
    const build = scenario.setup();
    primeContinuationState(build.state);
    const originalGoal = build.state.runtimeGoal;
    const goalBefore = jsonClone(originalGoal);
    const goalBytesBefore = JSON.stringify(originalGoal);
    const activeGoalBefore = jsonClone(build.state.activeGoal);
    const activeGoalBytesBefore = JSON.stringify(build.state.activeGoal);
    const continuationBefore = continuationSnapshot(build.state, build.sentMessages);
    const mutationId = `root-append-outage-${scenario.toolName}`;
    const params = { ...build.params, cas: guard(mutationId, build.revision) };
    const endOutage = installRuntimeGoalAppendOutage(build);

    await assert.rejects(() => callTool(build, params), /simulated root append outage/);

    assert.equal(build.state.runtimeGoal, originalGoal, "failed append preserves the original live Goal identity");
    assert.deepEqual(build.state.runtimeGoal, goalBefore);
    assert.equal(JSON.stringify(build.state.runtimeGoal), goalBytesBefore, "failed append preserves byte-identical live Goal data");
    assert.deepEqual(build.state.activeGoal, activeGoalBefore);
    assert.equal(JSON.stringify(build.state.activeGoal), activeGoalBytesBefore, "failed append does not publish activeGoal");
    assert.deepEqual(continuationSnapshot(build.state, build.sentMessages), continuationBefore, "failed append has no continuation effect");
    assertAbortedProtocol(build, mutationId);

    endOutage();
    const retried = await callTool(build, params);
    assert.equal(casRecord(retried).status, "applied");
    assert.equal(build.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE).length, 1, "exact retry appends the root event once");
    assert.equal(build.entries.filter((entry) => entry.type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE).length, 1);
    assert.equal(build.state.runtimeGoal?.revision, build.revision + 1);
    if (scenario.requiresExactCas) {
      assert.equal((retried.details.goal as { goalId: string }).goalId, build.state.runtimeGoal?.goalId, "body-free details identify the published Goal");
      assert.equal(JSON.stringify(retried.details.goal).includes("evidenceRefs"), false, "exact oracle/completion details omit raw evidence arrays");
    } else {
      assert.equal(retried.details.goal, build.state.runtimeGoal, "returned details reference the published persisted Goal");
    }
    assertSuccessfulContinuationEffect(build, scenario.toolName, continuationBefore);
  });

  test(`legacy root append outage preserves live state and exact retry applies once: ${scenario.name}`, async () => {
    const build = scenario.setup();
    if (scenario.requiresExactCas) {
      await assert.rejects(() => callTool(build, build.params), /invalid (?:root Goal mutation guard|Goal mutation guard: expected an object)/);
      assert.equal(build.entries.length, 0);
      return;
    }
    primeContinuationState(build.state);
    const originalGoal = build.state.runtimeGoal;
    const goalBefore = jsonClone(originalGoal);
    const goalBytesBefore = JSON.stringify(originalGoal);
    const activeGoalBefore = jsonClone(build.state.activeGoal);
    const activeGoalBytesBefore = JSON.stringify(build.state.activeGoal);
    const continuationBefore = continuationSnapshot(build.state, build.sentMessages);
    const endOutage = installRuntimeGoalAppendOutage(build);

    await assert.rejects(() => callTool(build, build.params), /simulated root append outage/);

    assert.equal(build.state.runtimeGoal, originalGoal, "legacy failed append preserves the original live Goal identity");
    assert.deepEqual(build.state.runtimeGoal, goalBefore);
    assert.equal(JSON.stringify(build.state.runtimeGoal), goalBytesBefore, "legacy failed append preserves byte-identical live Goal data");
    assert.deepEqual(build.state.activeGoal, activeGoalBefore);
    assert.equal(JSON.stringify(build.state.activeGoal), activeGoalBytesBefore, "legacy failed append does not publish activeGoal");
    assert.deepEqual(continuationSnapshot(build.state, build.sentMessages), continuationBefore, "legacy failed append has no continuation effect");
    assert.equal(build.entries.length, 0, "legacy append failure writes no CAS or root event");

    endOutage();
    const retried = await callTool(build, build.params);
    assert.equal(retried.isError, undefined);
    assert.equal(build.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE).length, 1, "legacy exact retry appends the root event once");
    assert.equal(build.state.runtimeGoal?.revision, build.revision + 1);
    assert.equal(retried.details.goal, build.state.runtimeGoal, "legacy details reference the published persisted Goal");
    assertSuccessfulContinuationEffect(build, scenario.toolName, continuationBefore);
  });
}

test("legacy slash-command oracle path is body-free, zero-effect, and directs callers to exact tool CAS", async () => {
  const build = oracleSetup();
  const before = JSON.stringify(build.state);
  const notices: string[] = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { notify: (message: string) => notices.push(message), setStatus: () => undefined },
  } as never;

  await handleGoalCommand(build.pi, build.state, "oracle PASS command evidence", ctx, () => undefined);
  assert.equal(JSON.stringify(build.state), before);
  assert.equal(build.entries.length, 0);
  assert.match(notices.join("\n"), /record_goal_oracle.*expected_proposal_hash.*expected_goal_revision/);
});

test("guarded create requires expected_goal_revision=0 and does not mint or persist an identity on stale/rejected attempts", async () => {
  const missing = createSetup();
  const missingResult = await callTool(missing, { ...missing.params, cas: { mutation_id: "create-missing-revision" } });
  assert.equal(missingResult.isError, true);
  assert.deepEqual(casRecord(missingResult).failureCodes, ["invalid_revision_guard"]);
  assert.equal(missing.state.runtimeGoal, undefined);
  assert.equal(missing.entries.length, 0);

  const stale = createSetup();
  const staleResult = await callTool(stale, { ...stale.params, cas: guard("create-stale-revision", 1) });
  assert.equal(casRecord(staleResult).status, "stale");
  assert.equal(stale.state.runtimeGoal, undefined);
  assert.equal(stale.entries.length, 0);
});

test("guarded create replays its persisted identity after branch restore without regenerating or appending", async () => {
  const original = createSetup();
  const guardedParams = { ...original.params, cas: guard("create-restore-replay", 0) };
  const applied = await callTool(original, guardedParams);
  assert.equal(casRecord(applied).status, "applied");
  const originalGoalId = original.state.runtimeGoal?.goalId;
  const branch = original.entries.map((entry) => ({ customType: entry.type, data: entry.data }));

  const capture = capturePi();
  const restoredState = createHarnessRuntimeState();
  restoredState.runtimeGoal = restoreRuntimeGoalFromBranch(branch);
  restoredState.goalTodos = restoreGoalTodosFromBranch(branch);
  const restored = finishSetup(capture, restoredState, "create_goal", original.params, (params) => params);
  const replayed = await callTool(restored, guardedParams);

  assert.equal(casRecord(replayed).status, "replayed");
  assert.equal(replayed.details.goalId, originalGoalId);
  assert.equal(restored.state.runtimeGoal?.goalId, originalGoalId);
  assert.equal(restored.entries.length, 0);
  assert.equal(restored.sentMessages.length, 0);
});

test("create receipt outage then restart preserves prepared identity and blocks duplicate root creation", async () => {
  const original = createSetup();
  const mutablePi = original.pi as unknown as { appendEntry: (type: string, data: unknown) => void };
  const append = mutablePi.appendEntry.bind(mutablePi);
  mutablePi.appendEntry = (type, data) => {
    if (type === GOAL_MUTATION_RECEIPT_ENTRY_TYPE) throw new Error("simulated root receipt outage");
    append(type, data);
  };
  const params = { ...original.params, cas: guard("create-restart-outage", 0) };
  const failed = await callTool(original, params);
  assert.equal(failed.isError, true);
  assert.deepEqual(casRecord(failed).failureCodes, ["receipt_persistence_failed"]);
  const createdGoalId = original.state.runtimeGoal?.goalId;
  assert.ok(createdGoalId);
  assert.deepEqual(original.entries.map((entry) => entry.type), [GOAL_MUTATION_PREPARATION_ENTRY_TYPE, GOAL_ENTRY_TYPE]);

  const branch = original.entries.map((entry) => ({ customType: entry.type, data: entry.data }));
  const restartedCapture = capturePi();
  const restartedState = createHarnessRuntimeState();
  restartedState.runtimeGoal = restoreRuntimeGoalFromBranch(branch);
  restartedState.goalTodos = restoreGoalTodosFromBranch(branch);
  const restarted = finishSetup(restartedCapture, restartedState, "create_goal", original.params, (value) => value);
  assert.equal(restarted.state.runtimeGoal?.goalId, createdGoalId);
  assert.equal(restarted.state.goalTodos.mutationReceipts.inDoubtByGoal[createdGoalId]?.["create-restart-outage"]?.phase, "prepared");

  const retry = await callTool(restarted, params);
  assert.equal(retry.isError, true);
  assert.deepEqual(casRecord(retry).failureCodes, ["mutation_in_doubt"]);
  assert.equal(restarted.entries.length, 0);
  assert.equal(restarted.state.runtimeGoal?.goalId, createdGoalId);
  assert.equal(restarted.state.runtimeGoal?.revision, 1);
});

test("guarded preflight/restore failures do not prepare while rejecting callbacks append prepared/aborted only", async () => {
  const activeCreate = persistedGoal();
  const createBuild = finishSetup(activeCreate.capture, activeCreate.state, "create_goal", { objective: "must be excluded" }, (params) => params);
  const createBefore = JSON.stringify(createBuild.state);
  await assert.rejects(() => callTool(createBuild, { ...createBuild.params, cas: guard("active-create", 0) }), /non-complete ZOB runtime goal already exists/);
  assert.equal(createBuild.entries.length, 0);
  assert.equal(JSON.stringify(createBuild.state), createBefore);

  const unsafeResumeBase = persistedGoal();
  const unsafeResume = finishSetup(unsafeResumeBase.capture, unsafeResumeBase.state, "resume_goal", { goal_id: GOAL_ID, resume_reason: "unsafe" }, (params) => params);
  const resumeBefore = JSON.stringify(unsafeResume.state.runtimeGoal);
  await assert.rejects(() => callTool(unsafeResume, { ...unsafeResume.params, cas: guard("unsafe-resume", unsafeResume.revision) }), /Only paused, blocked, or oracle_failed goals can be resumed/);
  assertAbortedProtocol(unsafeResume, "unsafe-resume");
  assert.equal(JSON.stringify(unsafeResume.state.runtimeGoal), resumeBefore);

  const blockedProposal = proposalSetup();
  const proposalBefore = JSON.stringify(blockedProposal.state.runtimeGoal);
  await assert.rejects(() => callTool(blockedProposal, { ...blockedProposal.params, no_ship: true, cas: guard("no-ship-proposal", blockedProposal.revision) }), /Cannot propose goal completion/);
  assertAbortedProtocol(blockedProposal, "no-ship-proposal");
  assert.equal(JSON.stringify(blockedProposal.state.runtimeGoal), proposalBefore);

  const missingProposalBase = persistedGoal();
  const missingProposal = finishSetup(missingProposalBase.capture, missingProposalBase.state, "update_goal", {
    status: "complete",
    expected_proposal_hash: "a".repeat(64),
    expected_oracle_decision_hash: "b".repeat(64),
  }, (params) => params);
  const updateBefore = JSON.stringify(missingProposal.state.runtimeGoal);
  await assert.rejects(() => callTool(missingProposal, { ...missingProposal.params, cas: guard("missing-proposal", missingProposal.revision) }), /code=GOAL_NOT_READY_FOR_COMPLETION/);
  assert.equal(missingProposal.entries.length, 0, "exact binding preflight rejection is zero-effect");
  assert.equal(JSON.stringify(missingProposal.state.runtimeGoal), updateBefore);

  const oracleBlocked = updateSetup();
  oracleBlocked.state.runtimeGoal!.oracle.noShip = true;
  const oracleBefore = JSON.stringify(oracleBlocked.state.runtimeGoal);
  await assert.rejects(() => callTool(oracleBlocked, { ...oracleBlocked.params, cas: guard("oracle-no-ship", oracleBlocked.revision) }), /code=ORACLE_BINDING_MALFORMED/);
  assert.equal(oracleBlocked.entries.length, 0, "mutated oracle binding rejection is zero-effect");
  assert.equal(JSON.stringify(oracleBlocked.state.runtimeGoal), oracleBefore);

  const alreadyComplete = updateSetup();
  alreadyComplete.state.runtimeGoal!.status = "complete";
  const completeBefore = JSON.stringify(alreadyComplete.state.runtimeGoal);
  await assert.rejects(() => callTool(alreadyComplete, { ...alreadyComplete.params, cas: guard("already-complete", alreadyComplete.revision) }), /code=GOAL_ALREADY_COMPLETE/);
  assert.equal(alreadyComplete.entries.length, 0, "new completion mutation against complete Goal is zero-effect");
  assert.equal(JSON.stringify(alreadyComplete.state.runtimeGoal), completeBefore);

  const restoreBlocked = resumeSetup();
  restoreBlocked.state.runtimeGoal!.restoreBlocked![GOAL_ID] = {
    code: "goal_revision_gap",
    goalId: GOAL_ID,
    eventKind: "set",
    at: 1,
    expectedRevision: restoreBlocked.revision + 1,
    receivedRevision: restoreBlocked.revision + 2,
    message: "test root restore block",
  };
  const restoreBefore = JSON.stringify(restoreBlocked.state);
  const blockedResult = await callTool(restoreBlocked, { ...restoreBlocked.params, cas: guard("restore-blocked-root", restoreBlocked.revision) });
  assert.equal(blockedResult.isError, true);
  assert.deepEqual(casRecord(blockedResult).failureCodes, ["state_restore_blocked"]);
  assert.equal(restoreBlocked.entries.length, 0);
  assert.equal(JSON.stringify(restoreBlocked.state), restoreBefore);
});

test("tool_execution_end suppresses generic root persistence only for guarded root calls", async () => {
  const guarded = resumeSetup();
  registerGoalRuntimeEvents(guarded.pi, guarded.state, () => undefined);
  const guardedParams = { ...guarded.params, cas: guard("event-guarded-resume", guarded.revision) };
  const applied = await callTool(guarded, guardedParams);
  assert.equal(casRecord(applied).status, "applied");
  guarded.entries.length = 0;
  const guardedBefore = JSON.stringify(guarded.state);
  const handler = guarded.handlers.get("tool_execution_end");
  assert.ok(handler);
  await handler({ toolName: "resume_goal", args: guardedParams, result: applied }, { ui: { setStatus: () => undefined } });
  assert.equal(guarded.entries.length, 0);
  assert.equal(JSON.stringify(guarded.state), guardedBefore);

  const legacy = resumeSetup();
  registerGoalRuntimeEvents(legacy.pi, legacy.state, () => undefined);
  const legacyResult = await callTool(legacy, legacy.params);
  legacy.entries.length = 0;
  const legacyRevision = legacy.state.runtimeGoal!.revision;
  const legacyHandler = legacy.handlers.get("tool_execution_end");
  assert.ok(legacyHandler);
  await legacyHandler({ toolName: "resume_goal", args: legacy.params, result: legacyResult }, { ui: { setStatus: () => undefined } });
  assert.equal(legacy.entries.filter((entry) => entry.type === GOAL_ENTRY_TYPE).length, 1);
  assert.equal(legacy.state.runtimeGoal?.revision, legacyRevision + 1);
});
