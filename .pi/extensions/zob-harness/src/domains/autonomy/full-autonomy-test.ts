import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadFactorySelectorCandidates, selectFactoryForDemands, type FactorySelectorResult } from "../factory/factory-selector.js";
import { buildControlledWorkerPoolPlan, evaluateLaunchAuthorizedApplyGate, type ControlledWorkerPoolPlan, type LaunchAuthorizedApplyGate } from "../governance/launch-apply.js";
import { sha256 } from "../../core/utils/hashing.js";
import { safeFileStem } from "../../core/utils/paths.js";

export interface FullAutonomyTestInput {
  runId?: string;
  launchConfirmed?: boolean;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  maxParallelWorkers?: number;
}

export interface FullAutonomyTestRun {
  schema: "zob.full-autonomy-test-run.v1";
  runId: string;
  status: "full_autonomy_test_ready" | "blocked";
  no_ship: boolean;
  testMode: true;
  productionMode: false;
  scopedTestAutonomyEnabled: boolean;
  globalAutonomyClaimAllowed: false;
  manualPerActionApprovalRequired: false;
  launchAuthorization: Record<string, unknown>;
  workerPool: ControlledWorkerPoolPlan;
  factorySelection: FactorySelectorResult;
  applyGate: LaunchAuthorizedApplyGate;
  inScopeAutonomousTestWrite: {
    performed: boolean;
    relativePath: string;
    pathHash: string;
    artifactHash: string;
    allowedByLaunch: boolean;
    productionWrite: false;
  };
  safety: {
    secretsAccessed: false;
    destructiveCommandsRun: false;
    commitsCreated: false;
    networkAccessed: false;
    productionWritesPerformed: false;
    outOfScopeWritesPerformed: false;
    bodyStored: false;
    promptBodiesStored: false;
    outputBodiesStored: false;
  };
  checks: Array<{ name: string; passed: boolean }>;
  failedChecks: string[];
  evidenceRefs: string[];
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  generatedAt: string;
}

function defaultForbiddenPaths(input?: string[]): string[] {
  return [...new Set([...(input ?? []), ".env", ".env.*", "**/.env*", "~/.ssh", "~/.aws", "node_modules", "dist", "build", "secrets", "raw-conversation-history"])].sort();
}

function buildLaunchAuthorization(runId: string, allowedPaths: string[], forbiddenPaths: string[], launchConfirmed: boolean): Record<string, unknown> {
  return {
    schema: "zob.launch-authorization.v1",
    runId,
    originalUserAskHash: sha256("enable full autonomous test mode"),
    refinedSpecHash: sha256("spec locked: run a scoped full-autonomy test with in-scope autonomous test write and no production apply"),
    specLocked: true,
    userLaunchConfirmed: launchConfirmed,
    launchConfirmedAt: launchConfirmed ? new Date().toISOString() : undefined,
    authorizedAutonomyLevel: "L6",
    allowedActions: ["read_repo", "context_lookup", "select_factory", "run_worker_pool", "sandbox_edit", "apply_in_scope_test_artifact", "post_apply_validation", "post_apply_oracle"],
    allowedPaths,
    forbiddenPaths,
    applyPolicy: {
      mode: "auto_apply_in_scope",
      rollbackRequired: true,
      exactDiffHashRequired: true,
      postApplyValidationRequired: true,
      postApplyOracleRequired: true,
    },
    budgetPolicy: {
      mode: "strict_requested",
      strict: true,
      strictBudgetRequired: true,
      strictBudgetSatisfied: true,
    },
    stopConditions: ["scope_drift", "secret_required", "validation_fail_exhausted", "oracle_no_ship", "budget_exceeded", "forbidden_path", "destructive_command"],
    launchAuthorizesInScopeActions: launchConfirmed,
    actionExecutionBlockedUntilLaunch: !launchConfirmed,
    exceptionApprovalRequiredOnlyForOutOfScope: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function writeFullAutonomyTestRun(repoRoot: string, input: FullAutonomyTestInput = {}): FullAutonomyTestRun {
  const runId = safeFileStem(input.runId ?? `full-autonomy-test-${Date.now()}`);
  const runRoot = join("reports", "autonomous-runs", runId);
  const runDir = join(repoRoot, runRoot);
  const testArtifactRelativePath = `${runRoot}/autonomous-test-action.json`;
  const allowedPaths = [...new Set([...(input.allowedPaths ?? []), `${runRoot}/`])].sort();
  const forbiddenPaths = defaultForbiddenPaths(input.forbiddenPaths);
  const launchConfirmed = input.launchConfirmed === true;
  const launchAuthorization = buildLaunchAuthorization(runId, allowedPaths, forbiddenPaths, launchConfirmed);
  const workerPool = buildControlledWorkerPoolPlan({ runId, maxParallelWorkers: input.maxParallelWorkers ?? 5, launchAuthorization });
  const factories = loadFactorySelectorCandidates(repoRoot);
  const factorySelection = selectFactoryForDemands({
    factories,
    demands: [
      {
        id: "full-autonomy-test",
        refinedSpec: "Run a full autonomous test lane with factory selection, worker pool, in-scope apply gate, validation and oracle.",
        acceptanceCriteria: ["launch authorization", "worker pool", "factory selector", "apply in scope", "oracle validation"],
        expectedArtifacts: ["autonomous-test-action.json", "FULL_AUTONOMY_TEST_READY.sentinel"],
      },
      {
        id: "fallback-forge-quarantine",
        refinedSpec: "If a new factory is needed, use factory-forge quarantine only and never auto-activate.",
        acceptanceCriteria: ["factory-forge quarantine", "no auto activation"],
        expectedArtifacts: ["factory.json", "smoke-manifest.json"],
      },
    ],
  });
  const testArtifact = {
    schema: "zob.full-autonomy-test-action.v1",
    runId,
    launchAuthorizationHash: sha256(JSON.stringify(launchAuthorization)),
    workerPoolHash: sha256(JSON.stringify(workerPool)),
    factorySelectionHash: sha256(JSON.stringify(factorySelection)),
    inScopeAutonomousTestAction: true,
    productionWrite: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const diffHash = sha256(JSON.stringify(testArtifact));
  const applyGate = evaluateLaunchAuthorizedApplyGate(repoRoot, {
    runId,
    launchAuthorization,
    workerPoolPlan: workerPool,
    changedPaths: [testArtifactRelativePath],
    diffHash,
    sandboxRunId: runId,
    oracleReviewRef: `${runRoot}/full-autonomy-test-oracle.json`,
    validationRefs: ["npm run full-autonomy:test", "npm run check -- --pretty false"],
  });
  const canWriteTestArtifact = applyGate.applyEligible === true && launchConfirmed;
  mkdirSync(runDir, { recursive: true });
  if (canWriteTestArtifact) {
    writeFileSync(join(repoRoot, testArtifactRelativePath), `${JSON.stringify(testArtifact, null, 2)}\n`, "utf8");
    writeFileSync(join(runDir, "FULL_AUTONOMY_TEST_READY.sentinel"), `full autonomy test ready ${new Date().toISOString()}\n`, "utf8");
  }
  const checks = [
    { name: "spec_locked", passed: launchAuthorization.specLocked === true },
    { name: "user_launch_confirmed", passed: launchConfirmed },
    { name: "manual_per_action_approval_disabled_for_in_scope", passed: applyGate.manualPerActionApprovalRequired === false },
    { name: "worker_pool_enabled", passed: workerPool.workerPoolEnabledByLaunch === true && workerPool.parentOwnedDispatch === true && workerPool.childDirectDispatch === false },
    { name: "factory_selector_ready", passed: factorySelection.selectionStatus !== "no_factory_available" && factorySelection.noAutoActivation === true },
    { name: "apply_gate_eligible", passed: applyGate.applyEligible === true && applyGate.autoApplyAuthorizedByLaunch === true },
    { name: "in_scope_autonomous_test_write_performed", passed: canWriteTestArtifact },
    { name: "production_writes_blocked", passed: applyGate.productionWritesPerformed === false },
    { name: "forbidden_paths_preserved", passed: forbiddenPaths.some((path) => path.includes(".env")) && applyGate.gates.forbiddenPathsClear === true },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  const report: FullAutonomyTestRun = {
    schema: "zob.full-autonomy-test-run.v1",
    runId,
    status: failedChecks.length === 0 ? "full_autonomy_test_ready" : "blocked",
    no_ship: failedChecks.length > 0,
    testMode: true,
    productionMode: false,
    scopedTestAutonomyEnabled: failedChecks.length === 0,
    globalAutonomyClaimAllowed: false,
    manualPerActionApprovalRequired: false,
    launchAuthorization,
    workerPool,
    factorySelection,
    applyGate,
    inScopeAutonomousTestWrite: {
      performed: canWriteTestArtifact,
      relativePath: testArtifactRelativePath,
      pathHash: sha256(testArtifactRelativePath),
      artifactHash: canWriteTestArtifact ? sha256(JSON.stringify(testArtifact)) : sha256("not-written"),
      allowedByLaunch: applyGate.applyEligible === true,
      productionWrite: false,
    },
    safety: {
      secretsAccessed: false,
      destructiveCommandsRun: false,
      commitsCreated: false,
      networkAccessed: false,
      productionWritesPerformed: false,
      outOfScopeWritesPerformed: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
    checks,
    failedChecks,
    evidenceRefs: canWriteTestArtifact ? [testArtifactRelativePath, `${runRoot}/FULL_AUTONOMY_TEST_READY.sentinel`] : [],
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const oracle = {
    schema: "zob.full-autonomy-test-oracle.v1",
    runId,
    verdict: report.no_ship ? "FAIL" : "PASS",
    no_ship: report.no_ship,
    scopedTestAutonomyEnabled: report.scopedTestAutonomyEnabled,
    globalAutonomyClaimAllowed: false,
    failedChecks,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "full-autonomy-test-run.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "full-autonomy-test-oracle.json"), `${JSON.stringify(oracle, null, 2)}\n`, "utf8");
  return report;
}
