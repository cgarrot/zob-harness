// WS-CH2 (capability-validation PART II — runtime complement): the PURE nudge-
// backoff / capability-gap primitives in domains/capability/nudge-policy. Proves
// the two structural-safety properties the live 59-spam bug demanded:
//   (1) CANNOT RE-NUDGE A CONFIRMED-INCAPABLE AGENT — once
//       transitionOnCapabilityGap sets capability_gap:true, planBackoffNudge
//       returns deliver:false reason 'capability_gap_stop' for ALL subsequent
//       ticks.
//   (2) CANNOT ESCALATE A SLOW-BUT-CAPABLE AGENT AS A CAPABILITY GAP —
//       detectCapabilityGap returns gap===true ONLY when the manifest lacks a
//       required tool; a bash-capable manifest stays gap===false so
//       transitionOnCapabilityGap returns alert:null (nudges continue).
// Also proves the backoff schedule (60s->2m->5m->15m cap), the fingerprint reset,
// monotonicity, and the metadata-only fix packet. Read+test only: no harness
// source is modified by this test; pure primitives are exercised directly.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_NUDGE_SCHEDULE,
  NUDGE_BACKOFF_CAP_MS,
  capabilityGapFixPacket,
  detectCapabilityGap,
  planBackoffNudge,
  transitionOnCapabilityGap,
  type AgentManifest,
  type DriverRecord,
  type GapResult,
  type RoleRequirement,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- the live bug, as a fake manifest data structure (metadata-only) ---------
// bootstrap-lead: defaultMode 'plan' (read-only) + allowedTools omitting bash.
// detectCapabilityGap against the phase_lead requirement returns gap===true
// (the agent is physically incapable, NOT merely slow).
const BOOTSTRAP_LEAD_BUG: AgentManifest = {
  id: "bootstrap-lead",
  role: "phase_lead",
  defaultMode: "plan",
  allowedTools: ["read", "grep", "find", "ls"],
  manifestPath: ".pi/zagents/bootstrap-lead.json",
};

// A bash-capable phase_lead (implement mode + bash). detectCapabilityGap returns
// gap===false — the agent is slow-but-capable, so nudges continue.
const BOOTSTRAP_LEAD_CAPABLE: AgentManifest = {
  id: "bootstrap-lead",
  role: "phase_lead",
  defaultMode: "implement",
  allowedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  manifestPath: ".pi/zagents/bootstrap-lead.json",
};

const PHASE_LEAD_REQ: RoleRequirement = {
  requiredTools: ["bash"],
  requiredMode: "implement",
  reasonRef: "test",
};

// --- a DriverRecord factory (the data structure the app persists; the primitives
//     are pure over it). Defaults: a stable fingerprint so no reset unless a test
//     passes a different currentFingerprint, and a long-ago last_sent_at so the
//     elapsed gate is satisfied when tests want deliver===true.
function baseRecord(
  attempt_count: number,
  overrides: Partial<DriverRecord> = {},
): DriverRecord {
  return {
    key: "bootstrap-lead",
    attempt_count,
    first_sent_at: 1_000,
    last_sent_at: 5_000,
    last_fingerprint: "fp-stable",
    ...overrides,
  };
}

// A far-future tick so elapsed (nowMs - last_sent_at) >= any waitMs => the
// deliver gate is satisfied when a test wants to observe deliver===true.
const FAR_FUTURE_MS = 100_000_000;

// ===========================================================================
// (a) BACKOFF SCHEDULE: the waitMs sequence across attempt_count 0..5 is
//     [60_000, 120_000, 300_000, 900_000, 900_000, 900_000] — the 4-entry
//     DEFAULT_NUDGE_SCHEDULE ascending, then capped at NUDGE_BACKOFF_CAP_MS for
//     indices past the end.
// ===========================================================================
test("nudge-policy (a): backoff schedule is [60k,120k,300k,900k,900k,900k] capped at NUDGE_BACKOFF_CAP_MS", () => {
  const expected = [60_000, 120_000, 300_000, 900_000, 900_000, 900_000];
  const observed = expected.map(
    (_, attempt) =>
      planBackoffNudge({
        key: "bootstrap-lead",
        record: baseRecord(attempt),
        nowMs: FAR_FUTURE_MS,
      }).waitMs,
  );
  assert.deepEqual(observed, expected);

  // The cap constant is 15m and equals the schedule's final entry.
  assert.equal(NUDGE_BACKOFF_CAP_MS, 900_000);
  assert.equal(
    DEFAULT_NUDGE_SCHEDULE[DEFAULT_NUDGE_SCHEDULE.length - 1],
    NUDGE_BACKOFF_CAP_MS,
  );
  assert.deepEqual([...DEFAULT_NUDGE_SCHEDULE], [60_000, 120_000, 300_000, 900_000]);
});

// ===========================================================================
// (b) FINGERPRINT RESET: when currentFingerprint is provided AND differs from
//     record.last_fingerprint, the effective attempt_count resets to 0 so waitMs
//     is the first (fastest) interval (60_000) regardless of the stored count.
//     This is the WS-T5 reset semantics: the agent responded (or the directive
//     content changed), so full-attention re-engagement resumes.
// ===========================================================================
test("nudge-policy (b): fingerprint change resets waitMs to 60_000 (the first interval)", () => {
  // attempt_count 3 would normally be 900_000; the reset drops it to 60_000.
  const plan = planBackoffNudge({
    key: "bootstrap-lead",
    record: baseRecord(3, { last_fingerprint: "old-fp" }),
    nowMs: FAR_FUTURE_MS,
    currentFingerprint: "new-fp",
  });
  assert.equal(plan.waitMs, 60_000, "a fingerprint change resets to the first interval");
  assert.equal(plan.nextAttempt, 1, "post-reset delivery increments from the reset base 0");

  // Same fingerprint => NO reset: attempt_count 3 stays at 900_000.
  const noReset = planBackoffNudge({
    key: "bootstrap-lead",
    record: baseRecord(3, { last_fingerprint: "same-fp" }),
    nowMs: FAR_FUTURE_MS,
    currentFingerprint: "same-fp",
  });
  assert.equal(noReset.waitMs, 900_000, "no fingerprint change => no reset");
});

// ===========================================================================
// (c) MONOTONICITY (non-decreasing, capped): waitMs never decreases as
//     attempt_count grows, and never exceeds NUDGE_BACKOFF_CAP_MS.
// ===========================================================================
test("nudge-policy (c): waitMs is monotonically non-decreasing and capped at NUDGE_BACKOFF_CAP_MS", () => {
  let prev = -Infinity;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const plan = planBackoffNudge({
      key: "bootstrap-lead",
      record: baseRecord(attempt),
      nowMs: FAR_FUTURE_MS,
    });
    assert.ok(
      plan.waitMs >= prev,
      `waitMs must be non-decreasing: attempt ${attempt} waitMs ${plan.waitMs} < prev ${prev}`,
    );
    assert.ok(
      plan.waitMs <= NUDGE_BACKOFF_CAP_MS,
      `waitMs must not exceed the cap: attempt ${attempt} waitMs ${plan.waitMs}`,
    );
    prev = plan.waitMs;
  }
  // The tail saturates at the cap.
  const saturated = planBackoffNudge({
    key: "bootstrap-lead",
    record: baseRecord(99),
    nowMs: FAR_FUTURE_MS,
  });
  assert.equal(saturated.waitMs, NUDGE_BACKOFF_CAP_MS);
});

// ===========================================================================
// (d) CAPABILITY-GAP STOP (structural safety #1): a record with
//     capability_gap===true => deliver===false reason 'capability_gap_stop'. Once
//     a gap is confirmed, planBackoffNudge NEVER re-delivers — the precise fix
//     for the live 59-spam. This holds even when elapsed would otherwise satisfy
//     the backoff gate.
// ===========================================================================
test("nudge-policy (d): capability_gap:true => deliver===false reason 'capability_gap_stop'", () => {
  const plan = planBackoffNudge({
    key: "bootstrap-lead",
    record: baseRecord(2, { capability_gap: true, no_ship: true }),
    nowMs: FAR_FUTURE_MS, // elapsed would normally satisfy the gate
  });
  assert.equal(plan.deliver, false, "a confirmed capability gap must NEVER re-nudge");
  assert.equal(plan.reason, "capability_gap_stop");
  assert.equal(plan.waitMs, 0);
  // The attempt count is not incremented when not delivering.
  assert.equal(plan.nextAttempt, 2);
});

// ===========================================================================
// (e) detectCapabilityGap: the slow/incapable distinction. A manifest that
//     physically lacks a required tool (no bash, plan mode) => gap===true; a
//     bash-capable manifest (bash + implement) => gap===false (slow-but-capable).
// ===========================================================================
test("nudge-policy (e): detectCapabilityGap — no-bash => gap===true; bash-capable => gap===false", () => {
  const gapInput = {
    agent: "bootstrap-lead",
    requiredAction: "append a handoff event via node scripts/transposer-handoff.mjs",
    manifest: BOOTSTRAP_LEAD_BUG,
    requirement: PHASE_LEAD_REQ,
  };
  const gap = detectCapabilityGap(gapInput);
  assert.equal(gap.gap, true, "a manifest lacking bash must be a confirmed capability gap");
  assert.deepEqual([...gap.missingTools], ["bash"]);
  assert.equal(gap.observedMode, "plan");
  assert.equal(gap.requiredMode, "implement");
  assert.ok(
    typeof gap.fixCommand === "string" && gap.fixCommand.length > 0,
    `fixCommand must be non-empty on a gap: ${JSON.stringify(gap.fixCommand)}`,
  );

  // Contrast: bash-capable manifest => gap===false (slow-but-capable, NOT incapable).
  const gap2 = detectCapabilityGap({
    agent: "bootstrap-lead",
    requiredAction: "append a handoff event",
    manifest: BOOTSTRAP_LEAD_CAPABLE,
    requirement: PHASE_LEAD_REQ,
  });
  assert.equal(gap2.gap, false, "a bash-capable manifest must NOT be a capability gap");
  assert.deepEqual([...gap2.missingTools], []);
});

// ===========================================================================
// (f) transitionOnCapabilityGap: gap===true => record forced to
//     capability_gap:true + no_ship:true + a single alert_no_ship action
//     (reason 'capability_gap'); gap===false => {record, alert:null} (no
//     transition — the agent stays on the slowness ramp).
// ===========================================================================
test("nudge-policy (f): transitionOnCapabilityGap forces the terminal stop on gap===true; no-op on gap===false", () => {
  const record = baseRecord(3);
  const gapTrue: GapResult = {
    gap: true,
    missingTools: ["bash"],
    observedMode: "plan",
    requiredMode: "implement",
    fixCommand: 'set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json',
  };

  const transitioned = transitionOnCapabilityGap(record, gapTrue);
  assert.equal(transitioned.record.capability_gap, true, "record is forced to capability_gap:true");
  assert.equal(transitioned.record.no_ship, true, "no_ship is set alongside capability_gap");
  assert.notEqual(transitioned.alert, null);
  assert.equal(transitioned.alert!.kind, "alert_no_ship");
  assert.equal(transitioned.alert!.reason, "capability_gap");
  assert.equal(transitioned.alert!.agent, "bootstrap-lead");
  assert.deepEqual([...transitioned.alert!.missing_tools], ["bash"]);
  assert.equal(transitioned.alert!.attempt_count, 3);
  assert.equal(transitioned.alert!.first_sent_at, record.first_sent_at);
  assert.equal(transitioned.alert!.last_sent_at, record.last_sent_at);

  // gap===false: NO transition. The record is unchanged and there is no alert
  // (the agent is slow-but-capable and stays on the existing escalation ramp).
  const gapFalse: GapResult = {
    gap: false,
    missingTools: [],
    observedMode: "implement",
    requiredMode: "implement",
    fixCommand: "",
  };
  const noTransition = transitionOnCapabilityGap(record, gapFalse);
  assert.equal(noTransition.alert, null, "gap===false must emit no alert");
  assert.equal(
    noTransition.record.capability_gap,
    undefined,
    "gap===false must not set capability_gap",
  );
});

// ===========================================================================
// (g) capabilityGapFixPacket: the metadata-only alert_no_ship fix packet carries
//     the exact operator-runnable fix_command + agent + manifest_path + role +
//     the capability-derived fields. The command the agent reconstructed by hand
//     in the live run is now machine-derived.
// ===========================================================================
test("nudge-policy (g): capabilityGapFixPacket carries fix_command + agent + manifest_path", () => {
  const gap: GapResult = {
    gap: true,
    missingTools: ["bash"],
    observedMode: "plan",
    requiredMode: "implement",
    fixCommand: 'set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json',
    alternative: "route phase:X ledger recording to a bash-capable agent",
  };
  const packet = capabilityGapFixPacket(
    gap,
    "bootstrap-lead",
    ".pi/zagents/bootstrap-lead.json",
    "phase_lead",
    "protocols/handoff.md#receiver-action-contract",
  );
  assert.equal(packet.kind, "capability_gap");
  assert.equal(packet.agent, "bootstrap-lead");
  assert.equal(packet.manifest_path, ".pi/zagents/bootstrap-lead.json");
  assert.equal(packet.role, "phase_lead");
  assert.deepEqual([...packet.missing_tools], ["bash"]);
  assert.equal(packet.observed_mode, "plan");
  assert.equal(packet.required_mode, "implement");
  assert.equal(packet.required_by, "protocols/handoff.md#receiver-action-contract");
  assert.ok(
    typeof packet.fix_command === "string" && packet.fix_command.length > 0,
    "fix_command must be non-empty",
  );
  assert.ok(
    packet.fix_command.includes(".pi/zagents/bootstrap-lead.json"),
    `fix_command must name the manifest path: ${packet.fix_command}`,
  );
  assert.ok(
    packet.fix_command.includes("bash"),
    `fix_command must name the missing tool: ${packet.fix_command}`,
  );
  assert.equal(packet.alternative, gap.alternative);
});

// ===========================================================================
// (h) LIVE-BUG END-TO-END: attempt 3 + a no-bash manifest => detectCapabilityGap
//     gap===true => transitionOnCapabilityGap forces capability_gap:true => a
//     subsequent planBackoffNudge returns deliver===false reason
//     'capability_gap_stop' (the spam is structurally stopped). CONTRAST: a
//     bash-capable manifest => gap===false => planBackoffNudge keeps delivering
//     (nudges continue on the slowness ramp).
// ===========================================================================
test("nudge-policy (h): end-to-end — attempt 3 no-bash => gap => stop; bash-capable => gap false, nudges continue", () => {
  // --- the incapable path (the live bug) ---
  const record3 = baseRecord(3);
  const gap = detectCapabilityGap({
    agent: "bootstrap-lead",
    requiredAction: "append a handoff event",
    manifest: BOOTSTRAP_LEAD_BUG,
    requirement: PHASE_LEAD_REQ,
  });
  assert.equal(gap.gap, true, "no-bash manifest must be a confirmed gap");

  const transitioned = transitionOnCapabilityGap(record3, gap);
  assert.equal(transitioned.record.capability_gap, true);
  assert.equal(transitioned.alert!.kind, "alert_no_ship");

  // The subsequent tick on the TERMINAL record must NOT re-deliver.
  const stopped = planBackoffNudge({
    key: "bootstrap-lead",
    record: transitioned.record,
    nowMs: FAR_FUTURE_MS,
  });
  assert.equal(stopped.deliver, false, "after transition, planBackoffNudge must stop");
  assert.equal(stopped.reason, "capability_gap_stop");

  // --- the capable contrast (nudges continue) ---
  const gap2 = detectCapabilityGap({
    agent: "bootstrap-lead",
    requiredAction: "append a handoff event",
    manifest: BOOTSTRAP_LEAD_CAPABLE,
    requirement: PHASE_LEAD_REQ,
  });
  assert.equal(gap2.gap, false, "bash-capable manifest must NOT be a gap");

  // No transition occurs (alert===null), so the record stays gap-free and
  // planBackoffNudge keeps delivering on the backoff ramp.
  const noTransition = transitionOnCapabilityGap(record3, gap2);
  assert.equal(noTransition.alert, null);

  const continuing = planBackoffNudge({
    key: "bootstrap-lead",
    record: record3,
    nowMs: FAR_FUTURE_MS, // elapsed >> waitMs(900_000) => deliver
  });
  assert.equal(continuing.deliver, true, "a capable agent's nudges must continue on the ramp");
  assert.notEqual(continuing.reason, "capability_gap_stop");
});
