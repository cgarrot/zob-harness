import { createAssuranceFactoryState, transitionAssuranceFactory, type AssuranceFactoryStage } from "./assurance/factory.js";
import { createBlindReviewFactoryState, transitionBlindReviewFactory, type BlindReviewFactoryStage } from "./blind-review/factory.js";
import { createPromotionFactoryState, transitionPromotionFactory, type PromotionFactoryStage } from "./promotion/factory.js";
import { createStagingMergeFactoryState, transitionStagingMergeFactory, type StagingMergeFactoryStage } from "./staging-merge/factory.js";
import { createStoryFactoryState, transitionStoryFactory, type StoryFactoryStage } from "./story-pr-close/factory.js";
import type { WheelFactoryState } from "./runtime/lifecycle.js";

export interface WheelFactoryPipelineState {
  schema: "wheel.zob.factory-pipeline.v1";
  missionId: string;
  story: WheelFactoryState<StoryFactoryStage>;
  blindReview: WheelFactoryState<BlindReviewFactoryStage>;
  stagingMerge: WheelFactoryState<StagingMergeFactoryStage>;
  assurance: WheelFactoryState<AssuranceFactoryStage>;
  promotion: WheelFactoryState<PromotionFactoryStage>;
  simulation: boolean;
  externalEffects: false;
  bodyStored: false;
}

export interface WheelFactoryPipelineResult {
  completed: boolean;
  blockedAt?: "story" | "blind-review" | "staging-merge" | "assurance" | "promotion";
  reason?: string;
  state: WheelFactoryPipelineState;
}

export function createWheelFactoryPipeline(input: {
  missionId: string;
  storyId: string;
  pullRequestId: string;
  candidateId: string;
  windowId: string;
  simulation?: boolean;
}): WheelFactoryPipelineState {
  return {
    schema: "wheel.zob.factory-pipeline.v1",
    missionId: input.missionId,
    story: createStoryFactoryState({ missionId: input.missionId, storyId: input.storyId, simulation: input.simulation }),
    blindReview: createBlindReviewFactoryState({ missionId: input.missionId, pullRequestId: input.pullRequestId, simulation: input.simulation }),
    stagingMerge: createStagingMergeFactoryState({ missionId: input.missionId, pullRequestId: input.pullRequestId, simulation: input.simulation }),
    assurance: createAssuranceFactoryState({ missionId: input.missionId, candidateId: input.candidateId, simulation: input.simulation }),
    promotion: createPromotionFactoryState({ missionId: input.missionId, windowId: input.windowId, simulation: input.simulation }),
    simulation: input.simulation === true,
    externalEffects: false,
    bodyStored: false,
  };
}

function applySequence<Stage extends string>(
  state: WheelFactoryState<Stage>,
  sequence: ReadonlyArray<{ to: Stage; event: string }>,
  transition: (state: WheelFactoryState<Stage>, input: { to: Stage; event: string }) => { applied: boolean; state: WheelFactoryState<Stage>; reason?: string },
): { applied: boolean; state: WheelFactoryState<Stage>; reason?: string } {
  let current = state;
  for (const input of sequence) {
    const result = transition(current, input);
    if (!result.applied) return result;
    current = result.state;
  }
  return { applied: true, state: current };
}

export function simulateWheelFactoryHappyPath(initial: WheelFactoryPipelineState): WheelFactoryPipelineResult {
  let state = initial;
  const story = applySequence(state.story, [
    { to: "planned", event: "plan-ready" },
    { to: "building", event: "build-start" },
    { to: "validating", event: "build-complete" },
    { to: "pr-close", event: "validation-pass" },
    { to: "needs-review", event: "pr-close-pass" },
  ], transitionStoryFactory);
  if (!story.applied) return { completed: false, blockedAt: "story", reason: story.reason, state };
  state = { ...state, story: story.state };

  const blind = applySequence(state.blindReview, [
    { to: "discovery", event: "review-claimed" },
    { to: "adjudication", event: "lanes-complete" },
    { to: "clean", event: "adjudicator-pass" },
  ], transitionBlindReviewFactory);
  if (!blind.applied) return { completed: false, blockedAt: "blind-review", reason: blind.reason, state };
  state = { ...state, blindReview: blind.state };

  const staging = applySequence(state.stagingMerge, [
    { to: "gate-evaluation", event: "blind-review-clean" },
    { to: "ready", event: "gates-pass" },
    { to: "merge-simulation", event: "staging-merge-simulated" },
    { to: "integration-verification", event: "merge-observed" },
    { to: "complete", event: "staging-integration-pass" },
  ], transitionStagingMergeFactory);
  if (!staging.applied) return { completed: false, blockedAt: "staging-merge", reason: staging.reason, state };
  state = { ...state, stagingMerge: staging.state };

  const assurance = applySequence(state.assurance, [
    { to: "frozen", event: "window-open" },
    { to: "auditing", event: "candidate-frozen" },
    { to: "passed", event: "assurance-pass" },
  ], transitionAssuranceFactory);
  if (!assurance.applied) return { completed: false, blockedAt: "assurance", reason: assurance.reason, state };
  state = { ...state, assurance: assurance.state };

  const promotion = applySequence(state.promotion, [
    { to: "window-open", event: "human-window-receipt" },
    { to: "pr-verification", event: "promotion-pr-open" },
    { to: "authorization", event: "promotion-pr-verified" },
    { to: "merge-simulation", event: "human-merge-receipt" },
    { to: "reconciliation", event: "promotion-merge-simulated" },
    { to: "alignment", event: "reconciliation-pass" },
    { to: "complete", event: "aligned-staging-ci-pass" },
  ], transitionPromotionFactory);
  if (!promotion.applied) return { completed: false, blockedAt: "promotion", reason: promotion.reason, state };
  state = { ...state, promotion: promotion.state };

  return { completed: true, state };
}
