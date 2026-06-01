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

- Use the canonical `zob_coms_*` tools; do not invent a parallel API.
- Treat `zob_coms_send` as live-first when policy mode is `required_local` or `required_network`.
- Include `transientBody` only for live transport delivery; it must never be stored in `.pi/coms`.
- Use `taskHash`, `outputHash`, and `artifactRefs` for durable evidence.
- Treat missing ACK, stale peer, offline peer, timeout, or transport error as blocker evidence.
- For parallel owner pools, treat Goal Room as canonical for owner requests/decisions; ZPeer is optional transient live assist only.
- For children launched without harness extensions, owner-change coordination is via final-output `OWNER_CHANGE_REQUEST.v1` blocks extracted by the parent, not direct child Goal Room/ZPeer writes.
- When a live answer changes ownership, scope, conflict, or merge readiness, mirror only typed hash/body-free metadata to Goal Room.
- Let the runtime capture normal inbound responses when handling live prompts.
- Prefer `zob_coms_get` / `zob_coms_await` with the `msgId` returned by your own send.

## MUST NOT

- Do not store raw prompt/task/output/body/content/text/rationale/diff/patch in `.pi/coms`.
- Do not use `zob_coms_send` to create worker-to-worker free chat.
- Do not use ZPeer to bypass parent-owned owner arbitration, TODO split, sandbox, merge, or oracle gates.
- Do not mark `queued`, `planned`, stale, or offline as completion.
- Do not create ping-pong loops; answer the inbound live prompt normally.
- Do not bypass topology guards.
- Do not enable network transport without explicit auth/locality policy.

## Expected pattern

```text
zob_coms_send
  -> topology guard
  -> live peer lookup/heartbeat
  -> live ACK or blocker
  -> hash-only ledger mirror
  -> await response or terminal error
```
