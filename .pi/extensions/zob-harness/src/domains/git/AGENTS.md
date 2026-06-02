# Git domain guardrail

## Scope

- Governed zcommit/git policy helpers and child dirty-path tracking.

## MUST DO

- Preserve `/zcommit` governance, explicit user-request requirement, no direct global staging, owned-path tracking, and policy smoke expectations.

## MUST NOT

- Do not introduce direct `git commit`, `git push`, `git tag`, force push, `git add .`, or `git add -A` behavior.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:git-ops` after git helper moves.
- `npm run smoke:harness` if runtime-facing behavior moves.
