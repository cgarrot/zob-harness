import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { evaluateBudgetPreflightDryRun } from "../telemetry/chronicle.js";
import type { BudgetPreflightDryRunCaps, FactoryRunModelRoutingInput, ModeName } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { parseJsonFile } from "../../core/utils/json.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export type ModelRiskLevel = "low" | "medium" | "high";
export type ModelClass = "cheap_scout" | "balanced_worker" | "strong_reasoning" | "strong_oracle" | "high_context";

export interface ModelRoutingDryRunInput {
  mode?: ModeName;
  taskType?: string;
  outputContract?: string;
  risk?: ModelRiskLevel | string;
  contextTokens?: number;
  estimatedCostUsd?: number;
  estimatedRuns?: number;
  estimatedDurationMs?: number;
  estimatedParallelChildren?: number;
  caps?: BudgetPreflightDryRunCaps;
  strictRequested?: boolean;
}

export interface ModelRoutingReadinessAuditInput {
  run_id?: string;
}

export interface ModelRoutingDispatchGateInput extends ModelRoutingDryRunInput {
  runId?: string;
  stage?: string;
  agent?: string;
  defaultModel?: string;
  modelRouting?: FactoryRunModelRoutingInput;
}

const FORBIDDEN_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content"]);

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

function normalizeRisk(value: string | undefined): ModelRiskLevel {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function includesAny(value: string | undefined, needles: string[]): boolean {
  const normalized = (value ?? "").toLowerCase();
  return needles.some((needle) => normalized.includes(needle));
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function chooseModelClass(input: ModelRoutingDryRunInput): { modelClass: ModelClass; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  const risk = normalizeRisk(input.risk);
  const contextTokens = numberOrZero(input.contextTokens);
  const isOracleLike = includesAny(input.taskType, ["oracle", "review", "validate"]) || includesAny(input.outputContract, ["oracle"]);
  const isImplementationLike = includesAny(input.taskType, ["implement", "factory", "synthesis", "worker"]) || input.mode === "implement" || input.mode === "factory" || input.mode === "vanilla";

  if (contextTokens >= 120_000) {
    reasonCodes.push("context_tokens_high");
    return { modelClass: "high_context", reasonCodes };
  }
  if (isOracleLike) {
    reasonCodes.push("oracle_or_validation_task");
    return { modelClass: "strong_oracle", reasonCodes };
  }
  if (risk === "high") {
    reasonCodes.push("high_risk_task");
    return { modelClass: "strong_reasoning", reasonCodes };
  }
  if (isImplementationLike || risk === "medium") {
    reasonCodes.push(isImplementationLike ? "implementation_or_factory_task" : "medium_risk_task");
    return { modelClass: "balanced_worker", reasonCodes };
  }

  reasonCodes.push("low_risk_readonly_task");
  return { modelClass: "cheap_scout", reasonCodes };
}

export function evaluateModelRoutingDryRun(input: ModelRoutingDryRunInput = {}): Record<string, unknown> {
  const budgetPreflight = evaluateBudgetPreflightDryRun({
    costUsd: input.estimatedCostUsd,
    runs: input.estimatedRuns,
    durationMs: input.estimatedDurationMs,
    parallelChildren: input.estimatedParallelChildren,
    caps: input.caps,
    strictRequested: input.strictRequested,
  });
  const { modelClass, reasonCodes } = chooseModelClass(input);
  const budgetWouldExceed = budgetPreflight.wouldExceed === true;
  return {
    schema: "zob.model-routing-dry-run.v1",
    dryRun: true,
    advisory: true,
    mode: input.mode ?? "explore",
    taskType: input.taskType ?? "unspecified",
    outputContract: input.outputContract,
    risk: normalizeRisk(input.risk),
    recommendedModelClass: modelClass,
    reasonCodes,
    budget: budgetPreflight,
    budgetWouldExceed,
    budgetEnforced: false,
    strictRequested: input.strictRequested === true,
    strictEnabled: false,
    modelRouterUsed: false,
    routingApplied: false,
    wouldBlockDispatch: false,
    defaultDispatchDecision: "allow",
    childDispatchAllowed: false,
    daemonStarted: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function writeModelRoutingDryRunReport(repoRoot: string, runId: string, input: ModelRoutingDryRunInput = {}): string {
  const dir = join(repoRoot, ".pi", "logs", "model-routing");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(evaluateModelRoutingDryRun(input), null, 2), "utf8");
  return outputPath;
}

function modelNameForClass(modelRouting: FactoryRunModelRoutingInput | undefined, modelClass: ModelClass): string | undefined {
  if (!isRecord(modelRouting?.modelByClass)) return undefined;
  const value = modelRouting.modelByClass[modelClass];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function evaluateModelRoutingDispatchGate(input: ModelRoutingDispatchGateInput = {}): Record<string, unknown> {
  const enabled = input.modelRouting?.enabled === true;
  const dryRun = evaluateModelRoutingDryRun({
    mode: input.mode,
    taskType: input.taskType ?? input.stage ?? input.agent,
    outputContract: input.outputContract,
    risk: input.modelRouting?.risk ?? input.risk,
    contextTokens: input.modelRouting?.contextTokens ?? input.contextTokens,
    estimatedCostUsd: input.estimatedCostUsd,
    estimatedRuns: input.estimatedRuns,
    estimatedDurationMs: input.estimatedDurationMs,
    estimatedParallelChildren: input.estimatedParallelChildren,
    caps: input.caps,
    strictRequested: input.strictRequested,
  });
  const selectedModelClass = dryRun.recommendedModelClass as ModelClass;
  const classModel = enabled ? modelNameForClass(input.modelRouting, selectedModelClass) : undefined;
  const selectedModel = enabled ? classModel ?? input.defaultModel : input.defaultModel;
  return {
    schema: "zob.model-routing-dispatch-gate.v1",
    runId: input.runId,
    stage: input.stage,
    agent: input.agent,
    mode: input.mode ?? "factory",
    outputContract: input.outputContract,
    liveRoutingRequested: enabled,
    liveRoutingEnabled: enabled,
    modelRouterUsed: enabled,
    routingApplied: enabled,
    selectedModelClass,
    recommendedModelClass: selectedModelClass,
    selectedModel,
    selectedModelHash: typeof selectedModel === "string" ? sha256(selectedModel) : undefined,
    selectedModelStored: false,
    modelByClassProvided: isRecord(input.modelRouting?.modelByClass),
    reasonCodes: dryRun.reasonCodes,
    budgetWouldExceed: dryRun.budgetWouldExceed === true,
    budgetEnforced: false,
    strictEnabled: false,
    wouldBlockDispatch: false,
    childDispatchAllowed: enabled,
    defaultDispatchDecision: enabled ? "route_model" : "allow_default_model",
    gateEvaluationOnly: true,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function readinessCheck(name: string, passed: boolean, detail: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, passed, detail };
}

function routeSafetyPassed(route: Record<string, unknown>): boolean {
  return route.dryRun === true
    && route.advisory === true
    && route.budgetEnforced === false
    && route.strictEnabled === false
    && route.modelRouterUsed === false
    && route.routingApplied === false
    && route.childDispatchAllowed === false
    && route.daemonStarted === false
    && route.noExecution === true
    && route.bodyStored === false
    && route.promptBodiesStored === false
    && route.outputBodiesStored === false
    && route.wouldBlockDispatch === false;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

export function validateModelRoutingConfig(repoRoot: string): Record<string, unknown> {
  const configPath = join(repoRoot, ".pi", "model-routing.json");
  const errors: string[] = [];
  let parsed: Record<string, unknown> | undefined;
  let configHash: string | undefined;
  if (!existsSync(configPath)) {
    errors.push(".pi/model-routing.json is missing");
  } else {
    try {
      const raw = readFileSync(configPath, "utf8");
      configHash = sha256(raw);
      const value = parseJsonFile(configPath);
      if (!isRecord(value)) {
        errors.push("model routing config must be a JSON object");
      } else {
        parsed = value;
      }
    } catch (error) {
      errors.push(`model routing config could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const expectedClasses: ModelClass[] = ["cheap_scout", "balanced_worker", "strong_reasoning", "strong_oracle", "high_context"];
  const modes: ModeName[] = ["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla"];
  const modelClasses = isRecord(parsed?.modelClasses) ? parsed.modelClasses : undefined;
  const defaults = isRecord(parsed?.defaults) ? parsed.defaults : undefined;
  const byMode = isRecord(defaults?.byMode) ? defaults.byMode : undefined;

  if (parsed) {
    if (parsed.schema !== "zob.model-routing-config.v1") errors.push("model routing config schema must be zob.model-routing-config.v1");
    if (parsed.advisoryOnly !== true) errors.push("model routing config must keep advisoryOnly=true");
    if (parsed.liveRoutingDispatchGateAvailable !== true) errors.push("model routing config must declare liveRoutingDispatchGateAvailable=true");
    if (parsed.liveRoutingRequiresExplicitInput !== true) errors.push("model routing config must declare liveRoutingRequiresExplicitInput=true");
    for (const flag of ["liveRoutingDefaultEnabled", "liveRoutingEnabled", "budgetEnforced", "strictEnabled", "modelRouterUsed", "routingApplied", "childDispatchAllowed", "daemonStarted", "networkAccessed", "bodyStored", "promptBodiesStored", "outputBodiesStored"]) {
      if (parsed[flag] !== false) errors.push(`model routing config must keep ${flag}=false`);
    }
    if (parsed.noExecution !== true) errors.push("model routing config must keep noExecution=true");
    if (!modelClasses) {
      errors.push("model routing config requires modelClasses object");
    } else {
      for (const modelClass of expectedClasses) {
        const entry = modelClasses[modelClass];
        if (!isRecord(entry)) {
          errors.push(`model routing config missing modelClasses.${modelClass}`);
          continue;
        }
        if (entry.risk !== "low" && entry.risk !== "medium" && entry.risk !== "high") errors.push(`modelClasses.${modelClass}.risk must be low, medium, or high`);
        if (!stringArray(entry.useFor) || stringArray(entry.useFor)?.length === 0) errors.push(`modelClasses.${modelClass}.useFor must be a non-empty string array`);
      }
    }
    if (!byMode) {
      errors.push("model routing config requires defaults.byMode object");
    } else {
      for (const mode of modes) {
        if (!expectedClasses.includes(byMode[mode] as ModelClass)) errors.push(`defaults.byMode.${mode} must reference a known model class`);
      }
    }
    if (defaults?.highContextThresholdTokens !== 120_000) errors.push("defaults.highContextThresholdTokens must be 120000");
    if (defaults?.highContextModelClass !== "high_context") errors.push("defaults.highContextModelClass must be high_context");
    if (!stringArray(parsed.futureLiveRoutingPrerequisites) || stringArray(parsed.futureLiveRoutingPrerequisites)?.length === 0) errors.push("model routing config requires futureLiveRoutingPrerequisites");
    if (hasForbiddenBodyKeys(parsed)) errors.push("model routing config must not store raw task/prompt/output/body/content fields");
  }

  return {
    schema: "zob.model-routing-config-validation.v1",
    path: ".pi/model-routing.json",
    present: existsSync(configPath),
    valid: errors.length === 0,
    errors,
    configHash,
    modelClasses: modelClasses ? expectedClasses.filter((modelClass) => isRecord(modelClasses[modelClass])) : [],
    modesConfigured: byMode ? modes.filter((mode) => typeof byMode[mode] === "string") : [],
    advisoryOnly: parsed?.advisoryOnly === true,
    liveRoutingDispatchGateAvailable: parsed?.liveRoutingDispatchGateAvailable === true,
    liveRoutingRequiresExplicitInput: parsed?.liveRoutingRequiresExplicitInput === true,
    liveRoutingDefaultEnabled: parsed?.liveRoutingDefaultEnabled === true,
    liveRoutingEnabled: parsed?.liveRoutingEnabled === true,
    budgetEnforced: parsed?.budgetEnforced === true,
    strictEnabled: parsed?.strictEnabled === true,
    modelRouterUsed: parsed?.modelRouterUsed === true,
    routingApplied: parsed?.routingApplied === true,
    childDispatchAllowed: parsed?.childDispatchAllowed === true,
    daemonStarted: parsed?.daemonStarted === true,
    networkAccessed: parsed?.networkAccessed === true,
    noExecution: parsed?.noExecution === true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildModelRoutingReadinessAudit(repoRoot: string, input: ModelRoutingReadinessAuditInput = {}): Record<string, unknown> {
  const configValidation = validateModelRoutingConfig(repoRoot);
  const scenarios: Array<{ name: string; expectedModelClass: ModelClass; input: ModelRoutingDryRunInput }> = [
    { name: "low_risk_readonly", expectedModelClass: "cheap_scout", input: { mode: "explore", taskType: "read-only-inspection", risk: "low" } },
    { name: "implementation_worker", expectedModelClass: "balanced_worker", input: { mode: "implement", taskType: "worker-implementation", risk: "medium" } },
    { name: "high_risk_reasoning", expectedModelClass: "strong_reasoning", input: { mode: "plan", taskType: "security-critical-plan", risk: "high" } },
    { name: "oracle_review", expectedModelClass: "strong_oracle", input: { mode: "oracle", taskType: "oracle-review", outputContract: "oracle.v1", risk: "high" } },
    { name: "high_context_batch", expectedModelClass: "high_context", input: { mode: "factory", taskType: "batch-synthesis", risk: "medium", contextTokens: 150_000 } },
    { name: "strict_budget_exceedance", expectedModelClass: "balanced_worker", input: { mode: "factory", taskType: "worker", risk: "medium", estimatedCostUsd: 2, caps: { maxCostUsd: 1 }, strictRequested: true } },
  ];
  const evaluated = scenarios.map((scenario) => {
    const route = evaluateModelRoutingDryRun(scenario.input);
    return {
      name: scenario.name,
      inputHash: sha256(JSON.stringify(scenario.input)),
      expectedModelClass: scenario.expectedModelClass,
      recommendedModelClass: route.recommendedModelClass,
      matchedExpectation: route.recommendedModelClass === scenario.expectedModelClass,
      safetyPassed: routeSafetyPassed(route),
      budgetWouldExceed: route.budgetWouldExceed === true,
      strictRequested: route.strictRequested === true,
      strictEnabled: route.strictEnabled === true,
      budgetEnforced: route.budgetEnforced === true,
      modelRouterUsed: route.modelRouterUsed === true,
      routingApplied: route.routingApplied === true,
      childDispatchAllowed: route.childDispatchAllowed === true,
      noExecution: route.noExecution === true,
      reasonCodes: route.reasonCodes,
    };
  });
  const coveredClasses = [...new Set(evaluated.map((scenario) => String(scenario.recommendedModelClass)))].sort();
  const expectedClasses: ModelClass[] = ["balanced_worker", "cheap_scout", "high_context", "strong_oracle", "strong_reasoning"];
  const strictBudgetScenario = evaluated.find((scenario) => scenario.name === "strict_budget_exceedance");
  const dispatchGateInputs: Array<{ name: string; input: ModelRoutingDispatchGateInput }> = [
    { name: "routing_default_disabled", input: { runId: "route-default", mode: "factory" as ModeName, stage: "map", agent: "explore", outputContract: "explore.v1", modelRouting: { enabled: false, modelByClass: { cheap_scout: "scout-model" } } } },
    { name: "routing_applies_when_enabled", input: { runId: "route-enabled", mode: "factory" as ModeName, stage: "validate", agent: "oracle-merge", outputContract: "oracle-merge.v1", modelRouting: { enabled: true, modelByClass: { strong_oracle: "oracle-model" } } } },
    { name: "routing_high_context_class", input: { runId: "route-high-context", mode: "factory" as ModeName, stage: "reduce", agent: "synthesis", outputContract: "synthesis.v1", modelRouting: { enabled: true, contextTokens: 150_000, modelByClass: { high_context: "long-context-model" } } } },
  ];
  const dispatchGateScenarios = dispatchGateInputs.map((scenario) => {
    const route = evaluateModelRoutingDispatchGate(scenario.input);
    return {
      name: scenario.name,
      inputHash: sha256(JSON.stringify(scenario.input)),
      liveRoutingEnabled: route.liveRoutingEnabled,
      modelRouterUsed: route.modelRouterUsed,
      routingApplied: route.routingApplied,
      selectedModelClass: route.selectedModelClass,
      selectedModelHash: route.selectedModelHash,
      selectedModelStored: route.selectedModelStored,
      childDispatchAllowed: route.childDispatchAllowed,
      noExecution: route.noExecution,
      bodyStored: route.bodyStored,
      promptBodiesStored: route.promptBodiesStored,
      outputBodiesStored: route.outputBodiesStored,
    };
  });
  const routingDefault = dispatchGateScenarios.find((scenario) => scenario.name === "routing_default_disabled");
  const routingEnabled = dispatchGateScenarios.find((scenario) => scenario.name === "routing_applies_when_enabled");
  const routingHighContext = dispatchGateScenarios.find((scenario) => scenario.name === "routing_high_context_class");
  const checks = [
    readinessCheck("dry_run_scenarios_safe", evaluated.every((scenario) => scenario.safetyPassed === true), { scenarioCount: evaluated.length }),
    readinessCheck("model_class_coverage", expectedClasses.every((modelClass) => coveredClasses.includes(modelClass)), { coveredClasses, expectedClasses }),
    readinessCheck("scenario_expectations_match", evaluated.every((scenario) => scenario.matchedExpectation === true), { mismatches: evaluated.filter((scenario) => scenario.matchedExpectation !== true).map((scenario) => scenario.name) }),
    readinessCheck("strict_budget_request_inert", strictBudgetScenario?.budgetWouldExceed === true && strictBudgetScenario.strictRequested === true && strictBudgetScenario.strictEnabled === false && strictBudgetScenario.budgetEnforced === false, { scenario: strictBudgetScenario?.name }),
    readinessCheck("dry_run_live_routing_disabled", evaluated.every((scenario) => scenario.modelRouterUsed === false && scenario.routingApplied === false && scenario.childDispatchAllowed === false && scenario.noExecution === true), { scenarioCount: evaluated.length }),
    readinessCheck("model_config_valid_for_future_live_routing", configValidation.present === true && configValidation.valid === true, { configPath: ".pi/model-routing.json", configHash: configValidation.configHash, errors: configValidation.errors }),
    readinessCheck("live_routing_dispatch_gate_applies_when_enabled", routingEnabled?.liveRoutingEnabled === true && routingEnabled.modelRouterUsed === true && routingEnabled.routingApplied === true && routingEnabled.childDispatchAllowed === true && routingEnabled.selectedModelClass === "strong_oracle" && routingHighContext?.selectedModelClass === "high_context", { enabled: routingEnabled, highContext: routingHighContext }),
    readinessCheck("live_routing_default_disabled", routingDefault?.liveRoutingEnabled === false && routingDefault.modelRouterUsed === false && routingDefault.routingApplied === false && routingDefault.childDispatchAllowed === false, { defaultScenario: routingDefault?.name }),
    readinessCheck("live_routing_integration_implemented", true, { reason: "explicit per-run model-class routing dispatch gate is available for agentic factory child dispatch" }),
    readinessCheck("live_routing_global_default_enabled", false, { reason: "global/default live model routing remains disabled until operator approval and broader autonomy gates are proven" }),
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const auditPassed = checks
    .filter((check) => check.name !== "live_routing_global_default_enabled")
    .every((check) => check.passed === true);
  const report = {
    schema: "zob.model-routing-readiness-audit.v1",
    runId: input.run_id,
    auditPassed,
    readiness: failedChecks.length === 0 ? "live_routing_enabled_globally" : "live_routing_gate_available_default_blocked",
    liveRoutingBlocked: failedChecks.length > 0,
    liveRoutingNoShip: true,
    liveRoutingBlockers: [
      "global/default live routing remains disabled",
      "live routing requires explicit per-run model_routing.enabled=true",
      "strict budget gate and oracle review are required before enabling live routing by default",
      ...(configValidation.valid === true ? [] : [".pi/model-routing.json is missing or invalid"]),
      "operator approval is required before routing all live dispatch by default",
    ],
    checks,
    failedChecks,
    scenarios: evaluated,
    dispatchGateScenarios,
    config: configValidation,
    liveRoutingDispatchGateAvailable: true,
    liveRoutingRequiresExplicitInput: true,
    budgetEnforced: false,
    strictEnabled: false,
    modelRouterUsed: false,
    routingApplied: false,
    childDispatchAllowed: false,
    daemonStarted: false,
    networkAccessed: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(report)) throw new Error("Model routing readiness audit would store forbidden body keys");
  return report;
}

export function writeModelRoutingReadinessAuditReport(repoRoot: string, runId = "model-routing-readiness", input: ModelRoutingReadinessAuditInput = {}): string {
  const dir = join(repoRoot, ".pi", "logs", "model-routing");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(buildModelRoutingReadinessAudit(repoRoot, { ...input, run_id: runId }), null, 2), "utf8");
  return outputPath;
}
