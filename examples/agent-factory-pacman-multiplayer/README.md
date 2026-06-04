# Agent Factory Pac-Man Multiplayer — generative demo brief

This folder is **not** the game. It is the brief used by a ZOB Agent Factory team.

Run artifacts are prepared under:

```text
reports/agent-factory-pacman-runs/<run_id>/
```

The agents must generate the actual Pac-Man multiplayer project under:

```text
reports/agent-factory-pacman-runs/<run_id>/project/
```

## What the team should generate

A local browser-playable Pac-Man-inspired multiplayer game:

- 2 to 4 local players by default;
- maze/grid movement, pellets, score, collisions, win/lose conditions;
- ghosts or hostile obstacles;
- deterministic game engine/state model with tests;
- browser UI using Canvas or DOM rendering;
- clear controls and README instructions;
- local-only by default, no external services.

The team may choose a small dependency-light stack, but it must validate whatever it generates.

## Communication and tmux guide

Before running the full demo, read [`../agent-factory-tmux-comms/`](../agent-factory-tmux-comms/) for the communication pattern:

- one parent-visible room;
- short `CONTEXT / ASK / EVIDENCE / URGENCY / BLOCKER` messages;
- startup kickoff files passed as `pi @file`;
- tmux as a local launcher/observer only;
- artifacts and validation as completion evidence.

## Safe dry run

Prepare run artifacts only; this does **not** launch tmux/Pi and does **not** generate the game:

```bash
RUN_ID="pacman-demo"
npm run demo:pacman:prepare -- "$RUN_ID" --force
npm run demo:pacman:validate -- "$RUN_ID"
```

## Full autonomous launch

This may launch multiple Pi sessions in tmux and consume model/API budget:

```bash
RUN_ID="pacman-demo"
npm run demo:pacman -- "$RUN_ID" --force
```

## Observe or stop the tmux team

```bash
bash .pi/zteams/agent-factory-pacman-multiplayer.tmux.sh status
bash .pi/zteams/agent-factory-pacman-multiplayer.tmux.sh attach agent-factory-pacman-chief
bash .pi/zteams/agent-factory-pacman-multiplayer.tmux.sh close
```

## Test the generated game

After agents finish, test the generated game from the reported project directory, typically:

```bash
cd reports/agent-factory-pacman-runs/$RUN_ID/project
npm install
npm run validate
npm run dev
```

## Important boundaries

- Do not generate game code in this `examples/` folder.
- Do not read secrets or raw session/coms bodies.
- Do not commit/push from the demo team.
- Treat tmux as a local launcher only; communication must stay parent-visible.
