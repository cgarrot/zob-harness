# Harness Intake Agent-Team Factory

Status: **P0 scaffold + working local CLI**.

This factory packages a natural-language-first workflow for analyzing another agent harness and producing quarantined ZOB team/factory proposals.

## What it does

- Accepts a natural-language request instead of requiring a hand-authored JSON manifest.
- Compiles the request into `inferred-run-spec.json`.
- Scans harness setup files read-only.
- Builds harness, skills, commands, prompt, session, and workflow profiles.
- Mines sessions only when explicit authorization is recorded.
- Generates team and factory proposals under `generated-proposals/`.
- Validates artifacts and writes oracle-style review metadata.
- Optionally launches a visible tmux team with run-scoped kickoff files.

## Safe entrypoints

```bash
npm run harness:intake -- "Analyze ../repo-x as a Claude Code setup and propose a ZOB team"
npm run harness:intake:smoke
npm run harness:intake:tmux -- start "Analyze ../repo-x with authorized sessions"
npm run harness:intake:validate -- <run_id>
```

## Output layout

```text
reports/factory-runs/<run-id>/
  request.md
  inferred-run-spec.json
  manifest.json
  agentic-plan.json
  artifact-contracts.json
  autonomous-status.md
  sources-index.json
  source-risk-report.json
  harness-profile.json
  skills-profile.json
  commands-profile.json
  prompt-patterns.json
  sessions-analysis.json
  session-evidence-index.json
  workflow-patterns.json
  workflow-patterns.md
  team-candidates.json
  factory-candidates.json
  generated-proposals/
  validation.json
  oracle-review.json
  DONE.sentinel
```

## Session policy

Sessions are valuable because they show real usage, but they are sensitive.

- No session files are read unless authorization is explicit in the request or CLI flags.
- Raw session bodies are not persisted.
- The session evidence index stores hashes, counts, metrics, and safe refs only.
- Session evidence alone cannot make a factory activation-ready.

## Tmux mode

Tmux mode is for visible, long-running team supervision:

```bash
npm run harness:intake:tmux -- start "Analyze ../repo-x as a Claude Code setup"
npm run harness:intake:tmux -- status <run_id>
npm run harness:intake:tmux -- attach <run_id> harness-intake-orchestrator
npm run harness:intake:tmux -- stop <run_id>
```

Tmux launch is not completion. Success still requires validation/oracle artifacts. The tmux dispatch proof records `startup_file_delivery: true`, `raw_prompt_transport_line_by_line: false`, and `post_start_tmux_paste_disabled: true` so the launcher can prove it used `pi @kickoff-file` instead of pasting prompts line by line.

## Activation policy

Generated teams/factories remain in quarantine. Activation requires separate owner review, validator pass, and oracle PASS/no_ship=false. This factory does not copy proposals into durable `.pi/agents`, `.pi/teams`, `.pi/skills`, or `.pi/factories` automatically.
