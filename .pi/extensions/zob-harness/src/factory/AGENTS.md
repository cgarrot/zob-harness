# Directory scope

- Factory validation, agentic plans, factory execution, and quarantine review/activate/verify.
- This directory must not register Pi tools directly; runtime delegates here.

# Invariants

- Preserve `SMOKE_PASSED.sentinel`, `PILOT_PASSED.sentinel`, `BATCH_PASSED.sentinel`, and `DONE.sentinel`.
- `plan_only` does not create completion sentinels.
- Pilot requires a persisted oracle review and a multi-item manifest.
- Factory-forge quarantine never self-activates.
- Activation refuses overwrite and requires the exact phrase.
- Do not change artifact names, statuses, or validations.

# Imports

- May import utils/safety/output-contracts/telemetry/child-runner as needed.
- Forbidden: importing from `index.ts`.
- Use runtime-relative imports with a `.js` suffix.

# Local validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after any factory/quarantine slice.
