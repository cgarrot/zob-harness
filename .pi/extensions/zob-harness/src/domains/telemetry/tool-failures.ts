import { sha256Hex } from "../../core/utils/hashing.js";
import type {
  ToolFailureAttempt,
  ToolFailureClass,
  ToolFailureReasonCode,
  ToolFailureReplayFixture,
  ToolFailureReplaySummary,
} from "../../types.js";

export const TOOL_FAILURE_TAXONOMY_REVISION = 1 as const;

export const TOOL_FAILURE_CLASSES = [
  "reference_resolution",
  "state_progress",
  "schema_validation",
  "policy_enforcement",
  "output_gate",
  "file_input",
] as const satisfies readonly ToolFailureClass[];

export const TOOL_FAILURE_REASON_CODES = [
  "todo_ref_not_found",
  "claim_state_unchanged",
  "schema_validation_failed",
  "policy_blocked",
  "output_gate_failed",
  "file_input_unavailable",
] as const satisfies readonly ToolFailureReasonCode[];

const REASON_CLASS: Readonly<Record<ToolFailureReasonCode, ToolFailureClass>> = {
  todo_ref_not_found: "reference_resolution",
  claim_state_unchanged: "state_progress",
  schema_validation_failed: "schema_validation",
  policy_blocked: "policy_enforcement",
  output_gate_failed: "output_gate",
  file_input_unavailable: "file_input",
};

const ATTEMPT_FIELDS = new Set([
  "schema",
  "attemptHash",
  "toolHash",
  "inputHash",
  "stateHash",
  "failureClass",
  "reasonCode",
  "stateRevision",
  "occurredAt",
  "bodyStored",
]);
const FIXTURE_FIELDS = new Set(["schema", "taxonomyRevision", "bodyStored", "attempts"]);
const BODY_LIKE_FIELDS = new Set([
  "body",
  "prompt",
  "output",
  "command",
  "path",
  "stderr",
  "diff",
  "patch",
  "secret",
  "content",
  "text",
  "task",
  "session",
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBodyLikeField(field: string): boolean {
  const normalized = field.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (normalized === "bodystored" || normalized.endsWith("hash")) return false;
  return BODY_LIKE_FIELDS.has(normalized) || (normalized.startsWith("raw") && BODY_LIKE_FIELDS.has(normalized.slice(3)));
}

export function toolFailureBodyLikeFieldViolations(value: unknown): string[] {
  const violations: string[] = [];
  const seen = new WeakSet<object>();

  function visit(candidate: unknown, path: string): void {
    if (typeof candidate !== "object" || candidate === null) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [field, entry] of Object.entries(candidate)) {
      const fieldPath = `${path}.${field}`;
      if (isBodyLikeField(field)) violations.push(fieldPath);
      visit(entry, fieldPath);
    }
  }

  visit(value, "$");
  return violations.sort();
}

function validateHash(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) errors.push(`${path} must be a lowercase sha256 hash`);
}

function validateAttempt(value: unknown, index: number, errors: string[]): value is ToolFailureAttempt {
  const path = `$.attempts[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  for (const field of Object.keys(value)) {
    if (!ATTEMPT_FIELDS.has(field)) errors.push(`${path}.${field} is not allowed`);
  }
  if (value.schema !== "zob.tool-failure-attempt.v1") errors.push(`${path}.schema must equal zob.tool-failure-attempt.v1`);
  validateHash(value.attemptHash, `${path}.attemptHash`, errors);
  validateHash(value.toolHash, `${path}.toolHash`, errors);
  validateHash(value.inputHash, `${path}.inputHash`, errors);
  validateHash(value.stateHash, `${path}.stateHash`, errors);
  if (!TOOL_FAILURE_CLASSES.includes(value.failureClass as ToolFailureClass)) errors.push(`${path}.failureClass is not a stable failure class`);
  if (!TOOL_FAILURE_REASON_CODES.includes(value.reasonCode as ToolFailureReasonCode)) {
    errors.push(`${path}.reasonCode is not a stable reason code`);
  } else if (REASON_CLASS[value.reasonCode as ToolFailureReasonCode] !== value.failureClass) {
    errors.push(`${path}.reasonCode does not belong to failureClass`);
  }
  if (!Number.isSafeInteger(value.stateRevision) || (value.stateRevision as number) < 0) errors.push(`${path}.stateRevision must be a non-negative safe integer`);
  if (typeof value.occurredAt !== "string" || Number.isNaN(Date.parse(value.occurredAt)) || new Date(value.occurredAt).toISOString() !== value.occurredAt) errors.push(`${path}.occurredAt must be a canonical ISO timestamp`);
  if (value.bodyStored !== false) errors.push(`${path}.bodyStored must be false`);
  return errors.length === 0;
}

export function validateToolFailureReplayFixture(value: unknown): string[] {
  const errors = toolFailureBodyLikeFieldViolations(value).map((path) => `${path} is a forbidden body-like field`);
  if (!isRecord(value)) return [...errors, "$ must be an object"];
  for (const field of Object.keys(value)) {
    if (!FIXTURE_FIELDS.has(field)) errors.push(`$.${field} is not allowed`);
  }
  if (value.schema !== "zob.tool-failure-replay-fixture.v1") errors.push("$.schema must equal zob.tool-failure-replay-fixture.v1");
  if (value.taxonomyRevision !== TOOL_FAILURE_TAXONOMY_REVISION) errors.push(`$.taxonomyRevision must equal ${TOOL_FAILURE_TAXONOMY_REVISION}`);
  if (value.bodyStored !== false) errors.push("$.bodyStored must be false");
  if (!Array.isArray(value.attempts)) {
    errors.push("$.attempts must be an array");
  } else {
    value.attempts.forEach((attempt, index) => validateAttempt(attempt, index, errors));
  }
  return [...new Set(errors)].sort();
}

export function toolFailureIncidentKey(attempt: ToolFailureAttempt): string {
  return sha256Hex([
    TOOL_FAILURE_TAXONOMY_REVISION,
    attempt.toolHash,
    attempt.inputHash,
    attempt.stateHash,
    attempt.failureClass,
    attempt.reasonCode,
  ].join(":"));
}

export function fileToolPreflightFingerprint(input: {
  toolHash: string;
  inputHash: string;
  snapshotHash: string;
  reasonCode: string;
}): string {
  return sha256Hex([
    TOOL_FAILURE_TAXONOMY_REVISION,
    input.toolHash,
    input.inputHash,
    input.snapshotHash,
    "file_input",
    "file_input_unavailable",
    input.reasonCode,
  ].join(":"));
}

export function replayToolFailureAttempts(attempts: readonly ToolFailureAttempt[]): ToolFailureReplaySummary {
  const countsByClass = Object.fromEntries(TOOL_FAILURE_CLASSES.map((failureClass) => [failureClass, 0])) as Record<ToolFailureClass, number>;
  const countsByReason = Object.fromEntries(TOOL_FAILURE_REASON_CODES.map((reasonCode) => [reasonCode, 0])) as Record<ToolFailureReasonCode, number>;
  const incidentKeys = new Set<string>();
  const timestamps: string[] = [];

  for (const attempt of attempts) {
    countsByClass[attempt.failureClass] += 1;
    countsByReason[attempt.reasonCode] += 1;
    incidentKeys.add(toolFailureIncidentKey(attempt));
    timestamps.push(attempt.occurredAt);
  }
  timestamps.sort();
  const sortedIncidentKeys = [...incidentKeys].sort();

  return {
    schema: "zob.tool-failure-replay.v1",
    taxonomyRevision: TOOL_FAILURE_TAXONOMY_REVISION,
    rawAttemptCount: attempts.length,
    uniqueIncidentCount: sortedIncidentKeys.length,
    unchangedStateRetryCount: attempts.length - sortedIncidentKeys.length,
    countsByClass,
    countsByReason,
    incidentKeys: sortedIncidentKeys,
    ...(timestamps[0] ? { firstOccurredAt: timestamps[0] } : {}),
    ...(timestamps.at(-1) ? { lastOccurredAt: timestamps.at(-1) } : {}),
    bodyStored: false,
  };
}

export function replayToolFailureFixtures(fixtures: readonly unknown[]): ToolFailureReplaySummary {
  const attempts: ToolFailureAttempt[] = [];
  fixtures.forEach((fixture, index) => {
    const errors = validateToolFailureReplayFixture(fixture);
    if (errors.length > 0) throw new Error(`invalid tool-failure fixture ${index}: ${errors.join("; ")}`);
    attempts.push(...(fixture as ToolFailureReplayFixture).attempts);
  });
  return replayToolFailureAttempts(attempts);
}
