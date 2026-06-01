---
description: Run parallel code/goal/security/QA reviews through specialist agents
argument-hint: "<artifact or change>"
---
Use `delegate_agent` in parallel mode for: $ARGUMENTS

Suggested tasks:
- oracle: goal-fit review with PASS/FAIL/WARN and blockers.
- oracle: security/safety review with trust-boundary and secret-handling checks.
- qa: executable verification plan or targeted smoke checks.
- explore: context map for any uncertain subsystem.

Each child must use the six-part contract and return concrete evidence. Parent must synthesize only after all results arrive.

Parallel owner-pool review rules:
- Split writable work by owner before dispatch; reviewers may read across all cited artifacts, but write-capable workers edit only owned paths.
- Use `zob_worker_pool_plan`/`zob_worker_pool_status` for metadata-only/body-free pool assignment and conflict records; these tools do not dispatch children, mutate TODOs, apply writes, or store raw prompt/task/output/diff bodies.
- Actual child dispatch remains parent-owned through `delegate_task`/`delegate_agent` with six-part contracts, explicit TODO linkage, repo-relative owned/write `allowed_paths`, safe `forbidden_paths`, and read-across refs.
- Use Goal Room and `zob_worker_pool_owner_request`/`zob_worker_pool_owner_decision` for typed owner requests, decisions, blockers, and evidence refs. ZPeer may clarify live questions but is transient and not canonical.
- Parent owns arbitration: accept/deny owner requests, resolve conflicts, decide merge queue entries, and request oracle review.
- No-ship on raw body persistence, hidden free chat, peer writes, stale/offline success, direct main-workspace apply, missing validation, or missing oracle for risky/conflicting changes.
