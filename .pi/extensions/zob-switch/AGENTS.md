# zob-switch Extension Guardrails

- This folder owns the `/zob` Pi switch extension only.
- Keep `.pi/extensions/zob-switch/index.ts` as the stable Pi entrypoint and preserve its default export.
- Split-only refactors are allowed; do not change `/zob` behavior, command registration, aliases/autocomplete behavior, messages, settings paths, snapshot paths, schemas, defaults, or sync/async behavior.
- Use NodeNext relative imports with `.js` suffix.
- Use `import type` for type-only imports.
- No file under `src/` may import from `index.ts`.
- Do not touch secrets, generated/vendor folders, logs, sessions, reports, or unrelated extensions from this package.
