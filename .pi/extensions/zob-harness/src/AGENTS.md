# Scope du dossier

- `src/**` reçoit les modules extraits de `.pi/extensions/zob-harness/index.ts`.
- Chaque module doit correspondre à une tranche claire du playbook de refactor.
- Ce dossier ne contient pas de nouvelle fonctionnalité produit.

# Invariants

- Move-only: conserver logique, strings, validations, defaults et ordre observable.
- Les exports publics doivent rester disponibles depuis `index.ts` jusqu'à la bascule finale.
- Éviter les cycles; isoler types, constantes et utils avant runtime.
- Ne pas stocker de prompt/output bodies dans telemetry/coms.

# Imports

- Imports relatifs NodeNext avec suffixe `.js` pour les imports runtime.
- `import type` pour les types.
- Interdit: importer depuis `../index.js`, `../../index.js` ou `index.ts`.
- Les modules bas niveau ne doivent pas dépendre de runtime Pi.

# Validation locale

- `npm run check -- --pretty false` après chaque tranche.
- `npm run smoke:harness` après safety, output-contracts, queue, topology, orchestration, factory, child-runner ou runtime.
- Oracle read-only avant de passer à la tranche suivante si une API publique est touchée.
