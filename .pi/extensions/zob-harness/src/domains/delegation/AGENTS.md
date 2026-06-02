# Delegation domain guardrail

## Scope

- Agent discovery, child runner support, output contracts, delegation schemas, and child-output gates.

## MUST DO

- Preserve six-part contract validation, child output contract ids, output gate behavior, model override checks, and path policy enforcement.
- Keep child prompt/output bodies out of persisted ledgers unless existing policy explicitly allows a redacted/hash-only artifact.

## MUST NOT

- Do not rename specialist agents, output contract ids, gate markers, or failure-kind strings.
- Do not loosen write-scope, cwd, allowed_paths, forbidden_paths, or secret protections.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after child-runner, output-contract, safety-adjacent, or runtime-facing moves.
