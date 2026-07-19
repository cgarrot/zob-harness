# 21 — Fleet v5 selected-machine local launch and exact PR handoff

- **Truth class:** Current development implementation plus corrected no-ship boundary
- **Evidence snapshot:** 2026-07-20
- **Maturity:** Contracts and local tests exist; uncommitted/unreleased; operational selected-machine rollout is blocked
- **Local session status:** Plan/validate is zero-effect; real `start-local-machine` use is blocked until initial source equality and later control-workspace reinspection are enforced in code
- **Commit status:** Unavailable: the machine-to-story bridge is missing and `zob_zcommit_run` does not atomically validate Wheel authority before mutation
- **Push/GitHub/CI/PR-close status:** Unavailable; contract artifacts have no activated effect consumer
- **Merge/promotion/deployment status:** Always prohibited by this workflow

This runbook is general. It accepts any valid `wheel.zob.fleet-v5-machine-bundle.v1`; PR 3853 and W1–W6 are examples, not hard-coded launch policy.

> **NO-SHIP correction:** Use preparation, validation, status inspection, and deterministic tests only. Do not execute provider-backed selected-machine start, PR handoff, governed commit, push, or GitHub effects for an operational wave until the source/HEAD gates, worktree bridge, and atomic pre-effect authority checks described below are implemented and independently reviewed.

## 1. Keep the four boundaries separate

| Boundary | What it does | What it does not do |
|---|---|---|
| Reconcile and validate | Application-owned code converts current approved story sources into immutable story manifests and one machine bundle. Wheel validates the entire bundle. | It does not select or start a machine. |
| Prepare selected machines | The owner names one or more machine IDs. Wheel writes a body-free, hash-bound launch plan. | It does not create a worktree, spawn Pi, call a provider, or edit source. |
| Start one local machine session | Target-state behavior: inside an already-open Pi or governed ZAgent session at one clean linked worktree root, Wheel claims that machine and injects a bounded edit/test/review prompt. | Operational use is currently blocked because claim/status/local-ready do not enforce and reinspect all source/workspace bindings. The command can queue a provider turn and spend. |
| PR handoff | Contract/test behavior: Wheel snapshots one separate story worktree and records exact candidate/authority hashes. | Operational use is blocked. No bridge safely transfers the reviewed machine diff, and governed commit does not validate Wheel authority atomically before effect. |

`/wheel-zob run-machine` remains an implemented one-turn command shape but is operationally blocked by the same source/workspace gate. The durable disabled supervisor remains a zero-effect control-plane simulation. Neither is the selected-machine isolated-session workflow described here.

## 2. Reconcile first; do not launch stale stories

`jointhewheel`, not the generic ZOB runtime, owns application-specific reconciliation. Before selecting machines:

1. pin the intended repository/source SHA;
2. reconcile current cards, allocation units, aliases, composites, dependencies, branch contracts, human gates, acceptance criteria, and non-goals;
3. materialize complete `zob.story-execution.v1` files;
4. materialize one source-bound `wheel.zob.fleet-v5-machine-bundle.v1`;
5. run the application drift/reconciliation validator;
6. resolve every missing, duplicate, contradictory, cyclic, stale, or human-owned item instead of guessing.

Current `bundleHash` computation uses the domain-separated canonical structured `wheel.zob.fleet-v5-machine-bundle-hash-preimage.v2` preimage, including all bundle fields except `bundleHash` and ordered referenced story-path/file-hash pairs. Delimiter-concatenated digests from earlier development snapshots are not accepted. Rematerialize an older bundle before launch; do not copy its prior hash into current state.

For the current `jointhewheel` adapter, the application command is:

```bash
npm run validate:wheel-zob-fleet-v5-adapter
```

Then use a read-only plan against any selected machine as a second whole-bundle check:

```bash
npm run wheel-zob -- \
  plan-machine \
  <mission-id> \
  <machine-id> \
  <machine-bundle.json>
```

Wheel validates all peers before selecting the requested machine. An invalid unselected peer still blocks preparation.

## 3. Prepare the exact owner-selected set

CLI:

```bash
npm run wheel-zob -- \
  prepare-local-launch \
  <launch-id> \
  <mission-id> \
  <machine-bundle.json> \
  <machine-id> [<machine-id> ...]
```

Pi:

```text
/wheel-zob prepare-local-launch <launch-id> <mission-id> <machine-bundle.json> <machine-id...>
```

Record the returned full `planHash`. The command writes only:

```text
reports/wheel-zob/local-launches/<launch-id>/launch-plan.json
```

The plan binds the bundle/source hashes, selected machine IDs, assignment hashes, story IDs, authority boundary, preparation time, and expiry. Repeating the exact request is an idempotent replay; conflicting content under the same launch ID is rejected.

Preparation reports all effect flags false. It does not create worktrees, start sessions, call providers, mutate source or Git, or contact GitHub.

Check the plan before starting anything:

```text
/wheel-zob local-launch-status <launch-id>
```

```bash
npm run wheel-zob -- local-launch-validate <launch-id>
```

## 4. Target-state isolated worktree and session procedure — operationally blocked

Do not execute the provider-backed start command for a real wave until initial claim checks `workspace HEAD === plan.sourceSha` and every status/local-ready/handoff transition reinspects the actual workspace root, branch, and HEAD. Manual shell equality is useful evidence but is not an atomic substitute for enforcement at the effect boundary.

After that gate is implemented and independently reviewed, the owner chooses the branch/worktree layout. Use the repository's approved worktree process and start each branch from an admitted SHA. The launch command itself intentionally does not run `git worktree add`.

Each machine session must start from:

- the repository worktree root;
- a named branch, not detached HEAD;
- a clean linked worktree (`gitDirectory !== gitCommonDirectory`);
- the exact launch plan and selected assignment;
- a distinct worktree from the control worktree and from every other machine;
- an already-open local Pi session or an already-governed ZAgent session.

Do not use credential-loading Fleet shell launchers as a shortcut.

### Plan availability across linked worktrees

Launch reports are intentionally not source files. If `reports/wheel-zob/` is ignored, an uncommitted launch plan in one worktree is not automatically visible in another linked worktree. Use one of these explicit local-only patterns:

1. **One-machine plan per worktree:** after creating the clean worktree, run `prepare-local-launch` there with that one machine ID, then start it there.
2. **Exact plan replication:** copy the already-reviewed `launch-plan.json` to the same ignored relative report path in each selected worktree and verify its internal `planHash` with `local-launch-validate` before start.

Do not commit a temporary plan merely to distribute it unless a separate human explicitly authorizes that repository change. Do not edit a copied plan; a hash mismatch blocks start.

### Starting Pi or ZAgent

The owner may open Pi directly in the selected worktree. If using a persistent ZTeam/ZAgent, use the existing governed ZTeam workflow (`zob_zteam_hot_add`/approved launch) rather than ad hoc tmux or file-room messaging. `start-local-machine` does not spawn Pi or tmux; it claims the session that invokes it.

When `ZOB_ZAGENT_ID`/`ZOB_ZTEAM_ID` are present, Wheel also requires current online local-registry presence. Environment labels without an online registry entry do not count as presence.

After the no-ship gate is closed, the intended command shape from the idle Pi/ZAgent session at the machine worktree root is:

```text
/wheel-zob start-local-machine <launch-id> <machine-id> <plan-sha256>
```

Do not execute this for an operational wave today. It calls `pi.sendUserMessage(...)`, which may invoke the selected provider and incur spend.

The exact confirmation is derived from launch, machine, and plan hashes. Wheel records the owner/session hashes, claim ID, workspace-root hash, starting HEAD, branch, ownership epoch, lease, journal hash, and optional ZAgent-presence receipt. Prompt and transcript bodies are not written to launch state.

The injected session may:

- inspect the assigned stories and approved cross-machine evidence;
- edit local files within assigned scope;
- run local tests and static checks;
- perform local QA, repair, and review;
- write safe hash-bound evidence refs.

It must stop before:

- commit or staging for commit;
- push, fetch, or remote mutation;
- GitHub PR, Check, comment, label, or workflow actions;
- merge, promotion, deployment, credentials, or arbitrary network access.

## 5. Target-state status, recovery, and local-ready evidence

This section describes the implemented state contract for tests and the future enabled path. It does not override the section 4 no-ship gate.

Inspect one test/development session:

```text
/wheel-zob local-machine-status <launch-id> <machine-id>
```

Inspect the selected set:

```text
/wheel-zob local-launch-status <launch-id>
```

State is body-free and hash-chained:

```text
reports/wheel-zob/local-launches/<launch-id>/machines/<machine-id>/journal.jsonl
reports/wheel-zob/local-launches/<launch-id>/machines/<machine-id>/checkpoint.json
reports/wheel-zob/local-launches/<launch-id>/machines/<machine-id>/owner.lock.json
```

The journal is authoritative. A checkpoint must match its event count and journal head. Corruption, a stale checkpoint, a live conflicting owner, a changed workspace root, changed branch, or changed HEAD blocks recovery.

If status says recovery is required and the prior lease is no longer live, use the exact next epoch:

```text
/wheel-zob recover-local-machine <launch-id> <machine-id> <plan-sha256> <next-epoch>
```

Recovery preserves dirty local edits but requires the original workspace, branch, and pre-commit HEAD. It does not authorize commit.

Checkpoint repair is an explicit local recovery action, not silent overwrite:

```bash
npm run wheel-zob -- \
  local-machine-repair-checkpoint \
  <launch-id> \
  <machine-id>
```

After edit/test/review evidence is complete:

```text
/wheel-zob local-machine-ready <launch-id> <machine-id> <epoch> <safe-evidence-ref> <evidence-sha256>
```

`local-ready` still means `commitEnabled=false` and `githubEffectsEnabled=false`.

## 6. Pre-commit candidate contract — design/test reference only

The candidate/authority schemas and snapshot code can be exercised in isolated tests, but they are not an operational handoff today.

The intended enabled workflow requires a separate linked story worktree for exactly one story, on its manifest branch, containing only the reviewed candidate changes. The admitted `sourceSha` must exist and be an ancestor of that story-worktree HEAD. Wheel’s snapshot contract records strict Git/path/content/diff metadata and rejects malformed encodings, literal-backslash path bytes, symlink traversal, secret/session/credential refs, and control-plane artifacts.

Two no-ship gaps block operator use:

1. no reviewed command creates the separate story worktree and transfers the exact reviewed machine-control diff into it while preserving machine lineage; and
2. the downstream commit consumer does not atomically load and validate the candidate/authority before mutation.

Until both gaps are implemented, negative-tested, and independently reviewed, do not run `prepare-pr-handoff` or `authorize-pr-handoff` for a real story. Artifact creation alone is not commit authority.

## 7. Governed Wheel story commit — unavailable

Do not invoke `zob_zcommit_run` for a Wheel story candidate under this workflow. Its current handoff fields are opaque caller-supplied hashes. The tool checks their presence plus the supplied base HEAD, performs the commit, and only afterward can Wheel validate candidate expiry, branch, workspace, lease, diff, or path lineage. That is effect-before-validation.

Commit may be re-enabled only when one atomic consumer, before any index/commit mutation:

1. resolves the exact candidate and authority from trusted local state;
2. recomputes and verifies their hashes;
3. checks authority expiry and allowed action;
4. reinspects machine claim, lease, epoch, journal, and checkpoint;
5. reinspects repository root, linked worktree, branch, HEAD, tree, content/diff, and exact eligible path set;
6. rejects fabricated, replayed, stale, aliased, partial, or extra bindings; and
7. has a focused negative test proving rejection creates no commit.

A later successful governed commit must still be no-push and write the body-free receipt under `.pi/logs/zcommit-receipts/`. No receipt should be handcrafted. These are acceptance requirements, not current operator instructions.

## 8. Post-commit lineage and GitHub authority — unavailable

The pack contains receipt-verification and post-commit authority contracts for tests and future integration. They are not reachable as a safe operational sequence while section 7 is blocked.

After atomic pre-effect commit validation exists, the future workflow must independently resolve the real disk-backed zcommit receipt, bind it to the exact candidate/authority/workspace/path set/pre-commit HEAD/resulting tree, and prove `actualGitPushRun=false`. Only then may it prepare a post-commit authority.

Even then, the current pack has no activated application consumer for push, draft PR creation, CI observation, or PR-close. Authority metadata is never proof of an external effect. No generic Git or GitHub tool may be described as consuming it. Merge, promotion, and deployment remain false and separately prohibited.

## 9. Body and path policy

Durable launch/handoff state may contain only IDs, hashes, safe paths, timestamps, statuses, counts, Git object IDs, booleans, and evidence references. It must not contain:

- prompt, output, transcript, review, rationale, or source bodies;
- credentials, tokens, `.env` values, or secrets;
- `.pi/sessions` or `.pi/agent-sessions` refs;
- raw private session identifiers;
- large diffs.

Schemas:

- `schemas/fleet-v5-local-machine-launch-plan.schema.json`;
- `schemas/fleet-v5-local-machine-launch-state.schema.json`;
- `schemas/fleet-v5-pr-handoff-candidate.schema.json`;
- `schemas/fleet-v5-pr-handoff-authority.schema.json`;
- `schemas/fleet-v5-pr-handoff-commit-receipt.schema.json`;
- `schemas/zcommit-receipt.schema.json`.

## 10. Fail-closed checklist

Stop and investigate if any item is true:

- whole-bundle validation fails, even for an unselected peer;
- source, bundle, assignment, plan, candidate, authority, receipt, or file hash differs;
- a selected machine is missing or duplicated;
- the worktree is not linked, named, clean at claim, or isolated;
- ZAgent presence is claimed but not online;
- journal/checkpoint lineage is corrupt or stale;
- the lease is expired or a different owner/session holds it;
- source SHA is missing or not an ancestor;
- candidate branch, HEAD, content, diff, modes, rename, binary, or untracked bytes drift;
- a forbidden ref uses `/` or `\\` separators, or a Git changed path contains a literal backslash/malformed UTF-8 or traverses any symlink component;
- a pre-commit authority asks for anything except `commit`;
- a post-commit authority asks for `commit`;
- a governed receipt cannot be resolved and independently hashed from disk;
- any step implies merge, promotion, deployment, credentials, spend, provider activation, or GitHub authority not explicitly implemented and authorized.

## 11. Validation

From the ZOB checkout under Node `22.22.3`:

```bash
npm run check -- --pretty false
node --import tsx --test \
  test/wheel-zob-pack/local-launch.test.ts \
  test/wheel-zob-pack/local-session-store.test.ts \
  test/wheel-zob-pack/pr-handoff-workspace.test.ts \
  test/wheel-zob-pack/extension-registration.test.ts
python3 docs/zob/validation/validate_contracts.py
python3 docs/zob/validation/validate_documentation.py
git diff --check
```

These checks establish local implementation behavior only. They are not clean-machine release evidence, live provider execution, GitHub execution, PR-close completion, merge approval, promotion approval, or deployment approval.
