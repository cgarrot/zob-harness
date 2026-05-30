# Scope du dossier

- Teams, orchestration profiles, chains et coms locales `.pi/coms`.
- Ce dossier gère les guards de topology et les messages hash-only.

# Invariants

- Préserver le topology guard et le blocage worker-to-worker.
- `chain_run` reste plan-only et read-only.
- Les coms restent hash-only: ne pas stocker les bodies de prompts ou outputs.
- Conserver la logique de status dérivé et le timeout max 5000ms pour await.

# Imports

- Peut importer types/constants/utils nécessaires depuis `src/**` avec suffixe `.js`.
- Interdit: importer depuis `index.ts`.
- Éviter dépendances runtime Pi directes; les tools runtime appellent ce domaine.

# Validation locale

- `npm run check -- --pretty false`.
- `npm run smoke:harness` après tout changement chains/coms/topology.
