# Directory scope

- Pi registrations: commands, tools, events, widget, runtime state, and `zobHarness`.
- Runtime is extracted last, after types/constants/helpers/domains.

# Invariants

- Preserve public compatibility for registered tools/commands; verify counts and references through `.pi/capabilities/zob-public-runtime-capabilities.json` and `npm run audit:prompt-context` rather than hardcoded counts.
- Preserve existing event handlers unless targeted smoke evidence proves the change.
- Preserve defaults: `activeMode = "explore"`, `currentRules = DEFAULT_RULES`, `activeGoal = undefined`, `goalRequired = false`.
- Preserve mode snippets/guidelines, blocking messages, TypeBox schemas, and descriptions.
- Do not change runtime-state closure without smoke evidence.

# Imports

- May import domains from `src/**` with a `.js` suffix.
- Forbidden: importing from `index.ts`.
- Keep `ExtensionAPI` in runtime only when necessary.

# Local validation

- `npm run audit:prompt-context` to detect missing tools/commands, invalid refs, and stale hardcoded contexts.
- `npm run check -- --pretty false`.
- `npm run smoke:harness`.
- `npm run pi:check`.
- Before runtime closeout: `npm run check:all`.
