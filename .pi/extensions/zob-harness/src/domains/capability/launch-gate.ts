// ZOB Harness — Agent capability launch-time gate primitive (WS-CH2 keystone,
// capability-validation PART II).
//
// The launch-time GATE on top of the WS-CH1 CapabilityContract: a pure primitive
// `runCapabilityGate(contract, agentIds, options)` that reads each manifest ONCE
// (via the contract's project-registered readManifest), evaluates every agent
// against its role's requirement (via the contract's evaluateCapability), and
// returns { ok, verdicts, fix_packet, shouldStart } — a pure verdict the app
// gates ZTEAM_LAUNCHER start on. It NEVER starts anything itself (mechanism in
// harness, action in app), preserving the shift-left split: the gate says
// "should this run start?" and the app acts on the answer. Mirrors the Round-4
// runLaunchGate invariant verbatim.
//
// THE HEADLINE DESIGN is fail-closed BY CONSTRUCTION — shouldStart === ok always,
// with NO parameter to opt out (the whole point of shifting agent-capability
// discovery from late runtime inside one agent — where it stalls ~2h and is
// nudge-spammed 59 times — to early launch when the operator who edits manifests
// is present). This is the temporal mirror of Round 4 applied to agent
// CONFIGURATION instead of environmental preconditions.
//
// IDEMPOTENT + RE-RUNNABLE: runCapabilityGate re-reads manifests (fresh
// contract.readManifest per agent) and re-evaluates on every call — it performs
// NO memoization. This is the property that makes "edit manifest → re-launch"
// work without a special path: after a manifest edit fixes a failing agent, a
// second runCapabilityGate call re-reads the now-fixed manifest and re-derives
// shouldStart === true.
//
// CRITICAL SAFETY DIVERGENCE from Round-4 EnvironmentContract (documented so it
// is never accidentally re-introduced): there is NO auto-resolve here. The gate
// EVALUATES + SURFACES a fix packet (buildFixPacket); APPLYING the manifest edit
// is operator-gated (a manifest edit changes an agent's authority =
// security-sensitive). grep this file for 'applyAutoResolve|autoFix|auto-resolve'
// returns ONLY this comment block — there is no such method. The Round-4
// environment launch-gate had an applyAutoResolve sibling (WS-PH3, allowlisted +
// REVERSIBLE env fixes); this capability gate intentionally does NOT, because
// editing a ZAgent manifest is a security-sensitive authority change that must
// stay operator-gated.
//
// Purity contract (the headline acceptance): this module performs NO direct
// filesystem access and NO process spawning. It imports type-only (erased at
// runtime) from the siblings ./types.js + ./capability-contract.js + a single
// runtime import of buildFixPacket (PURE) from ./primitives.js. The real IO
// (reading .pi/zagents/<id>.json into an AgentManifest) lives ENTIRELY in the
// project-registered readManifest (WS-CH3), never here. (The purity grep over
// this file — scanning for node:fs / node:child_process / spawnSync /
// readdirSync / readFileSync / exec( — returns NOTHING.)
//
// Metadata-only / body-free / network-disabled: LaunchGateResult /
// CapabilityFixPacketEntry carry agent ids, tool names, mode names, manifest
// paths, and fix_command strings only — no prompt bodies, no secrets, no
// allowedPaths contents.
import type { CapabilityContract } from "./capability-contract.js";
import type { AgentManifest, CapabilityVerdict } from "./types.js";
import { buildFixPacket, type CapabilityFixPacketEntry } from "./primitives.js";

// Re-export the fix-packet entry shape so consumers import it from the gate's
// surface (mirrors the WS-PH2 launch-gate re-exporting FixPacketEntry). The
// shape is defined in primitives.ts (buildFixPacket); the gate re-exports it so
// a downstream reader has one import site for the launch-gate result type.
export type { CapabilityFixPacketEntry } from "./primitives.js";

// --- Options ----------------------------------------------------------------
export interface LaunchGateOptions {
  /**
   * Pluggable clock (deterministic in tests). The verdict itself is pure over
   * (contract, manifests) and time-independent; this hook is reserved for an app
   * to stamp emitted fix_packet entries. Reserved — not consumed by the core
   * flow. (Mirrors the WS-PH2 runLaunchGate `now?` reserved hook.)
   *
   * NOTE: there is NO `manifests?` / `allowStart?` / `force?` option here. The
   * manifests are read via the contract's readManifest (the only IO seam); and
   * shouldStart === ok BY CONSTRUCTION with no opt-out — so no such option can
   * exist. The only option is the reserved clock.
   */
  readonly now?: () => Date;
}

// --- Result -----------------------------------------------------------------
export interface LaunchGateResult {
  /** True iff EVERY evaluated agent's verdict.ok === true (fail-closed). */
  readonly ok: boolean;
  /** One verdict per evaluated agent (agents with no role requirement are skipped). */
  readonly verdicts: readonly CapabilityVerdict[];
  /** One entry per FAILING agent, in evaluation order. Empty iff ok === true. */
  readonly fix_packet: readonly CapabilityFixPacketEntry[];
  /**
   * === ok BY CONSTRUCTION (fail-closed). There is NO option to opt out of this:
   * the gate refuses to start whenever any agent fails its capability contract.
   * This is the shift-left guarantee — agent capability validated at launch, not
   * ~2h into a run via nudge-spam.
   */
  readonly shouldStart: boolean;
}

// --- The primitive ----------------------------------------------------------
/**
 * Pure over (contract, agentIds). For each agentId: (1) read the manifest ONCE
 * via contract.readManifest; (2) look up the manifest's role requirement via
 * contract.requirements()[manifest.role] — agents with NO requirement are SKIPPED
 * (permissive for unknown roles, not blocking; documented); (3) evaluate via
 * contract.evaluateCapability(manifest, requirement) (the contract method, so the
 * project can override — it delegates to compareCapability by default);
 * (4) ok = every verdict.ok === true; (5) fix_packet from the FAILING verdicts via
 * buildFixPacket (one entry per failure); (6) shouldStart === ok BY CONSTRUCTION
 * (no opt-out — the headline fail-closed shift-left guarantee).
 *
 * SYNC when readManifest returns synchronously; returns a
 * Promise<LaunchGateResult> ONLY when readManifest returns a Promise (each
 * manifest is read once, then the set is shared across the evaluation). The union
 * return type accommodates both paths.
 *
 * IDEMPOTENT + RE-RUNNABLE: no memoization. A second call after a manifest edit
 * re-reads and re-evaluates, so "edit manifest → re-launch" works without a
 * special path. NEVER starts anything itself — it is a pure verdict the app acts
 * on (same split as Round 4's runLaunchGate).
 *
 * NO AUTO-RESOLVE: this function evaluates + surfaces a fix packet; it does NOT
 * apply any manifest edit. Applying the edit is operator-gated (security-
 * sensitive authority change).
 */
export function runCapabilityGate(
  contract: CapabilityContract,
  agentIds: readonly string[],
  // `options` is reserved (the `now?` clock hook); the core flow is pure over
  // (contract, agentIds) and does not consume it. Kept on the signature so the
  // reserved hook is available to an app without a breaking change later.
  options: LaunchGateOptions = {},
): LaunchGateResult | Promise<LaunchGateResult> {
  // (1) Read each manifest ONCE via the contract's project-registered readManifest.
  //     The IO lives in the contract (app-side), NEVER here. readManifest may be
  //     sync OR async (a project may register an async reader); the declared
  //     WS-CH1 signature is sync, but we tolerate a Promise return at runtime so a
  //     project whose reader is async composes without a wrapper. Each manifest is
  //     read exactly once (no repeated IO per agent).
  const manifestReads = agentIds.map(
    (agentId) => contract.readManifest(agentId) as AgentManifest | Promise<AgentManifest>,
  );

  // Build the verdict from resolved manifests. Pure over (contract, manifests).
  const buildResult = (manifests: readonly AgentManifest[]): LaunchGateResult => {
    const requirements = contract.requirements();
    const verdicts: CapabilityVerdict[] = [];
    const fix_packet: CapabilityFixPacketEntry[] = [];

    for (const manifest of manifests) {
      // (2) Look up the manifest's role requirement. Agents with no declared
      //     requirement are SKIPPED (permissive for unknown roles, not blocking).
      //     The launch gate evaluates only agents whose role has a protocol-declared
      //     tool contract; an unknown role is treated as "no requirement" rather
      //     than a blocker (the operator can add a requirement to enforce it).
      const requirement = requirements[manifest.role];
      if (!requirement) continue;

      // (3) Evaluate via the contract method (delegates to compareCapability by
      //     default; the project can override). Single site of capability
      //     satisfaction per the WS-CH1 contract.
      const verdict = contract.evaluateCapability(manifest, requirement);
      verdicts.push(verdict);

      // (5) fix_packet: one entry per FAILING agent, in evaluation order. Built
      //     from the verdict + the manifest + the requirement via buildFixPacket
      //     (the metadata-only remediation shape from primitives.ts).
      if (!verdict.ok) {
        fix_packet.push(buildFixPacket(verdict, manifest, requirement));
      }
    }

    // (4) ok iff EVERY verdict.ok === true (fail-closed — any single failure
    //     blocks start). An empty verdict set (no agents had requirements) is ok.
    const ok = verdicts.every((v) => v.ok === true);

    // (6) shouldStart === ok BY CONSTRUCTION. No option opts out of fail-closed.
    //     This is the headline shift-left guarantee — derived from ok, never set
    //     independently.
    return { ok, verdicts, fix_packet, shouldStart: ok };
  };

  // SYNC when every readManifest returns synchronously; ASYNC only when at least
  // one readManifest returns a Promise (await them all via Promise.all, then
  // build the result once over the resolved set).
  if (manifestReads.some((read) => read instanceof Promise)) {
    return Promise.all(manifestReads).then(buildResult);
  }
  return buildResult(manifestReads as readonly AgentManifest[]);
}
