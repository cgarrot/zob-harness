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

Final answer must include: result, evidence, risks/blockers, compliance line, `deliverable_delivered: yes/no`.
