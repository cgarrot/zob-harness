---
description: Build a six-part contract for one split-only ZOB harness refactor slice
argument-hint: "<target module or slice>"
---
Use `delegate_task` with agent `refactor-mover` for this bounded slice: $ARGUMENTS

Contract template:
1. TASK: Move exactly one bounded block from `.pi/extensions/zob-harness/index.ts` into the target sidecar module, or create the sidecar context for that module if no move is approved yet.
2. EXPECTED OUTCOME: Split-only change with public exports preserved, `index.ts` entrypoint stable, NodeNext imports valid, and validation evidence captured.
3. REQUIRED TOOLS: read, grep, find, ls, edit, write, safe bash for `npm run check -- --pretty false` and scoped smoke only.
4. MUST DO:
   - Read `docs/ZOB_HARNESS_INDEX_REFACTOR_PLAYBOOK.md` and the nearest local `AGENTS.md`.
   - Preserve strings, messages, schemas, array order, sentinels, artifacts, defaults, and sync/async behavior.
   - Use `.js` suffixes for relative runtime imports and `import type` for type-only imports.
   - Run `npm run check -- --pretty false`; run `npm run smoke:harness` for domain/runtime slices.
5. MUST NOT DO:
   - Do not rewrite logic, optimize, rename public exports, or change registrations.
   - Do not import from `index.ts` inside `src/**`.
   - Do not switch to final barrel unless explicitly approved.
   - Do not read secrets, touch generated/vendor folders, or commit.
6. CONTEXT:
   - Playbook: `docs/ZOB_HARNESS_INDEX_REFACTOR_PLAYBOOK.md`.
   - Current entrypoint: `.pi/extensions/zob-harness/index.ts`.
   - Baseline artifacts: `.pi/tmp/refactor-baseline/` when present.
