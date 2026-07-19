import assert from "node:assert/strict";
import test from "node:test";

import { createStoryFactoryState, transitionStoryFactory } from "../../packages/wheel-zob-pack/index.js";

test("factory is disabled by default and cannot transition", () => {
  const state = createStoryFactoryState({ missionId: "mission-disabled", storyId: "H31" });
  const result = transitionStoryFactory(state, { to: "planned", event: "plan-ready" });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "factory_disabled");
  assert.equal(result.state.effects.githubWrites, false);
  assert.equal(result.state.effects.deployment, false);
  assert.equal(result.state.activationEnabled, false);
});

test("simulation advances through Story to needs-review without external effects", () => {
  let state = createStoryFactoryState({ missionId: "mission-sim", storyId: "H31", simulation: true });
  for (const transition of [
    ["planned", "plan-ready"],
    ["building", "build-start"],
    ["validating", "build-complete"],
    ["pr-close", "validation-pass"],
    ["needs-review", "pr-close-pass"],
  ] as const) {
    const result = transitionStoryFactory(state, { to: transition[0], event: transition[1] });
    assert.equal(result.applied, true, result.reason);
    state = result.state;
  }
  assert.equal(state.stage, "needs-review");
  assert.equal(state.outcome, "pass");
  assert.equal(state.effects.githubWrites, false);
  assert.equal(state.effects.merge, false);
  assert.equal(state.effects.workflowDispatch, false);
  assert.equal(state.bodyStored, false);
});

test("invalid transition fails closed", () => {
  const state = createStoryFactoryState({ missionId: "mission-invalid", storyId: "H31", simulation: true });
  const result = transitionStoryFactory(state, { to: "needs-review", event: "skip-all-gates" });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "transition_not_allowed");
});
