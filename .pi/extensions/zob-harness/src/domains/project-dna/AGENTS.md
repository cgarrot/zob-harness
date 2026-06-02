# ProjectDNA domain guardrail

## Scope

- ProjectDNA query, federated query, workflow planning helpers, schemas, and writeback proposals.

## MUST DO

- Preserve read-only scan artifact usage, bounded cited context, proposal-only writeback, and quarantine/output path policy.

## MUST NOT

- Do not scan external projects, import/sync/embed/write to backends, or promote ProjectDNA learnings by moving code.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- Run relevant `validate:project-dna*`/smoke scripts when ProjectDNA behavior moves.
