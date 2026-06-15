// ZOB Harness — Agent capability validation primitives (WS-CH1 keystone).
//
// The PURE building blocks every capability check composes:
// manifestHasTool / modePermitsWrite / requiredToolsForRole / compareCapability /
// buildFixPacket. Each is PURE over its inputs (AgentManifest / RoleRequirement /
// CapabilityVerdict are DATA STRUCTURES the caller passes — the contract's
// project-registered readManifest does the IO, never here). These are the thing
// reinvented per-project today (and skipped — the root defect); promoting them
// here means every consumer (transposer, pacman, ...) gets the same building
// blocks for free, the same way environment primitives (dirEmpty /
// toolchainInstalled / ...) were promoted in WS-PH1.
//
// PURITY CONTRACT (the headline acceptance of WS-CH1, inherited from the WS-PH1
// environment-primitives precedent): this module performs NO direct filesystem
// access and NO process spawning. It imports ONLY type-only (erased at runtime)
// from ./types.js + ./capability-contract.js. The real IO (reading
// .pi/zagents/<id>.json into an AgentManifest) lives ENTIRELY in the
// project-registered `readManifest` implementation (WS-CH3), never here. This
// makes the matrix tests runnable without any real disk. (The purity grep over
// this file — scanning for direct fs / process-spawn / exec tokens — returns
// NOTHING; this module performs no IO whatsoever.)
//
// Metadata-only / body-free / network-disabled: every return value carries agent
// ids, tool names, mode names, manifest paths, and fixCommand strings only — no
// prompt bodies, no secrets.
import type { CapabilityContract } from "./capability-contract.js";
import type {
  AgentManifest,
  CapabilityVerdict,
  RoleName,
  RoleRequirement,
} from "./types.js";

// --- The write tools (the capability-axis primitive) ------------------------
// A tool name that performs a write action. A role whose requiredTools includes
// any of these must have a defaultMode that permits write execution (implement or
// edit); plan mode is read-only and structurally cannot produce the write the
// protocol requires (the live bug: bootstrap-lead plan-mode + required bash).
const WRITE_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "write"]);

// --- Fix packet entry (the metadata-only remediation shape) -----------------
// Mirrors the environment FixPacketEntry (launch-gate.ts) snake_case convention
// and the plan's WS-C4 capability-gap fix-packet shape: one entry per failing
// agent, carrying the exact operator-runnable fix. Metadata-only: no bodies, no
// secrets, no `allowedPaths` contents. `alternative` is the optional routing
// alternative (e.g. "route phase:X ledger recording to a bash-capable agent").
export interface CapabilityFixPacketEntry {
  readonly role: string;
  readonly agent: string;
  readonly manifest_path: string;
  readonly missing_tools: readonly string[];
  readonly observed_mode: string;
  readonly required_mode: string;
  readonly fix_command: string;
  readonly alternative?: string;
  /** Safe repo-relative pointer to where the requirement is documented. */
  readonly reason_ref?: string;
}

/**
 * manifestHasTool: does `manifest.allowedTools` include `tool`? PURE over the
 * manifest data structure — no IO. The building block for the missing_tool check.
 */
export function manifestHasTool(manifest: AgentManifest, tool: string): boolean {
  return manifest.allowedTools.includes(tool);
}

/**
 * modePermitsWrite: does `mode` permit write execution? Returns true iff mode is
 * 'implement' or 'edit'. 'plan' is read-only (structurally cannot produce a write
 * the protocol requires). PURE — no IO. The building block for the
 * read_only_mode_for_writing_role check.
 */
export function modePermitsWrite(mode: string): boolean {
  return mode === "implement" || mode === "edit";
}

/**
 * requiredToolsForRole: look up a role's required tool set on a registered
 * contract. Returns `contract.requirements()[role]?.requiredTools ?? []` — an
 * empty array when the role is unknown (so a contract without a requirement for a
 * role is permissive, not blocking; the launch gate WS-CH2 will warn on unknown
 * roles). PURE over the contract's requirements() projection — no IO.
 */
export function requiredToolsForRole(contract: CapabilityContract, role: RoleName): readonly string[] {
  const requirement = contract.requirements()[role];
  return requirement ? requirement.requiredTools : [];
}

/**
 * compareCapability: the CANONICAL pure capability evaluation over
 * (manifest, requirement). Single site of the missing_tool + read_only_mode checks:
 *   (1) missingTools = requiredTools.filter(!manifestHasTool) ;
 *   (2) writeToolRequired = requiredTools.some(WRITE_TOOLS) ;
 *       modeFails = writeToolRequired && requiredMode !== 'any' &&
 *                    !modePermitsWrite(manifest.defaultMode) ;
 *   (3) kind: 'missing_tool' if missingTools non-empty (the primary actionable
 *       gap — fix the missing tool first), else 'read_only_mode_for_writing_role'
 *       if modeFails, else 'pass' ;
 *   (4) ok = missingTools empty && !modeFails ;
 *   (5) fixCommand: the exact operator-runnable command built from the manifest
 *       path + missing tools + required mode (empty on pass) ;
 * observedMode/requiredMode are ALWAYS populated so a downstream reader can see
 * the mode gap even when kind='missing_tool' (the live bug has BOTH: missing bash
 * AND plan mode — both surface in the verdict). PURE — no IO. No auto-resolve.
 */
export function compareCapability(
  manifest: AgentManifest,
  requirement: RoleRequirement,
): CapabilityVerdict {
  const observedMode = manifest.defaultMode;
  const requiredMode = requirement.requiredMode;

  // (1) missing tools: requiredTools not covered by allowedTools.
  const missingTools = requirement.requiredTools.filter(
    (tool) => !manifestHasTool(manifest, tool),
  );

  // (2) write-mode check: a role that requires a write tool must have a
  //     write-permitting defaultMode. requiredMode 'any' opts out (read-only roles).
  const writeToolRequired = requirement.requiredTools.some((tool) => WRITE_TOOLS.has(tool));
  const modeFails =
    writeToolRequired &&
    requiredMode !== "any" &&
    !modePermitsWrite(observedMode);

  // (3) kind + ok.
  const ok = missingTools.length === 0 && !modeFails;
  const kind: CapabilityVerdict["kind"] = ok
    ? "pass"
    : missingTools.length > 0
      ? "missing_tool"
      : "read_only_mode_for_writing_role";

  // (4) fixCommand: the exact operator-runnable command. Mirrors the live
  //     bootstrap-lead fix reconstructed by hand in the run's reasoning stream:
  //     `set defaultMode="implement" and add "bash" to .pi/zagents/<id>.json`.
  //     Empty on pass (no fix needed). PURE — built only from manifest + requirement.
  const fixCommand = buildCapabilityFixCommand(manifest, missingTools, modeFails, requiredMode);

  return {
    ok,
    missingTools,
    observedMode,
    requiredMode,
    fixCommand,
    kind,
  };
}

/**
 * buildFixPacket: shape the metadata-only fix packet entry from a verdict + the
 * manifest + the requirement that produced it. PURE — no IO. The launch gate
 * (WS-CH2) emits one entry per failing agent; this primitive shapes it. Carries
 * role/agent/manifest_path/missing_tools/observed_mode/required_mode/fix_command
 * + the optional alternative (routing) + the reason_ref (where the requirement is
 * documented). The fix_command is copied from the verdict (already built by
 * compareCapability) and guaranteed non-empty for a failing verdict.
 */
export function buildFixPacket(
  verdict: CapabilityVerdict,
  manifest: AgentManifest,
  requirement: RoleRequirement,
): CapabilityFixPacketEntry {
  return {
    role: manifest.role,
    agent: manifest.id,
    manifest_path: manifest.manifestPath,
    missing_tools: verdict.missingTools,
    observed_mode: verdict.observedMode,
    required_mode: verdict.requiredMode,
    fix_command: verdict.fixCommand,
    alternative: verdict.alternative,
    reason_ref: requirement.reasonRef,
  };
}

// --- Internal: build the operator-runnable fix command (pure) ---------------
// Mirrors the live bootstrap-lead fix: `set defaultMode="implement" and add
// "bash","edit","write" to .pi/zagents/<id>.json`. Empty string on pass.
function buildCapabilityFixCommand(
  manifest: AgentManifest,
  missingTools: readonly string[],
  modeFails: boolean,
  requiredMode: string,
): string {
  const clauses: string[] = [];
  if (modeFails) clauses.push(`set defaultMode="${requiredMode}"`);
  if (missingTools.length > 0) clauses.push(`add "${missingTools.join('","')}"`);
  if (clauses.length === 0) return "";
  return `${clauses.join(" and ")} to ${manifest.manifestPath}`;
}
