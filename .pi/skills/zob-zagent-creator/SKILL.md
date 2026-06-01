---
name: zob-zagent-creator
description: Use when designing or creating project-local ZAgent definitions or ZTeam bundles for full Pi-session agents tied to ZPeer, distinct from delegate subagents.
---
# ZOB ZAgent Creator Skill

## When to use

Use this skill when the owner asks to create, review, or safely prepare project-local ZAgents or ZTeams.

ZAgents are **full Pi sessions tied to ZPeer presence and live coordination**. They are not `delegate_agent`/`delegate_task` subagents, not ephemeral child workers, and not a shortcut around normal ZOB safety, routing, verification, or owner approval gates.

## Natural-language creator workflow

This skill is for an owner who describes the desired team or agents in natural language. The assistant translates that request into project-local ZAgent/ZTeam files; it does **not** require or create a scaffold slash command.

Example owner asks:

- "J'ai besoin d'une team de trois agents: un planificateur, un implementer et un oracle pour refactorer ce repo."
- "Create a research ZAgent and a reviewer ZAgent that coordinate in one team, but keep all writes owner-approved."
- "I need a product-spec team that reads this repository, drafts prompts, and tells me how to launch each session manually."

The assistant should:

1. Parse the owner’s natural-language team/agent description into candidate ZAgent roles, ZTeam membership, rooms, authority, allowed tools, allowed paths, forbidden paths, and verification expectations.
2. Analyze the current repo and any owner-provided reference context before writing, staying within allowed paths and avoiding secrets.
3. Write only project-local artifacts: `.pi/zagents/*.json`, `.pi/zagents/prompts/*.md`, and `.pi/zteams/*.json`.
4. Report the generated files and the manual launch instructions; do not automatically spawn processes.
5. Tell the user to inspect `/zteam launch-plan <team-id>` and launch each full Pi session manually with `ZOB_ZAGENT_ID=<id> pi` when they are ready.

## Output locations

Generated definitions must stay project-local and are not harness-global:

- ZAgent definitions: `.pi/zagents/*.json`
- ZAgent prompts: `.pi/zagents/prompts/*.md`
- ZTeam definitions: `.pi/zteams/*.json`

Never write generated ZAgent or ZTeam artifacts outside those directories unless the owner explicitly provides a different project-local allowed path.

## Safe workflow

1. Clarify the requested ZAgent purpose, authority, inputs, outputs, allowed tools, and stop conditions from the natural-language ask.
2. Inspect existing project-local conventions before writing any new definition.
3. Draft one bounded ZAgent prompt, ZAgent definition, or ZTeam artifact at a time.
4. Keep every ZAgent scoped to a concrete mission, explicit allowed paths, and auditable verification expectations.
5. Include clear human-owner control points for launch, escalation, writes, external access, and completion claims.
6. Validate the artifact structurally before claiming it is ready.
7. Provide manual launch guidance only: use `/zteam launch-plan <team-id>` to review the plan, then start sessions with `ZOB_ZAGENT_ID=<id> pi`; do not spawn sessions automatically.
8. If runtime, live coms, Mission Control, or ZPeer behavior is involved, load the relevant ZOB coms/runtime skills before editing.

## MUST DO

- Accept natural-language descriptions of the desired team/agents and convert them into bounded project-local artifacts.
- Use `.pi/zagents/*.json`, `.pi/zagents/prompts/*.md`, and `.pi/zteams/*.json` for outputs.
- State that each ZAgent is a full Pi session tied to ZPeer/live coordination, not a delegated subagent.
- Define purpose, scope, allowed tools, allowed paths, forbidden paths, owner approval gates, verification requirements, and expected final report format.
- Keep definitions minimal, auditable, and project-local.
- Preserve existing runtime code and safety policy unless the owner explicitly asks for a separate implementation task.
- Ask for clarification when authority, launch conditions, write permissions, or external access are ambiguous.

## MUST NOT

- Do not edit runtime code while creating a ZAgent definition.
- Do not add a scaffold slash command or require one for natural-language ZAgent/ZTeam creation.
- Do not create, launch, or spawn actual ZAgent sessions unless explicitly requested as a separate task.
- Do not create manifests or prompts outside `.pi/zagents/`, `.pi/zagents/prompts/`, or `.pi/zteams/`.
- Do not grant broad filesystem, network, browser, secret, commit, push, or destructive-command authority by default.
- Do not treat ZAgent creation as delivery success for live communication or mission execution.
- Do not commit, push, tag, or modify git state unless the owner explicitly requests governed commit behavior.

## Validation checklist

Before reporting completion, verify:

- [ ] The owner’s natural-language ask was mapped to explicit ZAgent roles, team membership, scope, and verification expectations.
- [ ] File path is under `.pi/zagents/`, `.pi/zagents/prompts/`, or `.pi/zteams/`.
- [ ] The artifact names the ZAgent or ZTeam and its bounded mission.
- [ ] It says ZAgents are full Pi sessions tied to ZPeer/live coordination, not delegate subagents.
- [ ] Allowed tools and allowed paths are explicit and minimal.
- [ ] Forbidden paths include secrets and generated/vendor/build areas where applicable.
- [ ] Human-owner approval gates are explicit for launch, writes, external access, commits, and escalation.
- [ ] Manual launch instructions mention `/zteam launch-plan <team-id>` and `ZOB_ZAGENT_ID=<id> pi`, with no automatic process spawn.
- [ ] Verification commands or review steps are listed.
- [ ] No runtime code, live ledgers, sessions, or coms files were modified as part of definition creation.
