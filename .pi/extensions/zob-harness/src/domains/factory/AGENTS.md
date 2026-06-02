# Factory domain compatibility guardrail

## Scope

- Future home for factory selector and compatibility wrappers around `src/factory/**`.
- Existing `src/factory/AGENTS.md` remains authoritative for factory run/quarantine internals until those files move.

## MUST DO

- Preserve smoke/pilot/batch/DONE sentinel behavior, plan-only posture, oracle review requirements, and artifact names.
- Keep factory runtime registration in `src/runtime/**`.

## MUST NOT

- Do not auto-activate factory quarantine or skip oracle gates.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after factory moves.
