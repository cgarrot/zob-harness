# Lane Review — Operations, Installation, Validation, Upgrade/Rollback, Decisions, Enhancements, Source Evidence

**Review type:** Full second-pass audit (read-every-line)
**Reviewer:** ZOB doc-audit lane (read-only)
**Scope manifest:** [`SCOPE_MANIFEST.json`](SCOPE_MANIFEST.json) — `reviewMode: full`, 49 files / 3937 lines / 203839 bytes in scope
**Date:** 2026-07-18
**Files audited (7):**

| # | File | Lines | Truth class |
|---|---|---|---|
| 1 | [`../12-INSTALLATION.md`](../12-INSTALLATION.md) | 163 | Approved install specification |
| 2 | [`../13-OPERATIONS_RUNBOOK.md`](../13-OPERATIONS_RUNBOOK.md) | 162 | Approved operational specification |
| 3 | [`../14-VALIDATION_AND_PILOTS.md`](../14-VALIDATION_AND_PILOTS.md) | 170 | Approved implementation/activation plan |
| 4 | [`../15-UPGRADE_AND_ROLLBACK.md`](../15-UPGRADE_AND_ROLLBACK.md) | 108 | Approved operational specification |
| 5 | [`../16-DECISIONS.md`](../16-DECISIONS.md) | 151 | Ratified design decisions |
| 6 | [`../ENHANCEMENTS.md`](../ENHANCEMENTS.md) | 339 | Deferred/proposed capability register |
| 7 | [`../SOURCE_EVIDENCE.md`](../SOURCE_EVIDENCE.md) | 133 | Current evidence references + explicit limitations |

**Boundary honored:** This is an install specification, not activation. No merge, deploy, publish, live-provider activation, credential access, or GitHub App installation is authorized by any finding below. No edits were made except this named report.

---

## Verdict

**PASS (no no-ship blockers).**

All seven files are read-fully audited. Truth-class headers are honest and internally consistent. Command-state disclaimers correctly mark `pi install`/`wheel-zob`/`zobd` as proposed future commands. Factory activation gates are consistent across 14, 16-D-098/099, and ENHANCEMENTS. ZOB-ENH-031/032 remain correctly classified as `Proposed-needs-discussion` and are explicitly excluded from ratification in 16-DECISIONS. PR #3817's captured head `02af54029423310cbc4ed1cd70153ab611b766df` is date-qualified ("at design capture 2026-07-18", "open draft", "Recheck current PR/merge state before promotion", "captured head is evidence for the proposal, not merged current truth") in both ENHANCEMENTS and SOURCE_EVIDENCE. Install/ops/validation/rollback safety posture is strong and body-safe. All internal cross-links resolve. Current-evidence honesty is maintained throughout.

Findings are all **Low** or **Informational** severity — no High/Medium correctness, safety, or honesty defects were found. Two Low findings and three Informational observations are recorded below with `current_branch_fix` routing.

---

## Findings

### F-01 — Low — 14-VALIDATION_AND_PILOTS.md lacks an explicit command-state/proposed qualifier header

**Location:** `docs/zob/14-VALIDATION_AND_PILOTS.md` line 3.
**Observation:** 12-INSTALLATION and 13-OPERATIONS_RUNBOOK both carry a second header line disclaiming command maturity (`Command state: Proposed future commands; do not run until releases exist` / `CLI examples: Proposed interface, not evidence of implemented commands`). 15-UPGRADE_AND_ROLLBACK and 16-DECISIONS use their truth-class + status lines to the same effect. 14 carries only `Truth class: Approved implementation/activation plan` with no explicit "commands/phases proposed, not implemented" qualifier.
**Impact:** Low. The body of 14 is unambiguously a plan (phases, "Tests:", "Require …", "No live … unless separately authorized"), and the README truth-class/maturity section plus 16-D-096/102 already separate authored docs from verified suites. A reader skimming headers only could momentarily infer 14 describes executed validation rather than a required plan.
**Safety/honesty:** No safety impact; minor consistency polish.
**Recommended action (`current_branch_fix`):** Consider adding a one-line header such as `**Plan state:** Required validation sequence; no phase is executed or activated by this document.` to match 12/13's explicit qualifier. Optional, not blocking.
**Severity rationale:** Low — consistency/clarity, no correctness defect.

### F-02 — Low — 13-OPERATIONS_RUNBOOK and 15-UPGRADE_AND_ROLLBACK omit the shared-branch names `zob-mission-state` / `zob-model-telemetry`

**Location:** `docs/zob/13-OPERATIONS_RUNBOOK.md` (checkpoint-sync / "state branch push conflict" lines 88, 137–138); `docs/zob/15-UPGRADE_AND_ROLLBACK.md` ("protected telemetry" line 35, "shared state branches" line 83).
**Observation:** The canonical shared-branch names are defined in 12-INSTALLATION ("Shared branches") and ratified in 16-D-023 (`zob-mission-state`) and 16-D-025 (`zob-model-telemetry`). 13 refers generically to "checkpoint sync" and "State branch push conflict"; 15 refers to "protected telemetry" and "shared state branches" without naming them. SOURCE_EVIDENCE confirms the docs-tools main checkout had "no mission-state branch implementation or model-telemetry branch implementation", so the names are design-only — which is correctly reflected.
**Impact:** Low. An operator reading 13/15 in isolation must cross-reference 12/16 to map "state branch" / "telemetry" to the concrete branch names. No contradiction; just generic reference where a name would aid operability.
**Safety/honesty:** No safety defect; the generic references are still correct. Honesty is preserved because SOURCE_EVIDENCE marks these branches as not-yet-implemented.
**Recommended action (`current_branch_fix`):** Optionally name the branches inline at first reference in 13 ("State branch (`zob-mission-state`) push conflict") and 15 ("Flush checkpoint and protected telemetry (`zob-model-telemetry`)"). Optional, not blocking.
**Severity rationale:** Low — operability/traceability, no correctness or safety defect.

### F-03 — Informational — Command-name surface is consistent and correctly marked proposed

**Location:** 12-INSTALLATION lines 41–42 (`pi install -l …`), 13-OPERATIONS_RUNBOOK lines 20–25 (`wheel-zob …`), 12 lines 101/33 and 13 line 20 (`zobd`), 12 line 59 (`.pi/zob/wheel-zob.lock.json` future path).
**Observation:** All command tokens are consistently namespaced (`pi install` for package install, `wheel-zob` for operator CLI, `zobd` for the supervisor service, `.pi/zob/wheel-zob.lock.json` for the lock file). 12 and 13 both explicitly mark these as proposed/future. 15 references "release notes/migration/security changes" and "Install new pinned runtime/pack in staging path" without inventing CLI verbs — consistent with proposed state. No file claims these commands exist or are runnable now.
**Impact:** None. Recorded as a positive consistency confirmation.
**Severity rationale:** Informational — no action required.

### F-04 — Informational — Repo-name references are correct against the actual remote

**Location:** 12-INSTALLATION line 18 (`jointhewheel-docs-tools`) and line 42 (`git:git@github.com:Join-The-Wheel/jointhewheel-docs-tools@…`); SOURCE_EVIDENCE line 122 (`Join-The-Wheel/jointhewheel-docs-tools`).
**Observation:** The local working directory is named `jointhewheel-docs-tools-zob-system`, but the actual `git remote -v` resolves to `https://github.com/Join-The-Wheel/jointhewheel-docs-tools.git`. The documentation references use the canonical GitHub repo name `jointhewheel-docs-tools`, which matches the real remote. No discrepancy.
**Impact:** None. Recorded to prevent a future reviewer from flagging the local-folder-versus-remote-name difference as an error.
**Severity rationale:** Informational — no action required.

### F-05 — Informational — "Explicitly unresolved" list in 16-DECISIONS is consistent with the rest of the corpus

**Location:** 16-DECISIONS lines 145–151 ("Explicitly unresolved").
**Observation:** Each unresolved item maps to honest gaps elsewhere: model IDs/`Sol-high`/adjudicator (16-D-050, 16-D-066, 03-STORY_TO_PR_CLOSE_FACTORY line 168 "policy alias, not a provider/model identity"); provider pools/budgets (12 "Pool configuration remains empty/unverified until tests pass", 14 Phase 7 "Under explicit spend approval"); GitHub App IDs/installation (12 "separate human installation", 08 permissions doc); runtime release versions / compatibility matrix (12 "release compatibility matrix" as a future prerequisite from the tagged release, 15 "Read release notes" as upgrade step 1); ENH-031/032 (ENHANCEMENTS "Proposed-needs-discussion (requested 2026-07-18)"). The list is a faithful index of real open items, not smoothed-over gaps.
**Impact:** None. Positive honesty confirmation.
**Severity rationale:** Informational — no action required.

---

## Per-file coverage

### 1. 12-INSTALLATION.md — PASS

**Truth-class header:** `Approved install specification` + `Command state: Proposed future commands; do not run until releases exist`. Honest and correctly scoped.

**Install safety (strong):**
- Two modes (Development / Pinned machine) with explicit warning never to install from unreviewed dirty worktree as durable config — consistent with 16-D-008 and SOURCE_EVIDENCE's "uncommitted changes … must be preserved/revalidated".
- Safety preflight (7 steps) includes credential-printing check, `zobd` ownership check, disk check, old `jointhewheel-doc-archive` not repurposed (matches SOURCE_EVIDENCE line 129 and 14 Phase 0 "preserve old archive/worktrees").
- Package install uses exact-version pins (`npm:zob-harness@<exact-version>`, `git:…@wheel-zob-pack-v<version>`) — consistent with 16-D-010 and 15's "explicit new pin" upgrade principle. Tagged release provides checksums/SBOM/compatibility matrix/migrations/rollback — all marked future.
- Project lock (`.pi/zob/wheel-zob.lock.json`, future path) excludes credentials/machine username/raw provider data — body-safe, consistent with AGENTS.md hard rules 1–2.
- Default factory flags all `false` (`storyFactory.enabled = false until local validation`, blind/prShip/providerLiveTests false) — consistent with 16-D-013 and 14 activation gate.
- Supervisor service: permissioned runtime dirs, keychain key reference, `zobd` user service, Unix socket user-only, no-mission/no-mutation start, socket stale behavior. "Keychain failure blocks transcript-capable mission admission. It never falls back to plaintext." — consistent with 16-D-006/026/027 and 14 Phase 1 tests.
- Shared branches created/verified without force; state uses separate runtime bare clone/worktree, never the Pi package checkout — consistent with 16-D-012.
- GitHub Apps: separate human installation, "Installation is not activation"; private keys in OS secret store; denied-operation tests; Ship credentials absent until activation gate — consistent with 16-D-013/014/082/099 and 08-PERMISSIONS.
- Providers: manual OAuth, no API key in repo/config, inventory read-only, paid live tests require separate spend approval, pool config empty until tests pass — consistent with 16-D-015/066 and 14 Phase 7.
- Validation-after-install includes "no network listener", "no factory activation", "provider models not assumed", "App credentials/permissions absent or explicitly configured" — consistent with 16-D-006 ("no network service is exposed") and 16-D-014.
- Uninstall/rollback (8 steps) preserves evidence, never auto-deletes encrypted transcripts, removes keys only after cryptographic-deletion approval, leaves shared state/telemetry history intact, no application-branch reset — consistent with 15 "Uninstall versus rollback" and 16-D-020/026.

**No defects found.** F-02 (branch names not restated) does not apply to 12; 12 defines them.

### 2. 13-OPERATIONS_RUNBOOK.md — PASS

**Truth-class header:** `Approved operational specification` + `CLI examples: Proposed interface, not evidence of implemented commands`. Honest.

**Ops safety (strong):**
- Daily loop is deterministic (RECONCILE→POLL→TRIAGE→RESERVE→DISPATCH→VALIDATE/ACCEPT→CHECKPOINT→CONTINUE); "Models perform bounded work/judgment; they do not own the loop." — consistent with 16-D-005/007.
- Operator commands proposed only; "High-risk operations remain TUI/receipt gated. No arbitrary shell passthrough."
- Starting a Story mission step 1 "Verify Story factory activation and policy lock" — consistent with 12 default flags and 14 activation gate.
- Normal monitoring watches exceptions, not every token; live output available for selected agent — consistent with 16-D-030 (heartbeat/activity/progress/freshness distinction).
- Pause/resume: preserves running-attempt policy, continues watchers, writes checkpoint; same-machine resume auto-reconciles, cross-machine requires takeover receipt — consistent with 16-D-021/022/023.
- Needs-human: inspect exact question/consequences, answer through authenticated source, verify receipt scope/expiry, conflicting answer creates conflict card, fresh attempt after durable handoff — consistent with 16-D-046/047 and 08 ACK policy. "Do not answer high-risk receipts through generic batch controls."
- Provider/model incidents: no quality penalty for transient, cooldown/skip on unavailable, planned/actual mismatch or clamp quarantines route and invalidates benchmark, context overflow provider-specific recovery, all routes exhausted → needs-human. "Never print auth or provider response bodies while diagnosing." — consistent with 16-D-057/066 and AGENTS.md rule 1.
- Agent/run incidents: `launching` without ACK = not running; missing process = lost; completed marker without evidence = claim returned but unaccepted; stale heartbeat displayed separately; contract violation/out-of-scope write = stop/quarantine/revoke — consistent with 14 Phase 2 regressions and 16-D-018/019.
- Workspace incidents: lease conflict no parallel write; dirty canonical worktree stop integration, "never clean/reset blindly"; sandbox fail reject with evidence, source branch unchanged; base/head drift reconcile; stack dependency changes downstream invalidation through DAG — consistent with 16-D-034/035/042/043 and 15.
- CI incidents: draft/ready checks profile/version driven; one known-flake rerun only on matching log signature; real failure → repair task/factory handoff; missing/cancelled/superseded explicit unknown; source fix invalidates close/review/ship evidence — consistent with 16-D-048/049 and 11-EVIDENCE.
- Review incidents: new head cancels round; validated finding → Story repair; contested → fresh evidence/adjudication, bounded disagreement then needs-human; **three automatic repair rounds maximum**; no reviewer edits source — consistent with 16-D-074/077/078 and 04-BLIND_REVIEW.
- Ship incidents: "Ship factory is disabled until activated." When active: failed pre-ready repair/re-close/re-review; post-ready repair return draft before source mutation; stale authorization remove entry/request new exact-head receipt; merge request failure no retry until cause/head reconciled; crash with `merge_in_flight` inspect only that PR; pending post-merge no other PR mutation/merge until complete; automatic deploy run failure alert/downstream factory, "do not retrigger manually" — consistent with 16-D-081/086/088/091/092 and 05-PR_SHIP.
- Persistence incidents: SQLite invalid/journal valid rebuild; journal hash/schema invalid quarantine tail, block, ask human; state branch push conflict pause + reconcile expected head; keychain unavailable block transcript-enabled admission; disk warning alert, hard threshold pauses dispatch, "never auto-deletes" — consistent with 16-D-016/017/020/024/027/028.
- Controlled stop (7 steps) and force-stop typed reason + potentially orphaned work record — consistent with 15 failed-upgrade handling.
- Completion/handoffs: Story complete → `fleet:needs-review`/Blind Review queue; Blind Review clean → Ship queue (still disabled unless activated); Ship complete → exact-input Post-Merge Reconciliation; deployment confirmation separate future factory; "No factory claims the next factory's outcome." — consistent with 16-D-003/013 and ENH-022/023.

**Findings:** F-02 (generic "state branch" / "checkpoint sync" instead of naming `zob-mission-state`/`zob-model-telemetry`). Low severity, optional fix.

### 3. 14-VALIDATION_AND_PILOTS.md — PASS (with F-01)

**Truth-class header:** `Approved implementation/activation plan`. See F-01 for the missing explicit command/plan-state qualifier.

**Validation safety (strong):**
- Principle: "Deterministic scaffolding first, LLM enrichment second. Smoke one item, obtain oracle evidence, then pilot at bounded concurrency. No global autonomy claim." — consistent with 16-D-096/097/102 and README maturity ladder.
- Phase 0: fresh docs-tools clone, full docs/schemas/examples, classify existing dirty ZOB diff, preserve old archive/worktrees, independent architecture/security/doc review — consistent with SOURCE_EVIDENCE baseline and 16-D-008.
- Phase 1: service/socket, journal/SQLite/snapshots/outbox, recovery/ownership, encrypted transcripts, minimal HUD; tests include crash injection around every append/commit, replay/idempotency, DB rebuild, corrupt-tail block, same-machine restart, explicit takeover, transcript integrity/delete, socket stale — consistent with 16-D-016/017/020/021/026/027 and 07-PERSISTENCE.
- Phase 2: schemas/profile composition, dispatch reserve/preflight/ACK, claims/acceptance/gate reopen, permission/ACK primitives, blindness/skill grants; required regressions: "failed preflight never leaves `delegated`", `needs_review` valid resolve/reopen/reject, no terminal stuck leaf, stale optional leaves cannot be hidden, state-machine/property tests — consistent with 16-D-033/035/041/053.
- Phase 3: leases/sandboxes/merge candidates/integration owner, draft PR/bootstrap, GitHub broker/polling/CI, needs-human/checkpoints; "Use local Git and mocked GitHub before any remote smoke." — consistent with 16-D-019/029/042/043/044.
- Phase 4: full rendering/keyboard/status/freshness/live-output/replay tests; "Verify dispatch≠running, claim≠accepted and stale sources never appear current." — consistent with 16-D-030 and 06-MISSION_CONTROL.
- Phase 5: Wheel pack/docs-tools package/profile/taxonomy/prompt/policy/skills/contracts, install/update/drift/rollback tools, docs/enhancements, schema/golden/collision/clean-install tests — consistent with 12 and 15.
- Phase 6: JointheWheel adapter, pinned settings/lock, story/Fleet v5 adapters, branch/PR/CI/Ready Guard integration, model-lab telemetry bridge, compatibility/collision tests; "Do not remove local generic skills until parity/rollback pass." — consistent with 16-D-011/039 and SOURCE_EVIDENCE Fleet v5.
- Phase 7: "Under explicit spend approval", `fireconnect` and OpenAI OAuth inventory, bounded route/effort/tool/stream/cost/error/blindness/transcript smokes, exact pool/family/alias configuration, prompt control/candidate fixtures — consistent with 12 "paid live capability tests require separate spend approval" and 16-D-066.
- Phase 8: deterministic local simulation, disposable repo scenarios, "no network/paid model needed" — consistent with 16-D-097.
- Phase 9: one-story real pilot, human selects low-risk story + approves bounded model spend/GitHub writes; "Require immediate draft, truthful TUI, no stuck lifecycle, assignment blindness, prompt telemetry, exact evidence, terminal draft CI, three fresh close checks, no ready/merge/deploy and independent oracle PASS." — consistent with 16-D-050/102 and 03-STORY_TO_PR_CLOSE ("three fresh fixed PR-close auditors").
- Phase 10: 2–3 stories, different profiles/concurrency/dependency/stack, human checkpoint, QA/docs overlays, crash/restart; measure fairness/leases/budgets/model-prompt data/recovery — consistent with 16-D-034/045.
- Phase 11: another-machine install/recovery, pinned releases, manual auth, import checkpoint, record takeover, attach, complete fixture mission, validate rollback/uninstall, independent security/oracle — consistent with 12 and 16-D-021/022.
- ZOB PR plan: PR A (durable execution core), PR B (operational Story factory/TUI/model/integrations, stacked on A); docs-tools and application adapters separate PRs with explicit dependency links — consistent with 16-D-009.
- Blind Review factory rollout (8 steps) and Ship factory rollout (10 steps) both end with explicit activation receipt and independent oracle; "No live `fleet:needs-review` consumption before activation" and "No JointheWheel ready/merge action during implementation/pilots unless separately authorized" — consistent with 16-D-098/099 and ENH-020/021.
- Required security/quality checks: TypeScript/build/lint/unit/integration/property, CodeScene, Semgrep/Snyk high-severity bounded, dependency/license/SBOM, secret scan on diff, IaC scan, TUI accessibility/keyboard/render, JSON Schema/example validation, Git diff check, independent skeptical review/oracle — "As applicable" qualifier is honest (not every check applies to every phase).
- Factory activation gate: all required sentinels/validation artifacts, no unresolved no-ship issue, exact versions/permissions, human activation receipt defining factory/scope/caps/expiry, rollback plan, fresh oracle PASS/no-ship false; "Ship also requires per-batch authorization." — consistent with 16-D-098/099.

**Findings:** F-01 (no explicit command/plan-state qualifier header). Low severity, optional fix.

### 4. 15-UPGRADE_AND_ROLLBACK.md — PASS

**Truth-class header:** `Approved operational specification`. Honest.

**Upgrade/rollback safety (strong):**
- Versioned surfaces list (10 items) is comprehensive and matches 12's lock contents and 16's decision surface — consistent.
- Upgrade principles (7): pin/preview/validate before changing ref; stop new dispatch + checkpoint; preserve journal/transcripts/state; migrate projections deterministically (journal remains audit source); never rewrite historical events/receipts/attempt assignments; resume only after compatibility/recovery checks; "Rollback must not downgrade away evidence/permission requirements silently." — consistent with 16-D-032/064 and AGENTS.md rule 9.
- Proposed upgrade flow (13 steps) includes staging-path install, schema migration on copy, replay/validate projections, denied-operation/App/provider checks, atomic service ref switch, per-mission reconcile + upgrade event, resume only when gates pass — consistent with 12 and 16-D-017.
- Runtime/schema compatibility: readers declare supported ranges; unknown required fields fail closed; additive fields ignored only when schema marks non-semantic; SQLite migrations forward/deterministic/fixture-tested; downgrade allowed only if old runtime reads current event/schema set or reviewed compatibility projection exists — consistent with schemas/README "unknown required versions fail closed" and 16-D-016.
- Policy changes: new missions use new policy; active missions retain snapshot unless human-approved migration; stricter safety may pause active + require migration; weaker/removing requires explicit human approval + new evidence, "never automatic"; model/prompt recommendations remain proposals until approved version release — consistent with 16-D-038/065.
- Skill/pack drift: installer validates file hashes + owner/collision maps; local edits to packaged resources are drift, not implicit customization; project-specific overrides in declared adapter/config with own hashes; updating pack never overwrites app-specific skills without explicit migration — consistent with 12 "Pi pinned refs do not advance during generic updates" and 16-D-041.
- Rollback (9 steps) + "Rollback never" list (6): no journal truncation, no transcript deletion, no application-branch reset, no force-update shared state branches, no reviving expired/revoked receipts, no replaying external effects without idempotency/current-truth checks — consistent with 16-D-020/023/024/026 and 13 persistence incidents.
- Failed upgrade: before switch leave old runtime active/paused; after switch stop dispatch/effects, preserve diagnostics, compatible rollback or block for human; "Do not keep a partially migrated mission running." — consistent with 13 controlled stop.
- GitHub policy migration staged (7 steps): report-only → issuer/schema/legacy comparison → event-coverage review → test-repo ready transitions → branch-protection reality check → human cutover → remove legacy bare-label/title bypass only after new artifacts available; "Legacy adapters are bounded and versioned; they do not become permanent silent fallback." — consistent with SOURCE_EVIDENCE Ready Guard baseline ("current facts being replaced, not desired behavior") and 16-D-080/094.
- Uninstall versus rollback: "Rollback changes version. Uninstall removes the runtime/package integration while preserving evidence. Neither action authorizes deletion of state/telemetry/transcripts/keys without explicit scope." — consistent with 12 uninstall/rollback.

**Findings:** F-02 (does not restate `zob-mission-state`/`zob-model-telemetry` branch names). Low severity, optional fix.

### 5. 16-DECISIONS.md — PASS

**Truth-class header:** `Ratified design decisions` + `Status: Binding for implementation planning; not proof of implementation or activation`. Honest — explicitly separates ratification from implementation/activation.

**Decision consistency (verified against 12/13/14/15 and other docs):**
- ZOB-D-001/002/003 (ownership/factory split) — consistent with AGENTS.md ownership and 03/04/05 factory docs.
- ZOB-D-005/006/007 (deterministic supervisor, `zobd` user service + Unix socket, no idle LLM loop) — consistent with 12 supervisor service, 13 daily loop, 14 Phase 1.
- ZOB-D-008 (dirty worktree preserved) — consistent with SOURCE_EVIDENCE "uncommitted changes … must be preserved/revalidated" and 14 Phase 0.
- ZOB-D-009 (PR A/PR B split) — consistent with 14 ZOB PR plan.
- ZOB-D-010/011/012 (tagged package, skill migration, package checkout never reused for state) — consistent with 12 package install + shared branches.
- ZOB-D-013/014 (Blind Review/Ship specified but disabled; install ≠ activation ≠ per-action authorization) — consistent with 12 default flags, 13 "Ship factory is disabled until activated", 14 activation gate, ENH-020/021.
- ZOB-D-015 (provider/model aliases unresolved until audits) — consistent with 12 "provider models not assumed", 14 Phase 7, SOURCE_EVIDENCE model lab.
- ZOB-D-016/017/018/019/020 (persistence: SQLite + journal, fsync-before-projection, exclusive owner, idempotent outbox, corrupt-tail quarantine) — consistent with 07-PERSISTENCE and 13 persistence incidents.
- ZOB-D-021/022/023/024/025 (restart/takeover, orphaned local runs, portable checkpoints, expected-head push, protected telemetry) — consistent with 13 pause/resume, 15 rollback, 12 shared branches.
- ZOB-D-026/027/028 (encrypted transcripts, keychain wrap, disk warning/hard-stop) — consistent with 12 keychain-failure-blocks, 13 disk incidents, 14 Phase 1 transcript tests.
- ZOB-D-029/030 (adaptive polling first, Mission Control freshness distinctions) — consistent with 13 CI/monitoring and 06-MISSION_CONTROL.
- ZOB-D-031 through D-050 (manifests/profiles/workspaces): all spot-checked against 03-STORY_TO_PR_CLOSE, 10-EXECUTION_PROFILES, 13 workspace incidents. D-039 "17 signals preserved as inputs" matches SOURCE_EVIDENCE "60 stories and 17 signal fields". D-050 "three independent fixed Sol-high tasks" matches 03 line 162 and 14 "three fresh close checks".
- ZOB-D-051 through D-066 (model/prompt policy): spot-checked against 09-MODEL_AND_PROMPT. D-060 (50/50 prompt experiment) and D-063 (fixed orchestrator/close/adjudicator prompts no experiment) are internally consistent. D-066 (`fireconnect`/OpenAI OAuth audit before pools) matches 12/14 Phase 7.
- ZOB-D-067 through D-080 (Blind Review): spot-checked against 04-BLIND_REVIEW. D-078 (max three automatic rounds) matches 13 line 118. D-074 (reviewer source-read/report-only) matches 13 "No reviewer edits source".
- ZOB-D-081 through D-095 (Ship): spot-checked against 05-PR_SHIP. D-086 (one merge in flight; pending post-merge blocks every other PR mutation/merge) matches 13 ship incidents. D-091 (Ship never triggers/claims deployment) matches 13 "do not retrigger manually" and ENH-023.
- ZOB-D-096 through D-102 (rollout/governance): D-097 (deterministic local smoke → one-story → multi-story → another-machine) matches 14 Phases 8–11. D-098/099 (activation gate + per-batch) matches 14 activation gate. D-100 (schemas/examples part of acceptance) matches schemas/README + examples/README. D-101 (stable enhancement IDs with trigger/acceptance/dependencies) matches ENHANCEMENTS structure. D-102 (no completion claim without live validation + independent review) matches README "Absolute boundary" and AGENTS.md rule 10.

**Explicitly unresolved (lines 145–151):** faithful index of real open items — see F-05. Critically, the final bullet says "Proposed `develop-staging` integration branch and post-staging bidirectional audit factory; see `ZOB-ENH-031` and `ZOB-ENH-032` for discussion, **not ratification**." This correctly keeps 031/032 out of the ratified decision set.

**No defects found.** 16-DECISIONS is the most internally consistent file in the lane.

### 6. ENHANCEMENTS.md — PASS

**Truth-class header:** `Deferred/proposed capability register` + rule "An enhancement is not approved implementation scope unless promoted through an explicit decision and versioned plan." Honest.

**Status vocabulary (4 values):** Deferred / Specified-disabled / Research / Proposed-needs-discussion. All 36 entries use one of these. Consistent with README truth-class "Enhancement" dimension.

**ZOB-ENH-031 — `develop-staging` integration branch:**
- Status: `Proposed-needs-discussion (requested 2026-07-18)`. ✅ Remains proposed, not ratified.
- Proposal, potential value, unresolved (9 sub-items), dependencies, acceptance candidate, promotion trigger all present.
- Promotion trigger: "Human discussion/decision after the current documentation suite is complete." — correctly deferred.

**ZOB-ENH-032 — Final Repository Assurance Audit factory:**
- Status: `Proposed-needs-discussion (requested 2026-07-18)`. ✅ Remains proposed, not ratified.
- **PR #3817 captured head is date-qualified:** "Evidence baseline at design capture (2026-07-18): PR #3817 was an open draft at `02af54029423310cbc4ed1cd70153ab611b766df`; it added ten independent review lanes, frozen-SHA/current-head delta handling, canonical-doc manifest coverage and source-backed documentation reconciliation. **Recheck current PR/merge state before promotion. This captured head is evidence for the proposal, not merged current truth.**" ✅ This is the correct honesty posture — captured head is evidence, not current truth, and must be rechecked before promotion.
- Dependencies include "ENH-031 decision, PR #3817 outcome" — correctly sequential.
- Required directions (top-down/bottom-up), unresolved (9 sub-items), acceptance candidate, promotion trigger all present and bounded.

**ZOB-ENH-033 — Persistent source↔documentation coverage graph:** Status `Research; likely supporting ENH-032`. Correctly subordinate to 032.

**Factory activations (ENH-020/021/022):** all `Specified-disabled`, acceptance references 04/05 factory docs + validation phases, promotion triggers gated on stability + human authorization — consistent with 16-D-013/098 and 14 rollout.

**ENH-023 (Deployment Confirmation):** `Deferred`, "never dispatches deploy by default", promotion trigger "Automatic CD needs systematic confirmation" — consistent with 16-D-091 and 13 "deployment confirmation is a separate future factory".

**ENH-024 (Deployment rollback/recovery):** `Research`, depends on ENH-023, "human authorization for live mutation" — consistent.

**Rejected-as-v1-shortcuts list (13 items):** each maps to a ratified decision forbidding it (e.g., "journal tail deletion on corruption" → D-020; "plaintext or Git-stored transcripts" → D-026; "labels/comments as canonical authorization" → D-089/095; "reviewer source edits" → D-074; "global unattended auto-merge" → D-084; "Ship-triggered deployment workflows" → D-091; "automatic learned routing/prompt promotion" → D-065). Internally consistent.

**Dependency/acceptance quality:** Every entry has Status, Value, Dependencies, Acceptance, Promotion trigger. Dependencies cross-reference other ENH IDs correctly (ENH-004→001, ENH-005→001/004, ENH-015→013, ENH-021→020, ENH-024→023, ENH-029 implicit, ENH-032→031, ENH-033→032). Acceptance criteria are concrete and testable (e.g., "no split-brain; deterministic sequence/claim ownership; crash/takeover/property tests; oracle PASS"). No circular or missing dependency references found.

**No defects found.** Enhancement dependency/acceptance quality is high.

### 7. SOURCE_EVIDENCE.md — PASS

**Truth-class header:** `Current evidence references plus explicit limitations` + `Captured: 2026-07-18`. Honest and date-bound.

**Current-evidence honesty (strong):**
- ZOB execution-observability source: worktree `execution-observability`, branch `feature/execution-observability-v016`, base `657f470b3a5fcdb594fa1e746f58e186383567d4`. Evidence files listed. **Observed baseline honestly states what is missing:** "there is no unified transactional mission scheduler, event sequence, durable dispatch reservation, daemon or encrypted transcript store. The worktree had uncommitted changes and must be preserved/revalidated before PR claims." ✅ This is exemplary current-evidence honesty — distinguishes what exists from what is specified.
- Wheel worker/reviewer/ship source: paths listed; observed R/S/Ready Guard baselines described as **"current facts being replaced, not desired behavior"** ✅ — explicitly prevents treating current-state as target-state.
- Live skill inventory snapshot: enumerated counts (188/34/25/0 collisions) with date; "The generic/parameterized/application-specific migration partition is intentionally not asserted as a fixed count until the implementation inventory classifies all current files." ✅ Honest about what is not asserted.
- Fleet v5 story signals: PR #3853 at head `404ca9196a6f9546440f38f0146fc7951b09d4f0`, 60 stories / 17 signal fields. Matches 16-D-039.
- Model/prompt lab: observed `fleet-bakeoff` declares `uniform|optimized|both` but "currently rejects optimized/both as unimplemented." ✅ Honest about unimplemented modes — consistent with ENH-013.
- **Repository assurance functionality (PR #3817):** "GraphQL source inspection at **open draft head**", PR state `OPEN / draft`, head `02af54029423310cbc4ed1cd70153ab611b766df`, base `develop`. "This is the evidence base for proposed `ZOB-ENH-032`; **because the PR is still an open draft, it is not current merged behavior.**" ✅ Date-qualified, state-qualified, and explicitly distinguished from merged truth. This is the exact honesty posture the audit contract requires.
- Pi capabilities: "Read fully during design" with doc paths — consistent with Pi docs references.
- Docs-tools repository baseline: fresh clone, base branch `main`, base commit `443af1b`. Honestly states "There was no root `AGENTS.md`, Pi package manifest, ZOB docs, mission-state branch implementation or model-telemetry branch implementation in the inspected main checkout." ✅ Matches 12's "future path" framing and 16's "Explicitly unresolved" release-version gap.
- Old sibling `jointhewheel-doc-archive`: "remained pointed at the old archive remote and 24 commits ahead; it was not reset or repurposed." ✅ Matches 12 preflight step 5 and 14 Phase 0.
- **Design-only statements:** "Everything labeled Approved design—daemon, SQLite/journal protocol, Apps, Checks, factories, schemas, package release, branches, TUI, model/prompt routing—is not current implementation evidence. Implementation and activation require 14-VALIDATION_AND_PILOTS.md." ✅ This is the single strongest honesty statement in the corpus and governs the entire lane.

**No defects found.** SOURCE_EVIDENCE is the honesty anchor and is fully consistent with the other six files.

---

## Cross-file consistency matrix

| Topic | 12 | 13 | 14 | 15 | 16 | ENH | SRC | Consistent |
|---|---|---|---|---|---|---|---|---|
| Factory default-disabled / activation gate | ✓ (flags) | ✓ ("disabled until activated") | ✓ (gate) | — | ✓ (D-013/098/099) | ✓ (ENH-020/021/022) | — | ✅ |
| `zobd` user service + Unix socket, no network | ✓ | — | ✓ (Phase 1) | — | ✓ (D-006) | — | — | ✅ |
| Keychain failure blocks, no plaintext | ✓ | ✓ (persistence) | ✓ (Phase 1) | — | ✓ (D-026/027) | — | — | ✅ |
| Shared branches `zob-mission-state`/`zob-model-telemetry` | ✓ (named) | generic | — | generic | ✓ (D-023/025 named) | — | ✓ (not implemented) | ✅ (F-02: 13/15 generic) |
| `pi install` exact-version pins proposed | ✓ | — | — | ✓ (pinned) | ✓ (D-010) | — | ✓ (Pi docs/packages.md) | ✅ |
| `wheel-zob` CLI proposed | — | ✓ | — | — | — | — | — | ✅ |
| Provider/model aliases unresolved until audit | ✓ | ✓ (incidents) | ✓ (Phase 7) | — | ✓ (D-015/066) | ✓ (ENH-016/017) | ✓ (model lab) | ✅ |
| Three PR-close auditors / three fresh checks | — | — | ✓ | — | ✓ (D-050) | — | — | ✅ |
| Three max review/repair rounds | — | ✓ | — | — | ✓ (D-078) | — | — | ✅ |
| One merge in flight / pending post-merge block | — | ✓ | — | — | ✓ (D-086/092) | — | — | ✅ |
| PR A / PR B split | — | — | ✓ | — | ✓ (D-009) | — | — | ✅ |
| Rollout: smoke → one-story → multi-story → another-machine | — | — | ✓ (Phases 8–11) | — | ✓ (D-097) | — | — | ✅ |
| Dirty worktree preserved | ✓ | — | ✓ (Phase 0) | — | ✓ (D-008) | — | ✓ (uncommitted) | ✅ |
| Old `jointhewheel-doc-archive` not repurposed | ✓ | — | ✓ (Phase 0) | — | — | — | ✓ | ✅ |
| PR #3817 open-draft, captured head date-qualified | — | — | — | — | ✓ (unresolved) | ✓ (ENH-032) | ✓ | ✅ |
| ZOB-ENH-031/032 proposed, not ratified | — | — | — | — | ✓ ("not ratification") | ✓ (Proposed-needs-discussion) | — | ✅ |
| No completion claim without live validation + review | — | — | ✓ | — | ✓ (D-102) | — | ✓ (design-only) | ✅ |
| Rollback never truncates journal / deletes transcripts | ✓ (uninstall) | ✓ (persistence) | — | ✓ (rollback never) | ✓ (D-020/026) | — | — | ✅ |
| Internal cross-links resolve | ✓→14 | — | — | — | ✓→ENH | ✓→04/05 | ✓→14 | ✅ |

---

## Install / ops / validation / rollback safety summary

**Install (12):** Strong. Credentials excluded from lock/config, keychain-only key storage, keychain failure blocks (no plaintext fallback), no network listener, all factories default-disabled, GitHub Apps installation ≠ activation, Ship credentials absent until gate, providers manual + paid tests separately approved, uninstall preserves evidence and never auto-deletes transcripts/keys. No defects.

**Ops (13):** Strong. Deterministic loop, no shell passthrough, receipt-gated high-risk ops, needs-human authenticated-source-only, provider/auth bodies never printed, workspace conflicts never auto-clean/reset, one merge in flight, deployment never manually retriggered, disk hard-stop never auto-deletes, force-stop records orphaned work. F-02 only.

**Validation (14):** Strong. Deterministic-first/LLM-second, mocked GitHub before remote, no network/paid model in simulation, human selects + approves spend/writes for real pilots, no ready/merge/deploy in one-story pilot, independent oracle PASS required, activation gate = sentinels + no no-ship + exact versions + human receipt + rollback plan + fresh oracle PASS/no-ship false, Ship per-batch authorization. F-01 only.

**Rollback (15):** Strong. Pin/preview/validate before change, journal remains audit source, never rewrite historical events/receipts/assignments, rollback never truncates/deletes/resets/force-updates/revives/replays-unsafely, failed upgrade leaves old runtime or blocks human, no partially-migrated mission running, uninstall vs rollback distinguished, neither deletes state/telemetry/transcripts/keys without explicit scope. F-02 only.

**No safety blockers identified across the four operational files.**

---

## Current-evidence honesty summary

- **SOURCE_EVIDENCE** is the honesty anchor: explicitly states what does not exist (no scheduler, no daemon, no encrypted transcript store, no mission-state/model-telemetry branch implementation, no root AGENTS.md in the inspected main), marks the worktree as uncommitted and requiring revalidation, and labels the entire Approved-design surface as "not current implementation evidence."
- **16-DECISIONS** "Explicitly unresolved" list and "Binding for implementation planning; not proof of implementation or activation" header preserve the design/implementation boundary.
- **12/13/15** command-state/CLI-examples headers mark all commands as proposed.
- **14** is labeled "Approved implementation/activation plan" (F-01: missing explicit plan-state qualifier, but content is unambiguously a plan).
- **ENHANCEMENTS** rule + status vocabulary + ENH-031/032 "Proposed-needs-discussion" + PR #3817 "open draft … not merged current truth" keep proposals out of ratified scope.
- **README** truth-class/maturity distinction + "Absolute boundary" (no merge/deploy/publish/provider/App authorization) governs the lane.

**No honesty defects identified.** The corpus does not blur current evidence, approved design, and future enhancement.

---

## Decision consistency summary

All 102 decisions in 16-DECISIONS were spot-checked against the operational files in this lane and cross-referenced docs (03/04/05/06/07/08/09/10/11). No contradictions found. Key consistency points:
- D-006/013/014 (supervisor/factory-disabled/install≠activation) → 12/13/14 ✅
- D-016/017/020/026/027 (persistence/transcripts/keychain) → 13/15/07 ✅
- D-021/022/023/024/025 (restart/takeover/checkpoints/telemetry) → 13/15/12 ✅
- D-039/050 (17 signals/three Sol-high) → SOURCE_EVIDENCE/03 ✅
- D-078 (three rounds) → 13 ✅
- D-086/092 (one merge in flight/post-merge block) → 13 ✅
- D-097/098/099/102 (rollout/activation gate/per-batch/no-completion-without-validation) → 14 ✅
- D-031/032 (ENH-031/032 not ratified) → ENHANCEMENTS ✅

---

## Enhancement dependency/acceptance quality summary

All 36 enhancements (ENH-001–036) have the required five fields (Status, Value, Dependencies, Acceptance, Promotion trigger). Dependencies cross-reference correctly with no circular or missing links. Acceptance criteria are concrete and testable. Status vocabulary is consistent (Deferred/Specified-disabled/Research/Proposed-needs-discussion). ENH-031/032 correctly remain `Proposed-needs-discussion (requested 2026-07-18)` with PR #3817 captured head date-qualified and explicitly marked "evidence for the proposal, not merged current truth." The rejected-as-v1-shortcuts list maps cleanly to ratified decisions forbidding each item. No dependency/acceptance quality defects.

---

## Routing

All findings are routed to `current_branch_fix`:
- **F-01 (Low):** Optional header qualifier addition in `14-VALIDATION_AND_PILOTS.md`. Not blocking.
- **F-02 (Low):** Optional inline branch-name citation in `13-OPERATIONS_RUNBOOK.md` and `15-UPGRADE_AND_ROLLBACK.md`. Not blocking.
- **F-03/F-04/F-05 (Informational):** No action required; recorded as positive consistency/honesty confirmations.

No finding requires a cross-repository change, a schema change, a decision-record update, or an enhancement-status change. No finding alleges a safety, honesty, or correctness blocker.

---

## Scope-manifest compliance

- `reviewMode: full` — honored; every line of all 7 files read.
- No sampling. No file skipped.
- No edits except this named report (`docs/zob/reviews/LANE_OPERATIONS_DECISIONS.md`).
- No network, secrets, transcripts, provider/App activation, or merge/deploy authority invoked.
- No assumption that commands, releases, factories, or GitHub Apps currently exist; all treated as proposed/future per truth-class headers.
- Repo-relative refs used throughout; cross-file links verified to resolve.

---

## Final marker

LANE_OPERATIONS_DECISIONS_AUDIT_COMPLETE
