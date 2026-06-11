---
name: zob-coms-v2-live
description: Use when an active ZOB handoff, live peer question, required-local coms delivery, or orchestration message is needed.
---
# ZOB Coms v2 Live Skill

## When to use

Use this skill when:
- sending active handoffs between ZOB roles;
- awaiting a live peer response;
- diagnosing live peer presence, stale, or offline state;
- working on `zob_coms` v2 runtime, registry, heartbeat, local transport, or response capture.

## MUST DO

- Use the canonical `zob_coms_*`, ZPeer, and ZTeam/ZAgent surfaces for governed agent communication; do not invent a parallel API.
- Treat `zob_coms_send` as live-first when policy mode is `required_local` or `required_network`.
- Include `transientBody` only for live transport delivery; it must never be stored in `.pi/coms`.
- Use `taskHash`, `outputHash`, and `artifactRefs` for durable evidence.
- Treat missing ACK, stale peer, offline peer, timeout, or transport error as blocker evidence.
- For parallel owner pools and Goal TODO handoff, treat Goal Room as canonical for owner requests/decisions, TODO refs, receiver refs, message/result hashes, blockers, and evidence refs; ZPeer is optional transient live delivery/assist only.
- For `handoff_goal_todo` and `/goal todo handoff`, require an explicit team/ZTeam context, an existing live peer receiver, and a maintainer-provided custom contextual message; do not auto-launch teams or count handoff delivery as TODO completion.
- For children launched without harness extensions, owner-change coordination is via final-output `OWNER_CHANGE_REQUEST.v1` blocks extracted by the parent, not direct child Goal Room/ZPeer writes.
- When a live answer changes ownership, scope, conflict, or merge readiness, mirror only typed hash/body-free metadata to Goal Room.
- Let the runtime capture normal inbound responses when handling live prompts.
- Prefer `zob_coms_get` / `zob_coms_await` with the `msgId` returned by your own send.

## MUST NOT

- Do not store raw prompt/task/output/body/content/text/rationale/diff/patch in `.pi/coms`.
- Do not use `zob_coms_send` to create worker-to-worker free chat.
- Do not replace ZPeer/ZTeam room membership with custom file-backed `rooms/`, shell inbox/outbox scripts, or pane-paste protocols when the owner asked for agent rooms or live team communication.
- Do not use ZPeer to bypass parent-owned owner arbitration, TODO handoff acceptance, TODO split, sandbox, merge, or oracle gates.
- Do not mark `queued`, `planned`, delivered, acknowledged, stale, or offline as completion.
- Do not create ping-pong loops; answer the inbound live prompt normally.
- Do not bypass topology guards.
- Do not enable network transport without explicit auth/locality policy.

## Tmux/ZAgent communication pattern

For tmux-backed Agent Factory teams:

- Treat each tmux window as a local Pi/ZAgent session with its own identity and ZPeer/ZTeam room membership.
- Require tmux launch plans for ZAgents to use `ZOB_ZTEAM_ID=<team>` and `ZOB_ZAGENT_ID=<agent>`; plain `pi` panes are not ZPeer-room-bound ZAgents.
- Use tmux only to start, attach, inspect status, or close the local session; do not use pane paste as the primary communication transport.
- Prefer startup files (`pi @chief-kickoff.md`, `pi @worker-kickoff.md`) for initial instructions so Pi receives one bounded message block.
- Use async ZPeer/Goal Room-style asks for normal coordination; do not block in polling loops after sending a non-blocking ask.
- Keep any local file/timeline rooms as optional logs only; they are not delivery, live presence, ZPeer membership, or completion evidence.
- Keep messages short and actionable with `CONTEXT`, `ASK`, `EVIDENCE`, `URGENCY`, and `BLOCKER` fields.
- When a reply affects scope, ownership, merge readiness, oracle status, or completion, mirror only body-free metadata/artifact refs into durable records.

## Expected pattern

```text
zob_coms_send
  -> topology guard
  -> live peer lookup/heartbeat
  -> live ACK or blocker
  -> hash-only ledger mirror
  -> await response or terminal error
```
