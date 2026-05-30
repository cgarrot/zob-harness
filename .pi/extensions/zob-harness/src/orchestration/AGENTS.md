# Scope du dossier

- Orchestration plan-only, supervised smoke/read-only, room artifacts et widget readers.
- Ce dossier ne contient pas de registrations Pi; le runtime expose les tools.

# Invariants

- `plan_only` ne doit jamais écrire `DONE.sentinel`.
- `supervised_smoke` ne lance aucun child live.
- `supervised_readonly` reste parent-owned et read-only.
- Les plans redacted et mirror `.pi/coms` doivent rester identiques.
- Préserver noms d'artefacts, statuts et messages d'erreur.

# Imports

- Peut importer topology, safety, output-contracts, telemetry, child-runner selon besoin.
- Interdit: importer depuis `index.ts`.
- Imports relatifs runtime avec suffixe `.js`.

# Validation locale

- `npm run check -- --pretty false`.
- `npm run smoke:harness` après toute tranche orchestration.
