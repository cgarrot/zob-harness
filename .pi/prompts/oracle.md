---
description: Run skeptical read-only PASS/FAIL/WARN review via oracle agent
argument-hint: "<thing to review>"
---
Use `delegate_agent` with agent `oracle` to review: $ARGUMENTS

Review contract:
1. TASK: Skeptically verify the claim/change/plan.
2. EXPECTED OUTCOME: PASS / FAIL / WARN with confidence, blockers, non-blocking notes, evidence, next steps.
3. REQUIRED TOOLS: read, grep, find, ls, safe read-only bash.
4. MUST DO: Cite concrete evidence and check prior failure modes.
5. MUST NOT DO: No patches, no commits, no secret access.
6. CONTEXT: Include current user-provided claim, changed files, and verification logs if available.
