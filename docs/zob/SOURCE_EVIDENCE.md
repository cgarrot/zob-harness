# Source Evidence and Current-State Baseline

**Truth class:** Current evidence references plus explicit limitations
**Captured:** 2026-07-18

This file distinguishes evidence inspected during design from future capability specified in this corpus.

## ZOB execution-observability source

Repository/worktree inspected:

```text
zob-harness worktree: execution-observability
branch: feature/execution-observability-v016
base/current origin/main at design time: 657f470b3a5fcdb594fa1e746f58e186383567d4
```

Evidence:

- `zob-harness:reports/execution-observability/KICKOFF.md`
- `zob-harness:reports/execution-observability/IMPLEMENTATION.md`
- `zob-harness:reports/execution-observability/REVIEW_2.md`
- `zob-harness:.pi/extensions/zob-harness/src/runtime/agent-activity.ts`
- goal/TODO, recovery, evidence, workspace, model-compliance and worktree modules listed in the implementation report.

Observed baseline: useful source-bound evidence/activity/recovery/workspace components exist; there is no unified transactional mission scheduler, event sequence, durable dispatch reservation, daemon or encrypted transcript store. The worktree had uncommitted changes and must be preserved/revalidated before PR claims.

## Wheel worker/reviewer/ship source

- `jointhewheel:AGENTS.md`
- `jointhewheel:.pi/skills/orchestrator/SKILL.md`
- `jointhewheel:.pi/skills/orchestrator/OPERATING_PROTOCOL.md`
- `jointhewheel:.pi/skills/orchestrator/POLL_LOOP.md`
- `jointhewheel:.pi/skills/orchestrator/MERGE_READY_LOOP.md`
- `jointhewheel:.pi/skills/review-all/SKILL.md`
- `jointhewheel:.pi/agents/fresh-reviewer.md`
- `jointhewheel:.pi/skills/pr-close/SKILL.md`
- `jointhewheel:.pi/skills/pr-ship/SKILL.md`
- `jointhewheel:.pi/skills/merged/SKILL.md`
- `jointhewheel:scripts/ci/ready-guard.mjs`
- `jointhewheel:.github/workflows/ready-guard.yml`
- `jointhewheel:scripts/model-bakeoff/routing/allocation-plan.json`
- `jointhewheel:scripts/model-bakeoff/tools/analyze-results.ts`

Observed R baseline: static R→W coverage, story-model review at medium thinking, `/review-all`, SHA-bound comment/labels and coarse findings telemetry.

Observed S baseline: live queue, ready/post-ready phases, one-at-a-time merge, `merge_in_flight`/`pending_merged` interlock and mandatory `/merged`.

Observed Ready Guard baseline: bare-label authority, branch/body-pattern gating, early human override, title-only post-merge exemption and process ACK label. These are current facts being replaced, not desired behavior.

### Live skill inventory snapshot

Direct filesystem enumeration on 2026-07-18 found:

```text
jointhewheel/.pi/skills/*/SKILL.md                     188
jointhewheel/.pi/skills/_shared/*.md                  34
installed zob-harness/.pi/skills/*/SKILL.md           25
exact Wheel↔ZOB skill-name collisions                  0
```

The generic/parameterized/application-specific migration partition is intentionally not asserted as a fixed count until the implementation inventory classifies all current files.

## Fleet v5 story signals

PR #3853 source inspected at head:

```text
404ca9196a6f9546440f38f0146fc7951b09d4f0
scripts/model-bakeoff/routing/story-signals-v5.json
```

Observed: 60 stories and 17 signal fields preserved in the execution-profile design. Labels are explicitly inputs, not model decisions.

## Staging/promotion current state

GraphQL branch inspection on 2026-07-18 returned:

```text
jointhewheel default branch: develop @ 71a75ada0c8cf9324c6ff7fd11275e505b51e9dc
refs/heads/develop:          71a75ada0c8cf9324c6ff7fd11275e505b51e9dc
refs/heads/develop-staging:  absent
```

Current `jointhewheel:AGENTS.md` also directs ordinary PRs to `develop`. Therefore mandatory `develop-staging`, staging-only Apps, assurance, promotion rules and automatic-CD handoff in sections 05/17 are **Approved design / Specified only**, not Current evidence. This corpus must never imply the branch or automation exists until implementation, validation, installation and activation evidence supersedes this record.

## Model/prompt lab

- `jointhewheel:scripts/model-bakeoff/README.md`
- `jointhewheel:scripts/model-bakeoff/ARCHITECTURE.md`
- `jointhewheel:scripts/model-bakeoff/registry/task-types.json`
- `jointhewheel:scripts/model-bakeoff/knowledge/analysis.json`
- `jointhewheel:scripts/model-bakeoff/guides/models/*.md`
- `jointhewheel:scripts/model-bakeoff/guides/combos.md`
- `jointhewheel:scripts/model-bakeoff/gates-bakeoff.ts`
- `jointhewheel:scripts/model-bakeoff/fleet-bakeoff.ts`

Observed: model/task prompt-shape features, best/worst prompt guidance and per-model gates prompt modes exist. `fleet-bakeoff` declares `uniform|optimized|both` but currently rejects optimized/both as unimplemented.

## Fireconnect/OpenAI capability audit (2026-07-18)

- `zob-harness:reports/fireconnect-capability-tests/MATRIX.md`
- `zob-harness:reports/fireconnect-capability-tests/results.json`
- `zob-harness:reports/fireconnect-capability-tests/results_v2.json`
- `zob-harness:reports/fireconnect-capability-tests/fw_test.py`
- `zob-harness:reports/fireconnect-capability-tests/fw_test2.py`

Observed: 20 routes tested (17 Fireworks via Fireconnect + 3 OpenAI Codex), 297 calls, $0.13 metered spend against $5 cap. All randomized pools are evidence-backed from real inference. Two thinking formats identified (`reasoning_effort` enum, `budget_tokens`); qwen rejects `developer` role; GLM/qwen thinking budgets are advisory at fixture scope.

## Repository assurance functionality (PR #3817)

GraphQL source inspection at open draft head:

```text
PR: Join-The-Wheel/jointhewheel#3817
state: OPEN / draft
head: 02af54029423310cbc4ed1cd70153ab611b766df
base: develop
```

Relevant source:

- `jointhewheel:.pi/skills/full-review/SKILL.md`
- `jointhewheel:.pi/skills/full-review/CANONICAL_DOCS_AUDIT.md`
- `jointhewheel:.pi/skills/full-review/REVIEW_LANES.md`
- supporting baseline/fingerprint/doc-link/report/quality-closure scripts listed by that skill.

Observed: frozen audit SHA, current-head delta reconciliation, ten independent lanes, exact canonical-document manifest/assignment proof, per-document verdict ledger, source-backed doc reconciliation, broad QA/quality closure and completion gating. This is the evidence base for proposed `ZOB-ENH-032`; because the PR is still an open draft, it is not current merged behavior.

## Pi capabilities

Read fully during design:

- Pi `docs/tui.md` — persistent widgets, overlays, keyboard and responsive rendering.
- Pi `docs/models.md` — custom model config and `thinkingLevelMap` (`off|minimal|low|medium|high|xhigh|max`).
- Pi `docs/custom-provider.md` — provider/OAuth/streaming registration and testing.
- Pi `docs/packages.md` — pinned npm/git/local packages and project settings.

## Consolidated ZOB repository placement

After the first documentation audit passed, the human owner explicitly selected **Consolidate everything in ZOB**. The durable target is now:

```text
zob-harness worktree: wheel-zob-system-docs
branch: docs/wheel-zob-system
base/current origin/main at consolidation start: 657f470b3a5fcdb594fa1e746f58e186383567d4
canonical suite path: docs/zob/
```

The clean consolidation worktree is separate from `feature/execution-observability-v016`; the latter's 22 modified and 10 untracked paths were not reset, rebased, checked out or overwritten. The pre-consolidation round-2 manifest and oracle reports under `docs/zob/reviews/staging-design-2026-07-18/` remain immutable historical evidence for the authored content at its old repository boundary. They do not validate the new root files, ownership decision, terminal manual or regenerated consolidated manifest.

## Original docs-tools authoring baseline — superseded placement

Original fresh clone:

```text
Join-The-Wheel/jointhewheel-docs-tools
base branch: main
base commit at documentation start: 443af1b
```

Root areas before the suite were `investors/`, `needs-human/` and `superseded/`. There was no root `AGENTS.md`, Pi package manifest, ZOB docs, mission-state branch implementation or model-telemetry branch implementation in the inspected main checkout. That clone remains a preserved authoring/migration copy pending separately authorized cleanup; it is no longer the canonical ZOB location.

The old sibling `jointhewheel-doc-archive` checkout remained pointed at the old archive remote and 24 commits ahead; it was not reset or repurposed.

## Design-only statements

Everything labeled Approved design—daemon, SQLite/journal protocol, Apps, Checks, factories, schemas, package release, branches, TUI, model/prompt routing—is not current implementation evidence. Implementation and activation require [`14-VALIDATION_AND_PILOTS.md`](14-VALIDATION_AND_PILOTS.md).