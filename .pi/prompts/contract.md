---
description: Six-part contract for a delegated agent task
argument-hint: "<task>"
---
1. TASK: $ARGUMENTS
2. EXPECTED OUTCOME: [observable artifact/verdict/change]
3. REQUIRED TOOLS: [allowed tools only]
4. MUST DO:
   - Restate constraints before tool use.
   - Inspect real current state before conclusions.
   - Return concrete evidence.
5. MUST NOT DO:
   - Do not read or write secrets.
   - Do not run destructive commands.
   - Do not commit unless explicitly requested.
6. CONTEXT:
   - Paths:
   - Prior evidence:
   - Downstream use:

Structured `delegate_task` JSON uses canonical keys: `expected_outcome`, `required_tools`, `must_do`, `must_not_do`, `original_user_ask`, `allowed_paths`, `forbidden_paths`, `output_contract`, `run_in_background`, `child_goal`, `load_skills`. Safe aliases such as `expectedOutcome`, `mustDo`, `mustNotDo`/`must_not`/`mustNot`, `originalUserAsk`, `allowedPaths`, `forbiddenPaths`, `requiredTools`, `outputContract`, `runInBackground`, `childGoal`, and `loadSkills` are accepted only when they do not conflict with canonical values.

`allowed_paths` must be repo-relative-only grants (no absolute paths, `~`, traversal, broad roots, or NUL). If a child needs external context, create or cite a repo-local snapshot/context_ref under `reports/...` and pass that repo-relative artifact. `forbidden_paths` are deny-only and may use specific repo-local, absolute, or home-relative patterns when safe.

TODO-linked `child_goal` rules: refresh active TODO refs before delegation; set `child_goal.todo_id` only to a freshly verified canonical active id such as `<canonical-active-todo-id>`; when not freshly verified, set `child_goal.todo_path` such as `<visible-todo-path>` instead of inventing shorthand ids. Safe auto-open/delegation is limited to `planned`, `ready`, `in_progress`, or `needs_review` TODOs with no active child/run. Children return claims or `TODO_SPLIT_REQUEST.v1`; they do not mutate parent TODOs, apply XDEF splits, or spawn child agents. Split broad/parallel work into subtodos before dispatch, and do not assign multiple same-leaf write workers.

Final answer must include: result, evidence, risks/blockers, compliance line, `deliverable_delivered: yes/no`.
