# ZOB Rule Pack: Runtime Maintainer

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "runtime",
  "description": "Rules for Pi runtime registrations, commands, widgets, events, and public extension exports.",
  "applies_to": {
    "paths": [
      ".pi/extensions/zob-harness/index.ts",
      ".pi/extensions/zob-harness/src/runtime/**",
      ".pi/extensions/zob-harness/src/schemas.ts",
      ".pi/extensions/zob-harness/src/types.ts"
    ],
    "profiles": ["runtime-maintainer"]
  },
  "must_do": [
    "Preserve the default export zobHarness(pi).",
    "Preserve public exports consumed by scripts/harness-smoke.mjs.",
    "Preserve registered tool and command names unless explicitly approved.",
    "Keep runtime ledgers and widget summaries body-free."
  ],
  "must_not_do": [
    "Do not change observable tool names, command names, event handlers, sentinels, or artifact names without smoke coverage.",
    "Do not import from index.ts inside src/**.",
    "Do not convert synchronous fs behavior to async during split-only or runtime maintenance slices."
  ],
  "allowed_tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "required_validation": [
    "npm run check -- --pretty false",
    "npm run smoke:harness",
    "npm run pi:check"
  ],
  "oracle_required": true,
  "no_ship_conditions": [
    "runtime registration drift",
    "public export drift",
    "missing smoke coverage for runtime behavior",
    "prompt/output body persisted"
  ],
  "enforcement": "warn"
}
```
