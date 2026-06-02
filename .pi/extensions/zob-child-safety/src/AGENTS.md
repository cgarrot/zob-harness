# zob-child-safety src guardrails

Modules in this folder are split-only support modules for the safety-critical child safety extension.

- Move helpers/types/policy/path code only; do not rewrite logic or optimize behavior.
- Never import from `../index.ts` or `../index.js`.
- Keep imports NodeNext-compatible with `.js` suffix for relative runtime imports.
- Prefer `import type` for type-only imports.
- Do not change blocked messages, default rules, path matching, env parsing, validation ordering, or return shapes.
- Keep safety helpers deterministic and side-effect-free unless an existing side effect is explicitly being moved unchanged.
