import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  TOOL_FAILURE_CLASSES,
  TOOL_FAILURE_REASON_CODES,
  toolFailureBodyLikeFieldViolations,
  toolFailureIncidentKey,
  replayToolFailureAttempts,
  validateToolFailureReplayFixture,
} from "../.pi/extensions/zob-harness/index.js";
import type { ToolFailureAttempt, ToolFailureReplayFixture } from "../.pi/extensions/zob-harness/index.js";

const fixtureDir = join(process.cwd(), "test", "fixtures", "tool-failure-reliability");
const fixturePaths = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => join(fixtureDir, name));

function loadFixtures(): ToolFailureReplayFixture[] {
  return fixturePaths.map((path) => JSON.parse(readFileSync(path, "utf8")) as ToolFailureReplayFixture);
}

test("tool-failure taxonomy is stable and covers Phase 0 synthetic cases", () => {
  assert.deepEqual(TOOL_FAILURE_CLASSES, [
    "reference_resolution",
    "state_progress",
    "schema_validation",
    "policy_enforcement",
    "output_gate",
    "file_input",
  ]);
  assert.deepEqual(TOOL_FAILURE_REASON_CODES, [
    "todo_ref_not_found",
    "claim_state_unchanged",
    "schema_validation_failed",
    "policy_blocked",
    "output_gate_failed",
    "file_input_unavailable",
  ]);

  const fixtures = loadFixtures();
  assert.equal(fixtures.length, 6);
  for (const fixture of fixtures) {
    assert.deepEqual(validateToolFailureReplayFixture(fixture), []);
    assert.deepEqual(toolFailureBodyLikeFieldViolations(fixture), []);
  }
});

test("incident replay preserves attempts and separates unique incidents from unchanged-state retries", () => {
  const attempts = loadFixtures().flatMap((fixture) => fixture.attempts);
  const summary = replayToolFailureAttempts(attempts);

  assert.equal(summary.rawAttemptCount, 7);
  assert.equal(summary.uniqueIncidentCount, 6);
  assert.equal(summary.unchangedStateRetryCount, 1);
  assert.equal(summary.countsByReason.claim_state_unchanged, 2);
  assert.equal(summary.incidentKeys.length, 6);
  assert.deepEqual(summary, replayToolFailureAttempts(attempts));
  assert.equal(summary.bodyStored, false);
  assert.deepEqual(toolFailureBodyLikeFieldViolations(summary), []);

  const unchanged = attempts.filter((attempt) => attempt.reasonCode === "claim_state_unchanged");
  assert.notEqual(unchanged[0]?.attemptHash, unchanged[1]?.attemptHash);
  assert.equal(toolFailureIncidentKey(unchanged[0] as ToolFailureAttempt), toolFailureIncidentKey(unchanged[1] as ToolFailureAttempt));
});

test("fixture validation rejects body-like fields recursively", () => {
  const fixture = loadFixtures()[0] as ToolFailureReplayFixture;
  const unsafe = { ...fixture, nested: { prompt: "synthetic-body" } };
  const violations = toolFailureBodyLikeFieldViolations(unsafe);
  assert.deepEqual(violations, ["$.nested.prompt"]);
  assert.ok(validateToolFailureReplayFixture(unsafe).some((error) => error.includes("$.nested.prompt")));
});

test("replay CLI requires explicit safe fixture paths and never has a default scan", () => {
  const script = join(process.cwd(), "scripts", "telemetry", "replay-tool-failures.mjs");
  const noInput = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(noInput.status, 0);
  assert.match(noInput.stderr, /explicit fixture path required/i);

  const replay = spawnSync(process.execPath, ["--import", "tsx", script, ...fixturePaths], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(replay.status, 0, replay.stderr);
  const parsed = JSON.parse(replay.stdout) as { rawAttemptCount: number; uniqueIncidentCount: number; unchangedStateRetryCount: number };
  assert.deepEqual(parsed, { rawAttemptCount: 7, uniqueIncidentCount: 6, unchangedStateRetryCount: 1 });

  const source = readFileSync(script, "utf8");
  assert.doesNotMatch(source, /readdirSync|globSync|\.pi\/sessions|\.pi\/agent-sessions/);
});
