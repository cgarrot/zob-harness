# zob-switch src Guardrails

- Modules here are sidecars for `.pi/extensions/zob-switch/index.ts`.
- Move code only; do not rewrite logic, optimize, reorder behavior, rename helpers for behavior changes, or alter strings/schemas/paths.
- Preserve `/zob` command behavior exactly, including settings and snapshot semantics.
- Use NodeNext relative imports with `.js` suffix.
- Use `import type` for type-only imports.
- Never import from `../index.ts` or any `index.ts` entrypoint.
