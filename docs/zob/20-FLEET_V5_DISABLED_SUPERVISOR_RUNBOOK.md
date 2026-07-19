# 20 — Fleet v5 durable disabled supervisor runbook

- **Truth class:** Current development implementation and validation evidence
- **Evidence snapshot:** 2026-07-20
- **Maturity:** Implemented and locally validated; uncommitted/unreleased; activation disabled
- **Supervisor provider/GitHub status:** Unavailable and unauthorized; separate Pi run/start commands can invoke a provider but are operationally blocked
- **Applies to:** `wheel.zob.fleet-v5-machine-bundle.v1`, including the source-bound PR 3853 W1–W6 bundle

This runbook covers the durable supervisor that exists alongside implemented—but operationally blocked—provider-backed `/wheel-zob run-machine` and selected-machine session commands. The current no-ship boundary is in [`21-FLEET_V5_LOCAL_MACHINE_LAUNCH_AND_PR_HANDOFF.md`](21-FLEET_V5_LOCAL_MACHINE_LAUNCH_AND_PR_HANDOFF.md). This supervisor does **not** activate a live software factory.

## 1. What exists now

The activation-disabled supervisor can:

- validate the complete machine bundle and immutable source/story hashes before machine selection;
- admit all W1–W6 stories, or an explicit machine subset, into one durable mission;
- maintain a SHA-256-chained JSONL journal, atomic checkpoints, ownership leases, and ownership epochs;
- recover journal entries after interruption, reject corrupt/truncated tails, and replay mutation IDs exactly;
- schedule dependencies with bounded parallel-story selection;
- consume protected model-role assignments through disabled or deterministic-fake dispatch adapters;
- exercise development, optional documentation, QA, repair, internal review, formal blind review, repository assurance, CI, three independent PR-close audits, and final PR-close Check/label flows;
- model isolated workspace, branch, draft-PR, Check, comment, and label effects through body-free deterministic fakes;
- bind evidence to the exact current head and invalidate stale evidence after head movement;
- stop at explicit human gates and report downstream dependency blocks;
- validate persisted state without storing prompt bodies, outputs, transcripts, credentials, or secrets.

It cannot:

- call a model provider;
- access a network or credentials;
- create a real worktree, branch, commit, push, PR, Check, comment, or label;
- poll GitHub or CI;
- merge, dispatch workflows, promote, or deploy;
- accept `mode=live` in the controller, even when receipt-shaped metadata is supplied.

The disabled/fake brokers are validation doubles. A simulated PR is not a GitHub PR, a simulated Check is not a GitHub Check, and a completed fake story is not implemented application code.

## 2. Keep the two launch paths distinct

### Provider-backed local implementation handoff — operationally blocked

`/wheel-zob run-machine` validates the whole bundle and can inject one current Pi implementation turn, but it must not be used operationally until the active checkout is atomically bound to the admitted source and later transitions reinspect workspace/branch/HEAD. It can invoke a provider, incur spend, and edit the active checkout.

### Selected-machine isolated local sessions — preparation only

```text
/wheel-zob prepare-local-launch <launch-id> <mission-id> <machine-bundle.json> <machine-id...>
```

Preparation is zero-effect. The implemented `start-local-machine` command is operationally blocked by the same source/workspace gap and can queue a provider-backed turn. PR handoff and Wheel story commit are additionally blocked by the missing machine-to-story bridge and atomic pre-effect authority validation. See document 21.

### Durable activation-disabled supervisor

```text
/wheel-zob supervisor-plan <mission-id> <machine-bundle.json>
/wheel-zob supervisor-init <mission-id> <machine-bundle.json> <state-dir> disabled
/wheel-zob supervisor-run-fake <mission-id> <machine-bundle.json> <state-dir>
/wheel-zob supervisor-status <state-dir>
```

This path persists mission metadata and runs only through disabled or deterministic-fake adapters. It does not edit application source.

Do not describe the disabled/fake supervisor as provider dispatch, live GitHub automation, PR creation, or factory activation. The run/start commands can call the currently selected provider, but they are not operationally authorized.

## 3. Prerequisites

Before running from `jointhewheel`:

1. Pin the exact reviewed ZOB development source or released package.
2. Run Pi/Wheel under Node `22.22.3`.
3. Run application adapter checks under the repository’s exact Node `20.19.0` policy. Node `20.19.6` is useful development evidence but is not exact clean-machine certification.
4. Materialize and drift-check the PR 3853 adapter:

   ```bash
   npm run validate:wheel-zob-fleet-v5-adapter
   ```

5. Confirm the bundle remains bound to the intended source SHA and source-file hashes.
6. Choose a new path-safe mission ID.
7. Choose a state directory under `reports/wheel-zob/supervisor/`. Other roots, traversal, and absolute state paths are rejected.
8. Do not authenticate providers or GitHub for disabled/fake validation.

PR 3853’s current security/merge disposition, `develop-staging`, package release, and clean-machine trust remain separate human gates.

## 4. Plan the complete bundle without writing state

From the application repository root:

```bash
npm run wheel-zob -- \
  supervisor-plan \
  pr3853-full \
  docs/operations/fleet-v5/zob/pr3853-machine-bundle.json
```

Expected safe summary fields include:

- `prepared: true`;
- exact `bundleHash` and `sourceSha`;
- `machineIds: [W1, W2, W3, W4, W5, W6]`;
- `allocationUnitCount: 59`;
- 60 canonical `storyIds`;
- explicit `humanGateStoryIds`;
- every provider/GitHub/commit/push/merge/workflow/deploy flag `false`.

A stale source file, changed story body, duplicate assignment, missing machine, invalid dependency, cycle, unsafe path, or bundle-hash mismatch blocks preparation.

## 5. Initialize durable state with every effect disabled

```bash
npm run wheel-zob -- \
  supervisor-init \
  pr3853-full \
  docs/operations/fleet-v5/zob/pr3853-machine-bundle.json \
  reports/wheel-zob/supervisor/pr3853-full \
  disabled
```

`disabled` mode writes only the admitted journal/checkpoint/ownership metadata. Calling `tick` in this mode does not schedule attempts or submit effects.

Durable files are:

```text
reports/wheel-zob/supervisor/<mission>/journal.jsonl
reports/wheel-zob/supervisor/<mission>/checkpoint.json
reports/wheel-zob/supervisor/<mission>/owner.lock.json
```

The journal is authoritative. A checkpoint accelerates recovery but must match its journal sequence and head hash.

## 6. Run the end-to-end deterministic fake

Use a different state directory from a disabled-only initialization, or initialize directly in deterministic-fake mode:

```bash
npm run wheel-zob -- \
  supervisor-run-fake \
  pr3853-full-fake \
  docs/operations/fleet-v5/zob/pr3853-machine-bundle.json \
  reports/wheel-zob/supervisor/pr3853-full-fake \
  10000
```

The optional final number is the positive tick cap. The fake run:

- uses protected route/provider/family metadata but makes zero provider calls;
- hashes transient prompts and never writes them to the journal/checkpoint;
- simulates workspace/GitHub/CI effects with deterministic IDs;
- records `externalEffectPerformed=false`, `localRepositoryWritePerformed=false`, `networkAccessed=false`, and `credentialsAccessed=false`;
- incurs `settledCostUsd=0`;
- stops at `complete`, `needs-human`, `failed`, `paused`, the tick cap, or a no-progress fail-closed condition.

For the reviewed PR 3853 fixture, human-gated stories remain `needs-human`; their downstream hard/artifact dependents are reported as dependency-blocked. This is correct. The model must not invent receipts merely to turn the summary green.

## 7. Inspect and validate persisted state

```bash
npm run wheel-zob -- \
  supervisor-status \
  reports/wheel-zob/supervisor/pr3853-full-fake

npm run wheel-zob -- \
  supervisor-validate \
  reports/wheel-zob/supervisor/pr3853-full-fake
```

`supervisor-validate` checks journal lineage, unique attempt IDs, zero cost, no pending effects, terminal model-role evidence, exact-head PR-close evidence, trusted fake Check issuers, body-free snapshots, and complete/needs-human disposition accounting. It also fails a `complete` mission that retains any current no-ship reason and emits a body-free evidence capsule with story disposition IDs, current no-ship reasons, journal/projection hashes, checkpoint lineage, and event-kind counts. `supervisor-status`, `supervisor-run-fake`, and `supervisor-resolve-human` expose current no-ship reasons rather than hiding them.

A `needs-human` mission may still validate structurally when every story is either:

- completed at `needs-review`;
- explicitly human-gated; or
- downstream dependency-blocked by those gates.

Structural validity does not resolve the human decision.

## 8. Resolve one fake-run human gate

Only a human may decide that a checkpoint is resolved. The supervisor stores the decision as a full SHA-256 receipt, never as a raw rationale:

```bash
npm run wheel-zob -- \
  supervisor-resolve-human \
  reports/wheel-zob/supervisor/pr3853-full-fake \
  <story-id> \
  <64-character-receipt-sha256>
```

The equivalent Pi command is:

```text
/wheel-zob supervisor-resolve-human <state-dir> <story-id> <receipt-sha256> [owner-id]
```

Then rerun `supervisor-run-fake` with the same mission, bundle, and state directory. The source/authority/check-policy bindings must still match.

A fake-run receipt authorizes only continuation of that deterministic local validation. It is not a live activation receipt, GitHub permission, spend approval, merge approval, or deployment approval.

## 9. Controlled stop

For a foreground fake run:

1. use the current terminal/Pi controlled interrupt;
2. do not kill unrelated processes;
3. wait for command termination;
4. inspect `supervisor-status`;
5. run `supervisor-validate` before resuming.

Each event is appended and fsynced before projection/checkpoint advancement. An interruption after journal append but before checkpoint update is recoverable from the journal tail.

Do not manually edit `journal.jsonl`, `checkpoint.json`, or ownership receipts. Do not truncate a red/corrupt journal to force progress.

## 10. Restart and ownership recovery

Restart with the exact same command, mission ID, bundle, and state directory:

```bash
npm run wheel-zob -- \
  supervisor-run-fake \
  pr3853-full-fake \
  docs/operations/fleet-v5/zob/pr3853-machine-bundle.json \
  reports/wheel-zob/supervisor/pr3853-full-fake
```

On restart the supervisor:

1. revalidates the complete source-bound bundle;
2. verifies the stored authority and check-policy hashes;
3. verifies every journal hash, sequence, and previous-hash link;
4. loads the latest valid checkpoint and replays the journal tail;
5. renews the same owner or takes over only after the prior lease expires;
6. advances the ownership epoch and fences stale writers on takeover;
7. resumes reserved fake attempts with the same deterministic attempt ID;
8. resubmits the same deterministic effect idempotency key after a broker-process interruption;
9. continues only from current persisted state.

A truncated/corrupt journal, conflicting mutation ID, live competing owner, stale ownership epoch, source drift, or authority drift blocks recovery.

## 11. Pause, rollback, and reset posture

The controller API supports a durable mission pause. The current user-facing CLI intentionally does not expose arbitrary rollback or deletion.

- To pause during supervised development, use the controller’s governed `pause(reasonCode)` integration; do not mutate files by hand.
- To resume a paused mission, retain the exact state and source bindings and use a reviewed controller integration.
- To abandon/reset a mission, a human must approve archival/removal of that exact report directory and choose a new mission ID. Do not overwrite an existing state directory with a different bundle or source SHA.
- Workspace and PR rollback references produced by fake mode are metadata-only; they do not restore application files because fake mode never changed them.

## 12. Activation remains deliberately impossible

There is no `supervisor-activate` command. The controller rejects `mode=live` with:

```text
live supervisor activation is not implemented; use disabled or deterministic-fake mode
```

Before live activation can be considered, separate reviewed work must provide and validate:

- real sandbox/worktree ownership and rollback integration;
- provider dispatch with credentials isolation, spend reservation/settlement, expiry, timeouts, and durable idempotency;
- GitHub/CI observation and mutation brokers using least-privilege Apps;
- `develop-staging`, required Checks, branch protection, and non-deploying staging proof;
- outbox/reconciliation behavior against external truth;
- clean-machine package release and exact Node certification;
- one-story and bounded multi-story pilots;
- fresh security and oracle PASS with `no_ship=false`;
- an exact human activation receipt.

Even future factory activation cannot authorize promotion or deployment. Those remain separate exact-head human decisions.

## 13. Historical PR 3853 disabled validation evidence

This evidence used the earlier delimiter-concatenated development bundle digest. That hash format was superseded by collision-safe canonical structured preimage hashing before release. The historical journal still proves the reviewed disabled/fake supervisor execution, but its bundle must be rematerialized and the run repeated before it can serve as current launch intake.

The reviewed deterministic-fake run used:

- bundle: `jointhewheel-pr3853-fleet-v5`;
- bundle hash: `54f98df3fc091a60dcf02abd7052f3077685818b37756e891341f0795dfa9fd8`;
- source SHA: `404ca9196a6f9546440f38f0146fc7951b09d4f0`;
- machines: W1–W6;
- allocation units/stories: 59/60;
- durable events: 3,535;
- completed stories: 43;
- explicit human-gated stories: 14;
- downstream dependency-blocked stories: 3;
- undispositioned stories: 0;
- provider/network/repository/GitHub/deployment effects: 0;
- settled cost: USD 0;
- first process stopped at sequence 1,014; a new process recovered the existing journal/checkpoint and settled at sequence 3,535 without duplicate attempt IDs;
- ownership-epoch expiry/takeover fencing: separately covered by `test/wheel-zob-pack/supervisor-store.test.ts` (the full-run restart renewed the same epoch);
- persisted-state validator: PASS.

See the aggregate [`disabled-factory-validation.json`](../../reports/wheel-zob/pr3853-supervisor/disabled-factory-validation.json), the exact body-free [`persisted-state-validation.json`](../../reports/wheel-zob/pr3853-supervisor/persisted-state-validation.json), and the hash-bound [`recovery-receipt.json`](../../reports/wheel-zob/pr3853-supervisor/recovery-receipt.json). This evidence proves the disabled/fake control plane, not application implementation or live factory readiness.
