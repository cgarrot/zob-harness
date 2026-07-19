import type {
  WheelDispatchResult,
  WheelStoryEffectResult,
  WheelSupervisorAuthority,
  WheelSupervisorBudgetPolicy,
  WheelSupervisorMode,
} from "./types.js";

export const DEFAULT_WHEEL_SUPERVISOR_BUDGET_POLICY: WheelSupervisorBudgetPolicy = Object.freeze({
  schema: "wheel.zob.supervisor-budget-policy.v1",
  maxAttemptsPerTask: 3,
  maxRepairRoundsPerStory: 3,
  maxParallelStories: 4,
  maxParallelModelCalls: 4,
  maxDurationMs: 4 * 60 * 60 * 1000,
  maxCostUsd: 0,
  bodyStored: false,
});

function disabledAuthority(mode: Extract<WheelSupervisorMode, "disabled" | "deterministic-fake">): WheelSupervisorAuthority {
  return {
    schema: "wheel.zob.supervisor-authority.v1",
    mode,
    activationEnabled: false,
    networkEnabled: false,
    providerDispatchEnabled: false,
    localGitEffectsEnabled: false,
    githubEffectsEnabled: false,
    commitEnabled: false,
    pushEnabled: false,
    mergeEnabled: false,
    workflowDispatchEnabled: false,
    deploymentEnabled: false,
    strictBudgetRequired: true,
    bodyStored: false,
  };
}

export function createDisabledWheelSupervisorAuthority(): WheelSupervisorAuthority {
  return disabledAuthority("disabled");
}

export function createDeterministicFakeWheelSupervisorAuthority(): WheelSupervisorAuthority {
  return disabledAuthority("deterministic-fake");
}

export function validateWheelSupervisorAuthority(authority: WheelSupervisorAuthority): string[] {
  const issues: string[] = [];
  if (authority.schema !== "wheel.zob.supervisor-authority.v1") issues.push("authority schema is unsupported");
  if (authority.bodyStored !== false) issues.push("authority must be body-free");
  if (authority.strictBudgetRequired !== true) issues.push("strict budget enforcement is required");
  if (authority.mode !== "live") {
    const forbidden = [
      authority.activationEnabled,
      authority.networkEnabled,
      authority.providerDispatchEnabled,
      authority.localGitEffectsEnabled,
      authority.githubEffectsEnabled,
      authority.commitEnabled,
      authority.pushEnabled,
      authority.mergeEnabled,
      authority.workflowDispatchEnabled,
      authority.deploymentEnabled,
    ];
    if (forbidden.some(Boolean)) issues.push(`${authority.mode} authority cannot enable external or repository effects`);
  } else {
    if (!authority.activationEnabled) issues.push("live authority requires activationEnabled=true");
    if (!authority.activationReceiptHash || !/^[a-f0-9]{64}$/.test(authority.activationReceiptHash)) issues.push("live authority requires an activation receipt hash");
    if (!authority.oracleReceiptHash || !/^[a-f0-9]{64}$/.test(authority.oracleReceiptHash)) issues.push("live authority requires an oracle receipt hash");
    if (!authority.spendReceiptHash || !/^[a-f0-9]{64}$/.test(authority.spendReceiptHash)) issues.push("live authority requires a spend receipt hash");
    if (!authority.expiresAt || Number.isNaN(Date.parse(authority.expiresAt))) issues.push("live authority requires a valid expiry");
  }
  return issues;
}

export function validateWheelSupervisorBudgetPolicy(policy: WheelSupervisorBudgetPolicy): string[] {
  const issues: string[] = [];
  if (policy.schema !== "wheel.zob.supervisor-budget-policy.v1") issues.push("budget policy schema is unsupported");
  for (const [name, value] of Object.entries({
    maxAttemptsPerTask: policy.maxAttemptsPerTask,
    maxRepairRoundsPerStory: policy.maxRepairRoundsPerStory,
    maxParallelStories: policy.maxParallelStories,
    maxParallelModelCalls: policy.maxParallelModelCalls,
    maxDurationMs: policy.maxDurationMs,
  })) {
    if (!Number.isInteger(value) || value < 1) issues.push(`${name} must be a positive integer`);
  }
  if (!Number.isFinite(policy.maxCostUsd) || policy.maxCostUsd < 0) issues.push("maxCostUsd must be finite and non-negative");
  if (policy.bodyStored !== false) issues.push("budget policy must be body-free");
  return issues;
}

export function validateDispatchResultPosture(result: WheelDispatchResult, authority: WheelSupervisorAuthority): string[] {
  const issues: string[] = [];
  if (result.bodyStored !== false) issues.push("dispatch result must be body-free");
  if (authority.mode !== "live") {
    if (result.networkAccessed) issues.push("disabled/fake dispatch accessed network");
    if (result.providerCalled) issues.push("disabled/fake dispatch called a provider");
    if (!result.mocked && authority.mode === "deterministic-fake") issues.push("fake dispatch result must be marked mocked");
    if (result.costUsd !== 0) issues.push("disabled/fake dispatch cannot incur cost");
  }
  return issues;
}

export function validateEffectResultPosture(result: WheelStoryEffectResult, authority: WheelSupervisorAuthority): string[] {
  const issues: string[] = [];
  if (result.bodyStored !== false) issues.push("effect result must be body-free");
  if (authority.mode !== "live") {
    if (result.externalEffectPerformed) issues.push("disabled/fake broker performed an external effect");
    if (result.localRepositoryWritePerformed) issues.push("disabled/fake broker performed a local repository write");
    if (result.networkAccessed) issues.push("disabled/fake broker accessed network");
    if (result.credentialsAccessed) issues.push("disabled/fake broker accessed credentials");
    if (result.status === "performed") issues.push("disabled/fake broker cannot report a performed effect");
  }
  return issues;
}
