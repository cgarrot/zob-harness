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
