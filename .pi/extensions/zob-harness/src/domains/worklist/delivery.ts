// ZOB Harness — Worklist directive delivery (WS-H2).
//
// Idempotent causal delivery layered on the WS-H1 worklist keystone. Mirrors the
// proven project-transposer directive-delivery primitives
// (planDirectiveDelivery / recordDirectiveDelivery / markDirectiveActed /
// reconcileDirectiveLedger / DIRECTIVE_DELIVERY_REASON_*) EXACTLY in shape and
// semantics, reimplemented here because handoff-state.mjs is a different repo
// (read-only reference) and its delivery code is FSM-coupled. Only the delivery /
// dedup primitives are extracted here — no transposer handoff-FSM logic is copied.
//
// Properties:
//   - CAUSAL: a directive is CREATED by the reducer (computeDirectives), never
//     agent-composed. A delivery notification can ONLY be planned for a hash that
//     currently exists in the projected directives; speculative/unknown hashes are
//     rejected. A directive cannot be sent speculatively or lost-then-fabricated.
//   - IDEMPOTENT: delivery is deduped on the content-addressed hash. seen+acted ->
//     skip; in-flight within cooldown -> skip; lost nudge past cooldown -> re-deliver;
//     changed hash (different content => different hash via directiveHash) ->
//     re-deliver as new. Re-delivery of the same hash never causes a double action
//     because the hash is stable for unchanged directive content.
//   - DROPPED-NOTIFICATION TOLERANT: a persisted claim/satisfy in leases.jsonl
//     clears a directive on the next store tick EVEN IF the satisfy/delivery
//     notification was dropped (markDirectiveActed never called) — no double-exec,
//     no stall. This is the WS-H1 keystone's lease-store contribution (the
//     transposer has no lease store; the equivalent there is reconcileDirectiveLedger).
//
// Delivery notifications are persisted append-only to
// .pi/worklist/<scope>/deliveries.jsonl (hash-only). The persisted record is a
// DIRECTIVE_READY-style notification carrying directive_hash + evidence_refs ONLY
// of the directive's content (plus derived metadata identifiers and delivery
// bookkeeping); raw body/task/prompt/output/content/message/text/diff/patch
// (FORBIDDEN_PLAINTEXT_KEYS from types.ts) are never stored, and the record is
// bodyStored:false / networkEnabled:false / localOnly:true. This mirrors
// coms-v2's networkEnabled:false / localOnly:true posture; NO live transport
// dispatch is introduced (no coms-v2 source is modified).
//
// Purity contract: imports ONLY from src/core/** + ./types.js + ./store.js
// (siblings). No runtime or @earendil-works/pi-coding-agent imports, so the
// domain stays reusable by projections (transposer, pacman, ...).

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { readJsonl } from "../../core/utils/json.js";
import { newRunId, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import { SHA256_HEX } from "./types.js";
import { listWorklistDirectives, worklistBodyFreeViolations } from "./store.js";
import type { ProjectedDirective } from "./types.js";

// --- Schemas + reasons (mirror transposer DIRECTIVE_DELIVERY_REASON_* EXACTLY) --

export const WORKLIST_DIRECTIVE_DELIVERY_LEDGER_SCHEMA = "zob.worklist-directive-delivery-ledger.v1";
export const WORKLIST_DIRECTIVE_DELIVERY_ACTED_SCHEMA = "zob.worklist-directive-acted.v1";
export const DIRECTIVE_READY_NOTIFICATION_SCHEMA = "zob.worklist-directive-ready.v1";

// Delivery reasons — identical strings to transposer DIRECTIVE_DELIVERY_REASON_*.
export const DIRECTIVE_DELIVERY_REASON_NEW = "new_directive";
export const DIRECTIVE_DELIVERY_REASON_REDELIVER = "lost_nudge_redeliver";
export const DIRECTIVE_DELIVERY_REASON_SEEN_ACTED = "seen_and_acted";
export const DIRECTIVE_DELIVERY_REASON_IN_FLIGHT = "in_flight_within_cooldown";
export const DIRECTIVE_DELIVERY_REASON_NO_HASH = "no_directive_hash";
// Harness-only reason: the directive's persisted lease is satisfied, so the next
// store tick clears delivery (dropped-notification tolerance). Not present in the
// transposer (it has no lease store); this is the WS-H1 keystone's contribution.
export const DIRECTIVE_DELIVERY_REASON_DIRECTIVE_SATISFIED = "directive_satisfied";

// Default resend cooldown: a delivered-but-not-acted directive is not re-sent more
// often than this (lost-nudge re-delivery happens on a later tick past this window).
export const DEFAULT_RESEND_INTERVAL_MS = 2 * 60 * 1000;

// --- Ledger types ------------------------------------------------------------

// One per-content-hash delivery ledger entry. Map<hash, record> — mirror of the
// transposer ledger shape, with harness camelCase timestamps.
export interface DirectiveDeliveryRecord {
  hash: string;
  firstSentAt: string | null;
  lastSentAt: string | null;
  acted: boolean;
}

export type DirectiveDeliveryLedger = Map<string, DirectiveDeliveryRecord>;

// The plan for one directive delivery. Mirrors transposer planDirectiveDelivery
// return shape { deliver, reason, suppressed, resend_after_ms, hash } with
// camelCase resendAfterMs.
export interface DirectiveDeliveryPlan {
  deliver: boolean;
  reason: string;
  suppressed: boolean;
  resendAfterMs: number;
  hash: string | null;
}

// A persisted DIRECTIVE_READY notification (append-only, hash-only). Carries
// directive_hash + evidence_refs of the directive's content, plus derived
// metadata identifiers (action enum / owner role id) and delivery bookkeeping.
// bodyStored:false / networkEnabled:false / localOnly:true — asserted body-free.
export interface DirectiveReadyNotification {
  schema: typeof DIRECTIVE_READY_NOTIFICATION_SCHEMA;
  kind: "directive_ready";
  deliveryId: string;
  scope: string;
  directiveHash: string;
  action: string;
  owner: string;
  evidenceRefs: string[];
  firstSentAt: string;
  lastSentAt: string;
  deliverReason: string;
  at: string;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  localOnly: true;
  networkEnabled: false;
}

export interface DirectiveDeliveryResult {
  schema: "zob.worklist-directive-delivery-result.v1";
  scope: string;
  directiveHash: string;
  plan: DirectiveDeliveryPlan;
  directive: ProjectedDirective;
  notification: DirectiveReadyNotification | null;
  /** true when a persisted satisfy cleared the directive (dropped-notification tolerance). */
  cleared: boolean;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  localOnly: true;
  networkEnabled: false;
}

export interface DeliverDirectiveNotificationOptions {
  nowMs?: number;
  resendIntervalMs?: number;
}

// --- Pure primitives (exact transposer mirror; operate on an in-memory Map) ----

// Plan one directive delivery. Returns { deliver, reason, suppressed, resendAfterMs, hash }.
//   new_directive             -> deliver (hash never seen before; also the 'changed'
//                                case, since a changed directive is a different hash)
//   seen_and_acted            -> skip    (hash seen AND receiver already acted)
//   in_flight_within_cooldown -> skip    (hash sent, not yet acted, resend cooldown
//                                not elapsed — do not spam; a dropped nudge is
//                                re-delivered once the cooldown elapses later)
//   lost_nudge_redeliver      -> deliver (hash sent, not yet acted, cooldown elapsed)
//   no_directive_hash         -> skip    (no hash supplied)
export function planDirectiveDelivery(input: {
  hash: string | null;
  ledger: DirectiveDeliveryLedger | null;
  nowMs: number;
  resendIntervalMs: number;
}): DirectiveDeliveryPlan {
  const { hash, ledger, nowMs, resendIntervalMs } = input;
  if (!hash) {
    return { deliver: false, reason: DIRECTIVE_DELIVERY_REASON_NO_HASH, suppressed: true, resendAfterMs: 0, hash: null };
  }
  const prev = ledger?.get(hash);
  if (prev && prev.acted === true) {
    return { deliver: false, reason: DIRECTIVE_DELIVERY_REASON_SEEN_ACTED, suppressed: true, resendAfterMs: 0, hash };
  }
  if (prev) {
    const lastMs = prev.lastSentAt ? Date.parse(prev.lastSentAt) : Number.NaN;
    const elapsed = Number.isFinite(lastMs) ? nowMs - lastMs : Number.POSITIVE_INFINITY;
    if (elapsed < resendIntervalMs) {
      return { deliver: false, reason: DIRECTIVE_DELIVERY_REASON_IN_FLIGHT, suppressed: true, resendAfterMs: Math.max(0, resendIntervalMs - elapsed), hash };
    }
    return { deliver: true, reason: DIRECTIVE_DELIVERY_REASON_REDELIVER, suppressed: false, resendAfterMs: 0, hash };
  }
  return { deliver: true, reason: DIRECTIVE_DELIVERY_REASON_NEW, suppressed: false, resendAfterMs: 0, hash };
}

// Record that a directive hash was delivered (the emitter sent the nudge). Idempotent
// across re-deliveries of the same hash: firstSentAt is preserved, lastSentAt
// advances, acted is preserved. Pure metadata; no raw body.
export function recordDirectiveDelivery(ledger: DirectiveDeliveryLedger, hash: string, nowMs: number): void {
  if (!hash || !ledger) return;
  const prev = ledger.get(hash);
  const nowIso = new Date(nowMs).toISOString();
  ledger.set(hash, {
    hash,
    firstSentAt: prev?.firstSentAt ?? nowIso,
    lastSentAt: nowIso,
    acted: prev?.acted === true,
  });
}

// Mark a directive hash as acted (the receiver produced the expected action; the
// underlying task advanced past the directive). Returns false when the hash was
// never delivered or was already acted. This is the ONLY 'acted' setter, and it is
// evidence-driven (a stale/offline ledger write is never delivery success).
export function markDirectiveActed(ledger: DirectiveDeliveryLedger, hash: string): boolean {
  if (!hash || !ledger || !ledger.has(hash)) return false;
  const prev = ledger.get(hash);
  if (!prev) return false;
  if (prev.acted === true) return false; // already acted — no double-mark
  ledger.set(hash, { ...prev, acted: true });
  return true;
}

// Reconcile the delivery ledger against the current open-directive hash set. Hashes
// no longer open were satisfied/superseded (the task advanced), so they are pruned.
// Returns the pruned hashes. A pruned (satisfied) hash that later re-appears is
// treated as new_directive — it is genuinely a fresh delivery.
export function reconcileDirectiveLedger(ledger: DirectiveDeliveryLedger, currentHashes: readonly string[]): string[] {
  const current = new Set((Array.isArray(currentHashes) ? currentHashes : []).filter(Boolean));
  const pruned: string[] = [];
  if (!ledger) return pruned;
  for (const hash of ledger.keys()) {
    if (current.has(hash)) continue;
    ledger.delete(hash);
    pruned.push(hash);
  }
  return pruned;
}

// --- Persistence (append-only, hash-only jsonl) ------------------------------

function worklistScopeDir(repoRoot: string, scope: string): string {
  return join(repoRoot, ".pi", "worklist", scope);
}

function deliveriesPath(repoRoot: string, scope: string): string {
  return join(worklistScopeDir(repoRoot, scope), "deliveries.jsonl");
}

function validateScope(scope: string): void {
  if (typeof scope !== "string" || scope.trim().length === 0 || safeFileStem(scope) !== scope) {
    throw new Error(`invalid worklist scope: ${scope}`);
  }
}

function strField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Fold the append-only deliveries.jsonl into the in-memory ledger. Two record
// kinds share the log:
//   - directive_ready: a delivery notification (sets/advances first/last sent,
//     preserves acted).
//   - directive_acted : an acted marker (sets acted=true, preserves sent timestamps).
// Folding is order-preserving and deterministic, so the ledger is always
// reconstructable from the append-only log (no in-place mutation).
export function loadDirectiveDeliveryLedger(repoRoot: string, scope: string): DirectiveDeliveryLedger {
  const ledger = new Map<string, DirectiveDeliveryRecord>();
  const records = readJsonl(deliveriesPath(repoRoot, scope));
  for (const raw of records) {
    if (!isRecord(raw)) continue;
    const kind = String(raw.kind ?? "");
    const hash = typeof raw.directiveHash === "string" && raw.directiveHash ? raw.directiveHash : strField(raw, "hash");
    if (!hash || !SHA256_HEX.test(hash)) continue;
    if (kind === "directive_ready") {
      const prev = ledger.get(hash);
      ledger.set(hash, {
        hash,
        firstSentAt: prev?.firstSentAt ?? strField(raw, "firstSentAt"),
        lastSentAt: strField(raw, "lastSentAt") ?? prev?.lastSentAt ?? null,
        acted: prev?.acted === true,
      });
    } else if (kind === "directive_acted") {
      const prev = ledger.get(hash);
      ledger.set(hash, {
        hash,
        firstSentAt: prev?.firstSentAt ?? null,
        lastSentAt: prev?.lastSentAt ?? null,
        acted: true,
      });
    }
  }
  return ledger;
}

function buildDirectiveReadyNotification(
  scope: string,
  directive: ProjectedDirective,
  prev: DirectiveDeliveryRecord | undefined,
  reason: string,
  nowMs: number,
): DirectiveReadyNotification {
  const nowIso = new Date(nowMs).toISOString();
  return {
    schema: DIRECTIVE_READY_NOTIFICATION_SCHEMA,
    kind: "directive_ready",
    deliveryId: newRunId("wldel"),
    scope,
    directiveHash: directive.hash,
    action: directive.action,
    owner: directive.owner,
    evidenceRefs: [...directive.evidenceRequired],
    firstSentAt: prev?.firstSentAt ?? nowIso,
    lastSentAt: nowIso,
    deliverReason: reason,
    at: nowIso,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    localOnly: true,
    networkEnabled: false,
  };
}

function appendDirectiveDeliveryRecord(repoRoot: string, scope: string, record: unknown): void {
  mkdirSync(worklistScopeDir(repoRoot, scope), { recursive: true });
  appendFileSync(deliveriesPath(repoRoot, scope), `${JSON.stringify(record)}\n`, "utf8");
}

function deliveryResult(
  scope: string,
  hash: string,
  plan: DirectiveDeliveryPlan,
  directive: ProjectedDirective,
  notification: DirectiveReadyNotification | null,
  cleared: boolean,
): DirectiveDeliveryResult {
  return {
    schema: "zob.worklist-directive-delivery-result.v1",
    scope,
    directiveHash: hash,
    plan,
    directive,
    notification,
    cleared,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    localOnly: true,
    networkEnabled: false,
  };
}

// --- IO: deliver one directive notification (the zob_worklist deliver action) ---

// Plan + (if delivered) record + emit a DIRECTIVE_READY notification for one
// directive hash. Enforces the causal guard (hash must exist in the projected
// directives) and dropped-notification tolerance (a persisted satisfy clears
// delivery without needing markDirectiveActed). Returns the plan, the directive,
// the emitted notification (or null), and the cleared flag.
export function deliverDirectiveNotification(
  repoRoot: string,
  scope: string,
  hash: string,
  options: DeliverDirectiveNotificationOptions = {},
): DirectiveDeliveryResult {
  validateScope(scope);
  if (!hash || !SHA256_HEX.test(hash)) throw new Error(`directive_hash must be sha256 hex: ${hash}`);

  const nowMs = options.nowMs ?? Date.now();
  const resendIntervalMs = Math.floor(options.resendIntervalMs ?? DEFAULT_RESEND_INTERVAL_MS);
  if (!Number.isFinite(resendIntervalMs) || resendIntervalMs < 0) throw new Error("resend_interval_ms must be a finite number >= 0");

  // CAUSAL guard: a directive is CREATED by the reducer, never agent-composed. A
  // delivery notification can ONLY be planned for a hash that currently exists in
  // the projected directives. Reject speculative/unknown hashes (cannot be sent
  // speculatively or lost-then-fabricated).
  const directives = listWorklistDirectives(repoRoot, scope, nowMs);
  const directive = directives.find((item) => item.hash === hash);
  if (!directive) {
    throw new Error(`directive not found for hash (causal guard rejects speculative/unknown): ${hash}`);
  }

  const ledger = loadDirectiveDeliveryLedger(repoRoot, scope);

  // DROPPED-NOTIFICATION TOLERANCE: if the directive's lease is already satisfied
  // in leases.jsonl, the next store tick clears delivery EVEN IF the satisfy /
  // delivery notification was dropped (markDirectiveActed never called). The
  // persisted satisfy IS the acting evidence; mark the ledger acted (idempotent)
  // and emit NO new notification — no double-exec, no stall from re-delivery.
  if (directive.satisfied) {
    if (ledger.has(hash)) {
      const acted = markDirectiveActed(ledger, hash);
      if (acted) {
        appendDirectiveDeliveryRecord(repoRoot, scope, {
          schema: WORKLIST_DIRECTIVE_DELIVERY_ACTED_SCHEMA,
          kind: "directive_acted",
          directiveHash: hash,
          scope,
          cause: "satisfied_lease",
          at: new Date(nowMs).toISOString(),
          bodyStored: false,
          localOnly: true,
          networkEnabled: false,
        });
      }
    }
    const plan: DirectiveDeliveryPlan = { deliver: false, reason: DIRECTIVE_DELIVERY_REASON_DIRECTIVE_SATISFIED, suppressed: true, resendAfterMs: 0, hash };
    return deliveryResult(scope, hash, plan, directive, null, true);
  }

  const plan = planDirectiveDelivery({ hash, ledger, nowMs, resendIntervalMs });
  let notification: DirectiveReadyNotification | null = null;
  if (plan.deliver) {
    recordDirectiveDelivery(ledger, hash, nowMs);
    notification = buildDirectiveReadyNotification(scope, directive, ledger.get(hash), plan.reason, nowMs);
    // body-free hard assertion (defensive; the notification must never carry a
    // forbidden plaintext key).
    const violations = worklistBodyFreeViolations(notification);
    if (violations.length > 0) throw new Error(`directive notification contains forbidden plaintext keys: ${violations.join(", ")}`);
    appendDirectiveDeliveryRecord(repoRoot, scope, notification);
  }
  return deliveryResult(scope, hash, plan, directive, notification, false);
}

// Deliver directives for every open directive in a scope (convenience for a watch
// tick). Each hash is planned independently through deliverDirectiveNotification,
// so the ledger dedups across the batch (reloaded per hash from the append-only
// log). Satisfied directives return cleared; open directives are planned.
export function deliverDirectives(repoRoot: string, scope: string, options: DeliverDirectiveNotificationOptions = {}): DirectiveDeliveryResult[] {
  validateScope(scope);
  const nowMs = options.nowMs ?? Date.now();
  const directives = listWorklistDirectives(repoRoot, scope, nowMs);
  const results: DirectiveDeliveryResult[] = [];
  for (const directive of directives) {
    results.push(deliverDirectiveNotification(repoRoot, scope, directive.hash, { ...options, nowMs }));
  }
  return results;
}

// Receiver-side: mark a delivered directive hash as acted on disk (append an acted
// marker). Returns false if the hash was never delivered or was already acted
// (mirrors the pure markDirectiveActed semantics). cause defaults to receiver_ack.
export function markDirectiveDeliveredActed(repoRoot: string, scope: string, hash: string, nowMs: number = Date.now()): boolean {
  validateScope(scope);
  if (!hash || !SHA256_HEX.test(hash)) throw new Error(`directive_hash must be sha256 hex: ${hash}`);
  const ledger = loadDirectiveDeliveryLedger(repoRoot, scope);
  const acted = markDirectiveActed(ledger, hash);
  if (acted) {
    appendDirectiveDeliveryRecord(repoRoot, scope, {
      schema: WORKLIST_DIRECTIVE_DELIVERY_ACTED_SCHEMA,
      kind: "directive_acted",
      directiveHash: hash,
      scope,
      cause: "receiver_ack",
      at: new Date(nowMs).toISOString(),
      bodyStored: false,
      localOnly: true,
      networkEnabled: false,
    });
  }
  return acted;
}

// Read the raw append-only delivery log (directive_ready + directive_acted lines).
export function listDeliveries(repoRoot: string, scope: string): Array<Record<string, unknown>> {
  validateScope(scope);
  return readJsonl(deliveriesPath(repoRoot, scope));
}
