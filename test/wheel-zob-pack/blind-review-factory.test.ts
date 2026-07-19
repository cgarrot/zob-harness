import assert from "node:assert/strict";
import test from "node:test";

import {
  createBlindReviewFactoryState,
  transitionBlindReviewFactory,
  type BlindReviewFactoryStage,
} from "../../packages/wheel-zob-pack/factories/blind-review/factory.js";
import type { WheelFactoryState } from "../../packages/wheel-zob-pack/factories/runtime/lifecycle.js";

function assertSimulationOnly(state: WheelFactoryState<BlindReviewFactoryStage>): void {
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

function advance(
  state: WheelFactoryState<BlindReviewFactoryStage>,
  transitions: ReadonlyArray<readonly [BlindReviewFactoryStage, string]>,
): WheelFactoryState<BlindReviewFactoryStage> {
  for (const [to, event] of transitions) {
    const result = transitionBlindReviewFactory(state, { to, event });
    assert.equal(result.applied, true, result.reason);
    state = result.state;
    assertSimulationOnly(state);
  }
  return state;
}

const CLEAN_REVIEW = [
  ["discovery", "review-claimed"],
  ["adjudication", "lane-reports-frozen"],
  ["clean", "adjudicator-pass"],
] as const;

const FINDINGS_REPAIR_REVIEW = [
  ["discovery", "review-claimed"],
  ["adjudication", "lane-reports-frozen"],
  ["findings", "adjudicator-findings"],
  ["repair", "findings-returned"],
  ["re-review", "repair-evidence-ready"],
] as const;

test("Blind Review factory is disabled by default", () => {
  const state = createBlindReviewFactoryState({ missionId: "mission-disabled", pullRequestId: "pr-31" });
  const result = transitionBlindReviewFactory(state, { to: "discovery", event: "review-claimed" });

  assert.equal(state.stage, "queued");
  assert.equal(state.mode, "disabled");
  assert.equal(result.applied, false);
  assert.equal(result.reason, "factory_disabled");
  assert.strictEqual(result.state, state);
  assertSimulationOnly(result.state);
});

test("simulation reaches clean through discovery and adjudication", () => {
  const initial = createBlindReviewFactoryState({ missionId: "mission-clean", pullRequestId: "pr-32", simulation: true });
  const state = advance(initial, CLEAN_REVIEW);

  assert.equal(state.stage, "clean");
  assert.equal(state.outcome, "pass");
  assert.equal(state.round, 1);
  assertSimulationOnly(state);
});

test("findings return to repair and start a fresh re-review round", () => {
  let state = createBlindReviewFactoryState({ missionId: "mission-repair", pullRequestId: "pr-33", simulation: true });
  state = advance(state, FINDINGS_REPAIR_REVIEW);

  assert.equal(state.stage, "re-review");
  assert.equal(state.round, 2);
  state = advance(state, [
    ["discovery", "fresh-full-diff-started"],
    ["adjudication", "second-round-reports-frozen"],
    ["clean", "second-round-pass"],
  ]);
  assert.equal(state.stage, "clean");
  assert.equal(state.outcome, "pass");
  assertSimulationOnly(state);
});

test("a fourth complete review round is blocked by the three-round ceiling", () => {
  let state = createBlindReviewFactoryState({ missionId: "mission-ceiling", pullRequestId: "pr-34", simulation: true });
  state = advance(state, FINDINGS_REPAIR_REVIEW);
  state = advance(state, FINDINGS_REPAIR_REVIEW);
  state = advance(state, [
    ["discovery", "third-round-fresh-pass"],
    ["adjudication", "third-round-reports-frozen"],
    ["findings", "third-round-findings"],
    ["repair", "third-round-repair"],
  ]);

  assert.equal(state.round, 3);
  const blocked = transitionBlindReviewFactory(state, { to: "re-review", event: "fourth-round-requested" });
  assert.equal(blocked.applied, false);
  assert.equal(blocked.reason, "repair_round_limit");
  assert.equal(blocked.state.round, 3);
  assert.equal(blocked.state.outcome, "needs-human");
  assertSimulationOnly(blocked.state);

  const escalated = transitionBlindReviewFactory(blocked.state, { to: "needs-human", event: "repair-round-limit" });
  assert.equal(escalated.applied, true);
  assert.equal(escalated.state.stage, "needs-human");
  assert.equal(escalated.state.outcome, "needs-human");
  assertSimulationOnly(escalated.state);
});
