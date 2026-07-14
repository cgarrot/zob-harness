import { Type } from "typebox";

import { isRecord } from "../../core/utils/records.js";
import { GOAL_MUTATION_ID_PATTERN, isCanonicalGoalMutationId } from "../../domains/goal/mutation-cas.js";
import { CANONICAL_GOAL_TODO_ID_PATTERN, VISIBLE_GOAL_TODO_PATH_PATTERN } from "../../domains/goal/goal-todos/reference.js";
import type { GoalMutationPublicGuard } from "../../domains/goal/goal-todo-types.js";

const RevisionSchema = Type.Integer({
  description: "Optional exact nonnegative revision for optimistic concurrency. Values are never coerced.",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

/** Canonical additive public guard used under each mutator's optional `cas` field. */
export const GoalMutationGuardSchema = Type.Object({
  mutation_id: Type.Optional(Type.String({
    description: "Optional canonical idempotency key for one Goal/TODO mutation.",
    pattern: GOAL_MUTATION_ID_PATTERN,
    minLength: 1,
    maxLength: 128,
  })),
  expected_goal_revision: Type.Optional(RevisionSchema),
  expected_graph_revision: Type.Optional(RevisionSchema),
  expected_todo_revision: Type.Optional(RevisionSchema),
}, {
  additionalProperties: false,
  description: "Shared CAS/idempotency guard for Goal and TODO mutation tools; the containing cas field remains optional for legacy compatibility.",
});

export const GoalMutationGuardProperties = GoalMutationGuardSchema.properties;

/** Oracle recording and final completion are never legacy/unguarded: exact root revision and idempotency identity are mandatory. */
export const GoalExactRootMutationGuardSchema = Type.Object({
  mutation_id: Type.String({
    description: "Required canonical idempotency key for one oracle/completion root mutation.",
    pattern: GOAL_MUTATION_ID_PATTERN,
    minLength: 1,
    maxLength: 128,
  }),
  expected_goal_revision: RevisionSchema,
}, {
  additionalProperties: false,
  description: "Required exact root Goal CAS guard for oracle recording and final completion.",
});

/** Claim settlement and delegation recovery are never legacy/unguarded: exact graph/TODO revisions are mandatory. */
export const GoalExactTodoMutationGuardSchema = Type.Object({
  mutation_id: Type.String({
    description: "Required canonical idempotency key for one delegation recovery.",
    pattern: GOAL_MUTATION_ID_PATTERN,
    minLength: 1,
    maxLength: 128,
  }),
  expected_graph_revision: RevisionSchema,
  expected_todo_revision: RevisionSchema,
}, {
  additionalProperties: false,
  description: "Required exact CAS guard for claim validation/settlement or delegation recovery.",
});

export const GoalDelegationRecoveryGuardSchema = GoalExactTodoMutationGuardSchema;

export const GoalTodoCanonicalReferenceSchema = Type.Object({
  todo_id: Type.Optional(Type.String({
    description: "Exact canonical TODO node ID. Paths and legacy todo_<path> shorthand are rejected.",
    pattern: CANONICAL_GOAL_TODO_ID_PATTERN.source,
  })),
  todo_path: Type.Optional(Type.String({
    description: "Exact visible dotted TODO path. Canonical IDs are rejected.",
    pattern: VISIBLE_GOAL_TODO_PATH_PATTERN.source,
  })),
}, {
  additionalProperties: false,
  description: "Canonical Goal/TODO reference. Execute requires todo_id and/or todo_path and independently resolves both when supplied.",
});

export const GoalTodoCanonicalReferenceProperties = GoalTodoCanonicalReferenceSchema.properties;

export const GoalTodoClaimHashSchema = Type.String({
  description: "Exact full lowercase sha256 claim hash; truncated hashes are rejected.",
  pattern: "^[a-f0-9]{64}$",
  minLength: 64,
  maxLength: 64,
});

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Parse guard fields without coercion or input correction. */
export function parseRequiredGoalRootMutationGuard(value: unknown): GoalMutationPublicGuard & { expectedGoalRevision: number } {
  const guard = parseOptionalGoalMutationGuard(value);
  if (!guard || guard.expectedGoalRevision === undefined) {
    throw new TypeError("invalid root Goal mutation guard: mutation_id and expected_goal_revision are required");
  }
  return guard as GoalMutationPublicGuard & { expectedGoalRevision: number };
}

export function parseRequiredGoalDelegationRecoveryGuard(value: unknown): GoalMutationPublicGuard & { expectedGraphRevision: number; expectedTodoRevision: number } {
  const guard = parseOptionalGoalMutationGuard(value);
  if (!guard || guard.expectedGraphRevision === undefined || guard.expectedTodoRevision === undefined) {
    throw new TypeError("invalid delegation recovery guard: mutation_id, expected_graph_revision, and expected_todo_revision are required");
  }
  return guard as GoalMutationPublicGuard & { expectedGraphRevision: number; expectedTodoRevision: number };
}

export function parseOptionalGoalMutationGuard(value: unknown): GoalMutationPublicGuard | undefined {
  if (!isRecord(value)) throw new TypeError("invalid Goal mutation guard: expected an object");
  const mutationId = value.mutation_id;
  const expectedGoalRevision = value.expected_goal_revision;
  const expectedGraphRevision = value.expected_graph_revision;
  const expectedTodoRevision = value.expected_todo_revision;
  const present = mutationId !== undefined
    || expectedGoalRevision !== undefined
    || expectedGraphRevision !== undefined
    || expectedTodoRevision !== undefined;
  if (!present) return undefined;
  if (!isCanonicalGoalMutationId(mutationId)
    || (expectedGoalRevision !== undefined && !validRevision(expectedGoalRevision))
    || (expectedGraphRevision !== undefined && !validRevision(expectedGraphRevision))
    || (expectedTodoRevision !== undefined && !validRevision(expectedTodoRevision))) {
    throw new TypeError("invalid Goal mutation guard: canonical mutation_id and nonnegative safe integer revisions are required");
  }
  return {
    mutationId,
    ...(expectedGoalRevision !== undefined ? { expectedGoalRevision } : {}),
    ...(expectedGraphRevision !== undefined ? { expectedGraphRevision } : {}),
    ...(expectedTodoRevision !== undefined ? { expectedTodoRevision } : {}),
  };
}
