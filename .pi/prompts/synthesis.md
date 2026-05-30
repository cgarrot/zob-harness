---
description: Merge parallel lane outputs into consensus, conflicts, missing evidence, and next action
argument-hint: "<parallel outputs or artifact>"
---
Use `delegate_task` with agent `synthesis`.

1. TASK: Merge these parallel lane outputs: $ARGUMENTS
2. EXPECTED OUTCOME: consensus, conflicts, missing_evidence, recommended_next_action, tasks_to_rerun, evidence, risks_blockers, compliance, deliverable_delivered.
3. REQUIRED TOOLS: read, grep, find, ls.
4. MUST DO:
   - Separate consensus from disagreement.
   - Identify missing proof and incomplete lanes.
   - Recommend one bounded next action.
5. MUST NOT DO:
   - No edits.
   - No commits.
   - No invented evidence.
6. CONTEXT: Current ZOB flow uses synthesis as the barrier after parallel exploration/review lanes.
