import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSURANCE_FACTORY_DEFINITION,
  BLIND_REVIEW_FACTORY_DEFINITION,
  PROMOTION_FACTORY_DEFINITION,
  STAGING_MERGE_FACTORY_DEFINITION,
  STORY_FACTORY_DEFINITION,
  createWheelFactoryPipeline,
  simulateWheelFactoryHappyPath,
} from "../../packages/wheel-zob-pack/index.js";

const input = { missionId: "pipeline-demo", storyId: "H31", pullRequestId: "PR-31", candidateId: "candidate-1", windowId: "window-1" };

test("every factory definition is disabled by default and requires activation", () => {
  for (const definition of [STORY_FACTORY_DEFINITION, BLIND_REVIEW_FACTORY_DEFINITION, STAGING_MERGE_FACTORY_DEFINITION, ASSURANCE_FACTORY_DEFINITION, PROMOTION_FACTORY_DEFINITION]) {
    assert.equal(definition.enabledByDefault, false);
    assert.equal(definition.activationRequired, true);
  }
});

test("pipeline is disabled by default", () => {
  const result = simulateWheelFactoryHappyPath(createWheelFactoryPipeline(input));
  assert.equal(result.completed, false);
  assert.equal(result.blockedAt, "story");
  assert.equal(result.reason, "factory_disabled");
  assert.equal(result.state.externalEffects, false);
});

test("simulation traverses the complete Wheel lifecycle without effects", () => {
  const result = simulateWheelFactoryHappyPath(createWheelFactoryPipeline({ ...input, simulation: true }));
  assert.equal(result.completed, true, `${result.blockedAt}: ${result.reason}`);
  assert.equal(result.state.story.stage, "needs-review");
  assert.equal(result.state.blindReview.stage, "clean");
  assert.equal(result.state.stagingMerge.stage, "complete");
  assert.equal(result.state.assurance.stage, "passed");
  assert.equal(result.state.promotion.stage, "complete");
  assert.equal(result.state.externalEffects, false);
  for (const factory of [result.state.story, result.state.blindReview, result.state.stagingMerge, result.state.assurance, result.state.promotion]) {
    assert.equal(factory.effects.githubWrites, false);
    assert.equal(factory.effects.merge, false);
    assert.equal(factory.effects.workflowDispatch, false);
    assert.equal(factory.effects.deployment, false);
    assert.equal(factory.activationEnabled, false);
  }
});
