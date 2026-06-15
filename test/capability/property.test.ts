// capability-validation PART II — DoD: a PROPERTY test over a SECOND distinct
// toy consumer. Proves BOTH headline invariants hold for ANY CapabilityContract
// implementor via the SAME shipped harness primitives
// (registerCapabilityContract + runCapabilityGate + planBackoffNudge /
// detectCapabilityGap / transitionOnCapabilityGap / capabilityGapFixPacket).
//
// The SECOND toy consumer here is a `ci-pipeline` project with its OWN domain —
// roles deployer/reviewer/runner, manifestPath `.ci/agents/*.json`, reducerId
// 'ci-pipeline-caps'. It is INTENTIONALLY DISTINCT from:
//   - the WS-CH1/CH2 toy (phase_lead/oracle, `.pi/zagents/*.json`, 'toy-cap' /
//     'toy-cap-gate'), and
//   - the transposer reference (phase_lead/oracle/implementer).
// This proves the harness CapabilityContract is genuinely reusable (not
// transposer-coupled, not WS-toy-coupled).
//
// Four properties, all DETERMINISTIC over a fixed table of cases (no
// Math.random flakiness):
//   P1 LAUNCH FAIL-CLOSED-BEFORE-START — for any single launched agent missing a
//      protocol-required tool, runCapabilityGate shouldStart===false regardless
//      of how many other agents pass (the exact class the live bug violated:
//      bootstrap-lead launched without bash => ~2h stall).
//   P2 RUNTIME STOP-AFTER-N-ON-GAP — for any agent whose manifest lacks the
//      nudge's required tool: detectCapabilityGap gap===true =>
//      transitionOnCapabilityGap forces capability_gap:true + no_ship:true + one
//      alert_no_ship; planBackoffNudge then returns deliver===false reason
//      'capability_gap_stop' for ALL subsequent ticks (NEVER re-nudges). For any
//      agent whose manifest HAS the tool: gap===false, alert===null, nudges
//      continue on the backoff cadence.
//   P3 BACKOFF MONOTONICITY — nudge intervals are monotonically non-decreasing
//      and capped at NUDGE_BACKOFF_CAP_MS; a fingerprint change resets to the
//      first interval.
//   P4 FIX-PACKET COMPLETENESS — every failing agent appears in fix_packet with
//      a non-empty fix_command naming the exact manifest + missing tools; every
//      passing agent is absent.
//
// Read+test only: NO harness source is modified. The toy contract is invented
// here and dispatches to the shipped PURE primitives. No transposer body is
// copied (transposer is read-only reference). No disk IO, no network, no secrets.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_NUDGE_SCHEDULE,
  NUDGE_BACKOFF_CAP_MS,
  buildFixPacket,
  capabilityGapFixPacket,
  compareCapability,
  detectCapabilityGap,
  planBackoffNudge,
  registerCapabilityContract,
  resolveCapabilityContract,
  runCapabilityGate,
  transitionOnCapabilityGap,
  type AgentManifest,
  type CapabilityContract,
  type DriverRecord,
  type RoleRequirement,
} from "../../.pi/extensions/zob-harness/index.ts";

// ===========================================================================
// The SECOND toy consumer: a `ci-pipeline` project. DISTINCT domain.
// ===========================================================================
// Roles invented for this toy (NOT transposer's phase_lead/oracle/implementer,
// NOT the WS-CH1/CH2 toy's phase_lead/oracle). A real CI-pipeline style split:
//   - deployer  : needs bash + edit to run deploy scripts and patch config
//   - reviewer  : read-only code review (read + grep); requiredMode 'any'
//   - runner    : needs bash to execute CI jobs
//
// The role-name-distinctness is asserted explicitly below (P0) so a future edit
// that accidentally regresses into the transposer/WS-toy roles fails loudly —
// this is the proof that the contract is generic, not transposer-coupled.
const DEPLOYER_REQ: RoleRequirement = {
  requiredTools: ["bash", "edit"],
  requiredMode: "implement",
  reasonRef: ".ci/protocol/deploy.md#deployer-tool-contract",
  note: "deployer runs `node scripts/deploy.mjs` and patches .ci/config.json",
};
const REVIEWER_REQ: RoleRequirement = {
  requiredTools: ["read", "grep"],
  requiredMode: "any",
  reasonRef: ".ci/protocol/review.md#reviewer-read-only",
  note: "reviewer is read-only; never writes",
};
const RUNNER_REQ: RoleRequirement = {
  requiredTools: ["bash"],
  requiredMode: "implement",
  reasonRef: ".ci/protocol/run.md#runner-bash",
  note: "runner executes CI jobs via bash",
};

// The set of role names this SECOND toy owns. MUST differ from transposer's
// (phase_lead/oracle/implementer) and from the WS-CH1/CH2 toy's
// (phase_lead/oracle). Asserted in P0 below.
const CI_PIPELINE_ROLES = ["deployer", "reviewer", "runner"] as const;
const FORBIDDEN_TRANSPOSER_ROLES = new Set([
  "phase_lead",
  "oracle",
  "implementer",
]);

// --- A deterministic table of ci-pipeline manifests -------------------------
// Metadata-only data structures (agent ids, role ids, modes, tool-name lists,
// manifest paths). No disk read. Each is the input the contract evaluates.
type ManifestId =
  | "deployer-ok"
  | "deployer-missing-edit"
  | "deployer-plan-mode"
  | "reviewer-ok"
  | "reviewer-missing-grep"
  | "runner-ok"
  | "runner-no-bash";

const MANIFESTS: Record<ManifestId, AgentManifest> = {
  "deployer-ok": {
    id: "ci-deployer-1",
    role: "deployer",
    defaultMode: "implement",
    allowedTools: ["read", "bash", "edit", "grep"],
    manifestPath: ".ci/agents/ci-deployer-1.json",
  },
  "deployer-missing-edit": {
    id: "ci-deployer-1",
    role: "deployer",
    defaultMode: "implement",
    allowedTools: ["read", "bash", "grep"], // missing edit
    manifestPath: ".ci/agents/ci-deployer-1.json",
  },
  "deployer-plan-mode": {
    id: "ci-deployer-1",
    role: "deployer",
    defaultMode: "plan", // read-only for a writing role
    allowedTools: ["read", "bash", "edit", "grep"],
    manifestPath: ".ci/agents/ci-deployer-1.json",
  },
  "reviewer-ok": {
    id: "ci-reviewer-1",
    role: "reviewer",
    defaultMode: "plan",
    allowedTools: ["read", "grep", "find"],
    manifestPath: ".ci/agents/ci-reviewer-1.json",
  },
  "reviewer-missing-grep": {
    id: "ci-reviewer-1",
    role: "reviewer",
    defaultMode: "plan",
    allowedTools: ["read", "find"], // missing grep
    manifestPath: ".ci/agents/ci-reviewer-1.json",
  },
  "runner-ok": {
    id: "ci-runner-1",
    role: "runner",
    defaultMode: "implement",
    allowedTools: ["bash", "read"],
    manifestPath: ".ci/agents/ci-runner-1.json",
  },
  "runner-no-bash": {
    id: "ci-runner-1",
    role: "runner",
    defaultMode: "implement",
    allowedTools: ["read"], // missing bash
    manifestPath: ".ci/agents/ci-runner-1.json",
  },
};

// --- The SECOND toy CapabilityContract (reducerId='ci-pipeline-caps') -------
// Registered via the PUBLIC API only (registerCapabilityContract). Its
// evaluateCapability dispatches to the shipped PURE primitive compareCapability.
// Its requirements() returns THIS toy's role->required-tools body (the ci-pipeline
// protocol). Its readManifest reads from a mutable module-level `store` so each
// test controls the observed manifests deterministically AND re-runnability is
// provable by mutating the store between calls.
const CI_PIPELINE_ID = "ci-pipeline-caps";

let ciStore: Record<string, AgentManifest> = {};

const ciPipelineContract: CapabilityContract = {
  evaluateCapability(manifest, requirement) {
    return compareCapability(manifest, requirement);
  },
  readManifest(agentId) {
    return ciStore[agentId];
  },
  requirements() {
    return {
      deployer: DEPLOYER_REQ,
      reviewer: REVIEWER_REQ,
      runner: RUNNER_REQ,
    };
  },
};
registerCapabilityContract(CI_PIPELINE_ID, ciPipelineContract);

// --- Determinism helper: a far-future tick so the deliver gate (elapsed >=
//     waitMs) is satisfied when a test wants deliver===true.
const FAR_FUTURE_MS = 100_000_000;

function baseRecord(
  attempt_count: number,
  overrides: Partial<DriverRecord> = {},
): DriverRecord {
  return {
    key: "ci-runner-1",
    attempt_count,
    first_sent_at: 1_000,
    last_sent_at: 5_000,
    last_fingerprint: "fp-stable",
    ...overrides,
  };
}

// ===========================================================================
// P0 — GENERIC (not transposer-coupled): the SECOND toy's roles are DISTINCT
// from transposer's phase_lead/oracle/implementer and from the WS-CH1/CH2 toy.
// This is the proof the harness contract is reusable for ANY implementor.
// ===========================================================================
test("property P0 — ci-pipeline is a DISTINCT domain (roles differ from transposer + WS-toy)", () => {
  // The ci-pipeline role names must NOT be transposer's / WS-toy's.
  for (const role of CI_PIPELINE_ROLES) {
    assert.ok(
      !FORBIDDEN_TRANSPOSER_ROLES.has(role),
      `ci-pipeline role '${role}' must not collide with transposer/WS-toy roles`,
    );
  }
  // The contract is registered under its OWN reducerId, resolvable via the
  // public registry, and carries THIS toy's requirements body (not transposer's).
  const resolved = resolveCapabilityContract(CI_PIPELINE_ID);
  assert.notEqual(resolved, undefined, "ci-pipeline contract must be registered");
  const reqs = resolved!.requirements();
  assert.deepEqual([...Object.keys(reqs).sort()], ["deployer", "reviewer", "runner"]);
  // Distinct tool surfaces per role (not a copy of transposer's bash-only phase_lead).
  assert.deepEqual([...reqs.deployer.requiredTools], ["bash", "edit"]);
  assert.deepEqual([...reqs.reviewer.requiredTools], ["read", "grep"]);
  assert.deepEqual([...reqs.runner.requiredTools], ["bash"]);
  // Distinct manifest paths (this toy uses .ci/agents/*.json, not .pi/zagents/*).
  assert.ok(
    MANIFESTS["deployer-ok"].manifestPath.startsWith(".ci/agents/"),
    "ci-pipeline manifests live under .ci/agents/ (distinct from .pi/zagents/)",
  );
});

// ===========================================================================
// P1 — LAUNCH FAIL-CLOSED-BEFORE-START (the headline invariant).
// For several deterministic (agents, manifests) pairs, runCapabilityGate returns
// shouldStart===false whenever ANY single agent is missing a required tool,
// regardless of how many others pass. Assert: (a) all-pass => shouldStart===true;
// (b) one-fail-among-many-pass => shouldStart===false; (c) all-fail =>
// shouldStart===false. Plus a parametric sweep: for EACH role, a single failing
// agent of that role still blocks a full team of otherwise-passing agents.
// ===========================================================================

// A helper that runs the gate and returns the typed result.
function gateFor(store: Record<string, AgentManifest>): ReturnType<typeof runCapabilityGate> {
  ciStore = store;
  const ids = Object.keys(store);
  return runCapabilityGate(ciPipelineContract, ids);
}

test("property P1a — ALL-PASS => shouldStart===true (no agent blocks start)", () => {
  const result = gateFor({
    "ci-deployer-1": MANIFESTS["deployer-ok"],
    "ci-reviewer-1": MANIFESTS["reviewer-ok"],
    "ci-runner-1": MANIFESTS["runner-ok"],
  });
  assert.equal(result.ok, true, "ok must be true when every agent satisfies its role");
  assert.equal(result.shouldStart, true, "shouldStart===true when all pass (fail-closed gate opens)");
  assert.equal(result.shouldStart, result.ok, "shouldStart === ok by construction");
  assert.equal(result.fix_packet.length, 0, "no fix entries when all pass");
  assert.equal(result.verdicts.length, 3, "all three role-bearing agents evaluated");
});

test("property P1b — ONE-FAIL-AMONG-MANY-PASS => shouldStart===false (a single gap blocks the whole launch)", () => {
  // deployer passes, reviewer passes, runner FAILS (no bash). Exactly one gap.
  const result = gateFor({
    "ci-deployer-1": MANIFESTS["deployer-ok"],
    "ci-reviewer-1": MANIFESTS["reviewer-ok"],
    "ci-runner-1": MANIFESTS["runner-no-bash"],
  });
  assert.equal(result.ok, false, "ok must be false when one agent fails");
  assert.equal(result.shouldStart, false, "shouldStart===false — ONE gap blocks launch (the live-bug class)");
  assert.equal(result.shouldStart, result.ok, "shouldStart === ok by construction");
  assert.equal(result.fix_packet.length, 1, "exactly one fix entry for the single failure");
  assert.equal(result.fix_packet[0].agent, "ci-runner-1");
  assert.equal(result.fix_packet[0].role, "runner");
  assert.deepEqual([...result.fix_packet[0].missing_tools], ["bash"]);
});

test("property P1c — ALL-FAIL => shouldStart===false (every role has a gap)", () => {
  const result = gateFor({
    "ci-deployer-1": MANIFESTS["deployer-missing-edit"],
    "ci-reviewer-1": MANIFESTS["reviewer-missing-grep"],
    "ci-runner-1": MANIFESTS["runner-no-bash"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.shouldStart, false, "shouldStart===false when all agents fail");
  assert.equal(result.shouldStart, result.ok);
  assert.equal(result.fix_packet.length, 3, "one fix entry per failing agent");
  // Each failing agent appears, each naming its own manifest + missing tool.
  const byAgent = new Map(result.fix_packet.map((e) => [e.agent, e]));
  assert.ok(byAgent.has("ci-deployer-1"));
  assert.deepEqual([...byAgent.get("ci-deployer-1")!.missing_tools], ["edit"]);
  assert.ok(byAgent.has("ci-reviewer-1"));
  assert.deepEqual([...byAgent.get("ci-reviewer-1")!.missing_tools], ["grep"]);
  assert.ok(byAgent.has("ci-runner-1"));
  assert.deepEqual([...byAgent.get("ci-runner-1")!.missing_tools], ["bash"]);
});

test("property P1d — PARAMETRIC: for EACH role, a single failing agent of that role blocks a full passing team", () => {
  // For each role, build a team where everyone passes EXCEPT one agent of the
  // target role, and assert shouldStart===false. This is the heart of the
  // headline invariant: ANY single missing-tool gap blocks start, regardless of
  // how many others pass, and this holds for EVERY role in the contract.
  const passingByRole: Record<string, AgentManifest> = {
    deployer: MANIFESTS["deployer-ok"],
    reviewer: MANIFESTS["reviewer-ok"],
    runner: MANIFESTS["runner-ok"],
  };
  const failingByRole: Record<string, AgentManifest> = {
    deployer: MANIFESTS["deployer-missing-edit"], // missing edit
    reviewer: MANIFESTS["reviewer-missing-grep"], // missing grep
    runner: MANIFESTS["runner-no-bash"], // missing bash
  };
  for (const failingRole of CI_PIPELINE_ROLES) {
    const store: Record<string, AgentManifest> = {};
    for (const role of CI_PIPELINE_ROLES) {
      const m = role === failingRole ? failingByRole[role] : passingByRole[role];
      store[m.id] = m;
    }
    const result = gateFor(store);
    assert.equal(
      result.ok,
      false,
      `[role=${failingRole}] a single failing ${failingRole} must block start (ok===false)`,
    );
    assert.equal(
      result.shouldStart,
      false,
      `[role=${failingRole}] shouldStart===false — one ${failingRole} gap blocks the whole team`,
    );
    assert.equal(result.shouldStart, result.ok, `[role=${failingRole}] shouldStart === ok`);
    // The fix_packet contains the failing role's agent and names its missing tool.
    assert.equal(result.fix_packet.length, 1, `[role=${failingRole}] exactly one fix entry`);
    const entry = result.fix_packet[0];
    assert.equal(entry.role, failingRole, `[role=${failingRole}] fix entry role matches`);
    assert.ok(
      entry.missing_tools.length > 0,
      `[role=${failingRole}] fix entry must name a missing tool`,
    );
    assert.ok(
      entry.fix_command.length > 0,
      `[role=${failingRole}] fix_command must be non-empty`,
    );
  }
});

test("property P1e — mode-gap also blocks: deployer in plan mode (read-only for a writing role) => shouldStart===false", () => {
  // A role can also fail via read-only-mode-for-writing-role (no missing tool,
  // but defaultMode 'plan' while the role requires a write). This is the SAME
  // class as the live bug (bootstrap-lead plan-mode). It must block too.
  const result = gateFor({
    "ci-deployer-1": MANIFESTS["deployer-plan-mode"], // mode gap, no missing tool
    "ci-reviewer-1": MANIFESTS["reviewer-ok"],
    "ci-runner-1": MANIFESTS["runner-ok"],
  });
  assert.equal(result.ok, false, "a read-only mode for a writing role must fail the contract");
  assert.equal(result.shouldStart, false, "shouldStart===false on a mode gap (not just missing tool)");
  assert.equal(result.shouldStart, result.ok);
  assert.equal(result.fix_packet.length, 1);
  assert.equal(result.fix_packet[0].agent, "ci-deployer-1");
  assert.equal(result.fix_packet[0].observed_mode, "plan");
  assert.equal(result.fix_packet[0].required_mode, "implement");
});

// ===========================================================================
// P2 — RUNTIME STOP-AFTER-N-ON-GAP (the second headline invariant).
// For any agent whose manifest lacks the nudge's required tool:
//   (a) detectCapabilityGap gap===true;
//   (b) transitionOnCapabilityGap => capability_gap:true + no_ship:true + exactly
//       one alert_no_ship (kind/reason wired);
//   (c) planBackoffNudge on the TERMINAL record => deliver===false reason
//       'capability_gap_stop' for ALL subsequent ticks (NEVER re-nudges).
// For any agent whose manifest HAS the tool:
//   (d) detectCapabilityGap gap===false;
//   (e) transitionOnCapabilityGap alert===null (no transition — stays on ramp);
//   (f) planBackoffNudge continues at backoff cadence (deliver depends on elapsed
//       time, NOT a hard stop).
// ===========================================================================

// Parametric over (role, failing-manifest, passing-manifest, required-tool) so
// the property is proven for BOTH a deployer-style gap (missing edit) and a
// runner-style gap (missing bash) — not just one role.
const GAP_CASES = [
  {
    label: "runner-missing-bash",
    manifest: MANIFESTS["runner-no-bash"],
    requirement: RUNNER_REQ,
    requiredAction: "execute the CI job via bash",
    missing: ["bash"],
  },
  {
    label: "deployer-missing-edit",
    manifest: MANIFESTS["deployer-missing-edit"],
    requirement: DEPLOYER_REQ,
    requiredAction: "patch .ci/config.json (edit)",
    missing: ["edit"],
  },
  {
    label: "reviewer-missing-grep",
    manifest: MANIFESTS["reviewer-missing-grep"],
    requirement: REVIEWER_REQ,
    requiredAction: "search the diff for patterns (grep)",
    missing: ["grep"],
  },
] as const;

// The capable contrast for each case (same role, manifest HAS the tools).
const CAPABLE_CASES = [
  {
    label: "runner-capable",
    manifest: MANIFESTS["runner-ok"],
    requirement: RUNNER_REQ,
    requiredAction: "execute the CI job via bash",
  },
  {
    label: "deployer-capable",
    manifest: MANIFESTS["deployer-ok"],
    requirement: DEPLOYER_REQ,
    requiredAction: "patch .ci/config.json (edit)",
  },
  {
    label: "reviewer-capable",
    manifest: MANIFESTS["reviewer-ok"],
    requirement: REVIEWER_REQ,
    requiredAction: "search the diff for patterns (grep)",
  },
] as const;

test("property P2a — for ANY gap manifest: detectCapabilityGap gap===true + the right missing tool", () => {
  for (const c of GAP_CASES) {
    const gap = detectCapabilityGap({
      agent: c.manifest.id,
      requiredAction: c.requiredAction,
      manifest: c.manifest,
      requirement: c.requirement,
    });
    assert.equal(gap.gap, true, `[${c.label}] a manifest lacking a required tool must be a gap`);
    assert.deepEqual(
      [...gap.missingTools],
      c.missing,
      `[${c.label}] missingTools must name the exact missing tool`,
    );
    assert.ok(
      typeof gap.fixCommand === "string" && gap.fixCommand.length > 0,
      `[${c.label}] fixCommand must be non-empty on a gap`,
    );
  }
});

test("property P2b — for ANY gap manifest: transitionOnCapabilityGap forces capability_gap:true + no_ship:true + exactly one alert_no_ship", () => {
  for (const c of GAP_CASES) {
    const record = baseRecord(2, { key: c.manifest.id });
    const gap = detectCapabilityGap({
      agent: c.manifest.id,
      requiredAction: c.requiredAction,
      manifest: c.manifest,
      requirement: c.requirement,
    });
    const { record: terminal, alert } = transitionOnCapabilityGap(record, gap);

    assert.equal(terminal.capability_gap, true, `[${c.label}] record forced to capability_gap:true`);
    assert.equal(terminal.no_ship, true, `[${c.label}] no_ship set alongside capability_gap`);
    assert.notEqual(alert, null, `[${c.label}] exactly one alert emitted`);
    assert.equal(alert!.kind, "alert_no_ship", `[${c.label}] alert kind`);
    assert.equal(alert!.reason, "capability_gap", `[${c.label}] alert reason`);
    assert.equal(alert!.agent, c.manifest.id, `[${c.label}] alert agent`);
    assert.deepEqual([...alert!.missing_tools], c.missing, `[${c.label}] alert missing_tools`);
    assert.equal(alert!.attempt_count, record.attempt_count, `[${c.label}] alert carries the record's timing`);
    assert.equal(alert!.first_sent_at, record.first_sent_at);
    assert.equal(alert!.last_sent_at, record.last_sent_at);
  }
});

test("property P2c — for ANY gap manifest: after transition, planBackoffNudge NEVER re-nudges (deliver===false reason 'capability_gap_stop') on every subsequent tick", () => {
  for (const c of GAP_CASES) {
    const record = baseRecord(2, { key: c.manifest.id });
    const gap = detectCapabilityGap({
      agent: c.manifest.id,
      requiredAction: c.requiredAction,
      manifest: c.manifest,
      requirement: c.requirement,
    });
    const { record: terminal } = transitionOnCapabilityGap(record, gap);

    // Simulate a LONG streak of supervisor ticks at far-future times. EVERY one
    // must be a hard stop — this is the structural fix for the live 59-spam.
    let delivered = 0;
    for (let tick = 0; tick < 64; tick += 1) {
      const plan = planBackoffNudge({
        key: c.manifest.id,
        record: terminal,
        nowMs: FAR_FUTURE_MS + tick * NUDGE_BACKOFF_CAP_MS, // always past the backoff gate
      });
      assert.equal(plan.deliver, false, `[${c.label}] tick ${tick}: must NEVER deliver post-gap`);
      assert.equal(plan.reason, "capability_gap_stop", `[${c.label}] tick ${tick}: reason`);
      if (plan.deliver) delivered += 1;
    }
    assert.equal(delivered, 0, `[${c.label}] zero deliveries across 64 ticks post-gap`);
  }
});

test("property P2d — for ANY capable manifest: detectCapabilityGap gap===false (slow-but-capable, NOT a gap)", () => {
  for (const c of CAPABLE_CASES) {
    const gap = detectCapabilityGap({
      agent: c.manifest.id,
      requiredAction: c.requiredAction,
      manifest: c.manifest,
      requirement: c.requirement,
    });
    assert.equal(gap.gap, false, `[${c.label}] a manifest WITH the tools must NOT be a gap`);
    assert.deepEqual([...gap.missingTools], [], `[${c.label}] no missing tools when capable`);
  }
});

test("property P2e — for ANY capable manifest: transitionOnCapabilityGap alert===null (no transition — stays on slowness ramp)", () => {
  for (const c of CAPABLE_CASES) {
    const record = baseRecord(3, { key: c.manifest.id });
    const gap = detectCapabilityGap({
      agent: c.manifest.id,
      requiredAction: c.requiredAction,
      manifest: c.manifest,
      requirement: c.requirement,
    });
    const { record: after, alert } = transitionOnCapabilityGap(record, gap);
    assert.equal(alert, null, `[${c.label}] a capable agent must emit NO alert`);
    assert.equal(
      after.capability_gap,
      undefined,
      `[${c.label}] a capable agent must NOT be transitioned to capability_gap`,
    );
    assert.equal(
      after.no_ship,
      undefined,
      `[${c.label}] a capable agent must NOT be marked no_ship`,
    );
  }
});

test("property P2f — for ANY capable manifest: planBackoffNudge continues at backoff cadence (deliver depends on elapsed time, NOT a hard stop)", () => {
  for (const c of CAPABLE_CASES) {
    const record = baseRecord(1, { key: c.manifest.id }); // NOT terminal
    // Enough elapsed => deliver (the slowness ramp keeps nudging).
    const deliverPlan = planBackoffNudge({
      key: c.manifest.id,
      record,
      nowMs: FAR_FUTURE_MS, // elapsed >> waitMs => deliver
    });
    assert.equal(
      deliverPlan.deliver,
      true,
      `[${c.label}] a capable agent with enough elapsed MUST deliver (ramp continues)`,
    );
    assert.notEqual(
      deliverPlan.reason,
      "capability_gap_stop",
      `[${c.label}] a capable agent is never capability_gap_stop`,
    );
    // Not enough elapsed => hold (deliver depends on time, not stopped).
    const holdPlan = planBackoffNudge({
      key: c.manifest.id,
      record,
      nowMs: record.last_sent_at + 1_000, // 1s after last send << waitMs => hold
    });
    assert.equal(
      holdPlan.deliver,
      false,
      `[${c.label}] a capable agent with too-little elapsed holds (time-gated, not stopped)`,
    );
    assert.notEqual(
      holdPlan.reason,
      "capability_gap_stop",
      `[${c.label}] hold reason is NOT the capability-gap stop`,
    );
  }
});

test("property P2g — the loop NEVER transitions a capable agent to capability_gap across a long streak (stays on the slowness ramp)", () => {
  // End-to-end: simulate a long unanswered streak for a CAPABLE agent. At every
  // tick, re-probe + re-attempt transition. The agent must NEVER acquire
  // capability_gap:true (it stays on the slowness ramp), and the alert is NEVER
  // emitted. This is the structural gate that prevents escalating slow-but-
  // capable as a capability gap (the second structural safety property).
  const capable = CAPABLE_CASES[0]; // runner-ok
  let record = baseRecord(0, { key: capable.manifest.id });
  let alerts = 0;
  for (let tick = 0; tick < 32; tick += 1) {
    const gap = detectCapabilityGap({
      agent: capable.manifest.id,
      requiredAction: capable.requiredAction,
      manifest: capable.manifest,
      requirement: capable.requirement,
    });
    assert.equal(gap.gap, false, `[tick ${tick}] capable agent never becomes a gap`);
    const { record: next, alert } = transitionOnCapabilityGap(record, gap);
    if (alert !== null) alerts += 1;
    assert.equal(alert, null, `[tick ${tick}] capable agent never emits an alert`);
    // The record never acquires capability_gap.
    assert.equal(next.capability_gap, undefined, `[tick ${tick}] never transitioned`);
    record = next;
  }
  assert.equal(alerts, 0, "zero alerts across the whole capable streak");
});

// ===========================================================================
// P3 — BACKOFF MONOTONICITY.
// For a fixed driver key with no fingerprint change, nudge intervals are
// monotonically non-decreasing and capped at NUDGE_BACKOFF_CAP_MS. A fingerprint
// change resets to the first interval. Proven over the ci-pipeline driver key.
// ===========================================================================
test("property P3 — backoff is monotonically non-decreasing, capped, and resets on fingerprint change", () => {
  // Monotonic + capped across attempt_count 0..9 (past the 4-entry schedule).
  let prev = -Infinity;
  const observed: number[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const plan = planBackoffNudge({
      key: "ci-runner-1",
      record: baseRecord(attempt),
      nowMs: FAR_FUTURE_MS,
    });
    assert.ok(
      plan.waitMs >= prev,
      `monotonicity violated at attempt ${attempt}: ${plan.waitMs} < ${prev}`,
    );
    assert.ok(
      plan.waitMs <= NUDGE_BACKOFF_CAP_MS,
      `cap violated at attempt ${attempt}: ${plan.waitMs} > ${NUDGE_BACKOFF_CAP_MS}`,
    );
    prev = plan.waitMs;
    observed.push(plan.waitMs);
  }
  // The exact schedule for the default 4-entry schedule + cap tail.
  assert.deepEqual(observed, [
    60_000, 120_000, 300_000, 900_000, 900_000, 900_000, 900_000, 900_000, 900_000, 900_000,
  ]);
  assert.deepEqual([...DEFAULT_NUDGE_SCHEDULE], [60_000, 120_000, 300_000, 900_000]);
  assert.equal(DEFAULT_NUDGE_SCHEDULE[DEFAULT_NUDGE_SCHEDULE.length - 1], NUDGE_BACKOFF_CAP_MS);

  // Saturation: a very high attempt_count lands exactly on the cap.
  const saturated = planBackoffNudge({
    key: "ci-runner-1",
    record: baseRecord(999),
    nowMs: FAR_FUTURE_MS,
  });
  assert.equal(saturated.waitMs, NUDGE_BACKOFF_CAP_MS);

  // Fingerprint change RESETS to the first interval (60_000), even from a high
  // attempt_count that would otherwise be at the cap.
  const reset = planBackoffNudge({
    key: "ci-runner-1",
    record: baseRecord(999, { last_fingerprint: "old-fp" }),
    nowMs: FAR_FUTURE_MS,
    currentFingerprint: "new-fp",
  });
  assert.equal(reset.waitMs, 60_000, "a fingerprint change resets to the first interval");
  assert.equal(reset.nextAttempt, 1, "post-reset delivery increments from the reset base 0");

  // Same fingerprint => NO reset (stays at the cap).
  const noReset = planBackoffNudge({
    key: "ci-runner-1",
    record: baseRecord(999, { last_fingerprint: "same-fp" }),
    nowMs: FAR_FUTURE_MS,
    currentFingerprint: "same-fp",
  });
  assert.equal(noReset.waitMs, NUDGE_BACKOFF_CAP_MS, "no fingerprint change => no reset");
});

// ===========================================================================
// P4 — FIX-PACKET COMPLETENESS.
// Every failing agent appears in the launch fix_packet with a non-empty
// fix_command naming the EXACT manifest path + missing tools; every passing
// agent is absent. Proven over the all-fail case (3 distinct roles failing) and
// the one-fail case. Also covers the runtime capabilityGapFixPacket (the
// alert_no_ship variant) carrying the same completeness.
// ===========================================================================
test("property P4a — LAUNCH fix_packet: every failing agent appears with a non-empty fix_command naming manifest + missing tools; every passing agent is absent", () => {
  // Mixed: deployer fails (missing edit), reviewer passes, runner fails (no bash).
  const result = gateFor({
    "ci-deployer-1": MANIFESTS["deployer-missing-edit"],
    "ci-reviewer-1": MANIFESTS["reviewer-ok"],
    "ci-runner-1": MANIFESTS["runner-no-bash"],
  });
  assert.equal(result.fix_packet.length, 2, "two failing agents => two fix entries");

  // Every failing agent appears with a non-empty fix_command naming its manifest
  // path AND its missing tools.
  for (const entry of result.fix_packet) {
    assert.ok(
      typeof entry.fix_command === "string" && entry.fix_command.length > 0,
      `[${entry.agent}] fix_command must be non-empty`,
    );
    assert.ok(
      entry.fix_command.includes(entry.manifest_path),
      `[${entry.agent}] fix_command must name the manifest path: ${entry.fix_command}`,
    );
    assert.ok(
      entry.missing_tools.length > 0,
      `[${entry.agent}] a failing agent must name at least one missing tool`,
    );
    for (const tool of entry.missing_tools) {
      assert.ok(
        entry.fix_command.includes(tool),
        `[${entry.agent}] fix_command must name the missing tool '${tool}': ${entry.fix_command}`,
      );
    }
  }

  // The passing agent (reviewer) is ABSENT from the fix_packet.
  const agents = result.fix_packet.map((e) => e.agent);
  assert.ok(!agents.includes("ci-reviewer-1"), "the passing reviewer must NOT appear in fix_packet");
  assert.ok(agents.includes("ci-deployer-1"));
  assert.ok(agents.includes("ci-runner-1"));

  // Exact manifest + missing-tool wiring for the two failing agents.
  const byAgent = new Map(result.fix_packet.map((e) => [e.agent, e]));
  assert.equal(byAgent.get("ci-deployer-1")!.manifest_path, ".ci/agents/ci-deployer-1.json");
  assert.deepEqual([...byAgent.get("ci-deployer-1")!.missing_tools], ["edit"]);
  assert.equal(byAgent.get("ci-runner-1")!.manifest_path, ".ci/agents/ci-runner-1.json");
  assert.deepEqual([...byAgent.get("ci-runner-1")!.missing_tools], ["bash"]);
});

test("property P4b — buildFixPacket (the primitive) yields completeness + empty fix_command on pass", () => {
  // MISSING-TOOL fail (defaultMode is already 'implement', so no mode clause):
  // fix_command names the manifest path + the missing tool, NO defaultMode clause.
  const deployerMissingTool = MANIFESTS["deployer-missing-edit"];
  const missingToolVerdict = compareCapability(deployerMissingTool, DEPLOYER_REQ);
  assert.equal(missingToolVerdict.ok, false);
  assert.equal(missingToolVerdict.kind, "missing_tool");
  const missingToolPacket = buildFixPacket(missingToolVerdict, deployerMissingTool, DEPLOYER_REQ);
  assert.equal(missingToolPacket.agent, "ci-deployer-1");
  assert.equal(missingToolPacket.manifest_path, ".ci/agents/ci-deployer-1.json");
  assert.deepEqual([...missingToolPacket.missing_tools], ["edit"]);
  assert.ok(missingToolPacket.fix_command.length > 0);
  assert.ok(missingToolPacket.fix_command.includes(".ci/agents/ci-deployer-1.json"));
  assert.ok(missingToolPacket.fix_command.includes("edit"));
  assert.equal(
    missingToolPacket.fix_command,
    'add "edit" to .ci/agents/ci-deployer-1.json',
    "a pure missing-tool fail has NO defaultMode clause",
  );

  // MODE-ONLY fail (deployer in plan mode for a writing role): fix_command names
  // the defaultMode clause. Exercises the other fix_command shape.
  const deployerModeFail = MANIFESTS["deployer-plan-mode"];
  const modeVerdict = compareCapability(deployerModeFail, DEPLOYER_REQ);
  assert.equal(modeVerdict.ok, false);
  assert.equal(modeVerdict.kind, "read_only_mode_for_writing_role");
  const modePacket = buildFixPacket(modeVerdict, deployerModeFail, DEPLOYER_REQ);
  assert.ok(modePacket.fix_command.length > 0);
  assert.ok(modePacket.fix_command.includes('defaultMode="implement"'));
  assert.ok(modePacket.fix_command.includes(".ci/agents/ci-deployer-1.json"));

  // Passing verdict => EMPTY fix_command (nothing to fix).
  const deployerOk = MANIFESTS["deployer-ok"];
  const passVerdict = compareCapability(deployerOk, DEPLOYER_REQ);
  assert.equal(passVerdict.ok, true);
  const passPacket = buildFixPacket(passVerdict, deployerOk, DEPLOYER_REQ);
  assert.equal(passPacket.fix_command, "");
  assert.deepEqual([...passPacket.missing_tools], []);
});

test("property P4c — RUNTIME capabilityGapFixPacket: the alert_no_ship fix packet carries the exact manifest + missing tools + required_by", () => {
  // The runtime variant (capabilityGapFixPacket) carries the same completeness:
  // agent + manifest_path + role + missing_tools + modes + required_by +
  // non-empty fix_command. Proven over a runner gap (missing bash).
  const manifest = MANIFESTS["runner-no-bash"];
  const gap = detectCapabilityGap({
    agent: manifest.id,
    requiredAction: "execute the CI job via bash",
    manifest,
    requirement: RUNNER_REQ,
  });
  assert.equal(gap.gap, true);
  const packet = capabilityGapFixPacket(
    gap,
    manifest.id,
    manifest.manifestPath,
    "runner",
    RUNNER_REQ.reasonRef,
  );
  assert.equal(packet.kind, "capability_gap");
  assert.equal(packet.agent, "ci-runner-1");
  assert.equal(packet.manifest_path, ".ci/agents/ci-runner-1.json");
  assert.equal(packet.role, "runner");
  assert.deepEqual([...packet.missing_tools], ["bash"]);
  assert.equal(packet.observed_mode, "implement");
  assert.equal(packet.required_mode, "implement");
  assert.equal(packet.required_by, RUNNER_REQ.reasonRef);
  assert.ok(packet.fix_command.length > 0, "fix_command must be non-empty");
  assert.ok(packet.fix_command.includes(".ci/agents/ci-runner-1.json"));
  assert.ok(packet.fix_command.includes("bash"));
});

// ===========================================================================
// DETERMINISM: re-running the same gate call yields the identical result. No
// Math.random, no clock drift affecting the verdict (the verdict is pure over
// (contract, agentIds)). This guards against any future flakiness.
// ===========================================================================
test("property DETERMINISM — identical (contract, manifests) => identical result across repeated calls", () => {
  const store: Record<string, AgentManifest> = {
    "ci-deployer-1": MANIFESTS["deployer-missing-edit"],
    "ci-reviewer-1": MANIFESTS["reviewer-ok"],
    "ci-runner-1": MANIFESTS["runner-no-bash"],
  };
  const results: ReturnType<typeof runCapabilityGate>[] = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(gateFor({ ...store }));
  }
  // Every call yields the same ok / shouldStart / fix_packet shape.
  for (let i = 1; i < results.length; i += 1) {
    assert.equal(results[i].ok, results[0].ok);
    assert.equal(results[i].shouldStart, results[0].shouldStart);
    assert.equal(results[i].fix_packet.length, results[0].fix_packet.length);
    assert.deepEqual(
      results[i].fix_packet.map((e) => e.agent),
      results[0].fix_packet.map((e) => e.agent),
    );
  }
  assert.equal(results[0].ok, false);
  assert.equal(results[0].shouldStart, false);
  assert.equal(results[0].fix_packet.length, 2);
});
