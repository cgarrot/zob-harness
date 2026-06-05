# Directory scope

- `src/**` receives modules extracted from `.pi/extensions/zob-harness/index.ts`.
- Each module must correspond to a clear slice of the refactor playbook.
- This directory does not contain new product functionality.
- Target architecture: `core/**` for low-level helpers/types, `domains/**` for business logic, and `runtime/**` for Pi tool/command/event/widget adapters.

# Invariants

- Move-only: preserve logic, strings, validations, defaults, and observable order.
- Public exports must remain available from `index.ts` until the final switch.
- Avoid cycles; isolate types, constants, and utils before runtime.
- Do not store prompt/output bodies in telemetry/coms.

# Imports

- Use NodeNext relative imports with a `.js` suffix for runtime imports.
- Use `import type` for types.
- Forbidden: importing from `../index.js`, `../../index.js`, or `index.ts`.
- Low-level modules must not depend on Pi runtime.
- Target direction: `runtime -> domains -> core`; a `domains/**` file may depend on `runtime/**` only as explicitly temporary compatibility.

# Local validation

- Read `docs/ZOB_HARNESS_ARCHITECTURE.md` and local `AGENTS.md` files before any move slice.
- `npm run check -- --pretty false` after each slice.
- `npm run smoke:harness` after safety, output-contracts, queue, topology, orchestration, factory, child-runner, or runtime changes.
- `npm run pi:check` before declaring a complete runtime change.
- Read-only oracle review before moving to the next slice when a public API is touched.
