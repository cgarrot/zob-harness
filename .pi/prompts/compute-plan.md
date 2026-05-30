---
description: Turn a resolved ZOB compute profile into a bounded workflow shape and validation ladder.
argument-hint: "<compute-profile-resolution artifact>"
---
Load `.pi/skills/zob-compute-profile/SKILL.md` and read the compute profile resolution artifact.

For: $ARGUMENTS

Produce:

1. **Profile summary**
   - requested profile;
   - recommended profile;
   - effective profile;
   - caps and gates.

2. **Workflow shape**
   - deterministic stages;
   - optional parent-owned agent lanes;
   - max depth and max parallel;
   - validation level;
   - oracle requirements.

3. **Escalation policy**
   - when to ask for more compute;
   - when to de-escalate;
   - when to stop for budget/oracle/user approval.

4. **No-ship checks**
   - cap violations;
   - missing validation;
   - missing oracle;
   - raw body persistence;
   - safety bypass.

Do not dispatch children directly from this prompt. Return a plan only unless the parent explicitly invokes tools.
