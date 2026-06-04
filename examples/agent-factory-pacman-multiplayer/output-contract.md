# Output contract — generated Pac-Man Multiplayer project

Generated project target:

```text
reports/agent-factory-pacman-runs/<run_id>/project/
```

## Required generated structure

The team may refine details, but the final project should include equivalent artifacts:

```text
project/
  README.md
  AGENTS.md
  package.json
  src/
    game/
      engine.ts
      types.ts
    ui/
      main.ts
      renderer.ts
      input.ts
    styles.css
  test/
    engine.test.ts
    collisions.test.ts
    scoring.test.ts
  docs/
    architecture.md
    controls.md
    validation.md
```

## Required behavior

- 2 to 4 players can play locally.
- Movement, walls, pellets, score, collisions and round end are implemented.
- Controls are visible and documented.
- The game can be launched locally with documented commands.

## Required validation

- `npm run validate` or equivalent.
- Tests for engine logic.
- Static/type/build check if the generated stack supports it.
- QA/oracle verdict with `NO_SHIP: false` before claiming done.

## No-ship blockers

- Game code generated outside the run `project/` directory.
- No playable browser UI.
- No multiplayer behavior.
- Missing engine tests.
- External service dependency required for basic play.
- Hidden/raw transcript persistence or secret access.
