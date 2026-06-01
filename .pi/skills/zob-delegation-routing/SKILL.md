---
name: zob-delegation-routing
description: Use before delegating to ZOB specialist agents, choosing delegate_agent/delegate_task, selecting an agent, or deciding whether to set output_contract.
---
# ZOB Delegation Routing Skill

## When to use

Use this skill whenever you are about to call `delegate_agent` or `delegate_task`, especially the first delegation in a turn or when agent/contract routing is uncertain.

## Mandatory routing check

1. If you are not certain which agent or output contract to use, call `zob_delegation_catalog` first.
2. Choose the agent by the deliverable you need.
3. Model routing is advisory unless current runtime availability/authentication is proven: normally omit `delegate_task.model` and `delegate_agent.model` so the child uses the parent/session default. A configured, desired, catalogued, or class-mapped model is not evidence that the provider is currently available/authenticated. Set an explicit `model` override only when you have current runtime proof that the concrete model/provider is usable for this session, or when the user explicitly accepts that risk. If proof is missing, omit `model`; never let a catalog preference create a launch-blocking unavailable-provider override. Never downgrade oracle/security work to a weak or unverified default.
4. Normally omit `delegate_task.output_contract`; the harness infers the correct contract from the selected agent.
5. Normally omit `delegate_task.required_tools`; the harness infers the selected agent's declared tools.
6. Never invent output contract IDs or add tools not shown for the chosen agent in `zob_delegation_catalog`.
7. Treat preflight as a safety net, not as the first source of routing information.

## Common agent routing

- Need read-only facts, file mapping, gaps, or context: use `explore` (`explore.v1`).
- Need an implementation plan, TDD ladder, stop conditions, or handoff: use `planner` (`plan.v1`).
- Need bounded source edits: use `implementer` (`implement.v1`) with scoped `allowed_paths`.
- Need skeptical review, audit verdict, `PASS/WARN/FAIL`, blockers, or `no_ship`: use `oracle` (`oracle.v1`).
- Need verification/reproduction evidence: use `qa` (`qa.v1`).
- Need sourced reusable research/context: use `librarian` (`research.v1`).
- Need spec from a fuzzy request: use `specifier` (`spec.v1`).
- Need clarification before planning: use `clarifier` (`clarification.v1`).
- Need factory design: use `factory` (`factory.v1`).

## Output contract rules

- `delegate_agent` always infers the output contract from the agent.
- `delegate_task` infers the output contract from the agent when `output_contract` is omitted.
- Set `output_contract` only for an intentional, exact override with a known valid ID.
- There is no default `audit.v1`; audit/review work should usually route to `oracle` with `oracle.v1`.
- There is no `implementation_report.v1`; implementation reports use `implement.v1`.

## Tool routing rules

- **Write-enabled `delegate_task` hard rule:** when effective tools include `edit` or `write` (either inferred from the agent or supplied via `required_tools`), always set top-level `original_user_ask` to the original human request. Putting the user ask inside `context` or the task text is not enough for the strict write preflight gate.
- `delegate_task` structured JSON fields should use canonical snake_case. Safe aliases are normalized only when non-conflicting; conflicting canonical/alias values are blocked with no child launched.

| Canonical `delegate_task` field | Accepted safe aliases |
| --- | --- |
| `expected_outcome` | `expectedOutcome` |
| `required_tools` | `requiredTools` |
| `must_do` | `mustDo` |
| `must_not_do` | `mustNotDo`, `must_not`, `mustNot` |
| `original_user_ask` | `originalUserAsk` |
| `allowed_paths` | `allowedPaths` |
| `forbidden_paths` | `forbiddenPaths` |
| `output_contract` | `outputContract` |
| `run_in_background` | `runInBackground` |
| `child_goal` | `childGoal` |
| `load_skills` | `loadSkills` (still reserved/non-empty values are gated) |

- `delegate_task` infers `required_tools` from the selected agent when omitted.
- Omit `delegate_task.model`/`delegate_agent.model` by default. Explicit model overrides are exceptional and require current availability/auth proof for the concrete provider/model; desired/configured/catalogued models are preferences only, not availability. Fallback is to omit `model` and use the parent/session default.
- Set `required_tools` only to narrow the agent's tools, not to add tools.
- Do not request `bash` for `planner`; planner is read-only with `read`, `grep`, `find`, and `ls`.
- If a task truly needs `bash`, choose an agent whose catalog entry allows `bash`, or keep the work in the parent if appropriate.

## Safety reminders

- For write/edit tools, set top-level `original_user_ask`, non-empty repo-relative-only `allowed_paths`, and safe `forbidden_paths`.
- `allowed_paths` are capability grants and must never be absolute, home-relative (`~`), traversal (`..`), broad roots (`.`), or contain NUL. If external context is needed, first create/cite a repo-local snapshot or `context_ref` under `reports/...` and pass that repo-relative ref.
- `forbidden_paths` are deny-only patterns; they may be repo-local, absolute, or home-relative when specific and safe, but broad roots remain rejected.
- Preserve the six-part contract: TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT.
- Do not ask child agents to mark parent goals or TODOs complete directly; children return evidence/claims for parent review.
- For TODO-linked delegation, refresh with `get_goal_todos` first and use `child_goal.todo_id=<canonical-active-todo-id>` only when that id is freshly verified. If only the visible path is known, set `child_goal.todo_path=<visible-todo-path>`; do not fabricate shorthand ids. The parent runtime can resolve unique active paths/shorthands to canonical ids, and blocks stale refs with active-id hints.
- Safe auto-open/delegation is for runtime-delegatable TODOs (`planned`, `ready`, `in_progress`, `needs_review`) only when no active child/run owns the leaf. Recover delegated/recovery TODOs only when no active child/run owns the leaf; otherwise block/review instead of redelegating.
- Split-before-parallel: no same-leaf parallel write workers. If a TODO needs multiple agents or is too broad, parent splits it into subtodos first and dispatches one bounded owner per leaf.
- For parallel owner micro-worker pools, parents may use `zob_worker_pool_plan`/`zob_worker_pool_status` to record body-free assignment metadata before launch, but those tools do not dispatch children. Each actual child launch still goes through parent-owned `delegate_task`/`delegate_agent` with explicit owned/write paths, optional read-across refs, repo-relative `allowed_paths`, safe `forbidden_paths`, and TODO linkage.
- Read-across permits inspection and evidence synthesis only; it never grants write permission.
- Non-owner changes require a typed parent-visible owner request (`zob_worker_pool_owner_request`, `OWNER_CHANGE_REQUEST.v1`, or governed request) with requested path, reason/evidence hashes or refs, risk, and validation plan. Children without harness extensions may emit an `OWNER_CHANGE_REQUEST.v1` final-output block for parent-side `zob_governed_request_extract`; they must not call Goal Room/ZPeer directly. The owner/parent may approve, deny, defer, split, or escalate via `zob_worker_pool_owner_decision`/Goal Room; approval is not merge/apply and does not launch children.
- Goal Room is the canonical coordination surface for owner requests/decisions. ZPeer may be used for transient local clarification only and must not become hidden worker-to-worker free chat.
- Children must not dispatch children, mutate parent TODOs, apply split decisions, or write outside their owned paths.
- For TODO-linked high/xhigh/max work, children that discover the assigned TODO is too broad or needs deeper XDEF decomposition should return `TODO_SPLIT_REQUEST.v1` or a metadata-only split request; the parent validates and applies `split_goal_todo`.
- `delegate_task(run_in_background=true)` is active-session only: it returns a run id immediately, can be inspected with `get_delegation_run`, and can be waited on with bounded `await_delegation_run`; it does not start an always-on daemon.
