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
- For Goal TODO handoff, treat ZPeer as transient live delivery/clarification only and Goal Room hash-only metadata as canonical for TODO refs, receiver refs, custom-message hashes, result hashes, blockers, and evidence refs.
- For ZPeer priorities, preserve `normal`/`urgent`/`force` semantics: `urgent` is steer-only and must not abort; `force` requires an explicit transient reason, stores only `reasonHash`/`interruptReasonHash`, and remains blocked unless topology, room, role, rate, lease, and local-socket guards pass.
- Treat ZPeer ACK/interrupt/reinjection/`waiting` status as delivery/control metadata only, not as read/digestion proof or TODO completion evidence; opt-in required responses must expire terminally unless an exact msgId-correlated reply arrives. Use `zpeer_reply` or `/zpeer reply <msgId> <response>` only when the `msgId` is active inbound; wrong, expired, or already-answered msgIds must block.
- Automatic replies must bind through exact custom-message `details.msgId`, never taskHash alone; taskHash remains an integrity check. Multiple eligible inbounds are ambiguous and must fail closed without transport.
- Runtime-goal-bound inbounds may reply only after goal completion; blocked, paused, failed, or budget-limited goals send a correlated terminal blocker and must never be reported as success.
- Treat governed requests (`DELEGATION_REQUEST.v1`, `ORACLE_REQUEST.v1`, `CONTEXT_REQUEST.v1`, `OWNER_CHANGE_REQUEST.v1`) as proposals only: parent/governor decides; extraction must not dispatch, mutate TODO state, apply owner changes, or store raw bodies.
- Treat stale/offline as blockers, not completion evidence.
- Keep Mission Control commands proposal-only and parent-owned.
- Run body-free checks before claiming PASS.

## MUST NOT

- No raw `body`, `task`, `prompt`, `output`, `content`, `message`, `text`, `rationale`, `diff`, or `patch` keys in persisted ZOB ledgers or Mission Control artifacts.
- No hidden worker-to-worker free chat; use typed parent-visible Goal Room messages instead.
- No direct worker writes from Mission Control.
- No network transport without bearer token/locality/TLS policy.
- No silent fallback from required live delivery to append-only success.
- No handoff delivery, ACK, chat reply, stale peer, or append-only Goal Room record may count as parent TODO completion; receiver claims still require parent/oracle acceptance.
- No `force` ZPeer send without an explicit reason hash, no forged/broad force escalation, and no force fallback to append-only or tmux delivery success.
- No token/secret logging.

## Tmux Agent Factory safety

For tmux-backed ZAgent teams:

- Tmux is a local launch/observation surface, not the durable source of truth.
- Startup kickoff files are allowed when they stay bounded and avoid secrets/raw private dumps; post-start pane paste is not reliable proof of delivery.
- Pane capture may be useful for live diagnosis, but do not persist captured prompt/output bodies into ledgers, reports, Mission Control, or skills.
- Supervisors/watchdogs must be bounded and local-only; they may detect stale windows or nudge a specific owed-response agent only with hash/body-free durable records.
- Team communication must remain parent-visible. Prefer one `control` room with lanes/tags/artifact sections unless a bounded owner-approved route exists.
- Completion still requires artifacts, validation evidence, and oracle/no-ship review when applicable; an active tmux session or chat reply is not completion evidence.

## Goal Room and owner-pool safety

For parallel owner micro-worker pools:

- Goal Room is canonical for parent-visible coordination, decisions, TODO handoff metadata, owner requests, and evidence refs.
- ZPeer is transient/live assist only; use it for immediate local questions or explicit Goal TODO handoff delivery, then summarize decisions as typed Goal Room metadata when they affect scope, ownership, merge readiness, or TODO acceptance.
- Enforce read-across/write-by-owner: workers may read sibling outputs and owner summaries, but only the assigned owner writes its owned paths/leaf. Non-owners send `OWNER_CHANGE_REQUEST.v1`/governed request metadata and wait for owner/parent decision.
- For `--no-extensions` children, use final-output `OWNER_CHANGE_REQUEST.v1` blocks with `requested_by`, `owner_worker`, `requested_paths`, `body_hash`, `change_hash`, `reason_hash`, optional `validation_plan_hash`, safe refs, and `FINAL_MARKER: OWNER_CHANGE_REQUEST_END`; parent extraction appends Goal Room metadata only.
- Owner decisions are parent-visible and typed: approve, deny, defer, split, or escalate-to-parent/oracle. Approval is not an apply/merge.
- Peer writes, hidden free chat, stale/offline success, direct main-workspace writes, missing validation, or missing oracle on risky merge readiness are no-ship blockers.

## No-ship triggers

No-ship if:
- `.pi/coms` contains raw prompt/output/body-like fields;
- live send succeeds while receiver is absent/stale/offline;
- await treats timeout/stale/offline as success;
- hidden worker-to-worker free chat works outside a typed parent-visible Goal Room;
- ZPeer `force` works without reason hash, bypasses topology/room/role/local-socket guards, or persists raw reason/message bodies;
- ZPeer replies are correlated without a message id / active inbound guard, risking phantom or wrong-msgId responses;
- tmux pane paste/capture is treated as reliable durable communication or completion evidence;
- a supervisor/watchdog nudges indefinitely, starts broad work, or stores raw pane bodies;
- a non-owner writes owned paths instead of sending an owner request;
- a worker applies or merges directly into the main workspace;
- network starts without explicit auth/locality policy;
- `zob_coms_readiness` fails.
