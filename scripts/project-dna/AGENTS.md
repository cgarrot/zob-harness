# ProjectDNA Script Guardrails

Scope: `scripts/project-dna/` contains ProjectDNA scaffold, scan, workflow, query, sample, benchmark, oracle, and validation helpers.

## Structure

Canonical scripts live in grouped subfolders:

- `scan/` — scanner and scan-artifact validation.
- `workflow/` — agentic workflow planning and validation.
- `emit/` — ontology and golden-case emission helpers.
- `query/` — context query and query-steward helpers.
- `sample/` — sample-spec, quarantine sample generation, and sample validation.
- `capsules/` — pointer capsule builders.
- `benchmark/` — deterministic benchmark smoke helpers.
- `oracle/` — structural oracle review helpers.
- `validation/` — scaffold, ontology, golden-case, and 5/5 posture validators.

Top-level `*.mjs` entries are compatibility shims for existing `package.json` commands and direct CLI paths. Keep those paths stable unless package refs and downstream callers are intentionally migrated.

## Invariants

- Split-only changes: move code, do not change script logic, CLI args, output paths, status strings, report schemas, or validation semantics.
- Preserve read/write posture: ProjectDNA scans are read-only for source projects; generated outputs stay under approved quarantine/report locations.
- Do not read secrets or traverse forbidden/generated folders such as `.env`, `.git`, `node_modules`, `dist`, `build`, or runtime ledgers.
- Keep package command behavior stable; prefer compatibility shims over package script churn.
- Do not introduce network calls or external knowledge-backend imports/writes without explicit approval.

## Validation ladder

After structural edits, run:

```bash
npm run validate:script-surface
npm run validate:project-dna
npm run check -- --pretty false
```

Run targeted ProjectDNA smokes only when their report-output paths are approved for the current task.
