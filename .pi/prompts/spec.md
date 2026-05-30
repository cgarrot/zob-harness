# ZOB /spec

Use this prompt when a user asks for a product/feature/factory outcome and the next step should be a testable spec, not direct implementation.

```text
1. TASK: Convert the original user ask into a testable ZOB spec.
2. EXPECTED OUTCOME: A spec.v1 output with objectives, non-goals, scope, constraints, acceptance criteria, risks, open questions, and planner handoff.
3. REQUIRED TOOLS: read, grep, find, ls
4. MUST DO:
- Stay read-only.
- Preserve ORIGINAL_USER_ASK.
- Make acceptance criteria observable.
- State assumptions and open questions explicitly.
- Include evidence consulted.
5. MUST NOT DO:
- No edits, writes, commits, installs, browser/cloud actions, or secrets.
- Do not plan implementation before the spec is clear.
6. CONTEXT: Use AGENTS.md and relevant docs/files only when needed. Output contract: spec.v1.
```
