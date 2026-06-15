// WS-CH3 (capability-validation PART II): harness-side VALIDATION that the
// transposer->harness CapabilityContract BRIDGE ADAPTER shape is behavior-preserving
// for project-transposer's EXACT agent-capability FSM. This is a DRY-RUN of the
// migration described in
// .pi/extensions/zob-harness/reports/capability-ws-ch3-migration-spec.md: it proves
// an adapter implementing transposer's manifest-authoritative tool/mode evaluation
// (evaluatePhaseLead) + the WS-C3 required-tools contract on top of the harness
// CapabilityContract shape preserves:
//   - FAIL-CLOSED-BEFORE-START (headline #1): the EXACT live bug — bootstrap-lead
//     defaultMode 'plan' + allowedTools omitting 'bash' => runCapabilityGate
//     shouldStart===false with the bootstrap-lead fix_packet entry carrying the
//     exact fix command the supervisor reconstructed by hand.
//   - STOP-AFTER-N-ON-GAP (headline #2): a DriverRecord at attempt 3 + a no-bash
//     manifest => detectCapabilityGap gap===true => transitionOnCapabilityGap forces
//     the terminal capability_gap:true stop => a subsequent planBackoffNudge returns
//     deliver===false reason 'capability_gap_stop'. CONTRAST: a bash-capable manifest
//     => gap===false => transitionOnCapabilityGap returns {record, alert:null} =>
//     nudges continue on the backoff ramp.
//   - the THIN-CALLER delegation shape (resolve contract -> runCapabilityGate).
// The adapter is TEST-LOCAL: it registers via the PUBLIC harness API
// (registerCapabilityContract) and does NOT ship in the harness domain (no
// transposer coupling in shipped code).
//
// Reference (READ-ONLY, project-transposer repo):
//   - evaluatePhaseLead / validateAgentCapabilities .. scripts/validate-agent-capabilities.mjs
//     (manifest-authoritative + scoped-mode-fallback resolution; the
//      missing_required_tool / read_only_mode_for_writing_role / missing_manifest
//      blocker classes; the exact fix command
//      `set defaultMode="implement" and add "bash","edit","write" to .pi/zagents/<id>.json`).
//   - buildFixCommand ............ scripts/validate-agent-capabilities.mjs (≈370)
//     (the operator-runnable manifest edit the supervisor reconstructed by hand).
//   - WS-C3 required-tools contract . protocols/handoff.md (`## Required tools per
//     role`) + optional .pi/capabilities/project-transposer.json: phase_lead
//     {requiredTools:["bash"], requiredMode:"implement"}, oracle
//     {requiredTools:["read","grep"], requiredMode:"any"}, implementer
//     {requiredTools:["bash","edit","write"], requiredMode:"implement"}.
//   - WS-C4 nudge loop .......... scripts/{roadmap-watch.mjs, supervisor-check.mjs}
//     (planNudgeSend + probeAgentCapabilityGap + capabilityGapEscalation; an agent
//      missing bash gets exactly NUDGE_CAPABILITY_GAP_PROBE_AT nudges then
//      capability_gap_stop, NOT the live 59-spam).
//
// The harness primitives (domains/capability/primitives.ts + nudge-policy.ts) are
// byte-faithful mirrors of the transposer capability semantics (the harness was
// built to mirror them — see primitives.ts / nudge-policy.ts headers). So the adapter
// calling the harness primitives IS equivalent to the bridge calling the UNCHANGED
// transposer evaluatePhaseLead + compareCapability. Deterministic, body-free,
// network-disabled: fake manifests only (no real disk, no .pi read).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_NUDGE_SCHEDULE,
  NUDGE_BACKOFF_CAP_MS,
  buildFixPacket,
  capabilityGapFixPacket,
  compareCapability,
  detectCapabilityGap,
  manifestHasTool,
  modePermitsWrite,
  planBackoffNudge,
  registerCapabilityContract,
  requiredToolsForRole,
  resolveCapabilityContract,
  runCapabilityGate,
  transitionOnCapabilityGap,
  type AgentManifest,
  type CapabilityContract,
  type CapabilityLaunchGateResult,
  type CapabilityVerdict,
  type DriverRecord,
  type GapResult,
  type RoleRequirement,
} from "../../.pi/extensions/zob-harness/index.ts";

// ===========================================================================
// TEST-LOCAL TRANSPONDER ADAPTER (does NOT ship in the harness domain)
// ===========================================================================

const TRANSPONDER_CAPABILITY_REDUCER_ID = "project-transposer";

// --- the EXACT live bug, as a fake manifest data structure (metadata-only) ---
// bootstrap-lead: defaultMode 'plan' (read-only) + an allowedTools list that OMITS
// 'bash' (the handoff protocol requires every phase lead to record lifecycle events
// via `node scripts/transposer-handoff.mjs`, which needs the bash tool). This is the
// manifest that stalled pi-rust-env-relaunch-20260614T074416Z for ~2h and was
// nudge-spammed 59 times. Pure data structure the caller passes — NO disk read.
const BOOTSTRAP_LEAD_BUG: AgentManifest = {
  id: "bootstrap-lead",
  role: "phase_lead",
  defaultMode: "plan",
  allowedTools: ["read", "grep", "find", "ls", "zpeer_ask", "zob_context_search"],
  manifestPath: ".pi/zagents/bootstrap-lead.json",
};

// A PASSING phase_lead (the post-WS-C3 fix): defaultMode 'implement' + bash present.
// This is the manifest edit the supervisor reconstructed by hand (set defaultMode and
// add bash) — the exact fix the contract now machine-derives in its fix_command.
const BOOTSTRAP_LEAD_FIXED: AgentManifest = {
  id: "bootstrap-lead",
  role: "phase_lead",
  defaultMode: "implement",
  allowedTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "zpeer_ask", "zob_context_search"],
  manifestPath: ".pi/zagents/bootstrap-lead.json",
};

// A second passing phase_lead so the gate evaluates a real multi-agent team (the
// one-failure-still-blocks rule).
const INGESTION_LEAD_OK: AgentManifest = {
  id: "ingestion-lead",
  role: "phase_lead",
  defaultMode: "implement",
  allowedTools: ["read", "bash", "edit", "grep", "find"],
  manifestPath: ".pi/zagents/ingestion-lead.json",
};

// --- the WS-C3 required-tools contract (metadata-only) ----------------------
// The machine-readable `## Required tools per role` body WS-C3 ships in
// protocols/handoff.md (and optionally .pi/capabilities/project-transposer.json).
// phase_lead needs bash + a write mode; oracle is read-only (any mode); implementer
// needs the full write set. These are the requirements() the bridge returns.
const PHASE_LEAD_REQ: RoleRequirement = {
  requiredTools: ["bash"],
  requiredMode: "implement",
  reasonRef: "protocols/handoff.md#required-tools-per-role",
  note: "every phase lead records TASK_ACK/STARTED/PROGRESS/CLAIM via node scripts/transposer-handoff.mjs (needs the bash tool)",
};
const ORACLE_REQ: RoleRequirement = {
  requiredTools: ["read", "grep"],
  requiredMode: "any",
  reasonRef: "protocols/handoff.md#required-tools-per-role",
};
const IMPLEMENTER_REQ: RoleRequirement = {
  requiredTools: ["bash", "edit", "write"],
  requiredMode: "implement",
  reasonRef: "protocols/handoff.md#required-tools-per-role",
};

// --- the test-local CapabilityContract --------------------------------------
// evaluateCapability delegates to the PURE compareCapability (the single site of
// capability satisfaction per the WS-CH1 contract — the bridge does NOT reimplement
// the missing-tool / read-only-mode checks). readManifest reads from a mutable
// module-level `store` so each test controls the observed manifests deterministically
// AND re-runnability is provable by mutating the store between calls (the gate
// re-reads on every call — no memoization). requirements() returns the WS-C3 body.
//
// This is EXACTLY what the bridge does: the .mjs adapter's readManifest resolves the
// effective tools/mode (manifest-authoritative + scoped-mode fallback) and
// evaluateCapability delegates to compareCapability. Here the harness primitive
// stands in for the bridge's imported compareCapability (byte-faithful), and the
// mutable store stands in for the manifest reader.
let store: Record<string, AgentManifest> = {};

const transposerContract: CapabilityContract = {
  evaluateCapability(manifest, requirement) {
    return compareCapability(manifest, requirement);
  },
  readManifest(agentId) {
    return store[agentId];
  },
  requirements() {
    return {
      phase_lead: PHASE_LEAD_REQ,
      oracle: ORACLE_REQ,
      implementer: IMPLEMENTER_REQ,
    };
  },
};

// Register the adapter ONCE at module load, mirroring how the owner calls
// registerTransposerCapabilityBridge({ root, runId }) once at run init. The registry
// is module-global (the WS-CH1 contract registry pattern). Each test re-resolves the
// contract by id and re-seeds the store.
registerCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID, transposerContract);

// ===========================================================================
// Deterministic test scaffolding
// ===========================================================================

// A DriverRecord factory (the data structure the app persists to driver-state.json;
// the primitives are pure over it). Defaults: a stable fingerprint so no reset unless
// a test passes a different currentFingerprint, and a long-ago last_sent_at so the
// elapsed gate is satisfied when a test wants deliver===true.
function baseRecord(attempt_count: number, overrides: Partial<DriverRecord> = {}): DriverRecord {
  return {
    key: "bootstrap-lead",
    attempt_count,
    first_sent_at: 1_000,
    last_sent_at: 5_000,
    last_fingerprint: "fp-stable",
    ...overrides,
  };
}

// A far-future tick so elapsed (nowMs - last_sent_at) >= any waitMs => the deliver
// gate is satisfied when a test wants to observe deliver===true.
const FAR_FUTURE_MS = 100_000_000;

// ===========================================================================
// DISTINCTNESS: the adapter is a genuinely different consumer registered via the
// PUBLIC harness API (no transposer coupling in shipped code).
// ===========================================================================
test("distinctness: project-transposer capability adapter is registered via the public API and resolvable", () => {
  const contract = resolveCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID);
  assert.ok(contract, "the project-transposer CapabilityContract is registered");
  assert.equal(typeof contract!.evaluateCapability, "function");
  assert.equal(typeof contract!.readManifest, "function");
  assert.equal(typeof contract!.requirements, "function");
  // Distinct from the built-in toy consumers (toy-cap / toy-cap-gate / ci-pipeline-caps).
  assert.notEqual(TRANSPONDER_CAPABILITY_REDUCER_ID, "toy-cap");
  assert.notEqual(TRANSPONDER_CAPABILITY_REDUCER_ID, "toy-cap-gate");
  assert.notEqual(TRANSPONDER_CAPABILITY_REDUCER_ID, "ci-pipeline-caps");
  // The WS-C3 contract body is present (phase_lead + oracle + implementer).
  const reqs = contract!.requirements();
  assert.ok(reqs.phase_lead, "phase_lead requirement present");
  assert.ok(reqs.oracle, "oracle requirement present");
  assert.ok(reqs.implementer, "implementer requirement present");
  assert.deepEqual([...reqs.phase_lead.requiredTools], ["bash"]);
});

// ===========================================================================
// (a) FAIL-CLOSED-BEFORE-START (headline invariant #1) — the EXACT live bug:
//     bootstrap-lead (phase_lead, plan mode, no bash) fails its role contract;
//     ingestion-lead (phase_lead, implement, bash) passes. => runCapabilityGate
//     shouldStart===false, ok===false, fix_packet has exactly the bootstrap-lead
//     entry carrying the EXACT fix command the supervisor reconstructed by hand
//     (set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json).
// ===========================================================================
test("bridge (a): live bug — bootstrap-lead plan/no-bash => shouldStart===false, fix_packet has bootstrap-lead with the exact fix command", () => {
  store = {
    "bootstrap-lead": BOOTSTRAP_LEAD_BUG,
    "ingestion-lead": INGESTION_LEAD_OK,
  };
  const contract = resolveCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID)!;
  const result = runCapabilityGate(contract, ["bootstrap-lead", "ingestion-lead"]);

  // FAIL-CLOSED-BEFORE-START: any single failing agent blocks start.
  assert.equal(result.ok, false, "ok must be false when one agent fails its role contract");
  assert.equal(result.shouldStart, false, "shouldStart must be false (fail-closed before agents start)");
  assert.equal(result.shouldStart, result.ok, "shouldStart === ok BY CONSTRUCTION (no opt-out)");
  assert.equal(result.verdicts.length, 2, "both phase_lead agents are evaluated");
  assert.equal(result.fix_packet.length, 1, "exactly one fix_packet entry (the failing bootstrap-lead)");

  // The bootstrap-lead entry: metadata-only, the missing tool + the mode gap.
  const entry = result.fix_packet[0];
  assert.equal(entry.agent, "bootstrap-lead");
  assert.equal(entry.role, "phase_lead");
  assert.equal(entry.manifest_path, ".pi/zagents/bootstrap-lead.json");
  assert.deepEqual([...entry.missing_tools], ["bash"]);
  assert.equal(entry.observed_mode, "plan");
  assert.equal(entry.required_mode, "implement");
  assert.equal(entry.reason_ref, "protocols/handoff.md#required-tools-per-role");

  // The EXACT fix command the supervisor reconstructed by hand in the live run, now
  // machine-derived from the contract. compareCapability builds
  // `set defaultMode="<requiredMode>" and add "<missing>" to <manifestPath>` — for
  // the phase_lead requirement (implement + bash) over the bootstrap-lead bug, this
  // is the exact bootstrap-lead fix.
  const expectedFix = 'set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json';
  assert.equal(
    entry.fix_command,
    expectedFix,
    `fix_command must be the EXACT supervisor-reconstructed command; got ${JSON.stringify(entry.fix_command)}`,
  );
  // And it names the manifest path + the missing tool + the mode fix (defense in depth).
  assert.ok(entry.fix_command.includes("bootstrap-lead.json"), "fix_command names the manifest path");
  assert.ok(entry.fix_command.includes("bash"), "fix_command names the missing tool");
  assert.ok(/set defaultMode="implement"/.test(entry.fix_command), "fix_command names the mode fix");
});

// ===========================================================================
// (a2) PASSING + RE-RUNNABILITY — the fixed bootstrap-lead (implement + bash)
//      passes; flipping the store on re-call flips shouldStart (no stale
//      memoization). This is what makes "edit manifest -> re-launch" work without a
//      special path.
// ===========================================================================
test("bridge (a2): passing bootstrap-lead => shouldStart===true; flipping the store on re-call flips shouldStart (no stale memoization)", () => {
  const contract = resolveCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID)!;

  // First call: the live bug — shouldStart===false.
  store = { "bootstrap-lead": BOOTSTRAP_LEAD_BUG, "ingestion-lead": INGESTION_LEAD_OK };
  const failing = runCapabilityGate(contract, ["bootstrap-lead", "ingestion-lead"]);
  assert.equal(failing.ok, false);
  assert.equal(failing.shouldStart, false);
  assert.equal(failing.fix_packet.length, 1);

  // Mutate the SAME store (the contract's readManifest reads it live) and re-call
  // with the SAME contract + agentIds. A fresh re-read + re-evaluate must observe
  // the fix (no stale memoization across calls).
  store["bootstrap-lead"] = BOOTSTRAP_LEAD_FIXED;
  const flipped = runCapabilityGate(contract, ["bootstrap-lead", "ingestion-lead"]);
  assert.equal(flipped.ok, true, "re-call over the fixed manifest must observe the fix");
  assert.equal(flipped.shouldStart, true, "re-call must allow start after the manifest edit");
  assert.equal(flipped.shouldStart, flipped.ok, "shouldStart === ok (passing case)");
  assert.equal(flipped.fix_packet.length, 0, "fix_packet empty when ok");
  assert.equal(flipped.verdicts.length, 2, "both agents still evaluated");
  for (const v of flipped.verdicts) {
    assert.equal(v.ok, true);
    assert.equal(v.fixCommand, "", "a passing verdict carries an empty fixCommand");
  }
});

// ===========================================================================
// (b) STOP-AFTER-N-ON-GAP (headline invariant #2) — seed a DriverRecord at
//     attempt 3 + a no-bash manifest => detectCapabilityGap gap===true =>
//     transitionOnCapabilityGap forces the terminal stop => a subsequent
//     planBackoffNudge returns deliver===false reason 'capability_gap_stop'.
//     CONTRAST: a bash-capable manifest => gap===false => transition returns
//     {record, alert:null} => planBackoffNudge keeps delivering on the backoff ramp.
// ===========================================================================
test("bridge (b): attempt 3 + no-bash manifest => gap===true => transition stops it => planBackoffNudge deliver===false; bash-capable => gap===false => nudges continue", () => {
  const contract = resolveCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID)!;
  const requirement = contract.requirements().phase_lead;
  const record3 = baseRecord(3);

  // --- the incapable path (the live bug) ---
  // detectCapabilityGap probes the BUG manifest against the phase_lead requirement.
  // The manifest physically lacks bash AND is in read-only plan mode for a writing
  // role => verdict.ok===false => gap===true (incapable, NOT merely slow).
  const gap = detectCapabilityGap({
    agent: "bootstrap-lead",
    requiredAction: "append a handoff event via node scripts/transposer-handoff.mjs",
    manifest: BOOTSTRAP_LEAD_BUG,
    requirement,
  });
  assert.equal(gap.gap, true, "a no-bash plan-mode manifest must be a confirmed capability gap");
  assert.deepEqual([...gap.missingTools], ["bash"]);
  assert.equal(gap.observedMode, "plan");
  assert.equal(gap.requiredMode, "implement");
  assert.ok(
    typeof gap.fixCommand === "string" && gap.fixCommand.length > 0,
    `gap.fixCommand must be non-empty on a gap: ${JSON.stringify(gap.fixCommand)}`,
  );

  // transitionOnCapabilityGap forces the TERMINAL stop: capability_gap:true +
  // no_ship:true + a single alert_no_ship action. Once set, planBackoffNudge NEVER
  // re-delivers — the precise fix for the live 59-spam.
  const transitioned = transitionOnCapabilityGap(record3, gap);
  assert.equal(transitioned.record.capability_gap, true, "record forced to capability_gap:true");
  assert.equal(transitioned.record.no_ship, true, "no_ship set alongside capability_gap");
  assert.notEqual(transitioned.alert, null, "an alert_no_ship is emitted on the gap");
  assert.equal(transitioned.alert!.kind, "alert_no_ship");
  assert.equal(transitioned.alert!.reason, "capability_gap");
  assert.equal(transitioned.alert!.agent, "bootstrap-lead");
  assert.deepEqual([...transitioned.alert!.missing_tools], ["bash"]);
  assert.equal(transitioned.alert!.attempt_count, 3);

  // The subsequent tick on the TERMINAL record must NOT re-deliver, even when elapsed
  // would otherwise satisfy the backoff gate.
  const stopped = planBackoffNudge({
    key: "bootstrap-lead",
    record: transitioned.record,
    nowMs: FAR_FUTURE_MS,
  });
  assert.equal(stopped.deliver, false, "after transition, planBackoffNudge must stop (no re-nudge)");
  assert.equal(stopped.reason, "capability_gap_stop");
  assert.equal(stopped.waitMs, 0);
  // The attempt count is not incremented when not delivering.
  assert.equal(stopped.nextAttempt, 3);
  // And a SECOND subsequent tick is still stopped (the stop is terminal until the
  // manifest changes — the app drives a re-probe to clear the flag).
  const stoppedAgain = planBackoffNudge({
    key: "bootstrap-lead",
    record: transitioned.record,
    nowMs: FAR_FUTURE_MS + 1_000_000,
  });
  assert.equal(stoppedAgain.deliver, false, "a second subsequent tick is still stopped");
  assert.equal(stoppedAgain.reason, "capability_gap_stop");

  // --- the capable contrast (nudges continue) ---
  // A bash-capable manifest (implement + bash) => detectCapabilityGap gap===false
  // (slow-but-capable, NOT incapable). transitionOnCapabilityGap returns
  // {record, alert:null} (no transition), so the record stays gap-free and
  // planBackoffNudge keeps delivering on the backoff ramp.
  const gap2 = detectCapabilityGap({
    agent: "bootstrap-lead",
    requiredAction: "append a handoff event via node scripts/transposer-handoff.mjs",
    manifest: BOOTSTRAP_LEAD_FIXED,
    requirement,
  });
  assert.equal(gap2.gap, false, "a bash-capable manifest must NOT be a capability gap");
  assert.deepEqual([...gap2.missingTools], []);

  const noTransition = transitionOnCapabilityGap(record3, gap2);
  assert.equal(noTransition.alert, null, "gap===false must emit no alert");
  assert.equal(noTransition.record.capability_gap, undefined, "gap===false must not set capability_gap");

  const continuing = planBackoffNudge({
    key: "bootstrap-lead",
    record: record3, // unchanged record (no transition)
    nowMs: FAR_FUTURE_MS, // elapsed >> waitMs(900_000) => deliver
  });
  assert.equal(continuing.deliver, true, "a capable agent's nudges must continue on the backoff ramp");
  assert.notEqual(continuing.reason, "capability_gap_stop");
});

// ===========================================================================
// (b2) THE BACKOFF RAMP a capable agent stays on — the schedule 60s->2m->5m->15m
//      cap, the structural difference from the capability_gap_stop (which is
//      waitMs:0). Proves the stop is NOT just "the cap reached".
// ===========================================================================
test("bridge (b2): a capable agent rides the backoff ramp [60k,120k,300k,900k] — the stop is NOT the cap", () => {
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
  assert.equal(NUDGE_BACKOFF_CAP_MS, 900_000);
  assert.deepEqual([...DEFAULT_NUDGE_SCHEDULE], [60_000, 120_000, 300_000, 900_000]);

  // The capability_gap_stop is waitMs:0 (deliver:false) — distinct from the cap's
  // waitMs:900_000 (deliver:true when elapsed satisfies). The stop is NOT "the cap
  // reached": it is a forced terminal the gap transition sets.
  const stopped = planBackoffNudge({
    key: "bootstrap-lead",
    record: baseRecord(99, { capability_gap: true, no_ship: true }),
    nowMs: FAR_FUTURE_MS,
  });
  assert.equal(stopped.deliver, false);
  assert.equal(stopped.waitMs, 0);
  assert.equal(stopped.reason, "capability_gap_stop");
});

// ===========================================================================
// (b3) capabilityGapFixPacket — the metadata-only alert_no_ship fix packet carries
//      the exact operator-runnable fix + agent + manifest_path + role + the
//      capability-derived fields. The command the agent reconstructed by hand is now
//      machine-derived.
// ===========================================================================
test("bridge (b3): capabilityGapFixPacket carries the exact fix_command + agent + manifest_path + role", () => {
  const gap: GapResult = {
    gap: true,
    missingTools: ["bash"],
    observedMode: "plan",
    requiredMode: "implement",
    fixCommand: 'set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json',
    alternative: "route phase:bootstrap ledger recording to a bash-capable agent",
  };
  const packet = capabilityGapFixPacket(
    gap,
    "bootstrap-lead",
    ".pi/zagents/bootstrap-lead.json",
    "phase_lead",
    "protocols/handoff.md#required-tools-per-role",
  );
  assert.equal(packet.kind, "capability_gap");
  assert.equal(packet.agent, "bootstrap-lead");
  assert.equal(packet.manifest_path, ".pi/zagents/bootstrap-lead.json");
  assert.equal(packet.role, "phase_lead");
  assert.deepEqual([...packet.missing_tools], ["bash"]);
  assert.equal(packet.observed_mode, "plan");
  assert.equal(packet.required_mode, "implement");
  assert.equal(packet.required_by, "protocols/handoff.md#required-tools-per-role");
  assert.equal(
    packet.fix_command,
    'set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json',
    "the fix packet carries the exact supervisor-reconstructed command",
  );
  assert.equal(packet.alternative, gap.alternative);
});

// ===========================================================================
// (c) THIN-CALLER PATTERN — a test-local validateAgents(contract, agentIds) that
//     resolves the contract by id, calls runCapabilityGate, and maps the result to
//     the { ok, shouldStart, fix_packet } shape validate-agent-capabilities.mjs will
//     use. Proves the delegation shape (resolve contract -> runCapabilityGate) AND
//     the fail-closed-when-no-contract path (resolveCapabilityContract returns
//     undefined => the thin-caller fail-closes explicitly).
// ===========================================================================
interface ThinCallerResult {
  readonly ok: boolean;
  readonly shouldStart: boolean;
  readonly fix_packet: readonly { readonly agent: string; readonly fix_command: string }[];
  readonly contract_missing: boolean;
}

function validateAgents(reducerId: string, agentIds: readonly string[]): ThinCallerResult {
  const contract = resolveCapabilityContract(reducerId);
  if (!contract) {
    // Fail-closed when no contract is registered (the typed-missing signal). This is
    // the validate-agent-capabilities.mjs contract_missing blocker path.
    return { ok: false, shouldStart: false, fix_packet: [], contract_missing: true };
  }
  const gate = runCapabilityGate(contract, agentIds);
  return {
    ok: gate.ok,
    shouldStart: gate.shouldStart,
    fix_packet: gate.fix_packet.map((f) => ({ agent: f.agent, fix_command: f.fix_command })),
    contract_missing: false,
  };
}

test("bridge (c1): thin-caller resolves the contract -> runCapabilityGate; failing manifest => shouldStart===false with the bootstrap-lead fix", () => {
  store = { "bootstrap-lead": BOOTSTRAP_LEAD_BUG, "ingestion-lead": INGESTION_LEAD_OK };
  const out = validateAgents(TRANSPONDER_CAPABILITY_REDUCER_ID, ["bootstrap-lead", "ingestion-lead"]);
  assert.equal(out.contract_missing, false, "the registered contract resolves");
  assert.equal(out.ok, false, "thin-caller: failing manifest => ok false");
  assert.equal(out.shouldStart, false, "thin-caller: failing manifest => shouldStart false (fail-closed via the contract)");
  assert.equal(out.fix_packet.length, 1, "thin-caller: exactly one fix_packet entry");
  assert.equal(out.fix_packet[0].agent, "bootstrap-lead");
  assert.equal(
    out.fix_packet[0].fix_command,
    'set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json',
    "thin-caller: the exact fix command flows through the delegation",
  );

  // Passing manifest via the SAME thin-caller.
  store["bootstrap-lead"] = BOOTSTRAP_LEAD_FIXED;
  const out2 = validateAgents(TRANSPONDER_CAPABILITY_REDUCER_ID, ["bootstrap-lead", "ingestion-lead"]);
  assert.equal(out2.ok, true);
  assert.equal(out2.shouldStart, true);
  assert.equal(out2.fix_packet.length, 0);
});

test("bridge (c2): thin-caller fail-closes when no contract is registered (resolveCapabilityContract returns undefined)", () => {
  // An unregistered reducer id => resolveCapabilityContract returns undefined (the
  // typed-missing signal). The thin-caller turns it into an explicit fail-closed
  // verdict (the validate-agent-capabilities.mjs contract_missing blocker).
  assert.equal(resolveCapabilityContract("no-such-reducer"), undefined, "fixture: the id is unregistered");
  const out = validateAgents("no-such-reducer", ["bootstrap-lead"]);
  assert.equal(out.contract_missing, true, "the thin-caller detects the missing contract");
  assert.equal(out.ok, false, "fail-closed when no contract is registered");
  assert.equal(out.shouldStart, false, "shouldStart false (shift-left preserved even without init-run)");
  assert.equal(out.fix_packet.length, 0);
});

// ===========================================================================
// (d) ONE-FAILURE-STILL-BLOCKS (the oracle path) — a passing phase_lead alongside
//     a failing oracle (oracle role, missing 'grep'). Any single failure blocks
//     start. Exercises the oracle requirement (requiredMode 'any') so the test is
//     distinct from (a)'s phase_lead missing-tool failure. Proves the bridge
//     evaluates EVERY role's requirement, not just phase_lead.
// ===========================================================================
test("bridge (d): one failing oracle (missing 'grep') still blocks start (shouldStart===false)", () => {
  const oracleMissingGrep: AgentManifest = {
    id: "bad-oracle",
    role: "oracle",
    defaultMode: "plan",
    allowedTools: ["read", "find"],
    manifestPath: ".pi/zagents/bad-oracle.json",
  };
  const oracleOk: AgentManifest = {
    id: "good-oracle",
    role: "oracle",
    defaultMode: "plan",
    allowedTools: ["read", "grep", "find"],
    manifestPath: ".pi/zagents/good-oracle.json",
  };
  store = {
    "ingestion-lead": INGESTION_LEAD_OK,
    "bad-oracle": oracleMissingGrep,
    "good-oracle": oracleOk,
  };
  const contract = resolveCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID)!;
  const result = runCapabilityGate(contract, ["ingestion-lead", "bad-oracle", "good-oracle"]);

  assert.equal(result.verdicts.length, 3, "all three agents with a role requirement are evaluated");
  assert.equal(result.ok, false, "ok is false because one agent (bad-oracle) fails");
  assert.equal(result.shouldStart, false, "a single failure blocks start (fail-closed)");
  assert.equal(result.shouldStart, result.ok, "shouldStart === ok (one-failure case)");
  assert.equal(result.fix_packet.length, 1, "exactly one fix_packet entry for the single failure");
  assert.equal(result.fix_packet[0].agent, "bad-oracle");
  assert.equal(result.fix_packet[0].role, "oracle");
  assert.deepEqual([...result.fix_packet[0].missing_tools], ["grep"]);
  // oracle requiredMode 'any' => NO mode clause in the fix command (only the tool).
  assert.equal(
    result.fix_packet[0].fix_command,
    'add "grep" to .pi/zagents/bad-oracle.json',
    "oracle (requiredMode any) fix command adds only the missing tool (no mode clause)",
  );
});

// ===========================================================================
// (e) FAIL-CLOSED-BY-CONSTRUCTION — the headline invariant is structural: there is
//     NO parameter to make shouldStart diverge from ok. Assert shouldStart === ok
//     for the failing, passing, and one-failure cases. The CapabilityLaunchGateResult
//     type is imported to prove the WS-CH2 export resolves.
// ===========================================================================
test("bridge (e): shouldStart === ok in every case (fail-closed by construction, no opt-out)", () => {
  const contract = resolveCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID)!;

  store = { "bootstrap-lead": BOOTSTRAP_LEAD_BUG, "ingestion-lead": INGESTION_LEAD_OK };
  const failing: CapabilityLaunchGateResult | Promise<CapabilityLaunchGateResult> =
    runCapabilityGate(contract, ["bootstrap-lead", "ingestion-lead"]);

  store = { "bootstrap-lead": BOOTSTRAP_LEAD_FIXED, "ingestion-lead": INGESTION_LEAD_OK };
  const passing: CapabilityLaunchGateResult | Promise<CapabilityLaunchGateResult> =
    runCapabilityGate(contract, ["bootstrap-lead", "ingestion-lead"]);

  store = { "ingestion-lead": INGESTION_LEAD_OK };
  const empty: CapabilityLaunchGateResult | Promise<CapabilityLaunchGateResult> =
    runCapabilityGate(contract, ["ingestion-lead"]);

  // The readManifest is sync, so all three return synchronous results (not Promises).
  assert.ok(!(failing instanceof Promise), "sync readManifest must yield a synchronous result");
  assert.ok(!(passing instanceof Promise));
  assert.ok(!(empty instanceof Promise));

  // The invariant holds in both directions: failing (ok false -> shouldStart false)
  // and passing (ok true -> shouldStart true). runCapabilityGate exposes no option
  // that could break this — there is no `allowStart`, `force`, or `skip`.
  assert.equal(failing.ok, false);
  assert.equal(failing.shouldStart, failing.ok, "shouldStart must equal ok (failing case)");
  assert.equal(passing.ok, true);
  assert.equal(passing.shouldStart, passing.ok, "shouldStart must equal ok (passing case)");
  assert.equal(empty.ok, true);
  assert.equal(empty.shouldStart, empty.ok, "shouldStart must equal ok (all-passing single-agent case)");
});

// ===========================================================================
// (f) PRIMITIVE-LEVEL AGREEMENT — the bridge's evaluateCapability (delegated to
//     compareCapability) agrees with the shipped PURE primitives on the bug + the
//     fix. Proves the adapter calls the single site of satisfaction (no hand-rolled
//     re-implementation). Also exercises buildFixPacket (the launch-gate fix shape).
// ===========================================================================
test("bridge (f): evaluateCapability (via compareCapability) agrees with the primitives; buildFixPacket shapes the entry", () => {
  const contract = resolveCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID)!;
  const verdict = contract.evaluateCapability(BOOTSTRAP_LEAD_BUG, PHASE_LEAD_REQ);

  // compareCapability: missing bash + read-only plan mode for a writing role => fail.
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, "missing_tool", "missing_tool wins when tools are absent (the primary actionable gap)");
  assert.deepEqual([...verdict.missingTools], ["bash"]);
  assert.equal(verdict.observedMode, "plan");
  assert.equal(verdict.requiredMode, "implement");
  assert.equal(
    verdict.fixCommand,
    'set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json',
    "the verdict fixCommand is the exact supervisor-reconstructed command",
  );

  // The primitive-level building blocks the verdict composes (defense in depth).
  assert.equal(manifestHasTool(BOOTSTRAP_LEAD_BUG, "bash"), false, "bootstrap-lead bug lacks bash");
  assert.equal(manifestHasTool(BOOTSTRAP_LEAD_FIXED, "bash"), true, "bootstrap-lead fixed has bash");
  assert.equal(modePermitsWrite("plan"), false, "plan is read-only");
  assert.equal(modePermitsWrite("implement"), true, "implement permits write");
  assert.deepEqual(
    [...requiredToolsForRole(contract, "phase_lead")],
    ["bash"],
    "requiredToolsForRole reads the WS-C3 contract body",
  );
  assert.deepEqual(
    [...requiredToolsForRole(contract, "unknown-role")],
    [],
    "an unknown role has no required tools (permissive, not blocking)",
  );

  // buildFixPacket shapes the metadata-only entry the launch gate emits (the
  // capability-derived fields the supervisor needs to repair).
  const entry = buildFixPacket(verdict, BOOTSTRAP_LEAD_BUG, PHASE_LEAD_REQ);
  assert.equal(entry.agent, "bootstrap-lead");
  assert.equal(entry.role, "phase_lead");
  assert.equal(entry.manifest_path, ".pi/zagents/bootstrap-lead.json");
  assert.deepEqual([...entry.missing_tools], ["bash"]);
  assert.equal(entry.fix_command, verdict.fixCommand);
  assert.equal(entry.reason_ref, "protocols/handoff.md#required-tools-per-role");
});

// ===========================================================================
// (g) A passing CapabilityVerdict is body-free + the fix packet is body-free
//     (FORBIDDEN_PLAINTEXT_KEYS applies to every value that enters the contract).
//     Proves the contract is metadata-only / body-free from the first use (no raw
//     prompts/diffs/secrets leak through the manifest or the fix packet).
// ===========================================================================
test("bridge (g): the contract is body-free (no FORBIDDEN_PLAINTEXT_KEYS in the verdict or fix packet)", () => {
  const contract = resolveCapabilityContract(TRANSPONDER_CAPABILITY_REDUCER_ID)!;
  const verdict: CapabilityVerdict = contract.evaluateCapability(BOOTSTRAP_LEAD_BUG, PHASE_LEAD_REQ);
  const entry = buildFixPacket(verdict, BOOTSTRAP_LEAD_BUG, PHASE_LEAD_REQ);

  // capabilityBodyFreeViolations is the harness-side guard; the test-local adapter
  // reproduces the metadata-only contract here by checking the verdict + entry
  // fields directly (agent ids, tool names, mode names, manifest paths, fix_command
  // strings only — no body/task/prompt/output/content/message/text/rationale/diff/patch).
  const forbidden = new Set([
    "body", "task", "prompt", "output", "content",
    "message", "text", "rationale", "diff", "patch",
  ]);
  const check = (obj: object, label: string) => {
    for (const key of Object.keys(obj)) {
      assert.ok(!forbidden.has(key), `${label} must not carry a forbidden plaintext key: ${key}`);
    }
  };
  check(verdict as unknown as Record<string, unknown>, "verdict");
  check(entry as unknown as Record<string, unknown>, "fix_packet entry");
  // The manifest carries only agent id / role / mode / tools / paths.
  check(BOOTSTRAP_LEAD_BUG as unknown as Record<string, unknown>, "manifest");
});
