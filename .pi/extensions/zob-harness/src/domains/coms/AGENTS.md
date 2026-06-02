# Coms domain guardrail

## Scope

- Hash-only/local communication domains, Mission Control metadata, governed request extraction, topology-facing coms helpers, and coms-v2 compatibility.

## MUST DO

- Preserve hash-only/body-free ledgers, stale/offline peer blockers, bounded awaits, and topology guards.
- Keep Goal Room parent-visible as canonical for coordination decisions.

## MUST NOT

- Do not persist raw prompts, outputs, rationale, diffs, patches, or message bodies.
- Do not introduce hidden worker-to-worker direct chat or network transport.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` plus coms-specific smoke if coms transport paths move.
