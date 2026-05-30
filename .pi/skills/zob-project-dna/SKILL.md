---
name: zob-project-dna
description: "Use when turning a trusted reference project folder into ProjectDNA: a code-first knowledge graph, neutral sample-project plan, pointer capsules, and bounded cited context packs for future ZOB agents."
---
# ZOB ProjectDNA Skill

## Purpose

ProjectDNA makes a real project usable as code-first context without treating docs as truth. It is agents-first: ZOB agents own scope, capture goals, safety gates, validation, oracle review, and promotion proposals; deterministic scripts are tools that produce evidence for agents to inspect and cite.

The intended flow is:

```text
trusted reference project folder
→ read-only safe scan
→ deterministic code/architecture facts
→ Developer DNA synthesis with citations
→ neutral sample project in quarantine/sandbox
→ pointer capsules and code knowledge graph
→ bounded context packs for future agents
```

The real project code remains the source of truth. The generated sample, graph, and capsules are navigation layers only.

## When to use

Use this skill when the user asks to:

- learn from a project folder they like;
- create a reusable code knowledge graph from a reference app;
- generate a neutral sample project that preserves architecture/style;
- add project-code retrieval inspired by prior wiki/retrieval V2 work;
- speed up future coding with cited project examples;
- query “how do we do X in my style?” across reference projects.

## Required starting inputs

Before any scan or generation, collect or confirm:

1. `source_project_path`: absolute or repo-local path explicitly approved by the user.
2. `source_id`: safe id for the reference project, e.g. `my-reference-app`.
3. `allowed_paths`: bounded paths the scanner may inspect.
4. `forbidden_patterns`: at minimum `.env`, `.env.*`, keys, credentials, `node_modules`, `dist`, `build`, coverage, `.git`.
5. `sample_domain`: neutral domain for the generated sample, e.g. `task-tracker`.
6. `validation_profile`: install/lint/typecheck/test/build commands or a stated “plan-only” mode.
7. `compute_profile`: `auto`, `low`, `medium`, `high`, `xhigh`, or `max`; default `auto`.
8. `compute_caps`: optional hard caps for agents, depth, parallelism, duration, context, budget, and oracle.
9. `capture_mode`: execution posture: `plan_only`, `read_only_scan`, `sandbox_sample_generation`, or `runtime_query_existing_artifacts`.
10. `semantic_capture_mode`: knowledge posture: `full_capture`, `architecture_only`, `targeted_capture`, `sample_first`, or `context_only`.
11. `capture_goal`: concrete pattern/question to capture, e.g. architecture, queues, tests, config, or service boundaries.
12. `user_note`: optional operator intent/style note; guidance only, never citation evidence.
13. `promotion_policy`: normally `proposal_only` until oracle and human approval.

If any of these are missing for a real project scan, ask for clarification or produce a plan-only manifest instead of scanning.

## Native ZOB surfaces

- Plan doc: `docs/ZOB_PROJECT_DNA_CODE_KNOWLEDGE_GRAPH_PLAN.md`
- Factory scaffold: `.pi/factories/project-dna/factory.json`
- Prompt template: `.pi/prompts/project-dna.md`
- Scaffold validator: `npm run validate:project-dna`
- Compute preview smoke: `npm run preview:compute-profile:project-dna-smoke`
- Compute preview validator: `npm run validate:compute-profile:project-dna-smoke`
- Read-only scanner smoke: `npm run smoke:project-dna-scan`
- Scan artifact validator: `npm run validate:project-dna-scan:smoke`
- Pointer capsule builder smoke: `npm run build:project-dna-capsules:smoke`
- Neutral sample-spec smoke: `npm run build:project-dna-sample-spec:smoke`
- Quarantine sample generation smoke: `npm run generate:project-dna-sample:smoke`
- Quarantine sample validation smoke: `npm run validate:project-dna-sample:smoke`
- Metadata-only agentic workflow planner smoke: `npm run plan:project-dna-workflow:smoke`
- Agentic workflow plan validator: `npm run validate:project-dna-workflow:smoke`
- Metadata-only context query smoke: `npm run query:project-dna:smoke`
- Runtime readiness/plan/query tools: `zob_project_dna_readiness`, `zob_project_dna_plan_workflow`, `zob_project_dna_query`
- Runtime P5 proposal-only tools: `zob_project_dna_federated_query`, `zob_project_dna_writeback_proposal`
- Slash/operator surface: `/project-dna`
- Deterministic retrieval/sample benchmark: `npm run bench:project-dna:smoke`
- Structural oracle smoke review: `npm run oracle:project-dna:smoke`
- Context foundation: existing `zob_context_*` tools for scope/citation/writeback gates.

Current status: ProjectDNA is scaffolded as a safe skill/factory workflow and now includes deterministic read-only scanner, compute-profile preview scripts, validated smoke artifacts, native runtime readiness/query/federated-query tools, `/project-dna`, and hash-only proposal writeback. **No external knowledge backend import**, sync, embed, or write is performed by default, and no autonomous external-project scanning happens without parent-owned allowed paths. Scripts are deterministic tools for agents; they are not a replacement for parent-owned scope, safety, validation, oracle, and promotion decisions.

## 5/5 agents-first contract

A ProjectDNA result is 5/5 only when agents, not scripts, own scope and acceptance:

1. Safety Preflight confirms approved paths, forbidden patterns, source read-only posture, quarantine/report outputs, and proposal-only promotion.
2. Repo Scout and deterministic scanner produce cited facts; scanner scripts are microscopes, not the control plane.
3. Ontology Steward maps facts into controlled pattern concepts such as `project_dna.agentic_control_plane`, `project_dna.query_steward_rewrite`, and `project_dna.sample_quarantine_pi_like`.
4. Query Steward rewrites transient user questions into controlled intent/golden-case expectations without persisting raw query text.
5. Pattern Miner, Symbol Range Curator, and Test Linker connect source patterns to precise ranges, tests, examples, docs, and gaps.
6. Sample Architect creates only neutral Pi-like quarantine samples with extension/tool/agent/skill/test shape and `source_files_copied=false`.
7. Golden Evaluator runs golden cases; every case must return expected citations/files/patterns and no-write safety flags.
8. ProjectDNA Oracle can PASS only when ontology, golden cases, query steward report, benchmark, sample validation, and source-safe gates are present.

5/5 does **not** mean durable promotion. It remains reports-local/proposal-only until separate oracle and human approval.

## Safe workflow

### 1. Intake and scope

Produce an explicit scope block:

```text
source_project_path: ...
source_id: ...
allowed_paths: ...
forbidden_patterns: ...
sample_domain: ...
execution_mode: plan_only | read_only_scan | sandbox_sample_generation
capture_mode: plan_only | read_only_scan | sandbox_sample_generation | runtime_query_existing_artifacts
semantic_capture_mode: full_capture | architecture_only | targeted_capture | sample_first | context_only
capture_goal: bounded pattern/question to capture
user_note: optional operator guidance, not evidence
compute_profile: auto | low | medium | high | xhigh | max
compute_caps: optional hard caps
promotion_policy: proposal_only
```

### 2. Preflight

Must verify:

- user-approved path is bounded;
- source project is not modified;
- forbidden paths are excluded;
- output path is a run directory or sandbox/quarantine;
- no external knowledge-backend import, sync, embed, or write is implied unless explicitly approved.

### 3. Compute preview before scan when profile is auto

For `compute_profile=auto`, write or inspect metadata-only compute artifacts before choosing workflow depth:

```text
compute-preview.json
compute-profile-resolution.json
```

ProjectDNA profile mapping:

```text
auto   → metadata-only preview/resolve, then apply the resolved low/medium/high/xhigh/max row
low    → scan + scan validation
medium → scan + validation + capsules + sample spec + one query
high   → medium + quarantine sample + sample validation + benchmark + oracle
xhigh  → high + specialist lanes + richer query suite + adversarial review
max    → xhigh + multi-reference/symbol/callgraph/promotion packet gates, with strict human/budget/oracle approval
```

Compute profile must not bypass ProjectDNA safety: source projects remain read-only, external knowledge-backend writes remain disabled, quarantine/proposal-only outputs remain enforced, and child dispatch stays parent-owned.

### 3a. Capture mode policy

Use `capture_mode` to pick posture before any tool/script run:

- `plan_only`: produce a manifest/plan from approved docs, `capture_goal`, and `user_note`; do not scan source code.
- `read_only_scan`: inspect only explicit `allowed_paths`, with forbidden patterns skipped and cited.
- `sandbox_sample_generation`: use existing facts/specs to write only under approved quarantine/sandbox paths.
- `runtime_query_existing_artifacts`: return bounded cited context from existing scan artifacts; do not start a new external-project scan.

Use `semantic_capture_mode` to pick knowledge depth:

- `full_capture`: small/medium repo, reusable reference across major domains.
- `architecture_only`: large repo or user asks to preserve architecture/scaffold only.
- `targeted_capture`: mine only named domains/features from `capture_goal` or `user_note`.
- `sample_first`: prioritize a neutral working sample from cited architecture facts.
- `context_only`: return bounded pointers/context packs without sample generation.

`capture_goal` drives which artifacts/capsules/query cases are in scope. `user_note` may explain intent, constraints, or style preferences, but it is never a citation and must not override scanner facts. For huge repos, default to `architecture_only` or `targeted_capture` unless the user explicitly approves deeper compute.

### 4. Deterministic scan first

Scanner facts should precede LLM synthesis:

```text
project-fingerprint.json
dependency-map.json
file-map.json
symbol-map.json
import-graph.json
route-map.json
queue-map.json
config-map.json
test-map.json
architecture-map.json
```

Each fact must cite safe repo-relative or source-relative paths and line ranges when available.

### 5. Developer DNA synthesis

LLM/Ollama may summarize patterns, but only from deterministic facts and citations.

Allowed synthesis outputs:

```text
developer-dna.json
code-knowledge-graph.json
capsules/*.md
context-pack-smoke.json
```

Forbidden synthesis behavior:

- invent architecture not supported by scan facts;
- answer from generic framework docs instead of project evidence;
- store raw proprietary bodies unnecessarily;
- copy product-specific logic into the sample.

### 6. Sample generation

Generate only in quarantine/sandbox first:

```text
reports/factory-runs/<run_id>/quarantine/project-dna-sample/
```

Promote only if:

- validation commands pass;
- similarity/leakage checks pass;
- citations are valid;
- oracle returns PASS/no_ship=false;
- human approval is present if writing to durable knowledge/sample locations.

### 7. Runtime context packs

When another ZOB task needs project style context, the Context Steward should return a bounded context pack with:

- answer summary;
- files to read first;
- source citations;
- sample citations if available;
- observed rules;
- explicit gaps;
- token budget;
- no raw secrets or full-project dumps.

## No-ship rules

Block or stop if any occur:

- `.env`, key, credential, SSH/AWS/cloud secret, or private raw data is read or included;
- source project is modified;
- output writes outside the approved run/sandbox/quarantine path;
- external knowledge-backend import/sync/embed/write is attempted without explicit approval;
- sample project fails build/test/typecheck where required;
- generated sample copies product logic too closely;
- citations or line ranges are missing/invalid;
- context pack loads the entire project rather than bounded cited excerpts;
- oracle reports `no_ship=true`.

## Delegation contract template

Use this six-part contract for ProjectDNA child work:

```text
1. TASK: [scan/synthesize/validate one bounded ProjectDNA artifact]
2. EXPECTED OUTCOME: [specific artifact or verdict with citations]
3. REQUIRED TOOLS: read, grep, find, ls only unless sandbox/write is explicitly approved
4. MUST DO: cite files/line ranges; obey allowed_paths; report skipped forbidden paths
5. MUST NOT DO: no secrets; no source writes; no external knowledge-backend import/sync/embed/write; no broad corpus load
6. CONTEXT: source_id, allowed_paths, forbidden_patterns, target artifact, downstream validator/oracle use
```

## Final response shape

End ProjectDNA work with:

```text
<result>what was created or validated</result>
<evidence>file paths, run ids, validation commands</evidence>
<risks_blockers>remaining gaps/no-ship risks</risks_blockers>
<compliance>read-only/source-safe/quarantine/proposal-only statement</compliance>
<deliverable_delivered>yes|no</deliverable_delivered>
```
