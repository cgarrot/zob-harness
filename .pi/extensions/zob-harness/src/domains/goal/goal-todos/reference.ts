import type {
  GoalTodoCanonicalReferenceInput,
  GoalTodoNode,
  GoalTodoReferenceBatchResolution,
  GoalTodoReferenceCandidate,
  GoalTodoReferenceCode,
  GoalTodoReferenceDiagnostic,
  GoalTodoReferenceError,
  GoalTodoReferenceField,
  GoalTodoReferenceResolution,
  GoalTodoReferenceRetryPolicy,
  GoalTodoReferenceSafeNextAction,
  GoalTodoState,
} from "../goal-todo-types.js";
import { cloneNode } from "./normalize.js";

export const CANONICAL_GOAL_TODO_ID_PATTERN = /^todo_[a-f0-9]{12}$/;
export const VISIBLE_GOAL_TODO_PATH_PATTERN = /^[1-9]\d*(?:\.[1-9]\d*)*$/;

interface SingleReferenceResolution {
  node?: GoalTodoNode;
  code: Exclude<GoalTodoReferenceCode, "reference_mismatch" | "batch_resolution_failed" | "missing_goal_id" | "missing_reference">;
  errors: GoalTodoReferenceError[];
  candidates: GoalTodoReferenceCandidate[];
  retryPolicy: GoalTodoReferenceRetryPolicy;
}

function candidateFor(node: GoalTodoNode): GoalTodoReferenceCandidate {
  return { canonicalId: node.id, goalId: node.goalId, path: node.path };
}

function compareCandidates(left: GoalTodoReferenceCandidate, right: GoalTodoReferenceCandidate): number {
  return left.goalId.localeCompare(right.goalId)
    || left.path.localeCompare(right.path, undefined, { numeric: true })
    || left.canonicalId.localeCompare(right.canonicalId);
}

function uniqueCandidates(candidates: readonly GoalTodoReferenceCandidate[]): GoalTodoReferenceCandidate[] {
  const unique = new Map<string, GoalTodoReferenceCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.goalId}\u0000${candidate.canonicalId}\u0000${candidate.path}`;
    if (!unique.has(key)) unique.set(key, { ...candidate });
  }
  return [...unique.values()];
}

function failure(
  code: Exclude<SingleReferenceResolution["code"], "resolved">,
  field: GoalTodoReferenceField,
  message: string,
  retryPolicy: GoalTodoReferenceRetryPolicy,
  candidates: GoalTodoReferenceCandidate[] = [],
): SingleReferenceResolution {
  return { code, errors: [{ code, field, message }], candidates, retryPolicy };
}

function resolveTodoId(todoState: GoalTodoState, goalId: string, todoId: unknown): SingleReferenceResolution {
  if (typeof todoId !== "string" || !CANONICAL_GOAL_TODO_ID_PATTERN.test(todoId)) {
    return failure(
      "invalid_todo_id",
      "todo_id",
      "todo_id must be an exact canonical TODO node ID matching todo_<12 lowercase hex characters>",
      "fix_input",
    );
  }

  const inGoal = todoState.nodes.filter((node) => node.goalId === goalId && node.id === todoId);
  if (inGoal.length === 1) {
    const node = cloneNode(inGoal[0]);
    return { node, code: "resolved", errors: [], candidates: [candidateFor(node)], retryPolicy: "none" };
  }
  if (inGoal.length > 1) {
    return failure(
      "todo_id_ambiguous",
      "todo_id",
      `todo_id ${todoId} matches ${inGoal.length} nodes in goal ${goalId}`,
      "refresh_goal_todos",
      inGoal.map(candidateFor).sort(compareCandidates),
    );
  }

  const otherGoals = todoState.nodes.filter((node) => node.goalId !== goalId && node.id === todoId);
  if (otherGoals.length > 0) {
    return failure(
      "todo_id_cross_goal",
      "todo_id",
      `todo_id ${todoId} belongs to a different goal and cannot resolve in goal ${goalId}`,
      "refresh_goal_todos",
      otherGoals.map(candidateFor).sort(compareCandidates),
    );
  }
  return failure(
    "todo_id_not_found",
    "todo_id",
    `todo_id ${todoId} was not found in goal ${goalId}`,
    "refresh_goal_todos",
  );
}

function resolveTodoPath(todoState: GoalTodoState, goalId: string, todoPath: unknown): SingleReferenceResolution {
  if (typeof todoPath !== "string" || !VISIBLE_GOAL_TODO_PATH_PATTERN.test(todoPath)) {
    return failure(
      "invalid_todo_path",
      "todo_path",
      "todo_path must be an exact visible dotted path of positive integers without leading zeros",
      "fix_input",
    );
  }

  const matches = todoState.nodes.filter((node) => node.goalId === goalId && node.path === todoPath);
  if (matches.length === 1) {
    const node = cloneNode(matches[0]);
    return { node, code: "resolved", errors: [], candidates: [candidateFor(node)], retryPolicy: "none" };
  }
  if (matches.length > 1) {
    return failure(
      "todo_path_ambiguous",
      "todo_path",
      `todo_path ${todoPath} matches ${matches.length} nodes in goal ${goalId}`,
      "select_canonical_id",
      matches.map(candidateFor).sort(compareCandidates),
    );
  }
  return failure(
    "todo_path_not_found",
    "todo_path",
    `todo_path ${todoPath} was not found in goal ${goalId}`,
    "refresh_goal_todos",
  );
}

function successfulResolution(node: GoalTodoNode, candidates: GoalTodoReferenceCandidate[]): GoalTodoReferenceResolution {
  return {
    node: cloneNode(node),
    canonicalId: node.id,
    path: node.path,
    code: "resolved",
    errors: [],
    candidates: uniqueCandidates(candidates),
    retryPolicy: "none",
  };
}

/**
 * Resolve strict canonical fields without legacy interpretation or ID-to-path fallback.
 * When both fields are present, each is resolved independently in the requested goal.
 */
export function resolveCanonicalGoalTodoReference(
  todoState: GoalTodoState,
  goalId: string | undefined,
  input: GoalTodoCanonicalReferenceInput = {},
): GoalTodoReferenceResolution {
  if (typeof goalId !== "string" || goalId.trim().length === 0) {
    return {
      code: "missing_goal_id",
      errors: [{ code: "missing_goal_id", field: "goal_id", message: "canonical Goal/TODO reference resolution requires a goal_id" }],
      candidates: [],
      retryPolicy: "fix_input",
    };
  }

  const reference = input ?? {};
  const hasTodoId = reference.todoId !== undefined;
  const hasTodoPath = reference.todoPath !== undefined;
  if (!hasTodoId && !hasTodoPath) {
    return {
      code: "missing_reference",
      errors: [{ code: "missing_reference", field: "references", message: "provide todo_id and/or todo_path" }],
      candidates: [],
      retryPolicy: "fix_input",
    };
  }

  const idResolution = hasTodoId ? resolveTodoId(todoState, goalId, reference.todoId) : undefined;
  const pathResolution = hasTodoPath ? resolveTodoPath(todoState, goalId, reference.todoPath) : undefined;
  const errors = [...(idResolution?.errors ?? []), ...(pathResolution?.errors ?? [])];
  const candidates = uniqueCandidates([...(idResolution?.candidates ?? []), ...(pathResolution?.candidates ?? [])]);

  if (errors.length > 0) {
    const first = errors[0];
    const retryPolicy = errors.some((error) => error.code === "invalid_todo_id" || error.code === "invalid_todo_path")
      ? "fix_input"
      : errors.some((error) => error.code === "todo_path_ambiguous")
        ? "select_canonical_id"
        : "refresh_goal_todos";
    return { code: first.code, errors, candidates, retryPolicy };
  }

  const idNode = idResolution?.node;
  const pathNode = pathResolution?.node;
  if (idNode && pathNode && idNode.id !== pathNode.id) {
    return {
      code: "reference_mismatch",
      errors: [{
        code: "reference_mismatch",
        field: "references",
        message: `todo_id resolves to ${idNode.id} but todo_path resolves to ${pathNode.id}`,
      }],
      candidates,
      retryPolicy: "fix_input",
    };
  }

  const node = idNode ?? pathNode;
  if (!node) {
    return {
      code: "missing_reference",
      errors: [{ code: "missing_reference", field: "references", message: "provide todo_id and/or todo_path" }],
      candidates: [],
      retryPolicy: "fix_input",
    };
  }
  return successfulResolution(node, candidates);
}

function batchRetryPolicy(errors: readonly GoalTodoReferenceError[]): GoalTodoReferenceRetryPolicy {
  if (errors.some((error) => error.code === "invalid_todo_id" || error.code === "invalid_todo_path" || error.code === "reference_mismatch" || error.code === "missing_reference" || error.code === "missing_goal_id")) return "fix_input";
  if (errors.some((error) => error.code === "todo_path_ambiguous")) return "select_canonical_id";
  return "refresh_goal_todos";
}

function safeNextActions(retryPolicy: GoalTodoReferenceRetryPolicy, code: GoalTodoReferenceCode): readonly GoalTodoReferenceSafeNextAction[] {
  if (retryPolicy === "refresh_goal_todos") return Object.freeze(["refresh_goal_todos"]);
  if (retryPolicy === "select_canonical_id") return Object.freeze(["refresh_goal_todos", "select_canonical_todo_id"]);
  if (code === "reference_mismatch") return Object.freeze(["make_references_agree", "refresh_goal_todos"]);
  return Object.freeze(["provide_canonical_todo_id", "provide_visible_todo_path"]);
}

export function goalTodoReferenceDiagnostic(resolution: GoalTodoReferenceResolution | GoalTodoReferenceBatchResolution): GoalTodoReferenceDiagnostic {
  const first = resolution.errors[0];
  return Object.freeze({
    schema: "zob.goal-todo-reference-diagnostic.v1",
    code: resolution.code,
    field: first?.field ?? "references",
    retry_policy: resolution.retryPolicy,
    safe_next_actions: safeNextActions(resolution.retryPolicy, resolution.code),
    errors: Object.freeze(resolution.errors.map((error) => Object.freeze({ ...error }))),
    candidates: Object.freeze(resolution.candidates.map((candidate) => Object.freeze({ ...candidate }))),
  });
}

export class GoalTodoReferenceResolutionError extends Error {
  readonly diagnostic: GoalTodoReferenceDiagnostic;

  constructor(label: string, resolution: GoalTodoReferenceResolution | GoalTodoReferenceBatchResolution) {
    const diagnostic = goalTodoReferenceDiagnostic(resolution);
    const messages = diagnostic.errors.map((error) => `${error.code}:${error.message}`).join("; ") || "reference resolution failed";
    super(`${label}: code=${diagnostic.code} field=${diagnostic.field} retry_policy=${diagnostic.retry_policy} safe_next_actions=${diagnostic.safe_next_actions.join("|") || "none"}; ${messages}`);
    this.name = "GoalTodoReferenceResolutionError";
    this.diagnostic = diagnostic;
  }
}

export function throwGoalTodoReferenceResolution(label: string, resolution: GoalTodoReferenceResolution | GoalTodoReferenceBatchResolution): never {
  throw new GoalTodoReferenceResolutionError(label, resolution);
}

/** Resolve and deduplicate a batch in input order; any failed item makes the whole batch atomic failure. */
export function resolveCanonicalGoalTodoReferences(
  todoState: GoalTodoState,
  goalId: string | undefined,
  inputs: readonly GoalTodoCanonicalReferenceInput[],
): GoalTodoReferenceBatchResolution {
  if (inputs.length === 0) {
    const error: GoalTodoReferenceError = { code: "missing_reference", field: "batch", message: "canonical Goal/TODO reference batch must not be empty" };
    return { nodes: [], canonicalIds: [], paths: [], code: "batch_resolution_failed", resolutions: [], errors: [error], candidates: [], retryPolicy: "fix_input" };
  }

  const resolutions = inputs.map((input) => resolveCanonicalGoalTodoReference(todoState, goalId, input));
  const errors = resolutions.flatMap((resolution, index) => resolution.errors.map((error) => ({ ...error, index })));
  const candidates = uniqueCandidates(resolutions.flatMap((resolution) => resolution.candidates));
  if (errors.length > 0) {
    return {
      nodes: [],
      canonicalIds: [],
      paths: [],
      code: "batch_resolution_failed",
      resolutions,
      errors,
      candidates,
      retryPolicy: batchRetryPolicy(errors),
    };
  }

  const byId = new Map<string, GoalTodoNode>();
  for (const resolution of resolutions) {
    if (resolution.node && !byId.has(resolution.node.id)) byId.set(resolution.node.id, cloneNode(resolution.node));
  }
  const nodes = [...byId.values()];
  return {
    nodes,
    canonicalIds: nodes.map((node) => node.id),
    paths: nodes.map((node) => node.path),
    code: "resolved",
    resolutions,
    errors: [],
    candidates,
    retryPolicy: "none",
  };
}

/** Explicit compatibility adapter for legacy mixed refs. Strict resolvers never call this adapter. */
export function adaptLegacyGoalTodoReference(ref: string): GoalTodoCanonicalReferenceInput | undefined {
  if (CANONICAL_GOAL_TODO_ID_PATTERN.test(ref)) return { todoId: ref };
  if (VISIBLE_GOAL_TODO_PATH_PATTERN.test(ref)) return { todoPath: ref };
  const legacyPath = ref.match(/^todo_(\d+(?:\.\d+)*)$/)?.[1];
  return legacyPath && VISIBLE_GOAL_TODO_PATH_PATTERN.test(legacyPath) ? { todoPath: legacyPath } : undefined;
}
