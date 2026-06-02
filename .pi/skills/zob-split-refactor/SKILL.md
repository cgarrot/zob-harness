---
name: zob-split-refactor
description: Use when splitting a monolithic ZOB/Pi TypeScript extension into modules without behavior changes. Enforces split-only moves, export compatibility, local AGENTS.md context, and smoke validation.
---
# ZOB Split Refactor

## Use when

- Splitting `.pi/extensions/zob-harness/index.ts` or another monolithic ZOB/Pi TypeScript extension.
- Moving one bounded block into a sidecar module.
- Verifying exports/imports/circularity after a split-only slice.

## Rules

- Move code; do not rewrite logic.
- Preserve public exports from `index.ts`.
- Keep the Pi entrypoint and `default export` stable until an explicit final barrel switch is approved.
- Use NodeNext relative imports with `.js` suffix, e.g. `./utils/paths.js`.
- Never import `index.ts` from `src/**`.
- Do not rename tools, commands, event handlers, sentinels, artifacts, schemas, prompt strings, error messages, or output contract ids.
- Do not change array order, defaults, validations, sync/async behavior, `Date.now()`, `new Date()`, or `Math.random()` semantics.
- Read the nearest `AGENTS.md` before editing a folder.

## Slice workflow

1. Read `docs/ZOB_HARNESS_ARCHITECTURE.md` once for the phase.
2. Read the local `AGENTS.md` for the target folder.
3. Read only the relevant `index.ts` range and already-extracted modules.
4. Move a bounded block with minimal import/export changes.
5. Validate with `npm run check -- --pretty false`.
6. For domain/runtime slices, also run `npm run smoke:harness`.
7. Ask a read-only oracle to check equivalence before continuing.

## Stop conditions

- A slice requires importing from `src/**` back into `index.ts` without approval.
- A `src/**` file would import from `index.ts`.
- Typecheck failure requires behavior changes instead of import/export fixes.
- Any public export, registration, sentinel, artifact path, schema description, or error string would change.
