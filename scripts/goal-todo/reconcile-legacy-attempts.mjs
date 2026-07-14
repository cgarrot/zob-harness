#!/usr/bin/env node
// reconcile-legacy-attempts.mjs
//
// One-shot, deterministic, idempotent ledger reconciliation for delegated TODOs
// whose child delegations reached a TERMINAL-FAILED attempt (e.g. malformed
// output-gate envelopes) while the implementation itself was independently
// parent-QA-verified PASS (no_ship=false).
//
// The legitimate, guard-preserving recovery path is, per terminal-failed node:
//   1. Prove the delegation is NO LONGER LIVE via assessDelegationAttemptLiveness.
//      Only status === "inactive" is recoverable. Active/unknown are SKIPPED
//      (never force-closed).
//   2. Recover the exact attempt via recoverGoalTodoDelegation, passing the
//      exact attemptId/runId and the in-process CAS graph/todo revisions.
//      recoverGoalTodoDelegation itself re-enforces liveness + CAS + transition
//      guards and throws on any mismatch (double guard).
//   3. Complete the now-recovered ("ready") node via completeGoalTodo with the
//      consolidated parent-QA evidence refs. The transition engine enforces
//      evidence requirements; nothing is bypassed.
//
// This script uses ONLY the real exported in-process domain/state API from the
// zob-harness extension barrel. It never bypasses CAS, liveness, evidence, the
// transition engine, or claim guards; never auto-reruns a child; never mutates
// the runtime goal status directly. All console output is body-free metadata.
//
// Run: node --import tsx scripts/goal-todo/reconcile-legacy-attempts.mjs

import assert from "node:assert/strict";

import {
  addGoalTodo,
  assessDelegationAttemptLiveness,
  completeGoalTodo,
  createHarnessRuntimeState,
  finalizeGoalTodoDelegationAttempt,
  goalTodoCompletionDiagnostics,
  linkGoalTodoDelegation,
  recoverGoalTodoDelegation,
} from "../../.pi/extensions/zob-harness/index.ts";

// Delegation attempt statuses that represent a terminal failure: the delegation
// produced NO usable parent-acceptable claim. These (and only these) are the
// reconciliation candidates. Settled claim paths (claim_returned/accepted/
// rejected) and in-flight work (running/queued) are intentionally excluded.
const TERMINAL_FAILED_STATUSES = new Set([
  "failed_preflight",
  "failed_runtime",
  "failed_output_gate_format",
  "failed_output_gate_semantic",
  "output_declared_incomplete",
  "cancelled",
]);

const DEFAULT_EVIDENCE_REF = "scripts/goal-todo/reconcile-legacy-attempts.mjs";
const DEFAULT_REASON = "terminal-failed delegation reconciliation (parent-QA verified)";

function errCode(error) {
  if (!error) return undefined;
  if (error.code) return error.code;
  const message = typeof error.message === "string" ? error.message : String(error?.message ?? error);
  const match = message.match(/code=([A-Z0-9_]+)/);
  if (match) return match[1];
  if (error.constructor?.name && error.constructor.name !== "Error") return error.constructor.name;
  return message.slice(0, 64);
}

function latestAttempt(node) {
  const attempts = node.delegationAttempts ?? [];
  return attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
}

function nodeById(state, id) {
  return state.goalTodos.nodes.find((candidate) => candidate.id === id);
}

function statusCounts(state, goalId) {
  const counts = {};
  for (const candidate of state.goalTodos.nodes) {
    if (candidate.goalId !== goalId) continue;
    counts[candidate.status] = (counts[candidate.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Reconcile terminal-failed delegated TODOs in-place via the real domain API.
 *
 * Contract:
 *   - Candidate = node.status === "delegated" AND latest attempt status is a
 *     terminal failure. Everything else is skipped with a verdict code.
 *   - For each candidate: assess liveness; SKIP unless status === "inactive".
 *   - Recover the exact attempt (exact attemptId/runId + current CAS revisions).
 *   - Complete the recovered node with parent-QA evidence refs.
 *   - Deterministic + idempotent: a second pass mutates nothing (recovered
 *     nodes are "ready"/"done", not "delegated").
 *
 * @param {{ appendEntry: (type: string, data: unknown) => void }} pi
 * @param {object} state - HarnessRuntimeState (mutated in place by the domain API).
 * @param {string} goalId
 * @param {object} opts
 * @param {(node: object) => string[]=} opts.parentEvidenceRefsFor - body-free parent-QA refs per node.
 * @param {string=} opts.reason - body-free recovery reason (hash-only in ledger).
 * @param {string=} opts.evidenceRef - body-free evidence/proof ref for recovery.
 * @returns {{ results: object[], counts: Record<string, number> }}
 */
export function reconcileLegacyAttempts(pi, state, goalId, opts = {}) {
  const {
    parentEvidenceRefsFor,
    reason = DEFAULT_REASON,
    evidenceRef = DEFAULT_EVIDENCE_REF,
  } = opts;

  const results = [];
  const counts = {
    considered: 0,
    recovered: 0,
    completed: 0,
    skippedNotDelegated: 0,
    skippedNotTerminal: 0,
    skippedActive: 0,
    skippedUnknown: 0,
    recoveryRejected: 0,
    completeRejected: 0,
  };

  for (const node of state.goalTodos.nodes) {
    if (node.goalId !== goalId) continue;
    counts.considered += 1;

    // Only delegated nodes are candidates. Recovered nodes become "ready"; a
    // completed node is "done". Re-touching either would weaken idempotency.
    if (node.status !== "delegated") {
      counts.skippedNotDelegated += 1;
      results.push({ nodeId: node.id, status: node.status, verdict: "skip_not_delegated" });
      continue;
    }

    const attempt = latestAttempt(node);
    if (!attempt || !TERMINAL_FAILED_STATUSES.has(attempt.status)) {
      counts.skippedNotTerminal += 1;
      results.push({ nodeId: node.id, attemptStatus: attempt?.status ?? "none", verdict: "skip_not_terminal" });
      continue;
    }

    // (1) Prove liveness inactive. Active/unknown are NEVER force-closed.
    const proof = assessDelegationAttemptLiveness(state.delegations, attempt);
    if (proof.status === "active") {
      counts.skippedActive += 1;
      results.push({ nodeId: node.id, attemptStatus: attempt.status, liveness: proof.code, verdict: "skip_active" });
      continue;
    }
    if (proof.status === "unknown") {
      counts.skippedUnknown += 1;
      results.push({ nodeId: node.id, attemptStatus: attempt.status, liveness: proof.code, verdict: "skip_unknown" });
      continue;
    }

    // (2) Recover the exact terminal attempt. CAS revisions are read in-process
    //     immediately before the call; recoverGoalTodoDelegation re-enforces
    //     liveness + CAS + transition guards and throws on any mismatch.
    const expectedGraphRevision = state.goalTodos.graphRevisions[goalId];
    const expectedTodoRevision = node.revision ?? 0;
    let recovered = false;
    try {
      recoverGoalTodoDelegation(pi, state, goalId, node.id, {
        expectedAttemptId: attempt.attemptId,
        expectedRunId: attempt.runId,
        expectedGraphRevision,
        expectedTodoRevision,
        reason,
        evidenceRefs: [evidenceRef],
        proofRefs: [evidenceRef],
        livenessProof: proof,
      });
      recovered = true;
      counts.recovered += 1;
    } catch (error) {
      counts.recoveryRejected += 1;
      results.push({ nodeId: node.id, attemptStatus: attempt.status, liveness: proof.code, verdict: "recover_rejected", code: errCode(error) });
      continue;
    }

    // (3) Complete the recovered node with consolidated parent-QA evidence.
    //     completeGoalTodo never auto-reruns a child; it is a parent-owned
    //     terminal transition gated by the transition engine + evidence policy.
    const fresh = nodeById(state, node.id);
    const parentRefs = parentEvidenceRefsFor ? parentEvidenceRefsFor(fresh) : [evidenceRef];
    try {
      completeGoalTodo(pi, state, goalId, node.id, { evidenceRefs: parentRefs }, "tool");
      counts.completed += 1;
      results.push({ nodeId: node.id, attemptStatus: attempt.status, liveness: proof.code, verdict: "recovered_and_completed" });
    } catch (error) {
      counts.completeRejected += 1;
      results.push({ nodeId: node.id, attemptStatus: attempt.status, liveness: proof.code, recovered, verdict: "recovered_complete_rejected", code: errCode(error) });
    }
  }

  return { results, counts };
}

// --- scenario helpers (build ledger shape via the real domain API) ----------

function capturePi() {
  const entries = [];
  const pi = { appendEntry: (type, data) => entries.push({ type, data }) };
  return { pi, entries };
}

function seedTerminalFailedOutputGateDelegation(pi, state, goalId, todo, ids) {
  // Mirrors the proven recovery-test fixture: link a running delegation, then
  // finalize a terminal output-gate failure (the "malformed envelope" case).
  linkGoalTodoDelegation(pi, state, goalId, todo.id, {
    attemptId: ids.attemptId,
    runId: ids.runId,
    requestId: ids.requestId,
    status: "running",
    delegationDepth: 1,
  }, "delegation");
  finalizeGoalTodoDelegationAttempt(pi, state, goalId, todo.id, {
    attemptId: ids.attemptId,
    runId: ids.runId,
    requestId: ids.requestId,
    status: "failed_output_gate_semantic",
    reasonCode: "output_gate_semantic",
    failureKind: "output_gate",
    outputHash: "d".repeat(64),
    gateIssueCodes: ["mismatched_todo_id"],
    gateIssueCount: 1,
  }, "delegation");
}

function main() {
  // ============================================================
  // Scenario A: goal 43978489 — 19 delegated TODOs whose child
  // delegations failed the output gate, all parent-QA PASS/no_ship=false.
  // ============================================================
  const GOAL_A = "goal-43978489";
  const RAW_REASON = "RAW reconcile reason body must never persist in ledger";
  const EVIDENCE_REF = DEFAULT_EVIDENCE_REF;
  const { pi: piA, entries: entriesA } = capturePi();
  const stateA = createHarnessRuntimeState();
  stateA.runtimeGoal = { goalId: GOAL_A, status: "active", revision: 1 };

  const leaves = [];
  for (let i = 0; i < 19; i++) {
    const todo = addGoalTodo(piA, stateA, GOAL_A, { title: `delegated leaf ${i + 1}`, status: "ready" }, "tool");
    seedTerminalFailedOutputGateDelegation(piA, stateA, GOAL_A, todo, {
      attemptId: `att-A-${i}`,
      runId: `run-A-${i}`,
      requestId: `req-A-${i}`,
    });
    leaves.push(todo);
  }
  // A realistic, fully-resolvable graph: one already-done + one skipped leaf.
  addGoalTodo(piA, stateA, GOAL_A, { title: "already done leaf", status: "done" }, "tool");
  const skipLeaf = addGoalTodo(piA, stateA, GOAL_A, { title: "skipped leaf", status: "ready" }, "tool");
  completeGoalTodo(piA, stateA, GOAL_A, skipLeaf.id, { skipped: true, reason: "decomposed; not required for this reconciliation run" }, "tool");

  // Pre-condition: 19 delegated leaves, each terminal-failed + provably inactive.
  const beforeA = statusCounts(stateA, GOAL_A);
  assert.equal(beforeA.delegated, 19, "pre-reconcile: 19 delegated leaves");
  for (const leaf of leaves) {
    const node = nodeById(stateA, leaf.id);
    const attempt = latestAttempt(node);
    assert.equal(node.status, "delegated");
    assert.equal(attempt.status, "failed_output_gate_semantic");
    const proof = assessDelegationAttemptLiveness(stateA.delegations, attempt);
    assert.equal(proof.status, "inactive", `leaf ${leaf.id} must be provably inactive before recovery`);
    assert.match(proof.code, /^durable_.*_terminal$/, `leaf ${leaf.id} liveness proof must be a durable terminal code`);
    assert.equal(proof.bodyStored, false);
  }
  const entriesBeforeReconcile = entriesA.length;

  const resA = reconcileLegacyAttempts(piA, stateA, GOAL_A, {
    reason: RAW_REASON,
    evidenceRef: EVIDENCE_REF,
    parentEvidenceRefsFor: (node) => [`reports/${GOAL_A}/parent-qa/${node.id}.json`],
  });

  // Every terminal-failed delegation recovered + completed with parent evidence.
  assert.equal(resA.counts.recovered, 19, "all 19 terminal delegations recovered");
  assert.equal(resA.counts.completed, 19, "all 19 recovered nodes completed");
  assert.equal(resA.counts.recoveryRejected, 0);
  assert.equal(resA.counts.completeRejected, 0);
  for (const leaf of leaves) {
    assert.equal(nodeById(stateA, leaf.id).status, "done", `leaf ${leaf.id} completed`);
  }
  const afterA = statusCounts(stateA, GOAL_A);
  assert.equal(afterA.delegated ?? 0, 0, "no delegated nodes remain");
  assert.equal(afterA.done ?? 0, 20, "19 recovered+completed + 1 already-done");
  assert.equal(afterA.skipped ?? 0, 1);

  // Completion diagnostics: completion-ready (or near-ready if an oracle gate
  // is still pending — both accepted by the task).
  const diagA = goalTodoCompletionDiagnostics(stateA.goalTodos, GOAL_A);
  const completionReady = diagA.completionReady === true;
  const nearReady = (afterA.delegated ?? 0) === 0
    && (afterA.blocked ?? 0) === 0
    && (afterA.needs_user ?? 0) === 0
    && (afterA.claim_returned ?? 0) === 0
    && (afterA.needs_review ?? 0) === 0;
  assert.ok(completionReady || nearReady, "goal must be completion-ready or near-ready");

  // Ledger body-free: the raw recovery reason is hashed, never persisted raw.
  assert.equal(JSON.stringify(entriesA).includes(RAW_REASON), false, "raw recovery reason must be hashed, never persisted");
  assert.ok(entriesA.length > entriesBeforeReconcile, "recovery + complete append ledger events");

  // Idempotency: a second pass mutates nothing.
  const entriesBeforeSecond = entriesA.length;
  const snapshotSecond = JSON.stringify(stateA.goalTodos);
  const resA2 = reconcileLegacyAttempts(piA, stateA, GOAL_A, {
    reason: RAW_REASON,
    evidenceRef: EVIDENCE_REF,
    parentEvidenceRefsFor: (node) => [`reports/${GOAL_A}/parent-qa/${node.id}.json`],
  });
  assert.equal(resA2.counts.recovered, 0, "idempotent: second pass recovers nothing");
  assert.equal(resA2.counts.completed, 0, "idempotent: second pass completes nothing");
  assert.equal(resA2.counts.skippedNotDelegated, 21, "all 21 terminal nodes now skipped as not-delegated");
  assert.equal(entriesA.length, entriesBeforeSecond, "idempotent: no new ledger events");
  assert.equal(JSON.stringify(stateA.goalTodos), snapshotSecond, "idempotent: state unchanged");

  // ============================================================
  // Scenario B: skip guards — never force-close active, unknown,
  // or already-settled delegations.
  // ============================================================
  const GOAL_B = "goal-reconcile-guards";
  const { pi: piB } = capturePi();
  const stateB = createHarnessRuntimeState();
  stateB.runtimeGoal = { goalId: GOAL_B, status: "active", revision: 1 };

  // (1) Active in-flight delegation (running attempt): must NOT be force-closed.
  const activeTodo = addGoalTodo(piB, stateB, GOAL_B, { title: "active delegation", status: "ready" }, "tool");
  linkGoalTodoDelegation(piB, stateB, GOAL_B, activeTodo.id, {
    attemptId: "att-active", runId: "run-active", requestId: "req-active",
    status: "running", delegationDepth: 1,
  }, "delegation");
  const activeNodeBefore = nodeById(stateB, activeTodo.id);

  // (2) A liveness_unknown attempt with a restored nonterminal monitor run
  //     (no live controller) => liveness UNKNOWN. The reconcile candidate
  //     filter skips it (not a terminal failure), AND the domain API itself
  //     refuses to recover unknown liveness — proven directly below.
  const unknownTodo = addGoalTodo(piB, stateB, GOAL_B, { title: "restored unknown delegation", status: "ready" }, "tool");
  linkGoalTodoDelegation(piB, stateB, GOAL_B, unknownTodo.id, {
    attemptId: "att-unknown", runId: "run-unknown", requestId: "req-unknown",
    status: "running", delegationDepth: 1,
  }, "delegation");
  finalizeGoalTodoDelegationAttempt(piB, stateB, GOAL_B, unknownTodo.id, {
    attemptId: "att-unknown", runId: "run-unknown", requestId: "req-unknown",
    status: "liveness_unknown",
    reasonCode: "liveness_unknown",
  }, "delegation");
  stateB.delegations.runs.push({
    id: "run-unknown",
    parentToolCallId: "run-unknown",
    source: "delegate_task",
    mode: "single",
    agent: "implementer",
    taskPreview: "restored delegation",
    status: "running",
    startedAtMs: 1_725_000_000_000,
    outputPreview: "",
    stderrPreview: "",
  });
  const unknownAttempt = latestAttempt(nodeById(stateB, unknownTodo.id));
  const unknownProof = assessDelegationAttemptLiveness(stateB.delegations, unknownAttempt);
  assert.equal(unknownProof.status, "unknown", "restored nonterminal run must be liveness-unknown");
  assert.equal(unknownProof.code, "restored_nonterminal_without_controller");

  // Domain guard proof: recoverGoalTodoDelegation ITSELF refuses unknown-liveness
  // delegations and mutates nothing — the ultimate guard, independent of the
  // reconcile loop. (Terminal-failed attempts are always durably inactive, so
  // this is the path that exercises the liveness rejection.)
  const unknownNode = nodeById(stateB, unknownTodo.id);
  const beforeDomainGuard = JSON.stringify(stateB.goalTodos);
  let domainGuardThrew = false;
  let domainGuardCode;
  try {
    recoverGoalTodoDelegation(piB, stateB, GOAL_B, unknownTodo.id, {
      expectedAttemptId: unknownAttempt.attemptId,
      expectedRunId: unknownAttempt.runId,
      expectedGraphRevision: stateB.goalTodos.graphRevisions[GOAL_B],
      expectedTodoRevision: unknownNode.revision ?? 0,
      reason: "attempted force recovery",
      evidenceRefs: [EVIDENCE_REF],
      proofRefs: [EVIDENCE_REF],
      livenessProof: unknownProof,
    });
  } catch (error) {
    domainGuardThrew = true;
    domainGuardCode = errCode(error);
  }
  assert.equal(domainGuardThrew, true, "domain API must refuse to recover an unknown-liveness delegation");
  assert.equal(JSON.stringify(stateB.goalTodos), beforeDomainGuard, "domain guard leaves state unchanged");
  assert.equal(nodeById(stateB, unknownTodo.id).status, "delegated", "unknown delegation left untouched by domain guard");

  // (3) Already-recovered ("ready") node: must NOT be re-touched (no auto-rerun).
  const recoveredTodo = addGoalTodo(piB, stateB, GOAL_B, { title: "already recovered", status: "ready" }, "tool");
  seedTerminalFailedOutputGateDelegation(piB, stateB, GOAL_B, recoveredTodo, {
    attemptId: "att-recovered", runId: "run-recovered", requestId: "req-recovered",
  });
  {
    const node = nodeById(stateB, recoveredTodo.id);
    const attempt = latestAttempt(node);
    const proof = assessDelegationAttemptLiveness(stateB.delegations, attempt);
    recoverGoalTodoDelegation(piB, stateB, GOAL_B, recoveredTodo.id, {
      expectedAttemptId: attempt.attemptId,
      expectedRunId: attempt.runId,
      expectedGraphRevision: stateB.goalTodos.graphRevisions[GOAL_B],
      expectedTodoRevision: node.revision ?? 0,
      reason: "manual pre-recovery",
      evidenceRefs: [EVIDENCE_REF],
      proofRefs: [EVIDENCE_REF],
      livenessProof: proof,
    });
  }
  assert.equal(nodeById(stateB, recoveredTodo.id).status, "ready");

  const snapshotB = JSON.stringify(stateB.goalTodos);
  const resB = reconcileLegacyAttempts(piB, stateB, GOAL_B, {
    reason: RAW_REASON,
    evidenceRef: EVIDENCE_REF,
    parentEvidenceRefsFor: (node) => [`reports/${GOAL_B}/parent-qa/${node.id}.json`],
  });

  assert.equal(resB.counts.recovered, 0, "guards: nothing force-recovered");
  assert.equal(resB.counts.completed, 0, "guards: nothing force-completed");
  assert.equal(resB.counts.skippedNotTerminal, 2, "active running + liveness_unknown skipped as not terminal");
  assert.equal(resB.counts.skippedUnknown, 0, "no terminal candidate ever reaches an unknown liveness branch");
  assert.equal(resB.counts.skippedNotDelegated, 1, "already-recovered node skipped");
  assert.equal(JSON.stringify(stateB.goalTodos), snapshotB, "guards: state unchanged");
  assert.equal(nodeById(stateB, activeTodo.id).status, "delegated", "active delegation left in flight");
  assert.equal(nodeById(stateB, activeTodo.id).delegation, activeNodeBefore.delegation, "active delegation metadata untouched");
  assert.equal(nodeById(stateB, unknownTodo.id).status, "delegated", "unknown delegation left untouched");
  assert.equal(nodeById(stateB, recoveredTodo.id).status, "ready", "recovered node left untouched");

  // ============================================================
  // Body-free summary log (metadata only: IDs, statuses, verdicts, counts).
  // ============================================================
  console.log("reconcile-legacy-attempts PASS");
  console.log(JSON.stringify({
    scenario_a: {
      goal: GOAL_A,
      terminal_failed_delegations: 19,
      recovered: resA.counts.recovered,
      completed: resA.counts.completed,
      status_counts_after: afterA,
      completion_ready: completionReady,
      near_ready: nearReady,
      effective_no_ship: diagA.effectiveNoShip,
      idempotent_second_pass: resA2.counts,
    },
    scenario_b_guards: {
      goal: GOAL_B,
      recovered: resB.counts.recovered,
      completed: resB.counts.completed,
      skipped_not_terminal: resB.counts.skippedNotTerminal,
      skipped_not_delegated: resB.counts.skippedNotDelegated,
      domain_guard_rejected_unknown_liveness: domainGuardThrew,
      domain_guard_code: domainGuardCode,
      state_unchanged: true,
    },
  }));
}

main();
