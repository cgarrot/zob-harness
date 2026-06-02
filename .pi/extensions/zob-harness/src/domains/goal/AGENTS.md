# Goal domain guardrail

## Scope

- Goal parsing, runtime goal state, goal TODO graph, TODO imports, and goal-room reducer logic.

## MUST DO

- Preserve parent-owned TODO claim semantics, oracle/no_ship gates, TODO statuses, action names, diagnostics, and evidence refs.
- Preserve runtime goal statuses, activation mode defaults, continuation semantics, and branch restore behavior.
- Keep public exports reachable from `index.ts`.

## MUST NOT

- Do not accept delegated claims without parent-owned evidence/oracle gates.
- Do not bypass goal completion proposal or oracle requirements.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after TODO or runtime-goal moves.
