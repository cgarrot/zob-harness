---
name: zob-goal-todo-tree
description: Use when planning, using, reviewing, or implementing ZOB /goal-linked TODOs, subtodos, TODO HUD progress, delegated TODO claims, or hierarchical subagent work graphs.
---
# ZOB Goal TODO Tree Skill

## When to use

Use this skill when a task involves any of:

- `/goal todo`, `/todo`, or goal progress tracking;
- TODO/subtodo planning under an active runtime goal;
- showing progress in the HUD;
- linking TODOs to `delegate_task`, `delegate_agent`, `child_goal`, orchestration, chains, or factories;
- accepting/rejecting subagent completion claims;
- handing existing Goal TODOs to a live ZPeer/ZTeam member through `handoff_goal_todo`, `/goal todo handoff`, or `/todo handoff`;
- reviewing whether a goal can move to `ready_for_oracle` or `complete`;
- designing X-depth TODO/delegation systems.

Canonical design/runtime doc:

- `docs/ZOB_GOAL_TODO_TREE_PLAN.md`

Runtime support now includes `/goal todo ...`, `/todo`, `/todos overlay`, goal TODO tools, delegated claim acceptance/rejection, explicit ZPeer/ZTeam TODO handoff metadata, oracle claim validation, strict PASS/no_ship=false auto-accept, artifact imports, HUD/prompt summaries, and completion blockers.

## Core model

A ZOB goal TODO is not a standalone checklist. It is a parent-owned work graph attached to a `RuntimeGoal.goalId`.

```text
RuntimeGoal = objective + loop + oracle + final gate
GoalTodoGraph = work breakdown + progress + evidence
DelegationGraph = subagent execution/claims linked to TODO nodes
EvidenceGraph = validation commands, reports, checkpoints, sentinels, hashes
```

## Non-negotiable invariants

- Do not create floating TODOs without an active runtime goal.
- Do not mark root goal complete from TODO status alone.
- Do not call `update_goal complete` before `propose_goal_completion` and oracle `PASS/no_ship=false`.
- Do not propose root completion while required TODOs are open, blocked, delegated, or awaiting user/oracle review.
- Use `resolve_goal_todo` as the primary API for TODO transitions (`auto`, `complete`, `accept_claim`, `reject_claim`, `block`, `skip`, `reopen`).
- Do not use `update_goal_todo` to mark TODOs `done` or `skipped`; it is metadata-only.
- Do not let a subagent directly mutate canonical TODO state.
- Refresh active TODO refs with `get_goal_todos` before TODO-linked delegation.
- Do not pass stale or invented `child_goal.todo_id` values. Prefer canonical active IDs from `get_goal_todos`; if you only know the visible tree path, use `child_goal.todo_path` rather than fabricating shorthand IDs.
- Safe auto-open/delegation is allowed for runtime-delegatable TODOs (`planned`, `ready`, `in_progress`, `needs_review`) when no active child/run owns the leaf and scope/ownership are clear; do not auto-open `needs_user`, `needs_oracle`, `blocked`, `claim_returned`, or active delegated/review states.
- Recover delegated/recovery leaves only when no active child/run owns the TODO and stale metadata can be safely cleared; otherwise block/review and do not redelegate the same leaf.
- No same-leaf parallel write workers. If multiple agents or parallel work are needed, split into subtodos first and dispatch one owner per writable leaf.
- Parallel owner pools use read-across/write-by-owner: sibling workers may read cited outputs/context and Goal Room summaries, but only the leaf owner edits its owned paths, and planned write paths must be within owned paths. Read-across never grants write access; overlap with write paths requires a hash-only justification. Workspace claims are metadata-only; an owner's own active listed write claim can cover write intent while other overlaps remain conflicts. Cross-owner changes require a parent-visible owner request and owner/parent decision, with requested paths covered by the named owner assignment when a plan exists; children without harness extensions may emit a hash/body-free `OWNER_CHANGE_REQUEST.v1` final-output block for parent-side extraction only.
- Goal Room is canonical for pool coordination, TODO handoff metadata, owner requests/decisions, blockers, evidence refs, and oracle-visible history. ZPeer is optional transient live delivery/clarification and must be summarized to Goal Room when it changes decisions.
- A subagent or ZPeer/ZTeam TODO handoff receiver returns a claim; the parent accepts or rejects it.
- Child-spawns-child is forbidden. Child-proposes-child is allowed only through parent-owned adaptive delegation gates.
- Children may propose XDEF/deeper splits with `TODO_SPLIT_REQUEST.v1`; only the parent applies `split_goal_todo` and dispatches follow-up agents.
- Persisted coms/Mission Control/adaptive TODO refs must remain hash-only/body-free.

## Stop-on-blocker context layer

When runtime goal context shows a human-decision blocker was already recorded (blocker score >=90, no `nextAgent`, goal paused, blocker visible), report it once and stop. Do not re-dispatch, re-ask the same human question, mark done/skip, hide the blocker, auto-resume, or bypass oracle/no_ship/evidence gates. Wait for explicit `/goal resume` or `resume_goal` before continuing.

## Activation-mode behavior

Respect `/goal mode` (default: `auto` unless a session explicitly persisted `manual` or `validation`):

### manual

Only create TODOs when the user explicitly asks.

### validation

For long work, propose a TODO plan and ask confirmation before creating/applying it.

### auto

For clearly long, multi-step, delegated, factory, or oracle-gated work, create a bounded initial TODO plan, but keep it visible and editable. Use `add_goal_todos` for multi-item plans instead of repeated `add_goal_todo` calls.

## TODO planning rules

When creating TODOs:

0. If the user asks to run a saved captured plan, prefer `zob_plan_launch`/`/plan launch` so TODOs come from the validated `.todos.json` sidecar; do not recreate the saved TODO tree from prose unless launch reports `needs_manifest`/`invalid_manifest` and the user explicitly asks for repair. With a non-complete active runtime goal, the launcher safely auto-attaches by default; request `active_goal_strategy=block`/`--block-active-goal` only for deliberate strict blocking.
1. For an initial plan, batch top-level items with `add_goal_todos`; use `get_goal_todos` or `/goal todo tree` only when the full tree is needed.
2. Keep TODOs atomic and evidence-oriented.
3. Prefer 3-9 top-level TODOs for a normal feature.
4. Use subtodos when a step is too broad, needs delegation, or would require multiple agents/parallel writable work.
5. Split-before-parallel: create distinct child leaves and acceptance criteria before dispatching concurrent workers.
6. Mark required vs optional explicitly.
7. Assign owner: `agent`, `user`, `oracle`, `subagent`, `factory`, or `orchestration`.
8. Add acceptance criteria for critical TODOs.
9. Add expected evidence refs or validation commands where possible.
10. Avoid over-splitting; respect depth/fanout caps.

## Status meanings

Recommended statuses:

```text
planned        known but not ready/started
ready          next actionable item
in_progress    parent agent is working on it
delegated      child agent/run owns execution temporarily
claim_returned child output exists, parent has not accepted it
needs_review   parent review required
needs_oracle   oracle review required
needs_user     user input/action required
blocked        cannot proceed without replan/input/fix
done           accepted with evidence
skipped        intentionally skipped with reason
```

## Explicit ZPeer/ZTeam TODO handoff

Use `handoff_goal_todo`, `/goal todo handoff ...`, or `/todo handoff ...` only for explicit handoff of existing Goal TODOs to a live ZPeer/ZTeam member.

Handoff preconditions:

- active runtime goal and existing TODO IDs or unambiguous TODO paths are required;
- an explicit agent team/ZTeam context is required; handoff is not available to anonymous peers or ordinary subagents;
- the receiver must be a resolvable team peer and live/stale status must be treated according to coms safety gates;
- the maintainer must provide a custom contextual handoff message for the receiver; do not synthesize a silent generic assignment;
- handoff must not auto-launch teams, spawn child agents, mutate source files, or mark TODOs complete.

Single and batch behavior:

- A single handoff assigns one bounded TODO leaf or parent-approved bundle to one receiver.
- A batch handoff may include multiple TODO refs only when they share the same receiver, ownership model, path permissions, and context; otherwise split first.
- Do not run multiple write-capable receivers on the same leaf. If parallel work is needed, split into subtodos/XDEF leaves first and assign one writable owner per leaf.
- Record batch membership and per-TODO hashes/refs; do not persist raw handoff messages or raw outputs.

Receiver execution rules:

- The receiver may create local private subtasks for its own execution notes.
- The receiver must not mutate the parent TODO graph directly, complete the parent TODO, or dispatch child workers unless team policy and parent-owned gates explicitly allow it.
- If the work is too broad, needs different owners, or requires parallel writable work, the receiver returns `TODO_SPLIT_REQUEST.v1` or a blocker claim rather than forcing completion.
- If receiver-side delegation is allowed by team policy, returned evidence must still be consolidated into the peer return contract for parent acceptance.

Durable coordination:

- ZPeer is transient live delivery/clarification only.
- Goal Room hash-only metadata is canonical for TODO handoff records, receiver refs, TODO refs, custom-message hashes, artifact refs, result hashes, blockers, and oracle-visible history.
- Persisted records must keep `bodyStored=false` and use `taskHash`, `outputHash`, `artifactRefs`, and safe refs instead of raw conversation bodies.
- ACK, delivery, chat reply, or append-only metadata is not TODO completion evidence by itself.

Return contract:

- Preferred receiver output is `TODO_CHILD_RESULT.v2` with `child_goal_status`, `status_claim`, `evidence_refs`, `validation_commands`, `risks`, `acceptance_blockers`, `target_readiness`, advisory `no_ship`, and `FINAL_MARKER: TODO_CHILD_RESULT_V2_END`.
- `TODO_SPLIT_REQUEST.v1` is appropriate when the receiver recommends parent-owned splitting/replanning.
- Parent/oracle review decides acceptance; only parent-owned `resolve_goal_todo`/claim acceptance can transition canonical TODO state.

## Release note — zob-harness 0.4.0

Goal TODO handoff is tracked for ZPeer/ZTeam workflows: `handoff_goal_todo`, `/goal todo handoff`, and `/todo handoff` support single or batch handoff to one live team peer with a maintainer-provided custom message. Durable coordination remains hash-only in Goal Room (`bodyStored=false`, custom-message/task/output hashes and artifact refs only), and ACK/delivery/chat replies never complete work; parent-owned review via returned claims and `resolve_goal_todo` remains the only completion path.

## Delegated TODO claims

When delegating a TODO, pass TODO metadata via `child_goal` once the runtime supports it:

```text
child_goal.objective = bounded child objective
child_goal.todo_id = <canonical-active-todo-id from get_goal_todos>  # only when freshly verified
child_goal.parent_todo_id = <canonical-active-parent-todo-id if freshly verified>
child_goal.todo_path = <visible-todo-path such as 1.2>  # safe fallback when canonical id is not freshly known; parent resolves it before dispatch when unique
child_goal.delegation_depth = current agent-depth + 1
child_goal.completion_policy = return_claim
child_goal.agentic_validation.mode = oracle_then_auto_accept  # optional; validates claim with oracle child before safe auto-accept
```

Expected child claim shape (v2 preferred; v1 remains compatible):

```text
TODO_CHILD_RESULT.v2

todo_id: <id>
child_goal_status: ready_for_oracle | incomplete | blocked
status_claim: done | incomplete | blocked
evidence_refs:
validation_commands:
risks:
acceptance_blockers: <blockers parent must resolve before accepting, or none>
target_readiness: ready_for_parent_acceptance | needs_parent_review | blocked
no_ship: true/false  # advisory/readiness evidence; parent/oracle decides review_no_ship; runtime computes hard/effective no_ship
subtodo_delta_proposals:
FINAL_MARKER: TODO_CHILD_RESULT_V2_END
```

Parent action after a claim:

- accept claim only after output contract/gate/evidence checks pass;
- for `child_goal.agentic_validation.mode=oracle_then_auto_accept`, runtime requests an oracle child to return `todo-claim-validation.v1` and auto-accepts only when worker gate passed, child status is `ready_for_oracle`, status claim is `done`, target readiness is `ready_for_parent_acceptance`, no acceptance blockers remain, oracle `claim_hash` exactly matches the returned claim, `recommended_action=accept_claim`, confidence is MEDIUM/HIGH, no oracle blocking issues remain, and oracle verdict is `PASS` with `no_ship=false`;
- `WARN`, `FAIL`, oracle `no_ship=true`, missing evidence, missing final marker, or mismatched `claim_hash` must leave the TODO in review/blocked state, not `done`;
- treat child `no_ship=true` as advisory review evidence, not an automatic child delivery failure when a deliverable was returned;
- reject/block the claim if evidence is missing or the parent agrees the advisory no_ship is a real blocker;
- import subtodo proposals only after checking depth/fanout and relevance.

Oracle validation output shape:

```text
TODO_CLAIM_VALIDATION.v1

todo_id: <id>
claim_hash: <sha256 returned claim hash>
verdict: PASS | WARN | FAIL
recommended_action: accept_claim | needs_review | reject_claim | block
evidence_refs:
validation_commands:
blocking_issues: <issues, or none>
no_ship: true/false
confidence: LOW | MEDIUM | HIGH
FINAL_MARKER: TODO_CLAIM_VALIDATION_END
```

If a delegated TODO claim has returned:

- Primary Tool API: `resolve_goal_todo({ todo_id, action: "auto" | "complete" | "accept_claim", evidence_refs, validation_commands })`.
- Compatibility Tool API: `complete_goal_todo` and `accept_goal_todo_claim` use the same parent-owned acceptance behavior for returned claims.
- Slash command: `/goal todo done <todoId> [evidence]` and `/goal todo accept-claim <todoId> [evidence]` both route through parent acceptance for returned claims.
- Never mark delegated TODOs `done` while the delegation is queued/running/failed and no returned claim exists.
- If evidence is missing or `no_ship=true`, call `reject_goal_todo_claim` or `block_goal_todo` unless parent review explicitly accepts the advisory risk.

If a high/xhigh/max TODO-linked child determines the TODO is too broad for its scope/context, or discovers safe completion requires multiple agents/parallel writable leaves, it may return a split request instead of a poor completion:

```text
TODO_SPLIT_REQUEST.v1

todo_id: <id>
reason: <why this exceeds child scope/context>
recommended_action: split | replan | factory | needs_user | blocked
proposed_subtodos:
- <bounded child TODO title>
risk_level: low | medium | high
validation_plan:
- <expected evidence or command>
evidence: <why this split request is justified>
risks_blockers: <unresolved risks, or none>
compliance: parent-owned split request only; no child dispatch or parent TODO mutation
no_ship: false
FINAL_MARKER: TODO_SPLIT_REQUEST_END
```

Parent action after a split request:

- validate output contract, depth/fanout caps, scope, no_ship, and relevance;
- apply `split_goal_todo` only from the parent;
- assign one writable owner per new leaf and record owned/write paths plus read-across refs;
- mark the original parent TODO skipped/decomposed only after child TODOs are created;
- never let the child directly split, dispatch, or complete the parent TODO.

## Completion gate checklist

Before calling `propose_goal_completion`, verify:

- `get_goal_todos.details.completion_ready` is true and `effective_no_ship` is false;
- all required TODOs are `done` or `skipped` with explicit reason; critical/delegated/factory/orchestration skips also cite evidence refs or validation commands;
- no required TODO is `planned`, `ready`, `in_progress`, `delegated`, `claim_returned`, `needs_user`, `needs_oracle`, or `blocked`;
- critical/delegated TODOs have evidence refs or validation commands;
- factory/orchestration TODOs cite validation/sentinel/checkpoint artifacts when relevant;
- known risks are included in the completion proposal;
- no hard or unresolved review no-ship blocker remains (`hard_no_ship=false`, `review_no_ship=false`, `effective_no_ship=false`).

If any item fails, continue work or report the blocker instead of proposing completion.

## HUD guidance

HUD should show compact summary, not the whole tree:

```text
runtime goal active · loop on 2/12 · oracle none
todos 5/12 · active 2 · blocked 1 · delegated 3
next agent 1.2 add reducer · next user 3 confirm UX
```

Use detailed commands/overlay for the full tree.

## Coms and Mission Control safety

For TODO-linked communication and handoff:

- use `taskId=todoId`;
- use `taskHash` and `outputHash`;
- use safe repo-relative `artifactRefs`;
- keep `bodyStored=false`;
- for ZPeer/ZTeam TODO handoff, keep raw custom messages transient and persist only message hashes/refs plus typed Goal Room metadata;
- keep command proposals parent-owned and proposal-only;
- never target direct worker writes from Mission Control.

## Factory/orchestration evidence

When TODOs represent factories/orchestrations/chains, reference existing artifacts instead of duplicating bodies:

- `reports/factory-runs/<runId>/validation.json`
- `reports/factory-runs/<runId>/checkpoints/*.checkpoint.json`
- `reports/factory-runs/<runId>/DONE.sentinel`
- `reports/orchestrations/<runId>/orchestration-plan.json`
- `reports/orchestrations/<runId>/status.jsonl`
- `reports/chains/<runId>/chain-plan.json`

## Implementation advice

The harness implements the core phases. For future changes, preserve the phased safety model:

1. Flat TODOs attached to `/goal`.
2. HUD summary and prompt injection.
3. Completion blocker in `propose_goal_completion`.
4. Tree/subtodos.
5. Delegated TODO claims.
6. TODO overlay.
7. Adaptive delegation mapping.
8. Factory/orchestration/chain imports.
9. Mission Control/context/queue integrations.

Do not start with full X-depth delegation. First prove flat TODOs, restore, HUD, and completion blocking.

## Oracle review behavior

For oracle review of a goal with TODOs:

- inspect TODO summary;
- sample critical done TODO evidence;
- verify delegated claims were parent-accepted, not child-self-completed;
- verify required TODOs are closed;
- verify validation commands and sentinels exist when claimed;
- return PASS/WARN/FAIL and explicit `no_ship`.

Missing TODO evidence means WARN or FAIL, never PASS.
