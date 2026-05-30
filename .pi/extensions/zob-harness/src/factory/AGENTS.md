# Scope du dossier

- Validation factory, plan agentic, exécution factory et quarantine review/activate/verify.
- Ce dossier ne doit pas enregistrer de Pi tools directement; le runtime délègue ici.

# Invariants

- Préserver `SMOKE_PASSED.sentinel`, `PILOT_PASSED.sentinel`, `BATCH_PASSED.sentinel`, `DONE.sentinel`.
- `plan_only` ne crée pas de sentinels de complétion.
- Pilot exige une review oracle persistée et un manifest multi-item.
- Factory-forge quarantine ne s'auto-active jamais.
- Activation refuse overwrite et exige phrase exacte.
- Ne pas changer noms d'artefacts, statuts ou validations.

# Imports

- Peut importer utils/safety/output-contracts/telemetry/child-runner selon besoin.
- Interdit: importer depuis `index.ts`.
- Imports relatifs runtime avec suffixe `.js`.

# Validation locale

- `npm run check -- --pretty false`.
- `npm run smoke:harness` après toute tranche factory/quarantine.
