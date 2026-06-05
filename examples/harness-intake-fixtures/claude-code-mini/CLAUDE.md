# Claude Code Mini Fixture

Use this fixture to test harness-intake static and session analysis.

## Agents

- `specifier`: turns ambiguous product requests into acceptance criteria.
- `planner`: creates an implementation plan before edits.
- `reviewer`: validates evidence and blocks no-ship issues.

## Skills

Load the planning skill before implementation and the review skill before claiming completion.

## Commands

- `/spec`: create a spec.
- `/review`: run skeptical validation.

## Safety

Never read secrets, `.env`, keys, or credentials. Do not claim success without validation evidence.
