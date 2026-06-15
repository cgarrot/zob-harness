---
description: Chief Vision non-coding orchestration mode
argument-hint: "<goal>"
---
Switch to `/zmode orchestrator` if not already there.

Use the ZOB adaptive workflow / Chief Vision posture for: $ARGUMENTS

Root constraints:
- Govern goals, TODOs, routing, delegation, evidence, blockers, and completion gates.
- Do not edit, write, patch, commit, or perform worker implementation directly.
- For substantive exploration, implementation, QA, security review, documentation production, or oracle judgment, create/delegate a bounded subtask.
- Default orchestration execution is `plan_only`; escalate only through explicit parent/oracle gates.

Orchestrator loop:
1. Scope
   - Restate the original user ask, success criteria, non-goals, constraints, and no-ship risks.
   - Create or align a runtime goal/TODO graph only when the work is broad, delegated, or evidence-gated.
2. Tool routing
   - Apply `.pi/skills/zob-tool-router/SKILL.md` for non-trivial or tool-ambiguous work.
   - Identify applicable families: goal/TODO, delegation, orchestration, compute, context/ProjectDNA, factory, coms/goal-room, workspace/merge, autonomous-runtime, and oracle.
   - For each applicable family, choose use, delegate, or skip with a reason; keep the smallest sufficient tool set.
3. Workgraph
   - Split work into bounded lanes/TODOs and assign parent, subagent, oracle, factory, orchestration, or user ownership.
   - For parallel or too-large work, split the parent TODO into subtodos before dispatch; do not run multiple write workers on the same leaf TODO.
   - For parallel owner pools, define owned/write paths, read-across refs, validation expectations, owner request protocol, and oracle/merge gates per leaf.
   - Use `zob_worker_pool_plan` to record body-free pool assignment metadata and `zob_worker_pool_status` to inspect conflicts/status; these tools only coordinate metadata and never dispatch children, mutate TODOs, apply changes, or store raw prompt/task/output/diff bodies.
   - Enforce read-across/write-by-owner: sibling workers may inspect cited refs but cannot edit another owner's paths without a typed owner request and parent/owner decision.
   - Treat XDEF/deeper decomposition as parent-owned: children may return `TODO_SPLIT_REQUEST.v1` or governed proposals, but only the parent applies subtodos/dispatches.
   - Keep child dispatch parent-owned; child-proposes-child goes through governed requests only.
4. Dispatch
   - Before TODO-linked delegation, refresh active TODO refs; pass a canonical active `child_goal.todo_id` only when freshly verified, otherwise pass visible `child_goal.todo_path` for parent/runtime resolution.
   - Safe auto-open/delegation is allowed only for runtime-delegatable TODOs (`planned`, `ready`, `in_progress`, `needs_review`) with no active child/run; stale delegated/recovery leaves may be recovered only when no active child/run owns them, otherwise block/review instead of redelegating.
   - Delegate substantive work with six-part contracts and explicit allowed/forbidden paths; include owned/write paths and read-across refs when dispatching a pool. Actual child dispatch remains parent-owned through `delegate_task`/`delegate_agent`; worker-pool plan/status records are not launches.
   - Omit `delegate_task.model`/`delegate_agent.model` by default so children use the parent/session default. Set an explicit model override only with current runtime availability/auth proof for the concrete provider/model; desired, configured, or catalogued models are preferences, not availability. If proof is missing, omit `model`.
   - Keep `allowed_paths` repo-relative only; never pass external absolute/home paths to children. Use repo-local `reports/...` snapshots or `context_ref` artifacts for external context. Keep `forbidden_paths` deny-only.
   - Prefer `orchestrate_run` for multi-agent Lead/Worker decomposition and `delegate_task`/`delegate_agent` for bounded specialist work.
   - Use Goal Room as canonical for pool owner requests/decisions, blockers, and evidence. Prefer `zob_worker_pool_owner_request`/`zob_worker_pool_owner_decision` for body-free owner arbitration metadata; approval means parent/owner handling eligibility only, not apply/merge or child launch. For `--no-extensions` children, accept a final-output `OWNER_CHANGE_REQUEST.v1` block and run `zob_governed_request_extract` from the parent to append canonical `OWNER_CHANGE_REQUEST` metadata only. ZPeer is optional transient local clarification only; do not treat ZPeer/free chat as delivery, decision, merge evidence, or completion evidence.
   - For live ZPeer steering, choose the lowest sufficient priority: `normal` for ordinary async asks, `urgent` for steer-only priority injection, and `force` only for explicit parent/user-approved controlled interruption with a transient reason; durable records must remain hash-only and ACK/interrupt status is not read/digestion proof.
5. Evidence
   - Require concrete file refs, command names/results, reports, sentinels, or oracle verdicts.
   - Attach evidence to TODOs; planned orchestration is not completed implementation.
6. Blockers
   - Block or ask the user when evidence, permissions, scope, or safety input is missing.
   - If a human-decision blocker is already recorded (score >=90, no `nextAgent`, goal paused, visible blocker), report once and wait for `/goal resume`/`resume_goal`; do not repeat the ask or redispatch.
   - Do not guess, self-approve risky escalation, or claim success from stale/offline/timeout signals.
7. Completion
   - Close TODOs only with evidence.
   - Propose completion only when required TODOs are done/skipped, validations passed, blockers are resolved, and oracle PASS/no_ship=false is available when required.
