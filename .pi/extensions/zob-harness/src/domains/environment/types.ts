// ZOB Harness — Environment precondition types (WS-PH1 keystone).
//
// This is the FOURTH PILLAR promoted into the harness: a typed environment
// precondition contract that shifts the recurring root defect (environmental
// preconditions discovered LATE at phase execution — e.g. ~2h into a run: 3089
// stale files + a missing pinned Rust 1.95 — instead of EARLY at launch when the
// operator is present) into a fail-closed launch gate every consumer gets for
// free. Mirrors the Round-3 EvidenceContract promotion: the harness ships the
// typed SHAPES + a registry + PURE primitives; the body + snapshotEnvironment IO
// are project-registered (WS-PH4). EH1-style: shape-only, deferred body.
//
// Purity contract: imports ONLY from src/core/** and siblings. No IO; no runtime;
// no @earendil-works/pi-coding-agent types. Metadata-only / body-free /
// network-disabled: these types carry paths, counts, channel names, and command
// strings only — no file bodies, no secrets. FORBIDDEN_PLAINTEXT_KEYS (imported by
// environment-contract.ts from ../worklist/types.js) still applies to every value
// that enters the contract.

// --- Canonical precondition kind set ----------------------------------------
// The path-independent precondition class. Mirrors the proven
// project-transposer validate-environment.mjs kind set (PART I, planned) exactly:
// dir_empty = non-empty target tree; toolchain_installed = missing pinned channel
// or required components (rustfmt/clippy); command_present = a validation_commands
// base command not on PATH (soft); path_writable = a required path not writable.
export type PreconditionKind =
  | "dir_empty"
  | "toolchain_installed"
  | "command_present"
  | "path_writable";

// --- Check phase (when the gate runs) ---------------------------------------
// launch = checked by launch.sh / init-run.mjs at T+0 (shift-left, the whole
// point); bootstrap = checked by the bootstrap agent for preconditions genuinely
// only knowable post-planning; revalidate = checked again before scheduler
// dispatch.
export type CheckPhase = "launch" | "bootstrap" | "revalidate";

// --- A single structured precondition ---------------------------------------
// Machine-checkable, metadata-only. `target` is a path (dir_empty / path_writable),
// a channel (toolchain_installed, e.g. "1.95.0"), or a base command
// (command_present, e.g. "cargo"). `scope.ignore` is the per-precondition ignore
// list for dir_empty (e.g. [".DS_Store"]). `fix_command` is the exact
// operator-runnable command; `auto_resolvable` is true only if a known-safe,
// reversible resolution exists in the app allowlist (WS-PH3). `requires_network`
// marks fixes that need egress.
export interface Precondition {
  readonly id: string;
  readonly kind: PreconditionKind;
  readonly target: string;
  readonly scope?: { readonly ignore?: readonly string[] };
  readonly check_phase: CheckPhase;
  readonly remediation?: string;
  readonly fix_command?: string;
  readonly auto_resolvable: boolean;
  readonly requires_network: boolean;
  readonly note?: string;
}

// --- Canonical verdict (pure over (precondition, snapshot)) ------------------
// `ok` is computed ONLY from the snapshot observation + the precondition; it is
// path-independent given the snapshot. `fix_command` is null when ok; otherwise it
// is the precondition's `fix_command` (operator-runnable). `auto_resolvable` +
// `requires_network` are projected from the precondition so the launch gate
// (WS-PH2) can decide disposition without re-reading the precondition set.
export interface PreconditionVerdict {
  readonly ok: boolean;
  readonly observed: string;
  readonly expected: string;
  readonly fix_command: string | null;
  readonly auto_resolvable: boolean;
  readonly requires_network: boolean;
}

// --- The ONLY IO the primitives read ----------------------------------------
// Project-supplied so tests inject a fake (no real disk/rustup/PATH). Every method
// returns metadata only: names (not bodies), channel names (not toolchain output),
// a boolean (not a command-path resolution log). This is the single IO seam the
// primitives consume; the app implements it in snapshotEnvironment (WS-PH4).
export interface EnvironmentSnapshot {
  /** Entry names (not paths) under `path`. Empty array when the dir is empty. */
  readonly dirEntries: (path: string) => readonly string[];
  /** Installed toolchain channels, e.g. ["1.94.0", "1.87.0"]. */
  readonly installedToolchains: () => readonly string[];
  /** Components installed for `channel`, e.g. ["rustfmt", "clippy"]. */
  readonly toolchainComponents: (channel: string) => readonly string[];
  /** Is the base command `name` on PATH? */
  readonly commandOnPath: (name: string) => boolean;
  /** Is `path` writable? */
  readonly writable: (path: string) => boolean;
}
