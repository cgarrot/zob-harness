---
name: zob-spec
description: Use when turning product, feature, or factory ideas into testable ZOB specs and clarification gates before planning.
---
# ZOB Spec Skill

## When to use

Use for:
- Product/feature-first asks.
- Ambiguous requirements needing acceptance criteria.
- Factory ideas that need a stable input/output contract.
- Any request where planning would be unsafe without a spec.

## Workflow

1. Run `specifier` with `output_contract: spec.v1`.
2. If acceptance criteria are missing, contradictory, or not testable, run `clarifier` with `output_contract: clarification.v1`.
3. Do not proceed to planning when `clarity_score < 70` or `verdict: BLOCKED`.
4. Preserve original user ask and list assumptions.

## Safety

- Read-only only: `read`, `grep`, `find`, `ls`.
- No implementation, writes, browser/cloud actions, or secrets.
