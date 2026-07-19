# 07 — Persistence and Recovery

**Truth class:** Approved design

## Runtime layout

```text
<runtime-root>/missions/<mission-id>/
  mission.sqlite
  events.jsonl
  snapshots/
  transcripts/<attempt-id>/
  locks/
  exports/
  quarantine/
```

SQLite is the transactional projection/query/outbox store. The hash-chained JSONL journal is the append-only audit/rebuild source. Snapshots reduce replay cost.

## Event append protocol

Under an exclusive mission ownership lock:

1. validate typed event and body policy;
2. allocate next sequence;
3. compute previous/current hashes;
4. append and `fsync` journal;
5. apply idempotently in one SQLite transaction:
   - insert event;
   - update projections/budgets/leases;
   - enqueue external effects;
6. perform effects only after commit.

Crash after journal append but before SQLite commit is repaired by replay. Event/idempotency keys prevent duplicate application.

## Event envelope

See [`schemas/mission-event.schema.json`](schemas/mission-event.schema.json). Core fields include event/mission/sequence/time, producer, type, story/gate/task/attempt correlation, causation, idempotency key, body-safe payload, previous hash and event hash.

## Primary projections

- missions/stories/gates/tasks;
- attempts/agent runs;
- model/prompt assignments;
- workspaces/leases/merge candidates;
- human cards/ACK receipts;
- PRs/comments/labels/checks/CI;
- evidence/alerts;
- inbox/outbox;
- policies/snapshots/checkpoint watermarks.

Each row records last applied event sequence and revision.

## Background service

`zobd`:

- survives initiating Pi/TUI closure;
- auto-restarts on the same machine;
- exposes a filesystem-permissioned Unix socket, not a network listener;
- runs no idle LLM;
- supports several missions with one owner lease each;
- pauses dispatch while keeping truth watchers active;
- checkpoints before controlled stop.

## Watchers

Version one uses:

- immediate local process/session streams;
- filesystem/worktree observation;
- adaptive GraphQL polling for PRs, checks, reviews, labels and comments;
- needs-human/state-branch polling;
- timers/budget/lease watchdogs.

GitHub polling batches PRs, uses cursors/conditional data where available, honors rate limits and uses latest-review queries rather than full REST comment pagination. Optional webhooks are an enhancement; polling remains reconciliation fallback.

## Shared checkpoints

`zob-mission-state` stores body-safe milestone snapshots at:

```text
missions/<mission-id>/
  manifest.json
  latest.json
  checkpoints/<sequence>-<hash>.json
  receipts/
  indexes/
```

Triggers:

- mission start;
- meaningful periodic change;
- gate closure/reopen;
- human wait/answer;
- accepted PR head change;
- PR-close/review/staging-integration/assurance/promotion milestone;
- clean shutdown/completion;
- authenticated cross-machine takeover.

These map to checkpoint `reason` tokens `mission-start`, `periodic-change`, `gate-transition`, `human-wait|human-answer`, `pr-head`, `factory-milestone`, `shutdown|completion` and `takeover`. A promotion freeze/candidate revision/round/authorization/merge/aligned-head-CI event is a `factory-milestone` with exact initial/current staging, prior-candidate, finding/repair and develop correlation in the body-safe payload.

Pushes use expected-remote-head protection. Conflict pauses synchronization; it never overwrites remote state.

## Same-machine recovery

1. acquire lock;
2. verify journal chain/schema;
3. load snapshot and replay tail;
4. rebuild/catch up SQLite;
5. reconcile active runs with process/session registry;
6. reattach genuinely live streams;
7. inspect exited runs for valid final markers/artifacts;
8. mark missing processes lost;
9. reconcile worktrees/leases/branches;
10. reconcile GitHub/CI/cards/receipts;
11. publish recovery report;
12. resume idempotently.

A completion discovered after crash is validated—not automatically accepted or discarded.

## Cross-machine takeover

Automatic same-machine resume is allowed. Another machine requires an authenticated takeover receipt plus a fencing transition on the shared mission checkpoint: the prior owner lease must be expired/revoked or the prior owner must have recorded release, and the new owner must commit the next ownership epoch with expected-remote-head protection before any dispatch/effect. If ownership cannot be proved exclusive, takeover remains blocked.

Takeover:

- imports latest checkpoint and protected routing state;
- clones/reconciles story branches;
- marks former machine-local live runs orphaned;
- recovers source-bound candidates when evidence is sufficient;
- launches fresh attempts otherwise;
- records takeover before dispatch.

Encrypted transcripts are non-portable unless explicitly exported through a future gated mechanism.

## Integrity failures

- SQLite corruption with valid journal: rebuild automatically.
- Journal corruption: preserve verified prefix, copy invalid tail unchanged to quarantine, set `recovery-blocked`, create needs-human and stop dispatch/GitHub mutation.
- No silent truncation, rollback or continuation past an invalid chain.

## Encrypted transcripts

Each attempt has:

```text
transcripts/<attempt-id>/
  envelope.json
  stream.enc
  index.json
```

- OS keychain mission master key;
- unique wrapped per-attempt data key;
- independently authenticated chunks/nonces;
- chunk sequence/hash chain;
- stdout/stderr/tool/live-output tags;
- redaction before encryption;
- replay/export/delete auditing;
- normal completion writes an authenticated final chunk/index seal before the attempt can become evidence-complete;
- crash recovery verifies every committed chunk, marks an unsealed tail as `partial`, and never presents a partial transcript as complete; a reattached live process may continue only from its verified next sequence.

No prompt/output body enters SQLite, normal journal, Git or PR evidence.

Default retention: until manual cryptographic deletion. Disk warning and hard-stop thresholds apply; ZOB never auto-deletes. At hard threshold, new dispatch pauses and needs-human is created.

Keychain initialization failure blocks admission instead of writing plaintext.

## Dispatch recovery invariant

```text
task ready
  → attempt dispatch-reserved
  --preflight-passed/process-started event→ launching
  --agent-acknowledged event→ running
  → claim-returned → validating → needs-review
  → accepted | rejected | blocked | failed | lost | cancelled | superseded
```

Preflight, process-started and agent-acknowledged are transition events, matching the canonical UI vocabulary in section 06. Preflight failure releases reservation and returns the task to retry/ready. Spawn without ACK remains `launching` until recovery timeout. Only acknowledged `running` attempts consume active execution capacity; rejected attempts may return their task to ready under budget.