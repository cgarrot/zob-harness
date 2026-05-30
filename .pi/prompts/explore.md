---
description: Delegate read-only codebase exploration with a structured answer envelope
argument-hint: "<question or area>"
---
Use the `delegate_agent` tool with agent `explore` for this read-only reconnaissance.

Contract:
1. TASK: Explore $ARGUMENTS.
2. EXPECTED OUTCOME: `<files>`, `<answer>`, and `<next_steps>` with paths, key functions/signatures, and line refs where useful.
3. REQUIRED TOOLS: read, grep, find, ls, safe read-only bash.
4. MUST DO: Start with Literal Request / Actual Need / Success Looks Like. Mirror numbered questions. Trace orchestration/entry points if downstream intent requires it.
5. MUST NOT DO: No edits, no writes, no tests/builds unless explicitly allowed, no secrets.
6. CONTEXT: Use current repository and the user's downstream intent.
