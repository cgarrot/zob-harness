---
description: Run a ZOB software factory with manifest/checkpoint/validation/sentinel artifacts
argument-hint: "<factory> <manifest>"
---
Switch to `/zmode factory` first.

Check `.pi/capabilities/zob-public-runtime-capabilities.json` for factory/autonomous tool routing. Use `factory_run` for manifest/checkpoint/sentinel factories; use `zob_autonomous_*` only with `.pi/skills/zob-autonomous-runtime/SKILL.md` for supervised dry-run, readonly smoke, or validation evidence.

Use the `factory_run` tool in smoke mode before any pilot/batch.

Recommended first run:

```json
{
  "factory": "opencode-pattern-canonizer",
  "input_manifest": ".pi/factories/opencode-pattern-canonizer/smoke-manifest.json",
  "mode": "smoke",
  "execution": "plan_only"
}
```

Completion requires:
- `reports/factory-runs/<runId>/manifest.json`
- `ledger.jsonl`
- `checkpoints/`
- `outputs/`
- `validation.json` with passed status
- `final-report.md`
- `DONE.sentinel`

Execution modes:
- `plan_only`: inspect `agentic-plan.json` with no child-agent model calls and no sentinel.
- `deterministic`: local artifact generation with sentinel after validation.
- `agentic`: execute planned child-agent stages; currently smoke-only.

Do not scale beyond smoke until the sentinel and validation artifacts exist. Do not claim global autonomy from `zob_autonomous_dry_run` or `zob_autonomous_readonly_smoke`; final E2E evidence plus oracle PASS/no_ship=false is required.
