# Scope du dossier

- Registrations Pi: commands, tools, events, widget, runtime state et `zobHarness`.
- Runtime est extrait en dernier, après types/constants/helpers/domaines.

# Invariants

- Préserver la compatibilité publique des tools/commandes enregistrés; vérifier les comptes et références via `.pi/capabilities/zob-public-runtime-capabilities.json` et `npm run audit:prompt-context` plutôt que des nombres hardcodés.
- Préserver les event handlers existants sauf preuve smoke ciblée.
- Préserver defaults: `activeMode = "explore"`, `currentRules = DEFAULT_RULES`, `activeGoal = undefined`, `goalRequired = false`.
- Préserver snippets/guidelines de modes, messages bloquants, schemas Typebox et descriptions.
- Ne pas changer la fermeture d'état runtime sans preuve smoke.

# Imports

- Peut importer domaines `src/**` avec suffixe `.js`.
- Interdit: importer depuis `index.ts`.
- Garder `ExtensionAPI` dans runtime uniquement lorsque nécessaire.

# Validation locale

- `npm run audit:prompt-context` pour détecter les tools/commandes manquants, refs invalides et vieux contextes hardcodés.
- `npm run check -- --pretty false`.
- `npm run smoke:harness`.
- `npm run pi:check`.
- Avant close runtime: `npm run check:all`.
