// DoD-A (PART II): a SECOND worklist consumer proves the harness WorklistReducer
// contract is genuinely reusable. This is NOT transposer-coupled: it invents a
// 'pacman'-style feature-gate project with its OWN finite-state machine
// (READY -> IN_REVIEW -> GATE_PENDING -> SHIPPED) and its OWN event vocabulary,
// plugs it into the shipped harness API via registerWorklistReducer +
// openWorklistStore(reducer_id='pacman-features'), and proves its directives:
//   (a) are DERIVED from events by its own reducer (content-addressed hashes);
//   (b) honor the watchdog HARD RULE (observe ONLY when the open-directive set
//       is empty);
//   (c) CLOSE automatically through the watchdog + delivery loop, advancing
//       IN_REVIEW -> GATE_PENDING -> SHIPPED until the worklist is empty.
// Read+test only: no harness source is modified, and no transposer FSM state is
// copied (pacman's directive actions are REVIEW/GATE/SHIP, not transposer's
// ACCEPT/REJECT/AWAIT_EVIDENCE/REASSIGN/ROLLBACK).

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  DIRECTIVE_DELIVERY_REASON_DIRECTIVE_SATISFIED,
  GENERIC_WORKLIST_REDUCER_ID,
  buildDirective,
  deliverDirectiveNotification,
  directiveHash,
  evaluateWorklistWatchdog,
  listWorklistReducerIds,
  openWorklistStore,
  registerWorklistReducer,
  type Directive,
  type WorklistReducer,
  type WorklistStore,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- pacman's OWN reducer (distinct reducer_id + distinct FSM) ----------------

const PACMAN_REDUCER_ID = "pacman-features";

// Pacman event vocabulary — its own, distinct from transposer event types
// (PHASE_ACCEPTED.v1 / PHASE_REJECTED.v1 / ...) and from the generic reducer
// (OPEN / CLOSE / NOTE). Inventing a fresh vocabulary proves the contract generic.
const PACMAN_KIND_OPEN = "OPEN_FEATURE"; // feature node opened -> IN_REVIEW
const PACMAN_KIND_REVIEW_DONE = "REVIEW_COMPLETE"; // review done -> GATE_PENDING
const PACMAN_KIND_GATE_EVIDENCE = "GATE_EVIDENCE"; // gate evidence arrived (PASS)
const PACMAN_KIND_SHIPPED = "SHIP_COMPLETE"; // feature shipped -> SHIPPED

const PACMAN_GATE_EVIDENCE_TOKEN = "pacman:gate-evidence";

// pacmanFeatureReducer: a SECOND consumer WorklistReducer.
//
// Feature FSM: READY -> IN_REVIEW -> GATE_PENDING -> SHIPPED.
// The reducer reconstructs each feature's CURRENT state from its own event stream
// (the single source of truth) and emits exactly ONE directive per open feature:
//   IN_REVIEW  (OPEN_FEATURE, no REVIEW_COMPLETE)        -> REVIEW
//   GATE_PENDING + no GATE_EVIDENCE (evidence missing)   -> GATE
//   GATE_PENDING + GATE_EVIDENCE present (gate PASS)     -> SHIP
//   SHIPPED (SHIP_COMPLETE)                              -> (nothing)
// Everything is derived from events; deps is unused because the harness store
// passes deps.evidence = {} (evidence must be event-encoded on the blackboard).
export const pacmanFeatureReducer: WorklistReducer = {
  reducerId: PACMAN_REDUCER_ID,
  computeDirectives(events) {
    interface FeatureState {
      ref: string;
      owner: string;
      deadline: string | null;
      opened: boolean;
      reviewDone: boolean;
      gateEvidence: boolean;
      shipped: boolean;
    }
    const features = new Map<string, FeatureState>();
    const known = new Set([PACMAN_KIND_OPEN, PACMAN_KIND_REVIEW_DONE, PACMAN_KIND_GATE_EVIDENCE, PACMAN_KIND_SHIPPED]);
    for (const event of events) {
      const ref = event.ref;
      if (!ref) continue;
      const kind = String(event.kind ?? "");
      if (!known.has(kind)) continue; // ignore non-pacman events
      let feature = features.get(ref);
      if (!feature) {
        feature = {
          ref,
          owner: event.owner ?? "pac-unassigned",
          deadline: event.deadline ?? null,
          opened: false,
          reviewDone: false,
          gateEvidence: false,
          shipped: false,
        };
        features.set(ref, feature);
      }
      if (kind === PACMAN_KIND_OPEN) {
        feature.opened = true;
        if (event.owner) feature.owner = event.owner;
        if (event.deadline) feature.deadline = event.deadline;
      } else if (kind === PACMAN_KIND_REVIEW_DONE) {
        feature.reviewDone = true;
      } else if (kind === PACMAN_KIND_GATE_EVIDENCE) {
        feature.gateEvidence = true;
      } else if (kind === PACMAN_KIND_SHIPPED) {
        feature.shipped = true;
      }
    }

    const directives: Directive[] = [];
    for (const feature of features.values()) {
      if (feature.shipped || !feature.opened) continue;
      if (feature.reviewDone) {
        if (feature.gateEvidence) {
          directives.push(
            buildDirective({
              action: "SHIP",
              ref: feature.ref,
              owner: feature.owner,
              reasonRef: "pacman:gate_passed_ready_to_ship",
              unblockPath: "append:SHIP_COMPLETE",
              evidenceRequired: [],
              evidencePresent: true,
              deadline: feature.deadline,
            }),
          );
        } else {
          directives.push(
            buildDirective({
              action: "GATE",
              ref: feature.ref,
              owner: feature.owner,
              reasonRef: "pacman:gate_pending_evidence_missing",
              unblockPath: "append:GATE_EVIDENCE",
              evidenceRequired: [PACMAN_GATE_EVIDENCE_TOKEN],
              evidencePresent: false,
              deadline: feature.deadline,
            }),
          );
        }
      } else {
        directives.push(
          buildDirective({
            action: "REVIEW",
            ref: feature.ref,
            owner: feature.owner,
            reasonRef: "pacman:feature_in_review",
            unblockPath: "append:REVIEW_COMPLETE",
            evidenceRequired: [],
            evidencePresent: false,
            deadline: feature.deadline,
          }),
        );
      }
    }

    // Deterministic order: deadline then ref (mirrors generic + transposer).
    directives.sort(
      (a, b) =>
        String(a.deadline ?? "").localeCompare(String(b.deadline ?? "")) || String(a.ref ?? "").localeCompare(String(b.ref ?? "")),
    );
    return directives;
  },
  validateEvent(event) {
    const errors: string[] = [];
    const known = new Set([PACMAN_KIND_OPEN, PACMAN_KIND_REVIEW_DONE, PACMAN_KIND_GATE_EVIDENCE, PACMAN_KIND_SHIPPED]);
    if (!known.has(String(event.kind ?? ""))) errors.push(`pacman reducer: unknown event kind '${event.kind}'`);
    if (!event.ref || String(event.ref).trim().length === 0) errors.push("pacman reducer: event ref (feature id) is required");
    return errors;
  },
};
registerWorklistReducer(pacmanFeatureReducer);

// transposer's directive actions (reference only) — pacman must NOT use these.
const TRANSPOSER_ACTIONS = new Set(["ACCEPT", "REJECT", "AWAIT_EVIDENCE", "REASSIGN", "ROLLBACK"]);

let repo = "";
const stores: WorklistStore[] = [];
const BASE_NOW = 1_700_000_000_000; // deterministic clock

before(() => {
  repo = mkdtempSync(join(tmpdir(), "zob-pacman-reducer-"));
});

after(() => {
  for (const store of stores) {
    try {
      store.validate(BASE_NOW);
    } catch {
      /* best-effort consistency check */
    }
  }
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp repo */
  }
});

// ===========================================================================
// (0) Registry: the pacman reducer plugs into the harness WorklistReducer
//     contract under its own reducer_id, distinct from generic and not coupled
//     to transposer.
// ===========================================================================
test("pacman: reducer registers under its own reducer_id, distinct from generic", () => {
  const ids = listWorklistReducerIds();
  assert.ok(ids.includes(PACMAN_REDUCER_ID), "pacman-features reducer must be registered");
  assert.ok(ids.includes(GENERIC_WORKLIST_REDUCER_ID), "generic reducer stays available");
});

// ===========================================================================
// (a) Directives are DERIVED from events by pacman's own reducer. The directive
//     action advances REVIEW -> GATE -> SHIP as pacman events arrive, and each
//     hash is the content-addressed directiveHash() over {action, owner,
//     evidenceRequired, deadline} — proving the directive is reducer-derived, not
//     hardcoded, and not transposer-coupled.
// ===========================================================================
test("pacman (a): directives are derived from events via the pacman reducer (REVIEW -> GATE -> SHIP)", () => {
  const scope = "pac-derived";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  stores.push(store);
  const owner = "pac-reviewer";
  const ref = "features/pac-gobble.json";
  const deadline = new Date(BASE_NOW + 60_000).toISOString();

  // IN_REVIEW: OPEN_FEATURE -> exactly one REVIEW directive, content-addressed.
  store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: PACMAN_KIND_OPEN, ref, owner, deadline });
  let directives = store.listDirectives(BASE_NOW);
  assert.equal(directives.length, 1);
  const review = directives[0];
  assert.equal(review.action, "REVIEW");
  assert.equal(review.owner, owner);
  assert.equal(review.ref, ref);
  assert.deepEqual(review.evidenceRequired, []);
  assert.equal(review.evidencePresent, false);
  assert.equal(review.hash, directiveHash("REVIEW", owner, [], deadline));
  assert.equal(TRANSPOSER_ACTIONS.has(review.action), false); // pacman's own FSM

  // GATE_PENDING + no evidence: REVIEW_COMPLETE -> exactly one GATE directive.
  store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: PACMAN_KIND_REVIEW_DONE, ref });
  directives = store.listDirectives(BASE_NOW);
  assert.equal(directives.length, 1);
  const gate = directives[0];
  assert.equal(gate.action, "GATE");
  assert.equal(gate.owner, owner); // owner carried forward from OPEN_FEATURE
  assert.deepEqual(gate.evidenceRequired, [PACMAN_GATE_EVIDENCE_TOKEN]);
  assert.equal(gate.evidencePresent, false);
  assert.equal(gate.hash, directiveHash("GATE", owner, [PACMAN_GATE_EVIDENCE_TOKEN], deadline));
  assert.notEqual(gate.hash, review.hash); // new content => new hash
  assert.equal(TRANSPOSER_ACTIONS.has(gate.action), false);

  // GATE_PENDING + gate PASS: GATE_EVIDENCE -> exactly one SHIP directive.
  store.appendEvent({
    scope,
    reducer_id: PACMAN_REDUCER_ID,
    kind: PACMAN_KIND_GATE_EVIDENCE,
    ref,
    evidence_refs: ["features/pac-gobble-gate.json"],
  });
  directives = store.listDirectives(BASE_NOW);
  assert.equal(directives.length, 1);
  const ship = directives[0];
  assert.equal(ship.action, "SHIP");
  assert.equal(ship.evidencePresent, true); // gate evidence now present
  assert.equal(ship.hash, directiveHash("SHIP", owner, [], deadline));
  assert.notEqual(ship.hash, gate.hash); // GATE closed, SHIP is a new directive
  assert.equal(TRANSPOSER_ACTIONS.has(ship.action), false);

  // SHIPPED: SHIP_COMPLETE -> no directive (the feature is done).
  store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: PACMAN_KIND_SHIPPED, ref });
  assert.equal(store.listDirectives(BASE_NOW).length, 0);

  // The pacman validateEvent hook gates appends (injectable project validator).
  assert.throws(
    () => store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: "PHASE_ACCEPTED.v1", ref }),
    /pacman reducer: unknown event kind/,
  );
});

// ===========================================================================
// (b) The watchdog HARD RULE holds for the pacman scope too: observe is true
//     EXACTLY when the open-directive set is empty. A non-empty worklist NEVER
//     observes (the rule that prevents the original transposer supervisor-check
//     stall). The two features use distinct deadlines so their REVIEW directives
//     have distinct content-addressed hashes (directiveHash does not include ref).
// ===========================================================================
test("pacman (b): watchdog HARD RULE holds — observe only when directives are empty", () => {
  const scope = "pac-hard-rule";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  stores.push(store);
  const owner = "pac-reviewer";
  const speedRef = "features/pac-speed.json";
  const fruitRef = "features/pac-fruit.json";
  const speedDeadline = new Date(BASE_NOW + 60_000).toISOString();
  const fruitDeadline = new Date(BASE_NOW + 120_000).toISOString();

  // Empty worklist -> observe is correct.
  let evaluation = evaluateWorklistWatchdog(repo, scope, BASE_NOW);
  assert.equal(evaluation.observe, true);
  assert.equal(evaluation.directivesOpen, 0);
  assert.equal(evaluation.observe, evaluation.directivesOpen === 0); // HARD RULE invariant

  // One open REVIEW directive -> NEVER observe.
  store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: PACMAN_KIND_OPEN, ref: speedRef, owner, deadline: speedDeadline });
  evaluation = evaluateWorklistWatchdog(repo, scope, BASE_NOW);
  assert.equal(evaluation.observe, false);
  assert.equal(evaluation.directivesOpen, 1);
  assert.equal(evaluation.observe, evaluation.directivesOpen === 0);

  // Two open REVIEW directives -> still NEVER observe.
  store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: PACMAN_KIND_OPEN, ref: fruitRef, owner, deadline: fruitDeadline });
  evaluation = evaluateWorklistWatchdog(repo, scope, BASE_NOW);
  assert.equal(evaluation.observe, false);
  assert.equal(evaluation.directivesOpen, 2);

  // Satisfy the speed feature's REVIEW (distinct hash from fruit) -> one open
  // remains -> still NEVER observe. (A satisfied directive is DONE.)
  const speedHash = store
    .listDirectives(BASE_NOW)
    .find((directive) => directive.ref === speedRef)?.hash;
  assert.ok(speedHash);
  store.claim(speedHash, owner, { now: BASE_NOW });
  store.satisfy(speedHash, owner, BASE_NOW);
  evaluation = evaluateWorklistWatchdog(repo, scope, BASE_NOW);
  assert.equal(evaluation.observe, false);
  assert.equal(evaluation.directivesOpen, 1); // fruit REVIEW still open

  // Satisfy the fruit feature's REVIEW too -> empty open set -> observe.
  const fruitHash = store
    .listDirectives(BASE_NOW)
    .find((directive) => directive.ref === fruitRef && !directive.satisfied)?.hash;
  assert.ok(fruitHash);
  store.claim(fruitHash, owner, { now: BASE_NOW });
  store.satisfy(fruitHash, owner, BASE_NOW);
  evaluation = evaluateWorklistWatchdog(repo, scope, BASE_NOW);
  assert.equal(evaluation.observe, true);
  assert.equal(evaluation.directivesOpen, 0);
  assert.equal(evaluation.observe, evaluation.directivesOpen === 0);
});

// ===========================================================================
// (c) Directives CLOSE automatically through the watchdog + delivery loop. Two
//     features advance IN_REVIEW -> GATE_PENDING -> SHIPPED by claim + satisfy +
//     transition event; at every step the next directive is re-derived from the
//     event stream, the delivery layer clears the satisfied directive
//     (dropped-notification tolerance), and the loop ends with an empty worklist
//     that observes.
// ===========================================================================
test("pacman (c): directives close automatically through the watchdog + delivery loop", () => {
  const scope = "pac-lifecycle";
  const store = openWorklistStore(repo, scope, { now: () => BASE_NOW });
  stores.push(store);
  const claimant = "pac-worker";
  // Distinct deadlines => distinct content-addressed hashes per feature.
  const feats = [
    { ref: "features/pac-cherry.json", deadline: new Date(BASE_NOW + 60_000).toISOString() },
    { ref: "features/pac-bell.json", deadline: new Date(BASE_NOW + 120_000).toISOString() },
  ];

  // Open two features -> two REVIEW directives.
  for (const feat of feats) {
    store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: PACMAN_KIND_OPEN, ref: feat.ref, owner: claimant, deadline: feat.deadline });
  }
  assert.equal(store.listDirectives(BASE_NOW).length, 2);
  assert.equal(evaluateWorklistWatchdog(repo, scope, BASE_NOW).observe, false);

  // Advance each feature through its full lifecycle. At every phase the next
  // directive is DERIVED from the event stream and the previous one closes.
  for (const feat of feats) {
    const directiveFor = (ref: string): Directive =>
      store.listDirectives(BASE_NOW).find((directive) => directive.ref === ref) as Directive;

    // Phase IN_REVIEW: REVIEW directive derived from OPEN_FEATURE.
    const review = directiveFor(feat.ref);
    assert.ok(review, `REVIEW directive for ${feat.ref}`);
    assert.equal(review.action, "REVIEW");

    // Delivery loop: claim + satisfy. The delivery layer then reports the
    // directive CLEARED (reason directive_satisfied) — dropped-notification
    // tolerance: the persisted satisfy IS the acting evidence, so no re-delivery.
    store.claim(review.hash, claimant, { now: BASE_NOW });
    store.satisfy(review.hash, claimant, BASE_NOW);
    const clearedReview = deliverDirectiveNotification(repo, scope, review.hash, { nowMs: BASE_NOW });
    assert.equal(clearedReview.cleared, true);
    assert.equal(clearedReview.plan.reason, DIRECTIVE_DELIVERY_REASON_DIRECTIVE_SATISFIED);
    assert.equal(clearedReview.notification, null);

    // Transition: REVIEW_COMPLETE -> reducer re-derives -> next directive GATE.
    store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: PACMAN_KIND_REVIEW_DONE, ref: feat.ref });
    const gate = directiveFor(feat.ref);
    assert.ok(gate, `GATE directive for ${feat.ref}`);
    assert.equal(gate.action, "GATE");
    assert.notEqual(gate.hash, review.hash); // REVIEW closed, GATE is a new directive
    assert.equal(evaluateWorklistWatchdog(repo, scope, BASE_NOW).observe, false); // GATE open

    // claim + satisfy GATE, then gate evidence arrives -> SHIP.
    store.claim(gate.hash, claimant, { now: BASE_NOW });
    store.satisfy(gate.hash, claimant, BASE_NOW);
    store.appendEvent({
      scope,
      reducer_id: PACMAN_REDUCER_ID,
      kind: PACMAN_KIND_GATE_EVIDENCE,
      ref: feat.ref,
      evidence_refs: [`${feat.ref}.gate.json`],
    });
    const ship = directiveFor(feat.ref);
    assert.ok(ship, `SHIP directive for ${feat.ref}`);
    assert.equal(ship.action, "SHIP");
    assert.equal(ship.evidencePresent, true);
    assert.notEqual(ship.hash, gate.hash); // GATE closed, SHIP is a new directive

    // claim + satisfy SHIP, then SHIP_COMPLETE -> feature done (no directive).
    store.claim(ship.hash, claimant, { now: BASE_NOW });
    store.satisfy(ship.hash, claimant, BASE_NOW);
    store.appendEvent({ scope, reducer_id: PACMAN_REDUCER_ID, kind: PACMAN_KIND_SHIPPED, ref: feat.ref });
  }

  // Both features shipped -> empty worklist -> observe. The loop closed every
  // directive automatically through claim + satisfy + transition.
  assert.equal(store.listDirectives(BASE_NOW).length, 0);
  const evaluation = evaluateWorklistWatchdog(repo, scope, BASE_NOW);
  assert.equal(evaluation.observe, true);
  assert.equal(evaluation.directivesOpen, 0);
  assert.equal(evaluation.escalation.length, 0);

  // Scope stays internally consistent (reducer homogeneous, body-free, hashes hold).
  const validation = store.validate(BASE_NOW);
  assert.equal(validation.healthy, true);
  assert.equal(validation.violations.length, 0);
  assert.equal(validation.eventCount, feats.length * 4); // 4 events per feature
});
