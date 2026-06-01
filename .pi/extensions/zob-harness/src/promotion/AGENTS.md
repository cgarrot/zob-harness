# Promotion module guardrail

## Scope

- This folder owns promotion candidate metadata, promotion coms refs, and prepared/quarantine artifacts for documentation, temp-agent, factory, and write-lane flows.
- Promotion here is proposal-only unless an explicit human/oracle-approved quarantine path says otherwise; never turn preparation helpers into production apply behavior.

## Safety invariants

- Do not add auto-apply, hidden transport, worker-to-worker direct chat, or production writes.
- Never store prompt/output/body content in promotion metadata; keep body flags false and use hashes/refs only.
- Do not read or reference secrets (`.env`, keys, `~/.ssh`, `~/.aws`) or generated/vendor paths (`node_modules`, `dist`, `build`).
- Preserve public types, schemas, artifact names/refs, status transitions, validation gates, hashes, and parent-owned approval/oracle semantics.

## Refactor rules

- Split-only/no behavior drift: keep strings, defaults, ordering, validation errors, and observable artifacts stable.
- Use NodeNext runtime imports with `.js` suffix and `import type` for type-only imports.
- Do not import from extension `index.ts`/`index.js`.

## Validation

- For any doc-only guardrail change here: `git diff --check` and `npm run check -- --pretty false`.
- For any runtime-facing change in this folder: also run the narrow relevant promotion tests/smokes if available, then `npm run smoke:harness`.
