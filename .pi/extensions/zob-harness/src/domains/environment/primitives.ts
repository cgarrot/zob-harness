// ZOB Harness — Environment precondition primitives (WS-PH1 keystone).
//
// The PURE building blocks every environment check composes: dirEmpty /
// toolchainInstalled / commandPresent / pathWritable. Each is PURE over a pluggable
// EnvironmentSnapshot (the ONLY IO) — these are the thing reinvented per-project
// today; promoting them here means every consumer (transposer, pacman, ...) gets
// the same building blocks for free.
//
// PURITY CONTRACT (the headline acceptance of WS-PH1): this module performs NO
// direct filesystem access and NO process spawning. It imports ONLY the
// EnvironmentSnapshot type (type-only, erased at runtime) from ./types.js. The
// real IO (directory reads, rustup probes, PATH lookups, writability checks) lives
// ENTIRELY in the project-registered snapshotEnvironment implementation (WS-PH4),
// never here. This makes the matrix tests in WS-PH2 / WS-PH5 runnable without any
// real disk/PATH/rustup. (The purity grep over this file returns NOTHING.)
import type { EnvironmentSnapshot } from "./types.js";

// --- Result shapes (the primitive return types) ------------------------------
// Each primitive returns the base { ok, observed, expected } plus a kind-specific
// extra (entryCount for dirEmpty, installed for toolchainInstalled). A contract's
// evaluatePrecondition maps these into a full PreconditionVerdict by adding
// fix_command / auto_resolvable / requires_network from the Precondition.

export interface DirEmptyResult {
  readonly ok: boolean;
  readonly observed: string;
  readonly expected: string;
  readonly entryCount: number;
}

export interface ToolchainInstalledResult {
  readonly ok: boolean;
  readonly observed: string;
  readonly expected: string;
  readonly installed: readonly string[];
}

export interface CommandPresentResult {
  readonly ok: boolean;
  readonly observed: string;
  readonly expected: string;
}

export interface PathWritableResult {
  readonly ok: boolean;
  readonly observed: string;
  readonly expected: string;
}

/**
 * dirEmpty: is `target` empty? Calls snapshot.dirEntries(target), applies
 * scope.ignore (e.g. [".DS_Store"]), returns ok iff no entries remain. PURE over
 * the snapshot — no directory reads, no filesystem calls. The building block for the `dir_empty`
 * precondition (the live bug: 3089 stale entries under the target tree).
 */
export function dirEmpty(
  target: string,
  scope: { readonly ignore?: readonly string[] } | undefined,
  snapshot: EnvironmentSnapshot,
): DirEmptyResult {
  const ignore = scope?.ignore ? new Set(scope.ignore) : null;
  const entries = ignore
    ? snapshot.dirEntries(target).filter((name) => !ignore.has(name))
    : snapshot.dirEntries(target);
  const entryCount = entries.length;
  return {
    ok: entryCount === 0,
    observed: `${entryCount} entries`,
    expected: "0 entries",
    entryCount,
  };
}

/**
 * toolchainInstalled: is `channel` installed with all `components`? Calls
 * snapshot.installedToolchains() + snapshot.toolchainComponents(channel). Defaults
 * components to ["rustfmt", "clippy"] (the transposer requirement) when omitted or
 * empty. PURE over the snapshot — no rustup probe, no process spawning. The building block for
 * the `toolchain_installed` precondition (the live bug: 1.95.0 missing).
 */
export function toolchainInstalled(
  channel: string,
  components: readonly string[] | undefined,
  snapshot: EnvironmentSnapshot,
): ToolchainInstalledResult {
  const required =
    components && components.length > 0 ? components : ["rustfmt", "clippy"];
  const installed = [...snapshot.installedToolchains()];
  const channelInstalled = installed.includes(channel);
  const installedComponents = channelInstalled
    ? new Set(snapshot.toolchainComponents(channel))
    : new Set<string>();
  const missingComponents = required.filter(
    (component) => !installedComponents.has(component),
  );
  const ok = channelInstalled && missingComponents.length === 0;
  const observed = `installed ${installed.length > 0 ? installed.join(", ") : "(none)"}`;
  const expected = `${channel} + ${required.join(",")}`;
  return { ok, observed, expected, installed };
}

/**
 * commandPresent: is `name` on PATH? Calls snapshot.commandOnPath(name). PURE over
 * the snapshot — no which lookup, no process spawning. Soft by intent (a missing cargo at launch
 * may be intentional for a non-rust run); the launch gate treats it as a warning.
 */
export function commandPresent(
  name: string,
  snapshot: EnvironmentSnapshot,
): CommandPresentResult {
  const present = snapshot.commandOnPath(name);
  return {
    ok: present,
    observed: present ? "on PATH" : "not on PATH",
    expected: "on PATH",
  };
}

/**
 * pathWritable: is `path` writable? Calls snapshot.writable(path). PURE over the
 * snapshot — no writability probe, no real IO. The building block for the `path_writable`
 * precondition.
 */
export function pathWritable(
  path: string,
  snapshot: EnvironmentSnapshot,
): PathWritableResult {
  const writable = snapshot.writable(path);
  return {
    ok: writable,
    observed: writable ? "writable" : "not writable",
    expected: "writable",
  };
}
