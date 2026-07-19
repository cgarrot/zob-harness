# 19 — JointheWheel Fleet v5 with Wheel ZOB: Operator and Human-Authority Guide

- **Truth class:** Current evidence plus an explicit implementation/activation checklist
- **Evidence snapshot:** 2026-07-20
- **Current launch verdict:** **READY** only for deterministic materialization/validation/preview and disabled/deterministic-fake supervision; **BLOCKED** for operational provider-backed selected-machine sessions, Wheel story commits, released clean-machine rollout, and live push/GitHub factory launch
- **Current safe scope:** Deterministic PR 3853 materialization, all-story validation, per-machine preview, body-free launch-plan preparation, and durable zero-effect fake role/workspace/PR/CI/PR-close adapters
- **External effects:** Provider-backed start can invoke the selected model and spend; operational use is blocked until source/workspace checks are enforced. GitHub, merge, promotion, and deployment effects remain disabled.
- **Production activation:** Unavailable and unauthorized

This guide answers four operator questions:

1. What has to exist before a clean machine can run Wheel ZOB from the `jointhewheel` repository?
2. What can a model safely be prompted to do inside Pi today?
3. Which actions require an explicit human decision or must be performed by a human?
4. What still has to be implemented before “start the Fleet v5 factory” means live dispatch, GitHub pull requests, review, staging, promotion, or deployment?

For generic ZOB machine installation, read [`18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md`](18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md). For the selected-machine contract and its current source/worktree/commit no-ship gaps, read [`21-FLEET_V5_LOCAL_MACHINE_LAUNCH_AND_PR_HANDOFF.md`](21-FLEET_V5_LOCAL_MACHINE_LAUNCH_AND_PR_HANDOFF.md). For the current durable disabled supervisor, read [`20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md`](20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md). The broader live activation sequence remains in [`12-INSTALLATION.md`](12-INSTALLATION.md), [`14-VALIDATION_AND_PILOTS.md`](14-VALIDATION_AND_PILOTS.md), and [`17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md`](17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md).

## 1. The answer in one sentence

The development implementation now reconciles PR 3853 into 60 source-bound manifests, supports deterministic bounded queue preview and launch-plan preparation, and can durably exercise the complete scheduler/model-role/workspace/PR/CI/PR-close control plane through disabled deterministic fakes; operational provider-backed machine start and Wheel story commit remain blocked by source/workspace reinspection, worktree-bridge, and atomic pre-effect authority gaps; **a human still controls package trust, credentials, spend, security disposition, branch policy, real GitHub/provider effects, activation, promotion, and deployment**, and the live effect adapters do not exist yet.

## 2. Current evidence snapshot

Recheck every item before acting; this is a dated snapshot, not permanent truth.

### 2.1 PR 3853

PR: <https://github.com/Join-The-Wheel/jointhewheel/pull/3853>

At the evidence snapshot:

- state: `OPEN`;
- draft: `true`;
- head: `404ca9196a6f9546440f38f0146fc7951b09d4f0`;
- base: `develop`;
- individual `Gitleaks Scan`: `FAILURE`;
- open repository PR count: 13;
- the PR’s “all open PRs are closed/merged” precondition is therefore unmet.

Do not infer readiness from an aggregate check named “All Checks Passed” when an individual security check is failing. Intake must fail closed on any required red, cancelled, unknown, or missing check.

PR 3853 adds planning and routing data, not a ZOB execution adapter:

- `docs/operations/reviews/2026-07-17-full-codebase-review/FLEET-V5-V6-BACKLOG.md`;
- `docs/operations/reviews/2026-07-17-full-codebase-review/FLEET-V5-ALLOCATION.md`;
- `scripts/model-bakeoff/routing/allocation-plan-v5.json`;
- `scripts/model-bakeoff/routing/story-signals-v5.json`;
- 60 `docs/operations/kanban/stories/*/CARD.md` additions.

PR 3853 itself does **not** add:

- `zob.story-execution.v1` manifests;
- a `wheel.zob.fleet-v5-machine-bundle.v1` machine bundle;
- a `jointhewheel` → Wheel ZOB converter;
- `/wheel-zob run-machine` or another plan-level launcher;
- a ZOB package pin in `.pi/settings.json`;
- `.pi/zob/wheel-zob.lock.json`;
- a durable supervisor;
- live GitHub/model-provider integration.

The development implementation described in §§5.3–5.6 now supplies the first four items plus the durable activation-disabled supervisor, in separate uncommitted worktrees at the exact PR head. That is implementation evidence, not evidence that PR 3853 contains them, that they are released on a durable ref, or that live effects are enabled.

### 2.2 PR 3853 data incompatibilities

The allocation plan declares:

- six workers;
- 59 allocation units;
- 193 estimated effort days.

The signals file contains 60 story records. Its root `schema` is a descriptive field map, not the per-story `schemaVersion` required by the Wheel validator. At least these fields are scalar strings in the PR data but arrays in `FleetV5Signals`:

- `blast`;
- `verification`;
- `testDemands`;
- `opsTouch`.

The allocation also contains identifiers that require normalization, including:

- `W2-SIZES-STAGE` versus `W2`;
- `W3-A-CLIENT-CORE` versus `W3-A`;
- `W4-A-WIDGET-ROUTES-PWA` versus `W4-A`;
- combined `W4-B/W4-C` versus separate source records;
- path/ID aliases such as `BF-P40`.

The adapter must reconcile these differences from evidence. It must not guess, drop a story, or silently split a combined allocation.

### 2.3 Current ZOB package state

At the evidence snapshot:

- npm package `zob-harness@0.16.0` exists;
- its published Pi manifest loads only `.pi/extensions/zob-switch/index.ts` and `.pi/extensions/zob-harness/index.ts`;
- it does not load `.pi/extensions/wheel-zob-pack/index.ts`;
- `@join-the-wheel/wheel-zob-pack` is not published;
- `https://github.com/Join-The-Wheel/zob-harness.git` does not exist;
- the current repository source is `https://github.com/cgarrot/zob-harness.git`, whose inspected `main` was `657f470b3a5fcdb594fa1e746f58e186383567d4`;
- the Wheel implementation exists in the current development worktree but is not yet a reviewed, reproducible clean-machine release.

Therefore, do not tell a second machine to install `zob-harness@0.16.0` and expect `/wheel-zob` to exist.

### 2.4 Branch-policy mismatch

Current `jointhewheel` development and PR 3853 use `develop`. The Wheel story validator requires:

```text
ordinary story base: develop-staging
ordinary PR target: develop-staging
promotion target:   develop
```

`origin/develop-staging` was absent at the evidence snapshot. No model may invent that branch, weaken the validator, or change branch protection/workflows as an incidental fix.

### 2.5 Current runtime boundary

The executable Wheel extension currently exposes:

- `wheel_zob_validate_story`;
- `wheel_zob_preview_mission`;
- `wheel_zob_simulate_pipeline`;
- `/wheel-zob run|run-machine|validate|plan|simulate|pools`;
- `/wheel-zob supervisor-plan|supervisor-init|supervisor-run-fake|supervisor-status|supervisor-resolve-human`;
- `/wheel-zob prepare-local-launch|local-launch-status|start-local-machine|recover-local-machine|local-machine-status|local-machine-ready`;
- `/wheel-zob prepare-pr-handoff|record-pr-commit|authorize-pr-handoff|pr-handoff-status`;
- CLI `wheel-zob plan-machine`, `supervisor-plan`, `supervisor-init`, `supervisor-run-fake`, `supervisor-status`, `supervisor-validate`, and `supervisor-resolve-human` entry points.

`/wheel-zob run-machine` is implemented and:

1. accepts a mission ID, one explicit machine ID, and one repo-relative `wheel.zob.fleet-v5-machine-bundle.v1` file;
2. verifies allocation/signals source hashes, the bundle hash, all 60 story files, story IDs/paths, assignments, dependencies, and cycles before selecting a machine;
3. reports that machine’s allocation units, canonical stories, and human-gate stories;
4. injects one bounded implementation turn into the current Pi session; and
5. limits the prompt to that selected machine’s story scope, local source edits, and local validation.

`/wheel-zob run` is likewise implemented for explicit story-file lists. Both provider-backed run commands are operationally blocked until source/workspace enforcement is fixed; use their preview counterparts only.

Neither bounded `run` command:

- accepts mutable PR text, a directory, or a glob;
- grants a machine permission to implement peer-machine scope merely because it has a cross-machine artifact dependency;
- dispatches role-pool workers or starts the durable supervisor;
- activates Story, Blind Review, Staging, Assurance, or Promotion factories;
- creates branches or pull requests;
- comments, labels, issues Checks, marks ready, commits, pushes, merges, or deploys.

The separate supervisor entry points now persist and recover a shared mission, but only with disabled or deterministic-fake adapters. They make no provider/network/credential/repository/GitHub/deployment effect, and the controller rejects `mode=live`.

The selected-machine launch path is also distinct. Preparation writes a body-free immutable plan without spawning anything. Although `start-local-machine` is implemented, it can queue a provider turn and is not operationally approved: initial claim does not enforce equality with the plan source, and status/local-ready do not reinspect normal control-workspace drift. Candidate/authority metadata is testable but not commit authority. `zob_zcommit_run` currently treats the Wheel hashes as opaque inputs and can mutate Git before Wheel validates expiry, branch, workspace, lease, diff, and paths. Therefore operational use stops before provider-backed start; in isolated implementation tests, local-ready is the latest permissible state. Post-commit push/GitHub/CI/PR-close consumers are also absent. See document 21.

## 3. Authority legend

Use these labels throughout the runbook.

| Label | Meaning |
|---|---|
| **MODEL-LOCAL** | A model may perform the action autonomously inside an already trusted checkout and explicitly approved local scope. |
| **MODEL-AFTER-HUMAN** | A model may perform the bounded action only after a human explicitly approves the exact scope, effect, cap, or path. |
| **HUMAN-ONLY** | The decision or credential-bearing action must be made by a human. The model may prepare evidence/options but cannot self-authorize. |
| **UNAVAILABLE** | The required live integration is not implemented or validated; neither a prompt nor human confirmation makes it available. |

## 4. Responsibility matrix

| Action | Authority now | Notes |
|---|---|---|
| Read local source/docs and map integration points | MODEL-LOCAL | No secrets or private session stores. |
| Inspect PR 3853 metadata/checks/files read-only | MODEL-AFTER-HUMAN | Requires the operator’s existing read authorization and `gh` authentication; no checkout/comment/edit. |
| Reconcile cards, dependencies, aliases, and current code | MODEL-LOCAL | Return evidence and unresolved decisions; do not guess. |
| Write adapter code/tests in an approved local branch/worktree | MODEL-AFTER-HUMAN | Ordinary supervised repository development only, outside Fleet run/start. It requires a separately approved session and paths; no Wheel launch claim, commit, push, or GitHub mutation. |
| Generate sanitized story manifests and a machine bundle from pinned local files | MODEL-AFTER-HUMAN | Implemented for the PR 3853 head; generated outputs still require review before durable adoption. |
| Validate manifests | MODEL-LOCAL | Use `wheel_zob_validate_story` or the all-machine `plan-machine` validation path. |
| Preview a mission or one machine queue | MODEL-LOCAL | `dispatchEnabled=false`; not a live launch. |
| Simulate the lifecycle | MODEL-LOCAL | All effect flags remain false. |
| Implement one validated story locally with `/wheel-zob run` | UNAVAILABLE | Use validate/plan only until active-workspace source enforcement is fixed. |
| Hand one validated W1–W6 queue to the current Pi session with `/wheel-zob run-machine` | UNAVAILABLE | Use `plan-machine` only; provider-backed operational handoff is blocked by the same source/workspace gap. |
| Prepare an arbitrary selected-machine local launch plan | MODEL-LOCAL | Whole-bundle validation and body-free report write only; no worktree/session/process/effect. |
| Start or recover one selected machine in an isolated linked-worktree Pi/ZAgent session | UNAVAILABLE | Provider-backed operational start is blocked until claim and every transition enforce/reinspect source, workspace, branch, and HEAD. |
| Prepare or inspect a PR handoff candidate/authority | UNAVAILABLE | Contract tests may create metadata, but no reviewed machine-to-story bridge makes it an operational handoff. |
| Create one governed Wheel story commit through candidate/authority-bound `zob_zcommit_run` | UNAVAILABLE | Current consumer does not load and validate Wheel authority atomically before Git mutation. |
| Push/create draft PR/observe CI/run PR-close from post-commit authority | UNAVAILABLE | Authority contracts exist, but no activated application consumer is included. |
| Plan/initialize/status/validate the durable disabled supervisor | MODEL-LOCAL | Body-free state under `reports/wheel-zob/supervisor/`; no source or external effects. |
| Run `supervisor-run-fake` | MODEL-AFTER-HUMAN | Exercises all control-plane loops with deterministic fakes, zero provider calls, zero GitHub effects, and zero spend. |
| Resolve one fake-run human gate by full receipt hash | HUMAN-ONLY | The model may record the exact human-supplied hash; it may not invent the decision. |
| Run local tests/typechecks/docs validators | MODEL-LOCAL | Use the application’s required Node version. |
| Perform skeptical/oracle review | MODEL-LOCAL | Review does not grant authority. |
| Trust a project or third-party Pi package | HUMAN-ONLY | Extensions execute with the user’s permissions. |
| Authenticate OpenAI, Fireworks, GitHub, cloud, or other providers | HUMAN-ONLY | Never paste credentials into prompts or repositories. |
| Decide whether a Gitleaks finding is a secret or false positive | HUMAN-ONLY | Model may locate safe metadata but must not expose suspected secret bodies. |
| Ratify PR 3853 as canonical Fleet input | HUMAN-ONLY | Requires current evidence and repository process. |
| Resolve the 59-unit/60-card product-scope discrepancy | HUMAN-ONLY | Model may recommend a mapping; owner approves it. |
| Choose/create `develop-staging` and change branch policy | HUMAN-ONLY | High-stakes repository architecture and deployment boundary. |
| Approve model spend/provider calls | HUMAN-ONLY | Exact cap, expiry, routes, and purpose. |
| Unrelated repository-maintenance commit or push | MODEL-AFTER-HUMAN | Only through governed `/zcommit`/`zob_zcommit_run` after an explicit request and applicable repository policy; this does not authorize a Wheel story candidate. |
| Create a real draft PR | UNAVAILABLE | Fake mode produces body-free synthetic PR metadata only; no live GitHub broker is implemented. |
| Install GitHub Apps/change permissions/protection/workflows | HUMAN-ONLY | Least-privilege security boundary. |
| Activate a live factory | HUMAN-ONLY | Requires an exact activation receipt and oracle PASS/no-ship false. |
| Start a promotion window or authorize promotion merge | HUMAN-ONLY | Exact-head receipts required. |
| Trigger or approve deployment | HUMAN-ONLY | Never inferred from “go,” merge permission, or factory activation. |
| Run the full live Fleet v5 factory today | UNAVAILABLE | The durable disabled control plane exists; real provider, application-workspace, GitHub, staging, promotion, and deployment integrations are not implemented/activated. |

## 5. Work required before a clean-machine launch

### 5.1 Release a Wheel-enabled ZOB package

The ZOB maintainer must:

1. review the complete Wheel implementation diff;
2. remove or update stale handoff material;
3. verify the package includes `.pi/extensions/wheel-zob-pack/index.ts`, `packages/wheel-zob-pack/**`, scripts, tools, docs, and tests;
4. settle the canonical GitHub repository URL;
5. update and lock Pi package dependencies/peer ranges if required;
6. run the full validation ladder in §9;
7. obtain an independent oracle PASS/no-ship false for the bounded release;
8. use the governed commit/push workflow after explicit human authorization;
9. let the release workflow publish a new exact version or immutable tag;
10. verify the package tarball and clean-machine Pi load;
11. publish the exact version, full commit SHA, hashes, compatibility, and rollback reference.

Until that happens, another clean machine cannot reproduce the current Wheel extension from `origin/main` or `zob-harness@0.16.0`.

### 5.2 Reconcile and merge PR 3853

The `jointhewheel` owner must:

1. investigate the failing Gitleaks check safely;
2. rebase/reconcile the draft with current `develop`;
3. re-evaluate every dependency whose referenced PR has since merged or changed;
4. resolve the stated open-PR precondition;
5. regenerate the backlog, cards, signals, and allocation together;
6. resolve 59 allocation units versus 60 cards;
7. normalize IDs and split/retain `W4-B/W4-C` by explicit decision;
8. rerun routing/allocation arithmetic;
9. make all required checks green;
10. obtain review and merge through the repository’s process.

Before merge, PR 3853 is planning evidence, not durable runtime authority. After merge, intake should bind to exact files at an exact `jointhewheel` commit SHA, not to mutable PR text.

### 5.3 Application adapter — implemented in the PR 3853 development worktree

The bounded application-side implementation now exists at:

```text
scripts/wheel-zob/materialize-fleet-v5.mjs
scripts/wheel-zob/materialize-fleet-v5.test.mjs
docs/operations/fleet-v5/zob/pr3853-machine-bundle.json
docs/operations/fleet-v5/zob/pr3853-reconciliation.json
docs/operations/fleet-v5/zob/stories/*.json
```

It deterministically:

1. reads the pinned PR 3853 backlog, allocation, signals, and all referenced cards;
2. derives the source commit and hashes source/card content;
3. normalizes scalar/array signal fields and documented ID/path aliases;
4. reconciles 59 allocation units to all 60 story records;
5. preserves `W4-B/W4-C` as one allocation unit that explicitly materializes both canonical stories;
6. materializes 60 complete `zob.story-execution.v1` files;
7. types same-machine prerequisites as `hard` and cross-machine/external prerequisites as `artifact`;
8. binds acceptance, non-goal, gate, ratification, profile, branch, and human-gate references;
9. emits one source-bound `wheel.zob.fleet-v5-machine-bundle.v1` file for W1–W6;
10. refuses stale generated files, unassigned/duplicate/missing stories, stale source hashes, invalid paths, contradictory assignments, and invalid/cyclic mission data.

The application validation command is:

```bash
npm run validate:wheel-zob-fleet-v5-adapter
```

The generated reconciliation record says `localRunnerReady: true` and `liveFactoryReady: false`. The cited PR 3853 bundle predates canonical structured bundle-hash hardening; it is historical evidence and must be rematerialized from the reconciled sources before any current launch. Remaining integration work before a durable clean-machine release includes review/commit of refreshed artifacts, a reviewed immutable ZOB package pin in `.pi/settings.json`, an optional body-free `.pi/zob/wheel-zob.lock.json`, clean-machine certification, and the separately gated live architecture in §§5.5–5.6.

### 5.4 Per-machine preview is usable; provider-backed run is operationally blocked

Use the deterministic, zero-effect preview:

```text
wheel-zob plan-machine <mission-id> <machine-id> <machine-bundle.json>
```

`/wheel-zob run-machine <mission-id> <machine-id> <machine-bundle.json>` is implemented and validates the whole bundle before injecting one model turn, but do not use it for an operational wave until the active checkout is atomically proven to match the admitted source and later transitions reinspect workspace/branch/HEAD. It can invoke the selected provider and incur spend. The command does not provide durable queue supervision, GitHub effects, or automatic progression from smoke to pilot.

The durable activation-disabled supervisor is a separate implemented path:

```text
/wheel-zob supervisor-plan <mission-id> <machine-bundle.json>
/wheel-zob supervisor-init <mission-id> <machine-bundle.json> <state-dir> disabled
/wheel-zob supervisor-run-fake <mission-id> <machine-bundle.json> <state-dir>
/wheel-zob supervisor-status <state-dir>
```

The CLI additionally exposes `supervisor-validate` and `supervisor-resolve-human`. See [`20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md`](20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md).

Do not describe `run-machine` as the durable supervisor. Do not describe the disabled/fake supervisor as live factory activation.

For future repeated local implementation on an arbitrary reconciled bundle, document 21 defines the target selected-machine workflow. Today only whole-bundle validation and launch-plan preparation are operationally safe. Provider-backed start is blocked pending source/workspace enforcement; PR handoff is blocked pending the machine-to-story bridge; commit is blocked pending atomic pre-effect authority validation. Push/GitHub/CI/PR-close also remain unavailable.

### 5.5 Resolve branch and GitHub architecture

A full live factory additionally requires:

1. explicit owner selection of the staging architecture;
2. protected `develop-staging` created from an approved `develop` SHA;
3. ordinary PRs targeting `develop-staging`;
4. proof that staging cannot deploy;
5. push-triggered full staging integration CI;
6. typed promotion PRs from staging to `develop`;
7. tree-equivalence and parent checks;
8. separate least-privilege Builder, Reviewer, Staging Merge, and Promotion Apps;
9. branch protection and required Check configuration;
10. denied permissions and negative tests;
11. no manual deployment workflow dispatch path;
12. rollback and post-promotion staging alignment.

No model should make these changes as part of “fix the manifest validator.”

### 5.6 Implement and pilot the live adapters

The current disabled supervisor now provides a hash-chained journal, atomic checkpoints, crash/restart recovery, ownership epochs, dependency scheduling, routed fake role loops, bounded retries/repairs, body-free workspace/PR/CI metadata, exact-head evidence invalidation, needs-human receipts, and three-way PR-close audit evidence.

A real factory still needs separately reviewed and activated implementations for:

- provider/model calls with credential isolation, durable reservations, actual spend settlement, timeout/cancellation, and external idempotency;
- application workspace leases, real worktrees/sandboxes, source-path ownership, rollback, commit, and push;
- GitHub broker observation/mutation, least-privilege Apps, Checks, labels, comments, draft PRs, stale-head reconciliation, and outbox replay;
- protected `develop-staging`, Staging Merge, Final Assurance, Promotion, and deployment boundaries;
- Mission Control live provider/GitHub status and controlled stop;
- activation, expiry, rollback, revocation, spend, and exact-head human receipts;
- clean-machine release and pilots.

The controller explicitly rejects `mode=live`; no receipt-shaped input bypasses that stop. The deterministic fake validates control-plane behavior only. It does not implement application stories or create external resources.

## 6. Clean-machine setup

There are two setup modes:

- **Mode A — deterministic/read-only evaluation:** available only after obtaining the current Wheel source or a Wheel-enabled release; no provider-backed source-edit session and no live factory.
- **Mode B — integrated Fleet launch:** blocked until all §5 work and pilots are complete.

### 6.1 Collect immutable release values — HUMAN-ONLY

Do not continue with placeholders. Obtain:

```bash
export ZOB_REPO_URL="https://github.com/cgarrot/zob-harness.git" # replace if canonical ownership moves
export ZOB_REF="<full-reviewed-wheel-enabled-zob-sha-or-tag>"
export ZOB_VERSION="<wheel-enabled-version>"
export JTW_REF="<reviewed-jointhewheel-sha-containing-the-merged-plan-and-adapter>"
```

A clean-machine certification is invalid if it uses a moving branch without recording its resolved full SHA.

### 6.2 Install base tools — HUMAN-ONLY

Install with an organization-approved package manager:

- Git;
- GitHub CLI;
- `nvm`, `mise`, or equivalent;
- Node `20.19.0`;
- Node `22.22.3`;
- Python 3;
- `jsonschema>=4.25,<5` for ZOB contract/docs validation;
- `jq`;
- C/C++ build tools;
- Docker only when local application integration services are required.

macOS also requires Xcode Command Line Tools:

```bash
xcode-select --install
```

Install both Node versions:

```bash
nvm install 20.19.0
nvm install 22.22.3
```

Why both:

- `jointhewheel/.nvmrc` pins `20.19.0`;
- the current Wheel ZOB dependency graph requires Node `>=22.19.0` and recommends `22.22.3`;
- Pi/Wheel should run under Node 22;
- application installs/tests should run under Node 20 unless the application project changes its own policy.

### 6.3 Clone and pin `jointhewheel` — HUMAN or MODEL-AFTER-HUMAN

```bash
git clone https://github.com/Join-The-Wheel/jointhewheel.git
cd jointhewheel
git fetch origin --tags --prune
git checkout --detach "$JTW_REF"
test "$(git rev-parse HEAD)" = "$JTW_REF"
git status --short
```

Expected: exact SHA match and no dirty files.

This detached checkout is for certification/intake. Story implementation should occur in an explicitly approved branch/worktree created from the admitted base—not by accumulating work on the detached checkout.

### 6.4 Install application dependencies under Node 20 — MODEL-LOCAL after checkout approval

```bash
nvm exec 20.19.0 npm ci
nvm exec 20.19.0 npm --prefix frontend ci
```

Do not copy `node_modules` from another machine and do not substitute `npm install` for deterministic certification.

### 6.5 Clone, pin, and validate ZOB under Node 22

```bash
cd ..
git clone "$ZOB_REPO_URL" zob-harness
cd zob-harness
git fetch origin --tags --prune
git checkout --detach "$ZOB_REF"
test "$(git rev-parse HEAD)" = "$(git rev-parse "$ZOB_REF")"
nvm exec 22.22.3 npm ci
nvm exec 22.22.3 npm run doctor:wheel-zob:ci
nvm exec 22.22.3 npm run check -- --pretty false
nvm exec 22.22.3 npm run smoke:wheel-zob-pack
nvm exec 22.22.3 npm run smoke:wheel-zob-extension
nvm exec 22.22.3 npm test
python3 docs/zob/validation/validate_contracts.py
python3 docs/zob/validation/validate_documentation.py
```

Stop on any failure.

### 6.6 Install the exact Pi host — HUMAN-ONLY package trust

```bash
nvm use 22.22.3
npm install --global --ignore-scripts \
  @earendil-works/pi-coding-agent@0.80.7
pi --version
```

Pi packages/extensions execute with the user’s permissions. A human must review and trust the exact pinned source before loading it.

### 6.7 Choose temporary or project-pinned loading

#### Temporary evaluation — preferred before an adapter PR

From the `jointhewheel` root, load only the reviewed Wheel extension from the development checkout:

```bash
nvm exec 22.22.3 pi \
  -ne \
  -e /absolute/path/to/zob-harness/packages/wheel-zob-pack/extension.ts \
  --provider openai-codex \
  --model gpt-5.6-sol \
  --thinking high
```

`-ne` disables automatically discovered extensions for this run, preventing conflicts with an older globally installed `zob-harness`; the explicit `-e` then loads the reviewed Wheel extension. This avoids writing a machine-specific package path into `jointhewheel/.pi/settings.json`. Omitting `-ne` is safe only after verifying that no other loaded package registers conflicting ZOB tools/commands.

#### Durable project install — only in the reviewed adapter PR

After a Wheel-enabled npm release exists:

```bash
cd /path/to/jointhewheel
nvm exec 22.22.3 pi install -l "npm:zob-harness@$ZOB_VERSION"
```

Pinned Git alternative:

```bash
nvm exec 22.22.3 pi install -l \
  "git:github.com/cgarrot/zob-harness@$ZOB_REF"
```

`-l` writes project settings and may install missing packages after project trust. Review the resulting `.pi/settings.json` diff. Do not commit a machine-specific absolute local path. Clean-machine release certification must exercise the selected immutable install form; when both npm and Git forms are supported, test both.

### 6.8 Authenticate providers — HUMAN-ONLY

Provider authentication is not required for deterministic CLI validation/simulation, but an interactive model conversation requires an available model.

Inside Pi:

```text
/login
/model
```

Authenticate/select only the approved account and route. Never paste tokens into chat or source.

Fireconnect is optional for current preview, disabled initialization, and deterministic-fake supervision because those paths make no provider calls. If future live provider dispatch is implemented and piloted, follow the pinned Fireconnect setup in [`18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md`](18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md) and require a human spend cap.

GitHub read inspection requires operator authentication:

```bash
gh auth login
gh auth status
```

Operator `gh` authentication is not a substitute for future least-privilege GitHub Apps.

### 6.9 Trust and verify the Pi resources — HUMAN-ONLY trust, then MODEL-LOCAL checks

Launch Pi from the `jointhewheel` root. Review the exact project and package before accepting the trust prompt.

Inside Pi, use only zero-effect checks:

```text
/wheel-zob pools
/wheel-zob simulate installation-check
/wheel-zob supervisor-plan pr3853-full docs/operations/fleet-v5/zob/pr3853-machine-bundle.json
/wheel-zob supervisor-init pr3853-disabled docs/operations/fleet-v5/zob/pr3853-machine-bundle.json reports/wheel-zob/supervisor/pr3853-disabled disabled
/wheel-zob plan-machine pr3853-w1 W1 docs/operations/fleet-v5/zob/pr3853-machine-bundle.json
```

Use `W1` through `W6` and a distinct mission ID for the selected machine. Expected:

- `/wheel-zob` exists;
- six pools are reported;
- simulation completes with all external-effect and activation flags false;
- `supervisor-plan` reports all W1–W6 stories and every effect flag false;
- `supervisor-init ... disabled` writes only body-free durable state and does not schedule attempts;
- `plan-machine` reports the selected machine’s allocation/story/human-gate scope with dispatch disabled;
- no provider turn starts and nothing appears on GitHub.

When loading the extension explicitly with `-e`, do not run `/reload` unless the project/package installation is also configured to reload the same exact source; a reload can replace or duplicate the temporary extension set.

A model working inside this Node 22 Pi session must execute application commands through the project’s Node 20 environment, for example:

```bash
nvm exec 20.19.0 npm run type-check
nvm exec 20.19.0 npm test
```

If the Pi subprocess cannot see `nvm`, the human must configure an approved `mise`/`asdf` wrapper or source the local version-manager initialization. Do not change the application’s Node policy silently.

## 7. Copy-paste prompts for Pi

Each prompt states its authority. Do not remove the stop conditions.

### 7.1 Prompt A — PR 3853 readiness audit

- **Available now:** yes, read-only, assuming `gh` is authenticated.
- **Edits:** none.
- **Purpose:** determine what is stale or blocked before implementation.

```text
Read AGENTS.md first and follow the repository’s current instructions.

Inspect JointheWheel PR #3853 read-only. Treat head
404ca9196a6f9546440f38f0146fc7951b09d4f0 as dated planning evidence, not as
merged runtime authority. Compare it with the exact current local checkout.

Read and cross-check:
- docs/operations/reviews/2026-07-17-full-codebase-review/FLEET-V5-V6-BACKLOG.md
- docs/operations/reviews/2026-07-17-full-codebase-review/FLEET-V5-ALLOCATION.md
- scripts/model-bakeoff/routing/allocation-plan-v5.json
- scripts/model-bakeoff/routing/story-signals-v5.json
- every referenced CARD.md
- current code, board, dependency, open-PR, and merged-PR evidence

Do not use the legacy Fleet v4 allocation or the separate 17-story Fleet v5
Codex/Claude/Pi launch plan as a substitute for PR 3853.

Reconcile and report:
1. 59 allocation units versus 60 signal/card records;
2. every story ID/path alias, including W4-B/W4-C;
3. stale dependencies and already-merged prerequisite PRs;
4. acceptance/non-goal/source-line drift;
5. human checkpoints and secret/security-sensitive stories;
6. current individual PR checks, including Gitleaks;
7. develop versus required develop-staging branch policy;
8. whether complete zob.story-execution.v1 manifests and a mission bundle exist.

Do not edit files, expose suspected secret bodies, checkout the PR, create
branches/PRs, commit, push, merge, deploy, activate providers, or initiate
additional provider/model calls beyond this current human-authorized Pi turn.
Return GO or BLOCKED with exact evidence refs, unresolved human decisions, and
the smallest next implementation slice.
```

### 7.2 Prompt B — reproduce or revise the bounded adapter locally

- **Separate supervised-development exemption:** this is ordinary repository maintenance in an already authorized coding session, not Fleet operation and not permission to invoke `/wheel-zob run`, `run-machine`, or `start-local-machine`.
- **Available now:** only after a human separately approves that coding session, branch/worktree, and exact write paths; the development implementation in §5.3 is the current baseline.
- **Edits:** approved adapter/tests/docs paths only.
- **External effects:** provider-backed Fleet commands, commit, push, and GitHub effects are forbidden.

```text
Read AGENTS.md and the approved Wheel ZOB adapter contracts before editing.

Reproduce, review, or revise the smallest JointheWheel Fleet v5 -> Wheel ZOB
adapter slice in this approved local branch/worktree. Start from the existing
§5.3 implementation when present; do not create a parallel converter. Source
input must be pinned local files at the exact admitted repository SHA; do not
fetch mutable PR bodies as runtime input.

The adapter must:
- parse the PR 3853-derived backlog, allocation, signals, and referenced cards;
- normalize schema types and documented aliases;
- produce an explicit reconciliation record for all 60 cards and 59 allocation
  units;
- stop for a human ruling rather than guessing any unresolved mapping;
- materialize complete zob.story-execution.v1 manifests only after mappings are
  resolved;
- hash source/bundle/gate references;
- type dependencies and reject cycles, missing hard dependencies, duplicates,
  stale refs, and unsupported fields;
- keep credential/prompt/private-session bodies out of generated artifacts;
- add focused unit, negative, drift, and collision tests;
- preserve the mandatory develop-staging policy rather than weakening it.

Use Node 20.19.0 for JointheWheel commands and the separately pinned Node 22
checkout for Wheel ZOB validation. Make surgical edits only. Do not change
branch protection, workflows, GitHub, provider configuration, or credentials.
Do not commit or push.

Finish with changed paths, exact validation output, unresolved human decisions,
risks, and an explicit no-GitHub-mutation/no-provider-activation-or-dispatch/
no-deploy statement.
```

### 7.3 Prompt C — materialize and validate the local mission bundle

- **Available now:** after the adapter and human reconciliation decisions exist.
- **Edits:** reviewed generated output paths only.
- **Launch:** no.

```text
Read AGENTS.md. Use only the exact pinned local Fleet v5 source files and the
reviewed adapter. Verify the current git SHA and expected source hashes first.

Materialize the Fleet v5 ZOB outputs into the approved generated-output
location. Then:
1. prove every canonical card has exactly one disposition;
2. prove every allocation unit maps to the approved story or composite decision;
3. prove there are no unassigned, duplicate, missing, or cyclic stories;
4. run wheel_zob_validate_story for every generated story manifest;
5. run wheel_zob_preview_mission for the exact bundle;
6. run plan-machine for W1 through W6 against the generated machine bundle;
7. report allocation/story counts, DAG summary, human gates, public seed
   commitment, and all validation commands/results.

Do not call /wheel-zob run, dispatch models, create GitHub resources, commit,
push, merge, deploy, or access credentials. Stop on any drift or ambiguity.
```

### 7.4 Prompt D — skeptical oracle review

- **Available now:** after any adapter/manifest change.
- **Edits:** none.

```text
Act as a skeptical read-only oracle for the JointheWheel Fleet v5 Wheel ZOB
integration. Read AGENTS.md, the changed adapter/tests/docs, exact source Fleet
artifacts, generated manifests, mission preview, and visible validation output.

Try to disprove readiness. Check schema compatibility, 59/60 reconciliation,
ID aliases, dependency completeness/cycles, base SHA binding, develop-staging
policy, human-gate coverage, body/secret safety, legacy-plan confusion, package
pinning, Node-version handling, external-effect claims, and validation freshness.

Return PASS, WARN, or FAIL; no_ship true/false; blocking issues; evidence refs;
and exact rerun commands. Do not edit, authenticate, mutate GitHub, activate,
commit, push, merge, deploy, or initiate additional provider/model calls or
spend beyond this current human-authorized review turn.
```

### 7.5 One-machine PR 3853 queue preview

- **Available now:** deterministic preview after adapter drift validation and all-machine planning pass.
- **Provider-backed implementation handoff:** unavailable for operational use pending source/workspace enforcement.
- **Effects:** none.

From the `jointhewheel` root, use the zero-effect preview:

```text
/wheel-zob plan-machine pr3853-w1 W1 docs/operations/fleet-v5/zob/pr3853-machine-bundle.json
```

Replace both `pr3853-w1` and `W1` for W2–W6. The validated allocation is:

| Machine | Allocation units | Canonical stories |
|---|---:|---:|
| W1 | 11 | 11 |
| W2 | 10 | 10 |
| W3 | 9 | 9 |
| W4 | 11 | 11 |
| W5 | 9 | 10 |
| W6 | 9 | 9 |

W5 has ten stories because the one `W4-B/W4-C` allocation unit explicitly materializes both canonical source stories. The command validates all 60 stories before selecting one machine and reports that machine’s human gates. If any prerequisite belongs to another machine, verify its artifact or report blocked; do not implement the peer story.

`plan-machine` reports the selected list without dispatch. The implemented `run-machine` shape is not the durable per-story scheduler, crash-recovering supervisor, or six-machine fanout and must not be used operationally until the source/workspace gate is fixed.

### 7.6 Full-bundle durable disabled supervisor

- **Available now:** in the reviewed development worktree.
- **Application source edits:** none.
- **Provider/network/GitHub/commit/push/merge/deploy effects:** none.
- **Purpose:** exercise scheduling, recovery, model-role routing, repair/review, fake workspace/PR/CI, and PR-close evidence for the exact bundle.

```text
/wheel-zob supervisor-plan pr3853-full docs/operations/fleet-v5/zob/pr3853-machine-bundle.json
/wheel-zob supervisor-run-fake pr3853-full docs/operations/fleet-v5/zob/pr3853-machine-bundle.json reports/wheel-zob/supervisor/pr3853-full
/wheel-zob supervisor-status reports/wheel-zob/supervisor/pr3853-full
```

Use the CLI `supervisor-validate` command for structural persisted-state validation. Stop at human gates; only a human may supply a full receipt hash to `supervisor-resolve-human`. Restart with the exact same mission, bundle, and state path. See document 20 for the complete stop/recovery procedure.

### 7.7 One-story validation smoke

- **Available now:** validate/preview only, after one valid repo-local story manifest exists.
- **Provider-backed implementation handoff:** unavailable for operational use pending source/workspace enforcement.

Validate and preview:

```text
/wheel-zob validate docs/operations/fleet-v5/zob/stories/<story-id>.json
/wheel-zob plan fleet-v5-smoke docs/operations/fleet-v5/zob/stories/<story-id>.json
```

Do not follow the preview with `/wheel-zob run` for an operational story until the source/workspace gate is fixed and independently reviewed.

### 7.8 Two-to-three-story local pilot — blocked

Do not run a provider-backed multi-story pilot until the source/workspace enforcement gate is fixed, the one-story validation smoke passes, and a human approves the exact set. Future commands must use explicit repo-relative paths rather than globs. Never admit all 59 allocation units as the first pilot.

## 8. Human decision checklist

A human must provide or resolve each item explicitly.

### Before adopting the development adapter artifacts

- [ ] Which ZOB repository and exact release are canonical?
- [ ] Is PR 3853 still the intended Fleet source after subsequent merges?
- [ ] Does the owner accept the implemented 59-unit/60-story reconciliation?
- [ ] Does the owner accept `W4-B/W4-C` as one allocation unit that materializes two canonical stories?
- [ ] Which stale PR dependencies should be removed, replaced, or retained as artifact evidence?
- [ ] Is the Gitleaks failure a real secret incident or false positive, and what remediation is required?
- [ ] Which durable branch/PR should receive the reviewed development-worktree changes?

### Before package/project installation

- [ ] Has the exact Pi package source been reviewed?
- [ ] Is the package pinned to an immutable version/SHA?
- [ ] May `.pi/settings.json` be changed and committed by the adapter PR?
- [ ] Are project trust and local package trust approved?
- [ ] Which provider/account may Pi use?
- [ ] What spend cap and expiry apply, if any?
- [ ] Has `gh` authentication been performed without exposing credentials?

### Before local story execution

- [ ] Which low-risk story is the one-story smoke?
- [ ] Is its manifest complete and valid?
- [ ] Are acceptance/non-goals/current source refs reviewed?
- [ ] Are all hard/stack dependencies included?
- [ ] Are any human checkpoint or security-sensitive conditions unresolved?
- [ ] Is the checkout clean and based on the admitted SHA?
- [ ] If a provider-backed model will run, are the approved route, spend cap, and expiry still current?
- [ ] Is source-edit authority explicit for this story?

### Before any GitHub pilot

- [ ] Is the durable disabled supervisor released, clean-machine certified, independently reviewed, and structurally green?
- [ ] Are real provider/workspace/GitHub brokers implemented and pilot-validated behind live-mode gates?
- [ ] Are dedicated least-privilege Apps installed and permission-tested?
- [ ] Are branch protection and required Checks correct?
- [ ] Is `develop-staging` present and proven non-deploying?
- [ ] Is a dedicated non-production/test repository being used first?
- [ ] Is model spend approved and capped?
- [ ] Does the activation receipt name factory, repository, stories, effects, caps, and expiry?
- [ ] Is rollback tested?
- [ ] Is fresh oracle verdict PASS/no-ship false?

### Before promotion or deployment

- [ ] Did a human start the frozen assurance/promotion window?
- [ ] Is the exact candidate/staging SHA current?
- [ ] Did every required assurance lane pass on that exact revision?
- [ ] Is canonical documentation fresh with no stale/pending public elements?
- [ ] Is the promotion PR tree/parent shape correct?
- [ ] Did a human authorize the exact-head promotion merge and acknowledge deployment impact?
- [ ] Is automatic CD triggered only by the audited `develop` merge?
- [ ] Is there no manual `workflow_dispatch` deployment path?

No model, label, comment, Check, prior approval, or “go” message may fabricate these receipts.

## 9. Validation ladder

### 9.1 ZOB checkout

```bash
nvm exec 22.22.3 npm run doctor:wheel-zob:ci
nvm exec 22.22.3 npm run check -- --pretty false
nvm exec 22.22.3 npm run validate:wheel-zob-model-registry
nvm exec 22.22.3 npm run validate:wheel-zob-fleet-v5
nvm exec 22.22.3 npm run smoke:wheel-zob-pack
nvm exec 22.22.3 npm run smoke:wheel-zob-extension
nvm exec 22.22.3 npm run wheel-zob -- simulate clean-machine-check
nvm exec 22.22.3 npm run wheel-zob -- supervisor-plan pr3853-full <machine-bundle.json>
nvm exec 22.22.3 npm run wheel-zob -- supervisor-validate <reports/wheel-zob/supervisor/state-dir>
nvm exec 22.22.3 npm test
python3 docs/zob/validation/validate_contracts.py
python3 docs/zob/validation/validate_documentation.py
git diff --check
```

### 9.2 `jointhewheel` adapter checkout

Run under the application’s Node 20.19.0 policy:

```bash
node scripts/wheel-zob/materialize-fleet-v5.mjs --check
npm run validate:wheel-zob-fleet-v5-adapter
```

Then, from the reviewed Node 22 ZOB checkout, run `plan-machine` for W1 through W6 against:

```text
docs/operations/fleet-v5/zob/pr3853-machine-bundle.json
```

Every plan must report top-level `planned=true` and `publicPlan.dispatchEnabled=false`; the aggregate counts must be 59 allocation units and 60 canonical stories. Also run:

- all-story schema/dependency/cycle validation through the six machine previews;
- Pi RPC command-registration smoke with automatically discovered extensions disabled and the exact Wheel extension explicitly loaded;
- TypeScript check and Wheel pack/extension smoke in the ZOB checkout;
- relevant `jointhewheel` repository checks for the touched script/docs surfaces;
- CodeScene review for touched application code (the current materializer and test score 10.0);
- diff/secret hygiene without printing suspected secret bodies;
- independent oracle review.

A passing adapter check or 10.0 Code Health score does not authorize commit, package release, GitHub mutation, or live factory activation.

### 9.3 Pilot order

Follow the sequence in [`14-VALIDATION_AND_PILOTS.md`](14-VALIDATION_AND_PILOTS.md) only after the source/workspace and atomic commit gates are implemented and independently reviewed. At present, stop after deterministic zero-effect evidence:

1. deterministic local fixtures;
2. one-story local implementation smoke;
3. independent oracle;
4. one low-risk real GitHub pilot in a bounded test environment;
5. 2–3 story dependency/concurrency pilot;
6. staging-merge pilot in a repository without deployment credentials;
7. assurance pilot;
8. promotion/automatic-CD simulation with no real deployment;
9. another-machine install/recovery;
10. fresh security/oracle review;
11. explicit activation receipt.

Installation is not activation.

## 10. Monitoring, stopping, and recovery

### 10.1 Implemented bounded `/wheel-zob run` and `/wheel-zob run-machine` — operationally blocked

These commands can hand one explicit story set to one current Pi turn and do not persist queue position. Do not invoke them for an operational story until source/workspace enforcement is fixed and independently reviewed. If a maintainer exercises them in an isolated implementation test, treat provider use/spend as a real effect, monitor the current Pi session and workspace, stop with the session’s controlled interrupt, and never treat the result as launch certification.

### 10.2 Current durable disabled supervisor

The disabled/fake path exposes mission/source hashes, active/completed/needs-human/dependency-blocked stories, ownership epochs, journal/checkpoint freshness, zero-cost budget state, synthetic workspace/PR/Check metadata, and PR-close evidence.

Monitor with:

```text
/wheel-zob supervisor-status <state-dir>
```

Validate with CLI:

```bash
npm run wheel-zob -- supervisor-validate <state-dir>
```

To stop, use a controlled foreground interrupt. Every event is fsynced before projection advancement. Restart with the exact same mission ID, bundle, and state directory; the supervisor verifies journal lineage, replays the tail, renews/takes over the owner lease, fences stale epochs, and resumes deterministic IDs. Never hand-edit or truncate state. Full procedures are in document 20.

### 10.3 Future live adapters

The live implementation must expose:

- mission/run ID;
- current source and candidate SHAs;
- active/queued/blocked/needs-human stories;
- leases/worktrees/sandboxes;
- budget and provider status;
- GitHub effect/outbox status;
- checkpoint/journal freshness;
- oracle/no-ship posture;
- controlled pause/stop/takeover/rollback.

The current supervisor already replays durable local state. Future live adapters must additionally reconcile external truth idempotently. They must never infer completion from a prior model response or simulation.

## 11. Troubleshooting

### `/wheel-zob` is unknown in `jointhewheel`

1. Confirm Pi runs under Node 22.22.3.
2. For development evaluation, relaunch with `-ne -e /absolute/path/to/zob-harness/packages/wheel-zob-pack/extension.ts` from §6.7.
3. For a durable install, run `pi list` and inspect the package source/pin.
4. Verify the loaded release’s Pi manifest includes the Wheel extension.
5. Confirm the project/package was trusted.
6. Run `/wheel-zob pools`.
7. If using only `zob-harness@0.16.0`, stop: that published manifest lacks the Wheel extension.

### Explicit `-e` loading reports duplicate ZOB tools

An older globally installed `zob-harness` was auto-loaded alongside the development checkout. Relaunch with `-ne` plus the exact Wheel extension file as shown in §6.7. Do not ignore conflict diagnostics; a partially loaded mixed-version runtime is not valid evidence.

### Package installation changes `.pi/settings.json`

That is expected with `pi install -l`. Use temporary `pi -e /absolute/path/to/zob-harness` for evaluation, or make the exact package pin an intentional reviewed adapter-PR change.

### Node version errors

- Pi/Wheel host: Node 22.22.3.
- `jointhewheel`: Node 20.19.0.
- Run application checks through `nvm exec 20.19.0 ...` or an approved equivalent.
- Do not solve the mismatch by changing `.nvmrc` incidentally.

### `/wheel-zob validate` rejects a PR 3853 file

Expected: PR 3853 provides planning/signals/cards, not `zob.story-execution.v1`. Build and review the adapter; do not rename the source JSON and pretend it is a story-execution manifest.

### Manifest fails on `schemaVersion`, arrays, or branch policy

Expected until the adapter normalizes signals and the human resolves branch architecture. Do not weaken required fields or replace `develop-staging` with `develop` merely to obtain a green validator.

### The model starts the wrong Fleet

Stop if it reads:

- the Fleet v4 W1–W8/269-story allocation;
- `scripts/model-bakeoff/routing/allocation-plan.json` instead of `allocation-plan-v5.json`;
- the separate 17-story Codex/Claude/Pi Fleet v5 setup as PR 3853 authority;
- a mutable PR body instead of the admitted merged bundle.

Restart with Prompt A and exact evidence paths.

### Simulation passes but nothing happens on GitHub

Expected. Simulation hard-disables GitHub writes, merge, workflow dispatch, deployment, and provider activation.

### PR 3853’s aggregate checks look green but Gitleaks is red

Inspect individual checks. Any required red/unknown/cancelled check blocks admission even if an aggregate job succeeded.

### `develop-staging` is missing

That is a human architecture/rollout blocker. Do not create it or patch the validator from a normal story run.

### A model asks for an API key or secret file

Stop. A human performs approved login/configuration through provider tooling or the organization’s secret store. Do not paste values into Pi, reports, commands, manifests, or source.

## 12. PR 3853 allocation snapshot

This is evidence for reconciliation, not a launch manifest.

| Worker | Allocation units |
|---|---|
| W1 | SR-002, SR-003, SH-003, SH-006, SH-004, BH-001, BH-002, BH-004, BH-006, BH-009, BH-010 |
| W2 | SR-007, SH-002, SH-012, SH-005, SH-009, BH-003, BH-005, BH-008, BH-007, FH-004 |
| W3 | SR-004, E1-P1-WRONGACCOUNT, E1-P2-ADDTOSPACE, E1-P2-KEYGRANT, E1-P3-INGEST-ROUTING, E1-P3-CORE, E1-P3-GUESTZONES, E4-P3-APPROVAL, D39-summary |
| W4 | SR-001, SR-005, SH-010, SH-011, SH-014, E2-F1-STUDIO, E2-F2-CONSOLIDATION, E3-P4-WORKSPACE, DEPART-LINKS-001, D40, FH-006 |
| W5 | SR-006, W3-A-CLIENT-CORE, W2-SIZES-STAGE, W4-A-WIDGET-ROUTES-PWA, W4-B/W4-C, W5-B, ED-4, BF-P40, FH-001 |
| W6 | SH-001, SH-007, SH-008, SH-013, BF-MCP-SETUP, C21, FH-002, FH-003, FH-005 |

Recompute this allocation after PR reconciliation. Do not assume these 59 units remain current merely because the file still exists.

## 13. Final go/no-go gate

### Bounded local evaluation may proceed when

- [ ] exact ZOB source is reviewed and available locally;
- [ ] Pi loads `/wheel-zob` from that exact source;
- [ ] Node 22/20 separation is working;
- [ ] `/wheel-zob pools` passes;
- [ ] disabled simulation passes with every external-effect flag false;
- [ ] deterministic materialization and all six `plan-machine` previews pass;
- [ ] no claim is made that PR 3853 has been admitted to a live factory or launched on GitHub.

### Provider-backed one-story or one-machine implementation remains blocked until

- [ ] initial run/start atomically enforces active-workspace equality to the admitted source;
- [ ] status, recovery, local-ready, and handoff reinspect actual workspace root, branch, and HEAD;
- [ ] the machine-to-story worktree bridge is implemented and hash-preserving;
- [ ] Wheel authority is loaded and validated atomically before any commit effect;
- [ ] negative tests prove stale, fabricated, expired, or drifted bindings create no effect;
- [ ] provider route, account, spend cap, purpose, and expiry are explicitly approved;
- [ ] a fresh independent oracle returns PASS/no-ship false.

### Full Fleet launch remains blocked until

- [ ] Wheel-enabled ZOB is released and clean-machine certified;
- [ ] PR 3853 is reconciled, green, reviewed, and merged;
- [ ] the 59/60 discrepancy and aliases are resolved;
- [ ] the development adapter and `run-machine` changes are reviewed, committed, released, and clean-machine certified;
- [ ] branch/staging architecture is installed and proven non-deploying;
- [ ] the durable disabled supervisor is reviewed, released, and clean-machine certified;
- [ ] real provider/application-workspace/GitHub integrations are implemented and live-mode gated;
- [ ] least-privilege Apps and negative permission tests pass;
- [ ] one-story and multi-story pilots pass;
- [ ] crash/restart/rollback are proven;
- [ ] a fresh oracle returns PASS/no-ship false;
- [ ] a human signs the exact activation receipt.

### Promotion/deployment remains human-gated forever

Even after factory activation, every final promotion requires the separately specified human-started assurance window and exact-head promotion-merge/deployment-impact authorization. No prompt in this guide authorizes deployment.
