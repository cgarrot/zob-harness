---
description: Create a read-only implementation plan with TDD, validation, commits, and stop conditions
argument-hint: "<goal>"
---
Switch to `/zmode plan` if not already there.

Plan this goal without editing files: $ARGUMENTS

Before detailed planning, apply `.pi/skills/zob-tool-router/SKILL.md` when the task is non-trivial or tool selection is ambiguous. Use the smallest sufficient tool set and state which major families are in/out when that affects the plan.

Output must include:
1. Scope table: in / out / forbidden.
2. Tool routing summary: selected mode, applicable families, selected skills, and intentionally skipped heavy families.
3. Assumptions and open questions.
4. Likely files: primary vs only-if-needed.
5. TDD sequence with test names/assertions.
6. Implementation steps by smallest safe slice.
7. Validation ladder: minimum per slice vs full close.
8. Atomic commit strategy. State: no commit unless explicitly requested.
9. Risks and stop conditions, including: if a human-decision blocker is already recorded (score >=90, no `nextAgent`, paused goal, visible blocker), report once and wait for `/goal resume`/`resume_goal`; do not repeat the ask or redispatch.
10. Handoff prompt for implementer using the six-part contract.
