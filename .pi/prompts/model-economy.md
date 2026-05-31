---
description: Update .pi/model-economy.json from natural-language cost/quality policy instructions
argument-hint: "<natural language compute/model economy update>"
---
Switch to `/zmode implement` if not already there.

Update `.pi/model-economy.json` from this natural-language request:

$ARGUMENTS

Purpose:
- Maintain the policy connecting `/compute` profiles (`low`, `medium`, `high`, `xhigh`, `max`) to model classes and cost/quality gates.
- Keep `.pi/model-routing.json` as the source of model classes.
- Keep `.pi/model-catalog.json` as the source of concrete model IDs and human preference notes.
- Do not enable live/global model routing.

Required context to read first:
- `.pi/model-economy.json`
- `.pi/model-catalog.json`
- `.pi/model-routing.json`
- `.pi/compute-profiles/defaults.json`

Allowed edits:
- `.pi/model-economy.json` only, unless the user explicitly asks to change the command/validator itself.

Interpretation rules:
- Translate natural language like "low = cheap everywhere" or "medium = strong orchestrator, cheap workers" into `profiles.<profile>.roleClasses`, `preferCostTier`, and quality gates.
- Allowed compute profiles only: `low`, `medium`, `high`, `xhigh`, `max`.
- Allowed model classes only: `cheap_scout`, `balanced_worker`, `strong_reasoning`, `strong_oracle`, `high_context`.
- Role class intent:
  - `root`, `orchestrator`, `lead`, `planner`: coordination/planning model class.
  - `scout`: read-only exploration/recon class.
  - `worker`, `implementer`, `qa`: ordinary sub-agent work classes.
  - `oracle`: final validation/no-ship class.
  - `security`: security/high-risk reasoning class.
  - `high_context`: large context/lots of files class.
- Cost tiers: `free`, `low`, `medium`, `high`.
- Quality tiers: `unknown`, `experimental`, `reliable`, `strong`.
- Status values: `preferred`, `fallback`, `candidate`, `disabled`.
- For `low`, cheap defaults are fine for scouts/simple workers, but oracle/security must not be downgraded.
- For `medium`, prefer strong coordination/oracle with cheaper scouts and balanced workers.
- For `high` and above, require verified/reliable defaults unless the user explicitly asks for candidate experimentation.
- For `max`, keep `requireVerified=true`, `requireStrongQuality=true`, and `allowUnverified=false`.
- Preserve existing unknown fields when possible.

Safety rules:
- Never store API keys, auth headers, tokens, passwords, private keys, environment secret values, or provider secrets.
- Do not read or write secret files or home credential directories.
- Do not edit user-level Pi provider/model configuration; if provider/model installation is needed, tell the user to configure Pi models separately.
- Do not enable `liveRoutingEnabled`, `modelRouterUsed`, `routingApplied`, `childDispatchAllowed`, `budgetEnforced`, or `strictEnabled`.
- Never downgrade `oracle` below `strong_oracle` or `security` below `strong_reasoning`.

Validation:
- Run `npm run validate:model-economy`.
- If `.pi/model-catalog.json` was also changed, run `npm run validate:model-catalog`.
- If TypeScript/package changes were made, also run `npm run check -- --pretty false`.

Final answer:
- changed files
- concise summary of economy policy changes
- validation commands/results
- any unresolved model/profile ambiguity
- compliance line
- deliverable_delivered: yes/no
