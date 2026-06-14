// ZOB Harness — Environment launch-time gate primitive (WS-PH2 keystone,
// environment-precondition PART II).
//
// The launch-time GATE that sits on top of the WS-PH1 EnvironmentContract: a pure
// primitive `runLaunchGate(contract, options)` that snapshots ONCE, evaluates every
// check_phase:"launch" precondition, and returns
// { ok, verdicts, fix_packet, shouldStart } — a pure verdict the app gates on. It
// NEVER starts anything itself (mechanism in harness, action in app), preserving
// the shift-left split: the gate says "should this run start?" and the app acts on
// the answer. The HEADLINE design is fail-closed BY CONSTRUCTION —
// shouldStart === ok always, with NO parameter to opt out (the whole point of
// shifting environmental discovery from late phase-execution to early launch when
// the operator is present).
//
// IDEMPOTENT + RE-RUNNABLE: runLaunchGate re-snapshots (fresh
// contract.snapshotEnvironment()) and re-evaluates on every call — it performs NO
// memoization. This is the property that makes `--auto-resolve` then re-gate work
// without a relaunch: after an auto-resolve fixes a failing precondition, a second
// runLaunchGate call observes the now-fixed snapshot and re-derives shouldStart.
//
// Purity contract (the headline acceptance, inherited from the WS-PH1 keystone):
// this module performs NO direct filesystem access and NO process spawning. It
// imports ONLY type-only (erased at runtime) from the siblings ./types.js +
// ./environment-contract.js. The real IO (directory reads, rustup probes, PATH
// lookups) lives ENTIRELY in the project-registered snapshotEnvironment (WS-PH4),
// never here. (The purity grep over this file returns NOTHING.)
//
// Metadata-only / body-free / network-disabled: LaunchGateResult / FixPacketEntry
// carry paths, counts, channel names, command strings only — no file bodies, no
// secrets. The verdicts/preconditions they project are already body-free by
// construction (environmentBodyFreeViolations is available on the contract for
// defense-in-depth; the result is metadata-only without re-scanning).
import type {
  EnvironmentSnapshot,
  PreconditionKind,
  PreconditionVerdict,
} from "./types.js";
import type { EnvironmentContract } from "./environment-contract.js";

// --- Options ----------------------------------------------------------------
export interface LaunchGateOptions {
  /**
   * Inject a snapshot (for tests / re-evaluation over a known state). When
   * omitted, runLaunchGate calls `contract.snapshotEnvironment()` ONCE and shares
   * that snapshot across every launch precondition (no repeated IO).
   */
  readonly snapshot?: EnvironmentSnapshot;
  /**
   * Pluggable clock (deterministic in tests). The verdict itself is pure over
   * (contract, snapshot) and time-independent; this hook is reserved for an app to
   * stamp the emitted fix_packet. Reserved — not consumed by the core flow.
   */
  readonly now?: () => Date;
}

// --- Result + fix packet ----------------------------------------------------
export interface FixPacketEntry {
  readonly kind: PreconditionKind;
  readonly target: string;
  readonly observed: string;
  readonly expected: string;
  /**
   * Non-empty operator-runnable command. Falls back to the precondition's
   * fix_command, then to a placeholder, when the verdict carried none.
   */
  readonly fix_command: string;
  readonly auto_resolvable: boolean;
  readonly requires_network: boolean;
}

export interface LaunchGateResult {
  /** True iff EVERY launch precondition's verdict.ok === true. */
  readonly ok: boolean;
  readonly verdicts: readonly PreconditionVerdict[];
  /** One entry per FAILING verdict, in precondition order. Empty iff ok === true. */
  readonly fix_packet: readonly FixPacketEntry[];
  /**
   * === ok BY CONSTRUCTION (fail-closed). There is NO option to opt out of this:
   * the gate refuses to start whenever any launch precondition fails. This is the
   * shift-left guarantee — environmental preconditions discovered at launch, not
   * ~2h into a run.
   */
  readonly shouldStart: boolean;
}

// --- The primitive ----------------------------------------------------------
/**
 * Pure over (contract, snapshot). Snapshots ONCE, evaluates every
 * check_phase:"launch" precondition, returns { ok, verdicts, fix_packet,
 * shouldStart } with shouldStart === ok (fail-closed by construction). NEVER
 * starts anything itself — it is a verdict the app acts on.
 *
 * SYNC when a snapshot is injected (or the contract's snapshotEnvironment returns
 * synchronously); returns a Promise<LaunchGateResult> ONLY when
 * contract.snapshotEnvironment() is async (the snapshot is awaited exactly once,
 * then shared). The union return type accommodates both paths.
 *
 * IDEMPOTENT + RE-RUNNABLE: no memoization. A second call after an auto-resolve
 * re-snapshots and re-evaluates, so `--auto-resolve` then re-gate works without a
 * relaunch.
 */
export function runLaunchGate(
  contract: EnvironmentContract,
  options: LaunchGateOptions = {},
): Promise<LaunchGateResult> | LaunchGateResult {
  // (1) launch-phase preconditions — the ONLY ones this gate evaluates.
  const launchPreconditions = contract.preconditions("launch");

  // (2) Snapshot ONCE: prefer the injected snapshot (tests / re-evaluation), else
  //     call contract.snapshotEnvironment(). Shared across ALL preconditions so no
  //     precondition triggers a repeated IO. Re-callable: a subsequent
  //     runLaunchGate call re-invokes snapshotEnvironment (fresh read) — there is
  //     no memoization, so auto-resolve-then-re-gate observes the fixed state.
  const snapshotOrPromise: EnvironmentSnapshot | Promise<EnvironmentSnapshot> =
    options.snapshot ?? contract.snapshotEnvironment();

  // Build the verdict from a resolved snapshot. Pure over (contract, snapshot).
  const buildResult = (snapshot: EnvironmentSnapshot): LaunchGateResult => {
    const verdicts = launchPreconditions.map((p) =>
      contract.evaluatePrecondition(p, snapshot),
    );

    // (3) ok iff EVERY verdict.ok === true (fail-closed — any single failure blocks).
    const ok = verdicts.every((v) => v.ok === true);

    // (4) fix_packet: one entry per FAILING verdict, in precondition order. Carry
    //     kind/target/observed/expected + a NON-EMPTY fix_command (the verdict's
    //     fix_command, else the precondition's, else a placeholder) + the
    //     disposition flags. Metadata-only.
    const fix_packet: FixPacketEntry[] = [];
    for (let i = 0; i < launchPreconditions.length; i += 1) {
      const precondition = launchPreconditions[i];
      const verdict = verdicts[i];
      if (verdict.ok) continue;
      fix_packet.push({
        kind: precondition.kind,
        target: precondition.target,
        observed: verdict.observed,
        expected: verdict.expected,
        fix_command:
          verdict.fix_command ?? precondition.fix_command ?? "(no fix command defined)",
        auto_resolvable: verdict.auto_resolvable,
        requires_network: verdict.requires_network,
      });
    }

    // (5) shouldStart === ok BY CONSTRUCTION. No option opts out of fail-closed.
    //     This is the headline shift-left guarantee.
    return { ok, verdicts, fix_packet, shouldStart: ok };
  };

  // SYNC when a snapshot is injected or the contract returns synchronously; ASYNC
  // only when contract.snapshotEnvironment() returns a Promise (await it once).
  if (snapshotOrPromise instanceof Promise) {
    return snapshotOrPromise.then(buildResult);
  }
  return buildResult(snapshotOrPromise);
}
