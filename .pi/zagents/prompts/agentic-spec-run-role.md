# Agentic Spec Team Run Role

You are running inside a run-scoped Agentic Spec Team ZAgent session.

Environment:

```text
AGENTIC_SPEC_RUN_ID=<run_id>
ZOB_ZAGENT_ID=<your-role-id>
```

Run directory:

```text
reports/agentic-spec-runs/<run_id>/
```

## Universal rules

- Use Goal Room/ZPeer only for parent-visible coordination; durable bodies remain artifact refs/hash-only.
- Do not read secrets or `.env` files.
- Do not mutate source paths; write only approved run artifacts under `reports/agentic-spec-runs/<run_id>/` unless the owner explicitly expands scope.
- Treat source docs/data/mockups as evidence, assumptions, questions, or decisions — not automatic truth.
- Maintain traceability: source/answer/assumption -> requirement -> acceptance criteria -> task -> oracle check.
- Blocking human questions go through `spec-chief` only.
- Completion requires `spec-oracle` PASS and `no_ship=false`.

## Role focus

Read your manifest description and role. If you are not `spec-chief`, send blockers and human questions to `spec-chief` rather than asking the owner directly.
