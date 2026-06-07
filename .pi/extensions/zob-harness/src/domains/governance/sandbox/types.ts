

export type SandboxWriteAction = "create" | "update";

export interface SandboxWritePlanChange {
  path: string;
  action: SandboxWriteAction;
  contentHash: string;
  reason?: string;
}

export interface SandboxWritePlanInput {
  run_id?: string;
  allowed_paths: string[];
  forbidden_paths?: string[];
  changes: SandboxWritePlanChange[];
  base_ref?: string;
}

export interface SandboxWritePlanResult {
  runId: string;
  runDir: string;
  sandboxRoot: string;
  status: "planned_safe" | "blocked_preflight";
  changedPaths: string[];
  diffHash?: string;
  artifacts: string[];
  errors: string[];
}

export interface SandboxApplyReadinessInput {
  run_id: string;
  oracle_review_path?: string;
  diff_review_gate_path?: string;
  apply_id?: string;
  approval?: {
    approvedBy?: string;
    approvedAt?: string;
    approvalId?: string;
  };
}

export interface SandboxApplyReadinessResult {
  runId: string;
  applyId: string;
  reviewDir: string;
  status: "ready_for_manual_apply" | "blocked_preflight";
  applyReady: boolean;
  applyPerformed: false;
  artifacts: string[];
  errors: string[];
}

export interface SandboxApplySimulationInput {
  run_id: string;
  apply_readiness_path?: string;
  simulation_id?: string;
}

export interface SandboxApplySimulationResult {
  runId: string;
  simulationId: string;
  simulationDir: string;
  targetWorkspace: string;
  status: "simulated_apply_in_temp_workspace" | "blocked_preflight";
  simulatedApplyPerformed: boolean;
  productionWritesPerformed: false;
  autoApply: false;
  artifacts: string[];
  errors: string[];
}

export interface SandboxManualApplyPreflightInput {
  run_id: string;
  apply_readiness_path?: string;
  apply_simulation_path?: string;
  preflight_id?: string;
  confirmation_phrase?: string;
}

export interface SandboxManualApplyPreflightResult {
  runId: string;
  preflightId: string;
  preflightDir: string;
  status: "manual_apply_preflight_passed" | "blocked_preflight";
  manualApplyPreflightPassed: boolean;
  applyPerformed: false;
  productionWritesPerformed: false;
  autoApply: false;
  artifacts: string[];
  errors: string[];
}

export interface SandboxIsolatedExecutionInput {
  run_id: string;
  execution_id?: string;
}

export interface SandboxIsolatedExecutionResult {
  runId: string;
  executionId: string;
  executionDir: string;
  status: "executed_in_sandbox" | "blocked_preflight";
  isolatedExecutionPerformed: boolean;
  productionWritesPerformed: false;
  artifacts: string[];
  errors: string[];
}

export interface SandboxDiffReviewGateInput {
  run_id: string;
  oracle_review_path?: string;
  review_id?: string;
}

export interface SandboxDiffReviewGateResult {
  runId: string;
  reviewId: string;
  reviewDir: string;
  status: "diff_review_passed" | "blocked_preflight";
  reviewPassed: boolean;
  applyReadyUnlocked: boolean;
  applyPerformed: false;
  productionWritesPerformed: false;
  artifacts: string[];
  errors: string[];
}
