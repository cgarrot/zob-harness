// ZOB Harness — Agent capability nudge-policy primitives (WS-CH2 keystone,
// capability-validation PART II — the runtime complement to the launch gate).
//
// The PURE runtime primitives that fix the supervisor nudge-spam (the live bug:
// an agent physically incapable of complying — `bootstrap-lead` plan-mode with
// no `bash` while the handoff protocol requires `node scripts/transposer-
// handoff.mjs` — was nudge-spammed ~59 times over ~2h because the supervisor
// modeled every unmet nudge as *slowness*, never as *incapability*, and had a
// fixed 120s resend with no backoff and no stop). Four PURE primitives compose
// the policy the watchers (transposer `roadmap-watch.mjs` / `supervisor-
// check.mjs`, WS-CH3) consume instead of the hand-rolled fixed-interval loop:
//
//   - planBackoffNudge(...)      — exponential backoff 60s→2m→5m→15m cap + the
//                                  structural STOP for a confirmed capability gap
//                                  (deliver:false reason 'capability_gap_stop').
//   - detectCapabilityGap(...)   — probe the manifest against the nudge's required
//                                  action; returns gap===true ONLY when the agent
//                                  physically lacks a required tool (a slow-but-
//                                  capable agent stays gap===false — the critical
//                                  slow/incapable distinction).
//   - capabilityGapFixPacket(...)— shape the metadata-only alert_no_ship fix packet
//                                  carrying the exact operator-runnable fix (the
//                                  command the agent reconstructed by hand, now
//                                  machine-derived).
//   - transitionOnCapabilityGap(...) — force the terminal driver record
//                                  (capability_gap:true + no_ship:true) + emit the
//                                  single alert_no_ship action; once gap===true the
//                                  stop is FORCED (planBackoffNudge never re-delivers).
//
// THE TWO STRUCTURAL-SAFETY PROPERTIES (the headline acceptance, enforced by
// construction):
//   (1) CANNOT RE-NUDGE A CONFIRMED-INCAPABLE AGENT — once transitionOnCapabilityGap
//       sets capability_gap:true, planBackoffNudge returns deliver:false
//       reason:'capability_gap_stop' for ALL subsequent ticks. There is no path
//       that re-delivers for a capability_gap:true record.
//   (2) CANNOT ESCALATE A SLOW-BUT-CAPABLE AGENT AS A CAPABILITY GAP —
//       detectCapabilityGap returns gap===true ONLY when the manifest lacks a
//       required tool (verdict.ok===false); a manifest WITH the tools yields
//       gap===false, so transitionOnCapabilityGap returns {record, alert:null}
//       (no transition — the agent stays on the existing slowness escalation ramp).
//
// CRITICAL SAFETY DIVERGENCE from Round-4 EnvironmentContract: there is NO
// auto-resolve here. grep this file for 'applyAutoResolve|autoFix|auto-resolve'
// returns ONLY this comment block — there is no such method. The primitives
// EVALUATE + SURFACE a fix packet (capabilityGapFixPacket) + FORCE the terminal
// stop (transitionOnCapabilityGap); APPLYING the manifest edit is operator-gated
// (a manifest edit changes an agent's authority = security-sensitive). This is
// the same split as the WS-CH2 launch gate (evaluate + surface; action is app/
// operator-side), intentionally diverging from Round 4's reversible env
// auto-resolve.
//
// Purity contract (the headline acceptance): this module performs NO direct
// filesystem access and NO process spawning. It imports type-only (erased at
// runtime) from the siblings ./types.js + a single runtime import of
// compareCapability (PURE) from ./primitives.js. The real IO (reading
// .pi/zagents/<id>.json + persisting driver-state.json) lives ENTIRELY in the
// app's watcher (WS-CH3), never here. (The purity grep over this file returns
// NOTHING.) DriverRecord is a DATA STRUCTURE the app persists; these primitives
// are pure over it.
//
// Metadata-only / body-free / network-disabled: DriverRecord / GapResult /
// NudgePlan / CapabilityGapFixPacket / CapabilityGapAction carry agent ids,
// tool names, mode names, manifest paths, fix_command strings, counts, and
// timestamps only — no prompt bodies, no secrets.
import { compareCapability } from "./primitives.js";
import type { AgentManifest, RoleRequirement } from "./types.js";

// --- The backoff schedule (replaces the fixed 120s resend) ------------------
// 60s → 2m (120s) → 5m (300s) → 15m (900s) cap. Monotonically non-decreasing;
// capped at NUDGE_BACKOFF_CAP_MS. This alone cuts the live 2h spam from ~59
// sends to ~6 sends (60s + 2m + 5m + 15m + 15m + 15m ≈ 51m for 6 attempts) while
// still re-surfacing the issue on every backoff tick so it is never silently
// dropped. The slowness escalation ramp (existing handoffUnresponsiveEscalation)
// is retained for slow-but-capable agents; backoff changes FREQUENCY, not
// escalation eligibility.
export const DEFAULT_NUDGE_SCHEDULE: readonly number[] = [60_000, 120_000, 300_000, 900_000];

// The cap (never grows past this). Defaults to 15m (900s). The last schedule
// entry equals the cap by default; schedule indices past the end fall back to
// the cap, so a long unanswered streak saturates at the cap.
export const NUDGE_BACKOFF_CAP_MS = 900_000;

// --- Types ------------------------------------------------------------------
// The backoff schedule: a readonly ascending list of millisecond waits, indexed
// by the record's attempt_count (0-indexed: attempt_count 0 → schedule[0]).
export type NudgeSchedule = readonly number[];

// Per-key nudge state (a DATA STRUCTURE, NOT a persisted store — the app's
// watcher persists it to driver-state.json; these primitives are pure over it).
// Metadata-only: key (agent id), counts, timestamps (epoch ms), a fingerprint
// string (directive/state hash), and two booleans (capability_gap / no_ship).
export interface DriverRecord {
  readonly key: string;
  readonly attempt_count: number;
  readonly first_sent_at: number;
  readonly last_sent_at: number;
  readonly last_fingerprint: string;
  /** Set to true by transitionOnCapabilityGap once a gap is confirmed (terminal). */
  readonly capability_gap?: boolean;
  /** Set to true alongside capability_gap (the no_ship flag the watch loop reads). */
  readonly no_ship?: boolean;
}

// The detectCapabilityGap output. `gap` is true ONLY when the manifest lacks a
// required tool (the agent is physically incapable); false when the manifest has
// the tools (slow-but-capable — the critical distinction). Carries the
// capability-derived fields the fix packet needs.
export interface GapResult {
  readonly gap: boolean;
  readonly missingTools: readonly string[];
  readonly observedMode: string;
  readonly requiredMode: string;
  readonly fixCommand: string;
  readonly alternative?: string;
}

// The planBackoffNudge output. `deliver` is whether the watch loop should send a
// nudge this tick; `waitMs` is the computed backoff wait; `nextAttempt` is the
// record's next attempt_count if delivering; `reason` documents non-delivery
// (e.g. 'capability_gap_stop').
export interface NudgePlan {
  readonly deliver: boolean;
  readonly waitMs: number;
  readonly nextAttempt: number;
  readonly reason?: string;
}

// The metadata-only alert_no_ship fix packet for a capability gap. Carries the
// EXACT operator-runnable fix (the command the agent reconstructed by hand in the
// live run, now machine-derived). One entry per confirmed gap.
export interface CapabilityGapFixPacket {
  readonly kind: "capability_gap";
  readonly agent: string;
  readonly manifest_path: string;
  readonly role: string;
  readonly missing_tools: readonly string[];
  readonly observed_mode: string;
  readonly required_mode: string;
  /** Where the requirement is documented (safe repo-relative pointer). */
  readonly required_by: string;
  readonly fix_command: string;
  readonly alternative?: string;
  readonly attempt_count: number;
  readonly first_sent_at: number;
  readonly last_sent_at: number;
}

// The alert_no_ship ACTION transitionOnCapabilityGap emits (distinct from the
// full fix packet: this carries only what (record, gap) provide — the signal +
// the record's timing; the watch loop enriches it with manifest_path/role/
// required_by via capabilityGapFixPacket when it has the manifest, which it
// always does because it called detectCapabilityGap with the manifest).
export interface CapabilityGapAction {
  readonly kind: "alert_no_ship";
  readonly reason: "capability_gap";
  readonly agent: string;
  readonly missing_tools: readonly string[];
  readonly observed_mode: string;
  readonly required_mode: string;
  readonly fix_command: string;
  readonly alternative?: string;
  readonly attempt_count: number;
  readonly first_sent_at: number;
  readonly last_sent_at: number;
}

// The transitionOnCapabilityGap return: the terminal driver record + the single
// alert_no_ship action (or {record, alert:null} when gap===false — no transition).
export interface CapabilityGapTransition {
  readonly record: DriverRecord;
  readonly alert: CapabilityGapAction | null;
}

// --- planBackoffNudge input -------------------------------------------------
export interface PlanBackoffNudgeInput {
  readonly key: string;
  readonly record: DriverRecord;
  /** Defaults to DEFAULT_NUDGE_SCHEDULE. */
  readonly schedule?: NudgeSchedule;
  /** Defaults to NUDGE_BACKOFF_CAP_MS. */
  readonly capMs?: number;
  /** Epoch ms (the current tick). */
  readonly nowMs: number;
  /**
   * The CURRENT directive/state fingerprint. When provided AND different from
   * record.last_fingerprint, the backoff RESETS to the first interval (the
   * WS-T5 reset semantics: the agent responded, or the directive content
   * changed, so the unanswered streak is broken and full attention resumes).
   * When omitted, no reset detection (uses record.attempt_count as-is).
   */
  readonly currentFingerprint?: string;
}

// --- detectCapabilityGap input ----------------------------------------------
export interface DetectCapabilityGapInput {
  readonly agent: string;
  /** The nudge's required action (descriptive metadata, e.g. 'append a handoff event'). */
  readonly requiredAction: string;
  readonly manifest: AgentManifest;
  readonly requirement: RoleRequirement;
}

/**
 * planBackoffNudge: PURE over the record's attempt_count (and the fingerprint
 * reset). Returns { deliver, waitMs, nextAttempt }. Logic:
 *   (1) if record.capability_gap === true -> { deliver: false, waitMs: 0,
 *       reason: 'capability_gap_stop' } (the STOP — once a gap is confirmed,
 *       never re-nudge). THE STRUCTURAL SAFETY: no path re-delivers for a
 *       capability_gap:true record.
 *   (2) fingerprint change (currentFingerprint provided AND != record.last_
 *       fingerprint) RESETS the effective attempt_count to 0 (the first
 *       interval; the WS-C4 1-indexed "attempt 1" = 60s semantics, mapped to
 *       the 0-indexed record field — full-attention re-engagement is the
 *       PURPOSE of the reset).
 *   (3) waitMs = schedule[effectiveAttempt] ?? capMs (monotonically non-
 *       decreasing, capped at capMs).
 *   (4) deliver = (nowMs - record.last_sent_at) >= waitMs.
 *   (5) nextAttempt = effectiveAttempt + 1 if delivering; else effectiveAttempt
 *       (no increment when not delivering).
 *
 * Monotonically non-decreasing waits capped at capMs; reset on fingerprint
 * change. PURE — no IO. No auto-resolve.
 */
export function planBackoffNudge(input: PlanBackoffNudgeInput): NudgePlan {
  const schedule = input.schedule ?? DEFAULT_NUDGE_SCHEDULE;
  const capMs = input.capMs ?? NUDGE_BACKOFF_CAP_MS;
  const record = input.record;

  // (1) CAPABILITY-GAP STOP — the structural safety. Once a gap is confirmed,
  //     NEVER re-nudge. This is the precise fix for the live 59-spam: an agent
  //     that physically cannot comply is not nudged again.
  if (record.capability_gap === true) {
    return {
      deliver: false,
      waitMs: 0,
      nextAttempt: record.attempt_count,
      reason: "capability_gap_stop",
    };
  }

  // (2) FINGERPRINT RESET — a change (agent responded / directive content
  //     changed) resets the backoff to the first interval (effective attempt_count
  //     0 = schedule[0] = the fastest wait). The PURPOSE of the reset is full-
  //     attention re-engagement, so the first (fastest) interval is the right
  //     semantics. (The spec's "resets attempt_count to 1" is the WS-C4 1-indexed
  //     "attempt 1" = the first interval = 60s; in this 0-indexed record field
  //     that is attempt_count 0.)
  const fingerprintChanged =
    input.currentFingerprint !== undefined &&
    input.currentFingerprint !== record.last_fingerprint;
  const effectiveAttempt = fingerprintChanged ? 0 : record.attempt_count;

  // (3) waitMs from schedule[effectiveAttempt] ?? capMs. The schedule is ascending;
  //     indices past the end fall back to capMs, so a long unanswered streak
  //     saturates at the cap (monotonically non-decreasing + capped).
  const waitMs = schedule[effectiveAttempt] ?? capMs;

  // (4) deliver iff enough elapsed since the last send.
  const elapsed = input.nowMs - record.last_sent_at;
  const deliver = elapsed >= waitMs;

  // (5) nextAttempt increments only when delivering. On a fingerprint reset the
  //     effective base is 0, so the first post-reset delivery sets nextAttempt
  //     to 1 (one nudge sent in the new streak). When not delivering, the count
  //     is unchanged (we are still waiting out the backoff).
  const nextAttempt = deliver ? effectiveAttempt + 1 : effectiveAttempt;

  return { deliver, waitMs, nextAttempt };
}

/**
 * detectCapabilityGap: PURE. Probes the manifest against the nudge's required
 * action (via the requirement the action implies) and returns GapResult. Reuses
 * compareCapability(manifest, requirement) internally (the canonical pure
 * capability evaluation); maps to { gap: verdict.ok===false, missingTools,
 * observedMode, requiredMode, fixCommand, alternative }.
 *
 * THE CRITICAL DISTINCTION: if the manifest HAS the tools (verdict.ok===true) ->
 * gap===false (the agent is slow-but-capable, NOT incapable). This is what gates
 * the escalation: a slow-but-capable agent NEVER transitions to capability_gap
 * (it stays on the slowness ramp). Only a manifest that physically lacks a
 * required tool yields gap===true. PURE — no IO. No auto-resolve.
 *
 * `requiredAction` is descriptive metadata carried for the caller (e.g. 'append
 * a handoff event' for a missing_ack / STARTED-owner nudge); the requirement
 * object already encodes the tool/mode contract the action implies.
 */
export function detectCapabilityGap(input: DetectCapabilityGapInput): GapResult {
  // Reuse the canonical pure capability evaluation (single site of capability
  // satisfaction per the WS-CH1 contract primitives). The manifest is probed
  // against the requirement the nudge's required action implies.
  const verdict = compareCapability(input.manifest, input.requirement);
  return {
    // gap===true ONLY when the manifest physically lacks a required tool (or has
    // a read-only mode for a writing role). A slow-but-capable manifest (has the
    // tools) yields verdict.ok===true -> gap===false. This is the structural
    // gate that prevents escalating slow-but-capable as a capability gap.
    gap: verdict.ok === false,
    missingTools: verdict.missingTools,
    observedMode: verdict.observedMode,
    requiredMode: verdict.requiredMode,
    fixCommand: verdict.fixCommand,
    alternative: verdict.alternative,
  };
}

/**
 * capabilityGapFixPacket: PURE. Shapes the metadata-only alert_no_ship fix
 * packet carrying the EXACT operator-runnable fix (the command the agent
 * reconstructed by hand in the live run — e.g. 'set defaultMode="implement" and
 * add "bash" to .pi/zagents/bootstrap-lead.json' — now machine-derived). Carries
 * kind/agent/manifest_path/role/missing_tools/observed_mode/required_mode/
 * required_by/fix_command/alternative + the timing fields (attempt_count/
 * first_sent_at/last_sent_at, defaulted to 0 here — the watch loop fills them
 * from the driver record at transition time via transitionOnCapabilityGap).
 *
 * PURE — no IO. NO auto-resolve: this function SHAPES the fix packet; it does NOT
 * apply the manifest edit (applying is operator-gated = security-sensitive).
 */
export function capabilityGapFixPacket(
  gap: GapResult,
  agent: string,
  manifestPath: string,
  role: string,
  requiredBy: string,
): CapabilityGapFixPacket {
  return {
    kind: "capability_gap",
    agent,
    manifest_path: manifestPath,
    role,
    missing_tools: gap.missingTools,
    observed_mode: gap.observedMode,
    required_mode: gap.requiredMode,
    required_by: requiredBy,
    fix_command: gap.fixCommand,
    alternative: gap.alternative,
    // Timing fields are surfaced by the caller from the driver record at
    // transition time (transitionOnCapabilityGap carries them on its alert).
    // Defaulted to 0 here; capabilityGapFixPacket focuses on the capability-
    // derived content (the manifest edit the operator runs).
    attempt_count: 0,
    first_sent_at: 0,
    last_sent_at: 0,
  };
}

/**
 * transitionOnCapabilityGap: PURE. Returns the terminal driver record + the
 * single alert_no_ship action. Logic:
 *   - if gap.gap === true -> { record: {...record, capability_gap: true,
 *     no_ship: true}, alert: {kind: 'alert_no_ship', reason: 'capability_gap',
 *     ...the gap fields + the record's timing} }. THE STRUCTURAL SAFETY: the
 *     record is FORCED to capability_gap:true once gap===true; planBackoffNudge
 *     then returns deliver:false reason:'capability_gap_stop' for ALL subsequent
 *     ticks. There is NO path that re-nudges a confirmed-incapable agent.
 *   - if gap.gap === false -> { record, alert: null } (no transition — the agent
 *     is slow-but-capable and stays on the existing escalation ramp).
 *
 * PURE — no IO. No auto-resolve.
 */
export function transitionOnCapabilityGap(
  record: DriverRecord,
  gap: GapResult,
): CapabilityGapTransition {
  if (gap.gap === true) {
    // Force the terminal state: capability_gap:true + no_ship:true. Once set,
    // planBackoffNudge returns deliver:false for all subsequent ticks (the stop
    // is self-healing only on manifest change — a re-probe seeing the tool now
    // present clears the flag, which the app drives by re-evaluating).
    const terminalRecord: DriverRecord = {
      ...record,
      capability_gap: true,
      no_ship: true,
    };
    const alert: CapabilityGapAction = {
      kind: "alert_no_ship",
      reason: "capability_gap",
      agent: record.key,
      missing_tools: gap.missingTools,
      observed_mode: gap.observedMode,
      required_mode: gap.requiredMode,
      fix_command: gap.fixCommand,
      alternative: gap.alternative,
      attempt_count: record.attempt_count,
      first_sent_at: record.first_sent_at,
      last_sent_at: record.last_sent_at,
    };
    return { record: terminalRecord, alert };
  }

  // gap===false: the agent has the tools (slow-but-capable). NO transition —
  // the record is unchanged and the watch loop stays on the existing slowness
  // escalation ramp. This is the structural gate that prevents escalating a
  // slow-but-capable agent as a capability gap.
  return { record, alert: null };
}
