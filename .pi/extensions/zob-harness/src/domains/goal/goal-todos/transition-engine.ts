import type {
  GoalTodoStatus,
  GoalTodoTransitionAction,
  GoalTodoTransitionCode,
  GoalTodoTransitionContext,
  GoalTodoTransitionDecision,
  GoalTodoTransitionGuard,
  GoalTodoTransitionInput,
  GoalTodoTransitionRule,
  GoalTodoTransitionRuleDiagnostic,
  GoalTodoTransitionTable,
} from "../goal-todo-types.js";

export const GOAL_TODO_STATUSES = [
  "planned",
  "ready",
  "in_progress",
  "delegated",
  "claim_returned",
  "needs_review",
  "needs_oracle",
  "needs_user",
  "blocked",
  "done",
  "skipped",
] as const satisfies readonly GoalTodoStatus[];

export const GOAL_TODO_TRANSITION_ACTIONS = [
  "no_op",
  "update",
  "mark_ready",
  "start",
  "queue_delegation",
  "mark_delegation_failed",
  "return_claim",
  "mark_needs_review",
  "mark_needs_oracle",
  "mark_needs_user",
  "complete",
  "accept_claim",
  "reject_claim",
  "block",
  "skip",
  "reopen",
  "recover_delegation",
] as const satisfies readonly GoalTodoTransitionAction[];

const ACTIVE_DELEGATIONS = new Set(["queued", "running", "claim_returned"]);
const RETURNABLE_DELEGATIONS = new Set(["queued", "running"]);
const RECOVERY_PENDING_DELEGATIONS = new Set(["failed", "rejected", "unknown"]);
const CHILD_STATUSES = new Set(["ready_for_oracle", "incomplete", "blocked"]);
const STATUS_CLAIMS = new Set(["done", "incomplete", "blocked"]);
const TARGET_READINESS = new Set(["ready_for_parent_acceptance", "needs_parent_review", "blocked"]);

const allowedNext: Record<GoalTodoStatus, Partial<Record<GoalTodoTransitionAction, GoalTodoStatus>>> = {
  planned: {
    no_op: "planned", update: "planned", mark_ready: "ready", start: "in_progress", queue_delegation: "delegated",
    mark_needs_review: "needs_review", mark_needs_oracle: "needs_oracle", mark_needs_user: "needs_user",
    complete: "done", block: "blocked", skip: "skipped",
  },
  ready: {
    no_op: "ready", update: "ready", mark_ready: "ready", start: "in_progress", queue_delegation: "delegated",
    mark_needs_review: "needs_review", mark_needs_oracle: "needs_oracle", mark_needs_user: "needs_user",
    complete: "done", block: "blocked", skip: "skipped",
  },
  in_progress: {
    no_op: "in_progress", update: "in_progress", mark_ready: "ready", start: "in_progress", queue_delegation: "delegated",
    mark_needs_review: "needs_review", mark_needs_oracle: "needs_oracle", mark_needs_user: "needs_user",
    complete: "done", block: "blocked", skip: "skipped",
  },
  delegated: {
    no_op: "delegated", update: "delegated", mark_delegation_failed: "delegated", return_claim: "claim_returned", block: "blocked", recover_delegation: "ready",
  },
  claim_returned: {
    no_op: "claim_returned", update: "claim_returned", mark_needs_oracle: "needs_oracle",
    accept_claim: "done", reject_claim: "blocked", block: "blocked",
  },
  needs_review: {
    no_op: "needs_review", update: "needs_review", mark_needs_review: "needs_review", mark_needs_oracle: "needs_oracle", mark_needs_user: "needs_user",
    reject_claim: "blocked", block: "blocked",
  },
  needs_oracle: {
    no_op: "needs_oracle", update: "needs_oracle", accept_claim: "done", reject_claim: "blocked", block: "blocked",
  },
  needs_user: {
    no_op: "needs_user", update: "needs_user", mark_needs_review: "needs_review", mark_needs_oracle: "needs_oracle", mark_needs_user: "needs_user",
    complete: "done", block: "blocked", skip: "skipped", reopen: "ready",
  },
  blocked: {
    no_op: "blocked", update: "blocked", block: "blocked", skip: "skipped", reopen: "ready", recover_delegation: "ready",
  },
  done: { no_op: "done", update: "done", reopen: "ready" },
  skipped: { no_op: "skipped", update: "skipped", reopen: "ready" },
};

function requiredGuardsFor(status: GoalTodoStatus, action: GoalTodoTransitionAction): readonly GoalTodoTransitionGuard[] {
  switch (action) {
    case "update":
      return ["update_status_preserved"];
    case "mark_ready":
    case "start":
      return ["delegation_absent_or_inactive", "delegation_recovery_not_required", "claim_absent"];
    case "mark_needs_review":
    case "mark_needs_user":
      return status === "needs_user" || status === "needs_review"
        ? []
        : ["delegation_absent_or_inactive", "delegation_recovery_not_required", "claim_absent"];
    case "queue_delegation":
      return ["delegation_absent_or_inactive", "delegation_recovery_not_required", "claim_absent"];
    case "mark_delegation_failed":
      return ["delegation_returnable", "delegation_attempt_matches", "claim_absent", "delegation_failure_context_present"];
    case "return_claim":
      return [
        "delegation_returnable", "claim_present", "claim_gate_passed", "child_status_present", "child_ready_for_oracle",
        "status_claim_present", "child_claims_done", "target_readiness_present", "target_ready_for_parent_acceptance", "acceptance_blockers_absent",
        "child_no_ship_false", "evidence_present",
      ];
    case "mark_needs_oracle":
      return status === "claim_returned" || status === "needs_review"
        ? ["delegation_claim_returned", "claim_present"]
        : ["delegation_absent_or_inactive", "delegation_recovery_not_required", "claim_absent"];
    case "complete":
      return [
        "delegation_absent_or_inactive",
        "delegation_recovery_not_required",
        "claim_absent",
        "no_ship_clear",
        "resolution_evidence_present",
        ...(status === "needs_user" ? ["user_resolved" as const] : []),
      ];
    case "accept_claim":
      return [
        "delegation_claim_returned", "claim_present", "claim_gate_passed", "child_status_present", "child_ready_for_oracle",
        "status_claim_present", "child_claims_done", "target_readiness_present", "target_ready_for_parent_acceptance", "acceptance_blockers_absent",
        "child_no_ship_false", "evidence_present", "validation_policy_present",
        "acceptance_policy_satisfied", "claim_hash_matches", "claim_revision_matches",
      ];
    case "reject_claim":
      return ["delegation_claim_returned", "claim_present", "resolution_reason_present"];
    case "block":
      return status === "claim_returned" || status === "needs_review" || status === "needs_oracle"
        ? ["delegation_claim_returned", "claim_present", "resolution_reason_present"]
        : ["resolution_reason_present"];
    case "skip":
      if (status === "blocked") return ["delegation_absent", "claim_absent", "resolution_reason_present", "evidence_present"];
      return [
        "delegation_absent_or_inactive", "delegation_recovery_not_required", "claim_absent",
        "no_ship_clear", "resolution_reason_present", "resolution_evidence_present",
        ...(status === "needs_user" ? ["user_resolved" as const] : []),
      ];
    case "reopen":
      if (status === "done" || status === "skipped") return ["cas_bound", "resolution_reason_present", "evidence_present", "reopen_clears_delegation"];
      return [
        "delegation_absent", "claim_absent", "resolution_reason_present", "evidence_present",
        ...(status === "needs_user" ? ["user_resolved" as const] : []),
      ];
    case "recover_delegation":
      return [
        "delegation_recoverable", "delegation_not_live", "delegation_liveness_inactive",
        "delegation_attempt_matches", "resolution_reason_present", "evidence_present",
      ];
    default:
      return [];
  }
}

function freezeRule(rule: GoalTodoTransitionRule): GoalTodoTransitionRule {
  return Object.freeze({ ...rule, requiredGuards: Object.freeze([...rule.requiredGuards]) });
}

function buildRow(status: GoalTodoStatus): Readonly<Record<GoalTodoTransitionAction, GoalTodoTransitionRule>> {
  const row = {} as Record<GoalTodoTransitionAction, GoalTodoTransitionRule>;
  for (const action of GOAL_TODO_TRANSITION_ACTIONS) {
    const nextStatus = allowedNext[status][action];
    if (nextStatus) {
      row[action] = freezeRule({
        allowed: true,
        nextStatus,
        code: action === "no_op" || (nextStatus === status && action !== "update" && action !== "mark_delegation_failed") ? "idempotent_noop" : "transition_allowed",
        requiredGuards: requiredGuardsFor(status, action),
      });
    } else {
      row[action] = freezeRule({
        allowed: false,
        code: status === "done" || status === "skipped" ? "terminal_status" : "invalid_transition",
        requiredGuards: [],
      });
    }
  }
  return Object.freeze(row);
}

export const GOAL_TODO_TRANSITION_TABLE: GoalTodoTransitionTable = Object.freeze({
  planned: buildRow("planned"),
  ready: buildRow("ready"),
  in_progress: buildRow("in_progress"),
  delegated: buildRow("delegated"),
  claim_returned: buildRow("claim_returned"),
  needs_review: buildRow("needs_review"),
  needs_oracle: buildRow("needs_oracle"),
  needs_user: buildRow("needs_user"),
  blocked: buildRow("blocked"),
  done: buildRow("done"),
  skipped: buildRow("skipped"),
});

function isGoalTodoStatus(value: string): value is GoalTodoStatus {
  return (GOAL_TODO_STATUSES as readonly string[]).includes(value);
}

function isGoalTodoTransitionAction(value: string): value is GoalTodoTransitionAction {
  return (GOAL_TODO_TRANSITION_ACTIONS as readonly string[]).includes(value);
}

function strictOracleValidationPasses(context: GoalTodoTransitionContext): boolean {
  return context.validationStatus === "passed"
    && context.validationVerdict === "PASS"
    && context.validationRecommendedAction === "accept_claim"
    && (context.validationConfidence === "MEDIUM" || context.validationConfidence === "HIGH")
    && context.validationNoShip === false
    && context.validationHasBlockingIssues === false;
}

function claimHashMatches(context: GoalTodoTransitionContext): boolean {
  if (context.claimHashMatches !== undefined) return context.claimHashMatches;
  return typeof context.claimHash === "string"
    && /^[a-f0-9]{64}$/i.test(context.claimHash)
    && context.claimHash === context.expectedClaimHash;
}

function claimRevisionMatches(context: GoalTodoTransitionContext): boolean {
  if (context.claimRevisionMatches !== undefined) return context.claimRevisionMatches;
  return Number.isSafeInteger(context.claimRevision)
    && Number.isSafeInteger(context.expectedClaimRevision)
    && context.claimRevision! >= 0
    && context.claimRevision === context.expectedClaimRevision;
}

function guardPasses(status: GoalTodoStatus, guard: GoalTodoTransitionGuard, context: GoalTodoTransitionContext): boolean {
  switch (guard) {
    case "update_status_preserved": return context.requestedStatus === undefined || context.requestedStatus === status;
    case "delegation_absent_or_inactive": return !context.delegationStatus || !ACTIVE_DELEGATIONS.has(context.delegationStatus);
    case "delegation_recovery_not_required": return !context.delegationStatus || !RECOVERY_PENDING_DELEGATIONS.has(context.delegationStatus);
    case "delegation_absent": return context.delegationStatus === undefined;
    case "claim_absent": return context.hasClaim !== true;
    case "delegation_returnable": return !!context.delegationStatus && RETURNABLE_DELEGATIONS.has(context.delegationStatus);
    case "delegation_claim_returned": return context.delegationStatus === "claim_returned";
    case "delegation_recoverable": return !!context.delegationStatus && RECOVERY_PENDING_DELEGATIONS.has(context.delegationStatus);
    case "delegation_not_live": return context.delegationLiveness !== "live";
    case "delegation_liveness_inactive": return context.delegationLiveness === "inactive";
    case "delegation_attempt_matches": return context.delegationAttemptMatches === true;
    case "delegation_failure_context_present": return context.hasFailureContext === true;
    case "claim_present": return context.hasClaim === true;
    case "claim_gate_passed": return context.claimGatePassed === true;
    case "child_status_present": return !!context.childGoalStatus && CHILD_STATUSES.has(context.childGoalStatus);
    case "child_ready_for_oracle": return context.childGoalStatus === "ready_for_oracle";
    case "status_claim_present": return !!context.statusClaim && STATUS_CLAIMS.has(context.statusClaim);
    case "child_claims_done": return context.statusClaim === "done";
    case "target_readiness_present": return !!context.targetReadiness && TARGET_READINESS.has(context.targetReadiness);
    case "target_ready_for_parent_acceptance": return context.targetReadiness === "ready_for_parent_acceptance";
    case "acceptance_blockers_absent": return context.hasAcceptanceBlockers === false;
    case "no_ship_clear": return context.noShip !== true;
    case "child_no_ship_false": return context.noShip === false;
    case "resolution_evidence_present": return context.evidenceRequired !== true || context.hasEvidence === true;
    case "evidence_present": return context.hasEvidence === true;
    case "resolution_reason_present": return context.hasReason === true;
    case "validation_policy_present": return context.validationPolicy === "parent_review" || context.validationPolicy === "oracle_required";
    case "claim_binding_present": return context.claimBindingPresent === true;
    case "claim_attempt_matches": return context.claimAttemptMatches === true;
    case "claim_goal_revision_matches": return context.claimGoalRevisionMatches === true;
    case "claim_graph_revision_matches": return context.claimGraphRevisionMatches === true;
    case "claim_policy_matches": return context.claimPolicyMatches === true;
    case "validation_binding_matches": return context.validationPolicy === "parent_review" || context.validationBindingMatches === true;
    case "acceptance_policy_satisfied":
      return context.validationPolicy === "parent_review" ? status === "claim_returned" : context.validationPolicy === "oracle_required" && strictOracleValidationPasses(context);
    case "claim_hash_matches": return claimHashMatches(context);
    case "claim_revision_matches": return claimRevisionMatches(context);
    case "user_resolved": return context.userResolved === true;
    case "cas_bound": return context.casBound === true;
    case "reopen_clears_delegation": return context.clearDelegationOnReopen === true;
  }
}

const GUARD_FAILURE_CODES: Record<GoalTodoTransitionGuard, GoalTodoTransitionCode> = {
  update_status_preserved: "status_patch_forbidden",
  delegation_absent_or_inactive: "active_delegation",
  delegation_recovery_not_required: "delegation_recovery_required",
  delegation_absent: "delegation_must_be_absent",
  claim_absent: "claim_must_be_cleared",
  delegation_returnable: "delegation_not_returnable",
  delegation_claim_returned: "claim_delegation_not_returned",
  delegation_recoverable: "delegation_not_recoverable",
  delegation_not_live: "active_delegation",
  delegation_liveness_inactive: "delegation_liveness_unknown",
  delegation_attempt_matches: "delegation_attempt_mismatch",
  delegation_failure_context_present: "delegation_failure_context_required",
  claim_present: "claim_required",
  claim_gate_passed: "claim_gate_not_passed",
  child_status_present: "child_status_required",
  child_ready_for_oracle: "child_status_not_ready",
  status_claim_present: "status_claim_required",
  child_claims_done: "child_status_claim_not_done",
  target_readiness_present: "target_readiness_required",
  target_ready_for_parent_acceptance: "target_not_ready",
  acceptance_blockers_absent: "acceptance_blockers_present",
  no_ship_clear: "no_ship_blocked",
  child_no_ship_false: "no_ship_blocked",
  resolution_evidence_present: "evidence_required",
  evidence_present: "evidence_required",
  resolution_reason_present: "reason_required",
  validation_policy_present: "validation_policy_required",
  claim_binding_present: "legacy_claim_binding_required",
  claim_attempt_matches: "claim_attempt_mismatch",
  claim_goal_revision_matches: "claim_goal_revision_mismatch",
  claim_graph_revision_matches: "claim_graph_revision_mismatch",
  claim_policy_matches: "claim_policy_mismatch",
  validation_binding_matches: "claim_validation_binding_mismatch",
  acceptance_policy_satisfied: "claim_validation_not_acceptable",
  claim_hash_matches: "claim_hash_mismatch",
  claim_revision_matches: "claim_revision_mismatch",
  user_resolved: "user_resolution_required",
  cas_bound: "cas_required",
  reopen_clears_delegation: "reopen_reset_required",
};

function firstFailedGuard(status: GoalTodoStatus, rule: GoalTodoTransitionRule, context: GoalTodoTransitionContext): GoalTodoTransitionGuard | undefined {
  return rule.requiredGuards.find((guard) => !guardPasses(status, guard, context));
}

function safeNextActions(status: GoalTodoStatus, context: GoalTodoTransitionContext): readonly GoalTodoTransitionAction[] {
  return Object.freeze(GOAL_TODO_TRANSITION_ACTIONS.filter((action) => {
    const rule = GOAL_TODO_TRANSITION_TABLE[status][action];
    return rule.allowed && !firstFailedGuard(status, rule, context);
  }));
}

export function getGoalTodoTransitionRule(currentStatus: string, action: string): GoalTodoTransitionRule | undefined {
  if (!isGoalTodoStatus(currentStatus) || !isGoalTodoTransitionAction(action)) return undefined;
  return GOAL_TODO_TRANSITION_TABLE[currentStatus][action];
}

export function listGoalTodoTransitionRules(): readonly GoalTodoTransitionRuleDiagnostic[] {
  return Object.freeze(GOAL_TODO_STATUSES.flatMap((currentStatus) =>
    GOAL_TODO_TRANSITION_ACTIONS.map((action) => Object.freeze({
      currentStatus,
      action,
      ...GOAL_TODO_TRANSITION_TABLE[currentStatus][action],
      requiredGuards: Object.freeze([...GOAL_TODO_TRANSITION_TABLE[currentStatus][action].requiredGuards]),
    })),
  ));
}

export function decideGoalTodoTransition(input: GoalTodoTransitionInput): GoalTodoTransitionDecision {
  const { currentStatus, action } = input;
  const context = input.context ?? {};
  if (!isGoalTodoStatus(currentStatus)) {
    return { allowed: false, code: "unknown_status", currentStatus, action, requiredGuards: [], retryPolicy: "never", safeNextActions: [] };
  }
  if (!isGoalTodoTransitionAction(action)) {
    return { allowed: false, code: "unknown_action", currentStatus, action, requiredGuards: [], retryPolicy: "never", safeNextActions: [] };
  }

  const rule = GOAL_TODO_TRANSITION_TABLE[currentStatus][action];
  const safeActions = safeNextActions(currentStatus, context);
  if (!rule.allowed) {
    return {
      allowed: false,
      code: rule.code,
      currentStatus,
      action,
      requiredGuards: rule.requiredGuards,
      retryPolicy: "never",
      safeNextActions: safeActions,
    };
  }

  const failedGuard = firstFailedGuard(currentStatus, rule, context);
  if (failedGuard) {
    return {
      allowed: false,
      code: GUARD_FAILURE_CODES[failedGuard],
      currentStatus,
      action,
      requiredGuards: rule.requiredGuards,
      retryPolicy: "after_context_change",
      safeNextActions: safeActions,
    };
  }

  return {
    allowed: true,
    nextStatus: rule.nextStatus,
    code: rule.code,
    currentStatus,
    action,
    requiredGuards: rule.requiredGuards,
    retryPolicy: rule.code === "idempotent_noop" ? "idempotent" : "none",
    safeNextActions: safeActions,
  };
}
