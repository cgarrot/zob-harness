import {
  createWheelFactoryState,
  transitionWheelFactory,
  type WheelFactoryDefinition,
  type WheelFactoryState,
  type WheelFactoryTransitionResult,
} from "../runtime/lifecycle.js";

export type StagingMergeFactoryStage =
  | "queued"
  | "gate-evaluation"
  | "ready"
  | "merge-simulation"
  | "integration-verification"
  | "repair-blocked"
  | "complete"
  | "needs-human";

export type StagingMergeFactoryBlockReason =
  | NonNullable<WheelFactoryTransitionResult<StagingMergeFactoryStage>["reason"]>
  | "merge_in_flight"
  | "red_integration_interlock";

export interface StagingMergeFactoryTransitionResult
  extends Omit<WheelFactoryTransitionResult<StagingMergeFactoryStage>, "reason"> {
  reason?: StagingMergeFactoryBlockReason;
}

export const STAGING_MERGE_FACTORY_DEFINITION = Object.freeze<WheelFactoryDefinition<StagingMergeFactoryStage>>({
  type: "staging-merge",
  enabledByDefault: false,
  activationRequired: true,
  initialStage: "queued",
  terminalStages: ["complete", "needs-human"],
  transitions: {
    queued: ["gate-evaluation", "needs-human"],
    "gate-evaluation": ["ready", "repair-blocked", "needs-human"],
    ready: ["merge-simulation", "repair-blocked", "needs-human"],
    "merge-simulation": ["integration-verification", "needs-human"],
    "integration-verification": ["complete", "repair-blocked", "needs-human"],
    "repair-blocked": ["gate-evaluation", "needs-human"],
    complete: [],
    "needs-human": [],
  },
  maxRepairRounds: 3,
});

export function createStagingMergeFactoryState(input: {
  missionId: string;
  pullRequestId: string;
  simulation?: boolean;
}): WheelFactoryState<StagingMergeFactoryStage> {
  return createWheelFactoryState(STAGING_MERGE_FACTORY_DEFINITION, {
    missionId: input.missionId,
    subjectId: input.pullRequestId,
    mode: input.simulation === true ? "simulation" : "disabled",
  });
}

export function transitionStagingMergeFactory(
  state: WheelFactoryState<StagingMergeFactoryStage>,
  input: {
    to: StagingMergeFactoryStage;
    event: string;
    mergeInFlight?: boolean;
    redIntegrationInterlock?: boolean;
    failureBoundRepair?: boolean;
  },
): StagingMergeFactoryTransitionResult {
  if (state.mode === "simulation" && input.to === "merge-simulation") {
    if (input.mergeInFlight === true) return { applied: false, state, reason: "merge_in_flight" };
    if (input.redIntegrationInterlock === true && input.failureBoundRepair !== true) {
      return { applied: false, state, reason: "red_integration_interlock" };
    }
  }

  if (
    state.mode === "simulation" &&
    state.stage === "repair-blocked" &&
    input.to === "gate-evaluation" &&
    input.failureBoundRepair !== true
  ) {
    return { applied: false, state, reason: "red_integration_interlock" };
  }

  const outcome = input.to === "complete" ? "pass" : input.to === "repair-blocked" ? "findings" : input.to === "needs-human" ? "needs-human" : "pending";
  return transitionWheelFactory(STAGING_MERGE_FACTORY_DEFINITION, state, {
    to: input.to,
    event: input.event,
    outcome,
    startsRepairRound: state.stage === "repair-blocked" && input.to === "gate-evaluation",
  });
}
