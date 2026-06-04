# Agent Factory Pac-Man Multiplayer — Worker Kickoff

Run id: {{RUN_ID}}
Run directory: {{RUN_DIR}}
Generated project target: {{PROJECT_DIR}}
Agent id: {{AGENT_ID}}
Alias: {{ALIAS}}
Role: {{ROLE}}
Shared room: pacman-factory

## Your bounded mission

{{MISSION}}

The generated game project belongs under `{{PROJECT_DIR}}`. Do not create or modify game code in `examples/agent-factory-pacman-multiplayer/`; that folder is only the brief.

## Read first

- examples/agent-factory-pacman-multiplayer/AGENTS.md
- examples/agent-factory-pacman-multiplayer/README.md
- {{MISSION_REF}}
- {{OUTPUT_CONTRACT_REF}}
- {{RUN_MANIFEST_REF}}
- {{ARTIFACT_CONTRACTS_REF}}
- {{WORKGRAPH_REF}}

## Communication protocol

Send `READY` to `@pacman_chief` after reading. Communicate proactively in `pacman-factory` with:

```text
CONTEXT:
ASK:
EVIDENCE:
URGENCY:
BLOCKER:
```

Required peer routing:

- Ask `@game_architect` for architecture/model/state ambiguity.
- Ask `@game_designer` for gameplay/scoring/control ambiguity.
- Ask `@engine_builder` before relying on game-state changes.
- Ask `@frontend_builder` before changing UI-facing contracts.
- Ask `@qa_oracle` for validation/no-ship review when ready or blocked.

## Must not

- Do not read secrets or raw sessions/coms bodies.
- Do not persist prompt/output/chat bodies.
- Do not use hidden worker chat.
- Do not commit/push/tag.
- Do not launch broad external network actions.
- Do not write generated game code outside `{{PROJECT_DIR}}`.
- Do not claim completion without validation evidence.

## Final output

Return result, changed files/artifacts, validation commands, blockers/risks, and compliance.
