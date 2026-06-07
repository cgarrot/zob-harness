

export type AutonomousApplyPolicy = "no_apply" | "sandbox_simulation" | "manual_apply_only" | "auto_apply_in_scope";
export type AutonomousBudgetProfile = "advisory" | "strict_requested";
export type AutonomousRisk = "low" | "medium" | "high";
export type AutonomousLevel = "L4" | "L5" | "L6";

export interface AutonomousRuntimeDryRunInput {
  userNeed: string;
  refinedSpec?: string;
  runId?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  expectedArtifacts?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  allowedSources?: string[];
  maxContextTokens?: number;
  applyPolicy?: AutonomousApplyPolicy;
  budgetProfile?: AutonomousBudgetProfile;
  risk?: AutonomousRisk;
  authorizedAutonomyLevel?: AutonomousLevel;
  userLaunchConfirmed?: boolean;
  launchConfirmedAt?: string;
  allowedActions?: string[];
}

export interface AutonomousReadOnlySmokeRunInput extends AutonomousRuntimeDryRunInput {
  factoryRunId?: string;
}
