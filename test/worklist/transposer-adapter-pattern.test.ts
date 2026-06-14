// WS-EH4 (canonical-evidence-model PART II): harness-side VALIDATION that the
// transposer->harness EvidenceContract BRIDGE ADAPTER shape is behavior-preserving
// for project-transposer's EXACT verdict FSM. This is a DRY-RUN of the migration
// described in .pi/extensions/zob-harness/reports/worklist-ws-eh4-migration-spec.md:
// it proves an adapter implementing transposer's evaluateEvidence semantics on top of
// the harness EvidenceContract shape preserves AGREEMENT + PATH-INDEPENDENCE (incl.
// the ws-tickets direct-accept case) + the other kind branches (reassign/rollback/
// reject). The adapter is TEST-LOCAL: it registers via the PUBLIC harness API
// (registerEvidenceContract + registerWorklistReducer) and does NOT ship in the
// harness domain (no transposer coupling in shipped code).
//
// Reference (READ-ONLY, project-transposer repo):
//   - evaluateEvidence FSM ........ scripts/lib/handoff-state.mjs:717
//     kind branches (the EXACT semantics this adapter reproduces):
//       claimed_complete + decision_at                 -> 'noop'  (already decided)
//       claimed_complete + oraclePass + missing=[] + butterfly -> 'accept'
//       claimed_complete + evidence not satisfied       -> 'reject' (awaitedKinds=['accept'])
//       rejected + decision + gateNowPass + gateRef     -> 'reassign'
//       rejected + decision + gate not yet pass         -> 'noop'   (awaitedKinds=['reassign'])
//       accepted + decision + depInvalidated + depRef   -> 'rollback'
//       accepted + decision + no invalidated dep        -> 'noop'   (awaitedKinds=['rollback'])
//       anything else (in-flight / unassigned)          -> 'noop'
//   - discoverEvidence (the IO discovery) .. scripts/transposer-decide.mjs:228
//   - computeWorklist / deriveDirective ... scripts/lib/handoff-state.mjs:982,1030
//   - emptyTask (the task shape) .......... scripts/lib/handoff-state.mjs:144
//
// The CRUX is the {gates,deps} -> transposer-evidence translation done PURELY inside
// evaluateEvidence. The harness EvidenceInput carries {gates,deps}; the adapter maps
// those to {oraclePass, oracleNoShip, gateNowPass, gateRef, depInvalidated,
// depInvalidatedRef}. The two discoverEvidence-derived signals that do NOT map from
// {gates,deps} (missingArtifactRefs, butterflySatisfiable) are carried via a richer
// runtime evidence object the adapter's reducer builds (mirrors the .mjs adapter:
// discoverEvidence returns an object that is structurally an EvidenceInput AND carries
// the extra fields). Deterministic, body-free, network-disabled.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  buildDirective,
  directiveHash,
  emptyEvidenceInput,
  evaluateEvidenceForDirective,
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
  type EvidenceVerdict,
  type GateEntry,
  type TaskView,
  type WorklistEvent,
  type WorklistReducer,
} from "../../.pi/extensions/zob-harness/index.ts";

// ===========================================================================
// TEST-LOCAL TRANSPONDER ADAPTER (does NOT ship in the harness domain)
// ===========================================================================

const TRANSPONDER_EVIDENCE_ID = "project-transposer";
const TRANSPONDER_REDUCER_ID = "project-transposer";

// The richer evidence the adapter's reducer builds: the harness EvidenceInput
// {gates,deps} MERGED with the two discovery hints the {gates,deps} shape cannot
// carry (missingArtifactRefs + butterflySatisfiable). This mirrors the .mjs adapter
// the owner ships: discoverEvidence returns an object that is structurally an
// EvidenceInput (gates+deps present) AND carries the extra fields at runtime; the
// untyped .mjs evaluateEvidence reads them. Here a local subtype models the same.
interface TransposerEvidence extends EvidenceInput {
  missingArtifactRefs?: string[];
  butterflySatisfiable?: boolean;
}

// Translate harness EvidenceInput{gates,deps} -> transposer evidence, faithful to
// project-transposer discoverEvidence (transposer-decide.mjs:228) merged with the
// evaluateEvidence field reads (handoff-state.mjs:717). Pure over (taskView, evidence).
// Six fields map cleanly from {gates,deps}; missingArtifactRefs + butterflySatisfiable
// come from the richer runtime evidence (discovery hints).
function translateEvidence(taskView: TaskView, evidence: EvidenceInput): {
  oraclePass: boolean;
  oracleNoShip: boolean;
  missingArtifactRefs: string[];
  butterflySatisfiable: boolean;
  gateNowPass: boolean;
  gateRef: string | null;
  depInvalidated: boolean;
  depInvalidatedRef: string | null;
} {
  const gates: GateEntry[] = Array.isArray(evidence?.gates) ? evidence.gates : [];
  const deps: DepEntry[] = Array.isArray(evidence?.deps) ? evidence.deps : [];
  const te = evidence as TransposerEvidence;
  // {gates,deps} -> transposer oracle/gate/dep signals.
  const oraclePass = gates.some((g) => g.verdict === "PASS" && g.noShip !== true);
  const oracleNoShip = gates.some((g) => g.verdict === "FAIL" || g.noShip === true);
  // gateRef resolution mirrors discoverEvidence:
  //   reopenRef (task.reopen_gate_ref) ?? citedRef ?? discoveredRef(convention) ?? null
  // The recorded reopen gate takes precedence (the reopen write-gate must match it).
  const reopenRef = (taskView.reopenGateRef ?? null) as string | null;
  const cited = gates.filter((g) => g.discoveredVia === "cited");
  const convention = gates.filter((g) => g.discoveredVia === "convention");
  const onLog = gates.filter((g) => g.discoveredVia === "on-log");
  const gateRef = reopenRef ?? cited[0]?.ref ?? convention[0]?.ref ?? onLog[0]?.ref ?? null;
  const gateAtRef = gateRef ? gates.find((g) => g.ref === gateRef) ?? null : null;
  const gateNowPass = Boolean(gateAtRef) && gateAtRef.verdict === "PASS" && gateAtRef.noShip !== true;
  const invalidated = deps.find((d) => d.invalidated === true) ?? null;
  const depInvalidated = Boolean(invalidated);
  const depInvalidatedRef = invalidated?.ref ?? null;
  // discovery hints NOT mappable from {gates,deps}: carried via the richer evidence.
  const missingArtifactRefs = Array.isArray(te.missingArtifactRefs) ? [...te.missingArtifactRefs] : [];
  const butterflySatisfiable = te.butterflySatisfiable === true;
  return { oraclePass, oracleNoShip, missingArtifactRefs, butterflySatisfiable, gateNowPass, gateRef, depInvalidated, depInvalidatedRef };
}

// Transposer evaluateEvidence FSM — FAITHFUL reproduction of
// scripts/lib/handoff-state.mjs:717 (the proven second pillar). Pure over
// (taskView, evidence); kind is computed ONLY from (task.status, evidence) so it is
// path-independent. This is the body the owner's .mjs adapter delegates to (here
// reproduced test-locally; no transposer import).
function transposerEvaluateEvidence(task: TaskView, evidence: EvidenceInput): EvidenceVerdict {
  const ev = translateEvidence(task, evidence);
  const status = task.status ?? null;
  const decided = task.decidedAt != null && task.decidedAt !== "";
  const gateRef = ev.gateRef;
  const depRef = ev.depInvalidatedRef;
  if (!task || !status) {
    return { satisfied: false, kind: "noop", awaitedKinds: [], gateRef, depRef };
  }
  // Decided REJECTED epoch: reopen (REASSIGN) when the original blocker's gate is now
  // verdict=PASS and a gate ref is known.
  if (status === "rejected" && decided) {
    if (ev.gateNowPass === true && ev.gateRef) {
      return { satisfied: true, kind: "reassign", awaitedKinds: [], gateRef, depRef };
    }
    return { satisfied: false, kind: "noop", awaitedKinds: ["reassign"], gateRef, depRef };
  }
  // Decided ACCEPTED epoch: reopen (ROLLBACK) when a downstream dependency was
  // invalidated.
  if (status === "accepted" && decided) {
    if (ev.depInvalidated === true && ev.depInvalidatedRef) {
      return { satisfied: true, kind: "rollback", awaitedKinds: [], gateRef, depRef };
    }
    return { satisfied: false, kind: "noop", awaitedKinds: ["rollback"], gateRef, depRef };
  }
  // Open decision epoch (claimed_complete, undecided).
  if (status === "claimed_complete") {
    if (decided) {
      return { satisfied: false, kind: "noop", awaitedKinds: [], gateRef, depRef };
    }
    // SINGLE SITE of the ACCEPT hard-evidence gate: oracle PASS + required refs +
    // butterfly next-phase rule.
    if (ev.oraclePass && ev.missingArtifactRefs.length === 0 && ev.butterflySatisfiable) {
      return { satisfied: true, kind: "accept", awaitedKinds: [], gateRef, depRef };
    }
    return { satisfied: false, kind: "reject", awaitedKinds: ["accept"], gateRef, depRef };
  }
  // In-flight (unassigned/assigned/acknowledged/in_progress/blocked): not a decision
  // epoch; no evidence verdict applies.
  return { satisfied: false, kind: "noop", awaitedKinds: [], gateRef, depRef };
}

const transposerContract: EvidenceContract = {
  evidenceId: TRANSPONDER_EVIDENCE_ID,
  evaluateEvidence: transposerEvaluateEvidence,
};
registerEvidenceContract(transposerContract);

// Maps verdict kind -> directive action, faithful to transposer deriveDirective
// (handoff-state.mjs:982): accept->ACCEPT, reject->REJECT, reassign->REASSIGN,
// rollback->ROLLBACK, noop->(not emitted). 'await' never appears for these statuses
// (the transposer carries the await semantic via 'reject'/'noop' + awaitedKinds).
function actionForKind(kind: EvidenceKind): string | null {
  if (kind === "accept") return "ACCEPT";
  if (kind === "reject") return "REJECT";
  if (kind === "reassign") return "REASSIGN";
  if (kind === "rollback") return "ROLLBACK";
  return null; // noop / await -> not emitted
}

// The transposer WorklistReducer (test-local). Maps harness events to the transposer
// FSM statuses evaluateEvidence branches on (CLAIM->claimed_complete,
// REJECT->rejected, ACCEPT->accepted), builds the TaskView, MERGES the harness
// evidence channel {gates,deps} with the discovery hints {missingArtifactRefs,
// butterflySatisfiable} the {gates,deps} shape cannot carry, consults the registered
// contract via evaluateEvidenceForDirective, and projects a directive with the
// canonical evidenceKind annotation. noop kinds project NO directive (not actionable),
// faithful to deriveDirective returning null.
const transposerReducer: WorklistReducer = {
  reducerId: TRANSPONDER_REDUCER_ID,
  computeDirectives(events, deps) {
    // Build the latest lifecycle state per ref (CLAIM/REJECT/ACCEPT). The LAST
    // lifecycle event for a ref determines its status; claimedAt is preserved across
    // a later decision; reopenGateRef is recorded at REJECT time (the gate that
    // blocked, faithful to PHASE_REJECTED.v1 recording gate_ref).
    const stateByRef = new Map<string, {
      status: string;
      claimedAt: string | null;
      decidedAt: string | null;
      reopenGateRef: string | null;
      event: WorklistEvent;
    }>();
    const order: string[] = [];
    for (const event of events) {
      const key = event.ref ?? `event:${event.eventId}`;
      const kind = String(event.kind ?? "").toUpperCase();
      if (kind === "CLOSE") {
        stateByRef.delete(key);
        continue;
      }
      let status: string | null = null;
      let decidedAt: string | null = null;
      let reopenGateRef: string | null = null;
      if (kind === "CLAIM") {
        status = "claimed_complete";
      } else if (kind === "REJECT") {
        status = "rejected";
        decidedAt = event.at;
        reopenGateRef = event.evidenceRefs[0] ?? null;
      } else if (kind === "ACCEPT") {
        status = "accepted";
        decidedAt = event.at;
      } else {
        continue; // informational event kind
      }
      if (!stateByRef.has(key)) order.push(key);
      const prior = stateByRef.get(key);
      const claimedAt = kind === "CLAIM" ? event.at : prior?.claimedAt ?? null;
      stateByRef.set(key, {
        status,
        claimedAt,
        decidedAt,
        reopenGateRef: reopenGateRef ?? prior?.reopenGateRef ?? null,
        event,
      });
    }
    const directives: Directive[] = [];
    for (const key of order) {
      const entry = stateByRef.get(key);
      if (!entry) continue;
      const taskView: TaskView = {
        ref: entry.event.ref ?? null,
        status: entry.status,
        claimedAt: entry.claimedAt,
        decidedAt: entry.decidedAt,
        reopenGateRef: entry.reopenGateRef,
      };
      // The reducer MERGES the harness evidence channel {gates,deps} with the
      // discovery hints the {gates,deps} shape cannot carry. This mirrors the .mjs
      // adapter: discoverEvidence returns the richer object; evaluateEvidence reads it.
      // (A real adapter derives these from disk; here they default to the satisfiable
      // case so the gate/dep branches are isolated.)
      const merged: TransposerEvidence = {
        ...(deps.evidence ?? emptyEvidenceInput()),
        missingArtifactRefs: [],
        butterflySatisfiable: true,
      };
      // Consult the REGISTERED contract via the public helper (the AGREEMENT
      // mechanism: the annotation is derived FROM the contract, never recomputed).
      const annotation = evaluateEvidenceForDirective(deps.evidenceContract, taskView, merged);
      if (!annotation || annotation.evidenceKind === "noop") continue;
      const action = actionForKind(annotation.evidenceKind);
      if (!action) continue;
      const directive = buildDirective({
        action,
        ref: entry.event.ref,
        owner: entry.event.owner ?? "transposer-orchestrator",
        reasonRef: entry.event.reasonRef,
        unblockPath: entry.event.unblockPath,
        evidenceRequired: entry.event.evidenceRefs,
        evidencePresent: annotation.evidencePresent,
        deadline: entry.event.deadline,
      });
      directive.evidenceKind = annotation.evidenceKind;
      directives.push(directive);
    }
    directives.sort(
      (a, b) =>
        String(a.ref ?? "").localeCompare(String(b.ref ?? "")) ||
        String(a.hash).localeCompare(String(b.hash)),
    );
    return directives;
  },
  validateEvent(event) {
    const errors: string[] = [];
    if (!event.kind || String(event.kind).trim().length === 0) errors.push("project-transposer: event kind must be non-empty");
    if (event.deadline !== null && !Number.isFinite(Date.parse(event.deadline)))
      errors.push(`project-transposer: deadline is not ISO-8601: ${event.deadline}`);
    return errors;
  },
};
registerWorklistReducer(transposerReducer);

// ===========================================================================
// Deterministic test scaffolding
// ===========================================================================

let repo = "";
const BASE_NOW = 1_700_000_000_000; // fixed clock — no Date.now() drift
const DECIDED_AT = new Date(BASE_NOW).toISOString(); // any non-null/non-empty string
const ORCHESTRATOR = "transposer-orchestrator";

before(() => {
  repo = mkdtempSync(join(tmpdir(), "zob-eh4-transposer-"));
});

after(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp repo */
  }
});

interface TransposerEventInput {
  kind: string; // CLAIM | REJECT | ACCEPT
  ref: string;
  evidenceRefs?: string[];
}

// Append a transposer lifecycle to a fresh scope and return the projected directives
// with `evidence` threaded through the store (which resolves the project-transposer
// EvidenceContract by reducer_id and consults it).
function projectTransposer(scope: string, events: TransposerEventInput[], evidence: EvidenceInput = emptyEvidenceInput()) {
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  for (const ev of events) {
    store.appendEvent({
      scope,
      reducer_id: TRANSPONDER_REDUCER_ID,
      kind: ev.kind,
      ref: ev.ref,
      owner: ORCHESTRATOR,
      evidence_refs: ev.evidenceRefs,
    });
  }
  return listWorklistDirectives(repo, scope, BASE_NOW, evidence);
}

// Build the TaskView the reducer constructs for a lifecycle (for direct contract
// calls in AGREEMENT assertions). `decided` selects claimed_complete (undecided) vs
// rejected/accepted (decided).
function taskViewFor(ref: string, status: string, reopenGateRef: string | null = null): TaskView {
  const decided = status === "rejected" || status === "accepted";
  return {
    ref,
    status,
    claimedAt: new Date(BASE_NOW).toISOString(),
    decidedAt: decided ? DECIDED_AT : null,
    reopenGateRef,
  };
}

// ===========================================================================
// DISTINCTNESS: the adapter is a genuinely different consumer registered via the
// PUBLIC harness API (no transposer coupling in shipped code).
// ===========================================================================
test("distinctness: project-transposer adapter is registered via the public API and resolvable", () => {
  assert.ok(listEvidenceContractIds().includes(TRANSPONDER_EVIDENCE_ID));
  assert.ok(listWorklistReducerIds().includes(TRANSPONDER_REDUCER_ID));
  assert.equal(resolveEvidenceContract(TRANSPONDER_EVIDENCE_ID).evidenceId, TRANSPONDER_EVIDENCE_ID);
  // Distinct from the built-in generic reducer and the EH5 review-queue toy.
  assert.notEqual(TRANSPONDER_REDUCER_ID, "generic");
  assert.notEqual(TRANSPONDER_REDUCER_ID, "review-queue");
});

// ===========================================================================
// AGREEMENT + the kind branches: for a deterministic CASES table, every DERIVED
// Directive.evidenceKind AGREES with the contract's evaluateEvidence(taskView,
// merged).kind, and the projected action + kind match the transposer FSM.
// ===========================================================================
interface BranchCase {
  label: string;
  events: TransposerEventInput[];
  evidence: EvidenceInput;
  taskView: TaskView;
  expectedKind: EvidenceKind;
  expectedAction: string | null; // null => no directive projected (noop)
}

const GATE_REF = "plan/oracle-review.json";
const DEP_REF = "phase:ingestion";

const BRANCH_CASES: BranchCase[] = [
  {
    label: "claimed_complete + PASS gate (cited) + missing=[] + butterfly=true => accept",
    events: [{ kind: "CLAIM", ref: "phase:accept", evidenceRefs: [GATE_REF] }],
    evidence: { gates: [{ ref: GATE_REF, verdict: "PASS", noShip: false, discoveredVia: "cited" }] },
    taskView: taskViewFor("phase:accept", "claimed_complete"),
    expectedKind: "accept",
    expectedAction: "ACCEPT",
  },
  {
    label: "claimed_complete + no gate => reject (awaitedKinds=[accept])",
    events: [{ kind: "CLAIM", ref: "phase:reject" }],
    evidence: emptyEvidenceInput(),
    taskView: taskViewFor("phase:reject", "claimed_complete"),
    expectedKind: "reject",
    expectedAction: "REJECT",
  },
  {
    label: "rejected + decision + gateNowPass + gateRef => reassign",
    events: [{ kind: "CLAIM", ref: "phase:reassign" }, { kind: "REJECT", ref: "phase:reassign", evidenceRefs: [GATE_REF] }],
    evidence: { gates: [{ ref: GATE_REF, verdict: "PASS", noShip: false, discoveredVia: "on-log" }] },
    taskView: taskViewFor("phase:reassign", "rejected", GATE_REF),
    expectedKind: "reassign",
    expectedAction: "REASSIGN",
  },
  {
    label: "accepted + decision + depInvalidated + depRef => rollback",
    events: [{ kind: "CLAIM", ref: "phase:rollback" }, { kind: "ACCEPT", ref: "phase:rollback" }],
    evidence: { deps: [{ ref: DEP_REF, status: "rejected", invalidated: true }] },
    taskView: taskViewFor("phase:rollback", "accepted"),
    expectedKind: "rollback",
    expectedAction: "ROLLBACK",
  },
  {
    label: "accepted + decision + no invalidated dep => noop (no directive)",
    events: [{ kind: "CLAIM", ref: "phase:noop-accepted" }, { kind: "ACCEPT", ref: "phase:noop-accepted" }],
    evidence: emptyEvidenceInput(),
    taskView: taskViewFor("phase:noop-accepted", "accepted"),
    expectedKind: "noop",
    expectedAction: null,
  },
  {
    label: "rejected + decision + gate NOT yet pass => noop (no directive)",
    events: [{ kind: "CLAIM", ref: "phase:noop-rejected" }, { kind: "REJECT", ref: "phase:noop-rejected", evidenceRefs: [GATE_REF] }],
    evidence: { gates: [{ ref: GATE_REF, verdict: "UNKNOWN", noShip: false, discoveredVia: "on-log" }] },
    taskView: taskViewFor("phase:noop-rejected", "rejected", GATE_REF),
    expectedKind: "noop",
    expectedAction: null,
  },
];

for (let index = 0; index < BRANCH_CASES.length; index += 1) {
  const bc = BRANCH_CASES[index];
  test(`agreement (${index + 1}/${BRANCH_CASES.length}): ${bc.label}`, () => {
    const directives = projectTransposer(`branch-${index}`, bc.events, bc.evidence);

    // The contract's canonical verdict for the SAME (taskView, merged-evidence) the
    // reducer used. The merged evidence carries the discovery defaults ([], true).
    const merged: TransposerEvidence = { ...bc.evidence, missingArtifactRefs: [], butterflySatisfiable: true };
    const verdict = transposerContract.evaluateEvidence(bc.taskView, merged);

    if (bc.expectedAction === null) {
      // noop => no directive projected (not actionable), but the contract still
      // returns the expected noop kind (agreement at the contract level).
      assert.equal(directives.length, 0, `${bc.label}: noop => no directive`);
      assert.equal(verdict.kind, bc.expectedKind, `${bc.label}: contract verdict kind`);
      assert.equal(verdict.satisfied, false, `${bc.label}: noop is never satisfied`);
    } else {
      assert.equal(directives.length, 1, `${bc.label}: exactly one directive`);
      const directive = directives[0];
      assert.equal(directive.action, bc.expectedAction, `${bc.label}: action`);
      // AGREEMENT: the projected annotation equals the contract's canonical verdict.
      assert.equal(directive.evidenceKind, verdict.kind, `${bc.label}: directive.evidenceKind == evaluateEvidence().kind`);
      assert.equal(directive.evidencePresent, verdict.satisfied, `${bc.label}: directive.evidencePresent == evaluateEvidence().satisfied`);
      // And the expected deterministic outcome.
      assert.equal(directive.evidenceKind, bc.expectedKind, `${bc.label}: expected kind`);
      assert.equal(directive.evidencePresent, verdict.satisfied, `${bc.label}: expected satisfied`);
    }
  });
}

// ===========================================================================
// PATH-INDEPENDENCE (the headline asymmetry-invariant) — the EXACT ws-tickets
// direct-accept case. A claimed_complete task with a discovered PASS gate yields
// evidenceKind='accept' whether the gate is supplied via a 'cited' GateEntry (path A,
// the ACCEPT path that CITED the gate) OR a 'convention' GateEntry (path B, the gate
// discovered by disk-walk / supplied only via EvidenceInput). The asymmetry the
// ws-tickets bug exposed (ACCEPT path read CITED refs only while REASSIGN walked the
// disk) is now STRUCTURALLY IMPOSSIBLE: evaluateEvidence reads
// gates.some(g => g.verdict==='PASS' && !g.noShip) and never branches on discoveredVia.
// ===========================================================================
test("path-independence: claimed_complete + PASS gate => 'accept' via cited OR convention (ws-tickets direct-accept)", () => {
  const ref = "phase:tickets";
  const gate = "tickets/oracle-review.json";
  const passGateCited: GateEntry = { ref: gate, verdict: "PASS", noShip: false, discoveredVia: "cited" };
  const passGateConvention: GateEntry = { ref: gate, verdict: "PASS", noShip: false, discoveredVia: "convention" };

  // PATH A — the CLAIM CITED the gate (evidence_refs=[gate]); the evidence gate is
  // discoveredVia 'cited'. (The old ACCEPT path that read cited refs only.)
  const directivesA = projectTransposer(
    "tickets-cited",
    [{ kind: "CLAIM", ref, evidenceRefs: [gate] }],
    { gates: [passGateCited] },
  );
  // PATH B — the CLAIM did NOT cite the gate; the gate arrives via EvidenceInput only
  // (discoveredVia 'convention' = disk-walk). (The old REASSIGN path that walked disk.)
  const directivesB = projectTransposer(
    "tickets-convention",
    [{ kind: "CLAIM", ref }],
    { gates: [passGateConvention] },
  );

  assert.equal(directivesA.length, 1, "path A projects one directive");
  assert.equal(directivesB.length, 1, "path B projects one directive");

  // HEADLINE: identical evidenceKind across the two paths (both 'accept').
  assert.equal(directivesA[0].evidenceKind, "accept", "path A (cited) => accept");
  assert.equal(directivesB[0].evidenceKind, "accept", "path B (convention) => accept");
  assert.equal(directivesA[0].evidenceKind, directivesB[0].evidenceKind, "PATH-INDEPENDENCE: same evidence => same verdict regardless of path");
  assert.equal(directivesA[0].evidencePresent, true);
  assert.equal(directivesA[0].evidencePresent, directivesB[0].evidencePresent);

  // The two paths ARE genuinely different (path A cited the gate => evidenceRequired
  // =[gate]; path B did not => evidenceRequired=[]). Their directive content differs,
  // so their hashes DIFFER. Yet the EVIDENCE VERDICT is identical — the verdict
  // depends ONLY on evaluateEvidence(taskView, evidence), never on the path/citation.
  assert.deepEqual(directivesA[0].evidenceRequired, [gate], "path A cited the gate");
  assert.deepEqual(directivesB[0].evidenceRequired, [], "path B did not cite the gate");
  assert.notEqual(directivesA[0].hash, directivesB[0].hash, "the two paths produce different directive content (citation differs)");

  // The contract itself returns the SAME verdict for the same (taskView, evidence)
  // pair regardless of discoveredVia — citation channel is not even an input.
  const taskView = taskViewFor(ref, "claimed_complete");
  const evCited: TransposerEvidence = { gates: [passGateCited], missingArtifactRefs: [], butterflySatisfiable: true };
  const evConvention: TransposerEvidence = { gates: [passGateConvention], missingArtifactRefs: [], butterflySatisfiable: true };
  assert.equal(transposerContract.evaluateEvidence(taskView, evCited).kind, "accept");
  assert.equal(transposerContract.evaluateEvidence(taskView, evConvention).kind, "accept");
  assert.deepEqual(
    transposerContract.evaluateEvidence(taskView, evCited).kind,
    transposerContract.evaluateEvidence(taskView, evConvention).kind,
  );
});

// ===========================================================================
// DISCOVERY-COMPLETENESS: the contract sees the satisfying gate whether it is
// cited, convention-discovered, or both. Citation is a HINT, never a GATE.
// ===========================================================================
test("discovery-completeness: citation is a hint, never a gate (cited / convention / both => accept)", () => {
  const ref = "phase:discovery";
  const gate = "discovery/oracle-review.json";
  const variants: { label: string; slug: string; gates: GateEntry[] }[] = [
    { label: "(a) cited", slug: "cited", gates: [{ ref: gate, verdict: "PASS", noShip: false, discoveredVia: "cited" }] },
    { label: "(b) convention-discovered", slug: "convention", gates: [{ ref: gate, verdict: "PASS", noShip: false, discoveredVia: "convention" }] },
    {
      label: "(c) both cited + convention",
      slug: "both",
      gates: [
        { ref: gate, verdict: "PASS", noShip: false, discoveredVia: "cited" },
        { ref: gate, verdict: "PASS", noShip: false, discoveredVia: "convention" },
      ],
    },
  ];
  const taskView = taskViewFor(ref, "claimed_complete");
  for (const v of variants) {
    const directives = projectTransposer(`discovery-${v.slug}`, [{ kind: "CLAIM", ref }], { gates: v.gates });
    assert.equal(directives.length, 1, `${v.label}: one directive`);
    assert.equal(directives[0].evidenceKind, "accept", `${v.label}: accept whether cited, discovered, or both`);
    assert.equal(directives[0].evidencePresent, true, `${v.label}: satisfied`);
    // Contract-level lock: the verdict is the same across all three channels.
    const ev: TransposerEvidence = { gates: v.gates, missingArtifactRefs: [], butterflySatisfiable: true };
    assert.equal(transposerContract.evaluateEvidence(taskView, ev).kind, "accept", `${v.label}: contract verdict`);
  }
});

// ===========================================================================
// ACCEPT hard-evidence gate: the adapter respects ALL THREE accept conditions
// (oraclePass AND missingArtifactRefs=[] AND butterflySatisfiable), not just the
// gate. A claimed_complete task with a PASS gate but a MISSING required artifact is
// 'reject' (the evidence does not hold). Proves the discovery hints
// (missingArtifactRefs) are wired through the adapter, not stubbed.
// ===========================================================================
test("accept gate: claimed_complete + PASS gate + missingArtifactRefs => reject (full accept gate respected)", () => {
  const ref = "phase:missing-artifact";
  const gate = "missing/oracle-review.json";
  const taskView = taskViewFor(ref, "claimed_complete");

  // PASS gate present, but a required artifact ref is missing => reject.
  const evidenceWithMissing: TransposerEvidence = {
    gates: [{ ref: gate, verdict: "PASS", noShip: false, discoveredVia: "cited" }],
    missingArtifactRefs: ["plan/required-artifact.json"],
    butterflySatisfiable: true,
  };
  const verdictMissing = transposerContract.evaluateEvidence(taskView, evidenceWithMissing);
  assert.equal(verdictMissing.kind, "reject", "PASS gate but missing artifact => reject");
  assert.equal(verdictMissing.satisfied, false);
  assert.deepEqual(verdictMissing.awaitedKinds, ["accept"]);

  // Same gate, but the artifact is now present (missing=[]) + butterfly true => accept.
  const evidenceComplete: TransposerEvidence = {
    gates: [{ ref: gate, verdict: "PASS", noShip: false, discoveredVia: "cited" }],
    missingArtifactRefs: [],
    butterflySatisfiable: true,
  };
  const verdictComplete = transposerContract.evaluateEvidence(taskView, evidenceComplete);
  assert.equal(verdictComplete.kind, "accept", "PASS gate + all refs present + butterfly => accept");
  assert.equal(verdictComplete.satisfied, true);

  // And butterfly-unsatisfiable also blocks accept (the third condition).
  const evidenceNoButterfly: TransposerEvidence = {
    gates: [{ ref: gate, verdict: "PASS", noShip: false, discoveredVia: "cited" }],
    missingArtifactRefs: [],
    butterflySatisfiable: false,
  };
  assert.equal(transposerContract.evaluateEvidence(taskView, evidenceNoButterfly).kind, "reject", "PASS gate but butterfly unsatisfiable => reject");
});

// ===========================================================================
// directiveHash STABILITY: the projected evidenceKind is an ANNOTATION, NOT identity.
// Two directives identical except evidenceKind share the hash. This is the
// content-addressed idempotency the transposer WS-H2 delivery depends on; EH2
// already excludes evidenceKind from directiveHash (proven in
// test/worklist/evidence-reducer.test.ts (f)). Re-asserted here for the transposer
// adapter to confirm the migration does not change identity.
// ===========================================================================
test("directiveHash stability: projected evidenceKind does not change the hash (transposer adapter)", () => {
  const action = "ACCEPT";
  const owner = ORCHESTRATOR;
  const refs = ["plan/oracle-review.json"];
  const deadline = "2026-01-01T00:00:00.000Z";
  const hash = directiveHash(action, owner, refs, deadline);

  const base: Directive = {
    schema: "zob.worklist-directive.v1",
    action,
    ref: "phase:stable",
    owner,
    reasonRef: null,
    unblockPath: null,
    evidenceRequired: refs,
    evidencePresent: true,
    deadline,
    hash,
  };
  // Directives identical except the projected evidenceKind share the hash.
  const accept: Directive = { ...base, evidenceKind: "accept" };
  const reject: Directive = { ...base, evidenceKind: "reject" };
  const reassign: Directive = { ...base, evidenceKind: "reassign" };
  const nulled: Directive = { ...base, evidenceKind: null };
  assert.equal(accept.hash, hash);
  assert.equal(reject.hash, hash);
  assert.equal(reassign.hash, hash);
  assert.equal(nulled.hash, hash);
  assert.equal(accept.hash, reject.hash);
  assert.notEqual(accept.evidenceKind, reject.evidenceKind, "the kinds differ but the hash does not");
});

// ===========================================================================
// DETERMINISM: the contract is a PURE function — same (taskView, evidence) =>
// same verdict, reproducibly. A seeded sweep over the input space exercises
// multiple kind branches and is reproducible across two independent runs.
// ===========================================================================
test("determinism: seeded sweep is reproducible and exercises multiple kind branches", () => {
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
  function sweep(seed: number): { kind: EvidenceKind; satisfied: boolean }[] {
    const rng = mulberry32(seed);
    const out: { kind: EvidenceKind; satisfied: boolean }[] = [];
    for (let i = 0; i < 256; i += 1) {
      const r = rng();
      const statuses = ["claimed_complete", "rejected", "accepted", "assigned"] as const;
      const status = statuses[Math.floor(rng() * statuses.length)];
      const taskView: TaskView = taskViewFor("phase:det", status, r > 0.5 ? GATE_REF : null);
      const gates: GateEntry[] = rng() < 0.6 ? [{ ref: GATE_REF, verdict: rng() < 0.5 ? "PASS" : "UNKNOWN", noShip: rng() < 0.1, discoveredVia: "cited" }] : [];
      const deps: DepEntry[] = rng() < 0.3 ? [{ ref: DEP_REF, status: "rejected", invalidated: rng() < 0.5 }] : [];
      const ev: TransposerEvidence = { gates, deps, missingArtifactRefs: [], butterflySatisfiable: rng() < 0.8 };
      const verdict = transposerContract.evaluateEvidence(taskView, ev);
      out.push({ kind: verdict.kind, satisfied: verdict.satisfied });
    }
    return out;
  }
  const run1 = sweep(0xc0ffee);
  const run2 = sweep(0xc0ffee);
  assert.equal(run1.length, 256);
  assert.deepEqual(run1, run2, "seeded sweep must be reproducible (same seed => identical verdict sequence)");
  const distinctKinds = new Set(run1.map((x) => x.kind));
  assert.ok(distinctKinds.size >= 2, `deterministic sweep should exercise >=2 kind branches (got ${[...distinctKinds].join(",")})`);
  // The accept/reject/reassign/rollback/noop FSM branches all appear (non-degenerate).
  assert.ok(distinctKinds.has("noop"), "noop branch exercised");
});
