# 05 — Staging Merge Factory (S1 Successor for Ordinary PRs)

**Truth class:** Approved design
**Maturity / activation:** Specified only; disabled; no Staging Merge App credentials or activation receipt

## Mission boundary

**Input:** `blind-review-clean` ordinary PR targeting `develop-staging`, with current App-authored close/review Checks and required PR CI.
**Output:** automatic expected-head squash merge into non-deploying `develop-staging`, followed by exact-head full staging integration CI.
**Never:** source repair, close/review evidence authorship, merge to `develop`/`main`, manual deployment trigger, deployment-success claim or protection bypass.

The former `/pr-ship` semantic lifecycle splits:

- this factory owns ordinary PR ready/merge into staging;
- section 17 owns the human-started audited promotion into `develop`.

## Existing S1 behavior being evolved

**Truth class for this subsection:** Current evidence at the source refs/SHA captured in `SOURCE_EVIDENCE.md`.

Strengths preserved:

- live global queue reconciliation;
- mark-ready and post-ready phases;
- one merge at a time;
- `merge_in_flight` crash interlock;
- immediate pending-merge persistence;
- re-poll after every merge because base truth changed.

Weaknesses removed:

- direct ordinary merge into deployment-capable `develop`;
- bare label/title authority;
- broad `human-override` bypass;
- ship-authored stale PR-close refresh;
- S1 selecting/reusing builder models for fixes;
- unsafe direct merge/override behavior from queue helpers.

## Service identity

A dedicated Staging Merge GitHub App may:

- read PR metadata, contents, checks and reviews;
- mark qualifying ordinary PRs ready;
- publish staging Checks/comments;
- expected-head squash-merge only when base is `develop-staging`.

It may not write/merge `develop` or `main`, repair branches, dispatch workflows, access environments/secrets, administer protection or bypass rules. It only observes/correlates push-triggered CI. It is distinct from the dormant Promotion App.

## State machine

```text
pre-ready-reconcile
→ repair-required | review-invalid | mark-ready
→ post-ready-pr-ci
→ staging-merge-ready
→ staging-merge-in-flight
→ staging-integration-ci
→ staged-awaiting-promotion
```

A promotion freeze adds `promotion-window-frozen`; a red integration adds `staging-red-interlock`. Queued unrelated PRs can continue building/reviewing but cannot enter `staging-merge-in-flight`. The only narrow exceptions are an exact failure-bound repair PR for the red interlock or a finding-bound repair PR authorized by the active promotion window/candidate revision.

## Pre-ready reconciliation

Require:

- base branch exactly `develop-staging`;
- current exact-head `ZOB / PR Close` from Builder App;
- current exact-head `ZOB / Blind Review` from Reviewer App;
- compatible profile/schema/policy versions;
- valid scoped human/process receipts;
- no blocking review decision/question;
- expected draft checks acceptable;
- clean mergeability/current-base collision proof;
- available staging integration budget;
- no promotion freeze/staging-red interlock, unless a typed repair contract binds the exact interlock, failure/finding IDs and expected staging head; the exception never bypasses any other gate.

A shared pure guard evaluator runs in preview mode while draft and in the actual GitHub workflow after ready.

Eligible drafts are marked ready automatically when the complete pre-ready policy and CI-budget conditions pass. Ready is not merge evidence; the factory still waits for every expected post-ready PR check and revalidates exact head/base.

## PR CI

Every expected PR/ready check for the effective profile must be terminal/acceptable. Known ledgered flakes may rerun once only when the current signature matches. Source/CI/config/mergeability failures return the PR to Story repair, then PR-close and Blind Review rerun.

Missing, cancelled, superseded or unknown checks are blockers. No human per-PR merge receipt is required for staging, because staging has no deployment path and cannot promote itself.

## Automatic staging merge

The queue orders dependency topology first, then repair urgency, risk and age. One merge is in flight.

1. Persist exact PR/head/base/Check hashes and `staging-merge-in-flight`.
2. Issue one expected-head squash merge through Staging Merge App.
3. On success, immediately record staging merge SHA and included story/PR lineage.
4. On restart, inspect only the targeted PR/branch to resolve ambiguity.
5. Correlate the automatically push-triggered full staging integration CI profile on the exact new staging SHA; the App never calls workflow dispatch.
6. Publish `ZOB / Staging Integration` only after every expected check is terminal/acceptable.
7. Reconcile story/dependency/kanban state to `staged-awaiting-promotion`.
8. Permit the next unrelated staging merge only when the head is green and not frozen; otherwise admit only the current typed repair exception.

No parallel staging merges occur before the prior merged head’s integration result is known.

## Staging integration failure

A failed/unknown staging integration:

- freezes new staging merges;
- preserves exact merged head and failure evidence;
- attributes the failure where evidence permits;
- routes source/config/test repair through a new ordinary PR targeting staging with the exact failure/interlock/head contract;
- requires PR-close, Blind Review and PR CI for that repair;
- lets only that repair use the red-interlock merge exception;
- reruns push-triggered full staging integration after repair merge.

There is no automatic destructive reset/revert. If attribution or safe repair is unclear, create needs-human. No staging state can deploy while red or green.

## Stacks and dependencies

Stacked story PRs follow explicit parent branches until ready for staging. Retargeting/merge order is supervisor-owned. After each parent staging merge, downstream PRs reconcile against the new staging head and invalidate affected evidence before they can merge.

## Canonical Checks

```text
ZOB / PR Close             Builder App
ZOB / Blind Review         Reviewer App
ZOB / Human Gates          Supervisor projection
ZOB / Staging Merge Gate   Staging Merge App
ZOB / Staging Integration  Staging Merge App
```

Labels/comments project state only. `blind-review-clean` or `staged` labels cannot replace Checks.

## Handoff to assurance/promotion

A green staging head accumulates accepted PRs as `staged-awaiting-promotion`. It does not imply develop readiness, repository assurance, merge authorization, deployment or live proof.

Only a human-started promotion window in [`17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md`](17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md) can freeze staging and begin final assurance. That factory owns the exact-head audit/repair loop, promotion PR, human authorization, merge-commit into `develop`, automatic-CD handoff and post-promotion reconciliation.

## Disabled-by-default gate

```text
factory.stagingMerge.enabled = false
stagingMergeApp.credentials = absent
activationReceipt = none
developStaging.deploymentsEnabled = false
```

Activation requires protected `develop-staging`, proof that every deployment workflow excludes it, full CI/test-repo simulations, source/check/receipt issuer migration, denied-permission tests, independent oracle PASS/no-ship false and explicit human activation. No ordinary PR may target staging until this migration is complete.