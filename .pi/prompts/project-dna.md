---
description: Start a ProjectDNA code knowledge graph / neutral sample factory workflow from a trusted reference project folder
argument-hint: "<source_project_path or manifest>"
---
Switch to `/zmode factory` if not already there.

Load `.pi/skills/zob-project-dna/SKILL.md` and keep `.pi/skills/zob-factory/SKILL.md`, `.pi/skills/zob-sandbox/SKILL.md`, `.pi/skills/zob-oracle/SKILL.md`, and `.pi/skills/zob-harness/SKILL.md` in scope.

Start ProjectDNA for: $ARGUMENTS

Treat ProjectDNA as agents-first: the agent owns intake, scope, capture goal, safety gates, validation, oracle, and promotion posture. Deterministic npm scripts and factory runs are tools for producing cited artifacts; they are not the primary control plane and must not be described as autonomous external-project scanning or backend writeback.

For a 5/5 agentic run, require these specialist gates before claiming success: Safety Preflight, Repo Scout, Ontology Steward, Query Steward, Pattern Miner, Symbol Range Curator, Test Linker, Sample Architect, Golden Evaluator, and ProjectDNA Oracle. Query Steward must rewrite transient questions into controlled ontology/golden-case intent without persisting raw query text. Golden Evaluator must pass all golden cases before Oracle PASS/no_ship=false.

Output:

1. **Intake scope**
   - source_project_path or manifest path
   - source_id
   - allowed_paths
   - forbidden_patterns
   - sample_domain
   - capture_mode: execution posture: `plan_only`, `read_only_scan`, `sandbox_sample_generation`, or `runtime_query_existing_artifacts`
   - semantic_capture_mode: knowledge posture: `full_capture`, `architecture_only`, `targeted_capture`, `sample_first`, or `context_only`
   - capture_goal: bounded pattern/question to capture
   - user_note: optional operator guidance; not evidence and not a citation
   - compute profile: `auto`, `low`, `medium`, `high`, `xhigh`, or `max` (default `auto`)
   - compute caps, if any
   - execution mode: `plan_only`, `read_only_scan`, or `sandbox_sample_generation`
   - promotion policy, default `proposal_only`

2. **Safety preflight**
   - Confirm no `.env`, keys, credentials, `node_modules`, `dist`, `build`, `.git`, or generated/vendor folders are read.
   - Confirm the source project remains read-only.
   - Confirm outputs stay under `reports/factory-runs/<run_id>/` or approved sandbox/quarantine.
   - Confirm no external knowledge-backend import, sync, embed, or write is performed unless explicitly approved.

3. **Compute preview and workflow plan**
   - if compute profile is `auto`, run or recommend `npm run preview:compute-profile:project-dna-smoke` for the safe smoke target, or create a bounded real-run preview artifact for approved paths;
   - validate preview/resolution with `npm run validate:compute-profile:project-dna-smoke` or the matching artifact validator;
   - choose profile-specific stages: auto=metadata-only preview/resolve then apply resolved profile, low=scan+scan validation, medium=low+capsules/spec/one query, high=medium+quarantine sample/sample validation/benchmark/oracle, xhigh=high+specialist lanes/richer query/adversarial review, max=xhigh+multi-reference/symbol/callgraph/promotion packet with strict human/budget/oracle gates;
   - deterministic scanner artifacts;
   - Developer DNA synthesis artifacts;
   - neutral sample generation path, if approved;
   - code knowledge graph and capsule outputs;
   - benchmark smoke query;
   - validation and oracle gates.

4. **Factory action**
   - If only planning/scaffold validation is requested, run or recommend:
     - `npm run validate:project-dna`
     - `npm run preview:compute-profile:project-dna-smoke`
     - `npm run validate:compute-profile:project-dna-smoke`
     - `factory_run` with `.pi/factories/project-dna/smoke-manifest.json` in `plan_only` or deterministic smoke mode.
   - If scanner smoke is requested, run `npm run smoke:project-dna-scan`; it scans only `.pi/factories/project-dna` and writes metadata under `reports/project-dna-scans/project-dna-factory-smoke/`.
   - After scanner smoke, run `npm run validate:project-dna-scan:smoke` to verify artifacts, line-range citations, and no-write posture.
   - If pointer capsules are requested after scanner smoke, run `npm run build:project-dna-capsules:smoke`; it reads scan metadata only.
   - If neutral sample planning is requested, run `npm run build:project-dna-sample-spec:smoke`; it creates a spec only and does not generate code.
   - If quarantine sample smoke is requested, run `npm run generate:project-dna-sample:smoke` then `npm run validate:project-dna-sample:smoke`; generation must stay under `reports/.../quarantine/`.
   - If runtime-style context lookup is requested, prefer `zob_project_dna_query` against an existing `reports/project-dna-scans/...` directory; `npm run query:project-dna:smoke` remains the deterministic CLI smoke. Raw query text must be hashed/not persisted and output must be bounded/cited.
   - For multi-source proposal-only context, use `zob_project_dna_federated_query`; it must preserve source isolation and never write a backend.
   - For 5/5 agentic smoke, run `npm run emit:project-dna-ontology:smoke`, `npm run validate:project-dna-ontology:smoke`, `npm run emit:project-dna-golden-cases:smoke`, `npm run validate:project-dna-golden-cases:smoke`, and `npm run steward:project-dna-query:smoke` before benchmark/oracle.
   - Before treating ProjectDNA smoke as ready, run `npm run bench:project-dna:smoke`, `npm run oracle:project-dna:smoke`, and `npm run validate:project-dna-5of5:smoke`; these do not grant durable promotion.
   - If a real project path is requested, require explicit `allowed_paths` and produce a bounded manifest before scanning.
   - Use `capture_mode` strictly: `plan_only` never scans source; `read_only_scan` reads only approved paths; `sandbox_sample_generation` writes only quarantine/sandbox outputs; `runtime_query_existing_artifacts` queries existing artifacts only.
   - Use `semantic_capture_mode` for knowledge depth: `full_capture` for small complete references, `architecture_only` for huge repos or architecture notes, `targeted_capture` for named domains/features, `sample_first` for neutral sample priority, and `context_only` for lookup packs only.
   - Use `capture_goal` to bound scanner/capsule/query priorities; treat `user_note` as operator intent only and never as source truth.

5. **Context integration**
   - Use `zob_context_validate_scope` before runtime context lookup when injecting context into another task.
   - Use `zob_project_dna_readiness` to audit repo-local ProjectDNA readiness.
   - Use `zob_project_dna_query` or `/project-dna query ...` for bounded cited pointers from existing scan artifacts.
   - Use `zob_project_dna_writeback_proposal` only for hash-only local learning proposals; no durable promotion.
   - Return bounded context packs only.
   - Every ProjectDNA fact, pattern, and capsule must cite source/sample files.

6. **No-ship checks**
   - secrets or forbidden paths touched;
   - source project modified;
   - missing/invalid citations;
   - sample validation failed;
   - unapproved external knowledge-backend writes;
   - oracle `no_ship=true`.

Final answer:
- changed/generated files or planned artifacts;
- validation commands/results;
- no-ship risks and next slice;
- compliance line;
- `deliverable_delivered: yes/no`.
