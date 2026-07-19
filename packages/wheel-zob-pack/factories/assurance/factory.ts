import {
  createWheelFactoryState,
  transitionWheelFactory,
  type WheelFactoryDefinition,
  type WheelFactoryState,
  type WheelFactoryTransitionResult,
} from "../runtime/lifecycle.js";

export type AssuranceFactoryStage =
  | "awaiting-freeze"
  | "frozen"
  | "auditing"
  | "findings"
  | "repairing"
  | "re-auditing"
  | "passed"
  | "needs-human";

export const ASSURANCE_FACTORY_DEFINITION = Object.freeze<WheelFactoryDefinition<AssuranceFactoryStage>>({
  type: "repository-assurance",
  enabledByDefault: false,
  activationRequired: true,
  initialStage: "awaiting-freeze",
  terminalStages: ["passed", "needs-human"],
  transitions: {
    "awaiting-freeze": ["frozen", "needs-human"],
    frozen: ["auditing", "needs-human"],
    auditing: ["findings", "passed", "needs-human"],
    findings: ["repairing", "needs-human"],
    repairing: ["re-auditing", "needs-human"],
    "re-auditing": ["findings", "passed", "needs-human"],
    passed: [],
    "needs-human": [],
  },
  maxRepairRounds: 3,
});

export function createAssuranceFactoryState(input: {
  missionId: string;
  candidateId: string;
  simulation?: boolean;
}): WheelFactoryState<AssuranceFactoryStage> {
  return createWheelFactoryState(ASSURANCE_FACTORY_DEFINITION, {
    missionId: input.missionId,
    subjectId: input.candidateId,
    mode: input.simulation === true ? "simulation" : "disabled",
  });
}

export function transitionAssuranceFactory(
  state: WheelFactoryState<AssuranceFactoryStage>,
  input: { to: AssuranceFactoryStage; event: string },
): WheelFactoryTransitionResult<AssuranceFactoryStage> {
  const outcome = input.to === "passed" ? "pass" : input.to === "findings" ? "findings" : input.to === "needs-human" ? "needs-human" : "pending";
  const startsRepairRound = state.stage === "findings" && input.to === "repairing";
  return transitionWheelFactory(ASSURANCE_FACTORY_DEFINITION, state, { ...input, outcome, startsRepairRound });
}
