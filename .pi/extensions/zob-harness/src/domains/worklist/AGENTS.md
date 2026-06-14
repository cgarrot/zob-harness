# Worklist domain (`src/domains/worklist/`)

WS-H1 keystone of the harness liveness-primitive extraction (PART II). A
metadata-only, body-free, network-disabled **blackboard** store + a single
canonical `Directive` type + contentHash, extracted from the proven
`project-transposer` `handoff-state.mjs` worklist and adapted to the harness
record convention.

## Shape provenance

- `directiveHash()` / `buildDirective()` / `Directive` mirror
  `project-transposer/scripts/lib/handoff-state.mjs` EXACTLY: the contentHash is
  `sha256` over canonicalized `{ action, owner, evidence_refs(sorted), deadline }`
  (object literal fixes key order; refs sorted + stringified). The canonical JSON
  keys stay snake_case to match transposer; the TS record fields are camelCase to
  match the harness (`merge-queue.ts`, `workspace-claims.ts`).
- Consumer contract: `directiveHash` excludes `ref` (faithful to
  project-transposer), so distinct work items in the same scope MUST differ on at
  least one hashed field (`action`, `owner`, `evidence_refs`, `deadline`) to avoid
  content-hash collisions; consumers typically use distinct `deadline`, `owner`,
  or `evidence_refs`.
- claim/satisfy mirror the queue-daemon lease/heartbeat/stale-recovery SHAPE
  (`leaseId`, `claimedAt`, `heartbeatAt`, `expiresAt`, `leaseMs`,
  `bodyStored:false`) reimplemented here because `buildQueueLease` is not exported
  and `queue.ts` must not be modified (additive only).
- `FORBIDDEN_PLAINTEXT_KEYS` mirrors `goal-room.ts`; every persisted record carries
  `bodyStored:false`, `promptBodiesStored:false`, `outputBodiesStored:false`,
  `localOnly:true`, `networkEnabled:false`.

## Purity contract

Domain files import **only** from `src/core/**` (+ sibling `./types.js`,
`./reducer-contract.js`). No `src/runtime` or `@earendil-works/pi-coding-agent`
imports. This keeps the domain reusable by transposer/pacman-style projections.

## Files

- `types.ts` — single canonical `Directive` + `directiveHash` (contentHash),
  `WorklistEvent`/`WorklistEventInput`, `WorklistLease`, `WorklistDeps`,
  `ProjectedDirective`, `WorklistProjection`, `WorklistValidation`, schema
  constants, `FORBIDDEN_PLAINTEXT_KEYS`.
- `reducer-contract.ts` — `WorklistReducer` contract
  `{ computeDirectives(events, deps, now) }`, the reducer registry
  (`registerWorklistReducer` / `resolveWorklistReducer`), the built-in
  `genericWorklistReducer` (one directive per due OPEN work item), and
  `buildDirective`.
- `store.ts` — blackboard store: append-only `events.jsonl` + derived
  `directives.json` + `leases.jsonl`; `appendWorklistEvent`, `projectWorklist`,
  `claimWorklistDirective`, `satisfyWorklistDirective` (idempotent),
  `recoverStaleWorklistLeases`, `validateWorklist`, `worklistBodyFreeViolations`,
  guards, and the `openWorklistStore` factory.

## Store layout (`.pi/worklist/<scope>/`)

- `events.jsonl` — append-only blackboard events (hash-only, `bodyStored:false`).
- `leases.jsonl` — append-only claim/satisfy/recovery lease snapshots.
- `directives.json` — derived projection (directive + lease annotation).

## Generic reducer semantics

One Directive per OPEN work item (latest OPEN for a ref with no later CLOSE) that
is **due**: `deadline` is null (immediately actionable) or in the past (overdue).
Real consumers register their own FSM reducer under a project-specific
`reducer_id`; the generic reducer exists so a second consumer works with zero FSM
code.

## Liveness invariants (WS-H1 scope)

- claim/satisfy/delivery are keyed by the contentHash → same directive content is
  a tolerated no-op, never a double action.
- a claimed directive whose lease has expired is recovered (re-queued to open) on
  the next store tick (`recoverStaleWorklistLeases` / automatic on claim).
- `satisfy` is idempotent: double-satisfy returns the existing satisfied lease.
