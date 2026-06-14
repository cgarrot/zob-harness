# Environment domain (`src/domains/environment/`)

WS-PH1 keystone of the environment-precondition extraction (PART II). The FOURTH
harness pillar alongside `computeWorklist` (Round 2) and `EvidenceContract`
(Round 3): a typed `EnvironmentContract` + registry + PURE check primitives that
shift environmental preconditions (non-empty target, missing pinned toolchain,
missing command, non-writable path) from late phase-execution discovery to an early
fail-closed launch gate every consumer gets for free.

## Shape provenance

- `Precondition` / `PreconditionVerdict` / `EnvironmentSnapshot` / `CheckPhase` /
  `PreconditionKind` mirror the project-transposer `validate-environment.mjs`
  JSDoc typedefs (PART I, planned) adapted to TS interfaces (camelCase harness
  convention). `EnvironmentContract` + the `registerEnvironmentContract` /
  `resolveEnvironmentContract` / `listEnvironmentContractIds` Map registry mirror
  `evidence-contract.ts` (Round 3) EXACTLY.
- The registry is keyed by `reducerId` (projects register under their `reducer_id`;
  the transposer registers `reducerId='project-transposer'` in WS-PH4). A missing
  contract resolves to `undefined` (typed-missing, NOT a silent default) — a
  plan-specified divergence from `resolveEvidenceContract`'s throw.

## Purity contract (headline acceptance)

- `primitives.ts` imports NO `node:fs`, NO `node:child_process`, NO
  `spawnSync`/`readdirSync`/`exec`. It is PURE over the `EnvironmentSnapshot`
  parameter (the ONLY IO). The real IO (readdir / rustup / which / access) lives
  entirely in the project-registered `snapshotEnvironment` (WS-PH4), never here.
- `types.ts` + `environment-contract.ts` import ONLY `src/core/**` + siblings
  (`./types.js`, `../worklist/types.js` for `FORBIDDEN_PLAINTEXT_KEYS`). No runtime;
  no `@earendil-works/pi-coding-agent`. This keeps the domain reusable by
  transposer/pacman-style projections.

## MUST DO

- Keep the contract SHAPE-ONLY; the body (`evaluatePrecondition` dispatch +
  `snapshotEnvironment` IO) is project-registered. The snapshot reader is the only
  IO. Primitives stay pure over the snapshot. Metadata-only / body-free /
  network-disabled: paths, counts, channel names, command strings only.

## MUST NOT

- No `node:fs` / `node:child_process` (or `spawnSync`/`readdirSync`/`exec`) in
  `primitives.ts`. No raw bodies/prompts/diffs/secrets in any precondition or
  verdict. No network. No change to the worklist domain (read-only import of
  `FORBIDDEN_PLAINTEXT_KEYS`).

## Files

- `types.ts` — `PreconditionKind`, `CheckPhase`, `Precondition`,
  `PreconditionVerdict`, `EnvironmentSnapshot` (all readonly, metadata-only).
- `environment-contract.ts` — `EnvironmentContract`, `PreconditionScope`,
  `registerEnvironmentContract` / `resolveEnvironmentContract` /
  `listEnvironmentContractIds` Map registry, `environmentBodyFreeViolations`.
- `primitives.ts` — `dirEmpty`, `toolchainInstalled`, `commandPresent`,
  `pathWritable` (PURE over `EnvironmentSnapshot`; result interfaces exported).

## Validation

- `npx tsc --noEmit` clean; `node --import tsx --test "test/environment/*"` green.
- `grep -nE 'node:fs|node:child_process|spawnSync|readdirSync' .../primitives.ts`
  returns NOTHING (the purity proof).
