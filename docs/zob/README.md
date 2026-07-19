# Wheel ZOB System — Documentation Index

- **Status:** Deterministic validation/preview, launch-plan preparation, and durable disabled/deterministic-fake supervision are locally validated; provider-backed operational run/start, Wheel story commit, live GitHub effects, and production activation remain unavailable
- **Updated:** 2026-07-20
- **Canonical home:** `zob-harness/docs/zob/`
- **Scope:** Current zero-effect Fleet v5 validation, deterministic mission preview, body-free launch-plan preparation, disabled supervisor validation, and the explicit source/workspace/worktree/atomic-commit gates required before future provider-backed sessions or GitHub adapters.

The generic runtime and bounded Wheel AgentOps pack now share this repository. They remain separate dependency/authority layers; repository consolidation does not permit generic runtime code to hard-code Wheel policy.

## Start here

1. [`WHEEL_FLEET_V5_MULTI_MACHINE_OPERATOR_GUIDE.html`](WHEEL_FLEET_V5_MULTI_MACHINE_OPERATOR_GUIDE.html) — literal owner walkthrough for separate physical machines, immutable waves, moving `develop-staging` heads, current source/worktree/commit no-ship gaps, and the PR #3817/#3853/#3859 disposition
2. [`WHEEL_ZOB_RUNTIME_MACHINE_SETUP.html`](WHEEL_ZOB_RUNTIME_MACHINE_SETUP.html) — user-readable zero-effect machine setup plus current provider-backed run/start no-ship boundary
3. [`18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md`](18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md) — canonical Markdown source for the corrected generic setup guide
4. [`19-JOINTHEWHEEL_FLEET_V5_OPERATOR_GUIDE.md`](19-JOINTHEWHEEL_FLEET_V5_OPERATOR_GUIDE.md) — PR 3853 materialization, deterministic W1–W6 preview, disabled supervisor entry points, clean-machine limits, and current no-ship gates
5. [`21-FLEET_V5_LOCAL_MACHINE_LAUNCH_AND_PR_HANDOFF.md`](21-FLEET_V5_LOCAL_MACHINE_LAUNCH_AND_PR_HANDOFF.md) — general reconcile/select contract, current source/worktree/atomic-commit blockers, and future handoff requirements
6. [`20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md`](20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md) — current durable disabled/fake setup, status, stop, human-gate, restart, recovery, and activation boundary
7. [`WHEEL_ZOB_TERMINAL_MANUAL.html`](WHEEL_ZOB_TERMINAL_MANUAL.html) — interactive terminal manual and capability mock
8. [`01-SYSTEM_OVERVIEW.md`](01-SYSTEM_OVERVIEW.md)
9. [`02-ARCHITECTURE_AND_OWNERSHIP.md`](02-ARCHITECTURE_AND_OWNERSHIP.md)
10. [`03-STORY_TO_PR_CLOSE_FACTORY.md`](03-STORY_TO_PR_CLOSE_FACTORY.md)
11. [`04-BLIND_REVIEW_FACTORY.md`](04-BLIND_REVIEW_FACTORY.md)
12. [`05-PR_SHIP_FACTORY.md`](05-PR_SHIP_FACTORY.md)
13. [`17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md`](17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md)

## Runtime and governance

- [`06-MISSION_CONTROL_TUI.md`](06-MISSION_CONTROL_TUI.md)
- [`07-PERSISTENCE_AND_RECOVERY.md`](07-PERSISTENCE_AND_RECOVERY.md)
- [`08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md`](08-PERMISSIONS_ACKS_AND_GITHUB_APPS.md)
- [`09-MODEL_AND_PROMPT_EXPERIMENTS.md`](09-MODEL_AND_PROMPT_EXPERIMENTS.md)
- [`10-EXECUTION_PROFILES_AND_SKILLS.md`](10-EXECUTION_PROFILES_AND_SKILLS.md)
- [`11-EVIDENCE_AND_GITHUB_CHECKS.md`](11-EVIDENCE_AND_GITHUB_CHECKS.md)

## Installation and operations

- [`WHEEL_FLEET_V5_MULTI_MACHINE_OPERATOR_GUIDE.html`](WHEEL_FLEET_V5_MULTI_MACHINE_OPERATOR_GUIDE.html) — easiest owner-facing multi-computer launch, wave, moving-head, recovery, integration, and current no-ship-gap walkthrough
- [`WHEEL_ZOB_RUNTIME_MACHINE_SETUP.html`](WHEEL_ZOB_RUNTIME_MACHINE_SETUP.html) — readable HTML setup manual
- [`18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md`](18-WHEEL_ZOB_RUNTIME_MACHINE_SETUP.md) — canonical generic machine setup manual
- [`19-JOINTHEWHEEL_FLEET_V5_OPERATOR_GUIDE.md`](19-JOINTHEWHEEL_FLEET_V5_OPERATOR_GUIDE.md) — `jointhewheel` PR 3853 adapter, bounded per-machine Pi command, disabled supervisor, and human authority guide
- [`20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md`](20-FLEET_V5_DISABLED_SUPERVISOR_RUNBOOK.md) — current activation-disabled durable supervisor operations
- [`21-FLEET_V5_LOCAL_MACHINE_LAUNCH_AND_PR_HANDOFF.md`](21-FLEET_V5_LOCAL_MACHINE_LAUNCH_AND_PR_HANDOFF.md) — general selected-machine local sessions and exact-authority PR handoff
- [`12-INSTALLATION.md`](12-INSTALLATION.md) — broader live supervisor design and still-unimplemented activation work
- [`13-OPERATIONS_RUNBOOK.md`](13-OPERATIONS_RUNBOOK.md)
- [`14-VALIDATION_AND_PILOTS.md`](14-VALIDATION_AND_PILOTS.md)
- [`15-UPGRADE_AND_ROLLBACK.md`](15-UPGRADE_AND_ROLLBACK.md)

## Governance record

- [`16-DECISIONS.md`](16-DECISIONS.md)
- [`ENHANCEMENTS.md`](ENHANCEMENTS.md)
- [`SOURCE_EVIDENCE.md`](SOURCE_EVIDENCE.md)
- [`schemas/`](schemas/README.md)
- [`examples/`](examples/README.md)
- [`validation/validate_contracts.py`](validation/validate_contracts.py) — schema/example/cross-contract/negative-guard validator
- [`validation/validate_documentation.py`](validation/validate_documentation.py) — frozen-scope, link, index, ID/field, staging-policy, privacy and contract suite validator

Run from repository root (requires Python `jsonschema` with Draft 2020-12 support):

```bash
python3 docs/zob/validation/validate_contracts.py
python3 docs/zob/validation/validate_documentation.py
```

## Truth class and maturity state

These are two different dimensions; do not treat them as competing status vocabularies.

### Truth class

- **Current evidence** — verified behavior in cited source artifacts at the stated SHA/date.
- **Approved design** — explicitly selected intended behavior that still requires implementation and validation.
- **Enhancement** — deferred/proposed option with a stable ID; not part of v1 completion unless explicitly marked Promoted and recorded as a decision.

### Maturity state

- **Specified** — described and schema-backed.
- **Implemented** — code exists and has local tests.
- **Validated** — required smoke/pilot/oracle gates passed.
- **Installed** — pinned releases are present on a machine.
- **Activated** — a human activation receipt permits the specified live operation.

**Activation-gated** is an operational constraint, not a maturity claim: even implemented/validated/installed capability remains disabled until its activation receipt exists. Zero-effect Fleet validation/preview/launch-plan preparation and the durable disabled/deterministic-fake supervisor are **Implemented + locally Validated + disabled by default**. Provider-backed handoff commands exist in development but remain operationally blocked by source/workspace gates; application edits, Wheel story commit, GitHub Apps/brokers, branches, merge/CD behavior, and production operation remain unavailable until separately implemented, validated, installed, and activated. Section 01 defines the same maturity ladder.

## Absolute boundary

Nothing in this corpus authorizes provider-backed Fleet run/start, application edits, Wheel story commit, merge, deploy, publish, credential access, or GitHub App installation. Story, Blind Review, Staging Merge, and Final Assurance/Promotion remain design/fake surfaces until independently validated and activated. The design says automatic CD should run from an audited `develop` promotion merge, but this document neither enables nor triggers it.
