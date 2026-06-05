---
name: harness-intake
description: Use when the user wants to analyze another agent harness such as Claude Code, Codex, Cursor, Aider, Pi/ZOB, existing skills/commands/prompts/sessions, and turn reliable patterns into reusable ZOB agent teams or factory proposals.
---
# Harness Intake Skill

## When to use

Use this skill when the user asks to:

- analyze a Claude Code, Codex, Cursor, Aider, Pi/ZOB, or custom agent harness setup;
- inspect `AGENTS.md`, `CLAUDE.md`, `.claude/agents`, `.claude/commands`, `.codex`, `.cursor`, skills, prompts, or commands;
- understand existing agent sessions/conversations to recover real workflows;
- create or propose reusable ZOB teams of agents;
- convert repeated external harness workflows into ZOB factory proposals;
- launch a visible tmux-backed agent team for a long harness analysis.

## UX rule: natural language first

The user should not have to hand-write JSON. Treat natural language as the input source and compile it into an internal run spec under `reports/factory-runs/<run-id>/inferred-run-spec.json`.

Good user requests:

```text
Analyse ce setup Claude Code dans ../repo-x et propose une team ZOB réutilisable.
```

```text
Tu peux lire les sessions de ../repo-x; comprends les workflows récurrents et propose une factory d'agents.
```

```text
Lance une team tmux visible pour analyser ce harness Codex.
```

## Entry points

Preferred CLI/script entry points:

```bash
npm run harness:intake -- "Analyse ../repo-x comme setup Claude Code et propose une team"
npm run harness:intake:smoke
npm run harness:intake:tmux -- start "Analyse ../repo-x avec sessions autorisées"
npm run harness:intake:validate -- <run_id>
```

Core implementation paths:

```text
scripts/harness-intake/launch.mjs
scripts/harness-intake/infer-run-spec.mjs
scripts/harness-intake/scan-sources.mjs
scripts/harness-intake/validate-run.mjs
scripts/harness-intake/tmux-launch.mjs
.pi/factories/harness-intake-agent-team/
.pi/teams/harness-intake-team.json
.pi/agents/harness-*.md
```

## Default workflow

1. Infer target path, harness hint, goal, mode, and session posture from the user's request.
2. Ask only critical missing questions, such as target path or explicit session authorization.
3. Create `request.md`, `inferred-run-spec.json`, `manifest.json`, and `agentic-plan.json` in the run directory.
4. Run static source cartography.
5. Build harness, skill, command, prompt, and workflow profiles.
6. Mine sessions only if explicit authorization is recorded.
7. Generate ZOB team candidates in quarantine.
8. Generate factory candidates in quarantine when evidence is sufficient.
9. Validate artifacts and write oracle review.
10. Never activate generated teams/factories automatically.

## Session policy

Sessions/conversations can be highly informative but sensitive.

- Require explicit authorization before reading sessions.
- If sessions are mentioned but not authorized, skip session mining and report the blocker.
- Do not persist raw session bodies in generated artifacts.
- Persist hashes, metrics, safe refs, and redacted evidence indexes only.
- Do not use sessions alone to declare a factory activation-ready.

## Safety rules

- Never read `.env`, keys, tokens, credentials, `~/.ssh`, `~/.aws`, or secret-like files.
- Do not mutate the source project being analyzed.
- Keep generated proposals under `reports/factory-runs/<run-id>/generated-proposals/`.
- Do not copy generated files into `.pi/agents`, `.pi/teams`, `.pi/skills`, or `.pi/factories` without explicit owner activation.
- Every important claim should cite a run artifact or source line ref.
- Treat tmux launch as visibility only, not validation success.

## Team vs factory

A team is the group of agents that does the analysis.

A factory packages the workflow so the same team/process can be relaunched, validated, and scaled through smoke/pilot/batch.

In this workflow:

> Natural language request -> internal run spec -> analysis team -> quarantined team/factory proposals -> validation -> optional manual activation.
