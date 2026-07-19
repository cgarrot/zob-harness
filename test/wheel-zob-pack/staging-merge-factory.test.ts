import assert from "node:assert/strict";
import test from "node:test";

import {
  createStagingMergeFactoryState,
  transitionStagingMergeFactory,
  type StagingMergeFactoryStage,
} from "../../packages/wheel-zob-pack/factories/staging-merge/factory.js";

function advance(
  state: ReturnType<typeof createStagingMergeFactoryState>,
  transitions: ReadonlyArray<readonly [StagingMergeFactoryStage, string]>,
) {
  for (const [to, event] of transitions) {
    const result = transitionStagingMergeFactory(state, { to, event });
    assert.equal(result.applied, true, result.reason);
    state = result.state;
  }
  return state;
}

test("staging merge factory is disabled by default", () => {
  const state = createStagingMergeFactoryState({ missionId: "mission-disabled", pullRequestId: "PR-101" });
  const result = transitionStagingMergeFactory(state, { to: "gate-evaluation", event: "candidate-queued" });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "factory_disabled");
  assert.deepEqual(result.state.effects, {
    githubWrites: false,
    merge: false,
    workflowDispatch: false,
    deployment: false,
    providerActivation: false,
  });
  assert.equal(result.state.activationEnabled, false);
  assert.equal(result.state.bodyStored, false);
});

test("successful staging merge simulation completes without external effects", () => {
  let state = createStagingMergeFactoryState({ missionId: "mission-success", pullRequestId: "PR-102", simulation: true });
  state = advance(state, [
    ["gate-evaluation", "candidate-queued"],
    ["ready", "all-gates-pass"],
    ["merge-simulation", "expected-head-squash-simulated"],
    ["integration-verification", "push-ci-observed"],
    ["complete", "integration-green"],
  ]);

  assert.equal(state.stage, "complete");
  assert.equal(state.outcome, "pass");
  assert.equal(state.effects.githubWrites, false);
  assert.equal(state.effects.merge, false);
  assert.equal(state.effects.workflowDispatch, false);
  assert.equal(state.effects.deployment, false);
  assert.equal(state.effects.providerActivation, false);
  assert.equal(state.activationEnabled, false);
});

test("one-at-a-time and red integration interlocks reject unrelated merge simulation", () => {
  let state = createStagingMergeFactoryState({ missionId: "mission-interlock", pullRequestId: "PR-103", simulation: true });
  state = advance(state, [
    ["gate-evaluation", "candidate-queued"],
    ["ready", "all-gates-pass"],
  ]);

  const busy = transitionStagingMergeFactory(state, {
    to: "merge-simulation",
    event: "merge-attempt",
    mergeInFlight: true,
  });
  assert.equal(busy.applied, false);
  assert.equal(busy.reason, "merge_in_flight");
  assert.equal(busy.state.revision, state.revision);

  const red = transitionStagingMergeFactory(state, {
    to: "merge-simulation",
    event: "unrelated-merge-attempt",
    redIntegrationInterlock: true,
  });
  assert.equal(red.applied, false);
  assert.equal(red.reason, "red_integration_interlock");
  assert.equal(red.state.stage, "ready");
});

test("failure-bound repair returns through gate evaluation", () => {
  let state = createStagingMergeFactoryState({ missionId: "mission-repair", pullRequestId: "PR-104", simulation: true });
  state = advance(state, [
    ["gate-evaluation", "candidate-queued"],
    ["ready", "all-gates-pass"],
    ["merge-simulation", "expected-head-squash-simulated"],
    ["integration-verification", "push-ci-observed"],
    ["repair-blocked", "integration-red"],
  ]);

  const unrelated = transitionStagingMergeFactory(state, {
    to: "gate-evaluation",
    event: "unrelated-repair",
  });
  assert.equal(unrelated.applied, false);
  assert.equal(unrelated.reason, "red_integration_interlock");

  const repair = transitionStagingMergeFactory(state, {
    to: "gate-evaluation",
    event: "failure-bound-repair-admitted",
    failureBoundRepair: true,
  });
  assert.equal(repair.applied, true, repair.reason);
  assert.equal(repair.state.stage, "gate-evaluation");
  assert.equal(repair.state.round, 2);
  assert.equal(repair.state.outcome, "pending");
  assert.equal(repair.state.effects.merge, false);
});

test("invalid staging merge transition fails closed", () => {
  const state = createStagingMergeFactoryState({ missionId: "mission-invalid", pullRequestId: "PR-105", simulation: true });
  const result = transitionStagingMergeFactory(state, { to: "merge-simulation", event: "skip-gates" });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "transition_not_allowed");
  assert.equal(result.state.stage, "queued");
  assert.equal(result.state.revision, 1);
});
