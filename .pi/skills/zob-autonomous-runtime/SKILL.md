---
name: zob-autonomous-runtime
description: Use when running or reviewing zob_autonomous_* runtime tools, autonomous smoke/validation gates, or no-ship/global autonomy claims.
---
# ZOB Autonomous Runtime Skill

## When to use

Use this skill before using or documenting `zob_autonomous_*` tools:
- `zob_autonomous_dry_run`
- `zob_autonomous_readonly_smoke`
- `zob_autonomous_validate_smoke`
- `zob_autonomous_validate_run`

## Tool routing

- Start with the capability registry: `.pi/capabilities/zob-public-runtime-capabilities.json`.
- Use `zob-factory` for manifests, checkpoints, reports, and factory execution posture.
- Use `zob-sandbox` for any write-capable or quarantine workflow design.
- Use `zob-oracle` for validation, no-ship decisions, and final evidence review.

## Gates and meanings

- `zob_autonomous_dry_run`: factory-mode planning/report metadata only; no live/global routing and no production writes.
- `zob_autonomous_readonly_smoke`: factory-mode readonly smoke of reports/artifacts; no child dispatch, daemon, production writes, or global autonomy claim.
- `zob_autonomous_validate_smoke`: readonly validation of smoke artifacts.
- `zob_autonomous_validate_run`: readonly validation of run artifacts.

## MUST DO

- Treat all autonomy as supervised unless an explicit, later oracle-approved gate says otherwise.
- Keep dry-run, readonly smoke, validation, and final E2E evidence separate in reports.
- Require final E2E proof plus oracle PASS/no_ship=false before claiming an autonomous path is complete.
- Preserve metadata/hash-only posture; never store raw prompt or output bodies in artifacts.
- Record blockers for missing sentinel/report/validation evidence instead of inferring success.

## MUST NOT

- Do not claim global autonomy is complete from dry-run or readonly smoke results.
- Do not route production writes, daemon behavior, network/browser/API access, or child-agent dispatch through these tools unless the registry and a task-specific gate explicitly allow it.
- Do not bypass factory quarantine, sandbox, or oracle gates.
