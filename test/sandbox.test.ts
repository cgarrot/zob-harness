import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  validateSandboxApplyReadinessInputs,
  validateSandboxDiffReviewGateInputs,
  validateSandboxIsolatedExecutionInputs,
  validateSandboxWritePlanInputs,
} from "../.pi/extensions/zob-harness/index.ts";

const REPO = "/repo";
const HEX = "a".repeat(64);

function baseWritePlan() {
  return {
    allowed_paths: ["app/"],
    changes: [{ path: "app/feature.ts", action: "create" as const, contentHash: HEX }],
  };
}

test("validateSandboxWritePlanInputs: accepts a hash-only, repo-scoped create plan", () => {
  assert.deepEqual(validateSandboxWritePlanInputs(REPO, baseWritePlan()), []);
});

test("validateSandboxWritePlanInputs: requires non-empty allowed_paths and changes", () => {
  const noPaths = validateSandboxWritePlanInputs(REPO, { ...baseWritePlan(), allowed_paths: [] });
  assert.ok(noPaths.some((error) => error.includes("requires non-empty allowed_paths")));

  const noChanges = validateSandboxWritePlanInputs(REPO, { ...baseWritePlan(), changes: [] });
  assert.ok(noChanges.some((error) => error.includes("requires at least one planned change")));
});

test("validateSandboxWritePlanInputs: rejects non-hex content and unsupported actions", () => {
  const badHash = validateSandboxWritePlanInputs(REPO, {
    allowed_paths: ["app/"],
    changes: [{ path: "app/feature.ts", action: "create", contentHash: "deadbeef" }],
  });
  assert.ok(badHash.some((error) => error.includes("contentHash must be a sha256 hex hash")));

  const badAction = validateSandboxWritePlanInputs(REPO, {
    allowed_paths: ["app/"],
    changes: [{ path: "app/feature.ts", action: "delete", contentHash: HEX }],
  });
  assert.ok(badAction.some((error) => error.includes("action must be create or update")));
});

test("validateSandboxWritePlanInputs: rejects unsafe run ids and plaintext body keys", () => {
  const badRunId = validateSandboxWritePlanInputs(REPO, { ...baseWritePlan(), run_id: "../evil" });
  assert.ok(badRunId.some((error) => error.includes("run_id must be path-safe")));

  const withBody = validateSandboxWritePlanInputs(REPO, { ...baseWritePlan(), content: "leaked secret payload" });
  assert.ok(withBody.some((error) => error.includes("must not include plaintext")));
});

test("validateSandboxWritePlanInputs: keeps change paths inside the repo root", () => {
  const traversal = validateSandboxWritePlanInputs(REPO, {
    allowed_paths: ["app/"],
    changes: [{ path: "../escape.ts", action: "create", contentHash: HEX }],
  });
  assert.ok(traversal.some((error) => error.includes("stay inside repo root")));
});

test("validateSandboxApplyReadinessInputs: blocks when the run artifacts are missing", () => {
  const errors = validateSandboxApplyReadinessInputs(REPO, {
    run_id: "ghost-run",
    oracle_review_path: "reports/oracle.json",
    diff_review_gate_path: "reports/diff-gate.json",
    approval: { approvedBy: "maintainer", approvedAt: "2025-01-01T00:00:00Z", approvalId: "approval-1" },
  });
  assert.ok(errors.length > 0 && errors.some((error) => error.includes("is missing")), JSON.stringify(errors));
});

test("validateSandboxApplyReadinessInputs: requires review paths and full approval metadata", () => {
  const errors = validateSandboxApplyReadinessInputs(REPO, { run_id: "" });
  for (const fragment of [
    "run_id must be path-safe",
    "requires oracle_review_path",
    "requires diff_review_gate_path",
    "requires approval.approvedBy",
    "requires approval.approvedAt",
    "requires approval.approvalId",
  ]) {
    assert.ok(errors.some((error) => error.includes(fragment)), `missing: ${fragment} in ${JSON.stringify(errors)}`);
  }
});

test("validateSandboxApplyReadinessInputs: blocks traversal and zero-access review paths", () => {
  const traversal = validateSandboxApplyReadinessInputs(REPO, {
    run_id: "run1",
    oracle_review_path: "../oracle.json",
    diff_review_gate_path: "reports/diff-gate.json",
    approval: { approvedBy: "m", approvedAt: "t", approvalId: "id" },
  });
  assert.ok(traversal.some((error) => error.includes("oracle_review_path") && error.includes("stay inside repo root")));

  const zeroAccess = validateSandboxApplyReadinessInputs(REPO, {
    run_id: "run1",
    oracle_review_path: ".env",
    diff_review_gate_path: "reports/diff-gate.json",
    approval: { approvedBy: "m", approvedAt: "t", approvalId: "id" },
  });
  assert.ok(zeroAccess.some((error) => error.includes("references zero-access path")));
});

test("validateSandbox file-gated validators: block on missing run artifacts", () => {
  const isolated = validateSandboxIsolatedExecutionInputs(REPO, { run_id: "ghost-run" });
  assert.ok(isolated.length > 0 && isolated.some((error) => error.includes("is missing")));

  const diffReview = validateSandboxDiffReviewGateInputs(REPO, { run_id: "ghost-run", oracle_review_path: "reports/o.json" });
  assert.ok(diffReview.length > 0);
});
