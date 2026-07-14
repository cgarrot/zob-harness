import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  applyChildGates,
  inferOutputContract,
  listOutputContracts,
  validateChildOutput,
  validateOutputContract,
  validateOutputContractId,
  validateOutputContractIssues,
} from "../.pi/extensions/zob-harness/index.ts";

const PASSING_BASE = [
  "Did the work as scoped.",
  "evidence: ran the unit suite and captured output.",
  "risks/blockers: none observed.",
  "compliance: followed all MUST NOT rules; no secret reads.",
  "deliverable_delivered: yes",
].join("\n");

test("listOutputContracts: exposes the known contract ids", () => {
  const ids = listOutputContracts();
  for (const id of ["base.v1", "explore.v1", "plan.v1", "implement.v1", "oracle.v1"]) {
    assert.ok(ids.includes(id), `expected ${id} in ${JSON.stringify(ids)}`);
  }
});

test("inferOutputContract: maps agent names (case-insensitively) to contracts", () => {
  const cases: Array<[string, string]> = [
    ["oracle", "oracle.v1"],
    ["ORACLE", "oracle.v1"],
    ["planner", "plan.v1"],
    ["explore", "explore.v1"],
    ["implementer", "implement.v1"],
    ["totally-unknown-agent", "base.v1"],
  ];
  for (const [agent, expected] of cases) {
    assert.equal(inferOutputContract(agent), expected, `agent ${agent}`);
  }
});

test("validateOutputContractId: rejects unknown ids only", () => {
  assert.deepEqual(validateOutputContractId(undefined), []);
  assert.deepEqual(validateOutputContractId("base.v1"), []);
  const unknown = validateOutputContractId("does-not-exist.v9");
  assert.equal(unknown.length, 1);
  assert.ok(unknown[0].includes("Unknown output contract 'does-not-exist.v9'"));
});

test("validateOutputContract: accepts a complete base.v1 output", () => {
  assert.deepEqual(validateOutputContract(PASSING_BASE, "base.v1"), []);
});

test("validateOutputContract: rejects empty output", () => {
  assert.deepEqual(validateOutputContract("", "base.v1"), ["Child produced no assistant output"]);
  assert.deepEqual(validateOutputContractIssues("", "base.v1"), [{
    code: "empty_output",
    classification: "output_missing",
    failureKind: "output_gate",
    contractId: "base.v1",
    requirement: undefined,
    message: "Child produced no assistant output",
  }]);
});

test("validateOutputContract: requires the final deliverable marker", () => {
  const noMarker = [
    "Did the work.",
    "evidence: ran tests.",
    "risks/blockers: none.",
    "compliance: ok.",
  ].join("\n");
  const errors = validateOutputContract(noMarker, "base.v1");
  assert.ok(errors.some((error) => error.includes("Missing required final marker: deliverable_delivered")), JSON.stringify(errors));
});

test("validateOutputContract: flags an explicit deliverable_delivered: no", () => {
  const declined = [
    "evidence: attempted but blocked.",
    "risks/blockers: dependency missing.",
    "compliance: ok.",
    "deliverable_delivered: no",
  ].join("\n");
  const errors = validateOutputContract(declined, "base.v1");
  assert.ok(errors.some((error) => error === "Child reported deliverable_delivered: no"), JSON.stringify(errors));
});

test("validateOutputContract: unknown contract id surfaces an unknown-id error", () => {
  const errors = validateOutputContract(PASSING_BASE, "nope.v1");
  assert.ok(errors.some((error) => error.includes("Unknown output contract 'nope.v1'")));
});

test("validateChildOutput: infers the contract from the agent name", () => {
  assert.deepEqual(validateChildOutput({ agent: "totally-unknown-agent", output: PASSING_BASE }), []);

  const declined = validateChildOutput({
    agent: "totally-unknown-agent",
    output: ["evidence: x", "risks: none", "compliance: ok", "deliverable_delivered: no"].join("\n"),
  });
  assert.ok(declined.some((error) => error === "Child reported deliverable_delivered: no"));
});

test("structured gate issues preserve gateErrors message compatibility", () => {
  const output = ["compliance: ok", "deliverable_delivered: yes"].join("\n");
  const expectedErrors = validateOutputContract(output, "base.v1");
  const result = applyChildGates({
    agent: "unknown",
    task: "test",
    exitCode: 0,
    output,
    stderr: "",
    outputContract: "base.v1",
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
  });

  assert.deepEqual(result.gateErrors, expectedErrors);
  assert.equal(result.gatePassed, false);
  assert.deepEqual(result.gateIssues?.map(({ code, classification, failureKind, requirement, message }) => ({ code, classification, failureKind, requirement, message })), [
    { code: "missing_requirement", classification: "contract_format", failureKind: "output_gate", requirement: "evidence", message: "Missing evidence/proof section" },
    { code: "missing_requirement", classification: "contract_format", failureKind: "output_gate", requirement: "risks_blockers", message: "Missing risks/blockers section" },
  ]);
});

test("unknown output contracts expose a stable configuration issue without changing the error", () => {
  const errors = validateOutputContract(PASSING_BASE, "nope.v1");
  const issues = validateOutputContractIssues(PASSING_BASE, "nope.v1");
  assert.deepEqual(issues.map((issue) => issue.message), errors);
  assert.equal(issues[0]?.code, "unknown_contract");
  assert.equal(issues[0]?.classification, "contract_configuration");
});

test("bound TODO output correlation is an exact semantic gate", () => {
  const expectedTodoId = "todo_aaaaaaaaaaaa";
  const exact = applyChildGates({
    agent: "unknown",
    task: "test",
    exitCode: 0,
    output: `todo_id: ${expectedTodoId}\n${PASSING_BASE}`,
    stderr: "",
    outputContract: "base.v1",
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
  }, { expectedTodoId });
  assert.equal(exact.gatePassed, true);

  const mismatch = applyChildGates({
    ...exact,
    output: `todo_id: 1.2\n${PASSING_BASE}`,
    gateIssues: undefined,
    gateErrors: undefined,
    gatePassed: undefined,
  }, { expectedTodoId });
  assert.equal(mismatch.gatePassed, false);
  assert.ok(mismatch.gateIssues?.some((issue) => issue.code === "mismatched_todo_id" && issue.classification === "output_gate_semantic"));
});
