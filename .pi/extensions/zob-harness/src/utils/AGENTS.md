# Scope du dossier

- Helpers purs et réutilisables: records, paths, JSON, hashing, formatting.
- Ce dossier ne doit pas contenir de logique Pi runtime, tools, commands, factories ou orchestration.

# Invariants

- Préserver les messages d'erreur, règles de sanitization, hashing et path matching.
- Ne pas modifier `pathMatches`, `safeRunId`, `safeFileStem`, ou la logique de bornage d'output.
- Garder les helpers déterministes sauf si la source ne l'était pas.

# Imports

- Autorisé: modules Node minimaux nécessaires (`node:fs`, `node:path`, `node:crypto`, `node:os`) selon le helper.
- Interdit: `ExtensionAPI`, runtime Pi, tools, commands, factories, orchestration.
- Interdit: importer depuis `index.ts`.
- Utiliser `.js` pour les imports relatifs.

# Validation locale

- `npm run check -- --pretty false`.
- Si `pathMatches` ou formatting child output bouge: `npm run smoke:harness`.
