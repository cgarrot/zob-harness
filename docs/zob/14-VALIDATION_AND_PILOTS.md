# 14 — Validation, Rollout and Pilots

**Truth class:** Approved implementation/activation plan
**Plan state:** Required validation sequence; no phase is executed or activated by this document.

## Principle

Deterministic scaffolding first, LLM enrichment second. Smoke one item, obtain oracle evidence, then pilot at bounded concurrency. No global autonomy claim.

## Phase 0 — Specification and repository safety

- fresh clean ZOB documentation worktree and repository rules;
- consolidated docs/schemas/examples/terminal manual;
- classify and preserve the separate dirty execution-observability worktree;
- preserve old archive/worktrees;
- independent architecture/security/doc review.

## Phase 1 — Durable supervisor kernel

- service/socket;
- journal/SQLite/snapshots/outbox;
- recovery/ownership;
- encrypted transcripts;
- minimal HUD.

Tests: crash injection around every append/commit, replay/idempotency, DB rebuild, corrupt-tail block, same-machine restart, explicit takeover, transcript integrity/delete and socket stale behavior.

## Phase 2 — Manifest/DAG/lifecycle

- schemas/profile composition;
- dispatch reserve/preflight/ACK;
- claims/acceptance/gate reopen;
- permission/ACK primitives;
- blindness/skill grants.

Required regressions:

- failed preflight never leaves the task stuck in `delegated`: reservation releases and the task returns to `ready` or a terminal blocker;
- `needs-review` has valid resolve/reopen/reject paths;
- no terminal stuck leaf;
- stale optional leaves cannot be hidden;
- state-machine/property tests.

## Phase 3 — Workspaces/external truth

- leases/sandboxes/merge candidates/integration owner;
- draft PR/bootstrap;
- GitHub broker/polling/CI;
- needs-human/checkpoints.

Use local Git and mocked GitHub before any remote smoke. Test duplicate effect, head/ref races, dirty state, ACK-label projection and unreachable merge/deploy operations.

## Phase 4 — Mission Control

Full rendering/keyboard/status/freshness/live-output/replay tests at narrow/wide sizes. Verify dispatch≠running, claim≠accepted and stale sources never appear current.

## Phase 5 — Consolidated Wheel pack

- package/profile/taxonomy/prompt/policy/skills/contracts;
- install/update/drift/rollback tools;
- docs/enhancements;
- schema/golden/collision/clean-install tests.

## Phase 6 — JointheWheel adapter

- pinned settings/lock;
- story/Fleet v5 adapters;
- mandatory `develop-staging`, typed promotion PR and PR/staging/promotion Guard integration;
- workflow proof that staging never deploys and only audited develop promotion enables automatic CD;
- model-lab telemetry bridge;
- compatibility and collision tests.

Do not remove local generic skills until parity/rollback pass.

## Phase 7 — Model/prompt/provider audit

Under explicit spend approval:

- `fireconnect` and OpenAI OAuth inventory;
- bounded route/effort/tool/stream/cost/error/blindness/transcript smokes;
- exact pool/family/alias configuration;
- prompt control/candidate fixtures.

**Status:** completed 2026-07-18. 20 routes tested (17 Fireworks via Fireconnect + 3 OpenAI Codex), 297 calls, $0.13 metered spend against $5 cap. Verified pools, thinking-format adapter (budget_tokens vs reasoning_effort), and qwen role-format caveat are recorded in [`09-MODEL_AND_PROMPT_EXPERIMENTS.md`](09-MODEL_AND_PROMPT_EXPERIMENTS.md). Evidence: `reports/fireconnect-capability-tests/MATRIX.md`.

## Phase 8 — Deterministic local simulation

Disposable repo scenarios:

- full + quick stories;
- needs-human;
- CI failure/flake;
- agent crash/supervisor restart;
- gate reopen;
- stack dependency;
- PR-close;
- no network/paid model needed.

## Phase 9 — One-story real pilot

Human selects low-risk story and approves bounded model spend/GitHub writes.

Require immediate draft, truthful TUI, no stuck lifecycle, assignment blindness, prompt telemetry, exact evidence, terminal draft CI, three fresh close checks, no ready/merge/deploy and independent oracle PASS.

## Phase 10 — Multi-story pilot

2–3 stories with different profiles, concurrency, dependency/stack, human checkpoint, QA/docs overlays and crash/restart. Measure fairness, leases, budgets, model/prompt data and recovery.

## Phase 11 — Staging Merge pilot

In a dedicated test repository with no deployment credentials:

- every ordinary PR targets protected `develop-staging`;
- Staging Merge App cannot write/merge `develop`/`main`;
- qualified PRs auto-ready/squash-merge one at a time without human receipt;
- full staging integration CI is push-triggered after each merge and no App can dispatch it;
- red/unknown integration blocks unrelated merges and admits only the exact failure/head-bound reviewed repair PR;
- every deployment workflow proves staging exclusion.

## Phase 12 — Final Repository Assurance pilot

- human-start/freeze/abandon receipts bound to initial staging SHA plus candidate-revision/authorized-repair lineage;
- frozen unrelated-merge queue with only finding-bound round-1/2 repair exceptions;
- exact candidate/develop boundary and ten independent lanes across ≥3 model families when available;
- exact canonical-doc manifest with `STALE=0/PENDING=0` clean requirement;
- parser-backed every-element inventory with one disposition and zero undocumented/unknown public elements;
- at most two separate repair transitions, each with full staging CI and a wholly fresh next audit round;
- current-head invalidation and round-3 direct-to-needs-human ceiling;
- PR #3817 fixture parity, synthesizer/adjudicator and Check issuer tests;
- negative fixtures reject unmapped public elements, count drift, duplicate IDs, stale/pending docs, missing lanes, false undegraded family shortage, auditor=repairer, repair after round 3 and non-pass/noShip=false.

## Phase 13 — Promotion and automatic-CD simulation

- typed promotion PR from staging to develop;
- full promotion PR CI and tree-equivalence proof;
- separate Promotion App denied from ordinary staging/repair/workflow/environment operations;
- human exact-head promotion-merge/deployment-impact receipt;
- merge-commit preserves audited staging as second parent;
- fake/test automatic CD event occurs only from the develop merge;
- no `workflow_dispatch` call is reachable;
- exact post-promotion reconciliation and expected-head staging fast-forward;
- push-triggered full integration CI on the aligned staging SHA before unfreeze;
- crash injection at every promotion/interlock boundary;
- negative fixtures reject squash/rebase promotion, wrong parents/tree, stale assurance/receipt/base, candidate/repair PR-set mismatch, unknown active deployment impact, missing expected CD run, completed CD without conclusion, Promotion App overreach, manual dispatch and queue unfreeze before aligned-head CI.

No real deployment is triggered during this phase.

## Phase 14 — Another-machine install/recovery

Install pinned releases, authenticate manually, import checkpoint, record takeover, attach, complete fixture mission, staging and assurance simulations, validate rollback/uninstall and independent security/oracle.

## ZOB PR plan

- PR A: durable execution core.
- PR B: operational Story factory/TUI/model/integrations, stacked on A.
- PR C: Blind Review + Staging Merge, disabled and stacked after validated A/B.
- PR D: Final Assurance + Promotion, disabled and stacked after validated C.

Runtime-core and Wheel-pack changes are separate PRs in this repository; the `jointhewheel` application adapter is a separate repository PR with explicit dependency links.

## Blind Review factory rollout

1. schema/fixture review rounds;
2. read-only mock GitHub;
3. dedicated Reviewer App permission tests;
4. legacy evidence adapter fixtures;
5. test-repo PRs at low/medium/high/critical risk;
6. repair/review round and head/base invalidation drills;
7. independent oracle;
8. explicit activation receipt.

No live `fleet:needs-review` consumption before activation.

## Staging/assurance/promotion rollout

1. pure Staging and Promotion Guard tests;
2. App Check/receipt spoof fixtures;
3. expected-head squash/merge-commit fake server plus push-triggered CI observer (no workflow dispatch);
4. crash/freeze/integration/assurance/post-promotion simulations;
5. dedicated test repository with staging excluded from all deployment workflows;
6. top-down/bottom-up inventory fixtures and three-assurance-round/two-repair-transition loop;
7. deployment-impact/automatic-CD event analysis fixture;
8. denied Staging Merge and Promotion App permissions;
9. independent oracle;
10. explicit activation receipts;
11. human-started promotion window and later exact-head promotion-merge authorization.

No JointheWheel branch/ready/merge/CD workflow change during implementation/pilots unless separately authorized.

## Required security/quality checks

As applicable:

- TypeScript/build/lint/unit/integration/property tests;
- CodeScene for changed code;
- Semgrep/Snyk high-severity bounded scans;
- dependency/license/SBOM review;
- secret scan on diff;
- IaC scan;
- TUI accessibility/keyboard/render tests;
- `python3 docs/zob/validation/validate_contracts.py` (meta-schema, every example, cross-contract semantics and negative guards);
- `python3 docs/zob/validation/validate_documentation.py` (frozen scope, links, index, IDs/fields, staging policy, privacy and contract suite);
- Git diff check;
- independent skeptical review/oracle.

## Factory activation gate

Activation is separate from installation and requires:

- all required sentinels/validation artifacts;
- no unresolved no-ship issue;
- exact versions and permissions;
- human activation receipt defining factory/scope/caps/expiry;
- rollback plan;
- fresh oracle PASS/no-ship false.

Ordinary staging merges require no human per-PR receipt after activation. Every final promotion still requires a human-started frozen window and a separate exact-head promotion-merge/deployment-impact authorization. Automatic CD may run only from the resulting develop merge; no manual deployment dispatch is authorized.