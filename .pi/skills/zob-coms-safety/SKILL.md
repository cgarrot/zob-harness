---
name: zob-coms-safety
description: Use when reviewing or modifying ZOB communication, ledgers, Mission Control coms, or live transport safety gates.
---
# ZOB Coms Safety Skill

## Safety invariants

ZOB coms live transport may be transient, but ZOB audit must stay metadata-only.

## MUST DO

- Preserve `.pi/coms/messages.jsonl` and `.pi/coms/status.jsonl` as canonical hash-only ledgers.
- Keep `bodyStored=false` for persisted coms records.
- Use `taskHash`, `outputHash`, `artifactRefs`, `sessionHash`, and `endpointHash` instead of raw content.
- Validate topology before any live or ledger send.
- Keep Orchestrator -> Lead, Lead -> Worker, Worker -> Lead as the normal topology for direct role-to-role messages.
- Allow Shared Goal Room messages only when they are parent-visible, typed, metadata/hash-only, and not hidden worker-to-worker free chat.
- Treat governed requests (`DELEGATION_REQUEST.v1`, `ORACLE_REQUEST.v1`, `CONTEXT_REQUEST.v1`) as proposals only: parent/governor decides; extraction must not dispatch, mutate TODO state, or store raw bodies.
- Treat stale/offline as blockers, not completion evidence.
- Keep Mission Control commands proposal-only and parent-owned.
- Run body-free checks before claiming PASS.

## MUST NOT

- No raw `body`, `task`, `prompt`, `output`, `content`, `message`, `text`, `rationale`, `diff`, or `patch` keys in persisted ZOB ledgers or Mission Control artifacts.
- No hidden worker-to-worker free chat; use typed parent-visible Goal Room messages instead.
- No direct worker writes from Mission Control.
- No network transport without bearer token/locality/TLS policy.
- No silent fallback from required live delivery to append-only success.
- No token/secret logging.

## No-ship triggers

No-ship if:
- `.pi/coms` contains raw prompt/output/body-like fields;
- live send succeeds while receiver is absent/stale/offline;
- await treats timeout/stale/offline as success;
- hidden worker-to-worker free chat works outside a typed parent-visible Goal Room;
- network starts without explicit auth/locality policy;
- `zob_coms_readiness` fails.
