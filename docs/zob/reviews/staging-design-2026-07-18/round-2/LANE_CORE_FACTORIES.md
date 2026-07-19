# Round-2 Core-Factories Lane Audit

**Review:** staging-design-2026-07-18 / round-2
**Lane:** core-factories
**Auditor:** independent fresh round-2 pass (no round-1 findings read)
**Date:** 2026-07-18
**Scope manifest:** `docs/zob/reviews/staging-design-2026-07-18/round-2/SCOPE_MANIFEST.json`
**Manifest SHA-256 (verified):** `786bce2b809c62f135fbe4e15050cba4aabacfcfb80341377178a1064238ba76`

## Method and attestations

This audit performed a fresh, from-scratch read of every file assigned to the `core-factories` lane in the round-2 scope manifest. No round-1 reports or findings were read. Only read-only tools were used; no source was edited, no network or secrets were accessed, and no commit/push/merge/deploy/activate was performed.

### Manifest verification

`shasum -a 256` on the scope manifest produced `786bce2b809c62f135fbe4e15050cba4aabacfcfb80341377178a1064238ba76`, matching the task-specified manifest hash exactly.

### Assigned files (full-read, hash, line attestation)

For each file: SHA-256, byte count, and logical line count (UTF-8 splitlines) were recomputed from disk and matched the manifest entry exactly before the file was read in full.

| # | Path | Lines | Bytes | SHA-256 (verified) | Full read |
|----|------|------:|------:|---------------------|:---------:|
| 1 | `AGENTS.md` | 44 | 3066 | `67a4a303a0c4e2e40b3fb832c40c4874134265e1619bc5b8d2ddca22000c6bed` | ✓ |
| 2 | `README.md` | 14 | 872 | `bb4fb11253157eddc0fa38b2f75cc9eb5b73d7b38582eb2712ff7c60e36ef6e6` | ✓ |
| 3 | `docs/zob/01-SYSTEM_OVERVIEW.md` | 133 | 6364 | `01e45567e87098fe6476cb9f56fa9948a4ceb099817e8d205f8345c37aba629f` | ✓ |
| 4 | `docs/zob/02-ARCHITECTURE_AND_OWNERSHIP.md` | 163 | 6524 | `83fa72f372f512a97d61597d4465c0b07be2149741639976b2042a17b1a3dd3b` | ✓ |
| 5 | `docs/zob/03-STORY_TO_PR_CLOSE_FACTORY.md` | 195 | 8623 | `c48fbf14854181e94851881bb878c4ddf1906b91ff243cb9798d597190a9a4e5` | ✓ |
| 6 | `docs/zob/04-BLIND_REVIEW_FACTORY.md` | 199 | 7636 | `77d255cc23460e27f54714c453f54f4b7d5cbdba5ce19d4d6434040b726f895d` | ✓ |
| 7 | `docs/zob/05-PR_SHIP_FACTORY.md` | 149 | 7517 | `358fe78da15608a76ae9c827996fffbadef4581f391ac9c0601999165da0f9e2` | ✓ |
| 8 | `docs/zob/17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md` | 284 | 15971 | `afe46f76e02e8dc38fda690a4be404ac73ae6dfac5fff71043ed5759b9a17661` | ✓ |
| 9 | `docs/zob/README.md` | 71 | 3801 | `8333c8d3b28e2d7e66839d3329c1ab9bc234ad227ffed79a5a54922fc161d3e0` | ✓ |
| 10 | `docs/zob/SOURCE_EVIDENCE.md` | 145 | 6906 | `54e19de34e12568657c6cac922eac1bcd2b86bcaec37a5cf8d39972cbb8f3e24` | ✓ |

**Totals:** 10 files, 1398 logical lines, 64381 bytes. All hashes/lines/bytes match manifest exactly. Every file was read end-to-end.

## Required-contract verification

### C1 — Story → PR Close → Blind Review → automatic non-deploying staging merge

**Verdict: PASS**

The end-to-end pipeline is stated consistently across all factory files and the overview:

- `01-SYSTEM_OVERVIEW.md:15-33` draws the full lifecycle ASCII diagram: Story → PR-Close → Blind PR Review → Staging Merge Factory → Final Assurance & Promotion, with `fleet:needs-review` and `blind-review-clean` as the inter-factory handoff signals.
- `03-STORY_TO_PR_CLOSE_FACTORY.md:8-9` — output is "one exact-head, evidence-bound draft PR per story targeting mandatory non-deploying `develop-staging`, handed to formal review"; stop is "before formal R review, ready transition, staging merge, promotion, deployment, publish or provider activation."
- `03:195` — completion explicitly does not claim reviewed/ready/staged/promoted/deployed; "Blind Review consumes the handoff; only the separate Staging Merge factory may later merge a clean PR into `develop-staging`."
- `04-BLIND_REVIEW_FACTORY.md:8-9` — input is the draft PR with valid PR-close evidence and `fleet:needs-review`; output is SHA-bound clean review or findings; stop before ready/merge/deployment.
- `04:199` — "A clean verdict hands the PR to the automatic Staging Merge factory; it is not develop-promotion or deployment approval."
- `05-PR_SHIP_FACTORY.md:8-9` — input is `blind-review-clean` ordinary PR targeting `develop-staging`; output is "automatic expected-head squash merge into non-deploying `develop-staging`, followed by exact-head full staging integration CI."
- `05:11-13` — this factory owns ordinary PR ready/merge into staging; section 17 owns the human-started audited promotion into `develop`.
- `17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md:8` — `develop-staging` is "a non-deploying buffer where independently reviewed changes combine and run full integration CI before any code reaches `develop`."
- `17:16` — "staging deployment: forbidden / no CD workflow trigger."

The chain is complete, unidirectional, and every factory's stop boundary prevents skipping. Non-deploying status is asserted at every staging boundary (`03:9`, `05:9`, `17:8`, `17:16`, `02:126`).

### C2 — Exact red/freeze repair exceptions

**Verdict: PASS**

Two distinct narrow merge exceptions are specified precisely and consistently:

**Red interlock exception** (`05-PR_SHIP_FACTORY.md`):
- `05:62` — state machine: "A promotion freeze adds `promotion-window-frozen`; a red integration adds `staging-red-interlock`. Queued unrelated PRs can continue building/reviewing but cannot enter `staging-merge-in-flight`. The only narrow exceptions are an exact failure-bound repair PR for the red interlock or a finding-bound repair PR authorized by the active promotion window/candidate revision."
- `05:77` — pre-ready reconciliation: "no promotion freeze/staging-red interlock, unless a typed repair contract binds the exact interlock, failure/finding IDs and expected staging head; the exception never bypasses any other gate."
- `05:100` — step 8: "Permit the next unrelated staging merge only when the head is green and not frozen; otherwise admit only the current typed repair exception."
- `05:108-114` — staging integration failure: freezes merges, preserves evidence, routes repair through a new ordinary PR with exact failure/interlock/head contract, "lets only that repair use the red-interlock merge exception," reruns push-triggered integration after repair merge.

**Promotion freeze exception** (`17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md`):
- `17:53` — "The sole merge exception is a repair PR bound to a validated finding and the active window; it passes every ordinary gate, revises the candidate and invalidates the prior assurance."
- `17:65` — "During a promotion freeze, it rejects every merge except an active-window repair PR whose finding IDs, expected staging head and candidate revision are current."
- `17:173` — repair PRs must bind window/candidate/finding IDs and expected staging head, pass PR-close, Blind Review and ordinary CI before the Staging Merge App applies the narrow freeze exception.

The exceptions are typed (failure-bound vs finding-bound), contract-bound, and explicitly never bypass any other gate. The two files agree on the exception semantics. No destructive reset/revert is automatic (`05:116`, `17:75`); attribution uncertainty routes to needs-human (`05:116`, `17:75`).

### C3 — Initial-to-final candidate lineage

**Verdict: PASS**

Candidate lineage is specified as a strict monotonic hash-chained ancestry:

- `17:82` — promotion-window receipt binds "initial `develop-staging` SHA and initial candidate hash."
- `17:90` — "Each expected repair merge creates a monotonically numbered candidate revision linked to the prior candidate/hash and authorized finding/repair PR; it does not require a new window receipt. Any unrelated or unrecorded branch movement, develop movement, lineage gap or policy change invalidates the window and blocks effects. The later promotion-merge receipt binds the final exact candidate revision/SHA."
- `17:98-99` — frozen boundary records "window ID, candidate revision and prior-candidate hash" and "initial staging SHA, current staging worktree/branch/exact SHA and authorized repair lineage."
- `17:177` — after each authorized repair merge: "the candidate revision increments and records prior/current SHA, repair PR and finding lineage."
- `17:261` — semantic validator 1: "window ACK initial SHA/hash, every candidate revision, authorized repair transition and final included PR set form one exact staging ancestry."
- `17:262` — validator 2: "every candidate PR/check/merge is current; candidate and promotion included-PR sets match cohort + repairs."

The lineage is anchored at the initial staging SHA/candidate hash, increments monotonically with prior-hash linkage, and the final promotion-merge receipt binds the terminal candidate revision/SHA. Lineage gaps invalidate the window.

### C4 — Three assurance rounds / two repairs

**Verdict: PASS**

The three-rounds/two-repairs boundary is stated consistently in lifecycle, receipt binding, narrative, and semantic validator:

- `17:42` — lifecycle: "→ round 3 findings → needs-human (no automatic repair/round 4)."
- `17:86` — window receipt binds "maximum three assurance rounds and at most two automatic repair transitions."
- `17:183` — "Maximum three full assurance rounds means at most two automatic repair transitions. Findings in round 3 create one needs-human case; the system does not auto-repair into a nonexistent round 4. No partial/experimental/sampled audit can clear promotion."
- `17:266` — semantic validator 6: "each round-1/2 repair merge invalidates the old assurance, passes full staging CI and forces the next round; round-3 repair is rejected and remaining findings require needs-human."
- `17:284` — activation requires "three-assurance-round/two-repair-transition simulation."

Repair is only permitted after rounds 1 or 2 (`17:173`); round 3 findings are terminal needs-human. This is distinct from the Blind Review factory's own three-round repair ceiling (`04:162`), which the Story factory correctly scopes to formal R review only (`03:170`). The two three-round ceilings operate in different factories and do not conflict.

### C5 — Exact merge-commit promotion

**Verdict: PASS**

Merge method is specified consistently and enforced by narrative, receipt, and validator:

- `17:17` — "ordinary merge method: squash" (staging merges).
- `17:20` — "promotion merge method: merge-commit."
- `17:45` — lifecycle: "→ Promotion App merge-commit into develop."
- `17:210` — promotion-merge receipt binds "merge method `merge-commit`."
- `17:220` — "The dormant Promotion App performs one expected-head GitHub merge-commit. Squash/rebase are forbidden because they rewrite the audited staging commits. Admin/bypass flags are forbidden."
- `17:243` — Promotion App may "merge-commit only the typed promotion PR into `develop`."
- `17:268` — semantic validator 8: "promotion merge parents include exact audited staging and exact authorized develop base, result tree equals staging and method is merge-commit."
- `05:138` — cross-reference: section 17 "owns ... merge-commit into `develop`."
- `01:36,106` — overview confirms "merge-commit into develop" and "exact-head human-authorized merge-commit promotion into `develop`."

Squash is used for ordinary staging merges; merge-commit is mandatory for promotion. Squash/rebase are explicitly forbidden for promotion because they rewrite audited history. Expected-head is required.

### C6 — Push CD (automatic CD from develop merge, push-triggered only, no manual dispatch)

**Verdict: PASS**

- `17:10` — "That single develop merge is where automatic CD turns back on."
- `17:46` — lifecycle: "→ automatic CD from develop."
- `17:218-222` — "## Merge and automatic CD": "The `develop` merge event may automatically trigger configured CD workflows. That is the intended point where automatic CD is enabled again. The factory records workflow run IDs and deployment-impact receipts but never manually runs `workflow_dispatch` or claims deployment success."
- `17:21` — "manual deploy dispatch: forbidden."
- `17:212` — promotion-merge receipt binds "automatic CD workflow/path/environment consequences."
- `17:269` — semantic validator 9: "any observed CD run is push-triggered by the exact promotion merge, completed observations have conclusions and manual dispatch remains false."
- `17:16` — staging deployment forbidden / no CD workflow trigger on `develop-staging`.
- `05:48,97` — Staging Merge App never dispatches workflows; "only observes/correlates push-triggered CI."
- `01:107` — "automatic CD only from that develop merge; no manual workflow dispatch."
- `17:226` — "A deployment-confirmation factory remains separate/deferred" (no deployment-success claim).

CD is push-triggered by the exact promotion merge event only; manual `workflow_dispatch` is forbidden; deployment success is never claimed by this factory.

### C7 — Aligned-head CI before unfreeze

**Verdict: PASS**

- `17:47-50` — lifecycle: "→ expected-head fast-forward develop-staging to promotion merge SHA → full aligned-head staging integration CI → unfreeze staging queue."
- `17:224` — "Post-promotion reconciliation receives the exact promotion merge event. When complete, the Promotion App fast-forwards `develop-staging` from the audited staging SHA to the new develop promotion merge SHA using expected-head protection, restoring branch alignment without changing the tree. The aligned SHA is new, so push-triggered full staging integration CI must finish and a current `ZOB / Staging Integration` Check must bind that SHA before the staging merge queue is unfrozen."
- `17:244` — Promotion App may "expected-head fast-forward `develop-staging` only after successful promotion/reconciliation."
- `17:270` — semantic validator 10: "staging alignment expected-old/new SHAs match the audited staging and promotion merge, and aligned-head integration CI passes before queue unfreeze."
- `17:284` — activation requires "aligned-head-CI/CD simulation."

The aligned (fast-forwarded) SHA is new and distinct, so full staging integration CI must re-run and a current `ZOB / Staging Integration` Check must bind the aligned SHA before the queue unfreezes. The ordering is: promotion merge → reconciliation → fast-forward → aligned-head CI → Check binds → unfreeze.

### C8 — Issuer and authority separation

**Verdict: PASS**

Four independent least-privilege GitHub Apps are specified with disjoint authority. Check issuer mapping is consistent across all files:

- `02-ARCHITECTURE_AND_OWNERSHIP.md:124-127` — four Apps: Builder (contents/PR/check, no merge/deploy), Reviewer (read + review/comment/check write, no source write/merge/deploy), Staging Merge (ready/squash merge only into `develop-staging`, no develop/main write), Promotion (dormant except active window, merge-commit only typed promotion PR into `develop`, fast-forward staging after reconciliation).
- `02:128` — "Agents never receive App tokens. The deterministic broker validates typed requests and issues short-lived tokens."
- `05:48` — Staging Merge App "is distinct from the dormant Promotion App."
- `05:125-129` — Canonical Checks with issuers: `ZOB / PR Close` → Builder, `ZOB / Blind Review` → Reviewer, `ZOB / Human Gates` → Supervisor projection, `ZOB / Staging Merge Gate` → Staging Merge App, `ZOB / Staging Integration` → Staging Merge App.
- `17:192-196` — promotion PR Checks with issuers: `ZOB / Staging Integration` → Staging Merge App, `ZOB / Repository Assurance` → Reviewer App, `ZOB / Human Gates` → Supervisor projection, `ZOB / Promotion Authorization` → Promotion App, `ZOB / Promotion Gate` → Promotion App.
- `17:247` — "Builder and Reviewer Apps remain separate."
- `03:191` — `ZOB / PR Close` issued by Builder App.
- `04:144` — `ZOB / Blind Review` issued by Reviewer App.
- `17:199` — promotion PR revalidates "Check issuers/schema versions."
- `05:149` / `17:284` — activation requires "source/check/receipt issuer migration" / "denied-permission tests."

No App can borrow another's authority. The promotion PR Check list (`17:192-196`) intentionally omits `ZOB / PR Close` and `ZOB / Blind Review` because those are per-ordinary-PR Checks on constituent PRs already merged into staging; the promotion PR (`develop-staging → develop`) relies on `ZOB / Staging Integration` (which subsumes the merged cohort's staging CI), `ZOB / Repository Assurance`, `ZOB / Human Gates`, and the two Promotion-App Checks. This is logically consistent — the promotion PR head is the audited staging tree, not an ordinary feature-PR head. `ZOB / Staging Merge Gate` (`05:128`) appears only in the staging-merge context and not in the promotion PR list, which is correct since it is a staging-admission gate.

### C9 — Legacy read-only rejection

**Verdict: PASS**

Legacy tokens and evidence are parseable for read-only migration only and rejected for any new mission/effect:

- `01-SYSTEM_OVERVIEW.md:41` — "Current mission `factoryType` tokens are `story-pr-close`, `blind-pr-review`, `staging-merge`, `repository-assurance`, `promotion` and `post-promotion-reconciliation`. `pr-ship` and `post-merge-reconciliation` remain parseable for read-only historical migration only; the Wheel adapter rejects them for new missions and effects."
- `04-BLIND_REVIEW_FACTORY.md:30` — "Legacy `/pr-close` evidence is supported through a strict adapter. Missing fields fail closed."
- `04:47` — admission accepts "valid Builder App `ZOB / PR Close` exact-head Check or strict read-only legacy evidence equivalent."
- `05-PR_SHIP_FACTORY.md:12-13` — "The former `/pr-ship` semantic lifecycle splits: this factory owns ordinary PR ready/merge into staging; section 17 owns the human-started audited promotion into `develop`."
- `SOURCE_EVIDENCE.md:38` — current `pr-ship` skill source is recorded as current-evidence baseline being replaced.

Legacy evidence is adapter-gated, fail-closed on missing fields, and legacy factory-type tokens are rejected for new effects. No legacy path can produce new live mutations.

### C10 — Disabled maturity

**Verdict: PASS**

Every factory and the corpus as a whole are marked as design-only / specified / disabled-by-default with absent credentials and no activation receipt. Maturity is never overstated:

- `AGENTS.md:22` — hard rule 10: "Mark design-only capability honestly. 'Specified' does not mean 'implemented,' 'installed,' 'activated,' or 'validated.'"
- `AGENTS.md:44` — "deliberately disabled-by-default ... `develop-staging` is currently absent from the application repository."
- `README.md:14` — "`develop-staging` is currently absent. Provider credentials, GitHub Apps, branch policy, merge authority, automatic-CD policy and deployment authority are not configured by these files."
- `01-SYSTEM_OVERVIEW.md:4` — "Specified only; not implemented; all live factories disabled."
- `01:27,32` — Staging Merge Factory `[disabled]`, Final Assurance & Promotion Factory `[disabled]`.
- `01:39` — "`develop-staging` does not exist as an active integration policy merely because it is specified here."
- `01:125-131` — maturity ladder: Specified → Implemented → Validated → Installed → Activated; "No lower state implies a higher one."
- `03:4` — "Specified; first implementation target; not yet implemented or activated."
- `03:175-177` — `factory.story.enabled = false`, `builderApp.credentials = absent`, `activationReceipt = none`.
- `04:4` — "Specified only; disabled until separate implementation, pilots and activation receipt."
- `04:183-185` — `factory.blindReview.enabled = false`, `reviewerApp.credentials = absent`, `activationReceipt = none`.
- `05:4` — "Specified only; disabled; no Staging Merge App credentials or activation receipt."
- `05:143-146` — `factory.stagingMerge.enabled = false`, `stagingMergeApp.credentials = absent`, `activationReceipt = none`, `developStaging.deploymentsEnabled = false`.
- `17:4` — "Specified only; not implemented, installed or activated."
- `17:275-281` — `developStaging.required = design-only / not installed`, all four factory flags `= false`, both App credentials `= absent`, `activationReceipt = none`.
- `docs/zob/README.md:3` — "Approved design; not implemented or activated."
- `docs/zob/README.md:67` — "Activation-gated is an operational constraint, not a maturity claim."
- `docs/zob/README.md:71` — "Nothing in this corpus authorizes merge, deploy, publish, live-provider activation, credential access or GitHub App installation."
- `SOURCE_EVIDENCE.md:82,85` — `refs/heads/develop-staging: absent`; sections 05/17 are "Approved design / Specified only, not Current evidence."
- `SOURCE_EVIDENCE.md:145` — "Everything labeled Approved design ... is not current implementation evidence."

Every activation gate references the required proof chain (pilots, oracle PASS/no-ship false, human activation receipt) in `03:178`, `04:188`, `05:149`, `17:284`. No file claims implementation, installation, or activation.

## Cross-file consistency findings

### F-01 — Promotion PR Check list omits per-PR Checks (intentional, consistent)
- **Location:** `17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md:192-196` vs `05-PR_SHIP_FACTORY.md:125-129`.
- **Observation:** The promotion PR required Checks (`17:192-196`) list `ZOB / Staging Integration`, `ZOB / Repository Assurance`, `ZOB / Human Gates`, `ZOB / Promotion Authorization`, `ZOB / Promotion Gate`. It does not list `ZOB / PR Close` or `ZOB / Blind Review` (which appear in `05:125-126`) nor `ZOB / Staging Merge Gate` (`05:128`).
- **Assessment:** This is correct and intentional. `ZOB / PR Close` and `ZOB / Blind Review` are per-ordinary-PR Checks on constituent PRs that already merged into `develop-staging`; they are staging-merge admission requirements (`17:59-60`, `05:69-70`), not promotion-PR head Checks. `ZOB / Staging Merge Gate` is a staging-merge-admission gate. The promotion PR head is the audited staging tree, validated by `ZOB / Staging Integration` (cohort CI) and `ZOB / Repository Assurance`. No inconsistency.
- **Severity:** INFO (no action required).
- **current_branch_fix:** N/A.

### F-02 — Two distinct "three-round" ceilings are correctly scoped
- **Location:** `04-BLIND_REVIEW_FACTORY.md:162` (Blind Review: three complete repair/re-review rounds), `17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md:183` (assurance: three rounds / two repairs), `03-STORY_TO_PR_CLOSE_FACTORY.md:170` (PR-close repair is bounded by task attempt/pool/cost/duration, not the Blind Review three-round ceiling).
- **Observation:** Three different repair ceilings exist: (a) Blind Review formal R review: three complete repair/re-review rounds; (b) Final Repository Assurance: three assurance rounds / two automatic repair transitions; (c) Story PR-close internal repair: bounded by task attempt, model-pool, cost and duration budgets. The Story factory explicitly states the Blind Review three-round ceiling "applies only to formal R review."
- **Assessment:** These are three separate budgets in three separate factories. The scoping statement in `03:170` prevents confusion. No conflict.
- **Severity:** INFO (no action required).
- **current_branch_fix:** N/A.

### F-03 — Auditor/repairer disjointness enforced
- **Location:** `17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md:173` (repair agents "do not inherit reviewer identities or conclusions beyond the exact finding contract"), `17:265` (semantic validator 5: "auditor and repairer assignment sets are disjoint").
- **Assessment:** The disjointness is specified both narratively and as a mandatory semantic validator. Consistent with Blind Review blindness principles (`04:55-66`). No issue.
- **Severity:** INFO.
- **current_branch_fix:** N/A.

### F-04 — `develop-staging` ownership boundary consistent
- **Location:** `AGENTS.md:9` (`jointhewheel` owns `develop-staging`/promotion branch and CI/CD/Guard integration), `02-ARCHITECTURE_AND_OWNERSHIP.md:59` (`jointhewheel` owns `develop-staging`/`develop` branch protection and promotion adapter), `SOURCE_EVIDENCE.md:82` (`develop-staging` absent in application repo), `AGENTS.md:44` / `README.md:14` (absent).
- **Assessment:** The docs-tools repo owns the design/policy; the application repo owns the actual branch/CI/CD. The branch is confirmed absent in current evidence. No conflict.
- **Severity:** INFO.
- **current_branch_fix:** N/A.

### F-05 — Link integrity verified
- **Location:** all Markdown links in the 10 core-factories files.
- **Observation:** Every relative `.md` link target exists on disk. The two anchored links resolve: `17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md#merge-and-automatic-cd` → `17:218` ("## Merge and automatic CD"); `14-VALIDATION_AND_PILOTS.md#blind-review-factory-rollout` → `14:159` ("## Blind Review factory rollout"). Schema links in `17:249-255` point to files in the schemas-examples-validation lane (not audited here for content, but targets exist).
- **Severity:** INFO.
- **current_branch_fix:** N/A.

### F-06 — `ZOB / Staging Merge Gate` Check is singleton
- **Location:** `05-PR_SHIP_FACTORY.md:128` — `ZOB / Staging Merge Gate` (Staging Merge App) appears only in the section 05 canonical Checks list.
- **Observation:** This Check is not mentioned in section 17's promotion PR list or the overview. It is a staging-merge-admission gate owned by the Staging Merge App. Section 17's Staging Merge Factory subsection (`17:57-75`) describes the merge process but does not re-list the canonical Checks table; it focuses on `ZOB / Staging Integration` as the post-merge publish target.
- **Assessment:** Not an inconsistency — the Check belongs to the staging-merge factory's own gate set. However, section 17 does not restate the full canonical Check table for the Staging Merge Factory, relying on section 05 for that. A reader of section 17 alone would not see `ZOB / Staging Merge Gate` or `ZOB / PR Close`/`ZOB / Blind Review` in a Check table. This is a minor readability gap, not a correctness defect, since `17:59-60` does list the PR Close/Blind Review admission requirements in prose.
- **Severity:** WARN (documentation readability — section 17 does not restate the staging-merge canonical Check table; a reader must cross-reference section 05 for the full issuer table).
- **current_branch_fix:** Optional — section 17 could restate or cross-reference the section 05 canonical Checks table for self-containment. Not a blocker.

### F-07 — Promotion-window receipt vs promotion-merge receipt separation
- **Location:** `17:80-90` (promotion-window receipt), `17:204-215` (promotion-merge receipt), `17:257` (`ack-receipt.v1` with distinct `promotion-window` and `promotion-merge` tokens).
- **Assessment:** Two distinct ACK tokens are specified. The window receipt authorizes freeze/audit/repair descendants, not promotion. The merge receipt authorizes the final exact candidate promotion. Head/base/workflow/policy changes invalidate the merge receipt. This separation is consistent with `AGENTS.md:13` ("Human ACKs and overrides require authenticated, correlated receipts; a bare label is never authority"). No issue.
- **Severity:** INFO.
- **current_branch_fix:** N/A.

### F-08 — `noShip=true` and oracle PASS/no-ship false gating
- **Location:** `17:267` (semantic validator 7: "non-pass assurance is `noShip=true`"), `17:284` / `05:149` / `04:188` (activation requires "independent oracle PASS/no-ship false").
- **Assessment:** Non-passing assurance forces `noShip=true`; activation gates require oracle PASS with no-ship false. Consistent across factories. No issue.
- **Severity:** INFO.
- **current_branch_fix:** N/A.

## Summary table

| ID | Requirement | Verdict | Severity | no_ship |
|----|-------------|:-------:|:--------:|:-------:|
| C1 | Story → PR Close → Blind Review → automatic non-deploying staging merge | PASS | — | false |
| C2 | Exact red/freeze repair exceptions | PASS | — | false |
| C3 | Initial-to-final candidate lineage | PASS | — | false |
| C4 | Three assurance rounds / two repairs | PASS | — | false |
| C5 | Exact merge-commit promotion | PASS | — | false |
| C6 | Push CD (push-triggered, no manual dispatch) | PASS | — | false |
| C7 | Aligned-head CI before unfreeze | PASS | — | false |
| C8 | Issuer and authority separation | PASS | — | false |
| C9 | Legacy read-only rejection | PASS | — | false |
| C10 | Disabled maturity | PASS | — | false |
| F-01 | Promotion PR Check list omits per-PR Checks | INFO | — | false |
| F-02 | Two three-round ceilings correctly scoped | INFO | — | false |
| F-03 | Auditor/repairer disjointness | INFO | — | false |
| F-04 | develop-staging ownership boundary | INFO | — | false |
| F-05 | Link integrity | INFO | — | false |
| F-06 | Section 17 does not restate staging-merge canonical Check table | WARN | low | false |
| F-07 | Window vs merge receipt separation | INFO | — | false |
| F-08 | noShip=true and oracle gating | INFO | — | false |

## Overall verdict

**Lane verdict: PASS**
**no_ship: false**
**Highest severity: WARN (F-06, low, documentation readability only — no correctness or safety defect)**

All ten required contracts (C1–C10) are satisfied with consistent, path:line-anchored evidence across all 10 core-factories files. The full Story → PR-Close → Blind Review → automatic non-deploying Staging Merge → human-started Final Assurance → merge-commit Promotion → push-triggered CD → aligned-head CI → unfreeze pipeline is specified end-to-end with exact stop boundaries, typed repair exceptions, monotonic candidate lineage, three-rounds/two-repairs ceiling, merge-commit-only promotion, push-triggered-only CD, aligned-head CI before unfreeze, four disjoint least-privilege App identities, legacy read-only rejection, and honest disabled-by-default maturity. No file overstates implementation, installation, or activation status. `develop-staging` is confirmed absent in current evidence. No credentials, activation receipts, or live authority are present or implied.

The single WARN (F-06) is a minor self-containment/readability observation: section 17 does not restate the section 05 canonical Check table for the Staging Merge Factory, so a reader of section 17 alone must cross-reference section 05 for the full issuer mapping. This does not affect correctness, safety, or contract completeness.

**Unresolved risks:** None blocking. F-06 is optional documentation polish. All cross-factory contracts are internally consistent and validated by the semantic validators listed in `17:261-270`.

LANE_AUDIT_COMPLETE
