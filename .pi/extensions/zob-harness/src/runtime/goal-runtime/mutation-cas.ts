import {
  blockGoalMutationReceiptState,
  createGoalMutationPreparation,
  createGoalMutationReceipt,
  evaluateGoalMutationCas,
  hashGoalMutationRequest,
  indexGoalMutationPreparation,
  indexGoalMutationReceipt,
  markGoalMutationInDoubt,
  isCanonicalGoalMutationId,
} from "../../domains/goal/mutation-cas.js";
import { GOAL_MUTATION_PHASE_CODES } from "../../domains/goal/goal-todo-types.js";
import type {
  GoalMutationCanonicalRequest,
  GoalMutationExecutionDiagnostic,
  GoalMutationExecutionInput,
  GoalMutationExecutionOutcome,
  GoalMutationFailureCode,
  GoalMutationObservation,
  GoalMutationPreparation,
  GoalMutationPublicGuard,
  GoalMutationReceiptState,
} from "../../domains/goal/goal-todo-types.js";

const RESERVED_STREAM_IDS = new Set(["__proto__", "prototype", "constructor"]);

function validRuntimeId(value: string): boolean {
  return isCanonicalGoalMutationId(value) && !RESERVED_STREAM_IDS.has(value);
}

export interface GoalMutationCanonicalRequestInput {
  toolName: string;
  goalId: string;
  resolvedTargetId: string;
  payload: unknown;
}

export interface GoalMutationCanonicalRequestResult {
  request: GoalMutationCanonicalRequest;
  requestHash: string;
}

/** Bind identity plus payload into one canonical hash before any observation or mutation callback runs. */
export function buildGoalMutationCanonicalRequest(input: GoalMutationCanonicalRequestInput): GoalMutationCanonicalRequestResult {
  if (!validRuntimeId(input.toolName)) throw new TypeError("invalid Goal mutation tool name");
  if (!validRuntimeId(input.goalId)) throw new TypeError("invalid Goal mutation goal id");
  if (!validRuntimeId(input.resolvedTargetId)) throw new TypeError("invalid Goal mutation target id");
  const request: GoalMutationCanonicalRequest = {
    toolName: input.toolName,
    goalId: input.goalId,
    resolvedTargetId: input.resolvedTargetId,
    payload: input.payload,
  };
  return { request, requestHash: hashGoalMutationRequest(request) };
}

function executionDiagnostic(
  input: Pick<GoalMutationExecutionInput<unknown>, "toolName" | "goalId" | "resolvedTargetId">,
  status: "stale" | "conflict" | "rejected",
  code: GoalMutationFailureCode,
  mutationId?: string,
  requestHash?: string,
): GoalMutationExecutionDiagnostic {
  return {
    schema: "zob.goal-mutation-execution-diagnostic.v1",
    code,
    status,
    toolName: input.toolName,
    goalId: input.goalId,
    resolvedTargetId: input.resolvedTargetId,
    ...(mutationId !== undefined ? { mutationId } : {}),
    ...(requestHash !== undefined ? { requestHash } : {}),
    bodyStored: false,
  };
}

function failed<Result>(
  input: GoalMutationExecutionInput<Result>,
  status: "stale" | "conflict" | "rejected",
  failureCodes: GoalMutationFailureCode[],
  mutationId?: string,
  requestHash?: string,
): GoalMutationExecutionOutcome<Result> {
  return {
    status,
    ok: false,
    ...(requestHash !== undefined ? { requestHash } : {}),
    ...(mutationId !== undefined ? { mutationId } : {}),
    failureCodes,
    diagnostic: executionDiagnostic(input, status, failureCodes[0] ?? "invalid_request_body", mutationId, requestHash),
  };
}

function publicGuardToEvaluatorGuard(guard: GoalMutationPublicGuard, requestHash: string, _resolvedTargetId: string, canonicalTodoId?: string) {
  const todoId = canonicalTodoId;
  return {
    mutationId: guard.mutationId,
    requestHash,
    ...(guard.expectedGoalRevision !== undefined ? { expectedGoalRevision: guard.expectedGoalRevision } : {}),
    ...(guard.expectedGraphRevision !== undefined ? { expectedGraphRevision: guard.expectedGraphRevision } : {}),
    ...(todoId !== undefined ? { todoId } : {}),
    ...(guard.expectedTodoRevision !== undefined ? { expectedTodoRevision: guard.expectedTodoRevision } : {}),
  };
}

function recordMutationDiagnostic(
  receipts: GoalMutationReceiptState,
  goalId: string,
  mutationId: string,
  code: "preparation_persistence_failed" | "preparation_index_failed" | "abort_persistence_failed" | "abort_index_failed" | "receipt_persistence_failed" | "receipt_index_failed" | "invalid_mutation_result",
  at: number,
  message: string,
): void {
  receipts.diagnostics.push({ code, goalId, mutationId, at, message });
}

function leaveMutationInDoubt(
  receipts: GoalMutationReceiptState,
  preparation: GoalMutationPreparation,
  code: "abort_persistence_failed" | "receipt_persistence_failed" | "invalid_mutation_result",
  at: number,
  message: string,
): void {
  recordMutationDiagnostic(receipts, preparation.goalId, preparation.mutationId, code, at, message);
  markGoalMutationInDoubt(receipts, preparation);
}

function callbackMayHaveApplied<Result>(input: GoalMutationExecutionInput<Result>): boolean {
  if (!input.didApply) return true;
  try {
    return input.didApply() === true;
  } catch {
    return true;
  }
}

/**
 * Observe-first compatibility boundary. An absent guard invokes legacy mutation once and writes no
 * CAS records. A present guard evaluates CAS, durably persists prepared before mutation, then writes
 * either one applied receipt or an aborted sentinel. Unmatched prepared state remains in_doubt.
 */
export async function executeGoalMutationCas<Result>(input: GoalMutationExecutionInput<Result>): Promise<GoalMutationExecutionOutcome<Result>> {
  const invalidIdentity: GoalMutationFailureCode | undefined = !validRuntimeId(input.toolName)
    ? "invalid_tool_name"
    : !validRuntimeId(input.goalId)
      ? "invalid_goal_id"
      : !validRuntimeId(input.resolvedTargetId) || (input.todoId !== undefined && !validRuntimeId(input.todoId))
        ? "invalid_target_id"
        : undefined;
  if (invalidIdentity) return failed(input, "rejected", [invalidIdentity]);

  let canonical: GoalMutationCanonicalRequestResult;
  try {
    canonical = buildGoalMutationCanonicalRequest(input);
  } catch {
    return failed(input, "rejected", ["invalid_request_body"], input.guard?.mutationId);
  }

  if (!input.guard) {
    const observation: GoalMutationObservation = {
      schema: "zob.goal-mutation-observation.v1",
      code: "cas_guard_absent",
      toolName: input.toolName,
      goalId: input.goalId,
      resolvedTargetId: input.resolvedTargetId,
      requestHash: canonical.requestHash,
      bodyStored: false,
    };
    if (input.observe) {
      try {
        await input.observe(observation);
      } catch {
        // Observation is additive only: legacy behavior must not depend on its sink availability.
      }
    }
    await input.beforeApply?.();
    const applied = await input.apply();
    return { status: "observed", ok: true, requestHash: canonical.requestHash, result: applied.result, observation };
  }

  if (input.restoreBlocked === true) return failed(input, "rejected", ["state_restore_blocked"], input.guard.mutationId, canonical.requestHash);
  if (input.receipts.restoreBlocked[input.goalId]) return failed(input, "rejected", ["receipt_stream_poisoned"], input.guard.mutationId, canonical.requestHash);

  const guard = publicGuardToEvaluatorGuard(input.guard, canonical.requestHash, input.resolvedTargetId, input.todoId);
  const cas = evaluateGoalMutationCas({
    goalId: input.goalId,
    guard,
    request: canonical.request,
    current: input.current,
    receipts: input.receipts,
  });
  if (cas.status === "replayed") {
    return {
      status: "replayed",
      ok: true,
      mutationId: cas.mutationId,
      requestHash: cas.requestHash,
      receipt: cas.receipt,
    };
  }
  if (cas.status !== "applied") {
    return failed(input, cas.status, cas.failureCodes, cas.mutationId, cas.requestHash);
  }

  await input.beforeApply?.();

  const preparedAt = input.now?.() ?? Date.now();
  let preparation: GoalMutationPreparation;
  try {
    preparation = createGoalMutationPreparation({
      phase: GOAL_MUTATION_PHASE_CODES.prepared,
      goalId: input.goalId,
      mutationId: guard.mutationId,
      requestHash: canonical.requestHash,
      recordedAt: preparedAt,
    });
  } catch {
    recordMutationDiagnostic(input.receipts, input.goalId, guard.mutationId, "preparation_persistence_failed", Number.isSafeInteger(preparedAt) && preparedAt >= 0 ? preparedAt : 0, "Goal mutation preparation metadata was invalid; callback not invoked");
    return failed(input, "rejected", ["preparation_persistence_failed"], guard.mutationId, canonical.requestHash);
  }

  if (!input.persistPreparation) {
    recordMutationDiagnostic(input.receipts, input.goalId, guard.mutationId, "preparation_persistence_failed", preparation.recordedAt, "Goal mutation preparation persistence callback is unavailable; callback not invoked");
    return failed(input, "rejected", ["preparation_persistence_failed"], guard.mutationId, canonical.requestHash);
  }
  try {
    await input.persistPreparation(preparation);
  } catch {
    recordMutationDiagnostic(input.receipts, input.goalId, guard.mutationId, "preparation_persistence_failed", preparation.recordedAt, "Goal mutation preparation persistence failed; callback not invoked");
    return failed(input, "rejected", ["preparation_persistence_failed"], guard.mutationId, canonical.requestHash);
  }
  if (!indexGoalMutationPreparation(input.receipts, preparation)) {
    if (!input.receipts.restoreBlocked[input.goalId]) {
      blockGoalMutationReceiptState(input.receipts, {
        code: "preparation_index_failed",
        goalId: input.goalId,
        mutationId: guard.mutationId,
        at: preparation.recordedAt,
        message: "Goal mutation preparation indexing failed; stream blocked",
      });
    }
    return failed(input, "rejected", ["preparation_index_failed"], guard.mutationId, canonical.requestHash);
  }

  let applied: Awaited<ReturnType<typeof input.apply>>;
  try {
    applied = await input.apply();
  } catch (callbackError) {
    if (input.applyFailureMode === "in_doubt" || callbackMayHaveApplied(input)) {
      markGoalMutationInDoubt(input.receipts, preparation);
      throw callbackError;
    }

    const abortedAt = input.now?.() ?? Date.now();
    let aborted: GoalMutationPreparation;
    try {
      aborted = createGoalMutationPreparation({
        phase: GOAL_MUTATION_PHASE_CODES.aborted,
        goalId: input.goalId,
        mutationId: guard.mutationId,
        requestHash: canonical.requestHash,
        recordedAt: abortedAt,
      });
      await input.persistPreparation(aborted);
    } catch {
      leaveMutationInDoubt(input.receipts, preparation, "abort_persistence_failed", Number.isSafeInteger(abortedAt) && abortedAt >= 0 ? abortedAt : preparation.recordedAt, "Goal mutation abort persistence failed; mutation remains in_doubt");
      return failed(input, "rejected", ["abort_persistence_failed"], guard.mutationId, canonical.requestHash);
    }
    if (!indexGoalMutationPreparation(input.receipts, aborted)) {
      if (!input.receipts.restoreBlocked[input.goalId]) {
        blockGoalMutationReceiptState(input.receipts, {
          code: "abort_index_failed",
          goalId: input.goalId,
          mutationId: guard.mutationId,
          at: aborted.recordedAt,
          message: "Goal mutation abort indexing failed; stream blocked",
        });
      }
      return failed(input, "rejected", ["abort_index_failed"], guard.mutationId, canonical.requestHash);
    }
    throw callbackError;
  }

  const appliedAt = input.now?.() ?? Date.now();
  let receipt;
  try {
    receipt = createGoalMutationReceipt({
      goalId: input.goalId,
      guard,
      appliedRevisions: applied.appliedRevisions,
      eventCount: applied.eventCount,
      appliedAt,
      ...(applied.sideEffect !== undefined ? { sideEffect: applied.sideEffect } : {}),
    });
  } catch {
    leaveMutationInDoubt(input.receipts, preparation, "invalid_mutation_result", Number.isSafeInteger(appliedAt) && appliedAt >= 0 ? appliedAt : preparation.recordedAt, "Goal mutation callback returned invalid body-free receipt metadata; mutation remains in_doubt");
    return failed(input, "rejected", ["invalid_mutation_result"], guard.mutationId, canonical.requestHash);
  }

  try {
    await input.persistReceipt(receipt);
  } catch {
    leaveMutationInDoubt(input.receipts, preparation, "receipt_persistence_failed", receipt.appliedAt, "Goal mutation receipt persistence failed; mutation remains in_doubt");
    return failed(input, "rejected", ["receipt_persistence_failed"], guard.mutationId, canonical.requestHash);
  }
  if (!indexGoalMutationReceipt(input.receipts, receipt)) {
    if (!input.receipts.restoreBlocked[input.goalId]) {
      blockGoalMutationReceiptState(input.receipts, {
        code: "receipt_index_failed",
        goalId: input.goalId,
        mutationId: guard.mutationId,
        at: receipt.appliedAt,
        message: "Goal mutation receipt indexing failed; stream blocked",
      });
    }
    return failed(input, "rejected", ["receipt_index_failed"], guard.mutationId, canonical.requestHash);
  }

  return {
    status: "applied",
    ok: true,
    mutationId: guard.mutationId,
    requestHash: canonical.requestHash,
    result: applied.result,
    receipt,
  };
}
