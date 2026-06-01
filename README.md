# ZOB Harness

**A governed Pi harness for human-controlled agentic engineering.**

ZOB Harness turns an open-ended coding-agent chat into a governed engineering loop: clear contracts, specialist agents, mode-aware workflows, safety gates, evidence reports, skeptical oracle review, and repeatable software factories.

It is for developers and evaluators who want agents to help with real repository work without losing the plot, touching secrets, silently committing, or declaring victory without proof.

```text
Human intent
  -> six-part contract
  -> scoped mode and tools
  -> specialist agent or local implementation
  -> validation evidence
  -> oracle review / no-ship decision
  -> reusable workflow when the pattern repeats
```

ZOB is not an “unleash the agent” project. It is a control plane for making agent work reviewable, bounded, and repeatable.

## Why ZOB exists

Normal coding-agent sessions can be impressive and still fail in predictable ways:

- The agent drifts from the task or expands scope.
- Research, planning, implementation, and review blur together.
- Delegated work comes back without enough evidence.
- Generated artifacts mix with source files.
- Safety rules live in prose instead of enforceable gates.
- “Done” is claimed before commands, diffs, and blockers are visible.

ZOB adds an operating layer around Pi so each step has a job, a boundary, and an audit trail.

## What you get

### 1. Contract-first delegation

Every delegated task can be expressed as a six-part contract:

```text
1. TASK: [atomic goal]
2. EXPECTED OUTCOME: [observable deliverable/verdict]
3. REQUIRED TOOLS: [allowed tools only]
4. MUST DO: [positive constraints]
5. MUST NOT DO: [hard stops]
6. CONTEXT: [paths, prior evidence, downstream use]
```

This keeps child work bounded and makes review easier: what changed, what was verified, what remains risky, and what should stop shipment.

### 2. Mode-aware engineering loops

ZOB separates the work into explicit modes:

- **Explore** — inspect and map facts without editing.
- **Plan** — turn evidence into a bounded implementation path.
- **Implement** — change the smallest safe file set and verify it.
- **Oracle** — review skeptically and surface no-ship blockers.
- **Factory** — convert repeatable workflows into manifests, checkpoints, sentinels, and smoke gates.
- **Orchestrator** — coordinate goals, TODO graphs, and specialist handoffs without bypassing safety.

For non-trivial work, the default loop is:

```text
Explore -> Plan -> Implement -> Oracle
```

### 3. Specialist agents and domain skills

The repo includes reusable operating assets for focused work:

- [`.pi/agents/`](.pi/agents/) — specialist roles for exploration, planning, implementation, QA, oracle review, synthesis, ProjectDNA, and more.
- [`.pi/skills/`](.pi/skills/) — domain instructions for commits, coms, factories, sandboxing, ProjectDNA, autonomy checks, goal/TODO trees, oracle review, and harness routing.
- [`.pi/output-contracts/`](.pi/output-contracts/) — structured completion contracts for child results and other governed outputs.
- [`.pi/capabilities/`](.pi/capabilities/) — runtime capability registry that maps public tools/commands to modes, skills, docs, and no-ship notes.

The goal is not to make prompts longer. The goal is to route the right instructions only when a task needs them.

### 4. Evidence-gated completion

A ZOB result should make review straightforward. Agents are expected to report:

- exact files changed;
- exact commands run;
- command outcomes;
- evidence references;
- unresolved risks and blockers;
- compliance with forbidden paths, commit policy, and scope.

That evidence posture is built into the project instructions in [AGENTS.md](AGENTS.md), the source map in [SOURCE_INDEX.md](SOURCE_INDEX.md), and the validation helpers in [scripts/README.md](scripts/README.md).

### 5. Safety-first local operation

ZOB is deliberately conservative around risky actions:

- no `.env`, private key, SSH, AWS, or credential reads;
- no destructive shell/git operations without explicit approval;
- no direct commits, pushes, tags, or force pushes by default;
- governed commits go through `/zcommit` only when explicitly authorized;
- generated reports, ledgers, sessions, and local coordination state stay local;
- autonomy checks are supervised evidence, not a claim of unrestricted autonomy.

The safety posture is backed by [`.pi/damage-control-rules.json`](.pi/damage-control-rules.json), [`.pi/git-policy.json`](.pi/git-policy.json), the child-safety extension, and smoke scripts under [`scripts/`](scripts/README.md).

### 6. Factories for repeatable work

When a workflow repeats, ZOB can turn it into a factory-shaped process: manifest, checkpoints, sentinels, smoke/pilot/batch gates, artifacts, and oracle review. The repository includes safe scaffolds under [`.pi/factories/`](.pi/factories/) and validation commands for public, reproducible workflows.

### 7. Local code knowledge with ProjectDNA

ProjectDNA scaffolding helps turn approved local code scan artifacts into bounded, cited context packs and sample/spec outputs. The public posture is intentionally safe: read-only approved sources, generated artifacts under `reports/`, and no external knowledge-backend import/sync/embed/write unless explicitly approved.

## Quick start

### Requirements

- Node.js **22+**; Node 24 is recommended.
- npm.
- Pi installed and available on `PATH`.

### Install from npm for normal Pi use

After the package is published to npm, install the pinned Pi package:

```bash
pi install npm:zob-harness@0.1.0
```

Then verify that Pi can load the package extension set and return a deterministic response:

```bash
pi -e npm:zob-harness@0.1.0 --offline --no-session -p "Reply exactly: zob-harness-ok"
```

Expected result:

```text
zob-harness-ok
```

If `pi install` cannot find the package, confirm the npm release is visible first:

```bash
npm view zob-harness@0.1.0 version
```

Expected result:

```text
0.1.0
```

Pi package discovery on `pi.dev/packages` is based on the npm `pi-package` keyword and may lag behind npm publication.

### Try from a local checkout before publication

Use this path when developing or validating a release candidate before npm publication:

```bash
git clone https://github.com/cgarrot/zob-harness.git
cd zob-harness
npm install
npm run check -- --pretty false
npm run pi:check
npm run pack:dry-run
```

Expected results:

- TypeScript completes with exit code 0 and no diagnostics.
- Pi loads the local configured ZOB extension offline and replies with `zob-harness-ok`.
- `npm pack --dry-run --json` lists the Pi manifest, extensions, prompts, skills, agents, and validation scripts in the tarball.

### Start Pi with the local harness checkout

```bash
npm run pi
```

Inside Pi, try:

```text
/zmode
/agents
/contract
```

You should see ZOB modes, specialist agents, and the six-part delegation contract helper.

### Public smoke baseline

```bash
npm run validate:script-surface
npm run smoke:harness
npm run check -- --pretty false
npm run pack:dry-run
```

These commands verify the public script surface, core path/child-goal smokes, TypeScript baseline, and npm package surface.

## Common workflows

### A safe single-agent implementation loop

```text
1. Ask for Explore: inspect files and state a gap verdict.
2. Ask for Plan: name the smallest file set and validation ladder.
3. Ask for Implement: edit only that slice.
4. Ask for Oracle: verify evidence and decide whether no-ship remains.
```

This keeps implementation from starting before the repo facts and stop conditions are clear.

### Delegating work to a specialist

Use `/contract` to create a bounded handoff, then route to an appropriate specialist agent. A good delegated result should come back with changed files, validation commands, evidence refs, risks, and no-ship status for parent/oracle review.

### Goal-linked TODO work

Use `/goal`, `/todo`, and `/goal_gate` when work needs a parent-owned TODO graph. Child agents return claims; the parent decides acceptance. This prevents children from marking parent work done without review.

### Governed commits

ZOB does not encourage invisible git operations. When a user explicitly asks for a commit, agents must use `/zcommit` and follow [`.pi/git-policy.json`](.pi/git-policy.json). Autocommit and autopush are off by default.

### Repeatable factory runs

For recurring tasks, use factory scaffolds rather than ad hoc repetition. Factories should keep manifests, checkpoints, sentinels, generated artifacts, smoke gates, and oracle evidence visible.

### Bounded ProjectDNA context

Use ProjectDNA commands and scripts when a task needs cited local code context. Keep scans approved, artifacts local, and writeback proposal-only unless the parent explicitly authorizes more.

## Command cheat sheet

Inside Pi:

- `/zmode` — switch between `explore`, `plan`, `implement`, `oracle`, `factory`, and `orchestrator`.
- `/stop` — abort current foreground work and local background activity without shutting down Pi.
- `/contract` — insert the six-part delegation template.
- `/agents` — list specialist agents.
- `/goal`, `/todo`, `/todos`, `/goal_gate` — manage goal-linked TODO work and scope anchors.
- `/compute` or `/effort` — preview/resolve compute profiles without bypassing safety gates.
- `/project-dna` — query or operate bounded ProjectDNA context workflows.
- `/zcompact` — configure proactive context compaction.
- `/zcommit` — governed commit workflow; no direct git commit/push/tag shortcuts.
- `/zpeer` — local peer/coms workflow commands where enabled.

From npm/local checkout:

```bash
npm run pi                         # start Pi with configured harness wiring
npm run pi:check                   # offline extension load check
npm run check -- --pretty false    # TypeScript validation baseline
npm run check:ci                   # CI-style TypeScript check
npm run validate:script-surface    # package script/file surface validation
npm run smoke:harness              # path-policy + child-goal-ref smoke
npm run smoke:git-ops              # governed commit policy smoke
npm run smoke:worker-pool          # worker-pool static smoke
npm run smoke:zpeer                # static + local ZPeer smoke
npm run validate:project-dna       # ProjectDNA scaffold validation
npm run pack:dry-run               # npm package dry-run surface check
```

Published package install/check:

```bash
pi install npm:zob-harness@0.1.0
pi -e npm:zob-harness@0.1.0 --offline --no-session -p "Reply exactly: zob-harness-ok"
npm view zob-harness@0.1.0 version
```

See [scripts/README.md](scripts/README.md) for the script family map.

## Repository map

- [README.md](README.md) — project landing page and quickstart.
- [AGENTS.md](AGENTS.md) — project-local agent operating rules.
- [CONTRIBUTING.md](CONTRIBUTING.md) — contributor workflow and validation expectations.
- [SECURITY.md](SECURITY.md) — security policy.
- [SOURCE_INDEX.md](SOURCE_INDEX.md) — tracked source and local/generated area map.
- [package.json](package.json) — package metadata, Pi wiring, and npm scripts.
- [scripts/README.md](scripts/README.md) — public script surface guide.
- [`.pi/extensions/zob-harness/`](.pi/extensions/zob-harness/) — main Pi extension.
- [`.pi/extensions/zob-child-safety/`](.pi/extensions/zob-child-safety/) — child-agent safety extension.
- [`.pi/agents/`](.pi/agents/) — specialist agent definitions.
- [`.pi/skills/`](.pi/skills/) — domain-specific operating instructions.
- [`.pi/prompts/`](.pi/prompts/) — reusable prompt templates.
- [`.pi/factories/`](.pi/factories/) — safe factory scaffolds.
- [`.pi/output-contracts/`](.pi/output-contracts/) — structured output contract manifests.
- [`.pi/capabilities/`](.pi/capabilities/) — public runtime capability registry.
- [`scripts/`](scripts/README.md) — local validation, smoke, audit, and proof helpers.

Local/generated areas such as `reports/`, `plans/`, `.pi/sessions/`, `.pi/logs/`, `.pi/tmp/`, coms ledgers, workspace claims, worker pools, and merge queues are not part of the normal source surface. See [SOURCE_INDEX.md](SOURCE_INDEX.md) for the current classification.

## Current status and limits

ZOB Harness is an early, conservative, governed harness. The public repo is useful for evaluating the operating model, extension wiring, skills, agents, safety posture, and smoke validations. It should not be described as unrestricted autonomy, a production deployment system, or a benchmark-winning agent framework.

Current limits are intentional:

- explicit scoped tools, paths, and stop conditions by default;
- human approval for risky writes and commits;
- no global autonomy claim from dry-run or read-only validation;
- no public claims based on private benchmark artifacts;
- generated reports and local runtime ledgers are kept out of source control;
- advanced runtime moves and broad refactors should be split into reviewed slices.

## Validation standard for changes

For a normal README/docs or harness-surface change, start with:

```bash
npm run validate:script-surface
git diff --check
npm run check -- --pretty false
```

When relevant, add:

```bash
npm run smoke:harness
npm run smoke:git-ops
npm run smoke:worker-pool
npm run validate:project-dna
npm run pack:dry-run
```

For a public npm release, maintainers should additionally run:

```bash
npm whoami
npm view zob-harness@0.1.0 version || true
npm publish --dry-run
npm publish
npm view zob-harness@0.1.0 version
pi install npm:zob-harness@0.1.0
pi -e npm:zob-harness@0.1.0 --offline --no-session -p "Reply exactly: zob-harness-ok"
```

`npm publish` may require npm two-factor authentication in the browser or a one-time password. Do not paste OTPs, tokens, or secrets into issue reports or agent transcripts.

Report exact command outcomes before claiming readiness.

## Contributing

Contributions should preserve the ZOB operating style:

- small, reversible changes;
- explicit scope and stop conditions;
- no secret access;
- no hidden commits or pushes;
- no unsupported benchmark/autonomy claims;
- validation evidence attached to every readiness claim.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow.

## License

MIT.
