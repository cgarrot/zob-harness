# Context domain guardrail

## Scope

- Context/GBrain readiness, context scope validation, and writeback proposal helpers.

## MUST DO

- Preserve bounded context, citations, forbidden-source checks, and proposal-only writeback semantics.
- Keep raw conversation/prompt bodies out of persisted metadata.

## MUST NOT

- Do not import/embed/sync/write to external knowledge backends by moving code.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- Run context readiness checks when context behavior moves.
