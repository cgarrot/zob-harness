---
description: Update .pi/model-catalog.json from natural-language model preference instructions
argument-hint: "<natural language model preference/update>"
---
Switch to `/zmode implement` if not already there.

Update `.pi/model-catalog.json` from this natural-language request:

$ARGUMENTS

Purpose:
- Maintain the human preference catalog used before ZOB child-agent delegation.
- Translate natural language into safe structured model preferences.
- Keep `.pi/model-routing.json` as the source of model classes; do not enable live/global routing.

Required context to read first:
- `.pi/model-catalog.json`
- `.pi/model-routing.json`
- `.pi/skills/zob-delegation-routing/SKILL.md` if delegation behavior is relevant

Allowed edits:
- `.pi/model-catalog.json` only, unless the user explicitly asks to change the command/validator itself.

Interpretation rules:
- A model key is a Pi `--model` pattern, e.g. `anthropic/claude-sonnet-4-5`, `sonnet:high`, `openrouter/anthropic/claude-3.5-sonnet`, or another user-provided pattern.
- Do not invent credentials, provider setup, or exact model IDs. If the user gives only a vague family name, store it as an unverified candidate or ask one concise clarification if it would become a default.
- Map intent to existing classes only: `cheap_scout`, `balanced_worker`, `strong_reasoning`, `strong_oracle`, `high_context`.
- If the user says a model is preferred/default for a class, add it to the front of that `classDefaults[class]` array and remove duplicates.
- If the user says a model should not be used for a class/agent, add/update `avoidFor` or `agentPreferences.<agent>.avoid`; do not silently delete evidence notes.
- Oracle/security downgrade is forbidden: never make a weak/cheap/experimental model the only `strong_oracle` or high-risk security default unless the user explicitly states it is strong enough for oracle/security.
- Summarize long natural language into `whyWeLikeIt`, `bestFor`, `avoidFor`, and `notes`; do not paste raw prompt bodies.
- Preserve existing unknown fields when possible.

Model entry shape:
```json
{
  "label": "Human label",
  "status": "candidate|preferred|fallback|disabled",
  "resolutionStatus": "verified|unverified|needs_user",
  "classes": ["balanced_worker"],
  "whyWeLikeIt": "Short human reason.",
  "bestFor": ["implementation"],
  "avoidFor": ["oracle_final_security"],
  "costTier": "unknown|free|low|medium|high",
  "qualityTier": "unknown|experimental|reliable|strong",
  "contextWindow": 128000,
  "notes": ["Optional short note."],
  "lastUpdated": "YYYY-MM-DD"
}
```

Safety rules:
- Never store API keys, auth headers, tokens, passwords, private keys, environment secret values, or provider secrets.
- Do not read or write secret files or home credential directories.
- Do not edit user-level Pi provider/model configuration; if provider/model installation is needed, tell the user to configure Pi models separately.
- Do not enable `liveRoutingEnabled`, `modelRouterUsed`, `routingApplied`, or `childDispatchAllowed`.

Validation:
- Run `npm run validate:model-catalog`.
- If TypeScript/package changes were made, also run `npm run check -- --pretty false`.

Final answer:
- changed files
- concise summary of catalog changes
- validation commands/results
- any model IDs still unverified or needing user confirmation
- compliance line
- deliverable_delivered: yes/no
