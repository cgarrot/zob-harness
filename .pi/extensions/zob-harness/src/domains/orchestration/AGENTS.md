# Orchestration domain compatibility guardrail

## Scope

- Future home for orchestration domain files and compatibility wrappers around `src/orchestration/**`.
- Existing `src/orchestration/AGENTS.md` remains authoritative for current internals until moved.

## MUST DO

- Preserve plan-only/read-only supervised semantics, parent-owned dispatch, room artifact names, and no child-spawns-child policy.

## MUST NOT

- Do not make plan-only flows produce completion sentinels.
- Do not launch live children from supervised_readonly by moving code.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after orchestration moves.
