---
name: zob-tool-router
description: Use before non-trivial work, uncertain tool selection, orchestration, delegation, context lookup, factory work, autonomous-runtime claims, or evidence-gated completion.
---
# ZOB Tool Router Skill

## Purpose

This skill is the compact playbook for deciding which ZOB tool families, modes, and domain skills to use. It is not a runtime dispatcher and not a reason to use every tool. Use it to choose the smallest sufficient tool set, then follow each selected tool family's own safety gates.

## When to use

Use this skill when any of these are true:

- the user ask is non-trivial, multi-step, or evidence-gated;
- the right mode/tool family is ambiguous;
- the work may need delegation, orchestration, factory design, context retrieval, ProjectDNA, coms, workspace/merge coordination, autonomous-runtime evidence, or oracle review;
- you are about to claim completion for broad or risky work.

Do not use this skill for a small factual answer when no tools are needed.

## Core principles

1. Do not use every tool. Use the smallest sufficient set.
2. The registry is the source of truth for available tool families, mode allowlists, skill refs, docs, and no-ship notes: `.pi/capabilities/zob-public-runtime-capabilities.json`.
3. This router selects families and domain skills; it does not bypass mode, approval, sandbox, budget, evidence, or oracle gates.
4. If a family is applicable, either use it, delegate it, or explicitly skip it with a reason.
5. Prefer evidence-backed progress over autonomy claims.

## Routing loop

1. Classify the request:
   - trivial answer;
   - bounded code/doc edit;
   - multi-step goal;
   - multi-agent orchestration;
   - factory/repeated workflow;
   - context/reference lookup;
   - validation/oracle;
   - autonomous-runtime claim.
2. Identify applicable tool families from the table below.
3. Load specialized skills for selected families when their behavior matters.
4. Pick the smallest safe next action: answer directly, inspect, plan, implement, delegate, orchestrate, validate, block, or ask the user.
5. Attach evidence to TODOs or final reports when work is broad, delegated, or completion-gated.
6. If a human-decision blocker is already recorded (score >=90, no `nextAgent`, paused goal, visible blocker), report it once, do not repeat/redispatch, and wait for explicit `/goal resume` or `resume_goal`.
7. Escalate to oracle when no-ship, final completion, security, autonomous, sandbox, or promotion risk is involved.

## Tool family routing table

| Family | Use when | Tools / skills to consider |
| --- | --- | --- |
| goal/TODO | Long-running, multi-step, delegated, factory, or evidence-gated work | `create_goal`, `add_goal_todos`, `get_goal_todos`, `resolve_goal_todo`; skill `zob-goal-todo-tree` |
| delegation | Specialist review, parallel discovery, implementation handoff, independent QA, or uncertain broad work | `zob_delegation_catalog`, `delegate_task`, `delegate_agent`; skill `zob-delegation-routing` |
| orchestration | Lead/Worker lanes, Chief Vision coordination, parent-owned dispatch, multi-agent workgraph | `/zmode orchestrator`, `orchestrate_run`, `chain_run`, goal/TODO tools |
| compute | Complexity, budget, model class, max profile, or multi-agent sizing matters | `zob_compute_preview`, `zob_compute_resolve_profile`, `zob_compute_plan_workflow`, `zob_compute_validate_profile`; skill `zob-compute-profile` |
| context / ProjectDNA | Need bounded repo/reference context, scan artifacts, cited context packs, or writeback proposals | `zob_context_validate_scope`, `zob_context_readiness`, `zob_project_dna_query`, `zob_project_dna_federated_query`, `zob_project_dna_readiness`; skill `zob-project-dna` |
| factory | Repeated workflow, smoke/pilot/batch gates, manifests, checkpoints, sentinels | `factory_run`, factory quarantine tools, autonomous factory read-only smokes; skill `zob-factory` |
| coms / goal-room | Parent-visible coordination, live required-local handoff, blockers, TODO claims, status refs | `zob_goal_room_*`, `zob_coms_*`; skills `zob-coms-v2-live`, `zob-coms-safety` |
| workspace / merge queue | Parallel write intent, sandbox diff review, parent-owned manual apply decisions | `zob_workspace_claim`, `zob_workspace_release`, `zob_merge_candidate_submit`, `zob_merge_queue_decide`; skill `zob-sandbox` |
| worker-pool | Parent-owned same-type/read-only or write-by-owner pool planning, path ownership/read-across coordination, owner requests/decisions | `zob_worker_pool_plan`, `zob_worker_pool_status`, `zob_worker_pool_owner_request`, `zob_worker_pool_owner_decision`; skills `zob-harness`, `zob-delegation-routing`, `zob-coms-safety` |
| autonomous runtime | Dry-run, readonly smoke, validation evidence, or any autonomy readiness claim | `zob_autonomous_*`; skill `zob-autonomous-runtime` |
| Mission Control | Dashboard snapshots, readiness, pause/resume/replan/request-oracle proposals | `zob_mission_control_*`, `zob_coms_readiness`; skill `zob-mission-control-coms` |
| oracle | Final readiness, no-ship, safety/security, release, sandbox apply, or autonomous enablement | oracle agent/review, `propose_goal_completion`, `record_goal_oracle`; skill `zob-oracle` |

## Anti-over-orchestration rules

- Do not create a runtime goal for a simple question or tiny one-shot answer.
- Do not delegate if direct answer or local inspection is enough.
- Do not run compute profiling for a small obvious edit.
- Do not use coms/goal-room when no other agent/run is involved.
- Do not invoke factory tooling unless the workflow is repeatable or explicitly factory-shaped.
- Do not treat dry-run, readonly smoke, plan-only orchestration, or mocked dispatch as final autonomous production readiness.
- Do not use workspace/merge queue for single-agent non-overlapping edits unless sandbox governance is required.
- Do not bypass oracle when completion, no-ship, sandbox promotion, autonomous enablement, or security risk is in scope.

## Routing verdict format

For non-trivial or ambiguous work, produce a compact internal or visible verdict before the first substantive action when useful:

```text
TOOL ROUTING VERDICT
- complexity: trivial | small | non-trivial | high-risk
- selected mode: explore | plan | implement | oracle | factory | orchestrator
- applicable families:
  - goal/TODO: use | delegate | skip — reason
  - delegation: use | delegate | skip — reason
  - orchestration: use | delegate | skip — reason
  - compute: use | delegate | skip — reason
  - context/ProjectDNA: use | delegate | skip — reason
  - factory: use | delegate | skip — reason
  - coms/goal-room: use | delegate | skip — reason
  - workspace/merge: use | delegate | skip — reason
  - worker-pool: use | delegate | skip — reason
  - autonomous: use | delegate | skip — reason
  - oracle: use | delegate | skip — reason
- selected skills:
- smallest sufficient next action:
```

Keep the verdict short. For routine small work, summarize only the selected next action instead of printing the full matrix.

## Completion reminder

Before claiming broad work complete, verify evidence, required TODO closure, validation commands, and oracle/no-ship requirements. If evidence is missing, continue, block, or ask the user instead of claiming success.
