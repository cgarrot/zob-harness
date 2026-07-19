# Wheel ZOB Schemas

**Status:** Design and bounded-runtime contracts. Current Wheel intake consumes story and source-bound machine-bundle contracts; selected-machine launch, local-session state, PR-handoff, and governed zcommit receipt schemas are also implemented locally. Other schemas remain implementation/pilot designs unless their individual docs say otherwise.

| Schema | Purpose |
|---|---|
| `mission.schema.json` | Mission admission/policy/completion contract |
| `mission-event.schema.json` | Body-safe hash-chained event envelope |
| `story-execution.schema.json` | Canonical story execution manifest |
| `fleet-v5-machine-bundle.schema.json` | Source-bound machine assignments from allocation units to explicit story manifests |
| `fleet-v5-local-machine-launch-plan.schema.json` | Immutable owner-selected machine set and local-only authority boundary |
| `fleet-v5-local-machine-launch-state.schema.json` | Hash-chained machine claim/session/recovery state |
| `fleet-v5-pr-handoff-candidate.schema.json` | Exact pre/post-commit workspace candidate with forbidden-ref gates |
| `fleet-v5-pr-handoff-authority.schema.json` | Expiring candidate/head/action authority with merge/deploy denied |
| `fleet-v5-pr-handoff-commit-receipt.schema.json` | Candidate/authority/zcommit-bound resulting commit lineage |
| `zcommit-receipt.schema.json` | Generic body-free governed commit receipt consumed by Wheel commit recording |
| `execution-profile.schema.json` | Base/overlay profile composition and controls |
| `gate.schema.json` | Gate entry/task/exit/review contract |
| `task.schema.json` | Task lineage/dependency/permission/validation contract |
| `evidence.schema.json` | Source-bound task/gate/factory evidence |
| `pr-close-evidence.schema.json` | Exact-head gate/CI/three-auditor close evidence |
| `ack-receipt.schema.json` | Authenticated human decision/ACK receipt |
| `model-attempt.schema.json` | Protected exact model/prompt attempt telemetry |
| `blind-review-result.schema.json` | Formal R-review round/finding verdict |
| `merge-authorization.schema.json` | Legacy direct-base exact-head batch authorization (not Wheel v1 ordinary PR flow) |
| `staging-candidate.schema.json` | Human-started window, versioned candidate/repair ancestry and exact staging/develop integration proof |
| `source-doc-coverage.schema.json` | Exhaustive every-element disposition and canonical-doc mapping |
| `repository-assurance-result.schema.json` | Ten-lane/top-down/bottom-up exact-head assurance verdict |
| `assurance-repair-round.schema.json` | Separate round-1/2 repair PR/full-CI/fresh-next-audit lineage (no repair after round 3) |
| `promotion-authorization.schema.json` | Separate human exact-head merge-commit/deployment-impact authorization |
| `promotion-merge-evidence.schema.json` | Promotion parents/tree/CD correlation/reconciliation/staging alignment and aligned-head CI |
| `checkpoint.schema.json` | Portable body-safe mission checkpoint |

## Rules

- JSON Schema draft 2020-12.
- IDs and SHA-256 values are full length.
- Record hashes use RFC 8785 JSON Canonicalization Scheme bytes and SHA-256. Before hashing, omit only the record's own terminal hash field (for nested candidate artifacts, omit `artifactHashes.candidate`); referenced prior/input hashes remain included. This avoids self-reference and makes every receipt/candidate/result digest reproducible.
- Every appended runtime event/checkpoint/evidence/receipt record requires `bodyStored: false`. Static manifest templates (`execution-profile`, `gate`, `story-execution`, `task`) define work rather than journal records and intentionally omit the field.
- Raw prompts, outputs, diffs, credentials and transcripts are forbidden.
- Schemas are versioned; unknown required versions fail closed.
- Active Wheel ordinary PRs use `develop-staging`; only typed `promotion-authorization.v1` may authorize the audited merge-commit into `develop`.
- Legacy direct-base schemas/tokens are read-only migration inputs; the Wheel adapter rejects them for new missions, Checks and effects.
- Cross-field arithmetic/equality/role-separation checks that JSON Schema cannot express are mandatory semantic-validator rules.
- Examples live in [`../examples/`](../examples/README.md).

Implementation may split reusable definitions into `$defs`; these standalone design versions favor auditability.