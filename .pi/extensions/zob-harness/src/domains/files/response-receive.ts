/**
 * response-receive.ts — context-window-aware "receive a long response in one
 * call" logic for the future `zob_receive_full` tool.
 *
 * Two sources:
 *   1. `run_id` resolves a run's persisted report artifact under
 *      `reports/factory-runs|orchestrations|chains/<runId>/`.
 *   2. `path` is any repo response file.
 *
 * Both reuse the EXISTING `runFullRead` decision from `./full-read.js` (context
 * budget + path/secret safety incl. the realpath symlink check). This module
 * only adds source resolution + wrapping; all decision/budget math stays in
 * `full-read.ts`. Telemetry is body-free: `ResponseReceiveDetails` never
 * carries file content — `bodyStored` is always `false`.
 *
 * NodeNext imports use `.js` specifiers; the runtime loader resolves them to
 * the compiled/transpiled source.
 */
import { join, resolve } from "node:path";

import { sha256Hex } from "../../core/utils/hashing.js";
import {
  runFullRead,
  type FullReadContextUsage,
  type FullReadDecision,
  type FullReadDetails,
  type FullReadIo,
  type FullReadPolicy,
  type FullReadReasonCode,
  type FullReadRunResult,
} from "./full-read.js";

export const RESPONSE_RECEIVE_SCHEMA = "zob.response-receive.v1";

export type ResponseReceiveSource = "path" | "run";

export type ResponseReceiveRunType = "factory" | "orchestration" | "chain";

export type ResponseReceiveReasonCode =
  | FullReadReasonCode
  | "run_id_unsafe"
  | "artifact_unsafe"
  | "run_not_found"
  | "artifact_not_found"
  | "source_required"
  | "ambiguous_source";

export interface ResponseReceiveDetails {
  schema: typeof RESPONSE_RECEIVE_SCHEMA;
  source: ResponseReceiveSource;
  runType?: ResponseReceiveRunType;
  runId?: string;
  artifact?: string;
  decision: FullReadDecision;
  reasonCode: ResponseReceiveReasonCode;
  pathHash: string;
  byteSize: number;
  lineCount: number;
  estimatedTokens: number;
  contextWindow?: number;
  contextTokensBefore?: number;
  availableTokens?: number;
  allowedTokens?: number;
  safetyMarginPercent: number;
  maxAllowedContextFraction: number;
  hardCeilingBytes: number;
  maxBytesOverride?: number;
  contextKnown: boolean;
  bodyStored: false;
}

export interface ResponseReceiveInput {
  cwd: string;
  path?: string;
  runId?: string;
  runType?: ResponseReceiveRunType;
  artifact?: string;
  maxBytesOverride?: number;
  usage: FullReadContextUsage;
  policy: FullReadPolicy;
  io: FullReadIo;
  estimateTokens: (text: string) => number;
}

export interface ResponseReceiveResult {
  decision: FullReadDecision;
  reasonCode: ResponseReceiveReasonCode;
  content?: string;
  details: ResponseReceiveDetails;
}

export const RUN_ARTIFACT_DIRS: Record<ResponseReceiveRunType, string> = {
  factory: "reports/factory-runs",
  orchestration: "reports/orchestrations",
  chain: "reports/chains",
};

export const DEFAULT_RUN_ARTIFACT = "final-report.md";

const AUTO_DETECT_RUN_TYPES: ResponseReceiveRunType[] = ["factory", "orchestration", "chain"];

/**
 * A run id must be a flat, traversal-safe token. Mirrors the path-safe run_id
 * guard used by the goal runtime import source refs.
 */
export function isPathSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId) && runId !== "." && runId !== "..";
}

/**
 * An artifact must be a single basename: non-empty, no path separators, no
 * parent traversal, and only path-safe characters. Prevents traversal before
 * any resolution or read.
 */
export function isPathSafeArtifactName(artifact: string): boolean {
  return (
    artifact.length > 0 &&
    !artifact.includes("/") &&
    !artifact.includes("\\") &&
    !artifact.includes("..") &&
    /^[A-Za-z0-9._-]+$/.test(artifact)
  );
}

/** Pure composition of the run-type artifact dir and the run id. */
export function runDirRelative(runType: ResponseReceiveRunType, runId: string): string {
  return `${RUN_ARTIFACT_DIRS[runType]}/${runId}`;
}

export type RunArtifactResolution =
  | {
      ok: true;
      runType: ResponseReceiveRunType;
      runId: string;
      artifact: string;
      targetPath: string;
      relativeRef: string;
    }
  | {
      ok: false;
      reasonCode: "run_id_unsafe" | "artifact_unsafe" | "run_not_found" | "artifact_not_found";
      runType?: ResponseReceiveRunType;
      runId: string;
      artifact?: string;
    };

/**
 * Resolve a run_id (+ optional runType/artifact) to a concrete report artifact
 * path using the provided io. Path-safety is validated BEFORE any stat. When
 * runType is omitted, candidates are tried in auto-detect order and resolution
 * commits to the first candidate whose run DIR exists.
 */
export function resolveRunArtifact(
  io: FullReadIo,
  repoRoot: string,
  runId: string,
  runType?: ResponseReceiveRunType,
  artifact?: string,
): RunArtifactResolution {
  if (!isPathSafeRunId(runId)) {
    return { ok: false, reasonCode: "run_id_unsafe", runId };
  }

  const art = artifact && artifact.length > 0 ? artifact : DEFAULT_RUN_ARTIFACT;
  if (!isPathSafeArtifactName(art)) {
    return { ok: false, reasonCode: "artifact_unsafe", runId, artifact: art };
  }

  const candidates: ResponseReceiveRunType[] = runType ? [runType] : AUTO_DETECT_RUN_TYPES;

  for (const rt of candidates) {
    const dir = join(repoRoot, RUN_ARTIFACT_DIRS[rt], runId);
    let dirStat: { isDirectory: () => boolean } | null = null;
    try {
      dirStat = io.stat(dir);
    } catch {
      dirStat = null;
    }
    if (!dirStat || !dirStat.isDirectory()) {
      continue;
    }

    // This candidate's run dir exists — commit to it.
    const targetPath = join(dir, art);
    const relativeRef = `${RUN_ARTIFACT_DIRS[rt]}/${runId}/${art}`;
    let fileStat: { isFile: () => boolean } | null = null;
    try {
      fileStat = io.stat(targetPath);
    } catch {
      fileStat = null;
    }
    if (fileStat && fileStat.isFile()) {
      return { ok: true, runType: rt, runId, artifact: art, targetPath, relativeRef };
    }
    return { ok: false, reasonCode: "artifact_not_found", runType: rt, runId, artifact: art };
  }

  return { ok: false, reasonCode: "run_not_found", runId };
}

interface ErrorDetailOpts {
  runType?: ResponseReceiveRunType;
  runId?: string;
  artifact?: string;
  cwd?: string;
}

function contextKnownFromUsage(usage: FullReadContextUsage): boolean {
  return (
    typeof usage.contextWindow === "number" &&
    Number.isFinite(usage.contextWindow) &&
    typeof usage.tokens === "number" &&
    Number.isFinite(usage.tokens)
  );
}

/**
 * Replicates the resolveHardCeiling tightening logic (not exported from
 * full-read): the override can only tighten, never enlarge, the default.
 */
function resolveHardCeiling(policy: FullReadPolicy, maxBytesOverride?: number): number {
  if (maxBytesOverride !== undefined) {
    return Math.min(Math.floor(maxBytesOverride), policy.hardCeilingBytesDefault);
  }
  return policy.hardCeilingBytesDefault;
}

function errorPathHash(source: ResponseReceiveSource, opts: ErrorDetailOpts): string {
  if (opts.runType && opts.cwd) {
    return sha256Hex(resolve(opts.cwd, RUN_ARTIFACT_DIRS[opts.runType], opts.runId ?? ""));
  }
  if (opts.runId !== undefined) {
    return sha256Hex(`${opts.runId}:${opts.artifact ?? ""}`);
  }
  return sha256Hex(opts.artifact ?? source);
}

/**
 * Body-free details for a pre-read failure (resolution error or ambiguous/
 * missing source). No file is inspected, so byte/line/token metrics are
 * zeroed; policy/usage are echoed; pathHash is computed without storing a path.
 */
function errorDetails(
  reasonCode: ResponseReceiveReasonCode,
  source: ResponseReceiveSource,
  usage: FullReadContextUsage,
  policy: FullReadPolicy,
  maxBytesOverride: number | undefined,
  opts: ErrorDetailOpts = {},
): ResponseReceiveDetails {
  const contextKnown = contextKnownFromUsage(usage);
  const hardCeilingBytes = resolveHardCeiling(policy, maxBytesOverride);

  const contextWindow =
    typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow)
      ? usage.contextWindow
      : undefined;
  const contextTokensBefore =
    typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : undefined;

  const details: ResponseReceiveDetails = {
    schema: RESPONSE_RECEIVE_SCHEMA,
    source,
    decision: "block",
    reasonCode,
    pathHash: errorPathHash(source, opts),
    byteSize: 0,
    lineCount: 0,
    estimatedTokens: 0,
    safetyMarginPercent: policy.safetyMarginPercent,
    maxAllowedContextFraction: policy.maxAllowedContextFraction,
    hardCeilingBytes,
    contextKnown,
    bodyStored: false,
  };

  if (opts.runType !== undefined) details.runType = opts.runType;
  if (opts.runId !== undefined) details.runId = opts.runId;
  if (opts.artifact !== undefined) details.artifact = opts.artifact;
  if (contextWindow !== undefined) details.contextWindow = contextWindow;
  if (contextTokensBefore !== undefined) details.contextTokensBefore = contextTokensBefore;
  if (maxBytesOverride !== undefined) details.maxBytesOverride = maxBytesOverride;
  // Pre-read error: no meaningful per-file budget numbers are computed.
  return details;
}

/**
 * Wrap a FullReadRunResult's details into ResponseReceiveDetails by copying all
 * FullReadDetails fields EXCEPT `schema` and `encoding`, then setting the
 * response-receive schema and source/run metadata. bodyStored stays false.
 */
function toReceiveDetails(
  full: FullReadDetails,
  source: ResponseReceiveSource,
  runType?: ResponseReceiveRunType,
  runId?: string,
  artifact?: string,
): ResponseReceiveDetails {
  const rest = { ...full } as Record<string, unknown>;
  delete rest.schema;
  delete rest.encoding;
  const details = {
    ...rest,
    schema: RESPONSE_RECEIVE_SCHEMA,
    source,
  } as ResponseReceiveDetails;
  if (runType !== undefined) details.runType = runType;
  if (runId !== undefined) details.runId = runId;
  if (artifact !== undefined) details.artifact = artifact;
  return details;
}

function wrapFullRead(
  full: FullReadRunResult,
  source: ResponseReceiveSource,
  runType?: ResponseReceiveRunType,
  runId?: string,
  artifact?: string,
): ResponseReceiveResult {
  const decision = full.decision;
  const content = decision === "pass" || decision === "observe" ? full.content : undefined;
  const result: ResponseReceiveResult = {
    decision,
    reasonCode: full.reasonCode,
    details: toReceiveDetails(full.details, source, runType, runId, artifact),
  };
  if (content !== undefined) {
    result.content = content;
  }
  return result;
}

/**
 * Main entry. Validates exactly one source, resolves a run_id to its persisted
 * report artifact if needed, then delegates the actual read + context-budget
 * decision to `runFullRead` (inheriting path/secret/realpath safety).
 */
export function receiveFullResponse(input: ResponseReceiveInput): ResponseReceiveResult {
  const hasPath = typeof input.path === "string" && input.path.length > 0;
  const hasRunId = typeof input.runId === "string" && input.runId.length > 0;

  if (hasPath && hasRunId) {
    return {
      decision: "block",
      reasonCode: "ambiguous_source",
      details: errorDetails("ambiguous_source", "path", input.usage, input.policy, input.maxBytesOverride),
    };
  }

  if (!hasPath && !hasRunId) {
    return {
      decision: "block",
      reasonCode: "source_required",
      details: errorDetails("source_required", "path", input.usage, input.policy, input.maxBytesOverride),
    };
  }

  if (hasPath) {
    const full = runFullRead({
      cwd: input.cwd,
      path: input.path as string,
      encoding: "utf8",
      maxBytesOverride: input.maxBytesOverride,
      usage: input.usage,
      policy: input.policy,
      io: input.io,
      estimateTokens: input.estimateTokens,
    });
    return wrapFullRead(full, "path");
  }

  // run source
  const resolution = resolveRunArtifact(
    input.io,
    input.cwd,
    input.runId as string,
    input.runType,
    input.artifact,
  );

  if (!resolution.ok) {
    return {
      decision: "block",
      reasonCode: resolution.reasonCode,
      details: errorDetails(resolution.reasonCode, "run", input.usage, input.policy, input.maxBytesOverride, {
        runType: resolution.runType,
        runId: resolution.runId,
        artifact: resolution.artifact,
        cwd: input.cwd,
      }),
    };
  }

  const full = runFullRead({
    cwd: input.cwd,
    path: resolution.relativeRef,
    encoding: "utf8",
    maxBytesOverride: input.maxBytesOverride,
    usage: input.usage,
    policy: input.policy,
    io: input.io,
    estimateTokens: input.estimateTokens,
  });
  return wrapFullRead(full, "run", resolution.runType, resolution.runId, resolution.artifact);
}

const BODY_LIKE_WORDS = new Set<string>([
  "body",
  "prompt",
  "output",
  "command",
  "path",
  "pattern",
  "oldtext",
  "newtext",
  "stderr",
  "diff",
  "patch",
  "content",
  "text",
  "secret",
  "token",
  "password",
  "credential",
]);

/** Split a field key into lowercase words across camelCase / snake / kebab / path boundaries. */
function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[/_\-.]+/g, " ")
    .split(/\s+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/** Hash-bearing and bodyStored fields are explicitly exempt (metadata only). */
function isExemptField(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "bodystored" || lower.endsWith("hash");
}

/**
 * Mirror of fullReadBodyFreeViolations: walk an arbitrary value recursively and
 * return sorted paths to any body-like field name. A valid ResponseReceiveDetails
 * yields no violations. Never inspects values — only field names.
 */
export function responseReceiveBodyFreeViolations(value: unknown): string[] {
  const violations: string[] = [];

  const walk = (v: unknown, prefix: string): void => {
    if (v === null || typeof v !== "object") return;
    const record = v as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const path = prefix ? `${prefix}.${key}` : `$.${key}`;
      if (!isExemptField(key)) {
        const words = splitKeyWords(key);
        if (words.some((word) => BODY_LIKE_WORDS.has(word))) {
          violations.push(path);
        }
      }
      const child = record[key];
      if (child !== null && typeof child === "object") {
        walk(child, path);
      }
    }
  };

  walk(value, "");
  violations.sort();
  return violations;
}
