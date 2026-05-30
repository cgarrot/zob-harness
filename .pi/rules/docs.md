# ZOB Rule Pack: Docs Maintainer

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "docs",
  "description": "Rules for documentation updates and status notes.",
  "applies_to": {
    "paths": ["docs/**", "README.md", "AGENTS.md"],
    "profiles": ["docs-maintainer"]
  },
  "must_do": [
    "Use docs to reflect implemented behavior or durable decisions, not as a substitute for runtime gates.",
    "Cite concrete files, commands, or artifacts when marking work done.",
    "Keep status wording honest about supervised vs autonomous behavior."
  ],
  "must_not_do": [
    "Do not claim 100% autonomy without live no-mock evidence and completion audit.",
    "Do not mark planned work as implemented.",
    "Do not hide blockers or no-ship risks."
  ],
  "allowed_tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "required_validation": ["npm run check -- --pretty false"],
  "oracle_required": "conditional",
  "no_ship_conditions": [
    "claim lacks evidence",
    "docs contradict runtime behavior",
    "completion status overclaims autonomy"
  ],
  "enforcement": "advisory"
}
```
