import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DeterministicFakeWheelDispatchAdapter,
  DeterministicFakeWheelStoryEffectBroker,
  DisabledWheelDispatchAdapter,
  DisabledWheelStoryEffectBroker,
  FileWheelSupervisorStore,
  WheelFleetSupervisor,
  admitWheelSupervisorMission,
  buildWheelAttemptAndRequest,
  buildWheelStoryEffectRequest,
  createDisabledWheelSupervisorAuthority,
  sha256Canonical,
  validateWheelSupervisorPersistedState,
  validateWheelPrCloseEvidence,
  validateWheelPrCloseTerminal,
} from "../../packages/wheel-zob-pack/index.js";
import { supervisorAdmissionInput, supervisorStory } from "./supervisor-fixtures.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wheel-supervisor-controller-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.parse("2026-07-19T12:00:00.000Z") + tick++ * 1_000);
}

test("runs one fake story through workspace, routed loops, CI, and exact PR-close evidence", async () => withRoot(async (root) => {
  const input = supervisorAdmissionInput([supervisorStory("S-001")]);
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const dispatch = new DeterministicFakeWheelDispatchAdapter();
  const effects = new DeterministicFakeWheelStoryEffectBroker();
  const supervisor = new WheelFleetSupervisor(store, input.authority, { dispatch, effects }, fixedClock());
  const result = await supervisor.runUntilSettled(100);
  const state = supervisor.load();
  const story = state.stories["S-001"];

  assert.equal(result.status, "complete");
  assert.equal(state.status, "complete");
  assert.equal(story?.stage, "needs-review");
  assert.equal(story?.pullRequest?.isDraft, true);
  assert.equal(story?.pullRequest?.baseRef, "develop-staging");
  assert.equal(story?.pullRequest?.labels.includes("needs-review"), true);
  assert.equal(story?.pullRequest?.checkIds.length, 2);
  assert.equal(story?.prCloseEvidence?.auditResults.length, 3);
  assert.equal(new Set(story?.prCloseEvidence?.auditResults.map((audit) => audit.assignmentId)).size, 3);
  assert.equal(new Set(story?.prCloseEvidence?.auditResults.map((audit) => audit.attemptId)).size, 3);
  assert.deepEqual(validateWheelPrCloseEvidence(story?.prCloseEvidence!, state, story!), []);
  assert.deepEqual(validateWheelPrCloseTerminal(state, story!), []);
  const tampered = structuredClone(story!);
  const closeCheck = tampered.externalSnapshot?.checks.find((check) => check.name === state.checkPolicy.prCloseCheck.name);
  if (closeCheck) closeCheck.issuerHash = "e".repeat(64);
  assert.equal(validateWheelPrCloseTerminal(state, tampered).some((issue) => issue.includes("PR-close check")), true);
  assert.equal(state.budgetLedger.settledCostUsd, 0);
  assert.equal(result.externalEffectsPerformed, false);
  assert.equal(result.providerCallsPerformed, false);
  const dispatchedRoles = new Set(dispatch.recordedRequests.map((request) => request.role));
  assert.equal(dispatch.recordedRequests.length >= 8, true);
  assert.equal(dispatchedRoles.has("development"), true);
  assert.equal(dispatchedRoles.has("qa"), true);
  assert.equal(dispatchedRoles.has("internal-review"), true);
  assert.equal(dispatchedRoles.has("formal-blind-review"), true);
  assert.equal(dispatchedRoles.has("repository-assurance"), true);
  assert.equal(dispatchedRoles.has("pr-close-source-audit"), true);
  assert.equal(dispatchedRoles.has("pr-close-evidence-audit"), true);
  assert.equal(dispatchedRoles.has("pr-close"), true);
  assert.equal(dispatch.recordedRequests.every((request) => request.bodyStored === false), true);
  assert.equal(readFileSync(store.journalPath, "utf8").includes("WHEEL_ZOB_SUPERVISOR_TASK"), false);
}));

test("escalates model quality, repairs a QA rejection, and reruns evidence on the new head", async () => withRoot(async (root) => {
  const input = supervisorAdmissionInput([supervisorStory("S-REPAIR")]);
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const dispatch = new DeterministicFakeWheelDispatchAdapter([
    { storyId: "S-REPAIR", role: "development", attemptOrdinal: 1, candidateIndex: 0, qualityRung: "low", outcome: "model-quality" },
    { storyId: "S-REPAIR", role: "qa", attemptOrdinal: 1, outcome: "validation" },
  ]);
  const supervisor = new WheelFleetSupervisor(
    store,
    input.authority,
    { dispatch, effects: new DeterministicFakeWheelStoryEffectBroker() },
    fixedClock(),
  );
  const result = await supervisor.runUntilSettled(150);
  const story = supervisor.load().stories["S-REPAIR"]!;
  const development = story.attempts.filter((attempt) => attempt.role === "development");
  const qa = story.attempts.filter((attempt) => attempt.role === "qa");
  assert.equal(result.status, "complete");
  assert.equal(development[0]?.qualityRung, "low");
  assert.equal(development[0]?.status, "rejected");
  assert.equal(development[1]?.qualityRung, "high");
  assert.equal(development[1]?.status, "accepted");
  assert.equal(story.repairRound, 1);
  assert.equal(qa.length, 2);
  assert.equal(qa[0]?.status, "rejected");
  assert.equal(qa[1]?.status, "accepted");
  assert.equal(story.evidence.some((evidence) => evidence.status === "stale"), true);
  assert.equal(story.evidence.filter((evidence) => evidence.status === "current").every((evidence) => evidence.headSha === story.workspace?.headSha), true);
}));

test("fails closed at the bounded attempt ceiling", async () => withRoot(async (root) => {
  const input = supervisorAdmissionInput([supervisorStory("S-EXHAUST")]);
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const dispatch = new DeterministicFakeWheelDispatchAdapter([
    { storyId: "S-EXHAUST", role: "development", candidateIndex: 0, qualityRung: "low", outcome: "model-quality" },
    { storyId: "S-EXHAUST", role: "development", candidateIndex: 0, qualityRung: "high", outcome: "model-quality" },
    { storyId: "S-EXHAUST", role: "development", candidateIndex: 1, qualityRung: "low", outcome: "model-quality" },
  ]);
  const supervisor = new WheelFleetSupervisor(
    store,
    input.authority,
    { dispatch, effects: new DeterministicFakeWheelStoryEffectBroker() },
    fixedClock(),
  );
  const result = await supervisor.runUntilSettled(100);
  const story = supervisor.load().stories["S-EXHAUST"]!;
  assert.equal(result.status, "needs-human");
  assert.equal(story.stage, "needs-human");
  assert.equal(story.attempts.filter((attempt) => attempt.role === "development").length, 3);
  assert.deepEqual(story.blockerCodes, ["development-attempt-budget-exhausted"]);
}));

test("requires an explicit hash receipt before resuming a human-gated story", async () => withRoot(async (root) => {
  const story = supervisorStory("S-GATED");
  story.humanGateRefs = ["docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md"];
  const input = supervisorAdmissionInput([story]);
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const supervisor = new WheelFleetSupervisor(
    store,
    input.authority,
    { dispatch: new DeterministicFakeWheelDispatchAdapter(), effects: new DeterministicFakeWheelStoryEffectBroker() },
    fixedClock(),
  );
  const blocked = await supervisor.runUntilSettled(10);
  assert.equal(blocked.status, "needs-human");
  assert.throws(() => supervisor.resolveHumanGate("S-GATED", "short"), /full sha256/);
  supervisor.resolveHumanGate("S-GATED", "d".repeat(64));
  const completed = await supervisor.runUntilSettled(100);
  assert.equal(completed.status, "complete");
  assert.equal(supervisor.load().stories["S-GATED"]?.stage, "needs-review");
  assert.deepEqual(supervisor.load().noShipReasons, []);
}));

test("recomputes dependency blockers after a human-gated prerequisite resolves", async () => withRoot(async (root) => {
  const gated = supervisorStory("S-GATED-ROOT");
  gated.humanGateRefs = ["docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md"];
  const dependent = supervisorStory("S-DEPENDENT", [{ storyId: gated.storyId, type: "hard" }]);
  const input = supervisorAdmissionInput([gated, dependent]);
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const supervisor = new WheelFleetSupervisor(
    store,
    input.authority,
    { dispatch: new DeterministicFakeWheelDispatchAdapter(), effects: new DeterministicFakeWheelStoryEffectBroker() },
    fixedClock(),
  );

  const blocked = await supervisor.runUntilSettled(50);
  assert.equal(blocked.status, "needs-human");
  assert.deepEqual(supervisor.load().noShipReasons, [
    "story:S-GATED-ROOT:needs-human",
    "story:S-DEPENDENT:dependency-blocked",
  ]);

  const resumed = supervisor.resolveHumanGate("S-GATED-ROOT", "e".repeat(64));
  assert.equal(resumed.status, "running");
  assert.deepEqual(resumed.noShipReasons, []);
  const completed = await supervisor.runUntilSettled(200);
  const finalState = supervisor.load();
  assert.equal(completed.status, "complete");
  assert.equal(finalState.stories["S-GATED-ROOT"]?.stage, "needs-review");
  assert.equal(finalState.stories["S-DEPENDENT"]?.stage, "needs-review");
  assert.deepEqual(finalState.noShipReasons, []);
  assert.equal(new Set(Object.values(finalState.stories).flatMap((story) => story.attempts.map((attempt) => attempt.attemptId))).size,
    Object.values(finalState.stories).reduce((count, story) => count + story.attempts.length, 0));
  assert.equal(validateWheelSupervisorPersistedState(store).valid, true);
}));

test("rejects a completed projection that retains a current no-ship reason", async () => withRoot(async (root) => {
  const input = supervisorAdmissionInput([supervisorStory("S-INVALID-COMPLETE")]);
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const supervisor = new WheelFleetSupervisor(
    store,
    input.authority,
    { dispatch: new DeterministicFakeWheelDispatchAdapter(), effects: new DeterministicFakeWheelStoryEffectBroker() },
    fixedClock(),
  );
  await supervisor.runUntilSettled(100);
  const inconsistent = supervisor.load();
  inconsistent.noShipReasons = ["story:S-INVALID-COMPLETE:dependency-blocked"];
  store.writeCheckpoint(inconsistent, "2026-07-19T13:00:00.000Z");

  const validation = validateWheelSupervisorPersistedState(new FileWheelSupervisorStore(root));
  assert.equal(validation.valid, false);
  assert.equal(validation.issueCodes.includes("complete-status-with-no-ship-reasons"), true);
}));

test("disabled authority admits durably but performs no scheduling, dispatch, or effects", async () => withRoot(async (root) => {
  const authority = createDisabledWheelSupervisorAuthority();
  const input = supervisorAdmissionInput([supervisorStory("S-001")], { authority });
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const supervisor = new WheelFleetSupervisor(
    store,
    authority,
    { dispatch: new DisabledWheelDispatchAdapter(), effects: new DisabledWheelStoryEffectBroker() },
    fixedClock(),
  );
  const before = supervisor.load();
  const result = await supervisor.tick();
  const after = supervisor.load();
  assert.equal(result.progressedStoryIds.length, 0);
  assert.equal(after.journalSequence, before.journalSequence);
  assert.equal(after.stories["S-001"]?.attempts.length, 0);
  assert.equal(after.status, "admitted");
}));

test("replays the same deterministic effect request after a broker-process crash", async () => withRoot(async (root) => {
  const input = supervisorAdmissionInput([supervisorStory("S-EFFECT-RESTART")]);
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const firstEffects = new DeterministicFakeWheelStoryEffectBroker();
  const first = new WheelFleetSupervisor(
    store,
    input.authority,
    { dispatch: new DeterministicFakeWheelDispatchAdapter(), effects: firstEffects },
    fixedClock(),
  );
  while (first.load().stories["S-EFFECT-RESTART"]?.stage !== "workspace-provisioning") await first.tick();
  const state = first.load();
  const story = state.stories["S-EFFECT-RESTART"]!;
  const kind = "create-workspace" as const;
  const metadata = {};
  const request = buildWheelStoryEffectRequest({
    state,
    story,
    kind,
    mutationKey: `${story.stageRevision}-${sha256Canonical({ kind, metadata, payloadHash: undefined }).slice(0, 12)}`,
    metadata,
  });
  store.commit({
    mutationId: "manual-effect-request-before-crash",
    kind: "effect-requested",
    storyId: story.storyId,
    payload: { requestId: request.requestId },
    occurredAt: "2026-07-19T12:10:00.000Z",
    ownershipEpoch: state.ownershipEpoch,
  });
  const beforeCrash = await firstEffects.submit(request, input.authority);
  assert.equal(beforeCrash.status, "simulated");

  const restartedEffects = new DeterministicFakeWheelStoryEffectBroker();
  const restarted = new WheelFleetSupervisor(
    new FileWheelSupervisorStore(root),
    input.authority,
    { dispatch: new DeterministicFakeWheelDispatchAdapter(), effects: restartedEffects },
    fixedClock(),
  );
  await restarted.tick();
  const recovered = restarted.load();
  const requestedEvents = restarted.store.loadEvents().filter((event) =>
    event.kind === "effect-requested" && event.payload.requestId === request.requestId);
  assert.equal(recovered.stories[story.storyId]?.stage, "workspace-ready");
  assert.equal(recovered.pendingEffectRequestIds.length, 0);
  assert.equal(requestedEvents.length, 2);
}));

test("recovers a reserved fake attempt after controller restart without allocating a duplicate", async () => withRoot(async (root) => {
  const input = supervisorAdmissionInput([supervisorStory("S-001")]);
  const store = new FileWheelSupervisorStore(root);
  admitWheelSupervisorMission(store, input);
  const first = new WheelFleetSupervisor(
    store,
    input.authority,
    { dispatch: new DeterministicFakeWheelDispatchAdapter(), effects: new DeterministicFakeWheelStoryEffectBroker() },
    fixedClock(),
  );
  while (first.load().stories["S-001"]?.stage !== "development") await first.tick();
  const state = first.load();
  const story = state.stories["S-001"]!;
  const { attempt } = buildWheelAttemptAndRequest({
    state,
    story,
    role: "development",
    candidateIndex: 0,
    qualityRung: "low",
    now: "2026-07-19T12:10:00.000Z",
  });
  store.commit({
    mutationId: "manual-reserved-attempt",
    kind: "attempt-reserved",
    storyId: story.storyId,
    payload: { attempt },
    occurredAt: "2026-07-19T12:10:00.000Z",
    ownershipEpoch: state.ownershipEpoch,
  });

  const restartedDispatch = new DeterministicFakeWheelDispatchAdapter();
  const restarted = new WheelFleetSupervisor(
    new FileWheelSupervisorStore(root),
    input.authority,
    { dispatch: restartedDispatch, effects: new DeterministicFakeWheelStoryEffectBroker() },
    fixedClock(),
  );
  const result = await restarted.runUntilSettled(100);
  const attempts = restarted.load().stories["S-001"]?.attempts.filter((item) => item.role === "development") ?? [];
  assert.equal(result.status, "complete");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.attemptId, attempt.attemptId);
  assert.equal(restartedDispatch.recordedRequests[0]?.attemptId, attempt.attemptId);
}));
