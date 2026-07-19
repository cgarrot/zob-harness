import assert from "node:assert/strict";
import test from "node:test";

import { buildWheelSupervisorInitialState } from "../../packages/wheel-zob-pack/index.js";
import { supervisorAdmissionInput, supervisorStory } from "./supervisor-fixtures.js";

test("builds one source-bound tracked story projection per admitted manifest", () => {
  const first = supervisorStory("S-001");
  const second = supervisorStory("S-002", [{ storyId: "S-001", type: "hard" }]);
  const state = buildWheelSupervisorInitialState(supervisorAdmissionInput([first, second]));

  assert.equal(state.status, "admitted");
  assert.equal(state.mode, "deterministic-fake");
  assert.deepEqual(Object.keys(state.stories), ["S-001", "S-002"]);
  assert.equal(state.stories["S-002"]?.dependencies[0]?.storyId, "S-001");
  assert.equal(state.stories["S-001"]?.routeAssignments.some((assignment) => assignment.role === "development"), true);
  assert.equal(state.stories["S-001"]?.routeAssignments.some((assignment) => assignment.role === "qa"), true);
  assert.equal(state.stories["S-001"]?.routeAssignments.some((assignment) => assignment.role === "internal-review"), true);
  assert.equal(state.stories["S-001"]?.routeAssignments.some((assignment) => assignment.role === "pr-close-source-audit"), true);
  assert.equal(state.stories["S-001"]?.routeAssignments.some((assignment) => assignment.role === "pr-close-evidence-audit"), true);
  assert.equal(state.stories["S-001"]?.routeAssignments.some((assignment) => assignment.role === "pr-close"), true);
  const assignments = state.stories["S-001"]?.routeAssignments ?? [];
  const developmentFamily = assignments.find((assignment) => assignment.role === "development")?.selected.family;
  const auditFamilies = ["pr-close-source-audit", "pr-close-evidence-audit", "pr-close"]
    .map((role) => assignments.find((assignment) => assignment.role === role)?.selected.family);
  assert.equal(new Set(auditFamilies).size, 3);
  assert.equal(auditFamilies.includes(developmentFamily), false);
  assert.equal(state.pendingEffectRequestIds.length, 0);
  assert.equal(state.budgetLedger.settledCostUsd, 0);
});

test("preserves human gates as explicit story blockers without blocking unrelated admission", () => {
  const gated = supervisorStory("S-GATED");
  gated.humanGateRefs = ["docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md"];
  const ready = supervisorStory("S-READY");
  const state = buildWheelSupervisorInitialState(supervisorAdmissionInput([gated, ready]));
  assert.deepEqual(state.stories["S-GATED"]?.blockerCodes, ["human-gate-required"]);
  assert.deepEqual(state.stories["S-READY"]?.blockerCodes, []);
  assert.equal(state.status, "admitted");
});

test("rejects unsafe repository, check issuer, and branch isolation policy", () => {
  const first = supervisorStory("S-001");
  const second = supervisorStory("S-002");
  const input = supervisorAdmissionInput([first, second]);
  assert.throws(() => buildWheelSupervisorInitialState({ ...input, repositoryId: "unsafe repository" }), /repositoryId/);
  assert.throws(() => buildWheelSupervisorInitialState({
    ...input,
    checkPolicy: { ...input.checkPolicy, prCloseCheck: { ...input.checkPolicy.prCloseCheck, issuerHash: "short" } },
  }), /full issuer hashes/);
  second.branchContract.branchName = first.branchContract.branchName;
  assert.throws(
    () => buildWheelSupervisorInitialState(supervisorAdmissionInput([first, second])),
    /branch names must be unique/,
  );
});

test("fails closed on plan/story drift, duplicate stories, and unsafe authority", () => {
  const story = supervisorStory("S-001");
  const input = supervisorAdmissionInput([story]);
  assert.throws(
    () => buildWheelSupervisorInitialState({ ...input, bundleId: "wrong-bundle" }),
    /protected plan bundleId/,
  );
  assert.throws(
    () => buildWheelSupervisorInitialState({ ...input, stories: [input.stories[0], input.stories[0]] }),
    /story count|duplicate|branch names must be unique/,
  );
  assert.throws(
    () => buildWheelSupervisorInitialState({
      ...input,
      authority: { ...input.authority, githubEffectsEnabled: true },
    }),
    /cannot enable/,
  );
});
