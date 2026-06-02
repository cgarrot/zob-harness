# Autonomy domain guardrail

## Scope

- Interactive autonomy readiness, autonomous runtime dry-runs, daemon policy/readiness/runtime, and launch authorization metadata.

## MUST DO

- Preserve clarify/block thresholds, no-ship conditions, readonly/dry-run posture, budget/oracle gates, and launch authorization semantics.
- Treat autonomous smokes as evidence only, not production readiness.

## MUST NOT

- Do not claim global autonomy completion without fresh proof and oracle PASS/no_ship=false.
- Do not enable unsupervised daemon/autonomy behavior by moving files.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- Run relevant autonomy smoke/validation scripts when autonomy behavior moves.
