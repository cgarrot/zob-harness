import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_RULES } from "../../core/constants.js";
import { sha256Hex } from "../../core/utils/hashing.js";
import { pathMatches } from "../../core/utils/paths.js";

/**
 * `full-read.ts` is the PURE context-window-aware decision module for the future
 * `zob_read_full` tool. It decides whether an entire file may be returned in one
 * call given the live model context window, refusing with pagination guidance
 * (block `exceeds_context_budget` / `exceeds_hard_ceiling`) when there is not
 * enough headroom. All decision logic is pure over an injected `io` + `usage`;
 * the only `node:fs` use lives in `FULL_READ_DEFAULT_IO`.
 *
 * Telemetry is body-free: `FullReadDetails` never carries file content, only
 * hashes, byte/token counts, and policy echoes (`bodyStored: false`).
 */

export type FullReadDecision = "pass" | "block" | "observe";

export type FullReadReasonCode =
  | "full_read_pass"
  | "context_unknown_fallback_pass"
  | "path_not_found"
  | "path_not_file"
  | "path_secret_rejected"
  | "path_forbidden_generated"
  | "path_not_readable"
  | "inspection_failed"
  | "binary_not_supported"
  | "exceeds_context_budget"
  | "exceeds_hard_ceiling"
  | "symlink_resolves_to_zero_access";

export type FullReadEncoding = "utf8";

export const FULL_READ_SCHEMA = "zob.full-read.v1";

export interface FullReadContextUsage {
  tokens?: number;
  contextWindow?: number;
  percent?: number;
}

export interface FullReadPolicy {
  zeroAccessPaths: string[];
  forbiddenGeneratedPaths: string[];
  safetyMarginPercent: number;
  maxAllowedContextFraction: number;
  hardCeilingBytesDefault: number;
}

export const FULL_READ_DEFAULT_POLICY: FullReadPolicy = {
  zeroAccessPaths: [...DEFAULT_RULES.zeroAccessPaths],
  forbiddenGeneratedPaths: ["node_modules/", "dist/", "build/", ".pi/sessions/", ".pi/agent-sessions/"],
  safetyMarginPercent: 30,
  maxAllowedContextFraction: 0.5,
  hardCeilingBytesDefault: 2 * 1024 * 1024,
};

export interface FullReadStat {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FullReadIo {
  stat(path: string): FullReadStat;
  accessReadable(path: string): void;
  readFile(path: string): string;
  realpath(path: string): string;
}

export interface FullReadFacts {
  pathKind: "file" | "directory" | "other" | "missing";
  isSecret: boolean;
  isForbiddenGenerated: boolean;
  binaryRequested: boolean;
  readable: boolean;
  byteSize: number;
  estimatedTokens: number;
  usage: FullReadContextUsage;
}

export interface FullReadEvaluation {
  decision: FullReadDecision;
  reasonCode: FullReadReasonCode;
  contextKnown: boolean;
  availableTokens?: number;
  allowedTokens?: number;
  hardCeilingBytes: number;
}

export interface FullReadDetails {
  schema: typeof FULL_READ_SCHEMA;
  decision: FullReadDecision;
  reasonCode: FullReadReasonCode;
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
  encoding: FullReadEncoding;
  bodyStored: false;
}

export interface FullReadRunInput {
  cwd: string;
  path: string;
  encoding?: string;
  maxBytesOverride?: number;
  usage: FullReadContextUsage;
  policy: FullReadPolicy;
  io: FullReadIo;
  estimateTokens: (text: string) => number;
}

export interface FullReadRunResult {
  decision: FullReadDecision;
  reasonCode: FullReadReasonCode;
  content?: string;
  details: FullReadDetails;
}

const BODY_LIKE_FIELDS = new Set([
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

function errCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function contextWindowKnown(usage: FullReadContextUsage): boolean {
  return (
    typeof usage.contextWindow === "number" &&
    Number.isFinite(usage.contextWindow) &&
    usage.contextWindow > 0 &&
    typeof usage.tokens === "number" &&
    Number.isFinite(usage.tokens) &&
    usage.tokens >= 0
  );
}

function resolveHardCeiling(policy: FullReadPolicy, maxBytesOverride?: number): number {
  const ceiling = typeof maxBytesOverride === "number" && Number.isFinite(maxBytesOverride) && maxBytesOverride > 0
    ? Math.min(Math.floor(maxBytesOverride), policy.hardCeilingBytesDefault)
    : policy.hardCeilingBytesDefault;
  return ceiling;
}

export function classifyPathSecret(targetPath: string, cwd: string, policy: FullReadPolicy): boolean {
  return policy.zeroAccessPaths.some((pattern) => pathMatches(targetPath, pattern, cwd, cwd));
}

export function classifyPathForbiddenGenerated(targetPath: string, cwd: string, policy: FullReadPolicy): boolean {
  return policy.forbiddenGeneratedPaths.some((pattern) => pathMatches(targetPath, pattern, cwd, cwd));
}

export function evaluateFullRead(facts: FullReadFacts, policy: FullReadPolicy, maxBytesOverride?: number): FullReadEvaluation {
  const hardCeilingBytes = resolveHardCeiling(policy, maxBytesOverride);
  const contextKnown = contextWindowKnown(facts.usage);

  if (facts.isSecret) {
    return { decision: "block", reasonCode: "path_secret_rejected", contextKnown, hardCeilingBytes };
  }
  if (facts.isForbiddenGenerated) {
    return { decision: "block", reasonCode: "path_forbidden_generated", contextKnown, hardCeilingBytes };
  }
  if (facts.pathKind === "missing") {
    return { decision: "block", reasonCode: "path_not_found", contextKnown, hardCeilingBytes };
  }
  if (facts.pathKind !== "file") {
    return { decision: "block", reasonCode: "path_not_file", contextKnown, hardCeilingBytes };
  }
  if (facts.binaryRequested) {
    return { decision: "block", reasonCode: "binary_not_supported", contextKnown, hardCeilingBytes };
  }
  if (!facts.readable) {
    return { decision: "block", reasonCode: "path_not_readable", contextKnown, hardCeilingBytes };
  }
  if (facts.byteSize > hardCeilingBytes) {
    return { decision: "block", reasonCode: "exceeds_hard_ceiling", contextKnown, hardCeilingBytes };
  }

  if (!contextKnown) {
    return { decision: "observe", reasonCode: "context_unknown_fallback_pass", contextKnown: false, hardCeilingBytes };
  }

  const availableTokens = Math.max(0, Math.floor((facts.usage.contextWindow as number) - (facts.usage.tokens as number)));
  const marginAllowed = Math.floor(availableTokens * (1 - policy.safetyMarginPercent / 100));
  const fractionCap = Math.floor((facts.usage.contextWindow as number) * policy.maxAllowedContextFraction);
  const allowedTokens = Math.max(0, Math.min(marginAllowed, fractionCap));

  if (facts.estimatedTokens <= allowedTokens) {
    return { decision: "pass", reasonCode: "full_read_pass", contextKnown: true, availableTokens, allowedTokens, hardCeilingBytes };
  }
  return { decision: "block", reasonCode: "exceeds_context_budget", contextKnown: true, availableTokens, allowedTokens, hardCeilingBytes };
}

function bodyLikeField(field: string): boolean {
  const normalized = field.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (normalized === "bodystored" || normalized.endsWith("hash")) return false;
  return BODY_LIKE_FIELDS.has(normalized) || (normalized.startsWith("raw") && BODY_LIKE_FIELDS.has(normalized.slice(3)));
}

export function fullReadBodyFreeViolations(value: unknown): string[] {
  const violations: string[] = [];
  const seen = new WeakSet<object>();

  function visit(candidate: unknown, path: string): void {
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => {
        visit(entry, `${path}[${index}]`);
      });
      return;
    }
    for (const [field, entry] of Object.entries(candidate)) {
      const fieldPath = `${path}.${field}`;
      if (bodyLikeField(field)) violations.push(fieldPath);
      visit(entry, fieldPath);
    }
  }

  visit(value, "$");
  return violations.sort();
}

function buildDetails(input: {
  decision: FullReadDecision;
  reasonCode: FullReadReasonCode;
  pathHash: string;
  byteSize: number;
  lineCount: number;
  estimatedTokens: number;
  usage: FullReadContextUsage;
  evaluation: FullReadEvaluation;
  policy: FullReadPolicy;
  encoding: FullReadEncoding;
  maxBytesOverride?: number;
}): FullReadDetails {
  const details: FullReadDetails = {
    schema: FULL_READ_SCHEMA,
    decision: input.decision,
    reasonCode: input.reasonCode,
    pathHash: input.pathHash,
    byteSize: input.byteSize,
    lineCount: input.lineCount,
    estimatedTokens: input.estimatedTokens,
    safetyMarginPercent: input.policy.safetyMarginPercent,
    maxAllowedContextFraction: input.policy.maxAllowedContextFraction,
    hardCeilingBytes: input.evaluation.hardCeilingBytes,
    contextKnown: input.evaluation.contextKnown,
    encoding: input.encoding,
    bodyStored: false,
  };
  if (typeof input.usage.contextWindow === "number" && Number.isFinite(input.usage.contextWindow)) {
    details.contextWindow = input.usage.contextWindow;
  }
  if (typeof input.usage.tokens === "number" && Number.isFinite(input.usage.tokens)) {
    details.contextTokensBefore = input.usage.tokens;
  }
  if (typeof input.evaluation.availableTokens === "number") {
    details.availableTokens = input.evaluation.availableTokens;
  }
  if (typeof input.evaluation.allowedTokens === "number") {
    details.allowedTokens = input.evaluation.allowedTokens;
  }
  if (typeof input.maxBytesOverride === "number") {
    details.maxBytesOverride = input.maxBytesOverride;
  }
  return details;
}

function inspectionFailedResult(input: FullReadRunInput, pathHash: string, byteSize: number): FullReadRunResult {
  const evaluation: FullReadEvaluation = {
    decision: "block",
    reasonCode: "inspection_failed",
    contextKnown: contextWindowKnown(input.usage),
    hardCeilingBytes: resolveHardCeiling(input.policy, input.maxBytesOverride),
  };
  const details = buildDetails({
    decision: "block",
    reasonCode: "inspection_failed",
    pathHash,
    byteSize,
    lineCount: 0,
    estimatedTokens: 0,
    usage: input.usage,
    evaluation,
    policy: input.policy,
    encoding: "utf8",
    maxBytesOverride: input.maxBytesOverride,
  });
  return { decision: "block", reasonCode: "inspection_failed", details };
}

export function runFullRead(input: FullReadRunInput): FullReadRunResult {
  const targetPath = resolve(input.cwd, input.path);
  const pathHash = sha256Hex(targetPath);
  const binaryRequested = !(input.encoding === "utf8" || input.encoding === undefined);
  const encoding: FullReadEncoding = "utf8";
  const isSecret = classifyPathSecret(targetPath, input.cwd, input.policy);
  let isForbiddenGenerated = classifyPathForbiddenGenerated(targetPath, input.cwd, input.policy);

  let pathKind: FullReadFacts["pathKind"] = "missing";
  let readable = false;
  let byteSize = 0;
  let inspectionFailed = false;

  try {
    const stat = input.io.stat(targetPath);
    pathKind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
    byteSize = stat.size;
    try {
      input.io.accessReadable(targetPath);
      readable = true;
    } catch {
      readable = false;
    }
  } catch (error) {
    if (errCode(error) === "ENOENT") {
      pathKind = "missing";
      byteSize = 0;
      readable = false;
    } else {
      inspectionFailed = true;
    }
  }

  if (inspectionFailed) {
    return inspectionFailedResult(input, pathHash, 0);
  }

  // Canonical-path zero-access check: realpath the target (this follows symlinks,
  // unlike resolve) and re-run classifyPathSecret on the canonical path. This
  // closes the symlink bypass where an in-cwd symlink to ~/.ssh/id_rsa or a .env
  // would otherwise evade the lexical targetPath check. Runs for every existing
  // path kind and BEFORE any readFile, mirroring file-tool-preflight's
  // zeroAccessRealpathFailure.
  if (pathKind !== "missing") {
    let canonicalPath: string;
    try {
      canonicalPath = input.io.realpath(targetPath);
    } catch {
      return inspectionFailedResult(input, pathHash, byteSize);
    }
    const canonicalSecret = classifyPathSecret(canonicalPath, input.cwd, input.policy);
    if (canonicalSecret && !isSecret) {
      const canonicalEvaluation: FullReadEvaluation = {
        decision: "block",
        reasonCode: "symlink_resolves_to_zero_access",
        contextKnown: contextWindowKnown(input.usage),
        hardCeilingBytes: resolveHardCeiling(input.policy, input.maxBytesOverride),
      };
      const canonicalDetails = buildDetails({
        decision: "block",
        reasonCode: "symlink_resolves_to_zero_access",
        pathHash,
        byteSize,
        lineCount: 0,
        estimatedTokens: 0,
        usage: input.usage,
        evaluation: canonicalEvaluation,
        policy: input.policy,
        encoding,
        maxBytesOverride: input.maxBytesOverride,
      });
      return { decision: "block", reasonCode: "symlink_resolves_to_zero_access", details: canonicalDetails };
    }
    isForbiddenGenerated = isForbiddenGenerated || classifyPathForbiddenGenerated(canonicalPath, input.cwd, input.policy);
  }

  // Pre-evaluate WITHOUT reading content. estimatedTokens is 0 here, which only
  // matters for the budget branches — so any "block" from this pass is one of
  // the safety/path-kind/binary/readable/hard-ceiling branches and must return
  // immediately without touching file content.
  const preliminaryFacts: FullReadFacts = {
    pathKind,
    isSecret,
    isForbiddenGenerated,
    binaryRequested,
    readable,
    byteSize,
    estimatedTokens: 0,
    usage: input.usage,
  };
  const preliminaryEvaluation = evaluateFullRead(preliminaryFacts, input.policy, input.maxBytesOverride);
  if (preliminaryEvaluation.decision === "block") {
    const details = buildDetails({
      decision: preliminaryEvaluation.decision,
      reasonCode: preliminaryEvaluation.reasonCode,
      pathHash,
      byteSize,
      lineCount: 0,
      estimatedTokens: 0,
      usage: input.usage,
      evaluation: preliminaryEvaluation,
      policy: input.policy,
      encoding,
      maxBytesOverride: input.maxBytesOverride,
    });
    return { decision: preliminaryEvaluation.decision, reasonCode: preliminaryEvaluation.reasonCode, details };
  }

  let content: string;
  try {
    content = input.io.readFile(targetPath);
  } catch {
    return inspectionFailedResult(input, pathHash, byteSize);
  }

  const estimatedTokens = input.estimateTokens(content);
  const lineCount = content === "" ? 0 : content.split("\n").length;

  const facts: FullReadFacts = {
    pathKind,
    isSecret,
    isForbiddenGenerated,
    binaryRequested,
    readable,
    byteSize,
    estimatedTokens,
    usage: input.usage,
  };
  const evaluation = evaluateFullRead(facts, input.policy, input.maxBytesOverride);

  const details = buildDetails({
    decision: evaluation.decision,
    reasonCode: evaluation.reasonCode,
    pathHash,
    byteSize,
    lineCount,
    estimatedTokens,
    usage: input.usage,
    evaluation,
    policy: input.policy,
    encoding,
    maxBytesOverride: input.maxBytesOverride,
  });

  const result: FullReadRunResult = { decision: evaluation.decision, reasonCode: evaluation.reasonCode, details };
  if (evaluation.decision === "pass" || evaluation.decision === "observe") {
    result.content = content;
  }
  return result;
}

/**
 * Default IO backed by `node:fs` synchronous helpers. The runtime tool (later
 * slice) injects this unless tests pass an in-memory `FullReadIo`.
 */
export const FULL_READ_DEFAULT_IO: FullReadIo = {
  stat: (path: string): FullReadStat => statSync(path) as FullReadStat,
  accessReadable: (path: string): void => {
    accessSync(path, fsConstants.R_OK);
  },
  readFile: (path: string): string => readFileSync(path, "utf8"),
  realpath: (path: string): string => realpathSync(path),
};
