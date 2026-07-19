import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FLEET_V5_SIGNAL_FIELDS, ingestFleetV5StoryBundle, validateFleetV5StoryExecution } from "../../packages/wheel-zob-pack/index.js";

function exampleStory(): Record<string, unknown> {
  return JSON.parse(readFileSync("docs/zob/examples/story-execution.example.json", "utf8")) as Record<string, unknown>;
}

test("validates the canonical Fleet v5 example and all 17 signal fields", () => {
  const story = exampleStory();
  const result = validateFleetV5StoryExecution(story);
  assert.equal(FLEET_V5_SIGNAL_FIELDS.length, 17);
  assert.equal(result.valid, true, result.issues.map((item) => `${item.path}: ${item.message}`).join("\n"));
  assert.equal(result.value?.repository.baseRef, "develop-staging");
  assert.equal(result.value?.branchContract.prTarget, "develop-staging");
});

test("rejects a partial Fleet v5 story", () => {
  const story = exampleStory();
  delete (story.signals as Record<string, unknown>).reviewerGate;
  const result = validateFleetV5StoryExecution(story);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((item) => item.path.endsWith("signals.reviewerGate") && item.code === "required"));
});

test("rejects direct-develop ordinary stories", () => {
  const story = exampleStory();
  (story.repository as Record<string, unknown>).baseRef = "develop";
  (story.branchContract as Record<string, unknown>).prTarget = "develop";
  const result = validateFleetV5StoryExecution(story);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((item) => item.code === "policy"));
});

test("ingests a valid story list and emits body-safe dependency metadata", () => {
  const result = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: "fleet-v5-demo",
    missionSeed: "0123456789abcdef",
    stories: [exampleStory()],
  });
  assert.equal(result.accepted, true, result.issues.map((item) => item.message).join("\n"));
  assert.deepEqual(result.storyIds, ["H31"]);
  assert.equal(result.bodyStored, false);
  assert.equal("title" in result, false);
});

test("rejects duplicate story ids and missing hard dependencies", () => {
  const first = exampleStory();
  const duplicate = exampleStory();
  const result = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: "fleet-v5-duplicate",
    missionSeed: "0123456789abcdef",
    stories: [first, duplicate],
  });
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((item) => item.code === "duplicate"));

  const dependent = exampleStory();
  dependent.dependencies = [{ storyId: "H99", type: "hard" }];
  const missingDependency = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: "fleet-v5-dependency",
    missionSeed: "0123456789abcdef",
    stories: [dependent],
  });
  assert.equal(missingDependency.accepted, false);
  assert.ok(missingDependency.issues.some((item) => item.code === "dependency"));
});

test("rejects hard and stack dependency cycles", () => {
  const first = exampleStory();
  first.storyId = "H31";
  first.dependencies = [{ storyId: "H32", type: "hard" }];
  const second = exampleStory();
  second.storyId = "H32";
  second.dependencies = [{ storyId: "H31", type: "stack" }];
  const result = ingestFleetV5StoryBundle({
    schema: "wheel.zob.fleet-v5-bundle.v1",
    bundleId: "fleet-v5-cycle",
    missionSeed: "0123456789abcdef",
    stories: [first, second],
  });
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some((item) => item.code === "dependency" && item.message.includes("cycle detected")));
});
