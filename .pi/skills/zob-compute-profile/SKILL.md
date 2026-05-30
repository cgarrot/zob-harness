---
name: zob-compute-profile
description: "Use when selecting, previewing, validating, or implementing ZOB compute/effort profiles: auto, low, medium, high, xhigh, max."
---
# ZOB Compute Profile Skill

## Purpose

Compute profiles control how much workflow effort ZOB spends on a task. They are hard policy/cap inputs, not vague encouragement to “try harder”.

Canonical plan:

- `docs/ZOB_COMPUTE_PROFILE_ROUTING_PLAN.md`

## Profiles

```text
auto   → preview then resolve to low/medium/high/xhigh/max
low    → single-agent or deterministic fast path
medium → small supervised workflow
high   → multi-lane workflow with validation/oracle
xhigh  → extra-high expert workflow with richer benchmarks and adversarial review
max    → maximum bounded supervised workflow; requires strict budget/human gates
```

## TODO/delegation behavior by profile

- `low`: single-agent/best-effort. Do not spend extra turns on recursive split or background child orchestration; return incomplete/blocked if the box is too small.
- `medium`: small supervised workflow. A child may suggest a split in final output, but live/background escalation is not the default.
- `high`: multi-lane parent-owned workflow. Use active-session background delegation when useful, and let TODO-linked children return `TODO_SPLIT_REQUEST.v1` early when the TODO is too broad for their context.
- `xhigh`: same as high with deeper bounded decomposition and stronger validation/oracle.
- `max`: same as xhigh, but strict budget/human/oracle gates are mandatory before scale-up.

Even at high/xhigh/max, child agents must not directly spawn children or mutate parent TODO state; they request split/replan and the parent applies it.

## Required behavior

Before using compute to justify more work:

1. Run or inspect a compute preview when `requested_profile=auto`.
2. Resolve to an effective profile and hard caps.
3. Keep child dispatch parent-owned; child direct dispatch remains forbidden.
4. Keep safety, budget, path, and sandbox gates stronger than profile preference.
5. Persist only metadata/hash-safe artifacts; do not persist raw task/prompt/output bodies.
6. Treat `max` as approval-gated; do not auto-select it silently.

## Native surfaces

- Slash commands:
  - `/compute`
  - `/effort`
- Runtime tools:
  - `zob_compute_preview`
  - `zob_compute_resolve_profile`
  - `zob_compute_plan_workflow`
  - `zob_compute_validate_profile`
  - `zob_compute_write_profile_reports`
- Deterministic scripts:
  - `npm run preview:compute-profile:project-dna-smoke`
  - `npm run validate:compute-profile:project-dna-smoke`
  - `npm run plan:compute-workflow:project-dna-smoke`
  - `npm run validate:compute-workflow:project-dna-smoke`
  - `npm run snapshot:compute-profile:project-dna-smoke`
  - `npm run smoke:compute-profile-regression`
- Policy files:
  - `.pi/compute-profiles/defaults.json`
  - `.pi/compute-profiles/overrides.json`
  - `.pi/compute-profiles/risk-rules.json`
  - `npm run validate:compute-profile-policy`
- Plan/doc:
  - `docs/ZOB_COMPUTE_PROFILE_ROUTING_PLAN.md`

## No-ship rules

Block profile readiness if any occur:

- requested/effective profile mismatch is unexplained;
- caps are missing for a live or agentic workflow;
- child agents exceed `maxAgents`, `maxParallel`, or depth caps;
- strict budget is required but absent;
- oracle is required but missing;
- `max` is used without human/scale approval;
- profile is used to bypass secrets/path/sandbox/write policy;
- compute artifacts contain raw body/prompt/output/content/diff/patch text;
- telemetry or validation evidence is missing.

## ProjectDNA mapping

ProjectDNA should use compute profile as stage selection metadata:

```text
low    → scan + scan validation
medium → scan + validation + capsules + sample spec + one query
high   → medium + quarantine sample + sample validation + benchmark + oracle
xhigh  → high + specialist lanes + richer query suite + adversarial review
max    → xhigh + multi-reference/symbol/callgraph/promotion packet gates
```

Reference projects remain read-only, generated sample output remains quarantine/proposal-only, and external knowledge-backend import/sync/embed/write remains disabled unless explicitly approved.

## Final response shape

```text
<result>effective profile/caps or implemented surface</result>
<evidence>artifact paths and validation commands</evidence>
<risks_blockers>remaining gaps/no-ship risks</risks_blockers>
<compliance>profile did not bypass safety/budget/oracle gates</compliance>
```
