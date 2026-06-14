---
name: zob-worklist
description: Use when driving the append-only metadata-only worklist blackboard — appending events, reading derived directives, leasing/satisfying directives by content hash, delivering idempotent DIRECTIVE_READY notifications, running the liveness watchdog (observe/escalate), or building/querying the dependency DAG.
---
# ZOB Worklist Skill

## When to use

Use for driving the `zob_worklist` blackboard tool and its subcommands:

- `append` — append one metadata-only event (reducer-validated; `FORBIDDEN_PLAINTEXT_KEYS` rejected).
- `directives` — read the derived `Directive` projection for a scope.
- `claim` — lease a directive by content hash (lease-gated).
- `satisfy` — satisfy a directive by content hash (idempotent no-op if done).
- `deliver` — plan + emit an idempotent `DIRECTIVE_READY` notification for a directive hash (causal guard + dropped-notification tolerance).
- `validate` — run the scope reducer + assert internal consistency.
- `observe` — (WS-H3) evaluate the liveness watchdog WITHOUT persisting events.
- `escalate` — (WS-H3) run one watchdog tick and persist governed metadata-only escalation events to `.pi/worklist/<scope>/watchdog.jsonl`.
- `dag` — (WS-H4) build/query the generic dependency DAG (build/impact/seed/save/load).

Domain semantics: `.pi/extensions/zob-harness/src/domains/worklist/AGENTS.md`.

## MUST DO

- Keep everything hash-only and body-free (`bodyStored:false`, `promptBodiesStored:false`, `outputBodiesStored:false`); network is never enabled.
- Read `directives` (the derived projection) for current state, not stale cached projections.
- `claim`/`satisfy` by content hash; both are lease-gated and idempotent on the hash.
- Treat `deliver` as parent-owned and idempotent on the directive content hash; resend is governed, not speculative.
- Run `observe` ONLY when `directives == []` (no open directive). A directive past its deadline escalates, never observes.

## MUST NOT

- Do not store raw bodies, prompts, diffs, or secrets anywhere; refs are hashes/artifact paths only.
- Do not let `observe` be true while any directive is open.
- Do not dispatch live transport or network from the worklist; delivery notifications are metadata-only records, not live sends.
- Do not deliver a directive speculatively (no notification without a matching directive hash + causal guard).
- Do not use P2P messaging for cross-scope DAG dependencies; `dag` reads the OTHER scope's `dag.json` projection via a pure read, never a peer message.

## Watchdog HARD RULE

`observe === (openDirectives.length === 0)`, where `openDirectives = directives.filter(d => !d.satisfied)` — a satisfied (done) directive is filtered out and does NOT count as open, so `observe` is true exactly when no directive is still open.

A directive past its deadline escalates through `wait -> auto -> nudge_llm -> human_block`; it NEVER observes while open. `human_block` raises a no-ship escalation. This rule is what prevents silent stalls — an open directive must never be reported as "nothing to do."

## Operator checklist

1. Appended events are body-free and reducer-accepted.
2. `directives` reflects current derived state before any claim/satisfy/deliver.
3. claim/satisfy keyed by content hash; double actions are tolerated no-ops.
4. `observe` returns true ONLY with zero open directives.
5. Escalation events are metadata-only and raise no-ship at `human_block`.
6. No raw bodies, prompts, diffs, or secrets persisted anywhere; network never enabled.
