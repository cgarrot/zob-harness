// WS-CH2 (capability-validation PART II): the launch-time capability gate
// `runCapabilityGate`. Proves the fail-closed-by-construction invariant
// (shouldStart === ok, with NO opt-out), the read-manifest-once + re-evaluate
// flow, idempotent re-runnability (flip the manifest and re-call — no stale
// memoization), the one-failure-still-blocks rule, and that the verdict is pure
// over (contract, agentIds). Read+test only: a fresh toy CapabilityContract
// (reducerId='toy-cap-gate', distinct from the WS-CH1 'toy-cap') is invented here
// and dispatches to the PURE primitive compareCapability; NO transposer
// validate-agent-capabilities.mjs body is copied.
//
// NOTE: the gate's option/result types are exported from index.ts under the
// aliased names CapabilityLaunchGateOptions / CapabilityLaunchGateResult (the
// environment pillar already exports LaunchGateOptions / LaunchGateResult, so the
// capability gate aliases to avoid the name collision).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  compareCapability,
  runCapabilityGate,
  registerCapabilityContract,
  type AgentManifest,
  type CapabilityContract,
  type CapabilityLaunchGateOptions,
  type CapabilityLaunchGateResult,
  type RoleRequirement,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- the live bug, as a fake manifest data structure (metadata-only) ---------
// bootstrap-lead: defaultMode 'plan' (read-only) + allowedTools omitting bash
// (the phase_lead protocol requires bash to run transposer-handoff.mjs). This is
// the manifest that stalled pi-rust-env-relaunch-20260614T074416Z for ~2h.
const BOOTSTRAP_LEAD_BUG: AgentManifest = {
  id: "bootstrap-lead",
  role: "phase_lead",
  defaultMode: "plan",
  allowedTools: ["read", "grep", "find", "ls"],
  manifestPath: ".pi/zagents/bootstrap-lead.json",
};

// A PASSING phase_lead: implement mode + bash present (the post-fix manifest).
const INGESTION_LEAD_OK: AgentManifest = {
  id: "ingestion-lead",
  role: "phase_lead",
  defaultMode: "implement",
  allowedTools: ["read", "bash", "edit", "grep", "find"],
  manifestPath: ".pi/zagents/ingestion-lead.json",
};

// The post-fix bootstrap-lead (the WS-C3 manifest edit: set defaultMode="implement"
// and add "bash").
const BOOTSTRAP_LEAD_FIXED: AgentManifest = {
  id: "bootstrap-lead",
  role: "phase_lead",
  defaultMode: "implement",
  allowedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  manifestPath: ".pi/zagents/bootstrap-lead.json",
};

// A passing oracle + a failing oracle (missing 'grep') — used for the distinct
// one-failure-still-blocks scenario that exercises the oracle requirement path.
const ORACLE_OK: AgentManifest = {
  id: "good-oracle",
  role: "oracle",
  defaultMode: "plan",
  allowedTools: ["read", "grep", "find"],
  manifestPath: ".pi/zagents/good-oracle.json",
};
const ORACLE_MISSING_GREP: AgentManifest = {
  id: "bad-oracle",
  role: "oracle",
  defaultMode: "plan",
  allowedTools: ["read", "find"],
  manifestPath: ".pi/zagents/bad-oracle.json",
};

// --- the role requirements (metadata-only) ----------------------------------
const PHASE_LEAD_REQ: RoleRequirement = {
  requiredTools: ["bash"],
  requiredMode: "implement",
  reasonRef: "test",
};

const ORACLE_REQ: RoleRequirement = {
  requiredTools: ["read", "grep"],
  requiredMode: "any",
  reasonRef: "test",
};

// --- a toy CapabilityContract (reducerId='toy-cap-gate') --------------------
// evaluateCapability delegates to the PURE compareCapability (the single site of
// capability satisfaction per the WS-CH1 contract). readManifest reads from a
// mutable module-level `store` so each test controls the observed manifests
// deterministically AND re-runnability is provable by mutating the store between
// calls (the gate re-reads on every call — no memoization). requirements()
// returns the two-role body.
const TOY_CAP_GATE_ID = "toy-cap-gate";

let store: Record<string, AgentManifest> = {};

const toyGateContract: CapabilityContract = {
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
    };
  },
};
registerCapabilityContract(TOY_CAP_GATE_ID, toyGateContract);

// ===========================================================================
// (a) ONE failing agent: bootstrap-lead (phase_lead, plan mode, no bash) fails
//     its role contract; ingestion-lead (phase_lead, implement, bash) passes.
//     => shouldStart===false, ok===false, fix_packet has exactly 1 entry (the
//     failing agent), carrying the metadata-only fix_command naming the manifest.
// ===========================================================================
test("capability-launch-gate (a): one failing agent => shouldStart===false, ok===false, fix_packet.length===1", () => {
  store = {
    "bootstrap-lead": BOOTSTRAP_LEAD_BUG,
    "ingestion-lead": INGESTION_LEAD_OK,
  };
  // The aliased option type is imported to prove the WS-CH2 export resolves.
  const options: CapabilityLaunchGateOptions = {};
  const result = runCapabilityGate(
    toyGateContract,
    ["bootstrap-lead", "ingestion-lead"],
    options,
  );

  assert.equal(result.ok, false, "ok must be false when one agent fails its role contract");
  assert.equal(result.shouldStart, false, "shouldStart must be false (fail-closed)");
  assert.equal(result.fix_packet.length, 1, "exactly one fix_packet entry (the failing agent)");
  assert.equal(result.verdicts.length, 2, "both agents with a role requirement are evaluated");

  const entry = result.fix_packet[0];
  assert.equal(entry.agent, "bootstrap-lead");
  assert.equal(entry.role, "phase_lead");
  assert.deepEqual([...entry.missing_tools], ["bash"]);
  assert.equal(entry.observed_mode, "plan");
  assert.equal(entry.required_mode, "implement");
  assert.ok(
    typeof entry.fix_command === "string" && entry.fix_command.length > 0,
    `fix_command must be a non-empty string: ${JSON.stringify(entry.fix_command)}`,
  );
  assert.ok(
    entry.fix_command.includes("bootstrap-lead.json"),
    `fix_command must name the manifest path: ${entry.fix_command}`,
  );
  assert.ok(
    entry.fix_command.includes("bash"),
    `fix_command must name the missing tool: ${entry.fix_command}`,
  );
});

// ===========================================================================
// (b) ALL passing: both phase_leads satisfy the role contract (implement + bash).
//     => shouldStart===true, ok===true, fix_packet empty.
// ===========================================================================
test("capability-launch-gate (b): all passing => shouldStart===true, ok===true, fix_packet empty", () => {
  store = {
    "bootstrap-lead": BOOTSTRAP_LEAD_FIXED,
    "ingestion-lead": INGESTION_LEAD_OK,
  };
  const result = runCapabilityGate(toyGateContract, ["bootstrap-lead", "ingestion-lead"]);

  assert.equal(result.ok, true, "ok must be true when every agent satisfies its role contract");
  assert.equal(result.shouldStart, true, "shouldStart must be true (nothing blocks)");
  assert.equal(result.fix_packet.length, 0, "fix_packet must be empty when ok");
  assert.equal(result.verdicts.length, 2, "both agents are still evaluated");
  for (const v of result.verdicts) {
    assert.equal(v.ok, true);
  }
});

// ===========================================================================
// (c) RE-RUNNABILITY / IDEMPOTENCE: call runCapabilityGate with the BUG manifest
//     (shouldStart===false), then mutate the SAME store to the FIXED manifest and
//     re-call with the SAME contract. The second call must re-read the now-fixed
//     manifest (shouldStart===true) — proves NO stale memoization across calls,
//     which is what makes "edit manifest → re-launch" work without a special path.
// ===========================================================================
test("capability-launch-gate (c): flipping the manifest on re-call flips shouldStart (no stale memoization)", () => {
  // First call: the live bug — shouldStart===false.
  store = { "bootstrap-lead": BOOTSTRAP_LEAD_BUG };
  const failing = runCapabilityGate(toyGateContract, ["bootstrap-lead"]);
  assert.equal(failing.ok, false);
  assert.equal(failing.shouldStart, false);
  assert.equal(failing.fix_packet.length, 1);

  // Mutate the SAME store (the contract's readManifest reads it live) and re-call
  // with the SAME contract. A fresh re-read + re-evaluate must observe the fix.
  store["bootstrap-lead"] = BOOTSTRAP_LEAD_FIXED;
  const flipped = runCapabilityGate(toyGateContract, ["bootstrap-lead"]);
  assert.equal(flipped.ok, true, "re-call over the fixed manifest must observe the fix");
  assert.equal(flipped.shouldStart, true, "re-call must allow start after the manifest edit");
  assert.equal(flipped.fix_packet.length, 0);
});

// ===========================================================================
// (d) ONE-FAILURE-STILL-BLOCKS (distinct scenario, oracle path): a passing
//     phase_lead alongside a failing oracle (oracle role, missing 'grep'). Any
//     single failure blocks start. => shouldStart===false, fix_packet.length===1.
//     Exercises the oracle requirement (requiredMode 'any') so the test is
//     distinct from (a)'s phase_lead missing-tool failure.
// ===========================================================================
test("capability-launch-gate (d): one failing oracle still blocks start (shouldStart===false)", () => {
  store = {
    "ingestion-lead": INGESTION_LEAD_OK,
    "bad-oracle": ORACLE_MISSING_GREP,
    "good-oracle": ORACLE_OK,
  };
  const result = runCapabilityGate(
    toyGateContract,
    ["ingestion-lead", "bad-oracle", "good-oracle"],
  );

  assert.equal(result.verdicts.length, 3, "all three agents with a role requirement are evaluated");
  assert.equal(result.ok, false, "ok is false because one agent (bad-oracle) fails");
  assert.equal(result.shouldStart, false, "a single failure blocks start (fail-closed)");
  assert.equal(result.fix_packet.length, 1, "exactly one fix_packet entry for the single failure");
  assert.equal(result.fix_packet[0].agent, "bad-oracle");
  assert.equal(result.fix_packet[0].role, "oracle");
  assert.deepEqual([...result.fix_packet[0].missing_tools], ["grep"]);
});

// ===========================================================================
// (e) FAIL-CLOSED-BY-CONSTRUCTION (the headline): there is NO parameter to make
//     shouldStart diverge from ok. Assert the invariant shouldStart === ok for
//     the failing, passing, and one-failure cases — it is derived from ok, never
//     set independently. The aliased CapabilityLaunchGateResult type is imported
//     to prove the WS-CH2 export resolves.
// ===========================================================================
test("capability-launch-gate (e): shouldStart === ok in every case (fail-closed by construction, no opt-out)", () => {
  store = {
    "bootstrap-lead": BOOTSTRAP_LEAD_BUG,
    "ingestion-lead": INGESTION_LEAD_OK,
  };
  const failing: CapabilityLaunchGateResult | Promise<CapabilityLaunchGateResult> =
    runCapabilityGate(toyGateContract, ["bootstrap-lead", "ingestion-lead"]);

  store = {
    "bootstrap-lead": BOOTSTRAP_LEAD_FIXED,
    "ingestion-lead": INGESTION_LEAD_OK,
  };
  const passing: CapabilityLaunchGateResult | Promise<CapabilityLaunchGateResult> =
    runCapabilityGate(toyGateContract, ["bootstrap-lead", "ingestion-lead"]);

  store = {
    "ingestion-lead": INGESTION_LEAD_OK,
    "bad-oracle": ORACLE_MISSING_GREP,
  };
  const oneFail: CapabilityLaunchGateResult | Promise<CapabilityLaunchGateResult> =
    runCapabilityGate(toyGateContract, ["ingestion-lead", "bad-oracle"]);

  // The readManifest is sync, so all three return synchronous results (not
  // Promises). The invariant holds in both directions: failing (ok false →
  // shouldStart false) and passing (ok true → shouldStart true). runCapabilityGate
  // exposes no option that could break this — there is no `allowStart`, `force`,
  // or `skip`.
  assert.ok(!(failing instanceof Promise), "sync readManifest must yield a synchronous result");
  assert.ok(!(passing instanceof Promise));
  assert.ok(!(oneFail instanceof Promise));

  assert.equal(failing.ok, false);
  assert.equal(failing.shouldStart, failing.ok, "shouldStart must equal ok (failing case)");
  assert.equal(passing.ok, true);
  assert.equal(passing.shouldStart, passing.ok, "shouldStart must equal ok (passing case)");
  assert.equal(oneFail.shouldStart, oneFail.ok, "shouldStart must equal ok (one-failure case)");
  assert.equal(oneFail.shouldStart, false);
});
