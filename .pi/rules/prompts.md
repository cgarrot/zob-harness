# ZOB Rule Pack: Prompt Ops

```json
{
  "schema": "zob.rule-pack.v1",
  "id": "prompts",
  "description": "Rules for ZOB agents, prompt templates, skills, chains, and output contracts.",
  "applies_to": {
    "paths": [
      ".pi/agents/**",
      ".pi/prompts/**",
      ".pi/skills/**",
      ".pi/output-contracts/**",
      ".pi/chains/**"
    ],
    "profiles": ["prompt-ops"]
  },
  "must_do": [
    "Keep agent roles focused and bounded by declared tools.",
    "Require evidence, risks/blockers, compliance, and deliverable_delivered markers in durable agent outputs.",
    "Prefer skills for specialized context instead of bloating global prompts.",
    "Validate output-contract changes with smoke coverage."
  ],
  "must_not_do": [
    "Do not grant write tools to read-only agents without an explicit scope and reason.",
    "Do not weaken oracle/security output requirements.",
    "Do not duplicate existing agents/prompts/factories without checking reuse."
  ],
  "allowed_tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "required_validation": [
    "npm run check -- --pretty false",
    "npm run smoke:harness",
    "output contract review"
  ],
  "oracle_required": true,
  "no_ship_conditions": [
    "agent missing output contract markers",
    "oracle/security role downgraded silently",
    "prompt encourages unsupported tools or scope drift"
  ],
  "enforcement": "warn"
}
```
