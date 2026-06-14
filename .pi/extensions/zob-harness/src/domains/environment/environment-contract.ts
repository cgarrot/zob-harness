// ZOB Harness — Environment precondition contract + registry (WS-PH1 keystone,
// environment-precondition PART II).
//
// The FOURTH PILLAR alongside computeWorklist (Round 2) and EvidenceContract
// (Round 3): a typed EnvironmentContract that every multi-agent consumer registers
// under its reducer_id, mirroring registerEvidenceContract's Map registry EXACTLY.
// The harness ships the SHAPE (the contract interface + the pure primitives) + the
// registry; the BODY (evaluatePrecondition dispatch + snapshotEnvironment IO) is
// project-registered (WS-PH4 migration; EH1-style shape-only, deferred body).
//
// Purity contract: imports ONLY from src/core/** + siblings (./types.js +
// ../worklist/types.js for FORBIDDEN_PLAINTEXT_KEYS). No IO; no runtime; no
// @earendil-works/pi-coding-agent types. Metadata-only / body-free /
// network-disabled: EnvironmentContract consumers carry paths, counts, channel
// names, command strings only; FORBIDDEN_PLAINTEXT_KEYS is enforced on every value
// that enters the contract via environmentBodyFreeViolations.
import { FORBIDDEN_PLAINTEXT_KEYS } from "../worklist/types.js";
import type {
  CheckPhase,
  EnvironmentSnapshot,
  Precondition,
  PreconditionVerdict,
} from "./types.js";

// --- The environment contract ------------------------------------------------
// Project-registered under its reducer_id (the same keying as EvidenceContract).
// `evaluatePrecondition` is the SINGLE SITE of precondition satisfaction: pure over
// (precondition, snapshot); no IO. `snapshotEnvironment` is the ONLY IO entry
// point — the project supplies it (readdir / rustup / which live there); EH1
// defines the signature only and never does IO in the harness. `preconditions`
// returns the project's precondition set tagged by phase.
export interface EnvironmentContract {
  /** Canonical verdict, pure over (precondition, snapshot). */
  evaluatePrecondition(p: Precondition, env: EnvironmentSnapshot): PreconditionVerdict;
  /** Project-supplied snapshot reader (the ONLY IO). */
  snapshotEnvironment(scope?: PreconditionScope): Promise<EnvironmentSnapshot> | EnvironmentSnapshot;
  /** Project-supplied precondition set, tagged by check_phase. */
  preconditions(checkPhase: CheckPhase): readonly Precondition[];
}

/** Scope for snapshotEnvironment (which root to read). */
export interface PreconditionScope {
  readonly root?: string;
}

// --- Body-free enforcement ---------------------------------------------------
// Mirrors evidenceBodyFreeViolations / worklistBodyFreeViolations: recursively scan
// a Precondition / PreconditionVerdict / EnvironmentSnapshot-derived value and
// report any FORBIDDEN_PLAINTEXT_KEYS found (body/task/prompt/output/content/
// message/text/rationale/diff/patch). Returns [] for a clean value. The launch
// gate (WS-PH2) will call this before threading a precondition set into the
// contract; PH1 exposes it now so the contract is body-free from the first use.
export function environmentBodyFreeViolations(value: unknown): string[] {
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

// --- Environment contract registry ------------------------------------------
// Mirrors the EvidenceContract registry (evidence-contract.ts
// registerEvidenceContract / resolveEvidenceContract / listEvidenceContractIds)
// and the WorklistReducer registry: keyed by reducerId (projects register under
// their reducer_id; the transposer will register reducerId='project-transposer' in
// WS-PH4). A MISSING contract resolves to `undefined` — a typed-missing signal,
// NOT a silent default — so the caller can fail-closed explicitly. (Deliberate,
// plan-specified divergence from resolveEvidenceContract's throw: the WS-PH1 plan
// signature is `EnvironmentContract | undefined`; the launch gate WS-PH2 will turn
// undefined into an explicit fail-closed verdict.)
const ENVIRONMENT_CONTRACTS = new Map<string, EnvironmentContract>();

export function registerEnvironmentContract(
  reducerId: string,
  contract: EnvironmentContract,
): void {
  if (!reducerId) throw new Error("registerEnvironmentContract: reducerId is required");
  if (!contract || typeof contract !== "object")
    throw new Error(`registerEnvironmentContract('${reducerId}'): contract is required`);
  if (typeof contract.evaluatePrecondition !== "function")
    throw new Error(`EnvironmentContract '${reducerId}' is missing evaluatePrecondition(p, env)`);
  if (typeof contract.snapshotEnvironment !== "function")
    throw new Error(`EnvironmentContract '${reducerId}' is missing snapshotEnvironment(scope?)`);
  if (typeof contract.preconditions !== "function")
    throw new Error(`EnvironmentContract '${reducerId}' is missing preconditions(checkPhase)`);
  ENVIRONMENT_CONTRACTS.set(reducerId, contract);
}

export function resolveEnvironmentContract(reducerId: string): EnvironmentContract | undefined {
  return ENVIRONMENT_CONTRACTS.get(reducerId);
}

export function listEnvironmentContractIds(): string[] {
  return [...ENVIRONMENT_CONTRACTS.keys()];
}
