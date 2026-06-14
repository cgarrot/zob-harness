// ZOB Harness — Worklist EvidenceContract (WS-EH1 keystone, canonical-evidence-model PART II).
//
// This is the SECOND PILLAR promoted into the harness: a typed evidence contract
// that replaces the opaque `WorklistDeps.evidence: Record<string, unknown>`. Every
// multi-agent consumer (transposer today, pacman next) gets path-independent
// evidence satisfaction for free by registering one `EvidenceContract` under its
// `reducer_id`, exactly the way `computeWorklist` was promoted via the
// `WorklistReducer` registry.
//
// Faithful to the PROVEN project-transposer `evaluateEvidence` body
// (scripts/lib/handoff-state.mjs:693): its app-specific evidence object
// `{ oraclePass, oracleNoShip, missingArtifactRefs, butterflySatisfiable,
// gateNowPass, gateRef, depInvalidated, depInvalidatedRef }` is GENERALIZED here
// into a generic `EvidenceInput { gates: GateEntry[]; deps: DepEntry[] }`. The
// transposer's raw object is its INTERNAL body, adapted when it registers as a
// harness contract in WS-EH4 (separate, deferred slice). EH1 ships ONLY the generic
// typed CONTRACT + registry + shapes — not the transposer FSM body.
//
// The canonical `kind` set is taken verbatim from the proven reference:
//   'accept' | 'reject' | 'await' | 'reassign' | 'rollback' | 'noop'
// with the proven semantics (claimed_complete+oraclePASS+refs+butterfly->accept;
// claimed_complete+missing->reject(awaitedKinds=[accept]); rejected+gateNowPass+ref
// ->reassign; accepted+depInvalidated+ref->rollback; else noop). The BODY that
// implements those semantics stays app-side; the harness provides the SHAPE + the
// registry + the property-test harness.
//
// Purity contract: imports ONLY from src/core/** and ./types.js. No IO; no runtime;
// no @earendil-works/pi-coding-agent types. Metadata-only / body-free /
// network-disabled: EvidenceInput/GateEntry/DepEntry/EvidenceVerdict carry refs +
// verdict + noShip only; FORBIDDEN_PLAINTEXT_KEYS is enforced on every value that
// enters the contract.

import { FORBIDDEN_PLAINTEXT_KEYS } from "./types.js";

// --- Canonical evidence kind set ---------------------------------------------
// The path-independent verdict. Taken verbatim from the proven transposer
// evaluateEvidence kind set. This is the CANONICAL set every EvidenceContract
// implementor emits; nothing extends it.
export type EvidenceKind = "accept" | "reject" | "await" | "reassign" | "rollback" | "noop";

// --- Minimal open task view --------------------------------------------------
// The view of a task an EvidenceContract evaluates against. This is a minimal OPEN
// base: project reducers build a richer view from their own events (the transposer
// builds { status, decision_at, reopen_gate_ref, ... }; pacman builds its own FSM
// view) and pass it here. The index signature lets the transposer pass its task
// object unchanged, but NO FORBIDDEN_PLAINTEXT_KEYS are allowed (the body-free scan
// rejects them). EH1 does not constrain the shape beyond this open base so the
// contract is genuinely generic; richer views are reducer-private.
export interface TaskView {
  ref: string | null;
  status?: string;
  claimedAt?: string | null;
  decidedAt?: string | null;
  reopenGateRef?: string | null;
  [key: string]: unknown;
}

// --- Evidence entry shapes ---------------------------------------------------
// A gate evidence entry (the cited-or-discovered oracle gate). `verdict` +
// `noShip` are the hard-evidence signals; `discoveredVia` records whether the gate
// was content-addressed (cited in artifact_refs), conventionally discovered
// (disk-walk, e.g. **/oracle-review.json), or read from the on-log dependency
// state. This unifies citation AND conventional discovery into one shape so the
// ACCEPT/REASSIGN paths can never disagree on which gate satisfies the claim
// (the asymmetry class this pillar closes).
export interface GateEntry {
  ref: string;
  verdict: "PASS" | "FAIL" | "UNKNOWN";
  noShip: boolean;
  discoveredVia: "cited" | "convention" | "on-log";
}

// An on-log dependency entry (for ROLLBACK evidence). `status` is the dependency's
// lifecycle status (reducer-defined); `invalidated` is the hard signal that a
// downstream dependency was rejected/rolled back, which reopens an accepted epoch.
export interface DepEntry {
  ref: string;
  status: string;
  invalidated: boolean;
}

// The generic, path-independent evidence object. `gates` + `deps` are OPTIONAL and
// default to [] so `{}` (the store's existing `evidence: {}` passes at store.ts
// :222,:417) stays a valid EvidenceInput — that keeps EH1 backward compatible. The
// store will thread real EvidenceInput in WS-EH2 (separate slice).
export interface EvidenceInput {
  gates?: GateEntry[];
  deps?: DepEntry[];
}

// The canonical evidence verdict (the second pillar). `kind` is computed ONLY from
// (task, evidence) — path-independent. `satisfied` is the hard-evidence signal
// (accept/reassign/rollback). `awaitedKinds` records which evidence kinds are
// simply not-yet-arrived (e.g. ['accept'] for a not-yet-satisfied claim). `gateRef`
// / `depRef` are the refs that drove a reassign/rollback verdict (null otherwise).
export interface EvidenceVerdict {
  satisfied: boolean;
  kind: EvidenceKind;
  awaitedKinds: string[];
  gateRef: string | null;
  depRef: string | null;
}

// --- The evidence contract ---------------------------------------------------
// The contract a project registers under its reducer_id (the same keying as
// WorklistReducer). `evaluateEvidence` is the SINGLE SITE of evidence satisfaction:
// pure over (taskView, evidence); no IO. `discoverEvidence` is the optional
// app-supplied discovery routine (cited refs AND disk-walk, unified) — EH1 defines
// the signature only; it never does IO in the harness.
export interface EvidenceContract {
  readonly evidenceId: string;
  evaluateEvidence(task: TaskView, evidence: EvidenceInput): EvidenceVerdict;
  discoverEvidence?(task: TaskView): EvidenceInput | Promise<EvidenceInput>;
}

// --- Helpers -----------------------------------------------------------------

// The canonical empty EvidenceInput (gates: [], deps: []). The explicit form for
// callers that want a clean, normalized empty input.
export function emptyEvidenceInput(): EvidenceInput {
  return { gates: [], deps: [] };
}

// Defensive reader: gates/deps default to []. Used by the store (WS-EH2) to
// normalize whatever the caller passes into a well-formed EvidenceInput before it
// enters the contract. Tolerates undefined/null/missing arrays.
export function normalizeEvidenceInput(value: unknown): EvidenceInput {
  if (!value || typeof value !== "object") return { gates: [], deps: [] };
  const record = value as { gates?: unknown; deps?: unknown };
  const gates = Array.isArray(record.gates) ? record.gates.slice() : [];
  const deps = Array.isArray(record.deps) ? record.deps.slice() : [];
  return { gates, deps };
}

// Is a gate verdict string a valid canonical verdict? ('PASS'|'FAIL'|'UNKNOWN').
export function gateVerdictIsValid(verdict: unknown): verdict is GateEntry["verdict"] {
  return verdict === "PASS" || verdict === "FAIL" || verdict === "UNKNOWN";
}

// --- Body-free enforcement ---------------------------------------------------
// Mirrors worklistBodyFreeViolations (store.ts): recursively scan an EvidenceInput
// (and its GateEntry/DepEntry children) or an EvidenceVerdict and report any
// FORBIDDEN_PLAINTEXT_KEYS found (body/task/prompt/output/content/message/text/
// rationale/diff/patch). The store will call this in WS-EH2 before it threads an
// EvidenceInput into a contract; EH1 exposes it now so the contract is body-free
// from the first use. Returns [] for a clean value.
export function evidenceBodyFreeViolations(value: unknown): string[] {
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

// --- Evidence contract registry ----------------------------------------------
// Mirrors the WorklistReducer registry (reducer-contract.ts
// registerWorklistReducer/resolveWorklistReducer/listWorklistReducerIds) EXACTLY:
// keyed by evidenceId (projects register under their reducer_id; the transposer
// will register evidenceId='project-transposer' in WS-EH4). A missing contract is
// a TYPED ERROR, not a silent {} — that is the headline acceptance of WS-EH1.

const EVIDENCE_CONTRACTS = new Map<string, EvidenceContract>();

export function registerEvidenceContract(contract: EvidenceContract): void {
  if (!contract || !contract.evidenceId) throw new Error("EvidenceContract.evidenceId is required");
  if (typeof contract.evaluateEvidence !== "function")
    throw new Error(`EvidenceContract '${contract.evidenceId}' is missing evaluateEvidence(task, evidence)`);
  EVIDENCE_CONTRACTS.set(contract.evidenceId, contract);
}

export function resolveEvidenceContract(evidenceId: string): EvidenceContract {
  const contract = EVIDENCE_CONTRACTS.get(evidenceId);
  if (!contract) throw new Error(`Unknown evidence contract id: ${evidenceId}`);
  return contract;
}

export function listEvidenceContractIds(): string[] {
  return [...EVIDENCE_CONTRACTS.keys()];
}
