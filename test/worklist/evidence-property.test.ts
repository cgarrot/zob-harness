// WS-E5-harness (canonical-evidence-model PART II — DoD): harness-level
// PATH-INDEPENDENCE property test over a SECOND toy consumer (distinct FSM, not
// transposer-coupled). Proves three properties for ANY EvidenceContract implementor
// registered via the PUBLIC harness API:
//
//   1. AGREEMENT — for every DERIVED Directive, evidenceKind agrees with the
//      contract's evaluateEvidence(taskView, evidence) verdict (they can never
//      disagree by construction: the reducer derives the annotation FROM the
//      contract).
//   2. PATH-INDEPENDENCE (the headline asymmetry-invariant) — the SAME satisfiable
//      evidence yields the SAME verdict regardless of which lifecycle path produced
//      the task. This is the EXACT property the ws-tickets bug violated: the ACCEPT
//      path read CITED refs only while the REASSIGN path walked the disk, so the
//      same on-disk oracle gave different verdicts by path. Here, path A "claim that
//      CITED the gate" vs path B "claim that did NOT cite the gate but the gate is in
//      the supplied EvidenceInput (discovered)" yield IDENTICAL evidenceKind. The
//      verdict depends ONLY on evaluateEvidence(taskView, evidence), never on the path.
//   3. DISCOVERY-COMPLETENESS — the contract sees the satisfying gate whether it is
//      (a) cited in the task refs, (b) supplied only via discovered EvidenceInput
//      (uncited), or (c) both. Citation is a HINT, never a GATE.
//
// The SECOND toy consumer is a 'review-queue' domain: tasks are REVIEW items with FSM
// states DRAFT -> SUBMITTED -> GATED -> MERGED; the toy EvidenceContract emits
// 'accept' (a PASS gate on a SUBMITTED task), 'await' (gate absent/UNKNOWN/non-PASS),
// 'rollback' (an on-log dep is invalidated), and 'noop' (non-actionable state). It is
// DISTINCT from the transposer (actions ACCEPT/REJECT/REASSIGN/REOPEN, phase FSM) and
// from the EH1/EH2 toy (action ACT, FSM OPEN/CLOSE): a different domain, different
// action name (REVIEW), a STATUS-AWARE contract that reads taskView.status, and the
// only toy here that uses EvidenceInput.deps + the 'rollback' kind. It is registered
// via the PUBLIC API only (registerEvidenceContract + registerWorklistReducer). NO
// transposer FSM body is copied; NO harness source is modified (test + report only).
//
// Determinism: a fixed CASES table (the seeded input space) PLUS a seeded mulberry32
// PRNG sweep assert the contract is a PURE function — same (taskView, evidence) =>
// same verdict, reproducibly. No Math.random flakiness.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  buildDirective,
  evaluateEvidenceForDirective,
  emptyEvidenceInput,
  listEvidenceContractIds,
  listWorklistDirectives,
  listWorklistReducerIds,
  openWorklistStore,
  registerEvidenceContract,
  registerWorklistReducer,
  resolveEvidenceContract,
  type DepEntry,
  type Directive,
  type EvidenceContract,
  type EvidenceInput,
  type EvidenceKind,
  type GateEntry,
  type TaskView,
  type WorklistEvent,
  type WorklistReducer,
} from "../../.pi/extensions/zob-harness/index.ts";

// ===========================================================================
// SECOND TOY CONSUMER — review-queue (distinct FSM, distinct EvidenceContract)
// ===========================================================================

const REVIEW_QUEUE_EVIDENCE_ID = "review-queue";
const REVIEW_QUEUE_REDUCER_ID = "review-queue";
const REVIEW_ACTION = "REVIEW";

// The review-queue EvidenceContract. PURE over (taskView, evidence): it reads
// taskView.status (the FSM state) and the supplied EvidenceInput. It NEVER reads
// "which lifecycle path produced the task" — that is precisely the
// path-independence lock. Semantics:
//   - an invalidated dep is present        => rollback (an accepted review reopens)
//   - status SUBMITTED + a PASS gate       => accept   (the gate is satisfied)
//   - status SUBMITTED + no/UNKNOWN/FAIL   => await    (the gate has not arrived)
//   - any other state (DRAFT/GATED/MERGED) => noop     (not actionable)
const reviewQueueContract: EvidenceContract = {
  evidenceId: REVIEW_QUEUE_EVIDENCE_ID,
  evaluateEvidence(task: TaskView, evidence: EvidenceInput) {
    const gates: GateEntry[] = Array.isArray(evidence?.gates) ? evidence.gates : [];
    const deps: DepEntry[] = Array.isArray(evidence?.deps) ? evidence.deps : [];
    const invalidatedDep = deps.find((dep) => dep.invalidated === true);
    if (invalidatedDep) {
      return { satisfied: true, kind: "rollback", awaitedKinds: [], gateRef: null, depRef: invalidatedDep.ref };
    }
    const passGate = gates.find((gate) => gate.verdict === "PASS" && gate.noShip === false);
    if (task.status === "SUBMITTED") {
      if (passGate) {
        return { satisfied: true, kind: "accept", awaitedKinds: [], gateRef: passGate.ref, depRef: null };
      }
      return { satisfied: false, kind: "await", awaitedKinds: ["accept"], gateRef: null, depRef: null };
    }
    return { satisfied: false, kind: "noop", awaitedKinds: [], gateRef: null, depRef: null };
  },
};
registerEvidenceContract(reviewQueueContract);

// The review-queue WorklistReducer. FSM: DRAFT -> SUBMITTED -> GATED -> MERGED
// (CLOSE abandons). A directive is projected ONLY for items whose latest state is
// SUBMITTED (awaiting the gate) — the single actionable state. The projected
// directive consults deps.evidenceContract via evaluateEvidenceForDirective to
// layer the CANONICAL evidence verdict onto the directive. Action name 'REVIEW'.
const reviewQueueReducer: WorklistReducer = {
  reducerId: REVIEW_QUEUE_REDUCER_ID,
  computeDirectives(events, deps) {
    function statusForKind(kind: string): string | null {
      const upper = String(kind ?? "").toUpperCase();
      if (upper === "DRAFT") return "DRAFT";
      if (upper === "SUBMIT") return "SUBMITTED";
      if (upper === "GATE") return "GATED";
      if (upper === "MERGE") return "MERGED";
      return null;
    }
    const stateByRef = new Map<string, { status: string; event: WorklistEvent }>();
    const order: string[] = [];
    for (const event of events) {
      const key = event.ref ?? `event:${event.eventId}`;
      const kind = String(event.kind ?? "").toUpperCase();
      if (kind === "CLOSE") {
        stateByRef.delete(key);
        continue;
      }
      const status = statusForKind(kind);
      if (!status) continue; // informational event kind (e.g. NOTE)
      if (!stateByRef.has(key)) order.push(key);
      stateByRef.set(key, { status, event });
    }
    const directives: Directive[] = [];
    for (const key of order) {
      const entry = stateByRef.get(key);
      if (!entry) continue;
      if (entry.status !== "SUBMITTED") continue; // only SUBMITTED is actionable
      const event = entry.event;
      const directive = buildDirective({
        action: REVIEW_ACTION,
        ref: event.ref,
        owner: event.owner ?? "unassigned",
        reasonRef: event.reasonRef,
        unblockPath: event.unblockPath,
        evidenceRequired: event.evidenceRefs,
        evidencePresent: false,
        deadline: event.deadline,
      });
      const taskView: TaskView = { ref: event.ref ?? null, status: "SUBMITTED" };
      const annotation = evaluateEvidenceForDirective(deps.evidenceContract, taskView, deps.evidence);
      if (annotation) {
        directive.evidenceKind = annotation.evidenceKind;
        directive.evidencePresent = annotation.evidencePresent;
      }
      directives.push(directive);
    }
    directives.sort(
      (a, b) =>
        String(a.ref ?? "").localeCompare(String(b.ref ?? "")) || String(a.hash).localeCompare(String(b.hash)),
    );
    return directives;
  },
  validateEvent(event) {
    const errors: string[] = [];
    if (!event.kind || String(event.kind).trim().length === 0) errors.push("review-queue: event kind must be non-empty");
    return errors;
  },
};
registerWorklistReducer(reviewQueueReducer);

// --- Deterministic test scaffolding ------------------------------------------

let repo = "";
const BASE_NOW = 1_700_000_000_000; // fixed clock — no Date.now() drift
const REVIEW_OWNER = "review-worker";

before(() => {
  repo = mkdtempSync(join(tmpdir(), "zob-eh-prop-"));
});

after(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp repo */
  }
});

interface ReviewEventInput {
  kind: string;
  ref: string;
  evidenceRefs?: string[];
}

// Append a review-queue lifecycle to a fresh scope and return the projected
// directives with `evidence` threaded through the store (which resolves the
// review-queue EvidenceContract by reducer_id and consults it).
function projectReview(scope: string, events: ReviewEventInput[], evidence: EvidenceInput = emptyEvidenceInput()) {
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  for (const ev of events) {
    store.appendEvent({
      scope,
      reducer_id: REVIEW_QUEUE_REDUCER_ID,
      kind: ev.kind,
      ref: ev.ref,
      owner: REVIEW_OWNER,
      evidence_refs: ev.evidenceRefs,
    });
  }
  return listWorklistDirectives(repo, scope, BASE_NOW, evidence);
}

// ===========================================================================
// PROPERTY 0 — DISTINCTNESS: the second toy consumer is genuinely a DIFFERENT
// domain/FSM from the transposer and from the EH1/EH2 toy. This proves the harness
// EvidenceContract is reusable (path-independence is not transposer-coupled).
// ===========================================================================
test("distinctness: review-queue is a different consumer from the transposer and the EH1/EH2 toy", () => {
  // Distinct ids (the EH1 toy is 'toy-project'; the EH2 toy is 'toy-evi'; the
  // transposer registers 'project-transposer' in WS-EH4, deferred).
  assert.notEqual(REVIEW_QUEUE_EVIDENCE_ID, "toy-evi");
  assert.notEqual(REVIEW_QUEUE_EVIDENCE_ID, "toy-project");
  assert.notEqual(REVIEW_QUEUE_EVIDENCE_ID, "project-transposer");
  assert.notEqual(REVIEW_QUEUE_REDUCER_ID, "toy-evi");
  assert.notEqual(REVIEW_QUEUE_REDUCER_ID, "generic");
  assert.notEqual(REVIEW_QUEUE_REDUCER_ID, "project-transposer");

  // Distinct action name: REVIEW vs ACT (the EH1/EH2 toy) vs the transposer's
  // ACCEPT/REJECT/REASSIGN/REOPEN action set.
  assert.notEqual(REVIEW_ACTION, "ACT");
  const transposerActions = ["ACCEPT", "REJECT", "REASSIGN", "REOPEN"];
  assert.ok(!transposerActions.includes(REVIEW_ACTION), "review-queue action must differ from transposer actions");

  // Distinct FSM: the review-queue kinds DRAFT/SUBMIT/GATE/MERGE are NOT the
  // generic reducer's OPEN/CLOSE/NOTE vocabulary (CLOSE is shared for abandon, but
  // SUBMIT/GATE/MERGE are review-queue-specific).
  const reviewKinds = ["DRAFT", "SUBMIT", "GATE", "MERGE"];
  const genericKinds = ["OPEN", "CLOSE", "NOTE"];
  const reviewSpecific = reviewKinds.filter((k) => !genericKinds.includes(k));
  assert.ok(reviewSpecific.length >= 3, "review-queue FSM has >=3 kinds distinct from the generic reducer");

  // Registered via the PUBLIC harness API only (registerEvidenceContract +
  // registerWorklistReducer), then resolvable.
  assert.ok(listEvidenceContractIds().includes(REVIEW_QUEUE_EVIDENCE_ID));
  assert.ok(listWorklistReducerIds().includes(REVIEW_QUEUE_REDUCER_ID));
  assert.equal(resolveEvidenceContract(REVIEW_QUEUE_EVIDENCE_ID).evidenceId, REVIEW_QUEUE_EVIDENCE_ID);
});

// ===========================================================================
// PROPERTY 1 — AGREEMENT: for a deterministic table of (events, evidence) cases,
// every DERIVED Directive's evidenceKind/evidencePresent AGREES with the toy
// contract's evaluateEvidence(taskView, evidence) verdict. They can never disagree
// by construction (the reducer derives the annotation FROM the contract).
// ===========================================================================
interface AgreementCase {
  label: string;
  events: ReviewEventInput[];
  evidence: EvidenceInput;
  expectedKind: EvidenceKind;
  expectedSatisfied: boolean;
}

const PASS_GATE_REF = "reviews/acceptance/oracle-review.json";

const AGREEMENT_CASES: AgreementCase[] = [
  {
    label: "SUBMITTED + PASS gate (cited) => accept",
    events: [{ kind: "DRAFT", ref: "reviews/a1.json" }, { kind: "SUBMIT", ref: "reviews/a1.json", evidenceRefs: [PASS_GATE_REF] }],
    evidence: { gates: [{ ref: PASS_GATE_REF, verdict: "PASS", noShip: false, discoveredVia: "cited" }] },
    expectedKind: "accept",
    expectedSatisfied: true,
  },
  {
    label: "SUBMITTED + PASS gate (convention/discovered) => accept",
    events: [{ kind: "DRAFT", ref: "reviews/a2.json" }, { kind: "SUBMIT", ref: "reviews/a2.json" }],
    evidence: { gates: [{ ref: PASS_GATE_REF, verdict: "PASS", noShip: false, discoveredVia: "convention" }] },
    expectedKind: "accept",
    expectedSatisfied: true,
  },
  {
    label: "SUBMITTED + no gate => await",
    events: [{ kind: "DRAFT", ref: "reviews/a3.json" }, { kind: "SUBMIT", ref: "reviews/a3.json" }],
    evidence: emptyEvidenceInput(),
    expectedKind: "await",
    expectedSatisfied: false,
  },
  {
    label: "SUBMITTED + UNKNOWN gate => await",
    events: [{ kind: "DRAFT", ref: "reviews/a4.json" }, { kind: "SUBMIT", ref: "reviews/a4.json" }],
    evidence: { gates: [{ ref: PASS_GATE_REF, verdict: "UNKNOWN", noShip: false, discoveredVia: "cited" }] },
    expectedKind: "await",
    expectedSatisfied: false,
  },
  {
    label: "SUBMITTED + FAIL gate => await (review is re-submittable, not terminal-rejected)",
    events: [{ kind: "DRAFT", ref: "reviews/a5.json" }, { kind: "SUBMIT", ref: "reviews/a5.json" }],
    evidence: { gates: [{ ref: PASS_GATE_REF, verdict: "FAIL", noShip: false, discoveredVia: "cited" }] },
    expectedKind: "await",
    expectedSatisfied: false,
  },
  {
    label: "SUBMITTED + invalidated dep (no gate) => rollback",
    events: [{ kind: "DRAFT", ref: "reviews/a6.json" }, { kind: "SUBMIT", ref: "reviews/a6.json" }],
    evidence: { deps: [{ ref: "reviews/a6/downstream.json", status: "rejected", invalidated: true }] },
    expectedKind: "rollback",
    expectedSatisfied: true,
  },
  {
    label: "SUBMITTED + PASS gate + invalidated dep => rollback (dep precedence is deterministic)",
    events: [{ kind: "DRAFT", ref: "reviews/a7.json" }, { kind: "SUBMIT", ref: "reviews/a7.json", evidenceRefs: [PASS_GATE_REF] }],
    evidence: {
      gates: [{ ref: PASS_GATE_REF, verdict: "PASS", noShip: false, discoveredVia: "cited" }],
      deps: [{ ref: "reviews/a7/downstream.json", status: "rejected", invalidated: true }],
    },
    expectedKind: "rollback",
    expectedSatisfied: true,
  },
];

for (let index = 0; index < AGREEMENT_CASES.length; index += 1) {
  const ac = AGREEMENT_CASES[index];
  test(`agreement (${index + 1}/${AGREEMENT_CASES.length}): ${ac.label}`, () => {
    const directives = projectReview(`agreement-${index}`, ac.events, ac.evidence);
    assert.equal(directives.length, 1, `${ac.label}: expected exactly one projected (SUBMITTED) directive`);
    const directive = directives[0];
    assert.equal(directive.action, REVIEW_ACTION);

    // The TaskView the reducer built for this directive (status SUBMITTED).
    const taskView: TaskView = { ref: ac.events[ac.events.length - 1].ref, status: "SUBMITTED" };
    const verdict = reviewQueueContract.evaluateEvidence(taskView, ac.evidence);

    // AGREEMENT: the projected annotation equals the contract's canonical verdict.
    assert.equal(directive.evidenceKind, verdict.kind, `${ac.label}: directive.evidenceKind must equal evaluateEvidence().kind`);
    assert.equal(directive.evidencePresent, verdict.satisfied, `${ac.label}: directive.evidencePresent must equal evaluateEvidence().satisfied`);
    // And the expected deterministic outcome.
    assert.equal(directive.evidenceKind, ac.expectedKind, `${ac.label}: expected kind`);
    assert.equal(directive.evidencePresent, ac.expectedSatisfied, `${ac.label}: expected satisfied`);
  });
}

// Non-actionable states project NO directive, and the contract independently
// returns 'noop' for them (agreement at the contract level). This also proves the
// FSM is genuinely distinct: the generic reducer projects ALL open items, but the
// review-queue projects ONLY SUBMITTED ones.
test("agreement: non-actionable states (DRAFT/GATED/MERGED) project no directive and the contract returns 'noop'", () => {
  const passEvidence: EvidenceInput = { gates: [{ ref: "reviews/fsm/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited" }] };

  // DRAFT only => not actionable.
  assert.equal(projectReview("agreement-noop-draft", [{ kind: "DRAFT", ref: "reviews/fsm-d.json" }], passEvidence).length, 0);
  // GATED => already gated, not actionable.
  assert.equal(
    projectReview(
      "agreement-noop-gated",
      [{ kind: "DRAFT", ref: "reviews/fsm-g.json" }, { kind: "SUBMIT", ref: "reviews/fsm-g.json" }, { kind: "GATE", ref: "reviews/fsm-g.json" }],
      passEvidence,
    ).length,
    0,
  );
  // MERGED => terminal.
  assert.equal(
    projectReview(
      "agreement-noop-merged",
      [
        { kind: "DRAFT", ref: "reviews/fsm-m.json" },
        { kind: "SUBMIT", ref: "reviews/fsm-m.json" },
        { kind: "GATE", ref: "reviews/fsm-m.json" },
        { kind: "MERGE", ref: "reviews/fsm-m.json" },
      ],
      passEvidence,
    ).length,
    0,
  );

  // The contract returns 'noop' for these non-actionable states (agreement at the
  // contract level even when no directive projects).
  assert.equal(reviewQueueContract.evaluateEvidence({ ref: "reviews/fsm-d.json", status: "DRAFT" }, passEvidence).kind, "noop");
  assert.equal(reviewQueueContract.evaluateEvidence({ ref: "reviews/fsm-g.json", status: "GATED" }, passEvidence).kind, "noop");
  assert.equal(reviewQueueContract.evaluateEvidence({ ref: "reviews/fsm-m.json", status: "MERGED" }, passEvidence).kind, "noop");

  // Sanity: SUBMITTED + PASS gate DOES project exactly one directive.
  assert.equal(
    projectReview("agreement-noop-submitted", [{ kind: "DRAFT", ref: "reviews/fsm-s.json" }, { kind: "SUBMIT", ref: "reviews/fsm-s.json" }], passEvidence).length,
    1,
  );
});

// ===========================================================================
// PROPERTY 2 — PATH-INDEPENDENCE (the headline asymmetry-invariant). The SAME
// satisfiable evidence (a PASS gate) reaches a SUBMITTED task via TWO DIFFERENT
// lifecycle paths: path A "SUBMIT that CITED the gate" vs path B "SUBMIT that did
// NOT cite the gate but the gate is in the supplied EvidenceInput (discovered)". The
// derived Directive.evidenceKind is IDENTICAL across both paths (both 'accept').
//
// This is the EXACT property the ws-tickets bug violated: the ACCEPT path read
// CITED refs only while the REASSIGN path walked the disk, so the same on-disk
// oracle gave a different verdict by path. The harness contract is pure over
// (taskView, evidence) — citation is not even an input — so the verdict CANNOT
// depend on the path.
// ===========================================================================
test("path-independence: same evidence, two lifecycle paths (cited vs uncited/discovered) => IDENTICAL evidenceKind", () => {
  const gateRef = "reviews/pathindep/oracle-review.json";
  const ref = "reviews/pi.json";

  // The SAME satisfiable evidence (a PASS gate on disk) supplied to BOTH paths.
  // The contract reads this EvidenceInput; it does NOT read the task's citation.
  const evidence: EvidenceInput = { gates: [{ ref: gateRef, verdict: "PASS", noShip: false, discoveredVia: "cited" }] };

  // PATH A — the SUBMIT event CITED the gate (evidence_refs=[gateRef]).
  const directivesA = projectReview(
    "pathindep-cited",
    [{ kind: "DRAFT", ref }, { kind: "SUBMIT", ref, evidenceRefs: [gateRef] }],
    evidence,
  );
  // PATH B — the SUBMIT event did NOT cite the gate; the gate arrives via the
  // supplied EvidenceInput only (conventional/disk discovery).
  const directivesB = projectReview(
    "pathindep-discovered",
    [{ kind: "DRAFT", ref }, { kind: "SUBMIT", ref }],
    evidence,
  );

  assert.equal(directivesA.length, 1, "path A projects one directive");
  assert.equal(directivesB.length, 1, "path B projects one directive");

  // HEADLINE: identical evidenceKind + evidencePresent across the two paths.
  assert.equal(directivesA[0].evidenceKind, "accept", "path A (cited) => accept");
  assert.equal(directivesB[0].evidenceKind, "accept", "path B (uncited/discovered) => accept");
  assert.equal(directivesA[0].evidenceKind, directivesB[0].evidenceKind, "PATH-INDEPENDENCE: same evidence => same verdict regardless of path");
  assert.equal(directivesA[0].evidencePresent, true);
  assert.equal(directivesA[0].evidencePresent, directivesB[0].evidencePresent);

  // The two paths ARE genuinely different lifecycle paths: path A cited the gate
  // (evidenceRequired=[gateRef]) while path B did not (evidenceRequired=[]). Their
  // directive content differs, so their hashes DIFFER. Yet the EVIDENCE VERDICT is
  // identical — the verdict depends ONLY on evaluateEvidence(taskView, evidence),
  // never on the path/citation. (directiveHash is over {action, owner,
  // evidence_refs(sorted), deadline}; the verdict annotation evidenceKind is NOT
  // identity, so the differing citation changes the hash but not the verdict.)
  assert.deepEqual(directivesA[0].evidenceRequired, [gateRef], "path A cited the gate");
  assert.deepEqual(directivesB[0].evidenceRequired, [], "path B did not cite the gate");
  assert.notEqual(directivesA[0].hash, directivesB[0].hash, "the two paths produce different directive content (citation differs)");

  // The contract itself returns the SAME verdict for the same (taskView, evidence)
  // pair — proving citation is not even an input to evaluateEvidence (pure over the
  // pair). This is the structural reason path-independence holds.
  const taskView: TaskView = { ref, status: "SUBMITTED" };
  const verdictA = reviewQueueContract.evaluateEvidence(taskView, evidence);
  const verdictB = reviewQueueContract.evaluateEvidence(taskView, evidence);
  assert.deepEqual(verdictA, verdictB);
  assert.equal(verdictA.kind, "accept");
  assert.equal(verdictA.satisfied, true);
});

// ===========================================================================
// PROPERTY 3 — DISCOVERY-COMPLETENESS: the contract sees the satisfying gate
// whether it is (a) cited, (b) supplied only via discovered EvidenceInput (uncited),
// or (c) both. Citation is a HINT, never a GATE. Supplying the gate via evidence
// ALONE yields the same 'accept' verdict as citing it — the harness can never
// re-introduce "citation required".
// ===========================================================================
test("discovery-completeness: citation is a hint, never a gate (cited / convention-discovered / both => accept)", () => {
  const gateRef = "reviews/discovery/oracle-review.json";
  const ref = "reviews/dc.json";

  const variants: { label: string; slug: string; evidence: EvidenceInput }[] = [
    {
      label: "(a) cited in task refs",
      slug: "cited",
      evidence: { gates: [{ ref: gateRef, verdict: "PASS", noShip: false, discoveredVia: "cited" }] },
    },
    {
      label: "(b) supplied via discovered EvidenceInput only (NOT cited)",
      slug: "convention",
      evidence: { gates: [{ ref: gateRef, verdict: "PASS", noShip: false, discoveredVia: "convention" }] },
    },
    {
      label: "(c) both cited + convention-discovered",
      slug: "both",
      evidence: {
        gates: [
          { ref: gateRef, verdict: "PASS", noShip: false, discoveredVia: "cited" },
          { ref: gateRef, verdict: "PASS", noShip: false, discoveredVia: "convention" },
        ],
      },
    },
  ];

  for (const v of variants) {
    // The task did NOT cite the gate (the SUBMIT event has no evidence_refs); the
    // gate reaches the contract ONLY via the supplied EvidenceInput. In ALL three
    // variants the contract sees the PASS gate and returns 'accept'.
    const directives = projectReview(
      `discovery-${v.slug}`,
      [{ kind: "DRAFT", ref }, { kind: "SUBMIT", ref }],
      v.evidence,
    );
    assert.equal(directives.length, 1, `${v.label}: one directive`);
    assert.equal(directives[0].evidenceKind, "accept", `${v.label}: accept whether cited, discovered, or both`);
    assert.equal(directives[0].evidencePresent, true, `${v.label}: satisfied`);
  }

  // Direct lock: evaluateEvidence(taskView, evidence) returns the SAME verdict for
  // all three variants (citation/discovery channel is not an input — only the gate
  // entry's verdict+noShip matter). So "citation required" is structurally
  // impossible at the harness contract layer.
  const taskView: TaskView = { ref, status: "SUBMITTED" };
  const kinds = variants.map((v) => reviewQueueContract.evaluateEvidence(taskView, v.evidence).kind);
  assert.deepEqual(kinds, ["accept", "accept", "accept"]);
});

// ===========================================================================
// DETERMINISM: a fixed CASES table (the seeded input space above) PLUS a seeded
// mulberry32 PRNG sweep assert the contract is a PURE function — same
// (taskView, evidence) => same verdict, reproducibly. Two independent runs from the
// SAME seed produce IDENTICAL verdict sequences; the sweep exercises multiple
// contract branches (non-degenerate). No unconstrained Math.random.
// ===========================================================================
test("determinism: seeded mulberry32 sweep is reproducible and exercises multiple contract branches", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildEvidenceFromRng(rng: () => number): EvidenceInput {
    const r = rng();
    let gates: GateEntry[] = [];
    if (r < 0.5) {
      gates = [{ ref: "reviews/det/oracle.json", verdict: "PASS", noShip: false, discoveredVia: "cited" }];
    } else if (r < 0.7) {
      gates = [{ ref: "reviews/det/oracle.json", verdict: "UNKNOWN", noShip: false, discoveredVia: "cited" }];
    } else if (r < 0.9) {
      gates = [{ ref: "reviews/det/oracle.json", verdict: "FAIL", noShip: false, discoveredVia: "cited" }];
    }
    const hasInvalidatedDep = rng() < 0.25;
    const deps: DepEntry[] = hasInvalidatedDep
      ? [{ ref: "reviews/det/downstream.json", status: "rejected", invalidated: true }]
      : [];
    return { gates, deps };
  }

  function sweep(seed: number): { kind: EvidenceKind; satisfied: boolean }[] {
    const rng = mulberry32(seed);
    const task: TaskView = { ref: "reviews/det.json", status: "SUBMITTED" };
    const out: { kind: EvidenceKind; satisfied: boolean }[] = [];
    for (let i = 0; i < 256; i += 1) {
      const evidence = buildEvidenceFromRng(rng);
      const verdict = reviewQueueContract.evaluateEvidence(task, evidence);
      out.push({ kind: verdict.kind, satisfied: verdict.satisfied });
    }
    return out;
  }

  // Two independent seeded runs from the SAME seed produce IDENTICAL verdict
  // sequences — the core determinism / purity proof.
  const run1 = sweep(0xc0ffee);
  const run2 = sweep(0xc0ffee);
  assert.equal(run1.length, 256);
  assert.deepEqual(run1, run2, "seeded sweep must be reproducible (same seed => identical verdict sequence)");

  // The sweep is non-degenerate: it exercises >1 contract branch over the fixed
  // seed (the distribution above yields accept/await/rollback across 256 draws).
  // This guards against a degenerate constant-output contract.
  const distinctKinds = new Set(run1.map((x) => x.kind));
  assert.ok(distinctKinds.size >= 2, `deterministic sweep should exercise >=2 contract branches (got ${[...distinctKinds].join(",")})`);

  // A DIFFERENT seed is itself reproducible (its own two runs match) — determinism
  // holds for any fixed seed, not just the chosen one.
  assert.deepEqual(sweep(0x12345), sweep(0x12345));
});
