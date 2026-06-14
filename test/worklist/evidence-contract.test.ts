// WS-EH1 (canonical-evidence-model PART II keystone): the typed EvidenceContract
// in domains/worklist. This proves the contract shapes, the registry (mirrors the
// WorklistReducer registry EXACTLY), the body-free enforcement, the
// backward-compat guarantee (EvidenceInput `{}` is valid), and that the projected
// Directive.evidenceKind annotation does NOT affect directiveHash (content-addressed
// idempotency is unchanged). Read+test only: no harness source is modified by this
// test; the toy contract is invented here (distinct evidenceId), and NO transposer
// FSM body is copied (evaluateEvidence here is a toy, not the proven transposer FSM).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildDirective,
  directiveHash,
  emptyEvidenceInput,
  evidenceBodyFreeViolations,
  gateVerdictIsValid,
  listEvidenceContractIds,
  normalizeEvidenceInput,
  registerEvidenceContract,
  resolveEvidenceContract,
  type Directive,
  type EvidenceContract,
  type EvidenceInput,
  type EvidenceVerdict,
  type TaskView,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- a toy EvidenceContract (distinct evidenceId='toy-project') ---------------
// Its evaluateEvidence returns kind='accept' when a gate entry with verdict PASS +
// noShip false is present (the proven ACCEPT hard-evidence gate, reduced to a toy).
// It is NOT the transposer FSM; it only proves the contract + registry shapes.
const TOY_EVIDENCE_ID = "toy-project";

const toyContract: EvidenceContract = {
  evidenceId: TOY_EVIDENCE_ID,
  evaluateEvidence(task: TaskView, evidence: EvidenceInput): EvidenceVerdict {
    const gates = Array.isArray(evidence?.gates) ? evidence.gates : [];
    const acceptGate = gates.find((gate) => gate.verdict === "PASS" && gate.noShip === false);
    if (acceptGate) {
      return { satisfied: true, kind: "accept", awaitedKinds: [], gateRef: acceptGate.ref, depRef: null };
    }
    return { satisfied: false, kind: "reject", awaitedKinds: ["accept"], gateRef: null, depRef: null };
  },
};
registerEvidenceContract(toyContract);

// ===========================================================================
// (a) Registry: a project registers an EvidenceContract under its evidenceId;
//     resolveEvidenceContract returns it; listEvidenceContractIds includes it.
//     The contract's evaluateEvidence returns the canonical kind for the seeded
//     evidence (toy: gate PASS + noShip false -> accept).
// ===========================================================================
test("evidence-contract (a): registry resolves a registered contract and returns its verdict", () => {
  const ids = listEvidenceContractIds();
  assert.ok(ids.includes(TOY_EVIDENCE_ID), "toy-project contract must be registered");

  const resolved = resolveEvidenceContract(TOY_EVIDENCE_ID);
  assert.equal(resolved.evidenceId, TOY_EVIDENCE_ID);
  assert.equal(typeof resolved.evaluateEvidence, "function");

  // evaluateEvidence returns kind='accept' when a gate ref matches verdict PASS,
  // noShip false (the proven ACCEPT hard-evidence gate, reduced to a toy).
  const task: TaskView = { ref: "tasks/feature-1.json", status: "claimed_complete" };
  const evidence: EvidenceInput = {
    gates: [{ ref: "tasks/feature-1/oracle-review.json", verdict: "PASS", noShip: false, discoveredVia: "cited" }],
  };
  const verdict = resolved.evaluateEvidence(task, evidence);
  assert.equal(verdict.satisfied, true);
  assert.equal(verdict.kind, "accept");
  assert.deepEqual(verdict.awaitedKinds, []);
  assert.equal(verdict.gateRef, "tasks/feature-1/oracle-review.json");
  assert.equal(verdict.depRef, null);

  // Missing the PASS gate -> reject (awaitedKinds=[accept]) — the proven not-satisfied
  // claim verdict, reduced to the toy.
  const verdictMissing = resolved.evaluateEvidence(task, { gates: [] });
  assert.equal(verdictMissing.satisfied, false);
  assert.equal(verdictMissing.kind, "reject");
  assert.deepEqual(verdictMissing.awaitedKinds, ["accept"]);
});

// ===========================================================================
// (b) A missing contract is a TYPED ERROR, not a silent {} (the headline WS-EH1
//     acceptance). resolveEvidenceContract throws an Error mentioning the canonical
//     'Unknown evidence contract' message.
// ===========================================================================
test("evidence-contract (b): resolving an unknown evidenceId throws a typed error", () => {
  assert.throws(
    () => resolveEvidenceContract("does-not-exist"),
    /Unknown evidence contract/,
  );
  // Registering a contract missing evaluateEvidence is also a typed error.
  assert.throws(
    // @ts-expect-error -- intentionally invalid contract shape for the runtime guard
    () => registerEvidenceContract({ evidenceId: "broken-contract" }),
    /missing evaluateEvidence/,
  );
});

// ===========================================================================
// (c) evidenceBodyFreeViolations: the body-free posture is enforced on every
//     EvidenceInput/GateEntry/DepEntry/EvidenceVerdict. A forbidden key
//     (prompt/body/task/output/content/message/text/diff/patch) at ANY depth is
//     rejected; a clean EvidenceInput passes (returns []).
// ===========================================================================
test("evidence-contract (c): evidenceBodyFreeViolations rejects forbidden keys and accepts clean inputs", () => {
  // Clean EvidenceInput -> no violations.
  const clean: EvidenceInput = {
    gates: [{ ref: "gates/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited" }],
    deps: [{ ref: "deps/downstream.json", status: "accepted", invalidated: false }],
  };
  assert.deepEqual(evidenceBodyFreeViolations(clean), []);

  // Forbidden key at the top level -> rejected.
  assert.ok(evidenceBodyFreeViolations({ gates: [], deps: [], prompt: "do the thing" }).length > 0);

  // Forbidden key nested inside a gate entry -> rejected (deep scan).
  const nestedForbidden = {
    gates: [{ ref: "gates/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited", body: "raw oracle prose" }],
    deps: [],
  };
  const nestedViolations = evidenceBodyFreeViolations(nestedForbidden);
  assert.ok(nestedViolations.length > 0, "a forbidden key nested in a gate entry must be rejected");
  assert.ok(nestedViolations.some((v) => v.includes("body")), `violation path should name the forbidden key: ${nestedViolations.join(", ")}`);

  // EvidenceVerdict carrying a forbidden key -> rejected too.
  const verdictForbidden = { satisfied: true, kind: "accept", awaitedKinds: [], gateRef: null, depRef: null, output: "leaked" };
  assert.ok(evidenceBodyFreeViolations(verdictForbidden).length > 0);
});

// ===========================================================================
// (d) emptyEvidenceInput() returns the canonical empty EvidenceInput
//     { gates: [], deps: [] }.
// ===========================================================================
test("evidence-contract (d): emptyEvidenceInput returns { gates: [], deps: [] }", () => {
  const empty = emptyEvidenceInput();
  assert.deepEqual(empty, { gates: [], deps: [] });
  // It is body-free.
  assert.deepEqual(evidenceBodyFreeViolations(empty), []);
});

// ===========================================================================
// (e) Backward-compat guarantee: EvidenceInput `{}` is valid (gates/deps default).
//     This is what keeps the store's existing `evidence: {}` passes compiling
//     unchanged in EH1. normalizeEvidenceInput + the toy contract both tolerate {}.
// ===========================================================================
test("evidence-contract (e): EvidenceInput `{}` is valid (backward-compat guarantee)", () => {
  const empty: EvidenceInput = {};
  // normalizeEvidenceInput fills the defaulted arrays.
  assert.deepEqual(normalizeEvidenceInput(empty), { gates: [], deps: [] });
  assert.deepEqual(normalizeEvidenceInput({}), { gates: [], deps: [] });
  assert.deepEqual(normalizeEvidenceInput(null), { gates: [], deps: [] });
  assert.deepEqual(normalizeEvidenceInput(undefined), { gates: [], deps: [] });
  // The toy contract tolerates {} (it defaults gates to []).
  const verdict = resolveEvidenceContract(TOY_EVIDENCE_ID).evaluateEvidence({ ref: "tasks/x.json" }, {});
  assert.equal(verdict.kind, "reject");
  // gateVerdictIsValid is a faithful reader.
  assert.equal(gateVerdictIsValid("PASS"), true);
  assert.equal(gateVerdictIsValid("FAIL"), true);
  assert.equal(gateVerdictIsValid("UNKNOWN"), true);
  assert.equal(gateVerdictIsValid("MAYBE"), false);
});

// ===========================================================================
// (f) Directive.evidenceKind is a projected annotation, NOT identity: the same
//     { action, owner, evidence_refs(sorted), deadline } yields the SAME hash
//     whether evidenceKind is set, null, or absent. This is the content-addressed
//     idempotency guarantee WS-H1/WS-H2 delivery relies on — adding the optional
//     evidenceKind field must not break it.
// ===========================================================================
test("evidence-contract (f): Directive.evidenceKind does not affect directiveHash (projected annotation, not identity)", () => {
  const action = "ACCEPT";
  const owner = "worker-a";
  const refs = ["reports/run-a/evidence-1.json"];
  const deadline = "2026-06-13T20:00:00.000Z";

  // directiveHash is computed ONLY over { action, owner, evidence_refs(sorted),
  // deadline } — evidenceKind is not an input.
  const hash = directiveHash(action, owner, refs, deadline);

  // Two directives identical except evidenceKind: one carries the annotation
  // (evidenceKind='accept'), the other omits it (undefined). Their hash fields are
  // equal because directiveHash does not see evidenceKind.
  const base = buildDirective({ action, owner, evidenceRequired: refs, deadline }) as Directive;
  const annotated: Directive = { ...base, evidenceKind: "accept" };
  const nulled: Directive = { ...base, evidenceKind: null };
  assert.equal(annotated.hash, hash);
  assert.equal(nulled.hash, hash);
  assert.equal(base.hash, hash);
  // evidenceKind itself is independent of the hash.
  assert.equal(annotated.evidenceKind, "accept");
  assert.equal(nulled.evidenceKind, null);
  assert.equal(base.evidenceKind, undefined);
});
