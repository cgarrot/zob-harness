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

1. Parse the owner’s natural-language team/agent description into candidate ZAgent roles, ZTeam membership, rooms, authority, allowed tools, allowed paths, forbidden paths, default ZOB mode, and verification expectations.
2. Analyze the current repo and any owner-provided reference context before writing, staying within allowed paths and avoiding secrets.
3. If the owner mentions model choice, cost, “moins cher”, speed, quality, reasoning, context length, oracle/security strength, or any concrete model/provider, read the project-local model catalog before choosing: prefer `.pi/model-catalog.json` when present, otherwise use `.pi/model-catalog.example.json` as a fallback; also read `.pi/model-routing.json` for valid model classes.
4. Write only project-local artifacts: `.pi/zagents/*.json`, `.pi/zagents/prompts/*.md`, and `.pi/zteams/*.json`.
5. Report the generated files, model choices, model-catalog evidence, and the manual launch instructions; do not automatically spawn processes.
6. Tell the user to inspect `/zteam launch-plan <team-id>` and launch each full Pi session manually with `ZOB_ZAGENT_ID=<id> pi` or, when a ZAgent manifest sets `model`, the launch-plan-provided `ZOB_ZAGENT_ID=<id> pi --model <model>` command. If a manifest sets `defaultMode`, that launched ZAgent session applies the mode on startup.

## Output locations

Generated definitions must stay project-local and are not harness-global:

- ZAgent definitions: `.pi/zagents/*.json`
- ZAgent prompts: `.pi/zagents/prompts/*.md`
- ZTeam definitions: `.pi/zteams/*.json`

Never write generated ZAgent or ZTeam artifacts outside those directories unless the owner explicitly provides a different project-local allowed path.

## Model catalog selection

When the natural-language ask includes model, provider, budget, cheap/expensive, “moins cher”, speed, quality, reasoning, long context, oracle, reviewer, security, or fallback preferences, treat model choice as part of the ZAgent design.

Required read order:

1. `.pi/model-catalog.json` if it exists; otherwise `.pi/model-catalog.example.json` as the bounded fallback catalog.
2. `.pi/model-routing.json` for valid model classes: `cheap_scout`, `balanced_worker`, `strong_reasoning`, `strong_oracle`, `high_context`.

Selection rules:

- Map each ZAgent role to a model class before selecting a concrete model. Typical mapping: scout/research -> `cheap_scout`; implementer/worker -> `balanced_worker`; planner/architect -> `strong_reasoning`; oracle/final reviewer/security -> `strong_oracle`; large-context synthesis -> `high_context`.
- Use catalog fields to justify the choice: `classDefaults`, `agentPreferences`, `models[*].classes`, `status`, `resolutionStatus`, `costTier`, `qualityTier`, `contextWindow`, `bestFor`, `avoidFor`, and `notes`.
- If the owner asks for cheaper models, prefer `free`/`low`/`medium` cost tiers only when the chosen model is not listed in `avoidFor` for that role and does not downgrade oracle/security work.
- Do not make a cheap, experimental, disabled, or unverified model the only `strong_oracle`/security default unless the owner explicitly approves that downgrade for this ZAgent.
- If a model is unverified or the catalog is missing and only the example fallback was available, include that caveat in the final report and in manifest metadata.
- Never invent model IDs, credentials, provider setup, or exact availability. Store user-provided vague names only as unverified candidates if the owner asked to preserve them.
- Keep `.pi/model-routing.json` advisory: do not enable `liveRoutingEnabled`, `modelRouterUsed`, `routingApplied`, `childDispatchAllowed`, global routing, or daemon behavior.

ZAgent manifest model shape:

```json
{
  "model": "openrouter/moonshotai/kimi-k2.6:free",
  "metadata": {
    "modelSelection": {
      "source": ".pi/model-catalog.json",
      "class": "cheap_scout",
      "reason": "Owner asked for a cheaper scout model; catalog marks it free/low-risk for repo_search and not for oracle/security.",
      "resolutionStatus": "unverified",
      "caveats": ["Do not use for final oracle/security review."]
    }
  }
}
```

`/zteam launch-plan <team-id>` prints `--model <manifest.model>` for safe model patterns. If no model is set, Pi uses its default model.

## Default ZOB mode selection

When creating each ZAgent, set `defaultMode` to the smallest ZOB posture that matches the role. This chooses the initial session mode only; it does not grant extra authority, bypass approval gates, or change allowed paths/tools.

Typical mapping:

- repository scout, context finder, read-only researcher -> `explore`
- planner, architect, spec writer, strategy/coordination planner -> `plan`
- implementer, patch author, bounded builder -> `implement`
- reviewer, verifier, no-ship checker, final safety/security judge -> `oracle`
- repeatable workflow/factory designer or runner -> `factory`
- chief/lead/coordinator managing TODOs, delegation, workgraphs, owner protocols -> `orchestrator`
- base Pi/direct unrestricted operator mode -> `vanilla` only when the owner explicitly asks for vanilla/base Pi behavior; never choose `vanilla` by default.

ZAgent manifest mode shape:

```json
{
  "defaultMode": "explore",
  "metadata": {
    "modeSelection": {
      "reason": "Read-only repository scout; no writes expected.",
      "authorityNote": "defaultMode sets initial ZOB posture only and does not expand permissions."
    }
  }
}
```

`/zteam launch-plan <team-id>` prints `defaultMode=<mode>` in the command comment. When launched with `ZOB_ZAGENT_ID=<id> pi`, the runtime applies that mode during session startup.

## Safe workflow

1. Clarify the requested ZAgent purpose, authority, inputs, outputs, allowed tools, and stop conditions from the natural-language ask.
2. Inspect existing project-local conventions before writing any new definition.
3. Draft one bounded ZAgent prompt, ZAgent definition, or ZTeam artifact at a time.
4. Keep every ZAgent scoped to a concrete mission, explicit allowed paths, and auditable verification expectations.
5. Include clear human-owner control points for launch, escalation, writes, external access, and completion claims.
6. Validate the artifact structurally before claiming it is ready.
7. Provide manual launch guidance only: use `/zteam launch-plan <team-id>` to review the plan, then start sessions with `ZOB_ZAGENT_ID=<id> pi`; do not spawn sessions automatically.
8. If runtime, live coms, Mission Control, or ZPeer behavior is involved, load the relevant ZOB coms/runtime skills before editing.
9. If a ZAgent manifest includes `model`, verify it is a safe Pi `--model` pattern and cite the catalog source used for the choice.
10. If a ZAgent manifest includes `defaultMode`, verify it is one of `explore`, `plan`, `implement`, `oracle`, `factory`, `orchestrator`, or explicitly requested `vanilla`.

## MUST DO

- Accept natural-language descriptions of the desired team/agents and convert them into bounded project-local artifacts.
- Use `.pi/zagents/*.json`, `.pi/zagents/prompts/*.md`, and `.pi/zteams/*.json` for outputs.
- State that each ZAgent is a full Pi session tied to ZPeer/live coordination, not a delegated subagent.
- Define purpose, scope, allowed tools, allowed paths, forbidden paths, owner approval gates, verification requirements, default ZOB mode, and expected final report format.
- Set a justified per-ZAgent `defaultMode` from the role, using the smallest sufficient ZOB posture.
- When the ask mentions model choice or cost/quality tradeoffs, read the model catalog/routing files and record a justified per-ZAgent `model` plus metadata instead of guessing.
- Keep definitions minimal, auditable, and project-local.
- Preserve existing runtime code and safety policy unless the owner explicitly asks for a separate implementation task.
- Ask for clarification when authority, launch conditions, write permissions, or external access are ambiguous.

## MUST NOT

- Do not edit runtime code while creating a ZAgent definition.
- Do not add a scaffold slash command or require one for natural-language ZAgent/ZTeam creation.
- Do not create, launch, or spawn actual ZAgent sessions unless explicitly requested as a separate task.
- Do not create manifests or prompts outside `.pi/zagents/`, `.pi/zagents/prompts/`, or `.pi/zteams/`.
- Do not grant broad filesystem, network, browser, secret, commit, push, or destructive-command authority by default.
- Do not enable live/global model routing or store provider credentials/API keys while selecting ZAgent models.
- Do not choose `vanilla` as a default mode unless the owner explicitly requested vanilla/base Pi/direct unrestricted behavior.
- Do not treat ZAgent creation as delivery success for live communication or mission execution.
- Do not commit, push, tag, or modify git state unless the owner explicitly requests governed commit behavior.

## Validation checklist

Before reporting completion, verify:

- [ ] The owner’s natural-language ask was mapped to explicit ZAgent roles, team membership, scope, default ZOB modes, and verification expectations.
- [ ] File path is under `.pi/zagents/`, `.pi/zagents/prompts/`, or `.pi/zteams/`.
- [ ] The artifact names the ZAgent or ZTeam and its bounded mission.
- [ ] It says ZAgents are full Pi sessions tied to ZPeer/live coordination, not delegate subagents.
- [ ] Allowed tools and allowed paths are explicit and minimal.
- [ ] Forbidden paths include secrets and generated/vendor/build areas where applicable.
- [ ] Human-owner approval gates are explicit for launch, writes, external access, commits, and escalation.
- [ ] If model preferences/cost/quality were mentioned, the chosen `model` values cite `.pi/model-catalog.json` or `.pi/model-catalog.example.json`, map to valid `.pi/model-routing.json` classes, and avoid oracle/security downgrade.
- [ ] Each `defaultMode` is valid, role-appropriate, and not `vanilla` unless explicitly requested.
- [ ] Manual launch instructions mention `/zteam launch-plan <team-id>` and `ZOB_ZAGENT_ID=<id> pi` / `ZOB_ZAGENT_ID=<id> pi --model <model>`, with no automatic process spawn.
- [ ] Verification commands or review steps are listed.
- [ ] No runtime code, live ledgers, sessions, or coms files were modified as part of definition creation.
