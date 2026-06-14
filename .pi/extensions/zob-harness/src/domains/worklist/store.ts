// ZOB Harness — Worklist blackboard store (WS-H1 keystone).
//
// Append-only blackboard: .pi/worklist/<scope>/events.jsonl (hash-only,
// bodyStored:false) + derived directives.json projection + leases.jsonl
// (claim/satisfy lifecycle). claim/satisfy mirror the queue-daemon
// lease/heartbeat/stale-recovery SHAPE (leaseId, claimedAt, heartbeatAt,
// expiresAt, leaseMs, bodyStored:false) reimplemented here because buildQueueLease
// is not exported and queue.ts must not be modified (additive only).
//
// Purity contract: imports ONLY from src/core/** and ./types.js +
// ./reducer-contract.js + ./evidence-contract.js (pure domain siblings; no IO,
// no runtime). No runtime or Pi imports.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RULES } from "../../core/constants.js";
import { readJsonl } from "../../core/utils/json.js";
import { newRunId, pathMatches, resolveRepoPath, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import {
  FORBIDDEN_PLAINTEXT_KEYS,
  SHA256_HEX,
  WORKLIST_EVENT_SCHEMA,
  WORKLIST_LEASE_SCHEMA,
  WORKLIST_PROJECTION_SCHEMA,
  directiveHash,
  type ProjectedDirective,
  type WorklistDeps,
  type WorklistEvent,
  type WorklistEventInput,
  type WorklistLease,
  type WorklistProjection,
  type WorklistValidation,
} from "./types.js";
import { GENERIC_WORKLIST_REDUCER_ID, resolveWorklistReducer } from "./reducer-contract.js";
// WS-EH2: thread real EvidenceInput + the scope's registered EvidenceContract
// (resolved by reducer_id) into WorklistDeps so reducers can derive
// Directive.evidenceKind from evaluateEvidence. normalizeEvidenceInput +
// evidenceBodyFreeViolations gate the supplied evidence (throw on forbidden keys).
import {
  evidenceBodyFreeViolations,
  normalizeEvidenceInput,
  resolveEvidenceContract,
  type EvidenceContract,
  type EvidenceInput,
} from "./evidence-contract.js";

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

function worklistScopeDir(repoRoot: string, scope: string): string {
  return join(repoRoot, ".pi", "worklist", scope);
}
function eventsPath(repoRoot: string, scope: string): string {
  return join(worklistScopeDir(repoRoot, scope), "events.jsonl");
}
function leasesPath(repoRoot: string, scope: string): string {
  return join(worklistScopeDir(repoRoot, scope), "leases.jsonl");
}
function directivesPath(repoRoot: string, scope: string): string {
  return join(worklistScopeDir(repoRoot, scope), "directives.json");
}

function validateScope(scope: string): string[] {
  const errors: string[] = [];
  if (typeof scope !== "string" || scope.trim().length === 0) errors.push("scope must be non-empty");
  else if (safeFileStem(scope) !== scope) errors.push(`scope must be path-safe: ${scope}`);
  return errors;
}

function validateRef(repoRoot: string, ref: string, label: string): string[] {
  const errors: string[] = [];
  if (typeof ref !== "string" || ref.trim().length === 0) return [`${label} contains an empty ref`];
  if (ref.includes("\0")) errors.push(`${label} contains NUL byte`);
  for (const error of resolveRepoPath(repoRoot, ref).errors) errors.push(`${label}: ${error}`);
  for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
    if (pathMatches(ref, protectedPattern, repoRoot, repoRoot)) errors.push(`${label} references zero-access path: ${protectedPattern}`);
  }
  return errors;
}

export function worklistBodyFreeViolations(value: unknown): string[] {
  const violations: string[] = [];
  const visit = (item: unknown, path: string): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) visit(item[index], `${path}[${index}]`);
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_PLAINTEXT_KEYS.has(key)) violations.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "root");
  return violations;
}

export function isWorklistEvent(value: unknown): value is WorklistEvent {
  return (
    isRecord(value) &&
    value.schema === WORKLIST_EVENT_SCHEMA &&
    typeof value.eventId === "string" &&
    typeof value.scope === "string" &&
    typeof value.reducerId === "string" &&
    value.bodyStored === false &&
    value.localOnly === true &&
    value.networkEnabled === false
  );
}

export function isWorklistLease(value: unknown): value is WorklistLease {
  return (
    isRecord(value) &&
    value.schema === WORKLIST_LEASE_SCHEMA &&
    typeof value.leaseId === "string" &&
    typeof value.directiveHash === "string" &&
    SHA256_HEX.test(value.directiveHash) &&
    value.bodyStored === false
  );
}

function readEvents(repoRoot: string, scope: string): WorklistEvent[] {
  return readJsonl(eventsPath(repoRoot, scope))
    .filter(isWorklistEvent)
    .map((record) => record as unknown as WorklistEvent);
}

function readLeases(repoRoot: string, scope: string): WorklistLease[] {
  return readJsonl(leasesPath(repoRoot, scope))
    .filter(isWorklistLease)
    .map((record) => record as unknown as WorklistLease);
}

function appendLease(repoRoot: string, scope: string, lease: WorklistLease): void {
  mkdirSync(worklistScopeDir(repoRoot, scope), { recursive: true });
  appendFileSync(leasesPath(repoRoot, scope), `${JSON.stringify(lease)}\n`, "utf8");
}

// Current lease snapshot for a directive hash = the last-appended snapshot with
// that hash (later snapshots are state transitions for the same leaseId, or a
// fresh claim after recovery). Pure over the lease stream.
function currentLeaseForHash(leases: WorklistLease[], hash: string): WorklistLease | undefined {
  let current: WorklistLease | undefined;
  for (const lease of leases) if (lease.directiveHash === hash) current = lease;
  return current;
}

function leaseActive(lease: WorklistLease | undefined, now: number): boolean {
  return Boolean(lease && lease.status === "claimed" && Date.parse(lease.expiresAt) > now);
}

// --- Public store operations -------------------------------------------------

export function appendWorklistEvent(repoRoot: string, scope: string, input: WorklistEventInput): WorklistEvent {
  const errors: string[] = [];
  errors.push(...validateScope(scope));
  if (errors.length > 0) throw new Error(errors.join("; "));

  const reducerId = (input.reducer_id ?? GENERIC_WORKLIST_REDUCER_ID).trim();
  // Resolve the reducer (throws if unknown). This is the injectable project
  // validator gate keyed by reducer_id.
  const reducer = resolveWorklistReducer(reducerId);

  const kind = String(input.kind ?? "").trim();
  if (!kind) errors.push("worklist event kind must be non-empty");

  if (input.ref !== undefined && input.ref !== null) errors.push(...validateRef(repoRoot, String(input.ref), "ref"));
  if (input.reason_ref !== undefined && input.reason_ref !== null) errors.push(...validateRef(repoRoot, String(input.reason_ref), "reason_ref"));
  if (input.unblock_path !== undefined && input.unblock_path !== null) errors.push(...validateRef(repoRoot, String(input.unblock_path), "unblock_path"));
  if (Array.isArray(input.evidence_refs)) {
    for (const ref of input.evidence_refs) errors.push(...validateRef(repoRoot, String(ref), "evidence_refs"));
  }
  const evidenceRefs = Array.isArray(input.evidence_refs) ? [...new Set(input.evidence_refs.map((ref) => String(ref)))].sort() : [];

  const deadline = input.deadline ?? null;
  if (deadline !== null && !Number.isFinite(Date.parse(deadline))) errors.push(`worklist event deadline is not ISO-8601: ${deadline}`);

  const bodyViolations = worklistBodyFreeViolations(input);
  if (bodyViolations.length > 0) errors.push(`worklist event contains forbidden plaintext keys: ${bodyViolations.join(", ")}`);

  const prior = readEvents(repoRoot, scope);
  for (const event of prior) {
    if (event.reducerId !== reducerId) errors.push(`worklist scope '${scope}' reducer_id mismatch: prior '${event.reducerId}' vs new '${reducerId}'`);
  }

  const event: WorklistEvent = {
    schema: WORKLIST_EVENT_SCHEMA,
    eventId: newRunId("wlev"),
    scope,
    reducerId,
    kind,
    ref: input.ref ?? null,
    owner: input.owner ?? null,
    reasonRef: input.reason_ref ?? null,
    unblockPath: input.unblock_path ?? null,
    evidenceRefs,
    deadline,
    seq: prior.length,
    at: new Date().toISOString(),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    localOnly: true,
    networkEnabled: false,
  };

  const validateEvent = reducer.validateEvent;
  if (validateEvent) errors.push(...validateEvent(event));

  if (errors.length > 0) throw new Error(errors.join("; "));

  mkdirSync(worklistScopeDir(repoRoot, scope), { recursive: true });
  appendFileSync(eventsPath(repoRoot, scope), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function listWorklistEvents(repoRoot: string, scope: string): WorklistEvent[] {
  return readEvents(repoRoot, scope);
}

export function listWorklistLeases(repoRoot: string, scope: string): WorklistLease[] {
  return readLeases(repoRoot, scope);
}

// WS-EH2: build WorklistDeps by (a) normalizing the caller's EvidenceInput,
// (b) enforcing the body-free posture (throw on FORBIDDEN_PLAINTEXT_KEYS), and
// (c) resolving the scope's registered EvidenceContract by reducer_id (wrapped in
// try/catch — a missing contract is fine; the reducer then runs with no contract
// and Directive.evidenceKind stays null/undefined). This is the single site that
// turns a caller-supplied EvidenceInput + the project's contract into the
// WorklistDeps a reducer consults. Always returns a well-formed deps object
// (empty evidence when none supplied) so the no-evidence path stays identical to
// the historical `evidence: {}` pass.
function buildWorklistDeps(reducerId: string, evidence?: EvidenceInput): WorklistDeps {
  const normalized = normalizeEvidenceInput(evidence);
  const evViolations = evidenceBodyFreeViolations(normalized);
  if (evViolations.length > 0) {
    throw new Error(`worklist evidence contains forbidden plaintext keys: ${evViolations.join(", ")}`);
  }
  let evidenceContract: EvidenceContract | undefined;
  try {
    evidenceContract = resolveEvidenceContract(reducerId);
  } catch {
    // No contract registered under this reducer_id: that is fine. The reducer
    // runs with no contract; Directive.evidenceKind stays null/undefined and
    // evidencePresent stays false (backward compatible).
    evidenceContract = undefined;
  }
  return { evidence: normalized, evidenceContract };
}

export function projectWorklist(repoRoot: string, scope: string, now: number, evidence?: EvidenceInput): WorklistProjection {
  const scopeErrors = validateScope(scope);
  if (scopeErrors.length > 0) throw new Error(scopeErrors.join("; "));

  const events = readEvents(repoRoot, scope);
  const reducerId = events[0]?.reducerId ?? GENERIC_WORKLIST_REDUCER_ID;
  const reducer = resolveWorklistReducer(reducerId);
  const deps = buildWorklistDeps(reducerId, evidence);
  const raw = reducer.computeDirectives(events, deps, now);

  const leases = readLeases(repoRoot, scope);
  const directives: ProjectedDirective[] = raw.map((directive) => {
    const lease = currentLeaseForHash(leases, directive.hash);
    const active = leaseActive(lease, now);
    return {
      ...directive,
      claimed: active,
      claimant: active ? (lease as WorklistLease).claimant : null,
      satisfied: lease?.status === "satisfied",
      leaseId: lease?.leaseId ?? null,
    };
  });

  const projection: WorklistProjection = {
    schema: WORKLIST_PROJECTION_SCHEMA,
    scope,
    reducerId,
    directives,
    recoveredLeaseIds: leases.filter((lease) => lease.status === "expired").map((lease) => lease.leaseId),
    projectedAt: new Date(now).toISOString(),
  };

  mkdirSync(worklistScopeDir(repoRoot, scope), { recursive: true });
  writeFileSync(directivesPath(repoRoot, scope), JSON.stringify(projection, null, 2), "utf8");
  return projection;
}

export function listWorklistDirectives(repoRoot: string, scope: string, now: number, evidence?: EvidenceInput): ProjectedDirective[] {
  return projectWorklist(repoRoot, scope, now, evidence).directives;
}

export interface WorklistClaimOptions {
  leaseMs?: number;
  now?: number;
}

export function claimWorklistDirective(
  repoRoot: string,
  scope: string,
  directiveHashValue: string,
  claimant: string,
  options: WorklistClaimOptions = {},
): WorklistLease {
  const errors = validateScope(scope);
  if (errors.length > 0) throw new Error(errors.join("; "));
  if (!SHA256_HEX.test(directiveHashValue)) throw new Error(`directive_hash must be sha256 hex: ${directiveHashValue}`);
  if (!claimant || String(claimant).trim().length === 0) throw new Error("claimant must be non-empty");

  const now = options.now ?? Date.now();
  const leaseMs = Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) throw new Error("lease_ms must be positive and <= 24h");

  const projection = projectWorklist(repoRoot, scope, now);
  const directive = projection.directives.find((item) => item.hash === directiveHashValue);
  if (!directive) throw new Error(`directive not found for hash: ${directiveHashValue}`);
  if (directive.satisfied) throw new Error(`directive already satisfied: ${directiveHashValue}`);

  const leases = readLeases(repoRoot, scope);
  const current = currentLeaseForHash(leases, directiveHashValue);
  if (current && current.status === "claimed") {
    const expired = Date.parse(current.expiresAt) <= now;
    if (!expired) {
      if (current.claimant === claimant) {
        // Heartbeat refresh (mirror queue-daemon heartbeat): extend the lease.
        const refreshed: WorklistLease = {
          ...current,
          status: "claimed",
          heartbeatAt: new Date(now).toISOString(),
          expiresAt: new Date(now + leaseMs).toISOString(),
          leaseMs,
        };
        appendLease(repoRoot, scope, refreshed);
        return refreshed;
      }
      throw new Error(`directive already claimed by '${current.claimant}' (lease ${current.leaseId})`);
    }
    // Stale claimed lease: recover it, then create a fresh claim below.
    appendLease(repoRoot, scope, { ...current, status: "expired" });
  }

  const lease: WorklistLease = {
    schema: WORKLIST_LEASE_SCHEMA,
    leaseId: newRunId("wlclaim"),
    scope,
    directiveHash: directiveHashValue,
    claimant,
    status: "claimed",
    claimedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
    leaseMs,
    satisfiedAt: null,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    localOnly: true,
    networkEnabled: false,
  };
  appendLease(repoRoot, scope, lease);
  return lease;
}

export function satisfyWorklistDirective(
  repoRoot: string,
  scope: string,
  directiveHashValue: string,
  claimant: string,
  now: number = Date.now(),
): WorklistLease {
  const errors = validateScope(scope);
  if (errors.length > 0) throw new Error(errors.join("; "));
  if (!SHA256_HEX.test(directiveHashValue)) throw new Error(`directive_hash must be sha256 hex: ${directiveHashValue}`);
  if (!claimant || String(claimant).trim().length === 0) throw new Error("claimant must be non-empty");

  const leases = readLeases(repoRoot, scope);
  const current = currentLeaseForHash(leases, directiveHashValue);
  if (!current) throw new Error(`no claim for directive hash: ${directiveHashValue}`);

  // IDEMPOTENT: a directive already satisfied stays satisfied (double-satisfy = noop).
  if (current.status === "satisfied") return current;
  if (current.status === "expired") throw new Error(`lease expired; re-claim the directive: ${directiveHashValue}`);

  if (Date.parse(current.expiresAt) <= now) throw new Error(`lease expired; re-claim the directive: ${directiveHashValue}`);
  if (current.claimant !== claimant) throw new Error(`only the claimant '${current.claimant}' may satisfy directive: ${directiveHashValue}`);

  const satisfied: WorklistLease = {
    ...current,
    status: "satisfied",
    satisfiedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  appendLease(repoRoot, scope, satisfied);
  return satisfied;
}

// Recover stale claimed leases whose lease has expired, re-queuing their
// directives to open. Mirrors queue-daemon recoverStaleRunningJobs: on each store
// tick, a claimed lease past expiresAt is recovered. Returns the recovered leases.
export function recoverStaleWorklistLeases(repoRoot: string, scope: string, now: number = Date.now()): WorklistLease[] {
  const errors = validateScope(scope);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const leases = readLeases(repoRoot, scope);
  const recovered: WorklistLease[] = [];
  const seenHash = new Set<string>();
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    const lease = leases[index];
    if (seenHash.has(lease.directiveHash)) continue;
    seenHash.add(lease.directiveHash);
    if (lease.status === "claimed" && Date.parse(lease.expiresAt) <= now) {
      const expired: WorklistLease = { ...lease, status: "expired" };
      appendLease(repoRoot, scope, expired);
      recovered.push(expired);
    }
  }
  return recovered;
}

export function validateWorklist(repoRoot: string, scope: string, now: number = Date.now(), evidence?: EvidenceInput): WorklistValidation {
  const violations: string[] = [];
  for (const error of validateScope(scope)) violations.push(`scope: ${error}`);

  const events = readEvents(repoRoot, scope);
  const leases = readLeases(repoRoot, scope);

  const seenEventIds = new Set<string>();
  let expectedReducerId: string | null = null;
  let lastSeq = -1;
  for (const event of events) {
    // readEvents already filters with isWorklistEvent, so every entry here is a
    // well-formed WorklistEvent; validate asserts internal consistency only.
    if (seenEventIds.has(event.eventId)) violations.push(`duplicate eventId: ${event.eventId}`);
    seenEventIds.add(event.eventId);
    if (event.bodyStored !== false) violations.push(`event ${event.eventId} bodyStored must be false`);
    if (event.promptBodiesStored !== false) violations.push(`event ${event.eventId} promptBodiesStored must be false`);
    if (event.outputBodiesStored !== false) violations.push(`event ${event.eventId} outputBodiesStored must be false`);
    if (event.localOnly !== true) violations.push(`event ${event.eventId} localOnly must be true`);
    if (event.networkEnabled !== false) violations.push(`event ${event.eventId} networkEnabled must be false`);
    if (event.seq <= lastSeq) violations.push(`event ${event.eventId} seq regressed: ${event.seq} after ${lastSeq}`);
    lastSeq = event.seq;
    if (expectedReducerId === null) expectedReducerId = event.reducerId;
    else if (event.reducerId !== expectedReducerId)
      violations.push(`event ${event.eventId} reducer_id '${event.reducerId}' != scope reducer '${expectedReducerId}'`);
    for (const violation of worklistBodyFreeViolations(event)) violations.push(`event ${event.eventId} forbidden plaintext: ${violation}`);
    for (const ref of [event.ref, event.reasonRef, event.unblockPath, ...event.evidenceRefs]) {
      if (typeof ref === "string" && ref.length > 0) for (const error of validateRef(repoRoot, ref, `event ${event.eventId} ref`)) violations.push(error);
    }
  }

  const reducerId = expectedReducerId ?? GENERIC_WORKLIST_REDUCER_ID;
  let directiveCount = 0;
  try {
    const reducer = resolveWorklistReducer(reducerId);
    const deps = buildWorklistDeps(reducerId, evidence);
    const directives = reducer.computeDirectives(events, deps, now);
    directiveCount = directives.length;
    for (const directive of directives) {
      const recomputed = directiveHash(directive.action, directive.owner, directive.evidenceRequired, directive.deadline);
      if (recomputed !== directive.hash) violations.push(`directive hash mismatch for ${directive.hash}: recomputed ${recomputed}`);
    }
  } catch (error) {
    violations.push(`reducer error: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const lease of leases) {
    if (!isWorklistLease(lease)) {
      violations.push("invalid worklist lease record");
      continue;
    }
    if (lease.bodyStored !== false) violations.push(`lease ${lease.leaseId} bodyStored must be false`);
    if (lease.promptBodiesStored !== false) violations.push(`lease ${lease.leaseId} promptBodiesStored must be false`);
    if (lease.outputBodiesStored !== false) violations.push(`lease ${lease.leaseId} outputBodiesStored must be false`);
    if (lease.scope !== scope) violations.push(`lease ${lease.leaseId} scope '${lease.scope}' != '${scope}'`);
    for (const violation of worklistBodyFreeViolations(lease)) violations.push(`lease ${lease.leaseId} forbidden plaintext: ${violation}`);
  }

  return {
    schema: "zob.worklist-validation.v1",
    scope,
    healthy: violations.length === 0,
    violations,
    eventCount: events.length,
    directiveCount,
    leaseCount: leases.length,
    recoveredLeaseIds: leases.filter((lease) => lease.status === "expired").map((lease) => lease.leaseId),
  };
}

// --- Factory -----------------------------------------------------------------

export interface WorklistStoreOptions {
  /** Default claim lease duration. Default 5 minutes. */
  leaseMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface WorklistStore {
  readonly scope: string;
  appendEvent(input: WorklistEventInput): WorklistEvent;
  listEvents(): WorklistEvent[];
  listLeases(): WorklistLease[];
  project(now?: number): WorklistProjection;
  listDirectives(now?: number): ProjectedDirective[];
  claim(directiveHashValue: string, claimant: string, options?: WorklistClaimOptions): WorklistLease;
  satisfy(directiveHashValue: string, claimant: string, now?: number): WorklistLease;
  recoverStaleLeases(now?: number): WorklistLease[];
  validate(now?: number): WorklistValidation;
}

export function openWorklistStore(repoRoot: string, scope: string, options: WorklistStoreOptions = {}): WorklistStore {
  const scopeErrors = validateScope(scope);
  if (scopeErrors.length > 0) throw new Error(scopeErrors.join("; "));
  const defaultNow = options.now ?? (() => Date.now());
  const defaultLeaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  return {
    scope,
    appendEvent: (input) => appendWorklistEvent(repoRoot, scope, input),
    listEvents: () => listWorklistEvents(repoRoot, scope),
    listLeases: () => listWorklistLeases(repoRoot, scope),
    project: (now) => projectWorklist(repoRoot, scope, now ?? defaultNow()),
    listDirectives: (now) => listWorklistDirectives(repoRoot, scope, now ?? defaultNow()),
    claim: (directiveHashValue, claimant, claimOptions) =>
      claimWorklistDirective(repoRoot, scope, directiveHashValue, claimant, {
        leaseMs: claimOptions?.leaseMs ?? defaultLeaseMs,
        now: claimOptions?.now ?? defaultNow(),
      }),
    satisfy: (directiveHashValue, claimant, now) => satisfyWorklistDirective(repoRoot, scope, directiveHashValue, claimant, now ?? defaultNow()),
    recoverStaleLeases: (now) => recoverStaleWorklistLeases(repoRoot, scope, now ?? defaultNow()),
    validate: (now) => validateWorklist(repoRoot, scope, now ?? defaultNow()),
  };
}
