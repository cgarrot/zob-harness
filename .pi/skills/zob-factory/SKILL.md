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

## Required artifacts

- `manifest.json`
- `agentic-plan.json`
- `checkpoints/`
- `outputs/`
- `validation.json`
- phase sentinel (`SMOKE_PASSED.sentinel`, `PILOT_PASSED.sentinel`, or `BATCH_PASSED.sentinel`)
- `DONE.sentinel` only after validation passes
