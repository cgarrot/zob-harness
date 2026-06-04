---
name: zob-factory
description: Use when designing or running repeatable software factories with manifests, checkpoints, validators, sentinels, smoke/pilot/batch gates.
---
# ZOB Factory Skill

## When to use

Use when the task is repeated, batchable, or should become a reusable system rather than a one-off feature.

## Workflow

1. Spec first: define input manifest, outputs, validators, and no-ship rules.
2. Factory design: deterministic scaffolding first, LLM enrichment second.
3. Smoke: one item only.
4. Oracle: require validation evidence before pilot/batch.
5. Pilot: 10 items max with bounded concurrency.
6. Batch: only after pilot sentinel and oracle gate.

## Agent Factory shape

Some factories produce not only code or reports, but a supervised team workflow. Treat these as **Agent Factories**. A safe Agent Factory defines:

- ZAgent roles, prompts, default modes, and allowed authority;
- ZTeam topology, aliases, rooms, entry agent, and `parentVisible` communication policy;
- optional manual tmux launcher with start/attach/status/close only;
- startup kickoff templates or rendered kickoff files passed as `pi @kickoff.md`;
- run artifacts such as `run-manifest.json`, workgraph/status/iteration logs, readiness or kickoff-dispatch records;
- validation and oracle/no-ship gates before completion claims.

Do not treat launching a tmux team as factory success. Success comes from evidence artifacts, validators, and oracle review.

## Required artifacts

- `manifest.json`
- `agentic-plan.json`
- `checkpoints/`
- `outputs/`
- `validation.json`
- phase sentinel (`SMOKE_PASSED.sentinel`, `PILOT_PASSED.sentinel`, or `BATCH_PASSED.sentinel`)
- `DONE.sentinel` only after validation passes

For Agent Factories, also prefer:

- team manifest or generated run-scoped team manifest
- kickoff templates or rendered startup kickoff files
- `autonomous-workgraph.md` / `autonomous-status.md` / `iteration-log.md`
- `kickoff-dispatch.json` or equivalent body-free startup proof
- communication protocol and no-ship policy
