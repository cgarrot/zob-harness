# Round 1 Parent Adjudication and Findings

**Boundary:** `round-1/SCOPE_MANIFEST.json` — 66 files / 5768 logical lines / 316746 bytes
**Inputs:** four independent read-only lane reports plus parent cross-contract review
**Verdict:** FAIL pending repair
**no_ship:** true until all findings are repaired and a wholly fresh full audit reads a new frozen manifest

The lane agents reported PASS/WARN with `no_ship=false`, but parent adjudication found exact-head lineage and freeze/repair contradictions that the lanes did not surface. Parent findings govern the repair loop.

| ID | Severity | Evidence | Finding | Route / required repair |
|---|---|---|---|---|
| STG-R1-001 | High | `docs/zob/17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md:51,170`; `docs/zob/05-PR_SHIP_FACTORY.md:62` | Freeze says no PR may merge, while the assurance loop requires repair PRs to merge into the frozen staging branch. | `current_branch_fix`: freeze unrelated merges but allow only active-window, finding-bound repair PRs through all ordinary gates; every repair merge revises the candidate and stales assurance. |
| STG-R1-002 | High | `docs/zob/17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md:77-88`; `schemas/staging-candidate.schema.json:7-17,55`; schema lane §5.4 | The window binds one staging SHA, but expected repair merges change staging. Candidate schema does not distinguish initial frozen SHA from current repaired descendant, and validators do not prove candidate/repair/auth included-PR lineage. | `current_branch_fix`: model initial/current SHA, candidate revision and authorized repair lineage; bind window ACK to initial SHA and promotion ACK to final SHA; enforce candidate+repair PR set and after-repair assurance linkage. |
| STG-R1-003 | High | `docs/zob/17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md:179`; `schemas/assurance-repair-round.schema.json:14,41` | Three assurance rounds are allowed, but schema permits a repair after round 3 while always requiring another re-audit, implying forbidden round 4. | `current_branch_fix`: automatic repair rounds may follow assurance rounds 1–2 only; a blocked round 3 goes directly to needs-human. Add schema/negative guard. |
| STG-R1-004 | Medium | `docs/zob/17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md:220`; `schemas/promotion-merge-evidence.schema.json:47-78` | Post-promotion staging alignment creates a new staging SHA, but queue unfreeze does not require a SHA-bound Staging Integration rebind/rerun for that aligned head. | `current_branch_fix`: require aligned-head integration evidence before unfreeze (full CI or a policy-defined exact-tree rebind; v1 chooses full integration CI). |
| STG-R1-005 | Medium | `docs/zob/05-PR_SHIP_FACTORY.md:97`; App denial in `08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md` | “Start full staging CI” can imply workflow dispatch even though Staging Merge App has no workflow authority. | `current_branch_fix`: CI is push-triggered automatically; App observes/correlates it and never dispatches a workflow. |
| STG-R1-006 | Medium | `docs/zob/01-SYSTEM_OVERVIEW.md` legacy tokens; `schemas/merge-authorization.schema.json`; `schemas/mission.schema.json`; `schemas/evidence.schema.json` | Legacy direct-base tokens remain parseable, but Wheel adapter fail-closed rejection for new missions/effects is not explicit enough. | `current_branch_fix`: migration reader may parse historical evidence only; new Wheel missions/profiles/effects reject legacy factory/evidence/merge-batch authority. Add validator assertion. |
| STG-R1-007 | Medium | `schemas/repository-assurance-result.schema.json:36-46,81-107` | Fewer than three eligible families can record `degraded=false`; non-pass assurance can record `noShip=false`. | `current_branch_fix`: eligible-family shortage requires `degraded=true` plus reason; blocked/needs-human/invalid requires `noShip=true`; add negative guards. |
| STG-R1-008 | Medium | `schemas/promotion-authorization.schema.json:31,44`; `schemas/promotion-merge-evidence.schema.json:30-38` | An active authorization may retain `unknown-blocked` deployment impact, and a completed CD run may omit conclusion. | `current_branch_fix`: active promotion cannot have unknown impact; completed CD observation requires a conclusion. |
| STG-R1-009 | Medium | Runtime lane W1, `schemas/execution-profile.schema.json:31`, `schemas/mission.schema.json:41` | Execution-profile deferred actions omit `workflow-dispatch`. | `current_branch_fix`: add token and assert intended parity/superset relationships. |
| STG-R1-010 | Low | Core lane L1, `03-STORY_TO_PR_CLOSE_FACTORY.md`, `04-BLIND_REVIEW_FACTORY.md` | Local PR-close references omit Builder App issuer. | `current_branch_fix`: add issuer for self-containment. |
| STG-R1-011 | Low | Schema lane WARNs, `schemas/README.md`, example assurance IDs | Ledger-vs-manifest `bodyStored` rule and assurance run naming could be clearer. | `current_branch_fix`: clarify README; use uniform `assurance-...-round-N` IDs. |
| STG-R1-012 | Low | `validation/validate_documentation.py:122-130` | Decision validator scans every textual reference rather than exact decision table rows. | `current_branch_fix`: validate exact table-row IDs 001–121. |
| STG-R1-013 | Info | All four lane reports | Manifest logical line counts differ from `wc -l` for final unterminated lines while hashes/bytes match. | Document `splitlines()` logical-line semantics in the manifest; no source-content change required. |

## Round 1 lane dispositions

- Core: PASS/no_ship=false; one Low issuer finding.
- Runtime/governance: WARN/no_ship=false; one workflow-dispatch enum finding.
- Operations/decisions: PASS/no_ship=false; line-count convention and topical ordering observations.
- Schemas/examples/validation: PASS/no_ship=false; body-policy clarity, naming and cross-example validator gaps.

## Repair policy

The parent will repair only source files in the docs branch, regenerate all examples/validators/manifests, run the full local validation suite, then dispatch four completely fresh audit lanes against round 2. Round-1 reviewers do not repair or judge round 2. No implementation, App, branch, workflow, merge or deployment action is authorized.
