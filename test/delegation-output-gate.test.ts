import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  applyChildGates,
  getOutputContractDefinitions,
  getOutputContractFinalMarker,
  inferOutputContract,
} from "../.pi/extensions/zob-harness/index.ts";
import { classifyChildFailure, finalFormatGuidance } from "../.pi/extensions/zob-harness/src/runtime/tools-delegation/helpers.ts";
import type { ChildResult } from "../.pi/extensions/zob-harness/src/types.ts";

function childResult(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    agent: "implementer",
    task: "bounded test",
    exitCode: 0,
    output: "",
    stderr: "",
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
    ...overrides,
  };
}

test("child runtime failure stays primary when output gate also fails", () => {
  const result = childResult({ exitCode: 1, stopReason: "error", errorMessage: "provider failed", outputContract: "implement.v1" });
  applyChildGates(result);

  assert.equal(result.gatePassed, false);
  assert.ok((result.gateIssues?.length ?? 0) > 0);
  assert.ok(result.gateIssues?.every((issue) => issue.failureKind === "output_gate"));
  assert.equal(classifyChildFailure(result), "child_runtime");
});

test("supervised dispatcher reports runtime error hash before output-gate hash", () => {
  const childRunnerSource = readFileSync(new URL("../.pi/extensions/zob-harness/src/domains/delegation/child-runner.ts", import.meta.url), "utf8");
  assert.match(childRunnerSource, /error: runtimeErrorHash \?\? gateErrorHash \?\? `child_failed:/);
  assert.doesNotMatch(childRunnerSource, /error: gateErrorHash \?\? runtimeErrorHash \?\? `child_failed:/);
});

test("output gate is primary only when child runtime completed successfully", () => {
  const result = childResult({ outputContract: "implement.v1" });
  applyChildGates(result);
  assert.equal(classifyChildFailure(result), "output_gate");
});

test("all agent-inferred contracts receive exact required fields and final marker guidance", () => {
  const inferredAgents = [
    "explore",
    "planner",
    "implementer",
    "oracle",
    "qa",
    "synthesis",
    "oracle-merge",
    "factory",
    "librarian",
    "context-steward",
    "specifier",
    "clarifier",
    "guidance-steward",
    "temp-agent-creator",
  ];
  const definitions = new Map(getOutputContractDefinitions().map((definition) => [definition.id, definition.required]));

  for (const agent of inferredAgents) {
    const contractId = inferOutputContract(agent);
    const guidance = finalFormatGuidance(contractId).join("\n");
    const required = definitions.get(contractId);
    assert.ok(required, `missing definition for ${agent}/${contractId}`);
    for (const field of required) assert.ok(guidance.includes(field), `${contractId} guidance missing exact field ${field}`);
    const marker = getOutputContractFinalMarker(contractId);
    assert.ok(marker, `missing marker for ${contractId}`);
    assert.ok(guidance.includes(`final line must be exactly: ${marker}`), `${contractId} guidance missing exact marker ${marker}`);
  }
});

test("non-default contract markers remain exact", () => {
  const cases: Array<[string, string]> = [
    ["todo-child-result.v1", "FINAL_MARKER: TODO_CHILD_RESULT_END"],
    ["todo-child-result.v2", "FINAL_MARKER: TODO_CHILD_RESULT_V2_END"],
    ["todo-claim-validation.v1", "FINAL_MARKER: TODO_CLAIM_VALIDATION_END"],
    ["todo-split-request.v1", "FINAL_MARKER: TODO_SPLIT_REQUEST_END"],
    ["delegation-request.v1", "FINAL_MARKER: DELEGATION_REQUEST_END"],
    ["oracle-request.v1", "FINAL_MARKER: ORACLE_REQUEST_END"],
    ["context-request.v1", "FINAL_MARKER: CONTEXT_REQUEST_END"],
  ];
  for (const [contractId, marker] of cases) {
    assert.equal(getOutputContractFinalMarker(contractId), marker);
    assert.ok(finalFormatGuidance(contractId).includes(`- final line must be exactly: ${marker}`));
  }
});
