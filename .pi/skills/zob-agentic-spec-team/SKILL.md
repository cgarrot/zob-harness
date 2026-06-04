---
name: zob-agentic-spec-team
description: Use when launching, running, reviewing, or extending the Agentic Spec Team workflow that turns missions plus docs/data/mockups into evidence-first implementation specs.
---
# ZOB Agentic Spec Team Skill

## Purpose

Use this skill to run a reusable ZOB-native spec production workflow. It ingests a mission plus explicit source paths, coordinates a run-scoped ZTeam, asks the human only through `spec-chief`, and produces a detailed, testable, traceable implementation spec.

V1 packaging is composite and deliberately **not** a runtime extension. It is a specialized Agent Factory pattern:

```text
Skill = rules and operating contract
Factory = repeatable checkpoints, sentinels, validators
ZTeam/ZAgents = run-scoped human-facing team
CLI = scriptable entrypoint and tmux automation
Coms = parent-visible async asks, blockers, evidence refs, and oracle/no-ship routing
```

Use the generic `examples/agent-factory-tmux-comms/` pattern for a smaller teaching version of the same shape.

## Entry points

```bash
npm run spec-run -- init --mission "..." --source docs/ --source data/export.csv --name billing-redesign
npm run spec-run:auto-pilot -- --mission-file specs/mission.md --source docs/ --source mockups/
```

Run artifacts are written under:

```text
reports/agentic-spec-runs/<run_id>/
```

## Team roles

- `spec-chief` — sole human interlocutor, run coordinator, blocker owner.
- `source-intake-steward` — inventories sources, sensitivity, freshness, contradictions.
- `data-profile-analyst` — profiles CSV/XLS/structured data and writes dictionaries.
- `domain-modeler` — extracts entities, states, rules, glossary, assumptions.
- `ux-flow-analyst` — maps mockups/screens/user journeys and UI state matrix.
- `spec-writer` — writes mission spec, requirements, slices, contracts.
- `bdd-writer` — writes acceptance criteria and Gherkin/data-driven examples.
- `planner-handoff-writer` — produces workgraph, implementation tasks, agent prompts.
- `spec-oracle` — validates traceability, open questions, safety, and no-ship.

## Required artifacts

```text
run-manifest.json
source-register.json/source-register.md
questions.jsonl/questions.md
answers.jsonl/answers.md
analysis/data-profile.json
analysis/data-dictionary.md
analysis/domain-model.md
analysis/business-rules.md
analysis/ux-flows.md
spec/mission-spec.md
spec/functional-requirements.md
spec/non-functional-requirements.md
validation/acceptance-criteria.md
validation/bdd-scenarios.feature.md
validation/traceability-matrix.json
validation/traceability-matrix.md
handoff/workgraph.md
handoff/implementation-tasks.md
oracle/final-oracle-review.json
final-report.json
status.json
```

## Traceability rule

Every requirement must map to at least one of:

```text
source_ref | owner_answer | explicit_assumption | decision_ref
```

The traceability matrix must connect:

```text
source_ref -> extracted_fact/answer/assumption -> requirement -> acceptance_criteria -> task -> oracle_check
```

No requirement may be accepted if it is unsupported or if the supporting source is known to be stale/contradictory without an explicit assumption or decision.

## Human question loop

`spec-chief` is the only role that asks the owner questions. Other agents propose questions to `spec-chief`; they do not directly ask the human unless explicitly instructed.

Question shape:

```json
{
  "schema": "agentic-spec.question.v1",
  "question_id": "Q-001",
  "status": "open",
  "blocking": true,
  "origin_agent": "domain-modeler",
  "concerns": ["REQ-014", "AC-022"],
  "source_refs": ["SRC-003"],
  "question": "Which billing rule wins?",
  "options": [{ "id": "A", "label": "Invoice date wins" }],
  "recommended_option": "A"
}
```

If a blocking question is open, auto-pilot must return `blocked/no_ship=true` and point to `questions.md`. It must not invent answers.

Answers may be recorded with:

```bash
npm run spec-run -- answer <run_id> Q-001 --text "..." --answered-by owner
npm run spec-run -- resume <run_id>
```

## No-ship blockers

- secret-like paths or sensitive raw data are read/persisted without explicit approval;
- source content is treated as `safe_to_copy` instead of citation/context evidence;
- any requirement lacks source/answer/assumption/decision support;
- acceptance criteria are not mapped to requirements;
- implementation tasks are not mapped to acceptance criteria;
- blocking questions remain open;
- contradictions are hidden or collapsed without decision;
- ZPeer transient messages are treated as durable evidence without artifact refs;
- auto-pilot closes tmux on timeout, WARN, FAIL, or `no_ship=true`;
- final oracle is missing or does not PASS with `no_ship=false`.

## V1 vs V2

V1 uses `.pi/skills`, `.pi/factories`, `.pi/zagents`, `.pi/zteams`, and `scripts/spec-run.mjs`.

V2 may add a runtime `/spec-run` extension command only after the script/team/factory workflow is stable and validated.

## Validation

Minimum parent validation for scaffold changes:

```bash
npm run check
node scripts/spec-run.mjs --help
node scripts/spec-run.mjs init --name smoke --mission "smoke spec" --source README.md
node scripts/spec-run.mjs validate <run_id>
```
