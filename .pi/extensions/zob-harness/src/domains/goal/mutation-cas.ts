import { sha256Hex } from "../../core/utils/hashing.js";
import { isRecord } from "../../core/utils/records.js";
import { GOAL_MUTATION_PHASE_CODES } from "./goal-todo-types.js";
import type {
  GoalMutationCasInput,
  GoalMutationCasOutcome,
  GoalMutationFailureCode,
  GoalMutationGuard,
  GoalMutationPreparation,
  GoalMutationPreparationInput,
  GoalMutationProtocolRecord,
  GoalMutationReceipt,
  GoalMutationReceiptDiagnostic,
  GoalMutationReceiptInput,
  GoalMutationReceiptState,
  GoalMutationSideEffectRef,
} from "./goal-todo-types.js";

export const GOAL_MUTATION_RECEIPT_ENTRY_TYPE = "zob-goal-mutation-receipt";
export const GOAL_MUTATION_RECEIPT_SCHEMA = "zob.goal-mutation-receipt.v1";
export const GOAL_MUTATION_PREPARATION_ENTRY_TYPE = "zob-goal-mutation-preparation";
export const GOAL_MUTATION_PREPARATION_SCHEMA = "zob.goal-mutation-preparation.v1";

const SHA256_HEX = /^[a-f0-9]{64}$/;
export const GOAL_MUTATION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const CANONICAL_ID = new RegExp(GOAL_MUTATION_ID_PATTERN);
const SIDE_EFFECT_STATES = new Set(["none", "prepared", "in_doubt", "completed"]);

function canonicalJsonValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires a finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("value is not valid canonical JSON");
  if (seen.has(value)) throw new TypeError("cyclic value is not valid canonical JSON");

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("sparse arrays are not valid canonical JSON");
      }
      return `[${value.map((item) => canonicalJsonValue(item, seen)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("value is not a plain canonical JSON object");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("symbol keys are not valid canonical JSON");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Deterministic JSON: object keys are sorted recursively; array order and scalar values are preserved. */
export function canonicalGoalMutationJson(value: unknown): string {
  return canonicalJsonValue(value, new Set());
}

export function hashGoalMutationRequest(request: unknown): string {
  return sha256Hex(canonicalGoalMutationJson(request));
}

export function isCanonicalGoalMutationId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_ID.test(value);
}

export function isCanonicalGoalMutationRequestHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validOptionalRevision(value: unknown): value is number | undefined {
  return value === undefined || validRevision(value);
}

function validSideEffect(value: unknown): value is GoalMutationSideEffectRef | undefined {
  if (value === undefined) return true;
  return isRecord(value)
    && typeof value.state === "string"
    && SIDE_EFFECT_STATES.has(value.state)
    && (value.operationHash === undefined || isCanonicalGoalMutationRequestHash(value.operationHash));
}

function canonicalStreamId(value: unknown): value is string {
  return isCanonicalGoalMutationId(value) && value !== "__proto__" && value !== "prototype" && value !== "constructor";
}

function guardIsValid(guard: GoalMutationGuard): boolean {
  if (!validOptionalRevision(guard.expectedGoalRevision) || !validOptionalRevision(guard.expectedGraphRevision) || !validOptionalRevision(guard.expectedTodoRevision)) return false;
  if (guard.expectedTodoRevision !== undefined && guard.todoId === undefined) return false;
  return guard.todoId === undefined || canonicalStreamId(guard.todoId);
}

export function cloneGoalMutationReceipt(receipt: GoalMutationReceipt): GoalMutationReceipt {
  return {
    ...receipt,
    ...(receipt.sideEffect ? { sideEffect: { ...receipt.sideEffect } } : {}),
  };
}

export function normalizeGoalMutationReceipt(value: unknown): GoalMutationReceipt | undefined {
  if (!isRecord(value) || value.schema !== GOAL_MUTATION_RECEIPT_SCHEMA || value.bodyStored !== false) return undefined;
  if (value.phase !== undefined && value.phase !== GOAL_MUTATION_PHASE_CODES.applied) return undefined;
  if (!canonicalStreamId(value.goalId) || !isCanonicalGoalMutationId(value.mutationId) || !isCanonicalGoalMutationRequestHash(value.requestHash)) return undefined;
  if (!validOptionalRevision(value.expectedGoalRevision)
    || !validOptionalRevision(value.expectedGraphRevision)
    || !validOptionalRevision(value.expectedTodoRevision)
    || !validOptionalRevision(value.goalRevision)
    || !validOptionalRevision(value.graphRevision)
    || !validOptionalRevision(value.todoRevision)) return undefined;
  const todoId = value.todoId;
  if (value.expectedTodoRevision !== undefined && todoId === undefined) return undefined;
  if ((todoId === undefined) !== (value.todoRevision === undefined)) return undefined;
  if (todoId !== undefined && !canonicalStreamId(todoId)) return undefined;
  if (!validRevision(value.eventCount) || !validRevision(value.appliedAt) || !validSideEffect(value.sideEffect)) return undefined;

  return {
    schema: GOAL_MUTATION_RECEIPT_SCHEMA,
    ...(value.phase === GOAL_MUTATION_PHASE_CODES.applied ? { phase: GOAL_MUTATION_PHASE_CODES.applied } : {}),
    goalId: value.goalId,
    mutationId: value.mutationId,
    requestHash: value.requestHash,
    ...(value.expectedGoalRevision !== undefined ? { expectedGoalRevision: value.expectedGoalRevision } : {}),
    ...(value.expectedGraphRevision !== undefined ? { expectedGraphRevision: value.expectedGraphRevision } : {}),
    ...(todoId !== undefined ? { todoId, expectedTodoRevision: value.expectedTodoRevision as number } : {}),
    ...(value.goalRevision !== undefined ? { goalRevision: value.goalRevision } : {}),
    ...(value.graphRevision !== undefined ? { graphRevision: value.graphRevision } : {}),
    ...(value.todoRevision !== undefined ? { todoRevision: value.todoRevision } : {}),
    eventCount: value.eventCount,
    ...(value.sideEffect !== undefined ? { sideEffect: { ...value.sideEffect } as GoalMutationSideEffectRef } : {}),
    appliedAt: value.appliedAt,
    bodyStored: false,
  };
}

export function createGoalMutationReceipt(input: GoalMutationReceiptInput): GoalMutationReceipt {
  const candidate: GoalMutationReceipt = {
    schema: GOAL_MUTATION_RECEIPT_SCHEMA,
    phase: GOAL_MUTATION_PHASE_CODES.applied,
    goalId: input.goalId,
    mutationId: input.guard.mutationId,
    requestHash: input.guard.requestHash,
    ...(input.guard.expectedGoalRevision !== undefined ? { expectedGoalRevision: input.guard.expectedGoalRevision } : {}),
    ...(input.guard.expectedGraphRevision !== undefined ? { expectedGraphRevision: input.guard.expectedGraphRevision } : {}),
    ...(input.guard.todoId !== undefined ? { todoId: input.guard.todoId, expectedTodoRevision: input.guard.expectedTodoRevision } : {}),
    ...(input.appliedRevisions.goalRevision !== undefined ? { goalRevision: input.appliedRevisions.goalRevision } : {}),
    ...(input.appliedRevisions.graphRevision !== undefined ? { graphRevision: input.appliedRevisions.graphRevision } : {}),
    ...(input.appliedRevisions.todoRevision !== undefined ? { todoRevision: input.appliedRevisions.todoRevision } : {}),
    eventCount: input.eventCount,
    ...(input.sideEffect ? { sideEffect: { ...input.sideEffect } } : {}),
    appliedAt: input.appliedAt,
    bodyStored: false,
  };
  const receipt = normalizeGoalMutationReceipt(candidate);
  if (!receipt || !guardIsValid(input.guard)) throw new TypeError("invalid Goal mutation receipt input");
  return receipt;
}

const PREPARATION_KEYS = new Set(["schema", "phase", "goalId", "mutationId", "requestHash", "recordedAt", "bodyStored"]);

export function normalizeGoalMutationPreparation(value: unknown): GoalMutationPreparation | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !PREPARATION_KEYS.has(key))) return undefined;
  if (value.schema !== GOAL_MUTATION_PREPARATION_SCHEMA || value.bodyStored !== false) return undefined;
  if (value.phase !== GOAL_MUTATION_PHASE_CODES.prepared && value.phase !== GOAL_MUTATION_PHASE_CODES.aborted) return undefined;
  if (!canonicalStreamId(value.goalId) || !isCanonicalGoalMutationId(value.mutationId) || !isCanonicalGoalMutationRequestHash(value.requestHash)) return undefined;
  if (!validRevision(value.recordedAt)) return undefined;
  return {
    schema: GOAL_MUTATION_PREPARATION_SCHEMA,
    phase: value.phase,
    goalId: value.goalId,
    mutationId: value.mutationId,
    requestHash: value.requestHash,
    recordedAt: value.recordedAt,
    bodyStored: false,
  };
}

export function createGoalMutationPreparation(input: GoalMutationPreparationInput): GoalMutationPreparation {
  const preparation = normalizeGoalMutationPreparation({
    schema: GOAL_MUTATION_PREPARATION_SCHEMA,
    phase: input.phase,
    goalId: input.goalId,
    mutationId: input.mutationId,
    requestHash: input.requestHash,
    recordedAt: input.recordedAt,
    bodyStored: false,
  });
  if (!preparation) throw new TypeError("invalid Goal mutation preparation input");
  return preparation;
}

function cloneGoalMutationProtocolRecord(protocol: GoalMutationProtocolRecord): GoalMutationProtocolRecord {
  return {
    requestHash: protocol.requestHash,
    phase: protocol.phase,
    prepared: { ...protocol.prepared },
    ...(protocol.terminal ? { terminal: { ...protocol.terminal } } : {}),
  };
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function createGoalMutationReceiptState(): GoalMutationReceiptState {
  return {
    byGoal: emptyRecord(),
    protocolByGoal: emptyRecord(),
    inDoubtByGoal: emptyRecord(),
    diagnostics: [],
    restoreBlocked: emptyRecord(),
  };
}

function ensureGoalMutationReceiptState(state: GoalMutationReceiptState): void {
  state.byGoal ??= emptyRecord();
  state.protocolByGoal ??= emptyRecord();
  state.inDoubtByGoal ??= emptyRecord();
  state.diagnostics ??= [];
  state.restoreBlocked ??= emptyRecord();
}

export function cloneGoalMutationReceiptState(state: GoalMutationReceiptState): GoalMutationReceiptState {
  ensureGoalMutationReceiptState(state);
  return {
    byGoal: Object.fromEntries(Object.entries(state.byGoal).map(([goalId, receipts]) => [goalId, Object.fromEntries(Object.entries(receipts).map(([mutationId, receipt]) => [mutationId, cloneGoalMutationReceipt(receipt)]))])),
    protocolByGoal: Object.fromEntries(Object.entries(state.protocolByGoal).map(([goalId, protocols]) => [goalId, Object.fromEntries(Object.entries(protocols).map(([mutationId, protocol]) => [mutationId, cloneGoalMutationProtocolRecord(protocol)]))])),
    inDoubtByGoal: Object.fromEntries(Object.entries(state.inDoubtByGoal).map(([goalId, preparations]) => [goalId, Object.fromEntries(Object.entries(preparations).map(([mutationId, preparation]) => [mutationId, { ...preparation }]))])),
    diagnostics: state.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    restoreBlocked: Object.fromEntries(Object.entries(state.restoreBlocked).map(([goalId, diagnostic]) => [goalId, { ...diagnostic }])),
  };
}

export function blockGoalMutationReceiptState(state: GoalMutationReceiptState, diagnostic: GoalMutationReceiptDiagnostic): void {
  ensureGoalMutationReceiptState(state);
  if (state.restoreBlocked[diagnostic.goalId]) return;
  state.restoreBlocked[diagnostic.goalId] = { ...diagnostic };
  state.diagnostics.push({ ...diagnostic });
}

function blockGoalMutationPhase(state: GoalMutationReceiptState, goalId: string, mutationId: string | undefined, at: number, message: string): false {
  blockGoalMutationReceiptState(state, {
    code: "conflicting_mutation_phase",
    goalId,
    mutationId,
    at,
    message,
  });
  return false;
}

export function markGoalMutationInDoubt(state: GoalMutationReceiptState, preparation: GoalMutationPreparation): void {
  ensureGoalMutationReceiptState(state);
  const duplicate = state.diagnostics.some((diagnostic) => diagnostic.code === "mutation_in_doubt"
    && diagnostic.goalId === preparation.goalId
    && diagnostic.mutationId === preparation.mutationId);
  if (duplicate) return;
  state.diagnostics.push({
    code: "mutation_in_doubt",
    goalId: preparation.goalId,
    mutationId: preparation.mutationId,
    at: preparation.recordedAt,
    message: `Goal mutation remains in_doubt for mutationId=${preparation.mutationId}`,
  });
}

/** Index one prepared/aborted sentinel. Exact duplicates are idempotent; illegal transitions poison one goal only. */
export function indexGoalMutationPreparation(state: GoalMutationReceiptState, preparation: GoalMutationPreparation): boolean {
  ensureGoalMutationReceiptState(state);
  if (state.restoreBlocked[preparation.goalId]) return false;
  const goalReceipts = state.byGoal[preparation.goalId] ?? (state.byGoal[preparation.goalId] = emptyRecord());
  if (goalReceipts[preparation.mutationId]) {
    return blockGoalMutationPhase(state, preparation.goalId, preparation.mutationId, preparation.recordedAt, `mutation phase follows applied receipt for mutationId=${preparation.mutationId}`);
  }

  const goalProtocols = state.protocolByGoal[preparation.goalId] ?? (state.protocolByGoal[preparation.goalId] = emptyRecord());
  const goalInDoubt = state.inDoubtByGoal[preparation.goalId] ?? (state.inDoubtByGoal[preparation.goalId] = emptyRecord());
  const existing = goalProtocols[preparation.mutationId];
  if (!existing) {
    if (preparation.phase !== GOAL_MUTATION_PHASE_CODES.prepared) {
      return blockGoalMutationPhase(state, preparation.goalId, preparation.mutationId, preparation.recordedAt, `aborted mutation phase has no prepared predecessor for mutationId=${preparation.mutationId}`);
    }
    goalProtocols[preparation.mutationId] = {
      requestHash: preparation.requestHash,
      phase: GOAL_MUTATION_PHASE_CODES.prepared,
      prepared: { ...preparation },
    };
    goalInDoubt[preparation.mutationId] = { ...preparation };
    return true;
  }

  if (existing.requestHash !== preparation.requestHash) {
    return blockGoalMutationPhase(state, preparation.goalId, preparation.mutationId, preparation.recordedAt, `mutation phase request hash conflict for mutationId=${preparation.mutationId}`);
  }
  if (existing.phase === GOAL_MUTATION_PHASE_CODES.prepared) {
    if (preparation.phase === GOAL_MUTATION_PHASE_CODES.prepared) {
      if (canonicalGoalMutationJson(existing.prepared) === canonicalGoalMutationJson(preparation)) return true;
      return blockGoalMutationPhase(state, preparation.goalId, preparation.mutationId, preparation.recordedAt, `duplicate prepared mutation phase conflicts for mutationId=${preparation.mutationId}`);
    }
    existing.phase = GOAL_MUTATION_PHASE_CODES.aborted;
    existing.terminal = { ...preparation };
    delete goalInDoubt[preparation.mutationId];
    return true;
  }
  if (existing.phase === GOAL_MUTATION_PHASE_CODES.aborted) {
    if (preparation.phase === GOAL_MUTATION_PHASE_CODES.aborted) {
      if (existing.terminal && canonicalGoalMutationJson(existing.terminal) === canonicalGoalMutationJson(preparation)) return true;
      return blockGoalMutationPhase(state, preparation.goalId, preparation.mutationId, preparation.recordedAt, `duplicate aborted mutation phase conflicts for mutationId=${preparation.mutationId}`);
    }
    existing.phase = GOAL_MUTATION_PHASE_CODES.prepared;
    existing.prepared = { ...preparation };
    delete existing.terminal;
    goalInDoubt[preparation.mutationId] = { ...preparation };
    return true;
  }
  return blockGoalMutationPhase(state, preparation.goalId, preparation.mutationId, preparation.recordedAt, `mutation phase follows applied mutation for mutationId=${preparation.mutationId}`);
}

/** Index one normalized receipt. New applied receipts must match a prepared sentinel; legacy receipts remain replayable. */
export function indexGoalMutationReceipt(state: GoalMutationReceiptState, receipt: GoalMutationReceipt): boolean {
  ensureGoalMutationReceiptState(state);
  if (state.restoreBlocked[receipt.goalId]) return false;
  const goalReceipts = state.byGoal[receipt.goalId] ?? (state.byGoal[receipt.goalId] = emptyRecord());
  const existing = goalReceipts[receipt.mutationId];
  if (existing) {
    if (canonicalGoalMutationJson(existing) === canonicalGoalMutationJson(receipt)) return true;
    blockGoalMutationReceiptState(state, {
      code: "conflicting_mutation_receipt",
      goalId: receipt.goalId,
      mutationId: receipt.mutationId,
      at: receipt.appliedAt,
      message: `conflicting Goal mutation receipt for mutationId=${receipt.mutationId}`,
    });
    return false;
  }

  const goalProtocols = state.protocolByGoal[receipt.goalId] ?? (state.protocolByGoal[receipt.goalId] = emptyRecord());
  const protocol = goalProtocols[receipt.mutationId];
  if (receipt.phase === GOAL_MUTATION_PHASE_CODES.applied) {
    if (!protocol || protocol.phase !== GOAL_MUTATION_PHASE_CODES.prepared || protocol.requestHash !== receipt.requestHash) {
      return blockGoalMutationPhase(state, receipt.goalId, receipt.mutationId, receipt.appliedAt, `applied mutation receipt has no matching prepared phase for mutationId=${receipt.mutationId}`);
    }
  } else if (protocol) {
    return blockGoalMutationPhase(state, receipt.goalId, receipt.mutationId, receipt.appliedAt, `legacy mutation receipt conflicts with phase protocol for mutationId=${receipt.mutationId}`);
  }

  goalReceipts[receipt.mutationId] = cloneGoalMutationReceipt(receipt);
  if (protocol) {
    protocol.phase = GOAL_MUTATION_PHASE_CODES.applied;
    protocol.terminal = cloneGoalMutationReceipt(receipt);
    delete state.inDoubtByGoal[receipt.goalId]?.[receipt.mutationId];
  }
  return true;
}

export function finalizeGoalMutationReceiptRestore(state: GoalMutationReceiptState): GoalMutationReceiptState {
  ensureGoalMutationReceiptState(state);
  for (const preparations of Object.values(state.inDoubtByGoal)) {
    for (const preparation of Object.values(preparations)) markGoalMutationInDoubt(state, preparation);
  }
  return state;
}

/** Consume one branch protocol entry without interpreting or storing request bodies. */
export function indexGoalMutationReceiptEntry(state: GoalMutationReceiptState, entry: unknown, deterministicAt = 0): boolean {
  if (!isRecord(entry) || (entry.customType !== GOAL_MUTATION_RECEIPT_ENTRY_TYPE && entry.customType !== GOAL_MUTATION_PREPARATION_ENTRY_TYPE) || !isRecord(entry.data)) return false;
  ensureGoalMutationReceiptState(state);
  const rawGoalId = entry.data.goalId;
  if (!canonicalStreamId(rawGoalId)) return false;
  if (state.restoreBlocked[rawGoalId]) return false;

  if (entry.customType === GOAL_MUTATION_PREPARATION_ENTRY_TYPE) {
    const preparation = normalizeGoalMutationPreparation(entry.data);
    if (!preparation) {
      blockGoalMutationReceiptState(state, {
        code: "malformed_mutation_phase",
        goalId: rawGoalId,
        mutationId: typeof entry.data.mutationId === "string" ? entry.data.mutationId : undefined,
        at: validRevision(entry.data.recordedAt) ? entry.data.recordedAt : deterministicAt,
        message: "rejected malformed Goal mutation phase",
      });
      return false;
    }
    return indexGoalMutationPreparation(state, preparation);
  }

  const receipt = normalizeGoalMutationReceipt(entry.data);
  if (!receipt) {
    blockGoalMutationReceiptState(state, {
      code: "malformed_mutation_receipt",
      goalId: rawGoalId,
      mutationId: typeof entry.data.mutationId === "string" ? entry.data.mutationId : undefined,
      at: validRevision(entry.data.appliedAt) ? entry.data.appliedAt : deterministicAt,
      message: "rejected malformed Goal mutation receipt",
    });
    return false;
  }
  return indexGoalMutationReceipt(state, receipt);
}

export function restoreGoalMutationReceiptsFromBranch(entries: Iterable<unknown>): GoalMutationReceiptState {
  const state = createGoalMutationReceiptState();
  let ordering = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || (entry.customType !== GOAL_MUTATION_RECEIPT_ENTRY_TYPE && entry.customType !== GOAL_MUTATION_PREPARATION_ENTRY_TYPE)) continue;
    ordering += 1;
    indexGoalMutationReceiptEntry(state, entry, ordering);
  }
  return finalizeGoalMutationReceiptRestore(state);
}

function rejected(input: GoalMutationCasInput, requestHash: string, failureCodes: GoalMutationFailureCode[]): GoalMutationCasOutcome {
  return {
    status: "rejected",
    ok: false,
    shouldApply: false,
    emitEvents: false,
    mutationId: input.guard.mutationId,
    requestHash,
    failureCodes,
  };
}

/**
 * Pure CAS/idempotency evaluator. `applied` authorizes the caller to mutate; this function never
 * appends events, records receipts, advances revisions, or dispatches side effects itself.
 */
export function evaluateGoalMutationCas(input: GoalMutationCasInput): GoalMutationCasOutcome {
  const suppliedHash = input.guard.requestHash;
  if (!isCanonicalGoalMutationId(input.guard.mutationId)) return rejected(input, suppliedHash, ["invalid_mutation_id"]);
  if (!isCanonicalGoalMutationRequestHash(suppliedHash)) return rejected(input, suppliedHash, ["invalid_request_hash"]);
  if (!guardIsValid(input.guard)) return rejected(input, suppliedHash, ["invalid_revision_guard"]);

  let computedHash: string;
  try {
    computedHash = hashGoalMutationRequest(input.request);
  } catch {
    return rejected(input, suppliedHash, ["invalid_request_body"]);
  }
  if (computedHash !== suppliedHash) return rejected(input, suppliedHash, ["request_hash_mismatch"]);

  const receipts = input.receipts;
  if (receipts) ensureGoalMutationReceiptState(receipts);
  if (receipts?.restoreBlocked[input.goalId]) return rejected(input, suppliedHash, ["receipt_stream_poisoned"]);
  const existing = receipts?.byGoal[input.goalId]?.[input.guard.mutationId];
  if (existing) {
    if (existing.requestHash !== suppliedHash) {
      return {
        status: "conflict",
        ok: false,
        shouldApply: false,
        emitEvents: false,
        mutationId: input.guard.mutationId,
        requestHash: suppliedHash,
        failureCodes: ["mutation_id_conflict"],
      };
    }
    return {
      status: "replayed",
      ok: true,
      shouldApply: false,
      emitEvents: false,
      mutationId: input.guard.mutationId,
      requestHash: suppliedHash,
      failureCodes: [],
      receipt: cloneGoalMutationReceipt(existing),
    };
  }

  const protocol = receipts?.protocolByGoal[input.goalId]?.[input.guard.mutationId];
  if (protocol) {
    if (protocol.requestHash !== suppliedHash) {
      return {
        status: "conflict",
        ok: false,
        shouldApply: false,
        emitEvents: false,
        mutationId: input.guard.mutationId,
        requestHash: suppliedHash,
        failureCodes: ["mutation_id_conflict"],
      };
    }
    if (protocol.phase === GOAL_MUTATION_PHASE_CODES.prepared) return rejected(input, suppliedHash, ["mutation_in_doubt"]);
    if (protocol.phase === GOAL_MUTATION_PHASE_CODES.applied) return rejected(input, suppliedHash, ["receipt_stream_poisoned"]);
  }

  const invalidCurrent = (input.guard.expectedGoalRevision !== undefined && input.current.goalRevision !== undefined && !validRevision(input.current.goalRevision))
    || (input.guard.expectedGraphRevision !== undefined && input.current.graphRevision !== undefined && !validRevision(input.current.graphRevision))
    || (input.guard.todoId !== undefined
      && input.guard.expectedTodoRevision !== undefined
      && input.current.todoRevisions?.[input.guard.todoId] !== undefined
      && !validRevision(input.current.todoRevisions[input.guard.todoId]));
  if (invalidCurrent) return rejected(input, suppliedHash, ["invalid_current_revision"]);

  const stale: GoalMutationFailureCode[] = [];
  if (input.guard.expectedGoalRevision !== undefined && input.current.goalRevision !== input.guard.expectedGoalRevision) stale.push("stale_goal_revision");
  if (input.guard.expectedGraphRevision !== undefined && input.current.graphRevision !== input.guard.expectedGraphRevision) stale.push("stale_graph_revision");
  if (input.guard.todoId !== undefined && input.guard.expectedTodoRevision !== undefined && input.current.todoRevisions?.[input.guard.todoId] !== input.guard.expectedTodoRevision) stale.push("stale_todo_revision");
  if (stale.length > 0) {
    return {
      status: "stale",
      ok: false,
      shouldApply: false,
      emitEvents: false,
      mutationId: input.guard.mutationId,
      requestHash: suppliedHash,
      failureCodes: stale,
    };
  }

  return {
    status: "applied",
    ok: true,
    shouldApply: true,
    emitEvents: true,
    mutationId: input.guard.mutationId,
    requestHash: suppliedHash,
    failureCodes: [],
  };
}
