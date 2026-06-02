# ZOB Harness Scripts

This folder contains local validation, smoke, audit, and proof helpers.

## Public/reproducible script families

These script families are intended to be part of the normal tracked repo workflow:

- `scripts/autonomy/` — static/read-only autonomy readiness smokes.
- `scripts/compute-profile/` — compute profile policy and regression checks.
- `scripts/git-ops/` — governed `/zcommit` policy smokes.
- `scripts/goal-todo/` — Goal/TODO tree compatibility smokes.
- `scripts/model-catalog/` — local model catalog/economy validators.
- `scripts/package-surface/` — package.json script/file surface validation.
- `scripts/path-policy/` — path safety smoke checks.
- `scripts/project-dna/` — ProjectDNA scaffold/scan/query smoke helpers; canonical helpers are grouped in subfolders with top-level compatibility CLI shims.
- `scripts/worker-pool/` — worker-pool metadata/static checks.
- `scripts/start-pi.sh` — local Pi startup helper.

## Root smoke helpers

Some root-level `*.mjs` files are one-off or transitional smoke helpers. Root-level scripts are ignored by default unless explicitly unignored/tracked.

Public root-level helpers currently referenced by `package.json` are exact-file allowlisted in `.gitignore` and included in `package.json.files`:

- `scripts/zpeer-static-smoke.mjs`
- `scripts/zpeer-local-e2e-smoke.mjs`

Deferred/local root helpers (for example, transitional delegation proof scripts) stay out of the public npm script surface until they are intentionally promoted.

If a future `package.json` script references a root-level helper, that helper must either be tracked/unignored and added to `package.json.files`, or the npm script must be marked local-only/removed.

## Local-only / private benchmark scripts

The private benchmark scaffold is intentionally local-only and ignored:

- `scripts/coding-agent-benchmark/`

Do not expose these helpers through public `package.json` scripts or package files. Local benchmark operators can run private commands directly from their local checkout, but public/fresh-clone validation must not depend on this ignored scaffold unless the benchmark is sanitized and committed intentionally.

## Generated outputs

Scripts may write reports under `reports/`. Those outputs are generated evidence and are ignored by git.

## Validation baseline

Common safe checks:

```bash
npm run validate:script-surface
npm run check -- --pretty false
npm run smoke:harness
```

Run `npm run validate:script-surface` after changing `package.json` scripts, adding/removing script helper files, or changing `package.json.files`. It verifies package script file references exist, are not ignored, are tracked or visible as pending adds in the current patch, and are included in the package file surface.

Run additional domain-specific smokes only when their source files are present and the task requires them.
