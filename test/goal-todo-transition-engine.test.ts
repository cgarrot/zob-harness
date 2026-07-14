import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  GOAL_TODO_STATUSES,
  GOAL_TODO_TRANSITION_ACTIONS,
  GOAL_TODO_TRANSITION_TABLE,
  decideGoalTodoTransition,
  getGoalTodoTransitionRule,
  listGoalTodoTransitionRules,
} from "../.pi/extensions/zob-harness/index.ts";
import type {
  GoalTodoStatus,
  GoalTodoTransitionAction,
  GoalTodoTransitionContext,
} from "../.pi/extensions/zob-harness/index.ts";

const expectedAllowed: Record<GoalTodoStatus, Partial<Record<GoalTodoTransitionAction, GoalTodoStatus>>> = {
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

function canonicalClaimContext(): GoalTodoTransitionContext {
  return {
    delegationStatus: "claim_returned",
    hasClaim: true,
    claimGatePassed: true,
    childGoalStatus: "ready_for_oracle",
    statusClaim: "done",
    targetReadiness: "ready_for_parent_acceptance",
    hasAcceptanceBlockers: false,
    noShip: false,
    hasEvidence: true,
    hasReason: true,
    validationPolicy: "parent_review",
    claimHashMatches: true,
    claimRevisionMatches: true,
  };
}

function strictOracleContext(): GoalTodoTransitionContext {
  return {
    ...canonicalClaimContext(),
    validationPolicy: "oracle_required",
    validationStatus: "passed",
    validationVerdict: "PASS",
    validationRecommendedAction: "accept_claim",
    validationConfidence: "HIGH",
    validationNoShip: false,
    validationHasBlockingIssues: false,
  };
}

function satisfiedContext(status: GoalTodoStatus, action: GoalTodoTransitionAction): GoalTodoTransitionContext {
  const claimContext = canonicalClaimContext();
  if (action === "return_claim") return { ...claimContext, delegationStatus: "running" };
  if (action === "mark_delegation_failed") return { delegationStatus: "queued", delegationAttemptMatches: true, hasClaim: false, hasFailureContext: true };
  if (action === "recover_delegation") {
    return {
      delegationStatus: "failed",
      delegationLiveness: "inactive",
      delegationAttemptMatches: true,
      hasEvidence: true,
      hasReason: true,
    };
  }
  if (action === "accept_claim") return status === "needs_oracle" ? strictOracleContext() : claimContext;
  if (action === "reject_claim" || (action === "mark_needs_oracle" && ["claim_returned", "needs_review"].includes(status)) || (action === "block" && ["claim_returned", "needs_review", "needs_oracle"].includes(status))) return claimContext;
  return {
    required: true,
    evidenceRequired: false,
    hasEvidence: true,
    hasReason: true,
    noShip: false,
    userResolved: status === "needs_user",
    casBound: status === "done" || status === "skipped",
    clearDelegationOnReopen: true,
  };
}

test("transition table exhaustively covers every canonical status x action combination", () => {
  assert.equal(GOAL_TODO_STATUSES.length, 11);
  assert.equal(GOAL_TODO_TRANSITION_ACTIONS.length, 17);
  assert.equal(listGoalTodoTransitionRules().length, GOAL_TODO_STATUSES.length * GOAL_TODO_TRANSITION_ACTIONS.length);

  for (const status of GOAL_TODO_STATUSES) {
    assert.deepEqual(Object.keys(GOAL_TODO_TRANSITION_TABLE[status]).sort(), [...GOAL_TODO_TRANSITION_ACTIONS].sort());
    for (const action of GOAL_TODO_TRANSITION_ACTIONS) {
      const expected = expectedAllowed[status][action];
      const rule = getGoalTodoTransitionRule(status, action);
      assert.ok(rule, `${status} x ${action} has an introspection rule`);
      const decision = decideGoalTodoTransition({ currentStatus: status, action, context: satisfiedContext(status, action) });
      assert.equal(decision.currentStatus, status);
      assert.equal(decision.action, action);
      if (expected) {
        assert.equal(decision.allowed, true, `${status} x ${action} is allowed`);
        assert.equal(decision.nextStatus, expected);
        assert.ok(["transition_allowed", "idempotent_noop"].includes(decision.code));
      } else {
        assert.equal(decision.allowed, false, `${status} x ${action} fails closed`);
        assert.equal(decision.nextStatus, undefined);
        assert.ok(["invalid_transition", "terminal_status"].includes(decision.code));
      }
      assert.ok(Array.isArray(decision.requiredGuards));
      assert.ok(Array.isArray(decision.safeNextActions));
      assert.equal(typeof decision.retryPolicy, "string");
    }
  }
});

test("mark_delegation_failed is status-preserving and fail-closed on source, attempt, claim, and failure context", () => {
  for (const delegationStatus of ["queued", "running"] as const) {
    const decision = decideGoalTodoTransition({
      currentStatus: "delegated",
      action: "mark_delegation_failed",
      context: { delegationStatus, delegationAttemptMatches: true, hasClaim: false, hasFailureContext: true },
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.nextStatus, "delegated");
    assert.equal(decision.code, "transition_allowed");
  }
  const base: GoalTodoTransitionContext = { delegationStatus: "queued", delegationAttemptMatches: true, hasClaim: false, hasFailureContext: true };
  assert.equal(decideGoalTodoTransition({ currentStatus: "ready", action: "mark_delegation_failed", context: base }).code, "invalid_transition");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "mark_delegation_failed", context: { ...base, delegationStatus: "failed" } }).code, "delegation_not_returnable");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "mark_delegation_failed", context: { ...base, delegationAttemptMatches: false } }).code, "delegation_attempt_mismatch");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "mark_delegation_failed", context: { ...base, hasClaim: true } }).code, "claim_must_be_cleared");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "mark_delegation_failed", context: { ...base, hasFailureContext: false } }).code, "delegation_failure_context_required");
});

test("return_claim accepts only the full canonical done contract", () => {
  const complete = satisfiedContext("delegated", "return_claim");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "return_claim", context: complete }).allowed, true);

  const failures: Array<[Partial<GoalTodoTransitionContext>, string]> = [
    [{ delegationStatus: "failed" }, "delegation_not_returnable"],
    [{ claimGatePassed: false }, "claim_gate_not_passed"],
    [{ childGoalStatus: undefined }, "child_status_required"],
    [{ childGoalStatus: "incomplete" }, "child_status_not_ready"],
    [{ statusClaim: undefined }, "status_claim_required"],
    [{ statusClaim: "incomplete" }, "child_status_claim_not_done"],
    [{ targetReadiness: undefined }, "target_readiness_required"],
    [{ targetReadiness: "needs_parent_review" }, "target_not_ready"],
    [{ hasAcceptanceBlockers: true }, "acceptance_blockers_present"],
    [{ noShip: true }, "no_ship_blocked"],
    [{ hasEvidence: false }, "evidence_required"],
  ];
  for (const [patch, code] of failures) {
    assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "return_claim", context: { ...complete, ...patch } }).code, code);
  }
});

test("claim acceptance requires exact policy, canonical claim, evidence, hash, and revision binding", () => {
  const parentReview = canonicalClaimContext();
  const accepted = decideGoalTodoTransition({ currentStatus: "claim_returned", action: "accept_claim", context: parentReview });
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.nextStatus, "done");
  assert.deepEqual(accepted.requiredGuards, [
    "delegation_claim_returned", "claim_present", "claim_gate_passed", "child_status_present", "child_ready_for_oracle",
    "status_claim_present", "child_claims_done", "target_readiness_present", "target_ready_for_parent_acceptance", "acceptance_blockers_absent",
    "child_no_ship_false", "evidence_present", "validation_policy_present",
    "acceptance_policy_satisfied", "claim_hash_matches", "claim_revision_matches",
  ]);

  assert.equal(decideGoalTodoTransition({ currentStatus: "claim_returned", action: "accept_claim", context: { ...parentReview, validationPolicy: undefined } }).code, "validation_policy_required");
  assert.equal(decideGoalTodoTransition({ currentStatus: "claim_returned", action: "accept_claim", context: { ...parentReview, claimHashMatches: false } }).code, "claim_hash_mismatch");
  assert.equal(decideGoalTodoTransition({ currentStatus: "claim_returned", action: "accept_claim", context: { ...parentReview, claimRevisionMatches: false } }).code, "claim_revision_mismatch");
  const rawBinding = {
    ...parentReview,
    claimHashMatches: undefined,
    claimRevisionMatches: undefined,
    claimHash: "a".repeat(64),
    expectedClaimHash: "a".repeat(64),
    claimRevision: 4,
    expectedClaimRevision: 4,
  };
  assert.equal(decideGoalTodoTransition({ currentStatus: "claim_returned", action: "accept_claim", context: rawBinding }).allowed, true);
  assert.equal(decideGoalTodoTransition({ currentStatus: "claim_returned", action: "accept_claim", context: { ...rawBinding, expectedClaimHash: "b".repeat(64) } }).code, "claim_hash_mismatch");
  assert.equal(decideGoalTodoTransition({ currentStatus: "needs_review", action: "accept_claim", context: parentReview }).code, "invalid_transition");
});

test("needs_oracle and oracle-required claim_returned acceptance require strict passed oracle validation", () => {
  const strict = strictOracleContext();
  assert.equal(decideGoalTodoTransition({ currentStatus: "needs_oracle", action: "accept_claim", context: strict }).allowed, true);
  assert.equal(decideGoalTodoTransition({ currentStatus: "claim_returned", action: "accept_claim", context: strict }).allowed, true);
  assert.equal(decideGoalTodoTransition({ currentStatus: "needs_oracle", action: "accept_claim", context: canonicalClaimContext() }).code, "claim_validation_not_acceptable");

  for (const patch of [
    { validationStatus: "warn" as const },
    { validationVerdict: "WARN" as const },
    { validationRecommendedAction: "needs_review" as const },
    { validationConfidence: "LOW" as const },
    { validationNoShip: true },
    { validationHasBlockingIssues: true },
  ]) {
    assert.equal(decideGoalTodoTransition({ currentStatus: "needs_oracle", action: "accept_claim", context: { ...strict, ...patch } }).code, "claim_validation_not_acceptable");
  }
});

test("normal resolution uses only caller-derived evidence policy and blocks active or recovery-pending delegation", () => {
  assert.equal(decideGoalTodoTransition({ currentStatus: "in_progress", action: "complete", context: { required: true, critical: true, evidenceRequired: false, hasEvidence: false } }).allowed, true);
  assert.equal(decideGoalTodoTransition({ currentStatus: "in_progress", action: "complete", context: { evidenceRequired: true, hasEvidence: false } }).code, "evidence_required");
  assert.equal(decideGoalTodoTransition({ currentStatus: "ready", action: "skip", context: { required: true, evidenceRequired: false, hasEvidence: false, hasReason: true } }).allowed, true);
  assert.equal(decideGoalTodoTransition({ currentStatus: "ready", action: "skip", context: { evidenceRequired: true, hasEvidence: false, hasReason: true } }).code, "evidence_required");
  assert.equal(decideGoalTodoTransition({ currentStatus: "in_progress", action: "complete", context: { noShip: true } }).code, "no_ship_blocked");
  assert.equal(decideGoalTodoTransition({ currentStatus: "ready", action: "block", context: {} }).code, "reason_required");

  for (const delegationStatus of ["queued", "running", "claim_returned"] as const) {
    assert.equal(decideGoalTodoTransition({ currentStatus: "in_progress", action: "complete", context: { delegationStatus } }).code, "active_delegation");
  }
  for (const delegationStatus of ["failed", "rejected", "unknown"] as const) {
    for (const action of ["complete", "skip", "queue_delegation"] as const) {
      const context = action === "skip" ? { delegationStatus, hasReason: true } : { delegationStatus };
      assert.equal(decideGoalTodoTransition({ currentStatus: "ready", action, context }).code, "delegation_recovery_required");
    }
  }
  assert.equal(decideGoalTodoTransition({ currentStatus: "needs_review", action: "complete", context: canonicalClaimContext() }).code, "invalid_transition");
  assert.equal(decideGoalTodoTransition({ currentStatus: "needs_oracle", action: "complete", context: strictOracleContext() }).code, "invalid_transition");
});

test("claim reject and block paths require a canonical returned claim and reason", () => {
  for (const status of ["claim_returned", "needs_review", "needs_oracle"] as const) {
    const claim = canonicalClaimContext();
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "reject_claim", context: claim }).allowed, true);
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "block", context: claim }).allowed, true);
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "reject_claim", context: { ...claim, hasClaim: false } }).code, "claim_required");
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "block", context: { ...claim, hasReason: false } }).code, "reason_required");
  }
});

test("blocked resolution requires no delegation or claim plus reason and proof", () => {
  const proof = { hasReason: true, hasEvidence: true };
  assert.equal(decideGoalTodoTransition({ currentStatus: "blocked", action: "reopen", context: proof }).nextStatus, "ready");
  assert.equal(decideGoalTodoTransition({ currentStatus: "blocked", action: "skip", context: proof }).nextStatus, "skipped");
  assert.equal(decideGoalTodoTransition({ currentStatus: "blocked", action: "reopen", context: { ...proof, delegationStatus: "rejected" } }).code, "delegation_must_be_absent");
  assert.equal(decideGoalTodoTransition({ currentStatus: "blocked", action: "skip", context: { ...proof, hasClaim: true } }).code, "claim_must_be_cleared");
  assert.equal(decideGoalTodoTransition({ currentStatus: "blocked", action: "reopen", context: { hasEvidence: true } }).code, "reason_required");
  assert.equal(decideGoalTodoTransition({ currentStatus: "blocked", action: "reopen", context: { hasReason: true } }).code, "evidence_required");
});

test("explicit delegation recovery is fail-closed on status, liveness, attempt, reason, and proof", () => {
  for (const delegationStatus of ["failed", "rejected", "unknown"] as const) {
    const recovered = decideGoalTodoTransition({
      currentStatus: delegationStatus === "rejected" ? "blocked" : "delegated",
      action: "recover_delegation",
      context: { delegationStatus, delegationLiveness: "inactive", delegationAttemptMatches: true, hasReason: true, hasEvidence: true },
    });
    assert.equal(recovered.allowed, true);
    assert.equal(recovered.nextStatus, "ready");
  }
  const base: GoalTodoTransitionContext = { delegationStatus: "failed", delegationLiveness: "inactive", delegationAttemptMatches: true, hasReason: true, hasEvidence: true };
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "recover_delegation", context: { ...base, delegationStatus: "running" } }).code, "delegation_not_recoverable");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "recover_delegation", context: { ...base, delegationLiveness: "live" } }).code, "active_delegation");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "recover_delegation", context: { ...base, delegationLiveness: "unknown" } }).code, "delegation_liveness_unknown");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "recover_delegation", context: { ...base, delegationAttemptMatches: false } }).code, "delegation_attempt_mismatch");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "recover_delegation", context: { ...base, hasReason: false } }).code, "reason_required");
  assert.equal(decideGoalTodoTransition({ currentStatus: "delegated", action: "recover_delegation", context: { ...base, hasEvidence: false } }).code, "evidence_required");
});

test("done/skipped remain terminal except CAS-bound reopen that clears old delegation and claim metadata", () => {
  for (const status of ["done", "skipped"] as const) {
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "complete", context: {} }).code, "terminal_status");
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "block", context: { hasReason: true } }).code, "terminal_status");
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "reopen", context: {} }).code, "cas_required");
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "reopen", context: { casBound: true, hasReason: true, hasEvidence: true } }).code, "reopen_reset_required");
    const reopened = decideGoalTodoTransition({
      currentStatus: status,
      action: "reopen",
      context: { casBound: true, hasReason: true, hasEvidence: true, delegationStatus: "accepted", hasClaim: true, clearDelegationOnReopen: true },
    });
    assert.equal(reopened.allowed, true);
    assert.equal(reopened.nextStatus, "ready");
  }
});

test("metadata update is status-preserving and target-policy deltas reject current unsafe operation bypasses", () => {
  for (const status of GOAL_TODO_STATUSES) {
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "update", context: {} }).nextStatus, status);
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "update", context: { requestedStatus: status } }).allowed, true);
    const different = status === "done" ? "ready" : "done";
    assert.equal(decideGoalTodoTransition({ currentStatus: status, action: "update", context: { requestedStatus: different } }).code, "status_patch_forbidden");
  }

  assert.equal(decideGoalTodoTransition({ currentStatus: "done", action: "block", context: { hasReason: true } }).code, "terminal_status", "terminal block is rejected");
  assert.equal(decideGoalTodoTransition({ currentStatus: "needs_review", action: "accept_claim", context: canonicalClaimContext() }).code, "invalid_transition", "needs_review never accepts directly");
  assert.equal(decideGoalTodoTransition({ currentStatus: "blocked", action: "reopen", context: { delegationStatus: "rejected", hasReason: true, hasEvidence: true } }).code, "delegation_must_be_absent", "unsafe reopen cannot revive delegation");
  assert.equal(decideGoalTodoTransition({ currentStatus: "claim_returned", action: "reject_claim", context: { delegationStatus: "claim_returned", hasClaim: false, hasReason: true } }).code, "claim_required", "reject requires a canonical claim");
  assert.equal(decideGoalTodoTransition({ currentStatus: "ready", action: "skip", context: { required: true, evidenceRequired: false, hasReason: true, hasEvidence: false } }).allowed, true, "required normal skip remains compatible when evidence policy is false");
});

test("unknown statuses and actions are rejected without trimming, case folding, or coercion", () => {
  assert.equal(decideGoalTodoTransition({ currentStatus: " ready", action: "start", context: {} }).code, "unknown_status");
  assert.equal(decideGoalTodoTransition({ currentStatus: "ready", action: "START", context: {} }).code, "unknown_action");
  assert.equal(getGoalTodoTransitionRule("ready ", "start"), undefined);
});
