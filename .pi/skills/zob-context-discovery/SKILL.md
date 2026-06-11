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
2. When ColGREP is installed and ready, exploratory or natural-language repo discovery MUST start with `zob_context_search`/ColGREP before broad grep/find. This includes prompts like “explore this repo”, “where is this mechanism?”, or “find the design/flow”.
3. If `zob_context_search` is not exposed in the current session/toolset but `bash` is available, use the compact local wrapper before broad grep: `npm run --silent zob:context:query -- --query "<natural language query>" --max-results 6 --max-context-lines 1`.
4. Do not treat missing native-tool exposure as permission to immediately use broad `rg`/`grep`; the wrapper is the ColGREP path for those sessions.
5. Reuse `zob_context_search`/ColGREP at context pivot points, not only once at startup: new subsystem/domain, ambiguous or broad file area, `fallback_status` suggesting narrower paths, repeated low-signal grep/find, unfamiliar code before edits, or unknown validation/test failure.
6. Use grep/find/read after semantic discovery for exact proof, known identifiers/strings, final citations, and line refs. If the exact identifier/path/string is already known, grep/read may be used directly.
7. When ColGREP is missing, unavailable, or not indexed, fall back to grep/find/read. Missing ColGREP is not a blocker for normal ZOB work.
8. Do not auto-install ColGREP, run network/package-manager installer commands, or mutate user tooling without explicit owner approval.
9. Keep search bounded to repo-local allowed paths and task-relevant globs.
10. Never run broad grep/find over `.pi` unless `.pi/sessions` and `.pi/agent-sessions` are explicitly excluded/pruned.
11. Never read forbidden paths or secret-like files, including `.env`, `**/.env`, `**/*secret*`, `**/*key*`, private keys, `.pi/sessions`, `.pi/agent-sessions`, `node_modules`, `dist`, or `build`.
12. Persist only safe metadata/artifact refs for context packs. Do not persist raw secret/session bodies.

## User setup and scripts

- `npm run zob:context:doctor` checks the active backend, reports config/status, and prints install/setup guidance without installing anything.
- `npm run zob:context:init` may initialize safe ColGREP settings/indexing only when ColGREP is already installed and the owner runs it deliberately.
- `npm run zob:context:query -- <query>` runs a one-shot context query, preferring ColGREP when ready and using grep fallback otherwise.
- `npm run smoke:context-discovery` validates deterministic fallback behavior and should pass even when ColGREP is absent.

## Prompt injection posture

- Active-backend prompt injection is controlled by `.pi/context-discovery.json` under `promptInjection.enabled`.
- The injected block must stay concise, current-repo scoped, and bounded by the configured include/exclude roots; it is a discovery hint, not a context pack or evidence source.
- Do not inject stale/global context or raw search results into the prompt. Use `zob_context_search` or the compact `npm run --silent zob:context:query` wrapper, then read exact files when details are needed.

## UX / performance posture

- Native `zob_context_search` execution must remain async/non-blocking from the Pi extension perspective; avoid synchronous long-running ColGREP calls in tool handlers.
- Default discovery output should be compact: a small set of refs/previews, then read exact files. Do not dump raw ColGREP JSON or code bodies into the chat by default.

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
