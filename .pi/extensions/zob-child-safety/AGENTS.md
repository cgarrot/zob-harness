# zob-child-safety extension guardrails

This folder is safety-critical. Changes here must be split-only unless the owner explicitly approves behavior changes.

- Preserve the Pi entrypoint in `index.ts` and keep the default export stable.
- Do not change event names, registration order, safety messages, default rules, path policy, env parsing, or sync/async behavior.
- Preserve public exports from `index.ts`.
- Use NodeNext relative imports with `.js` suffix.
- Prefer `import type` for type-only imports.
- Do not import from `index.ts` inside `src/**`.
- Do not read or write secrets, generated output, logs, sessions, or temp ledgers.
- Validate with `npm run check -- --pretty false`, `npm run smoke:path-policy`, and `npm run smoke:harness` after edits.
