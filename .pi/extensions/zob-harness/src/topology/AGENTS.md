# Directory scope

- Teams, orchestration profiles, chains, and local `.pi/coms` communication.
- This directory owns topology guards and hash-only messages.

# Invariants

- Preserve the topology guard and worker-to-worker blocking.
- `chain_run` remains plan-only and read-only.
- Communication records remain hash-only: do not store prompt or output bodies.
- Preserve derived status logic and the 5000 ms max timeout for await.

# Imports

- May import required types/constants/utils from `src/**` with a `.js` suffix.
- Forbidden: importing from `index.ts`.
- Avoid direct Pi runtime dependencies; runtime tools call this domain.

# Local validation

- `npm run check -- --pretty false`.
- `npm run smoke:harness` after any chains/coms/topology change.
