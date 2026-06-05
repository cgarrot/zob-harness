# Directory scope

- Orchestration plan-only, supervised smoke/read-only, room artifacts, and widget readers.
- This directory does not contain Pi registrations; runtime exposes the tools.

# Invariants

- `plan_only` must never write `DONE.sentinel`.
- `supervised_smoke` launches no live child.
- `supervised_readonly` remains parent-owned and read-only.
- Redacted plans and `.pi/coms` mirrors must remain identical.
- Preserve artifact names, statuses, and error messages.

# Imports

- May import topology, safety, output-contracts, telemetry, and child-runner as needed.
- Forbidden: importing from `index.ts`.
- Use runtime-relative imports with a `.js` suffix.

# Local validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after any orchestration slice.
