# ZOB Harness

**ZOB Harness is a local-first Pi harness for agentic engineering.**

It turns a chat-style coding assistant into a safer engineering loop: explicit contracts, bounded specialist agents, mode-aware tools, evidence-gated completion, skeptical oracle review, and repeatable software-factory workflows.

The philosophy is simple:

```text
Intent
-> Contract
-> Preflight
-> Explore
-> Plan
-> Bounded Implement
-> Evidence
-> Oracle
-> Ledger
-> Repeatable Factory
```

ZOB is not trying to make agents wild or invisible. It is built around parent-owned control, local artifacts, no-secret rules, and explicit stop conditions.

## Why this exists

Modern coding agents are powerful, but they can drift, overclaim, forget constraints, spawn work without evidence, or mix generated artifacts with source code. ZOB Harness provides a project-local operating layer for Pi that makes agent work easier to audit:

- **Contract-first delegation** — child agents receive a six-part task contract.
- **Modes with intent** — explore, plan, implement, oracle, factory, and orchestrator modes have different tool stances.
- **Safety gates** — destructive commands, secret paths, and unsafe writes are blocked by policy.
- **Specialist agents** — exploration, planning, implementation, QA, oracle, synthesis, factories, and docs stewardship are separate roles.
- **Evidence before completion** — work is not done until commands, artifacts, or explicit blockers prove it.
- **Factories for repeatable work** — repeated workflows can become manifest/checkpoint/sentinel pipelines.
- **Local-first by default** — runtime ledgers and reports stay local unless intentionally published.

## What is included in the public repo

This open-source surface contains the harness code and reusable operating assets:

- `.pi/extensions/zob-harness/` — the main Pi extension.
- `.pi/extensions/zob-child-safety/` — child-agent safety extension.
- `.pi/agents/` — specialist agent definitions.
- `.pi/skills/` — domain-specific operating instructions.
- `.pi/prompts/` — prompt templates.
- `.pi/factories/` — safe factory scaffolds, excluding private local benchmarks.
- `.pi/output-contracts/` — output contract manifests.
- `.pi/capabilities/` — public runtime capability registry.
- `scripts/` — local smoke, validation, audit, and proof helpers. See `scripts/README.md` for the script surface map.
- `SOURCE_INDEX.md` — concise map of tracked source folders and local/generated areas.

The repository intentionally excludes local/private runtime material:

- `docs/` and `plans/` are internal planning/documentation artifacts and are not pushed by default.
- `reports/`, `.pi/sessions/`, `.pi/agent-sessions/`, `.pi/tmp/`, `.pi/logs/`, local coms ledgers, merge queues, and workspace claims are generated local artifacts.
- The private Dokploy benchmark scaffold is excluded from the public repo.

## Requirements

- Node.js **22+**. Node 24 is recommended.
- npm.
- Pi packages installed from npm through this repo's dependencies.
- A terminal environment where `pi` is available after `npm install`.

## Quick start

```bash
git clone https://github.com/cgarrot/zob-harness.git
cd zob-harness
npm install
npm run check -- --pretty false
```

Start Pi with the ZOB harness loaded:

```bash
npm run pi
```

Run a lightweight offline extension check:

```bash
npm run pi:check
```

Run the main TypeScript check used by CI:

```bash
npm run check:ci
```

## Core commands inside Pi

Once Pi starts with this harness, the common workflow commands are:

- `/zmode` — switch between `explore`, `plan`, `implement`, `oracle`, `factory`, and `orchestrator`.
- `/stop` — abort current foreground work, session-local background delegations, daemon loop, and runtime-goal auto-continuation without shutting down Pi.
- `/contract` — insert a six-part delegation contract.
- `/agents` — list available specialist agents.
- `/goal` — create or manage a runtime goal with evidence-gated completion.
- `/goal todo` or `/todo` — manage goal-linked TODO trees.
- `/goal_gate` — set a scope anchor for dispatch.
- `/compute` or `/effort` — preview and resolve compute profiles.
- `/zcompact` — configure proactive context compaction (`observe`, `on`, `off`, `status`, `threshold`, `target`, `fraction`, `trigger`).
- `/zcommit` — governed commit workflow (`status`, `plan`, `commit`, `push`, `autocommit on|off`, `autopush on|off`) with no aliases; autocommit/autopush default to off in `.pi/git-policy.json`.

## The six-part task contract

Delegated work should be explicit and bounded:

```text
1. TASK: [atomic goal]
2. EXPECTED OUTCOME: [observable deliverable/verdict]
3. REQUIRED TOOLS: [allowed tools only]
4. MUST DO: [positive constraints]
5. MUST NOT DO: [hard stops]
6. CONTEXT: [paths, prior evidence, downstream use]
```

This contract is the core of the harness. It makes delegation reviewable and gives child agents a clear stop condition.

## Operating loop

For non-trivial work, use:

```text
Explore -> Plan -> Implement -> Oracle
```

- **Explore** maps the repo and gathers facts without editing.
- **Plan** turns facts into a bounded implementation and validation ladder.
- **Implement** changes the smallest safe file set.
- **Oracle** performs skeptical review and decides whether no-ship blockers remain.

The orchestrator mode can coordinate goals, TODO graphs, and specialist work, but it does not bypass safety or evidence gates.

## Validation

Minimal validation:

```bash
npm run check -- --pretty false
```

CI validation:

```bash
npm run check:ci
```

A small set of public validation scripts is kept in `package.json`. Broader one-off proof, promotion, benchmark, and internal smoke scripts are intentionally kept out of the public Git surface. Some public smoke commands may write generated artifacts under `reports/`; those outputs are ignored and are not part of the source surface.

## Safety posture

ZOB Harness is designed to fail closed around sensitive actions:

- No `.env`, private key, SSH, AWS, or credential reads.
- No destructive commands such as recursive deletion, hard reset, git clean, broad process kills, or privileged operations without explicit approval.
- No commits unless the user explicitly asks or governed autocommit is explicitly policy-authorized for the current task.
- Commit/push/tag actions are governed by `.pi/skills/zob-commit/SKILL.md` and `.pi/git-policy.json`; agents must use `/zcommit` only, preserve unrelated dirty files, require Conventional Commits and validation evidence, and keep autocommit/autopush off by default.
- No raw prompt/output bodies in coms or telemetry ledgers by default.
- Generated runtime artifacts stay local and are ignored.

The safety policy is implemented in `.pi/damage-control-rules.json` and in the child-safety extension.

## Project status

This is an early open-source release of a project-local harness. Some advanced workflows are intentionally conservative:

- local-first by default;
- no unrestricted autonomy target;
- no production writes without human approval;
- no external private benchmark data in the public repo;
- generated proof/report artifacts are excluded from source control.

## Contributing

Contributions should preserve the harness philosophy: small changes, explicit evidence, no hidden side effects, no secret access, and no logic drift during cleanup/refactor work.

See `CONTRIBUTING.md` for the expected workflow.

## License

MIT.
