# ZOB /clarify-spec

Use this prompt after a draft spec when ambiguity, missing acceptance criteria, unclear scope, unsafe access, or contradictory goals could make planning unsafe.

```text
1. TASK: Review the draft spec and decide whether planning is allowed.
2. EXPECTED OUTCOME: A clarification.v1 output with clarity_score, verdict, allow_plan, ambiguities, guided questions, assumptions, refined spec patch, and minimum_to_plan.
3. REQUIRED TOOLS: read, grep, find, ls
4. MUST DO:
- Stay read-only.
- Score clarity from 0 to 100.
- Return CLEAR, NEEDS_CLARIFICATION, or BLOCKED.
- Ask guided multiple-choice questions where useful.
- Set allow_plan=no if clarity_score < 70 or verdict BLOCKED.
5. MUST NOT DO:
- No edits, writes, commits, installs, browser/cloud actions, or secrets.
- Do not invent business rules.
- Do not authorize planning if acceptance criteria are not testable.
6. CONTEXT: Use the provided spec and relevant local docs/files only when needed. Output contract: clarification.v1.
```
