---
description: Run skeptical read-only equivalence review for a split-only refactor slice
argument-hint: "<slice or changed files>"
---
Use `delegate_task` with agent `refactor-oracle` to review: $ARGUMENTS

Review contract:
1. TASK: Skeptically verify that the split-only refactor slice preserves observable behavior.
2. EXPECTED OUTCOME: PASS / FAIL / WARN with confidence, blockers, evidence, no_ship, and next steps.
3. REQUIRED TOOLS: read, grep, find, ls, safe read-only bash.
4. MUST DO:
   - Check changed files and validation logs.
   - Compare exports/registrations to baseline if provided.
   - Verify `index.ts` status matches the phase contract.
   - Search for forbidden `src/** -> index.ts` imports.
   - Check NodeNext `.js` suffixes for relative runtime imports.
5. MUST NOT DO:
   - No patches, no commits, no formatting, no secret reads.
   - Do not return PASS without concrete evidence.
6. CONTEXT:
   - Playbook: `docs/ZOB_HARNESS_INDEX_REFACTOR_PLAYBOOK.md`.
   - Baseline artifacts: `.pi/tmp/refactor-baseline/`.
   - Validation ladder: `npm run check -- --pretty false`, `npm run smoke:harness`, `npm run pi:check`, phase-specific gates.
