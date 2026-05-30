---
description: Implement one bounded slice with verify-before-change and final evidence
argument-hint: "<slice>"
---
Switch to `/zmode implement` if not already there.

Implement this bounded slice: $ARGUMENTS

Rules:
- Before editing, produce a sufficiency verdict: SUFFICIENT/no change or GAP/smallest file set.
- For non-trivial or tool-ambiguous slices, apply `.pi/skills/zob-tool-router/SKILL.md` briefly; use/delegate/skip applicable families and avoid heavy routing for small edits.
- Use surgical edits. No broad rewrites.
- No secrets. No destructive commands. No commits unless explicitly requested.
- Verify with narrowest relevant checks first.
- If a human-decision blocker is already recorded (score >=90, no `nextAgent`, paused goal, visible blocker), report it once and wait for `/goal resume`/`resume_goal`; do not repeat the ask, redispatch, auto-resume, or bypass oracle/no_ship/evidence gates.

Final answer:
- changed files
- verification commands/results
- unresolved risks
- compliance line
- deliverable_delivered: yes/no
