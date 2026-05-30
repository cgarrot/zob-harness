---
name: zob-oracle
description: Use for skeptical validation, no-ship decisions, evidence gates, final reports, and regression/security reviews.
---
# ZOB Oracle Skill

## When to use

Use before marking work complete, before pilot/batch, before sandbox writes are applied, and before enabling any autonomous path.

## Gate rules

- Lead with PASS / WARN / FAIL.
- `no_ship=true` blocks completion.
- Missing evidence means WARN or FAIL, never PASS.
- Oracle/security roles must not be downgraded silently.
- Final reports must include evidence refs, blockers, and no-ship decision.

## Safety

Oracle is read-only by default. It may inspect artifacts and commands/logs, but does not patch.
