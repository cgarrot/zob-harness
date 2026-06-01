# ZOB Harness Source Index

This file is the human-facing map of the tracked source surface. It is intentionally small and should stay current when public source folders change.

## Core package files

- `README.md` — project overview and quick start.
- `AGENTS.md` — project-local operating rules for agents.
- `CONTRIBUTING.md` — contributor workflow and validation expectations.
- `SECURITY.md` — security policy.
- `package.json` — npm scripts, package metadata, Pi extension/prompts/skills wiring.
- `tsconfig.json` — TypeScript configuration.

## Pi harness source

- `.pi/extensions/zob-harness/` — main Pi extension.
- `.pi/extensions/zob-child-safety/` — child-agent safety extension.
- `.pi/capabilities/` — public runtime capabilities registry.
- `.pi/agents/` — specialist agent definitions.
- `.pi/skills/` — domain-specific operating instructions.
- `.pi/prompts/` — prompt templates.
- `.pi/output-contracts/` — output contract manifests.
- `.pi/factories/` — reusable factory scaffolds that are safe for source control.
- `.pi/chains/` — read-only/plan-only chain definitions.
- `.pi/orchestrations/` — reusable orchestration profiles.
- `.pi/teams/` — reusable team topology profiles.
- `.pi/rules/` — rule packs.
- `.pi/compute-profiles/` — compute profile defaults and risk rules.

## Scripts

See `scripts/README.md` for the script surface map.

## Local/generated areas

These are intentionally local/generated and should not be committed by default:

- `docs/` — legacy/internal docs for now; future curated docs should be recreated intentionally.
- `plans/` — captured planning artifacts.
- `reports/` — generated reports and evidence.
- `.pi/tmp/`, `.pi/logs/`, `.pi/sessions/`, `.pi/agent-sessions/` — runtime local state.
- `.pi/coms/`, `.pi/context/`, `.pi/goal-rooms/`, `.pi/workspace-claims/`, `.pi/worker-pools/`, `.pi/merge-queue/` — generated ledgers/coordination state.

## Cleanup rule

Before moving, deleting, or committing a local/generated file, classify it first in a report under `reports/zob-cleanup-lanes/` and keep no-ship blockers visible.
