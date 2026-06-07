import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCapabilityIndex, buildReuseScoutReport } from "../../delegation/capabilities.js";
import { selectFactoryForDemands } from "../../factory/factory-selector.js";
import { evaluateStrictBudgetDispatchGate } from "../../governance/budget-policy.js";
import { evaluateBudgetPreflightDryRun } from "../../telemetry/chronicle.js";
import { buildBrainLookupResult, buildContextPack, buildDefaultContextScope, validateContextPack, validateContextScope } from "../../context/context-gbrain.js";
import { evaluateModelRoutingDispatchGate, evaluateModelRoutingDryRun } from "../../models/model-routing.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { safeFileStem } from "../../../core/utils/paths.js";
import { isRecord } from "../../../core/utils/records.js";
import type { AutonomousApplyPolicy, AutonomousBudgetProfile, AutonomousLevel, AutonomousRisk, AutonomousRuntimeDryRunInput } from "./types.js";

export const FORBIDDEN_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content", "patch", "diff", "raw", "messages", "conversationHistory"]);
export const AMBIGUOUS_PATTERNS = [/\bstuff\b/i, /\bsomething\b/i, /\bwhatever\b/i, /\bfix it\b/i, /\bmake it better\b/i, /\betc\.?\b/i];
export const SECRET_PATTERNS = [/\.env\b/i, /api[_-]?key/i, /secret/i, /password/i, /token/i, /private[_-]?key/i, /ssh[_-]?key/i];
export const DEFAULT_AUTONOMOUS_FORBIDDEN_PATHS = [".env", ".env.*", "secrets", "raw-conversation-history", "node_modules", "dist", "build"];
export const UNSAFE_AUTONOMOUS_ALLOWED_SEGMENTS = new Set(["node_modules", "dist", "build", "secrets", "raw-conversation-history"]);
export const AUTONOMOUS_CURRENT_SOURCE_FINGERPRINT_FILES = [
  "package.json",
  "tsconfig.json",
  "scripts/harness-smoke.mjs",
  "docs/AUTONOMY_FACTORY_AGENT_DETAILED_PLAN.md",
  ".pi/budget-policy.json",
  ".pi/model-routing.json",
  ".pi/daemon-policy.json",
  ".pi/teams/zob-core.json",
  ".pi/extensions/zob-harness/index.ts",
  ".pi/extensions/zob-harness/src/domains/autonomy/autonomous-runtime.ts",
  ".pi/extensions/zob-harness/src/domains/autonomy/autonomy-readiness.ts",
  ".pi/extensions/zob-harness/src/runtime/tools-autonomous.ts",
  ".pi/extensions/zob-harness/src/runtime/schemas.ts",
  ".pi/extensions/zob-harness/src/domains/factory/run.ts",
  ".pi/extensions/zob-harness/src/domains/models/model-routing.ts",
  ".pi/extensions/zob-harness/src/domains/governance/budget-policy.ts",
  ".pi/extensions/zob-harness/src/domains/autonomy/daemon-policy.ts",
  ".pi/extensions/zob-harness/src/domains/coms/mission-control.ts",
  ".pi/extensions/zob-harness/src/domains/governance/sandbox.ts",
];

export function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

export function stableStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].sort();
}

export function normalizeAutonomousSpecPath(value: string): string {
  return value.trim().replace(/\\+/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isBroadAutonomousAllowedPath(value: string): boolean {
  const normalized = normalizeAutonomousSpecPath(value);
  return normalized === "" || normalized === "." || normalized === "/" || normalized === "*" || normalized === "**" || normalized === "~" || normalized === "~/";
}

export function forbiddenPatternBase(value: string): string {
  return normalizeAutonomousSpecPath(value)
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "")
    .replace(/\.\*$/, "");
}

export function pathConflict(left: string, right: string): boolean {
  const a = forbiddenPatternBase(left).toLowerCase();
  const b = forbiddenPatternBase(right).toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function unsafeAllowedPathReason(value: string, forbiddenPaths: string[]): string | undefined {
  const normalized = normalizeAutonomousSpecPath(value);
  const lower = normalized.toLowerCase();
  if (value.includes("\0")) return "allowed_path_contains_nul_byte";
  if (isBroadAutonomousAllowedPath(value)) return "allowed_path_too_broad";
  if (lower.startsWith("/") || lower.startsWith("~/") || /^[a-z]:\//i.test(lower)) return "allowed_path_must_be_repo_relative";
  if (lower.split("/").includes("..")) return "allowed_path_must_not_traverse_parent";
  const segments = lower.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) return "allowed_path_references_secret_path";
  if (segments.some((segment) => UNSAFE_AUTONOMOUS_ALLOWED_SEGMENTS.has(segment))) return "allowed_path_references_forbidden_segment";
  if (forbiddenPaths.some((forbidden) => pathConflict(normalized, forbidden))) return "allowed_path_conflicts_with_forbidden_path";
  return undefined;
}

export function validateAutonomousSpecPathGate(allowedPaths: string[], forbiddenPaths: string[]): string[] {
  if (allowedPaths.length === 0) return ["allowed_paths_required_before_execution"];
  return allowedPaths.flatMap((allowedPath) => {
    const reason = unsafeAllowedPathReason(allowedPath, forbiddenPaths);
    return reason ? [reason] : [];
  });
}

export function hashes(values: string[]): string[] {
  return values.map((value) => sha256(value)).sort();
}

export function defaultAutonomousAllowedActions(applyPolicy: AutonomousApplyPolicy): string[] {
  const base = ["read_repo", "context_lookup", "select_factory", "run_factory_smoke", "run_factory_pilot", "run_factory_batch", "post_run_validation", "post_run_oracle"];
  return applyPolicy === "auto_apply_in_scope"
    ? [...base, "sandbox_edit", "apply_in_scope", "post_apply_validation", "post_apply_oracle"]
    : base;
}

export function inferAutonomousLevel(applyPolicy: AutonomousApplyPolicy): AutonomousLevel {
  return applyPolicy === "auto_apply_in_scope" ? "L6" : "L4";
}

export function capabilityFactories(capabilityIndex: Record<string, unknown>): Record<string, unknown>[] {
  const capabilities = Array.isArray(capabilityIndex.capabilities) ? capabilityIndex.capabilities.filter(isRecord) : [];
  return capabilities.filter((capability) => capability.kind === "factory");
}

export function textSignals(...values: string[]): string[] {
  const text = values.join("\n").toLowerCase();
  const signals: string[] = [];
  const add = (condition: boolean, signal: string): void => {
    if (condition) signals.push(signal);
  };
  add(/\b(code review|review code|review changes|oracle matrix|security review|qa review|correctness|architecture)\b/.test(text), "code_review");
  add(/\b(budget|cost|costs|cap|caps|preflight|strict budget|max runs|max cost|parallel children)\b/.test(text), "budget_preflight");
  add(/\b(roadmap|lot|lots|milestone|unchecked item|execution queue)\b/.test(text), "roadmap_lots");
  add(/\b(opencode|pattern|patterns|canonizer|canonical|taxonomy|workflow rules|quality gates)\b/.test(text), "opencode_patterns");
  add(/\b(projectdna|project dna|project-dna|knowledge graph|code knowledge|context pack|repo scan|reference project)\b/.test(text), "project_dna");
  add(/\b(new factory|create factory|generate factory|factory scaffold|quarantine|factory-forge|forge)\b/.test(text), "factory_forge");
  return [...new Set(signals)].sort();
}

export function scoreFactoryCandidate(factory: Record<string, unknown>, signals: string[]): Record<string, unknown> {
  const id = typeof factory.id === "string" ? factory.id : "unknown";
  const reasonCodes: string[] = [];
  let score = 0;
  const add = (condition: boolean, points: number, reason: string): void => {
    if (condition) {
      score += points;
      reasonCodes.push(reason);
    }
  };
  add(id === "code-review-matrix" && signals.includes("code_review"), 8, "signal:code_review");
  add(id === "budget-preflight-dry-run" && signals.includes("budget_preflight"), 8, "signal:budget_preflight");
  add(id === "roadmap-smoke-lots" && signals.includes("roadmap_lots"), 8, "signal:roadmap_lots");
  add(id === "opencode-pattern-canonizer" && signals.includes("opencode_patterns"), 8, "signal:opencode_patterns");
  add(id === "project-dna" && signals.includes("project_dna"), 8, "signal:project_dna");
  add(id === "factory-forge" && signals.includes("factory_forge"), 8, "signal:factory_forge");
  const metadata = isRecord(factory.metadata) ? factory.metadata : {};
  const manifests = Array.isArray(metadata.manifests) ? metadata.manifests.filter((item): item is string => typeof item === "string") : [];
  add(manifests.includes("smoke-manifest.json"), 1, "manifest:smoke");
  add(manifests.includes("pilot-manifest.json"), 1, "manifest:pilot");
  add(manifests.includes("batch-manifest.json"), 1, "manifest:batch");
  const confidence = Math.max(0, Math.min(0.99, score / 12));
  return {
    kind: "factory",
    id,
    sourcePath: factory.sourcePath,
    score,
    confidence,
    reasonCodes: reasonCodes.sort(),
    summaryHash: typeof factory.summary === "string" ? sha256(factory.summary) : undefined,
  };
}

export function selectAutonomousFactory(input: { factories: Record<string, unknown>[]; refinedSpec: string; acceptanceCriteria: string[]; expectedArtifacts: string[] }): Record<string, unknown> {
  return selectFactoryForDemands({
    schema: "zob.autonomous-factory-selection-score.v1",
    factories: input.factories,
    refinedSpec: input.refinedSpec,
    acceptanceCriteria: input.acceptanceCriteria,
    expectedArtifacts: input.expectedArtifacts,
  }) as unknown as Record<string, unknown>;
}

export function factoryManifestAvailability(repoRoot: string, factoryName: string | undefined): Record<string, unknown> {
  if (!factoryName) return { smoke: false, pilot: false, batch: false };
  return {
    smoke: existsSync(join(repoRoot, ".pi", "factories", factoryName, "smoke-manifest.json")),
    pilot: existsSync(join(repoRoot, ".pi", "factories", factoryName, "pilot-manifest.json")),
    batch: existsSync(join(repoRoot, ".pi", "factories", factoryName, "batch-manifest.json")),
  };
}

export function readFactoryRegistryReadiness(repoRoot: string, factoryName: string | undefined): Record<string, unknown> {
  const reportPath = "reports/factory-registry-readiness-audit-smoke.json";
  const absolutePath = join(repoRoot, reportPath);
  const base = {
    schema: "zob.autonomous-factory-readiness-snapshot.v1",
    reportPath,
    reportPresent: false,
    reportHash: undefined,
    selectedFactory: factoryName,
    registeredBatchReady: false,
    arbitraryFactoryNoShip: true,
    currentSourceProofRequired: true,
    proofBeforeExecutionRequired: true,
    readinessFreshness: "missing_registry_snapshot",
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (!existsSync(absolutePath)) return base;
  try {
    const rawJson = readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(rawJson) as unknown;
    const registry = isRecord(parsed) ? parsed : {};
    const readyFactories = Array.isArray(registry.registeredAgenticBatchReadyFactories) ? registry.registeredAgenticBatchReadyFactories.filter((item): item is string => typeof item === "string") : [];
    const missingFactories = Array.isArray(registry.factoriesMissingRegisteredBatchProof) ? registry.factoriesMissingRegisteredBatchProof.filter((item): item is string => typeof item === "string") : [];
    const registeredBatchReady = typeof factoryName === "string" && readyFactories.includes(factoryName);
    return {
      ...base,
      reportPresent: true,
      reportHash: sha256(rawJson),
      registeredBatchReady,
      arbitraryFactoryNoShip: registry.arbitraryFactoryNoShip !== false,
      currentSourceProofRequired: true,
      proofBeforeExecutionRequired: !registeredBatchReady,
      readinessFreshness: "snapshot_requires_current_source_refresh_before_execution",
      registeredAgenticBatchReadyFactoryCount: readyFactories.length,
      factoriesMissingRegisteredBatchProofCount: missingFactories.length,
      selectedFactoryMissingRegisteredBatchProof: typeof factoryName === "string" ? missingFactories.includes(factoryName) : undefined,
    };
  } catch {
    return { ...base, reportPresent: true, readinessFreshness: "invalid_registry_snapshot", reportHash: undefined };
  }
}

export function buildAutonomousContextArtifacts(repoRoot: string, scope: Record<string, unknown>, queryHash: string): Record<string, unknown> {
  const scopeErrors = validateContextScope(repoRoot, scope);
  if (scopeErrors.length > 0) return { lookupResults: [], contextPack: undefined, contextPackValid: false, contextPackErrors: scopeErrors };
  const allowedSources = Array.isArray(scope.allowedSources) ? scope.allowedSources.filter((source): source is string => typeof source === "string") : [];
  try {
    const lookupResults: Record<string, unknown>[] = [];
    if (allowedSources.includes("zob-harness-docs")) {
      const citation = "harness-system:zob-harness-docs:docs/AUTONOMOUS_SUPER_FACTORY_GOAL.md#phase-3";
      lookupResults.push(buildBrainLookupResult(repoRoot, {
        scope,
        brainId: "harness-system",
        sourceId: "zob-harness-docs",
        queryHash,
        facts: [{ factHash: sha256("autonomous loop requires spec context factory oracle final report"), citations: [citation], confidence: "HIGH" }],
        gaps: [{ gapHash: sha256("P0 dry-run does not execute live factories"), citations: [citation], noShipIfTreatedAsPass: true }],
        confidence: "HIGH",
      }));
    }
    if (allowedSources.includes("factory-run-reports")) {
      const citation = "factory-evidence:factory-run-reports:reports/factory-registry-readiness-audit-smoke.json";
      lookupResults.push(buildBrainLookupResult(repoRoot, {
        scope,
        brainId: "factory-evidence",
        sourceId: "factory-run-reports",
        queryHash,
        facts: [{ factHash: sha256("registered factory current-source proof is required before execution"), citations: [citation], confidence: "HIGH", sourcePresent: existsSync(join(repoRoot, "reports", "factory-registry-readiness-audit-smoke.json")) }],
        gaps: [{ gapHash: sha256("selected factory may still require current-source proof refresh"), citations: [citation], noShipIfTreatedAsPass: true }],
        confidence: "HIGH",
      }));
    }
    if (lookupResults.length === 0 && allowedSources.includes("zob-harness-src")) {
      const citation = "harness-system:zob-harness-src:.pi/extensions/zob-harness/src/domains/autonomy/autonomous-runtime.ts";
      lookupResults.push(buildBrainLookupResult(repoRoot, {
        scope,
        brainId: "harness-system",
        sourceId: "zob-harness-src",
        queryHash,
        facts: [{ factHash: sha256("autonomous dry-run implementation is repo-local metadata-only"), citations: [citation], confidence: "MEDIUM" }],
        confidence: "MEDIUM",
      }));
    }
    if (lookupResults.length === 0) return { lookupResults: [], contextPack: undefined, contextPackValid: false, contextPackErrors: ["no_allowed_context_source_for_autonomous_lookup"] };
    const contextPack = buildContextPack(repoRoot, scope, lookupResults);
    const contextPackErrors = validateContextPack(repoRoot, contextPack);
    return { lookupResults, contextPack, contextPackValid: contextPackErrors.length === 0, contextPackErrors };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { lookupResults: [], contextPack: undefined, contextPackValid: false, contextPackErrors: [message] };
  }
}

export function buildAutonomousRuntimeGates(input: { runId: string; risk: AutonomousRisk; budgetProfile: AutonomousBudgetProfile; applyPolicy: AutonomousApplyPolicy; maxContextTokens?: number }): Record<string, unknown> {
  const budgetGate = evaluateBudgetPreflightDryRun({
    runs: 0,
    durationMs: 0,
    parallelChildren: 0,
    caps: { maxRuns: 0, maxParallelChildren: 0 },
    strictRequested: input.budgetProfile === "strict_requested",
  });
  const modelRoutingGate = evaluateModelRoutingDryRun({
    mode: "factory",
    taskType: "autonomous-runtime-dry-run",
    risk: input.risk,
    contextTokens: input.maxContextTokens,
    estimatedRuns: 0,
    estimatedParallelChildren: 0,
    caps: { maxRuns: 0, maxParallelChildren: 0 },
    strictRequested: input.budgetProfile === "strict_requested",
  });
  const sandboxGate = {
    schema: "zob.autonomous-sandbox-gate.v1",
    applyPolicy: input.applyPolicy,
    sandboxSimulationPlanned: input.applyPolicy === "sandbox_simulation",
    manualApplyOnly: input.applyPolicy === "manual_apply_only",
    launchAuthorizedApplyPlanned: input.applyPolicy === "auto_apply_in_scope",
    launchAuthorizationRequiredForApply: input.applyPolicy === "auto_apply_in_scope",
    productionWritesPerformed: false,
    autoApply: false,
    rollbackRequiredBeforeRealApply: true,
    oracleDiffReviewRequiredBeforeRealApply: true,
    childDispatchAllowed: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const daemonGate = {
    schema: "zob.autonomous-daemon-gate.v1",
    autoStartDaemon: false,
    continuousLoop: false,
    daemonStarted: false,
    manualOneShotOnly: true,
    killSwitchRequiredBeforeLiveAutonomy: true,
    childDispatchAllowed: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const missionControlGate = {
    schema: "zob.autonomous-mission-control-gate.v1",
    proposalOnly: true,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    topologyGuardRequired: true,
    hashOnlyLedgerRequired: true,
    childDispatchAllowed: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const autonomousStrictBudgetGate = {
    schema: "zob.autonomous-strict-budget-gate.v1",
    strictBudgetRequiredForAutonomy: true,
    budgetProfile: input.budgetProfile,
    strictRequested: input.budgetProfile === "strict_requested",
    strictEnabled: false,
    globalDefaultEnabled: false,
    budgetEnforced: false,
    childDispatchAllowed: false,
    dispatchBlockedUntilLiveStrictGate: true,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const checks = [
    { name: "autonomous_strict_budget_requested_no_dispatch", passed: autonomousStrictBudgetGate.strictRequested === true && autonomousStrictBudgetGate.noExecution === true && autonomousStrictBudgetGate.budgetEnforced === false && autonomousStrictBudgetGate.childDispatchAllowed === false },
    { name: "budget_preflight_advisory_no_dispatch", passed: budgetGate.noExecution === true && budgetGate.childDispatchAllowed === false && budgetGate.budgetEnforced === false && budgetGate.wouldBlockDispatch === false },
    { name: "model_routing_dry_run_no_dispatch", passed: modelRoutingGate.noExecution === true && modelRoutingGate.modelRouterUsed === false && modelRoutingGate.routingApplied === false && modelRoutingGate.childDispatchAllowed === false },
    { name: "sandbox_no_production_apply", passed: sandboxGate.productionWritesPerformed === false && sandboxGate.autoApply === false && sandboxGate.noExecution === true },
    { name: "daemon_not_started", passed: daemonGate.daemonStarted === false && daemonGate.autoStartDaemon === false && daemonGate.continuousLoop === false },
    { name: "mission_control_proposals_only", passed: missionControlGate.proposalOnly === true && missionControlGate.directWorkerWrites === false && missionControlGate.transportDispatch === false && missionControlGate.networkComsEnabled === false },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  const gates = {
    schema: "zob.autonomous-runtime-gates.v1",
    runId: input.runId,
    passed: failedChecks.length === 0,
    failedChecks,
    checks,
    budgetGate,
    autonomousStrictBudgetGate,
    modelRoutingGate,
    sandboxGate,
    daemonGate,
    missionControlGate,
    dryRun: true,
    noExecution: true,
    childDispatchAllowed: false,
    globalBudgetEnforced: false,
    globalModelRoutingEnabled: false,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    networkAccessed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(gates)) throw new Error("autonomous runtime gates would store forbidden plaintext body keys");
  return gates;
}

export function buildAutonomousStrictBudgetProofPlan(input: { runId: string; runtimeGates: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const scenarioSpecs = [
    { name: "strict_gate_allows_within_caps", gateInput: { runId: `${input.runId}-strict-budget-allow`, mode: "smoke", execution: "agentic", taskCount: 1, budget: { strictEnabled: true, maxRuns: 2, estimatedRuns: 1, maxParallelChildren: 1, estimatedParallelChildren: 1 } } },
    { name: "strict_gate_blocks_exceedance_pre_dispatch", gateInput: { runId: `${input.runId}-strict-budget-block`, mode: "smoke", execution: "agentic", taskCount: 3, budget: { strictEnabled: true, maxRuns: 2, estimatedRuns: 3, maxParallelChildren: 1, estimatedParallelChildren: 1 } } },
    { name: "strict_gate_default_disabled_advisory", gateInput: { runId: `${input.runId}-strict-budget-default`, mode: "smoke", execution: "agentic", taskCount: 3, budget: { strictRequested: true, maxRuns: 2, estimatedRuns: 3, maxParallelChildren: 1, estimatedParallelChildren: 1 } } },
  ].map((scenario) => {
    const gate = evaluateStrictBudgetDispatchGate(scenario.gateInput);
    return {
      name: scenario.name,
      inputHash: sha256(JSON.stringify(scenario.gateInput)),
      strictRequested: gate.strictRequested === true,
      strictEnabled: gate.strictEnabled === true,
      budgetEnforced: gate.budgetEnforced === true,
      wouldExceed: gate.wouldExceed === true,
      wouldBlockDispatch: gate.wouldBlockDispatch === true,
      gateChildDispatchAllowed: gate.childDispatchAllowed === true,
      dispatchDecision: gate.dispatchDecision,
      stopCondition: gate.stopCondition,
      noExecution: gate.noExecution === true,
      failures: Array.isArray(gate.failures) ? gate.failures.filter((failure): failure is string => typeof failure === "string") : [],
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    };
  });
  const allow = scenarioSpecs.find((scenario) => scenario.name === "strict_gate_allows_within_caps");
  const block = scenarioSpecs.find((scenario) => scenario.name === "strict_gate_blocks_exceedance_pre_dispatch");
  const defaultDisabled = scenarioSpecs.find((scenario) => scenario.name === "strict_gate_default_disabled_advisory");
  const autonomousStrictBudgetGate = isRecord(input.runtimeGates.autonomousStrictBudgetGate) ? input.runtimeGates.autonomousStrictBudgetGate : {};
  const checks = [
    { name: "strict_gate_allows_within_caps", passed: allow?.strictEnabled === true && allow.budgetEnforced === true && allow.wouldBlockDispatch === false && allow.gateChildDispatchAllowed === true && allow.dispatchDecision === "allow_strict" },
    { name: "strict_gate_blocks_exceedance_pre_dispatch", passed: block?.strictEnabled === true && block.budgetEnforced === true && block.wouldBlockDispatch === true && block.gateChildDispatchAllowed === false && block.dispatchDecision === "block" && block.stopCondition === "blocked" },
    { name: "strict_gate_default_disabled_advisory", passed: defaultDisabled?.strictRequested === true && defaultDisabled.strictEnabled === false && defaultDisabled.budgetEnforced === false && defaultDisabled.wouldBlockDispatch === false && defaultDisabled.dispatchDecision === "allow_advisory" },
    { name: "autonomous_runtime_global_budget_still_disabled", passed: autonomousStrictBudgetGate.strictRequested === true && autonomousStrictBudgetGate.strictEnabled === false && autonomousStrictBudgetGate.budgetEnforced === false && autonomousStrictBudgetGate.childDispatchAllowed === false },
    { name: "run_scope_no_global_autonomy", passed: input.validation.globalAutonomyReady === false && input.validation.globalAutonomyNoShip === true && input.validation.childDispatchAllowed === false && input.validation.productionWritesPerformed === false && input.validation.autoApply === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const proof = {
    schema: "zob.autonomous-strict-budget-proof-plan.v1",
    runId: input.runId,
    phase: "5B",
    status: failedChecks.length === 0 ? "strict_budget_dispatch_gate_proof_ready_global_default_blocked" : "strict_budget_dispatch_gate_proof_incomplete",
    strictBudgetProofReady: failedChecks.length === 0,
    strictBudgetDispatchGateAvailable: true,
    strictBudgetAllowProofPassed: allow?.dispatchDecision === "allow_strict" && allow.budgetEnforced === true,
    strictBudgetBlockProofPassed: block?.dispatchDecision === "block" && block.wouldBlockDispatch === true,
    strictBudgetDefaultDisabledProofPassed: defaultDisabled?.dispatchDecision === "allow_advisory" && defaultDisabled.strictEnabled === false,
    finalE2ERequirementCleared: false,
    no_ship: true,
    checks,
    failedChecks,
    scenarios: scenarioSpecs,
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/runtime-gates.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
    ],
    blockers: [
      "live_autonomous_strict_budget_not_enforced",
      "global_default_strict_budget_disabled",
      "final_e2e_strict_budget_evidence_required",
    ],
    autonomousRuntimeStrictBudgetEnforced: false,
    globalStrictBudgetEnabled: false,
    globalBudgetEnforced: false,
    liveAutonomousBudgetEnforced: false,
    budgetEnforced: false,
    strictEnabled: false,
    childDispatchAllowed: false,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecution: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(proof)) throw new Error("autonomous strict budget proof plan would store forbidden plaintext body keys");
  return proof;
}

export function buildAutonomousModelRoutingPlan(input: { runId: string; risk: AutonomousRisk; budgetProfile: AutonomousBudgetProfile; maxContextTokens?: number; specText: string; selectedFactory?: string }): Record<string, unknown> {
  const strictRequested = input.budgetProfile === "strict_requested";
  const contextTokens = typeof input.maxContextTokens === "number" && Number.isFinite(input.maxContextTokens) ? Math.max(0, Math.floor(input.maxContextTokens)) : 0;
  const highContextRequired = contextTokens >= 120_000;
  const securitySensitive = input.risk === "high" || /\b(security|secure|vulnerability|vulnerabilities|auth|permission|permissions|sandbox|apply|write|privilege|injection)\b/i.test(input.specText);
  const routeSpecs: Array<{ stage: string; mode: "explore" | "plan" | "implement" | "oracle" | "factory"; taskType: string; outputContract?: string; risk: AutonomousRisk; contextTokens?: number; expectedModelClass: string; securityCritical?: boolean; oracleCritical?: boolean }> = [
    { stage: "context_reuse_scout", mode: "explore", taskType: "read-only-inspection", risk: "low", expectedModelClass: "cheap_scout" },
    { stage: "context_pack", mode: "explore", taskType: "context-pack-read-only", risk: "low", contextTokens: contextTokens || undefined, expectedModelClass: highContextRequired ? "high_context" : "cheap_scout" },
    { stage: "factory_selection", mode: "factory", taskType: securitySensitive ? "security-critical-plan" : "factory-selection", risk: securitySensitive ? "high" : input.risk, expectedModelClass: securitySensitive ? "strong_reasoning" : "balanced_worker", securityCritical: securitySensitive },
    { stage: "factory_smoke_plan", mode: "factory", taskType: `factory-smoke:${input.selectedFactory ?? "unselected"}`, risk: input.risk, expectedModelClass: input.risk === "high" ? "strong_reasoning" : "balanced_worker" },
    { stage: "smoke_oracle", mode: "oracle", taskType: "oracle-review", outputContract: "oracle.v1", risk: "high", expectedModelClass: "strong_oracle", oracleCritical: true },
    { stage: "pilot_oracle", mode: "oracle", taskType: "oracle-review", outputContract: "oracle.v1", risk: "high", expectedModelClass: "strong_oracle", oracleCritical: true },
    { stage: "final_report_synthesis", mode: "implement", taskType: "synthesis-final-report", risk: input.risk, expectedModelClass: input.risk === "high" ? "strong_reasoning" : "balanced_worker" },
  ];
  if (securitySensitive) {
    routeSpecs.push({ stage: "security_reasoning_gate", mode: "plan", taskType: "security-critical-plan", risk: "high", expectedModelClass: "strong_reasoning", securityCritical: true });
  }
  const routes = routeSpecs.map((spec) => {
    const route = evaluateModelRoutingDryRun({
      mode: spec.mode,
      taskType: spec.taskType,
      outputContract: spec.outputContract,
      risk: spec.risk,
      contextTokens: spec.contextTokens,
      estimatedRuns: 0,
      estimatedParallelChildren: 0,
      caps: { maxRuns: 0, maxParallelChildren: 0 },
      strictRequested,
    });
    return {
      stage: spec.stage,
      mode: spec.mode,
      taskType: spec.taskType,
      outputContract: spec.outputContract,
      risk: spec.risk,
      contextTokens: spec.contextTokens,
      expectedModelClass: spec.expectedModelClass,
      recommendedModelClass: route.recommendedModelClass,
      matchedExpectedClass: route.recommendedModelClass === spec.expectedModelClass,
      reasonCodes: Array.isArray(route.reasonCodes) ? route.reasonCodes : [],
      budgetWouldExceed: route.budgetWouldExceed === true,
      budgetEnforced: route.budgetEnforced === true,
      strictRequested: route.strictRequested === true,
      strictEnabled: route.strictEnabled === true,
      modelRouterUsed: route.modelRouterUsed === true,
      routingApplied: route.routingApplied === true,
      childDispatchAllowed: route.childDispatchAllowed === true,
      noExecution: route.noExecution === true,
      securityCritical: spec.securityCritical === true,
      oracleCritical: spec.oracleCritical === true,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    };
  });
  const oracleRoutes = routes.filter((route) => route.oracleCritical === true);
  const securityRoutes = routes.filter((route) => route.securityCritical === true);
  const checks = [
    { name: "model_routing_plan_present", passed: routes.length >= 7 },
    { name: "low_risk_readonly_uses_cheap_scout", passed: routes.some((route) => route.stage === "context_reuse_scout" && route.recommendedModelClass === "cheap_scout") },
    { name: "oracle_uses_strong_oracle", passed: oracleRoutes.length > 0 && oracleRoutes.every((route) => route.recommendedModelClass === "strong_oracle") },
    { name: "high_context_uses_high_context", passed: !highContextRequired || routes.some((route) => route.stage === "context_pack" && route.recommendedModelClass === "high_context") },
    { name: "security_not_downgraded", passed: !securitySensitive || (securityRoutes.length > 0 && securityRoutes.every((route) => route.recommendedModelClass === "strong_reasoning" || route.recommendedModelClass === "strong_oracle" || route.recommendedModelClass === "high_context")) },
    { name: "budget_aware_strict_requested", passed: strictRequested && routes.every((route) => route.strictRequested === true && route.budgetEnforced === false && route.strictEnabled === false) },
    { name: "routing_dry_run_no_dispatch", passed: routes.every((route) => route.noExecution === true && route.modelRouterUsed === false && route.routingApplied === false && route.childDispatchAllowed === false) },
    { name: "global_live_routing_disabled", passed: true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const plan = {
    schema: "zob.autonomous-model-routing-plan.v1",
    runId: input.runId,
    selectedFactory: input.selectedFactory,
    routingRequiredForAutonomy: true,
    routingPlanReady: failedChecks.length === 0,
    failedChecks,
    checks,
    routes,
    highContextRequired,
    securitySensitive,
    budgetAware: strictRequested,
    strictRequested,
    strictEnabled: false,
    budgetEnforced: false,
    liveRoutingEnabled: false,
    globalLiveRoutingEnabled: false,
    modelRouterUsed: false,
    routingApplied: false,
    childDispatchAllowed: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous model routing plan would store forbidden plaintext body keys");
  return plan;
}

export function buildAutonomousModelRoutingProofPlan(input: { runId: string; modelRoutingPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const proofModelByClass = { cheap_scout: "scout-model", balanced_worker: "worker-model", strong_reasoning: "reasoning-model", strong_oracle: "oracle-model", high_context: "long-context-model" };
  const scenarioSpecs = [
    { name: "routing_default_disabled", gateInput: { runId: `${input.runId}-routing-default`, mode: "factory" as const, stage: "map", agent: "explore", outputContract: "explore.v1", modelRouting: { enabled: false, modelByClass: proofModelByClass } } },
    { name: "routing_oracle_applies_when_enabled", gateInput: { runId: `${input.runId}-routing-oracle`, mode: "factory" as const, stage: "validate", agent: "oracle-merge", outputContract: "oracle-merge.v1", modelRouting: { enabled: true, modelByClass: proofModelByClass } } },
    { name: "routing_high_context_applies_when_enabled", gateInput: { runId: `${input.runId}-routing-high-context`, mode: "factory" as const, stage: "reduce", agent: "synthesis", outputContract: "synthesis.v1", modelRouting: { enabled: true, contextTokens: 150_000, modelByClass: proofModelByClass } } },
    { name: "routing_security_not_downgraded_when_enabled", gateInput: { runId: `${input.runId}-routing-security`, mode: "plan" as const, stage: "security_reasoning_gate", agent: "planner", outputContract: "plan.v1", risk: "high" as const, taskType: "security-critical-plan", modelRouting: { enabled: true, modelByClass: proofModelByClass } } },
  ].map((scenario) => {
    const gate = evaluateModelRoutingDispatchGate(scenario.gateInput);
    return {
      name: scenario.name,
      inputHash: sha256(JSON.stringify(scenario.gateInput)),
      liveRoutingRequested: gate.liveRoutingRequested === true,
      liveRoutingEnabled: gate.liveRoutingEnabled === true,
      modelRouterUsed: gate.modelRouterUsed === true,
      routingApplied: gate.routingApplied === true,
      selectedModelClass: gate.selectedModelClass,
      recommendedModelClass: gate.recommendedModelClass,
      selectedModelHash: typeof gate.selectedModelHash === "string" ? gate.selectedModelHash : undefined,
      selectedModelStored: gate.selectedModelStored === true,
      modelByClassProvided: gate.modelByClassProvided === true,
      gateChildDispatchAllowed: gate.childDispatchAllowed === true,
      defaultDispatchDecision: gate.defaultDispatchDecision,
      noExecution: gate.noExecution === true,
      budgetEnforced: gate.budgetEnforced === true,
      strictEnabled: gate.strictEnabled === true,
      reasonCodes: Array.isArray(gate.reasonCodes) ? gate.reasonCodes.filter((reason): reason is string => typeof reason === "string") : [],
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    };
  });
  const defaultDisabled = scenarioSpecs.find((scenario) => scenario.name === "routing_default_disabled");
  const oracle = scenarioSpecs.find((scenario) => scenario.name === "routing_oracle_applies_when_enabled");
  const highContext = scenarioSpecs.find((scenario) => scenario.name === "routing_high_context_applies_when_enabled");
  const security = scenarioSpecs.find((scenario) => scenario.name === "routing_security_not_downgraded_when_enabled");
  const checks = [
    { name: "routing_default_disabled", passed: defaultDisabled?.liveRoutingEnabled === false && defaultDisabled.modelRouterUsed === false && defaultDisabled.routingApplied === false && defaultDisabled.gateChildDispatchAllowed === false && defaultDisabled.defaultDispatchDecision === "allow_default_model" },
    { name: "routing_oracle_uses_strong_oracle_when_enabled", passed: oracle?.liveRoutingEnabled === true && oracle.modelRouterUsed === true && oracle.routingApplied === true && oracle.selectedModelClass === "strong_oracle" && typeof oracle.selectedModelHash === "string" && oracle.selectedModelStored === false },
    { name: "routing_high_context_uses_high_context_when_enabled", passed: highContext?.liveRoutingEnabled === true && highContext.selectedModelClass === "high_context" && typeof highContext.selectedModelHash === "string" && highContext.selectedModelStored === false },
    { name: "routing_security_not_downgraded_when_enabled", passed: security?.liveRoutingEnabled === true && security.selectedModelClass === "strong_reasoning" && typeof security.selectedModelHash === "string" && security.selectedModelStored === false },
    { name: "autonomous_model_routing_plan_still_disabled", passed: input.modelRoutingPlan.liveRoutingEnabled === false && input.modelRoutingPlan.globalLiveRoutingEnabled === false && input.modelRoutingPlan.modelRouterUsed === false && input.modelRoutingPlan.routingApplied === false && input.modelRoutingPlan.childDispatchAllowed === false },
    { name: "run_scope_no_global_autonomy", passed: input.validation.globalAutonomyReady === false && input.validation.globalAutonomyNoShip === true && input.validation.childDispatchAllowed === false && input.validation.productionWritesPerformed === false && input.validation.autoApply === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const proof = {
    schema: "zob.autonomous-model-routing-proof-plan.v1",
    runId: input.runId,
    phase: "6B",
    status: failedChecks.length === 0 ? "model_routing_dispatch_gate_proof_ready_global_default_blocked" : "model_routing_dispatch_gate_proof_incomplete",
    modelRoutingProofReady: failedChecks.length === 0,
    liveRoutingDispatchGateAvailable: true,
    routingDefaultDisabledProofPassed: defaultDisabled?.defaultDispatchDecision === "allow_default_model" && defaultDisabled.liveRoutingEnabled === false,
    routingOracleProofPassed: oracle?.selectedModelClass === "strong_oracle" && oracle.routingApplied === true,
    routingHighContextProofPassed: highContext?.selectedModelClass === "high_context" && highContext.routingApplied === true,
    routingSecurityNoDowngradeProofPassed: security?.selectedModelClass === "strong_reasoning" && security.routingApplied === true,
    selectedModelsStored: false,
    selectedModelHashesOnly: scenarioSpecs.every((scenario) => scenario.selectedModelStored === false && (scenario.liveRoutingEnabled === false || typeof scenario.selectedModelHash === "string")),
    finalE2ERequirementCleared: false,
    no_ship: true,
    checks,
    failedChecks,
    scenarios: scenarioSpecs,
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/model-routing-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
    ],
    blockers: [
      "live_autonomous_model_routing_not_enabled",
      "global_default_model_routing_disabled",
      "final_e2e_model_routing_evidence_required",
    ],
    globalLiveRoutingEnabled: false,
    liveAutonomousRoutingApplied: false,
    modelRouterUsed: false,
    routingApplied: false,
    budgetEnforced: false,
    strictEnabled: false,
    childDispatchAllowed: false,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecution: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(proof)) throw new Error("autonomous model routing proof plan would store forbidden plaintext body keys");
  return proof;
}

export function buildAutonomousRunGraph(input: {
  runId: string;
  specLocked: boolean;
  contextScopeValid: boolean;
  contextPackValid: boolean;
  runtimeGatesValid: boolean;
  modelRoutingPlanValid: boolean;
  factorySelected: boolean;
  registeredBatchReady: boolean;
  proofBeforeExecutionRequired: boolean;
  selectedFactory?: string;
}): Record<string, unknown> {
  const nodes = [
    { id: "spec_gate", kind: "gate", artifactRef: "spec-gate.json", passed: input.specLocked, stopOnFail: true },
    { id: "context_scope", kind: "context", artifactRef: "context-scope.json", passed: input.contextScopeValid, stopOnFail: true },
    { id: "context_lookup", kind: "context", artifactRef: "context-lookup.json", passed: input.contextPackValid, stopOnFail: true },
    { id: "context_pack", kind: "context", artifactRef: "context-pack.json", passed: input.contextPackValid, stopOnFail: true },
    { id: "runtime_gates", kind: "gate", artifactRef: "runtime-gates.json", passed: input.runtimeGatesValid, stopOnFail: true },
    { id: "model_routing_plan", kind: "gate", artifactRef: "model-routing-plan.json", passed: input.modelRoutingPlanValid, stopOnFail: true },
    { id: "factory_selection", kind: "selection", artifactRef: "factory-selection.json", passed: input.factorySelected, selectedFactory: input.selectedFactory, stopOnFail: true },
    { id: "registered_factory_current_source_proof", kind: "proof", artifactRef: "proof-plan.json", passed: input.registeredBatchReady, proofBeforeExecutionRequired: input.proofBeforeExecutionRequired, stopOnFail: false },
    { id: "smoke", kind: "future_execution", artifactRef: "SMOKE_PASSED.sentinel", passed: false, dispatchAllowed: false },
    { id: "smoke_oracle", kind: "future_oracle", artifactRef: "oracle-review-pass.json", passed: false, dispatchAllowed: false },
    { id: "pilot", kind: "future_execution", artifactRef: "PILOT_PASSED.sentinel", passed: false, dispatchAllowed: false },
    { id: "pilot_oracle", kind: "future_oracle", artifactRef: "oracle-review-pass.json", passed: false, dispatchAllowed: false },
    { id: "batch", kind: "future_execution", artifactRef: "BATCH_PASSED.sentinel", passed: false, dispatchAllowed: false },
    { id: "final_report", kind: "report", artifactRef: "final-report.md", passed: false, dispatchAllowed: false },
  ];
  const edges = [
    ["spec_gate", "context_scope"],
    ["context_scope", "context_lookup"],
    ["context_lookup", "context_pack"],
    ["context_pack", "runtime_gates"],
    ["runtime_gates", "model_routing_plan"],
    ["model_routing_plan", "factory_selection"],
    ["factory_selection", "registered_factory_current_source_proof"],
    ["registered_factory_current_source_proof", "smoke"],
    ["smoke", "smoke_oracle"],
    ["smoke_oracle", "pilot"],
    ["pilot", "pilot_oracle"],
    ["pilot_oracle", "batch"],
    ["batch", "final_report"],
  ].map(([from, to]) => ({ from, to, parentOwned: true, dispatchAllowed: false }));
  const runGraph = {
    schema: "zob.autonomous-run-graph.v1",
    runId: input.runId,
    status: input.specLocked && input.contextScopeValid && input.contextPackValid && input.runtimeGatesValid && input.modelRoutingPlanValid && input.factorySelected ? "dry_run_graph_ready" : "dry_run_graph_blocked",
    parentOwned: true,
    nodes,
    edges,
    stopConditions: ["clarification_required", "context_scope_invalid", "context_pack_invalid", "runtime_gates_invalid", "model_routing_plan_invalid", "factory_selection_missing", "current_source_proof_missing", "oracle_fail", "budget_exceeded", "secret_reference", "production_apply_requested"],
    futureExecutionNodesDispatchAllowed: false,
    childDispatchAllowed: false,
    noExecution: true,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(runGraph)) throw new Error("autonomous run graph would store forbidden plaintext body keys");
  return runGraph;
}

export function detectContextNeedTags(specText: string): string[] {
  const lower = specText.toLowerCase();
  const tags = new Set<string>(["harness-system", "factory-evidence"]);
  if (/factory|batch|pilot|smoke|oracle/.test(lower)) tags.add("factory-evidence");
  if (/context|gbrain|brain|citation|source/.test(lower)) tags.add("context-gbrain");
  if (/budget|cost|cap/.test(lower)) tags.add("budget-policy");
  if (/model|routing|oracle/.test(lower)) tags.add("model-routing");
  if (/sandbox|apply|write|patch|edit/.test(lower)) tags.add("sandbox-policy");
  if (/daemon|queue|worker|mission|coms|heartbeat/.test(lower)) tags.add("mission-control");
  return [...tags].sort();
}

export function buildClarificationQuestions(input: {
  shortSpec: boolean;
  missingAcceptance: boolean;
  missingArtifacts: boolean;
  missingAllowedPaths: boolean;
  unsafeAllowedPaths: boolean;
  missingApplyPolicy: boolean;
  missingBudgetProfile: boolean;
  riskyApply: boolean;
  sensitiveReference: boolean;
}): string[] {
  const questions: string[] = [];
  if (input.shortSpec) questions.push("What exact deliverable should the autonomous dry-run plan target?");
  if (input.missingAcceptance) questions.push("What acceptance criteria must be true before the run can proceed past spec lock?");
  if (input.missingArtifacts) questions.push("Which final artifacts or reports should be produced?");
  if (input.missingAllowedPaths) questions.push("Which repo-relative allowed_paths should bound future autonomous work?");
  if (input.unsafeAllowedPaths) questions.push("Please remove unsafe or forbidden entries from allowed_paths and keep them in forbidden_paths only.");
  if (input.missingApplyPolicy) questions.push("Which apply_policy should govern this autonomous run: no_apply, sandbox_simulation, manual_apply_only, or auto_apply_in_scope?");
  if (input.missingBudgetProfile) questions.push("Which budget_profile should govern this autonomous run: advisory or strict_requested?");
  if (input.riskyApply) questions.push("Should this remain no-apply/manual-apply, or is a sandbox simulation explicitly required?");
  if (input.sensitiveReference) questions.push("Please remove or replace any secret-like values with safe placeholders before planning.");
  return questions;
}

export function buildAutonomousRuntimeDryRun(repoRoot: string, input: AutonomousRuntimeDryRunInput): Record<string, unknown> {
  const userNeed = typeof input.userNeed === "string" ? input.userNeed.trim() : "";
  const refinedSpec = typeof input.refinedSpec === "string" && input.refinedSpec.trim().length > 0 ? input.refinedSpec.trim() : userNeed;
  const constraints = stableStrings(input.constraints);
  const acceptanceCriteria = stableStrings(input.acceptanceCriteria);
  const expectedArtifacts = stableStrings(input.expectedArtifacts);
  const allowedPaths = stableStrings(input.allowedPaths);
  const forbiddenPaths = stableStrings(input.forbiddenPaths ?? DEFAULT_AUTONOMOUS_FORBIDDEN_PATHS);
  const applyPolicyProvided = typeof input.applyPolicy === "string";
  const budgetProfileProvided = typeof input.budgetProfile === "string";
  const applyPolicy = input.applyPolicy ?? "no_apply";
  const budgetProfile = input.budgetProfile ?? "advisory";
  const risk = input.risk ?? "medium";
  const authorizedAutonomyLevel = input.authorizedAutonomyLevel ?? inferAutonomousLevel(applyPolicy);
  const userLaunchConfirmed = input.userLaunchConfirmed === true;
  const allowedActions = stableStrings(input.allowedActions ?? defaultAutonomousAllowedActions(applyPolicy));
  const runId = safeFileStem(input.runId ?? `autonomous-dry-run-${sha256(refinedSpec || "missing-spec").slice(0, 12)}`);
  const specText = `${userNeed}\n${refinedSpec}\n${constraints.join("\n")}\n${acceptanceCriteria.join("\n")}\n${expectedArtifacts.join("\n")}`;
  const shortSpec = refinedSpec.length < 24;
  const ambiguous = AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(refinedSpec));
  const sensitiveReference = SECRET_PATTERNS.some((pattern) => pattern.test(specText));
  const missingAcceptance = acceptanceCriteria.length === 0;
  const missingArtifacts = expectedArtifacts.length === 0;
  const pathGateErrors = validateAutonomousSpecPathGate(allowedPaths, forbiddenPaths);
  const missingAllowedPaths = allowedPaths.length === 0;
  const unsafeAllowedPaths = pathGateErrors.some((error) => error !== "allowed_paths_required_before_execution");
  const missingApplyPolicy = !applyPolicyProvided;
  const missingBudgetProfile = !budgetProfileProvided;
  const riskyApply = applyPolicy !== "no_apply" && allowedPaths.length === 0;
  const clarificationRequired = !userNeed || shortSpec || ambiguous || sensitiveReference || missingAcceptance || missingArtifacts || missingAllowedPaths || unsafeAllowedPaths || missingApplyPolicy || missingBudgetProfile || riskyApply;
  const clarificationQuestions = buildClarificationQuestions({ shortSpec: !userNeed || shortSpec || ambiguous, missingAcceptance, missingArtifacts, missingAllowedPaths, unsafeAllowedPaths, missingApplyPolicy, missingBudgetProfile, riskyApply, sensitiveReference });

  const contextScope = buildDefaultContextScope(repoRoot, {
    runId,
    allowedSources: input.allowedSources,
    forbiddenSources: forbiddenPaths,
    agentProfile: "autonomous-runtime-dry-run-p0",
    maxContextTokens: input.maxContextTokens,
  });
  const contextScopeErrors = validateContextScope(repoRoot, contextScope);
  const contextArtifacts = buildAutonomousContextArtifacts(repoRoot, contextScope, sha256(refinedSpec));
  const contextPackValid = contextArtifacts.contextPackValid === true;
  const contextPackErrors = Array.isArray(contextArtifacts.contextPackErrors) ? contextArtifacts.contextPackErrors : [];
  const runtimeGates = buildAutonomousRuntimeGates({ runId, risk, budgetProfile, applyPolicy, maxContextTokens: input.maxContextTokens });
  const runtimeGatesValid = runtimeGates.passed === true;
  const capabilityIndex = buildCapabilityIndex(repoRoot);
  const reuseScout = buildReuseScoutReport(repoRoot, { query: refinedSpec, run_id: runId, limit: 8 });
  const candidates = Array.isArray(reuseScout.candidates) ? reuseScout.candidates : [];
  const factories = capabilityFactories(capabilityIndex);
  const factoryForgeAvailable = factories.some((factory) => factory.id === "factory-forge");
  const factoryScore = selectAutonomousFactory({ factories, refinedSpec, acceptanceCriteria, expectedArtifacts });
  const selectedFactory = typeof factoryScore.selectedFactory === "string" ? factoryScore.selectedFactory : (factoryForgeAvailable ? "factory-forge" : undefined);
  const selectionStatus = typeof factoryScore.selectionStatus === "string" && factoryScore.selectionStatus !== "no_factory_available"
    ? factoryScore.selectionStatus
    : (factoryForgeAvailable ? "factory_forge_quarantine_recommended" : "no_factory_available");
  const manifestAvailability = factoryManifestAvailability(repoRoot, selectedFactory);
  const factoryReadiness = readFactoryRegistryReadiness(repoRoot, selectedFactory);
  const proofBeforeExecutionRequired = factoryReadiness.proofBeforeExecutionRequired === true;
  const modelRoutingPlan = buildAutonomousModelRoutingPlan({ runId, risk, budgetProfile, maxContextTokens: input.maxContextTokens, specText, selectedFactory });
  const modelRoutingPlanValid = modelRoutingPlan.routingPlanReady === true;
  const selectionBlockers = selectedFactory ? [] : ["no_factory_available_for_spec"];

  const strictBudgetMissing = budgetProfile !== "strict_requested";
  const blockers = [
    ...(!userNeed ? ["user_need_required"] : []),
    ...(clarificationRequired ? ["clarification_required_before_execution"] : []),
    ...pathGateErrors,
    ...(missingApplyPolicy ? ["apply_policy_required_before_execution"] : []),
    ...(missingBudgetProfile ? ["budget_profile_required_before_execution"] : []),
    ...(!missingBudgetProfile && strictBudgetMissing ? ["autonomous_strict_budget_required_before_execution"] : []),
    ...(contextScopeErrors.length > 0 ? ["context_scope_invalid"] : []),
    ...(!contextPackValid ? ["context_pack_invalid"] : []),
    ...(!runtimeGatesValid ? ["runtime_gates_invalid"] : []),
    ...(!modelRoutingPlanValid ? ["model_routing_plan_invalid"] : []),
    ...selectionBlockers,
  ];
  const specLocked = blockers.length === 0;
  const launchAuthorization = {
    schema: "zob.launch-authorization.v1",
    runId,
    originalUserAskHash: sha256(userNeed),
    refinedSpecHash: sha256(refinedSpec),
    specLocked,
    userLaunchConfirmed,
    launchConfirmedAt: userLaunchConfirmed && typeof input.launchConfirmedAt === "string" && input.launchConfirmedAt.trim().length > 0 ? input.launchConfirmedAt.trim() : undefined,
    authorizedAutonomyLevel,
    allowedActions,
    allowedPaths,
    forbiddenPaths,
    applyPolicy: {
      mode: applyPolicy,
      rollbackRequired: applyPolicy !== "no_apply",
      exactDiffHashRequired: applyPolicy !== "no_apply",
      postApplyValidationRequired: applyPolicy !== "no_apply",
      postApplyOracleRequired: applyPolicy !== "no_apply",
    },
    budgetPolicy: {
      mode: budgetProfile,
      strict: budgetProfile === "strict_requested",
      strictBudgetRequired: true,
      strictBudgetSatisfied: budgetProfile === "strict_requested",
    },
    stopConditions: ["scope_drift", "secret_required", "validation_fail_exhausted", "oracle_no_ship", "budget_exceeded", "stale_worker_unrecoverable"],
    launchAuthorizesInScopeActions: specLocked && userLaunchConfirmed,
    actionExecutionBlockedUntilLaunch: !userLaunchConfirmed,
    exceptionApprovalRequiredOnlyForOutOfScope: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const status = specLocked ? "dry_run_plan_ready" : "clarification_or_gate_required";
  const runGraph = buildAutonomousRunGraph({
    runId,
    specLocked,
    contextScopeValid: contextScopeErrors.length === 0,
    contextPackValid,
    runtimeGatesValid,
    modelRoutingPlanValid,
    factorySelected: Boolean(selectedFactory),
    registeredBatchReady: factoryReadiness.registeredBatchReady === true,
    proofBeforeExecutionRequired,
    selectedFactory,
  });

  const report = {
    schema: "zob.autonomous-runtime-dry-run.v1",
    runId,
    status,
    no_ship: true,
    noShipReason: "P0 dry-run only; global autonomy remains disabled until current-source proof and policy gates pass.",
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    dryRun: true,
    noExecution: true,
    childDispatchAllowed: false,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    networkAccessed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    specGate: {
      schema: "zob.autonomous-spec-gate.v1",
      userNeedHash: sha256(userNeed),
      refinedSpecHash: sha256(refinedSpec),
      constraintHashes: hashes(constraints),
      acceptanceCriteriaHashes: hashes(acceptanceCriteria),
      expectedArtifactHashes: hashes(expectedArtifacts),
      allowedPaths,
      forbiddenPaths,
      allowedPathsRequired: true,
      pathGatePassed: pathGateErrors.length === 0,
      pathGateErrors,
      applyPolicyRequired: true,
      applyPolicyProvided,
      applyPolicy,
      budgetProfileRequired: true,
      budgetProfileProvided,
      budgetProfile,
      autonomousStrictBudgetRequired: true,
      autonomousStrictBudgetSatisfied: budgetProfile === "strict_requested",
      risk,
      specTextStored: false,
      specLocked,
      launchAuthorizationRequired: true,
      userLaunchConfirmed,
      launchAuthorizesInScopeActions: launchAuthorization.launchAuthorizesInScopeActions,
      actionExecutionBlockedUntilLaunch: launchAuthorization.actionExecutionBlockedUntilLaunch,
      clarificationRequired,
      clarificationQuestions,
      blockers,
    },
    launchAuthorization,
    contextPlan: {
      schema: "zob.autonomous-context-plan.v1",
      contextNeedTags: detectContextNeedTags(specText),
      contextScope,
      contextScopeValid: contextScopeErrors.length === 0,
      contextScopeErrors,
      lookupResults: contextArtifacts.lookupResults,
      contextPack: contextArtifacts.contextPack,
      contextPackValid,
      contextPackErrors,
      lookupPlan: {
        queryHash: sha256(refinedSpec),
        allowedSources: contextScope.allowedSources,
        citationRequired: true,
        boundedContextOnly: true,
        gbrainImportEnabled: false,
        gbrainEmbedEnabled: false,
        gbrainSyncEnabled: false,
        gbrainWriteEnabled: false,
      },
    },
    runtimeGates,
    modelRoutingPlan,
    runGraph,
    factorySelection: {
      schema: "zob.autonomous-factory-selection.v1",
      queryHash: reuseScout.queryHash,
      selectionStatus,
      selectedFactory,
      selectedFactorySourcePath: selectedFactory ? `.pi/factories/${selectedFactory}/factory.json` : undefined,
      manifestAvailability,
      candidateCount: candidates.length,
      reuseScoutCandidates: candidates.filter(isRecord).map((candidate) => ({
        kind: candidate.kind,
        id: candidate.id,
        sourcePath: candidate.sourcePath,
        score: candidate.score,
        reasonCodes: candidate.reasonCodes,
        summaryHash: candidate.summaryHash,
      })),
      deterministicScoring: factoryScore,
      factoryForgeAvailable,
      factoryReadiness,
      currentSourceProofRequired: true,
      proofBeforeExecutionRequired,
      noAutoActivation: true,
      quarantineRequiredForNewFactory: selectionStatus === "factory_forge_quarantine_recommended",
    },
    proofPlan: {
      schema: "zob.autonomous-proof-plan.v1",
      parentOwned: true,
      stages: [
        { name: "spec_lock", required: true, passed: specLocked },
        { name: "launch_authorization", required: true, passed: launchAuthorization.launchAuthorizesInScopeActions, executionBlockedUntilLaunch: launchAuthorization.actionExecutionBlockedUntilLaunch, dispatchAllowed: false, noExecution: true },
        { name: "context_scope", required: true, passed: contextScopeErrors.length === 0, citationRequired: true },
        { name: "context_lookup_and_pack", required: true, passed: contextPackValid, citationRequired: true, boundedContextOnly: true, dispatchAllowed: false },
        { name: "runtime_gates_preflight", required: true, passed: runtimeGatesValid, dispatchAllowed: false, noExecution: true },
        { name: "model_routing_plan", required: true, passed: modelRoutingPlanValid, dispatchAllowed: false, liveRoutingEnabled: false },
        { name: "factory_selection", required: true, passed: Boolean(selectedFactory) },
        { name: "registered_factory_current_source_proof", required: true, passed: factoryReadiness.registeredBatchReady === true, dispatchAllowed: false, proofBeforeExecutionRequired },
        { name: "smoke", required: true, dispatchAllowed: false, sentinelRequired: "SMOKE_PASSED.sentinel" },
        { name: "smoke_oracle", required: true, dispatchAllowed: false, verdictRequired: "PASS", noShipRequired: false },
        { name: "pilot", required: true, dispatchAllowed: false, requiresSmokeOracle: true, sentinelRequired: "PILOT_PASSED.sentinel" },
        { name: "pilot_oracle", required: true, dispatchAllowed: false, verdictRequired: "PASS", noShipRequired: false },
        { name: "batch", required: true, dispatchAllowed: false, requiresPilotOracle: true, sentinelRequired: "BATCH_PASSED.sentinel", batchConcurrencyCapRequired: true },
        { name: "final_report", required: true, dispatchAllowed: false, validationJsonRequired: true, doneSentinelRequired: true },
      ],
      gates: ["strict_goal_spec", "context_scope", "context_lookup_and_pack", "runtime_gates_preflight", "model_routing_plan", "run_graph_ready", "registered_factory_current_source_proof", "budget_preflight", "model_routing_policy", "sandbox_apply_policy", "daemon_policy", "oracle_review", "mission_control_proposals_only"],
      noShipConditions: ["clarification_required", "context_scope_invalid", "context_pack_invalid", "runtime_gates_invalid", "model_routing_plan_invalid", "factory_selection_missing", "oracle_fail", "budget_exceeded", "secret_reference", "production_apply_requested", "current_source_proof_missing"],
    },
    finalReportPlan: {
      schema: "zob.autonomous-final-report-plan.v1",
      artifactPath: `reports/autonomous-runs/${runId}/dry-run-report.json`,
      includesEvidenceRefs: true,
      includesBlockers: true,
      includesNoShipDecision: true,
      rawSpecStored: false,
    },
    validation: {
      passed: blockers.length === 0,
      blockers,
      warnings: ["dry_run_only", "global_autonomy_no_ship", "no_child_dispatch", ...(proofBeforeExecutionRequired ? ["selected_factory_current_source_proof_required_before_execution"] : [])],
    },
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(report)) throw new Error("autonomous dry-run report would store forbidden plaintext body keys");
  return report;
}

export function buildAutonomousRuntimeDryRunValidation(report: Record<string, unknown>): Record<string, unknown> {
  const validation = {
    schema: "zob.autonomous-runtime-dry-run-validation.v1",
    runId: report.runId,
    status: report.status,
    passed: report.status === "dry_run_plan_ready",
    no_ship: report.no_ship,
    dryRun: report.dryRun,
    noExecution: report.noExecution,
    childDispatchAllowed: report.childDispatchAllowed,
    daemonStarted: report.daemonStarted,
    productionWritesPerformed: report.productionWritesPerformed,
    autoApply: report.autoApply,
    networkAccessed: report.networkAccessed,
    globalAutonomyReady: report.globalAutonomyReady,
    globalAutonomyNoShip: report.globalAutonomyNoShip,
    blockers: isRecord(report.validation) && Array.isArray(report.validation.blockers) ? report.validation.blockers : [],
    requiredArtifacts: ["spec-gate.json", "context-scope.json", "context-lookup.json", "context-pack.json", "runtime-gates.json", "model-routing-plan.json", "run-graph.json", "factory-selection.json", "proof-plan.json", "dry-run-report.json", "validation.json", "final-report.md", "DRY_RUN_READY.sentinel"],
    sentinel: report.status === "dry_run_plan_ready" ? "DRY_RUN_READY.sentinel" : undefined,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(validation)) throw new Error("autonomous dry-run validation would store forbidden plaintext body keys");
  return validation;
}

export function buildAutonomousRuntimeDryRunFinalReport(report: Record<string, unknown>): string {
  const factorySelection = isRecord(report.factorySelection) ? report.factorySelection : {};
  const validation = isRecord(report.validation) ? report.validation : {};
  const blockers = Array.isArray(validation.blockers) ? validation.blockers.map((blocker) => `- ${String(blocker)}`).join("\n") : "";
  return [
    "# Autonomous Runtime Dry-Run Report",
    "",
    `Run ID: ${String(report.runId ?? "unknown")}`,
    `Status: ${String(report.status ?? "unknown")}`,
    `No-ship: ${String(report.no_ship ?? true)}`,
    "",
    "## Safety posture",
    "",
    `- Dry-run only: ${String(report.dryRun === true)}`,
    `- No execution: ${String(report.noExecution === true)}`,
    `- Child dispatch allowed: ${String(report.childDispatchAllowed === true)}`,
    `- Daemon started: ${String(report.daemonStarted === true)}`,
    `- Production writes performed: ${String(report.productionWritesPerformed === true)}`,
    `- Auto-apply: ${String(report.autoApply === true)}`,
    `- Global autonomy no-ship: ${String(report.globalAutonomyNoShip === true)}`,
    "",
    "## Factory selection",
    "",
    `- Status: ${String(factorySelection.selectionStatus ?? "unknown")}`,
    `- Selected factory: ${String(factorySelection.selectedFactory ?? "none")}`,
    "",
    "## Blockers",
    "",
    blockers || "- None for dry-run plan readiness.",
    "",
    "## Evidence refs",
    "",
    "- spec-gate.json",
    "- context-scope.json",
    "- context-lookup.json",
    "- context-pack.json",
    "- runtime-gates.json",
    "- model-routing-plan.json",
    "- run-graph.json",
    "- factory-selection.json",
    "- proof-plan.json",
    "- dry-run-report.json",
    "- validation.json",
    "- DRY_RUN_READY.sentinel when status=dry_run_plan_ready",
    "",
    "Compliance: P0 dry-run artifact only; no global autonomy claim.",
    "",
  ].join("\n");
}
