---
name: zob-compaction-policy
description: Use when reviewing, designing, triggering, or recovering from ZOB/Pi context compaction, branch summaries, long-goal continuation, or post-compaction skill/context reloads.
---
# ZOB Compaction Policy Skill

## When to use

Use this skill when:

- context usage is high or compaction happened recently;
- a runtime `/goal` continuation is near context limits;
- `/tree` branch summarization may lose important ZOB state;
- the agent must resume work from a compacted summary;
- changing compaction hooks, context summaries, prompt stacks, or session continuity behavior.

Canonical policy doc: `docs/ZOB_COMPACTION_POLICY.md`.

## Core rule

A ZOB compaction summary is a **continuity index**, not the source of truth. Preserve refs, decisions, state, evidence, blockers, and next actions; reload detailed skills/docs/files by path when needed.

## Source-of-truth hierarchy

1. Persisted ZOB state and ledgers.
2. Repo files and cited artifacts.
3. Compaction or branch summary.
4. Model memory from before compaction.

Prefer `get_goal`, `get_goal_todos`, safe file reads, reports, and validation artifacts over assumptions from memory.

## Mandatory preservation checklist

When creating or reviewing a compaction summary, ensure it captures:

- original user ask, constraints, non-goals, success criteria;
- active ZOB mode and role boundary;
- runtime goal id/objective/status/oracle/no-ship state;
- TODO graph summary, active/open/blocked/delegated/claim-returned TODOs, evidence refs, validation commands, next TODO;
- current work thread: current slice, last action, next exact action, what not to redo;
- critical skill/prompt/doc/source/report refs to reload;
- key decisions and rationale;
- files read/modified and why they matter, without full bodies;
- delegation run ids, agents, statuses, gate result, no-ship/evidence summary;
- validations and artifact refs;
- blockers and hard/review/effective no-ship;
- reload rules;
- body policy: refs/hashes only for persisted metadata.

## Budget policy

- Target: 3k-5k tokens.
- Hard cap: 8k tokens.
- Small tasks: 1k-2k tokens.
- If over budget, shrink resolved details, verbose subagent summaries, superseded validations, and long file lists before touching blockers/no-ship/TODO/next action.

## Refs-not-bodies policy

Do not paste full skills, prompts, file bodies, raw subagent outputs, raw diffs, raw tool outputs, secrets, or credentials. Keep refs and reload rules instead.

Examples:

```text
critical_skill_refs:
- .pi/skills/zob-tool-router/SKILL.md
- .pi/skills/zob-goal-todo-tree/SKILL.md
- .pi/skills/zob-compaction-policy/SKILL.md

reload_rules:
- Re-read the relevant skill before applying detailed behavior.
- Re-read changed files before editing after compaction.
```

## Post-compaction behavior

After compaction:

1. Trust persisted state and artifacts over summary prose.
2. Re-read critical skills/docs/files before detailed changes.
3. Re-check active goal/TODO state before completing or delegating.
4. Re-run or inspect validation evidence before claiming success.
5. If blockers/no-ship were compacted, resolve them explicitly before completion.

## No-ship conditions

Treat these as blockers:

- compaction summary lost active goal/TODO/blocker state;
- raw prompt/output/diff bodies are stored in ZOB compaction details or ledgers;
- post-compaction completion relies only on summary memory;
- critical skill/doc refs are missing for a long-running or delegated task;
- no-ship or oracle status is unknown but completion is attempted.
