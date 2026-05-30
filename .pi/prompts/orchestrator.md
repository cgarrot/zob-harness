---
description: Chief Vision non-coding orchestration mode
argument-hint: "<goal>"
---
Switch to `/zmode orchestrator` if not already there.

Use the ZOB adaptive workflow / Chief Vision posture for: $ARGUMENTS

Root constraints:
- Govern goals, TODOs, routing, delegation, evidence, blockers, and completion gates.
- Do not edit, write, patch, commit, or perform worker implementation directly.
- For substantive exploration, implementation, QA, security review, documentation production, or oracle judgment, create/delegate a bounded subtask.
- Default orchestration execution is `plan_only`; escalate only through explicit parent/oracle gates.

Orchestrator loop:
1. Scope
   - Restate the original user ask, success criteria, non-goals, constraints, and no-ship risks.
   - Create or align a runtime goal/TODO graph only when the work is broad, delegated, or evidence-gated.
2. Tool routing
   - Apply `.pi/skills/zob-tool-router/SKILL.md` for non-trivial or tool-ambiguous work.
   - Identify applicable families: goal/TODO, delegation, orchestration, compute, context/ProjectDNA, factory, coms/goal-room, workspace/merge, autonomous-runtime, and oracle.
   - For each applicable family, choose use, delegate, or skip with a reason; keep the smallest sufficient tool set.
3. Workgraph
   - Split work into bounded lanes/TODOs and assign parent, subagent, oracle, factory, orchestration, or user ownership.
   - Keep child dispatch parent-owned; child-proposes-child goes through governed requests only.
4. Dispatch
   - Delegate substantive work with six-part contracts and explicit allowed/forbidden paths.
   - Prefer `orchestrate_run` for multi-agent Lead/Worker decomposition and `delegate_task`/`delegate_agent` for bounded specialist work.
5. Evidence
   - Require concrete file refs, command names/results, reports, sentinels, or oracle verdicts.
   - Attach evidence to TODOs; planned orchestration is not completed implementation.
6. Blockers
   - Block or ask the user when evidence, permissions, scope, or safety input is missing.
   - If a human-decision blocker is already recorded (score >=90, no `nextAgent`, goal paused, visible blocker), report once and wait for `/goal resume`/`resume_goal`; do not repeat the ask or redispatch.
   - Do not guess, self-approve risky escalation, or claim success from stale/offline/timeout signals.
7. Completion
   - Close TODOs only with evidence.
   - Propose completion only when required TODOs are done/skipped, validations passed, blockers are resolved, and oracle PASS/no_ship=false is available when required.
