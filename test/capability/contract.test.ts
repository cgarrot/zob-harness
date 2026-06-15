// WS-CH1 (capability-validation PART II keystone): the typed CapabilityContract
// in domains/capability. This proves the contract shapes, the registry (mirrors
// the EnvironmentContract registry EXACTLY), the body-free enforcement, the
// typed-missing resolve contract, and the PURITY of the primitives over a fake
// manifest data structure (no real disk — the manifest is passed in, never read
// by the harness). Read+test only: no harness source is modified by this test
// beyond registering a toy contract; the toy contract is invented here (distinct
// reducerId='toy-cap'), and NO transposer validate-agent-capabilities.mjs body is
// copied (the transposer body does not exist yet — PART I is not shipped).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildFixPacket,
  capabilityBodyFreeViolations,
  compareCapability,
  listCapabilityContractIds,
  manifestHasTool,
  modePermitsWrite,
  registerCapabilityContract,
  requiredToolsForRole,
  resolveCapabilityContract,
  type AgentManifest,
  type CapabilityContract,
  type CapabilityVerdict,
  type RoleRequirement,
} from "../../.pi/extensions/zob-harness/index.ts";

// --- the EXACT live bug, as a fake manifest data structure (metadata-only) ---
// bootstrap-lead: defaultMode 'plan' (read-only) + an allowedTools list that
// OMITS bash (the protocol requires every phase lead to record lifecycle events
// via `node scripts/transposer-handoff.mjs`, which needs bash). This is the
// manifest that stalled pi-rust-env-relaunch-20260614T074416Z for ~2h. It is a
// pure data structure the caller passes — NO disk read.
const BOOTSTRAP_LEAD_BUG: AgentManifest = {
  id: "bootstrap-lead",
  role: "phase_lead",
  defaultMode: "plan",
  allowedTools: ["read", "grep", "find", "ls", "zpeer_ask", "zob_context_search"],
  manifestPath: ".pi/zagents/bootstrap-lead.json",
};

// --- a PASSING bootstrap-lead (the post-fix manifest, WS-C3) ----------------
// defaultMode 'implement' + bash present — satisfies the phase_lead contract.
const BOOTSTRAP_LEAD_FIXED: AgentManifest = {
  id: "bootstrap-lead",
  role: "phase_lead",
  defaultMode: "implement",
  allowedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  manifestPath: ".pi/zagents/bootstrap-lead.json",
};

// --- the role requirements (the WS-C3 structured contract, metadata-only) ----
const PHASE_LEAD_REQ: RoleRequirement = {
  requiredTools: ["bash"],
  requiredMode: "implement",
  reasonRef: "protocols/handoff.md#receiver-action-contract",
  note: "every phase lead records TASK_ACK/STARTED/PROGRESS/CLAIM via node scripts/transposer-handoff.mjs",
};

const ORACLE_REQ: RoleRequirement = {
  requiredTools: ["read", "grep"],
  requiredMode: "any",
  reasonRef: "protocols/handoff.md#oracle-review",
};

// --- a toy CapabilityContract (reducerId='toy-cap') -------------------------
// Its evaluateCapability dispatches to the pure primitive compareCapability.
// Its requirements() returns the project's role->required-tools body (the
// transposer handoff protocol's structured section, adapted). It is NOT the
// transposer validate-agent-capabilities.mjs body; it only proves the contract +
// registry + primitives shapes compose.
const TOY_CAP_ID = "toy-cap";

const toyContract: CapabilityContract = {
  evaluateCapability(manifest: AgentManifest, requirement: RoleRequirement): CapabilityVerdict {
    return compareCapability(manifest, requirement);
  },
  readManifest(_agentId: string): AgentManifest {
    // Toy reader; the real reader is project-registered (WS-CH3). The harness
    // never calls readManifest itself — it is a signature-only IO seam.
    return BOOTSTRAP_LEAD_BUG;
  },
  requirements() {
    return {
      phase_lead: PHASE_LEAD_REQ,
      oracle: ORACLE_REQ,
    };
  },
};
registerCapabilityContract(TOY_CAP_ID, toyContract);

// ===========================================================================
// (a) The EXACT live bug: bootstrap-lead (plan mode, no bash) => ok===false +
//     BOTH conditions surface (missing bash AND the plan/implement mode mismatch).
//     kind is 'missing_tool' (the primary actionable gap — fix the missing tool
//     first); the mode mismatch is still RECORDED in observedMode/requiredMode so
//     a downstream reader sees both gaps even when one kind wins.
// ===========================================================================
test("capability-contract (a): live bug — plan-mode + no bash => ok===false, BOTH gaps surface", () => {
  const contract = resolveCapabilityContract(TOY_CAP_ID)!;
  const verdict = contract.evaluateCapability(BOOTSTRAP_LEAD_BUG, PHASE_LEAD_REQ);

  // The bug surfaces: the agent is structurally incapable.
  assert.equal(verdict.ok, false);

  // (1) missing-tool condition surfaces: bash is missing.
  assert.deepEqual([...verdict.missingTools], ["bash"]);

  // (2) mode-mismatch condition surfaces: observed plan vs required implement.
  assert.equal(verdict.observedMode, "plan");
  assert.equal(verdict.requiredMode, "implement");

  // kind is the primary actionable gap (missing tool first). Either failure kind
  // is acceptable per the WS-CH1 plan; here missingTools is non-empty so it wins.
  assert.ok(
    verdict.kind === "missing_tool" || verdict.kind === "read_only_mode_for_writing_role",
    `unexpected kind: ${verdict.kind}`,
  );

  // The fix command names the manifest path + the missing tool.
  assert.ok(verdict.fixCommand.length > 0, "fixCommand must be non-empty on failure");
  assert.ok(
    verdict.fixCommand.includes("bootstrap-lead.json"),
    `fixCommand must name the manifest path: ${verdict.fixCommand}`,
  );
  assert.ok(
    verdict.fixCommand.includes("bash"),
    `fixCommand must name the missing tool: ${verdict.fixCommand}`,
  );

  // Contrast: the mode-ONLY fail (bash present, plan mode) surfaces the other kind
  // exclusively — proving both code paths are reachable and distinct.
  const modeOnlyFailing: AgentManifest = {
    ...BOOTSTRAP_LEAD_BUG,
    defaultMode: "plan",
    allowedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  };
  const modeOnlyVerdict = compareCapability(modeOnlyFailing, PHASE_LEAD_REQ);
  assert.equal(modeOnlyVerdict.ok, false);
  assert.deepEqual([...modeOnlyVerdict.missingTools], []);
  assert.equal(modeOnlyVerdict.kind, "read_only_mode_for_writing_role");
  assert.ok(modeOnlyVerdict.fixCommand.includes('defaultMode="implement"'));
});

// ===========================================================================
// (b) Passing manifest: bootstrap-lead (implement mode, bash present) => ok===true,
//     kind 'pass', missingTools [], fixCommand empty.
// ===========================================================================
test("capability-contract (b): fixed manifest (implement + bash) => ok===true, kind 'pass'", () => {
  const contract = resolveCapabilityContract(TOY_CAP_ID)!;
  const verdict = contract.evaluateCapability(BOOTSTRAP_LEAD_FIXED, PHASE_LEAD_REQ);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.kind, "pass");
  assert.deepEqual([...verdict.missingTools], []);
  assert.equal(verdict.fixCommand, "");

  // Oracle (read-only role, requiredMode 'any') passes on a read-only manifest.
  const oracleManifest: AgentManifest = {
    id: "toy-oracle",
    role: "oracle",
    defaultMode: "plan",
    allowedTools: ["read", "grep", "find"],
    manifestPath: ".pi/zagents/toy-oracle.json",
  };
  const oracleVerdict = contract.evaluateCapability(oracleManifest, ORACLE_REQ);
  assert.equal(oracleVerdict.ok, true);
  assert.equal(oracleVerdict.kind, "pass");
});

// ===========================================================================
// (c) Typed-missing resolve: unknown reducerId -> undefined (NOT a silent default;
//     NOT a throw — the WS-CH1 plan signature is CapabilityContract | undefined).
// ===========================================================================
test("capability-contract (c): resolveCapabilityContract('unknown') === undefined (typed-missing)", () => {
  assert.equal(resolveCapabilityContract("does-not-exist"), undefined);
  // Registering a contract missing evaluateCapability is a typed runtime error.
  assert.throws(
    () =>
      // @ts-expect-error -- intentionally invalid contract shape for the runtime guard
      registerCapabilityContract("broken-cap", {
        readManifest() {
          return BOOTSTRAP_LEAD_BUG;
        },
        requirements() {
          return {};
        },
      }),
    /missing evaluateCapability/,
  );
});

// ===========================================================================
// (d) Registry list includes the toy contract.
// ===========================================================================
test("capability-contract (d): listCapabilityContractIds() includes the toy contract", () => {
  const ids = listCapabilityContractIds();
  assert.ok(ids.includes(TOY_CAP_ID), "toy-cap contract must be registered");
});

// ===========================================================================
// (e) capabilityBodyFreeViolations: the body-free posture is enforced on every
//     AgentManifest / RoleRequirement / CapabilityVerdict / fix-packet entry. A
//     forbidden key (prompt/body/task/output/content/message/text/rationale/diff/
//     patch) at ANY depth is rejected; a clean manifest/verdict passes (returns []).
// ===========================================================================
test("capability-contract (e): capabilityBodyFreeViolations rejects forbidden keys and accepts clean values", () => {
  // Clean manifest -> no violations.
  assert.deepEqual(capabilityBodyFreeViolations(BOOTSTRAP_LEAD_BUG), []);
  // Clean verdict -> no violations.
  assert.deepEqual(
    capabilityBodyFreeViolations(compareCapability(BOOTSTRAP_LEAD_BUG, PHASE_LEAD_REQ)),
    [],
  );

  // Forbidden key at the top level of a manifest -> rejected.
  const topForbidden = { ...BOOTSTRAP_LEAD_BUG, prompt: "do the thing" };
  assert.ok(capabilityBodyFreeViolations(topForbidden).length > 0);

  // Forbidden key nested inside a verdict -> rejected (deep scan).
  const verdictForbidden: CapabilityVerdict = {
    ok: false,
    missingTools: ["bash"],
    observedMode: "plan",
    requiredMode: "implement",
    fixCommand: "fix",
    kind: "missing_tool",
    output: "leaked prose",
  };
  const verdictViolations = capabilityBodyFreeViolations(verdictForbidden);
  assert.ok(verdictViolations.length > 0, "a forbidden key nested in a verdict must be rejected");
  assert.ok(
    verdictViolations.some((v) => v.includes("output")),
    `violation path should name the forbidden key: ${verdictViolations.join(", ")}`,
  );
});

// ===========================================================================
// (f) Purity proof: the primitives are deterministic over the PASSED manifest
//     data structure and do NOT touch the real filesystem. They read ONLY the
//     AgentManifest/RoleRequirement inputs. (Structural purity is also proven by
//     grep: primitives.ts has no node:fs / node:child_process / spawnSync /
//     readdirSync / readFileSync / exec(.)
// ===========================================================================
test("capability-contract (f): primitives are pure over the passed manifest (deterministic, no disk IO)", () => {
  // manifestHasTool reflects the PASSED manifest, not the disk.
  assert.equal(manifestHasTool(BOOTSTRAP_LEAD_BUG, "read"), true);
  assert.equal(manifestHasTool(BOOTSTRAP_LEAD_BUG, "bash"), false);
  assert.equal(manifestHasTool(BOOTSTRAP_LEAD_FIXED, "bash"), true);

  // modePermitsWrite is a pure mode classifier.
  assert.equal(modePermitsWrite("plan"), false);
  assert.equal(modePermitsWrite("implement"), true);
  assert.equal(modePermitsWrite("edit"), true);
  assert.equal(modePermitsWrite("custom-mode"), false);

  // requiredToolsForRole reads the contract's requirements() projection.
  const contract = resolveCapabilityContract(TOY_CAP_ID)!;
  assert.deepEqual([...requiredToolsForRole(contract, "phase_lead")], ["bash"]);
  assert.deepEqual([...requiredToolsForRole(contract, "oracle")], ["read", "grep"]);
  // Unknown role -> empty (permissive, not blocking).
  assert.deepEqual([...requiredToolsForRole(contract, "unknown-role")], []);

  // compareCapability is deterministic + reflects ONLY the passed manifest. The
  // fake manifest asserts a bogus manifestPath that does not exist on disk; the
  // result matches the fake regardless of the real filesystem.
  const fakeManifest: AgentManifest = {
    id: "fake",
    role: "phase_lead",
    defaultMode: "plan",
    allowedTools: ["read"],
    manifestPath: "/this/path/does/not/exist/on/disk.json",
  };
  const v1 = compareCapability(fakeManifest, PHASE_LEAD_REQ);
  const v2 = compareCapability(fakeManifest, PHASE_LEAD_REQ);
  assert.deepEqual(v1, v2); // deterministic
  assert.equal(v1.ok, false);
  assert.deepEqual([...v1.missingTools], ["bash"]);
  assert.equal(v1.observedMode, "plan");
  assert.ok(
    v1.fixCommand.includes("/this/path/does/not/exist/on/disk.json"),
    "fixCommand must echo the PASSED manifestPath (proves no disk read)",
  );
});

// ===========================================================================
// (g) buildFixPacket: produces a non-empty fix_command naming the manifest path
//     + missing tools, with role/agent/manifest_path/modes wired from the inputs.
// ===========================================================================
test("capability-contract (g): buildFixPacket shapes a non-empty fix_command naming manifest + missing tools", () => {
  const verdict = compareCapability(BOOTSTRAP_LEAD_BUG, PHASE_LEAD_REQ);
  const packet = buildFixPacket(verdict, BOOTSTRAP_LEAD_BUG, PHASE_LEAD_REQ);

  assert.equal(packet.role, "phase_lead");
  assert.equal(packet.agent, "bootstrap-lead");
  assert.equal(packet.manifest_path, ".pi/zagents/bootstrap-lead.json");
  assert.deepEqual([...packet.missing_tools], ["bash"]);
  assert.equal(packet.observed_mode, "plan");
  assert.equal(packet.required_mode, "implement");

  // Non-empty fix_command naming BOTH the manifest path AND the missing tool.
  assert.ok(packet.fix_command.length > 0, "fix_command must be non-empty for a failing verdict");
  assert.ok(
    packet.fix_command.includes(".pi/zagents/bootstrap-lead.json"),
    `fix_command must name the manifest path: ${packet.fix_command}`,
  );
  assert.ok(
    packet.fix_command.includes("bash"),
    `fix_command must name the missing tool: ${packet.fix_command}`,
  );
  assert.ok(
    packet.fix_command.includes('defaultMode="implement"'),
    `fix_command must name the required mode: ${packet.fix_command}`,
  );

  // reason_ref is surfaced (where the requirement is documented).
  assert.equal(packet.reason_ref, PHASE_LEAD_REQ.reasonRef);

  // The fix_command for the live bug matches the hand-reconstructed fix shape.
  assert.equal(
    packet.fix_command,
    'set defaultMode="implement" and add "bash" to .pi/zagents/bootstrap-lead.json',
  );

  // buildFixPacket on a PASSING verdict yields an empty fix_command (nothing to fix).
  const passVerdict = compareCapability(BOOTSTRAP_LEAD_FIXED, PHASE_LEAD_REQ);
  const passPacket = buildFixPacket(passVerdict, BOOTSTRAP_LEAD_FIXED, PHASE_LEAD_REQ);
  assert.equal(passPacket.fix_command, "");
  assert.deepEqual([...passPacket.missing_tools], []);
});
