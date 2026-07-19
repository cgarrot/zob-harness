import { createWheelFactoryState, transitionWheelFactory, type WheelFactoryDefinition, type WheelFactoryState, type WheelFactoryTransitionResult } from "../runtime/lifecycle.js";

export type BlindReviewFactoryStage = "queued" | "discovery" | "adjudication" | "findings" | "repair" | "re-review" | "clean" | "needs-human";

export const BLIND_REVIEW_FACTORY_DEFINITION = Object.freeze<WheelFactoryDefinition<BlindReviewFactoryStage>>({
  type: "blind-pr-review",
  enabledByDefault: false,
  activationRequired: true,
  initialStage: "queued",
  terminalStages: ["clean", "needs-human"],
  transitions: {
    queued: ["discovery", "needs-human"],
    discovery: ["adjudication", "needs-human"],
    adjudication: ["clean", "findings", "needs-human"],
    findings: ["repair", "needs-human"],
    repair: ["re-review", "needs-human"],
    "re-review": ["discovery", "needs-human"],
    clean: [],
    "needs-human": [],
  },
  maxRepairRounds: 3,
});

export function createBlindReviewFactoryState(input: {
  missionId: string;
  pullRequestId: string;
  simulation?: boolean;
}): WheelFactoryState<BlindReviewFactoryStage> {
  return createWheelFactoryState(BLIND_REVIEW_FACTORY_DEFINITION, {
    missionId: input.missionId,
    subjectId: input.pullRequestId,
    mode: input.simulation === true ? "simulation" : "disabled",
  });
}

export function transitionBlindReviewFactory(
  state: WheelFactoryState<BlindReviewFactoryStage>,
  input: { to: BlindReviewFactoryStage; event: string },
): WheelFactoryTransitionResult<BlindReviewFactoryStage> {
  const outcome = input.to === "clean" ? "pass" : input.to === "findings" ? "findings" : input.to === "needs-human" ? "needs-human" : "pending";
  return transitionWheelFactory(BLIND_REVIEW_FACTORY_DEFINITION, state, {
    ...input,
    outcome,
    startsRepairRound: input.to === "re-review",
  });
}
