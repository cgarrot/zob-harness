# ProjectDNA Factory

Status: **P0 scaffold**.

This factory implements the first safe surface for ProjectDNA: a code-first reference-project workflow that can be planned and validated before any real project scan, sample generation, or external knowledge-backend write. It is agents-first: agents own scope, capture goals, safety gates, validation, oracle, and promotion posture; deterministic scripts are tools that produce cited evidence.

## What this factory does now

- Registers a `project-dna` factory under `.pi/factories/project-dna/`.
- Defines map/reduce/validate stages for ProjectDNA planning and oracle review.
- Provides smoke/pilot/batch manifests that use repo-local docs/skill/prompt/factory artifacts as safe inputs.
- Produces factory-run evidence through the existing `factory_run` tool.
- Keeps promotion and writeback proposal-only.
- Frames npm scripts as deterministic tools used by agents, not as the primary control plane.
- Captures operator intent through `capture_mode`, `capture_goal`, and optional `user_note` metadata without treating notes as evidence.

## What this factory does not do yet

- It does not scan arbitrary external projects by default.
- It does not read `.env`, keys, credentials, generated/vendor folders, or private raw data.
- It does not generate a sample project outside quarantine/sandbox.
- It does not import/sync/embed/write into external knowledge backend.
- It does not claim ProjectDNA retrieval is production-ready.

## Safe smoke command

Use the harness tool or equivalent:

```text
factory_run(
  factory="project-dna",
  input_manifest=".pi/factories/project-dna/smoke-manifest.json",
  mode="smoke",
  execution="deterministic"
)
```

Local scaffold validator:

```bash
npm run validate:project-dna
```

Metadata-only compute profile preview for the safe ProjectDNA smoke target:

```bash
npm run preview:compute-profile:project-dna-smoke
npm run validate:compute-profile:project-dna-smoke
npm run plan:compute-workflow:project-dna-smoke
npm run validate:compute-workflow:project-dna-smoke
npm run validate:compute-profile-policy
npm run smoke:compute-profile-regression
npm run snapshot:compute-profile:project-dna-smoke
```

These write `compute-preview.json`, `compute-profile-resolution.json`, and `compute-workflow-shape.json` under `reports/project-dna-scans/project-dna-factory-smoke/`; they do not dispatch children, read secrets, use network, modify source projects, or write to an external knowledge backend.

Read-only scanner smoke against this factory scaffold:

```bash
npm run smoke:project-dna-scan
```

Equivalent manifest-driven scanner example:

```bash
node scripts/project-dna/scan.mjs \
  --manifest .pi/factories/project-dna/example-project-dna-manifest.json \
  --out-dir reports/project-dna-scans/project-dna-manifest-smoke
```

These write only metadata artifacts under `reports/project-dna-scans/` and do not touch any external project or external knowledge backend corpus.

Validate scanner artifacts, source/read-only posture, and citation line ranges:

```bash
npm run validate:project-dna-scan:smoke
```

Build pointer capsules from the scanner smoke metadata:

```bash
npm run build:project-dna-capsules:smoke
```

This reads scan artifacts only and writes capsules under `reports/project-dna-scans/project-dna-factory-smoke/capsules/`.

Build a neutral sample-project spec, without generating code:

```bash
npm run build:project-dna-sample-spec:smoke
```

This writes `reports/project-dna-scans/project-dna-factory-smoke/sample-spec.json` with `generation_status=spec_only_no_code_generated`.

Generate and validate a dependency-free neutral sample project in quarantine:

```bash
npm run generate:project-dna-sample:smoke
npm run validate:project-dna-sample:smoke
```

This writes only under `reports/project-dna-scans/project-dna-factory-smoke/quarantine/sample-project/`; the validator runs local `node --check` and a dependency-free sample test.

Query ProjectDNA scan metadata for a bounded cited context pack:

```bash
npm run query:project-dna:smoke
```

This writes `reports/project-dna-scans/project-dna-factory-smoke/query-result-smoke.json`; raw query text is hashed and not persisted.

Run 5/5 agents-first ontology, Query Steward, golden benchmark, and structural oracle smoke gates:

```bash
npm run emit:project-dna-ontology:smoke
npm run validate:project-dna-ontology:smoke
npm run emit:project-dna-golden-cases:smoke
npm run validate:project-dna-golden-cases:smoke
npm run steward:project-dna-query:smoke
npm run bench:project-dna:smoke
npm run oracle:project-dna:smoke
npm run validate:project-dna-5of5:smoke
```

These write ontology/golden/query-steward/benchmark/oracle artifacts under `reports/project-dna-scans/project-dna-factory-smoke/`; the oracle review covers scaffold readiness only and keeps durable promotion disabled until human approval. Query Steward hashes the raw query and persists controlled intent metadata only.

## Capture and compute profile gates

ProjectDNA manifests may include optional `capture_mode`, `semantic_capture_mode`, `capture_goal`, `user_note`, `compute_profile`, and `compute_caps` fields.

Capture posture:

```text
plan_only                        → plan/manifest from approved inputs; no source scan
read_only_scan                   → scan only explicit allowed_paths; source remains read-only
sandbox_sample_generation         → write only under approved quarantine/sandbox outputs
runtime_query_existing_artifacts  → query existing scan artifacts only; no new external scan
```

Semantic capture posture:

```text
full_capture      → small/medium repo reusable across major domains
architecture_only → large repo or architecture/scaffold-only user note
targeted_capture  → named domains/features from capture_goal or user_note
sample_first      → prioritize neutral sample design from cited architecture facts
context_only      → return bounded cited context packs; no sample generation
```

`capture_goal` bounds the pattern/question being captured. `user_note` records operator intent or constraints, but it is not source evidence and must not replace citations. For very large repos, default semantic posture should be `architecture_only` or `targeted_capture` unless the user approves deeper compute.

Profile stage mapping is:

```text
auto   → metadata-only preview/resolve, then apply the resolved low/medium/high/xhigh/max row
low    → scan + scan validation
medium → scan + validation + capsules + sample spec + one query
high   → medium + quarantine sample + sample validation + benchmark + oracle
xhigh  → high + specialist lanes + richer query suite + adversarial review
max    → xhigh + approval-gated multi-reference/symbol/callgraph/promotion packet work
```

Profile selection never bypasses secrets, sandbox, oracle, budget, quarantine/proposal-only output policy, external backend-write restrictions, or parent-owned dispatch gates.

## Promotion gates

Do not promote ProjectDNA artifacts to durable knowledge/sample locations unless all are true:

1. Scanner/sample implementation exists and ran in a sandbox/quarantine.
2. Validation commands passed.
3. Secret/leakage checks passed.
4. Citations and line ranges are valid.
5. Oracle returned `PASS` with `no_ship=false`.
6. Human approval is present for any durable writeback/promotion.

## Related files

- Plan: `docs/ZOB_PROJECT_DNA_CODE_KNOWLEDGE_GRAPH_PLAN.md`
- Skill: `.pi/skills/zob-project-dna/SKILL.md`
- Prompt: `.pi/prompts/project-dna.md`
- Schemas: `.pi/factories/project-dna/schemas/`
