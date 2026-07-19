import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WHEEL_MODEL_ROUTES, buildWheelThinkingControl, ingestFleetV5StoryBundle, planWheelMission } from "../../packages/wheel-zob-pack/index.js";

function intake(seed = "0123456789abcdef") {
  const story = JSON.parse(readFileSync("docs/zob/examples/story-execution.example.json", "utf8"));
  return ingestFleetV5StoryBundle({ schema: "wheel.zob.fleet-v5-bundle.v1", bundleId: "fleet-v5-plan", missionSeed: seed, stories: [story] });
}

test("plans deterministically and fixes the orchestrator to Sol high", () => {
  const first = planWheelMission({ missionId: "mission-plan-1", intake: intake() });
  const second = planWheelMission({ missionId: "mission-plan-1", intake: intake() });
  assert.equal(first.planned, true);
  assert.equal(second.planned, true);
  if (!first.planned || !second.planned) return;
  assert.deepEqual(first.protectedPlan, second.protectedPlan);
  assert.equal(first.protectedPlan.orchestrator.routeId, "openai-codex/gpt-5.6-sol");
  assert.deepEqual(first.protectedPlan.orchestrator.thinkingControl, { kind: "pi-level", level: "high", advisory: false });
  assert.equal(first.protectedPlan.dispatchEnabled, false);
  assert.equal(first.protectedPlan.githubEffectsEnabled, false);
});

test("different mission seeds produce different private candidate orders", () => {
  const first = planWheelMission({ missionId: "mission-plan-a", intake: intake("0123456789abcdef") });
  const second = planWheelMission({ missionId: "mission-plan-b", intake: intake("fedcba9876543210") });
  assert.equal(first.planned, true);
  assert.equal(second.planned, true);
  if (!first.planned || !second.planned) return;
  const firstOrder = first.protectedPlan.stories[0].roleAssignments[0].candidates.map((candidate) => candidate.routeId);
  const secondOrder = second.protectedPlan.stories[0].roleAssignments[0].candidates.map((candidate) => candidate.routeId);
  assert.notDeepEqual(firstOrder, secondOrder);
});

test("QA and formal blind review select a different family from development", () => {
  const result = planWheelMission({ missionId: "mission-independence", intake: intake() });
  assert.equal(result.planned, true);
  if (!result.planned) return;
  const assignments = result.protectedPlan.stories[0].roleAssignments;
  const development = assignments.find((assignment) => assignment.rolePool === "development");
  assert.ok(development);
  for (const pool of ["qa", "formal-blind-review"] as const) {
    const review = assignments.find((assignment) => assignment.rolePool === pool);
    assert.ok(review);
    assert.equal(review.independentFromDevelopment, true);
    assert.notEqual(review.selected.family, development.selected.family);
  }
});

test("maps model-specific thinking controls", () => {
  assert.deepEqual(buildWheelThinkingControl(WHEEL_MODEL_ROUTES["accounts/fireworks/models/gpt-oss-120b"], "high"), { kind: "reasoning_effort", reasoning_effort: "high", advisory: false });
  assert.deepEqual(buildWheelThinkingControl(WHEEL_MODEL_ROUTES["accounts/fireworks/models/kimi-k2p7-code"], "low"), { kind: "budget_tokens", thinking: { type: "enabled", budget_tokens: 4096 }, advisory: false });
  assert.deepEqual(buildWheelThinkingControl(WHEEL_MODEL_ROUTES["accounts/fireworks/models/glm-5p2"], "high"), { kind: "budget_tokens", thinking: { type: "enabled", budget_tokens: 16384 }, advisory: true });
});

test("public plan stores route hashes, not model identities or raw seed", () => {
  const result = planWheelMission({ missionId: "mission-public", intake: intake() });
  assert.equal(result.planned, true);
  if (!result.planned) return;
  const serialized = JSON.stringify(result.publicPlan);
  assert.equal(serialized.includes("gpt-5.6"), false);
  assert.equal(serialized.includes("accounts/fireworks"), false);
  assert.equal(serialized.includes("0123456789abcdef"), false);
  assert.equal(result.publicPlan.modelIdentityStored, false);
  assert.equal(result.publicPlan.bodyStored, false);
});

test("hard eligibility can block every route without dispatching", () => {
  const result = planWheelMission({ missionId: "mission-blocked", intake: intake(), eligibility: { maxOutputPriceUsdPerMillion: 0 } });
  assert.equal(result.planned, false);
  if (result.planned) return;
  assert.ok(result.errors.some((error) => error.includes("no hard-eligible routes")));
  assert.equal(result.bodyStored, false);
});
