# Directory scope

- This directory contains the `zob-harness` Pi extension, its `index.ts` entrypoint, and sidecar modules for split-only refactors.
- `index.ts` remains the Pi entrypoint declared in `package.json` until an explicit final switch is approved.
- `src/**` subdirectories contain only extracted logic or local context; they do not replace the entrypoint without review.
- The target architecture and refactor instructions are documented in `docs/ZOB_HARNESS_ARCHITECTURE.md` and local `AGENTS.md` files.

# Invariants

- Split-only: move code without changing observable behavior.
- Preserve the `default export` `zobHarness(pi)`.
- Preserve every public export used by `scripts/harness-smoke.mjs`.
- Do not change tool names, commands, event handlers, sentinels, artifacts, error messages, TypeBox descriptions, prompt snippets, or guidelines.
- Do not change observable array order or runtime defaults.
- Do not convert synchronous `fs` operations to async.

# Imports

- In NodeNext, use relative imports with a `.js` suffix.
- `index.ts` may remain hybrid during migration.
- No `src/**` file may import from `index.ts`.
- Prefer `import type` for types.
- Target dependency direction: `runtime -> domains -> core`; never `core -> domains/runtime`.

# Local validation

- Baseline before a slice: `npm run check -- --pretty false`.
- After any code slice: `npm run check -- --pretty false`.
- After a domain/runtime slice: `npm run smoke:harness`.
- Before the final switch: `npm run check:all` and read-only oracle review.
