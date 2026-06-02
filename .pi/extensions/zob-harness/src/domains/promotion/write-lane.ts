import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { sha256 } from "../../core/utils/hashing.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import { advancePromotionCandidate, createPromotionCandidate, promotionCandidateDir, promotionCandidateRef, validatePromotionCandidate, writePromotionCandidate } from "./candidate.js";
import type { PromotionCandidateRecord } from "./types.js";

export interface WriteLaneChangeInput {
  path: string;
  draftText: string;
}

export interface PrepareWriteLanePromotionInput {
  candidateId?: string;
  runId: string;
  goalId?: string;
  todoId?: string;
  sourceRef: string;
  allowedPaths: string[];
  forbiddenPaths?: string[];
  changes: WriteLaneChangeInput[];
}

function validateLogicalPath(path: string): string[] {
  const errors: string[] = [];
  if (typeof path !== "string" || path.trim().length === 0) return ["path must be non-empty"];
  if (path.startsWith("/") || path.includes("..") || path.includes("\\") || path.includes("\0")) errors.push(`path must be safe relative: ${path}`);
  if (/(^|\/)\.env($|[./])|(^|\/)(\.ssh|\.aws)(\/|$)|secret|credential|\.pem$|\.p12$|\.pfx$/i.test(path)) errors.push(`path must not reference secrets: ${path}`);
  return errors;
}

function insideAnyLogical(child: string, parents: string[]): boolean {
  const c = child.replace(/\/+$/g, "");
  return parents.some((parent) => {
    const p = parent.replace(/\/+$/g, "");
    return c === p || c.startsWith(`${p}/`);
  });
}

function pathMatchesForbidden(path: string, forbiddenPaths: string[]): boolean {
  return forbiddenPaths.some((forbidden) => path === forbidden || path.startsWith(`${forbidden.replace(/\/+$/g, "")}/`) || new RegExp(forbidden.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).test(path));
}

export function prepareWriteLanePromotion(repoRoot: string, input: PrepareWriteLanePromotionInput): { candidate: PromotionCandidateRecord; sandboxRootRef: string; diffMetadataRef: string; rollbackRef: string; validationRef: string } {
  if (!Array.isArray(input.allowedPaths) || input.allowedPaths.length === 0) throw new Error("write lane requires explicit allowedPaths");
  const pathErrors = [
    ...input.allowedPaths.flatMap(validateLogicalPath),
    ...(input.forbiddenPaths ?? []).flatMap(validateLogicalPath),
    ...input.changes.flatMap((change) => validateLogicalPath(change.path)),
  ];
  for (const change of input.changes) {
    if (!insideAnyLogical(change.path, input.allowedPaths)) pathErrors.push(`write lane change outside allowedPaths: ${change.path}`);
    if (pathMatchesForbidden(change.path, input.forbiddenPaths ?? [])) pathErrors.push(`write lane change matches forbiddenPaths: ${change.path}`);
  }
  if (pathErrors.length > 0) throw new Error(pathErrors.join("; "));
  const preliminary = createPromotionCandidate({
    candidateId: input.candidateId,
    kind: "write_lane",
    runId: input.runId,
    goalId: input.goalId,
    todoId: input.todoId,
    sourceRef: input.sourceRef,
    comsThreadRef: input.candidateId ? promotionCandidateRef(input.candidateId, "promotion-coms-thread.json") : undefined,
    metadata: { lane: "write_lane", logicalAllowedPaths: input.allowedPaths, logicalForbiddenPaths: input.forbiddenPaths ?? [] },
  });
  const sandboxRootRef = promotionCandidateRef(preliminary.candidateId, "write-lane/sandbox");
  const sandboxRoot = join(repoRoot, sandboxRootRef);
  const changedPaths: string[] = [];
  const fileRecords = input.changes.map((change) => {
    const safeParts = change.path.split("/").map((part) => safeFileStem(part));
    const relativeSandboxPath = safeParts.join("/");
    const targetRef = `${sandboxRootRef}/${relativeSandboxPath}`;
    const targetPath = join(repoRoot, targetRef);
    const resolvedTarget = resolve(targetPath);
    const resolvedSandbox = resolve(sandboxRoot);
    if (resolvedTarget !== resolvedSandbox && !resolvedTarget.startsWith(`${resolvedSandbox}/`)) throw new Error(`sandbox write escaped sandbox root: ${change.path}`);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, change.draftText, "utf8");
    changedPaths.push(targetRef);
    return {
      logicalPath: change.path,
      sandboxRef: targetRef,
      contentHash: sha256(change.draftText),
      bodyStored: false,
    };
  });
  const diffHash = sha256(JSON.stringify(fileRecords.map((record) => [record.logicalPath, record.sandboxRef, record.contentHash])));
  const diffMetadata = {
    schema: "zob.write-lane-diff-metadata.v1",
    candidateId: preliminary.candidateId,
    sandboxRootRef,
    changedPaths,
    fileRecords,
    diffHash,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const rollback = {
    schema: "zob.write-lane-rollback-metadata.v1",
    candidateId: preliminary.candidateId,
    rollbackStrategy: "delete_quarantine_test_workspace_or_discard_merge_candidate",
    sandboxRootRef,
    rollbackHash: sha256(JSON.stringify({ sandboxRootRef, changedPaths, diffHash })),
    productionWritesPerformed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const candidateDir = promotionCandidateDir(repoRoot, preliminary.candidateId);
  mkdirSync(join(candidateDir, "write-lane"), { recursive: true });
  const diffMetadataRef = promotionCandidateRef(preliminary.candidateId, "write-lane/diff-metadata.json");
  const rollbackRef = promotionCandidateRef(preliminary.candidateId, "write-lane/rollback.json");
  writeFileSync(join(repoRoot, diffMetadataRef), JSON.stringify(diffMetadata, null, 2), "utf8");
  writeFileSync(join(repoRoot, rollbackRef), JSON.stringify(rollback, null, 2), "utf8");
  const validationErrors = validateWriteLaneDiffMetadata(diffMetadata);
  const validationRef = promotionCandidateRef(preliminary.candidateId, "write-lane/validation.json");
  writeFileSync(join(repoRoot, validationRef), JSON.stringify({ schema: "zob.write-lane-validation.v1", candidateId: preliminary.candidateId, valid: validationErrors.length === 0, errors: validationErrors, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  const candidate: PromotionCandidateRecord = {
    ...preliminary,
    changedPaths: changedPaths.sort(),
    changedPathHashes: changedPaths.sort().map((path) => sha256(path)),
    allowedPaths: [sandboxRootRef],
    forbiddenPaths: [],
    comsThreadRef: promotionCandidateRef(preliminary.candidateId, "promotion-coms-thread.json"),
    metadata: { ...preliminary.metadata, diffHash, sandboxRootRef, logicalAllowedPaths: input.allowedPaths, logicalForbiddenPaths: input.forbiddenPaths ?? [] },
  };
  const prepared = advancePromotionCandidate(repoRoot, candidate, { toStatus: "prepared", preparedArtifactRef: diffMetadataRef, validationRefs: validationErrors.length === 0 ? [validationRef] : [], rollbackRef });
  writePromotionCandidate(repoRoot, prepared);
  return { candidate: prepared, sandboxRootRef, diffMetadataRef, rollbackRef, validationRef };
}

export function validateWriteLaneDiffMetadata(artifact: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(artifact)) return ["write-lane diff metadata must be an object"];
  if (artifact.schema !== "zob.write-lane-diff-metadata.v1") errors.push("write-lane diff metadata schema mismatch");
  if (!Array.isArray(artifact.changedPaths) || artifact.changedPaths.length === 0) errors.push("write lane requires changedPaths");
  if (typeof artifact.diffHash !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.diffHash)) errors.push("write lane requires diffHash");
  if (artifact.productionWritesPerformed !== false || artifact.autoApply !== false) errors.push("write lane preparation must not perform production writes or auto-apply");
  if (artifact.bodyStored !== false || artifact.promptBodiesStored !== false || artifact.outputBodiesStored !== false) errors.push("write-lane diff metadata must keep body flags false");
  return errors;
}

export function markWriteLaneAppliedInQuarantine(repoRoot: string, candidate: PromotionCandidateRecord): PromotionCandidateRecord {
  if (candidate.kind !== "write_lane") throw new Error("candidate kind must be write_lane");
  if (candidate.status !== "approved") throw new Error("write lane quarantine apply requires approved candidate");
  const applied = advancePromotionCandidate(repoRoot, candidate, { toStatus: "applied", applyScope: "quarantine_test_directory", applyPerformed: true });
  writePromotionCandidate(repoRoot, applied);
  return applied;
}

export function validateWriteLanePromotionCandidate(repoRoot: string, candidate: PromotionCandidateRecord): string[] {
  const errors = validatePromotionCandidate(repoRoot, candidate);
  if (candidate.kind !== "write_lane") errors.push("candidate kind must be write_lane");
  if (candidate.productionWritesPerformed !== false || candidate.autoApply !== false) errors.push("write lane candidate must not perform production writes or auto-apply");
  if (!String(candidate.metadata?.sandboxRootRef ?? "").startsWith(`reports/promotions/${candidate.candidateId}/write-lane/sandbox`)) errors.push("write lane sandboxRootRef must stay inside candidate promotion workspace");
  return errors;
}
