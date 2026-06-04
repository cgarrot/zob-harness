# Generic Agent Factory with tmux and visible coms

This is a **documentation example** for a small local Agent Factory. It is intentionally generic and inert until a human explicitly runs the launcher.

The example shows how to package a repeatable multi-agent workflow around four local Pi/ZOB sessions:

| Agent | Role | Default posture |
| --- | --- | --- |
| `factory-chief` | owner-facing coordinator, workgraph owner, final synthesis | orchestrator |
| `context-scout` | read-only context finder and evidence mapper | explore |
| `builder` | bounded implementation or artifact producer | implement |
| `oracle` | skeptical reviewer and no-ship gate | oracle |

## What this demonstrates

A ZOB Agent Factory is more than a script that starts agents. It defines:

1. **Team topology** — one parent-visible `control` room, explicit aliases, no hidden worker chat.
2. **Manual launch surface** — tmux creates one local window per ZAgent only when the owner runs `start`.
3. **Startup kickoffs** — agents should receive bounded startup files such as `pi @chief-kickoff.md`, not unreliable post-start paste blobs.
4. **Communication protocol** — agents coordinate with short async messages and safe evidence refs.
5. **Evidence gates** — work is not complete until artifacts, validation, and oracle/no-ship status are visible.

## Files

```text
examples/agent-factory-tmux-comms/
  README.md                         # this guide
  simple-agent-factory.team.json    # example ZTeam-style topology
  simple-agent-factory.tmux.sh      # manual local tmux launcher
  chief-kickoff.template.md         # chief startup kickoff template
  worker-kickoff.template.md        # worker startup kickoff template
```

These files are examples, not active project-local ZAgent definitions. A real project should copy/adapt the topology into `.pi/zagents/`, `.pi/zagents/prompts/`, and `.pi/zteams/` after owner review.

For an active automatic example that applies this pattern end-to-end, see [`../agent-factory-pacman-multiplayer/`](../agent-factory-pacman-multiplayer/). That demo prepares run-scoped kickoff files and can launch a six-agent tmux-backed team with `npm run demo:pacman`.

## Communication shape

All cross-agent asks should be short, actionable, and parent-visible:

```text
CONTEXT: what changed or what you are working on
ASK: exact answer/review/action needed
EVIDENCE: safe file refs, artifact refs, command names, or TODO ids
URGENCY: low|normal|high|critical
BLOCKER: yes/no
```

Example ask from `factory-chief` to `context-scout`:

```text
CONTEXT: We are preparing the first implementation slice for the widget settings workflow.
ASK: Identify the smallest source files and docs needed for a safe plan; return evidence refs only.
EVIDENCE: README.md, docs/widget-settings.md, TODO WIDGET-001
URGENCY: normal
BLOCKER: no
```

Example blocker from `builder` to `factory-chief`:

```text
CONTEXT: The implementation slice requires editing a path outside my assigned scope.
ASK: Approve a split or reassign ownership before I continue.
EVIDENCE: workgraph.md#slice-3, planned path src/settings/persistence.ts
URGENCY: high
BLOCKER: yes
```

## Manual launcher usage

Inspect the team without launching sessions:

```bash
bash examples/agent-factory-tmux-comms/simple-agent-factory.tmux.sh list
```

Show tmux status:

```bash
bash examples/agent-factory-tmux-comms/simple-agent-factory.tmux.sh status
```

Start all windows only when you intentionally want local Pi sessions:

```bash
bash examples/agent-factory-tmux-comms/simple-agent-factory.tmux.sh start factory-chief
```

Attach to a specific window:

```bash
bash examples/agent-factory-tmux-comms/simple-agent-factory.tmux.sh attach builder
```

Close only this example session:

```bash
bash examples/agent-factory-tmux-comms/simple-agent-factory.tmux.sh close
```

## Startup kickoff pattern

For a real factory run, render the templates into a run directory such as:

```text
reports/agent-factory-runs/<run_id>/
  run-manifest.json
  chief-kickoff.md
  worker-kickoffs/context-scout-kickoff.md
  worker-kickoffs/builder-kickoff.md
  worker-kickoffs/oracle-kickoff.md
  autonomous-workgraph.md
  autonomous-status.md
  iteration-log.md
  kickoff-dispatch.json
```

Then start the launcher with environment variables pointing at the rendered files:

```bash
AGENT_FACTORY_RUN_ID=my-run \
AGENT_FACTORY_CHIEF_KICKOFF_FILE=reports/agent-factory-runs/my-run/chief-kickoff.md \
AGENT_FACTORY_WORKER_KICKOFF_DIR=reports/agent-factory-runs/my-run/worker-kickoffs \
bash examples/agent-factory-tmux-comms/simple-agent-factory.tmux.sh start factory-chief
```

The launcher passes startup files as `pi @<file>`. It does **not** paste large prompts into already-running tmux panes.

## Limits and no-ship rules

This pattern is local and supervised:

- Tmux is a launch/observation convenience, not the source of truth.
- ZPeer/Goal Room-style messages are for coordination; artifacts are durable evidence.
- Do not persist raw prompt/output/chat bodies in ledgers or reports.
- Do not use hidden worker-to-worker rooms for decisions.
- Do not treat stale/offline/no-ack peers as success.
- Do not read secrets or inject credentials into kickoff files.
- Do not commit/push or run destructive commands without explicit governed approval.
- Do not claim completion without validation evidence and oracle/no-ship review when required.

## How this relates to real projects

SaPilot and ProjectDNA Lab have richer versions of this pattern: run manifests, generated run-scoped teams, startup kickoff files, detached tmux sessions, status/workgraph artifacts, and oracle gates. This example keeps the same principles but reduces them to the smallest teaching shape for ZOB itself.
