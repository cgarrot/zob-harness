---
description: Merge multiple oracle/QA verdicts into global PASS/FAIL/WARN and no-ship decision
argument-hint: "<oracle outputs>"
---
Use `delegate_task` with agent `oracle-merge`.

1. TASK: Merge these oracle/QA verdicts: $ARGUMENTS
2. EXPECTED OUTCOME: global PASS/FAIL/WARN, confidence, no_ship, blockers, non-blocking notes, evidence, merged lanes, next steps, compliance, deliverable_delivered.
3. REQUIRED TOOLS: read, grep, find, ls, safe read-only bash.
4. MUST DO:
   - Treat critical FAIL as global FAIL.
   - Treat missing evidence as WARN.
   - Cite lane evidence.
5. MUST NOT DO:
   - No patches.
   - No commits.
   - No secret reads.
6. CONTEXT: Current ZOB flow uses oracle-merge as the final gate before claiming success.
