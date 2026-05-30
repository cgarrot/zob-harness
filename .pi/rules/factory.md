# ZOB Rule Pack: Factory Engineer

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "factory",
  "description": "Rules for software-factory manifests, checkpoints, validators, sentinels, pilot/batch gates, and quarantine flows.",
  "applies_to": {
    "paths": [
      ".pi/extensions/zob-harness/src/factory/**",
      ".pi/factories/**",
      "reports/factory-runs/**"
    ],
    "modes": ["factory"],
    "profiles": ["factory-engineer"]
  },
  "must_do": [
    "Start with smoke before pilot or batch.",
    "Require validation.json before writing phase sentinels or DONE.sentinel.",
    "Require persisted oracle review artifacts for pilot and future batch promotion gates.",
    "Keep factory-forge outputs quarantined until explicit review and activation."
  ],
  "must_not_do": [
    "Do not run pilot/batch without prerequisite sentinels and oracle review evidence.",
    "Do not enable agentic pilot/batch until deterministic gates pass.",
    "Do not auto-activate quarantined factories.",
    "Do not start a daemon from factory runs."
  ],
  "allowed_tools": ["read", "bash", "edit", "write", "grep", "find", "ls", "factory_run"],
  "required_validation": [
    "npm run check -- --pretty false",
    "npm run smoke:harness",
    "factory_run smoke validation.json and sentinel checks"
  ],
  "oracle_required": true,
  "no_ship_conditions": [
    "missing validation.json",
    "missing phase sentinel after passed validation",
    "pilot or batch gate missing persisted oracle review",
    "factory-forge activation without approval"
  ],
  "enforcement": "preflight_fail"
}
```
