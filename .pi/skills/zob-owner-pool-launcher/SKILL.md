---
name: zob-owner-pool-launcher
description: Use when the owner gives a plain-language intention and wants the assistant to actively launch and operate a supervised ZOB parallel owner micro-worker pool workflow instead of only generating a prompt.
---
# ZOB Owner Pool Launcher Skill

## Purpose

Use this skill when the owner writes a natural-language request such as:

```text
/skill:zob-owner-pool-launcher <user intent>
```

The assistant must turn the owner intent into one bounded supervised owner micro-worker pool run, then operate the workflow using existing ZOB coordination and delegation surfaces. This is an operational launcher, not a prompt generator.

The launcher may use the prompt-writing logic from `zob-owner-pool-drill-writer` as a formatting aid, but it must actively classify scope, size the pool, create/inspect Goal TODOs when appropriate, create/read worker-pool metadata, dispatch actual workers parent-owned through `delegate_task`/`delegate_agent`, monitor runs, synthesize evidence, validate, and request oracle review when needed.

## Non-negotiable invariants

- One bounded slice only. If the intent is broad, narrow it or ask the owner to choose the first slice.
- Parent-owned dispatch only. Worker-pool metadata does not launch workers.
- No child-spawns-child. Children may propose splits or owner requests; only the parent applies them.
- Goal Room is the canonical coordination record for assignments, owner requests, decisions, blockers, and evidence refs.
- ZPeer/live chat is transient only. Summarize any decision-affecting live clarification as typed Goal Room metadata.
- No hidden worker-to-worker free chat.
- Persist no raw bodies in coordination metadata, ledgers, Mission Control artifacts, compute artifacts, or worker-pool records. Use hashes, refs, summaries, and paths.
- Enforce read-across/write-by-owner: workers may read cited sibling outputs, but only the named owner writes its owned paths.
- Non-owner changes require a parent-visible `OWNER_CHANGE_REQUEST.v1` or governed request and a parent/owner decision. Approval is not apply/merge.
- Do not let children directly mutate parent TODOs or mark parent goals complete. Children return evidence/claims; the parent accepts or rejects after review.
- Reports-only is the default mode.
- Source-write-gated work requires explicit paths, sandbox/workspace claims, merge queue, rollback metadata, validation, and oracle/human gates. Never auto-apply.
- Never commit, push, tag, stage, force push, or alter git state from this skill.
- Never read/write secrets or forbidden paths such as `.env`, keys, `~/.ssh`, `~/.aws`, `node_modules`, `dist`, `build`, or `.git`.
- Never run destructive commands unless the owner gives explicit approval outside this skill's default workflow.
- Never count stale/offline peers, append-only logs, or non-live refs as required delivery success.
- Do not imply fully autonomous production writes, unlimited spawning, or always-on background daemons.

## Intake from the owner prompt

Use the user's plain prompt directly. Do not require a preformatted contract unless safety-critical details are missing.

Extract:

1. `OBJECTIVE`: one sentence.
2. `SCOPE`: the smallest bounded slice that can produce evidence.
3. `MODE`: `reports-only` by default, or `source-write-gated` only when explicitly requested.
4. `READ_PATHS`: explicit source/context paths; ask if absent and required for safety.
5. `OWNED_PATHS`: per-worker output or sandbox paths; must be repo-relative and non-overlapping for writes.
6. `FORBIDDEN_PATHS`: include secrets, generated/vendor/build paths, and owner-specified denies.
7. `VALIDATION`: narrow commands or evidence checks.
8. `OWNER_DECISIONS_NEEDED`: missing paths, scale approval, source-write permission, merge/apply decisions.

Ask a clarification question instead of launching when the request lacks safety boundaries for source writes, requires secrets/destructive actions, is too broad for one slice, or would require hidden chat, child direct dispatch, direct TODO mutation, auto-apply, or unbounded worker count.

## Scale and compute policy

Choose the smallest useful pool. Worker counts are caps, not targets.

| Workers | Use when | Gates |
| --- | --- | --- |
| 2 | Simple compare/review, mapper + oracle/planner | Default for small reports-only tasks |
| 3 | Normal owner pool: mapper, implementer/planner, oracle | Default for most bounded tasks |
| 5 | Multiple independent lanes or owned paths plus synthesis/oracle | Requires clear decomposition and non-overlapping write grants |
| 10 | High-complexity, high-profile workflow with separable lanes | Requires explicit owner consent, compute/budget gates, TODO split, validation/oracle plan |
| 20 | Exceptional max-scale supervised drill | Requires explicit human approval, strict compute/budget gates, oracle plan, and should normally be plan-only or read-only/report-only |

Rules:

- Default to 2-5 workers.
- Do not silently select 10 or 20.
- Use compute preview/resolve when the owner requests auto/high/xhigh/max scale or when 10/20 workers are considered.
- `max` or 20-worker scale is approval-gated and never bypasses safety, path, sandbox, budget, validation, or oracle gates.
- If planned work exceeds caps, split into a smaller first run and return a follow-up proposal.

## Safe modes

### Reports-only default

Use for exploration, audits, plans, specs, proposals, prompt/workflow design, and oracle review.

- Workers write only report/proposal artifacts under explicit output paths.
- Source paths are read-only.
- Validation may be structural checks, targeted commands, or evidence review.
- Final output includes exact next owner decisions.

### Source-write-gated

Use only when the owner explicitly asks for code/source changes and provides or approves exact paths.

Required gates:

1. Explicit allowed read/write paths and forbidden paths.
2. Workspace claim/lease metadata for intended owned write paths.
3. Sandbox/temp/quarantine workspace for worker edits; no direct main-workspace apply.
4. Merge queue or diff-candidate metadata owned by the parent.
5. Changed paths, diff hash, rollback notes, and validation logs.
6. Oracle review for risky or merge-ready changes.
7. Human/owner approval before any apply. Approval only makes a candidate eligible; it does not auto-apply.

If any gate is missing, downgrade to reports-only or stop with a blocker.

## Operational runbook

### 1. Load consistency context

When launching a pool, apply these skills as relevant:

- `zob-harness` for harness/orchestrator rules.
- `zob-delegation-routing` before child dispatch.
- `zob-goal-todo-tree` when using active goals/TODO-linked work.
- `zob-compute-profile` when auto/high/xhigh/max or 10/20 worker scale is considered.
- `zob-coms-safety` for Goal Room, governed requests, no raw-body persistence, and stale/live safety.
- `zob-sandbox` for source-write-gated work.

### 2. Scope lock

Restate the six-part contract for the pool:

```text
1. TASK: [bounded objective]
2. EXPECTED OUTCOME: [observable deliverable/evidence]
3. REQUIRED TOOLS: [allowed tools only]
4. MUST DO: [positive constraints, paths, validation, parent-owned coordination]
5. MUST NOT DO: [hard stops, forbidden paths, no auto-apply/no commits]
6. CONTEXT: [original owner prompt, assumptions, mode, worker count, TODO/goal refs]
```

If the scope or write boundaries are unsafe, stop and ask the owner for the missing decision.

### 3. Goal/TODO setup

- If an active goal exists and the work is multi-step, inspect current TODOs first.
- In `auto` goal mode, create a bounded TODO plan for long/delegated work; in `manual` mode, ask before creating TODOs.
- Split before parallel writable work: no same-leaf parallel write workers.
- Use fresh canonical TODO IDs from `get_goal_todos` when linking children; if only a visible path is known, pass `child_goal.todo_path` and let the parent runtime resolve it.
- Children must return claims; the parent accepts/rejects only after evidence and, when needed, oracle review.

### 4. Worker-pool metadata

Create/read worker-pool metadata with existing ZOB worker-pool tools when available.

Metadata must be body-free and include:

- pool id / goal id / TODO refs;
- worker roles;
- owned paths and read paths;
- output paths;
- write mode;
- validation commands;
- owner request/decision refs;
- evidence refs/hashes;
- no-ship blockers.

Remember: worker-pool metadata is coordination only and does not dispatch children, mutate TODOs, or apply changes.

### 5. Worker role templates

Prefer 3 workers unless the scale policy justifies otherwise:

- Mapper: inventory paths, evidence, dependencies, risks, and missing inputs.
- Planner/Implementer: produce the report, proposal, sandbox diff candidate, or owned slice output.
- Oracle/QA: review evidence, validation, safety, no-ship status, and completion readiness.

For 5 workers, split into independent lanes such as mapper, lane A, lane B, synthesis, oracle.

For 10/20 workers, require a named lane map, each with a bounded owner, explicit allowed paths, expected output, validation evidence, and no child dispatch.

### 6. Parent-owned dispatch

Dispatch actual work only through parent-owned `delegate_task` or `delegate_agent`.

Before first delegation, use the delegation catalog/routing flow when agent choice or output contract is uncertain. Normally omit child `output_contract`, `required_tools`, and `model` unless a narrower verified choice is required.

Each child contract must include:

- original owner ask when write/edit tools are available;
- exact `allowed_paths` and `forbidden_paths`;
- owned/write paths and read-across refs;
- TODO linkage when applicable;
- `run_in_background=true` only for active-session background runs that the parent will monitor;
- explicit statement: no child-spawns-child, no parent TODO mutation, no commits, no auto-apply.

### 7. Runtime monitoring loop

While background runs are active:

1. Poll/await bounded runs; do not assume daemon persistence.
2. Inspect run status and outputs.
3. Extract `OWNER_CHANGE_REQUEST.v1`, `TODO_SPLIT_REQUEST.v1`, or governed request blocks from child outputs with `zob_governed_request_extract` when available.
4. Record owner decisions through Goal Room/worker-pool owner decision tools when available.
5. Accept, reject, split, defer, or escalate requests parent-owned only.
6. Accept/reject TODO claims only after output contract, evidence, validation, and oracle gates pass.
7. Treat stale/offline/timeout/missing evidence as blockers, not success.
8. Maintain a body-free metadata audit with refs/hashes, not raw child bodies.

If the owner sends an in-flight change request, pause affected lanes, record the request, decide whether to narrow, split, cancel, or relaunch, and update Goal Room metadata before continuing.

### 8. Synthesis and validation

After child outputs return:

- Synthesize worker findings into one parent-owned result.
- Run the narrowest useful validation commands first.
- Escalate validation only with a reason.
- Request oracle review for source-write-gated outputs, risky claims, high/xhigh/max scale, merge readiness, or completion/no-ship decisions.
- Do not propose root goal completion until TODO completion gates are satisfied and oracle `PASS/no_ship=false` is available when required.

### 9. Completion report

Return a concise final result with:

```text
gap_verdict: SUFFICIENT or GAP, with exact evidence
worker_count: selected count and why
worker_outputs: paths/refs and one-line summaries
owner_requests: decisions made or pending
validation_commands: exact commands run, or not run with reason
results: exact outcomes
metadata_audit: pool id, goal/TODO refs, workers, owned paths, read paths, output paths, evidence refs/hashes, no raw bodies
no_ship: true/false with reason
risks/blockers: unresolved risks
compliance: parent-owned dispatch, Goal Room canonical, ZPeer transient, read-across/write-by-owner, no child-spawns-child, no auto-apply, no commits, no secrets
```

## Refusal and stop conditions

Refuse or stop when:

- The owner asks for secrets, credential harvesting, destructive commands, broad unbounded writes, commits, pushes, tags, or force operations.
- Source-write is requested without explicit paths or without sandbox/oracle/human gates.
- The owner requests hidden worker-to-worker chat, child direct dispatch, direct TODO mutation, automatic merge/apply, or unlimited agents.
- Required live/local delivery is absent, stale, or offline and the workflow depends on it.
- Persisted metadata would require raw prompt/output/body/diff/patch content.
- Worker count 10/20 is requested without the required owner approval and budget/compute gates.

## Minimal usage

```text
/skill:zob-owner-pool-launcher Analyze this workflow and launch a small worker pool that returns a clear plan without modifying code.
```

```text
/skill:zob-owner-pool-launcher I want 3 workers: one to map files, one to prepare a proposal, and one oracle to verify it. Reports-only.
```

```text
/skill:zob-owner-pool-launcher Prepare a sandboxed correction for these exact paths, with validation and oracle review, but do not apply anything without my approval.
```

You can also write naturally:

```text
Launch a supervised pool to audit this area, choose 2 to 5 workers as needed, and return with evidence.
```

For 10 or 20 workers, the owner must say it explicitly and accept the compute/budget/safety gates, for example:

```text
/skill:zob-owner-pool-launcher I want to consider 10 workers for this reports-only analysis; ask me for the required validations before launching.
```
