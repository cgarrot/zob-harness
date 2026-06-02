# Domains layer guardrail

## Scope

- Domain behavior for goals, delegation, governance, autonomy, coms, context, factory, git, models, orchestration, ProjectDNA, and telemetry.
- Domains should expose typed functions and records; runtime adapters register Pi tools/commands/events.

## MUST DO

- Preserve public names, statuses, artifact refs, schemas, hashes, sentinels, and validation messages.
- Keep domain modules importable by runtime with stable behavior.
- Depend downward on `src/core/**` and sideways only when a domain relationship already exists.

## MUST NOT

- Do not import from `src/runtime/**` unless a file is explicitly marked as a temporary compatibility adapter.
- Do not import from `index.ts` or `index.js`.
- Do not introduce direct production apply, hidden transport, secret reads, or body persistence.

## Validation

- `npm run check -- --pretty false` after every domain move.
- `npm run smoke:harness` after goal, governance, delegation, factory, orchestration, coms, or runtime-facing moves.
