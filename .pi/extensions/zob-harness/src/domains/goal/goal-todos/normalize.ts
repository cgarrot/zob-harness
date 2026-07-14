import type { GoalRoomTodoReducerDecision, GoalTodoArtifacts, GoalTodoClaimRef, GoalTodoClaimResolutionBinding, GoalTodoClaimValidationRef, GoalTodoDelegationAttempt, GoalTodoDelegationAttemptReasonCode, GoalTodoDelegationAttemptStatus, GoalTodoDelegationLivenessProof, GoalTodoDelegationRecovery, GoalTodoDelegationRef, GoalTodoEvent, GoalTodoLegacyEvent, GoalTodoNode, GoalTodoPatchClearField, GoalTodoPolicy, GoalTodoRevisionDiagnostic, GoalTodoState, GoalTodoStatus } from "../goal-todo-types.js";
import { type ZcommitChildChangedPathRef } from "../../git/git-ops.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { isRecord } from "../../../core/utils/records.js";
import { VALID_CHILD_GOAL_STATUS, VALID_DELEGATION_STATUS, VALID_OWNER, VALID_PRIORITY, VALID_STATUS, VALID_STATUS_CLAIM, VALID_TARGET_READINESS, VALID_VALIDATION_ACTION, VALID_VALIDATION_CONFIDENCE, VALID_VALIDATION_STATUS, VALID_VALIDATION_VERDICT, ZOB_GOAL_TODO_ENTRY_TYPE } from "./constants.js";
import { hasOnlyNoneLike, renumberGoalPaths } from "./operations.js";
import { createGoalMutationReceiptState, finalizeGoalMutationReceiptRestore, indexGoalMutationReceiptEntry } from "../mutation-cas.js";

const GOAL_TODO_PATCH_CLEAR_FIELDS = new Set<GoalTodoPatchClearField>(["parentId", "descriptionHash", "delegation", "claim", "validation", "contextScopeId", "contextPackRef", "freshness", "blocker", "skipReason", "reviewNoShip"]);

export function defaultGoalTodoPolicy(): GoalTodoPolicy {
  return {
    maxTodoDepth: 6,
    maxDelegationDepth: 4,
    maxChildrenPerTodo: 8,
    maxOpenTodos: 80,
    requireEvidenceForCritical: true,
    parentOwnedClaims: true,
    oracleBeforeGoalComplete: true,
  };
}

export function createGoalTodoState(): GoalTodoState {
  return { nodes: [], policy: defaultGoalTodoPolicy(), graphRevisions: {}, revisionDiagnostics: [], restoreBlocked: {}, mutationReceipts: createGoalMutationReceiptState() };
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function includesString<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function cloneNode(node: GoalTodoNode): GoalTodoNode {
  return {
    ...node,
    acceptanceCriteria: [...node.acceptanceCriteria],
    evidenceRefs: [...node.evidenceRefs],
    validationCommands: [...node.validationCommands],
    delegationAttempts: node.delegationAttempts?.map(cloneDelegationAttempt),
    delegation: node.delegation ? { ...node.delegation } : undefined,
    claim: node.claim ? { ...node.claim, acceptanceBlockers: [...node.claim.acceptanceBlockers], childChangedPaths: node.claim.childChangedPaths ? node.claim.childChangedPaths.map((ref) => ({ ...ref })) : undefined } : undefined,
    validation: node.validation ? { ...node.validation, evidenceRefs: [...node.validation.evidenceRefs], validationCommands: [...node.validation.validationCommands], blockingIssues: [...node.validation.blockingIssues] } : undefined,
    artifacts: node.artifacts
      ? {
        reports: node.artifacts.reports ? [...node.artifacts.reports] : undefined,
        checkpoints: node.artifacts.checkpoints ? [...node.artifacts.checkpoints] : undefined,
        sentinels: node.artifacts.sentinels ? [...node.artifacts.sentinels] : undefined,
        taskHash: node.artifacts.taskHash,
        outputHash: node.artifacts.outputHash,
      }
      : undefined,
    citations: node.citations ? [...node.citations] : undefined,
  };
}

export function clonePolicy(policy: GoalTodoPolicy): GoalTodoPolicy {
  return { ...policy };
}

export function normalizePolicy(value: unknown): GoalTodoPolicy | undefined {
  if (!isRecord(value)) return undefined;
  return {
    maxTodoDepth: Math.max(1, Math.trunc(numberField(value, "maxTodoDepth") ?? defaultGoalTodoPolicy().maxTodoDepth)),
    maxDelegationDepth: Math.max(1, Math.trunc(numberField(value, "maxDelegationDepth") ?? defaultGoalTodoPolicy().maxDelegationDepth)),
    maxChildrenPerTodo: Math.max(1, Math.trunc(numberField(value, "maxChildrenPerTodo") ?? defaultGoalTodoPolicy().maxChildrenPerTodo)),
    maxOpenTodos: Math.max(1, Math.trunc(numberField(value, "maxOpenTodos") ?? defaultGoalTodoPolicy().maxOpenTodos)),
    requireEvidenceForCritical: true,
    parentOwnedClaims: true,
    oracleBeforeGoalComplete: true,
  };
}

export function normalizeDelegation(value: unknown): GoalTodoDelegationRef | undefined {
  if (!isRecord(value)) return undefined;
  const status = includesString(VALID_DELEGATION_STATUS, value.status) ? value.status : "running";
  return {
    attemptId: typeof value.attemptId === "string" ? value.attemptId : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    agent: typeof value.agent === "string" ? value.agent : undefined,
    childGoalId: typeof value.childGoalId === "string" ? value.childGoalId : undefined,
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    delegationDepth: Math.max(0, Math.trunc(numberField(value, "delegationDepth") ?? 0)),
    status,
    reasonCode: includesString(DELEGATION_ATTEMPT_REASON_CODES, value.reasonCode) ? value.reasonCode : undefined,
  };
}

const DELEGATION_ATTEMPT_STATUSES = [
  "queued", "running", "claim_returned", "accepted", "rejected", "failed_preflight", "failed_runtime",
  "failed_output_gate_format", "failed_output_gate_semantic", "output_declared_incomplete", "cancelled", "liveness_unknown",
] as const satisfies readonly GoalTodoDelegationAttemptStatus[];
const DELEGATION_ATTEMPT_REASON_CODES = [
  "queued", "child_started", "claim_returned", "claim_accepted", "claim_rejected", "preflight_config_failed",
  "preflight_contract_failed", "preflight_policy_failed", "child_runtime_failed", "child_aborted", "output_missing",
  "output_gate_contract_configuration", "output_gate_format", "output_gate_semantic", "output_declared_incomplete",
  "output_declared_blocked", "cancelled", "liveness_unknown",
] as const satisfies readonly GoalTodoDelegationAttemptReasonCode[];
const DELEGATION_ATTEMPT_FAILURE_KINDS = ["preflight", "config", "output_gate", "child_runtime", "aborted"] as const;
const SAFE_DELEGATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

export function safeDelegationAttemptId(value: string | undefined, prefix: string): string {
  const candidate = value?.trim();
  return candidate && SAFE_DELEGATION_ID.test(candidate) ? candidate : `${prefix}_${sha256(candidate ?? prefix).slice(0, 24)}`;
}

export function cloneDelegationAttempt(attempt: GoalTodoDelegationAttempt): GoalTodoDelegationAttempt {
  return { ...attempt, gateIssueCodes: [...attempt.gateIssueCodes], bodyStored: false };
}

const LIVENESS_PROOF_STATUSES = ["active", "inactive", "unknown"] as const;
const LIVENESS_PROOF_SOURCES = ["current_monitor", "durable_attempt", "restored_monitor", "none"] as const;
const LIVENESS_PROOF_CODES = [
  "monitor_active_exact", "monitor_terminal_exact", "durable_preflight_terminal", "durable_child_terminal", "durable_output_terminal",
  "restored_nonterminal_without_controller", "nonterminal_without_authoritative_status", "terminal_proof_incomplete",
  "attempt_id_mismatch", "run_id_mismatch", "monitor_attempt_run_mismatch",
] as const;
const MONITOR_STATUSES = ["queued", "running", "preflight_failed", "complete", "failed", "aborted"] as const;
const RECOVERABLE_ATTEMPT_STATUSES = new Set<GoalTodoDelegationAttemptStatus>([
  "failed_preflight", "failed_runtime", "failed_output_gate_format", "failed_output_gate_semantic",
  "output_declared_incomplete", "cancelled", "liveness_unknown",
]);

function recoveryRefsHash(refs: string[]): string {
  return sha256(JSON.stringify([...new Set(refs.map((ref) => ref.trim()).filter(Boolean))].sort()));
}

function livenessProofStatusMatchesCode(status: unknown, code: unknown): boolean {
  if (status === "active") return code === "monitor_active_exact";
  if (status === "inactive") return code === "monitor_terminal_exact"
    || code === "durable_preflight_terminal"
    || code === "durable_child_terminal"
    || code === "durable_output_terminal";
  return status === "unknown" && (code === "restored_nonterminal_without_controller"
    || code === "nonterminal_without_authoritative_status"
    || code === "terminal_proof_incomplete"
    || code === "attempt_id_mismatch"
    || code === "run_id_mismatch"
    || code === "monitor_attempt_run_mismatch");
}

function livenessProofHashMatchesAttempt(proof: GoalTodoDelegationLivenessProof, attempt: GoalTodoDelegationAttempt): boolean {
  return proof.proofHash === sha256(JSON.stringify([
    proof.status,
    proof.source,
    proof.code,
    attempt.attemptId,
    attempt.runId,
    attempt.status,
    proof.monitorStatus ?? "",
    proof.proofAt,
    proof.proofTimestampHash,
    attempt.boundGoalRevision,
    attempt.boundGraphRevision,
    attempt.boundTodoRevision,
  ]));
}

export function normalizeDelegationLivenessProof(value: unknown): GoalTodoDelegationLivenessProof | undefined {
  if (!isRecord(value)
    || value.schema !== "zob.goal-todo-delegation-liveness-proof.v1"
    || value.bodyStored !== false
    || !includesString(LIVENESS_PROOF_STATUSES, value.status)
    || !includesString(LIVENESS_PROOF_SOURCES, value.source)
    || !includesString(LIVENESS_PROOF_CODES, value.code)
    || !livenessProofStatusMatchesCode(value.status, value.code)
    || typeof value.attemptId !== "string"
    || typeof value.runId !== "string"
    || !includesString(DELEGATION_ATTEMPT_STATUSES, value.attemptStatus)
    || !Number.isSafeInteger(value.proofAt)
    || (value.proofAt as number) < 0
    || typeof value.proofTimestampHash !== "string"
    || value.proofTimestampHash !== sha256(String(value.proofAt))
    || typeof value.proofHash !== "string"
    || !SHA256_HEX.test(value.proofHash)) return undefined;
  return {
    schema: "zob.goal-todo-delegation-liveness-proof.v1",
    status: value.status,
    source: value.source,
    code: value.code,
    attemptId: value.attemptId,
    runId: value.runId,
    attemptStatus: value.attemptStatus,
    monitorStatus: includesString(MONITOR_STATUSES, value.monitorStatus) ? value.monitorStatus : undefined,
    proofAt: value.proofAt as number,
    proofTimestampHash: value.proofTimestampHash,
    proofHash: value.proofHash,
    bodyStored: false,
  };
}

export function normalizeDelegationRecovery(value: unknown): GoalTodoDelegationRecovery | undefined {
  if (!isRecord(value) || value.bodyStored !== false || typeof value.attemptId !== "string" || typeof value.runId !== "string") return undefined;
  const numberKeys = ["boundGoalRevision", "boundGraphRevision", "boundTodoRevision", "expectedGraphRevision", "expectedTodoRevision", "recoveredAt"] as const;
  if (numberKeys.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return undefined;
  const livenessProof = normalizeDelegationLivenessProof(value.livenessProof);
  const evidenceRefs = stringArray(value.evidenceRefs).map((ref) => ref.trim()).filter(Boolean).sort();
  const proofRefs = stringArray(value.proofRefs).map((ref) => ref.trim()).filter(Boolean).sort();
  if (!livenessProof
    || livenessProof.status !== "inactive"
    || livenessProof.attemptId !== value.attemptId
    || livenessProof.runId !== value.runId
    || typeof value.reasonHash !== "string"
    || !SHA256_HEX.test(value.reasonHash)
    || evidenceRefs.length === 0
    || proofRefs.length === 0
    || value.evidenceRefsHash !== recoveryRefsHash(evidenceRefs)
    || value.proofRefsHash !== recoveryRefsHash(proofRefs)) return undefined;
  return {
    attemptId: value.attemptId,
    runId: value.runId,
    boundGoalRevision: value.boundGoalRevision as number,
    boundGraphRevision: value.boundGraphRevision as number,
    boundTodoRevision: value.boundTodoRevision as number,
    expectedGraphRevision: value.expectedGraphRevision as number,
    expectedTodoRevision: value.expectedTodoRevision as number,
    reasonHash: value.reasonHash,
    evidenceRefs,
    evidenceRefsHash: value.evidenceRefsHash as string,
    proofRefs,
    proofRefsHash: value.proofRefsHash as string,
    livenessProof,
    recoveredAt: value.recoveredAt as number,
    bodyStored: false,
  };
}

export function normalizeDelegationAttempt(value: unknown): GoalTodoDelegationAttempt | undefined {
  if (!isRecord(value) || value.bodyStored !== false) return undefined;
  if (typeof value.attemptId !== "string" || typeof value.runId !== "string" || typeof value.goalId !== "string" || typeof value.todoId !== "string" || typeof value.todoPath !== "string") return undefined;
  if (!includesString(DELEGATION_ATTEMPT_STATUSES, value.status) || !includesString(DELEGATION_ATTEMPT_REASON_CODES, value.reasonCode)) return undefined;
  const attemptId = safeDelegationAttemptId(value.attemptId, "attempt");
  const runId = safeDelegationAttemptId(value.runId, "run");
  const requestId = typeof value.requestId === "string" && SAFE_DELEGATION_ID.test(value.requestId) ? value.requestId : undefined;
  return {
    attemptId,
    runId,
    requestId,
    requestIdHash: typeof value.requestIdHash === "string" && SHA256_HEX.test(value.requestIdHash) ? value.requestIdHash : requestId ? sha256(requestId) : undefined,
    goalId: value.goalId,
    todoId: value.todoId,
    todoPath: value.todoPath,
    parentTodoId: typeof value.parentTodoId === "string" ? value.parentTodoId : undefined,
    boundGoalRevision: Math.max(0, Math.trunc(numberField(value, "boundGoalRevision") ?? 0)),
    boundGraphRevision: Math.max(0, Math.trunc(numberField(value, "boundGraphRevision") ?? 0)),
    boundTodoRevision: Math.max(0, Math.trunc(numberField(value, "boundTodoRevision") ?? 0)),
    agent: typeof value.agent === "string" && SAFE_DELEGATION_ID.test(value.agent) ? value.agent : undefined,
    childGoalId: typeof value.childGoalId === "string" && SAFE_DELEGATION_ID.test(value.childGoalId) ? value.childGoalId : undefined,
    delegationDepth: Math.max(0, Math.trunc(numberField(value, "delegationDepth") ?? 0)),
    status: value.status,
    reasonCode: value.reasonCode,
    failureKind: includesString(DELEGATION_ATTEMPT_FAILURE_KINDS, value.failureKind) ? value.failureKind : undefined,
    outputContract: typeof value.outputContract === "string" && SAFE_DELEGATION_ID.test(value.outputContract) ? value.outputContract : undefined,
    validationPolicy: value.validationPolicy === "parent_review" || value.validationPolicy === "oracle_required" ? value.validationPolicy : undefined,
    outputHash: typeof value.outputHash === "string" && SHA256_HEX.test(value.outputHash) ? value.outputHash : undefined,
    gateHash: typeof value.gateHash === "string" && SHA256_HEX.test(value.gateHash) ? value.gateHash : undefined,
    failureHash: typeof value.failureHash === "string" && SHA256_HEX.test(value.failureHash) ? value.failureHash : undefined,
    gateIssueCodes: stringArray(value.gateIssueCodes).filter((code) => /^[a-z0-9_]+$/.test(code)).slice(0, 32),
    gateIssueCount: Math.max(0, Math.trunc(numberField(value, "gateIssueCount") ?? 0)),
    evidenceRefCount: Math.max(0, Math.trunc(numberField(value, "evidenceRefCount") ?? 0)),
    validationCommandCount: Math.max(0, Math.trunc(numberField(value, "validationCommandCount") ?? 0)),
    queuedAt: numberField(value, "queuedAt") === undefined ? undefined : Math.max(0, Math.trunc(numberField(value, "queuedAt")!)),
    startedAt: numberField(value, "startedAt") === undefined ? undefined : Math.max(0, Math.trunc(numberField(value, "startedAt")!)),
    finalizedAt: numberField(value, "finalizedAt") === undefined ? undefined : Math.max(0, Math.trunc(numberField(value, "finalizedAt")!)),
    updatedAt: Math.max(0, Math.trunc(numberField(value, "updatedAt") ?? 0)),
    bodyStored: false,
  };
}

function attemptStatusFromLegacy(status: GoalTodoDelegationRef["status"]): GoalTodoDelegationAttemptStatus {
  if (status === "failed") return "failed_runtime";
  if (status === "unknown") return "liveness_unknown";
  return status;
}

function attemptReasonFromStatus(status: GoalTodoDelegationAttemptStatus): GoalTodoDelegationAttemptReasonCode {
  if (status === "queued") return "queued";
  if (status === "running") return "child_started";
  if (status === "claim_returned") return "claim_returned";
  if (status === "accepted") return "claim_accepted";
  if (status === "rejected") return "claim_rejected";
  if (status === "liveness_unknown") return "liveness_unknown";
  return "child_runtime_failed";
}

export function legacyDelegationAttempt(input: { goalId: string; todoId: string; todoPath: string; parentTodoId?: string; goalRevision?: number; graphRevision?: number; todoRevision?: number; delegation: GoalTodoDelegationRef; at: number }): GoalTodoDelegationAttempt {
  const identityHash = sha256(JSON.stringify([input.goalId, input.todoId, input.delegation.runId ?? "", input.delegation.requestId ?? "", input.at]));
  const status = attemptStatusFromLegacy(input.delegation.status);
  const runId = safeDelegationAttemptId(input.delegation.runId, `legacy_run_${identityHash.slice(0, 12)}`);
  const requestId = typeof input.delegation.requestId === "string" && SAFE_DELEGATION_ID.test(input.delegation.requestId) ? input.delegation.requestId : undefined;
  return {
    attemptId: safeDelegationAttemptId(input.delegation.attemptId, `legacy_attempt_${identityHash.slice(0, 12)}`),
    runId,
    requestId,
    requestIdHash: input.delegation.requestId ? sha256(input.delegation.requestId) : undefined,
    goalId: input.goalId,
    todoId: input.todoId,
    todoPath: input.todoPath,
    parentTodoId: input.parentTodoId,
    boundGoalRevision: Math.max(0, Math.trunc(input.goalRevision ?? 0)),
    boundGraphRevision: Math.max(0, Math.trunc(input.graphRevision ?? 0)),
    boundTodoRevision: Math.max(0, Math.trunc(input.todoRevision ?? 0)),
    agent: input.delegation.agent,
    childGoalId: input.delegation.childGoalId,
    delegationDepth: input.delegation.delegationDepth,
    status,
    reasonCode: input.delegation.reasonCode ?? attemptReasonFromStatus(status),
    failureKind: status === "failed_runtime" ? "child_runtime" : undefined,
    gateIssueCodes: [],
    gateIssueCount: 0,
    evidenceRefCount: 0,
    validationCommandCount: 0,
    queuedAt: input.at,
    startedAt: status === "queued" ? undefined : input.at,
    finalizedAt: ["queued", "running", "claim_returned"].includes(status) ? undefined : input.at,
    updatedAt: input.at,
    bodyStored: false,
  };
}

export function compatibilityDelegationFromAttempt(attempt: GoalTodoDelegationAttempt): GoalTodoDelegationRef {
  const status: GoalTodoDelegationRef["status"] = attempt.status === "failed_preflight"
    || attempt.status === "failed_runtime"
    || attempt.status === "failed_output_gate_format"
    || attempt.status === "failed_output_gate_semantic"
    || attempt.status === "output_declared_incomplete"
    || attempt.status === "cancelled"
    ? "failed"
    : attempt.status === "liveness_unknown" ? "unknown" : attempt.status;
  return {
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    agent: attempt.agent,
    childGoalId: attempt.childGoalId,
    requestId: attempt.requestId,
    delegationDepth: attempt.delegationDepth,
    status,
    reasonCode: attempt.reasonCode,
  };
}

export function upsertDelegationAttempt(node: GoalTodoNode, attempt: GoalTodoDelegationAttempt): GoalTodoDelegationAttempt[] {
  const attempts = (node.delegationAttempts ?? []).map(cloneDelegationAttempt);
  const index = attempts.findIndex((candidate) => candidate.attemptId === attempt.attemptId);
  if (index >= 0) attempts[index] = cloneDelegationAttempt(attempt);
  else attempts.push(cloneDelegationAttempt(attempt));
  return attempts;
}

export function normalizeArtifacts(value: unknown): GoalTodoArtifacts | undefined {
  if (!isRecord(value)) return undefined;
  return {
    reports: stringArray(value.reports),
    checkpoints: stringArray(value.checkpoints),
    sentinels: stringArray(value.sentinels),
    taskHash: typeof value.taskHash === "string" ? value.taskHash : undefined,
    outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined,
  };
}

export function normalizeChildChangedPathRefs(value: unknown): ZcommitChildChangedPathRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.pathHash !== "string" || typeof item.status !== "string") return [];
    return [{ path: item.path, pathHash: item.pathHash, status: item.status, contentHash: typeof item.contentHash === "string" ? item.contentHash : undefined }];
  }).slice(0, 100);
}

function boundRevisionField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

export function normalizeClaim(value: unknown, fallbackAt = 0): GoalTodoClaimRef | undefined {
  if (!isRecord(value) || typeof value.claimHash !== "string") return undefined;
  return {
    claimHash: value.claimHash,
    claimVersion: value.claimVersion === 2 ? 2 : undefined,
    attemptId: typeof value.attemptId === "string" ? value.attemptId : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    goalRevision: boundRevisionField(value, "goalRevision"),
    graphRevision: boundRevisionField(value, "graphRevision"),
    todoRevision: boundRevisionField(value, "todoRevision"),
    validationPolicy: value.validationPolicy === "parent_review" || value.validationPolicy === "oracle_required" ? value.validationPolicy : undefined,
    outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined,
    outputContract: typeof value.outputContract === "string" ? value.outputContract : undefined,
    gateHash: typeof value.gateHash === "string" ? value.gateHash : undefined,
    gatePassed: typeof value.gatePassed === "boolean" ? value.gatePassed : undefined,
    childGoalStatus: includesString(VALID_CHILD_GOAL_STATUS, value.childGoalStatus) ? value.childGoalStatus : undefined,
    statusClaim: includesString(VALID_STATUS_CLAIM, value.statusClaim) ? value.statusClaim : undefined,
    targetReadiness: includesString(VALID_TARGET_READINESS, value.targetReadiness) ? value.targetReadiness : undefined,
    acceptanceBlockers: stringArray(value.acceptanceBlockers),
    noShip: typeof value.noShip === "boolean" ? value.noShip : undefined,
    childChangedPaths: normalizeChildChangedPathRefs(value.childChangedPaths),
    returnedAt: Math.trunc(numberField(value, "returnedAt") ?? fallbackAt),
  };
}

export function normalizeValidation(value: unknown): GoalTodoClaimValidationRef | undefined {
  if (!isRecord(value)) return undefined;
  const status = includesString(VALID_VALIDATION_STATUS, value.status) ? value.status : undefined;
  if (!status) return undefined;
  return {
    validationVersion: value.validationVersion === 1 ? 1 : undefined,
    claimHash: typeof value.claimHash === "string" ? value.claimHash : undefined,
    attemptId: typeof value.attemptId === "string" ? value.attemptId : undefined,
    claimRunId: typeof value.claimRunId === "string" ? value.claimRunId : undefined,
    claimGoalRevision: boundRevisionField(value, "claimGoalRevision"),
    claimGraphRevision: boundRevisionField(value, "claimGraphRevision"),
    claimTodoRevision: boundRevisionField(value, "claimTodoRevision"),
    validationPolicy: value.validationPolicy === "parent_review" || value.validationPolicy === "oracle_required" ? value.validationPolicy : undefined,
    expectedGraphRevision: boundRevisionField(value, "expectedGraphRevision"),
    expectedTodoRevision: boundRevisionField(value, "expectedTodoRevision"),
    goalRevision: boundRevisionField(value, "goalRevision"),
    graphRevision: boundRevisionField(value, "graphRevision"),
    todoRevision: boundRevisionField(value, "todoRevision"),
    runId: typeof value.runId === "string" ? value.runId : undefined,
    agent: typeof value.agent === "string" ? value.agent : undefined,
    status,
    verdict: includesString(VALID_VALIDATION_VERDICT, value.verdict) ? value.verdict : undefined,
    recommendedAction: includesString(VALID_VALIDATION_ACTION, value.recommendedAction) ? value.recommendedAction : undefined,
    noShip: typeof value.noShip === "boolean" ? value.noShip : undefined,
    outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined,
    evidenceRefs: stringArray(value.evidenceRefs),
    validationCommands: stringArray(value.validationCommands),
    blockingIssues: stringArray(value.blockingIssues),
    confidence: includesString(VALID_VALIDATION_CONFIDENCE, value.confidence) ? value.confidence : undefined,
    requestedAt: typeof value.requestedAt === "number" ? Math.trunc(value.requestedAt) : undefined,
    validatedAt: typeof value.validatedAt === "number" ? Math.trunc(value.validatedAt) : undefined,
  };
}

function normalizeClaimResolutionBinding(value: unknown): GoalTodoClaimResolutionBinding | undefined {
  if (!isRecord(value)
    || value.claimVersion !== 2
    || typeof value.claimHash !== "string"
    || !SHA256_HEX.test(value.claimHash)
    || typeof value.attemptId !== "string"
    || (value.validationPolicy !== "parent_review" && value.validationPolicy !== "oracle_required")) return undefined;
  const claimGoalRevision = boundRevisionField(value, "claimGoalRevision");
  const claimGraphRevision = boundRevisionField(value, "claimGraphRevision");
  const claimTodoRevision = boundRevisionField(value, "claimTodoRevision");
  const expectedGoalRevision = boundRevisionField(value, "expectedGoalRevision");
  const expectedGraphRevision = boundRevisionField(value, "expectedGraphRevision");
  const expectedTodoRevision = boundRevisionField(value, "expectedTodoRevision");
  if ([claimGoalRevision, claimGraphRevision, claimTodoRevision, expectedGoalRevision, expectedGraphRevision, expectedTodoRevision].some((revision) => revision === undefined)) return undefined;
  const validationOutputHash = typeof value.validationOutputHash === "string" && SHA256_HEX.test(value.validationOutputHash) ? value.validationOutputHash : undefined;
  return {
    claimVersion: 2,
    claimHash: value.claimHash,
    attemptId: value.attemptId,
    claimGoalRevision: claimGoalRevision!,
    claimGraphRevision: claimGraphRevision!,
    claimTodoRevision: claimTodoRevision!,
    expectedGoalRevision: expectedGoalRevision!,
    expectedGraphRevision: expectedGraphRevision!,
    expectedTodoRevision: expectedTodoRevision!,
    validationPolicy: value.validationPolicy,
    ...(validationOutputHash ? { validationOutputHash } : {}),
  };
}

export function cloneValidation(validation: GoalTodoClaimValidationRef): GoalTodoClaimValidationRef {
  return { ...validation, evidenceRefs: [...validation.evidenceRefs], validationCommands: [...validation.validationCommands], blockingIssues: [...validation.blockingIssues] };
}

export function cloneClaim(claim: GoalTodoClaimRef): GoalTodoClaimRef {
  return { ...claim, acceptanceBlockers: [...claim.acceptanceBlockers], childChangedPaths: claim.childChangedPaths?.map((ref) => ({ ...ref })) };
}

export function normalizeNode(value: unknown, fallbackAt = 0): GoalTodoNode | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.goalId !== "string" || typeof value.title !== "string") return undefined;
  const status = includesString(VALID_STATUS, value.status) ? value.status : "planned";
  const owner = includesString(VALID_OWNER, value.owner) ? value.owner : "agent";
  const priority = includesString(VALID_PRIORITY, value.priority) ? value.priority : "normal";
  const delegation = normalizeDelegation(value.delegation);
  let delegationAttempts = Array.isArray(value.delegationAttempts)
    ? value.delegationAttempts.map(normalizeDelegationAttempt).filter((attempt): attempt is GoalTodoDelegationAttempt => Boolean(attempt))
    : [];
  if (delegationAttempts.length === 0 && delegation) delegationAttempts = [legacyDelegationAttempt({
    goalId: value.goalId,
    todoId: value.id,
    todoPath: typeof value.path === "string" && value.path.trim().length > 0 ? value.path : "1",
    parentTodoId: typeof value.parentId === "string" ? value.parentId : undefined,
    todoRevision: Math.max(0, Math.trunc(numberField(value, "revision") ?? 0)),
    delegation,
    at: Math.trunc(numberField(value, "updatedAt") ?? fallbackAt),
  })];
  return {
    id: value.id,
    goalId: value.goalId,
    parentId: typeof value.parentId === "string" ? value.parentId : undefined,
    path: typeof value.path === "string" && value.path.trim().length > 0 ? value.path : "1",
    depth: Math.max(1, Math.trunc(numberField(value, "depth") ?? 1)),
    title: value.title,
    descriptionHash: typeof value.descriptionHash === "string" ? value.descriptionHash : undefined,
    status,
    owner,
    required: value.required !== false,
    priority,
    acceptanceCriteria: stringArray(value.acceptanceCriteria),
    evidenceRefs: stringArray(value.evidenceRefs),
    validationCommands: stringArray(value.validationCommands),
    delegationAttempts,
    delegation: delegationAttempts.length > 0 ? compatibilityDelegationFromAttempt(delegationAttempts.at(-1)!) : delegation,
    claim: normalizeClaim(value.claim, fallbackAt),
    validation: normalizeValidation(value.validation),
    artifacts: normalizeArtifacts(value.artifacts),
    contextScopeId: typeof value.contextScopeId === "string" ? value.contextScopeId : undefined,
    contextPackRef: typeof value.contextPackRef === "string" ? value.contextPackRef : undefined,
    citations: stringArray(value.citations),
    freshness: typeof value.freshness === "string" ? value.freshness : undefined,
    blocker: typeof value.blocker === "string" ? value.blocker : undefined,
    skipReason: typeof value.skipReason === "string" ? value.skipReason : undefined,
    reviewNoShip: value.reviewNoShip === true,
    revision: Math.max(0, Math.trunc(numberField(value, "revision") ?? 0)),
    createdAt: Math.trunc(numberField(value, "createdAt") ?? fallbackAt),
    updatedAt: Math.trunc(numberField(value, "updatedAt") ?? fallbackAt),
  };
}

export function normalizePatch(value: Partial<GoalTodoNode>): Partial<GoalTodoNode> {
  const patch: Partial<GoalTodoNode> = {};
  if ("parentId" in value && (typeof value.parentId === "string" || value.parentId === undefined)) patch.parentId = value.parentId;
  if (typeof value.path === "string") patch.path = value.path;
  if (typeof value.depth === "number" && Number.isFinite(value.depth)) patch.depth = Math.max(1, Math.trunc(value.depth));
  if (typeof value.title === "string" && value.title.trim().length > 0) patch.title = value.title.trim();
  if ("descriptionHash" in value && (typeof value.descriptionHash === "string" || value.descriptionHash === undefined)) patch.descriptionHash = value.descriptionHash;
  if (includesString(VALID_STATUS, value.status)) patch.status = value.status;
  if (includesString(VALID_OWNER, value.owner)) patch.owner = value.owner;
  if (typeof value.required === "boolean") patch.required = value.required;
  if (includesString(VALID_PRIORITY, value.priority)) patch.priority = value.priority;
  if (Array.isArray(value.acceptanceCriteria)) patch.acceptanceCriteria = value.acceptanceCriteria.filter((item): item is string => typeof item === "string");
  if (Array.isArray(value.evidenceRefs)) patch.evidenceRefs = value.evidenceRefs.filter((item): item is string => typeof item === "string");
  if (Array.isArray(value.validationCommands)) patch.validationCommands = value.validationCommands.filter((item): item is string => typeof item === "string");
  if (Array.isArray(value.delegationAttempts)) patch.delegationAttempts = value.delegationAttempts.map(cloneDelegationAttempt);
  if (value.delegation) patch.delegation = { ...value.delegation };
  else if ("delegation" in value && value.delegation === undefined) patch.delegation = undefined;
  if (value.claim) patch.claim = cloneClaim(value.claim);
  else if ("claim" in value && value.claim === undefined) patch.claim = undefined;
  if (value.validation) patch.validation = cloneValidation(value.validation);
  else if ("validation" in value && value.validation === undefined) patch.validation = undefined;
  if (value.artifacts) patch.artifacts = { ...value.artifacts };
  if ("contextScopeId" in value && (typeof value.contextScopeId === "string" || value.contextScopeId === undefined)) patch.contextScopeId = value.contextScopeId;
  if ("contextPackRef" in value && (typeof value.contextPackRef === "string" || value.contextPackRef === undefined)) patch.contextPackRef = value.contextPackRef;
  if (Array.isArray(value.citations)) patch.citations = value.citations.filter((item): item is string => typeof item === "string");
  if ("freshness" in value && (typeof value.freshness === "string" || value.freshness === undefined)) patch.freshness = value.freshness;
  if ("blocker" in value && (typeof value.blocker === "string" || value.blocker === undefined)) patch.blocker = value.blocker;
  if ("skipReason" in value && (typeof value.skipReason === "string" || value.skipReason === undefined)) patch.skipReason = value.skipReason;
  if ("reviewNoShip" in value && (typeof value.reviewNoShip === "boolean" || value.reviewNoShip === undefined)) patch.reviewNoShip = value.reviewNoShip;
  return patch;
}

export function applyPatchToNode(node: GoalTodoNode, patch: Partial<GoalTodoNode>, updatedAt = node.updatedAt): GoalTodoNode {
  return {
    ...node,
    ...normalizePatch(patch),
    acceptanceCriteria: patch.acceptanceCriteria ? [...patch.acceptanceCriteria] : [...node.acceptanceCriteria],
    evidenceRefs: patch.evidenceRefs ? [...patch.evidenceRefs] : [...node.evidenceRefs],
    validationCommands: patch.validationCommands ? [...patch.validationCommands] : [...node.validationCommands],
    delegationAttempts: patch.delegationAttempts ? patch.delegationAttempts.map(cloneDelegationAttempt) : node.delegationAttempts?.map(cloneDelegationAttempt),
    delegation: "delegation" in patch ? patch.delegation ? { ...patch.delegation } : undefined : node.delegation ? { ...node.delegation } : undefined,
    claim: "claim" in patch ? patch.claim ? cloneClaim(patch.claim) : undefined : node.claim ? cloneClaim(node.claim) : undefined,
    validation: "validation" in patch ? patch.validation ? cloneValidation(patch.validation) : undefined : node.validation ? cloneValidation(node.validation) : undefined,
    artifacts: patch.artifacts ? { ...patch.artifacts } : patch.artifacts === undefined ? node.artifacts ? { ...node.artifacts } : undefined : undefined,
    citations: patch.citations ? [...patch.citations] : node.citations ? [...node.citations] : undefined,
    updatedAt: Math.trunc(updatedAt),
  };
}

export function replaceNode(state: GoalTodoState, node: GoalTodoNode): void {
  const index = state.nodes.findIndex((candidate) => candidate.id === node.id && candidate.goalId === node.goalId);
  if (index >= 0) state.nodes[index] = cloneNode(node);
  else state.nodes.push(cloneNode(node));
}

export function removeGoalNodes(state: GoalTodoState, goalId: string): void {
  state.nodes = state.nodes.filter((node) => node.goalId !== goalId);
  if (state.focusTodoId && !state.nodes.some((node) => node.id === state.focusTodoId)) state.focusTodoId = undefined;
}

function eventBoundGraphRevision(state: GoalTodoState, event: GoalTodoEvent): number {
  return event.version === 2 ? event.graphRevision : (state.graphRevisions[event.goalId] ?? 0) + 1;
}

function eventBoundTodoRevision(existing: GoalTodoNode, event: GoalTodoEvent): number {
  return event.version === 2 && event.nodeRevision !== undefined ? event.nodeRevision : (existing.revision ?? 0) + 1;
}

function canonicalClaimBinding(claim: GoalTodoClaimRef | undefined): boolean {
  return Boolean(claim
    && claim.claimVersion === 2
    && SHA256_HEX.test(claim.claimHash)
    && typeof claim.attemptId === "string"
    && typeof claim.runId === "string"
    && boundRevisionField(claim as unknown as Record<string, unknown>, "goalRevision") !== undefined
    && boundRevisionField(claim as unknown as Record<string, unknown>, "graphRevision") !== undefined
    && boundRevisionField(claim as unknown as Record<string, unknown>, "todoRevision") !== undefined
    && (claim.validationPolicy === "parent_review" || claim.validationPolicy === "oracle_required")
    && typeof claim.outputHash === "string"
    && SHA256_HEX.test(claim.outputHash)
    && typeof claim.outputContract === "string"
    && typeof claim.gateHash === "string"
    && SHA256_HEX.test(claim.gateHash)
    && claim.gatePassed === true);
}

function validationBindingMatchesEvent(state: GoalTodoState, existing: GoalTodoNode, validation: GoalTodoClaimValidationRef, requireOutput: boolean): boolean {
  const claim = existing.claim;
  return canonicalClaimBinding(claim)
    && validation.validationVersion === 1
    && validation.claimHash === claim!.claimHash
    && validation.attemptId === claim!.attemptId
    && validation.claimRunId === claim!.runId
    && validation.claimGoalRevision === claim!.goalRevision
    && validation.claimGraphRevision === claim!.graphRevision
    && validation.claimTodoRevision === claim!.todoRevision
    && validation.validationPolicy === claim!.validationPolicy
    && validation.expectedGraphRevision === (state.graphRevisions[existing.goalId] ?? 0)
    && validation.expectedTodoRevision === (existing.revision ?? 0)
    && validation.goalRevision === claim!.goalRevision
    && validation.graphRevision === (state.graphRevisions[existing.goalId] ?? 0) + 1
    && validation.todoRevision === (existing.revision ?? 0) + 1
    && (!requireOutput || (typeof validation.outputHash === "string" && SHA256_HEX.test(validation.outputHash)));
}

function resolutionBindingMatches(state: GoalTodoState, existing: GoalTodoNode, binding: GoalTodoClaimResolutionBinding | undefined, requirePassedValidation: boolean): boolean {
  const claim = existing.claim;
  const latest = existing.delegationAttempts?.at(-1);
  if (!binding || !canonicalClaimBinding(claim)) return false;
  const strictValidationPassed = existing.validation?.status === "passed"
    && existing.validation.verdict === "PASS"
    && existing.validation.recommendedAction === "accept_claim"
    && (existing.validation.confidence === "MEDIUM" || existing.validation.confidence === "HIGH")
    && existing.validation.noShip === false
    && hasOnlyNoneLike(existing.validation.blockingIssues);
  const validationHashMatches = binding.validationPolicy === "parent_review"
    ? binding.validationOutputHash === undefined && claim!.graphRevision === binding.expectedGraphRevision && claim!.todoRevision === binding.expectedTodoRevision
    : existing.validation
      ? (!requirePassedValidation || strictValidationPassed)
        && binding.validationOutputHash === existing.validation.outputHash
        && existing.validation.graphRevision === binding.expectedGraphRevision
        && existing.validation.todoRevision === binding.expectedTodoRevision
      : !requirePassedValidation
        && binding.validationOutputHash === undefined
        && claim!.graphRevision === binding.expectedGraphRevision
        && claim!.todoRevision === binding.expectedTodoRevision;
  return binding.claimVersion === 2
    && binding.claimHash === claim!.claimHash
    && binding.attemptId === claim!.attemptId
    && binding.claimGoalRevision === claim!.goalRevision
    && binding.claimGraphRevision === claim!.graphRevision
    && binding.claimTodoRevision === claim!.todoRevision
    && binding.expectedGoalRevision === claim!.goalRevision
    && binding.expectedGraphRevision === (state.graphRevisions[existing.goalId] ?? 0)
    && binding.expectedTodoRevision === (existing.revision ?? 0)
    && binding.validationPolicy === claim!.validationPolicy
    && latest?.attemptId === claim!.attemptId
    && latest.runId === claim!.runId
    && latest.status === "claim_returned"
    && validationHashMatches;
}

function settleLatestAttempt(node: GoalTodoNode, status: "accepted" | "rejected", reasonCode: "claim_accepted" | "claim_rejected", at: number): { attempts?: GoalTodoDelegationAttempt[]; delegation?: GoalTodoDelegationRef } {
  const latest = node.delegationAttempts?.at(-1);
  const claim = node.claim;
  if (!latest || !claim || latest.status !== "claim_returned" || latest.attemptId !== claim.attemptId || latest.runId !== claim.runId) return {};
  const attempt: GoalTodoDelegationAttempt = { ...latest, status, reasonCode, finalizedAt: at, updatedAt: at, bodyStored: false };
  const attempts = upsertDelegationAttempt(node, attempt);
  return { attempts, delegation: compatibilityDelegationFromAttempt(attempts.at(-1)!) };
}

function applyEventMutation(state: GoalTodoState, event: GoalTodoEvent): void {
  if (event.kind === "policy_set") {
    state.policy = clonePolicy(event.policy);
    return;
  }
  if (event.kind === "clear_goal_todos") {
    removeGoalNodes(state, event.goalId);
    return;
  }
  if (event.kind === "snapshot") {
    removeGoalNodes(state, event.goalId);
    for (const node of event.nodes) replaceNode(state, node);
    if (event.policy) state.policy = clonePolicy(event.policy);
    state.focusTodoId = event.focusTodoId;
    return;
  }
  if (event.kind === "add") {
    replaceNode(state, event.node);
    return;
  }
  if (event.kind === "patch") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    const patch = { ...event.patch };
    for (const field of event.clearFields ?? []) (patch as Record<string, unknown>)[field] = undefined;
    if (existing) replaceNode(state, applyPatchToNode(existing, patch, event.at));
    return;
  }
  if (event.kind === "move") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) replaceNode(state, applyPatchToNode(existing, { parentId: event.parentId }, event.at));
    renumberGoalPaths(state, event.goalId);
    return;
  }
  if (event.kind === "split") {
    const parent = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (parent) replaceNode(state, applyPatchToNode(parent, { status: "in_progress" }, event.at));
    renumberGoalPaths(state, event.goalId);
    return;
  }
  if (event.kind === "delegate_link") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) {
      const attempt = legacyDelegationAttempt({
        goalId: event.goalId,
        todoId: event.todoId,
        todoPath: existing.path,
        parentTodoId: existing.parentId,
        graphRevision: eventBoundGraphRevision(state, event),
        todoRevision: eventBoundTodoRevision(existing, event),
        delegation: event.delegation,
        at: event.at,
      });
      const attempts = upsertDelegationAttempt(existing, attempt);
      replaceNode(state, applyPatchToNode(existing, {
        status: "delegated",
        owner: "subagent",
        delegationAttempts: attempts,
        delegation: compatibilityDelegationFromAttempt(attempts.at(-1)!),
        blocker: undefined,
      }, event.at));
    }
    return;
  }
  if (event.kind === "delegation_attempt_started") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) {
      const attempts = upsertDelegationAttempt(existing, event.attempt);
      replaceNode(state, applyPatchToNode(existing, {
        status: "delegated",
        owner: "subagent",
        delegationAttempts: attempts,
        delegation: compatibilityDelegationFromAttempt(attempts.at(-1)!),
        blocker: undefined,
      }, event.at));
    }
    return;
  }
  if (event.kind === "delegation_attempt_finalized") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) {
      const attempts = upsertDelegationAttempt(existing, event.attempt);
      replaceNode(state, applyPatchToNode(existing, {
        status: "delegated",
        owner: "subagent",
        delegationAttempts: attempts,
        delegation: compatibilityDelegationFromAttempt(attempts.at(-1)!),
      }, event.at));
    }
    return;
  }
  if (event.kind === "attempt_recovered") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    const latest = existing?.delegationAttempts?.at(-1);
    const recovery = event.recovery;
    const exact = Boolean(existing
      && existing.status === "delegated"
      && !existing.claim
      && latest
      && RECOVERABLE_ATTEMPT_STATUSES.has(latest.status)
      && latest.attemptId === recovery.attemptId
      && latest.runId === recovery.runId
      && latest.boundGoalRevision === recovery.boundGoalRevision
      && latest.boundGraphRevision === recovery.boundGraphRevision
      && latest.boundTodoRevision === recovery.boundTodoRevision
      && existing.delegation?.attemptId === recovery.attemptId
      && existing.delegation?.runId === recovery.runId
      && (state.graphRevisions[event.goalId] ?? 0) === recovery.expectedGraphRevision
      && (existing.revision ?? 0) === recovery.expectedTodoRevision
      && recovery.livenessProof.status === "inactive"
      && recovery.livenessProof.attemptId === recovery.attemptId
      && recovery.livenessProof.runId === recovery.runId
      && recovery.livenessProof.attemptStatus === latest.status
      && livenessProofHashMatchesAttempt(recovery.livenessProof, latest)
      && recovery.recoveredAt === event.at);
    if (existing && exact) replaceNode(state, applyPatchToNode(existing, {
      status: "ready",
      owner: "agent",
      evidenceRefs: [...new Set([...existing.evidenceRefs, ...recovery.evidenceRefs])],
      delegation: undefined,
      claim: undefined,
      validation: undefined,
      blocker: undefined,
      reviewNoShip: undefined,
    }, event.at));
    return;
  }
  if (event.kind === "claim_returned") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing) {
      const priorAttempt = existing.delegationAttempts?.at(-1);
      const activeAttempt = priorAttempt && (priorAttempt.status === "queued" || priorAttempt.status === "running") ? priorAttempt : undefined;
      const attemptMatches = Boolean(activeAttempt
        && event.runId
        && activeAttempt.runId === event.runId
        && (!event.attempt || event.attempt.attemptId === activeAttempt.attemptId));
      const exactBoundClaim = !event.claim || (canonicalClaimBinding(event.claim)
        && event.claim.claimHash === event.claimHash
        && event.claim.attemptId === activeAttempt?.attemptId
        && event.claim.runId === event.runId
        && event.claim.graphRevision === eventBoundGraphRevision(state, event)
        && event.claim.todoRevision === eventBoundTodoRevision(existing, event)
        && event.claim.validationPolicy === (event.attempt ?? activeAttempt)?.validationPolicy
        && event.claim.outputHash === event.outputHash
        && event.claim.outputContract === event.outputContract
        && event.claim.gateHash === event.attempt?.gateHash);
      const canonical = SHA256_HEX.test(event.claimHash)
        && event.gatePassed === true
        && (event.outputContract === "todo-child-result.v1" || event.outputContract === "todo-child-result.v2" || event.outputContract === "agent-event.v1")
        && event.childGoalStatus === "ready_for_oracle"
        && event.statusClaim === "done"
        && event.targetReadiness === "ready_for_parent_acceptance"
        && hasOnlyNoneLike(event.acceptanceBlockers ?? [])
        && event.noShip === false
        && (event.evidenceRefs.length > 0 || event.validationCommands.length > 0 || Boolean(event.outputHash))
        && attemptMatches
        && exactBoundClaim;
      if (!canonical) {
        const baseAttempt = activeAttempt ?? event.attempt;
        if (baseAttempt) {
          const semanticFailure = !attemptMatches;
          const gateFailure = event.gatePassed !== true;
          const failedAttempt: GoalTodoDelegationAttempt = {
            ...baseAttempt,
            status: semanticFailure ? "failed_output_gate_semantic" : gateFailure ? "failed_output_gate_format" : "output_declared_incomplete",
            reasonCode: semanticFailure ? "output_gate_semantic" : gateFailure ? "output_gate_format" : event.statusClaim === "blocked" ? "output_declared_blocked" : "output_declared_incomplete",
            failureKind: semanticFailure || gateFailure ? "output_gate" : undefined,
            outputContract: event.outputContract,
            outputHash: event.outputHash,
            gateIssueCodes: semanticFailure ? ["mismatched_delegation_attempt"] : gateFailure ? ["legacy_claim_gate_not_passed"] : [],
            gateIssueCount: semanticFailure || gateFailure ? 1 : 0,
            evidenceRefCount: event.evidenceRefs.length,
            validationCommandCount: event.validationCommands.length,
            finalizedAt: event.at,
            updatedAt: event.at,
            bodyStored: false,
          };
          const attempts = upsertDelegationAttempt(existing, failedAttempt);
          replaceNode(state, applyPatchToNode(existing, {
            delegationAttempts: attempts,
            delegation: compatibilityDelegationFromAttempt(attempts.at(-1)!),
          }, event.at));
        }
        return;
      }
      const evidenceRefs = [...new Set([...existing.evidenceRefs, ...event.evidenceRefs])];
      const validationCommands = [...new Set([...existing.validationCommands, ...event.validationCommands])];
      const returnedAttempt: GoalTodoDelegationAttempt = {
        ...(event.attempt ?? activeAttempt!),
        status: "claim_returned",
        reasonCode: "claim_returned",
        failureKind: undefined,
        outputContract: event.outputContract,
        outputHash: event.outputHash,
        gateIssueCodes: [],
        gateIssueCount: 0,
        evidenceRefCount: event.evidenceRefs.length,
        validationCommandCount: event.validationCommands.length,
        finalizedAt: undefined,
        updatedAt: event.at,
        bodyStored: false,
      };
      const attempts = upsertDelegationAttempt(existing, returnedAttempt);
      const claim: GoalTodoClaimRef = event.claim ? cloneClaim(event.claim) : {
        claimHash: event.claimHash,
        runId: event.runId,
        outputHash: event.outputHash,
        outputContract: event.outputContract,
        gatePassed: true,
        childGoalStatus: event.childGoalStatus,
        statusClaim: event.statusClaim,
        targetReadiness: event.targetReadiness,
        acceptanceBlockers: [],
        noShip: false,
        childChangedPaths: event.childChangedPaths ?? [],
        returnedAt: event.at,
      };
      replaceNode(state, applyPatchToNode(existing, {
        status: "claim_returned",
        evidenceRefs,
        validationCommands,
        delegationAttempts: attempts,
        delegation: compatibilityDelegationFromAttempt(attempts.at(-1)!),
        claim,
        artifacts: { ...(existing.artifacts ?? {}), outputHash: event.outputHash ?? event.claimHash },
        blocker: undefined,
        reviewNoShip: undefined,
      }, event.at));
    }
    return;
  }
  if (event.kind === "claim_validation_requested") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing && existing.claim?.validationPolicy === "oracle_required" && validationBindingMatchesEvent(state, existing, event.validation, false)) replaceNode(state, applyPatchToNode(existing, {
      status: "needs_oracle",
      owner: "oracle",
      validation: cloneValidation(event.validation),
      blocker: undefined,
      reviewNoShip: undefined,
    }, event.at));
    return;
  }
  if (event.kind === "claim_validation_returned") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing && existing.claim?.validationPolicy === "oracle_required" && validationBindingMatchesEvent(state, existing, event.validation, true)) {
      const priorValidationCurrent = !existing.validation || (existing.validation.status === "running"
        && existing.validation.claimHash === event.validation.claimHash
        && existing.validation.attemptId === event.validation.attemptId
        && existing.validation.graphRevision === event.validation.expectedGraphRevision
        && existing.validation.todoRevision === event.validation.expectedTodoRevision);
      if (!priorValidationCurrent) return;
      const evidenceRefs = [...new Set([...existing.evidenceRefs, ...event.evidenceRefs])];
      const validationCommands = [...new Set([...existing.validationCommands, ...event.validationCommands])];
      const passed = event.validation.status === "passed" && event.validation.verdict === "PASS" && event.validation.noShip === false && hasOnlyNoneLike(event.validation.blockingIssues);
      replaceNode(state, applyPatchToNode(existing, {
        status: existing.status,
        owner: existing.owner,
        evidenceRefs,
        validationCommands,
        validation: cloneValidation(event.validation),
        blocker: passed ? existing.blocker : event.validation.blockingIssues[0] ?? `claim validation ${event.validation.verdict ?? "blocked"}`,
        reviewNoShip: passed ? existing.reviewNoShip : true,
      }, event.at));
    }
    return;
  }
  if (event.kind === "claim_accepted") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing && resolutionBindingMatches(state, existing, event.binding, true)) {
      const settled = settleLatestAttempt(existing, "accepted", "claim_accepted", event.at);
      replaceNode(state, applyPatchToNode(existing, {
        status: "done",
        evidenceRefs: [...new Set([...existing.evidenceRefs, ...event.evidenceRefs])],
        validationCommands: [...new Set([...existing.validationCommands, ...event.validationCommands])],
        delegationAttempts: settled.attempts,
        delegation: settled.delegation ?? (existing.delegation ? { ...existing.delegation, status: "accepted" } : undefined),
        blocker: undefined,
        reviewNoShip: undefined,
      }, event.at));
    }
    return;
  }
  if (event.kind === "claim_rejected") {
    const existing = state.nodes.find((node) => node.goalId === event.goalId && node.id === event.todoId);
    if (existing && resolutionBindingMatches(state, existing, event.binding, false)) {
      const settled = settleLatestAttempt(existing, "rejected", "claim_rejected", event.at);
      replaceNode(state, applyPatchToNode(existing, {
        status: "blocked",
        delegationAttempts: settled.attempts,
        delegation: settled.delegation ?? (existing.delegation ? { ...existing.delegation, status: "rejected" } : undefined),
        blocker: `claim rejected (${event.reasonHash.slice(0, 12)})`,
        reviewNoShip: true,
      }, event.at));
    }
    return;
  }
  if (event.kind === "focus") state.focusTodoId = event.todoId;
}

const NODE_MUTATION_KINDS = new Set<GoalTodoEvent["kind"]>([
  "add",
  "patch",
  "move",
  "split",
  "delegate_link",
  "delegation_attempt_started",
  "delegation_attempt_finalized",
  "attempt_recovered",
  "claim_returned",
  "claim_validation_requested",
  "claim_validation_returned",
  "claim_accepted",
  "claim_rejected",
]);

function eventTodoId(event: GoalTodoEvent): string | undefined {
  if (event.kind === "add") return event.node.id;
  return NODE_MUTATION_KINDS.has(event.kind) && "todoId" in event ? event.todoId : undefined;
}

function nodeWithoutRevision(node: GoalTodoNode): string {
  const { revision: _revision, ...rest } = node;
  return JSON.stringify(rest);
}

function ensureRevisionState(state: GoalTodoState): asserts state is GoalTodoState & { restoreBlocked: Record<string, GoalTodoRevisionDiagnostic> } {
  state.graphRevisions ??= {};
  state.revisionDiagnostics ??= [];
  state.restoreBlocked ??= {};
}

function recordRevisionDiagnostic(state: GoalTodoState, diagnostic: GoalTodoRevisionDiagnostic): void {
  ensureRevisionState(state);
  if (state.restoreBlocked[diagnostic.goalId]) return;
  state.restoreBlocked[diagnostic.goalId] = { ...diagnostic };
  state.revisionDiagnostics.push({ ...diagnostic });
}

/** Apply one event atomically. A poisoned goal stream rejects every later replay/live mutation. */
export function applyEvent(state: GoalTodoState, event: GoalTodoEvent): boolean {
  ensureRevisionState(state);
  if (state.restoreBlocked[event.goalId]) return false;
  const currentGraphRevision = state.graphRevisions[event.goalId] ?? 0;
  const expectedGraphRevision = currentGraphRevision + 1;
  const todoId = eventTodoId(event);
  const existing = todoId ? state.nodes.find((node) => node.goalId === event.goalId && node.id === todoId) : undefined;
  const expectedNodeRevision = todoId ? (existing ? (existing.revision ?? 0) + 1 : 1) : undefined;

  if (event.version === 2) {
    if (!Number.isSafeInteger(event.graphRevision) || event.graphRevision < 1 || event.graphRevision !== expectedGraphRevision) {
      recordRevisionDiagnostic(state, {
        code: "graph_revision_gap",
        goalId: event.goalId,
        eventKind: event.kind,
        at: event.at,
        todoId,
        expectedGraphRevision,
        receivedGraphRevision: event.graphRevision,
        message: `rejected v2 ${event.kind}: expected graphRevision=${expectedGraphRevision}, received ${event.graphRevision}`,
      });
      return false;
    }
    if (event.kind === "add" && existing) {
      recordRevisionDiagnostic(state, {
        code: "node_revision_conflict",
        goalId: event.goalId,
        eventKind: event.kind,
        at: event.at,
        todoId,
        expectedGraphRevision,
        receivedGraphRevision: event.graphRevision,
        expectedNodeRevision,
        receivedNodeRevision: event.nodeRevision,
        message: `rejected v2 add: TODO ${todoId} already exists at revision ${existing.revision ?? 0}`,
      });
      return false;
    }
    if (event.kind === "add" && (event.node.revision ?? 0) > 0 && event.node.revision !== event.nodeRevision) {
      recordRevisionDiagnostic(state, {
        code: "node_revision_conflict",
        goalId: event.goalId,
        eventKind: event.kind,
        at: event.at,
        todoId,
        expectedGraphRevision,
        receivedGraphRevision: event.graphRevision,
        expectedNodeRevision,
        receivedNodeRevision: event.nodeRevision,
        message: `rejected v2 add: envelope nodeRevision=${event.nodeRevision} conflicts with node revision=${event.node.revision}`,
      });
      return false;
    }
    if (todoId && (!Number.isSafeInteger(event.nodeRevision) || event.nodeRevision !== expectedNodeRevision)) {
      recordRevisionDiagnostic(state, {
        code: "node_revision_gap",
        goalId: event.goalId,
        eventKind: event.kind,
        at: event.at,
        todoId,
        expectedGraphRevision,
        receivedGraphRevision: event.graphRevision,
        expectedNodeRevision,
        receivedNodeRevision: event.nodeRevision,
        message: `rejected v2 ${event.kind}: expected nodeRevision=${expectedNodeRevision}, received ${event.nodeRevision}`,
      });
      return false;
    }
  }

  const before = new Map(state.nodes.filter((node) => node.goalId === event.goalId).map((node) => [node.id, cloneNode(node)]));
  applyEventMutation(state, event);
  state.graphRevisions[event.goalId] = expectedGraphRevision;

  const affected = new Set<string>();
  for (const node of state.nodes.filter((candidate) => candidate.goalId === event.goalId)) {
    const prior = before.get(node.id);
    if (!prior || nodeWithoutRevision(prior) !== nodeWithoutRevision(node)) affected.add(node.id);
  }
  if (todoId && state.nodes.some((node) => node.goalId === event.goalId && node.id === todoId)) affected.add(todoId);
  for (const affectedId of affected) {
    const node = state.nodes.find((candidate) => candidate.goalId === event.goalId && candidate.id === affectedId);
    if (!node) continue;
    const prior = before.get(affectedId);
    node.revision = prior ? (prior.revision ?? 0) + 1 : 1;
  }
  return true;
}

export function normalizeEvent(value: unknown, deterministicAt = 0): GoalTodoEvent | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || typeof value.kind !== "string" || typeof value.goalId !== "string") return undefined;
  const source = value.source === "tool" || value.source === "runtime" || value.source === "delegation" || value.source === "import" ? value.source : "command";
  const at = Math.trunc(numberField(value, "at") ?? deterministicAt);
  let event: GoalTodoLegacyEvent | undefined;
  if (value.kind === "policy_set") {
    const policy = normalizePolicy(value.policy);
    if (policy) event = { version: 1, kind: "policy_set", source, goalId: value.goalId, policy, at };
  } else if (value.kind === "add") {
    const node = normalizeNode(value.node, at);
    if (node) event = { version: 1, kind: "add", source, goalId: value.goalId, node, at };
  } else if (value.kind === "patch" && typeof value.todoId === "string" && isRecord(value.patch)) event = {
    version: 1,
    kind: "patch",
    source,
    goalId: value.goalId,
    todoId: value.todoId,
    patch: value.patch as Partial<GoalTodoNode>,
    clearFields: stringArray(value.clearFields).filter((field): field is GoalTodoPatchClearField => GOAL_TODO_PATCH_CLEAR_FIELDS.has(field as GoalTodoPatchClearField)),
    at,
  };
  else if (value.kind === "move" && typeof value.todoId === "string") event = { version: 1, kind: "move", source, goalId: value.goalId, todoId: value.todoId, parentId: typeof value.parentId === "string" ? value.parentId : undefined, at };
  else if (value.kind === "split" && typeof value.todoId === "string") event = { version: 1, kind: "split", source, goalId: value.goalId, todoId: value.todoId, childIds: stringArray(value.childIds), at };
  else if (value.kind === "delegate_link" && typeof value.todoId === "string" && typeof value.runId === "string") {
    const delegation = normalizeDelegation(value.delegation);
    if (delegation) event = { version: 1, kind: "delegate_link", source, goalId: value.goalId, todoId: value.todoId, runId: value.runId, delegation, at };
  } else if ((value.kind === "delegation_attempt_started" || value.kind === "delegation_attempt_finalized") && typeof value.todoId === "string") {
    const attempt = normalizeDelegationAttempt(value.attempt);
    if (attempt && attempt.goalId === value.goalId && attempt.todoId === value.todoId) event = value.kind === "delegation_attempt_started"
      ? { version: 1, kind: "delegation_attempt_started", source, goalId: value.goalId, todoId: value.todoId, attempt, at }
      : { version: 1, kind: "delegation_attempt_finalized", source, goalId: value.goalId, todoId: value.todoId, attempt, at };
  } else if (value.kind === "attempt_recovered" && typeof value.todoId === "string") {
    const recovery = normalizeDelegationRecovery(value.recovery);
    if (recovery && recovery.recoveredAt === at) event = { version: 1, kind: "attempt_recovered", source, goalId: value.goalId, todoId: value.todoId, recovery, at };
  } else if (value.kind === "claim_returned" && typeof value.todoId === "string" && typeof value.claimHash === "string") {
    const attempt = normalizeDelegationAttempt(value.attempt);
    const claim = normalizeClaim(value.claim, at);
    event = { version: 1, kind: "claim_returned", source, goalId: value.goalId, todoId: value.todoId, claimHash: value.claimHash, claim, evidenceRefs: stringArray(value.evidenceRefs), validationCommands: stringArray(value.validationCommands), noShip: typeof value.noShip === "boolean" ? value.noShip : undefined, runId: typeof value.runId === "string" ? value.runId : undefined, outputHash: typeof value.outputHash === "string" ? value.outputHash : undefined, outputContract: typeof value.outputContract === "string" ? value.outputContract : undefined, gatePassed: typeof value.gatePassed === "boolean" ? value.gatePassed : undefined, childGoalStatus: includesString(VALID_CHILD_GOAL_STATUS, value.childGoalStatus) ? value.childGoalStatus : undefined, statusClaim: includesString(VALID_STATUS_CLAIM, value.statusClaim) ? value.statusClaim : undefined, targetReadiness: includesString(VALID_TARGET_READINESS, value.targetReadiness) ? value.targetReadiness : undefined, acceptanceBlockers: stringArray(value.acceptanceBlockers), childChangedPaths: normalizeChildChangedPathRefs(value.childChangedPaths), attempt, at };
  }
  else if (value.kind === "claim_validation_requested" && typeof value.todoId === "string") {
    const validation = normalizeValidation(value.validation);
    if (validation) event = { version: 1, kind: "claim_validation_requested", source, goalId: value.goalId, todoId: value.todoId, validation, at };
  } else if (value.kind === "claim_validation_returned" && typeof value.todoId === "string") {
    const validation = normalizeValidation(value.validation);
    if (validation) event = { version: 1, kind: "claim_validation_returned", source, goalId: value.goalId, todoId: value.todoId, validation, evidenceRefs: stringArray(value.evidenceRefs), validationCommands: stringArray(value.validationCommands), noShip: typeof value.noShip === "boolean" ? value.noShip : undefined, at };
  } else if (value.kind === "claim_accepted" && typeof value.todoId === "string") event = { version: 1, kind: "claim_accepted", source, goalId: value.goalId, todoId: value.todoId, binding: normalizeClaimResolutionBinding(value.binding), evidenceRefs: stringArray(value.evidenceRefs), validationCommands: stringArray(value.validationCommands), at };
  else if (value.kind === "claim_rejected" && typeof value.todoId === "string" && typeof value.reasonHash === "string") event = { version: 1, kind: "claim_rejected", source, goalId: value.goalId, todoId: value.todoId, binding: normalizeClaimResolutionBinding(value.binding), reasonHash: value.reasonHash, at };
  else if (value.kind === "clear_goal_todos") event = { version: 1, kind: "clear_goal_todos", source, goalId: value.goalId, at };
  else if (value.kind === "focus") event = { version: 1, kind: "focus", source, goalId: value.goalId, todoId: typeof value.todoId === "string" ? value.todoId : undefined, at };
  else if (value.kind === "snapshot") {
    const nodes = Array.isArray(value.nodes) ? value.nodes.map((node) => normalizeNode(node, at)).filter((node): node is GoalTodoNode => Boolean(node)) : [];
    event = { version: 1, kind: "snapshot", source, goalId: value.goalId, nodes, policy: normalizePolicy(value.policy), focusTodoId: typeof value.focusTodoId === "string" ? value.focusTodoId : undefined, at };
  }
  if (!event || value.version === 1) return event;
  const graphRevision = numberField(value, "graphRevision");
  const nodeRevision = numberField(value, "nodeRevision");
  if (!Number.isSafeInteger(graphRevision) || (graphRevision ?? 0) < 1) return undefined;
  if (eventTodoId(event) && (!Number.isSafeInteger(nodeRevision) || (nodeRevision ?? 0) < 1)) return undefined;
  return { ...event, version: 2, graphRevision: graphRevision as number, nodeRevision } as GoalTodoEvent;
}

export function restoreGoalTodosFromBranch(entries: Iterable<unknown>): GoalTodoState {
  const state = createGoalTodoState();
  let ordering = 0;
  let branchOrdering = 0;
  for (const entry of entries) {
    branchOrdering += 1;
    indexGoalMutationReceiptEntry(state.mutationReceipts, entry, branchOrdering);
    if (!isRecord(entry) || entry.customType !== ZOB_GOAL_TODO_ENTRY_TYPE || !isRecord(entry.data)) continue;
    ordering += 1;
    const event = normalizeEvent(entry.data, ordering);
    if (event) {
      applyEvent(state, event);
      continue;
    }
    if (entry.data.version === 2 && typeof entry.data.goalId === "string") {
      recordRevisionDiagnostic(state, {
        code: "malformed_v2_revision",
        goalId: entry.data.goalId,
        eventKind: typeof entry.data.kind === "string" ? entry.data.kind : "unknown",
        at: Math.trunc(numberField(entry.data, "at") ?? ordering),
        todoId: typeof entry.data.todoId === "string" ? entry.data.todoId : undefined,
        receivedGraphRevision: numberField(entry.data, "graphRevision"),
        receivedNodeRevision: numberField(entry.data, "nodeRevision"),
        message: "rejected malformed v2 Goal/TODO revision envelope",
      });
    }
  }
  finalizeGoalMutationReceiptRestore(state.mutationReceipts);
  return state;
}

export function goalRoomMetadata(message: Record<string, unknown>): Record<string, unknown> {
  return isRecord(message.metadata) ? message.metadata : {};
}

export function reducerStringArray(value: unknown): string[] {
  return stringArray(value).slice(0, 20);
}

export function goalRoomMessageString(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function baseTodoReducerDecision(message: Record<string, unknown>, reasonCodes: string[] = []): GoalRoomTodoReducerDecision {
  return {
    schema: "zob.todo-event-reducer-decision.v1",
    action: "ignore",
    reasonCodes,
    goalId: goalRoomMessageString(message, "goalId"),
    todoId: goalRoomMessageString(message, "todoId"),
    sourceMsgId: goalRoomMessageString(message, "msgId"),
    sourceKind: goalRoomMessageString(message, "kind"),
    runId: goalRoomMessageString(message, "runId"),
    outputHash: goalRoomMessageString(message, "outputHash"),
    evidenceRefs: reducerStringArray(message.evidenceRefs),
    validationCommands: [],
    acceptanceBlockers: [],
    parentOwnedActions: true,
    directMutationByWorker: false,
    reducerRequiredForTodoMutation: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}
