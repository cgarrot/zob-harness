import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("get_goal_todos exposes exact body-free CAS and claim bindings in text", () => {
  const source = readFileSync(".pi/extensions/zob-harness/src/runtime/goal-runtime/tools.ts", "utf8");
  assert.match(source, /TODO_API_BINDING\.v1/);
  assert.match(source, /graph_revision=\$\{graphRevision\}/);
  assert.match(source, /todo_revision=\$\{todoRevision\}/);
  assert.match(source, /claim_hash=\$\{node\.claim\?\.claimHash/);
  assert.match(source, /attempt_id=\$\{node\.claim\?\.attemptId/);
  assert.match(source, /validation_policy=\$\{node\.claim\?\.validationPolicy/);
  assert.match(source, /body_stored=false/);
  assert.doesNotMatch(source, /TODO_API_BINDING[\s\S]{0,500}rawOutput/);
});

test("Goal TODO command fallback recovers terminal attempts and accepts exact current claim bindings", () => {
  const source = readFileSync(".pi/extensions/zob-harness/src/domains/goal/goal-todos/parsing.ts", "utf8");
  assert.match(source, /command === "recover"/);
  assert.match(source, /assessDelegationAttemptLiveness/);
  assert.match(source, /liveness\.status !== "inactive"/);
  assert.match(source, /recoverGoalTodoDelegation/);
  assert.match(source, /expectedGraphRevision: state\.goalTodos\.graphRevisions/);
  assert.match(source, /expectedTodoRevision: resolved\.node\.revision/);
  assert.match(source, /expectedClaimHash: claim\.claimHash/);
  assert.match(source, /expectedAttemptId: claim\.attemptId/);
  assert.match(source, /expectedValidationPolicy: claim\.validationPolicy/);
  assert.match(source, /auto_dispatch=false/);
});
