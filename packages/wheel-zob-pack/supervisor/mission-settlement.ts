import { selectWheelRunnableStories, wheelStoryCompletionSummary } from "./scheduler.js";
import type { WheelSupervisorEventKind, WheelSupervisorMissionState } from "./types.js";

export interface WheelMissionSettlement {
  state: WheelSupervisorMissionState;
  progressed: boolean;
}

export function settleWheelSupervisorMission(
  initialState: WheelSupervisorMissionState,
  initialProgressed: boolean,
  commit: (
    kind: WheelSupervisorEventKind,
    payload: Record<string, unknown>,
    ownershipEpoch: number,
  ) => WheelSupervisorMissionState,
): WheelMissionSettlement {
  let state = initialState;
  let progressed = initialProgressed;
  const summary = wheelStoryCompletionSummary(state);
  if (summary.pending.length === 0 && state.status !== "complete" && state.status !== "failed") {
    if (summary.failed.length > 0) {
      state = commit("mission-failed", { noShipReasons: summary.failed.map((storyId) => `story:${storyId}:failed`) }, state.ownershipEpoch);
    } else if (summary.needsHuman.length > 0) {
      state = commit("mission-needs-human", { noShipReasons: summary.needsHuman.map((storyId) => `story:${storyId}:needs-human`) }, state.ownershipEpoch);
    } else {
      state = commit("mission-completed", {}, state.ownershipEpoch);
    }
    progressed = true;
  } else if (!progressed && state.status !== "needs-human" && summary.pending.length > 0 && selectWheelRunnableStories(state).length === 0) {
    if (summary.needsHuman.length > 0) {
      state = commit("mission-needs-human", {
        noShipReasons: [
          ...summary.needsHuman.map((storyId) => `story:${storyId}:needs-human`),
          ...summary.pending.map((storyId) => `story:${storyId}:dependency-blocked`),
        ],
      }, state.ownershipEpoch);
    } else {
      state = commit("mission-failed", { noShipReasons: ["scheduler-deadlock", ...summary.pending.map((storyId) => `story:${storyId}:blocked`)] }, state.ownershipEpoch);
    }
    progressed = true;
  }
  return { state, progressed };
}
