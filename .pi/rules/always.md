# ZOB Rule Pack: Always

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "always",
  "description": "Non-negotiable safety, evidence, and completion rules for every ZOB task.",
  "applies_to": {
    "paths": ["**"],
    "modes": ["explore", "plan", "implement", "oracle", "factory", "orchestrator"],
    "profiles": ["project-maintainer", "runtime-maintainer", "factory-engineer", "orchestration-engineer", "prompt-ops", "docs-maintainer", "sandbox-engineer", "oracle-reviewer"]
  },
  "must_do": [
    "Use contract-first, evidence-first, safety-first execution.",
    "Gather live context before edits.",
    "Preserve prompt/output body minimization in ledgers and telemetry.",
    "Report validation evidence before claiming completion."
  ],
  "must_not_do": [
    "Do not read secrets such as .env, private keys, ~/.ssh, ~/.aws, *.pem, or *.key.",
    "Do not run destructive commands such as rm -rf, git reset --hard, git clean, or broad process kills without explicit human approval.",
    "Do not commit unless explicitly asked.",
    "Do not mark work complete without concrete evidence."
  ],
  "allowed_tools": [],
  "required_validation": [],
  "oracle_required": "conditional",
  "no_ship_conditions": [
    "secret access attempted",
    "destructive command attempted without explicit approval",
    "missing validation evidence",
    "oracle no_ship=true"
  ],
  "enforcement": "block"
}
```
