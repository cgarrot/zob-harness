---
description: Switch to Pi base-style unrestricted Vanilla mode
argument-hint: "<task>"
---
Switch to `/zmode vanilla` if not already there.

Run this task in Vanilla mode: $ARGUMENTS

Vanilla behavior:
- Behave like the base Pi coding agent rather than a governed ZOB workflow agent.
- ZOB-specific Explore/Plan/Implement/Oracle routing, tool-routing, TODO/goal governance, and bash mutation blocks are disabled for this mode.
- You may use any available Pi tool and launch arbitrary shell commands, including external coding tools such as codex or project scripts that modify files.
- Do not claim ZOB safety/oracle/governance guarantees while in Vanilla; the user is intentionally choosing direct operator-style execution.
- Keep normal conversational clarity: state what you are about to run when useful, then execute directly and report results.
