// ZOB Harness — WorklistReducer contract + generic reducer.
//
// The CONTRACT a projection implements: { computeDirectives(events, deps, now) }.
// Project transposer/pacman plug their own FSM body here; the harness ALSO ships a
// built-in GENERIC reducer so a second consumer works with zero FSM code. The
// reducer is keyed by reducer_id and resolved by the store, so an optional
// validateEvent hook is the "injectable project validator keyed by reducer_id"
// that gates append.
//
// Purity contract: imports ONLY from src/core/** and ./types.js +
// ./evidence-contract.js (a pure domain sibling; no IO, no runtime).

import { directiveHash, WORKLIST_DIRECTIVE_SCHEMA, type Directive, type WorklistDeps, type WorklistEvent } from "./types.js";
// WS-EH2: the evidence pillar (./evidence-contract.js) is a pure domain sibling
// (it imports only ./types.js; no IO). The reducer consults it to derive the
// projected Directive.evidenceKind annotation via evaluateEvidenceForDirective.
import { emptyEvidenceInput, type EvidenceContract, type EvidenceInput, type EvidenceKind, type TaskView } from "./evidence-contract.js";

// The harness-wide contract every worklist projection implements. computeDirectives
// is the required member (pure over events + deps + now; no IO); reducerId selects
// the reducer from the registry; validateEvent is the optional append-time project
// validator (returns violation strings; empty = ok).
export interface WorklistReducer {
  readonly reducerId: string;
  computeDirectives(events: WorklistEvent[], deps: WorklistDeps, now: number): Directive[];
  validateEvent?(event: WorklistEvent): string[];
}

export interface BuildDirectiveInput {
  action: string;
  ref?: string | null;
  owner: string;
  reasonRef?: string | null;
  unblockPath?: string | null;
  evidenceRequired?: string[];
  evidencePresent?: boolean;
  deadline?: string | null;
}

// Build one canonical Directive, deriving its contentHash from
// { action, owner, evidenceRequired, deadline }. Mirrors transposer buildDirective.
export function buildDirective(input: BuildDirectiveInput): Directive {
  const evidenceRequired = Array.isArray(input.evidenceRequired) ? [...input.evidenceRequired] : [];
  return {
    schema: WORKLIST_DIRECTIVE_SCHEMA,
    action: String(input.action ?? ""),
    ref: input.ref ?? null,
    owner: String(input.owner ?? ""),
    reasonRef: input.reasonRef ?? null,
    unblockPath: input.unblockPath ?? null,
    evidenceRequired,
    evidencePresent: input.evidencePresent === true,
    deadline: input.deadline ?? null,
    hash: directiveHash(input.action, input.owner, evidenceRequired, input.deadline ?? null),
  };
}

// --- Evidence-aware directive helper (WS-EH2) --------------------------------
// A clean, optional way for a reducer to consult the registered EvidenceContract
// and derive the projected { evidenceKind, evidencePresent } annotation for a
// Directive. Returns null when no contract is supplied so the caller keeps its
// current behavior (evidenceKind null/undefined, evidencePresent false). When a
// contract is supplied, it calls evaluateEvidence(taskView, evidence) and maps
// verdict.kind -> evidenceKind + verdict.satisfied -> evidencePresent.
//
// This is the single helper a project reducer calls inside computeDirectives to
// layer the canonical evidence verdict onto its directives; the generic reducer
// also uses it when deps.evidenceContract is present AND deps.evidence is
// non-empty (backward compatible). The helper never throws: a missing contract
// is a typed null so the reducer decides whether to annotate. evidenceKind is a
// PROJECTED ANNOTATION — it never enters directiveHash (the content-addressed
// idempotency WS-H1/WS-H2 delivery relies on stays unchanged).
export function evaluateEvidenceForDirective(
  evidenceContract: EvidenceContract | undefined,
  taskView: TaskView,
  evidence: EvidenceInput | undefined,
): { evidenceKind: EvidenceKind; evidencePresent: boolean } | null {
  if (!evidenceContract) return null;
  const verdict = evidenceContract.evaluateEvidence(taskView, evidence ?? emptyEvidenceInput());
  return { evidenceKind: verdict.kind, evidencePresent: verdict.satisfied === true };
}

// --- Reducer registry --------------------------------------------------------

const REDUCERS = new Map<string, WorklistReducer>();

export function registerWorklistReducer(reducer: WorklistReducer): void {
  if (!reducer || !reducer.reducerId) throw new Error("WorklistReducer.reducerId is required");
  REDUCERS.set(reducer.reducerId, reducer);
}

export function resolveWorklistReducer(reducerId: string): WorklistReducer {
  const reducer = REDUCERS.get(reducerId);
  if (!reducer) throw new Error(`Unknown worklist reducer_id: ${reducerId}`);
  return reducer;
}

export function listWorklistReducerIds(): string[] {
  return [...REDUCERS.keys()];
}

// --- Built-in generic reducer -------------------------------------------------
//
// Minimal generic projection: one Directive per OPEN work item (the latest OPEN
// for a ref with no later CLOSE) that is DUE — deadline is null (immediately
// actionable) or in the past (overdue). Real consumers register their own FSM
// reducer under a project-specific reducer_id; this one exists so a second
// consumer works with zero FSM code. OPEN/CLOSE/NOTE kinds are case-insensitive;
// any other kind is informational and not projected.
export const GENERIC_WORKLIST_REDUCER_ID = "generic";

export const genericWorklistReducer: WorklistReducer = {
  reducerId: GENERIC_WORKLIST_REDUCER_ID,
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
      // WS-EH2: when an EvidenceContract is present AND non-empty evidence is
      // supplied, consult it to derive the projected { evidenceKind,
      // evidencePresent } annotation for this directive. Without a contract (the
      // default) the generic reducer cannot evaluate evidence — evidenceKind stays
      // null/undefined and evidencePresent stays false (backward compatible). Only
      // a non-empty EvidenceInput triggers consultation so an empty/`{}` evidence
      // pass keeps the historical behavior exactly.
      const contract = deps.evidenceContract;
      const evidence = deps.evidence;
      const hasEvidence =
        Boolean(evidence) &&
        ((evidence?.gates?.length ?? 0) > 0 || (evidence?.deps?.length ?? 0) > 0);
      if (contract && hasEvidence) {
        const taskView: TaskView = { ref: event.ref ?? null, status: "OPEN" };
        const annotation = evaluateEvidenceForDirective(contract, taskView, evidence);
        if (annotation) {
          directive.evidenceKind = annotation.evidenceKind;
          directive.evidencePresent = annotation.evidencePresent;
        }
      }
      directives.push(directive);
    }
    // Dedupe by contentHash (same directive content => one directive) then sort
    // deterministically by deadline then ref, mirroring transposer computeWorklist.
    const seen = new Set<string>();
    const deduped = directives.filter((directive) => {
      if (seen.has(directive.hash)) return false;
      seen.add(directive.hash);
      return true;
    });
    deduped.sort(
      (a, b) =>
        String(a.deadline ?? "").localeCompare(String(b.deadline ?? "")) ||
        String(a.ref ?? "").localeCompare(String(b.ref ?? "")) ||
        String(a.hash).localeCompare(String(b.hash)),
    );
    return deduped;
  },
  validateEvent(event) {
    const errors: string[] = [];
    if (!event.kind || String(event.kind).trim().length === 0) errors.push("worklist event kind must be non-empty");
    if (event.deadline !== null && !Number.isFinite(Date.parse(event.deadline)))
      errors.push(`worklist event deadline is not ISO-8601: ${event.deadline}`);
    return errors;
  },
};

// The generic reducer is always available so append with reducer_id="generic" (the
// default) works with no extra registration.
registerWorklistReducer(genericWorklistReducer);
