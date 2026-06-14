// WS-EH2 (canonical-evidence-model PART II): evidence-aware WorklistReducer /
// Directive / store. Proves the MECHANISM shipped in EH2 — Directive.evidenceKind
// is derived from evaluateEvidence when a contract is present; the store threads a
// real EvidenceInput (via the new optional evidence param) instead of evidence:{};
// the generic reducer is backward compatible (no contract => evidenceKind null,
// evidencePresent false); directiveHash stability holds (evidenceKind is a projected
// annotation, NOT identity). Additive + metadata-only + body-free + network-disabled.
//
// The toy contract + toy reducer are INVENTED here (distinct evidenceId/reducerId
// 'toy-evi'); NO transposer FSM body is copied (this is the proven MECHANISM, not
// the transposer FSM, which registers in WS-EH4).
//
//   (a) toy reducer + toy contract + PASS gate => evidenceKind 'accept' + true
//   (b) toy reducer + toy contract + no PASS gate => reject/await + false
//   (c) GENERIC reducer, NO contract + emptyEvidenceInput => null/false (compat)
//   (c2) GENERIC reducer consults evidence when a contract IS present (guarded)
//   (d) store.projectWorklist(..., evidence) threads evidence; directive reflects
//   (e) evidence carrying a forbidden plaintext key is rejected (throws)
//   (f) directiveHash stability: same {action,owner,evidence_refs,deadline} =>
//       identical hash whether evidenceKind is populated or null (NOT identity)

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  GENERIC_WORKLIST_REDUCER_ID,
  buildDirective,
  directiveHash,
  emptyEvidenceInput,
  evaluateEvidenceForDirective,
  genericWorklistReducer,
  listWorklistDirectives,
  openWorklistStore,
  projectWorklist,
  registerEvidenceContract,
  registerWorklistReducer,
  resolveEvidenceContract,
  type Directive,
  type EvidenceContract,
  type EvidenceInput,
  type EvidenceVerdict,
  type TaskView,
  type WorklistEvent,
  type WorklistReducer,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- a toy EvidenceContract (evidenceId='toy-evi') ---------------------------
// Self-contained: a PASS gate (verdict=PASS + noShip=false) => accept; a FAIL gate
// => reject (awaitedKinds=[accept]); no gate => await. This is NOT the transposer
// FSM — it only proves the contract-consultation mechanism.
const TOY_EVI_ID = "toy-evi";

const toyContract: EvidenceContract = {
  evidenceId: TOY_EVI_ID,
  evaluateEvidence(_task: TaskView, evidence: EvidenceInput): EvidenceVerdict {
    const gates = Array.isArray(evidence?.gates) ? evidence.gates : [];
    const passGate = gates.find((gate) => gate.verdict === "PASS" && gate.noShip === false);
    if (passGate) {
      return { satisfied: true, kind: "accept", awaitedKinds: [], gateRef: passGate.ref, depRef: null };
    }
    const failGate = gates.find((gate) => gate.verdict === "FAIL");
    if (failGate) {
      return { satisfied: false, kind: "reject", awaitedKinds: ["accept"], gateRef: failGate.ref, depRef: null };
    }
    return { satisfied: false, kind: "await", awaitedKinds: ["accept"], gateRef: null, depRef: null };
  },
};
registerEvidenceContract(toyContract);

// --- a toy WorklistReducer (reducerId='toy-evi') ------------------------------
// A project reducer that CONSULTS deps.evidenceContract to derive
// Directive.evidenceKind via evaluateEvidenceForDirective. Its own minimal FSM:
// one ACT directive per OPEN work item; the projected evidence verdict is layered
// on top. evidenceKind never enters the hash (proven in (f)).
const TOY_REDUCER_ID = "toy-evi";

const toyReducer: WorklistReducer = {
  reducerId: TOY_REDUCER_ID,
  computeDirectives(events, deps, now) {
    const openByRef = new Map<string, WorklistEvent>();
    const order: string[] = [];
    for (const event of events) {
      const key = event.ref ?? `event:${event.eventId}`;
      const kind = String(event.kind ?? "").toUpperCase();
      if (kind === "OPEN") {
        if (!openByRef.has(key)) order.push(key);
        openByRef.set(key, event);
      } else if (kind === "CLOSE") {
        openByRef.delete(key);
      }
    }
    const directives: Directive[] = [];
    for (const key of order) {
      const event = openByRef.get(key);
      if (!event) continue;
      const deadlineMs = event.deadline === null ? NaN : Date.parse(event.deadline);
      const due = event.deadline === null || (Number.isFinite(deadlineMs) && deadlineMs <= now);
      if (!due) continue;
      const directive = buildDirective({
        action: "ACT",
        ref: event.ref,
        owner: event.owner ?? "unassigned",
        reasonRef: event.reasonRef,
        unblockPath: event.unblockPath,
        evidenceRequired: event.evidenceRefs,
        evidencePresent: false,
        deadline: event.deadline,
      });
      // Consult the registered contract to layer the projected evidence verdict.
      const taskView: TaskView = { ref: event.ref ?? null, status: "OPEN" };
      const annotation = evaluateEvidenceForDirective(deps.evidenceContract, taskView, deps.evidence);
      if (annotation) {
        directive.evidenceKind = annotation.evidenceKind;
        directive.evidencePresent = annotation.evidencePresent;
      }
      directives.push(directive);
    }
    directives.sort(
      (a, b) =>
        String(a.deadline ?? "").localeCompare(String(b.deadline ?? "")) ||
        String(a.ref ?? "").localeCompare(String(b.ref ?? "")) ||
        String(a.hash).localeCompare(String(b.hash)),
    );
    return directives;
  },
  validateEvent(event) {
    const errors: string[] = [];
    if (!event.kind || String(event.kind).trim().length === 0) errors.push("toy-evi: event kind must be non-empty");
    return errors;
  },
};
registerWorklistReducer(toyReducer);

let repo = "";
const BASE_NOW = 1_700_000_000_000; // deterministic clock

before(() => {
  repo = mkdtempSync(join(tmpdir(), "zob-eh2-"));
});

after(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp repo */
  }
});

// ===========================================================================
// (a) toy reducer + toy contract + a PASS-gate EvidenceInput => the Directive's
//     evidenceKind === 'accept' (matching the toy contract's verdict) AND
//     evidencePresent === true. The verdict matches what the contract returns
//     directly for the same (taskView, evidence) — proving the reducer threaded
//     the contract's verdict into the projected annotation.
// ===========================================================================
test("eh2 (a): toy reducer + toy contract + PASS gate => evidenceKind 'accept' + evidencePresent true", () => {
  const scope = "eh2-toy-accept";
  const owner = "evi-worker";
  const ref = "tasks/eh2-accept.json";
  // deadline=null => immediately actionable (the generic reducer's due semantics).
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  store.appendEvent({ scope, reducer_id: TOY_REDUCER_ID, kind: "OPEN", ref, owner });

  const evidence: EvidenceInput = {
    gates: [{ ref: "reports/eh2-accept/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited" }],
  };
  const directives = listWorklistDirectives(repo, scope, BASE_NOW, evidence);
  assert.equal(directives.length, 1);
  const directive = directives[0];
  assert.equal(directive.action, "ACT");
  assert.equal(directive.evidenceKind, "accept");
  assert.equal(directive.evidencePresent, true);

  // The projected annotation matches the contract's own verdict for the same view.
  const verdict = resolveEvidenceContract(TOY_EVI_ID).evaluateEvidence({ ref, status: "OPEN" }, evidence);
  assert.equal(verdict.kind, directive.evidenceKind);
  assert.equal(verdict.satisfied, directive.evidencePresent);
});

// ===========================================================================
// (b) toy reducer + toy contract + evidence with NO pass gate => evidenceKind
//     reflects the toy contract's 'reject' (FAIL gate) / 'await' (no gate) verdict
//     and evidencePresent is false.
// ===========================================================================
test("eh2 (b): toy reducer + toy contract + no PASS gate => reject/await + evidencePresent false", () => {
  const scope = "eh2-toy-nopass";
  const owner = "evi-worker";
  const ref = "tasks/eh2-nopass.json";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  store.appendEvent({ scope, reducer_id: TOY_REDUCER_ID, kind: "OPEN", ref, owner });

  // A FAIL gate (present, just not a pass) => reject (not satisfied).
  const failEvidence: EvidenceInput = {
    gates: [{ ref: "reports/eh2-nopass/oracle.json", verdict: "FAIL", noShip: false, discoveredVia: "cited" }],
  };
  const failDirectives = listWorklistDirectives(repo, scope, BASE_NOW, failEvidence);
  assert.equal(failDirectives.length, 1);
  assert.equal(failDirectives[0].evidenceKind, "reject");
  assert.equal(failDirectives[0].evidencePresent, false);

  // No gate at all => await (not satisfied).
  const awaitDirectives = listWorklistDirectives(repo, scope, BASE_NOW, emptyEvidenceInput());
  assert.equal(awaitDirectives.length, 1);
  assert.equal(awaitDirectives[0].evidenceKind, "await");
  assert.equal(awaitDirectives[0].evidencePresent, false);
});

// ===========================================================================
// (c) GENERIC reducer backward compatibility (critical): with NO contract (the
//     default for 'generic') and an emptyEvidenceInput, the projected Directive
//     keeps the historical behavior — evidenceKind is null/undefined and
//     evidencePresent is false. Nothing changes for existing consumers.
// ===========================================================================
test("eh2 (c): GENERIC reducer, NO contract + emptyEvidenceInput => evidenceKind null + evidencePresent false (backward compat)", () => {
  const scope = "eh2-generic-nocontract";
  const owner = "gen-worker";
  const ref = "tasks/eh2-generic.json";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  store.appendEvent({ scope, reducer_id: GENERIC_WORKLIST_REDUCER_ID, kind: "OPEN", ref, owner });

  // No contract registered under 'generic' => store threads no contract.
  const directives = listWorklistDirectives(repo, scope, BASE_NOW, emptyEvidenceInput());
  assert.equal(directives.length, 1);
  assert.equal(directives[0].evidenceKind, undefined);
  assert.equal(directives[0].evidencePresent, false);
  // And the no-evidence default (undefined) behaves identically.
  const defaultDirectives = listWorklistDirectives(repo, scope, BASE_NOW);
  assert.equal(defaultDirectives[0].evidenceKind, undefined);
  assert.equal(defaultDirectives[0].evidencePresent, false);
});

// ===========================================================================
// (c2) GENERIC reducer built-in evidence-awareness: when a contract IS present
//      AND evidence is non-empty, the generic reducer consults it and populates
//      evidenceKind/evidencePresent. Without a contract the same events yield no
//      annotation (the backward-compat guard). Proves the helper is wired into the
//      shipped generic reducer, not just the toy reducer.
// ===========================================================================
test("eh2 (c2): GENERIC reducer consults evidence when a contract is present (guarded built-in evidence-awareness)", () => {
  const scope = "eh2-generic-contract";
  const owner = "gen-worker";
  const ref = "tasks/eh2-generic-c2.json";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  store.appendEvent({ scope, kind: "OPEN", ref, owner });
  const events = store.listEvents();

  const evidence: EvidenceInput = {
    gates: [{ ref: "reports/eh2-c2/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited" }],
  };

  // Contract + non-empty evidence => generic reducer consults it.
  const withContract = genericWorklistReducer.computeDirectives(events, { evidence, evidenceContract: toyContract }, BASE_NOW);
  assert.equal(withContract.length, 1);
  assert.equal(withContract[0].evidenceKind, "accept");
  assert.equal(withContract[0].evidencePresent, true);

  // Same events, NO contract => no consultation (backward compat).
  const noContract = genericWorklistReducer.computeDirectives(events, { evidence }, BASE_NOW);
  assert.equal(noContract.length, 1);
  assert.equal(noContract[0].evidenceKind, undefined);
  assert.equal(noContract[0].evidencePresent, false);

  // Contract present but EMPTY evidence => generic reducer does not consult
  // (the conservative backward-compat guard).
  const emptyEvidence = genericWorklistReducer.computeDirectives(events, { evidence: emptyEvidenceInput(), evidenceContract: toyContract }, BASE_NOW);
  assert.equal(emptyEvidence.length, 1);
  assert.equal(emptyEvidence[0].evidenceKind, undefined);
  assert.equal(emptyEvidence[0].evidencePresent, false);
});

// ===========================================================================
// (d) store.projectWorklist threads the supplied EvidenceInput AND resolves the
//     scope's EvidenceContract by reducer_id, so the projected directive reflects
//     the supplied evidence. With no evidence the toy contract returns 'await';
//     with a PASS gate it returns 'accept'. The hash is identical in both cases
//     (evidenceKind is a projected annotation, not identity — full proof in (f)).
// ===========================================================================
test("eh2 (d): store.projectWorklist threads supplied evidence; the projection directive reflects it", () => {
  const scope = "eh2-store-thread";
  const owner = "evi-worker";
  const ref = "tasks/eh2-store.json";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  store.appendEvent({ scope, reducer_id: TOY_REDUCER_ID, kind: "OPEN", ref, owner });

  // No evidence supplied => default emptyEvidenceInput => toy contract => 'await'.
  const projectionDefault = projectWorklist(repo, scope, BASE_NOW);
  assert.equal(projectionDefault.directives.length, 1);
  assert.equal(projectionDefault.directives[0].evidenceKind, "await");
  assert.equal(projectionDefault.directives[0].evidencePresent, false);

  // Supply a PASS gate => the directive reflects 'accept'.
  const projectionAccept = projectWorklist(repo, scope, BASE_NOW, {
    gates: [{ ref: "reports/eh2-store/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited" }],
  });
  assert.equal(projectionAccept.directives.length, 1);
  assert.equal(projectionAccept.directives[0].evidenceKind, "accept");
  assert.equal(projectionAccept.directives[0].evidencePresent, true);

  // Hash is identical (evidenceKind is a projected annotation, not identity).
  assert.equal(projectionDefault.directives[0].hash, projectionAccept.directives[0].hash);

  // The projection is internally consistent (validate re-derives the same hashes).
  const validation = store.validate(BASE_NOW);
  assert.equal(validation.healthy, true);
  assert.equal(validation.violations.length, 0);
});

// ===========================================================================
// (e) Body-free posture: an EvidenceInput carrying a FORBIDDEN_PLAINTEXT_KEYS key
//     (body/task/prompt/output/content/message/text/rationale/diff/patch) at ANY
//     depth is rejected before it is threaded — projectWorklist and
//     listWorklistDirectives throw. No raw bodies are ever threaded or persisted.
// ===========================================================================
test("eh2 (e): evidence carrying a forbidden plaintext key is rejected (throws before threading)", () => {
  const scope = "eh2-forbidden";
  const owner = "evi-worker";
  const ref = "tasks/eh2-forbidden.json";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  store.appendEvent({ scope, reducer_id: TOY_REDUCER_ID, kind: "OPEN", ref, owner });

  const forbidden = {
    gates: [{ ref: "reports/eh2-forbidden/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited", body: "raw oracle prose" }],
  };
  assert.throws(
    () => projectWorklist(repo, scope, BASE_NOW, forbidden as unknown as EvidenceInput),
    /forbidden plaintext/,
  );
  assert.throws(
    () => listWorklistDirectives(repo, scope, BASE_NOW, forbidden as unknown as EvidenceInput),
    /forbidden plaintext/,
  );
});

// ===========================================================================
// (f) directiveHash stability regression: for the SAME {action, owner,
//     evidence_refs(sorted), deadline}, the hash is IDENTICAL whether evidenceKind
//     is populated ('accept'/'reject'), null, or absent. This guards the WS-H2
//     content-addressed idempotency/delivery that depends on directiveHash
//     stability — evidenceKind is a projected annotation, NOT identity. Proven both
//     at the hash level and end-to-end through the store.
// ===========================================================================
test("eh2 (f): directiveHash stability — projected evidenceKind does not change the hash", () => {
  const action = "ACT";
  const owner = "evi-worker";
  const refs = ["reports/eh2-stable/evidence-1.json"];
  const deadline = "2026-06-14T20:00:00.000Z";
  const hash = directiveHash(action, owner, refs, deadline);

  // Directives identical except evidenceKind share the hash.
  const base = buildDirective({ action, owner, evidenceRequired: refs, deadline });
  const accept: Directive = { ...base, evidenceKind: "accept" };
  const reject: Directive = { ...base, evidenceKind: "reject" };
  const nulled: Directive = { ...base, evidenceKind: null };
  assert.equal(base.hash, hash);
  assert.equal(accept.hash, hash);
  assert.equal(reject.hash, hash);
  assert.equal(nulled.hash, hash);
  // The annotations differ; the hashes do not.
  assert.equal(accept.evidenceKind, "accept");
  assert.equal(reject.evidenceKind, "reject");
  assert.equal(base.evidenceKind, undefined);

  // End-to-end: the same OPEN event projected with PASS-gate evidence vs default
  // (no) evidence yields directives with DIFFERENT evidenceKind but the SAME hash.
  const scope = "eh2-hash-stability";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  store.appendEvent({ scope, reducer_id: TOY_REDUCER_ID, kind: "OPEN", ref: "tasks/eh2-stable.json", owner });
  const withPass = listWorklistDirectives(repo, scope, BASE_NOW, {
    gates: [{ ref: "reports/eh2-stable/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited" }],
  });
  const withNone = listWorklistDirectives(repo, scope, BASE_NOW, emptyEvidenceInput());
  assert.equal(withPass[0].hash, withNone[0].hash);
  assert.notEqual(withPass[0].evidenceKind, withNone[0].evidenceKind); // accept vs await
});
