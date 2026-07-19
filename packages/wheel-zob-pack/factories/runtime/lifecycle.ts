export type WheelFactoryType = "story-pr-close" | "blind-pr-review" | "staging-merge" | "repository-assurance" | "promotion";
export type WheelFactoryMode = "disabled" | "simulation";
export type WheelFactoryOutcome = "pending" | "pass" | "findings" | "needs-human" | "failed";

export interface WheelFactoryEffectFlags {
  githubWrites: false;
  merge: false;
  workflowDispatch: false;
  deployment: false;
  providerActivation: false;
}

export interface WheelFactoryDefinition<Stage extends string> {
  type: WheelFactoryType;
  enabledByDefault: false;
  activationRequired: true;
  initialStage: Stage;
  terminalStages: readonly Stage[];
  transitions: Readonly<Record<Stage, readonly Stage[]>>;
  maxRepairRounds: number;
}

export interface WheelFactoryState<Stage extends string> {
  schema: "wheel.zob.factory-state.v1";
  factoryType: WheelFactoryType;
  missionId: string;
  subjectId: string;
  mode: WheelFactoryMode;
  stage: Stage;
  outcome: WheelFactoryOutcome;
  round: number;
  revision: number;
  history: Array<{ from: Stage; to: Stage; event: string; revision: number }>;
  effects: WheelFactoryEffectFlags;
  activationEnabled: false;
  bodyStored: false;
}

export interface WheelFactoryTransitionResult<Stage extends string> {
  applied: boolean;
  state: WheelFactoryState<Stage>;
  reason?: "factory_disabled" | "transition_not_allowed" | "repair_round_limit" | "terminal_state";
}

export const NO_EXTERNAL_EFFECTS: WheelFactoryEffectFlags = Object.freeze({
  githubWrites: false,
  merge: false,
  workflowDispatch: false,
  deployment: false,
  providerActivation: false,
});

export function createWheelFactoryState<Stage extends string>(
  definition: WheelFactoryDefinition<Stage>,
  input: { missionId: string; subjectId: string; mode?: WheelFactoryMode },
): WheelFactoryState<Stage> {
  return {
    schema: "wheel.zob.factory-state.v1",
    factoryType: definition.type,
    missionId: input.missionId,
    subjectId: input.subjectId,
    mode: input.mode ?? "disabled",
    stage: definition.initialStage,
    outcome: "pending",
    round: 1,
    revision: 1,
    history: [],
    effects: NO_EXTERNAL_EFFECTS,
    activationEnabled: false,
    bodyStored: false,
  };
}

export function transitionWheelFactory<Stage extends string>(
  definition: WheelFactoryDefinition<Stage>,
  state: WheelFactoryState<Stage>,
  input: { to: Stage; event: string; outcome?: WheelFactoryOutcome; startsRepairRound?: boolean },
): WheelFactoryTransitionResult<Stage> {
  if (state.mode !== "simulation") return { applied: false, state, reason: "factory_disabled" };
  if (definition.terminalStages.includes(state.stage)) return { applied: false, state, reason: "terminal_state" };
  if (!definition.transitions[state.stage]?.includes(input.to)) return { applied: false, state, reason: "transition_not_allowed" };
  const nextRound = input.startsRepairRound === true ? state.round + 1 : state.round;
  if (nextRound > definition.maxRepairRounds) return { applied: false, state: { ...state, outcome: "needs-human" }, reason: "repair_round_limit" };
  const revision = state.revision + 1;
  return {
    applied: true,
    state: {
      ...state,
      stage: input.to,
      outcome: input.outcome ?? state.outcome,
      round: nextRound,
      revision,
      history: [...state.history, { from: state.stage, to: input.to, event: input.event, revision }],
      effects: NO_EXTERNAL_EFFECTS,
      activationEnabled: false,
      bodyStored: false,
    },
  };
}
