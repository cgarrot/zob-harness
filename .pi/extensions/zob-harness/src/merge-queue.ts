import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RULES } from "./constants.js";
import type { TeamDefinition } from "./types.js";
import { sha256 } from "./utils/hashing.js";
import { readJsonl } from "./utils/json.js";
import { pathMatches, resolveRepoPath, safeFileStem } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

export type MergeCandidatePriority = "low" | "normal" | "high" | "critical";
export type MergeCandidateRisk = "low" | "medium" | "high";
export type MergeDecision = "approve_for_manual_apply" | "reject" | "needs_oracle";

export interface MergeCandidateInput {
  run_id: string;
  submitted_by: string;
  sandbox_run_id: string;
  workspace_claim_ids: string[];
  changed_paths: string[];
  diff_hash: string;
  validation_refs: string[];
  summary_hash?: string;
  todo_id?: string;
  oracle_review_ref?: string;
  rollback_ref?: string;
  priority?: MergeCandidatePriority;
  risk_level?: MergeCandidateRisk;
}

export interface MergeDecisionInput {
  candidate_id: string;
  decided_by: string;
  decision: MergeDecision;
  reason_hash: string;
  oracle_review_ref?: string;
}

export interface MergeQueueListInput {
  run_id?: string;
  submitted_by?: string;
  status?: string;
  limit?: number;
}

export interface MergeCandidateRecord {
  schema: "zob.merge-candidate.v1";
  candidateId: string;
  runId: string;
  submittedBy: string;
  todoId: string | null;
  sandboxRunId: string;
  workspaceClaimIds: string[];
  changedPaths: string[];
  changedPathHashes: string[];
  diffHash: string;
  validationRefs: string[];
  oracleReviewRef: string | null;
  rollbackRef: string | null;
  summaryHash: string | null;
  priority: MergeCandidatePriority;
  riskLevel: MergeCandidateRisk;
  status: "queued";
  parentOwnedQueue: true;
  sequentialApplyRequired: true;
  oracleReviewRequired: boolean;
  humanApprovalRequired: true;
  applyPerformed: false;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  queuedAt: string;
}

export interface MergeDecisionRecord {
  schema: "zob.merge-decision.v1";
  decisionId: string;
  candidateId: string;
  decidedBy: string;
  decision: MergeDecision;
  reasonHash: string;
  oracleReviewRef: string | null;
  parentOwnedDecision: true;
  manualApplyOnly: true;
  applyPerformed: false;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  decidedAt: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const PRIORITIES = new Set<MergeCandidatePriority>(["low", "normal", "high", "critical"]);
const RISKS = new Set<MergeCandidateRisk>(["low", "medium", "high"]);
const DECISIONS = new Set<MergeDecision>(["approve_for_manual_apply", "reject", "needs_oracle"]);

function mergeQueueDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "merge-queue");
}

function candidatesDir(repoRoot: string): string {
  return join(mergeQueueDir(repoRoot), "candidates");
}

function candidatesPath(repoRoot: string): string {
  return join(mergeQueueDir(repoRoot), "candidates.jsonl");
}

function decisionsPath(repoRoot: string): string {
  return join(mergeQueueDir(repoRoot), "decisions.jsonl");
}

function eventsPath(repoRoot: string): string {
  return join(mergeQueueDir(repoRoot), "events.jsonl");
}

function knownRoleIds(definition: TeamDefinition): Set<string> {
  return new Set([definition.orchestrator.id, ...definition.leads.map((lead) => lead.id), ...definition.workers.map((worker) => worker.id), "parent", "mission-control"]);
}

function appendMergeEvent(repoRoot: string, event: Record<string, unknown>): void {
  mkdirSync(mergeQueueDir(repoRoot), { recursive: true });
  appendFileSync(eventsPath(repoRoot), `${JSON.stringify({ ...event, timestamp: new Date().toISOString(), bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, applyPerformed: false, productionWritesPerformed: false, autoApply: false })}\n`, "utf8");
}

function validateRef(repoRoot: string, ref: string, label: string): string[] {
  const errors: string[] = [];
  if (typeof ref !== "string" || ref.trim().length === 0) return [`${label} contains an empty ref`];
  if (ref.includes("\0")) errors.push(`${label} contains NUL byte: ${ref}`);
  const resolved = resolveRepoPath(repoRoot, ref);
  errors.push(...resolved.errors.map((error) => `${label}: ${error}`));
  for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
    if (pathMatches(ref, protectedPattern, repoRoot, repoRoot)) errors.push(`${label} references zero-access path: ${protectedPattern}`);
  }
  return errors;
}

function validateCandidateInput(repoRoot: string, definition: TeamDefinition, input: MergeCandidateInput): string[] {
  const errors: string[] = [];
  if (!input.run_id || safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (input.todo_id && safeFileStem(input.todo_id) !== input.todo_id) errors.push(`todo_id must be path-safe: ${input.todo_id}`);
  if (!input.sandbox_run_id || safeFileStem(input.sandbox_run_id) !== input.sandbox_run_id) errors.push(`sandbox_run_id must be path-safe: ${input.sandbox_run_id}`);
  if (!knownRoleIds(definition).has(input.submitted_by)) errors.push(`Unknown merge candidate submitter '${input.submitted_by}'`);
  if (!Array.isArray(input.workspace_claim_ids) || input.workspace_claim_ids.length === 0) errors.push("merge candidate requires workspace_claim_ids");
  for (const claimId of input.workspace_claim_ids ?? []) {
    if (!claimId || safeFileStem(claimId) !== claimId) errors.push(`workspace claim id must be path-safe: ${claimId}`);
  }
  if (!Array.isArray(input.changed_paths) || input.changed_paths.length === 0) errors.push("merge candidate requires changed_paths");
  if (input.changed_paths.length > 100) errors.push("merge candidate changed_paths are capped at 100");
  for (const changedPath of input.changed_paths ?? []) errors.push(...validateRef(repoRoot, changedPath, "changed_paths"));
  if (!SHA256_HEX.test(input.diff_hash)) errors.push("merge candidate diff_hash must be sha256 hex");
  if (input.summary_hash !== undefined && !SHA256_HEX.test(input.summary_hash)) errors.push("merge candidate summary_hash must be sha256 hex");
  if (!Array.isArray(input.validation_refs) || input.validation_refs.length === 0) errors.push("merge candidate requires validation_refs");
  for (const ref of input.validation_refs ?? []) errors.push(...validateRef(repoRoot, ref, "validation_refs"));
  if (input.oracle_review_ref) errors.push(...validateRef(repoRoot, input.oracle_review_ref, "oracle_review_ref"));
  if (input.rollback_ref) errors.push(...validateRef(repoRoot, input.rollback_ref, "rollback_ref"));
  if (input.priority !== undefined && !PRIORITIES.has(input.priority)) errors.push("merge candidate priority must be low|normal|high|critical");
  if (input.risk_level !== undefined && !RISKS.has(input.risk_level)) errors.push("merge candidate risk_level must be low|medium|high");
  return errors;
}

function readCandidates(repoRoot: string): MergeCandidateRecord[] {
  return readJsonl(candidatesPath(repoRoot)).filter(isMergeCandidateRecord).map((record) => record as unknown as MergeCandidateRecord);
}

function readDecisions(repoRoot: string): MergeDecisionRecord[] {
  return readJsonl(decisionsPath(repoRoot)).filter(isMergeDecisionRecord).map((record) => record as unknown as MergeDecisionRecord);
}

function latestDecision(candidateId: string, decisions: MergeDecisionRecord[]): MergeDecisionRecord | undefined {
  return decisions.filter((decision) => decision.candidateId === candidateId).at(-1);
}

export function submitMergeCandidate(repoRoot: string, definition: TeamDefinition, input: MergeCandidateInput): MergeCandidateRecord {
  const errors = validateCandidateInput(repoRoot, definition, input);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const now = Date.now();
  const changedPaths = [...new Set(input.changed_paths)].sort();
  const candidateId = `merge_${sha256(`${input.run_id}:${input.submitted_by}:${input.sandbox_run_id}:${input.diff_hash}:${now}`).slice(0, 16)}`;
  const candidate: MergeCandidateRecord = {
    schema: "zob.merge-candidate.v1",
    candidateId,
    runId: input.run_id,
    submittedBy: input.submitted_by,
    todoId: input.todo_id ?? null,
    sandboxRunId: input.sandbox_run_id,
    workspaceClaimIds: [...new Set(input.workspace_claim_ids)].sort(),
    changedPaths,
    changedPathHashes: changedPaths.map((path) => sha256(path)),
    diffHash: input.diff_hash,
    validationRefs: [...new Set(input.validation_refs)].sort(),
    oracleReviewRef: input.oracle_review_ref ?? null,
    rollbackRef: input.rollback_ref ?? null,
    summaryHash: input.summary_hash ?? null,
    priority: input.priority ?? "normal",
    riskLevel: input.risk_level ?? "medium",
    status: "queued",
    parentOwnedQueue: true,
    sequentialApplyRequired: true,
    oracleReviewRequired: input.oracle_review_ref === undefined,
    humanApprovalRequired: true,
    applyPerformed: false,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    queuedAt: new Date(now).toISOString(),
  };
  mkdirSync(candidatesDir(repoRoot), { recursive: true });
  appendFileSync(candidatesPath(repoRoot), `${JSON.stringify(candidate)}\n`, "utf8");
  writeFileSync(join(candidatesDir(repoRoot), `${candidateId}.json`), JSON.stringify(candidate, null, 2), "utf8");
  appendMergeEvent(repoRoot, { event: "candidate_queued", candidateId, runId: candidate.runId, submittedBy: candidate.submittedBy, applyPerformed: false, productionWritesPerformed: false, autoApply: false });
  return candidate;
}

export function decideMergeCandidate(repoRoot: string, definition: TeamDefinition, input: MergeDecisionInput): MergeDecisionRecord {
  if (!input.candidate_id || safeFileStem(input.candidate_id) !== input.candidate_id) throw new Error(`candidate_id must be path-safe: ${input.candidate_id}`);
  if (!knownRoleIds(definition).has(input.decided_by)) throw new Error(`Unknown merge decision actor '${input.decided_by}'`);
  if (!DECISIONS.has(input.decision)) throw new Error("merge decision must be approve_for_manual_apply|reject|needs_oracle");
  if (!SHA256_HEX.test(input.reason_hash)) throw new Error("merge decision reason_hash must be sha256 hex");
  const candidate = readCandidates(repoRoot).find((item) => item.candidateId === input.candidate_id);
  if (!candidate) throw new Error(`merge candidate not found: ${input.candidate_id}`);
  const errors = input.oracle_review_ref ? validateRef(repoRoot, input.oracle_review_ref, "oracle_review_ref") : [];
  if (input.decision === "approve_for_manual_apply" && !input.oracle_review_ref && candidate.oracleReviewRequired) errors.push("approve_for_manual_apply requires oracle_review_ref when candidate lacks prior oracle review");
  if (errors.length > 0) throw new Error(errors.join("; "));
  const decision: MergeDecisionRecord = {
    schema: "zob.merge-decision.v1",
    decisionId: `mdecision_${sha256(`${input.candidate_id}:${input.decided_by}:${input.decision}:${Date.now()}`).slice(0, 16)}`,
    candidateId: input.candidate_id,
    decidedBy: input.decided_by,
    decision: input.decision,
    reasonHash: input.reason_hash,
    oracleReviewRef: input.oracle_review_ref ?? null,
    parentOwnedDecision: true,
    manualApplyOnly: true,
    applyPerformed: false,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    decidedAt: new Date().toISOString(),
  };
  mkdirSync(mergeQueueDir(repoRoot), { recursive: true });
  appendFileSync(decisionsPath(repoRoot), `${JSON.stringify(decision)}\n`, "utf8");
  appendMergeEvent(repoRoot, { event: "decision_recorded", candidateId: decision.candidateId, decision: decision.decision, applyPerformed: false, productionWritesPerformed: false, autoApply: false });
  return decision;
}

export function listMergeQueue(repoRoot: string, input: MergeQueueListInput = {}): Array<MergeCandidateRecord & { latestDecision?: MergeDecisionRecord }> {
  const decisions = readDecisions(repoRoot);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  return readCandidates(repoRoot)
    .map((candidate) => ({ ...candidate, latestDecision: latestDecision(candidate.candidateId, decisions) }))
    .filter((candidate) => !input.run_id || candidate.runId === input.run_id)
    .filter((candidate) => !input.submitted_by || candidate.submittedBy === input.submitted_by)
    .filter((candidate) => !input.status || candidate.latestDecision?.decision === input.status || (!candidate.latestDecision && candidate.status === input.status))
    .slice(-limit);
}

export function mergeQueueBodyFreeViolations(value: unknown): string[] {
  const forbidden = new Set(["body", "task", "prompt", "output", "content", "patch", "diff"]);
  const violations: string[] = [];
  const visit = (item: unknown, path: string): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (forbidden.has(key)) violations.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "root");
  return violations;
}

export function isMergeCandidateRecord(value: unknown): value is MergeCandidateRecord {
  return isRecord(value) && value.schema === "zob.merge-candidate.v1" && typeof value.candidateId === "string" && value.bodyStored === false && value.applyPerformed === false && value.autoApply === false;
}

export function isMergeDecisionRecord(value: unknown): value is MergeDecisionRecord {
  return isRecord(value) && value.schema === "zob.merge-decision.v1" && typeof value.candidateId === "string" && value.bodyStored === false && value.applyPerformed === false && value.autoApply === false;
}
