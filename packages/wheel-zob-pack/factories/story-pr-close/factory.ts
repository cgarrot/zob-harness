import { createWheelFactoryState, transitionWheelFactory, type WheelFactoryDefinition, type WheelFactoryState, type WheelFactoryTransitionResult } from "../runtime/lifecycle.js";

export type StoryFactoryStage = "admitted" | "planned" | "building" | "validating" | "pr-close" | "needs-review" | "needs-human";

export const STORY_FACTORY_DEFINITION = Object.freeze<WheelFactoryDefinition<StoryFactoryStage>>({
  type: "story-pr-close",
  enabledByDefault: false,
  activationRequired: true,
  initialStage: "admitted",
  terminalStages: ["needs-review", "needs-human"],
  transitions: {
    admitted: ["planned", "needs-human"],
    planned: ["building", "needs-human"],
    building: ["validating", "needs-human"],
    validating: ["building", "pr-close", "needs-human"],
    "pr-close": ["building", "needs-review", "needs-human"],
    "needs-review": [],
    "needs-human": [],
  },
  maxRepairRounds: 3,
});

export function createStoryFactoryState(input: { missionId: string; storyId: string; simulation?: boolean }): WheelFactoryState<StoryFactoryStage> {
  return createWheelFactoryState(STORY_FACTORY_DEFINITION, { missionId: input.missionId, subjectId: input.storyId, mode: input.simulation === true ? "simulation" : "disabled" });
}

export function transitionStoryFactory(
  state: WheelFactoryState<StoryFactoryStage>,
  input: { to: StoryFactoryStage; event: string; startsRepairRound?: boolean },
): WheelFactoryTransitionResult<StoryFactoryStage> {
  const outcome = input.to === "needs-review" ? "pass" : input.to === "needs-human" ? "needs-human" : "pending";
  return transitionWheelFactory(STORY_FACTORY_DEFINITION, state, { ...input, outcome });
}
