# Capability domain (`src/domains/capability/`)

WS-CH1 keystone of the capability-validation extraction (PART II). The FIFTH
harness pillar alongside `computeWorklist` (Round 2), `EvidenceContract`
(Round 3), and `EnvironmentContract` (Round 4): a typed `CapabilityContract` +
registry + PURE check primitives that shift agent-capability validation (an
agent's `allowedTools`/`defaultMode` vs the protocol's per-role required tools)
from late runtime discovery (a stall + 59 nudge-spams when a structurally
incapable agent is launched) to an early fail-closed launch gate every consumer
gets for free.

## Shape provenance

- `AgentManifest` / `RoleRequirement` / `CapabilityVerdict` / `CapabilityContract`
  mirror the WS-CH1 plan signatures (adapted JSDoc typedefs -> TS interfaces;
  camelCase harness convention) verbatim. `registerCapabilityContract` /
  `resolveCapabilityContract` / `listCapabilityContractIds` Map registry mirrors
  `environment-contract.ts` (Round 4) EXACTLY.
- The registry is keyed by `reducerId` (projects register under their
  `reducer_id`; the transposer registers `reducerId='project-transposer'` in
  WS-CH3). A missing contract resolves to `undefined` (typed-missing, NOT a
  silent default) — same plan-specified divergence as `resolveEnvironmentContract`.

## Purity contract (headline acceptance)

- `primitives.ts` imports NO `node:fs`, NO `node:child_process`, NO
  `spawnSync`/`readdirSync`/`readFileSync`/`exec`. It is PURE over the
  `AgentManifest` / `RoleRequirement` / `CapabilityVerdict` data structures the
  caller passes (the ONLY IO seam is the project-registered `readManifest`, which
  the harness never calls — it is a signature only in CH1).
- `types.ts` + `capability-contract.ts` import ONLY `src/core/**` + siblings
  (`./types.js`, `../worklist/types.js` for `FORBIDDEN_PLAINTEXT_KEYS`). No
  runtime; no `@earendil-works/pi-coding-agent`. This keeps the domain reusable by
  transposer/pacman-style projections.

## MUST DO

- Keep the contract SHAPE-ONLY; the body (`evaluateCapability` dispatch +
  `readManifest` IO + the role->required-tools map) is project-registered.
  `readManifest` is the ONLY IO and is project-supplied (the harness defines the
  signature only). Primitives stay pure over the inputs. Metadata-only /
  body-free / network-disabled: agent ids, tool names, mode names, manifest paths,
  fixCommand strings only.

## MUST NOT

- No `node:fs` / `node:child_process` (or `spawnSync`/`readdirSync`/`exec`) in
  `primitives.ts`. No raw bodies/prompts/diffs/secrets in any manifest,
  requirement, verdict, or fix packet. No network. No change to the worklist or
  environment domains (read-only import of `FORBIDDEN_PLAINTEXT_KEYS`).
- **CRITICAL SAFETY DIVERGENCE from Round 4**: NO auto-resolve method on the
  contract (no `applyAutoResolve`, no auto-fix). Editing a ZAgent manifest changes
  an agent's authority (allowedTools/defaultMode) = SECURITY-SENSITIVE = always
  operator-gated, unlike Round 4's reversible environment auto-resolve. The
  contract evaluates + surfaces a fix packet; applying the edit is app/operator-side.

## Files

- `types.ts` — `RoleName`, `AgentManifest`, `RoleRequirement`, `CapabilityVerdict`
  (all readonly, metadata-only).
- `capability-contract.ts` — `CapabilityContract`, `registerCapabilityContract` /
  `resolveCapabilityContract` / `listCapabilityContractIds` Map registry,
  `capabilityBodyFreeViolations`.
- `primitives.ts` — `manifestHasTool`, `modePermitsWrite`, `requiredToolsForRole`,
  `compareCapability`, `buildFixPacket` (PURE over the inputs; result interface
  `CapabilityFixPacketEntry` exported).

## Validation

- `npm run check -- --pretty false` clean; `node --import tsx --test "test/capability/*"` green.
- `grep primitives.ts for direct fs / process-spawn / exec tokens` returns
  NOTHING (the purity proof).
