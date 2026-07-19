# Round-2 Lane Audit — runtime-governance

**Review:** staging-design-2026-07-18 / round-2
**Lane:** runtime-governance
**Auditor:** independent fresh round-2 reviewer (zob-orchestrator-0f076f)
**Mode:** full read-only documentation audit; no source edits, no network, no secrets, no commit/push/merge/deploy/activate, no labels/comments accepted
**Date:** 2026-07-18

## Scope and manifest attestation

Manifest read in full: `docs/zob/reviews/staging-design-2026-07-18/round-2/SCOPE_MANIFEST.json`
Manifest SHA-256 (computed over raw bytes): `786bce2b809c62f135fbe4e15050cba4aabacfcfb80341377178a1064238ba76`
Manifest SHA-256 (expected by TASK): `786bce2b809c62f135fbe4e15050cba4aabacfcfb80341377178a1064238ba76`
**Manifest SHA match: PASS**

Line-count semantics per manifest: `utf8-splitlines-logical-lines`. Exclusions honored: `docs/zob/reviews/**` not read; no round-1 report/finding file was opened (verified by tool-call record). Only the six files assigned `lane: runtime-governance` were audited.

### Assigned files — full-read / hash / line attestation

| # | Path | Manifest SHA-256 | Computed SHA-256 | Manifest lines | Computed lines | Bytes (manifest/computed) | Attest |
|---|---|---|---|---|---|---|---|
| 1 | docs/zob/06-MISSION_CONTROL_TUI.md | 8a46b029c87209ca30f96a09397d87df40ab51fcff1d228954ce1b22a272f619 | 8a46b029c87209ca30f96a09397d87df40ab51fcff1d228954ce1b22a272f619 | 201 | 201 | 8752 / 8752 | PASS |
| 2 | docs/zob/07-PERSISTENCE_AND_RECOVERY.md | 64cecd1b1a3c165e3c1f7fb48a5edc8b1b886e91d03c2c21838c761c5b81313c | 64cecd1b1a3c165e3c1f7fb48a5edc8b1b886e91d03c2c21838c761c5b81313c | 182 | 182 | 6910 / 6910 | PASS |
| 3 | docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md | fd83c760c502aabd0501b44eec9dfb1d523dc6e317a875575c4ba9eb0b76495b | fd83c760c502aabd0501b44eec9dfb1d523dc6e317a875575c4ba9eb0b76495b | 177 | 177 | 8248 / 8248 | PASS |
| 4 | docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md | 932d68d17c754a2c4fd6c6378c9ab0897db1942f120b123775afadf8f62b8485 | 932d68d17c754a2c4fd6c6378c9ab0897db1942f120b123775afadf8f62b8485 | 213 | 213 | 8226 / 8226 | PASS |
| 5 | docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md | 0fcce486195bb7b6b11efacafcb3456ab25153501c30ead54239779f899c77e6 | 0fcce486195bb7b6b11efacafcb3456ab25153501c30ead54239779f899c77e6 | 190 | 190 | 7729 / 7729 | PASS |
| 6 | docs/zob/11-EVIDENCE_AND_GITHUB_CHECKS.md | 937208a0169c202fc1bcf77457e687f750db6493beb2ceb0f7574cf689ddbd38 | 937208a0169c202fc1bcf77457e687f750db6493beb2ceb0f7574cf689ddbd38 | 169 | 169 | 10158 / 10158 | PASS |

All six files were full-read start-to-end (read tool, no offset skipping). SHA-256, line count and byte count match the manifest for every assigned file. **File attestation: PASS (6/6).**

## Truth-class and maturity baseline

All six files carry `**Truth class:** Approved design` (06:3, 07:3, 08:3, 09:3, 11:3; 10:3). Per AGENTS.md, `docs/zob/` is the approved architecture/implementation specification for a future installable system, deliberately disabled-by-default, and does not authorize live execution, branch creation, protection/workflow changes, staging merges, develop promotions or deployment. The lane files honor this: design-only capability is marked honestly and future/enhancement items are gated, not claimed as implemented.

## MUST-DO checklist findings

Each item: finding with path:line, severity, current_branch_fix (the in-doc mechanism already present), verdict.

### 1. window / candidate / repair / receipt / invalidation lineage — PASS

- 06:100-109 (Staging and Promotion view): initial staging SHA, current candidate revision/SHA, authorized repair lineage, unrelated-merge queue, assurance round 1–3, repair PRs, full-CI reruns, invalidated rounds, audited staging SHA, develop base, merge-commit relation, automatic-CD impact, post-promotion reconciliation, staging fast-forward, aligned-head CI, queue unfreeze — full lineage surfaced.
- 08:91-96 (Staging Merge App): red interlock merges only the exact failure-bound repair PR; promotion freeze merges only finding-bound repair PRs authorized by the active window/candidate revision; no write/merge to `develop`/`main`.
- 08:160 (ACK): promotion-window freezes unrelated merges and binds initial→authorized-repair candidate lineage; promotion-merge authorizes one final exact audited merge-commit into `develop`.
- 11:65-73 (invalidation table): `authorized finding-bound repair merge during a window` → increment candidate revision, retain window lineage, stale prior assurance/promotion artifacts, require full staging CI + next assurance round; `unrelated/unrecorded frozen staging movement or any develop base movement` → invalidate the window and every assurance/promotion Check/receipt until a new human-started exact boundary; `exact staging/promotion merge event, merge SHA or reconciliation output changes` → staging-integration, promotion/post-promotion and downstream deployment-confirmation evidence invalidated.
- 07:102 (checkpoint reason `factory-milestone`): promotion freeze/candidate revision/round/authorization/merge/aligned-head-CI event carries exact initial/current staging, prior-candidate, finding/repair and develop correlation in a body-safe payload.

Lineage is closed: window start → initial candidate → finding-bound repair descendants (candidate revision increments) → assurance round → final exact-head candidate → promotion-merge → reconciliation → aligned-head CI → queue unfreeze, with invalidation of every dependent artifact on unrelated movement. **Verdict: PASS.** Severity: n/a. current_branch_fix: present and consistent across 06/07/08/11.

### 2. body-safe persistence — PASS

- 07:38 (event envelope): body-safe payload only.
- 07:80 (`zob-mission-state` stores body-safe milestone snapshots).
- 07:102 (factory-milestone payload is body-safe).
- 07:160 (redaction before encryption).
- 07:165 (No prompt/output body enters SQLite, normal journal, Git or PR evidence).
- 07:167 (ZOB never auto-deletes; hard threshold pauses dispatch and creates needs-human).
- 07:169 (keychain init failure blocks admission instead of writing plaintext).
- 11:5-17 (Body policy: may contain IDs/refs/hashes/enums/timestamps/status/counts + protected-telemetry operational metadata only; may not contain credentials, raw prompts, raw model/provider responses, full tool output, raw diffs, private transcripts, sensitive URLs; full transcripts remain encrypted local data).
- 09:70 (No credential/base URL/private body stored), 09:77 (seeds persisted in telemetry, never exposed to agent contexts), 09:183 (worker/reviewer contexts cannot read telemetry or run unscoped `gh`/process-list/session-inspection).

No secret/credential/plaintext/raw-prompt/raw-response path into SQLite, journal, Git, PR evidence or shared checkpoints. **Verdict: PASS.** Severity: n/a.

### 3. ACK scope — PASS

- 08:129-131 (ackType tokens: `promotion-window`, `promotion-merge`, deployment-impact acknowledgement).
- 08:135 (first valid answer authoritative for ordinary cards; conflicting later answer → conflict card; revocation/supersession is a new append-only receipt linked by `supersedesReceiptId`; cancels only unconsumed future actions; never erases original; never reverses an already-performed irreversible action — instead a remediation/incident card).
- 08:148 (low-risk independent answers batchable, each separate receipt).
- 08:152-160 (never generic batch: process/trust/destructive ACK, override, takeover, activation, promotion-window start/abandon, promotion-merge authorization, deployment-impact; ordinary staging merges have no human batch form; promotion-window and promotion-merge are separate purpose-built forms).
- 06:82-84 (separate high-risk ACK/override/takeover/promotion-window/promotion-merge forms; high-risk receipts not accepted via generic batch; window freezes unrelated merges at initial candidate and exposes only finding-bound repair descendants; does not authorize the later develop merge; promotion-merge has its own final-candidate exact-head UI after assurance and CI pass).
- 06:177 (data changing while a confirmation is open invalidates the stale form).

ACK scope is separated, receipt-bound, append-only, and irreversible-action-safe. **Verdict: PASS.** Severity: n/a.

### 4. App least privilege and workflow denial — PASS

- 08:78-83 (Builder App: feature contents write, PR/check/comment/approved lifecycle-label write, checks/actions read; no ready/merge/workflow/deploy/admin).
- 08:85-89 (Reviewer App: contents/diff/check/review read, formal review/comment/check/approved review-label write; no source write/ready/merge/workflow/deploy/admin).
- 08:91-96 (Staging Merge App: read + ready/Staging Merge/Integration Check/comment + expected-head squash merge only when base is `develop-staging`; red interlock → only exact failure-bound repair PR; promotion freeze → only finding-bound repair PRs; no write/merge to `develop`/`main`, no repair push/workflow-dispatch/deploy/environment/secret/admin bypass; CI push-triggered and observed).
- 08:98-104 (Promotion App: dormant except active human-started window; read + Promotion Authorization/Gate Check write; expected-head merge-commit only for typed `develop-staging`→`develop` promotion PR; expected-head fast-forward of `develop-staging` only to the successful promotion merge SHA after reconciliation; no source repair/workflow dispatch/environment/secret/admin bypass).
- 08:106 (separate identities prevent the continuously running staging merger from holding credentials capable of merging `develop`).
- 08:168-175 (Denied-by-design: no secrets/auth-file read; no direct push of protected branches outside the two typed broker operations; no merge outside Staging Merge/Promotion broker with correct App/base/method/evidence; no deployment workflow trigger; no branch-protection alter; no admin/bypass/force flags; no silent risk/profile/review lowering; no ACK-label-as-human-intent).

Workflow dispatch and deployment are explicitly denied to every agent/factory; deployment trigger is reserved for the develop promotion merge only and recorded without manual dispatch (11:142). **Verdict: PASS.** Severity: n/a.

### 5. exact-SHA Check issuers — PASS

11:83-111 maps each canonical Check to exactly one App and an exact SHA binding:

- `ZOB / PR Close` — Builder App; exact head (11:83).
- `ZOB / Blind Review` — Reviewer App; exact head/base relation (11:87).
- `ZOB / Human Gates` — Supervisor projection of authenticated human receipts; exact head/process-diff/promotion scope; cannot create human authority (11:91).
- `ZOB / Staging Merge Gate` — Staging Merge App; exact ordinary PR head/base (11:95).
- `ZOB / Staging Integration` — Staging Merge App; exact `develop-staging` SHA (11:99).
- `ZOB / Repository Assurance` — Reviewer App; exact frozen staging/develop boundary (11:103).
- `ZOB / Promotion Authorization` — Promotion App; exact promotion PR/staging/develop heads (11:107).
- `ZOB / Promotion Gate` — Promotion App; exact pre-merge promotion PR (11:111).

Issuer-to-App binding is consistent with the App least-privilege scopes in 08:78-104 (Builder→PR Close, Reviewer→Blind Review + Repository Assurance, Staging Merge→Staging Merge Gate + Staging Integration, Promotion→Promotion Authorization + Promotion Gate, Supervisor→Human Gates). Current issuer tokens 11:40 (`supervisor`, `builder-app`, `reviewer-app`, `staging-merge-app`, `promotion-app`, `ci`, `human`) match the App identities. Human-readable comments/labels are explicitly non-authoritative (11:113). **Verdict: PASS.** Severity: n/a.

### 6. model/prompt blindness — PASS

- 09:20-26 (mission-visible identities are opaque agentId/runId/attemptId/assignmentId only; agents/orchestrator do not receive own or peers' provider/model/family/thinking/prompt treatment/reputation/stable pseudonym).
- 09:28-32 (human Models view + protected telemetry resolve assignmentId → provider route + model/version + actual thinking + prompt variant; launcher/tool/session/process metadata sanitized/denied to prevent leakage via CLI args/logs/session files/process inspection).
- 09:70 (no credential/base URL/private body stored).
- 09:72-77 (cryptographic random private task seed; domain-separated `model-order` and `prompt-treatment` seeds via HKDF with exact info labels; commitments + protected seeds in telemetry, never exposed to agent contexts).
- 09:183 (story branches/checkpoints use opaque IDs; worker/reviewer contexts cannot read telemetry or run unscoped `gh`/process-list/session-inspection).
- 09:126-127 (prompt text does not name model/treatment; raw compiled prompts do not enter committed story evidence).
- 06:132-141 (human-only Models view: role pool snapshot, shuffled order, provider route/family/model/version, requested/actual thinking, prompt control/candidate assignment, usage/cost/outcome/failure class, independence degradation, provider health; "Agents never receive this projection").
- 07:165 (no prompt/output body enters SQLite/journal/Git/PR evidence).

No model/prompt identity leakage path identified. Per AGENTS.md rule 6, model/thinking/prompt assignment mappings are kept outside agent-readable story evidence — satisfied by 09:126-127 and 07:165. **Verdict: PASS.** Severity: n/a.

### 7. degraded-family and non-pass no-ship truth — PASS

- 09:100-103 (independence: prefer different provider/model family; otherwise different exact model; same model is a visible degraded fallback; critical policy may require human/additional review when independence degrades).
- 09:129 (assurance uses at least three eligible model families where available; if fewer than three eligible, record `degraded=true` plus a reason hash and apply the configured human/no-ship policy; cannot report undegraded independence).
- 09:124-127 (formal review/final repository assurance always retain required stable control coverage; experimental shadows may find validated blockers but cannot clear a PR or staging candidate alone).
- 10:147 (if full acceptance includes publish/deploy/live action, admission splits build/PR-close/staging versus promotion/post-promotion/live acceptance; if the bundle cannot authorize that split, needs-human blocks false completion; ordinary story profiles never authorize a develop promotion or deployment).
- 11:142 (cancelled, superseded, missing or unknown checks do not silently pass; acceptable skipped/neutral conclusions must be policy-declared).
- 11:165 (no lower layer can self-certify a higher one) — non-pass at any layer cannot be smoothed into a pass at a higher layer.

Degraded independence is forced visible (`degraded=true`) and bound to human/no-ship policy; non-pass CI/checks never silently pass; false completion is blocked by needs-human. **Verdict: PASS.** Severity: n/a.

### 8. separate Story / Review / Staging / Assurance / Promotion / Deployment authority — PASS

- 11:157-165 (claim-vs-completion hierarchy): agent output/final marker = claim; parent validation/review = accepted task evidence; gate closure aggregates accepted required tasks; PR-close aggregates current gates/CI/audits; Blind Review independently evaluates the PR; Staging Merge mechanically revalidates and integrates one PR, then full staging CI validates the combined head; Final Repository Assurance independently evaluates the whole frozen repository and documentation coverage; Promotion mechanically revalidates assurance/CI/receipts and merge-commits only the exact authorized candidate; no lower layer can self-certify a higher one.
- 10:170 (final assurance is a factory-level profile, not a story base/overlay; cannot be weakened by any story profile or sampled scan).
- 10:147 (ordinary story profiles never authorize a develop promotion or deployment).
- 08:24-44 (role boundaries): supervisor (no deploy), orchestrator-model (no GitHub mutation/permission grant/work acceptance), developer (no commit/push/telemetry/credentials/manifest/GitHub/peer contact), QA/doc/reviewer (role-specific; blind review + final repository-assurance lanes are source-read/report-only; assurance repair workers are fresh builder-role agents on separate repair PRs and cannot accept their own work), integration owner (no ready/merge/deploy), PR-close auditors (read-only exact-head; cannot repair or publish their own verdict), human (sole authority for product/trust/destructive/spend/override/takeover/activation, promotion-window start/abandon, exact-head develop-promotion authorization, deployment-impact receipts).
- 08:78-104 (four separate GitHub App identities with non-overlapping mutation authority; staging vs promotion separated; deployment trigger reserved for develop promotion merge only, recorded without manual dispatch — 11:142).

All six authority layers are separated and mechanically/independently bounded. **Verdict: PASS.** Severity: n/a.

### 9. aligned-head CI — PASS

- 06:109 (post-promotion reconciliation, staging fast-forward, aligned-head integration CI and queue unfreeze).
- 08:71 (broker operation `fast-forward-staging-after-promotion`).
- 08:104 (expected-head fast-forward of `develop-staging` only to the successful promotion merge SHA after reconciliation).
- 11:140 (post-promotion staging fast-forward creates a new SHA; full staging integration CI and a current Check on that aligned SHA pass before queue unfreeze).
- 07:102 (aligned-head-CI event is a `factory-milestone` checkpoint with exact correlation in body-safe payload).

The aligned-head CI gate is closed: fast-forward produces a new SHA → full staging integration CI + current Check on that aligned SHA → queue unfreeze only after pass. **Verdict: PASS.** Severity: n/a.

### 10. legacy read-only rejection — PASS

- 08:133 (legacy `merge-batch` ACK parseable only for read-only historical/non-Wheel migration; Wheel adapter rejects it — and legacy `pr-ship`, `post-merge`, `ship-gate`, `ship-app` authority — for every newly admitted mission, profile, Check or mutation request; no legacy artifact can authorize an ordinary staging merge or develop promotion).
- 11:40 (current evidence tokens exclude `merge-authorization`, `ship-gate`, `post-merge` as authority — parseable only by read-only historical migration adapter; current issuer tokens exclude `ship-app` as legacy; Wheel adapter rejects every legacy token/issuer as authority for a new Check, mission or mutation).
- 11:131 (New Wheel evaluations fail closed on legacy direct-base factory/evidence/issuer/merge-batch tokens; no early `human-override` exit, no title-only exemption, no bare-label proof).

Legacy tokens are read-only-parseable but never authoritative for new admits/Checks/mutations/promotions. Rejection set is consistent across 08 and 11. **Verdict: PASS.** Severity: n/a.

### 11. Specified-disabled maturity — PASS

- All six files: `**Truth class:** Approved design` — design-only, not implemented/installed/activated/validated (AGENTS.md rule 10 honored).
- 09:4 (`**Exact pool state:** Deferred until gated provider capability audit`); 09:58 (`Exact IDs are not guessed. They are filled after fireconnect and OpenAI OAuth capability tests`); 09:116 (`declared but not yet implemented fleet-bakeoff optimized/both modes`); 09:118 (`This becomes the seed catalog, not automatic truth`); 09:11 (`never auto-promote learned policy`); 09:198 (`No runtime self-modifies routing or prompt policy`).
- 06:185 (future external notification adapter is enhancement-gated).
- 07:76 (optional webhooks are an enhancement; polling remains reconciliation fallback).
- 07:136 (encrypted transcripts non-portable unless explicitly exported through a future gated mechanism).
- 10:170 (assurance requirements specified as design contract, not claimed as live).

No design-only capability is overstated as implemented/activated. "Specified" is honestly distinguished from "implemented/installed/activated/validated." **Verdict: PASS.** Severity: n/a.

## Cross-file consistency checks (within lane)

| Check | Files | Result |
|---|---|---|
| Attempt `outcome` terminal vocabulary `accepted\|rejected\|failed\|blocked\|cancelled\|lost\|superseded` | 06:18, 07:179, 09:144 | PASS — identical 7-token set |
| Attempt status vocabulary | 06:18, 07:174-178 | PASS — `dispatch-reserved`/`launching`/`running`/`claim-returned`/`validating`/`needs-review` consistent; preflight/process-started/agent-acknowledged are transition events in both |
| Task status vocabulary | 06:16, 07:174 | PASS — `in-progress` is a projection of a non-terminal active attempt, not a synonym for attempt `running` |
| Check issuer ↔ App binding | 11:83-111 vs 08:78-104 | PASS — every Check's App matches the App's allowed mutation scope |
| Issuer token allowlist | 11:40 vs 08 Apps | PASS — `supervisor/builder-app/reviewer-app/staging-merge-app/promotion-app/ci/human`; `ship-app` legacy-only |
| Legacy rejection set | 08:133 vs 11:40,131 | PASS — `merge-batch/pr-ship/post-merge/ship-gate/ship-app` all rejected for new authority |
| Aligned-head CI lineage | 06:109, 08:104, 11:140, 07:102 | PASS — closed loop |
| Promotion-window freeze scope | 06:84, 08:91-96,160, 11:69 | PASS — freezes unrelated merges, allows only finding-bound repair descendants, does not authorize develop merge |
| Body-safe persistence | 07:38,80,102,165-169, 11:5-17, 09:70,183 | PASS — no secret/raw-body path into persisted/shared/PR evidence |
| Independence degradation truth | 09:100-103,129, 10:147 | PASS — `degraded=true` forced, human/no-ship policy applied |
| Authority separation | 11:157-165, 10:147,170, 08:24-44,78-104 | PASS — six layers distinct, no self-certification |

## Bounded warnings (cross-lane dependencies, not lane defects)

- **W1 (LOW, cross-lane, not blocking):** 06:~100 and 10:170 reference "ten lanes in section 17" and the assurance round (1–3)/ten-lane dispositions. Section 17 (`17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md`) is in the `core-factories` lane and was not in this lane's assigned set; the ten-lane contract and canonical-doc manifest could not be verified from runtime-governance files alone. Internal references are consistent, but completeness depends on the core-factories lane audit. Severity LOW. current_branch_fix: none required in this lane; cross-reference is correct as written.
- **W2 (LOW, cosmetic):** 09:3-4 header lines carry trailing whitespace after "Approved design" and "Deferred until gated provider capability audit". No semantic impact; cosmetic only. Severity LOW. current_branch_fix: optional whitespace trim.

No FAIL findings. No WARN finding rises to a governance defect. Both warnings are bounded and non-blocking.

## Summary verdict

| MUST-DO item | Verdict |
|---|---|
| window/candidate/repair/receipt/invalidation lineage | PASS |
| body-safe persistence | PASS |
| ACK scope | PASS |
| App least privilege and workflow denial | PASS |
| exact-SHA Check issuers | PASS |
| model/prompt blindness | PASS |
| degraded-family and non-pass no-ship truth | PASS |
| separate Story/Review/Staging/Assurance/Promotion/Deployment authority | PASS |
| aligned-head CI | PASS |
| legacy read-only rejection | PASS |
| Specified-disabled maturity | PASS |

**Lane verdict: PASS** (11/11 MUST-DO items PASS; 0 FAIL; 2 LOW non-blocking warnings, both cross-lane/cosmetic).

**no_ship: false** — no defect in the runtime-governance lane requires blocking shipment of this documentation. The lane files honestly mark themselves "Approved design / disabled-by-default," enforce no-ship semantics for degraded independence and non-pass CI/checks, deny deployment/workflow authority to agents/factories, and make no live-execution, activation, merge, promotion or deployment claim. Per AGENTS.md, `docs/zob/` does not authorize live execution; this audit confirms the runtime-governance files do not contradict that.

## Audit constraints honored

- Read-only: no source edits, no schema/example edits, no validation script edits.
- No network, no secrets, no credentials, no provider calls.
- No commit, push, merge, deploy, activate, branch-protection or workflow change.
- No labels, comments, Checks or ACKs accepted as authority.
- No round-1 report or finding file was read (exclusion `docs/zob/reviews/**` for round-1 honored; only round-2 SCOPE_MANIFEST.json and the six assigned lane files were read).
- Only `docs/zob/reviews/staging-design-2026-07-18/round-2/LANE_RUNTIME_GOVERNANCE.md` was written.

LANE_AUDIT_COMPLETE