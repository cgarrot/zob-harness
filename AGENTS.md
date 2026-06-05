# ZOB Harness v1 — Project Instructions

This repo is a project-local Pi harness, not an application product. Optimize for agentic engineering: reusable workflows, specialist delegation, safety gates, and verified outputs.

## Operating loop

For non-trivial work use: Explore -> Plan -> Implement -> Oracle.

1. Restate the task, allowed tools, MUST DO, MUST NOT, and expected outcome before tool use.
2. Gather live context before editing. Do not rely on filename guesses or stale memory.
3. Prefer small, reversible changes. Use `edit` for existing files and avoid broad rewrites.
4. Verify with concrete evidence before claiming success.
5. Finish with: result, evidence, risks/blockers, compliance line.

## Delegation contract

Use this six-part contract for specialist agents:

```text
1. TASK: [atomic goal]
2. EXPECTED OUTCOME: [observable deliverable/verdict]
3. REQUIRED TOOLS: [allowed tools only]
4. MUST DO: [positive constraints]
5. MUST NOT DO: [hard stops]
6. CONTEXT: [paths, prior evidence, downstream use]
```

## Safety

- Never read or write secrets (`.env`, keys, `~/.ssh`, `~/.aws`). Ask the user if a value is required.
- Never run destructive commands (`rm -rf`, `git reset --hard`, `git clean`, broad process kills) without explicit user approval.
- Never commit unless explicitly asked or governed autocommit is explicitly policy-authorized for the current task.
- Commit/push/tag operations must go through governed `/zcommit` or the agent-executable `zob_zcommit_run` tool when the user explicitly asks the agent to commit/push; direct `git commit`, `git push`, `git tag`, force push, `git add .`, and `git add -A` are blocked.
- Avoid touching generated/vendor folders: `node_modules`, `dist`, `build`.

## Pi harness specifics

- Runtime capability registry: `.pi/capabilities/zob-public-runtime-capabilities.json` is the first stop for public tool/command family, mode, skill, doc, and no-ship routing.
- Extension: `.pi/extensions/zob-harness/index.ts`
- Specialist agents: `.pi/agents/*.md`
- Prompt templates: `.pi/prompts/*.md`
- Synthesis agents: `.pi/agents/synthesis.md`, `.pi/agents/oracle-merge.md`
- Damage rules: `.pi/damage-control-rules.json`

## Tool-family router

Use the registry plus the domain skill instead of copying tool docs into prompts:

- Delegation/catalog: `zob_delegation_catalog`, `delegate_agent`, `delegate_task` -> `.pi/skills/zob-delegation-routing/SKILL.md` and `.pi/skills/zob-harness/SKILL.md`; call the catalog before first delegation when agent/contract/tool routing is uncertain, normally omit `delegate_task.output_contract` and `delegate_task.required_tools`, and never invent contract IDs or agent tools.
- Live coms: `zob_coms_*` -> `.pi/skills/zob-coms-v2-live/SKILL.md` and `.pi/skills/zob-coms-safety/SKILL.md`; required-local delivery must be live, never append-only success.
- Mission Control: `zob_mission_control_*` / readiness -> `.pi/skills/zob-mission-control-coms/SKILL.md`; command writes are proposals only.
- Context: `zob_context_search`, `zob_context_*` -> registry no-ship notes plus `.pi/skills/zob-context-discovery/SKILL.md`, `.pi/skills/zob-harness/SKILL.md`, and `.pi/skills/zob-spec/SKILL.md` as applicable; prefer the active search backend (ColGREP when ready, grep/find/read fallback) and verify exact claims with file refs.
- Compute profile / effort routing: `zob_compute_*`, `npm run preview:compute-profile:project-dna-smoke`, `npm run validate:compute-profile:project-dna-smoke` -> `.pi/skills/zob-compute-profile/SKILL.md`; preview/resolve/report tools are metadata-only and never bypass safety, budget, oracle, sandbox, or parent-owned dispatch gates.
- Autonomy: `zob_autonomous_*` -> `.pi/skills/zob-autonomous-runtime/SKILL.md`; dry-run/readonly smoke/validation are supervised evidence only, not global autonomy completion.
- Factory quarantine/run: `factory_quarantine_*`, `factory_run` -> `.pi/skills/zob-factory/SKILL.md` and `.pi/skills/zob-sandbox/SKILL.md`.
- Goal TODOs: `/goal`, `/todo`, `*_goal_todo*` -> `.pi/skills/zob-goal-todo-tree/SKILL.md`.
- ProjectDNA/code knowledge graph: `/project-dna`, `zob_project_dna_*`, `.pi/factories/project-dna/*`, `npm run validate:project-dna`, `npm run smoke:project-dna-scan`, `npm run validate:project-dna-scan:smoke`, `npm run build:project-dna-capsules:smoke`, `npm run build:project-dna-sample-spec:smoke`, `npm run generate:project-dna-sample:smoke`, `npm run validate:project-dna-sample:smoke`, `npm run query:project-dna:smoke`, `npm run bench:project-dna:smoke`, `npm run oracle:project-dna:smoke` -> `.pi/skills/zob-project-dna/SKILL.md`; keep reference projects read-only, outputs quarantined/proposal-only, and never run external knowledge-backend import/sync/embed/write without explicit approval.

Useful commands inside Pi:

- `/zmode` — switch mode (`explore`, `plan`, `implement`, `oracle`, `factory`)
- `/zcommit` / `zob_zcommit_run` — governed commit workflow (`status`/`plan`, `commit`, `push`, `commit_and_push`, `autocommit on|off`, `autopush on|off`); no aliases, defaults off, load `.pi/skills/zob-commit/SKILL.md` and `.pi/git-policy.json`; use `zob_zcommit_run` when the user explicitly asks the agent to commit/push
- `/contract` — insert the six-part delegation template
- `/agents` — list specialist agents
- `/goal_gate` — set active goal/scope anchor
- `/compute` / `/effort` — preview and resolve compute profile (`auto`, `low`, `medium`, `high`, `xhigh`, `max`) for a target path/task without child dispatch
- `delegate_task` tool — strict single-task child Pi delegation with preflight/gates
- `delegate_agent` tool — single, parallel, or chain child Pi agents
- `factory_run` tool — deterministic manifest/checkpoint/sentinel software factory runner
- `/project-dna` — query/audit ProjectDNA scan artifacts or start the ProjectDNA workflow for code-first reference-project context
- `zob_project_dna_query` / `zob_project_dna_federated_query` — return bounded cited context from existing scan artifacts without external scans/backend writes
- `npm run preview:compute-profile:project-dna-smoke` — write metadata-only compute preview/resolution artifacts for the safe ProjectDNA smoke target
- `npm run validate:compute-profile:project-dna-smoke` — validate compute preview/resolution safety posture and profile fields
- `npm run plan:compute-workflow:project-dna-smoke` — build metadata-only workflow-shape lanes from the resolved compute profile
- `npm run validate:compute-workflow:project-dna-smoke` — validate workflow-shape parent-owned/no-dispatch posture
- `npm run validate:compute-profile-policy` — validate repository compute profile defaults/overrides/risk rules
- `npm run smoke:compute-profile-regression` — verify profile caps/gates across low/medium/high/xhigh/max
- `npm run snapshot:compute-profile:project-dna-smoke` — write body-free Mission Control-compatible compute summary metadata
- `npm run validate:project-dna` — validate the ProjectDNA scaffold without scanning external projects
- `npm run smoke:project-dna-scan` — run a bounded read-only ProjectDNA scanner smoke against `.pi/factories/project-dna`
- `npm run validate:project-dna-scan:smoke` — validate ProjectDNA scan artifacts, line refs, and no-write posture
- `npm run build:project-dna-capsules:smoke` — build pointer capsules from ProjectDNA scanner smoke metadata only
- `npm run build:project-dna-sample-spec:smoke` — build a neutral sample-project spec without generating code
- `npm run generate:project-dna-sample:smoke` — generate a dependency-free ProjectDNA sample under reports quarantine
- `npm run validate:project-dna-sample:smoke` — validate the quarantine sample with local Node checks/tests
- `npm run query:project-dna:smoke` — build a bounded cited ProjectDNA query result from scan metadata
- `npm run bench:project-dna:smoke` — run deterministic ProjectDNA retrieval/sample smoke benchmark
- `npm run oracle:project-dna:smoke` — write structural oracle review for ProjectDNA smoke artifacts
- `npm run smoke:harness` — non-destructive P0/P1/P2 gate/policy smoke tests
