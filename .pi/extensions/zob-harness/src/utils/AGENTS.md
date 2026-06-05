# Directory scope

- Pure reusable helpers: records, paths, JSON, hashing, and formatting.
- This directory must not contain Pi runtime, tools, commands, factories, or orchestration logic.

# Invariants

- Preserve error messages, sanitization rules, hashing, and path matching.
- Do not modify `pathMatches`, `safeRunId`, `safeFileStem`, or output-bounding logic unless the task explicitly requires it.
- Keep helpers deterministic unless the source behavior was already nondeterministic.

# Imports

- Allowed: minimal required Node modules (`node:fs`, `node:path`, `node:crypto`, `node:os`) as needed by the helper.
- Forbidden: `ExtensionAPI`, Pi runtime, tools, commands, factories, orchestration.
- Forbidden: importing from `index.ts`.
- Use `.js` for relative imports.

# Local validation

- `npm run check -- --pretty false`.
- If `pathMatches` or child-output formatting changes: `npm run smoke:harness`.
