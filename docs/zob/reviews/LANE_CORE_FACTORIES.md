# Lane: Core & Factories — Second-Pass Documentation Audit

**Audit date:** 2026-07-18
**Reviewer:** ZOB doc-audit lane (read-only second pass)
**Scope manifest:** `docs/zob/reviews/SCOPE_MANIFEST.json`
**Mode:** full second-pass after repairs; verify rather than trust the prior WARN summary
**Tools used:** read, read-only grep/bash; write only for this report

## Assigned files (8)

| # | Path (repo-relative) | Lines | Read fully | Truth class (as labeled) |
|---|---|---:|:---:|---|
| 1 | `AGENTS.md` | 44 | yes | (implicit) policy / operating truth |
| 2 | `README.md` | 14 | yes | (implicit) policy / safety status |
| 3 | `docs/zob/README.md` | 61 | yes | Approved design (suite) |
| 4 | `docs/zob/01-SYSTEM_OVERVIEW.md` | 115 | yes | Approved design |
| 5 | `docs/zob/02-ARCHITECTURE_AND_OWNERSHIP.md` | 160 | yes | Approved design (skill-inventory subsection: Current evidence) |
| 6 | `docs/zob/03-STORY_TO_PR_CLOSE_FACTORY.md` | 185 | yes | Approved design |
| 7 | `docs/zob/04-BLIND_REVIEW_FACTORY.md` | 197 | yes | Approved design (R-behavior subsection: Current evidence) |
| 8 | `docs/zob/05-PR_SHIP_FACTORY.md` | 192 | yes | Approved design (strengths/weaknesses subsections: Current evidence) |

Every assigned file was read from line 1 to its last line; no sampling.

## Method

1. Read all 8 files fully.
2. Consulted `docs/zob/reviews/SCOPE_MANIFEST.json` for the corpus boundary and file/line counts.
3. Cross-checked every internal link/anchor and every `ZOB-ENH-*` / `Sol-high` / `riskClass` / branch / gate / handoff reference against its target file.
4. Verified current-evidence subsections against `docs/zob/SOURCE_EVIDENCE.md`.
5. Attempted to disprove each prior WARN repair by searching for residual contradictions, overclaims, or dual vocabularies.
6. Distinguished current evidence / approved design / enhancement throughout.

## Prior WARNs and verification of repairs

The task summary said prior WARNs addressed: dual status vocabularies, current-evidence labels, Gate 8 refs, Blind Review disabled block, Sol alias neutrality, repair ceiling, branch push scope, ready-transition clarity. Each was independently re-verified rather than trusted.

| Prior WARN topic | Verified state | Evidence |
|---|---|---|
| Dual status vocabularies (truth class vs maturity) | **Repaired + verified** | `docs/zob/README.md:39-59` explicitly separates "Truth class" and "Maturity state" as two dimensions and warns "do not treat them as competing status vocabularies." The five maturity terms in `README.md:55-59` match `01:109-113` exactly. |
| Current-evidence labels | **Repaired + verified** | Subsection-level labels present and correct: `02:69` ("Current evidence"), `04:8` ("Current evidence at the source refs/SHA captured in `SOURCE_EVIDENCE.md`"), `05:16` (same). Counts in `02:71-76` match `SOURCE_EVIDENCE.md:55-59` exactly (188 / 34 / 25 / 0 collisions / 2026-07-18). |
| Gate 8 refs | **Repaired + verified** | `03:65` states "Gate 8/post-deploy is outside this factory" and routes post-merge to `05` + `ZOB-ENH-022`, deployment confirmation to `ZOB-ENH-023`. Both IDs confirmed in `ENHANCEMENTS.md:189,197`. |
| Blind Review disabled block | **Repaired + verified** | `04:178-186` shows `factory.blindReview.enabled = false`, `reviewerApp.credentials = absent`, `activationReceipt = none`, plus "Installation or implementation does not change these values." Activation gate references `14-VALIDATION_AND_PILOTS.md#blind-review-factory-rollout` (anchor verified valid). |
| Sol alias neutrality | **Repaired + verified** | `03:168`: "`Sol-high` is a policy alias, not a provider/model identity. Its exact route is filled only after the gated provider audit (including OpenAI OAuth); the design does not pre-assert which verified route will satisfy it." Corroborated by `09-MODEL_AND_PROMPT_EXPERIMENTS.md:47,205` and `16-DECISIONS.md:71,147`. |
| Repair ceiling | **Repaired + verified** | `03:170`: "The three-round ceiling in the Blind Review factory applies only to formal R review; internal build/PR-close repair remains bounded by task attempt, model-pool, cost and duration budgets, then routes to needs-human." `04:160` confirms "Maximum: three complete repair/re-view rounds" scoped to formal review. |
| Branch push scope | **Repaired + verified** | `03:91`: "Those pushes are limited to approved feature/stack branches; direct pushes to protected base branches remain forbidden." Consistent with `02:124` (Builder App feature-branch only), `08:31` (integration owner pushes feature/stack), `08:153` (no direct protected-branch push). |
| Ready-transition clarity | **Repaired + verified** | `05:78`: "After this factory is separately activated, eligible drafts are marked ready automatically only when the complete pre-ready policy set above and CI budget policy pass. That reversible ready transition is not merge permission: the separate exact-head human batch authorization remains mandatory after post-ready CI." Clearly separates ready transition from merge authorization. |

All eight prior WARN topics are confirmed repaired with no residual regression found.

## Findings by severity

### CRITICAL / HIGH
None.

### MEDIUM

**M-1 — `riskClass` vocabulary declares `critical` but panel subsections do not define a distinct critical panel.**
- File: `docs/zob/04-BLIND_REVIEW_FACTORY.md:57` and `:60-77`
- `04:57` declares the normalized vocabulary as `low|medium|high|critical` and states "security/trust work that requires the strongest panel is `critical` rather than a separate `security-critical` enum."
- The panel subsections that follow define only three tiers: `### Low risk` (`:60`), `### Medium risk` (`:65`), `### High/security/trust risk` (`:70`). There is no `### Critical risk` subsection.
- The heading `High/security/trust risk` conflates `high` and `critical` without stating whether `critical` receives a stronger/different panel than `high` (e.g., more mandatory lanes, stricter same-model prohibition), or whether `critical` uses the same panel as `high` with `critical` merely being the risk-domain label for security/trust.
- This is an internal specification ambiguity, not an overclaim. It does not authorize any live action.
- **Truth class:** Approved design (gap in a design contract).
- **Maturity:** Specified-incompletely.
- **Recommended action:** `current_branch_fix` — add either a `### Critical risk` subsection or an explicit sentence under `### High/security/trust risk` stating that `critical` uses the same panel composition as `high` (or describe the delta). Keep within approved-design framing.

### LOW

**L-1 — Section heading "Completion language" in 01 vs "Maturity state" in README.**
- File: `docs/zob/01-SYSTEM_OVERVIEW.md:107` vs `docs/zob/README.md:54`
- `README.md:59` states "Section 01 defines the same maturity ladder." `01:107` labels the section "Completion language" and defines the identical five terms (Specified/Implemented/Validated/Installed/Activated).
- The five-term vocabulary matches exactly; only the section heading differs from the README's "Maturity state" label. A reader cross-referencing "Section 01 defines the same maturity ladder" will find "Completion language" instead, which is a minor discoverability/terminology friction.
- **Truth class:** Approved design (terminology).
- **Recommended action:** `current_branch_fix` — either rename `01:107` to "Maturity state" (preferred for cross-doc consistency) or add a one-line note in `README.md:59` that 01 calls this "Completion language."

**L-2 — Per-file header uses "Implementation state" (01) vs "Activation state" (03/04/05).**
- Files: `docs/zob/01-SYSTEM_OVERVIEW.md:4`, `docs/zob/03-STORY_TO_PR_CLOSE_FACTORY.md:4`, `docs/zob/04-BLIND_REVIEW_FACTORY.md:4`, `docs/zob/05-PR_SHIP_FACTORY.md:4`
- `01:4` uses "Implementation state: Not implemented; all live factories disabled."
- `03:4`, `04:4`, `05:4` use "Activation state: ..." with factory-specific disabled wording.
- These are operational-constraint labels, not the "Maturity state" dimension from README, and they are not contradictory in content (the system is not implemented; each factory is activation-gated). But the two different label names ("Implementation state" vs "Activation state") for closely related per-file header fields may confuse a reader into thinking they are different dimensions.
- **Truth class:** Approved design (labeling).
- **Recommended action:** `current_branch_fix` — consider unifying the label name across the four files (e.g., "Activation state" everywhere, with 01 saying "Not implemented; all live factories disabled" under that label), or document the distinction in `README.md`'s truth-class/maturity section.

## Truth-class / maturity mapping

| File | Truth class (header) | Maturity (effective) | Activation-gated? |
|---|---|---|---|
| `AGENTS.md` | Policy / operating truth (implicit) | n/a (process rules) | n/a |
| `README.md` | Policy / safety status (implicit) | n/a (entry doc) | n/a |
| `docs/zob/README.md` | Approved design (suite) | Specified | Yes (Activation-gated) |
| `docs/zob/01-SYSTEM_OVERVIEW.md` | Approved design | Specified | Yes (all live factories disabled) |
| `docs/zob/02-ARCHITECTURE_AND_OWNERSHIP.md` | Approved design (skill-inventory subsection: Current evidence) | Specified; inventory subsection = Current evidence at 2026-07-18 | Yes |
| `docs/zob/03-STORY_TO_PR_CLOSE_FACTORY.md` | Approved design | Specified | Yes (first implementation target; not yet implemented) |
| `docs/zob/04-BLIND_REVIEW_FACTORY.md` | Approved design (R-behavior subsection: Current evidence) | Specified | Yes (disabled until separate implementation, pilots and activation receipt) |
| `docs/zob/05-PR_SHIP_FACTORY.md` | Approved design (strengths/weaknesses subsections: Current evidence) | Specified | Yes (disabled; no ship credentials or activation receipt) |

No file in this lane claims Implemented, Validated, Installed, or Activated for any factory. No present-tense live-behavior overclaim was found (searched for `is installed`, `is activated`, `is implemented`, `currently runs`, `live merge/review/ship`, etc.: zero matches).

## Factory stop / activation boundaries

| Factory | Stop boundary (file:line) | Disabled-by-default gate (file:line) | Activation requires | Consistent across corpus? |
|---|---|---|---|---|
| Story → PR-Close | `03:10` "before formal R review, ready transition, merge, deployment, publish or provider activation" | (no explicit `factory.story.enabled=false` block; status conveyed by `03:4` "not yet implemented" + `01:32`) | Story pilot + oracle PASS (`14` Phase 9) | Yes — `01:70-74` outputs (no formal approval/ready/merge/deploy), `01:32`, `README.md:61` all align. |
| Blind PR Review | `04:28` "before ready, merge or deployment" | `04:178-184` (`factory.blindReview.enabled=false`, `reviewerApp.credentials=absent`, `activationReceipt=none`) | `14` Blind Review rollout + fresh oracle PASS/no-ship false + explicit factory activation receipt | Yes — anchor `14#blind-review-factory-rollout` verified valid (`14:116`). |
| PR Ship | `05:10` "Never: code repair, close-evidence authorship, ACK invention, branch-protection bypass, force push, manual deployment trigger or deployment-success claim" | `05:170-176` (`factory.prShip.enabled=false`, `shipApp.credentials=absent`, `activationReceipt=none`) | `14` Ship rollout + test-repo pilots + Ready Guard migration + permission audit + oracle PASS/no-ship false + explicit activation; **plus per-batch exact-head human authorization** | Yes — `05:176-178` and `14` "Factory activation gate" both require per-batch authorization for Ship. |
| Post-Merge Reconciliation | (sub-design inside Ship output, `05:9`, `05:153-167`) | `05:155` "still specified-disabled"; `ZOB-ENH-022` = Specified-disabled (`ENHANCEMENTS.md:189`) | `ZOB-ENH-022` promotion trigger: before any Ship factory activation | Yes — `03:65` routes post-merge to `05` + `ZOB-ENH-022`. |
| Deployment Confirmation | (non-goal of v1; `01:103`, `03:185`) | `ZOB-ENH-023` = Deferred (`ENHANCEMENTS.md:197`) | Separate future factory | Yes. |

Handoff chain verified end-to-end:
`Story → fleet:needs-review` (`01:19`, `03:183`) → `Blind Review input: fleet:needs-review` (`04:26`) → `blind-review-clean` (`04:191`, `01:25`) → `Ship input: blind-review-clean` (`05:8`). Repair loop `04:148-156` returns findings to Story and re-emits `fleet:needs-review` after re-close. No broken link in the chain.

## Cross-reference checks

| Source (file:line) | Reference | Target | Resolved? | Notes |
|---|---|---|:---:|---|
| `03:65` | `05-PR_SHIP_FACTORY.md#post-merge-reconciliation` | `05:153` `## Post-merge reconciliation` | yes | GitHub anchor `post-merge-reconciliation` matches lowercase-hyphenated heading. |
| `03:65` | `ZOB-ENH-022` | `ENHANCEMENTS.md:189` | yes | "Exact-input Post-Merge Reconciliation factory", Specified-disabled. |
| `03:65` | `ZOB-ENH-023` | `ENHANCEMENTS.md:197` | yes | "Deployment Confirmation factory", Deferred. |
| `04:186` | `14-VALIDATION_AND_PILOTS.md#blind-review-factory-rollout` | `14:116` `## Blind Review factory rollout` | yes | Anchor verified via slug rule. |
| `01:104` | `ENHANCEMENTS.md` | `docs/zob/ENHANCEMENTS.md` | yes | File exists; non-goals registered there. |
| `docs/zob/README.md:7-31` | 01–16, ENHANCEMENTS, SOURCE_EVIDENCE, schemas/, examples/ | corresponding files | yes | All 20 link targets exist (file-existence checked). |
| `README.md:3-9` | `investors/`, `needs-human/`, `docs/zob/`, `superseded/` | directories | yes | All four directories exist. |
| `02:124-130` (Builder/Reviewer/Ship App permissions) | cross-check with `04:128-131` (Reviewer App) and `05:39-46` (Ship App) | — | yes | No permission contradiction across the three App definitions. |
| `02:132-134` (branch purposes) | cross-check with `AGENTS.md:26-28` | — | yes | Consistent (main / zob-mission-state / zob-model-telemetry). |
| `03:91` (feature/stack push only) | cross-check with `02:124`, `08:31`, `08:153` | — | yes | No file permits direct protected-base push. |
| `04:22` (`/review-all` owned by PR-close) | cross-check with `03` | — | yes | `03` does not mention `/review-all`; no contradiction (one-sided reference is acceptable). |
| `05:16` (current strengths/weaknesses = Current evidence) | cross-check with `SOURCE_EVIDENCE.md:31-51` (S baseline) | — | yes | Strengths/weaknesses lists map to observed S baseline evidence. |
| `04:8-21` (R-behavior = Current evidence) | cross-check with `SOURCE_EVIDENCE.md:26-37` (R baseline) | — | yes | Static R→W, `/review-all`, SHA-bound verdict all backed by source refs. |
| `02:69-76` (skill inventory = Current evidence) | cross-check with `SOURCE_EVIDENCE.md:53-61` | — | yes | Counts match exactly. |

No broken internal link or anchor was found in the 8 assigned files.

## Disprove-repairs sweep (negative results)

The following targeted searches were performed to try to disprove the repairs; all returned zero contradicting evidence:

- `security-critical` enum residue: only `04:57` (which explicitly says `critical` *replaces* it). No residual separate enum. ✓
- Implementation/activation overclaims (`is installed`, `is activated`, `currently runs`, `live merge/review/ship`): zero matches across all 8 files. ✓
- Dual maturity vocabulary mismatch: the five terms match exactly between `01` and `README` (only heading differs — see L-1). ✓
- Broken anchors: both `#post-merge-reconciliation` and `#blind-review-factory-rollout` resolve. ✓
- Branch push scope contradiction: no file permits direct protected-base push. ✓
- Ready transition conflated with merge permission: `05:78` explicitly separates them. ✓
- `Sol-high` pre-asserted to a provider/model: `03:168` and `09:205` both refuse to pre-assert. ✓
- Three-round ceiling leaking into internal repair: `03:170` explicitly scopes it to formal R review. ✓

## Unresolved risks (recorded, not smoothed)

1. **M-1** — `critical` panel composition is underspecified relative to the declared four-value `riskClass` vocabulary. This is a design-contract gap, not an activation or implementation risk.
2. **L-1 / L-2** — Terminology friction ("Completion language" vs "Maturity state"; "Implementation state" vs "Activation state") does not affect safety but may impair cross-document discoverability for future implementers and reviewers.
3. The Story factory has no explicit `factory.story.enabled=false` config block analogous to the Blind Review (`04:178`) and Ship (`05:170`) blocks. Its disabled status is conveyed only via prose (`03:4` "not yet implemented", `01:32`). This is not a defect — Story is the first implementation target rather than a separately-activated factory — but the asymmetry may confuse a reader expecting a uniform disabled-block pattern across all three factories. Noted as an observation, not a finding.

## Verdict

**PASS (with low-severity notes).**

All 8 assigned files are internally consistent, correctly truth-classed, honestly maturity-labeled, and free of implementation/activation overclaims. All prior WARN repairs are verified intact with no regression. All cross-references and anchors resolve. Factory stop/activation boundaries are consistent across the corpus and align with `AGENTS.md`, `README.md`, `docs/zob/README.md`, and `ENHANCEMENTS.md`.

No CRITICAL or HIGH finding. One MEDIUM finding (M-1: `critical` panel gap in `04`) and two LOW findings (L-1, L-2: terminology friction) are all `current_branch_fix`-routable and do not block corpus approval or safety.

This audit confirms — but did not trust — the prior WARN repair summary.

FINAL: DOC_AUDIT_LANE_COMPLETE
