---
description: Implement one bounded slice with verify-before-change and final evidence
argument-hint: "<slice>"
---
Switch to `/zmode implement` if not already there.

Implement this bounded slice: $ARGUMENTS

Rules:
- Before editing, produce a sufficiency verdict: SUFFICIENT/no change or GAP/smallest file set.
- For non-trivial or tool-ambiguous slices, apply `.pi/skills/zob-tool-router/SKILL.md` briefly; use/delegate/skip applicable families and avoid heavy routing for small edits.
- Use surgical edits. No broad rewrites.
- In a parallel owner pool, edit only your owned/write paths; read-across sibling refs for context/evidence only. If you need another owner's path, send a typed owner request and wait for parent/owner decision.
- If running without harness tools/extensions, do not call Goal Room/ZPeer directly; emit a hash/body-free `OWNER_CHANGE_REQUEST.v1` final-output block (`requested_by`, `owner_worker`, `requested_paths`, `body_hash`, `change_hash`, `reason_hash`, optional `validation_plan_hash`, safe refs, `FINAL_MARKER: OWNER_CHANGE_REQUEST_END`) for the parent to extract with `zob_governed_request_extract`.
- Goal Room is canonical for owner requests, decisions, blockers, and evidence; ZPeer is transient clarification only and cannot replace parent-owned arbitration.
- If using ZPeer urgent/force/requireResponse, load `.pi/skills/zob-coms-v2-live/SKILL.md` and `.pi/skills/zob-coms-safety/SKILL.md`; `urgent` is steer-only, `force` requires an explicit transient reason and hash-only metadata, `requireResponse` needs exact msgId correlation or terminal expiration, explicit replies must use `zpeer_reply`/`/zpeer reply <msgId>`, and ACK/interrupt/reinjection status is not completion evidence.
- No secrets. No destructive commands. No commits unless explicitly requested or governed autocommit is explicitly policy-authorized for this slice.
- If commit/push work is authorized, load `.pi/skills/zob-commit/SKILL.md` and `.pi/git-policy.json`, then use only governed `/zcommit` commands or the agent-executable `zob_zcommit_run` tool when the user explicitly asks the agent to commit/push; no aliases and no direct git commit/push/tag/force-push/bulk-stage commands.
- Verify with narrowest relevant checks first.
- Do not dispatch children, mutate parent TODOs, apply/merge to main workspace, or claim success from stale/offline coms.
- If a human-decision blocker is already recorded (score >=90, no `nextAgent`, paused goal, visible blocker), report it once and wait for `/goal resume`/`resume_goal`; do not repeat the ask, redispatch, auto-resume, or bypass oracle/no_ship/evidence gates.

Final answer:
- changed files
- verification commands/results
- unresolved risks
- compliance line
- deliverable_delivered: yes/no
