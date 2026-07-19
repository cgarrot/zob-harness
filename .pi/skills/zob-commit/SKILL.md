---
name: zob-commit
description: Use when planning, reviewing, or executing governed ZOB commit/autocommit/autopush behavior through explicit /zcommit commands or the agent-executable zob_zcommit_run tool.
---
# ZOB Commit Skill

## Purpose

This skill defines the easy governed commit workflow for ZOB agents. The `/zcommit` runtime command and `zob_zcommit_run` tool prioritize quick, beautiful Conventional Commits over strict per-session ownership tracking: when the user explicitly asks for commit/push, the assistant should use `zob_zcommit_run` instead of asking the user to paste slash commands. Direct git commit/push/tag remains forbidden.

Baseline safety remains: do not commit, tag, or push unless the user explicitly asks or `/zcommit autocommit on` / `/zcommit autopush on` authorizes it for the current repo/session scope.

## Allowed command surface

Use only these explicit commands/tools. Do not invent aliases, shortcuts, shell fallbacks, or alternate command names.

- `/zcommit status [paths/globs...]`
- `/zcommit plan [paths/globs...]`
- `/zcommit adopt <paths...>`
- `/zcommit commit [paths/globs...]`
- `/zcommit push`
- `/zcommit autocommit on`
- `/zcommit autocommit off`
- `/zcommit autopush on`
- `/zcommit autopush off`
- `zob_zcommit_run` tool with `action=plan|commit|push|commit_and_push`

## Hard stops

- Do not run direct `git commit`, `git push`, `git tag`, force push, `git add .`, or `git add -A`.
- Do not commit secrets, credentials, generated runtime artifacts, local ledgers, sessions, logs, temporary files, vendor folders, or build outputs.
- Do not use `/zcommit adopt` for root/global/broad directory/wildcard adoption; it is an advanced metadata-only ownership hint and should not be needed in normal easy mode.
- Do not treat autocommit or autopush as enabled unless the corresponding `/zcommit ... on` toggle is active for the current repo/session scope.
- Do not push if autopush is off, the work is no-ship, the target branch/remote is not allowed, or the last commit was not created by `/zcommit commit`.

## Governed workflow

1. Load `.pi/git-policy.json` and this skill before any governed commit/push work.
2. If the user asks the assistant to commit and/or push, call `zob_zcommit_run`; do not answer with instructions for the user to run `/zcommit` manually.
3. Run `/zcommit status [paths/globs...]` or `/zcommit plan [paths/globs...]` when the human wants an interactive command, or `zob_zcommit_run action=plan` when the agent needs a plan without staging.
4. Normal easy mode does not require `/zcommit adopt`: `/zcommit plan` and `zob_zcommit_run` select all dirty workspace files that pass forbidden-path filtering. When you need “only these session files”, use `zob_zcommit_run scope=session_modified`, or pass explicit repo-relative files, directories, or globs directly to `/zcommit plan` and `/zcommit commit`.
5. Optionally run `/zcommit adopt <paths...>` only as an advanced metadata hint for strict/legacy flows; it remains metadata-only and does not stage.
6. `/zcommit plan [paths/globs...]` / `zob_zcommit_run action=plan` produces:
   - safe workspace dirty files selected for commit, optionally limited by the pathspecs;
   - forbidden paths excluded from commit;
   - advisory validation command/status;
   - Conventional Commit type/scope/subject/body plan;
   - push target if and only if push is requested or authorized.
7. `/zcommit commit [paths/globs...]` and `zob_zcommit_run action=commit|commit_and_push` stage only the selected safe paths with `git add -- <paths>`, never `git add .` or `git add -A`, then create the Conventional Commit. Advisory validation failures are recorded in the commit body instead of blocking easy-mode commit.
8. Run `/zcommit push` or `zob_zcommit_run action=push|commit_and_push` when push is explicitly requested, the branch/remote are allowed, the commit was created by the zcommit engine, HEAD still equals that commit, and there are no no-ship blockers. Push is not blocked by advisory validation by default.

## Exact handoff-bound commit receipt

A higher-level pack may require a commit to be bound to an immutable pre-commit candidate and authority. In that case `zob_zcommit_run` accepts the complete optional binding set:

- `handoff_candidate_hash` — full candidate SHA-256;
- `handoff_authority_hash` — full authority SHA-256;
- `handoff_expected_base_sha` — exact current pre-commit HEAD.

All three fields must be present together. The tool requires `action=commit`, `user_requested=true`, the exact current base HEAD, and no `push`/`commit_and_push`. Before commit, the tool proves the receipt directory is writable, repository-contained, non-symlinked, and ignored by Git. A successful commit writes a body-free receipt at `.pi/logs/zcommit-receipts/<committed-head>.json` and returns both its ref and serialized-file SHA-256. The receipt binds repository root, base/resulting HEADs, tree, branch, eligible path hashes, candidate/authority hashes, validation posture, actual commit execution, and `actualGitPushRun=false`. Do not handcraft or use a symlink for this receipt. A later domain-specific validator must resolve and independently verify it; the receipt alone grants no push, GitHub, merge, promotion, or deployment authority.

## Commit message standard

Use Conventional Commits:

```text
<type>(<scope>): <imperative summary>

<body with validation evidence and risk notes when useful>
```

Allowed default types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `build`, `perf`, `revert`.

Examples:

- `docs(commit): add governed zcommit policy`
- `fix(coms): preserve live delivery guard`

## Autocommit/autopush defaults

- `autocommit` defaults to `off`.
- `autopush` defaults to `off`.
- Turning autocommit on with `/zcommit autocommit on` authorizes the assistant to create an easy Conventional Commit automatically at assistant message end when safe workspace changes exist.
- Turning autopush on with `/zcommit autopush on` remains separate and requires autocommit to be on first.
- Autopush never implies force push, tag creation, or bypassing branch/remote/no-ship gates.

## Easy workspace file rule

A governed easy commit may include all dirty workspace files that pass forbidden-path filtering, or a narrower explicit subset when pathspecs are passed to `/zcommit plan` / `/zcommit commit`. Pathspecs can be repo-relative files, directories, or globs such as `.pi/skills/zob-*/SKILL.md`. The policy should exclude secrets, credentials, generated/runtime ledgers, sessions, logs, temporary files, vendor folders, and build outputs. `/zcommit commit` still stages explicit selected paths only; it never stages the entire workspace through `git add .` or `git add -A`.
