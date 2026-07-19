import { wheelStoryDependenciesSatisfied } from "./scheduler.js";
import type { WheelSupervisorMissionState, WheelSupervisorStoryStage } from "./types.js";

export interface WheelStoryReadinessResult {
  state: WheelSupervisorMissionState;
  progressed: boolean;
  processedStoryIds: string[];
}

export function advanceWheelStoryReadiness(
  initialState: WheelSupervisorMissionState,
  operations: {
    block: (storyId: string, blockerCodes: string[]) => WheelSupervisorMissionState;
    changeStage: (storyId: string, stage: WheelSupervisorStoryStage) => WheelSupervisorMissionState;
  },
): WheelStoryReadinessResult {
  let state = initialState;
  let progressed = false;
  const processedStoryIds: string[] = [];
  for (const story of Object.values(state.stories)) {
    if (story.stage === "admitted" && story.blockerCodes.length > 0) {
      state = operations.block(story.storyId, story.blockerCodes);
      progressed = true;
      processedStoryIds.push(story.storyId);
    } else if (
      story.blockerCodes.length === 0
      && !wheelStoryDependenciesSatisfied(state, story)
      && story.stage !== "waiting-dependencies"
      && !["needs-review", "needs-human", "failed"].includes(story.stage)
    ) {
      state = operations.changeStage(story.storyId, "waiting-dependencies");
      progressed = true;
      processedStoryIds.push(story.storyId);
    }
  }
  return { state, progressed, processedStoryIds };
}
