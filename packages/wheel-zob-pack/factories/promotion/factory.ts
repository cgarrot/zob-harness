import {
  createWheelFactoryState,
  transitionWheelFactory,
  type WheelFactoryDefinition,
  type WheelFactoryState,
  type WheelFactoryTransitionResult,
} from "../runtime/lifecycle.js";

export type PromotionFactoryStage =
  | "awaiting-window"
  | "window-open"
  | "pr-verification"
  | "authorization"
  | "merge-simulation"
  | "reconciliation"
  | "alignment"
  | "complete"
  | "needs-human";

export const PROMOTION_FACTORY_DEFINITION = Object.freeze<WheelFactoryDefinition<PromotionFactoryStage>>({
  type: "promotion",
  enabledByDefault: false,
  activationRequired: true,
  initialStage: "awaiting-window",
  terminalStages: ["complete", "needs-human"],
  transitions: {
    "awaiting-window": ["window-open", "needs-human"],
    "window-open": ["pr-verification", "needs-human"],
    "pr-verification": ["authorization", "needs-human"],
    authorization: ["merge-simulation", "needs-human"],
    "merge-simulation": ["reconciliation", "needs-human"],
    reconciliation: ["alignment", "needs-human"],
    alignment: ["complete", "needs-human"],
    complete: [],
    "needs-human": [],
  },
  maxRepairRounds: 1,
});

export function createPromotionFactoryState(input: {
  missionId: string;
  windowId: string;
  simulation?: boolean;
}): WheelFactoryState<PromotionFactoryStage> {
  return createWheelFactoryState(PROMOTION_FACTORY_DEFINITION, {
    missionId: input.missionId,
    subjectId: input.windowId,
    mode: input.simulation === true ? "simulation" : "disabled",
  });
}

export function transitionPromotionFactory(
  state: WheelFactoryState<PromotionFactoryStage>,
  input: { to: PromotionFactoryStage; event: string },
): WheelFactoryTransitionResult<PromotionFactoryStage> {
  const outcome = input.to === "complete" ? "pass" : input.to === "needs-human" ? "needs-human" : "pending";
  return transitionWheelFactory(PROMOTION_FACTORY_DEFINITION, state, { ...input, outcome });
}
