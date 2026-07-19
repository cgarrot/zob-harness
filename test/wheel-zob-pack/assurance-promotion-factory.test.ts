import assert from "node:assert/strict";
import test from "node:test";

import { createAssuranceFactoryState, transitionAssuranceFactory } from "../../packages/wheel-zob-pack/factories/assurance/factory.js";
import { createPromotionFactoryState, transitionPromotionFactory } from "../../packages/wheel-zob-pack/factories/promotion/factory.js";

function assertSimulationOnly(state: {
  effects: {
    githubWrites: false;
    merge: false;
    workflowDispatch: false;
    deployment: false;
    providerActivation: false;
  };
  activationEnabled: false;
  bodyStored: false;
}): void {
  assert.deepEqual(state.effects, {
    githubWrites: false,
    merge: false,
    workflowDispatch: false,
    deployment: false,
    providerActivation: false,
  });
  assert.equal(state.activationEnabled, false);
  assert.equal(state.bodyStored, false);
}

test("assurance and promotion are disabled by default", () => {
  const assurance = createAssuranceFactoryState({ missionId: "mission-disabled", candidateId: "candidate-1" });
  const assuranceResult = transitionAssuranceFactory(assurance, { to: "frozen", event: "window-receipt-observed" });
  assert.equal(assuranceResult.applied, false);
  assert.equal(assuranceResult.reason, "factory_disabled");
  assertSimulationOnly(assuranceResult.state);

  const promotion = createPromotionFactoryState({ missionId: "mission-disabled", windowId: "window-1" });
  const promotionResult = transitionPromotionFactory(promotion, { to: "window-open", event: "window-receipt-observed" });
  assert.equal(promotionResult.applied, false);
  assert.equal(promotionResult.reason, "factory_disabled");
  assertSimulationOnly(promotionResult.state);
});

test("assurance simulation freezes, audits, repairs, freshly re-audits, and passes", () => {
  let state = createAssuranceFactoryState({ missionId: "mission-assurance", candidateId: "candidate-2", simulation: true });
  for (const transition of [
    ["frozen", "freeze-confirmed"],
    ["auditing", "audit-started"],
    ["findings", "findings-validated"],
    ["repairing", "finding-bound-repair-started"],
    ["re-auditing", "repair-candidate-frozen"],
    ["passed", "fresh-audit-clean"],
  ] as const) {
    const result = transitionAssuranceFactory(state, { to: transition[0], event: transition[1] });
    assert.equal(result.applied, true, result.reason);
    state = result.state;
    assertSimulationOnly(state);
  }

  assert.equal(state.stage, "passed");
  assert.equal(state.outcome, "pass");
  assert.equal(state.round, 2);
});

test("assurance permits at most three rounds and two repair transitions", () => {
  let state = createAssuranceFactoryState({ missionId: "mission-ceiling", candidateId: "candidate-3", simulation: true });
  for (const transition of [
    ["frozen", "freeze-confirmed"],
    ["auditing", "round-1-started"],
    ["findings", "round-1-findings"],
    ["repairing", "repair-1-started"],
    ["re-auditing", "round-2-started"],
    ["findings", "round-2-findings"],
    ["repairing", "repair-2-started"],
    ["re-auditing", "round-3-started"],
    ["findings", "round-3-findings"],
  ] as const) {
    const result = transitionAssuranceFactory(state, { to: transition[0], event: transition[1] });
    assert.equal(result.applied, true, result.reason);
    state = result.state;
  }

  assert.equal(state.round, 3);
  const blockedRepair = transitionAssuranceFactory(state, { to: "repairing", event: "repair-3-rejected" });
  assert.equal(blockedRepair.applied, false);
  assert.equal(blockedRepair.reason, "repair_round_limit");
  assert.equal(blockedRepair.state.round, 3);
  assert.equal(blockedRepair.state.outcome, "needs-human");
  assertSimulationOnly(blockedRepair.state);
});

test("promotion verifies the PR before authorization and completes only in simulation", () => {
  let state = createPromotionFactoryState({ missionId: "mission-promotion", windowId: "window-2", simulation: true });
  let result = transitionPromotionFactory(state, { to: "window-open", event: "human-window-receipt-observed" });
  assert.equal(result.applied, true, result.reason);
  state = result.state;

  const earlyAuthorization = transitionPromotionFactory(state, { to: "authorization", event: "authorization-before-pr-verification" });
  assert.equal(earlyAuthorization.applied, false);
  assert.equal(earlyAuthorization.reason, "transition_not_allowed");
  assert.equal(earlyAuthorization.state.stage, "window-open");

  for (const transition of [
    ["pr-verification", "promotion-pr-checks-verified"],
    ["authorization", "exact-head-authorization-observed"],
    ["merge-simulation", "merge-commit-simulated"],
    ["reconciliation", "merge-event-correlated"],
    ["alignment", "staging-alignment-simulated"],
    ["complete", "aligned-head-ci-observed"],
  ] as const) {
    result = transitionPromotionFactory(state, { to: transition[0], event: transition[1] });
    assert.equal(result.applied, true, result.reason);
    state = result.state;
    assertSimulationOnly(state);
  }

  assert.equal(state.stage, "complete");
  assert.equal(state.outcome, "pass");
});
