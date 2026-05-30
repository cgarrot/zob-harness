---
name: zob-mission-control-coms
description: Use when reading or controlling ZOB coms from Mission Control, including live presence, stale peers, command proposals, and oracle/no-ship review.
---
# ZOB Mission Control Coms Skill

## When to use

Use for:
- `zob_mission_control_snapshot` interpretation;
- `zob_coms_readiness` review;
- live peer online/stale/offline diagnosis;
- command proposal creation;
- oracle/no-ship communication reviews.

## MUST DO

- Read Mission Control as metadata-only.
- Use `zob_mission_control_snapshot` for queue/runs/coms/live presence overview.
- Use `zob_coms_readiness` before approving coms changes.
- Use `zob_mission_control_propose_command` for pause/resume/replan/request_oracle/stop/approve.
- Treat direct worker command targets as blocked.
- Escalate stale/offline peers as blockers or replan candidates.
- Verify `proposalOnly=true`, `directWorkerWrites=false`, `transportDispatch=false` for dashboard commands.

## MUST NOT

- Do not dispatch worker writes from Mission Control.
- Do not override topology or stale/no-ship gates.
- Do not store raw rationale or command body; use hashes and artifact refs.
- Do not use dashboard state as proof of task completion unless live response/output hash exists.

## Operator checklist

1. Snapshot shows live presence and no direct writes.
2. Readiness PASS.
3. No stale/offline peer counted as success.
4. Command is proposal-only.
5. Oracle/no-ship gates remain enforceable.
