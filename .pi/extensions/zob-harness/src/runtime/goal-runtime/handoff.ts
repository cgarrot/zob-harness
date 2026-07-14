import { hashGoalMutationRequest } from "../../domains/goal/mutation-cas.js";
import type {
  GoalMutationApplyResult,
  GoalMutationCurrentRevisions,
  GoalMutationExecutionOutcome,
  GoalMutationPreparation,
  GoalMutationPublicGuard,
  GoalMutationReceipt,
  GoalMutationReceiptState,
} from "../../domains/goal/goal-todo-types.js";
import { executeGoalMutationCas } from "./mutation-cas.js";

export const GOAL_HANDOFF_EFFECT_FLAGS = {
  appendGoalRoom: true,
  linkDelegation: true,
  deliverLive: true,
  appendDeliveryLog: true,
  appendHandoffResult: true,
  markDelegationFailure: true,
  appendFailureResult: true,
  deliveryPreparedOnly: false,
} as const;

export interface GoalHandoffCanonicalPayload {
  canonicalTodoIds: string[];
  runId: string;
  targetType: "zpeer" | "zteam";
  canonicalTargetHash: string;
  targetHashes: string[];
  targetRoomHashes: string[];
  instructionHash: string;
  delegationDepth: number;
  senderHash: string;
  goalRoomTeamHash: string;
  source: "tool";
  effectFlags: typeof GOAL_HANDOFF_EFFECT_FLAGS;
}

export interface GoalHandoffCasPreflight<Result> {
  goalId: string;
  canonicalTodoIds: string[];
  runId: string;
  targetType: "zpeer" | "zteam";
  canonicalTargetHash: string;
  targetHashes: string[];
  targetRoomHashes: string[];
  instructionHash: string;
  delegationDepth: number;
  senderHash: string;
  goalRoomTeamHash: string;
  current: GoalMutationCurrentRevisions;
  /** Re-check local policy, team, and live target state before prepared. Exact replay skips this hook. */
  beforeApply: () => void | Promise<void>;
  apply: () => Omit<GoalMutationApplyResult<Result>, "sideEffect"> | Promise<Omit<GoalMutationApplyResult<Result>, "sideEffect">>;
}

export interface GoalHandoffCasExecutionInput<Result> {
  guard?: GoalMutationPublicGuard;
  receipts: GoalMutationReceiptState;
  restoreBlocked?: boolean;
  preflight: () => GoalHandoffCasPreflight<Result> | Promise<GoalHandoffCasPreflight<Result>>;
  persistPreparation?: (preparation: GoalMutationPreparation) => void | Promise<void>;
  persistReceipt: (receipt: GoalMutationReceipt) => void | Promise<void>;
  now?: () => number;
}

export interface GoalHandoffCasExecution<Result> {
  preflight: GoalHandoffCasPreflight<Result>;
  payload: GoalHandoffCanonicalPayload;
  outcome: GoalMutationExecutionOutcome<Result>;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Build the complete body-free handoff effect identity. Raw target aliases, rooms, and messages are excluded. */
export function buildGoalHandoffCanonicalPayload(preflight: GoalHandoffCasPreflight<unknown>): GoalHandoffCanonicalPayload {
  const canonicalTodoIds = sortedUnique(preflight.canonicalTodoIds);
  if (canonicalTodoIds.length === 0) throw new TypeError("Goal handoff CAS requires at least one canonical TODO id");
  return {
    canonicalTodoIds,
    runId: preflight.runId,
    targetType: preflight.targetType,
    canonicalTargetHash: preflight.canonicalTargetHash,
    targetHashes: sortedUnique(preflight.targetHashes),
    targetRoomHashes: sortedUnique(preflight.targetRoomHashes),
    instructionHash: preflight.instructionHash,
    delegationDepth: preflight.delegationDepth,
    senderHash: preflight.senderHash,
    goalRoomTeamHash: preflight.goalRoomTeamHash,
    source: "tool",
    effectFlags: { ...GOAL_HANDOFF_EFFECT_FLAGS },
  };
}

/**
 * Preflight-first CAS boundary for externally side-effectful Goal TODO handoff. Canonical identity is
 * resolved before CAS; local validation runs after replay/conflict checks but before durable prepared.
 * Every effect callback failure after prepared remains in_doubt.
 */
export async function executeGoalHandoffCas<Result>(input: GoalHandoffCasExecutionInput<Result>): Promise<GoalHandoffCasExecution<Result>> {
  const preflight = await input.preflight();
  const payload = buildGoalHandoffCanonicalPayload(preflight);
  const canonicalTodoId = payload.canonicalTodoIds.length === 1 ? payload.canonicalTodoIds[0] : undefined;
  const operationHash = hashGoalMutationRequest(payload);
  const outcome = await executeGoalMutationCas({
    toolName: "handoff_goal_todo",
    goalId: preflight.goalId,
    resolvedTargetId: `handoff:${payload.canonicalTargetHash}`,
    ...(canonicalTodoId !== undefined ? { todoId: canonicalTodoId } : {}),
    payload,
    guard: input.guard,
    current: preflight.current,
    receipts: input.receipts,
    restoreBlocked: input.restoreBlocked,
    beforeApply: preflight.beforeApply,
    apply: async () => {
      const applied = await preflight.apply();
      return {
        ...applied,
        sideEffect: { state: "completed", operationHash },
      };
    },
    persistPreparation: input.persistPreparation,
    persistReceipt: input.persistReceipt,
    applyFailureMode: "in_doubt",
    now: input.now,
  });
  return { preflight, payload, outcome };
}
