# ZOB Harness

**A governed Agent Factory for Pi.**

Launch teams of agents that communicate, build, validate, and turn repeatable workflows into reusable factories.

ZOB turns Pi from a single coding-agent chat into a supervised factory system: define a team, start a run, watch agent communication, review artifacts, and package successful workflows into factories that can create the next thing.

```text
Human intent
  -> governed Agent Factory
  -> chief / scout / builder / oracle / custom roles
  -> visible agent communication
  -> tmux-backed Pi sessions when useful
  -> artifacts under reports/<run_id>/
  -> validation + oracle/no-ship review
  -> reusable factory for the next run
```

ZOB is not “unleash an agent and hope.” ZOB is “launch a team, keep the work observable, preserve evidence, and reuse the pattern once it works.”

## Why this is different

Most agent tools optimize the single assistant session. ZOB optimizes the **agent factory loop**:

- **Teams, not tabs** — model a chief, scouts, builders, reviewers, oracles, and custom roles as ZAgents/ZTeams.
- **Visible communication** — agents coordinate through parent-visible messages instead of hidden worker chat.
- **tmux-backed runs** — launch real Pi sessions in local tmux windows when a workflow benefits from persistent roles.
- **Run artifacts as truth** — manifests, kickoff files, workgraphs, status files, validation output, and oracle reports outlive the chat.
- **Factories create factories** — a successful workflow can become a reusable manifest, launcher, checkpoint set, and validation ladder.
- **Governed by default** — scoped tools, path rules, evidence gates, no-ship review, and governed commits keep the owner in control.

## Try the six-agent Pac-Man factory

The fastest way to understand ZOB is to run the demo factory. The repository does **not** contain a prebuilt game. The factory prepares a run, launches a six-agent team, and asks that team to generate a local browser-playable Pac-Man-inspired multiplayer game under `reports/`.

Prepare and validate run artifacts only. This does not launch tmux/Pi and does not generate the game:

```bash
RUN_ID="pacman-demo"
npm run demo:pacman:prepare -- "$RUN_ID" --force
npm run demo:pacman:validate -- "$RUN_ID"
```

Launch the full tmux-backed Agent Factory team:

```bash
RUN_ID="pacman-demo"
npm run demo:pacman -- "$RUN_ID" --force
```

Observe or stop only this demo team:

```bash
bash .pi/zteams/agent-factory-pacman-multiplayer.tmux.sh status
bash .pi/zteams/agent-factory-pacman-multiplayer.tmux.sh attach agent-factory-pacman-chief
bash .pi/zteams/agent-factory-pacman-multiplayer.tmux.sh close
```

After the agents finish, test the generated project from the reported run directory, typically:

```bash
cd reports/agent-factory-pacman-runs/$RUN_ID/project
npm install
npm run validate
npm run dev
```

See [`examples/agent-factory-pacman-multiplayer/`](examples/agent-factory-pacman-multiplayer/) for the demo brief and [`examples/agent-factory-tmux-comms/`](examples/agent-factory-tmux-comms/) for the small generic tmux + visible communication playbook.

## Agents communicate visibly

ZOB teams coordinate with short, structured, parent-visible messages. The goal is to keep multi-agent work debuggable without persisting raw hidden chat as the source of truth.

```text
CONTEXT: what changed or what the agent is working on
ASK: exact answer, review, or action needed
EVIDENCE: safe file refs, artifact refs, command names, or TODO ids
URGENCY: low|normal|high|critical
BLOCKER: yes/no
```

Example chief → scout ask:

```text
CONTEXT: We are preparing the first implementation slice for the settings workflow.
ASK: Identify the smallest files needed for a safe plan; return evidence refs only.
EVIDENCE: README.md, docs/settings.md, TODO SETTINGS-001
URGENCY: normal
BLOCKER: no
```

Example builder → oracle review request:

```text
CONTEXT: Builder generated the first game loop under the Pac-Man run project.
ASK: Review game rules and validation output before the chief calls this done.
EVIDENCE: reports/agent-factory-pacman-runs/pacman-demo/project/src/game.ts, npm run validate
URGENCY: normal
BLOCKER: no
```

Communication is coordination. **Artifacts are the source of truth.**

## A factory that creates factories

ZOB is designed for the moment when an agent workflow works once and should not remain an ad hoc prompt forever.

A ZOB factory can define:

- a ZTeam topology and role aliases;
- role-specific ZAgent prompts and domain skills;
- tmux launch/status/attach/close scripts;
- startup kickoff files passed as `pi @file`;
- run manifests and dispatch metadata;
- parent-owned workgraphs and TODO trees;
- validation checkpoints, sentinels, and smoke gates;
- oracle/no-ship review requirements;
- generated artifact directories under `reports/<run_id>/`;
- npm scripts that make the workflow repeatable.

The output of a ZOB run can be another ZOB factory: a reusable manifest, launcher, kickoff set, workgraph, and validation ladder for the next class of work.

Existing factory-shaped surfaces include:

- [`examples/agent-factory-tmux-comms/`](examples/agent-factory-tmux-comms/) — smallest teaching shape for a chief, scout, builder, and oracle.
- [`examples/agent-factory-pacman-multiplayer/`](examples/agent-factory-pacman-multiplayer/) — runnable generative team demo.
- [`.pi/factories/harness-intake-agent-team/`](.pi/factories/harness-intake-agent-team/) — natural-language harness/setup/session analyzer that proposes reusable ZOB teams and factory scaffolds in quarantine.
- [`.pi/factories/`](.pi/factories/) — safe factory scaffolds for repeatable workflows such as ProjectDNA, agentic spec work, budget preflight, code review matrices, harness intake, and factory forging.

## Harness Intake: turn another agent setup into a reusable ZOB team

Use Harness Intake when you want to analyze another agent harness — Claude Code, Codex, Cursor, Aider, Pi/ZOB, or a custom setup — and recover reusable teams/factories from its docs, agents, skills, commands, prompts, and authorized sessions.

Natural-language quick start:

```bash
npm run harness:intake -- "Analyze ../repo-x as a Claude Code setup and propose a reusable ZOB team"
```

With explicit session/conversation authorization:

```bash
npm run harness:intake -- --target ../repo-x --harness claude-code --allow-sessions "You may read the sessions; identify recurring workflows and propose a factory"
```

Prepare a visible tmux team run without launching completion claims:

```bash
npm run harness:intake:tmux -- prepare --target ../repo-x "Prepare a visible tmux team to analyze this harness"
```

Outputs are written under:

```text
reports/factory-runs/<run-id>/
  inferred-run-spec.json
  artifact-contracts.json
  autonomous-status.md
  sources-index.json
  harness-profile.json
  skills-profile.json
  sessions-analysis.json
  workflow-patterns.json
  team-candidates.json
  factory-candidates.json
  generated-proposals/
  validation.json
```

Generated teams/factories stay in `generated-proposals/` and are **not activated automatically**. Sessions are read only with explicit authorization, and raw session bodies are not persisted in generated proposals.

See [`.pi/factories/harness-intake-agent-team/README.md`](.pi/factories/harness-intake-agent-team/README.md) for factory usage and implementation details.

## What a ZOB run produces

A serious run should leave reviewable evidence, not just a chat transcript:

```text
reports/<run_id>/
  run-manifest.json
  chief-kickoff.md
  worker-kickoffs/
  autonomous-workgraph.md
  autonomous-status.md
  iteration-log.md
  validation-output.*
  oracle-report.*
  project/ or generated-artifacts/
```

The exact shape depends on the factory, but the posture is consistent: bounded inputs, visible coordination, durable artifacts, validation commands, and explicit risks/blockers.

## Core concepts

- **ZAgent** — a full Pi session with identity, role, allowed posture, and optional ZPeer presence.
- **ZTeam** — topology for rooms, aliases, owner-facing entry points, and communication policy.
- **Chief / orchestrator** — the parent-facing role that owns the workgraph, status, and final synthesis.
- **Scout / builder / oracle** — common role pattern for context discovery, artifact production, and skeptical review.
- **Kickoff file** — bounded startup context passed as `pi @file`, safer than pasting long prompts into live panes.
- **Goal/TODO graph** — parent-owned work breakdown where child claims are reviewed before acceptance.
- **No-ship gate** — explicit blocker status that prevents unsupported “done” claims.

## Quick start

### Requirements

- Node.js **22+**; Node 24 is recommended.
- npm.
- Pi installed and available on `PATH`.
- tmux for tmux-backed Agent Factory demos.

### Install from npm for normal Pi use

After the package is published to npm, install the pinned Pi package:

```bash
pi install npm:zob-harness@0.3.1
```

Verify Pi can load the package extension set and return a deterministic response:

```bash
pi -e npm:zob-harness@0.3.1 --offline --no-session -p "Reply exactly: zob-harness-ok"
```

Expected result:

```text
zob-harness-ok
```

If `pi install` cannot find the package, confirm the npm release is visible first:

```bash
npm view zob-harness@0.3.1 version
```

Expected result:

```text
0.3.1
```

Pi package discovery on `pi.dev/packages` is based on the npm `pi-package` keyword and may lag behind npm publication.

### Try from a local checkout before publication

Use this path when developing or validating a release candidate before npm publication:

```bash
git clone https://github.com/cgarrot/zob-harness.git
cd zob-harness
npm install
npm run validate:script-surface
npm run check -- --pretty false
npm run pi:check
npm run pack:dry-run
```

Expected results:

- script references validate;
- TypeScript completes with exit code 0 and no diagnostics;
- Pi loads the local configured ZOB extension offline and replies with `zob-harness-ok`;
- `npm pack --dry-run --json` lists the Pi manifest, extensions, prompts, skills, agents, examples, and validation scripts in the tarball.

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

## Common workflows

### Launch a tmux-backed Agent Factory team

Use an Agent Factory when the job needs multiple persistent roles rather than one transient assistant. The pattern is:

1. define a ZTeam manifest with parent-visible rooms and `bodyStored=false`;
2. prepare startup kickoff files so each agent begins with bounded instructions;
3. launch one Pi session per ZAgent through a tmux launcher when useful;
4. coordinate with async ZPeer/Goal Room-style messages using `CONTEXT / ASK / EVIDENCE / URGENCY / BLOCKER`;
5. treat artifacts, validation commands, and oracle review as completion evidence.

### Turn repeated work into a factory

When a process repeats, stop re-prompting it by hand. Capture the workflow as:

```text
manifest + team topology + kickoff templates + workgraph + checkpoints + validator + oracle gate
```

Then expose it through an npm script or project-local launcher so the next run starts from a known shape.

### Use a safe single-agent loop

```text
Explore -> Plan -> Implement -> Oracle
```

- **Explore** — inspect and map facts without editing.
- **Plan** — turn evidence into a bounded implementation path.
- **Implement** — change the smallest safe file set and verify it.
- **Oracle** — review skeptically and surface no-ship blockers.

### Delegate to a specialist

Use `/contract` to create a bounded six-part handoff, then route to the appropriate specialist agent. A good delegated result should return changed files, validation commands, evidence refs, risks, and no-ship status for parent/oracle review.

### Use goal-linked TODOs

Use `/goal`, `/todo`, and `/goal_gate` when work needs a parent-owned TODO graph. Child agents return claims; the parent decides acceptance. This prevents children from marking parent work done without review.

### Goal TODO ZPeer/ZTeam handoff (0.4.0)

Use `handoff_goal_todo`, `/goal todo handoff`, or `/todo handoff` to hand existing Goal TODOs to a live ZPeer/ZTeam member. Handoffs can be single TODOs or bounded batches to one receiver, require a maintainer-provided custom message, and use transient live delivery plus canonical Goal Room metadata.

Durable records stay hash-only (`bodyStored=false` with TODO refs, receiver refs, message/task/result hashes, and artifact refs). Handoff delivery, ACKs, or chat replies are not completion evidence: the receiver returns a claim or split/blocker request, and the parent/oracle accepts or rejects it before any TODO becomes done.

This release adds the handoff runtime/docs and `npm run smoke:goal-todo-handoff` validation. It does not auto-launch teams, auto-complete parent TODOs, or automate `npm publish`, versioning, tags, commits, or pushes.

### Use ProjectDNA context

ProjectDNA turns approved local code scan artifacts into bounded, cited context packs and sample/spec outputs. Keep scans approved, artifacts local, and writeback proposal-only unless the parent explicitly authorizes more.

### Use governed commits

ZOB does not encourage invisible git operations. When a user explicitly asks for a commit, agents must use `/zcommit` or the governed `zob_zcommit_run` tool and follow [`.pi/git-policy.json`](.pi/git-policy.json). Autocommit and autopush are off by default.

### Optional intent classifier

ZOB can optionally classify user intent with a small model before falling back to deterministic regex routing. The default config at [`.pi/routing/intent-classifier.json`](.pi/routing/intent-classifier.json) is disabled and local-only:

```json
{
  "enabled": false,
  "provider": "regex",
  "model": "lfm2.5:8b",
  "fallback": "regex",
  "sendUserTextToProvider": false
}
```

To experiment with Ollama Cloud, use the slash command after reloading the extension:

```text
/intent-classifier status
/intent-classifier regex
/intent-classifier model-strict --endpoint <ollama-cloud-chat-endpoint> --model lfm2.5:8b
/intent-classifier model-fallback --endpoint <ollama-cloud-chat-endpoint> --model lfm2.5:8b
/intent-classifier test launch multiple workers and an oracle
```

`model-strict` means no regex fallback: provider failures, invalid JSON, low confidence, or unknown intent return `unknown`. `model-fallback` tries the model first and then falls back to regex. Both model presets set `sendUserTextToProvider=true`; set `OLLAMA_API_KEY` in the environment and pass only `--api-key-env` if you use a non-default env var. The classifier suggests intent only; it never approves secrets, destructive commands, commits, deploys, session reads, or no-ship status.

## Command cheat sheet

Inside Pi:

- `/zmode` — switch between `explore`, `plan`, `implement`, `oracle`, `factory`, and `orchestrator`.
- `/stop` — abort current foreground work and local background activity without shutting down Pi.
- `/contract` — insert the six-part delegation template.
- `/agents` — list specialist agents.
- `/goal`, `/todo`, `/todos`, `/goal_gate` — manage goal-linked TODO work and scope anchors.
- `/compute` or `/effort` — preview/resolve compute profiles without bypassing safety gates.
- `/project-dna` — query or operate bounded ProjectDNA context workflows.
- `/intent-classifier` or `/intent` — configure/test regex, model-strict, or model-fallback intent routing.
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
npm run smoke:goal-todo-handoff    # Goal TODO ZPeer/ZTeam handoff static smoke
npm run smoke:intent-classifier    # optional model intent-classifier fallback smoke
npm run smoke:git-ops              # governed commit policy smoke
npm run smoke:worker-pool          # worker-pool static smoke
npm run smoke:zpeer                # static + local ZPeer smoke
npm run validate:project-dna       # ProjectDNA scaffold validation
npm run pack:dry-run               # npm package dry-run surface check
npm run demo:pacman:prepare        # prepare Pac-Man factory run artifacts
npm run demo:pacman:validate       # validate Pac-Man factory run artifacts
npm run demo:pacman                # launch the full Pac-Man Agent Factory demo
```

Published package install/check:

```bash
pi install npm:zob-harness@0.3.1
pi -e npm:zob-harness@0.3.1 --offline --no-session -p "Reply exactly: zob-harness-ok"
npm view zob-harness@0.3.1 version
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
- [`examples/`](examples/) — Agent Factory examples, including the generic tmux/coms playbook and the runnable Pac-Man multiplayer generative demo.
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

## Safety model

ZOB is deliberately conservative around risky actions:

- no `.env`, private key, SSH, AWS, or credential reads;
- no destructive shell/git operations without explicit approval;
- no direct commits, pushes, tags, or force pushes by default;
- governed commits go through `/zcommit` or `zob_zcommit_run` only when explicitly authorized;
- tmux is a launch/observation layer, not the source of truth;
- generated reports, ledgers, sessions, and local coordination state stay local;
- autonomy checks are supervised evidence, not a claim of unrestricted autonomy;
- completion requires concrete artifacts, validation evidence, and oracle/no-ship review when required.

The safety posture is backed by [AGENTS.md](AGENTS.md), [`.pi/damage-control-rules.json`](.pi/damage-control-rules.json), [`.pi/git-policy.json`](.pi/git-policy.json), the child-safety extension, and smoke scripts under [`scripts/`](scripts/README.md).

## Current status and limits

ZOB Harness is an early, conservative, governed harness. The public repo is useful for evaluating the Agent Factory operating model, extension wiring, skills, agents, safety posture, and smoke validations. It should not be described as unrestricted autonomy, a production deployment system, or a benchmark-winning agent framework.

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
npm view zob-harness@0.3.1 version || true
npm publish --dry-run
npm publish
npm view zob-harness@0.3.1 version
pi install npm:zob-harness@0.3.1
pi -e npm:zob-harness@0.3.1 --offline --no-session -p "Reply exactly: zob-harness-ok"
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
