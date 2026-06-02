import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { evaluateBudgetPreflightDryRun } from "../telemetry/chronicle.js";
import type { BudgetPreflightDryRunCaps, FactoryRunBudgetInput } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { parseJsonFile } from "../../core/utils/json.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

const FORBIDDEN_BUDGET_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content"]);
const REQUIRED_CAP_KEYS: Array<keyof BudgetPreflightDryRunCaps> = ["maxCostUsd", "maxRuns", "maxDurationMs", "maxParallelChildren"];
const REQUIRED_PROFILES = ["smoke", "pilot", "batch"];

export interface BudgetReadinessAuditInput {
  run_id?: string;
}

export interface StrictBudgetDispatchGateInput {
  runId?: string;
  mode?: string;
  execution?: string;
  taskCount?: number;
  selectedItems?: number;
  budget?: FactoryRunBudgetInput;
}

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BUDGET_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function capsFromRecord(record: unknown): BudgetPreflightDryRunCaps | undefined {
  if (!isRecord(record)) return undefined;
  const caps: BudgetPreflightDryRunCaps = {};
  for (const key of REQUIRED_CAP_KEYS) {
    if (!finiteNonnegative(record[key])) return undefined;
    caps[key] = record[key] as number;
  }
  return caps;
}

function readinessCheck(name: string, passed: boolean, detail: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, passed, detail };
}

function nonnegativeOrUndefined(value: unknown): number | undefined {
  return finiteNonnegative(value) ? value : undefined;
}

export function evaluateStrictBudgetDispatchGate(input: StrictBudgetDispatchGateInput = {}): Record<string, unknown> {
  const budget = isRecord(input.budget) ? input.budget as FactoryRunBudgetInput : undefined;
  const caps: BudgetPreflightDryRunCaps = {
    ...(nonnegativeOrUndefined(budget?.maxCostUsd) !== undefined ? { maxCostUsd: nonnegativeOrUndefined(budget?.maxCostUsd) } : {}),
    ...(nonnegativeOrUndefined(budget?.maxRuns) !== undefined ? { maxRuns: nonnegativeOrUndefined(budget?.maxRuns) } : {}),
    ...(nonnegativeOrUndefined(budget?.maxDurationMs) !== undefined ? { maxDurationMs: nonnegativeOrUndefined(budget?.maxDurationMs) } : {}),
    ...(nonnegativeOrUndefined(budget?.maxParallelChildren) !== undefined ? { maxParallelChildren: nonnegativeOrUndefined(budget?.maxParallelChildren) } : {}),
  };
  const observed = {
    costUsd: nonnegativeOrUndefined(budget?.estimatedCostUsd) ?? 0,
    runs: nonnegativeOrUndefined(budget?.estimatedRuns) ?? Math.max(0, Math.floor(input.taskCount ?? 0)),
    durationMs: nonnegativeOrUndefined(budget?.estimatedDurationMs) ?? 0,
    parallelChildren: nonnegativeOrUndefined(budget?.estimatedParallelChildren) ?? 1,
  };
  const strictEnabled = budget?.strictEnabled === true;
  const strictRequested = budget?.strictRequested === true || strictEnabled;
  const preflight = evaluateBudgetPreflightDryRun({
    costUsd: observed.costUsd,
    runs: observed.runs,
    durationMs: observed.durationMs,
    parallelChildren: observed.parallelChildren,
    caps,
    strictRequested,
  });
  const failures = Array.isArray(preflight.failures) ? preflight.failures.filter((failure): failure is string => typeof failure === "string") : [];
  const wouldBlockDispatch = strictEnabled && failures.length > 0;
  return {
    schema: "zob.strict-budget-dispatch-gate.v1",
    runId: input.runId,
    mode: input.mode,
    execution: input.execution,
    strictRequested,
    strictEnabled,
    budgetEnforced: strictEnabled,
    caps,
    observed,
    checks: preflight.checks,
    passed: failures.length === 0,
    failures,
    wouldExceed: failures.length > 0,
    wouldBlockDispatch,
    dispatchDecision: wouldBlockDispatch ? "block" : strictEnabled ? "allow_strict" : "allow_advisory",
    childDispatchAllowed: strictEnabled && !wouldBlockDispatch,
    stopCondition: wouldBlockDispatch ? "blocked" : "none",
    defaultDispatchDecision: strictEnabled ? "gate_decides" : "allow",
    advisoryFallback: !strictEnabled,
    gateEvaluationOnly: true,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function budgetSafetyPassed(result: Record<string, unknown>): boolean {
  return result.dryRun === true
    && result.mode === "advisory"
    && result.advisory === true
    && result.strictEnabled === false
    && result.budgetEnforced === false
    && result.wouldBlockDispatch === false
    && result.defaultDispatchDecision === "allow"
    && result.modelRouterUsed === false
    && result.daemonStarted === false
    && result.childDispatchAllowed === false
    && result.noExecution === true;
}

export function validateBudgetPolicyConfig(repoRoot: string): Record<string, unknown> {
  const configPath = join(repoRoot, ".pi", "budget-policy.json");
  const errors: string[] = [];
  let parsed: Record<string, unknown> | undefined;
  let configHash: string | undefined;
  if (!existsSync(configPath)) {
    errors.push(".pi/budget-policy.json is missing");
  } else {
    try {
      const raw = readFileSync(configPath, "utf8");
      configHash = sha256(raw);
      const value = parseJsonFile(configPath);
      if (!isRecord(value)) errors.push("budget policy config must be a JSON object");
      else parsed = value;
    } catch (error) {
      errors.push(`budget policy config could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const defaultCaps = capsFromRecord(parsed?.defaultCaps);
  const profiles = isRecord(parsed?.profiles) ? parsed.profiles : undefined;
  const validProfiles: Record<string, BudgetPreflightDryRunCaps> = {};

  if (parsed) {
    if (parsed.schema !== "zob.budget-policy.v1") errors.push("budget policy schema must be zob.budget-policy.v1");
    if (parsed.advisoryOnly !== true) errors.push("budget policy must keep advisoryOnly=true");
    if (parsed.strictBudgetDispatchGateAvailable !== true) errors.push("budget policy must declare strictBudgetDispatchGateAvailable=true");
    if (parsed.strictBudgetRequiresExplicitInput !== true) errors.push("budget policy must declare strictBudgetRequiresExplicitInput=true");
    for (const flag of ["strictBudgetDefaultEnabled", "strictBudgetEnabled", "budgetEnforced", "wouldBlockDispatch", "modelRouterUsed", "childDispatchAllowed", "daemonStarted", "networkAccessed", "bodyStored", "promptBodiesStored", "outputBodiesStored"]) {
      if (parsed[flag] !== false) errors.push(`budget policy must keep ${flag}=false`);
    }
    if (parsed.noExecution !== true) errors.push("budget policy must keep noExecution=true");
    if (parsed.defaultDispatchDecision !== "allow") errors.push("budget policy defaultDispatchDecision must remain allow");
    if (!defaultCaps) errors.push("budget policy requires complete nonnegative defaultCaps");
    if (!profiles) {
      errors.push("budget policy requires profiles object");
    } else {
      for (const profileName of REQUIRED_PROFILES) {
        const caps = capsFromRecord(profiles[profileName]);
        if (!caps) errors.push(`budget policy requires complete nonnegative profiles.${profileName}`);
        else validProfiles[profileName] = caps;
      }
    }
    if (!Array.isArray(parsed.futureStrictBudgetPrerequisites) || !parsed.futureStrictBudgetPrerequisites.every((item) => typeof item === "string") || parsed.futureStrictBudgetPrerequisites.length === 0) {
      errors.push("budget policy requires futureStrictBudgetPrerequisites string array");
    }
    if (hasForbiddenBodyKeys(parsed)) errors.push("budget policy must not store raw task/prompt/output/body/content fields");
  }

  return {
    schema: "zob.budget-policy-validation.v1",
    path: ".pi/budget-policy.json",
    present: existsSync(configPath),
    valid: errors.length === 0,
    errors,
    configHash,
    defaultCaps,
    profiles: Object.keys(validProfiles).sort(),
    advisoryOnly: parsed?.advisoryOnly === true,
    strictBudgetDispatchGateAvailable: parsed?.strictBudgetDispatchGateAvailable === true,
    strictBudgetRequiresExplicitInput: parsed?.strictBudgetRequiresExplicitInput === true,
    strictBudgetDefaultEnabled: parsed?.strictBudgetDefaultEnabled === true,
    strictBudgetEnabled: parsed?.strictBudgetEnabled === true,
    budgetEnforced: parsed?.budgetEnforced === true,
    wouldBlockDispatch: parsed?.wouldBlockDispatch === true,
    modelRouterUsed: parsed?.modelRouterUsed === true,
    childDispatchAllowed: parsed?.childDispatchAllowed === true,
    daemonStarted: parsed?.daemonStarted === true,
    networkAccessed: parsed?.networkAccessed === true,
    noExecution: parsed?.noExecution === true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildBudgetReadinessAudit(repoRoot: string, input: BudgetReadinessAuditInput = {}): Record<string, unknown> {
  const configValidation = validateBudgetPolicyConfig(repoRoot);
  const defaultCaps = isRecord(configValidation.defaultCaps) ? configValidation.defaultCaps as BudgetPreflightDryRunCaps : { maxCostUsd: 1, maxRuns: 1, maxDurationMs: 1000, maxParallelChildren: 1 };
  const scenarios = [
    { name: "within_default_caps", input: { costUsd: 0.5, runs: 1, durationMs: 500, parallelChildren: 1, caps: defaultCaps } },
    { name: "cost_exceeds_default_caps", input: { costUsd: Number(defaultCaps.maxCostUsd ?? 1) + 1, runs: 1, durationMs: 500, parallelChildren: 1, caps: defaultCaps } },
    { name: "runs_exceed_default_caps", input: { costUsd: 0.5, runs: Number(defaultCaps.maxRuns ?? 1) + 1, durationMs: 500, parallelChildren: 1, caps: defaultCaps } },
    { name: "duration_exceeds_default_caps", input: { costUsd: 0.5, runs: 1, durationMs: Number(defaultCaps.maxDurationMs ?? 1000) + 1, parallelChildren: 1, caps: defaultCaps } },
    { name: "parallel_children_exceed_default_caps", input: { costUsd: 0.5, runs: 1, durationMs: 500, parallelChildren: Number(defaultCaps.maxParallelChildren ?? 1) + 1, caps: defaultCaps } },
    { name: "strict_budget_request_inert", input: { costUsd: Number(defaultCaps.maxCostUsd ?? 1) + 1, runs: 1, durationMs: 500, parallelChildren: 1, caps: defaultCaps, strictRequested: true } },
  ].map((scenario) => {
    const result = evaluateBudgetPreflightDryRun(scenario.input);
    return {
      name: scenario.name,
      inputHash: sha256(JSON.stringify(scenario.input)),
      passed: result.passed,
      wouldExceed: result.wouldExceed,
      strictRequested: result.strictRequested,
      strictEnabled: result.strictEnabled,
      budgetEnforced: result.budgetEnforced,
      wouldBlockDispatch: result.wouldBlockDispatch,
      childDispatchAllowed: result.childDispatchAllowed,
      noExecution: result.noExecution,
      failures: result.failures,
      safetyPassed: budgetSafetyPassed(result),
    };
  });
  const strictScenario = scenarios.find((scenario) => scenario.name === "strict_budget_request_inert");
  const strictGateScenarios = [
    { name: "strict_gate_allows_within_caps", input: { runId: "strict-gate-allow", mode: "smoke", execution: "agentic", taskCount: 1, budget: { strictEnabled: true, maxRuns: 2, estimatedRuns: 1, maxParallelChildren: 1, estimatedParallelChildren: 1 } } },
    { name: "strict_gate_blocks_exceedance", input: { runId: "strict-gate-block", mode: "smoke", execution: "agentic", taskCount: 3, budget: { strictEnabled: true, maxRuns: 2, estimatedRuns: 3, maxParallelChildren: 1, estimatedParallelChildren: 1 } } },
    { name: "strict_gate_default_disabled_advisory", input: { runId: "strict-gate-default", mode: "smoke", execution: "agentic", taskCount: 3, budget: { strictRequested: true, maxRuns: 2, estimatedRuns: 3 } } },
  ].map((scenario) => {
    const result = evaluateStrictBudgetDispatchGate(scenario.input);
    return {
      name: scenario.name,
      inputHash: sha256(JSON.stringify(scenario.input)),
      strictRequested: result.strictRequested,
      strictEnabled: result.strictEnabled,
      budgetEnforced: result.budgetEnforced,
      wouldExceed: result.wouldExceed,
      wouldBlockDispatch: result.wouldBlockDispatch,
      childDispatchAllowed: result.childDispatchAllowed,
      dispatchDecision: result.dispatchDecision,
      stopCondition: result.stopCondition,
      noExecution: result.noExecution,
      failures: result.failures,
    };
  });
  const strictAllow = strictGateScenarios.find((scenario) => scenario.name === "strict_gate_allows_within_caps");
  const strictBlock = strictGateScenarios.find((scenario) => scenario.name === "strict_gate_blocks_exceedance");
  const strictDefault = strictGateScenarios.find((scenario) => scenario.name === "strict_gate_default_disabled_advisory");
  const checks = [
    readinessCheck("budget_policy_config_valid", configValidation.present === true && configValidation.valid === true, { configHash: configValidation.configHash, errors: configValidation.errors }),
    readinessCheck("budget_dry_run_scenarios_safe", scenarios.every((scenario) => scenario.safetyPassed === true), { scenarioCount: scenarios.length }),
    readinessCheck("budget_exceedances_detected", scenarios.filter((scenario) => String(scenario.name).includes("exceed")).every((scenario) => scenario.wouldExceed === true), { exceedanceScenarios: scenarios.filter((scenario) => String(scenario.name).includes("exceed")).map((scenario) => scenario.name) }),
    readinessCheck("strict_budget_request_inert_without_enable", strictScenario?.wouldExceed === true && strictScenario.strictRequested === true && strictScenario.strictEnabled === false && strictScenario.budgetEnforced === false && strictScenario.wouldBlockDispatch === false, { scenario: strictScenario?.name }),
    readinessCheck("strict_budget_dispatch_gate_blocks_when_enabled", strictAllow?.strictEnabled === true && strictAllow.budgetEnforced === true && strictAllow.wouldBlockDispatch === false && strictAllow.childDispatchAllowed === true && strictBlock?.strictEnabled === true && strictBlock.budgetEnforced === true && strictBlock.wouldBlockDispatch === true && strictBlock.childDispatchAllowed === false && strictBlock.stopCondition === "blocked", { allow: strictAllow?.dispatchDecision, block: strictBlock?.dispatchDecision }),
    readinessCheck("strict_budget_default_disabled", strictDefault?.strictRequested === true && strictDefault.strictEnabled === false && strictDefault.budgetEnforced === false && strictDefault.wouldBlockDispatch === false && strictDefault.dispatchDecision === "allow_advisory", { scenario: strictDefault?.name }),
    readinessCheck("budget_enforcement_integration_implemented", true, { reason: "strict budget dispatch gate is available and can block before live child dispatch when explicitly enabled" }),
    readinessCheck("strict_budget_global_default_enabled", false, { reason: "global/default strict budget enforcement remains disabled until operator approval and broader autonomy gates are proven" }),
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const auditPassed = checks.filter((check) => check.name !== "strict_budget_global_default_enabled").every((check) => check.passed === true);
  const report = {
    schema: "zob.budget-readiness-audit.v1",
    runId: input.run_id,
    auditPassed,
    readiness: failedChecks.length === 0 ? "strict_budget_enabled_globally" : "strict_gate_available_default_blocked",
    strictBudgetBlocked: failedChecks.length > 0,
    strictBudgetNoShip: true,
    strictBudgetBlockers: [
      "global/default strict budget enforcement remains disabled",
      "strict dispatch blocking requires explicit per-run budget.strictEnabled=true",
      "oracle review and explicit approval are required before enabling strict budgets by default",
    ],
    checks,
    failedChecks,
    scenarios,
    strictGateScenarios,
    config: configValidation,
    strictBudgetDispatchGateAvailable: true,
    strictBudgetRequiresExplicitInput: true,
    budgetEnforced: false,
    strictEnabled: false,
    wouldBlockDispatch: false,
    defaultDispatchDecision: "allow",
    modelRouterUsed: false,
    childDispatchAllowed: false,
    daemonStarted: false,
    networkAccessed: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(report)) throw new Error("Budget readiness audit would store forbidden body keys");
  return report;
}

export function writeBudgetReadinessAuditReport(repoRoot: string, runId = "budget-readiness", input: BudgetReadinessAuditInput = {}): string {
  const dir = join(repoRoot, ".pi", "logs", "budget");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(buildBudgetReadinessAudit(repoRoot, { ...input, run_id: runId }), null, 2), "utf8");
  return outputPath;
}
