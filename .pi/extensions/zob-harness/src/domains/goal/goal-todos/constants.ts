import type { GoalTodoChildGoalStatus, GoalTodoClaimTargetReadiness, GoalTodoClaimValidationConfidence, GoalTodoClaimValidationRecommendedAction, GoalTodoClaimValidationStatus, GoalTodoClaimValidationVerdict, GoalTodoDelegationStatus, GoalTodoOwner, GoalTodoPriority, GoalTodoStatus, GoalTodoStatusClaim } from "../goal-todo-types.js";

export const ZOB_GOAL_TODO_ENTRY_TYPE = "zob-goal-todo";

export const OPEN_REQUIRED_STATUSES = new Set<GoalTodoStatus>(["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user", "blocked"]);
export const ACTIVE_STATUSES = new Set<GoalTodoStatus>(["ready", "in_progress", "delegated", "claim_returned", "needs_review"]);
export const ACTIONABLE_STATUSES = new Set<GoalTodoStatus>(["planned", "ready", "in_progress", "needs_review", "needs_user", "needs_oracle", "blocked"]);
export const VALID_STATUS: readonly GoalTodoStatus[] = ["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user", "blocked", "done", "skipped"];
export const VALID_OWNER: readonly GoalTodoOwner[] = ["agent", "user", "oracle", "subagent", "factory", "orchestration"];
export const VALID_PRIORITY: readonly GoalTodoPriority[] = ["low", "normal", "high", "critical"];
export const VALID_DELEGATION_STATUS: readonly GoalTodoDelegationStatus[] = ["queued", "running", "claim_returned", "accepted", "rejected", "failed"];
export const VALID_CHILD_GOAL_STATUS: readonly GoalTodoChildGoalStatus[] = ["ready_for_oracle", "incomplete", "blocked"];
export const VALID_STATUS_CLAIM: readonly GoalTodoStatusClaim[] = ["done", "incomplete", "blocked"];
export const VALID_TARGET_READINESS: readonly GoalTodoClaimTargetReadiness[] = ["ready_for_parent_acceptance", "needs_parent_review", "blocked"];
export const VALID_VALIDATION_STATUS: readonly GoalTodoClaimValidationStatus[] = ["queued", "running", "passed", "warn", "failed", "blocked"];
export const VALID_VALIDATION_VERDICT: readonly GoalTodoClaimValidationVerdict[] = ["PASS", "WARN", "FAIL"];
export const VALID_VALIDATION_ACTION: readonly GoalTodoClaimValidationRecommendedAction[] = ["accept_claim", "needs_review", "reject_claim", "block"];
export const VALID_VALIDATION_CONFIDENCE: readonly GoalTodoClaimValidationConfidence[] = ["LOW", "MEDIUM", "HIGH"];
export const SHA256_HEX = /^[a-f0-9]{64}$/i;
