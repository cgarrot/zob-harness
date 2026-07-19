# 12 — Installation on a New Machine

**Truth class:** Approved future full-supervisor install specification
**Command state:** Proposed future commands; do not run until releases exist

For the executable bounded Fleet validation/mission preview/factory simulation pack that exists now, use [`18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md`](18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md). This section continues to describe the not-yet-released live supervisor, GitHub/App, branch, service and production installation design.

## Installation modes

- **Development:** one explicit local ZOB source worktree with its bounded local `packages/wheel-zob-pack/` path.
- **Pinned machine/project:** exact released `zob-harness` runtime plus a tagged Wheel pack from the same canonical repository.

Never install from an unreviewed dirty worktree as a durable machine configuration.

## Prerequisites

- supported macOS/Linux host;
- Node/Pi versions in release compatibility matrix;
- Git and GitHub CLI;
- access to `jointhewheel` plus the reviewed ZOB repository/runtime and Wheel-pack releases;
- OS keychain/secret store;
- sufficient disk for worktrees/transcripts;
- trusted repository checkout;
- human available for provider OAuth and GitHub App installation when those later become authorized;
- Python 3 plus Draft 2020-12 `jsonschema` for pack contract validation (development/release tooling, not the runtime data plane).

SQLite is bundled/managed by the runtime; do not rely on an unversioned global DB tool for mission integrity.

## Safety preflight

1. Inventory existing Pi packages/providers/MCP/skills.
2. Record current settings and package lock.
3. Verify no credentials will be printed or copied into the repository.
4. Verify target application worktree is clean or intentionally preserved.
5. Verify old `jointhewheel-doc-archive` is not repurposed.
6. Verify `zobd` is not already owned by another installation.
7. Confirm enough disk for planned worktrees and transcript threshold.

## Package install

Project settings pin exact sources:

```text
pi install -l npm:zob-harness@<exact-runtime-version>
pi install -l git:git@github.com:Join-The-Wheel/zob-harness@wheel-zob-pack-v<version>
```

The tagged release provides:

- reviewed commit and changelog;
- Pi package manifest exposing only pack resources;
- file inventory/SHA-256 sums;
- SBOM/dependency inventory;
- compatibility matrix;
- migrations and rollback;
- schema/policy/profile/taxonomy/prompt versions.

Pi pinned refs do not advance during generic updates. Upgrade uses an explicit new pin.

## Project lock

`.pi/zob/wheel-zob.lock.json` (future path) records:

- ZOB/Pi versions;
- Wheel pack tag/commit/hash;
- execution-profile/taxonomy/role/ACK/model/prompt catalog versions;
- project adapter version;
- install validation receipt.

Do not include credentials, machine username or raw provider data.

## Project configuration

Application-owned config supplies:

- repository identity;
- mandatory ordinary PR base `develop-staging` and promotion base `develop`;
- story bundle roots;
- branch/stack naming;
- draft PR and staging-freeze rules;
- PR, full staging integration, assurance and promotion CI profiles;
- explicit proof that every deployment workflow excludes `develop-staging` and includes only the intended `develop` promotion event;
- label/check names;
- process path patterns;
- state/telemetry remote and branch names;
- local runtime root;
- concurrency/disk/budget caps;
- disabled factory flags.

Default flags:

```text
storyFactory.enabled = false until local validation
blindReviewFactory.enabled = false
stagingMergeFactory.enabled = false
repositoryAssuranceFactory.enabled = false
promotionFactory.enabled = false
developStaging.required = false until branch migration
providerLiveTests.enabled = false
```

## Supervisor service

Future installer:

1. creates permissioned runtime directories;
2. initializes local keychain key reference;
3. installs `zobd` user service/launch agent;
4. creates Unix socket with user-only permissions;
5. initializes schema/version metadata;
6. starts in no-mission/no-mutation mode;
7. validates attach/disconnect/restart behavior.

Keychain failure blocks transcript-capable mission admission. It never falls back to plaintext.

## Shared branches

A supervisor-owned setup command creates/verifies, without force:

- `zob-mission-state`;
- `zob-model-telemetry`.

It validates branch purpose, expected remote and access policy. State uses a separate runtime bare clone/worktree, never the Pi package checkout.

## Application branch migration

A separately approved JointheWheel adapter PR must:

1. create `develop-staging` from the then-current `develop` head;
2. protect it and require ordinary PRs/Checks;
3. prove every CD workflow excludes staging;
4. configure push-triggered full staging integration CI after every staging merge and post-promotion alignment;
5. restrict `develop` to typed promotion PRs from staging through Promotion App;
6. configure promotion merge-commit and develop-only automatic CD;
7. add unrelated-merge freeze, finding-bound repair exception, candidate-revision and expected-head branch-alignment controls;
8. migrate existing open PRs without losing review/evidence;
9. keep legacy direct-base tokens parseable only in the read-only migration reader and reject them for every new Wheel mission/Check/effect.

This documentation does not create either branch or change any workflow.

## GitHub Apps

Builder, Reviewer, Staging Merge and Promotion Apps require separate human installation and credential setup. Installation is not activation.

- Store private keys/tokens in OS secret store only.
- Verify actual permissions against documented allowlists.
- Run denied-operation tests.
- Keep Staging Merge credentials absent until staging migration/pilots pass.
- Keep Promotion credentials absent/dormant until its independent activation gate and every promotion window receipt.

## Providers

Provider authentication is manual:

- `fireconnect` CLI (v0.8.0+) wires Pi to the Fireworks OpenAI-compatible endpoint (`https://api.fireworks.ai/inference/v1`); install via `fireconnect login` then `fireconnect pi on`;
- OpenAI Codex OAuth through Pi (built-in `openai-codex` provider);
- no API key added to repository/config docs; the Fireworks key is stored in the OS keychain and injected at runtime by `fireconnect`.

Inventory may be read-only. Paid live capability tests require separate spend approval. The gated capability audit was completed 2026-07-18 (see [`09-MODEL_AND_PROMPT_EXPERIMENTS.md`](09-MODEL_AND_PROMPT_EXPERIMENTS.md) § Provider audit); only verified routes enter pools. Pool configuration is now evidence-backed, not empty.

## Validation after install

- package hashes and lock;
- skill collision/owner map;
- JSON/YAML/schema examples;
- supervisor socket/service/restart;
- SQLite/journal/transcript fixture;
- no network listener;
- no factory activation;
- no active `develop-staging` policy or workflow change from package installation alone;
- staging cannot trigger any deployment and develop promotion can trigger only intended automatic CD;
- App credentials/permissions absent or explicitly configured;
- provider models not assumed;
- Mission Control fixture renders.

See [`14-VALIDATION_AND_PILOTS.md`](14-VALIDATION_AND_PILOTS.md).

## Uninstall/rollback

1. pause missions and checkpoint;
2. verify no active agents/leases/outbox effects;
3. stop/disable service;
4. remove project package pins or restore prior lock;
5. preserve/export local mission evidence as instructed;
6. never delete encrypted transcripts automatically;
7. remove keys only after explicit cryptographic-deletion approval;
8. leave shared state/telemetry history intact unless separately authorized.

No uninstall step resets application branches or removes unrelated Pi packages.