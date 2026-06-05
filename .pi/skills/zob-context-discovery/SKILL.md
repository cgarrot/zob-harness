---
name: zob-context-discovery
description: Use when running, documenting, or reviewing adaptive active search backend context discovery, including zob_context_search, optional ColGREP setup, and grep/find/read fallback behavior.
---
# ZOB Context Discovery Skill

## When to use

Use this skill for:
- `zob_context_search` and `zob_context_*` discovery workflows.
- Active search backend guidance in prompts, docs, or registry entries.
- Optional ColGREP setup/doctor/query UX.
- Reviews of context discovery safety, bounded search output, and exact evidence refs.

## Active backend rules

1. Prefer `zob_context_search` for repo-local discovery when the runtime tool is available.
2. When ColGREP is installed and ready, use it as the preferred broad/semantic discovery backend.
3. Always use grep/find/read or exact file refs for verification before making claims.
4. When ColGREP is missing, unavailable, or not indexed, fall back to grep/find/read. Missing ColGREP is not a blocker for normal ZOB work.
5. Do not auto-install ColGREP, run network/package-manager installer commands, or mutate user tooling without explicit owner approval.
6. Keep search bounded to repo-local allowed paths and task-relevant globs.
7. Never read forbidden paths or secret-like files, including `.env`, `**/.env`, `**/*secret*`, `**/*key*`, private keys, `.pi/sessions`, `.pi/agent-sessions`, `node_modules`, `dist`, or `build`.
8. Persist only safe metadata/artifact refs for context packs. Do not persist raw secret/session bodies.

## User setup and scripts

- `npm run zob:context:doctor` checks the active backend, reports config/status, and prints install/setup guidance without installing anything.
- `npm run zob:context:init` may initialize safe ColGREP settings/indexing only when ColGREP is already installed and the owner runs it deliberately.
- `npm run zob:context:query -- <query>` runs a one-shot context query, preferring ColGREP when ready and using grep fallback otherwise.
- `npm run smoke:context-discovery` validates deterministic fallback behavior and should pass even when ColGREP is absent.

## Prompt injection posture

- Active-backend prompt injection is controlled by `.pi/context-discovery.json` under `promptInjection.enabled`.
- The injected block must stay concise, current-repo scoped, and bounded by the configured include/exclude roots; it is a discovery hint, not a context pack or evidence source.
- Do not inject stale/global context or raw search results into the prompt. Use `zob_context_search` and then read exact files when details are needed.

## Evidence expectations

- Cite repo-relative paths and line refs when available.
- Treat semantic/broad search hits as leads until exact grep/read verification confirms the behavior.
- Include provider/fallback metadata in readiness claims when relevant.
- If context discovery cannot search a required path because of scope or forbidden-path policy, report a blocker instead of broadening silently.

## Oracle / no-ship criteria

No-ship for context discovery if any of these remain true:
- forbidden sources or secret/session/vendor/build paths are read, indexed intentionally, or returned as results;
- ColGREP setup requires unapproved network/package-manager/installer commands;
- missing ColGREP blocks normal ZOB operation instead of using fallback;
- dynamic prompt injection includes stale/global context, raw search bodies, or unbounded output;
- implementation claims rely on semantic hits without exact grep/read/file-ref verification;
- context freshness or citation coverage cannot be shown for files used as evidence.
