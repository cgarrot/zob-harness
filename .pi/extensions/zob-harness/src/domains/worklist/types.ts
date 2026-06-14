// ZOB Harness — Worklist blackboard domain (WS-H1 keystone).
//
// A metadata-only, body-free, network-disabled blackboard store + a single
// canonical Directive type + contentHash, extracted from the proven
// project-transposer handoff-state.mjs worklist (directiveHash / buildDirective
// SHAPE) and adapted to the harness record convention (camelCase fields,
// bodyStored/promptBodiesStored/outputBodiesStored = false, localOnly = true,
// networkEnabled = false on every persisted record).
//
// Purity contract: this module imports ONLY from src/core/**. It never imports
// runtime or @earendil-works/pi-coding-agent types so projections (transposer,
// pacman, ...) can reuse the domain without pulling the harness runtime.

import { sha256 } from "../../core/utils/hashing.js";

// WS-EH1: the typed evidence pillar lives in ./evidence-contract.js. This is a
// TYPE-ONLY import (erased at runtime) so there is no runtime cycle — the runtime
// dependency is one-directional: evidence-contract.ts -> types.ts (for
// FORBIDDEN_PLAINTEXT_KEYS). WorklistDeps.evidence is now the typed EvidenceInput
// (was opaque Record<string, unknown>); WorklistDeps.evidenceContract lets a
// reducer consult the registered contract; Directive.evidenceKind is the projected
// canonical verdict annotation (NOT identity, so it is never part of directiveHash).
import type { EvidenceContract, EvidenceInput, EvidenceKind } from "./evidence-contract.js";

export const WORKLIST_EVENT_SCHEMA = "zob.worklist-event.v1";
export const WORKLIST_DIRECTIVE_SCHEMA = "zob.worklist-directive.v1";
export const WORKLIST_LEASE_SCHEMA = "zob.worklist-lease.v1";
export const WORKLIST_PROJECTION_SCHEMA = "zob.worklist-projection.v1";

// Metadata-only posture: raw prose/content fields are forbidden in ANY persisted
// worklist record. Mirrors goal-room.ts FORBIDDEN_PLAINTEXT_KEYS (exact key match;
// compound keys like bodyStored/outputBodiesStored are NOT matched).
export const FORBIDDEN_PLAINTEXT_KEYS = new Set([
  "body",
  "task",
  "prompt",
  "output",
  "content",
  "message",
  "text",
  "rationale",
  "diff",
  "patch",
]);

export const SHA256_HEX = /^[a-f0-9]{64}$/i;

// sha256 over canonicalized { action, owner, evidence_refs, deadline }. Mirrors
// project-transposer directiveHash() EXACTLY: the object literal fixes key order,
// refs are sorted + stringified. This is the single content-addressed idempotency
// key for claim/satisfy/delivery — same directive content => same hash, so a
// re-deliver or double-satisfy is a tolerated no-op, never a double action.
export function directiveHash(
  action: string,
  owner: string,
  evidenceRefs: readonly string[],
  deadline: string | null,
): string {
  const refs = [...(Array.isArray(evidenceRefs) ? evidenceRefs : [])].map((value) => String(value)).sort();
  const canon = JSON.stringify({
    action: String(action ?? ""),
    owner: String(owner ?? ""),
    evidence_refs: refs,
    deadline: deadline ?? null,
  });
  return sha256(canon);
}

// --- Append-only blackboard event --------------------------------------------
// One event per logical worklist mutation. The reducer_id selects which
// WorklistReducer projection derives directives from the event stream; it must be
// homogeneous within a scope. Raw bodies/prompts/diffs are never stored.
export interface WorklistEventInput {
  scope: string;
  /** Registered WorklistReducer id. Defaults to "generic". Must be homogeneous per scope. */
  reducer_id?: string;
  /** Reducer-defined event kind (the generic reducer understands OPEN / CLOSE / NOTE). */
  kind: string;
  /** Optional safe repo-relative correlation ref (e.g. a task-id pointer). No bodies. */
  ref?: string | null;
  /** Optional owner role id for the work item. */
  owner?: string | null;
  /** Optional safe repo-relative reason pointer. Raw rationale is not stored. */
  reason_ref?: string | null;
  /** Optional safe repo-relative unblock pointer. */
  unblock_path?: string | null;
  /** Optional safe repo-relative evidence refs. No bodies, no secrets. */
  evidence_refs?: string[];
  /** Optional ISO-8601 deadline for the work item. */
  deadline?: string | null;
}

export interface WorklistEvent {
  schema: typeof WORKLIST_EVENT_SCHEMA;
  eventId: string;
  scope: string;
  reducerId: string;
  kind: string;
  ref: string | null;
  owner: string | null;
  reasonRef: string | null;
  unblockPath: string | null;
  evidenceRefs: string[];
  deadline: string | null;
  seq: number;
  at: string;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  localOnly: true;
  networkEnabled: false;
}

// --- Derived directive (DECISION INPUT) --------------------------------------
// Mirrors the transposer Directive SHAPE { schema, action, ref/owner, reason_ref,
// unblock_path, evidence_required[], evidence_present, deadline, hash } using
// harness camelCase fields. `hash` is the contentHash above (stable across
// re-derivation for unchanged input) so claim/satisfy/delivery are idempotent.
export interface Directive {
  schema: typeof WORKLIST_DIRECTIVE_SCHEMA;
  action: string;
  ref: string | null;
  owner: string;
  reasonRef: string | null;
  unblockPath: string | null;
  evidenceRequired: string[];
  evidencePresent: boolean;
  // WS-EH1/WS-EH2: the projected canonical evidence verdict (the second pillar's
  // `kind`). This is an ANNOTATION, NOT identity: it is deliberately excluded from
  // directiveHash (which stays over {action, owner, evidence_refs(sorted), deadline})
  // so the content-addressed idempotency WS-H1/WS-H2 delivery relies on is unchanged.
  // WS-EH2 fills it from deps.evidenceContract.evaluateEvidence(...); EH1 just adds
  // the optional field so the type exists.
  evidenceKind?: EvidenceKind | null;
  deadline: string | null;
  hash: string;
}

// Optional evidence/dependency map a reducer may consult. The generic reducer
// ignores it; richer FSM reducers (transposer/pacman) read per-ref evidence here.
// WS-EH1: `evidence` is now the typed EvidenceInput (was opaque
// Record<string, unknown>). Its gates/deps are optional and default to [] so the
// store's existing `evidence: {}` passes (store.ts:222,417) still compile unchanged
// in EH1 (WS-EH2 threads real EvidenceInput). `evidenceContract` lets a reducer
// resolve the project's registered contract (resolveEvidenceContract) to compute a
// canonical verdict; absent it, the reducer works with no contract (backward
// compatible) and evidencePresent stays false.
export interface WorklistDeps {
  readonly evidence?: EvidenceInput;
  readonly evidenceContract?: EvidenceContract;
}

// --- Claim/satisfy lease (mirrors queue-daemon lease/heartbeat/recovery) ------
export type WorklistLeaseStatus = "claimed" | "satisfied" | "expired";

export interface WorklistLease {
  schema: typeof WORKLIST_LEASE_SCHEMA;
  leaseId: string;
  scope: string;
  directiveHash: string;
  claimant: string;
  status: WorklistLeaseStatus;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  leaseMs: number;
  satisfiedAt: string | null;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  localOnly: true;
  networkEnabled: false;
}

// A directive annotated with its projected lease state (what consumers read to
// know what is open / claimed / satisfied). Pure projection; never persisted as a
// lease — only written to the derived directives.json view.
export interface ProjectedDirective extends Directive {
  claimed: boolean;
  claimant: string | null;
  satisfied: boolean;
  leaseId: string | null;
}

export interface WorklistProjection {
  schema: typeof WORKLIST_PROJECTION_SCHEMA;
  scope: string;
  reducerId: string;
  directives: ProjectedDirective[];
  recoveredLeaseIds: string[];
  projectedAt: string;
}

export interface WorklistValidation {
  schema: "zob.worklist-validation.v1";
  scope: string;
  healthy: boolean;
  violations: string[];
  eventCount: number;
  directiveCount: number;
  leaseCount: number;
  recoveredLeaseIds: string[];
}
