# Core layer guardrail

## Scope

- Pure shared utilities, constants, and low-level types for the ZOB harness extension.
- This layer should be safe to import from any domain or runtime adapter.

## MUST DO

- Keep helpers deterministic unless the original helper was not deterministic.
- Preserve hashing, path matching, formatting, JSON parsing, and validation error behavior.
- Use NodeNext `.js` suffix for relative runtime imports.
- Prefer `import type` for type-only imports.

## MUST NOT

- Do not import from `../runtime/**`, `../domains/**`, `index.ts`, or `index.js`.
- Do not register Pi tools, commands, events, widgets, factories, or orchestration here.
- Do not read secrets or generated/vendor folders.

## Validation

- `npm run check -- --pretty false` after every core move.
- `npm run smoke:harness` if path, formatting, hashing, or body-free behavior changes location.
