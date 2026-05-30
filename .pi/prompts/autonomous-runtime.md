---
description: Route a supervised ZOB autonomous runtime dry-run, readonly smoke, or validation check
argument-hint: "<dry-run|readonly-smoke|validate-smoke|validate-run> <target/artifact>"
---
Switch to `/zmode factory` for dry-run/readonly smoke, or use an allowed validation mode for readonly validators.

Before calling tools, load `.pi/skills/zob-autonomous-runtime/SKILL.md` and check `.pi/capabilities/zob-public-runtime-capabilities.json` for modes, related skills, and no-ship notes.

Use the `zob_autonomous_*` family only for supervised evidence:
- `zob_autonomous_dry_run`: metadata/report generation only; no live/global routing or production writes.
- `zob_autonomous_readonly_smoke`: readonly reports smoke; no child dispatch, daemon, production writes, or global autonomy claim.
- `zob_autonomous_validate_smoke`: readonly smoke artifact validation.
- `zob_autonomous_validate_run`: readonly run artifact validation.

Do not claim global autonomy is complete without final E2E evidence and oracle PASS/no_ship=false.
