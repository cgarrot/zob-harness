import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  DEFAULT_RESEND_INTERVAL_MS,
  DIRECTIVE_DELIVERY_REASON_DIRECTIVE_SATISFIED,
  DIRECTIVE_DELIVERY_REASON_IN_FLIGHT,
  DIRECTIVE_DELIVERY_REASON_NEW,
  DIRECTIVE_DELIVERY_REASON_NO_HASH,
  DIRECTIVE_DELIVERY_REASON_REDELIVER,
  DIRECTIVE_DELIVERY_REASON_SEEN_ACTED,
  GENERIC_WORKLIST_REDUCER_ID,
  claimWorklistDirective,
  deliverDirectiveNotification,
  listDeliveries,
  markDirectiveActed,
  markDirectiveDeliveredActed,
  openWorklistStore,
  planDirectiveDelivery,
  reconcileDirectiveLedger,
  recordDirectiveDelivery,
  satisfyWorklistDirective,
  worklistBodyFreeViolations,
  type DirectiveDeliveryLedger,
  type WorklistStore,
} from "../../.pi/extensions/zob-harness/index.ts";

let repo = "";
let stores: WorklistStore[] = [];
const UNKNOWN_HASH = "a".repeat(64); // valid sha256-hex shape, never projected

before(() => {
  repo = mkdtempSync(join(tmpdir(), "zob-worklist-delivery-"));
});

after(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp repo */
  }
});

function readDeliveryLines(scope: string): Array<Record<string, unknown>> {
  return listDeliveries(repo, scope);
}

function openDirectiveFor(scope: string, store: WorklistStore, ref: string, owner: string, evidenceRefs: string[] = []): string {
  // OPEN with a NULL deadline so the generic reducer projects it as DUE
  // immediately at ANY clock value. The delivery tests drive deterministic
  // resend_after_ms with a FIXED nowMs, so the directive must be due regardless
  // of that fixed clock; a null deadline is immediately actionable.
  store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID,
    kind: "OPEN",
    ref,
    owner,
    evidence_refs: evidenceRefs,
  });
  return store.listDirectives()[0].hash;
}

// =============================================================================
// (1) Pure primitive parity — exact transposer DIRECTIVE_DELIVERY_REASON_* mirror.
//     Operates on an in-memory Map; no IO. Same assertions as the transposer
//     self-test (adapted to camelCase + resendAfterMs).
// =============================================================================
test("delivery: pure planDirectiveDelivery mirrors transposer reasons (new/in_flight/redeliver/seen_acted/no_hash)", () => {
  const ledger: DirectiveDeliveryLedger = new Map();
  const now = 1_700_000_000_000;
  const interval = 120_000;
  const H = "b".repeat(64);

  // new_directive
  const p1 = planDirectiveDelivery({ hash: H, ledger, nowMs: now, resendIntervalMs: interval });
  assert.equal(p1.deliver, true);
  assert.equal(p1.reason, DIRECTIVE_DELIVERY_REASON_NEW);
  assert.equal(p1.suppressed, false);
  assert.equal(p1.resendAfterMs, 0);
  assert.equal(p1.hash, H);

  // record once; in_flight_within_cooldown suppresses with exact remaining ms.
  recordDirectiveDelivery(ledger, H, now);
  const p2 = planDirectiveDelivery({ hash: H, ledger, nowMs: now + 1_000, resendIntervalMs: interval });
  assert.equal(p2.deliver, false);
  assert.equal(p2.reason, DIRECTIVE_DELIVERY_REASON_IN_FLIGHT);
  assert.equal(p2.resendAfterMs, 119_000);

  // past the cooldown: a dropped nudge is re-delivered (lost-nudge tolerance).
  const p3 = planDirectiveDelivery({ hash: H, ledger, nowMs: now + interval + 1_000, resendIntervalMs: interval });
  assert.equal(p3.deliver, true);
  assert.equal(p3.reason, DIRECTIVE_DELIVERY_REASON_REDELIVER);
  recordDirectiveDelivery(ledger, H, now + interval + 1_000);

  // receiver acts exactly once: seen+acted => skip on every later tick.
  assert.equal(markDirectiveActed(ledger, H), true);
  const p4 = planDirectiveDelivery({ hash: H, ledger, nowMs: now + interval + 2_000, resendIntervalMs: interval });
  assert.equal(p4.deliver, false);
  assert.equal(p4.reason, DIRECTIVE_DELIVERY_REASON_SEEN_ACTED);

  // no double-mark: markDirectiveActed returns false for an already-acted hash.
  assert.equal(markDirectiveActed(ledger, H), false);

  // changed content => different hash => re-deliver as new (not seen_and_acted).
  const H2 = "c".repeat(64);
  const p5 = planDirectiveDelivery({ hash: H2, ledger, nowMs: now + interval + 3_000, resendIntervalMs: interval });
  assert.equal(p5.deliver, true);
  assert.equal(p5.reason, DIRECTIVE_DELIVERY_REASON_NEW);

  // no hash => no_directive_hash (never deliver a directive with no hash).
  const p6 = planDirectiveDelivery({ hash: null, ledger, nowMs: now, resendIntervalMs: interval });
  assert.equal(p6.deliver, false);
  assert.equal(p6.reason, DIRECTIVE_DELIVERY_REASON_NO_HASH);
  assert.equal(p6.hash, null);

  // markDirectiveActed returns false for a hash that was never delivered.
  const H3 = "d".repeat(64);
  assert.equal(markDirectiveActed(ledger, H3), false);
});

// =============================================================================
// (2) reconcileDirectiveLedger prunes satisfied/superseded hashes.
// =============================================================================
test("delivery: reconcileDirectiveLedger prunes hashes no longer in the open set", () => {
  const ledger: DirectiveDeliveryLedger = new Map();
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  recordDirectiveDelivery(ledger, H1, 1_700_000_000_000);
  recordDirectiveDelivery(ledger, H2, 1_700_000_000_000);
  assert.equal(ledger.size, 2);

  const pruned = reconcileDirectiveLedger(ledger, [H1]); // H2 satisfied/closed
  assert.deepEqual(pruned, [H2]);
  assert.equal(ledger.has(H1), true);
  assert.equal(ledger.has(H2), false);

  // A pruned hash that re-appears is treated as new_directive.
  const after = planDirectiveDelivery({ hash: H2, ledger, nowMs: 1_700_000_000_000, resendIntervalMs: 60_000 });
  assert.equal(after.reason, DIRECTIVE_DELIVERY_REASON_NEW);
});

// =============================================================================
// (3) End-to-end idempotent re-delivery via the persisted append-only ledger.
//     The ledger is reloaded from deliveries.jsonl each call, proving the
//     first_sent_at is preserved and last_sent_at advances across ticks.
// =============================================================================
test("delivery: persisted ledger tolerates dropped nudges (in_flight -> redeliver -> seen_acted)", () => {
  const scope = "deliver-idem";
  const store = openWorklistStore(repo, scope);
  stores.push(store);
  const H = openDirectiveFor(scope, store, "reports/deliver-idem/task.json", "worker-a");

  const now = 1_700_000_000_000;
  const interval = 120_000;

  // Tick 1: new_directive -> emit DIRECTIVE_READY notification.
  const r1 = deliverDirectiveNotification(repo, scope, H, { nowMs: now, resendIntervalMs: interval });
  assert.equal(r1.plan.deliver, true);
  assert.equal(r1.plan.reason, DIRECTIVE_DELIVERY_REASON_NEW);
  assert.equal(r1.cleared, false);
  assert.ok(r1.notification);
  assert.equal(r1.notification.directiveHash, H);
  assert.equal(r1.notification.firstSentAt, r1.notification.lastSentAt);

  // The persisted notification is body-free + metadata-only.
  assert.equal(r1.notification.bodyStored, false);
  assert.equal(r1.notification.promptBodiesStored, false);
  assert.equal(r1.notification.outputBodiesStored, false);
  assert.equal(r1.notification.localOnly, true);
  assert.equal(r1.notification.networkEnabled, false);
  assert.deepEqual(worklistBodyFreeViolations(r1.notification), []);
  assert.equal(worklistBodyFreeViolations(r1).length, 0);

  const ready1 = readDeliveryLines(scope).filter((line) => line.kind === "directive_ready");
  assert.equal(ready1.length, 1);

  // Tick 2 (same hash, within cooldown): suppressed in_flight, exact remaining ms.
  const r2 = deliverDirectiveNotification(repo, scope, H, { nowMs: now + 1_000, resendIntervalMs: interval });
  assert.equal(r2.plan.deliver, false);
  assert.equal(r2.plan.reason, DIRECTIVE_DELIVERY_REASON_IN_FLIGHT);
  assert.equal(r2.plan.resendAfterMs, 119_000);
  assert.equal(r2.notification, null);
  assert.equal(readDeliveryLines(scope).filter((line) => line.kind === "directive_ready").length, 1);

  // Tick 3 (past cooldown): a dropped nudge is re-delivered; firstSentAt preserved.
  const r3 = deliverDirectiveNotification(repo, scope, H, { nowMs: now + interval + 1_000, resendIntervalMs: interval });
  assert.equal(r3.plan.deliver, true);
  assert.equal(r3.plan.reason, DIRECTIVE_DELIVERY_REASON_REDELIVER);
  assert.ok(r3.notification);
  assert.equal(r3.notification.firstSentAt, r1.notification.firstSentAt);
  assert.notEqual(r3.notification.lastSentAt, r1.notification.lastSentAt);
  assert.equal(readDeliveryLines(scope).filter((line) => line.kind === "directive_ready").length, 2);

  // Receiver acknowledges acting (the ONLY acted setter path on disk).
  assert.equal(markDirectiveDeliveredActed(repo, scope, H, now + interval + 1_500), true);
  // No double-mark on disk.
  assert.equal(markDirectiveDeliveredActed(repo, scope, H, now + interval + 1_600), false);

  // Tick 4: seen+acted => skip; no new notification.
  const r4 = deliverDirectiveNotification(repo, scope, H, { nowMs: now + interval + 2_000, resendIntervalMs: interval });
  assert.equal(r4.plan.deliver, false);
  assert.equal(r4.plan.reason, DIRECTIVE_DELIVERY_REASON_SEEN_ACTED);
  assert.equal(r4.notification, null);
  assert.equal(readDeliveryLines(scope).filter((line) => line.kind === "directive_ready").length, 2);
});

// =============================================================================
// (4) CAUSAL guard: a delivery notification can ONLY be planned for a hash that
//     currently exists in the projected directives. Speculative/unknown hashes are
//     rejected; an agent cannot fabricate or send a directive the reducer did not
//     derive from state.
// =============================================================================
test("delivery: causal guard rejects speculative/unknown directive hashes", () => {
  const scope = "deliver-causal";
  const store = openWorklistStore(repo, scope);
  stores.push(store);
  const H = openDirectiveFor(scope, store, "reports/deliver-causal/task.json", "worker-b");

  // A valid sha256-hex hash that is NOT in the projected directives is rejected.
  assert.throws(
    () => deliverDirectiveNotification(repo, scope, UNKNOWN_HASH, { nowMs: 1_700_000_000_000 }),
    /directive not found for hash.*causal guard/,
  );

  // The real hash delivers fine.
  const r = deliverDirectiveNotification(repo, scope, H, { nowMs: 1_700_000_000_000 });
  assert.equal(r.plan.reason, DIRECTIVE_DELIVERY_REASON_NEW);

  // A malformed hash is rejected before the causal check.
  assert.throws(() => deliverDirectiveNotification(repo, scope, "not-a-hash", {}), /directive_hash must be sha256 hex/);
});

// =============================================================================
// (5) Changed content => different hash => re-deliver as new (idempotency key is
//     the content-addressed hash). A second OPEN with different content produces a
//     different hash and is delivered independently.
// =============================================================================
test("delivery: a different directive hash re-delivers as new (content-addressed idempotency)", () => {
  const scope = "deliver-changed";
  const store = openWorklistStore(repo, scope);
  stores.push(store);

  // directiveHash covers {action, owner, evidence_refs, deadline} (NOT ref), so
  // two directives with distinct content must differ on owner/evidence_refs.
  store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/deliver-changed/a.json",
    owner: "worker-c1",
  });
  const hashes = store.listDirectives().map((directive) => directive.hash);
  assert.equal(hashes.length, 1);
  const H1 = hashes[0];

  // A second OPEN with DIFFERENT content (different owner) => different hash.
  store.appendEvent({
    scope,
    reducer_id: GENERIC_WORKLIST_REDUCER_ID,
    kind: "OPEN",
    ref: "reports/deliver-changed/b.json",
    owner: "worker-c2",
  });
  const after = store.listDirectives().map((directive) => directive.hash);
  assert.equal(after.length, 2);
  const H2 = after.find((hash) => hash !== H1);
  assert.ok(H2);
  assert.notEqual(H1, H2);

  const now = 1_700_000_000_000;
  const r1 = deliverDirectiveNotification(repo, scope, H1, { nowMs: now });
  const r2 = deliverDirectiveNotification(repo, scope, H2, { nowMs: now });
  assert.equal(r1.plan.reason, DIRECTIVE_DELIVERY_REASON_NEW);
  assert.equal(r2.plan.reason, DIRECTIVE_DELIVERY_REASON_NEW); // changed hash => new
  assert.notEqual(r1.notification?.deliveryId, r2.notification?.deliveryId);
});

// =============================================================================
// (6) HEADLINE — dropped satisfy/delivery notification tolerance.
//     Agent A claims a directive; the satisfy/delivery notification is "dropped"
//     (markDirectiveActed is never called). The NEXT store tick sees the persisted
//     claim/satisfy in leases.jsonl and clears the directive anyway: NO double-exec
//     (a satisfied directive cannot be re-claimed) and NO stall (delivery returns
//     suppressed/cleared on every later tick instead of looping).
// =============================================================================
test("delivery: dropped satisfy notification is tolerated (no double-exec, no stall)", () => {
  const scope = "deliver-dropped";
  const store = openWorklistStore(repo, scope, { leaseMs: 60_000 });
  stores.push(store);
  const H = openDirectiveFor(scope, store, "reports/deliver-dropped/task.json", "agent-a");

  const now = 1_700_000_000_000;

  // Tick 1: orchestrator delivers the directive nudge (new_directive).
  const delivered = deliverDirectiveNotification(repo, scope, H, { nowMs: now });
  assert.equal(delivered.plan.deliver, true);
  assert.equal(delivered.plan.reason, DIRECTIVE_DELIVERY_REASON_NEW);
  assert.equal(delivered.cleared, false);

  // Agent A claims + satisfies the directive (persisted to leases.jsonl).
  claimWorklistDirective(repo, scope, H, "agent-a", { now });
  satisfyWorklistDirective(repo, scope, H, "agent-a", now + 1_000);

  // The satisfy/delivery notification is DROPPED: markDirectiveActed is NEVER called
  // (the acknowledgement back to the orchestrator was lost). No acted marker yet.
  assert.equal(readDeliveryLines(scope).filter((line) => line.kind === "directive_acted").length, 0);

  // Tick 2 (next store tick): the persisted satisfy clears the directive anyway.
  const cleared = deliverDirectiveNotification(repo, scope, H, { nowMs: now + 2_000 });
  assert.equal(cleared.plan.deliver, false);
  assert.equal(cleared.plan.reason, DIRECTIVE_DELIVERY_REASON_DIRECTIVE_SATISFIED);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.notification, null); // no new delivery => no double-exec
  assert.equal(cleared.directive.satisfied, true);

  // The cleared tick recorded the acting evidence derived from the satisfied lease.
  assert.equal(readDeliveryLines(scope).filter((line) => line.kind === "directive_acted").length, 1);

  // NO DOUBLE-EXEC: the satisfied directive cannot be claimed again.
  assert.throws(() => claimWorklistDirective(repo, scope, H, "agent-a", { now: now + 3_000 }), /already satisfied/);

  // NO STALL: every later tick stays suppressed/cleared (no infinite re-delivery).
  const later = deliverDirectiveNotification(repo, scope, H, { nowMs: now + 3_000 });
  assert.equal(later.plan.deliver, false);
  assert.equal(later.cleared, true);
  assert.equal(later.notification, null);

  // The append-only log gained NO new directive_ready after the dropped nudge:
  // exactly one notification (tick 1) + one acted marker (the cleared tick).
  const lines = readDeliveryLines(scope);
  assert.equal(lines.filter((line) => line.kind === "directive_ready").length, 1);
  assert.equal(lines.filter((line) => line.kind === "directive_acted").length, 1);

  // Every persisted delivery record stays body-free + metadata-only.
  for (const line of lines) {
    assert.equal((line as { bodyStored?: unknown }).bodyStored, false);
    assert.equal((line as { networkEnabled?: unknown }).networkEnabled, false);
    assert.equal(worklistBodyFreeViolations(line).length, 0);
  }
});

// =============================================================================
// (7) Default resend interval is exported and sane (metadata-only constant).
// =============================================================================
test("delivery: DEFAULT_RESEND_INTERVAL_MS is a positive finite constant", () => {
  assert.equal(Number.isFinite(DEFAULT_RESEND_INTERVAL_MS), true);
  assert.ok(DEFAULT_RESEND_INTERVAL_MS > 0);
});
