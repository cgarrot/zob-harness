# 15 — Upgrade, Migration and Rollback

**Truth class:** Approved operational specification

## Versioned surfaces

- Pi and ZOB runtime;
- Wheel pack tag/commit;
- mission/event/checkpoint schemas;
- SQLite projection schema;
- factory/profile/taxonomy;
- role/permission/ACK policy;
- model registry/pool/prompt catalog;
- project adapter, Staging Guard and Promotion Guard;
- `develop-staging`/`develop` branch/workflow policy;
- GitHub Check schemas/App issuer allowlists.

Every mission snapshots exact versions. An active attempt never silently switches policy.

## Upgrade principles

1. Pin, preview and validate before changing an installed ref.
2. Stop new dispatch and checkpoint active missions.
3. Preserve event journal/transcripts/state before migration.
4. Migrate projections deterministically; journal remains audit source.
5. Never rewrite historical events/receipts/attempt assignments.
6. Resume only after compatibility/recovery checks.
7. Rollback must not downgrade away evidence/permission requirements silently.

## Proposed upgrade flow

1. Read release notes/migration/security changes.
2. Verify tag/commit/checksums/SBOM.
3. Run compatibility validator against project lock and active mission versions.
4. Pause missions; allow/stop attempts per policy.
5. Flush checkpoint to `zob-mission-state` and protected telemetry to `zob-model-telemetry`.
6. Back up SQLite/snapshots/config; retain journal/transcripts.
7. Install new pinned runtime/pack in staging path.
8. Run schema migration on copy.
9. Replay/validate projections and Mission Control fixture.
10. Run denied-operation/App/provider checks.
11. Atomically switch service package refs.
12. Reconcile each mission and record upgrade event.
13. Resume only when gates pass.

## Runtime/schema compatibility

- Readers declare supported version ranges.
- Unknown required event/schema fields fail closed.
- Additive fields may be ignored only when schema marks them non-semantic.
- SQLite migrations are forward, deterministic and fixture-tested.
- Downgrade is allowed only if old runtime can read the current event/schema set or a reviewed compatibility projection exists.

## Policy changes

- New missions use newly approved policy by default.
- Active missions retain snapshot unless human-approved migration occurs.
- Stricter safety additions may pause active missions and require migration.
- Weaker/removing requirements require explicit human approval and new evidence; never automatic.
- Model/prompt recommendations remain proposals until approved version release.

## Skill/pack drift

Installer validates file hashes and owner/collision maps. Local edits to packaged resources are drift, not implicit customization.

Project-specific overrides live in declared adapter/config surfaces with their own hashes. Updating the pack never overwrites application-specific skills without an explicit migration.

## Rollback

1. pause/checkpoint;
2. determine whether prior runtime supports current event/schema versions;
3. restore prior package pins/config from lock;
4. restore SQLite snapshot or rebuild projection from journal;
5. verify event/checkpoint hash heads unchanged;
6. reconcile processes/workspaces/GitHub/outbox;
7. run smoke and denied-operation tests;
8. record rollback event/reason;
9. resume only with safe compatibility proof.

Rollback never:

- truncates the journal;
- deletes transcripts;
- resets application branches;
- force-updates shared state/telemetry branches (`zob-mission-state`, `zob-model-telemetry`);
- revives expired/revoked receipts;
- replays external effects without idempotency/current-truth checks.

## Failed upgrade

If failure occurs before switch, leave old runtime active/paused. If after switch, stop dispatch/effects, preserve diagnostics, use compatible rollback or block for human. Do not keep a partially migrated mission running.

## GitHub/branch policy migration

Staging/Promotion Guard, branch and App Check migration must be staged:

1. report-only Checks and exact current branch/workflow inventory;
2. create/test `develop-staging` in a dedicated non-deploying repository first;
3. prove every deployment workflow excludes staging and responds only to the intended develop promotion event;
4. issuer/schema/legacy comparison and App denied-operation tests;
5. event/path-filter/required-check coverage review;
6. test-repo ordinary PR ready/squash merge plus full staging integration CI;
7. test-repo frozen unrelated queue, finding-bound repair candidate lineage, re-audit and merge-commit promotion;
8. post-promotion expected-head staging alignment plus aligned-head integration CI before unfreeze;
9. branch-protection/default-target reality check and open-PR migration plan;
10. human cutover with all factories still disabled, then bounded activations;
11. make the legacy direct-base reader read-only and reject its tokens for every new Wheel mission/Check/effect before removing bare-label/title bypass.

Legacy adapters are bounded and versioned; they do not become permanent silent fallback.

## Branch-policy rollback

A failed staging migration never resets or deletes staging commits.

1. freeze ordinary staging merges and promotions;
2. inventory every staging-only PR/commit and open PR base;
3. disable Staging Merge/Assurance/Promotion Apps and automatic effects;
4. preserve branch/Check/receipt evidence;
5. either finish an already-authorized audited promotion or explicitly abandon it—never partially promote;
6. restore prior PR target/workflow policy only through a reviewed human-approved adapter rollback;
7. keep automatic CD limited to `develop`; never compensate by manually dispatching deployment;
8. verify no commit became unreachable and no PR silently changed scope/base.

## Uninstall versus rollback

Rollback changes version. Uninstall removes the runtime/package integration while preserving evidence. Neither action authorizes deletion of state/telemetry/transcripts/keys without explicit scope.