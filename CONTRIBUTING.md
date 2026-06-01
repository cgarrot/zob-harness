# Contributing to ZOB Harness

Thanks for helping improve ZOB Harness.

This project is a safety-first Pi harness. Contributions should preserve the operating model: explicit contracts, bounded changes, validation evidence, and no hidden side effects.

## Development setup

```bash
npm install
npm run check -- --pretty false
```

Start the harness locally:

```bash
npm run pi
```

## Contribution rules

- Keep changes small and reversible.
- Do not read or commit secrets, `.env` files, private keys, SSH/AWS material, or local credentials.
- Do not commit generated runtime artifacts from `reports/`, `.pi/sessions/`, `.pi/tmp/`, `.pi/logs/`, or local ledgers.
- Do not use direct `git commit`, `git push`, `git tag`, force push, `git add .`, or `git add -A` from agent workflows; use governed `/zcommit` only when explicitly requested or policy-authorized.
- Preserve public tool names, command names, output contract ids, sentinel names, artifact paths, and safety defaults unless the change explicitly targets those surfaces.
- For refactors, prefer split-only moves and prove no behavior drift.
- Include validation commands and results in the pull request.

## Recommended workflow

1. Explore the current behavior.
2. Plan the smallest safe change.
3. Implement only the bounded slice.
4. Run validation.
5. If a commit is authorized, load `.pi/skills/zob-commit/SKILL.md` and `.pi/git-policy.json`, run `/zcommit status` then `/zcommit plan`, and commit only owned files with a Conventional Commit message.
6. Document evidence and remaining risks.

Minimum validation before opening a PR:

```bash
npm run check -- --pretty false
```

For runtime, safety, delegation, factory, or output-contract changes, also run the relevant smoke/audit script when possible.

## Pull request checklist

- [ ] The change is scoped and explained.
- [ ] No generated reports, sessions, logs, private benchmark data, or local-only docs were committed.
- [ ] No secrets or credentials were read or committed.
- [ ] Validation commands and results are included.
- [ ] Any no-ship risk or incomplete evidence is called out clearly.
