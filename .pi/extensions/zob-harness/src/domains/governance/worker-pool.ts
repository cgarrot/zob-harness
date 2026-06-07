import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RULES } from "../../core/constants.js";
import { appendGoalRoomMessage } from "../goal/goal-room.js";
import type { TeamDefinition } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { readJsonl } from "../../core/utils/json.js";
import { newRunId, pathMatches, resolveRepoPath, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import { listWorkspaceClaims, type WorkspaceClaimRecord } from "./workspace-claims.js";

export type WorkerPoolCommunicationPolicyMode = "goal_room_only" | "goal_room_with_optional_live";
export type WorkerPoolDecision = "approved" | "rejected" | "needs_parent" | "owner_will_handle";

export interface WorkerPoolCommunicationPolicyInput {
  mode?: WorkerPoolCommunicationPolicyMode;
  parent_visible?: boolean;
  hidden_peer_chat?: boolean;
  worker_to_worker_direct?: boolean;
  required_local_live?: boolean;
  goal_room_canonical?: boolean;
}

export interface WorkerPoolAssignmentInput {
  worker_id: string;
  agent_name: string;
  owned_paths: string[];
  write_paths: string[];
  read_across_paths?: string[];
  read_across_write_overlap_justification_hash?: string;
  forbidden_paths?: string[];
  todo_id?: string;
  child_goal_id?: string;
  run_id?: string;
  workspace_claim_ids?: string[];
  communication_policy?: WorkerPoolCommunicationPolicyInput;
}

export interface WorkerPoolPlanInput {
  goal_id: string;
  pool_id?: string;
  run_id?: string;
  todo_id?: string;
  owner: string;
  assignments: WorkerPoolAssignmentInput[];
  forbidden_paths?: string[];
  communication_policy?: WorkerPoolCommunicationPolicyInput;
}

export interface WorkerPoolStatusInput {
  goal_id?: string;
  pool_id?: string;
  run_id?: string;
  limit?: number;
}

export interface WorkerPoolOwnerRequestInput {
  goal_id: string;
  pool_id: string;
  request_id?: string;
  run_id?: string;
  todo_id?: string;
  requester: string;
  owner_worker: string;
  requested_paths: string[];
  change_hash: string;
  reason_hash: string;
  evidence_refs?: string[];
  artifact_refs?: string[];
}

export interface WorkerPoolOwnerDecisionInput {
  goal_id: string;
  pool_id: string;
  request_id: string;
  run_id?: string;
  todo_id?: string;
  decided_by: string;
  owner_worker: string;
  requester?: string;
  decision: WorkerPoolDecision;
  decision_hash: string;
  evidence_refs?: string[];
  artifact_refs?: string[];
}

export interface WorkerPoolCommunicationPolicyRecord {
  mode: WorkerPoolCommunicationPolicyMode;
  parentVisible: true;
  hiddenPeerChat: false;
  workerToWorkerDirect: false;
  requiredLocalLive: boolean;
  goalRoomCanonical: true;
}

export interface WorkerPoolAssignmentRecord {
  workerId: string;
  agentName: string;
  ownedPaths: string[];
  ownedPathHashes: string[];
  writePaths: string[];
  writePathHashes: string[];
  readAcrossPaths: string[];
  readAcrossPathHashes: string[];
  readAcrossWriteOverlapJustificationHash: string | null;
  forbiddenPaths: string[];
  todoId: string | null;
  childGoalId: string | null;
  runId: string | null;
  workspaceClaimIds: string[];
  workspaceClaimsCoverWriteIntent: boolean;
  communicationPolicy: WorkerPoolCommunicationPolicyRecord;
}

export interface WorkerPoolConflictRecord {
  schema: "zob.worker-pool-conflict.v1";
  type: "assignment_write_overlap" | "workspace_claim_overlap" | "owner_request_plan_mismatch";
  poolId: string;
  workerIds: string[];
  paths: string[];
  conflictHash: string;
  parentOwnedResolutionRequired: true;
  writesBlocked: true;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface WorkerPoolSafetyGateRecord {
  schema: "zob.worker-pool-safety-gates.v1";
  workspaceClaimsChecked: true;
  ownerPathCoverageRequired: true;
  sandboxIsolationRequired: true;
  mergeQueueRequired: true;
  rollbackMetadataRequired: true;
  oracleReviewRequiredForRiskyMerge: true;
  parentOwnedApplyOnly: true;
  productionWritesPerformed: false;
  autoApply: false;
}

export interface WorkerPoolPlanRecord {
  schema: "zob.worker-pool-plan.v1";
  poolId: string;
  goalId: string;
  runId: string | null;
  todoId: string | null;
  owner: string;
  assignments: WorkerPoolAssignmentRecord[];
  forbiddenPaths: string[];
  communicationPolicy: WorkerPoolCommunicationPolicyRecord;
  conflicts: WorkerPoolConflictRecord[];
  status: "planned" | "blocked_conflict";
  safetyGates: WorkerPoolSafetyGateRecord;
  parentOwned: true;
  readAcrossWriteByOwner: true;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  createdAt: string;
}

export interface WorkerPoolOwnerRequestRecord {
  schema: "zob.worker-pool-owner-request.v1";
  requestId: string;
  poolId: string;
  goalId: string;
  runId: string | null;
  todoId: string | null;
  requester: string;
  ownerWorker: string;
  requestedPaths: string[];
  requestedPathHashes: string[];
  changeHash: string;
  reasonHash: string;
  planValidation: "covered_by_owner" | "blocked_no_plan" | "blocked_unknown_owner" | "blocked_uncovered_paths";
  parentOwnedConflict: boolean;
  goalRoomMsgId: string;
  parentVisible: true;
  hiddenPeerChat: false;
  workerToWorkerDirect: false;
  parentOwnedDecisionRequired: true;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  createdAt: string;
}

export interface WorkerPoolOwnerDecisionRecord {
  schema: "zob.worker-pool-owner-decision.v1";
  decisionId: string;
  requestId: string;
  poolId: string;
  goalId: string;
  runId: string | null;
  todoId: string | null;
  decidedBy: string;
  ownerWorker: string;
  requester: string | null;
  decision: WorkerPoolDecision;
  decisionHash: string;
  goalRoomMsgId: string;
  parentVisible: true;
  hiddenPeerChat: false;
  workerToWorkerDirect: false;
  parentOwnedActions: true;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  createdAt: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const MAX_ASSIGNMENTS = 32;
const MAX_PATHS = 100;
const FORBIDDEN_PLAINTEXT_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "text", "rationale", "diff", "patch"]);
const DECISIONS = new Set<WorkerPoolDecision>(["approved", "rejected", "needs_parent", "owner_will_handle"]);

function hasForbiddenPlaintextKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenPlaintextKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_PLAINTEXT_KEYS.has(key) || hasForbiddenPlaintextKeys(child));
}

function workerPoolsDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "worker-pools");
}

function plansPath(repoRoot: string): string {
  return join(workerPoolsDir(repoRoot), "plans.jsonl");
}

function requestsPath(repoRoot: string): string {
  return join(workerPoolsDir(repoRoot), "owner-requests.jsonl");
}

function decisionsPath(repoRoot: string): string {
  return join(workerPoolsDir(repoRoot), "owner-decisions.jsonl");
}

function knownRoleIds(definition: TeamDefinition): Set<string> {
  return new Set([definition.orchestrator.id, ...definition.leads.map((lead) => lead.id), ...definition.workers.map((worker) => worker.id), "parent", "mission-control"]);
}

function normalizeUnique(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function communicationPolicy(input?: WorkerPoolCommunicationPolicyInput): WorkerPoolCommunicationPolicyRecord {
  return {
    mode: input?.mode === "goal_room_with_optional_live" ? "goal_room_with_optional_live" : "goal_room_only",
    parentVisible: true,
    hiddenPeerChat: false,
    workerToWorkerDirect: false,
    requiredLocalLive: input?.required_local_live === true,
    goalRoomCanonical: true,
  };
}

function validatePathList(repoRoot: string, paths: string[] | undefined, label: string, allowZeroAccessDenyRefs = false): string[] {
  const errors: string[] = [];
  const normalized = normalizeUnique(paths);
  if (normalized.length > MAX_PATHS) errors.push(`${label} are capped at ${MAX_PATHS}`);
  for (const path of normalized) {
    if (path.includes("\0")) {
      errors.push(`${label} contains NUL byte`);
      continue;
    }
    const resolved = resolveRepoPath(repoRoot, path);
    errors.push(...resolved.errors.map((error) => `${label}: ${error}`));
    if (!allowZeroAccessDenyRefs) {
      for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
        if (pathMatches(path, protectedPattern, repoRoot, repoRoot)) errors.push(`${label} references zero-access path: ${protectedPattern}`);
      }
    }
  }
  return errors;
}

function validateSafeIds(input: { goal_id?: string; pool_id?: string; run_id?: string; todo_id?: string; request_id?: string; child_goal_id?: string }, errors: string[]): void {
  for (const [key, value] of Object.entries(input)) {
    if (value && safeFileStem(value) !== value) errors.push(`${key} must be path-safe: ${value}`);
  }
}

function validateWorkerPoolPlanInput(repoRoot: string, definition: TeamDefinition, input: WorkerPoolPlanInput): string[] {
  const errors: string[] = [];
  validateSafeIds({ goal_id: input.goal_id, pool_id: input.pool_id, run_id: input.run_id, todo_id: input.todo_id }, errors);
  if (!input.goal_id) errors.push("worker pool goal_id is required");
  if (!knownRoleIds(definition).has(input.owner)) errors.push(`Unknown worker-pool owner '${input.owner}'`);
  if (!Array.isArray(input.assignments) || input.assignments.length === 0) errors.push("worker pool requires at least one assignment");
  if ((input.assignments ?? []).length > MAX_ASSIGNMENTS) errors.push(`worker pool assignments are capped at ${MAX_ASSIGNMENTS}`);
  if (hasForbiddenPlaintextKeys(input)) errors.push("worker pool input must not contain raw body/task/prompt/output/content/message/text/rationale/diff/patch keys");
  errors.push(...validatePathList(repoRoot, input.forbidden_paths, "pool forbidden_paths", true));
  for (const assignment of input.assignments ?? []) {
    validateSafeIds({ run_id: assignment.run_id, todo_id: assignment.todo_id, child_goal_id: assignment.child_goal_id }, errors);
    if (!knownRoleIds(definition).has(assignment.worker_id)) errors.push(`Unknown worker-pool assignment worker_id '${assignment.worker_id}'`);
    if (!assignment.agent_name || assignment.agent_name.trim().length === 0) errors.push(`worker ${assignment.worker_id} requires agent_name`);
    if (!Array.isArray(assignment.owned_paths) || assignment.owned_paths.length === 0) errors.push(`worker ${assignment.worker_id} requires owned_paths`);
    if (!Array.isArray(assignment.write_paths) || assignment.write_paths.length === 0) errors.push(`worker ${assignment.worker_id} requires write_paths`);
    errors.push(...validatePathList(repoRoot, assignment.owned_paths, `worker ${assignment.worker_id} owned_paths`));
    errors.push(...validatePathList(repoRoot, assignment.write_paths, `worker ${assignment.worker_id} write_paths`));
    errors.push(...validatePathList(repoRoot, assignment.read_across_paths, `worker ${assignment.worker_id} read_across_paths`));
    errors.push(...validatePathList(repoRoot, assignment.forbidden_paths, `worker ${assignment.worker_id} forbidden_paths`, true));
    for (const claimId of assignment.workspace_claim_ids ?? []) {
      if (!claimId || safeFileStem(claimId) !== claimId) errors.push(`worker ${assignment.worker_id} workspace_claim_ids must be path-safe: ${claimId}`);
    }
    if (assignment.read_across_write_overlap_justification_hash !== undefined && !SHA256_HEX.test(assignment.read_across_write_overlap_justification_hash)) errors.push(`worker ${assignment.worker_id} read_across_write_overlap_justification_hash must be sha256 hex`);
    if (Array.isArray(assignment.owned_paths) && Array.isArray(assignment.write_paths) && !pathsCoveredByOwnedPaths(repoRoot, assignment.write_paths, assignment.owned_paths)) errors.push(`worker ${assignment.worker_id} write_paths must be within owned_paths`);
    const readWriteOverlap = (assignment.read_across_paths ?? []).some((readPath) => (assignment.write_paths ?? []).some((writePath) => pathsOverlap(repoRoot, readPath, writePath)));
    if (readWriteOverlap && !assignment.read_across_write_overlap_justification_hash) errors.push(`worker ${assignment.worker_id} read_across_paths overlap write_paths and require read_across_write_overlap_justification_hash`);
    if (assignment.communication_policy?.parent_visible === false || assignment.communication_policy?.hidden_peer_chat === true || assignment.communication_policy?.worker_to_worker_direct === true || assignment.communication_policy?.goal_room_canonical === false) {
      errors.push(`worker ${assignment.worker_id} communication policy must be parent-visible, Goal Room canonical, and not direct hidden peer chat`);
    }
  }
  if (input.communication_policy?.parent_visible === false || input.communication_policy?.hidden_peer_chat === true || input.communication_policy?.worker_to_worker_direct === true || input.communication_policy?.goal_room_canonical === false) {
    errors.push("pool communication policy must be parent-visible, Goal Room canonical, and not direct hidden peer chat");
  }
  return errors;
}

function normalizedPath(repoRoot: string, path: string): string {
  return resolveRepoPath(repoRoot, path).path.replace(/\/+$/g, "");
}

function pathsOverlap(repoRoot: string, left: string, right: string): boolean {
  const a = normalizedPath(repoRoot, left);
  const b = normalizedPath(repoRoot, right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function pathWithinOwnedPath(repoRoot: string, path: string, ownedPath: string): boolean {
  const candidate = normalizedPath(repoRoot, path);
  const owner = normalizedPath(repoRoot, ownedPath);
  return candidate === owner || candidate.startsWith(`${owner}/`);
}

function pathsCoveredByOwnedPaths(repoRoot: string, paths: string[], ownedPaths: string[]): boolean {
  return paths.every((path) => ownedPaths.some((ownedPath) => pathWithinOwnedPath(repoRoot, path, ownedPath)));
}

function safetyGates(): WorkerPoolSafetyGateRecord {
  return {
    schema: "zob.worker-pool-safety-gates.v1",
    workspaceClaimsChecked: true,
    ownerPathCoverageRequired: true,
    sandboxIsolationRequired: true,
    mergeQueueRequired: true,
    rollbackMetadataRequired: true,
    oracleReviewRequiredForRiskyMerge: true,
    parentOwnedApplyOnly: true,
    productionWritesPerformed: false,
    autoApply: false,
  };
}

function buildAssignmentOverlapConflicts(repoRoot: string, poolId: string, assignments: WorkerPoolAssignmentRecord[]): WorkerPoolConflictRecord[] {
  const conflicts: WorkerPoolConflictRecord[] = [];
  for (let i = 0; i < assignments.length; i += 1) {
    for (let j = i + 1; j < assignments.length; j += 1) {
      const left = assignments[i];
      const right = assignments[j];
      const paths = left.writePaths.filter((path) => right.writePaths.some((candidate) => pathsOverlap(repoRoot, path, candidate)));
      if (paths.length === 0) continue;
      const workerIds = [left.workerId, right.workerId].sort();
      const normalizedPaths = normalizeUnique(paths);
      conflicts.push({
        schema: "zob.worker-pool-conflict.v1",
        type: "assignment_write_overlap",
        poolId,
        workerIds,
        paths: normalizedPaths,
        conflictHash: sha256(JSON.stringify({ type: "assignment_write_overlap", poolId, workerIds, paths: normalizedPaths })),
        parentOwnedResolutionRequired: true,
        writesBlocked: true,
        productionWritesPerformed: false,
        autoApply: false,
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
      });
    }
  }
  return conflicts;
}

function assignmentOwnClaimCoversPath(repoRoot: string, assignment: WorkerPoolAssignmentRecord, claim: WorkspaceClaimRecord, path: string): boolean {
  return assignment.workspaceClaimIds.includes(claim.claimId) && claim.claimant === assignment.workerId && claim.mode === "write" && claim.paths.some((claimedPath) => pathWithinOwnedPath(repoRoot, path, claimedPath));
}

function workspaceClaimsCoverWriteIntent(repoRoot: string, assignment: WorkerPoolAssignmentRecord): boolean {
  if (assignment.workspaceClaimIds.length === 0) return false;
  const claims = listWorkspaceClaims(repoRoot, { include_expired: false, include_released: false, limit: 100 }) as WorkspaceClaimRecord[];
  return assignment.writePaths.every((path) => claims.some((claim) => assignmentOwnClaimCoversPath(repoRoot, assignment, claim, path)));
}

function buildWorkspaceOverlapConflicts(repoRoot: string, poolId: string, assignments: WorkerPoolAssignmentRecord[]): WorkerPoolConflictRecord[] {
  const claims = listWorkspaceClaims(repoRoot, { include_expired: false, include_released: false, limit: 100 }) as WorkspaceClaimRecord[];
  const conflicts: WorkerPoolConflictRecord[] = [];
  for (const assignment of assignments) {
    assignment.workspaceClaimsCoverWriteIntent = workspaceClaimsCoverWriteIntent(repoRoot, assignment);
    const overlaps = claims.flatMap((claim) => assignment.writePaths
      .filter((path) => claim.paths.some((claimedPath) => pathsOverlap(repoRoot, path, claimedPath)) && !assignmentOwnClaimCoversPath(repoRoot, assignment, claim, path))
      .map((path) => ({ claim, path })));
    if (overlaps.length === 0) continue;
    const claimIds = [...new Set(overlaps.map((overlap) => overlap.claim.claimId))].sort();
    const paths = normalizeUnique(overlaps.map((overlap) => overlap.path));
    conflicts.push({
      schema: "zob.worker-pool-conflict.v1",
      type: "workspace_claim_overlap",
      poolId,
      workerIds: [assignment.workerId, ...claimIds].sort(),
      paths,
      conflictHash: sha256(JSON.stringify({ type: "workspace_claim_overlap", poolId, workerId: assignment.workerId, claimIds, paths })),
      parentOwnedResolutionRequired: true,
      writesBlocked: true,
      productionWritesPerformed: false,
      autoApply: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    });
  }
  return conflicts;
}

function buildAssignment(input: WorkerPoolAssignmentInput): WorkerPoolAssignmentRecord {
  const ownedPaths = normalizeUnique(input.owned_paths);
  const writePaths = normalizeUnique(input.write_paths);
  const readAcrossPaths = normalizeUnique(input.read_across_paths);
  return {
    workerId: input.worker_id,
    agentName: input.agent_name,
    ownedPaths,
    ownedPathHashes: ownedPaths.map((path) => sha256(path)),
    writePaths,
    writePathHashes: writePaths.map((path) => sha256(path)),
    readAcrossPaths,
    readAcrossPathHashes: readAcrossPaths.map((path) => sha256(path)),
    readAcrossWriteOverlapJustificationHash: input.read_across_write_overlap_justification_hash ?? null,
    forbiddenPaths: normalizeUnique(input.forbidden_paths),
    todoId: input.todo_id ?? null,
    childGoalId: input.child_goal_id ?? null,
    runId: input.run_id ?? null,
    workspaceClaimIds: normalizeUnique(input.workspace_claim_ids),
    workspaceClaimsCoverWriteIntent: false,
    communicationPolicy: communicationPolicy(input.communication_policy),
  };
}

export function createWorkerPoolPlan(repoRoot: string, definition: TeamDefinition, input: WorkerPoolPlanInput): WorkerPoolPlanRecord {
  const errors = validateWorkerPoolPlanInput(repoRoot, definition, input);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const poolId = input.pool_id ?? newRunId("wpool");
  if (safeFileStem(poolId) !== poolId) throw new Error(`pool_id must be path-safe: ${poolId}`);
  const assignments = input.assignments.map(buildAssignment);
  const conflicts = [...buildAssignmentOverlapConflicts(repoRoot, poolId, assignments), ...buildWorkspaceOverlapConflicts(repoRoot, poolId, assignments)];
  const record: WorkerPoolPlanRecord = {
    schema: "zob.worker-pool-plan.v1",
    poolId,
    goalId: input.goal_id,
    runId: input.run_id ?? null,
    todoId: input.todo_id ?? null,
    owner: input.owner,
    assignments,
    forbiddenPaths: normalizeUnique(input.forbidden_paths),
    communicationPolicy: communicationPolicy(input.communication_policy),
    conflicts,
    status: conflicts.length > 0 ? "blocked_conflict" : "planned",
    safetyGates: safetyGates(),
    parentOwned: true,
    readAcrossWriteByOwner: true,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt: new Date().toISOString(),
  };
  if (hasForbiddenPlaintextKeys(record)) throw new Error("worker pool record would contain forbidden plaintext keys");
  mkdirSync(workerPoolsDir(repoRoot), { recursive: true });
  appendFileSync(plansPath(repoRoot), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function readPlans(repoRoot: string): WorkerPoolPlanRecord[] {
  if (!existsSync(plansPath(repoRoot))) return [];
  return readJsonl(plansPath(repoRoot)).filter(isWorkerPoolPlanRecord).map((record) => record as unknown as WorkerPoolPlanRecord);
}

export function listWorkerPoolPlans(repoRoot: string, input: WorkerPoolStatusInput = {}): WorkerPoolPlanRecord[] {
  if (input.goal_id && safeFileStem(input.goal_id) !== input.goal_id) throw new Error(`goal_id must be path-safe: ${input.goal_id}`);
  if (input.pool_id && safeFileStem(input.pool_id) !== input.pool_id) throw new Error(`pool_id must be path-safe: ${input.pool_id}`);
  if (input.run_id && safeFileStem(input.run_id) !== input.run_id) throw new Error(`run_id must be path-safe: ${input.run_id}`);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  return readPlans(repoRoot)
    .filter((plan) => !input.goal_id || plan.goalId === input.goal_id)
    .filter((plan) => !input.pool_id || plan.poolId === input.pool_id)
    .filter((plan) => !input.run_id || plan.runId === input.run_id)
    .slice(-limit);
}

function validateOwnerRequestAgainstPlan(repoRoot: string, input: WorkerPoolOwnerRequestInput): string[] {
  const plan = readPlans(repoRoot).filter((candidate) => candidate.poolId === input.pool_id && candidate.goalId === input.goal_id).at(-1);
  if (!plan) return [`owner request pool plan not found for ${input.pool_id}`];
  const ownerAssignment = plan.assignments.find((assignment) => assignment.workerId === input.owner_worker);
  if (!ownerAssignment) return [`owner request owner_worker '${input.owner_worker}' is not an assignment owner in pool ${input.pool_id}`];
  const ownerCoverage = [...ownerAssignment.ownedPaths, ...ownerAssignment.writePaths];
  if (!pathsCoveredByOwnedPaths(repoRoot, input.requested_paths, ownerCoverage)) return [`owner request requested_paths must be covered by owner_worker '${input.owner_worker}' owned/write paths`];
  return [];
}

function validateOwnerRequest(repoRoot: string, definition: TeamDefinition, input: WorkerPoolOwnerRequestInput): string[] {
  const errors: string[] = [];
  validateSafeIds({ goal_id: input.goal_id, pool_id: input.pool_id, run_id: input.run_id, todo_id: input.todo_id, request_id: input.request_id }, errors);
  if (!knownRoleIds(definition).has(input.requester)) errors.push(`Unknown owner request requester '${input.requester}'`);
  if (!knownRoleIds(definition).has(input.owner_worker)) errors.push(`Unknown owner request owner_worker '${input.owner_worker}'`);
  if (!SHA256_HEX.test(input.change_hash)) errors.push("owner request change_hash must be sha256 hex");
  if (!SHA256_HEX.test(input.reason_hash)) errors.push("owner request reason_hash must be sha256 hex");
  if (!Array.isArray(input.requested_paths) || input.requested_paths.length === 0) errors.push("owner request requires requested_paths");
  errors.push(...validatePathList(repoRoot, input.requested_paths, "owner request requested_paths"));
  if (Array.isArray(input.requested_paths) && input.requested_paths.length > 0) errors.push(...validateOwnerRequestAgainstPlan(repoRoot, input));
  if (hasForbiddenPlaintextKeys(input)) errors.push("owner request input must not contain raw body/task/prompt/output/content/message/text/rationale/diff/patch keys");
  return errors;
}

export function createWorkerPoolOwnerRequest(repoRoot: string, definition: TeamDefinition, input: WorkerPoolOwnerRequestInput): WorkerPoolOwnerRequestRecord {
  const errors = validateOwnerRequest(repoRoot, definition, input);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const requestId = input.request_id ?? newRunId("ownerreq");
  if (safeFileStem(requestId) !== requestId) throw new Error(`request_id must be path-safe: ${requestId}`);
  const requestedPaths = normalizeUnique(input.requested_paths);
  const goalRoomMessage = appendGoalRoomMessage(repoRoot, definition, {
    goal_id: input.goal_id,
    run_id: input.run_id,
    todo_id: input.todo_id,
    sender: input.requester,
    audience: "parent",
    kind: "OWNER_CHANGE_REQUEST",
    priority: "high",
    body_hash: input.reason_hash,
    task_id: requestId,
    output_hash: input.change_hash,
    evidence_refs: input.evidence_refs,
    artifact_refs: input.artifact_refs,
    requires_parent_action: true,
    metadata: { schema: "zob.worker-pool-owner-request-ref.v1", poolId: input.pool_id, requestId, requester: input.requester, ownerWorker: input.owner_worker, requestedPaths, requestedPathHashes: requestedPaths.map((path) => sha256(path)), planValidation: "covered_by_owner", parentOwnedConflict: false, parentVisible: true, hiddenPeerChat: false, workerToWorkerDirect: false },
  });
  const record: WorkerPoolOwnerRequestRecord = {
    schema: "zob.worker-pool-owner-request.v1",
    requestId,
    poolId: input.pool_id,
    goalId: input.goal_id,
    runId: input.run_id ?? null,
    todoId: input.todo_id ?? null,
    requester: input.requester,
    ownerWorker: input.owner_worker,
    requestedPaths,
    requestedPathHashes: requestedPaths.map((path) => sha256(path)),
    changeHash: input.change_hash,
    reasonHash: input.reason_hash,
    planValidation: "covered_by_owner",
    parentOwnedConflict: false,
    goalRoomMsgId: String(goalRoomMessage.msgId),
    parentVisible: true,
    hiddenPeerChat: false,
    workerToWorkerDirect: false,
    parentOwnedDecisionRequired: true,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt: new Date().toISOString(),
  };
  if (hasForbiddenPlaintextKeys(record)) throw new Error("worker pool owner request record would contain forbidden plaintext keys");
  mkdirSync(workerPoolsDir(repoRoot), { recursive: true });
  appendFileSync(requestsPath(repoRoot), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function validateOwnerDecision(definition: TeamDefinition, input: WorkerPoolOwnerDecisionInput): string[] {
  const errors: string[] = [];
  validateSafeIds({ goal_id: input.goal_id, pool_id: input.pool_id, run_id: input.run_id, todo_id: input.todo_id, request_id: input.request_id }, errors);
  if (!knownRoleIds(definition).has(input.decided_by)) errors.push(`Unknown owner decision decided_by '${input.decided_by}'`);
  if (!knownRoleIds(definition).has(input.owner_worker)) errors.push(`Unknown owner decision owner_worker '${input.owner_worker}'`);
  if (input.requester && !knownRoleIds(definition).has(input.requester)) errors.push(`Unknown owner decision requester '${input.requester}'`);
  if (!DECISIONS.has(input.decision)) errors.push(`Invalid owner decision: ${input.decision}`);
  if (!SHA256_HEX.test(input.decision_hash)) errors.push("owner decision decision_hash must be sha256 hex");
  if (hasForbiddenPlaintextKeys(input)) errors.push("owner decision input must not contain raw body/task/prompt/output/content/message/text/rationale/diff/patch keys");
  return errors;
}

export function createWorkerPoolOwnerDecision(repoRoot: string, definition: TeamDefinition, input: WorkerPoolOwnerDecisionInput): WorkerPoolOwnerDecisionRecord {
  const errors = validateOwnerDecision(definition, input);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const decisionId = newRunId("ownerdec");
  const goalRoomMessage = appendGoalRoomMessage(repoRoot, definition, {
    goal_id: input.goal_id,
    run_id: input.run_id,
    todo_id: input.todo_id,
    sender: input.decided_by,
    audience: "parent",
    kind: "OWNER_CHANGE_DECISION",
    priority: input.decision === "approved" || input.decision === "owner_will_handle" ? "high" : "normal",
    body_hash: input.decision_hash,
    task_id: input.request_id,
    evidence_refs: input.evidence_refs,
    artifact_refs: input.artifact_refs,
    requires_parent_action: input.decision === "needs_parent",
    metadata: { schema: "zob.worker-pool-owner-decision-ref.v1", poolId: input.pool_id, requestId: input.request_id, decisionId, decidedBy: input.decided_by, ownerWorker: input.owner_worker, requester: input.requester ?? null, decision: input.decision, parentVisible: true, hiddenPeerChat: false, workerToWorkerDirect: false },
  });
  const record: WorkerPoolOwnerDecisionRecord = {
    schema: "zob.worker-pool-owner-decision.v1",
    decisionId,
    requestId: input.request_id,
    poolId: input.pool_id,
    goalId: input.goal_id,
    runId: input.run_id ?? null,
    todoId: input.todo_id ?? null,
    decidedBy: input.decided_by,
    ownerWorker: input.owner_worker,
    requester: input.requester ?? null,
    decision: input.decision,
    decisionHash: input.decision_hash,
    goalRoomMsgId: String(goalRoomMessage.msgId),
    parentVisible: true,
    hiddenPeerChat: false,
    workerToWorkerDirect: false,
    parentOwnedActions: true,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt: new Date().toISOString(),
  };
  if (hasForbiddenPlaintextKeys(record)) throw new Error("worker pool owner decision record would contain forbidden plaintext keys");
  mkdirSync(workerPoolsDir(repoRoot), { recursive: true });
  appendFileSync(decisionsPath(repoRoot), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function workerPoolBodyFreeViolations(value: unknown): string[] {
  const violations: string[] = [];
  const visit = (item: unknown, path: string): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        visit(item[index], `${path}[${index}]`);
      }
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_PLAINTEXT_KEYS.has(key)) violations.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "root");
  return violations;
}

export function isWorkerPoolPlanRecord(value: unknown): value is WorkerPoolPlanRecord {
  return isRecord(value) && value.schema === "zob.worker-pool-plan.v1" && typeof value.poolId === "string" && value.parentOwned === true && value.productionWritesPerformed === false && value.autoApply === false && value.bodyStored === false;
}
