# 08 — Permissions, ACKs and GitHub Apps

**Truth class:** Approved design

## Authority model

Role defaults establish the maximum capability class. Every attempt receives a narrower task-scoped grant. No worker gets repository-wide GitHub or filesystem write authority.

Agents return typed requests; the deterministic supervisor validates and executes permitted effects.

## Role boundaries

### Supervisor

May schedule, persist events, reconcile truth, validate typed requests, manage leases, call approved adapters and project authorized GitHub state. Cannot change product scope, fabricate receipts, weaken completion, bypass protection or deploy.

### Orchestrator model

May propose technical DAG/splits/retries, classify blockers and synthesize bounded plans. Cannot choose model identities, grant permissions, accept work, mutate GitHub or alter human decisions.

### Developer

May read approved context and write owned/sandbox paths; run approved commands. Cannot commit/push, accept itself, access telemetry/credentials, modify manifest, call GitHub or contact peers outside the parent-visible protocol.

### QA/documentation/reviewer

Receive role-specific read/write/command scopes. Formal Blind Review and final repository-assurance lanes are source-read/report-only. Assurance repair workers are fresh builder-role agents on separate repair PRs and cannot accept their own work.

### Integration owner

Parent-controlled role that validates merge candidates, creates scoped commits and pushes feature/stack branches. No ready/merge/deploy.

### PR-close auditors

Read-only exact-head inspection. Cannot repair or publish their own verdict except through supervisor evidence projection.

### Human

Sole authority for product/trust/destructive/spend/override/takeover/activation, starting/abandoning a promotion window, exact-head develop-promotion authorization and deployment-impact receipts.

## Capability grant

An attempt grant records:

- role-policy version;
- allowed repository/source roots;
- read/write path patterns;
- approved command/tool/adapters;
- GitHub request types (normally none);
- network policy;
- denied capability classes;
- expiry and attempt binding.

Expansion requires a typed request. Technical path additions within the attempt’s role maximum and parent-owned story scope may be approved by the supervisor; scope/trust/external authority goes to needs-human. Approval creates a new immutable grant revision/event with exact added capability, reason, approver, attempt binding and expiry. The old grant is superseded, not edited; no requested operation runs until the worker receives/acknowledges the new revision. Denied or expired expansion leaves the prior grant unchanged.

## GitHub mutation broker

Agents cannot call `gh` or inspect App credentials/process/session metadata. They submit typed requests such as:

```text
create-draft-pr
push-accepted-commit
post-check
post-review
project-label
mark-ready-for-staging
squash-merge-to-staging
start-staging-integration-check
post-assurance-check
merge-commit-audited-promotion
fast-forward-staging-after-promotion
```

The broker verifies factory, role, receipt/evidence, expected head, policy, idempotency and App identity before effect. Every response becomes an event and external observation.

## GitHub Apps

### Builder App

- feature branch contents write;
- PR/check/comment/approved lifecycle-label write;
- checks/actions read;
- no ready/merge/workflow/deploy/admin.

### Reviewer App

- contents/diff/check/review read;
- formal review/comment/check/approved review-label write;
- no source write/ready/merge/workflow/deploy/admin.

### Staging Merge App

- metadata/contents/check/review read;
- ready, Staging Merge/Integration Check/comment and expected-head squash merge write only when the base is `develop-staging`;
- during a red interlock, merge only the exact failure-bound repair PR; during a promotion freeze, merge only finding-bound repair PRs authorized by the active window/candidate revision;
- no write/merge to `develop`/`main`, no repair push/workflow-dispatch/deploy/environment/secret/admin bypass; CI is push-triggered and observed.

### Promotion App

- dormant except an active human-started promotion window;
- metadata/contents/check/review/receipt read;
- Promotion Authorization/Gate Check write;
- expected-head merge-commit only for the typed `develop-staging`→`develop` promotion PR;
- expected-head fast-forward of `develop-staging` only to the successful promotion merge SHA after reconciliation;
- no source repair/workflow dispatch/environment/secret/admin bypass.

Separate identities prevent the continuously running staging merger from holding credentials capable of merging `develop` and create clear audit trails.

## Human ACK receipts

A canonical receipt binds:

- receipt/ACK type;
- authenticated actor/source;
- repository, PR/story and exact head or process-diff hash;
- scope/rule IDs;
- reason/answer;
- timestamp/expiry/revocation;
- schema/policy versions;
- receipt hash and correlation.

Examples:

- process-change ACK;
- trust/destructive/spend decision;
- human override of specific overridable rules;
- cross-machine takeover;
- factory activation;
- human-started promotion window/freeze (`ackType: promotion-window`);
- exact-head audited develop promotion (`ackType: promotion-merge`);
- deployment-impact acknowledgement.

The legacy `merge-batch` ACK remains parseable only for read-only historical/non-Wheel migration. The Wheel adapter rejects it—and legacy `pr-ship`, `post-merge`, `ship-gate` or `ship-app` authority—for every newly admitted mission, profile, Check or mutation request. No legacy artifact can authorize an ordinary staging merge or develop promotion.

For ordinary question cards, the first valid answer is authoritative and a conflicting later answer creates a conflict card. An authorized revocation/supersession is a new append-only receipt linked by `supersedesReceiptId`; it may cancel an unconsumed future action and invalidates dependent projections/evidence. It never erases the original receipt or reverses an already performed irreversible action. Expired/revoked receipts are removed from current label/Check projections; if an irreversible effect already occurred, the supervisor creates a remediation/incident card instead of pretending revocation undid it.

## Labels are projections

The supervisor may add/remove lifecycle labels only from current receipts/evidence. Bare/manual labels do not satisfy gates.

- `process-change-ack` requires a current process-diff receipt.
- `human-override` waives only named overridable rules; it never bypasses the entire guard.
- `blind-review-clean` requires a current Reviewer-App Check.
- `fleet:needs-review/findings/needs-fixer` project factory state.

## Batch rules

Low-risk independent Needs You answers may be selected together; each produces a separate receipt.

The following never use generic batch response:

- process/trust/destructive ACK;
- override;
- takeover;
- activation;
- promotion-window start/abandon;
- promotion-merge authorization;
- deployment-impact acknowledgement.

Ordinary staging merges have no human batch form. Promotion-window and promotion-merge are separate purpose-built forms: the first freezes unrelated merges and binds initial→authorized-repair candidate lineage; the second authorizes one final exact audited merge-commit into `develop`.

## Communication

Goal Room/mission timeline is canonical parent-visible coordination. Optional live delivery is transient. Hidden worker-to-worker free chat and direct peer-owned writes are prohibited. Owner-change requests are body-safe, path-scoped and parent-visible.

## Denied-by-design operations

No agent/factory can:

- read secrets or auth files;
- directly push protected branches outside the two typed broker operations (ordinary staging squash merge; post-promotion expected-head staging alignment);
- merge outside the Staging Merge or Promotion broker with the correct App/base/method/evidence;
- trigger deployment workflows;
- alter branch protection;
- use admin/bypass/force flags;
- silently lower risk/profile/review requirements;
- treat ACK label presence as human intent.