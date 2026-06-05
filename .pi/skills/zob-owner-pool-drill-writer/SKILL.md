---
name: zob-owner-pool-drill-writer
description: Use when the owner gives a plain-language intention and wants it rewritten into a safe, copy-pasteable ZOB parallel owner micro-worker pool drill or execution prompt.
---
# ZOB Owner Pool Drill Writer Skill

## Purpose

Use this skill to turn a short owner ask into a complete ZOB parallel owner micro-worker pool prompt. The owner may write only a few plain-language notes; the assistant expands them into a structured, safe drill with objective, assumptions, path grants, worker assignments, phases, owner arbitration, validation, metadata audit, and result contract.

This skill writes prompts only. It does not dispatch workers, apply changes, mutate TODOs, commit, or enable autonomous production writes.

## Lightweight intake form

Ask for missing details only when they change safety. Otherwise use the defaults.

```text
1. Objective: [what should the worker pool accomplish?]
2. Source/read paths: [default: ask owner; never assume broad repo access]
3. Desired outputs: [default: reports/proposals only]
4. Workers: [default: 3 micro-workers: mapper, implementer/planner, oracle]
5. Write mode: [default: reports-only]
   - reports-only: workers may write only report/proposal artifacts
   - source-write: requires explicit owner request plus sandbox/merge/oracle gates
6. Validation commands: [default: narrowest relevant read/check command; if unknown, ask]
7. Time/scale: [default: one bounded slice, no batch scaling]
8. Special constraints: [forbidden paths, no-ship gates, human decisions]
```

## Defaults

- Mode: `reports-only`.
- Dispatch: parent-owned only.
- Coordination record: Goal Room is canonical.
- Peer/live chatter: ZPeer is transient only and cannot replace typed Goal Room decisions or evidence.
- Worker policy: no child-spawns-child; no child mutates parent TODOs; no direct main-workspace apply/merge.
- Persistence: no raw body persistence in coordination metadata; use body-free summaries, hashes, paths, and evidence refs.
- Writes: read-across/write-by-owner. Workers can read cited context, but only the owning worker may propose or perform writes within granted owned paths.
- Source writes: prohibited unless the owner explicitly requests `source-write` and the generated prompt states sandbox, merge, rollback, validation, oracle, and human approval gates.
- Git: no commits, pushes, tags, staging, or direct git state changes unless separately authorized by governed ZOB commit policy.

## Conversion procedure

1. Extract the owner intent into one sentence: `OBJECTIVE`.
2. Identify concrete `READ_PATHS`, `OWNED_PATHS`, and `OUTPUT_PATHS`. If paths are absent, use placeholders and ask the owner to fill them.
3. Choose worker roles. Prefer small, bounded micro-workers:
   - Mapper: inventories relevant files/artifacts and creates a path/evidence map.
   - Planner or Implementer: drafts the proposed changes or performs the bounded owned slice.
   - Oracle: checks safety, evidence, validation, and no-ship conditions.
   Add workers only when the objective has clearly separable owned paths.
4. Choose mode:
   - `reports-only` for exploration, planning, audits, prompts, specs, and proposals.
   - `source-write-gated` only when explicitly requested.
5. Generate a copy-pasteable prompt using the template below.
6. End with a strict result contract so downstream agents return comparable evidence.

## Copy-paste template

```text
ORIGINAL_OWNER_ASK: [paste the owner’s plain-language request]

1. TASK: Run a bounded ZOB parallel owner micro-worker pool drill for [OBJECTIVE].
2. EXPECTED OUTCOME: [observable deliverable: report/proposal/diff candidate/validation verdict], with evidence and no auto-apply.
3. REQUIRED TOOLS: [list allowed tools only; default: read, grep, find, ls, bash, write/edit only for allowed report paths]
4. MUST DO:
   - Keep this to one bounded slice: [SCOPE].
   - Use Goal Room as the canonical coordination record; ZPeer is transient only.
   - Use parent-owned dispatch only; workers must not spawn children.
   - Enforce read-across/write-by-owner.
   - Persist no raw message bodies in metadata; use paths, hashes, summaries, and evidence refs.
   - Default to reports-only outputs under [OUTPUT_PATHS].
   - Record owner requests for any cross-owner or source-write need; decisions are metadata only and never auto-apply.
   - Run validation commands: [VALIDATION_COMMANDS].
   - Produce a metadata audit: worker IDs/roles, owned paths, read paths, outputs, evidence refs, validation results, no-ship status.
5. MUST NOT DO:
   - Do not commit, push, tag, stage, or alter git state.
   - Do not read/write secrets or forbidden paths: [FORBIDDEN_PATHS].
   - Do not write source files unless source-write is explicitly requested and sandbox/merge/oracle/human gates are stated.
   - Do not count append-only or stale/offline records as delivery success.
   - Do not auto-apply, auto-merge, or claim autonomous production readiness.
6. CONTEXT:
   - Objective: [OBJECTIVE]
   - Assumptions: [ASSUMPTIONS]
   - Read paths: [READ_PATHS]
   - Owned/write paths: [OWNED_PATHS]
   - Output paths: [OUTPUT_PATHS]
   - Write mode: [reports-only | source-write-gated]

WORKER ASSIGNMENTS:
- Worker A / Mapper:
  - Owns: [owned report path]
  - Reads: [read paths]
  - Produces: path map, risk map, evidence refs.
- Worker B / [Planner or Implementer]:
  - Owns: [owned report or sandbox path]
  - Reads: [read paths]
  - Produces: [proposal, patch plan, or sandbox diff candidate].
- Worker C / Oracle:
  - Owns: [oracle report path]
  - Reads: Worker A/B outputs and validation logs.
  - Produces: PASS/WARN/FAIL, no_ship flag, evidence gaps, merge/apply blockers.

PHASES:
1. Intake and scope lock: confirm objective, paths, mode, forbidden paths, and validation.
2. Metadata setup: create/read only body-free coordination records; no raw body persistence.
3. Parallel work: workers operate only within owned grants; read-across is read-only.
4. Owner arbitration: cross-owner/source-write requests must be explicit typed requests and parent decisions.
5. Validation: run [VALIDATION_COMMANDS] or report why not feasible.
6. Oracle review: verify evidence, safety rules, and no-ship status.
7. Final synthesis: summarize outputs, evidence, risks, and exact next owner decision.

RESULT CONTRACT:
- gap_verdict: SUFFICIENT or GAP, with exact missing behavior if GAP
- worker_outputs: paths and one-line summaries
- validation_commands: exact commands run, or not run with reason
- results: exact outcomes
- metadata_audit: workers, owned paths, read paths, output paths, owner requests/decisions, hashes/evidence refs
- no_ship: true/false with reason
- risks/blockers: unresolved risks
- compliance: Goal Room canonical, ZPeer transient, parent-owned dispatch, no child-spawns-child, read-across/write-by-owner, no raw body persistence, no auto-apply, no commits
- deliverable_delivered: yes/no
```

## Example 1: reports-only full drill

Owner writes:

```text
I want several workers to analyze our ProjectDNA workflow and return a clear plan without modifying code.
```

Generated prompt:

```text
ORIGINAL_OWNER_ASK: I want several workers to analyze our ProjectDNA workflow and return a clear plan without modifying code.

1. TASK: Run a bounded ZOB parallel owner micro-worker pool drill to analyze the ProjectDNA workflow and produce a clear reports-only improvement plan.
2. EXPECTED OUTCOME: Report artifacts with workflow map, improvement plan, oracle review, validation evidence, and no source changes.
3. REQUIRED TOOLS: read, grep, find, ls, bash, write.
4. MUST DO:
   - Keep this to one bounded ProjectDNA workflow analysis slice.
   - Use Goal Room as the canonical coordination record; ZPeer is transient only.
   - Use parent-owned dispatch only; workers must not spawn children.
   - Enforce read-across/write-by-owner.
   - Persist no raw message bodies in metadata; use paths, hashes, summaries, and evidence refs.
   - Write only reports under `reports/project-dna-owner-pool-drill/`.
   - Run validation commands: `npm run validate:project-dna` if feasible.
   - Produce a metadata audit with workers, paths, outputs, evidence refs, validation results, and no-ship status.
5. MUST NOT DO:
   - Do not edit source files, prompts, existing skills, docs, package files, or registry.
   - Do not commit, push, tag, stage, or alter git state.
   - Do not read/write secrets, `.env`, keys, `~/.ssh`, `~/.aws`, `node_modules`, `dist`, `build`, or `.git`.
   - Do not auto-apply or claim autonomous production readiness.
6. CONTEXT:
   - Objective: Analyze the ProjectDNA workflow and produce a clear plan.
   - Assumptions: Reports-only; no code changes.
   - Read paths: `.pi/factories/project-dna`, `.pi/skills/zob-project-dna/SKILL.md`, relevant package scripts.
   - Owned/write paths: `reports/project-dna-owner-pool-drill/worker-a-map.md`, `worker-b-plan.md`, `worker-c-oracle.md`.
   - Output paths: `reports/project-dna-owner-pool-drill/`.
   - Write mode: reports-only.

WORKER ASSIGNMENTS:
- Worker A / Mapper: produce workflow/path/evidence map.
- Worker B / Planner: produce improvement plan and owner decision points.
- Worker C / Oracle: review evidence, safety, validation, and no-ship status.

PHASES: intake and scope lock; body-free metadata setup; parallel reports-only work; owner arbitration for any cross-owner need; validation; oracle review; final synthesis.

RESULT CONTRACT:
- gap_verdict
- worker_outputs
- validation_commands
- results
- metadata_audit
- no_ship
- risks/blockers
- compliance
- deliverable_delivered: yes/no
```

## Example 2: source-write plan remains gated/sandboxed

Owner writes:

```text
I want the workers to prepare a small runtime correction, but I want to review it before it touches the repo.
```

Generated prompt:

```text
ORIGINAL_OWNER_ASK: I want the workers to prepare a small runtime correction, but I want to review it before it touches the repo.

1. TASK: Run a bounded ZOB parallel owner micro-worker pool drill to prepare a gated sandbox source-write correction plan for the specified runtime issue.
2. EXPECTED OUTCOME: Sandbox diff candidate plus validation and oracle reports; no main-workspace apply unless the owner later approves through explicit merge gates.
3. REQUIRED TOOLS: read, grep, find, ls, bash, write, edit only inside the declared sandbox/allowed paths.
4. MUST DO:
   - Ask the owner to specify the exact runtime issue and allowed source paths before any source-write work.
   - Use Goal Room as the canonical coordination record; ZPeer is transient only.
   - Use parent-owned dispatch only; workers must not spawn children.
   - Enforce read-across/write-by-owner.
   - Work in a sandbox/temp workspace or explicit quarantine path, not direct main-workspace source files.
   - Record diff hash, changed paths, rollback notes, validation logs, and oracle verdict.
   - Treat owner merge approval as a later separate decision; this prompt does not auto-apply.
5. MUST NOT DO:
   - Do not write directly to main-workspace runtime files.
   - Do not commit, push, tag, stage, or alter git state.
   - Do not read/write secrets, `.env`, keys, `~/.ssh`, `~/.aws`, `node_modules`, `dist`, `build`, or `.git`.
   - Do not auto-merge, auto-apply, or claim autonomous production readiness.
6. CONTEXT:
   - Objective: Prepare a small runtime correction candidate for owner review.
   - Assumptions: Source-write is gated and sandboxed only.
   - Read paths: [owner fills exact runtime paths].
   - Owned/write paths: [sandbox/quarantine paths only].
   - Output paths: [sandbox diff report, validation log, oracle report].
   - Write mode: source-write-gated.

WORKER ASSIGNMENTS:
- Worker A / Mapper: inspect allowed runtime paths and identify minimal change surface.
- Worker B / Sandbox Implementer: create only the sandbox diff candidate and rollback notes.
- Worker C / Oracle: review diff hash, validation logs, safety gates, and no-ship status.

PHASES: owner path confirmation; sandbox setup; parallel read/planning; sandbox-only implementation; validation; oracle review; owner merge decision request.

RESULT CONTRACT:
- gap_verdict
- worker_outputs
- validation_commands
- results
- metadata_audit
- no_ship
- risks/blockers
- compliance
- deliverable_delivered: yes/no
```

## Refusal and clarification triggers

Refuse or ask for clarification instead of generating a runnable drill when:

- The owner asks for commits, pushes, tags, secret access, destructive commands, or broad unbounded writes.
- The owner requests source writes but gives no path boundaries or rejects sandbox/oracle gates.
- The prompt would require child-spawns-child, auto-apply, raw body persistence, or treating non-live append-only records as delivery success.
- The objective is too broad to be one bounded slice.
