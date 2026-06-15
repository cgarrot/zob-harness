// ZOB Harness — Agent capability validation types (WS-CH1 keystone).
//
// This is the FIFTH PILLAR promoted into the harness: a typed agent-capability
// contract that shifts the recurring root defect (an agent's declared tools are
// never validated against the protocol's required tools BEFORE launch — the live
// `pi-rust-env-relaunch-20260614T074416Z` run stalled ~2h because `bootstrap-lead`
// was `defaultMode: "plan"` with no `bash` while the handoff protocol requires
// every phase lead to record lifecycle events via `node scripts/transposer-handoff.mjs`;
// a supervisor that cannot tell *slow* from *incapable* then nudge-spammed it 59
// times) into a fail-closed launch gate every consumer gets for free. Mirrors the
// Round-3 `EvidenceContract` + Round-4 `EnvironmentContract` promotion: the harness
// ships the typed SHAPES + a registry + PURE primitives; the BODY (which roles
// need which tools) + the manifest READER (`readManifest` IO) are
// project-registered (WS-CH3). CH1-style: shape-only, deferred body.
//
// Purity contract: imports ONLY from src/core/** and siblings. No IO; no runtime;
// no @earendil-works/pi-coding-agent types. Metadata-only / body-free /
// network-disabled: these types carry agent ids, tool names, mode names, manifest
// paths, and `fixCommand` strings only — no prompt bodies, no secrets, no
// `allowedPaths` contents. FORBIDDEN_PLAINTEXT_KEYS (imported by
// capability-contract.ts from ../worklist/types.js) still applies to every value
// that enters the contract.

// --- Role id (project-defined) ----------------------------------------------
// A role id, e.g. 'phase_lead' | 'oracle' | 'implementer'. Kept a generic string
// because role names are project-defined (the transposer names its own roles in
// protocols/handoff.md; pacman names its own). The contract keys
// `requirements(): Record<RoleName, RoleRequirement>` by this id.
export type RoleName = string;

// --- Agent manifest (the data structure the contract evaluates) -------------
// Metadata-only by construction: every field is an agent id, a role id, a mode
// name, a tool-name list, an optional path list, or a manifest path. No prompt
// bodies, no secret material, no file contents. The caller passes this data
// structure (the contract's project-registered `readManifest` is the ONLY IO that
// produces it — never in the harness; WS-CH3).
export interface AgentManifest {
  readonly id: string;
  readonly role: string;
  // 'plan' = read-only; 'implement'|'edit' permit write execution. The literal
  // union documents intent; the trailing `string` keeps the type open for
  // project-defined modes (project-validated by modePermitsWrite).
  readonly defaultMode: "plan" | "implement" | "edit" | string;
  readonly allowedTools: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly manifestPath: string;
}

// --- Per-role requirement (the protocol's declared tool contract) -----------
// Machine-checkable, metadata-only. `requiredTools` is the protocol-derived
// minimum tool set for the role (e.g. phase_lead needs `bash` to run
// transposer-handoff.mjs; oracles need `read`+`grep`; implementers need
// `bash`+`edit`+`write`). `requiredMode` is `implement`|`edit` for any role that
// must write lifecycle events/source, or `any` for read-only roles.
// `reasonRef` is the safe repo-relative pointer to where the requirement is
// documented (the prose note stays for humans; this object is what the contract
// evaluates). Mirrors the WS-C3 `## Required tools per role` structured section.
export interface RoleRequirement {
  readonly requiredTools: readonly string[];
  readonly requiredMode: "implement" | "edit" | "any";
  readonly reasonRef: string;
  readonly note?: string;
}

// --- Canonical capability verdict (pure over (manifest, requirement)) --------
// `ok` is computed ONLY from (manifest, requirement) — path-independent. `kind`
// is the canonical failure class: 'pass' when ok; 'missing_tool' when the
// manifest's allowedTools omits a required tool; 'read_only_mode_for_writing_role'
// when the role requires a write tool (bash/edit/write) but defaultMode is
// read-only (plan); 'missing_manifest' reserved for the launch-gate's no-manifest
// case. `missingTools` is the subset of requiredTools the manifest lacks.
// `observedMode`/`requiredMode` are the mode mismatch pair (always populated so a
// downstream reader can see the mode gap even when kind='missing_tool'). `fixCommand`
// is the exact operator-runnable command (empty string on pass); `alternative` is
// the optional routing alternative (e.g. "route phase:X to a bash-capable agent").
//
// CRITICAL SAFETY DIVERGENCE from Round-4 EnvironmentContract: there is NO
// auto-resolve for capability gaps. The verdict surfaces a fix packet; APPLYING
// the manifest edit is operator-gated (a manifest edit changes an agent's
// authority = security-sensitive, unlike a reversible environment auto-resolve).
// The harness only evaluates + surfaces; the edit is app/operator-side.
export interface CapabilityVerdict {
  readonly ok: boolean;
  readonly missingTools: readonly string[];
  readonly observedMode: string;
  readonly requiredMode: string;
  readonly fixCommand: string;
  readonly alternative?: string;
  readonly kind:
    | "pass"
    | "missing_tool"
    | "read_only_mode_for_writing_role"
    | "missing_manifest";
}
