# ZOB Coms v2 module instructions

Scope: observe-only/live communication runtime primitives for ZOB.

MUST DO:
- Preserve hash-only ledger semantics.
- Keep persisted records metadata-only and body-free.
- Keep transport dispatch disabled unless an explicit later phase enables it.
- Prefer additive compatibility with existing `zob_coms_*` tools.
- Treat stale/offline peers as blockers, never completion evidence.

MUST NOT:
- Do not persist raw prompt, task, output, content, text, rationale, diff, or patch bodies.
- Do not introduce worker-to-worker free chat.
- Do not enable network transport without auth/locality policy.
- Do not make append-only ledger writes count as live delivery.
