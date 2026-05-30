---
description: Delegate sourced external research to librarian with anti-overclaiming guardrails
argument-hint: "<topic>"
---
Use `delegate_agent` with agent `librarian`.

1. TASK: Research $ARGUMENTS for the current project decision.
2. EXPECTED OUTCOME: Bottom-line recommendation, sourced facts, assumptions/unknowns, practical integration implications, safer wording if claims are uncertain.
3. REQUIRED TOOLS: official docs/web/GitHub/local docs as available; no file edits.
4. MUST DO: Prefer primary sources. Label assumptions. Provide fallback/vendor-agnostic wording when source evidence is weak.
5. MUST NOT DO: Do not invent APIs, do not edit files, do not overclaim.
6. CONTEXT: Current project is a Pi-based agent harness and software factory.

End with:
- evidence
- risks/blockers
- compliance
- sources_consulted
- constraints_respected
- deliverable_delivered: yes/no
