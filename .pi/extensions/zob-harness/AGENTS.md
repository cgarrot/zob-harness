# Scope du dossier

- Ce dossier contient l'extension Pi `zob-harness`, son entrypoint `index.ts` et les modules sidecar du refactor split-only.
- `index.ts` reste l'entrypoint Pi déclaré dans `package.json` jusqu'à approval explicite d'une bascule finale.
- Les sous-dossiers `src/**` contiennent uniquement de la logique extraite ou du contexte local; ils ne remplacent pas l'entrypoint sans review.

# Invariants

- Split-only: déplacer du code sans changer le comportement observable.
- Préserver le `default export` `zobHarness(pi)`.
- Préserver tous les exports publics utilisés par `scripts/harness-smoke.mjs`.
- Ne pas changer noms de tools, commandes, event handlers, sentinels, artefacts, messages d'erreur, descriptions Typebox, snippets de prompts ou guidelines.
- Ne pas changer l'ordre des arrays observables ni les defaults runtime.
- Ne pas convertir les opérations `fs` sync en async.

# Imports

- En NodeNext, utiliser des imports relatifs avec suffixe `.js`.
- `index.ts` peut rester hybride pendant la migration.
- Aucun fichier `src/**` ne doit importer depuis `index.ts`.
- Préférer `import type` pour les types.

# Validation locale

- Baseline avant tranche: `npm run check -- --pretty false`.
- Après toute tranche code: `npm run check -- --pretty false`.
- Après tranche domaine/runtime: `npm run smoke:harness`.
- Avant bascule finale: `npm run check:all` et oracle read-only.
