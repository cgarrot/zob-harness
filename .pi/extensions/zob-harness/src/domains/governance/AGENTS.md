# Governance domain guardrail

## Scope

- Safety policy, rules, budget gates, sandbox metadata, workspace claims, worker pools, and merge queue records.

## MUST DO

- Preserve path policy, secret protection, no destructive behavior, parent-owned merge/apply semantics, and hash-only metadata.
- Keep sandbox/apply helpers proposal-only unless the original gated path explicitly required approval.

## MUST NOT

- Do not introduce auto-apply, direct git commit/push, hidden worker chat, or raw body persistence.
- Do not weaken allowed_paths/forbidden_paths validation.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after safety, sandbox, workspace, worker-pool, or merge-queue moves.
