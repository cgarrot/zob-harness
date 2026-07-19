# 01 — System Overview

**Truth class:** Approved design
**Maturity / activation:** Specified only; not implemented; all live factories disabled

## Purpose

Wheel ZOB is a persistent, evidence-first supervisor for turning one or many approved story bundles into trustworthy draft PR outcomes. It replaces fragile “one long agent session” orchestration with a deterministic mission service, typed task graph, bounded model attempts, exact-head evidence, durable human handoffs and a truthful Mission Control UI.

The complete lifecycle is split into independent factories:

```text
Approved story bundle(s)
        │
        ▼
Story → PR-Close Factory
  ordinary PR targets develop-staging
  build + docs + QA + exact-head PR-close evidence
        │ fleet:needs-review
        ▼
Blind PR Review Factory
  independent risk-scaled review
  ├─ findings → Story repair/re-close → fresh review
  └─ clean
        │ blind-review-clean
        ▼
Staging Merge Factory [disabled]
  automatic one-at-a-time squash merge
  + full non-deploying develop-staging integration CI
        │ staged-awaiting-promotion
        ▼
Final Assurance & Promotion Factory [disabled]
  human-started staging freeze
  + full-repository audit → separate repair → full re-audit (≤3 rounds)
  + exact-head promotion PR/authorization
  + merge-commit into develop → automatic CD
```

The first implementation target is the Story factory. Blind Review, Staging Merge and Final Assurance/Promotion are fully specified so their contracts shape v1 correctly, but remain disabled until their own pilots and activation receipts pass. `develop-staging` does not exist as an active integration policy merely because it is specified here.

Current mission `factoryType` tokens are `story-pr-close`, `blind-pr-review`, `staging-merge`, `repository-assurance`, `promotion` and `post-promotion-reconciliation`. `pr-ship` and `post-merge-reconciliation` remain parseable for read-only historical migration only; the Wheel adapter rejects them for new missions and effects.

## Core principles

1. **One logical supervisor, many fresh agents.** Mission truth lives in a deterministic background service, not an LLM’s memory.
2. **Events, not optimistic labels.** “Dispatched” is not “working”; heartbeat is not progress; a worker claim is not accepted completion.
3. **Exact-head evidence.** Every review, validation, CI or completion claim binds to immutable source and policy hashes.
4. **Least authority.** Agents receive task-scoped skills, tools and paths. GitHub mutations are brokered by the supervisor.
5. **Blind assignment.** Orchestrator, workers, QA and reviewers do not know model identity, thinking level or prompt-treatment label.
6. **Parent acceptance.** Builders cannot accept their own work. Risk controls determine independent review.
7. **Durable human handoff.** A question becomes a canonical card and receipt, not an informal session wait.
8. **Reversible progress.** Gates reopen when source/evidence bindings become invalid; the UI explains backward progress.
9. **No hidden scope change.** Technical replanning is visible and bounded. Product, trust, destructive, spend and completion changes require human authority.
10. **Separate factory authority.** Build, formal review, staging merge, repository assurance and develop promotion identities cannot borrow each other’s permissions.

## Version-one topology

- One machine executes agents.
- Portable mission/story/task IDs, manifests, checkpoints and leases prepare for later distribution.
- A local `zobd` service survives Pi/TUI closure and same-machine restart.
- Pi sessions attach through a local Unix socket.
- High-frequency truth remains local; milestone checkpoints synchronize to the dedicated `zob-mission-state` branch in the canonical ZOB repository.
- Exact model/prompt telemetry synchronizes separately and is denied to agent task contexts.

## Inputs

A Story mission accepts:

- one approved story bundle; or
- several approved bundles, including explicit dependencies/stacks.

Bundles may contain existing Wheel gate artifacts. Admission verifies them and begins at the first incomplete or stale gate. Unratified product scope does not self-authorize.

## Outputs

### Story factory

- one draft PR per story, opened at admission;
- canonical execution manifest and revision history on the story branch;
- compact per-task and per-gate evidence;
- current ordinary draft CI status;
- SHA-bound `ZOB / PR Close` Check;
- `fleet:needs-review` handoff;
- no formal approval, ready transition, merge or deployment.

### Blind Review factory

- SHA-bound formal review artifact;
- validated structured findings or `blind-review-clean`;
- reviewer/model/prompt outcome telemetry;
- no source edit, ready transition, merge or deployment.

### Staging Merge factory

- automatic qualified PR ready/squash merge to `develop-staging`;
- one merge at a time and exact-head full staging integration CI;
- no per-PR human merge receipt;
- no merge/write to `develop` and no deployment trigger.

### Final Assurance and Promotion factory

- human-started frozen staging promotion window;
- independent PR #3817-style whole-repository lanes;
- top-down canonical-doc truth plus bottom-up every-element inventory/disposition;
- separate repair PRs and complete re-audit, maximum three rounds;
- exact-head human-authorized merge-commit promotion into `develop`;
- automatic CD only from that develop merge; no manual workflow dispatch.

## Explicit non-goals

Version one does not provide:

- network-distributed agent execution;
- automatic learned routing changes;
- browser Mission Control;
- GitHub webhooks as the primary watcher;
- formal review/staging/promotion activation;
- automatic promotion cadence or break-glass direct-to-develop path;
- deployment confirmation or rollback automation;
- automatic transcript deletion;
- secrets, provider bodies or raw transcript storage in Git.

These items are registered in [`ENHANCEMENTS.md`](ENHANCEMENTS.md).

## Maturity state

- **Specified:** described and schema-backed here.
- **Implemented:** code exists and has local tests.
- **Validated:** required smoke/pilot/oracle gates passed.
- **Installed:** pinned releases are present on a machine.
- **Activated:** a human activation receipt permits live mutations.

No lower state implies a higher one.