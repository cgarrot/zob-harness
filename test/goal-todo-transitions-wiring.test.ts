import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GOAL_TODO_STATUSES,
  GOAL_TODO_TRANSITION_ACTIONS,
  GoalTodoTransitionError,
  acceptGoalTodoClaim,
  addGoalTodo,
  authorizeGoalTodoTransition,
  blockGoalTodo,
  completeGoalTodo,
  createHarnessRuntimeState,
  decideGoalTodoTransition,
  linkGoalTodoDelegation,
  markGoalTodoDelegationFailed,
  patchGoalTodo,
  recordGoalTodoClaimValidationResult,
  reduceGoalRoomEventToTodoDecision,
  requestGoalTodoClaimValidation,
  resolveGoalTodo,
  restoreGoalTodosFromBranch,
  returnGoalTodoClaim,
} from "../.pi/extensions/zob-harness/index.ts";
import type {
  GoalTodoNode,
  GoalTodoStatus,
  GoalTodoTransitionAction,
  GoalTodoTransitionContext,
} from "../.pi/extensions/zob-harness/index.ts";

const GOAL_ID = "goal-transition-wiring";
const CLAIM_HASH = "c".repeat(64);
const OUTPUT_HASH = "d".repeat(64);

type Entry = { customType: string; data: unknown };

function capture() {
  const entries: Entry[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, entries, state: createHarnessRuntimeState() };
}

function add(pi: ExtensionAPI, state: ReturnType<typeof createHarnessRuntimeState>, status: GoalTodoStatus = "ready", overrides: Partial<GoalTodoNode> = {}) {
  const created = addGoalTodo(pi, state, GOAL_ID, {
    title: `transition ${status}`,
    status,
    priority: overrides.priority,
    owner: overrides.owner,
    evidenceRefs: overrides.evidenceRefs,
    validationCommands: overrides.validationCommands,
  });
  const canonical = state.goalTodos.nodes.find((node) => node.id === created.id)!;
  Object.assign(canonical, overrides);
  return canonical;
}

function returnCanonicalClaim(pi: ExtensionAPI, state: ReturnType<typeof createHarnessRuntimeState>, node: GoalTodoNode, validationPolicy: "parent_review" | "oracle_required" = "parent_review"): GoalTodoNode {
  linkGoalTodoDelegation(pi, state, GOAL_ID, node.id, { runId: `run-${node.id}`, status: "running", delegationDepth: 1, validationPolicy });
  returnGoalTodoClaim(pi, state, GOAL_ID, node.id, {
    claimHash: CLAIM_HASH,
    outputHash: OUTPUT_HASH,
    outputContract: "todo-child-result.v2",
    gatePassed: true,
    childGoalStatus: "ready_for_oracle",
    statusClaim: "done",
    targetReadiness: "ready_for_parent_acceptance",
    acceptanceBlockers: [],
    evidenceRefs: ["test/goal-todo-transitions-wiring.test.ts"],
    validationCommands: ["node --test"],
    noShip: false,
  });
  return state.goalTodos.nodes.find((candidate) => candidate.id === node.id)!;
}

function exactClaimBinding(state: ReturnType<typeof createHarnessRuntimeState>, node: GoalTodoNode) {
  const current = state.goalTodos.nodes.find((candidate) => candidate.id === node.id)!;
  assert.ok(current.claim?.claimHash && current.claim.attemptId && current.claim.validationPolicy);
  return {
    expectedClaimHash: current.claim.claimHash,
    expectedAttemptId: current.claim.attemptId,
    expectedValidationPolicy: current.claim.validationPolicy,
    expectedGraphRevision: state.goalTodos.graphRevisions[GOAL_ID],
    expectedTodoRevision: current.revision ?? 0,
  };
}

function expectTransitionCode(fn: () => unknown, code: string): GoalTodoTransitionError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof GoalTodoTransitionError, `expected GoalTodoTransitionError, received ${String(caught)}`);
  assert.equal(caught.diagnostic.code, code);
  assert.equal(caught.diagnostic.schema, "zob.goal-todo-transition-diagnostic.v1");
  assert.equal(typeof caught.diagnostic.current, "string");
  assert.equal(typeof caught.diagnostic.action, "string");
  assert.ok(Array.isArray(caught.diagnostic.safe_next_actions));
  assert.match(caught.message, /code=.* current=.* action=.* safe_next_actions=/);
  return caught;
}

function emptyDerivedContext(status: GoalTodoStatus, action: GoalTodoTransitionAction): GoalTodoTransitionContext {
  return {
    requestedStatus: action === "update" ? undefined : undefined,
    delegationStatus: undefined,
    delegationLiveness: undefined,
    delegationAttemptMatches: undefined,
    hasClaim: false,
    claimGatePassed: undefined,
    childGoalStatus: undefined,
    statusClaim: undefined,
    targetReadiness: undefined,
    hasAcceptanceBlockers: undefined,
    noShip: undefined,
    evidenceRequired: false,
    critical: false,
    required: true,
    hasEvidence: false,
    hasReason: false,
    validationPolicy: "parent_review",
    claimRevision: 0,
  };
}

test("operation authorization helper is exhaustive and diagnostic-parity exact with the transition engine", () => {
  for (const status of GOAL_TODO_STATUSES) {
    const node = {
      id: `todo-${status}`,
      goalId: GOAL_ID,
      path: "1",
      depth: 1,
      title: status,
      status,
      owner: "agent",
      required: true,
      priority: "normal",
      acceptanceCriteria: [],
      evidenceRefs: [],
      validationCommands: [],
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    } satisfies GoalTodoNode;
    for (const action of GOAL_TODO_TRANSITION_ACTIONS) {
      const expected = decideGoalTodoTransition({ currentStatus: status, action, context: emptyDerivedContext(status, action) });
      try {
        const authorization = authorizeGoalTodoTransition(node, action);
        assert.equal(expected.allowed, true, `${status} x ${action}`);
        assert.equal(authorization.decision.code, expected.code);
        assert.deepEqual(authorization.diagnostic.safe_next_actions, expected.safeNextActions);
      } catch (error) {
        assert.ok(error instanceof GoalTodoTransitionError, `${status} x ${action}`);
        assert.equal(expected.allowed, false, `${status} x ${action}`);
        assert.equal(error.diagnostic.code, expected.code);
        assert.deepEqual(error.diagnostic.safe_next_actions, expected.safeNextActions);
      }
    }
  }
});

test("raw patch is metadata-only; status and review no_ship changes require a current canonical authorization", () => {
  const { pi, state } = capture();
  const node = add(pi, state, "ready");
  const metadata = patchGoalTodo(pi, state, GOAL_ID, node.id, { title: "metadata preserved" });
  assert.equal(metadata.status, "ready");
  expectTransitionCode(() => patchGoalTodo(pi, state, GOAL_ID, node.id, { status: "done" }), "status_patch_forbidden");

  const current = state.goalTodos.nodes.find((candidate) => candidate.id === node.id)!;
  const authorization = authorizeGoalTodoTransition(current, "start");
  const started = patchGoalTodo(pi, state, GOAL_ID, node.id, { status: "in_progress" }, "tool", authorization);
  assert.equal(started.status, "in_progress");

  const blocked = blockGoalTodo(pi, state, GOAL_ID, node.id, "bounded blocker");
  expectTransitionCode(() => patchGoalTodo(pi, state, GOAL_ID, blocked.id, { reviewNoShip: undefined }), "status_patch_forbidden");
});

test("complete, block, and skip use engine policy and exact critical/delegated evidence semantics", () => {
  const { pi, state } = capture();
  for (const status of ["planned", "ready", "in_progress"] as const) {
    const normal = add(pi, state, status);
    assert.equal(completeGoalTodo(pi, state, GOAL_ID, normal.id).status, "done");
  }

  const critical = add(pi, state, "ready", { priority: "critical" });
  expectTransitionCode(() => completeGoalTodo(pi, state, GOAL_ID, critical.id), "evidence_required");
  assert.equal(completeGoalTodo(pi, state, GOAL_ID, critical.id, { evidenceRefs: ["test/goal-todo-transitions-wiring.test.ts"] }).status, "done");

  const terminal = add(pi, state, "done");
  assert.equal(completeGoalTodo(pi, state, GOAL_ID, terminal.id).status, "done", "done remains idempotent");
  expectTransitionCode(() => blockGoalTodo(pi, state, GOAL_ID, terminal.id, "must fail"), "terminal_status");

  const skip = add(pi, state, "ready");
  expectTransitionCode(() => completeGoalTodo(pi, state, GOAL_ID, skip.id, { skipped: true }), "reason_required");
  assert.equal(completeGoalTodo(pi, state, GOAL_ID, skip.id, { skipped: true, reason: "not required for this run" }).status, "skipped");
});

test("dedicated delegation failure marks only the exact queued/running attempt and preserves delegated node state", () => {
  const failureHash = "f".repeat(64);
  for (const status of ["queued", "running"] as const) {
    const { pi, state, entries } = capture();
    const node = add(pi, state);
    const runId = `run-${status}`;
    const requestId = `request-${status}`;
    linkGoalTodoDelegation(pi, state, GOAL_ID, node.id, { runId, requestId, status, delegationDepth: 1 });
    const failed = markGoalTodoDelegationFailed(pi, state, GOAL_ID, node.id, { runId, requestId, failureHash });
    assert.equal(failed.status, "delegated");
    assert.equal(failed.owner, "subagent");
    assert.equal(failed.delegation?.status, "failed");
    assert.equal(failed.delegation?.runId, runId);
    assert.equal(failed.delegation?.requestId, requestId);
    assert.equal(failed.claim, undefined);
    const restored = restoreGoalTodosFromBranch(entries).nodes.find((candidate) => candidate.id === node.id)!;
    assert.equal(restored.status, "delegated");
    assert.equal(restored.delegation?.status, "failed");
  }

  const invalidSource = capture();
  const ready = add(invalidSource.pi, invalidSource.state);
  expectTransitionCode(() => markGoalTodoDelegationFailed(invalidSource.pi, invalidSource.state, GOAL_ID, ready.id, {
    runId: "missing-run", requestId: "missing-request", failureHash,
  }), "invalid_transition");

  const mismatch = capture();
  const queued = add(mismatch.pi, mismatch.state);
  linkGoalTodoDelegation(mismatch.pi, mismatch.state, GOAL_ID, queued.id, { runId: "exact-run", requestId: "exact-request", status: "queued" });
  const beforeMismatch = mismatch.entries.length;
  expectTransitionCode(() => markGoalTodoDelegationFailed(mismatch.pi, mismatch.state, GOAL_ID, queued.id, {
    runId: "wrong-run", requestId: "exact-request", failureHash,
  }), "delegation_attempt_mismatch");
  expectTransitionCode(() => markGoalTodoDelegationFailed(mismatch.pi, mismatch.state, GOAL_ID, queued.id, {
    runId: "exact-run", requestId: "wrong-request", failureHash,
  }), "delegation_attempt_mismatch");
  expectTransitionCode(() => markGoalTodoDelegationFailed(mismatch.pi, mismatch.state, GOAL_ID, queued.id, {
    runId: "exact-run", requestId: "exact-request", failureHash: "not-a-hash",
  }), "delegation_failure_context_required");
  assert.equal(mismatch.entries.length, beforeMismatch);
  assert.equal(mismatch.state.goalTodos.nodes.find((candidate) => candidate.id === queued.id)!.delegation?.status, "queued");

  const claimed = mismatch.state.goalTodos.nodes.find((candidate) => candidate.id === queued.id)!;
  claimed.claim = { claimHash: CLAIM_HASH, acceptanceBlockers: [], returnedAt: 1 };
  expectTransitionCode(() => markGoalTodoDelegationFailed(mismatch.pi, mismatch.state, GOAL_ID, queued.id, {
    runId: "exact-run", requestId: "exact-request", failureHash,
  }), "claim_must_be_cleared");
  assert.equal(claimed.delegation?.status, "queued");
});

test("only a full canonical child contract returns a claim; invalid output appends no event or accept-ready claim", () => {
  const { pi, state, entries } = capture();
  const node = add(pi, state);
  linkGoalTodoDelegation(pi, state, GOAL_ID, node.id, { runId: "run-invalid", status: "running" });
  const beforeEvents = entries.length;
  const beforeRevision = state.goalTodos.nodes.find((candidate) => candidate.id === node.id)!.revision;
  expectTransitionCode(() => returnGoalTodoClaim(pi, state, GOAL_ID, node.id, {
    claimHash: CLAIM_HASH,
    gatePassed: false,
    childGoalStatus: "incomplete",
    statusClaim: "incomplete",
    targetReadiness: "needs_parent_review",
    acceptanceBlockers: ["missing validation"],
    noShip: true,
  }), "claim_gate_not_passed");
  const unchanged = state.goalTodos.nodes.find((candidate) => candidate.id === node.id)!;
  assert.equal(unchanged.status, "delegated");
  assert.equal(unchanged.claim, undefined);
  assert.equal(unchanged.revision, beforeRevision);
  assert.equal(entries.length, beforeEvents);

  const goalRoomDecision = reduceGoalRoomEventToTodoDecision({
    schema: "zob.goal-room-message.v1",
    kind: "TODO_CLAIM",
    goalId: GOAL_ID,
    todoId: node.id,
    bodyHash: CLAIM_HASH,
    parentOwnedActions: true,
    workerToWorkerDirect: false,
    hiddenPeerChat: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    evidenceRefs: ["test/goal-todo-transitions-wiring.test.ts"],
    metadata: {},
  });
  assert.equal(goalRoomDecision.action, "ignore");
  assert.ok(goalRoomDecision.reasonCodes.includes("child_status_not_ready"));
  assert.ok(goalRoomDecision.reasonCodes.includes("no_ship_not_clear"));
});

test("claim acceptance enforces canonical gate, policy, exact bindings, oracle result, and needs_review hardening", () => {
  const parent = capture();
  const parentClaim = returnCanonicalClaim(parent.pi, parent.state, add(parent.pi, parent.state));
  assert.throws(() => acceptGoalTodoClaim(parent.pi, parent.state, GOAL_ID, parentClaim.id, {
    ...exactClaimBinding(parent.state, parentClaim),
    expectedClaimHash: "e".repeat(64),
  }), /claim hash mismatch/);
  assert.equal(acceptGoalTodoClaim(parent.pi, parent.state, GOAL_ID, parentClaim.id, exactClaimBinding(parent.state, parentClaim)).status, "done");

  const oracle = capture();
  let oracleClaim = returnCanonicalClaim(oracle.pi, oracle.state, add(oracle.pi, oracle.state), "oracle_required");
  oracleClaim = requestGoalTodoClaimValidation(oracle.pi, oracle.state, GOAL_ID, oracleClaim.id);
  assert.equal(oracleClaim.status, "needs_oracle");
  oracleClaim = recordGoalTodoClaimValidationResult(oracle.pi, oracle.state, GOAL_ID, oracleClaim.id, {
    result: {
      todoId: oracleClaim.id,
      claimHash: CLAIM_HASH,
      verdict: "PASS",
      recommendedAction: "accept_claim",
      evidenceRefs: ["test/goal-todo-transitions-wiring.test.ts"],
      validationCommands: ["node --test"],
      blockingIssues: [],
      noShip: false,
      confidence: "HIGH",
      hasFinalMarker: true,
    },
    outputHash: "e".repeat(64),
    expectedClaimHash: CLAIM_HASH,
    expectedAttemptId: oracleClaim.claim!.attemptId!,
    expectedValidationPolicy: "oracle_required",
    expectedGraphRevision: oracle.state.goalTodos.graphRevisions[GOAL_ID],
    expectedTodoRevision: oracleClaim.revision ?? 0,
  });
  assert.equal(oracleClaim.status, "needs_oracle", "validation metadata never bypasses the engine with a status rewrite");
  assert.equal(acceptGoalTodoClaim(oracle.pi, oracle.state, GOAL_ID, oracleClaim.id, exactClaimBinding(oracle.state, oracleClaim)).status, "done");

  const needsReview = capture();
  const invalid = add(needsReview.pi, needsReview.state, "needs_review", {
    delegation: { runId: "review", delegationDepth: 1, status: "claim_returned" },
    claim: {
      claimHash: CLAIM_HASH,
      gatePassed: true,
      childGoalStatus: "ready_for_oracle",
      statusClaim: "done",
      targetReadiness: "ready_for_parent_acceptance",
      acceptanceBlockers: [],
      noShip: false,
      returnedAt: 1,
    },
    evidenceRefs: ["test/goal-todo-transitions-wiring.test.ts"],
  });
  assert.throws(() => acceptGoalTodoClaim(needsReview.pi, needsReview.state, GOAL_ID, invalid.id, {
    expectedClaimHash: CLAIM_HASH,
    expectedAttemptId: "review",
    expectedValidationPolicy: "parent_review",
    expectedGraphRevision: needsReview.state.goalTodos.graphRevisions[GOAL_ID],
    expectedTodoRevision: invalid.revision ?? 0,
  }), /LEGACY_CLAIM_BINDING_REQUIRED/);
});

test("action=auto completes only nondelegated work and claim auto-accept requires explicit exact expectations", () => {
  const normal = capture();
  const node = add(normal.pi, normal.state);
  assert.equal(resolveGoalTodo(normal.pi, normal.state, GOAL_ID, node.id, { action: "auto" }).status, "done");

  const delegated = capture();
  const claim = returnCanonicalClaim(delegated.pi, delegated.state, add(delegated.pi, delegated.state));
  assert.throws(() => resolveGoalTodo(delegated.pi, delegated.state, GOAL_ID, claim.id, { action: "auto" }), /expected_auto_resolution=accept_claim/);
  assert.throws(() => resolveGoalTodo(delegated.pi, delegated.state, GOAL_ID, claim.id, {
    action: "auto",
    expectedAutoResolution: "accept_claim",
    ...exactClaimBinding(delegated.state, claim),
    expectedTodoRevision: (claim.revision ?? 0) - 1,
  }), /stale graph\/todo revisions/);
  assert.equal(resolveGoalTodo(delegated.pi, delegated.state, GOAL_ID, claim.id, {
    action: "auto",
    expectedAutoResolution: "accept_claim",
    ...exactClaimBinding(delegated.state, claim),
  }).status, "done");
});

test("reopen is CAS-aware for terminals, clears claim/delegation/validation durably, and never revives old running work", () => {
  const { pi, state, entries } = capture();
  let claim = returnCanonicalClaim(pi, state, add(pi, state));
  claim = acceptGoalTodoClaim(pi, state, GOAL_ID, claim.id, exactClaimBinding(state, claim));
  expectTransitionCode(() => resolveGoalTodo(pi, state, GOAL_ID, claim.id, {
    action: "reopen",
    reason: "new parent-owned attempt",
    evidenceRefs: ["test/goal-todo-transitions-wiring.test.ts"],
  }), "cas_required");
  const reopened = resolveGoalTodo(pi, state, GOAL_ID, claim.id, {
    action: "reopen",
    reason: "new parent-owned attempt",
    evidenceRefs: ["test/goal-todo-transitions-wiring.test.ts"],
    casBound: true,
  });
  assert.equal(reopened.status, "ready");
  assert.equal(reopened.delegation, undefined);
  assert.equal(reopened.claim, undefined);
  assert.equal(reopened.validation, undefined);
  assert.equal(reopened.reviewNoShip, undefined);

  const restored = restoreGoalTodosFromBranch(entries);
  const restoredNode = restored.nodes.find((candidate) => candidate.id === reopened.id)!;
  assert.equal(restoredNode.status, "ready");
  assert.equal(restoredNode.delegation, undefined);
  assert.equal(restoredNode.claim, undefined);
  assert.equal(restoredNode.validation, undefined);

  const recovery = capture();
  const failed = add(recovery.pi, recovery.state, "delegated", {
    delegation: { runId: "failed-run", delegationDepth: 1, status: "failed" },
  });
  expectTransitionCode(() => resolveGoalTodo(recovery.pi, recovery.state, GOAL_ID, failed.id, {
    action: "reopen",
    reason: "must recover explicitly",
    evidenceRefs: ["test/goal-todo-transitions-wiring.test.ts"],
    casBound: true,
  }), "invalid_transition");
  assert.equal(recovery.state.goalTodos.nodes.find((candidate) => candidate.id === failed.id)!.delegation?.status, "failed");
});
