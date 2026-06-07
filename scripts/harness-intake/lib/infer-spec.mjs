import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { repoRel, safeRunId, sha256, timestamp } from "./cli-io.mjs";
import { DEFAULT_FORBIDDEN, MAX_FILE_BYTES, MAX_SCAN_FILES, MAX_SESSION_FILES, SCHEMA_PREFIX, repoRoot } from "./constants.mjs";

export function inferRunSpecFromRequest(request, opts = {}) {
  const rawRequest = String(request || opts.request || "").trim();
  if (!rawRequest && !opts.demo && !opts.self && !opts.target && !opts.path) {
    throw new Error("missing natural-language request or --target/--path");
  }

  const runId = safeRunId(opts.runId || `harness-intake-${timestamp()}`);
  const targetInput = opts.target || opts.path || (opts.demo ? "examples/agent-factory-tmux-comms" : opts.self ? "." : extractPathLike(rawRequest));
  if (!targetInput) throw new Error("could not infer target path; pass --target <path> or mention a path in the request");
  const target = resolveTargetPath(targetInput, { allowRepoRoot: Boolean(opts.allowRepoRoot || opts.self) });
  const requestLower = rawRequest.toLowerCase();
  const harnessHint = opts.harness || inferHarnessHint(rawRequest, targetInput);
  const sessionMentioned = /\b(session|sessions|conversation|conversations|transcript|transcripts|history)\b/i.test(rawRequest) || opts.sessionPath?.length > 0;
  const explicitAllowSessions = Boolean(
    opts.allowSessions ||
      ["yes", "true", "allow", "allowed", "authorized"].includes(String(opts.sessions || "").toLowerCase()) ||
      /\b(you may read|authorized sessions?|allow sessions|read sessions)\b/i.test(rawRequest)
  );
  const sessionMode = explicitAllowSessions ? "authorized" : sessionMentioned ? "needs_authorization" : "disabled";
  const sessionPaths = explicitAllowSessions ? resolveSessionPaths(target, opts.sessionPath ?? []) : [];
  const goal = inferGoal(rawRequest);
  const mode = opts.mode || inferMode(rawRequest);
  const createdAt = new Date().toISOString();
  return {
    schema: `${SCHEMA_PREFIX}.inferred-run-spec.v1`,
    run_id: runId,
    created_at: createdAt,
    request: rawRequest || `Analyze ${targetInput}`,
    request_hash: sha256(rawRequest || `Analyze ${targetInput}`),
    target: {
      input: targetInput,
      path: target,
      repo_relative: isInside(repoRoot, target) ? repoRel(target) : null,
      broad_root_allowed: Boolean(opts.allowRepoRoot || opts.self),
    },
    harness_hint: harnessHint,
    mode,
    goal,
    sessions: {
      mentioned: sessionMentioned,
      mode: sessionMode,
      authorized: explicitAllowSessions,
      authorization_source: explicitAllowSessions ? (opts.allowSessions ? "flag" : "natural_request") : null,
      paths: sessionPaths,
      skipped_reason: sessionMentioned && !explicitAllowSessions ? "session analysis requires explicit authorization; rerun with --allow-sessions or say that sessions are authorized" : null,
    },
    output_policy: {
      quarantine_only: true,
      activation_enabled: false,
      raw_session_body_persisted: false,
      source_project_modified: false,
    },
    safety: {
      forbidden_patterns: DEFAULT_FORBIDDEN,
      max_file_bytes: MAX_FILE_BYTES,
      max_scan_files: MAX_SCAN_FILES,
      max_session_files: MAX_SESSION_FILES,
    },
  };
}

export function inferMode(request) {
  const lower = request.toLowerCase();
  if (/\bbatch\b/.test(lower)) return "batch";
  if (/\bpilot\b/.test(lower)) return "pilot";
  if (/\bdeep|complete|xhigh|max\b/.test(lower)) return "smoke-deep";
  return "smoke";
}

export function inferGoal(request) {
  const lower = request.toLowerCase();
  if (/factory|factories|factor/i.test(lower)) return "propose-zob-team-and-factory";
  if (/team|agents? team/i.test(lower)) return "propose-zob-team";
  return "analyze-harness";
}

export function inferHarnessHint(request, targetInput) {
  const value = `${request} ${targetInput}`.toLowerCase();
  if (value.includes("claude")) return "claude-code";
  if (value.includes("codex")) return "codex";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("aider")) return "aider";
  if (value.includes("pi") || value.includes("zob")) return "pi-zob";
  return "unknown";
}

export function extractPathLike(request) {
  const tokens = String(request || "").match(/(?:\.\.?|~|\/)?[A-Za-z0-9_./@:-]+/g) ?? [];
  const stop = new Set(["analyze", "setup", "claude", "codex", "cursor", "aider", "team", "factory", "sessions", "project"]);
  for (const token of tokens) {
    if (stop.has(token.toLowerCase())) continue;
    if (token.includes("/") || token.startsWith(".") || token.startsWith("~")) return token.replace(/[,.]$/u, "");
  }
  return null;
}

export function resolveTargetPath(input, opts = {}) {
  const expanded = String(input).startsWith("~/") ? join(process.env.HOME || "", String(input).slice(2)) : String(input);
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(repoRoot, expanded);
  if (!existsSync(resolved)) throw new Error(`target path does not exist: ${input}`);
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`target must be a directory: ${input}`);
  const forbiddenBroad = new Set(["/", "/home", "/Users"]);
  if (forbiddenBroad.has(resolved)) throw new Error(`refusing broad target path: ${resolved}`);
  if (!opts.allowRepoRoot && resolved === repoRoot) throw new Error("refusing repo root target without --self or --allow-repo-root");
  return resolved;
}

export function resolveSessionPaths(target, explicitPaths) {
  const candidates = explicitPaths.length ? explicitPaths : [".claude/sessions", ".codex/sessions", ".cursor/sessions", "sessions", "transcripts", ".sessions"];
  const out = [];
  for (const candidate of candidates) {
    const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(target, candidate);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) out.push(resolved);
  }
  return [...new Set(out)];
}

export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
