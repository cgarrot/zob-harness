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
4. Write only project-local artifacts: `.pi/zagents/*.json`, `.pi/zagents/prompts/*.md`, `.pi/zteams/*.json`, and, only when the owner explicitly requests `tmux`, `.pi/zteams/*.tmux.sh`.
5. Report the generated files, model choices, model-catalog evidence, tmux bundle details when applicable, and the manual launch instructions; do not automatically spawn processes.
6. Tell the user to inspect `/zteam launch-plan <team-id>` and launch each full Pi session manually with `ZOB_ZAGENT_ID=<id> pi` or, when a ZAgent manifest sets `model`, the launch-plan-provided `ZOB_ZAGENT_ID=<id> pi --model <model>` command. If a manifest sets `defaultMode`, that launched ZAgent session applies the mode on startup. When a tmux launcher was generated, tell the user it is a manual convenience wrapper around those commands, not proof that agents were launched.

## Output locations

Generated definitions must stay project-local and are not harness-global:

- ZAgent definitions: `.pi/zagents/*.json`
- ZAgent prompts: `.pi/zagents/prompts/*.md`
- ZTeam definitions: `.pi/zteams/*.json`
- Optional tmux launchers, only when explicitly requested: `.pi/zteams/*.tmux.sh`

Never write generated ZAgent, ZTeam, prompt, or tmux launcher artifacts outside those directories unless the owner explicitly provides a different project-local allowed path.

## Optional tmux launcher mode

When the owner starts or qualifies the natural-language request with `tmux`, generate a project-local tmux launcher script alongside the generated ZTeam manifests. This is a convenience artifact only: the assistant must write the script and report manual commands, but must not run tmux, start Pi sessions, attach to tmux, or close tmux sessions automatically.

Accepted owner request patterns include:

- `/skill:zob-zagent-creator tmux ...`
- `/skill:zob-zagent-creator tmux team ...`
- `/skill:zob-zagent-creator tmux connected ...`
- `/skill:zob-zagent-creator tmux all ...`

Tmux scope rules:

- `tmux team`: include only the primary generated ZTeam's direct members.
- `tmux connected`: include the primary ZTeam plus every generated or existing ZTeam connected through shared ZAgent membership. This is the default when the owner says only `tmux`, especially when the request describes bridge agents, multiple teams, or agents that belong to more than one team.
- `tmux all`: include every ZTeam generated for the owner's request.

A tmux launcher represents a **bundle** of teams and unique agents, not necessarily a single team. Use a safe bundle id such as `<team-id>` for simple teams or `<mission-id>-bundle` for multi-team connected graphs. Also record the intended owner entry point in the primary ZTeam manifest as `metadata.entryAgent` (and optionally `metadata.entryRoom`) when absent; choose the lead/orchestrator agent if one exists, otherwise the first unique agent. Write the launcher to:

```text
.pi/zteams/<bundle-id>.tmux.sh
```

The launcher must create one tmux session for the bundle and one tmux window per unique ZAgent id:

```text
session: zob-<bundle-id>
  window: <zagent-id-1>
  window: <shared-bridge-zagent-id>
  window: <zagent-id-2>
```

Deduplicate agents by `zagentId` only. Do not launch the same bridge/shared ZAgent once per team. A shared ZAgent should be launched once with `ZOB_ZAGENT_ID=<id> pi`; the runtime can resolve its rooms and team memberships from the ZAgent and ZTeam manifests.

The script must support these manual subcommands:

```bash
./.pi/zteams/<bundle-id>.tmux.sh start [agent]   # create the tmux session if absent, then attach entryAgent or named agent
./.pi/zteams/<bundle-id>.tmux.sh attach [agent]  # attach to entryAgent or named agent in an existing session
./.pi/zteams/<bundle-id>.tmux.sh window <agent>  # alias for attach <agent>
./.pi/zteams/<bundle-id>.tmux.sh list            # list entryAgent and available agent windows
./.pi/zteams/<bundle-id>.tmux.sh status          # list bundle windows/session status
./.pi/zteams/<bundle-id>.tmux.sh close           # close only this bundle's tmux session
```

Script safety requirements:

- Use `#!/usr/bin/env bash` and `set -euo pipefail`.
- Check `command -v tmux` before any tmux operation.
- Use a safe session name like `zob-<bundle-id>` and safe tmux window names derived from validated ZAgent ids.
- Choose an entry agent for the bundle. Prefer `team.metadata.entryAgent` when present; otherwise use the first unique ZAgent in the launcher.
- If `start` sees that the session already exists, attach to the entry agent or requested agent instead of creating duplicate Pi processes.
- `start [agent]`, `attach [agent]`, and `window <agent>` must validate the target against the launcher `AGENTS` list before passing it to tmux.
- `close` may call only `tmux kill-session -t "$SESSION_NAME"`; do not use `killall`, broad process kills, destructive shell commands, or global cleanup.
- Quote shell values safely. Do not inject raw natural-language text into shell commands.
- Only include `--model <model>` when the model value passes the same safe pattern expected by `/zteam launch-plan`; otherwise omit it and report the omission.
- Keep the script local-only and manual; it must not perform network setup, credential access, commits, pushes, or background daemon installation.

Recommended launcher shape:

```bash
#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="zob-<bundle-id>"
ENTRY_AGENT="planner" # prefer team.metadata.entryAgent; fallback AGENTS[0]
AGENTS=("planner" "bridge-agent" "oracle")
MODELS=("" "" "openrouter/example/model")

require_tmux() {
  command -v tmux >/dev/null 2>&1 || { echo "tmux is required"; exit 1; }
}

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

safe_window_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '-'
}

is_known_agent() {
  local candidate="${1:-}"
  local agent
  for agent in "${AGENTS[@]}"; do
    if [ "$agent" = "$candidate" ]; then return 0; fi
  done
  return 1
}

resolve_target_agent() {
  local requested="${1:-$ENTRY_AGENT}"
  if ! is_known_agent "$requested"; then
    echo "Unknown agent/window: $requested" >&2
    echo "Known agents:" >&2
    printf '  %s\n' "${AGENTS[@]}" >&2
    exit 2
  fi
  printf '%s' "$requested"
}

attach_to_agent() {
  require_tmux
  local target="$(resolve_target_agent "${1:-$ENTRY_AGENT}")"
  local window="$(safe_window_name "$target")"
  if ! session_exists; then
    echo "session not running: $SESSION_NAME" >&2
    echo "Run: $0 start $target" >&2
    exit 1
  fi
  tmux select-window -t "$SESSION_NAME:$window"
  tmux attach -t "$SESSION_NAME:$window"
}

start_session() {
  require_tmux
  local target="$(resolve_target_agent "${1:-$ENTRY_AGENT}")"
  local target_window="$(safe_window_name "$target")"
  if session_exists; then
    attach_to_agent "$target"
    exit 0
  fi
  local first="${AGENTS[0]}"
  local first_window="$(safe_window_name "$first")"
  tmux new-session -d -s "$SESSION_NAME" -n "$first_window"
  for i in "${!AGENTS[@]}"; do
    agent="${AGENTS[$i]}"
    model="${MODELS[$i]}"
    window="$(safe_window_name "$agent")"
    if [ "$i" -ne 0 ]; then tmux new-window -t "$SESSION_NAME" -n "$window"; fi
    if [ -n "$model" ]; then
      tmux send-keys -t "$SESSION_NAME:$window" "ZOB_ZAGENT_ID=$agent pi --model $model" C-m
    else
      tmux send-keys -t "$SESSION_NAME:$window" "ZOB_ZAGENT_ID=$agent pi" C-m
    fi
  done
  tmux select-window -t "$SESSION_NAME:$target_window"
  tmux attach -t "$SESSION_NAME:$target_window"
}

list_agents() {
  printf 'entry: %s\n' "$ENTRY_AGENT"
  printf 'agents:\n'
  printf '  %s\n' "${AGENTS[@]}"
}

case "${1:-start}" in
  start) start_session "${2:-$ENTRY_AGENT}" ;;
  attach) attach_to_agent "${2:-$ENTRY_AGENT}" ;;
  window) attach_to_agent "${2:-$ENTRY_AGENT}" ;;
  list) list_agents ;;
  status) require_tmux; tmux list-windows -t "$SESSION_NAME" ;;
  close) require_tmux; tmux kill-session -t "$SESSION_NAME" ;;
  *) echo "Usage: $0 start [agent]|attach [agent]|window <agent>|list|status|close"; exit 2 ;;
esac
```

When reporting a generated tmux launcher, include the bundle id, session name, scope (`team`, `connected`, or `all`), teams included, unique ZAgents included, shared/bridge ZAgents deduplicated, entry agent/window, whether `metadata.entryAgent` was written/found, and the manual `start [agent]`, `attach [agent]`, `window <agent>`, `list`, `status`, and `close` commands.

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
8. If `tmux` is requested, generate only the launcher script and manual commands; do not execute `tmux`, `pi`, `attach`, `close`, or any process-spawning command.
9. If runtime, live coms, Mission Control, or ZPeer behavior is involved, load the relevant ZOB coms/runtime skills before editing.
10. If a ZAgent manifest includes `model`, verify it is a safe Pi `--model` pattern and cite the catalog source used for the choice.
11. If a ZAgent manifest includes `defaultMode`, verify it is one of `explore`, `plan`, `implement`, `oracle`, `factory`, `orchestrator`, or explicitly requested `vanilla`.
12. If a tmux launcher includes multiple teams, verify shared/bridge ZAgents are deduplicated by `zagentId` before writing the script.

## MUST DO

- Accept natural-language descriptions of the desired team/agents and convert them into bounded project-local artifacts.
- Use `.pi/zagents/*.json`, `.pi/zagents/prompts/*.md`, and `.pi/zteams/*.json` for normal outputs; use `.pi/zteams/*.tmux.sh` only for explicitly requested tmux launchers.
- State that each ZAgent is a full Pi session tied to ZPeer/live coordination, not a delegated subagent.
- Define purpose, scope, allowed tools, allowed paths, forbidden paths, owner approval gates, verification requirements, default ZOB mode, and expected final report format.
- Set a justified per-ZAgent `defaultMode` from the role, using the smallest sufficient ZOB posture.
- When the ask mentions model choice or cost/quality tradeoffs, read the model catalog/routing files and record a justified per-ZAgent `model` plus metadata instead of guessing.
- Keep definitions minimal, auditable, and project-local.
- When generating tmux launchers, treat multi-team requests as bundles, deduplicate shared agents by `zagentId`, and document included teams, unique agents, and bridge/shared agents.
- Preserve existing runtime code and safety policy unless the owner explicitly asks for a separate implementation task.
- Ask for clarification when authority, launch conditions, write permissions, or external access are ambiguous.

## MUST NOT

- Do not edit runtime code while creating a ZAgent definition.
- Do not add a scaffold slash command or require one for natural-language ZAgent/ZTeam creation.
- Do not create, launch, or spawn actual ZAgent sessions unless explicitly requested as a separate task.
- Do not create manifests, prompts, or tmux launchers outside `.pi/zagents/`, `.pi/zagents/prompts/`, or `.pi/zteams/`.
- Do not grant broad filesystem, network, browser, secret, commit, push, or destructive-command authority by default.
- Do not generate tmux launchers that duplicate shared ZAgents per team, use `killall`, broad process kills, install daemons, access credentials, or perform global cleanup.
- Do not enable live/global model routing or store provider credentials/API keys while selecting ZAgent models.
- Do not choose `vanilla` as a default mode unless the owner explicitly requested vanilla/base Pi/direct unrestricted behavior.
- Do not treat ZAgent creation as delivery success for live communication or mission execution.
- Do not commit, push, tag, or modify git state unless the owner explicitly requests governed commit behavior.

## Validation checklist

Before reporting completion, verify:

- [ ] The owner’s natural-language ask was mapped to explicit ZAgent roles, team membership, scope, default ZOB modes, and verification expectations.
- [ ] File path is under `.pi/zagents/`, `.pi/zagents/prompts/`, or `.pi/zteams/`; tmux launchers, when requested, use `.pi/zteams/*.tmux.sh`.
- [ ] The artifact names the ZAgent or ZTeam and its bounded mission.
- [ ] It says ZAgents are full Pi sessions tied to ZPeer/live coordination, not delegate subagents.
- [ ] Allowed tools and allowed paths are explicit and minimal.
- [ ] Forbidden paths include secrets and generated/vendor/build areas where applicable.
- [ ] Human-owner approval gates are explicit for launch, writes, external access, commits, and escalation.
- [ ] If model preferences/cost/quality were mentioned, the chosen `model` values cite `.pi/model-catalog.json` or `.pi/model-catalog.example.json`, map to valid `.pi/model-routing.json` classes, and avoid oracle/security downgrade.
- [ ] Each `defaultMode` is valid, role-appropriate, and not `vanilla` unless explicitly requested.
- [ ] Manual launch instructions mention `/zteam launch-plan <team-id>` and `ZOB_ZAGENT_ID=<id> pi` / `ZOB_ZAGENT_ID=<id> pi --model <model>`, with no automatic process spawn.
- [ ] If tmux was requested, the primary ZTeam has `metadata.entryAgent` or the report states the fallback first agent.
- [ ] If tmux was requested, the report lists bundle id, session name, scope, teams included, unique agents, shared/bridge agents, entry agent/window, and manual `start [agent]`/`attach [agent]`/`window <agent>`/`list`/`status`/`close` commands.
- [ ] If tmux was requested, shared/bridge ZAgents are deduplicated by `zagentId`, and the script uses only bounded tmux operations for the bundle session.
- [ ] Verification commands or review steps are listed.
- [ ] No runtime code, live ledgers, sessions, or coms files were modified as part of definition creation.
