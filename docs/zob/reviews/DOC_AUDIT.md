# Full Wheel ZOB Documentation Audit

> **Historical audit only:** this PASS predates the ratified mandatory `develop-staging`, Final Repository Assurance and promotion design. It is superseded for final acceptance and cannot authorize completion. A fresh staging-design audit must replace it.

**Reviewed:** 2026-07-18
**Review mode:** full
**Scope source:** [`SCOPE_MANIFEST.json`](SCOPE_MANIFEST.json)
**Included:** `AGENTS.md`, `README.md`, every Markdown/JSON file under `docs/zob/` except audit outputs
**Excluded:** `docs/zob/reviews/**` (review outputs), `transcripts/**` (local/excluded), pre-existing `investors/**`, `needs-human/**`, `superseded/**`
**Files / lines:** 49 / 3970
**Verification method:** mixed — source/API/command-verified current-state claims; full doc/schema review for approved design; no runtime/live-system validation

## Summary

Four independent lanes read every declared source file fully. Their initial and second-pass reports found no blocker/high issue, several contract/terminology/schema gaps, and low/informational polish items. Every actionable current-branch finding was repaired. Parent mechanical validation then passed schema meta-validation, all examples, semantic negative guards, link/index coverage, stable IDs, scope freshness and privacy/path/secret scans.

**Documentation audit verdict: PASS.**

This does not make the system implemented, validated, installed or activated. The overall goal remains no-ship pending the independent final oracle and the human discussion of `ZOB-ENH-031`/`ZOB-ENH-032`.

## Independent lane evidence

| Lane | Durable report | Full coverage | Result at review time | Final disposition |
|---|---|:---:|---|---|
| Core/factories | [`LANE_CORE_FACTORIES.md`](LANE_CORE_FACTORIES.md) | 8/8 | PASS with one medium/two low | all fixed |
| Runtime/governance | [`LANE_RUNTIME_GOVERNANCE.md`](LANE_RUNTIME_GOVERNANCE.md) | 6/6 plus schema cross-check | PASS with one medium/two low/informational | all fixed |
| Operations/decisions | [`LANE_OPERATIONS_DECISIONS.md`](LANE_OPERATIONS_DECISIONS.md) | 7/7 | PASS with two low | all fixed |
| Schemas/examples | [`LANE_SCHEMAS_EXAMPLES.md`](LANE_SCHEMAS_EXAMPLES.md) | 28/28 | PASS with two low/one info | all actionable items fixed |

## Findings and repairs

| ID | Severity | Finding | Repair / evidence | Status |
|---|---|---|---|---|
| DOC-001 | High (first pass) | Truth class and maturity terminology could be read as competing vocabularies. | `docs/zob/README.md` now defines two dimensions and maps Approved design + Specified + Activation-gated. | fixed |
| DOC-002 | High (first pass) | No canonical mission/task/attempt status contract across TUI/recovery. | Sections 06/07 now define canonical status/outcome/event mappings and health flags. | fixed |
| DOC-003 | Medium | Cross-machine takeover lacked fencing/mutual-exclusion proof. | Section 07 requires prior lease release/expiry and next ownership epoch commit with expected-head protection before effects. | fixed |
| DOC-004 | Medium | Crash-recovered transcript could lack authenticated completion semantics. | Section 07 adds final seal, partial-tail state and verified next sequence. | fixed |
| DOC-005 | Medium | Capability expansion and receipt revocation/supersession underspecified. | Section 08 adds immutable grant revisions, ACK-before-use, append-only revocation, dependent invalidation and remediation rules. | fixed |
| DOC-006 | Medium | Model/prompt seed and Pi effort mapping incomplete. | Section 09 adds domain-separated seed derivation, `off|minimal` exclusion, non-reasoning `default`, requested/actual thinking and mismatch treatment. | fixed |
| DOC-007 | Medium | Prompt/failure tokens drifted from model-attempt schema. | Section 09 now uses exact prompt-mode and complete 18-value failureClass vocabulary including `none`. | fixed |
| DOC-008 | Medium | Execution profiles lacked a normative schema and several overlay examples. | Added execution-profile schema/example and explicit examples for all 15 overlays. | fixed |
| DOC-009 | Medium | Blind Review risk enum/required lane coverage under-enforced. | Unified `low|medium|high|critical`; schema conditionals require control+complete mandatory lanes; negative high/critical tests pass. | fixed |
| DOC-010 | Medium | Blind Review disabled state and critical panel semantics ambiguous. | Section 04 adds disabled config and defines high/critical minimum panel plus stricter critical independence. | fixed |
| DOC-011 | Medium | Existing R/S/skill inventory facts lived under Approved-design headers. | Current-evidence subsection labels and dated source ledger added. | fixed |
| DOC-012 | Medium | Gate 8/post-merge/deployment follow-ons lacked explicit routing. | Section 03 links specified-disabled post-merge (`ENH-022`) and deferred deployment confirmation (`ENH-023`). | fixed |
| DOC-013 | Medium | PR-close `Sol-high` looked provider-specific before capability audit. | It is now explicitly a provider-neutral policy alias unresolved until the gated audit. | fixed |
| DOC-014 | Low | Story, Blind Review and Ship maturity/activation headers/config blocks were asymmetric. | Unified `Maturity / activation` headers and explicit disabled-until-validated Story block. | fixed |
| DOC-015 | Low | `needs_review` and failed-preflight regression wording conflicted with canonical state transitions. | Section 14 uses `needs-review` and requires reservation release to `ready` or terminal blocker. | fixed |
| DOC-016 | Low | Validation plan header could be mistaken for executed evidence. | Section 14 adds explicit plan-state disclaimer. | fixed |
| DOC-017 | Low | Operations/rollback used generic state/telemetry branch names. | Sections 13/15 name `zob-mission-state` and `zob-model-telemetry`. | fixed |
| DOC-018 | Low | Mission forbidden-actions enum omitted a deferred completion action. | Mission schema/example include workflow dispatch and post-deploy confirmation; parity validator passes. | fixed |
| DOC-019 | Low | Evidence invalidation/path/status mappings were incomplete. | Section 11 defines path token, status semantics and post-merge invalidation row. | fixed |
| DOC-020 | Low | Audit scope byte counts became stale during repairs. | `SCOPE_MANIFEST.json` regenerated from final reviewed sources; exact freshness check passes. | fixed |
| DOC-021 | Low | PR #3817 captured SHA could stale. | `ENH-032` says “at design capture,” requires rechecking PR/merge state before promotion, and does not treat the open draft as merged truth. | fixed |

## Verification evidence

Visible final validator output:

```text
PASS scope freshness 49 files / 3970 lines
PASS JSON/meta/example validation 13/13
PASS semantic negative guards
PASS cross-schema/prose enums
PASS local link targets 45
PASS index coverage
PASS stable IDs decisions=102 enhancements=36
PASS privacy/path/secret hygiene
FINAL VALIDATION: PASS
```

Additional negative proofs:

- incomplete `high` and `critical` Blind Review panels are rejected;
- valid medium panel is accepted;
- overlay-kind with a base profile ID is rejected;
- every schema passes Draft 2020-12 meta-validation;
- every example validates against its sibling schema;
- all referenced enhancement IDs resolve;
- no raw absolute local path, forbidden private example name or secret-like material occurs in the 49-file source scope;
- all top-level docs, schemas and examples appear in their indexes;
- all local Markdown link targets resolve.

## Per-file coverage matrix

| File | Lines | Read fully | Lane | Final status |
|---|---:|:---:|---|---|
| `AGENTS.md` | 44 | yes | Core/factories | PASS |
| `README.md` | 14 | yes | Core/factories | PASS |
| `docs/zob/01-SYSTEM_OVERVIEW.md` | 115 | yes | Core/factories | PASS |
| `docs/zob/02-ARCHITECTURE_AND_OWNERSHIP.md` | 160 | yes | Core/factories | PASS |
| `docs/zob/03-STORY_TO_PR_CLOSE_FACTORY.md` | 195 | yes | Core/factories | PASS |
| `docs/zob/04-BLIND_REVIEW_FACTORY.md` | 199 | yes | Core/factories | PASS |
| `docs/zob/05-PR_SHIP_FACTORY.md` | 192 | yes | Core/factories | PASS |
| `docs/zob/06-MISSION_CONTROL_TUI.md` | 185 | yes | Runtime/governance | PASS |
| `docs/zob/07-PERSISTENCE_AND_RECOVERY.md` | 182 | yes | Runtime/governance | PASS |
| `docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md` | 159 | yes | Runtime/governance | PASS |
| `docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md` | 211 | yes | Runtime/governance | PASS |
| `docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md` | 184 | yes | Runtime/governance | PASS |
| `docs/zob/11-EVIDENCE_AND_GITHUB_CHECKS.md` | 138 | yes | Runtime/governance | PASS |
| `docs/zob/12-INSTALLATION.md` | 163 | yes | Operations/decisions | PASS |
| `docs/zob/13-OPERATIONS_RUNBOOK.md` | 162 | yes | Operations/decisions | PASS |
| `docs/zob/14-VALIDATION_AND_PILOTS.md` | 171 | yes | Operations/decisions | PASS |
| `docs/zob/15-UPGRADE_AND_ROLLBACK.md` | 108 | yes | Operations/decisions | PASS |
| `docs/zob/16-DECISIONS.md` | 151 | yes | Operations/decisions | PASS |
| `docs/zob/ENHANCEMENTS.md` | 339 | yes | Operations/decisions | PASS |
| `docs/zob/README.md` | 61 | yes | Core/factories | PASS |
| `docs/zob/SOURCE_EVIDENCE.md` | 133 | yes | Operations/decisions | PASS |
| `docs/zob/examples/README.md` | 21 | yes | Schemas/examples | PASS |
| `docs/zob/examples/ack-receipt.example.json` | 16 | yes | Schemas/examples | PASS |
| `docs/zob/examples/blind-review-result.example.json` | 21 | yes | Schemas/examples | PASS |
| `docs/zob/examples/checkpoint.example.json` | 19 | yes | Schemas/examples | PASS |
| `docs/zob/examples/evidence.example.json` | 15 | yes | Schemas/examples | PASS |
| `docs/zob/examples/execution-profile.example.json` | 19 | yes | Schemas/examples | PASS |
| `docs/zob/examples/gate.example.json` | 15 | yes | Schemas/examples | PASS |
| `docs/zob/examples/merge-authorization.example.json` | 24 | yes | Schemas/examples | PASS |
| `docs/zob/examples/mission-event.example.json` | 22 | yes | Schemas/examples | PASS |
| `docs/zob/examples/mission.example.json` | 16 | yes | Schemas/examples | PASS |
| `docs/zob/examples/model-attempt.example.json` | 25 | yes | Schemas/examples | PASS |
| `docs/zob/examples/pr-close-evidence.example.json` | 24 | yes | Schemas/examples | PASS |
| `docs/zob/examples/story-execution.example.json` | 24 | yes | Schemas/examples | PASS |
| `docs/zob/examples/task.example.json` | 22 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/README.md` | 30 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/ack-receipt.schema.json` | 26 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/blind-review-result.schema.json` | 50 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/checkpoint.schema.json` | 22 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/evidence.schema.json` | 24 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/execution-profile.schema.json` | 38 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/gate.schema.json` | 24 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/merge-authorization.schema.json` | 19 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/mission-event.schema.json` | 36 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/mission.schema.json` | 44 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/model-attempt.schema.json` | 28 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/pr-close-evidence.schema.json` | 23 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/story-execution.schema.json` | 27 | yes | Schemas/examples | PASS |
| `docs/zob/schemas/task.schema.json` | 30 | yes | Schemas/examples | PASS |

## Claim classification

- **Code/API/command-verified current facts:** repository privacy/default branch/base commit; source skill/R/S/Ready Guard/model-lab/PR #3817 snapshots; live skill counts/collisions; JSON/schema/link/index/ID/hygiene outputs.
- **Doc-reviewed-only:** all Approved-design architecture, future commands, Apps, branches, factory behavior, profiles, schemas and rollout steps.
- **Not verified / intentionally unresolved:** runtime implementation, provider/model identities/capabilities, App IDs/credentials/permissions, shared branch existence, installations, factory activation, real merges/deployments/live systems.

## Finding routing summary

| Route | Count | Items |
|---|---:|---|
| Fix now/current branch | 21 resolved | DOC-001–DOC-021 |
| Human decision | 2 open proposals | `ZOB-ENH-031`, `ZOB-ENH-032` |
| Roadmap/deferred | 34 | remaining enhancement register entries |
| No-ship blocker in docs | 0 | — |
| Independent final oracle | 1 pending | goal TODO 6 |

## Final audit state

The authored documentation corpus is internally consistent and mechanically valid at this reviewed snapshot. It remains a design specification. Do not promote `develop-staging` or the final assurance factory from proposal status until the requested human discussion occurs, and do not treat this audit as runtime/provider/GitHub/merge/deployment activation evidence.

FINAL: DOC_AUDIT_PASS