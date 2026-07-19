# 02 — Architecture and Repository Ownership

**Truth class:** Approved design

## Repository boundary

### `zob-harness` — canonical system repository

This repository owns two deliberately bounded layers.

**Generic runtime mechanics:**

- `zobd` background service and Unix-socket API;
- hash-chained event journal and SQLite projections;
- scheduler, leases, recovery, outbox and checkpoint protocol;
- encrypted transcript storage;
- generic mission/story/gate/task/attempt schemas;
- dispatch reservation, claim acceptance and gate invalidation;
- capability/permission engine;
- workspace leases, sandboxes and merge-candidate queue;
- model blindness, randomized policy engine and prompt experiment mechanics;
- GitHub observation/effect interfaces;
- generic Mission Control views and controls.

**Consolidated Wheel AgentOps layer:**

```text
packages/wheel-zob-pack/
  execution-profiles/
  gate-templates/
  role-policies/
  permissions/
  ack-types/
  taxonomy/
  prompt-catalog/
  model-policy/
  shared-contracts/
  skills/
  adapters/
  factories/

tools/wheel-zob/
docs/zob/
needs-human/
```

The Wheel layer owns the master decision/enhancement record, install tooling, prompt/model policy, final repository-assurance coverage policy, protected checkpoint/telemetry branch contracts and the user-facing terminal manual. Generic code must not import that layer or hard-code Wheel paths, gate names, labels, model aliases, CI workflow names or completion policy. Consolidation changes repository placement, not this dependency direction. `jointhewheel-docs-tools` is retained only as historical authoring/migration evidence and is not a second source of ZOB truth.

### `jointhewheel` — application integration

Owns:

- application-specific skills;
- Fleet v5 story signals and story cards;
- story execution manifests/evidence on feature branches;
- app paths, `develop-staging`/`develop` branch protection and promotion adapter, labels, full staging/develop CI and Ready/Promotion Guard adapters;
- app-specific profile selectors and validators;
- pinned package settings/lock;
- compatibility wrappers;
- source-coupled integration tests.

It does not vendor the ZOB extension or become the canonical source of reusable AgentOps policy.

## Skill ownership

**Truth class for this inventory subsection:** Current evidence.

Current live inventory snapshot (2026-07-18):

- 25 ZOB skill entry files;
- 188 Wheel skill entry files;
- 34 Wheel shared-contract Markdown files;
- zero exact skill-name collisions between Wheel and ZOB.

The generic/parameterized/application-specific migration partition is a required implementation artifact, not a frozen count in this design. Generic reusable skills/contracts stay in the runtime/support layer of this repository; parameterized Wheel skills move into `packages/wheel-zob-pack/` only after project assumptions become configuration; application-specific skills stay in `jointhewheel`.

Wheel owns intent; ZOB owns execution mechanics. `/work`, `qa`, `mpr`, `pr-close`, `pr-ship` and `/merged` retain semantic ownership. ZOB support skills remain hidden mechanisms rather than competing front doors.

## Runtime components

```text
zobd
├── mission admission and scheduler
├── journal/SQLite/snapshot persistence
├── task and attempt state machines
├── model/prompt assignment broker
├── process/session manager
├── transcript encryptor
├── worktree/lease/merge-candidate manager
├── GitHub/CI/needs-human watchers
├── GitHub effect outbox
├── evidence reconciler
└── Mission Control socket server
```

The service runs no idle LLM. It invokes a model only for a ready task or bounded judgment. Any Pi session can attach after ownership verification.

## Control and data planes

### Control plane

- mission/task state;
- policy and version refs;
- leases and idempotency keys;
- body-safe events, evidence bindings and receipts;
- GitHub mutation requests;
- user controls.

### Sensitive local data plane

- encrypted agent stdout/stderr/tool transcript chunks;
- local prompt compilation inputs;
- exact model assignment mapping before protected export.

Raw bodies never enter normal mission state, Git evidence or PR comments.

## GitHub service identities

Four independent least-privilege Apps are planned:

1. **Builder App** — feature-branch contents/PR/check mutations only; no merge/deploy.
2. **Reviewer App** — contents/checks read; formal review and repository-assurance review/comment/check write; no source write/merge/deploy.
3. **Staging Merge App** — ready/squash merge only into non-deploying `develop-staging`, plus Staging Integration Checks; no write/merge to `develop`/`main` and no workflow/deploy/admin authority.
4. **Promotion App** — dormant except a human-started promotion window; merge-commit only the typed audited promotion PR into `develop`, then expected-head fast-forward staging after reconciliation; no repair/workflow dispatch/environment/admin bypass.

Agents never receive App tokens. The deterministic broker validates typed requests and issues short-lived tokens.

## Shared branch purposes

- `main`: generic runtime, consolidated Wheel pack, docs, needs-human contracts and reviewed policy.
- `zob-mission-state`: body-safe checkpoint snapshots and indexes.
- `zob-model-telemetry`: protected exact model/thinking/prompt/outcome mappings.

The Pi package checkout is never reused for mutable state branches because Pi may reconcile/reset it.

## Packaging

Initial distribution uses one reviewed repository with independently versioned runtime and Wheel-pack surfaces:

```text
npm:zob-harness@<exact-runtime-version>
git:git@github.com:Join-The-Wheel/zob-harness@wheel-zob-pack-v<version>
```

The second pin selects the bounded Wheel pack from this repository; it is not another repository or another source of truth. A lock records exact runtime version, repository commit, pack tag/hash, taxonomy, prompt catalog, role policy and profile versions.

## Implementation PR structure

The ZOB runtime rollout is split into bounded stacked draft PRs:

- **PR A — Durable execution core:** current observability repair, daemon, persistence, lifecycle, permissions, blindness, workspaces.
- **PR B — Operational Story Factory:** adapters, GitHub/CI/needs-human, Mission Control, model/prompt engine and Story factory.
- **PR C — Blind Review + Staging Merge:** formal review, Staging Merge App broker and non-deploying integration CI.
- **PR D — Final Assurance + Promotion:** PR #3817-style lanes/coverage/repair loop, Promotion App broker and post-promotion reconciliation.

PR C/D remain disabled follow-ons until A/B are validated. Runtime-core and Wheel-pack changes remain separately reviewable PRs in this repository; the `jointhewheel` application adapter remains a separate repository PR with explicit dependency links. Nothing is merged or activated automatically.

## Source-worktree rule

The existing dirty execution-observability worktree is preserved. Useful modules are integrated through reviewable changes; no destructive reset/rebase/checkout is allowed merely to make the new architecture easier.