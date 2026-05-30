# ZOB Rule Pack: Sandbox Engineer

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "sandbox",
  "description": "Rules for write-capable agents, temp workspaces, diff gates, rollback metadata, and apply controls.",
  "applies_to": {
    "paths": [
      ".pi/extensions/zob-harness/src/safety.ts",
      ".pi/extensions/zob-harness/src/child-runner.ts",
      "reports/sandbox-runs/**"
    ],
    "task_types": ["sandbox", "write autonomy", "diff gate", "rollback"],
    "profiles": ["sandbox-engineer"]
  },
  "must_do": [
    "Run write-capable autonomous work in a temp workspace or equivalent sandbox before applying to main workspace.",
    "Produce diff artifacts and rollback metadata for write phases.",
    "Require oracle review before applying generated changes.",
    "Default autoApply to false."
  ],
  "must_not_do": [
    "Do not auto-apply sandbox diffs without explicit approval.",
    "Do not allow writes without allowed_paths and forbidden_paths.",
    "Do not modify protected/generated/vendor paths without explicit approval."
  ],
  "allowed_tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "required_validation": [
    "npm run check -- --pretty false",
    "npm run smoke:harness",
    "diff artifact and rollback metadata checks"
  ],
  "oracle_required": true,
  "no_ship_conditions": [
    "autoApply=true without approval",
    "missing diff artifact",
    "missing rollback metadata",
    "oracle review missing before apply"
  ],
  "enforcement": "human_approval"
}
```
