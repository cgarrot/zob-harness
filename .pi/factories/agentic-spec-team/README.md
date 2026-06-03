# Agentic Spec Team Factory

Status: **v1 scaffold**.

This factory describes the repeatable checkpoint backbone for the Agentic Spec Team workflow. The actual v1 launch surface is `scripts/spec-run.mjs` plus run-scoped ZTeam agents. The factory keeps the process evidence-first, human-question-gated, and oracle-reviewed.

## Safe entrypoints

```bash
npm run spec-run -- init --mission "..." --source docs/ --source data/export.csv
npm run spec-run:auto-pilot -- --mission-file specs/mission.md --source docs/ --source mockups/
```

## What it does

- Defines map/reduce/validate stages for source intake, data/domain/UX analysis, spec synthesis, BDD, handoff, and oracle review.
- Requires traceability from source/answer/assumption to requirement, criteria, task, and oracle check.
- Treats raw sources as `citation_only` or `context_only` until explicitly approved otherwise.
- Blocks completion on open blocking questions.
- Requires final oracle PASS with `no_ship=false`.

## What it does not do in v1

- No runtime `/spec-run` extension command.
- No external durable write/import/sync.
- No automatic answer invention for business decisions.
- No closing tmux on timeout/WARN/FAIL/no_ship=true.

## Local validators

```bash
node scripts/spec-run.mjs validate <run_id>
node scripts/agentic-spec-team/validate-run.mjs <run_id>
node scripts/agentic-spec-team/validate-traceability.mjs <run_id>
```
