# 18 — Wheel ZOB Runtime: Machine-by-Machine Setup and Use

**Truth class:** Current zero-effect runtime instructions plus corrected no-ship and future distribution boundaries
**Current runtime scope:** Fleet v5 validation/preview, launch-plan preparation, durable disabled/deterministic-fake scheduling and recovery, routed fake Story → QA → repair → blind review → PR-close loops, and separate in-memory staging/assurance/promotion simulation
**External effects:** zero-effect paths are disabled; provider-backed `run`, `run-machine`, and `start-local-machine` can invoke a model and spend, so operational use is currently blocked
**Production activation:** unavailable and unauthorized

This is the operator-facing setup guide. Follow the section for each machine you intend to use.

## 0. Read this before installing anything

### What works now

The current repository contains an executable, validated Wheel pack with:

- `wheel_zob_validate_story`;
- `wheel_zob_preview_mission`;
- `wheel_zob_simulate_pipeline`;
- `/wheel-zob` inside Pi, including implemented `run`/`run-machine` command shapes that are operationally blocked pending source/workspace enforcement;
- `npm run wheel-zob -- ...` outside Pi, including `plan-machine` plus `supervisor-plan|init|run-fake|status|validate|resolve-human`;
- durable hash-chained journals, atomic checkpoints, ownership epochs, dependency scheduling, and body-free fake workspace/PR/CI/PR-close evidence;
- six verified functional model pools and fixed GPT-5.6 Sol role policy;
- disabled-by-default Story, Blind Review, Staging Merge, Assurance, and Promotion state machines;
- hard-false GitHub, merge, workflow-dispatch, provider-activation, and deployment effects.

### What does not work yet

This pack does **not** currently:

- enforce active-workspace source equality at provider-backed run/start boundaries or reinspect workspace/branch/HEAD at every transition;
- bridge reviewed machine-control edits into the required separate story worktree;
- atomically validate Wheel candidate/authority/lease/diff/path state before a governed commit mutates Git;
- read live Fleet data from `jointhewheel`;
- dispatch model work through the role pools;
- create branches, pull requests, comments, labels, Checks, or merges;
- install or use GitHub Apps;
- change branch protection or CI/CD;
- deploy anything;
- run a production daemon or a live provider/GitHub multi-machine supervisor.

It validates, plans, and simulates. The separate durable supervisor persists/restarts a multi-story mission but uses only disabled or deterministic-fake dispatch/effect adapters. By contrast, `/wheel-zob run`, `run-machine`, and `start-local-machine` queue a Pi model turn and can incur provider spend and application workspace edits. Do not use those commands operationally until source/workspace enforcement is fixed and independently reviewed. Commit, push, GitHub mutation, merge, workflow dispatch, promotion, and deployment remain unavailable.

### Current multi-machine distribution blocker

The implementation is presently in an uncommitted working tree. Therefore:

- the **current machine** can validate, preview, and run disabled/deterministic-fake checks immediately from this checkout;
- a **second machine cannot clone this exact implementation yet**;
- do not point another machine at `origin/main` and assume it contains this runtime;
- first review the changes, then explicitly authorize a governed commit/push or tagged release;
- after that, every machine must pin the exact reviewed commit or tag.

No commit or push is performed by this guide.

## 1. Machine roles

Use these labels consistently:

| Machine | Purpose | Pi required? | Fireconnect/OpenAI auth? | Live effects? |
|---|---|---:|---:|---:|
| `operator-01` | Primary interactive owner/operator workstation | yes | not needed for zero-effect checks; configure locally only after approval | no GitHub/deploy; provider calls are real effects |
| `worker-01`, `worker-02`, … | Additional trusted developer/operator workstations | yes if using Pi; no for CLI-only validation | each person authenticates separately only after approval | no GitHub/deploy; provider calls are real effects |
| `ci-01` | Non-interactive typecheck/test/contract validation | no global Pi; project dependencies only | no | no |
| staging/production host | Future live service or GitHub/CI integration | **do not install yet** | **do not provision yet** | unavailable |

There is no live shared ZOB daemon to install on every machine. Durable disabled supervisor state is local to one trusted checkout and one report directory; each checkout operates independently.

## 2. Version baseline

Use the same baseline on every current machine:

| Component | Required/pinned value |
|---|---|
| OS | supported macOS or Linux |
| Node.js | `22.22.3` recommended; `>=22.19.0` required by the locked dependency graph |
| npm | version bundled with the selected Node 22 release |
| project dependencies | exact versions from `package-lock.json` via `npm ci` |
| project-local Pi dependency | `0.75.5` from the lock file; used for compile/test compatibility, not the GPT-5.6 interactive host |
| interactive Pi host | globally pinned `0.80.7` for current GPT-5.6 Sol catalog support |
| Fireconnect | `v0.8.0` / audited commit `977855aa082bcb7a696b43bc34226d5ff11d0eb1` when Fireworks use is requested |
| Python | Python 3 for documentation/contract validators |
| Python `jsonschema` | Draft 2020-12-capable release; `>=4.25,<5` recommended |

Use the globally pinned Pi `0.80.7` for interactive operation. The locked project-local Pi `0.75.5` is retained for repository tests but does not recognize the current `openai-codex/gpt-5.6-*` catalog. Before publishing this repository as a Pi package, update and re-lock the Pi development dependencies/peer range through a separately reviewed dependency change.

## 3. Common OS prerequisites — every source/validation machine

### 3.1 Install base tools

Install these through your organization-approved package manager:

- Git;
- Node version manager (`nvm`, `mise`, or equivalent);
- Python 3;
- a C/C++ build toolchain required by npm packages;
- `curl` only if you will install Fireconnect from its official source.

macOS also needs Xcode Command Line Tools:

```bash
xcode-select --install
```

Debian/Ubuntu typically needs:

```bash
sudo apt-get update
sudo apt-get install -y git curl python3 python3-venv build-essential
```

### 3.2 Install and select Node

The following assumes `nvm` is already installed from its official repository:

```bash
nvm install 22.22.3
nvm use 22.22.3
node --version
npm --version
```

Expected Node output:

```text
v22.22.3
```

If `nvm` is unavailable, install Node using your approved tool and confirm the exact version is at least `22.19.0`.

### 3.3 Optional Python validator environment

Create this outside the repository:

```bash
python3 -m venv "$HOME/.venvs/wheel-zob-docs"
source "$HOME/.venvs/wheel-zob-docs/bin/activate"
python -m pip install --upgrade pip
python -m pip install 'jsonschema>=4.25,<5'
python -c 'import jsonschema; print(jsonschema.__version__)'
```

You only need this environment for the Python documentation and schema validators.

## 4. `operator-01` — primary workstation

### 4.1 Use the current checkout on the current machine

From the existing repository:

```bash
cd /path/to/zob-harness
npm ci
npm run doctor:wheel-zob
```

Do not run `npm install`; use `npm ci` so the lock file is authoritative.

A successful baseline doctor report contains:

```json
{
  "schema": "wheel.zob.machine-doctor.v1",
  "mode": "source",
  "valid": true,
  "scope": "local source, manifest, registry, and explicitly requested CLI presence only",
  "externalEffectsEnabled": false
}
```

The baseline doctor does not require Fireconnect or inspect provider/auth configuration. It does not claim to prove network or credential behavior.

### 4.2 Install Fireconnect v0.8.0 if this machine will use Fireworks models in Pi

Fireworks authentication is **not required** for Wheel validation, mission preview, disabled initialization, deterministic-fake supervision, or simulation because those paths do not call providers. Configure it only if this workstation will also use Fireworks models through Pi.

Review the official source before installation. Pin and verify the immutable audited commit **before** executing its installer:

```bash
export FIRECONNECT_COMMIT="977855aa082bcb7a696b43bc34226d5ff11d0eb1"
git clone https://github.com/fw-ai/fireconnect.git "$HOME/.fireconnect/cli" && \
  git -C "$HOME/.fireconnect/cli" checkout --detach "$FIRECONNECT_COMMIT" && \
  test "$(git -C "$HOME/.fireconnect/cli" rev-parse HEAD)" = "$FIRECONNECT_COMMIT" && \
  bash "$HOME/.fireconnect/cli/install.sh" && \
  export PATH="$HOME/.local/bin:$PATH" && \
  fireconnect --version
```

Expected version is `v0.8.0`. If the commit comparison fails, do not run the installer.

### 4.3 Authenticate Fireworks separately on this machine

Never paste an API key into this repository, a command transcript, or a shared chat.

Run:

```bash
fireconnect login
fireconnect pi on
fireconnect pi status
```

Use the guided browser/key prompt. In keychain mode Fireconnect stores the credential in the OS keychain and configures Pi through an environment reference. It snapshots the prior Pi configuration under `~/.fireconnect/pi/`.

Restart Pi after `fireconnect pi on`.

To undo Fireconnect’s Pi changes and restore the snapshot:

```bash
fireconnect pi off
```

Do not copy `~/.fireconnect/`, `~/.pi/agent/auth.json`, or OS-keychain data between machines.

After Fireconnect is installed, you may check only its CLI presence through the doctor:

```bash
export WHEEL_ZOB_FIRECONNECT_BIN="$(type -P fireconnect)"
npm run doctor:wheel-zob -- --providers
```

Authentication/routing state remains a separate explicit `fireconnect pi status` check.

### 4.4 Install Pi 0.80.7 and authenticate OpenAI Codex separately

Install the current interactive Pi host globally and verify the exact executable before login:

```bash
npm install --global @earendil-works/pi-coding-agent@0.80.7
export WHEEL_ZOB_PI_BIN="$(type -P pi)"
"$WHEEL_ZOB_PI_BIN" --version
cd /path/to/zob-harness
"$WHEEL_ZOB_PI_BIN"
```

Inside Pi:

```text
/login
```

Select **ChatGPT Plus/Pro (Codex)** and complete the OAuth flow. Pi stores and refreshes the token in the local user auth store. Do not copy that file to another machine.

To select the fixed Wheel orchestrator route in a session:

```text
/model
```

Choose:

```text
openai-codex/gpt-5.6-sol
```

Set thinking to high using Pi’s thinking control.

You can also start the verified global Pi explicitly on Sol:

```bash
"$WHEEL_ZOB_PI_BIN" --provider openai-codex --model gpt-5.6-sol --thinking high
```

After login, run the interactive/provider-aware doctor without reading auth files:

```bash
WHEEL_ZOB_PI_BIN="$(type -P pi)" \
WHEEL_ZOB_FIRECONNECT_BIN="$(type -P fireconnect)" \
npm run doctor:wheel-zob -- --interactive --providers
```

Fireconnect and OpenAI Codex can coexist. Fireconnect may change the default provider, but OpenAI Codex remains selectable after its separate OAuth login.

### 4.5 Trust and load the project extensions

Always launch the verified global Pi from the repository root:

```bash
cd /path/to/zob-harness
WHEEL_ZOB_PI_BIN="$(type -P pi)"
"$WHEEL_ZOB_PI_BIN"
```

When Pi asks whether to trust the project, review the checkout and approve only the exact pinned source you intend to run. Project extensions execute with your user permissions.

Inside Pi, reload once after installation or source updates:

```text
/reload
```

The project package manifest loads:

- `.pi/extensions/zob-switch/index.ts`;
- `.pi/extensions/zob-harness/index.ts`;
- `.pi/extensions/wheel-zob-pack/index.ts`.

### 4.6 Confirm the Wheel command exists

Inside Pi:

```text
/wheel-zob pools
```

Expected summary:

- six pools;
- minimum pool size at least five;
- fixed orchestrator family `OpenAI-GPT-5.6`;
- high thinking;
- no route identities stored in public output.

If `/wheel-zob` is unknown, see troubleshooting §12.

### 4.7 Run the complete local validation ladder

In a separate terminal at repository root:

```bash
npm run doctor:wheel-zob
npm run check -- --pretty false
npm run validate:wheel-zob-model-registry
npm run validate:wheel-zob-fleet-v5
npm run smoke:wheel-zob-pack
npm run smoke:wheel-zob-extension
npm run wheel-zob -- simulate installation-check
```

For the full repository suite:

```bash
npm test
```

For documentation/contract validation, activate the Python environment first:

```bash
source "$HOME/.venvs/wheel-zob-docs/bin/activate"
python3 docs/zob/validation/validate_contracts.py
python3 docs/zob/validation/validate_documentation.py
```

Do not proceed if any command fails.

## 5. First use — exact commands

### 5.1 Inspect the configured pools

Terminal:

```bash
npm run wheel-zob -- pools
```

Pi:

```text
/wheel-zob pools
```

This validates the static routing registry. It does not call a provider.

### 5.2 Validate one Fleet v5 story manifest

Use the included safe example first.

Terminal:

```bash
npm run wheel-zob -- validate \
  docs/zob/examples/story-execution.example.json
```

Pi:

```text
/wheel-zob validate docs/zob/examples/story-execution.example.json
```

A real input must be a repo-relative JSON file inside the trusted checkout. The intake blocks absolute paths, traversal, private session paths, environment/credential/key names, and symlink escapes.

The current pack has no live `jointhewheel` Fleet adapter and does not ingest mutable PR data. It can consume reviewed, sanitized Fleet v5 story manifests and a `wheel.zob.fleet-v5-machine-bundle.v1` produced inside an application checkout by a separate source-bound adapter. Do not point the pack at live PR text and do not copy secrets or raw private session data into either repository.

### 5.3 Build a deterministic public mission preview

Terminal:

```bash
npm run wheel-zob -- plan demo-mission \
  docs/zob/examples/story-execution.example.json
```

Pi:

```text
/wheel-zob plan demo-mission docs/zob/examples/story-execution.example.json
```

The public plan contains hashes/commitments rather than protected model route identities. `dispatchEnabled` remains false.

### 5.4 Simulate the full factory lifecycle

Terminal:

```bash
npm run wheel-zob -- simulate demo-mission
```

Pi:

```text
/wheel-zob simulate demo-mission
```

Expected final stages:

| Factory | Expected simulation stage |
|---|---|
| Story | `needs-review` |
| Blind Review | `clean` |
| Staging Merge | `complete` |
| Repository Assurance | `passed` |
| Promotion | `complete` |

The result must still show:

```text
activationEnabled=false
externalEffects=false
githubWrites=false
merge=false
workflowDispatch=false
deployment=false
providerActivation=false
```

A successful simulation is not a real PR, merge, assurance run, promotion, or deployment.

### 5.5 Validate or preview one story or a dependency-aware set

Use only zero-effect validation and preview for operational evidence:

```text
/wheel-zob validate path/to/story.json
/wheel-zob plan <mission-id> path/to/story.json [path/to/dependency.json ...]
```

`/wheel-zob run` is implemented, but it queues a Pi model turn that can invoke the selected provider, incur spend, and edit the active checkout. Do not execute it for an operational story until the runtime atomically proves that the active workspace matches the admitted source and reinspects workspace/branch/HEAD at later transitions. Human selection alone does not close that code-level gate.

### 5.6 Preview one explicit source-bound machine assignment

Preview the selected machine without starting an agent turn:

```bash
npm run wheel-zob -- plan-machine \
  <mission-id> \
  <machine-id> \
  path/to/machine-bundle.json
```

The preview verifies the bundle’s allocation/signals hashes and deterministic bundle hash, every machine and story assignment, every story ID/path, all story manifests, dependency completeness, and cycles. A combined allocation unit may explicitly map to multiple canonical stories; none may be silently dropped.

`/wheel-zob run-machine` is implemented but operationally blocked. It queues one provider-backed implementation turn in the current checkout; it does not start six Pi processes or a persistent queue. Do not execute it until active-workspace source enforcement and transition-time reinspection are implemented, negative-tested, and independently reviewed. Commit, push, GitHub mutation, provider-pool dispatch, merge, promotion, and deployment remain forbidden.

See [`19-JOINTHEWHEEL_FLEET_V5_OPERATOR_GUIDE.md`](19-JOINTHEWHEEL_FLEET_V5_OPERATOR_GUIDE.md) for the PR 3853 bundle path, exact W1–W6 counts, temporary development loading command, and human-authority gates.

### 5.7 Run the durable activation-disabled supervisor

Plan all machine assignments without writing state:

```bash
npm run wheel-zob -- supervisor-plan <mission-id> path/to/machine-bundle.json
```

Initialize body-free state with scheduling/effects disabled:

```bash
npm run wheel-zob -- supervisor-init \
  <mission-id> \
  path/to/machine-bundle.json \
  reports/wheel-zob/supervisor/<mission-id> \
  disabled
```

Exercise the complete control plane through deterministic fakes:

```bash
npm run wheel-zob -- supervisor-run-fake \
  <mission-id> \
  path/to/machine-bundle.json \
  reports/wheel-zob/supervisor/<mission-id>

npm run wheel-zob -- supervisor-status reports/wheel-zob/supervisor/<mission-id>
npm run wheel-zob -- supervisor-validate reports/wheel-zob/supervisor/<mission-id>
```

Fake mode makes zero provider/network/credential/repository/GitHub effects and incurs zero spend. It may stop at `needs-human`; a human can supply one exact hash-only fake-run receipt with `supervisor-resolve-human`, then rerun the same mission. Restart after interruption with the exact same source-bound arguments and state directory.

See [`20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md`](20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md) for setup, stop, restart, ownership recovery, validation, rollback posture, and the explicit live-activation stop.

## 6. `worker-01` and additional developer/operator machines

Do not copy the current working directory blindly and do not share credentials.

### 6.1 Wait for a reviewed commit/tag

Another machine requires both values:

```bash
export ZOB_REPO_URL="https://github.com/cgarrot/zob-harness.git"
export ZOB_REF="<reviewed-commit-or-tag>"
```

`<reviewed-commit-or-tag>` does not exist for the current uncommitted work yet. It must be created through the governed review/commit/release process first.

### 6.2 Clone and pin after a commit/tag exists

```bash
git clone "$ZOB_REPO_URL" zob-harness
cd zob-harness
git fetch --tags --prune
git checkout --detach "$ZOB_REF"
git rev-parse HEAD
npm ci
npm run doctor:wheel-zob
```

Record the exact `git rev-parse HEAD` value in your machine inventory. Every operator machine must report the same commit.

### 6.3 Decide whether the machine needs provider credentials

- **CLI-only validation/simulation:** no Fireworks or OpenAI login required.
- **Interactive Pi but no provider calls:** Pi can load commands, but ordinary agent conversation still needs some selected model/provider.
- **Fireworks use:** repeat §4.2–4.3 locally.
- **OpenAI Codex use:** repeat §4.4 locally.
- Never transfer credentials from `operator-01`.

### 6.4 Validate the machine

Run the same §4.7 ladder. Do not call the machine ready because the files merely exist.

### 6.5 Start Pi

Install/verify global Pi `0.80.7` as in §4.4, then:

```bash
cd /path/to/zob-harness
WHEEL_ZOB_PI_BIN="$(type -P pi)"
"$WHEEL_ZOB_PI_BIN"
```

Review/trust the pinned checkout, run `/reload`, then test `/wheel-zob pools` and `/wheel-zob simulate worker-check`.

## 7. `ci-01` — non-interactive validation host

The CI host validates source only. It must not authenticate providers or activate effects.

### 7.1 Environment

Use a clean checkout pinned to the reviewed commit/tag and Node 22:

```bash
export CI=true
export GIT_TERMINAL_PROMPT=0
node --version
git rev-parse HEAD
npm ci
```

### 7.2 CI validation commands

```bash
npm run doctor:wheel-zob:ci
npm run check -- --pretty false
npm run validate:wheel-zob-model-registry
npm run validate:wheel-zob-fleet-v5
npm run smoke:wheel-zob-pack
npm run smoke:wheel-zob-extension
npm run wheel-zob -- simulate ci-check
npm test
```

Required release/documentation validation:

```bash
python3 -m pip install 'jsonschema>=4.25,<5'
python3 docs/zob/validation/validate_contracts.py
python3 docs/zob/validation/validate_documentation.py
```

A release CI job is incomplete if these documentation/contract checks are omitted.

### 7.3 CI prohibitions

Do not configure on `ci-01`:

- `fireconnect login`;
- `/login` OAuth;
- provider keys;
- GitHub App private keys;
- merge/deployment credentials;
- production branches or workflow mutation.

The CI job should fail on any validation error and publish only safe test output/artifact references.

## 8. Staging and production machines — do not install a live runtime yet

There is currently no approved procedure for installing this pack as a live staging/production service.

Do **not**:

- create a `zobd` service;
- provision GitHub Apps;
- create or protect `develop-staging` because of this pack;
- enable automatic staging merges;
- configure deployment credentials;
- turn simulation transitions into real effects;
- share provider credentials with a service account.

A future production phase requires application adapters in `jointhewheel`, durable state/checkpoints, least-privilege credentials, branch/CI integration, rollback evidence, pilots, and a fresh independent oracle.

## 9. Keeping machines identical

For every trusted machine, record:

```bash
node --version
npm --version
git rev-parse HEAD
npm run doctor:wheel-zob
```

On interactive operator machines also record the global host explicitly:

```bash
WHEEL_ZOB_PI_BIN="$(type -P pi)"
"$WHEEL_ZOB_PI_BIN" --version
WHEEL_ZOB_PI_BIN="$WHEEL_ZOB_PI_BIN" npm run doctor:wheel-zob -- --interactive
```

Also record locally, without copying secrets:

```bash
fireconnect --version
fireconnect pi status
```

Inside Pi, record the Pi version and confirm `/wheel-zob pools` works.

Machine parity means the same:

- reviewed Git commit/tag;
- `package-lock.json`;
- Node major/version policy;
- Wheel doctor result;
- validation results.

It does not mean shared auth files or copied keychains.

## 10. Updating a machine after a reviewed release

Stop active Pi sessions first. Preserve or intentionally resolve every local change before switching revisions:

```bash
cd /path/to/zob-harness
git status --short
```

If this prints anything, stop and preserve/review the work; do not overwrite it. When clean:

```bash
git fetch --tags --prune
git checkout --detach <new-reviewed-commit-or-tag>
npm ci
npm run doctor:wheel-zob
npm run check -- --pretty false
npm run validate:wheel-zob-model-registry
npm run validate:wheel-zob-fleet-v5
npm run smoke:wheel-zob-pack
npm run smoke:wheel-zob-extension
npm run wheel-zob -- simulate upgrade-check
npm test
python3 docs/zob/validation/validate_contracts.py
python3 docs/zob/validation/validate_documentation.py
```

Start Pi and run:

```text
/reload
/wheel-zob pools
/wheel-zob simulate upgrade-check
```

Never use an unpinned moving branch as a durable machine installation.

## 11. Rollback and local removal

### 11.1 Roll back source

Check and preserve local work first:

```bash
cd /path/to/zob-harness
git status --short
```

If clean, roll back and rerun the full bounded validation ladder:

```bash
git checkout --detach <previous-reviewed-commit-or-tag>
npm ci
npm run doctor:wheel-zob
npm run check -- --pretty false
npm run validate:wheel-zob-model-registry
npm run validate:wheel-zob-fleet-v5
npm run smoke:wheel-zob-pack
npm run smoke:wheel-zob-extension
npm run wheel-zob -- simulate rollback-check
npm test
python3 docs/zob/validation/validate_contracts.py
python3 docs/zob/validation/validate_documentation.py
```

### 11.2 Disable Fireconnect routing for Pi

```bash
fireconnect pi off
```

This restores the files Fireconnect snapshotted before enabling Pi.

### 11.3 Remove OpenAI OAuth locally

Inside Pi use `/logout` and select the OpenAI Codex credential to remove. Do not delete unrelated provider credentials.

### 11.4 Remove the checkout

Only remove a checkout after preserving any required reports and confirming no worktree is active. Do not use broad destructive cleanup commands from this guide.

## 12. Troubleshooting

### `/wheel-zob` is unknown

1. Confirm you are at repository root.
2. Run `npm ci`.
3. Run `npm run doctor:wheel-zob`.
4. Confirm `package.json` lists `.pi/extensions/wheel-zob-pack/index.ts`.
5. Confirm global `pi --version` is `0.80.7` and start that executable from this repository root.
6. Review/trust the project.
7. Run `/reload` inside Pi.

### `fireconnect: command not found`

```bash
export PATH="$HOME/.local/bin:$PATH"
fireconnect --version
```

If it still fails, rerun the reviewed pinned Fireconnect installer in §4.2.

### Fireworks is not active in Pi

Close/restart Pi around configuration changes:

```bash
fireconnect login
fireconnect pi on
fireconnect pi status
```

Then restart the verified global Pi executable from the repository root.

### OpenAI Codex is unavailable

Inside Pi:

```text
/login
```

Select ChatGPT Plus/Pro (Codex), complete OAuth, then use `/model` to choose `openai-codex/gpt-5.6-sol`.

### Doctor fails on Node

```bash
nvm use 22.22.3
node --version
npm ci
npm run doctor:wheel-zob
```

### Story path is rejected

The file must be a normal repo-relative file inside the trusted checkout. Absolute paths, `..`, session/env/credential/key paths, and symlink escapes are intentionally rejected.

### Mission preview shows no identities

That is expected. Public mission output intentionally stores route hashes rather than protected model identities.

### Simulation completes but nothing appears on GitHub

That is expected. The current runtime has only disabled/deterministic-fake GitHub-effect brokers; all external-effect flags remain false.

## 13. Per-machine acceptance checklists

### `operator-01`

- [ ] trusted pinned source checkout
- [ ] Node 22 selected
- [ ] `npm ci` passed
- [ ] `npm run doctor:wheel-zob` valid
- [ ] provider authentication performed locally only if needed
- [ ] project trusted in Pi
- [ ] `/reload` completed
- [ ] `/wheel-zob pools` works
- [ ] Wheel smoke and TypeScript checks pass
- [ ] example validate/plan/simulate commands pass
- [ ] supervisor-plan and disabled supervisor-init pass for the reviewed bundle
- [ ] deterministic-fake persisted state validates when that test is in scope
- [ ] no production or real GitHub/provider effect enabled

### each additional operator/worker

- [ ] exact same reviewed commit/tag as `operator-01`
- [ ] independent `npm ci` and doctor pass
- [ ] no copied auth/keychain files
- [ ] local provider login only if needed
- [ ] same validation ladder passes
- [ ] no production or GitHub effect enabled

### `ci-01`

- [ ] detached/pinned reviewed commit
- [ ] Node 22
- [ ] `npm ci`
- [ ] `npm run doctor:wheel-zob:ci` valid
- [ ] full required tests pass
- [ ] no provider or production credentials
- [ ] no live effects

## 14. Authoritative references

- Pi package installation and project-local settings: <https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md>
- Pi extension auto-discovery, trust, and `/reload`: <https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md>
- Pi provider login: <https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md>
- Fireconnect Pi integration: <https://docs.fireworks.ai/ecosystem/fireconnect/pi>
- Fireconnect overview: <https://docs.fireworks.ai/ecosystem/fireconnect/overview>
- Fireconnect source: <https://github.com/fw-ai/fireconnect>
- Local runtime map: [`../../reports/wheel-runtime-evidence/runtime-map.md`](../../reports/wheel-runtime-evidence/runtime-map.md)
- Independent oracle: [`../../reports/wheel-runtime-evidence/oracle-review.md`](../../reports/wheel-runtime-evidence/oracle-review.md)
