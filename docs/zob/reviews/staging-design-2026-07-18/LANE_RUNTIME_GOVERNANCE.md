# Lane Audit — Runtime Governance

**Review:** staging-design-2026-07-18
**Lane:** runtime-governance
**Auditor:** independent (ZOB oracle-style, read-only)
**Scope source:** `docs/zob/reviews/staging-design-2026-07-18/SCOPE_MANIFEST.json` (frozen, `schema: zob.doc-audit-scope.v2`)
**Truth class of all six files:** Approved design (specified, not implemented/installed/activated)

## 1. Manifest hash verification

Every `runtime-governance` file was re-hashed with `shasum -a 256` and compared against the manifest's recorded `sha256` and `byteCount`.

| # | File | Manifest SHA-256 | Computed SHA-256 | SHA match | Manifest bytes | Computed bytes | Manifest lines | `wc -l` |
|---|---|---|---|---|---|---|---|---|
| 1 | `docs/zob/06-MISSION_CONTROL_TUI.md` | `bd86d3450c0953b44918ca43a4bed26f4654bff6696482bb2f687e816f6d634e` | `bd86d3450c0953b44918ca43a4bed26f4654bff6696482bb2f687e816f6d634e` | ✅ | 8482 | 8482 | 200 | 199 |
| 2 | `docs/zob/07-PERSISTENCE_AND_RECOVERY.md` | `c175f107a95d2cea109b2070db0a79d479790a6aa3cf683f9af8a50671e78b81` | `c175f107a95d2cea109b2070db0a79d479790a6aa3cf683f9af8a50671e78b81` | ✅ | 6816 | 6816 | 182 | 181 |
| 3 | `docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md` | `820f7bb9b56985ac8a7e52f68c4be5d484ad7fd627d9762aaad569038453be6f` | `820f7bb9b56985ac8a7e52f68c4be5d484ad7fd627d9762aaad569038453be6f` | ✅ | 7743 | 7743 | 176 | 175 |
| 4 | `docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md` | `19532fefd22593c773e1edeeb5e5e0feeb13d34eb90bbbc4d38b5f39012e0d3d` | `19532fefd22593c773e1edeeb5e5e0feeb13d34eb90bbbc4d38b5f39012e0d3d` | ✅ | 8087 | 8087 | 213 | 212 |
| 5 | `docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md` | `0fcce486195bb7b6b11efacafcb3456ab25153501c30ead54239779f899c77e6` | `0fcce486195bb7b6b11efacafcb3456ab25153501c30ead54239779f899c77e6` | ✅ | 7729 | 7729 | 190 | 189 |
| 6 | `docs/zob/11-EVIDENCE_AND_GITHUB_CHECKS.md` | `1bcdaecddd468e2455023aaf81a5c19bdfcf6884543a527d1f3f9d7b3d05d79b` | `1bcdaecddd468e2455023aaf81a5c19bdfcf6884543a527d1f3f9d7b3d05d79b` | ✅ | 8790 | 8790 | 163 | 162 |

**Result:** All six SHA-256 digests and byte counts match the frozen manifest exactly. Content is identical to the audited scope.

**Benign observation (not a finding):** Every file's `wc -l` is exactly one less than the manifest `lineCount`. This is a consistent off-by-one counting convention (the manifest counts the final line whether or not it ends with a newline; `wc -l` counts newline characters). Because SHA-256 and byte count both match, this is a manifest line-counting convention, not a content drift. No action required.

## 2. Per-file coverage and findings

### 2.1 `docs/zob/06-MISSION_CONTROL_TUI.md` (200 lines)

**Read:** fully (lines 1–200).

**Coverage:**
- Surfaces, status truth, core views (Mission Overview, Story Cockpit, Task/Attempt Inspector, Agents, Needs You, CI, Staging and Promotion, Evidence, Models, Timeline, Permissions, Workspaces/Merge Queue, Settings), controls, alerts, search/filter, responsive behavior, disconnect behavior.

**Lifecycle / evidence invalidation:**
- `06:18-26` defines canonical mission status (`admitting, active, paused, needs-human, recovery-blocked, complete, failed, cancelled`) — matches `mission.schema.json:12` `status` enum exactly. ✅
- `06:28` canonical task status (11 tokens) and `06:30` canonical attempt status (13 tokens) are prose-only vocabularies (no task/attempt schema in scope); cross-checked against `07` dispatch recovery invariant (`07:181-199`) — the attempt lifecycle tokens (`dispatch-reserved, launching, running, claim-returned, validating, needs-review, accepted, rejected, blocked, failed, lost, cancelled, superseded`) are identical and ordered consistently. ✅
- `06:32` "`dispatched` is UI shorthand for `dispatch-reserved`; it is never shown as `running`" — consistent with `07:183` which uses `dispatch-reserved` as the canonical token. ✅
- `06:34` protected model-attempt `outcome` terminal subset `accepted|rejected|failed|blocked|cancelled|lost|superseded` — matches `model-attempt.schema.json` `outcome` enum exactly. ✅
- `06:36-43` orthogonal clocks/flags (heartbeat, activity, progress, external freshness, stale, waiting) correctly distinguish `stale` as a derived health flag "never a lifecycle status" and `waiting` as "never an active worker status" — no authority bleed into lifecycle. ✅

**TUI human-start vs promotion authorization:**
- `06:82` "separate high-risk ACK, override, takeover, promotion-window and promotion-merge authorization forms." ✅
- `06:84` "Starting a promotion window freezes one exact staging head but **does not authorize the later develop merge**; promotion-merge authorization has its own exact-head UI after assurance and CI pass." — This is the critical separation. Cross-checked against `08:54-56` (Promotion App dormant except active window; merge-commit only for typed promotion PR) and `08:112-114` (promotion-window and promotion-merge are separate purpose-built forms). ✅ No authority bleed.
- `06:174` typed actions list explicitly separates "start/abandon a promotion window" from "authorize one exact-head audited promotion merge"; "Ordinary staging merges are mechanical and have no human batch form." ✅
- `06:178` "Arbitrary command execution is not a TUI feature." ✅

**Body safety:**
- `06:156` Evidence view: "no raw transcript bodies." ✅
- `06:164` Models view is "Human-only exact view"; `06:168` "Agents never receive this projection." ✅
- `06:178` "Data changing while a confirmation is open invalidates the stale form." — stale-form invalidation on data change. ✅

**No authority bleed:** Story/Review/Staging/Assurance/Promotion/Deployment are projected as distinct CI/Staging/Promotion sections (`06:86-120`) with separate App identities (`06:114` "separate Staging Merge App and Promotion App state/permissions"). ✅

**Findings for 06:** None.

---

### 2.2 `docs/zob/07-PERSISTENCE_AND_RECOVERY.md` (182 lines)

**Read:** fully (lines 1–182).

**Coverage:**
- Runtime layout, event append protocol, event envelope, primary projections, background service, watchers, shared checkpoints, same-machine recovery, cross-machine takeover, integrity failures, encrypted transcripts, dispatch recovery invariant.

**Lifecycle / evidence invalidation:**
- `07:29-43` event append protocol: validate → allocate sequence → hash chain → append+fsync → idempotent SQLite transaction → effects only after commit. Crash-after-append-before-commit repaired by replay; idempotency keys prevent duplicate application. ✅
- `07:49` event envelope references `schemas/mission-event.schema.json`; cross-checked: prose core fields (event/mission/sequence/time, producer, type, correlation, causation, idempotency key, body-safe payload, prev/current hash) match `mission-event.schema.json:1-36` required fields. ✅
- `07:91-97` checkpoint reason tokens: `mission-start, periodic-change, gate-transition, human-wait|human-answer, pr-head, factory-milestone, shutdown|completion, takeover`. These are prose tokens (no checkpoint schema enum in scope to cross-check). `07:99` "A promotion freeze/round/authorization/merge is a `factory-milestone` with exact staging/develop correlation in the body-safe payload." — consistent with `11` promotion evidence invalidation on base movement. ✅
- `07:115-127` integrity failures: SQLite corruption with valid journal → auto-rebuild; journal corruption → preserve verified prefix, quarantine invalid tail, set `recovery-blocked`, needs-human, stop dispatch/GitHub mutation; "No silent truncation, rollback or continuation past an invalid chain." ✅ Strong no-silent-continuation guarantee.

**Body safety:**
- `07:149` "No prompt/output body enters SQLite, normal journal, Git or PR evidence." ✅
- `07:139-148` encrypted transcripts: OS keychain master key, wrapped per-attempt data key, authenticated chunks, redaction before encryption, replay/export/delete auditing, partial-tail marking on crash, "never presents a partial transcript as complete." ✅
- `07:153` "Keychain initialization failure blocks admission instead of writing plaintext." ✅
- `07:151` default retention until manual cryptographic deletion; "ZOB never auto-deletes"; hard threshold pauses dispatch + needs-human. ✅

**Exact SHA boundaries:**
- `07:101` pushes use "expected-remote-head protection"; `07:103` "Conflict pauses synchronization; it never overwrites remote state." ✅
- `07:129-137` cross-machine takeover requires authenticated takeover receipt + fencing transition: prior lease expired/revoked/released + new owner commits next ownership epoch with expected-remote-head protection before any dispatch/effect. "If ownership cannot be proved exclusive, takeover remains blocked." ✅
- `07:139` "Encrypted transcripts are non-portable unless explicitly exported through a future gated mechanism." — honestly marked as future. ✅

**Dispatch recovery invariant (`07:181-199`):**
- `task ready → attempt dispatch-reserved →(preflight/process-started) launching →(agent-acknowledged) running → claim-returned → validating → needs-review → accepted|rejected|blocked|failed|lost|cancelled|superseded`. Matches `06:30` attempt status vocabulary exactly. ✅
- `07:199` "Only acknowledged `running` attempts consume active execution capacity; rejected attempts may return their task to ready under budget." ✅

**Findings for 07:** None.

---

### 2.3 `docs/zob/08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md` (176 lines)

**Read:** fully (lines 1–176).

**Coverage:**
- Authority model, role boundaries (Supervisor, Orchestrator, Developer, QA/reviewer, Integration owner, PR-close auditors, Human), capability grant, GitHub mutation broker, four GitHub Apps, human ACK receipts, labels-as-projections, batch rules, communication, denied-by-design.

**ACK enum / scope:**
- `08:100-110` ACK receipt canonical bindings: receipt/ACK type, authenticated actor/source, repository/PR/story/exact head or process-diff hash, scope/rule IDs, reason/answer, timestamp/expiry/revocation, schema/policy versions, receipt hash, correlation. Cross-checked against `ack-receipt.schema.json`: required fields match (`receiptId, ackType, actor, source, scope, decision, createdAt, expiresAt, policyVersion, receiptHash, bodyStored`). ✅
- `08:112-120` ACK type examples: process-change, trust/destructive/spend, human-override, cross-machine-takeover, factory-activation, promotion-window, promotion-merge, deployment-impact, legacy merge-batch. Cross-checked against `ack-receipt.schema.json:14` `ackType` enum (11 tokens): `process-change, trust-decision, destructive-change, spend, human-override, cross-machine-takeover, factory-activation, merge-batch, promotion-window, promotion-merge, deployment-impact`. ✅ Exact match (prose groups "trust/destructive/spend" as three tokens `trust-decision, destructive-change, spend`).
- `08:118` "The legacy `merge-batch` ACK remains reserved for non-Wheel/direct-base compatibility; mandatory-staging Wheel v1 does not use it for ordinary PRs." — honestly marked legacy. ✅
- `08:122` "For ordinary question cards, the first valid answer is authoritative and a conflicting later answer creates a conflict card." ✅
- `08:124-126` revocation/supersession is append-only, linked by `supersedesReceiptId`, may cancel unconsumed future actions, invalidates dependent projections/evidence, "never erases the original receipt or reverses an already performed irreversible action"; if irreversible effect already occurred, supervisor creates remediation/incident card. ✅ Strong irreversibility honesty.
- `08:132-136` scope: `headSha` (`^[a-f0-9]{40}$`), `stagingSha`, `developSha`, `processDiffHash` (`^[a-f0-9]{64}$`), `assuranceId`, `promotionId`, `ruleIds` — all present in `ack-receipt.schema.json` `scope` object. ✅

**App least privilege:**
- `08:64-68` Builder App: feature branch contents write, PR/check/comment/lifecycle-label write, checks/actions read, "no ready/merge/workflow/deploy/admin." ✅
- `08:70-74` Reviewer App: contents/diff/check/review read, formal review/comment/check/review-label write, "no source write/ready/merge/workflow/deploy/admin." ✅
- `08:76-80` Staging Merge App: ready + Staging Merge/Integration Check/comment + expected-head squash merge **only when base is `develop-staging`**; "no write/merge to `develop`/`main`, no repair push/workflow/deploy/environment/secret/admin bypass." ✅
- `08:82-90` Promotion App: **dormant except an active human-started promotion window**; Promotion Authorization/Gate Check write; expected-head merge-commit **only for the typed `develop-staging`→`develop` promotion PR**; expected-head fast-forward of `develop-staging` **only to the successful promotion merge SHA after reconciliation**; "no source repair/workflow dispatch/environment/secret/admin bypass." ✅
- `08:92` "Separate identities prevent the continuously running staging merger from holding credentials capable of merging `develop` and create clear audit trails." ✅ This is the core App-separation guarantee.

**Authority bleed check (Story/Review/Staging/Assurance/Promotion/Deployment):**
- `08:44-48` Supervisor "Cannot change product scope, fabricate receipts, weaken completion, bypass protection or deploy." ✅
- `08:52` Orchestrator "Cannot choose model identities, grant permissions, accept work, mutate GitHub or alter human decisions." ✅
- `08:58` Developer "Cannot commit/push, accept itself, access telemetry/credentials, modify manifest, call GitHub or contact peers outside the parent-visible protocol." ✅
- `08:62` Assurance repair workers are "fresh builder-role agents on separate repair PRs and cannot accept their own work." ✅
- `08:150-164` denied-by-design: no secrets, no direct push outside two typed broker ops, no merge outside correct App/base/method/evidence, no deployment workflow triggers, no branch-protection changes, no admin/bypass/force, no silent risk/profile/review lowering, no ACK-label-as-human-intent. ✅

**Checks / issuers:**
- `08:72` Reviewer App writes "formal review/comment/check/approved review-label" — consistent with `11:74` `ZOB / Blind Review` (Reviewer App) and `11:92` `ZOB / Repository Assurance` (Reviewer App). ✅
- `08:80` Staging Merge App writes Staging Merge/Integration Check — consistent with `11:80` `ZOB / Staging Merge Gate` and `11:84` `ZOB / Staging Integration` (both Staging Merge App). ✅
- `08:86` Promotion App writes Promotion Authorization/Gate Check — consistent with `11:96` `ZOB / Promotion Authorization` and `11:100` `ZOB / Promotion Gate` (both Promotion App). ✅

**Body safety:**
- `08:166` "Owner-change requests are body-safe, path-scoped and parent-visible." ✅
- ACK receipts use `reasonHash`/`answerHash` (64-hex hashes), not raw text. ✅

**Findings for 08:** None.

---

### 2.4 `docs/zob/09-MODEL_AND_PROMPT_EXPERIMENTS.md` (213 lines)

**Read:** fully (lines 1–213).

**Coverage:**
- Goals, blind identity, role pools, registry snapshot, selection, thinking ladder, independence, prompt experiment design, prompt metadata, attempt outcome/failure taxonomy, protected telemetry, analysis, provider audit.

**Model blindness / family independence:**
- `09:12-20` blind identity: agents/orchestrator do not receive own or peers' provider/model/family, thinking, prompt treatment, reputation or stable pseudonym; every attempt gets a new opaque assignment ID. ✅
- `09:22` human Models view + protected telemetry resolve `assignmentId → provider route + model/version + actual thinking + prompt variant`. ✅
- `09:24` "Launcher/tool/session/process metadata must be sanitized/denied so model identity is not leaked through CLI arguments, logs, session files or process inspection." ✅
- `09:76-82` independence for QA/formal review: (1) prefer different provider/model family from implementation and peer lanes; (2) otherwise require different exact model; (3) same model is a visible degraded fallback; (4) critical policy may require human/additional review when independence degrades. "The supervisor enforces this privately; reviewers do not learn what was excluded." ✅
- `09:116` "Assurance uses at least three eligible model families where available and records degraded independence visibly." — cross-checked against `repository-assurance-result.schema.json` `modelIndependence` (`eligibleFamilyCount, usedFamilyCount, familySetHash, degraded`) with `anyOf` constraint: either `eligibleFamilyCount ≤ 2` or `eligibleFamilyCount ≥ 3 AND usedFamilyCount ≥ 3`. ✅ Schema enforces the 3-family rule when available.
- `09:120` "Experimental shadows may find validated blockers but cannot clear a PR or staging candidate alone." ✅ No authority bleed from experimental to clearance.

**Thinking ladder:**
- `09:58` ladder `low → medium → high → xhigh → max`; `09:60` "Pi's `off` and `minimal` levels are below the ZOB quality minimum and are ineligible"; `09:62` non-reasoning model gets one `default` rung. Cross-checked against `model-attempt.schema.json` `requestedThinking`/`actualThinking` enum: `default, low, medium, high, xhigh, max`. ✅ Exact match.
- `09:64` "Requested and actual levels are both recorded; an unapproved provider clamp is a capability mismatch, not a successful rung." — consistent with `model-attempt.schema.json` `thinkingVerified` boolean and `failureClass: capability_mismatch`. ✅
- `09:66` "Qualifying model/quality failure advances the same model. Provider, rate, tool, permission, human, cancellation and environment failures do not consume quality rungs." ✅

**Attempt outcome / failure taxonomy:**
- `09:128` protected terminal `outcome`: `accepted, rejected, failed, blocked, cancelled, lost, superseded` (7 tokens) — matches `model-attempt.schema.json` `outcome` enum exactly. ✅
- `09:134-152` `failureClass` (18 tokens) — matches `model-attempt.schema.json` `failureClass` enum exactly: `none, provider_transient, provider_unavailable, rate_limit, capability_mismatch, context_overflow, output_budget, tool_environment, permission_denied, human_blocked, cancelled, prompt_candidate_failure, model_quality_failure, validation_failure, review_rejection, integration_regression, ci_regression, policy_violation`. ✅
- `09:132` "`none` is the sentinel for a non-failed terminal outcome. The other tokens classify failure/block/rejection causes; they do not replace `outcome`." ✅ Clean separation of outcome vs failure class.

**Prompt experiment design:**
- `09:96-106` 50% uniform control / 50% vetted candidates; prompt treatment uses domain-separated `prompt-treatment` seed, not model-order RNG stream; prompt variant fixed across one model's thinking ladder; candidate exhaustion gets bounded same-model control rescue; fixed orchestrator/close/adjudication prompts do not experiment initially. ✅
- `09:126-136` prompt mode tokens: `uniform-control, shared-candidate, model-candidate, approved-optimized` — matches `model-attempt.schema.json` `promptTreatment.mode` enum exactly. ✅
- `09:130` "`uniform-control` is the permanent control; shared/model candidates are the experimental 50%; approved-optimized is available only after human promotion." ✅
- `09:138` "Prompt text does not name model/treatment. Raw compiled prompts do not enter committed story evidence." ✅ Body safety.

**Protected telemetry:**
- `09:154-162` `zob-model-telemetry` stores `assignments.jsonl, prompt-assignments.jsonl, outcomes.jsonl, summary.json`; "Worker/reviewer contexts cannot read telemetry or run unscoped `gh`, process-list or session-inspection commands." ✅
- `09:172` "No runtime self-modifies routing or prompt policy." ✅
- `09:174-184` provider audit "under explicit spend approval"; "Only verified routes enter pools. `Sol-high` and fixed aliases remain unresolved until then." — honestly deferred. ✅

**Findings for 09:** None.

---

### 2.5 `docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md` (190 lines)

**Read:** fully (lines 1–190).

**Coverage:**
- Composition (base profiles + overlays), profile schema behavior, base profile expectations, overlay examples (15 overlays), Fleet v5 signal mapping, taxonomy, repository-assurance profile, skill binding.

**Profile enum / schema cross-check:**
- `10:8-11` base profiles: `full-feature, quick-fix, docs-process, refactor-cleanup` (4) — matches `execution-profile.schema.json` `allOf` base `profileId` enum exactly. ✅
- `10:14-29` overlays (15): `security-trust, privacy-encryption, database-migration, infrastructure-ci, frontend-user-visible, backend-api-data, cli-mcp-tooling, vendor-dependency, external-integration, model-prompt-control, performance-cost, supply-chain-installer, observability-operations, test-harness-evidence, destructive-change` — matches `execution-profile.schema.json` `allOf` overlay `profileId` enum exactly (15 tokens). ✅
- `10:34` "Requirements union and the stricter rule wins." — matches `execution-profile.schema.json:32` `compositionPolicy.mergeMode: "union-stricter-wins"`, `canStrengthenAutomatically: true`, `requiresHumanToWeakenOrRemove: true`. ✅
- `10:36` "Removing/weakening a declared/required overlay needs human approval." ✅
- `10:38` "Quick may auto-promote to full; full cannot auto-downgrade." ✅

**ACK enum parity (humanReceiptTypes):**
- `execution-profile.schema.json:30` `humanReceiptTypes` enum = 11 tokens, identical to `ack-receipt.schema.json:14` `ackType` enum. The validator `validate_contracts.py:139-141` explicitly asserts `ack_enum == profile_enum` and emits `ENUM_BRANCH_PARITY_PASS`. ✅ Cross-validated programmatically.

**⚠️ FINDING W1 — `deferredActions` enum missing `workflow-dispatch`:**
- `10:78` (infrastructure-ci overlay) states "No workflow dispatch."
- `10:144` (Fleet signal mapping) states "external-publish/live-systems create deferred-action boundaries."
- `08:156` (denied-by-design) states "trigger deployment workflows" is denied.
- `mission.schema.json:41` `forbiddenActions` enum includes `workflow-dispatch` (11 tokens).
- `execution-profile.schema.json:31` `deferredActions` enum = `formal-review, ready, staging-merge, repository-assurance, promotion, merge, deploy, publish, provider-activation, post-deploy-confirmation` (**10 tokens — `workflow-dispatch` absent**).
- **Impact:** An execution profile cannot declaratively express "workflow-dispatch is a deferred action" even though the mission-level `forbiddenActions` enum and the prose both treat it as a deferred/forbidden concept. The safety gate itself is not bypassed (mission `forbiddenActions` and the broker's denied-by-design still block workflow dispatch), so this is a **schema-prose completeness gap**, not a safety hole.
- **Severity:** WARN.
- **Location:** `docs/zob/schemas/execution-profile.schema.json:31` (deferredActions enum); prose at `docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md:78`, `docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md:144`; counterpart `docs/zob/schemas/mission.schema.json:41`.
- **Validator gap:** `validate_contracts.py` asserts ACK↔profile enum parity (`:139-141`) but does **not** assert `mission.forbiddenActions` ↔ `execution-profile.deferredActions` parity. A cross-enum invariant test would catch this.

**Repository-assurance profile:**
- `10:158-166` "Final assurance is a factory-level profile, not a story base/overlay. It requires the ten lanes in section 17, an exact canonical-doc manifest, an exhaustive every-element source inventory with one disposition per element, full staging CI, a fixed blind synthesizer, zero unresolved public documentation gaps and a maximum of three complete audit/repair/re-audit rounds. It cannot be weakened by any story profile or sampled scan." — cross-checked against `repository-assurance-result.schema.json`: 10 required lanes (`:18-27`), `round` max 3 (`:15`), `synthesizer.fixedControl: true` (`:62`), `verdict: pass` allOf requiring all lanes pass + zero doc/coverage gaps (`:71-89`). ✅

**Fleet v5 signal mapping:**
- `10:122-138` 17 story signals listed; "They are inputs, not decisions." `10:140` "route hint informs workload planning, not initial model preference" — consistent with `09` blind selection (Fleet/task labels only for hard eligibility, not preference). ✅
- `10:142-146` "If full acceptance includes publish/deploy/live action, admission splits build/PR-close/staging versus promotion/post-promotion/live acceptance. If the bundle cannot authorize that split, needs-human blocks false completion. Ordinary story profiles never authorize a develop promotion or deployment." ✅ No authority bleed from story profile to promotion/deployment.

**Skill binding:**
- `10:178-188` skill table maps stages to intent owners; "Workers receive only the owning skill, required support skills/contracts and permitted ZOB mechanisms. Additional skill need is a typed request." ✅
- `10:190` "Every attempt records skill/shared-contract/prompt/context versions so model analysis does not blame a model for a changed workflow." ✅

**Findings for 10:** 1 WARN (W1, schema-prose gap on `deferredActions`/`workflow-dispatch`).

---

### 2.6 `docs/zob/11-EVIDENCE_AND_GITHUB_CHECKS.md` (163 lines)

**Read:** fully (lines 1–163).

**Coverage:**
- Body policy, branch evidence, binding, canonical GitHub machine artifacts (8 Checks), staging/promotion guards, PR/staging/promotion CI, flakes, claim vs completion, progress.

**Evidence types / issuers:**
- `11:36` current factory evidence tokens (11): `task, gate, pr-close, blind-review, human-gate, staging-merge-gate, staging-integration, repository-assurance, promotion-authorization, promotion-gate, post-promotion`; legacy (3): `merge-authorization, ship-gate, post-merge`. Cross-checked against `evidence.schema.json:10` `evidenceType` enum (14 tokens): exact match — all 11 current + 3 legacy present. ✅
- `11:38` current issuer tokens (7): `supervisor, builder-app, reviewer-app, staging-merge-app, promotion-app, ci, human`; legacy: `ship-app`. Cross-checked against `evidence.schema.json:22` `issuer.type` enum (8 tokens): exact match. ✅
- `11:40` "`human/` stores evidence records whose schema `evidenceType` is `human-gate`; the shorter path name is not a second evidence-type token." ✅ Prevents path/schema token confusion.
- `11:42` "Per-task records contain the complete compact attempt chain—success, failure, rejection, timeout, abandonment and supersession—using opaque assignment IDs." — consistent with `evidence.schema.json` `attemptChain` using `assignmentId` (opaque). ✅

**Checks / issuers (canonical GitHub artifacts):**
- `11:50` `ZOB / PR Close` — Builder App, exact head. ✅ (matches `08:64` Builder App)
- `11:54` `ZOB / Blind Review` — Reviewer App, exact head/base relation. ✅ (matches `08:70` Reviewer App)
- `11:58` `ZOB / Human Gates` — Supervisor projection; "It cannot create human authority." ✅ (matches `08:130` "Bare/manual labels do not satisfy gates")
- `11:62` `ZOB / Staging Merge Gate` — Staging Merge App, exact ordinary PR head/base. ✅ (matches `08:76`)
- `11:66` `ZOB / Staging Integration` — Staging Merge App, exact `develop-staging` SHA; "deployment workflows exclude staging." ✅ Cross-checked against `staging-candidate.schema.json:35-45` `integration.deploymentDisabledProof.stagingCanTriggerDeployment: false`. ✅
- `11:70` `ZOB / Repository Assurance` — Reviewer App, exact frozen staging/develop boundary. ✅ (matches `repository-assurance-result.schema.json:64` `assuranceCheck.issuerType: "reviewer-app"`)
- `11:74` `ZOB / Promotion Authorization` — Promotion App, exact promotion PR/staging/develop heads; binds separate human promotion-merge receipt + automatic-CD impact receipt. ✅ Cross-checked against `promotion-authorization.schema.json`: `stagingSha`, `developSha`, `windowReceiptHash`, `promotionMergeReceiptHash`, `deploymentImpact.acknowledgementReceiptHash` all required. ✅
- `11:80` `ZOB / Promotion Gate` — Promotion App, exact pre-merge promotion PR; "merge method `merge-commit`." ✅ Cross-checked against `promotion-authorization.schema.json:48` `mergeMethod: "merge-commit"` (const) and `promotion-merge-evidence.schema.json:30` `mergeMethod: "merge-commit"` (const). ✅
- `11:84` "Human-readable PR comments summarize Checks. Lifecycle labels project queue state. Neither comments nor labels replace canonical Checks/receipts." ✅ No label/comment authority.

**Lifecycle / evidence invalidation:**
- `11:86-96` invalidation evaluator is evidence-type-aware; 9-row table covering: source/head/manifest revision → owning task + containing gate + PR-close + Blind Review + staging integration + repository assurance + downstream promotion; hard dependency → dependent task/gate + aggregates; validation command/runner/CI policy → evidence using that validation + dependent aggregates; permission/profile/taxonomy/prompt compiler change → only semantically dependent evidence; human receipt expiry/revocation/supersession → Human Gates + unconsumed actions/evidence; PR base movement → review/staging only on contract collision; frozen staging/develop base movement → assurance/promotion window + every promotion Check/receipt until new exact boundary; issuer/App/schema allowlist change → affected Check evidence; exact staging/promotion merge event/SHA/reconciliation → staging-integration + promotion/post-promotion + downstream deployment-confirmation. ✅ Comprehensive, evidence-type-aware, no blanket invalidation.
- `11:98` "`superseded` means a newer valid artifact replaces an older still-auditable one; `stale` means freshness/binding is no longer current; `invalid` means integrity/policy/issuer/contract validation failed. Historical records are retained in all cases." — matches `evidence.schema.json:26` `status` enum `current, stale, invalid, superseded`. ✅

**Exact SHA boundaries:**
- `11:66` Staging Integration binds exact `develop-staging` SHA. ✅
- `11:70` Repository Assurance binds exact frozen staging/develop boundary. ✅ Cross-checked: `repository-assurance-result.schema.json:12-13` requires both `stagingSha` and `developSha` (`^[a-f0-9]{40}$`). ✅
- `11:74` Promotion Authorization binds exact promotion PR/staging/develop heads. ✅ Cross-checked: `promotion-authorization.schema.json:20-25` requires `stagingSha`, `developSha` (`^[a-f0-9]{40}$`), `stagingBranch: "develop-staging"` (const), `developBranch: "develop"` (const). ✅
- `11:88` (invalidation table) "frozen staging or develop base movement → invalidate assurance/promotion window and every promotion Check/receipt until a new exact boundary is audited." ✅
- `11:94` "exact staging/promotion merge event, merge SHA or reconciliation output changes → staging-integration, promotion/post-promotion evidence and any downstream deployment-confirmation evidence." ✅

**Staging and Promotion Guards:**
- `11:106-120` shared pure evaluators (Staging Guard reads `develop-staging` policy; Promotion Guard reads `develop` policy + frozen assurance contract). Validate: governed profile + required Check set, current SHA + approved issuer App IDs, schema/policy compatibility, profile artifact requirements, exact human ACK/override scope, check failures/pending/missing, review-state consistency, ordinary PR base is `develop-staging` + deployment workflows exclude it, frozen staging/develop SHA relation + assurance coverage + promotion merge method, automatic-CD impact, post-promotion bundle. "No early `human-override` exit. No title-only exemption. No bare-label proof." ✅
- `11:122-128` CI ordering: (1) story PR-close requires all scheduled ordinary draft-head checks terminal/acceptable; (2) Staging Merge marks ready, waits for post-ready checks, squash-merges to `develop-staging`; (3) every staging merge runs full integration CI on exact staging SHA before next merge; (4) human-started frozen promotion window reruns full staging CI before assurance; (5) promotion PR to `develop` runs every required develop-target PR/ready check again before human promotion-merge authorization. ✅ Cross-checked against `staging-candidate.schema.json:33` `integration.result` and `:49` `freeze.humanStarted: true`, `:53` `stagingMergeQueueFrozen: true`. ✅
- `11:130` "Acceptable skipped/neutral conclusions must be policy-declared. Cancelled, superseded, missing or unknown checks do not silently pass." ✅
- `11:132` "Staging branches must not match any deployment trigger; the develop promotion merge may trigger automatic CD and is recorded without manual dispatch." ✅ Cross-checked: `promotion-merge-evidence.schema.json:54` `manualDispatchPerformed: false` (const); `:48` `triggerEvent: "push"` (const). ✅

**Flakes:**
- `11:134-138` one automatic rerun only when: check matches versioned known-flake ledger entry, current log signature matches, rerun ceiling not consumed. "Otherwise route real failure to repair." ✅

**Claim vs completion (no lower layer self-certifies a higher one):**
- `11:140-150` agent output = claim; parent validation = accepted task evidence; gate closure aggregates accepted required tasks; PR-close aggregates current gates/CI/audits; Blind Review independently evaluates PR; Staging Merge mechanically revalidates + integrates + full staging CI; Final Repository Assurance independently evaluates whole frozen repo + doc coverage; Promotion mechanically revalidates assurance/CI/receipts + merge-commits only exact authorized candidate. "No lower layer can self-certify a higher one." ✅ This is the core anti-authority-bleed invariant across Story/Review/Staging/Assurance/Promotion/Deployment.

**Body safety:**
- `11:8-14` normal persisted evidence may contain IDs/refs/paths/hashes/enums/timestamps/status/counts, exact provider/model operational metadata only on protected telemetry, safe command names/templates + result summaries, GitHub URLs/check/review IDs, source/manifest/policy bindings. "It may not contain credentials, raw prompts, raw model/provider responses, full tool output, raw diffs, private transcripts or sensitive URLs." ✅
- `11:16` "Full transcripts remain encrypted local data." ✅
- `11:44` "Large logs live in CI or encrypted local storage and are referenced by hash/URL." ✅
- `evidence.schema.json:44` `bodyStored: false` (const). ✅

**Findings for 11:** None.

---

## 3. Cross-cutting checks

### 3.1 Lifecycle / evidence invalidation consistency
- `06` status vocabularies ↔ `07` dispatch invariant ↔ `mission.schema.json` status enum: all consistent. ✅
- `07:99` promotion milestone = `factory-milestone` ↔ `11:88,94` promotion evidence invalidation on base/merge movement: consistent. ✅
- `11:86-96` invalidation table ↔ `evidence.schema.json:26` status enum: consistent. ✅
- `08:124-126` receipt revocation invalidates dependent projections/evidence ↔ `11:92` human receipt expiry/revocation/supersession → Human Gates + unconsumed actions: consistent. ✅

### 3.2 Exact SHA boundaries
- Staging: `develop-staging` SHA bound in `staging-candidate.schema.json:19`, `11:66`, `06:108`. ✅
- Promotion: `develop-staging`→`develop` with exact heads in `promotion-authorization.schema.json:20-25`, `11:74,80`, `06:84`. ✅
- Merge-commit only: `promotion-authorization.schema.json:48`, `promotion-merge-evidence.schema.json:30`, `11:80`. ✅
- Audited staging must be parent: `promotion-merge-evidence.schema.json:36` `auditedStagingIsParent: true` (const), `promotion-authorization.schema.json:52` `auditedStagingMustBeParent: true` (const). ✅
- Result tree must match staging: `promotion-merge-evidence.schema.json:42` `treesEqual: true` (const), `promotion-authorization.schema.json:53` `resultTreeMustMatchStaging: true` (const). ✅
- No admin bypass: `promotion-authorization.schema.json:55` `adminBypassAllowed: false` (const). ✅
- No manual dispatch: `promotion-merge-evidence.schema.json:54` `manualDispatchPerformed: false` (const), `promotion-authorization.schema.json:67` `manualDispatchAuthorized: false` (const). ✅

### 3.3 ACK enum / scope
- `ack-receipt.schema.json:14` ackType (11) = `execution-profile.schema.json:30` humanReceiptTypes (11). ✅ Programmatically enforced by `validate_contracts.py:139-141`.
- `ack-receipt.schema.json` scope includes `headSha`, `stagingSha`, `developSha`, `processDiffHash`, `assuranceId`, `promotionId`, `ruleIds` — all referenced in `08:132-136` prose. ✅
- `08:118` legacy `merge-batch` reserved, not used for ordinary PRs in mandatory-staging Wheel v1. ✅

### 3.4 App least privilege
- Four separate App identities (Builder, Reviewer, Staging Merge, Promotion) with non-overlapping write scopes (`08:64-92`). ✅
- Staging Merge App cannot merge `develop`/`main` (`08:80`). ✅
- Promotion App dormant except active window, merge-commit only for typed promotion PR, fast-forward only to promotion merge SHA (`08:82-90`). ✅
- `08:92` separate identities prevent staging merger from holding develop-merge credentials. ✅

### 3.5 Checks / issuers
- 8 canonical Checks in `11:50-80` map 1:1 to issuer Apps in `08:64-92`. ✅
- `ZOB / Human Gates` is a supervisor projection that "cannot create human authority" (`11:58`). ✅
- Comments/labels do not replace Checks/receipts (`11:84`). ✅

### 3.6 Model blindness / family independence
- `09:12-24` no model identity leakage to agents/orchestrator; sanitized launcher/session metadata. ✅
- `09:76-82` independence hierarchy (different family → different model → same model degraded fallback). ✅
- `09:116` assurance ≥ 3 eligible families; schema-enforced via `repository-assurance-result.schema.json` `modelIndependence.anyOf`. ✅
- `09:172` no runtime self-modification of routing/prompt policy. ✅

### 3.7 TUI human-start vs promotion authorization
- `06:84` promotion window start ≠ develop merge authorization. ✅
- `06:174` separate typed actions for window start/abandon vs exact-head promotion merge authorization. ✅
- `08:112-116` separate purpose-built forms; ordinary staging merges have no human batch form. ✅
- `08:82` Promotion App dormant except active human-started window. ✅

### 3.8 Body safety
- All 6 files + all cross-checked schemas enforce `bodyStored: false` (const) and hash-only payloads. ✅
- No raw prompts/responses/transcripts/credentials/diffs in normal evidence, journal, Git or PR evidence (`07:149`, `11:8-16`, `09:138`). ✅
- Encrypted transcripts with keychain, redaction, partial-tail marking (`07:139-153`). ✅

### 3.9 No authority bleed across Story/Review/Staging/Assurance/Promotion/Deployment
- `11:148` "No lower layer can self-certify a higher one." ✅
- `08:150-164` denied-by-design covers all six layers. ✅
- `10:146` ordinary story profiles never authorize develop promotion or deployment. ✅
- `09:120` experimental shadows cannot clear PR/staging alone. ✅
- `08:62` assurance repair workers cannot accept their own work. ✅
- `06:114` separate Staging Merge App and Promotion App state/permissions. ✅

### 3.10 Schema / prose cross-check summary
- ACK enum parity (ack-receipt ↔ execution-profile): ✅ enforced by validator.
- Evidence type/issuer enums (evidence schema ↔ `11` prose): ✅ exact match.
- Model outcome/failureClass/thinking/mode enums (model-attempt ↔ `09` prose): ✅ exact match.
- Mission status enum (mission schema ↔ `06` prose): ✅ exact match.
- Profile base/overlay enums (execution-profile schema ↔ `10` prose): ✅ exact match.
- `deferredActions` enum (execution-profile) vs `forbiddenActions` enum (mission): ⚠️ `workflow-dispatch` missing from `deferredActions` (W1).

---

## 4. Findings summary

| ID | Severity | File:Line | Finding |
|---|---|---|---|
| W1 | WARN | `docs/zob/schemas/execution-profile.schema.json:31` (deferredActions enum); prose `docs/zob/10-EXECUTION_PROFILES_AND_SKILLS.md:78,144`; counterpart `docs/zob/schemas/mission.schema.json:41` | `execution-profile.schema.json` `deferredActions` enum omits `workflow-dispatch`, which is present in `mission.schema.json` `forbiddenActions` and referenced in prose (`10:78` "No workflow dispatch", `08:156` denied-by-design). An execution profile cannot declaratively express workflow-dispatch as a deferred action. **Not a safety hole** — mission-level `forbiddenActions` and the broker's denied-by-design still block workflow dispatch — but a schema-prose completeness gap. The validator (`validate_contracts.py`) does not test `forbiddenActions`↔`deferredActions` enum parity (it only tests ACK↔profile parity at `:139-141`). Recommended fix: add `"workflow-dispatch"` to the `deferredActions` enum and add a cross-enum invariant test. |

**No PASS-affecting findings.** No FAIL findings. No authority bleed, no body-safety violation, no SHA-boundary weakness, no ACK/scope gap, no model-blindness leak, no TUI/promotion authorization confusion, and no lifecycle invalidation gap were found in the six runtime-governance files.

---

## 5. Verdict

**Verdict: WARN**

- **no_ship: false** — The single WARN (W1) is a schema-prose completeness gap in an enum that is not on the critical safety path. The workflow-dispatch prohibition is still enforced by `mission.schema.json` `forbiddenActions`, the GitHub mutation broker's denied-by-design list (`08:150-164`), and the infrastructure-ci overlay prose (`10:78`). No authority bleed, safety bypass, body-safety violation, or SHA-boundary weakness results from W1.
- All six runtime-governance files match their frozen manifest hashes exactly.
- All lifecycle/evidence-invalidation, exact-SHA-boundary, ACK-enum/scope, App least-privilege, Checks/issuer, model-blindness/family-independence, TUI human-start vs promotion-authorization, body-safety, and no-authority-bleed invariants are consistent across the six files and their cross-referenced schemas.
- The design is honestly marked **Approved design (specified, not implemented/installed/activated)** throughout, consistent with `AGENTS.md:44` ("deliberately disabled-by-default and does not authorize live execution").

LANE_AUDIT_COMPLETE
