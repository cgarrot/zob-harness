---
name: zob-file-read
description: Use when running, documenting, or reviewing the zob_read_full whole-file read tool, including context-window headroom gating, pagination fallback, and path/secret/body-free safety.
---

# ZOB File Read Skill

## When to use

- Loading a whole file in one call when the live context window has enough headroom and the file is large enough that paginated `read` would be tedious.
- Reviewing `zob_read_full` safety/gating (path/secret blocking, context budget, body-free telemetry).
- Documenting the `zob_read_full` tool in prompts, capability registry, or README.

## Decision model

`zob_read_full` returns the entire file in one call iff **all** of the following hold:

1. The path passes the shared file-tool preflight (secret/generated-path safety) shared with other file tools.
2. The path resolves to a readable regular file.
3. `byteSize <= hardCeiling`, where the hard ceiling defaults to 2 MB and is overridable via `max_bytes`.
4. When the context window is known, `estimatedTokens <= allowedTokens`, where
   `allowedTokens = min(availableTokens * (1 - safetyMargin/100), contextWindow * 0.5)`.

When the context window is **unknown**, the tool **OBSERVES** and returns content only if the file is under the hard byte ceiling (`full_read_pass` when served, otherwise blocked for size reasons).

When any condition fails, the tool **BLOCKS** and returns a `reason` code plus pagination guidance (use native `read` with `offset`/`limit`, or `zob_context_search`/`grep`) and **no file content**.

## Reason codes

- `full_read_pass` — served the whole file (context known and within budget).
- `context_unknown_fallback_pass` — served the whole file (context unknown, under hard ceiling only).
- `path_not_found` — path does not exist.
- `path_not_file` — path is not a regular file (directory, device, etc.).
- `path_secret_rejected` — path matched a secret-like pattern.
- `path_forbidden_generated` — path is a generated/vendor/session path.
- `path_not_readable` — path exists but is not readable.
- `inspection_failed` — stat/inspection of the path raised an error.
- `binary_not_supported` — file is non-utf8 (v1 supports utf8 only).
- `exceeds_context_budget` — estimated tokens exceed the allowed context headroom (context known).
- `exceeds_hard_ceiling` — byte size exceeds the hard ceiling / `max_bytes`.

## Safety rules

1. Never read secrets (`.env`, `~/.ssh`, `~/.aws`, `*.pem`, `*.key`); reject with `path_secret_rejected`.
2. Never read generated/vendor/session paths (`node_modules`, `dist`, `build`, `.pi/sessions`, `.pi/agent-sessions`); reject with `path_forbidden_generated`.
3. v1 is utf8 only; non-utf8 content is rejected with `binary_not_supported`.
4. Telemetry is body-free: detail payloads carry hashes/counts only (`bodyStored: false`); never echo or persist raw file bodies in telemetry.
5. On any block, return pagination guidance and no content; callers fall back to native `read` with `offset`/`limit` or `zob_context_search`/`grep`.
6. Prefer the native `read` tool for small files or paginated needs.
7. Do not bypass the shared file-tool preflight or any other safety gate.

## When NOT to use

- Small files (use the native `read` tool).
- Paginated needs (`offset`/`limit`).
- Binary files (v1 refuses with `binary_not_supported`).
- Secret-like or generated/vendor/session paths.

## zob_receive_full — whole long response in one call

`zob_receive_full` is the response-side counterpart to `zob_read_full`. Use it to pull a long **response/report** into context in one shot, only when the live context window has enough headroom.

### Sources (exactly one required)

- `run_id` (+ optional `run_type` ∈ factory|orchestration|chain, + optional `artifact`) — resolves to the run's **persisted report artifact** under `reports/factory-runs|orchestrations|chains/<runId>/` (default `final-report.md`). If `run_type` is omitted it is auto-detected by directory existence (factory, then orchestration, then chain).
- `path` — any repo response/artifact file.

### What it does NOT return

- Raw child agent output bodies are **not persisted** (the harness is body-free). `run_id` therefore returns the run's **report artifacts** (e.g. `final-report.md`, `agentic-results.json`), not the raw child response.

### Decision model

Identical to `zob_read_full`: returns content iff path/secret safety passes (lexical zero-access + realpath symlink check), the target is a readable utf8 file under the hard byte ceiling (2MB default, tighten-only via `max_bytes`), and (when the context window is known) estimated tokens fit the headroom. Otherwise blocks with recovery guidance and no content.

### Reason codes

Inherits all `zob_read_full` reason codes, plus: `run_id_unsafe`, `artifact_unsafe`, `run_not_found`, `artifact_not_found`, `source_required`, `ambiguous_source`.

### When NOT to use

- Small or targeted reads (use native `read` with offset/limit, `grep`, or `zob_context_search`).
- Pointing `path` at secrets or generated/vendor paths (`.env`, `~/.ssh`, `~/.aws`, `node_modules`, `dist`, `build`, `.pi/sessions`).
- Expecting raw child output for a `run_id` (not stored — read the run's report artifacts instead).
