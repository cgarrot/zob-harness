# Models domain guardrail

## Scope

- Model routing, model availability validation, model catalog/economy helpers.

## MUST DO

- Preserve explicit model override validation and configured/runtime availability distinctions.
- Keep budget and routing decisions evidence-backed.

## MUST NOT

- Do not treat desired/configured/catalogued models as runtime availability proof.
- Do not import from `index.ts` or `index.js`.

## Validation

- `npm run check -- --pretty false`.
- Run model catalog validation scripts when model policy files or helpers move.
