import { strict as assert } from "node:assert";
import { test } from "node:test";

import { assessDelegationAttemptLiveness, createChildSessionPath } from "../.pi/extensions/zob-harness/index.ts";
import type { GoalTodoDelegationAttempt } from "../.pi/extensions/zob-harness/index.ts";
import { createDelegationMonitorState, finishDelegationRun, startDelegationRun } from "../.pi/extensions/zob-harness/src/runtime/delegation-monitor.ts";

const FIXED_NOW = 1_725_000_000_000;
const FIXED_PID = 4242;

test("child session paths do not collide for same-tick same-process same-agent launches", () => {
  const originalDateNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const paths = Array.from({ length: 10_000 }, () => createChildSessionPath("/repo/.pi/agent-sessions", "implementer", {
      pid: FIXED_PID,
    }));
    assert.equal(new Set(paths).size, paths.length);
    assert.ok(paths.every((path) => path.includes(`${FIXED_NOW}-${FIXED_PID}-implementer-`)));
    assert.ok(paths.every((path) => path.endsWith(".jsonl")));
  } finally {
    Date.now = originalDateNow;
  }
});

test("child session path uniqueness is independent of timestamp, pid, and agent", () => {
  const paths = Array.from({ length: 1_000 }, () => createChildSessionPath("/repo/.pi/agent-sessions", "same agent", {
    now: FIXED_NOW,
    pid: FIXED_PID,
  }));
  assert.equal(new Set(paths).size, paths.length);
});

function attempt(overrides: Partial<GoalTodoDelegationAttempt> = {}): GoalTodoDelegationAttempt {
  return {
    attemptId: "attempt-live",
    runId: "attempt-live",
    goalId: "goal-live",
    todoId: "todo_aaaaaaaaaaaa",
    todoPath: "1",
    boundGoalRevision: 1,
    boundGraphRevision: 2,
    boundTodoRevision: 3,
    delegationDepth: 1,
    status: "liveness_unknown",
    reasonCode: "liveness_unknown",
    gateIssueCodes: [],
    gateIssueCount: 0,
    evidenceRefCount: 0,
    validationCommandCount: 0,
    updatedAt: 17,
    bodyStored: false,
    ...overrides,
  };
}

test("attempt liveness is active only for an exact current-runtime monitor run and terminal monitor status is inactive", () => {
  const monitor = createDelegationMonitorState();
  startDelegationRun(monitor, {
    id: "attempt-live",
    parentToolCallId: "parent-live",
    source: "delegate_task",
    mode: "single",
    agent: "implementer",
    task: "live",
    startedAtMs: FIXED_NOW,
  });
  const active = assessDelegationAttemptLiveness(monitor, attempt());
  assert.equal(active.status, "active");
  assert.equal(active.code, "monitor_active_exact");
  assert.equal(active.bodyStored, false);

  finishDelegationRun(monitor, "attempt-live", { status: "failed", endedAtMs: FIXED_NOW + 10 });
  const inactive = assessDelegationAttemptLiveness(monitor, attempt());
  assert.equal(inactive.status, "inactive");
  assert.equal(inactive.code, "monitor_terminal_exact");
  assert.notEqual(inactive.proofHash, active.proofHash);
});

test("attempt liveness accepts strong durable terminal proof but fails closed after restore and on ID/run mismatch", () => {
  const durable = attempt({
    status: "failed_runtime",
    reasonCode: "child_runtime_failed",
    failureKind: "child_runtime",
    failureHash: "f".repeat(64),
    finalizedAt: 19,
    updatedAt: 19,
  });
  const durableProof = assessDelegationAttemptLiveness(createDelegationMonitorState(), durable);
  assert.equal(durableProof.status, "inactive");
  assert.equal(durableProof.code, "durable_child_terminal");

  const restored = createDelegationMonitorState();
  restored.runs.push({
    id: "attempt-live",
    parentToolCallId: "attempt-live",
    source: "delegate_task",
    mode: "single",
    agent: "implementer",
    taskPreview: "restored delegation",
    status: "running",
    startedAtMs: FIXED_NOW,
    outputPreview: "",
    stderrPreview: "",
  });
  const unknown = assessDelegationAttemptLiveness(restored, attempt());
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.code, "restored_nonterminal_without_controller");

  assert.equal(assessDelegationAttemptLiveness(restored, attempt(), { attemptId: "wrong", runId: "attempt-live" }).code, "attempt_id_mismatch");
  assert.equal(assessDelegationAttemptLiveness(restored, attempt(), { attemptId: "attempt-live", runId: "wrong" }).code, "run_id_mismatch");
});
