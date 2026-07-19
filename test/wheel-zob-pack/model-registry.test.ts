import assert from "node:assert/strict";
import test from "node:test";

import {
  WHEEL_FIXED_ROLE_ROUTES,
  WHEEL_MODEL_ROUTES,
  WHEEL_RANDOMIZED_ROLE_POOLS,
  listWheelPoolRoutes,
  validateWheelModelRegistry,
} from "../../packages/wheel-zob-pack/index.js";

test("Wheel model registry is internally valid", () => {
  const result = validateWheelModelRegistry();
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.routeCount, 20);
  assert.equal(result.randomizedPoolCount, 6);
  assert.ok(result.minimumPoolSize >= 5);
});

test("orchestrator and fixed adjudication roles use GPT-5.6 Sol high", () => {
  for (const assignment of Object.values(WHEEL_FIXED_ROLE_ROUTES)) {
    assert.equal(assignment.routeId, "openai-codex/gpt-5.6-sol");
    assert.equal(assignment.thinking, "high");
  }
});

test("OpenAI reduced-battery dimensions remain explicitly unverified", () => {
  const sol = WHEEL_MODEL_ROUTES["openai-codex/gpt-5.6-sol"];
  assert.equal(sol.capabilityVerification.inference, "verified");
  assert.equal(sol.capabilityVerification.thinking, "verified");
  assert.equal(sol.capabilityVerification.toolCalling, "unverified");
  assert.equal(sol.capabilityVerification.jsonMode, "unverified");
  assert.equal(sol.capabilityVerification.streaming, "unverified");
  assert.equal("toolCalling" in sol, false);
  assert.equal(sol.toolCallingDeclared, true);
});

test("gpt-oss and qwen compatibility findings are encoded", () => {
  assert.equal(WHEEL_MODEL_ROUTES["accounts/fireworks/models/gpt-oss-120b"].thinking.format, "reasoning_effort");
  assert.equal(WHEEL_MODEL_ROUTES["accounts/fireworks/models/qwen3p7-plus"].messageRoleFormat, "system-user");
});

test("review and assurance pools preserve family independence", () => {
  const reviewFamilies = new Set(listWheelPoolRoutes("formal-blind-review").map((route) => route.family));
  const assuranceFamilies = new Set(listWheelPoolRoutes("repository-assurance").map((route) => route.family));
  assert.ok(reviewFamilies.size >= 5);
  assert.ok(assuranceFamilies.size >= 3);
  assert.ok(Object.values(WHEEL_RANDOMIZED_ROLE_POOLS).every((pool) => pool.length >= 5));
});
