# 16 — Decision Record

**Truth class:** Ratified design decisions
**Status:** Binding for implementation planning; not proof of implementation or activation

Proposed items still awaiting discussion are kept in [`ENHANCEMENTS.md`](ENHANCEMENTS.md), not silently promoted here.

## System and repository

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-001 | Original repository split: `zob-harness` owned generic mechanics; docs-tools owned Wheel AgentOps policy; `jointhewheel` owned application adapters. **Superseded by ZOB-D-122.** | Preserved as design history; the module boundary remains, but the first two layers now share one repository. |
| ZOB-D-002 | Build, formal review and ship are three distinct factories. | Each has different trust, permissions, evidence and stop conditions. |
| ZOB-D-003 | Story factory stops at exact-head PR-close and review handoff. | It cannot claim formal approval, ready, merge or deployment. |
| ZOB-D-004 | Version one executes on one machine but uses portable IDs/manifests/checkpoints/leases. | Keeps v1 operable while preserving later distribution. |
| ZOB-D-005 | “One logical orchestrator” is a deterministic persistent supervisor plus fresh model calls. | Mission liveness cannot depend on one LLM session. |
| ZOB-D-006 | `zobd` is an independent user service connected by a permissioned local Unix socket. | Pi/TUI can close without stopping work; no network service is exposed. |
| ZOB-D-007 | No idle LLM loop. | Watchers and state machines are deterministic; model cost is task/judgment scoped. |
| ZOB-D-008 | Existing dirty ZOB worktree is preserved and integrated through reviewable PRs. | Destructive cleanup would erase evidence/work. |
| ZOB-D-009 | Runtime implementation is split into durable-core PR A and operational Story-factory PR B. | Makes persistence/lifecycle reviewable before broad integration. |
| ZOB-D-010 | Wheel pack initially ships as a tagged, checksummed private Git/Pi package with exact lock. | Simple reviewable distribution without premature package infrastructure. |
| ZOB-D-011 | Generic/shared skills were to migrate to docs-tools while app-specific skills stayed in `jointhewheel`. **Superseded by ZOB-D-122.** | Preserved as migration history; reusable generic and parameterized Wheel layers now live in one repository without becoming one module. |
| ZOB-D-012 | Pi package checkout is never reused for mission/telemetry state branches. | Package reconciliation must not reset mutable runtime state. |
| ZOB-D-013 | Blind Review and Ship are specified now but disabled until separate validation/activation. | Contracts shape v1 without granting premature authority. |
| ZOB-D-014 | Installation, activation and per-action authorization are distinct states. | Installed code must not imply permission to act. |
| ZOB-D-015 | Exact provider/model aliases remain unresolved until capability audits. | Avoid false configuration from catalog names rather than observed behavior. |

## Persistence, recovery and truth

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-016 | SQLite projections plus a hash-chained append-only JSONL journal. | SQLite enables transactional queries/outbox; journal enables audit/rebuild. |
| ZOB-D-017 | Journal append+`fsync` precedes idempotent SQLite projection transaction. | Crash between phases can replay without losing acknowledged intent. |
| ZOB-D-018 | One exclusive mission owner allocates event sequence/lock. | Prevent split-brain and duplicate scheduler authority. |
| ZOB-D-019 | GitHub/external effects execute from a post-commit idempotent outbox. | External mutation is never ahead of durable intent. |
| ZOB-D-020 | Corrupt journal tail is preserved/quarantined and mission becomes recovery-blocked. | Integrity failure cannot be “repaired” by silent deletion. |
| ZOB-D-021 | Automatic same-machine restart; explicit authenticated cross-machine takeover. | Prevent concurrent owners while supporting recovery. |
| ZOB-D-022 | Former machine-local active runs become orphaned on takeover and are re-evaluated. | Another host cannot assume a local process is alive. |
| ZOB-D-023 | Portable body-safe checkpoints use `zob-mission-state`. | Shared recovery needs durable state without transcript bodies. |
| ZOB-D-024 | Checkpoint pushes require expected remote head and stop on conflict. | Never overwrite another owner’s state. |
| ZOB-D-025 | Exact model/prompt mappings use protected `zob-model-telemetry`. | Preserve analysis while denying biasing data to agents/reviewers. |
| ZOB-D-026 | Full transcripts are encrypted locally and retained until manual deletion. | Maximal replayability without plaintext/Git exposure; ZOB never auto-deletes. |
| ZOB-D-027 | OS keychain mission key wraps per-attempt authenticated chunk keys. | Bounded cryptographic deletion and tamper-evident replay. |
| ZOB-D-028 | Transcript disk warning and hard-stop pause new dispatch. | Avoid uncontrolled disk exhaustion without deleting evidence. |
| ZOB-D-029 | Adaptive GitHub polling first; webhooks later, polling remains fallback. | Simpler v1 with reconciliation correctness. |
| ZOB-D-030 | Mission Control distinguishes heartbeat, activity, progress and external freshness. | Prevent optimistic “working/current” claims. |

## Story manifests, profiles and workspaces

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-031 | Full canonical execution manifest lives on each story branch. | Contract travels with source and can be reviewed. |
| ZOB-D-032 | Manifest revisions are immutable/hash-linked; task IDs never renumber. | Preserve lineage across splits/repair/replan. |
| ZOB-D-033 | Workers propose structural changes; supervisor alone revises the manifest. | No agent can silently change scope/acceptance/dependencies. |
| ZOB-D-034 | Cross-gate pipelining only through explicit DAG edges; closure order remains strict. | Gains safe parallelism without weakening gates. |
| ZOB-D-035 | Invalid bindings reopen only affected gate/task descendants. | Progress can move backward truthfully without restarting everything. |
| ZOB-D-036 | One base execution profile plus compositional overlays; stricter union wins. | Avoid profile explosion while preserving domain rigor. |
| ZOB-D-037 | Bases are full-feature, quick-fix, docs-process and refactor-cleanup. | Covers primary work shapes. |
| ZOB-D-038 | Supervisor may conservatively add overlays; weakening/removal needs human approval. | Automation may strengthen but not silently lower controls. |
| ZOB-D-039 | Fleet v5’s 17 signals are preserved as inputs, not model decisions. | Separate story description from routing preference. |
| ZOB-D-040 | Unknown taxonomy values become `candidate:<value>` without policy effects. | Capture emergent labels without uncontrolled behavior. |
| ZOB-D-041 | Task-scoped skill allowlists record exact skill/shared-contract versions. | Limit context/authority and distinguish workflow changes from model quality. |
| ZOB-D-042 | One canonical story worktree with exclusive path leases; risky overlap uses sandbox. | Allow concurrency without ownership ambiguity. |
| ZOB-D-043 | Workers submit merge candidates; integration owner validates, commits and pushes. | Builders do not self-integrate or receive GitHub authority. |
| ZOB-D-044 | Story draft PR opens immediately after non-empty bootstrap commit. | Gives early visibility without confusing empty PRs as work. |
| ZOB-D-045 | Stacked stories target parent branch until safe retargeting. | Preserve dependency order and reviewable deltas. |
| ZOB-D-046 | Genuine human wait closes worker, checkpoints and resumes in a fresh attempt. | Do not hold capacity/session memory while waiting. |
| ZOB-D-047 | First valid human answer is authoritative; conflict creates a card. | Durable deterministic handoff semantics. |
| ZOB-D-048 | Ordinary draft CI must be terminal at PR-close; ready-only checks are explicitly deferred. | PR-close is current evidence without prematurely entering Ship. |
| ZOB-D-049 | Known flake may auto-rerun once only on matching ledger signature. | Avoid endless reruns and real-failure masking. |
| ZOB-D-050 | Three independent fixed `Sol-high` tasks are inside PR-close: source/integration, evidence/QA/CI and finalizer. | Separates close assurance from later formal R review. |

## Model and prompt policy

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-051 | Development/QA/docs/internal-review pools are uniformly shuffled after hard eligibility. | Establish unbiased baseline. |
| ZOB-D-052 | Initial labels affect hard eligibility only, not preference. | Avoid baking current assumptions into evaluation. |
| ZOB-D-053 | Opaque `agentId/runId/attemptId/assignmentId`; assignment is per attempt. | Prevent identity/reputation linkage. |
| ZOB-D-054 | Orchestrator/workers/QA/reviewers/adjudicators do not see model, thinking or prompt treatment. | Preserve blindness. |
| ZOB-D-055 | Attempt ladder starts at lowest supported level ≥ low and advances through supported levels. | Cheap capability-first escalation. |
| ZOB-D-056 | Non-reasoning models get one default attempt. | Do not invent thinking controls. |
| ZOB-D-057 | Provider/tool/permission/human/environment failures do not consume quality rungs. | Attribute failures correctly. |
| ZOB-D-058 | QA/review prefer different model family; different exact model is fallback; same model is degraded. | Increase independence without deadlocking scarce pools. |
| ZOB-D-059 | Equivalent provider routes are distinct candidates sharing one underlying family. | Measure reliability/cost while preserving independence semantics. |
| ZOB-D-060 | Prompt experiment allocation is 50% uniform control / 50% vetted candidate. | Retain a permanent baseline. |
| ZOB-D-061 | Prompt seed is independent of model seed and variant stays fixed over one model ladder. | Avoid confounding treatment and effort. |
| ZOB-D-062 | Candidate exhaustion permits bounded control rescue on same model. | Distinguish prompt failure from model failure. |
| ZOB-D-063 | Fixed orchestrator/close/adjudicator prompts do not experiment initially. | Stability at governance-critical gates. |
| ZOB-D-064 | Exact model/prompt telemetry is protected; story evidence uses opaque IDs only. | Analysis without bias/exposure. |
| ZOB-D-065 | Recommendations remain advisory and require human-approved policy release. | No self-modifying routing. |
| ZOB-D-066 | `fireconnect` and OpenAI OAuth require bounded capability/blindness/cost/transcript audit before pools. | Catalog availability is not runtime proof. |

## Formal Blind Review (R successor)

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-067 | Formal R review is `mpr` formal-PR, not `/review-all`. | `/review-all` remains pre-close/human scanner; formal review is read-only exact-head assurance. |
| ZOB-D-068 | Dynamic global review queue replaces static R→W assignment. | Better fairness, utilization and recovery. |
| ZOB-D-069 | Risk scales mandatory panel lanes: 1 low, 2 medium, 3+ high/security. | Spend review where blast/trust demands it. |
| ZOB-D-070 | Experimental review lanes may add blockers but cannot clear alone. | Preserve stable control coverage. |
| ZOB-D-071 | Review starts with frozen fresh-source pass, then acceptance/evidence pass. | Detect both raw defects and contract gaps without priming. |
| ZOB-D-072 | Fixed strong blind adjudicator reconciles frozen lane reports. | Stable verdict while discovery lanes generate experimental evidence. |
| ZOB-D-073 | Every evidence-qualified defect/acceptance gap blocks; suggestions do not. | Severity does not excuse correctness defects. |
| ZOB-D-074 | Reviewer agents are source-read/report-only; no source/GitHub mutation. | Formal independence. |
| ZOB-D-075 | Dedicated Reviewer App issues exact-SHA `ZOB / Blind Review` Check. | Canonical issuer-bound evidence. |
| ZOB-D-076 | Bare `blind-review-clean` label is projection only. | Prevent spoofed/stale approval. |
| ZOB-D-077 | Findings return to Story repair/re-close; next round includes fresh full diff plus repair-verification. | Avoid tunnel vision and confirm repair. |
| ZOB-D-078 | Maximum three automatic review/repair rounds, then needs-human. | Bounded loop. |
| ZOB-D-079 | Head change cancels/requeues; base change invalidates only for meaningful collision. | Exact source while avoiding unnecessary full review. |
| ZOB-D-080 | Strict legacy PR-close adapter fails closed on missing fields. | Permit migration without permanent weak fallback. |

## Initial direct-develop Ship design — superseded

**Status:** ZOB-D-081 through ZOB-D-095 preserve the first design discussed in this record but are superseded for Wheel ordinary PRs by ZOB-D-103 through ZOB-D-121. They are not implementation authority.

| ID | Superseded decision | Why retained |
|---|---|---|
| ZOB-D-081 | `/pr-ship` was one direct-base merge broker. | Semantic ownership now has staging and promotion modes. |
| ZOB-D-082 | One least-privilege Ship App. | Split into Staging Merge and Promotion Apps. |
| ZOB-D-083 | Eligible draft auto-ready after pre-ready gates. | Preserved for staging. |
| ZOB-D-084 | Every merge required a human exact-head batch receipt. | Ordinary staging merges now auto-merge; only promotion requires human receipts. |
| ZOB-D-085 | Authorization invalidation on head/base change. | Preserved for promotion receipts. |
| ZOB-D-086 | One merge in flight and post-merge interlock. | Preserved separately for staging and promotion. |
| ZOB-D-087 | Squash-only merge. | Preserved for ordinary staging; promotion is merge-commit. |
| ZOB-D-088 | Ship cannot repair/refresh Story evidence. | Preserved. |
| ZOB-D-089 | Earlier PR Close/Blind Review/Human/Merge/Ship Checks. | Replaced by staging/assurance/promotion Check set. |
| ZOB-D-090 | Per-PR deployment-impact receipt. | Aggregated per included PR in the promotion receipt. |
| ZOB-D-091 | No manual deploy trigger or deployment-success claim. | Preserved. |
| ZOB-D-092 | Post-merge exact event/interlock. | Preserved as post-promotion reconciliation/alignment. |
| ZOB-D-093 | Risk-based post-merge bundle review. | Preserved. |
| ZOB-D-094 | No broad human-override bypass. | Preserved. |
| ZOB-D-095 | Labels/comments are projections; Checks/receipts canonical. | Preserved. |

## Rollout and governance

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-096 | Document/specify before resuming implementation. | Reduce rework and surface cross-repository contracts. |
| ZOB-D-097 | Rollout: deterministic local smoke → Story pilots → Blind/Staging pilot → Assurance/Promotion simulation → another-machine. | Bound risk and prove installability without live deployment. |
| ZOB-D-098 | Every factory activation requires fresh oracle PASS/no-ship false plus explicit receipt. | Installation/implementation is insufficient authority. |
| ZOB-D-099 | Every develop promotion requires a human-started window and later exact-head promotion-merge authorization even after factory activation. | No ambient develop/deployment authority; ordinary staging merges are automatic after gates. |
| ZOB-D-100 | Exact body-safe schemas/examples are part of acceptance. | Make prose contracts testable. |
| ZOB-D-101 | Deferred work uses stable enhancement IDs with trigger/acceptance/dependencies. | Avoid idea loss and accidental scope creep. |
| ZOB-D-102 | No completion claim without live validation and independent review evidence. | Separate authored docs from verified suite. |

## Mandatory staging, final assurance and promotion

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-103 | Every ordinary PR targets persistent `develop-staging`; `develop` accepts only typed audited promotion PRs. | Integration and final audit precede deployment-capable history. |
| ZOB-D-104 | `develop-staging` never deploys; automatic CD turns on only from the audited merge into `develop`. | Restore automatic CD without letting ordinary merges deploy. |
| ZOB-D-105 | Required CI runs at ordinary PR, exact merged staging head, frozen assurance head, promotion PR and post-promotion aligned staging head. | Catch local, integration, promotion-base and alignment regressions. |
| ZOB-D-106 | Qualified PRs auto-ready/squash-merge one-at-a-time into staging without human per-PR receipt. | Staging is protected/non-deploying; remove redundant human gate. |
| ZOB-D-107 | A staging merge remains interlocked until full integration CI is terminal green; only an exact failure-bound, fully gated repair PR may cross a red interlock. | Never stack unrelated change onto an unknown/red head without deadlocking repair. |
| ZOB-D-108 | Staging Merge App and Promotion App are separate identities. | Continuous staging automation never holds develop-merge credentials. |
| ZOB-D-109 | Only a human starts/abandons a promotion window. | Promotion cadence is human-started in v1. |
| ZOB-D-110 | `develop-staging` freezes unrelated merges during assurance/promotion; only finding-bound round-1/2 repair PRs may merge through normal gates and candidate revision. Open PR work/CI may continue. | Stable exact-head audit with a bounded repair exception. |
| ZOB-D-111 | Final assurance is a closed read-only audit → separate finding-bound repair PR → candidate revision → full CI → wholly fresh re-audit loop. | Preserve reviewer independence and exact window lineage while closing findings. |
| ZOB-D-112 | Assurance requires ten PR #3817-style independent lanes across at least three model families where available and a fixed blind synthesizer. | Whole-repository coverage and model independence. |
| ZOB-D-113 | Bottom-up audit inventories every discoverable code element and gives exactly one disposition. | “Everything accounted for” is testable without forcing prose for every private helper. |
| ZOB-D-114 | Every public/operational element must map to current canonical docs; internal/test/generated/vendor/deprecated elements still need explicit evidence-backed disposition. | Full bidirectional source↔docs truth without unreadable canonical docs. |
| ZOB-D-115 | Top-down audit requires exact canonical manifest, per-document source verification and `STALE=0/PENDING=0`. | Docs must represent exact candidate reality. |
| ZOB-D-116 | Maximum three full assurance rounds and therefore at most two automatic repair transitions; round-3 findings go directly to one needs-human case. | Bound cost/thrash and prohibit implicit round 4. |
| ZOB-D-117 | Promotion is a PR from frozen staging to develop merged with a merge commit, never squash/rebase. | Preserve exact audited staging commits/history. |
| ZOB-D-118 | Promotion-window and promotion-merge are distinct human receipts; the window binds the initial candidate and authorized repair descendants, while the merge receipt binds the final exact candidate. Unrelated head/base changes invalidate. | Starting/repairing audit is not permission to deploy-capable merge. |
| ZOB-D-119 | Canonical new Checks: Staging Merge Gate, Staging Integration, Repository Assurance, Promotion Authorization and Promotion Gate. | Issuer/SHA-bound staged authority. |
| ZOB-D-120 | Successful promotion receives exact-input reconciliation, expected-head fast-forward alignment, then full integration CI/Check on the aligned staging SHA before unfreeze. | Preserve branch ancestry/tree and prove the next-batch baseline. |
| ZOB-D-121 | Version one has no break-glass direct-to-develop path and never manually dispatches CD. | Emergencies cannot silently bypass assurance; automatic CD comes only from promotion merge. |

## Repository consolidation

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-122 | `zob-harness` is the canonical repository for both generic runtime mechanics and the bounded Wheel AgentOps pack/specification; `jointhewheel` retains only application-specific adapters and integration. | One discoverable installable system removes repository-placement ambiguity. Generic runtime code still cannot import or hard-code Wheel policy; that boundary is enforced by packages, schemas, dependency checks and separate PR review rather than by a second repository. The preserved docs-tools copy is migration evidence only. |

## Model/provider audit (2026-07-18)

| ID | Decision | Rationale / consequence |
|---|---|---|
| ZOB-D-123 | Provider surface is `fireworks` (via `fireconnect` CLI v0.8.0 OpenAI-compatible endpoint) plus `openai-codex` (Codex OAuth). Fireconnect is a setup/proxy tool, not a separate provider. | Removes the deferred provider-identity placeholder; no credential or base URL stored in repository. |
| ZOB-D-124 | Verified randomized pools: development (9), QA (6), documentation (6), internal review (6), formal blind-review (6), repository-assurance (6). Fixed/stable roles run on `openai-codex/gpt-5.6-sol` at high thinking. | Evidence-backed pools replace the empty/unverified placeholder; only routes that passed the 11-test capability battery on the actual provider path are admitted. |
| ZOB-D-125 | A per-model thinking format adapter is required: `reasoning_effort` enum for gpt-oss-120b and minimax-m2p7; `thinking.budget_tokens` for kimi, deepseek, minimax-m3 and nemotron. GLM and qwen budgets are advisory. | Token-budget thinking is rejected by gpt-oss and minimax-m2p7; an unapproved clamp is a capability mismatch, not a successful rung. |
| ZOB-D-126 | qwen3p7-plus requires `system`+`user` message roles only; the `developer` role is rejected. The prompt compiler must emit system-role instructions for qwen routes. | Error 1010 on developer role; all other capabilities pass. |

## Explicitly unresolved

- GitHub App IDs/installation and final permission manifests.
- Runtime release versions and compatibility matrix.
- Exact parser/adaptor inventory coverage for every implementation language/framework, to be proven in assurance fixtures.
- Any future break-glass production-emergency policy; none exists in v1.
- OpenAI Codex JSON mode / raw tool-call format / streaming event order (pi CLI wraps these; unverified, not failed).
- GLM/qwen thinking budget clamping at larger fixture sizes (advisory at fixture scope; larger reasoning fixtures needed to confirm cost/depth scaling).