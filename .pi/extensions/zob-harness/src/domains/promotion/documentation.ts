import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256 } from "../../core/utils/hashing.js";
import { resolveRepoPath, safeFileStem } from "../../core/utils/paths.js";
import { parseJsonFile } from "../../core/utils/json.js";
import { isRecord } from "../../core/utils/records.js";
import { advancePromotionCandidate, createPromotionCandidate, promotionCandidateDir, promotionCandidateRef, validatePromotionCandidate, writePromotionCandidate } from "./candidate.js";
import type { PromotionCandidateRecord } from "./types.js";

export interface DocumentationPromotionDraft {
  targetPath: string;
  draftText: string;
  reason?: string;
}

export interface PrepareDocumentationPromotionInput {
  candidateId?: string;
  runId: string;
  goalId?: string;
  todoId?: string;
  sourceRef: string;
  drafts: DocumentationPromotionDraft[];
  approvalMode?: "proposal_only" | "auto_prepare_patch";
}

const SENSITIVE_DOC_PATTERNS = [/^AGENTS\.md$/, /^docs\//, /^\.pi\/(rules|skills|prompts|agents|output-contracts)\//];

function hasForbiddenRawKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenRawKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => ["body", "task", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch", "transcript", "rawContext", "rawPrompt"].includes(key) || hasForbiddenRawKeys(child));
}

function validateTargetPath(repoRoot: string, path: string): string[] {
  const errors: string[] = [];
  const resolved = resolveRepoPath(repoRoot, path);
  errors.push(...resolved.errors.map((error) => `targetPath: ${error}`));
  if (path.includes("\0") || path.startsWith("/") || path.includes("..") || path.includes("\\")) errors.push(`targetPath must be safe repo-relative: ${path}`);
  if (/(^|\/)\.env($|[./])|secret|credential|\.pem$|\.p12$|\.pfx$/i.test(path)) errors.push(`targetPath must not reference secrets: ${path}`);
  if (!SENSITIVE_DOC_PATTERNS.some((pattern) => pattern.test(path))) errors.push(`documentation promotion target must be a docs/guidance path: ${path}`);
  return errors;
}

export function prepareDocumentationPromotion(repoRoot: string, input: PrepareDocumentationPromotionInput): { candidate: PromotionCandidateRecord; preparedArtifactRef: string; draftRefs: string[]; validationRef: string } {
  const targetErrors = input.drafts.flatMap((draft) => validateTargetPath(repoRoot, draft.targetPath));
  if (targetErrors.length > 0) throw new Error(targetErrors.join("; "));
  const candidate = createPromotionCandidate({
    candidateId: input.candidateId,
    kind: "documentation_writeback",
    runId: input.runId,
    goalId: input.goalId,
    todoId: input.todoId,
    sourceRef: input.sourceRef,
    allowedPaths: [...new Set(input.drafts.map((draft) => draft.targetPath.split("/").slice(0, -1).join("/") || draft.targetPath))],
    changedPaths: input.drafts.map((draft) => draft.targetPath),
    comsThreadRef: input.candidateId ? promotionCandidateRef(input.candidateId, "promotion-coms-thread.json") : undefined,
    metadata: { lane: "documentation", approvalMode: input.approvalMode ?? "auto_prepare_patch" },
  });
  const candidateDir = promotionCandidateDir(repoRoot, candidate.candidateId);
  const draftRefs: string[] = [];
  const draftRecords = input.drafts.map((draft) => {
    const draftRef = promotionCandidateRef(candidate.candidateId, `documentation/quarantine/${safeFileStem(draft.targetPath)}.draft.md`);
    const draftPath = join(repoRoot, draftRef);
    mkdirSync(dirname(draftPath), { recursive: true });
    writeFileSync(draftPath, draft.draftText, "utf8");
    draftRefs.push(draftRef);
    return {
      targetPath: draft.targetPath,
      targetPathHash: sha256(draft.targetPath),
      draftRef,
      draftHash: sha256(draft.draftText),
      reasonHash: draft.reason ? sha256(draft.reason) : null,
      bodyStored: false,
    };
  });
  const preparedArtifact = {
    schema: "zob.documentation-promotion-prepared.v1",
    candidateId: candidate.candidateId,
    approvalMode: input.approvalMode ?? "auto_prepare_patch",
    draftRecords,
    changedPaths: candidate.changedPaths,
    patchHash: sha256(JSON.stringify(draftRecords.map((record) => [record.targetPathHash, record.draftHash]))),
    durableApplyPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const preparedArtifactRef = promotionCandidateRef(candidate.candidateId, "documentation/prepared.json");
  mkdirSync(join(candidateDir, "documentation"), { recursive: true });
  writeFileSync(join(repoRoot, preparedArtifactRef), JSON.stringify(preparedArtifact, null, 2), "utf8");
  const validation = validateDocumentationPromotion(preparedArtifact);
  const validationRef = promotionCandidateRef(candidate.candidateId, "documentation/validation.json");
  writeFileSync(join(repoRoot, validationRef), JSON.stringify({ schema: "zob.documentation-promotion-validation.v1", candidateId: candidate.candidateId, valid: validation.length === 0, errors: validation, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  const prepared = advancePromotionCandidate(repoRoot, { ...candidate, comsThreadRef: promotionCandidateRef(candidate.candidateId, "promotion-coms-thread.json") }, { toStatus: "prepared", preparedArtifactRef, validationRefs: validation.length === 0 ? [validationRef] : [], metadata: { draftRefs } });
  writePromotionCandidate(repoRoot, prepared);
  return { candidate: prepared, preparedArtifactRef, draftRefs, validationRef };
}

export function validateDocumentationPromotion(artifact: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(artifact)) return ["documentation promotion artifact must be an object"];
  if (artifact.schema !== "zob.documentation-promotion-prepared.v1") errors.push("documentation promotion artifact schema mismatch");
  if (hasForbiddenRawKeys(artifact)) errors.push("documentation promotion artifact must not include raw body-like keys");
  if (!Array.isArray(artifact.draftRecords) || artifact.draftRecords.length === 0) errors.push("documentation promotion requires draftRecords");
  if (artifact.durableApplyPerformed !== false || artifact.autoApply !== false) errors.push("documentation promotion must not auto-apply durable docs");
  if (artifact.bodyStored !== false || artifact.promptBodiesStored !== false || artifact.outputBodiesStored !== false) errors.push("documentation promotion artifact must keep body flags false");
  if (typeof artifact.patchHash !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.patchHash)) errors.push("documentation promotion requires patchHash");
  return errors;
}

export function applyDocumentationPromotionInQuarantine(repoRoot: string, candidate: PromotionCandidateRecord): { candidate: PromotionCandidateRecord; appliedRefs: string[]; appliedMetadataRef: string } {
  if (candidate.kind !== "documentation_writeback") throw new Error("candidate kind must be documentation_writeback");
  if (candidate.status !== "approved") throw new Error("documentation quarantine apply requires approved candidate");
  if (!candidate.preparedArtifactRef) throw new Error("documentation quarantine apply requires preparedArtifactRef");
  const prepared = parseJsonFile(join(repoRoot, candidate.preparedArtifactRef));
  if (!isRecord(prepared) || !Array.isArray(prepared.draftRecords)) throw new Error("documentation prepared artifact missing draftRecords");
  const appliedRefs: string[] = [];
  for (const record of prepared.draftRecords.filter(isRecord)) {
    const targetPath = typeof record.targetPath === "string" ? record.targetPath : "unknown.md";
    const draftRef = typeof record.draftRef === "string" ? record.draftRef : undefined;
    if (!draftRef) throw new Error("draftRef missing from documentation prepared artifact");
    const draftText = readFileSync(join(repoRoot, draftRef), "utf8");
    const appliedRef = promotionCandidateRef(candidate.candidateId, `documentation/applied-test-workspace/${safeFileStem(targetPath)}.md`);
    mkdirSync(dirname(join(repoRoot, appliedRef)), { recursive: true });
    writeFileSync(join(repoRoot, appliedRef), draftText, "utf8");
    appliedRefs.push(appliedRef);
  }
  const appliedMetadataRef = promotionCandidateRef(candidate.candidateId, "documentation/applied-test-workspace/apply-metadata.json");
  writeFileSync(join(repoRoot, appliedMetadataRef), JSON.stringify({ schema: "zob.documentation-quarantine-apply.v1", candidateId: candidate.candidateId, appliedRefs, productionWritesPerformed: false, autoApply: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  const applied = advancePromotionCandidate(repoRoot, candidate, { toStatus: "applied", applyScope: "quarantine_test_directory", applyPerformed: true });
  writePromotionCandidate(repoRoot, applied);
  return { candidate: applied, appliedRefs, appliedMetadataRef };
}

export function validateDocumentationPromotionCandidate(repoRoot: string, candidate: PromotionCandidateRecord): string[] {
  const errors = validatePromotionCandidate(repoRoot, candidate);
  if (candidate.kind !== "documentation_writeback") errors.push("candidate kind must be documentation_writeback");
  if (candidate.autoApply !== false || candidate.productionWritesPerformed !== false) errors.push("documentation candidate must not auto-apply or perform production writes");
  return errors;
}
