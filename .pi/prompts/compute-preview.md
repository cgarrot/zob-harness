---
description: Preview and resolve ZOB compute/effort profile for a task, factory, ProjectDNA run, or orchestration.
argument-hint: "<target path or task hash>"
---
Load `.pi/skills/zob-compute-profile/SKILL.md` and keep `docs/ZOB_COMPUTE_PROFILE_ROUTING_PLAN.md` in scope.

For: $ARGUMENTS

Output:

1. **Requested profile**
   - `auto | low | medium | high | xhigh | max`
   - optional max profile ceiling
   - domain: `generic | project-dna | factory | orchestration`

2. **Preview inputs**
   - target path metadata only, if any;
   - task/spec hash, not raw prompt body;
   - risk hints such as write/network/browser/cloud/durable/promotion;
   - expected budget/oracle posture.

3. **Resolution**
   - recommended profile;
   - effective profile;
   - hard caps for agents/depth/parallel/context/time/cost;
   - oracle and strict-budget gates;
   - blocked escalation if any.

4. **Safety constraints**
   - no secrets;
   - no child direct dispatch;
   - no network by default;
   - no source writes;
   - no raw task/prompt/output body persistence;
   - `max` requires explicit approval.

5. **Suggested command**
   - For ProjectDNA smoke, prefer:
     - `npm run preview:compute-profile:project-dna-smoke`
     - `npm run validate:compute-profile:project-dna-smoke`

Final answer: effective profile, evidence refs, risks/blockers, compliance.
