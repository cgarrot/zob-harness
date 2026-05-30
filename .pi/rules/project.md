# ZOB Rule Pack: Project

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "project",
  "description": "Project-local ZOB harness operating rules shared by all implementation slices.",
  "applies_to": {
    "paths": ["**"],
    "modes": ["explore", "plan", "implement", "oracle", "factory", "orchestrator"],
    "profiles": ["project-maintainer", "runtime-maintainer", "factory-engineer", "orchestration-engineer", "prompt-ops", "docs-maintainer", "sandbox-engineer", "oracle-reviewer"]
  },
  "must_do": [
    "Prefer Explore -> Plan -> Implement -> Oracle for non-trivial work.",
    "Use the six-part TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT contract for delegated work.",
    "Keep edits small, reversible, and scoped to the active goal.",
    "Use existing ZOB agents, prompts, factories, chains, and output contracts before creating new ones."
  ],
  "must_not_do": [
    "Do not touch node_modules, dist, build, or generated/vendor folders.",
    "Do not store prompt bodies or output bodies in telemetry, coms, rooms, or rule resolution artifacts.",
    "Do not treat planned orchestration as completed implementation work."
  ],
  "allowed_tools": [],
  "required_validation": ["npm run check -- --pretty false"],
  "oracle_required": "conditional",
  "no_ship_conditions": [
    "scope drift",
    "public export drift without smoke coverage",
    "missing risks/blockers/compliance summary"
  ],
  "enforcement": "warn"
}
```
