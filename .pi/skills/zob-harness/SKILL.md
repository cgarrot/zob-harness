---
name: zob-harness
description: Use when working inside the ZOB Pi harness, designing agentic workflows, creating specialist prompts, adding Pi extensions, or turning repeated tasks into software factories.
---
# ZOB Harness Skill

## When to use

Use this skill for any task involving:
- Pi extensions, prompt templates, skills, or agent definitions.
- Multi-agent delegation workflows.
- Safety gates and damage-control policy.
- Software-factory design from repeated manual workflows.
- Runtime tool/command routing via `.pi/capabilities/zob-public-runtime-capabilities.json`.

For routing behavior, load `zob-tool-router` before non-trivial or tool-ambiguous work. For compaction/recovery behavior, load `zob-compaction-policy` before changing compaction hooks or resuming from a compacted long-running goal. For domain behavior, load the domain skill named by the registry instead of inlining details here: `zob-goal-todo-tree`, `zob-coms-v2-live`, `zob-coms-safety`, `zob-mission-control-coms`, `zob-autonomous-runtime`, `zob-factory`, `zob-sandbox`, `zob-oracle`, or `zob-spec` as applicable.

## Operating model

1. Classify the task as one of: `explore`, `plan`, `implement`, `oracle`, `factory`, `orchestrator`.
2. For non-trivial or tool-ambiguous work, apply `zob-tool-router`: classify applicable families, then use/delegate/skip each with a reason.
3. Use `orchestrator` when the task needs Chief Vision coordination, multi-agent decomposition, Lead/Worker routing, goal/TODO graph governance, or parent-owned dispatch; the root should delegate substantive work rather than do it directly.
4. Check `.pi/capabilities/zob-public-runtime-capabilities.json` for the relevant tool/command family, mode allowlist, skill refs, and no-ship notes.
5. If broad or risky, use the `delegate_agent` tool before editing.
6. For delegated work, use the six-part contract:
   - TASK
   - EXPECTED OUTCOME
   - REQUIRED TOOLS
   - MUST DO
   - MUST NOT DO
   - CONTEXT
7. For code changes, verify with the smallest relevant command first.
8. End with evidence and a compliance line.

## Planning in auto-mode

When the user asks for a plan:
- Produce exactly one plan for the request.
- If you already produce the plan in the current response, do not emit a `mode="plan"` intent.
- Emit a `mode="plan"` intent only when deliberately deferring the actual detailed plan to the next turn; keep that response to a short handoff.
- Never both: full plan content and `mode="plan"` intent in the same response.
- If a prior assistant response already contained a complete plan for the same request, do not restate it; summarize that the plan exists and ask whether to refine, save, or implement it.
- The harness may auto-capture complete plans into `plans/`; do not manually duplicate that artifact unless the user asks.

## Project files

- Extension: `.pi/extensions/zob-harness/index.ts`
- Agents: `.pi/agents/*.md`
- Prompt templates: `.pi/prompts/*.md`
- Capability registry: `.pi/capabilities/zob-public-runtime-capabilities.json`
- Damage rules: `.pi/damage-control-rules.json`
- Architecture docs: `docs/`
- Goal TODO tree plan: `docs/ZOB_GOAL_TODO_TREE_PLAN.md`

## Safety reminders

- Never read `.env` or secrets. Ask the user instead.
- Never run destructive git/shell commands without explicit approval.
- Do not commit unless explicitly requested.
- Stop-on-blocker: when a human-decision blocker is already visible on a paused goal (score >=90, no `nextAgent`), report once and wait for `/goal resume` or `resume_goal`; do not repeat the ask, redispatch, auto-resume, or bypass oracle/no_ship/evidence gates.
