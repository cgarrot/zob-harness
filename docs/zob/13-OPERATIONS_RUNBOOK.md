# 13 — Operations Runbook

**Truth class:** Approved operational specification
**CLI examples:** Proposed interface, not evidence of implemented commands

## Daily operating loop

The deterministic supervisor continuously:

```text
RECONCILE → POLL → TRIAGE → RESERVE → DISPATCH
→ VALIDATE/ACCEPT → CHECKPOINT → CONTINUE
```

Models perform bounded work/judgment; they do not own the loop.

## Proposed operator commands

```text
wheel-zob service status|start|stop
wheel-zob mission admit <bundle-or-manifest>
wheel-zob mission list|status|attach <mission-id>
wheel-zob mission pause|resume|stop <mission-id>
wheel-zob mission export <mission-id>
wheel-zob staging status
wheel-zob promotion propose|status
wheel-zob doctor
```

High-risk operations remain TUI/receipt gated. No arbitrary shell passthrough.

## Starting a Story mission

1. Verify Story factory activation and policy lock.
2. Select one/many approved bundles.
3. Preview repository, mandatory ordinary PR base `develop-staging`, profiles/overlays, dependencies, budgets, model/prompt policy and deferred actions.
4. Resolve genuine admission questions.
5. Record mission authorization.
6. Admit; verify bootstrap branch/commit/draft PR per story.
7. Attach Mission Control and confirm watcher freshness.

## Normal monitoring

The operator watches exceptions, not every token:

- supervisor/process freshness;
- accepted progress and critical path;
- Needs You;
- stale/lost attempts;
- workspace conflicts/dirty state;
- ordinary PR, staging integration, promotion and automatic-CD run state;
- staging window, initial/current candidate revision+SHA, authorized repair lineage, staged cohort and assurance round;
- model/provider budget/health;
- transcript disk growth;
- checkpoint sync to `zob-mission-state` and protected model/prompt telemetry sync to `zob-model-telemetry`.

Live output remains available for the selected agent at all times.

## Pause/resume

Pause:

- stops new dispatch;
- preserves running-attempt policy (finish or controlled stop per reason);
- continues source/GitHub/human watchers;
- writes checkpoint.

Same-machine resume reconciles automatically. Cross-machine resume requires takeover receipt.

## Needs-human

For each card:

1. inspect exact question, proposed answer, affected tasks and consequences;
2. answer through an authenticated supported source;
3. verify receipt scope/expiry;
4. conflicting answer creates conflict card;
5. supervisor starts a fresh attempt after durable handoff pickup.

Do not answer high-risk receipts through generic batch controls.

## Provider/model incidents

- Provider transient: bounded backoff/same-level retry; no quality penalty.
- Provider unavailable: cooldown/skip; wait or needs-human after policy SLA.
- Planned/actual mismatch or clamp: quarantine route and invalidate benchmark result.
- Context overflow: provider-specific recognized recovery; no thinking penalty unless quality failure follows.
- All eligible routes unavailable/exhausted: needs-human.

Never print auth or provider response bodies while diagnosing.

## Agent/run incidents

- `launching` without ACK: timeout/reconcile, not running.
- Missing process: mark lost, inspect artifacts, retry if unfinished.
- Completed marker without evidence: claim returned but unaccepted.
- Stale heartbeat/activity/progress: display separately and follow watchdog policy.
- Contract violation/out-of-scope write: stop attempt, quarantine workspace, review diff, revoke grant.

## Workspace incidents

- Lease conflict: no parallel write; owner request or reschedule.
- Dirty canonical worktree: stop integration, identify ownership, never clean/reset blindly.
- Sandbox candidate fails: reject with evidence; source branch unchanged.
- Base/head drift: reconcile before commit/push/review.
- Stack dependency changes: downstream story/task invalidation through DAG.

## CI incidents

- Expected draft/ready checks are profile/version driven.
- One known-flake rerun only on matching log signature.
- Real failure creates repair task/factory handoff.
- Missing/cancelled/superseded remains explicit unknown/blocker.
- Any source fix invalidates close/review/staging/assurance/promotion evidence as required.

## Review incidents

- New head cancels current round.
- Validated finding returns to Story repair.
- Contested finding receives fresh evidence/adjudication; bounded disagreement then needs-human.
- Three automatic repair rounds maximum.
- No reviewer edits source.

## Staging, assurance and promotion incidents

All three factories are disabled until their separate activation gates pass.

When active:

- failed ordinary pre-ready/PR CI: repair/re-close/re-review;
- staging merge crash: inspect only the exact targeted PR/head before any retry;
- red/unknown full staging integration CI: block unrelated staging merges and let only an exact failure/head-bound, fully reviewed repair PR use the red-interlock exception; never destructive-reset automatically;
- authorized round-1/2 repair merge: increment candidate revision, retain window lineage, stale prior assurance, run full staging CI and then a completely fresh assurance round;
- unrelated staging movement, develop movement or candidate/repair lineage gap during a window: invalidate the window/assurance/receipts and block;
- assurance finding in round 3: needs-human immediately; no automatic repair that would require round 4 and no partial promotion;
- stale promotion-window receipt: abandon/freeze until a new window is explicitly started;
- stale promotion-merge receipt: invalidate it and request a new exact-head receipt after revalidation;
- promotion merge failure: no retry until PR/head/base/assurance/receipt cause is reconciled;
- post-promotion reconciliation pending: keep staging frozen and perform no other promotion;
- staging fast-forward/alignment failure or aligned-head integration CI failure: keep frozen, preserve both exact SHAs and needs-human if safe expected-head recovery is unclear; the queue stays frozen until a current aligned-head Staging Integration Check passes;
- automatic CD run failure after develop promotion: alert/downstream deployment-confirmation/recovery factory; do not retrigger manually.

## Persistence incidents

- SQLite invalid, journal valid: rebuild.
- Journal hash/schema invalid: quarantine tail, block and ask human.
- State branch (`zob-mission-state`) push conflict: pause checkpoint sync and reconcile expected head; telemetry branch (`zob-model-telemetry`) conflicts independently pause protected telemetry sync.
- Keychain unavailable: block transcript-enabled admission.
- Disk warning: alert; hard threshold pauses dispatch, never auto-deletes.

## Controlled stop

1. stop new dispatch;
2. reconcile active attempts;
3. release safe leases;
4. flush journal/SQLite/outbox/transcripts;
5. write local/shared checkpoint;
6. report retained dirty workspaces/pending effects;
7. stop service only when state proves safe.

Force stop requires typed reason and records potentially orphaned work.

## Completion and handoffs

- Story mission complete → `fleet:needs-review`/Blind Review queue.
- Blind Review clean → automatic Staging Merge queue (still disabled unless activated).
- Staging integration green → `staged-awaiting-promotion`.
- Human-started frozen cohort → Final Repository Assurance.
- Assurance clean + promotion CI + exact human receipt → Promotion App merge-commit into `develop`.
- Develop promotion merge → automatic CD plus exact-input Post-Promotion Reconciliation/staging alignment.
- Deployment confirmation is a separate future factory; no manual dispatch.

No factory claims the next factory’s outcome.