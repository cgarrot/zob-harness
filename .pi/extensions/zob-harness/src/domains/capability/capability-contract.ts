// ZOB Harness — Agent capability validation contract + registry (WS-CH1 keystone,
// capability-validation PART II).
//
// The FIFTH PILLAR alongside computeWorklist (Round 2), EvidenceContract
// (Round 3), and EnvironmentContract (Round 4): a typed CapabilityContract that
// every multi-agent consumer registers under its `reducer_id`, mirroring
// registerEnvironmentContract's Map registry EXACTLY. The harness ships the SHAPE
// (the contract interface + the pure primitives) + the registry; the BODY
// (which roles need which tools) + the manifest READER (`readManifest` IO) are
// project-registered (WS-CH3, deferred). CH1-style: shape-only, deferred body.
//
// CRITICAL SAFETY DIVERGENCE from Round-4 EnvironmentContract (documented here so
// it is never accidentally re-introduced): there is NO auto-resolve method on
// this contract. Round 4's EnvironmentContract had `snapshotEnvironment` + a
// WS-PH3 `applyAutoResolve` framework (allowlisted + REVERSIBLE env fixes). A
// capability gap is NOT auto-resolvable: editing a ZAgent manifest changes an
// agent's authority (its allowedTools/defaultMode), which is a SECURITY-SENSITIVE
// operation that must stay operator-gated. This contract therefore exposes ONLY
// `evaluateCapability` (pure verdict) + `readManifest` (project-supplied IO) +
// `requirements` (project-supplied role→required-tools body). The fix packet the
// verdict surfaces is the END of what the harness does; applying the manifest edit
// is app/operator-side (WS-CH2 launch-gate will turn a failing verdict into a
// fail-closed block + a printed fix_command, never an auto-edit). This is the
// same split as Round 4's `runLaunchGate` (mechanism in harness, action in app)
// EXCEPT there is intentionally no `applyAutoResolve` sibling — the action is
// always a human edit.
//
// Purity contract: imports ONLY from src/core/** + siblings (../worklist/types.js
// for FORBIDDEN_PLAINTEXT_KEYS, ./types.js for the typed shapes — type-only,
// erased at runtime). No IO; no runtime; no @earendil-works/pi-coding-agent
// types. Metadata-only / body-free / network-disabled: CapabilityContract
// consumers carry agent ids, tool names, mode names, manifest paths, and
// fixCommand strings only; FORBIDDEN_PLAINTEXT_KEYS is enforced on every value
// that enters the contract via capabilityBodyFreeViolations.
import { FORBIDDEN_PLAINTEXT_KEYS } from "../worklist/types.js";
import type {
  AgentManifest,
  CapabilityVerdict,
  RoleName,
  RoleRequirement,
} from "./types.js";

// --- The capability contract ------------------------------------------------
// Project-registered under its `reducer_id` (the same keying as
// EnvironmentContract / EvidenceContract / WorklistReducer). `evaluateCapability`
// is the SINGLE SITE of capability satisfaction: pure over
// (manifest, requirement); no IO. `readManifest` is the ONLY IO entry point —
// the project supplies it (reads .pi/zagents/<id>.json -> AgentManifest); CH1
// defines the signature only and never does IO in the harness. `requirements`
// returns the project's role→required-tools body (from the protocol's
// machine-readable `Required tools per role` section / .pi/capabilities/<id>.json).
export interface CapabilityContract {
  /** Canonical verdict, pure over (manifest, requirement). */
  evaluateCapability(manifest: AgentManifest, requirement: RoleRequirement): CapabilityVerdict;
  /** Project-supplied manifest reader (.pi/zagents/<id>.json -> AgentManifest). The ONLY IO. */
  readManifest(agentId: string): AgentManifest;
  /** Project-supplied role->required-tools body (from protocol / .pi/capabilities). */
  requirements(): Record<RoleName, RoleRequirement>;
}

// --- Body-free enforcement ---------------------------------------------------
// Mirrors environmentBodyFreeViolations / evidenceBodyFreeViolations /
// worklistBodyFreeViolations: recursively scan an AgentManifest / RoleRequirement
// / CapabilityVerdict / fix-packet value and report any FORBIDDEN_PLAINTEXT_KEYS
// found (body/task/prompt/output/content/message/text/rationale/diff/patch).
// Returns [] for a clean value. The launch gate (WS-CH2) will call this before
// threading a manifest set into the contract; CH1 exposes it now so the contract
// is body-free from the first use.
export function capabilityBodyFreeViolations(value: unknown): string[] {
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

// --- Capability contract registry -------------------------------------------
// Mirrors the EnvironmentContract registry (environment-contract.ts
// registerEnvironmentContract / resolveEnvironmentContract /
// listEnvironmentContractIds) and the EvidenceContract / WorklistReducer
// registries: keyed by reducerId (projects register under their reducer_id; the
// transposer will register reducerId='project-transposer' in WS-CH3). A MISSING
// contract resolves to `undefined` — a typed-missing signal, NOT a silent
// default — so the caller can fail-closed explicitly. (Same deliberate,
// plan-specified divergence as resolveEnvironmentContract: the WS-CH1 plan
// signature is `CapabilityContract | undefined`; the launch gate WS-CH2 will turn
// undefined into an explicit fail-closed verdict.)
const CAPABILITY_CONTRACTS = new Map<string, CapabilityContract>();

export function registerCapabilityContract(
  reducerId: string,
  contract: CapabilityContract,
): void {
  if (!reducerId) throw new Error("registerCapabilityContract: reducerId is required");
  if (!contract || typeof contract !== "object")
    throw new Error(`registerCapabilityContract('${reducerId}'): contract is required`);
  if (typeof contract.evaluateCapability !== "function")
    throw new Error(`CapabilityContract '${reducerId}' is missing evaluateCapability(manifest, requirement)`);
  if (typeof contract.readManifest !== "function")
    throw new Error(`CapabilityContract '${reducerId}' is missing readManifest(agentId)`);
  if (typeof contract.requirements !== "function")
    throw new Error(`CapabilityContract '${reducerId}' is missing requirements()`);
  CAPABILITY_CONTRACTS.set(reducerId, contract);
}

export function resolveCapabilityContract(reducerId: string): CapabilityContract | undefined {
  return CAPABILITY_CONTRACTS.get(reducerId);
}

export function listCapabilityContractIds(): string[] {
  return [...CAPABILITY_CONTRACTS.keys()];
}
