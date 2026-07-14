import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { sha256Hex } from "../../core/utils/hashing.js";
import { pathMatches } from "../../core/utils/paths.js";
import { fileToolPreflightFingerprint } from "../telemetry/tool-failures.js";

export const FILE_TOOL_PREFLIGHT_TOOLS = ["read", "edit", "grep", "find"] as const;
export type FileToolPreflightTool = (typeof FILE_TOOL_PREFLIGHT_TOOLS)[number];

export const FILE_TOOL_PREFLIGHT_VERDICTS = ["pass", "observe", "block"] as const;
export type FileToolPreflightVerdict = (typeof FILE_TOOL_PREFLIGHT_VERDICTS)[number];

export const FILE_TOOL_PREFLIGHT_REASON_CODES = [
  "file_tool_preflight_pass",
  "path_not_found",
  "path_not_file",
  "path_not_directory",
  "path_not_file_or_directory",
  "path_not_readable",
  "path_inspection_failed",
  "symlink_resolves_to_zero_access",
  "invalid_regex",
  "offset_beyond_eof",
  "old_text_empty",
  "old_text_not_found",
  "old_text_not_unique",
  "ambiguous_concatenated_path",
  "grep_root_glob_mismatch",
  "large_offset_observed",
  "large_content_above_budget",
  "binary_offset_observed",
] as const;
export type FileToolPreflightReasonCode = (typeof FILE_TOOL_PREFLIGHT_REASON_CODES)[number];

export const FILE_TOOL_PREFLIGHT_FIELDS = ["none", "path", "pattern", "offset", "oldText", "glob"] as const;
export type FileToolPreflightField = (typeof FILE_TOOL_PREFLIGHT_FIELDS)[number];

export const FILE_TOOL_PREFLIGHT_RETRY_POLICIES = ["none", "fix_input_then_retry", "refresh_snapshot_then_retry", "review_guidance_then_continue"] as const;
export type FileToolPreflightRetryPolicy = (typeof FILE_TOOL_PREFLIGHT_RETRY_POLICIES)[number];

export const FILE_TOOL_PREFLIGHT_SAFE_NEXT_ACTIONS = [
  "proceed_with_native_tool",
  "inspect_parent_or_root_then_retry",
  "use_an_existing_regular_file",
  "use_an_existing_directory",
  "request_readable_access_or_choose_another_path",
  "use_literal_true_for_code_punctuation_or_fix_the_regex",
  "reread_without_a_guessed_offset",
  "reread_the_file_then_use_exact_nonempty_old_text",
  "include_more_exact_context_until_old_text_is_unique",
  "use_one_explicit_path_without_splitting_or_correction",
  "use_one_explicit_root_and_make_the_glob_relative_to_it",
  "review_the_large_offset_before_continuing",
  "review_the_large_file_before_continuing",
  "remove_text_offsets_from_binary_reads",
  "avoid_symlinks_resolving_to_protected_paths",
  "restore_preflight_telemetry_then_retry",
] as const;
export type FileToolPreflightSafeNextAction = (typeof FILE_TOOL_PREFLIGHT_SAFE_NEXT_ACTIONS)[number];

export interface FileToolPreflightDecision {
  schema: "zob.file-tool-preflight-decision.v1";
  verdict: FileToolPreflightVerdict;
  executionPerformed: false;
  toolName: FileToolPreflightTool;
  reasonCode: FileToolPreflightReasonCode;
  field: FileToolPreflightField;
  retryPolicy: FileToolPreflightRetryPolicy;
  safeNextActions: FileToolPreflightSafeNextAction[];
  toolHash: string;
  inputHash: string;
  pathHash: string;
  snapshotHash: string;
  fingerprintHash: string;
  argumentCount: number;
  byteSize?: number;
  lineCount?: number;
  occurrenceCount?: number;
  bodyStored: false;
}

export interface FileToolPreflightLedgerEntry extends Omit<FileToolPreflightDecision, "schema"> {
  schema: "zob.file-tool-preflight-ledger.v1";
  attemptCount: number;
  unchangedRetryCount: number;
}

export interface FileToolPreflightIncidentState {
  snapshotHash: string;
  attemptCount: number;
  ledgerRecorded: boolean;
}

export interface FileToolPreflightRuntimeState {
  incidentsByFingerprint: Record<string, FileToolPreflightIncidentState>;
}

export interface FileToolPreflightRecordResult {
  telemetryRecorded: boolean;
  deduplicated: boolean;
  attemptCount: number;
  unchangedRetryCount: number;
}

interface FileToolPreflightStat {
  size: number;
  mtimeMs: number;
  mode?: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FileToolPreflightIo {
  stat(path: string): FileToolPreflightStat;
  accessReadable(path: string): void;
  readFile(path: string): Buffer;
  realpath(path: string): string;
}

export interface FileToolPreflightPolicy {
  zeroAccessPaths?: string[];
  policyRoot?: string;
  contentReadBudgetBytes?: number;
}

export const DEFAULT_CONTENT_READ_BUDGET_BYTES = 512 * 1024;

export type FileToolPreflightCall =
  | { toolName: "read"; cwd: string; input: { path: string; offset?: number; limit?: number } }
  | { toolName: "edit"; cwd: string; input: { path: string; edits: Array<{ oldText: string; newText: string }> } }
  | { toolName: "grep"; cwd: string; input: { pattern: string; path?: string; glob?: string; literal?: boolean; ignoreCase?: boolean; context?: number; limit?: number } }
  | { toolName: "find"; cwd: string; input: { pattern: string; path?: string; limit?: number } };

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DECISION_FIELDS = new Set([
  "schema",
  "verdict",
  "executionPerformed",
  "toolName",
  "reasonCode",
  "field",
  "retryPolicy",
  "safeNextActions",
  "toolHash",
  "inputHash",
  "pathHash",
  "snapshotHash",
  "fingerprintHash",
  "argumentCount",
  "byteSize",
  "lineCount",
  "occurrenceCount",
  "bodyStored",
]);
const LEDGER_FIELDS = new Set([...DECISION_FIELDS, "attemptCount", "unchangedRetryCount"]);
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

const DEFAULT_IO: FileToolPreflightIo = {
  stat: (path) => statSync(path),
  accessReadable: (path) => accessSync(path, constants.R_OK),
  readFile: (path) => readFileSync(path),
  realpath: (path) => realpathSync(path),
};

function stableHashInput(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (typeof value === "undefined") return '"[undefined]"';
    const serialized = JSON.stringify(value);
    return serialized === undefined ? JSON.stringify(String(value)) : serialized;
  }
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableHashInput(entry, seen)).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableHashInput((value as Record<string, unknown>)[key], seen)}`)
    .join(",")}}`;
}

function argumentCount(input: unknown): number {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? Object.keys(input).length : 0;
}

function preflightBodyLikeField(field: string): boolean {
  const normalized = field.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (normalized === "bodystored" || normalized.endsWith("hash")) return false;
  return BODY_LIKE_FIELDS.has(normalized) || (normalized.startsWith("raw") && BODY_LIKE_FIELDS.has(normalized.slice(3)));
}

export function fileToolPreflightBodyLikeFieldViolations(value: unknown): string[] {
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
      if (preflightBodyLikeField(field)) violations.push(fieldPath);
      visit(entry, fieldPath);
    }
  }

  visit(value, "$");
  return violations.sort();
}

function validateNonNegativeInteger(value: unknown, path: string, errors: string[]): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) errors.push(`${path} must be a non-negative safe integer`);
}

function validateMetadata(value: unknown, ledger: boolean): string[] {
  const errors = fileToolPreflightBodyLikeFieldViolations(value).map((path) => `${path} is a forbidden body-like field`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [...errors, "$ must be an object"];
  const record = value as Record<string, unknown>;
  const fields = ledger ? LEDGER_FIELDS : DECISION_FIELDS;
  for (const field of Object.keys(record)) {
    if (!fields.has(field)) errors.push(`$.${field} is not allowed`);
  }
  const expectedSchema = ledger ? "zob.file-tool-preflight-ledger.v1" : "zob.file-tool-preflight-decision.v1";
  if (record.schema !== expectedSchema) errors.push(`$.schema must equal ${expectedSchema}`);
  if (!FILE_TOOL_PREFLIGHT_VERDICTS.includes(record.verdict as FileToolPreflightVerdict)) errors.push("$.verdict must be a stable preflight verdict");
  if (record.executionPerformed !== false) errors.push("$.executionPerformed must be false");
  if (!FILE_TOOL_PREFLIGHT_TOOLS.includes(record.toolName as FileToolPreflightTool)) errors.push("$.toolName must be a native file tool");
  if (!FILE_TOOL_PREFLIGHT_REASON_CODES.includes(record.reasonCode as FileToolPreflightReasonCode)) errors.push("$.reasonCode must be a stable preflight reason code");
  if (!FILE_TOOL_PREFLIGHT_FIELDS.includes(record.field as FileToolPreflightField)) errors.push("$.field must be a stable preflight field");
  if (!FILE_TOOL_PREFLIGHT_RETRY_POLICIES.includes(record.retryPolicy as FileToolPreflightRetryPolicy)) errors.push("$.retryPolicy must be a stable retry policy");
  if (
    !Array.isArray(record.safeNextActions) ||
    record.safeNextActions.length === 0 ||
    record.safeNextActions.some((action) => !FILE_TOOL_PREFLIGHT_SAFE_NEXT_ACTIONS.includes(action as FileToolPreflightSafeNextAction))
  ) {
    errors.push("$.safeNextActions must contain stable safe actions");
  }
  for (const field of ["toolHash", "inputHash", "pathHash", "snapshotHash", "fingerprintHash"] as const) {
    if (typeof record[field] !== "string" || !HASH_PATTERN.test(record[field] as string)) errors.push(`$.${field} must be a lowercase sha256 hash`);
  }
  validateNonNegativeInteger(record.argumentCount, "$.argumentCount", errors);
  for (const field of ["byteSize", "lineCount", "occurrenceCount"] as const) {
    if (record[field] !== undefined) validateNonNegativeInteger(record[field], `$.${field}`, errors);
  }
  if (record.bodyStored !== false) errors.push("$.bodyStored must be false");
  if (ledger) {
    validateNonNegativeInteger(record.attemptCount, "$.attemptCount", errors);
    validateNonNegativeInteger(record.unchangedRetryCount, "$.unchangedRetryCount", errors);
    if (Number.isSafeInteger(record.attemptCount) && Number.isSafeInteger(record.unchangedRetryCount) && record.unchangedRetryCount !== (record.attemptCount as number) - 1) {
      errors.push("$.unchangedRetryCount must equal attemptCount - 1");
    }
  }
  if (["toolHash", "inputHash", "snapshotHash"].every((field) => typeof record[field] === "string") && typeof record.reasonCode === "string" && typeof record.fingerprintHash === "string") {
    const expectedFingerprint = fileToolPreflightFingerprint({
      toolHash: record.toolHash as string,
      inputHash: record.inputHash as string,
      snapshotHash: record.snapshotHash as string,
      reasonCode: record.reasonCode,
    });
    if (record.fingerprintHash !== expectedFingerprint) errors.push("$.fingerprintHash does not match the deterministic Phase 0 fingerprint");
  }
  return [...new Set(errors)].sort();
}

export function validateFileToolPreflightDecision(value: unknown): string[] {
  return validateMetadata(value, false);
}

export function validateFileToolPreflightLedgerEntry(value: unknown): string[] {
  return validateMetadata(value, true);
}

function pathKind(stat: FileToolPreflightStat): "file" | "directory" | "other" {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

function statSnapshotHash(pathHash: string, stat: FileToolPreflightStat, contentHash?: string): string {
  return sha256Hex(
    stableHashInput({
      pathHash,
      kind: pathKind(stat),
      byteSize: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode ?? 0,
      contentHash: contentHash ?? "not_read",
    }),
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

interface PathInspection {
  targetPath: string;
  pathHash: string;
  snapshotHash: string;
  stat?: FileToolPreflightStat;
  missing: boolean;
  inspectionFailed: boolean;
  deterministicInspectionFailure: boolean;
}

function inspectPath(cwd: string, inputPath: string, io: FileToolPreflightIo): PathInspection {
  const targetPath = resolve(cwd, inputPath);
  const pathHash = sha256Hex(targetPath);
  try {
    const stat = io.stat(targetPath);
    return {
      targetPath,
      pathHash,
      snapshotHash: statSnapshotHash(pathHash, stat),
      stat,
      missing: false,
      inspectionFailed: false,
      deterministicInspectionFailure: false,
    };
  } catch (error) {
    const code = errorCode(error);
    const missing = code === "ENOENT" || code === "ENOTDIR";
    const deterministicInspectionFailure = ["EACCES", "EPERM", "EINVAL", "ENAMETOOLONG", "ELOOP"].includes(code ?? "");
    return {
      targetPath,
      pathHash,
      snapshotHash: sha256Hex(`${pathHash}:${missing ? "missing" : deterministicInspectionFailure ? "deterministic_inspection_failure" : "ambiguous_inspection_failure"}`),
      missing,
      inspectionFailed: !missing,
      deterministicInspectionFailure,
    };
  }
}

function decision(input: {
  call: FileToolPreflightCall;
  inspection: PathInspection;
  verdict: FileToolPreflightVerdict;
  reasonCode: FileToolPreflightReasonCode;
  field: FileToolPreflightField;
  retryPolicy: FileToolPreflightRetryPolicy;
  safeNextActions: FileToolPreflightSafeNextAction[];
  snapshotHash?: string;
  byteSize?: number;
  lineCount?: number;
  occurrenceCount?: number;
}): FileToolPreflightDecision {
  const toolHash = sha256Hex(input.call.toolName);
  const inputHash = sha256Hex(stableHashInput(input.call.input));
  const snapshotHash = input.snapshotHash ?? input.inspection.snapshotHash;
  const result: FileToolPreflightDecision = {
    schema: "zob.file-tool-preflight-decision.v1",
    verdict: input.verdict,
    executionPerformed: false,
    toolName: input.call.toolName,
    reasonCode: input.reasonCode,
    field: input.field,
    retryPolicy: input.retryPolicy,
    safeNextActions: input.safeNextActions,
    toolHash,
    inputHash,
    pathHash: input.inspection.pathHash,
    snapshotHash,
    fingerprintHash: fileToolPreflightFingerprint({ toolHash, inputHash, snapshotHash, reasonCode: input.reasonCode }),
    argumentCount: argumentCount(input.call.input),
    ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
    ...(input.lineCount === undefined ? {} : { lineCount: input.lineCount }),
    ...(input.occurrenceCount === undefined ? {} : { occurrenceCount: input.occurrenceCount }),
    bodyStored: false,
  };
  const errors = validateFileToolPreflightDecision(result);
  if (errors.length > 0) throw new Error(`unsafe file-tool preflight decision: ${errors.join("; ")}`);
  return result;
}

function pathFailure(call: FileToolPreflightCall, inspection: PathInspection, expected: "file" | "directory" | "file_or_directory"): FileToolPreflightDecision | undefined {
  if (inspection.missing) {
    return decision({
      call,
      inspection,
      verdict: "block",
      reasonCode: "path_not_found",
      field: "path",
      retryPolicy: "fix_input_then_retry",
      safeNextActions: ["inspect_parent_or_root_then_retry"],
    });
  }
  if (inspection.inspectionFailed || !inspection.stat) {
    return decision({
      call,
      inspection,
      verdict: inspection.deterministicInspectionFailure ? "block" : "observe",
      reasonCode: "path_inspection_failed",
      field: "path",
      retryPolicy: inspection.deterministicInspectionFailure ? "fix_input_then_retry" : "review_guidance_then_continue",
      safeNextActions: ["inspect_parent_or_root_then_retry"],
    });
  }
  const kind = pathKind(inspection.stat);
  if (expected === "file" && kind !== "file") {
    return decision({
      call,
      inspection,
      verdict: "block",
      reasonCode: "path_not_file",
      field: "path",
      retryPolicy: "fix_input_then_retry",
      safeNextActions: ["use_an_existing_regular_file"],
      byteSize: inspection.stat.size,
    });
  }
  if (expected === "directory" && kind !== "directory") {
    return decision({
      call,
      inspection,
      verdict: "block",
      reasonCode: "path_not_directory",
      field: "path",
      retryPolicy: "fix_input_then_retry",
      safeNextActions: ["use_an_existing_directory"],
      byteSize: inspection.stat.size,
    });
  }
  if (expected === "file_or_directory" && kind === "other") {
    return decision({
      call,
      inspection,
      verdict: "block",
      reasonCode: "path_not_file_or_directory",
      field: "path",
      retryPolicy: "fix_input_then_retry",
      safeNextActions: ["inspect_parent_or_root_then_retry"],
      byteSize: inspection.stat.size,
    });
  }
  return undefined;
}

function readableFailure(call: FileToolPreflightCall, inspection: PathInspection, io: FileToolPreflightIo): FileToolPreflightDecision | undefined {
  try {
    io.accessReadable(inspection.targetPath);
    return undefined;
  } catch {
    return decision({
      call,
      inspection,
      verdict: "block",
      reasonCode: "path_not_readable",
      field: "path",
      retryPolicy: "fix_input_then_retry",
      safeNextActions: ["request_readable_access_or_choose_another_path"],
      byteSize: inspection.stat?.size,
    });
  }
}

function readContent(call: FileToolPreflightCall, inspection: PathInspection, io: FileToolPreflightIo): { content?: Buffer; failure?: FileToolPreflightDecision } {
  try {
    return { content: io.readFile(inspection.targetPath) };
  } catch {
    return {
      failure: decision({
        call,
        inspection,
        verdict: "block",
        reasonCode: "path_not_readable",
        field: "path",
        retryPolicy: "refresh_snapshot_then_retry",
        safeNextActions: ["request_readable_access_or_choose_another_path"],
        byteSize: inspection.stat?.size,
      }),
    };
  }
}

function zeroAccessRealpathFailure(call: FileToolPreflightCall, inspection: PathInspection, io: FileToolPreflightIo, policy: FileToolPreflightPolicy): FileToolPreflightDecision | undefined {
  const patterns = policy.zeroAccessPaths ?? [];
  if (patterns.length === 0) return undefined;
  const policyRoot = policy.policyRoot ?? call.cwd;
  let resolvedTarget: string;
  try {
    resolvedTarget = io.realpath(inspection.targetPath);
  } catch {
    return decision({
      call,
      inspection,
      verdict: "block",
      reasonCode: "path_inspection_failed",
      field: "path",
      retryPolicy: "fix_input_then_retry",
      safeNextActions: ["inspect_parent_or_root_then_retry"],
      byteSize: inspection.stat?.size,
    });
  }
  // Canonicalize the policy root the same way as the target so a symlinked repo
  // root (e.g. /var -> /private/var) does not break the protected-path comparison.
  let resolvedRoot = resolve(policyRoot);
  try {
    resolvedRoot = io.realpath(resolvedRoot);
  } catch {
    // policyRoot may still be valid lexically; keep the lexical root as a best-effort fallback.
  }
  for (const pattern of patterns) {
    if (pathMatches(resolvedTarget, pattern, resolvedRoot, resolvedRoot)) {
      return decision({
        call,
        inspection,
        verdict: "block",
        reasonCode: "symlink_resolves_to_zero_access",
        field: "path",
        retryPolicy: "fix_input_then_retry",
        safeNextActions: ["avoid_symlinks_resolving_to_protected_paths"],
        byteSize: inspection.stat?.size,
      });
    }
  }
  return undefined;
}

function contentBudgetFailure(call: FileToolPreflightCall, inspection: PathInspection, policy: FileToolPreflightPolicy): FileToolPreflightDecision | undefined {
  const budget = policy.contentReadBudgetBytes ?? DEFAULT_CONTENT_READ_BUDGET_BYTES;
  const size = inspection.stat?.size ?? 0;
  if (size > budget) {
    return decision({
      call,
      inspection,
      verdict: "observe",
      reasonCode: "large_content_above_budget",
      field: "path",
      retryPolicy: "review_guidance_then_continue",
      safeNextActions: ["review_the_large_file_before_continuing"],
      byteSize: size,
    });
  }
  return undefined;
}

function looksLikeConcatenatedPath(path: string): boolean {
  return path.includes("\n") || path.includes("\r");
}

function grepRootGlobMismatch(path: string, glob: string | undefined): boolean {
  if (!glob || path === "." || path === "./") return false;
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const normalizedGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalizedGlob === normalizedPath || normalizedGlob.startsWith(`${normalizedPath}/`);
}

function decodeText(content: Buffer): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function exactOccurrenceCount(content: string, oldText: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length - oldText.length) {
    const index = content.indexOf(oldText, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + oldText.length;
  }
  return count;
}

function passDecision(
  call: FileToolPreflightCall,
  inspection: PathInspection,
  snapshotHash?: string,
  counts?: { byteSize?: number; lineCount?: number; occurrenceCount?: number },
): FileToolPreflightDecision {
  return decision({
    call,
    inspection,
    verdict: "pass",
    reasonCode: "file_tool_preflight_pass",
    field: "none",
    retryPolicy: "none",
    safeNextActions: ["proceed_with_native_tool"],
    snapshotHash,
    ...counts,
  });
}

export function preflightFileToolCall(call: FileToolPreflightCall, io: FileToolPreflightIo = DEFAULT_IO, policy: FileToolPreflightPolicy = {}): FileToolPreflightDecision {
  const inputPath = call.toolName === "read" || call.toolName === "edit" ? call.input.path : (call.input.path ?? ".");
  const inspection = inspectPath(call.cwd, inputPath, io);
  const expected = call.toolName === "find" ? "directory" : call.toolName === "grep" ? "file_or_directory" : "file";
  const deterministicPathFailure = pathFailure(call, inspection, expected);
  if (deterministicPathFailure) return deterministicPathFailure;

  if (call.toolName === "read" || call.toolName === "edit") {
    const unreadable = readableFailure(call, inspection, io);
    if (unreadable) return unreadable;
  }

  const zeroAccessFailure = zeroAccessRealpathFailure(call, inspection, io, policy);
  if (zeroAccessFailure) return zeroAccessFailure;

  if (call.toolName === "grep" && call.input.literal !== true) {
    try {
      void new RegExp(call.input.pattern);
    } catch {
      return decision({
        call,
        inspection,
        verdict: "block",
        reasonCode: "invalid_regex",
        field: "pattern",
        retryPolicy: "fix_input_then_retry",
        safeNextActions: ["use_literal_true_for_code_punctuation_or_fix_the_regex"],
        byteSize: inspection.stat?.size,
      });
    }
  }

  if (call.toolName === "read" && Number.isSafeInteger(call.input.offset) && (call.input.offset as number) >= 1) {
    const budgetFailure = contentBudgetFailure(call, inspection, policy);
    if (budgetFailure) return budgetFailure;
    const loaded = readContent(call, inspection, io);
    if (loaded.failure) return loaded.failure;
    const content = loaded.content as Buffer;
    const snapshotHash = statSnapshotHash(inspection.pathHash, inspection.stat as FileToolPreflightStat, sha256Hex(content.toString("base64")));
    const text = decodeText(content);
    if (text === undefined) {
      return decision({
        call,
        inspection,
        verdict: "observe",
        reasonCode: "binary_offset_observed",
        field: "offset",
        retryPolicy: "review_guidance_then_continue",
        safeNextActions: ["remove_text_offsets_from_binary_reads"],
        snapshotHash,
        byteSize: content.byteLength,
      });
    }
    const lineCount = text.length === 0 ? 0 : text.split("\n").length;
    const maximumReadableOffset = text.length === 0 ? 1 : lineCount;
    if ((call.input.offset as number) > maximumReadableOffset) {
      return decision({
        call,
        inspection,
        verdict: "block",
        reasonCode: "offset_beyond_eof",
        field: "offset",
        retryPolicy: "fix_input_then_retry",
        safeNextActions: ["reread_without_a_guessed_offset"],
        snapshotHash,
        byteSize: content.byteLength,
        lineCount,
      });
    }
    if ((call.input.offset as number) >= 10_000) {
      return decision({
        call,
        inspection,
        verdict: "observe",
        reasonCode: "large_offset_observed",
        field: "offset",
        retryPolicy: "review_guidance_then_continue",
        safeNextActions: ["review_the_large_offset_before_continuing"],
        snapshotHash,
        byteSize: content.byteLength,
        lineCount,
      });
    }
    if (looksLikeConcatenatedPath(inputPath)) {
      return decision({
        call,
        inspection,
        verdict: "observe",
        reasonCode: "ambiguous_concatenated_path",
        field: "path",
        retryPolicy: "review_guidance_then_continue",
        safeNextActions: ["use_one_explicit_path_without_splitting_or_correction"],
        snapshotHash,
        byteSize: content.byteLength,
        lineCount,
      });
    }
    return passDecision(call, inspection, snapshotHash, { byteSize: content.byteLength, lineCount });
  }

  if (call.toolName === "edit") {
    if (call.input.edits.some((item) => item.oldText.length === 0)) {
      return decision({
        call,
        inspection,
        verdict: "block",
        reasonCode: "old_text_empty",
        field: "oldText",
        retryPolicy: "fix_input_then_retry",
        safeNextActions: ["reread_the_file_then_use_exact_nonempty_old_text"],
        byteSize: inspection.stat?.size,
        occurrenceCount: 0,
      });
    }
    const budgetFailure = contentBudgetFailure(call, inspection, policy);
    if (budgetFailure) return budgetFailure;
    const loaded = readContent(call, inspection, io);
    if (loaded.failure) return loaded.failure;
    const contentBuffer = loaded.content as Buffer;
    let candidateContent = contentBuffer.toString("utf8");
    const snapshotHash = statSnapshotHash(inspection.pathHash, inspection.stat as FileToolPreflightStat, sha256Hex(contentBuffer.toString("base64")));
    for (const item of call.input.edits) {
      const occurrenceCount = exactOccurrenceCount(candidateContent, item.oldText);
      if (occurrenceCount === 0) {
        return decision({
          call,
          inspection,
          verdict: "block",
          reasonCode: "old_text_not_found",
          field: "oldText",
          retryPolicy: "refresh_snapshot_then_retry",
          safeNextActions: ["reread_the_file_then_use_exact_nonempty_old_text"],
          snapshotHash,
          byteSize: contentBuffer.byteLength,
          occurrenceCount,
        });
      }
      if (occurrenceCount > 1) {
        return decision({
          call,
          inspection,
          verdict: "block",
          reasonCode: "old_text_not_unique",
          field: "oldText",
          retryPolicy: "fix_input_then_retry",
          safeNextActions: ["include_more_exact_context_until_old_text_is_unique"],
          snapshotHash,
          byteSize: contentBuffer.byteLength,
          occurrenceCount,
        });
      }
      candidateContent = candidateContent.replace(item.oldText, item.newText);
    }
    if (looksLikeConcatenatedPath(inputPath)) {
      return decision({
        call,
        inspection,
        verdict: "observe",
        reasonCode: "ambiguous_concatenated_path",
        field: "path",
        retryPolicy: "review_guidance_then_continue",
        safeNextActions: ["use_one_explicit_path_without_splitting_or_correction"],
        snapshotHash,
        byteSize: contentBuffer.byteLength,
        occurrenceCount: 1,
      });
    }
    return passDecision(call, inspection, snapshotHash, { byteSize: contentBuffer.byteLength, occurrenceCount: call.input.edits.length === 0 ? 0 : 1 });
  }

  if (looksLikeConcatenatedPath(inputPath)) {
    return decision({
      call,
      inspection,
      verdict: "observe",
      reasonCode: "ambiguous_concatenated_path",
      field: "path",
      retryPolicy: "review_guidance_then_continue",
      safeNextActions: ["use_one_explicit_path_without_splitting_or_correction"],
      byteSize: inspection.stat?.size,
    });
  }

  if (call.toolName === "grep" && grepRootGlobMismatch(inputPath, call.input.glob)) {
    return decision({
      call,
      inspection,
      verdict: "observe",
      reasonCode: "grep_root_glob_mismatch",
      field: "glob",
      retryPolicy: "review_guidance_then_continue",
      safeNextActions: ["use_one_explicit_root_and_make_the_glob_relative_to_it"],
      byteSize: inspection.stat?.size,
    });
  }

  return passDecision(call, inspection, undefined, { byteSize: inspection.stat?.size });
}

export function createFileToolPreflightRuntimeState(): FileToolPreflightRuntimeState {
  return { incidentsByFingerprint: {} };
}

export function persistFileToolPreflightDecision(
  result: FileToolPreflightDecision,
  state: FileToolPreflightRuntimeState,
  appendEntry: (customType: "zob-file-tool-preflight", data: FileToolPreflightLedgerEntry) => void,
): FileToolPreflightRecordResult {
  if (result.verdict === "pass") {
    return { telemetryRecorded: true, deduplicated: false, attemptCount: 1, unchangedRetryCount: 0 };
  }
  const previous = state.incidentsByFingerprint[result.fingerprintHash];
  const incident: FileToolPreflightIncidentState = previous ?? {
    snapshotHash: result.snapshotHash,
    attemptCount: 0,
    ledgerRecorded: false,
  };
  incident.attemptCount += 1;
  state.incidentsByFingerprint[result.fingerprintHash] = incident;
  const unchangedRetryCount = incident.attemptCount - 1;
  if (incident.ledgerRecorded && incident.snapshotHash === result.snapshotHash) {
    return {
      telemetryRecorded: true,
      deduplicated: true,
      attemptCount: incident.attemptCount,
      unchangedRetryCount,
    };
  }
  const entry: FileToolPreflightLedgerEntry = {
    ...result,
    schema: "zob.file-tool-preflight-ledger.v1",
    attemptCount: incident.attemptCount,
    unchangedRetryCount,
  };
  try {
    const errors = validateFileToolPreflightLedgerEntry(entry);
    if (errors.length > 0) throw new Error(`unsafe file-tool preflight ledger entry: ${errors.join("; ")}`);
    appendEntry("zob-file-tool-preflight", entry);
    incident.ledgerRecorded = true;
    return {
      telemetryRecorded: true,
      deduplicated: false,
      attemptCount: incident.attemptCount,
      unchangedRetryCount,
    };
  } catch {
    return {
      telemetryRecorded: false,
      deduplicated: false,
      attemptCount: incident.attemptCount,
      unchangedRetryCount,
    };
  }
}
