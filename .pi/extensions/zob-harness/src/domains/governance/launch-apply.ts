import { DEFAULT_RULES } from "../../core/constants.js";
import { sha256 } from "../../core/utils/hashing.js";
import { pathMatches, resolveRepoPath, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export type WorkerPoolLaneKind = "context" | "factory" | "implement" | "qa" | "oracle";
export type ApplyGateStatus = "eligible_not_applied" | "blocked";

export interface ControlledWorkerPoolLane {
  laneId: string;
  kind: WorkerPoolLaneKind;
  maxWorkers: number;
  parentOwnedDispatch: true;
  childDirectDispatch: false;
  workspaceClaimRequired: true;
  goalRoomEventsRequired: true;
  todoClaimReducerRequired: true;
  outputContract: string;
}

export interface ControlledWorkerPoolPlan {
  schema: "zob.controlled-worker-pool-plan.v1";
  runId: string;
  maxParallelWorkers: number;
  launchAuthorizationRequired: true;
  strictBudgetRequired: true;
  workerPoolEnabledByLaunch: boolean;
  lanes: ControlledWorkerPoolLane[];
  l5ControlledWorkerPool: true;
  parentOwnedDispatch: true;
  childDirectDispatch: false;
  eventContract: "agent-event.v1";
  todoReducerContract: "zob.todo-event-reducer-decision.v1";
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface LaunchAuthorizedApplyInput {
  runId: string;
  launchAuthorization: Record<string, unknown>;
  changedPaths: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  diffHash: string;
  sandboxRunId?: string;
  oracleReviewRef?: string;
  validationRefs?: string[];
  workerPoolPlan?: ControlledWorkerPoolPlan;
}

export interface LaunchAuthorizedApplyGate {
  schema: "zob.launch-authorized-apply-gate.v1";
  runId: string;
  status: ApplyGateStatus;
  applyEligible: boolean;
  autoApplyAuthorizedByLaunch: boolean;
  manualPerActionApprovalRequired: false;
  exceptionApprovalRequiredOnlyForOutOfScope: true;
  applyPerformed: false;
  productionWritesPerformed: false;
  changedPaths: string[];
  changedPathHashes: string[];
  diffHash: string;
  sandboxRunIdHash?: string;
  oracleReviewRef?: string;
  validationRefs: string[];
  gates: {
    specLocked: boolean;
    userLaunchConfirmed: boolean;
    launchAuthorizesInScopeActions: boolean;
    applyPolicyAutoApplyInScope: boolean;
    workerPoolControlled: boolean;
    changedPathsAllowed: boolean;
    forbiddenPathsClear: boolean;
    sandboxEvidencePresent: boolean;
    oracleReviewPresent: boolean;
    validationRefsPresent: boolean;
    diffHashPresent: boolean;
  };
  blockers: string[];
  l6LaunchAuthorizedApply: true;
  parentOwnedApplyCoordinatorRequired: true;
  rollbackRequired: true;
  postApplyValidationRequired: true;
  postApplyOracleRequired: true;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface LaunchAuthorizedApplySmokeReport {
  schema: "zob.launch-authorized-apply-smoke.v1";
  status: "passed" | "failed";
  workerPool: ControlledWorkerPoolPlan;
  eligibleGate: LaunchAuthorizedApplyGate;
  blockedGate: LaunchAuthorizedApplyGate;
  checks: Array<{ name: string; passed: boolean }>;
  failedChecks: string[];
  no_ship: boolean;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  generatedAt: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

function stableStrings(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()).sort() : [];
}

function hashStrings(values: string[]): string[] {
  return values.map((value) => sha256(value)).sort();
}

function launchApplyPolicyMode(launchAuthorization: Record<string, unknown>): string | undefined {
  const applyPolicy = isRecord(launchAuthorization.applyPolicy) ? launchAuthorization.applyPolicy : undefined;
  return typeof applyPolicy?.mode === "string" ? applyPolicy.mode : undefined;
}

function launchAllowedPaths(launchAuthorization: Record<string, unknown>, fallback: string[] | undefined): string[] {
  return stableStrings(fallback && fallback.length > 0 ? fallback : launchAuthorization.allowedPaths);
}

function launchForbiddenPaths(launchAuthorization: Record<string, unknown>, fallback: string[] | undefined): string[] {
  return stableStrings(fallback && fallback.length > 0 ? fallback : launchAuthorization.forbiddenPaths);
}

function pathAllowed(repoRoot: string, path: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowedPath) => pathMatches(path, allowedPath, repoRoot, repoRoot));
}

function pathForbidden(repoRoot: string, path: string, forbiddenPaths: string[]): boolean {
  return [...DEFAULT_RULES.zeroAccessPaths, ...forbiddenPaths].some((forbiddenPath) => pathMatches(path, forbiddenPath, repoRoot, repoRoot));
}

function validateChangedPaths(repoRoot: string, changedPaths: string[], allowedPaths: string[], forbiddenPaths: string[]): { allowed: boolean; forbiddenClear: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const changedPath of changedPaths) {
    const resolved = resolveRepoPath(repoRoot, changedPath);
    blockers.push(...resolved.errors.map((error) => `changed_path:${error}`));
    if (resolved.errors.length === 0 && !pathAllowed(repoRoot, changedPath, allowedPaths)) blockers.push(`changed_path_not_allowed:${changedPath}`);
    if (pathForbidden(repoRoot, changedPath, forbiddenPaths)) blockers.push(`changed_path_forbidden:${changedPath}`);
  }
  return {
    allowed: changedPaths.length > 0 && blockers.every((blocker) => !blocker.startsWith("changed_path_not_allowed") && !blocker.startsWith("changed_path:Path")),
    forbiddenClear: blockers.every((blocker) => !blocker.startsWith("changed_path_forbidden")),
    blockers,
  };
}

export function buildControlledWorkerPoolPlan(input: { runId: string; maxParallelWorkers?: number; launchAuthorization?: Record<string, unknown> }): ControlledWorkerPoolPlan {
  const maxParallelWorkers = Math.max(1, Math.min(8, Math.trunc(input.maxParallelWorkers ?? 4)));
  const launchAuthorization = input.launchAuthorization ?? {};
  const launchAuthorized = launchAuthorization.specLocked === true && launchAuthorization.userLaunchConfirmed === true && launchAuthorization.launchAuthorizesInScopeActions === true;
  const lane = (kind: WorkerPoolLaneKind, index: number, outputContract: string): ControlledWorkerPoolLane => ({
    laneId: safeFileStem(`${index}-${kind}`),
    kind,
    maxWorkers: kind === "implement" ? Math.max(1, Math.min(3, maxParallelWorkers - 1)) : 1,
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    workspaceClaimRequired: true,
    goalRoomEventsRequired: true,
    todoClaimReducerRequired: true,
    outputContract,
  });
  return {
    schema: "zob.controlled-worker-pool-plan.v1",
    runId: safeFileStem(input.runId),
    maxParallelWorkers,
    launchAuthorizationRequired: true,
    strictBudgetRequired: true,
    workerPoolEnabledByLaunch: launchAuthorized,
    lanes: [
      lane("context", 1, "context-pack.v1"),
      lane("factory", 2, "factory.v1"),
      lane("implement", 3, "implement.v1"),
      lane("qa", 4, "qa.v1"),
      lane("oracle", 5, "oracle.v1"),
    ],
    l5ControlledWorkerPool: true,
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    eventContract: "agent-event.v1",
    todoReducerContract: "zob.todo-event-reducer-decision.v1",
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function evaluateLaunchAuthorizedApplyGate(repoRoot: string, input: LaunchAuthorizedApplyInput): LaunchAuthorizedApplyGate {
  const launchAuthorization = input.launchAuthorization;
  const changedPaths = stableStrings(input.changedPaths);
  const allowedPaths = launchAllowedPaths(launchAuthorization, input.allowedPaths);
  const forbiddenPaths = launchForbiddenPaths(launchAuthorization, input.forbiddenPaths);
  const pathGate = validateChangedPaths(repoRoot, changedPaths, allowedPaths, forbiddenPaths);
  const validationRefs = stableStrings(input.validationRefs);
  const gates = {
    specLocked: launchAuthorization.specLocked === true,
    userLaunchConfirmed: launchAuthorization.userLaunchConfirmed === true,
    launchAuthorizesInScopeActions: launchAuthorization.launchAuthorizesInScopeActions === true,
    applyPolicyAutoApplyInScope: launchApplyPolicyMode(launchAuthorization) === "auto_apply_in_scope",
    workerPoolControlled: input.workerPoolPlan?.l5ControlledWorkerPool === true && input.workerPoolPlan.parentOwnedDispatch === true && input.workerPoolPlan.childDirectDispatch === false,
    changedPathsAllowed: pathGate.allowed,
    forbiddenPathsClear: pathGate.forbiddenClear,
    sandboxEvidencePresent: typeof input.sandboxRunId === "string" && input.sandboxRunId.trim().length > 0,
    oracleReviewPresent: typeof input.oracleReviewRef === "string" && input.oracleReviewRef.trim().length > 0,
    validationRefsPresent: validationRefs.length > 0,
    diffHashPresent: SHA256_HEX.test(input.diffHash),
  };
  const blockers = [
    ...(!gates.specLocked ? ["spec_not_locked"] : []),
    ...(!gates.userLaunchConfirmed ? ["user_launch_not_confirmed"] : []),
    ...(!gates.launchAuthorizesInScopeActions ? ["launch_does_not_authorize_in_scope_actions"] : []),
    ...(!gates.applyPolicyAutoApplyInScope ? ["apply_policy_not_auto_apply_in_scope"] : []),
    ...(!gates.workerPoolControlled ? ["l5_worker_pool_not_controlled"] : []),
    ...(!gates.changedPathsAllowed ? ["changed_paths_not_allowed"] : []),
    ...(!gates.forbiddenPathsClear ? ["changed_paths_hit_forbidden_policy"] : []),
    ...(!gates.sandboxEvidencePresent ? ["sandbox_evidence_missing"] : []),
    ...(!gates.oracleReviewPresent ? ["oracle_review_missing"] : []),
    ...(!gates.validationRefsPresent ? ["validation_refs_missing"] : []),
    ...(!gates.diffHashPresent ? ["diff_hash_missing_or_invalid"] : []),
    ...pathGate.blockers,
  ];
  const applyEligible = blockers.length === 0;
  return {
    schema: "zob.launch-authorized-apply-gate.v1",
    runId: safeFileStem(input.runId),
    status: applyEligible ? "eligible_not_applied" : "blocked",
    applyEligible,
    autoApplyAuthorizedByLaunch: gates.specLocked && gates.userLaunchConfirmed && gates.launchAuthorizesInScopeActions && gates.applyPolicyAutoApplyInScope,
    manualPerActionApprovalRequired: false,
    exceptionApprovalRequiredOnlyForOutOfScope: true,
    applyPerformed: false,
    productionWritesPerformed: false,
    changedPaths,
    changedPathHashes: hashStrings(changedPaths),
    diffHash: input.diffHash,
    sandboxRunIdHash: input.sandboxRunId ? sha256(input.sandboxRunId) : undefined,
    oracleReviewRef: input.oracleReviewRef,
    validationRefs,
    gates,
    blockers,
    l6LaunchAuthorizedApply: true,
    parentOwnedApplyCoordinatorRequired: true,
    rollbackRequired: true,
    postApplyValidationRequired: true,
    postApplyOracleRequired: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildLaunchAuthorizedApplySmokeReport(repoRoot: string): LaunchAuthorizedApplySmokeReport {
  const launchAuthorization = {
    schema: "zob.launch-authorization.v1",
    specLocked: true,
    userLaunchConfirmed: true,
    launchAuthorizesInScopeActions: true,
    allowedPaths: ["docs/", ".pi/extensions/zob-harness/src/"],
    forbiddenPaths: [".env", "**/.env*", "node_modules", "dist", "build"],
    applyPolicy: { mode: "auto_apply_in_scope" },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const workerPool = buildControlledWorkerPoolPlan({ runId: "launch-authorized-apply-smoke", maxParallelWorkers: 4, launchAuthorization });
  const eligibleGate = evaluateLaunchAuthorizedApplyGate(repoRoot, {
    runId: "launch-authorized-apply-smoke",
    launchAuthorization,
    workerPoolPlan: workerPool,
    changedPaths: ["docs/ZOB_GENERAL_FACTORY_AGENT_L4_L6_MASTER_PLAN.md"],
    diffHash: sha256("eligible launch-authorized smoke diff"),
    sandboxRunId: "sandbox-launch-authorized-smoke",
    oracleReviewRef: "reports/sandbox-manual-apply-preflight-smoke.json",
    validationRefs: ["npm run check -- --pretty false", "npm run smoke:launch-authorized-apply"],
  });
  const blockedGate = evaluateLaunchAuthorizedApplyGate(repoRoot, {
    runId: "launch-authorized-apply-smoke-blocked",
    launchAuthorization: { ...launchAuthorization, userLaunchConfirmed: false, launchAuthorizesInScopeActions: false },
    workerPoolPlan: workerPool,
    changedPaths: [".env"],
    diffHash: "invalid",
    sandboxRunId: "sandbox-launch-authorized-smoke",
    validationRefs: [],
  });
  const checks = [
    { name: "l5_worker_pool_parent_owned", passed: workerPool.l5ControlledWorkerPool === true && workerPool.parentOwnedDispatch === true && workerPool.childDirectDispatch === false },
    { name: "worker_pool_uses_events_and_todo_reducer", passed: workerPool.lanes.every((lane) => lane.goalRoomEventsRequired === true && lane.todoClaimReducerRequired === true) },
    { name: "eligible_gate_authorizes_without_per_action_approval", passed: eligibleGate.applyEligible === true && eligibleGate.manualPerActionApprovalRequired === false && eligibleGate.autoApplyAuthorizedByLaunch === true },
    { name: "eligible_gate_does_not_apply", passed: eligibleGate.applyPerformed === false && eligibleGate.productionWritesPerformed === false },
    { name: "blocked_gate_rejects_missing_launch_and_forbidden_path", passed: blockedGate.applyEligible === false && blockedGate.blockers.includes("user_launch_not_confirmed") && blockedGate.blockers.some((blocker) => blocker.startsWith("changed_path_forbidden")) },
    { name: "body_free", passed: eligibleGate.bodyStored === false && workerPool.bodyStored === false },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  return {
    schema: "zob.launch-authorized-apply-smoke.v1",
    status: failedChecks.length === 0 ? "passed" : "failed",
    workerPool,
    eligibleGate,
    blockedGate,
    checks,
    failedChecks,
    no_ship: failedChecks.length > 0,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}
