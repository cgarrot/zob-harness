# Core utils guardrail

## Scope

- Pure reusable helpers: records, paths, JSON, hashing, formatting, and resource path display.
- This folder contains the canonical helper implementations; `src/utils/**` may remain as compatibility wrappers during migration.

## Invariants

- Preserve error messages, sanitization rules, hashing, path matching, and bounded output behavior.
- Do not modify `pathMatches`, `safeRunId`, `safeFileStem`, or child-output formatting semantics during structural moves.
- Keep helpers deterministic unless the original source was not deterministic.

## Imports

- Allowed: minimal Node modules needed by each helper (`node:fs`, `node:path`, `node:crypto`, `node:os`).
- Forbidden: `ExtensionAPI`, Pi runtime, tools, commands, factories, orchestration, `index.ts`/`index.js`.
- Use `.js` suffix for relative imports.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` if path matching or child-output formatting paths move.
