# Telemetry domain guardrail

## Scope

- Chronicle classification, queue metadata, telemetry summaries, and body-free runtime evidence records.

## MUST DO

- Preserve completion classifiers, budget preflight dry-run semantics, body-free telemetry, and artifact/ref names.

## MUST NOT

- Do not persist raw prompts, outputs, diffs, patches, or secrets.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after chronicle/queue/runtime-facing moves.
