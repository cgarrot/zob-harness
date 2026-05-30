import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DEFAULT_RULES } from "../constants.js";
import { sha256 } from "../utils/hashing.js";
import { readJsonObjectIfPresent } from "../utils/json.js";
import { pathMatches, resolveRepoPath, safeFileStem } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";
import type { PromotionApplyScope, PromotionCandidateInput, PromotionCandidateRecord, PromotionGates, PromotionKind, PromotionStatus, PromotionTransitionInput } from "./types.js";
import { PROMOTION_APPLY_SCOPES, PROMOTION_KINDS, PROMOTION_STATUSES } from "./types.js";

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const FORBIDDEN_BODY_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch", "transcript", "rawContext", "rawPrompt"]);
const STATUS_ORDER: Record<Exclude<PromotionStatus, "rejected" | "blocked">, number> = {
  proposal: 0,
  prepared: 1,
  validated: 2,
  oracle_reviewed: 3,
  approved: 4,
  applied: 5,
};

export const DEFAULT_PROMOTION_GATES: PromotionGates = {
  comsThreadRequired: true,
  sandboxRequired: true,
  validationRequired: true,
  oracleRequired: true,
  humanApprovalRequired: true,
  rollbackRequired: true,
};

const ALLOWED_TRANSITIONS: Record<PromotionStatus, PromotionStatus[]> = {
  proposal: ["prepared", "rejected", "blocked"],
  prepared: ["validated", "rejected", "blocked"],
  validated: ["oracle_reviewed", "rejected", "blocked"],
  oracle_reviewed: ["approved", "rejected", "blocked"],
  approved: ["applied", "rejected", "blocked"],
  applied: [],
  rejected: [],
  blocked: ["proposal"],
};

function hasForbiddenBodyKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKey);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKey(child));
}

function isBodyFreeRecord(value: unknown): boolean {
  return isRecord(value) && value.bodyStored === false && value.promptBodiesStored === false && value.outputBodiesStored === false && !hasForbiddenBodyKey(value);
}

function isSafeMetaId(value: string | null | undefined): boolean {
  return value === null || value === undefined || (value.length > 0 && safeFileStem(value) === value);
}

function validateArtifactRef(repoRoot: string, ref: string, label: string): string[] {
  const errors: string[] = [];
  if (typeof ref !== "string" || ref.trim().length === 0) return [`${label} must be a non-empty repo-relative ref`];
  if (ref.includes("\0")) errors.push(`${label} contains NUL byte`);
  if (ref.startsWith("/") || ref.includes("\\") || ref.includes("..")) errors.push(`${label} must be safe repo-relative: ${ref}`);
  const resolved = resolveRepoPath(repoRoot, ref);
  errors.push(...resolved.errors.map((error) => `${label}: ${error}`));
  for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
    if (pathMatches(ref, protectedPattern, repoRoot, repoRoot)) errors.push(`${label} references zero-access path: ${protectedPattern}`);
  }
  if (/(^|\/)(node_modules|dist|build|coverage)(\/|$)/.test(ref)) errors.push(`${label} must not reference generated/vendor path: ${ref}`);
  if (/(^|\/)\.env($|[./])|(^|\/)(\.ssh|\.aws)(\/|$)|secret|credential|\.pem$|\.p12$|\.pfx$/i.test(ref)) errors.push(`${label} must not reference secrets: ${ref}`);
  return errors;
}

function requireExistingArtifactRef(repoRoot: string, ref: unknown, label: string): string[] {
  if (typeof ref !== "string") return [`${label} must be a persisted artifact ref`];
  const errors = validateArtifactRef(repoRoot, ref, label);
  if (errors.length === 0 && !existsSync(resolveRepoPath(repoRoot, ref).path)) errors.push(`${label} does not exist: ${ref}`);
  return errors;
}

function normalizeRepoPath(repoRoot: string, ref: string): string {
  return resolveRepoPath(repoRoot, ref).path.replace(/\/+$/g, "");
}

function pathInsideAny(repoRoot: string, child: string, parents: string[]): boolean {
  if (parents.length === 0) return true;
  const normalizedChild = normalizeRepoPath(repoRoot, child);
  return parents.some((parent) => {
    const normalizedParent = normalizeRepoPath(repoRoot, parent);
    return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
  });
}

function isAtLeast(status: PromotionStatus, minimum: Exclude<PromotionStatus, "rejected" | "blocked">): boolean {
  if (status === "rejected" || status === "blocked") return false;
  return STATUS_ORDER[status] >= STATUS_ORDER[minimum];
}

function mergeGates(input?: Partial<PromotionGates>): PromotionGates {
  return { ...DEFAULT_PROMOTION_GATES, ...(input ?? {}) };
}

export function promotionReportsDir(repoRoot: string): string {
  return join(repoRoot, "reports", "promotions");
}

export function promotionCandidateDir(repoRoot: string, candidateId: string): string {
  return join(promotionReportsDir(repoRoot), safeFileStem(candidateId));
}

export function promotionCandidateRef(candidateId: string, relativePath = "promotion-candidate.json"): string {
  return `reports/promotions/${safeFileStem(candidateId)}/${relativePath}`;
}

function buildCandidateId(input: PromotionCandidateInput): string {
  if (input.candidateId) {
    const safe = safeFileStem(input.candidateId);
    if (safe !== input.candidateId) throw new Error(`Unsafe promotion candidateId: ${input.candidateId}`);
    return safe;
  }
  return `promo_${sha256(`${input.kind}:${input.runId}:${input.sourceRef}:${Date.now()}`).slice(0, 16)}`;
}

export function createPromotionCandidate(input: PromotionCandidateInput): PromotionCandidateRecord {
  const candidateId = buildCandidateId(input);
  const now = new Date().toISOString();
  const changedPaths = [...new Set(input.changedPaths ?? [])].sort();
  const allowedPaths = [...new Set(input.allowedPaths ?? [])].sort();
  const forbiddenPaths = [...new Set(input.forbiddenPaths ?? [])].sort();
  return {
    schema: "zob.promotion-candidate.v1",
    candidateId,
    kind: input.kind,
    runId: input.runId,
    goalId: input.goalId ?? null,
    todoId: input.todoId ?? null,
    status: "proposal",
    sourceRef: input.sourceRef,
    sourceHash: input.sourceHash ?? null,
    preparedArtifactRef: input.preparedArtifactRef ?? null,
    validationRefs: [...new Set(input.validationRefs ?? [])].sort(),
    oracleReviewRef: input.oracleReviewRef ?? null,
    oracleVerdict: input.oracleVerdict ?? null,
    oracleNoShip: input.oracleNoShip ?? null,
    approvalRef: input.approvalRef ?? null,
    rollbackRef: input.rollbackRef ?? null,
    comsThreadRef: input.comsThreadRef ?? null,
    goalRoomMessageRefs: [...new Set(input.goalRoomMessageRefs ?? [])].sort(),
    changedPaths,
    changedPathHashes: changedPaths.map((path) => sha256(path)),
    allowedPaths,
    forbiddenPaths,
    gates: mergeGates(input.gates),
    applyScope: input.applyScope ?? "none",
    applyPerformed: false,
    productionWritesPerformed: false,
    autoApply: false,
    parentOwned: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

export function validatePromotionCandidate(repoRoot: string, candidate: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(candidate)) return ["promotion candidate must be an object"];
  if (!isBodyFreeRecord(candidate)) errors.push("promotion candidate must be body-free/hash-only and must not contain raw body-like keys");
  if (candidate.schema !== "zob.promotion-candidate.v1") errors.push("promotion candidate schema mismatch");
  if (typeof candidate.candidateId !== "string" || safeFileStem(candidate.candidateId) !== candidate.candidateId) errors.push("candidateId must be path-safe");
  if (typeof candidate.runId !== "string" || safeFileStem(candidate.runId) !== candidate.runId) errors.push("runId must be path-safe");
  if (!isSafeMetaId(candidate.goalId as string | null | undefined)) errors.push("goalId must be metadata/path safe when provided");
  if (!isSafeMetaId(candidate.todoId as string | null | undefined)) errors.push("todoId must be metadata/path safe when provided");
  if (typeof candidate.kind !== "string" || !PROMOTION_KINDS.includes(candidate.kind as PromotionKind)) errors.push("invalid promotion kind");
  if (typeof candidate.status !== "string" || !PROMOTION_STATUSES.includes(candidate.status as PromotionStatus)) errors.push("invalid promotion status");
  if (typeof candidate.sourceRef !== "string") errors.push("sourceRef is required");
  else errors.push(...validateArtifactRef(repoRoot, candidate.sourceRef, "sourceRef"));
  if (candidate.sourceHash !== null && candidate.sourceHash !== undefined && !SHA256_HEX.test(String(candidate.sourceHash))) errors.push("sourceHash must be sha256 hex when provided");
  const gates = isRecord(candidate.gates) ? candidate.gates as Partial<PromotionGates> : undefined;
  if (!gates) errors.push("promotion candidate requires gates");
  for (const gateName of ["comsThreadRequired", "sandboxRequired", "validationRequired", "oracleRequired", "humanApprovalRequired", "rollbackRequired"] as const) {
    if (typeof gates?.[gateName] !== "boolean") errors.push(`gate ${gateName} must be boolean`);
  }
  const refs: Array<[unknown, string]> = [
    [candidate.preparedArtifactRef, "preparedArtifactRef"],
    [candidate.oracleReviewRef, "oracleReviewRef"],
    [candidate.approvalRef, "approvalRef"],
    [candidate.rollbackRef, "rollbackRef"],
    [candidate.comsThreadRef, "comsThreadRef"],
  ];
  for (const [ref, label] of refs) {
    if (ref !== null && ref !== undefined) errors.push(...validateArtifactRef(repoRoot, String(ref), label));
  }
  for (const [field, label] of [[candidate.validationRefs, "validationRefs"], [candidate.goalRoomMessageRefs, "goalRoomMessageRefs"], [candidate.changedPaths, "changedPaths"], [candidate.allowedPaths, "allowedPaths"], [candidate.forbiddenPaths, "forbiddenPaths"]] as const) {
    if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) errors.push(`${label} must be a string array`);
    else for (const item of field) errors.push(...validateArtifactRef(repoRoot, item, label));
  }
  if (!Array.isArray(candidate.changedPathHashes) || !candidate.changedPathHashes.every((hash) => typeof hash === "string" && SHA256_HEX.test(hash))) errors.push("changedPathHashes must be sha256 hex array");
  if (Array.isArray(candidate.changedPaths) && Array.isArray(candidate.allowedPaths)) {
    for (const changedPath of candidate.changedPaths.filter((item): item is string => typeof item === "string")) {
      if (!pathInsideAny(repoRoot, changedPath, candidate.allowedPaths.filter((item): item is string => typeof item === "string"))) errors.push(`changed path is outside allowedPaths: ${changedPath}`);
      for (const forbiddenPath of (candidate.forbiddenPaths as unknown[]).filter((item): item is string => typeof item === "string")) {
        if (pathMatches(changedPath, forbiddenPath, repoRoot, repoRoot)) errors.push(`changed path matches forbiddenPaths: ${changedPath}`);
      }
    }
  }
  const status = candidate.status as PromotionStatus;
  if (gates?.comsThreadRequired === true && typeof candidate.comsThreadRef !== "string") errors.push("comsThreadRef is required by gates");
  if (gates?.sandboxRequired === true && isAtLeast(status, "prepared")) errors.push(...requireExistingArtifactRef(repoRoot, candidate.preparedArtifactRef, "preparedArtifactRef"));
  if (gates?.validationRequired === true && isAtLeast(status, "validated")) {
    if (!Array.isArray(candidate.validationRefs) || candidate.validationRefs.length === 0) errors.push("validationRefs are required by validation gate");
    else for (const validationRef of candidate.validationRefs) errors.push(...requireExistingArtifactRef(repoRoot, validationRef, "validationRefs"));
  }
  if (gates?.oracleRequired === true && isAtLeast(status, "oracle_reviewed")) {
    errors.push(...requireExistingArtifactRef(repoRoot, candidate.oracleReviewRef, "oracleReviewRef"));
    if (candidate.oracleVerdict !== "PASS") errors.push("oracle gate requires oracleVerdict=PASS");
    if (candidate.oracleNoShip !== false) errors.push("oracle gate requires oracleNoShip=false");
  }
  if (gates?.comsThreadRequired === true && isAtLeast(status, "approved")) errors.push(...requireExistingArtifactRef(repoRoot, candidate.comsThreadRef, "comsThreadRef"));
  if (gates?.humanApprovalRequired === true && isAtLeast(status, "approved")) errors.push(...requireExistingArtifactRef(repoRoot, candidate.approvalRef, "approvalRef"));
  if (gates?.rollbackRequired === true && status === "applied") errors.push(...requireExistingArtifactRef(repoRoot, candidate.rollbackRef, "rollbackRef"));
  if (!PROMOTION_APPLY_SCOPES.includes(candidate.applyScope as PromotionApplyScope)) errors.push("invalid applyScope");
  if (status === "applied") {
    if (candidate.applyScope !== "quarantine_test_directory") errors.push("applied status is only supported for quarantine_test_directory scope in this runtime slice");
    if (candidate.applyPerformed !== true) errors.push("applied status requires applyPerformed=true");
  } else if (candidate.applyPerformed !== false) {
    errors.push("applyPerformed must remain false until applied status");
  }
  if (candidate.productionWritesPerformed !== false) errors.push("productionWritesPerformed must remain false");
  if (candidate.autoApply !== false) errors.push("autoApply must remain false");
  if (candidate.parentOwned !== true) errors.push("promotion candidate must remain parent-owned");
  return errors;
}

export function transitionAllowed(from: PromotionStatus, to: PromotionStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function advancePromotionCandidate(repoRoot: string, candidate: PromotionCandidateRecord, input: PromotionTransitionInput): PromotionCandidateRecord {
  if (!transitionAllowed(candidate.status, input.toStatus)) throw new Error(`Invalid promotion transition ${candidate.status} -> ${input.toStatus}`);
  const updated: PromotionCandidateRecord = {
    ...candidate,
    status: input.toStatus,
    preparedArtifactRef: input.preparedArtifactRef ?? candidate.preparedArtifactRef,
    validationRefs: [...new Set([...(candidate.validationRefs ?? []), ...(input.validationRefs ?? [])])].sort(),
    oracleReviewRef: input.oracleReviewRef ?? candidate.oracleReviewRef,
    oracleVerdict: input.oracleVerdict ?? candidate.oracleVerdict,
    oracleNoShip: input.oracleNoShip ?? candidate.oracleNoShip,
    approvalRef: input.approvalRef ?? candidate.approvalRef,
    rollbackRef: input.rollbackRef ?? candidate.rollbackRef,
    goalRoomMessageRefs: [...new Set([...(candidate.goalRoomMessageRefs ?? []), ...(input.goalRoomMessageRefs ?? [])])].sort(),
    applyScope: input.applyScope ?? candidate.applyScope,
    applyPerformed: input.applyPerformed ?? (input.toStatus === "applied" ? true : candidate.applyPerformed),
    metadata: { ...candidate.metadata, ...(input.metadata ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  const errors = validatePromotionCandidate(repoRoot, updated);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return updated;
}

export function writePromotionCandidate(repoRoot: string, candidate: PromotionCandidateRecord): string {
  const errors = validatePromotionCandidate(repoRoot, candidate);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const dir = promotionCandidateDir(repoRoot, candidate.candidateId);
  mkdirSync(dir, { recursive: true });
  const relativeRef = promotionCandidateRef(candidate.candidateId);
  writeFileSync(join(dir, "promotion-candidate.json"), JSON.stringify(candidate, null, 2), "utf8");
  appendFileSync(join(dir, "promotion-ledger.jsonl"), `${JSON.stringify({ event: "candidate_written", candidateId: candidate.candidateId, status: candidate.status, applyPerformed: candidate.applyPerformed, productionWritesPerformed: false, autoApply: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, timestamp: new Date().toISOString() })}\n`, "utf8");
  return relativeRef;
}

export function appendPromotionLedger(repoRoot: string, candidateId: string, event: Record<string, unknown>): string {
  const dir = promotionCandidateDir(repoRoot, candidateId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "promotion-ledger.jsonl"), `${JSON.stringify({ ...event, candidateId, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, timestamp: new Date().toISOString() })}\n`, "utf8");
  return promotionCandidateRef(candidateId, "promotion-ledger.jsonl");
}

function latestPromotionIds(repoRoot: string, limit: number): string[] {
  const root = promotionReportsDir(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((entry) => ({ entry, path: join(root, entry), stat: statSync(join(root, entry)) }))
    .filter((item) => item.stat.isDirectory())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, Math.max(1, limit))
    .map((item) => item.entry);
}

export function summarizePromotionCandidates(repoRoot: string, limit = 10): Record<string, unknown> {
  const latest = latestPromotionIds(repoRoot, limit).flatMap((candidateId) => {
    const candidate = readJsonObjectIfPresent(join(promotionCandidateDir(repoRoot, candidateId), "promotion-candidate.json"));
    if (!candidate) return [];
    const errors = validatePromotionCandidate(repoRoot, candidate);
    return [{
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      status: candidate.status,
      runId: candidate.runId,
      todoId: candidate.todoId,
      changedPaths: Array.isArray(candidate.changedPaths) ? candidate.changedPaths : [],
      validationRefs: Array.isArray(candidate.validationRefs) ? candidate.validationRefs : [],
      oracleReviewRef: candidate.oracleReviewRef,
      approvalRef: candidate.approvalRef,
      applyScope: candidate.applyScope,
      applyPerformed: candidate.applyPerformed,
      productionWritesPerformed: candidate.productionWritesPerformed,
      autoApply: candidate.autoApply,
      valid: errors.length === 0,
      errors,
      artifact: promotionCandidateRef(String(candidate.candidateId)),
      bodyStored: false,
    }];
  });
  return {
    latest,
    blocked: latest.filter((entry) => entry.status === "blocked" || (Array.isArray(entry.errors) && entry.errors.length > 0)),
    awaitingOracle: latest.filter((entry) => entry.status === "validated"),
    awaitingApproval: latest.filter((entry) => entry.status === "oracle_reviewed"),
    eligibleApply: latest.filter((entry) => entry.status === "approved"),
    bodySafety: { summariesBodyFree: !hasForbiddenBodyKey(latest) },
    uiReadyMetadataOnly: true,
  };
}

export function promotionTestWorkspaceRef(candidateId: string, suffix = "applied-test-workspace"): string {
  return promotionCandidateRef(candidateId, suffix);
}

export function assertInsidePromotionWorkspace(repoRoot: string, candidateId: string, path: string): void {
  const root = resolve(promotionCandidateDir(repoRoot, candidateId));
  const resolved = resolve(repoRoot, path);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error(`Path must stay inside promotion workspace: ${path}`);
}
