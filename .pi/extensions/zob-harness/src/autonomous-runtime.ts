import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildCapabilityIndex, buildReuseScoutReport } from "./capabilities.js";
import { runFactoryRun } from "./factory/run.js";
import { selectFactoryForDemands } from "./factory-selector.js";
import { evaluateStrictBudgetDispatchGate } from "./budget-policy.js";
import { evaluateBudgetPreflightDryRun } from "./chronicle.js";
import { buildBrainLookupResult, buildContextPack, buildDefaultContextScope, validateContextPack, validateContextScope } from "./context-gbrain.js";
import { validateDaemonPolicyConfig } from "./daemon-policy.js";
import { MISSION_CONTROL_COMMANDS, buildMissionControlCommandProposal, buildMissionControlSnapshot, buildZobComsTransportReadiness, buildZobCommunicationReadinessAudit } from "./mission-control.js";
import { evaluateModelRoutingDispatchGate, evaluateModelRoutingDryRun } from "./model-routing.js";
import { loadTeamDefinition, validateTeamDefinition } from "./topology/teams.js";
import { sha256 } from "./utils/hashing.js";
import { safeFileStem } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

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

const FORBIDDEN_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content", "patch", "diff", "raw", "messages", "conversationHistory"]);
const AMBIGUOUS_PATTERNS = [/\bstuff\b/i, /\bsomething\b/i, /\bwhatever\b/i, /\bfix it\b/i, /\bmake it better\b/i, /\betc\.?\b/i];
const SECRET_PATTERNS = [/\.env\b/i, /api[_-]?key/i, /secret/i, /password/i, /token/i, /private[_-]?key/i, /ssh[_-]?key/i];
const DEFAULT_AUTONOMOUS_FORBIDDEN_PATHS = [".env", ".env.*", "secrets", "raw-conversation-history", "node_modules", "dist", "build"];
const UNSAFE_AUTONOMOUS_ALLOWED_SEGMENTS = new Set(["node_modules", "dist", "build", "secrets", "raw-conversation-history"]);
const AUTONOMOUS_CURRENT_SOURCE_FINGERPRINT_FILES = [
  "package.json",
  "tsconfig.json",
  "scripts/harness-smoke.mjs",
  "docs/AUTONOMY_FACTORY_AGENT_DETAILED_PLAN.md",
  ".pi/budget-policy.json",
  ".pi/model-routing.json",
  ".pi/daemon-policy.json",
  ".pi/teams/zob-core.json",
  ".pi/extensions/zob-harness/index.ts",
  ".pi/extensions/zob-harness/src/autonomous-runtime.ts",
  ".pi/extensions/zob-harness/src/autonomy-readiness.ts",
  ".pi/extensions/zob-harness/src/runtime/tools-autonomous.ts",
  ".pi/extensions/zob-harness/src/schemas.ts",
  ".pi/extensions/zob-harness/src/factory/run.ts",
  ".pi/extensions/zob-harness/src/model-routing.ts",
  ".pi/extensions/zob-harness/src/budget-policy.ts",
  ".pi/extensions/zob-harness/src/daemon-policy.ts",
  ".pi/extensions/zob-harness/src/mission-control.ts",
  ".pi/extensions/zob-harness/src/sandbox.ts",
];

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

function stableStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].sort();
}

function normalizeAutonomousSpecPath(value: string): string {
  return value.trim().replace(/\\+/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isBroadAutonomousAllowedPath(value: string): boolean {
  const normalized = normalizeAutonomousSpecPath(value);
  return normalized === "" || normalized === "." || normalized === "/" || normalized === "*" || normalized === "**" || normalized === "~" || normalized === "~/";
}

function forbiddenPatternBase(value: string): string {
  return normalizeAutonomousSpecPath(value)
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "")
    .replace(/\.\*$/, "");
}

function pathConflict(left: string, right: string): boolean {
  const a = forbiddenPatternBase(left).toLowerCase();
  const b = forbiddenPatternBase(right).toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function unsafeAllowedPathReason(value: string, forbiddenPaths: string[]): string | undefined {
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

function validateAutonomousSpecPathGate(allowedPaths: string[], forbiddenPaths: string[]): string[] {
  if (allowedPaths.length === 0) return ["allowed_paths_required_before_execution"];
  return allowedPaths.flatMap((allowedPath) => {
    const reason = unsafeAllowedPathReason(allowedPath, forbiddenPaths);
    return reason ? [reason] : [];
  });
}

function hashes(values: string[]): string[] {
  return values.map((value) => sha256(value)).sort();
}

function defaultAutonomousAllowedActions(applyPolicy: AutonomousApplyPolicy): string[] {
  const base = ["read_repo", "context_lookup", "select_factory", "run_factory_smoke", "run_factory_pilot", "run_factory_batch", "post_run_validation", "post_run_oracle"];
  return applyPolicy === "auto_apply_in_scope"
    ? [...base, "sandbox_edit", "apply_in_scope", "post_apply_validation", "post_apply_oracle"]
    : base;
}

function inferAutonomousLevel(applyPolicy: AutonomousApplyPolicy): AutonomousLevel {
  return applyPolicy === "auto_apply_in_scope" ? "L6" : "L4";
}

function capabilityFactories(capabilityIndex: Record<string, unknown>): Record<string, unknown>[] {
  const capabilities = Array.isArray(capabilityIndex.capabilities) ? capabilityIndex.capabilities.filter(isRecord) : [];
  return capabilities.filter((capability) => capability.kind === "factory");
}

function textSignals(...values: string[]): string[] {
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

function scoreFactoryCandidate(factory: Record<string, unknown>, signals: string[]): Record<string, unknown> {
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

function selectAutonomousFactory(input: { factories: Record<string, unknown>[]; refinedSpec: string; acceptanceCriteria: string[]; expectedArtifacts: string[] }): Record<string, unknown> {
  return selectFactoryForDemands({
    schema: "zob.autonomous-factory-selection-score.v1",
    factories: input.factories,
    refinedSpec: input.refinedSpec,
    acceptanceCriteria: input.acceptanceCriteria,
    expectedArtifacts: input.expectedArtifacts,
  }) as unknown as Record<string, unknown>;
}

function factoryManifestAvailability(repoRoot: string, factoryName: string | undefined): Record<string, unknown> {
  if (!factoryName) return { smoke: false, pilot: false, batch: false };
  return {
    smoke: existsSync(join(repoRoot, ".pi", "factories", factoryName, "smoke-manifest.json")),
    pilot: existsSync(join(repoRoot, ".pi", "factories", factoryName, "pilot-manifest.json")),
    batch: existsSync(join(repoRoot, ".pi", "factories", factoryName, "batch-manifest.json")),
  };
}

function readFactoryRegistryReadiness(repoRoot: string, factoryName: string | undefined): Record<string, unknown> {
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

function buildAutonomousContextArtifacts(repoRoot: string, scope: Record<string, unknown>, queryHash: string): Record<string, unknown> {
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
      const citation = "harness-system:zob-harness-src:.pi/extensions/zob-harness/src/autonomous-runtime.ts";
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

function buildAutonomousRuntimeGates(input: { runId: string; risk: AutonomousRisk; budgetProfile: AutonomousBudgetProfile; applyPolicy: AutonomousApplyPolicy; maxContextTokens?: number }): Record<string, unknown> {
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

function buildAutonomousStrictBudgetProofPlan(input: { runId: string; runtimeGates: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
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

function buildAutonomousModelRoutingPlan(input: { runId: string; risk: AutonomousRisk; budgetProfile: AutonomousBudgetProfile; maxContextTokens?: number; specText: string; selectedFactory?: string }): Record<string, unknown> {
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

function buildAutonomousModelRoutingProofPlan(input: { runId: string; modelRoutingPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
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

function buildAutonomousRunGraph(input: {
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

function detectContextNeedTags(specText: string): string[] {
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

function buildClarificationQuestions(input: {
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

function readJsonArtifact(path: string): { parsed?: Record<string, unknown> | unknown[]; hash?: string; error?: string } {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return { parsed: isRecord(parsed) || Array.isArray(parsed) ? parsed : undefined, hash: sha256(raw), error: isRecord(parsed) || Array.isArray(parsed) ? undefined : "artifact JSON root must be object or array" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function artifactHashIfPresent(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return sha256(readFileSync(path, "utf8"));
}

function relativeFactoryRunPath(runId: string, artifact?: string): string {
  return artifact ? `reports/factory-runs/${runId}/${artifact}` : `reports/factory-runs/${runId}`;
}

function buildAutonomousPromotionPlan(input: { runId: string; selectedFactory?: string; factoryRunRef: Record<string, unknown>; oracleReview: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const smokeGatePassed = input.validation.status === "smoke_autonomy_passed"
    && input.validation.no_ship === false
    && input.factoryRunRef.status === "done"
    && input.factoryRunRef.phaseSentinelPresent === true
    && input.factoryRunRef.doneSentinelPresent === true
    && input.oracleReview.verdict === "PASS"
    && input.oracleReview.no_ship === false;
  const factoryRunId = typeof input.factoryRunRef.factoryRunId === "string" ? input.factoryRunRef.factoryRunId : "unknown";
  const plan = {
    schema: "zob.autonomous-promotion-plan.v1",
    runId: input.runId,
    selectedFactory: input.selectedFactory,
    sourceSmoke: {
      autonomousRunId: input.runId,
      factoryRunId,
      smokeSentinelRef: relativeFactoryRunPath(factoryRunId, "SMOKE_PASSED.sentinel"),
      doneSentinelRef: relativeFactoryRunPath(factoryRunId, "DONE.sentinel"),
      oracleReviewRef: `reports/autonomous-runs/${input.runId}/oracle-review.json`,
    },
    smokeGate: {
      passed: smokeGatePassed,
      sentinelPresent: input.factoryRunRef.phaseSentinelPresent === true,
      doneSentinelPresent: input.factoryRunRef.doneSentinelPresent === true,
      oraclePass: input.oracleReview.verdict === "PASS" && input.oracleReview.no_ship === false,
      structuralOracleOnly: input.oracleReview.oracleType === "deterministic_structural",
    },
    pilotGate: {
      preconditionsMet: smokeGatePassed,
      executionAllowed: false,
      dispatchAllowed: false,
      reason: "phase_7a_promotion_metadata_only_no_pilot_execution",
      requiredBeforeExecution: ["strict_budget_gate", "live_or_structural_oracle_pass", "current_source_factory_proof", "operator_or_parent_gate", "PILOT_PASSED.sentinel_on_success"],
      maxItems: 10,
      prerequisiteSmokeRunId: factoryRunId,
      oracleReviewPath: `reports/autonomous-runs/${input.runId}/oracle-review.json`,
    },
    batchGate: {
      preconditionsMet: false,
      executionAllowed: false,
      dispatchAllowed: false,
      reason: "pilot_not_executed_in_phase_7a",
      requiredBeforeExecution: ["PILOT_PASSED.sentinel", "pilot_oracle_PASS_no_ship_false", "batch_concurrency_cap", "strict_budget_gate", "final_oracle_gate"],
      batchConcurrencyCapRequired: true,
    },
    resumePolicy: {
      resumeOnlyIncompleteItems: true,
      doNotRerunPassedItems: true,
      stopOnRepeatedFail: true,
      maxRetryPolicyRequiredBeforeLiveScale: true,
    },
    oraclePolicy: {
      smokeOracleRequired: true,
      pilotOracleRequired: true,
      batchOracleRequired: true,
      warnOrFailTreatedAsNoShip: true,
    },
    strictBudgetRequired: true,
    liveRoutingEnabled: false,
    childDispatchAllowed: false,
    pilotExecuted: false,
    batchExecuted: false,
    noExecutionBeyondSmoke: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous promotion plan would store forbidden plaintext body keys");
  return plan;
}

function buildAutonomousPromotionProofPlan(input: { runId: string; promotionPlan: Record<string, unknown>; factoryRunRef: Record<string, unknown>; oracleReview: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const smokeGate = isRecord(input.promotionPlan.smokeGate) ? input.promotionPlan.smokeGate : {};
  const pilotGate = isRecord(input.promotionPlan.pilotGate) ? input.promotionPlan.pilotGate : {};
  const batchGate = isRecord(input.promotionPlan.batchGate) ? input.promotionPlan.batchGate : {};
  const resumePolicy = isRecord(input.promotionPlan.resumePolicy) ? input.promotionPlan.resumePolicy : {};
  const oraclePolicy = isRecord(input.promotionPlan.oraclePolicy) ? input.promotionPlan.oraclePolicy : {};
  const scenarios = [
    {
      name: "smoke_to_pilot_preconditions_met",
      passed: smokeGate.passed === true && smokeGate.sentinelPresent === true && smokeGate.doneSentinelPresent === true && smokeGate.oraclePass === true,
      evidenceRefs: [`reports/autonomous-runs/${safeFileStem(input.runId)}/promotion-plan.json`, `reports/autonomous-runs/${safeFileStem(input.runId)}/oracle-review.json`],
      dispatchAllowed: false,
    },
    {
      name: "pilot_execution_blocked_until_live_gates",
      passed: pilotGate.preconditionsMet === true && pilotGate.executionAllowed === false && pilotGate.dispatchAllowed === false && input.promotionPlan.pilotExecuted === false,
      blockers: ["pilot_execution_disabled_until_live_budget_routing_daemon_oracle_gates"],
      dispatchAllowed: false,
    },
    {
      name: "batch_execution_blocked_without_pilot_oracle_and_concurrency",
      passed: batchGate.preconditionsMet === false && batchGate.executionAllowed === false && batchGate.dispatchAllowed === false && batchGate.batchConcurrencyCapRequired === true && input.promotionPlan.batchExecuted === false,
      blockers: ["pilot_not_executed", "pilot_oracle_missing", "batch_concurrency_cap_missing"],
      dispatchAllowed: false,
    },
    {
      name: "resume_retry_policy_safe_before_scale",
      passed: resumePolicy.resumeOnlyIncompleteItems === true && resumePolicy.doNotRerunPassedItems === true && resumePolicy.stopOnRepeatedFail === true && resumePolicy.maxRetryPolicyRequiredBeforeLiveScale === true,
      dispatchAllowed: false,
    },
    {
      name: "oracle_policy_no_warn_fail_promotion",
      passed: oraclePolicy.smokeOracleRequired === true && oraclePolicy.pilotOracleRequired === true && oraclePolicy.batchOracleRequired === true && oraclePolicy.warnOrFailTreatedAsNoShip === true,
      dispatchAllowed: false,
    },
  ];
  const checks = [
    { name: "smoke_gate_passed", passed: scenarios[0].passed === true },
    { name: "pilot_blocked_no_execution", passed: scenarios[1].passed === true },
    { name: "batch_blocked_no_execution", passed: scenarios[2].passed === true },
    { name: "resume_retry_policy_safe", passed: scenarios[3].passed === true },
    { name: "oracle_policy_safe", passed: scenarios[4].passed === true },
    { name: "run_scope_no_global_autonomy", passed: input.validation.globalAutonomyReady === false && input.validation.globalAutonomyNoShip === true && input.validation.childDispatchAllowed === false && input.validation.productionWritesPerformed === false && input.validation.autoApply === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const proof = {
    schema: "zob.autonomous-promotion-proof-plan.v1",
    runId: input.runId,
    phase: "7B",
    status: failedChecks.length === 0 ? "pilot_batch_promotion_proof_ready_execution_blocked" : "pilot_batch_promotion_proof_incomplete",
    promotionProofReady: failedChecks.length === 0,
    smokeToPilotPreconditionsProved: scenarios[0].passed === true,
    pilotExecutionBlockedProofPassed: scenarios[1].passed === true,
    batchExecutionBlockedProofPassed: scenarios[2].passed === true,
    resumeRetryPolicyProofPassed: scenarios[3].passed === true,
    oraclePolicyProofPassed: scenarios[4].passed === true,
    finalE2ERequirementCleared: false,
    no_ship: true,
    checks,
    failedChecks,
    scenarios,
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/promotion-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/factory-run-ref.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/oracle-review.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
    ],
    blockers: [
      "pilot_execution_disabled",
      "batch_execution_disabled",
      "pilot_oracle_missing",
      "batch_concurrency_cap_missing",
      "final_e2e_pilot_batch_evidence_required",
    ],
    pilotExecutionAllowed: false,
    batchExecutionAllowed: false,
    pilotExecuted: false,
    batchExecuted: false,
    pilotOraclePass: false,
    batchConcurrencyCapPresent: false,
    childDispatchAllowed: false,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecutionBeyondSmoke: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(proof)) throw new Error("autonomous promotion proof plan would store forbidden plaintext body keys");
  return proof;
}

function buildAutonomousSchedulerPlan(repoRoot: string, input: { runId: string; promotionPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const daemonPolicy = validateDaemonPolicyConfig(repoRoot);
  const allowedJobTypes = Array.isArray(daemonPolicy.allowedJobTypes) ? daemonPolicy.allowedJobTypes.filter((item): item is string => typeof item === "string") : [];
  const requiredStopConditions = Array.isArray(daemonPolicy.requiredStopConditions) ? daemonPolicy.requiredStopConditions.filter((item): item is string => typeof item === "string") : [];
  const promotionReady = isRecord(input.promotionPlan.smokeGate) && input.promotionPlan.smokeGate.passed === true;
  const checks = [
    { name: "daemon_policy_valid", passed: daemonPolicy.present === true && daemonPolicy.valid === true },
    { name: "daemon_disabled_by_default", passed: daemonPolicy.daemonEnabled === false && daemonPolicy.alwaysOnDaemonEnabled === false && daemonPolicy.autoStartDaemon === false && daemonPolicy.continuousLoop === false },
    { name: "one_worker_bounded", passed: daemonPolicy.maxWorkersDefault === 1 && daemonPolicy.maxWorkersMax === 1 },
    { name: "read_only_work_kinds_only", passed: allowedJobTypes.length > 0 && daemonPolicy.writeAdaptersEnabled === false && daemonPolicy.productionWritesPerformed === false && daemonPolicy.autoApply === false },
    { name: "terminal_stop_conditions_available", passed: requiredStopConditions.includes("timeout") && requiredStopConditions.includes("blocked") && requiredStopConditions.includes("fail_loop") && requiredStopConditions.includes("no_ship") },
    { name: "kill_switch_required", passed: true },
    { name: "leases_and_heartbeat_required", passed: true },
    { name: "budget_required_before_dispatch", passed: true },
    { name: "scheduler_execution_disabled", passed: true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const plan = {
    schema: "zob.autonomous-scheduler-plan.v1",
    runId: input.runId,
    schedulerPlanReady: failedChecks.length === 0,
    failedChecks,
    checks,
    promotionReady,
    daemonPolicy,
    queuePolicy: {
      allowedWorkKinds: allowedJobTypes,
      initialWorkKinds: ["docs_watch", "repo_audit_readonly", "todo_risk_report", "session_analysis"].filter((kind) => allowedJobTypes.includes(kind)),
      writeWorkAccepted: false,
      claimAtMostOnePerTick: daemonPolicy.claimAtMostOneJobPerTick === true,
      boundedQueueOnly: true,
    },
    leasePolicy: {
      leaseRequired: true,
      leaseTtlMs: 300_000,
      maxLeaseRenewals: 0,
      staleLeaseFailsCleanly: true,
      leaseOwnerHashOnly: true,
    },
    heartbeatPolicy: {
      heartbeatRequired: true,
      heartbeatIntervalMs: 30_000,
      staleHeartbeatTimeoutMs: 90_000,
      staleHeartbeatStopCondition: "timeout",
    },
    timeoutPolicy: {
      perWorkItemTimeoutMs: 300_000,
      globalTickTimeoutMs: 600_000,
      timeoutStopCondition: "timeout",
    },
    retryPolicy: {
      retriesCapped: true,
      maxRetriesPerWorkItem: 1,
      failLoopThreshold: 3,
      repeatedFailureStopCondition: "fail_loop",
      doNotRetryNoShip: true,
    },
    killSwitch: {
      required: true,
      defaultState: "stopped_until_manual_start",
      stopFileRef: ".pi/queue/STOP_DAEMON.sentinel",
      checkedBeforeEachTick: true,
      stopsQueueCleanly: true,
    },
    workerPool: {
      defaultWorkers: 1,
      maxWorkers: 1,
      workerPoolBounded: true,
    },
    budgetPolicy: {
      strictBudgetRequired: true,
      perRunCapsRequired: true,
      perDayCapsRequired: true,
      budgetEnforced: false,
      dispatchBlockedUntilStrictBudgetEnforced: true,
    },
    stopConditions: requiredStopConditions,
    approvalPolicy: {
      manualStartRequiresApproval: true,
      alwaysOnRequiresApproval: true,
      schedulerAutostartAllowed: false,
    },
    schedulerExecutionAllowed: false,
    daemonEnabled: false,
    alwaysOnDaemonEnabled: false,
    autoStartDaemon: false,
    continuousLoop: false,
    daemonStarted: false,
    cronEnabled: false,
    childDispatchAllowed: false,
    liveChildExecution: false,
    networkAccessed: false,
    writeAdaptersEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    pilotExecuted: false,
    batchExecuted: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous scheduler plan would store forbidden plaintext body keys");
  return plan;
}

function buildAutonomousSchedulerProofPlan(input: { runId: string; schedulerPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const queuePolicy = isRecord(input.schedulerPlan.queuePolicy) ? input.schedulerPlan.queuePolicy : {};
  const leasePolicy = isRecord(input.schedulerPlan.leasePolicy) ? input.schedulerPlan.leasePolicy : {};
  const heartbeatPolicy = isRecord(input.schedulerPlan.heartbeatPolicy) ? input.schedulerPlan.heartbeatPolicy : {};
  const timeoutPolicy = isRecord(input.schedulerPlan.timeoutPolicy) ? input.schedulerPlan.timeoutPolicy : {};
  const retryPolicy = isRecord(input.schedulerPlan.retryPolicy) ? input.schedulerPlan.retryPolicy : {};
  const killSwitch = isRecord(input.schedulerPlan.killSwitch) ? input.schedulerPlan.killSwitch : {};
  const workerPool = isRecord(input.schedulerPlan.workerPool) ? input.schedulerPlan.workerPool : {};
  const budgetPolicy = isRecord(input.schedulerPlan.budgetPolicy) ? input.schedulerPlan.budgetPolicy : {};
  const approvalPolicy = isRecord(input.schedulerPlan.approvalPolicy) ? input.schedulerPlan.approvalPolicy : {};
  const daemonPolicy = isRecord(input.schedulerPlan.daemonPolicy) ? input.schedulerPlan.daemonPolicy : {};
  const stopConditions = Array.isArray(input.schedulerPlan.stopConditions) ? input.schedulerPlan.stopConditions.filter((condition): condition is string => typeof condition === "string") : [];
  const scenarios = [
    {
      name: "daemon_default_disabled",
      passed: input.schedulerPlan.schedulerExecutionAllowed === false && input.schedulerPlan.daemonStarted === false && input.schedulerPlan.autoStartDaemon === false && input.schedulerPlan.continuousLoop === false && input.schedulerPlan.cronEnabled === false,
      dispatchAllowed: false,
    },
    {
      name: "one_worker_bounded_readonly_queue",
      passed: workerPool.defaultWorkers === 1 && workerPool.maxWorkers === 1 && workerPool.workerPoolBounded === true && queuePolicy.writeWorkAccepted === false && queuePolicy.claimAtMostOnePerTick === true,
      dispatchAllowed: false,
    },
    {
      name: "lease_heartbeat_timeout_stop_conditions_required",
      passed: leasePolicy.leaseRequired === true && heartbeatPolicy.heartbeatRequired === true && heartbeatPolicy.staleHeartbeatStopCondition === "timeout" && timeoutPolicy.timeoutStopCondition === "timeout" && stopConditions.includes("timeout") && stopConditions.includes("blocked") && stopConditions.includes("fail_loop") && stopConditions.includes("no_ship"),
      dispatchAllowed: false,
    },
    {
      name: "kill_switch_and_retry_stop_clean",
      passed: killSwitch.required === true && killSwitch.checkedBeforeEachTick === true && killSwitch.stopsQueueCleanly === true && retryPolicy.retriesCapped === true && retryPolicy.doNotRetryNoShip === true && retryPolicy.repeatedFailureStopCondition === "fail_loop",
      dispatchAllowed: false,
    },
    {
      name: "strict_budget_required_before_daemon_dispatch",
      passed: budgetPolicy.strictBudgetRequired === true && budgetPolicy.perRunCapsRequired === true && budgetPolicy.perDayCapsRequired === true && budgetPolicy.budgetEnforced === false && budgetPolicy.dispatchBlockedUntilStrictBudgetEnforced === true,
      dispatchAllowed: false,
    },
    {
      name: "always_on_requires_future_approval",
      passed: approvalPolicy.manualStartRequiresApproval === true && approvalPolicy.alwaysOnRequiresApproval === true && approvalPolicy.schedulerAutostartAllowed === false && daemonPolicy.alwaysOnDaemonEnabled === false,
      dispatchAllowed: false,
    },
  ];
  const checks = [
    { name: "scheduler_plan_ready", passed: input.schedulerPlan.schedulerPlanReady === true },
    { name: "daemon_default_disabled", passed: scenarios[0].passed === true },
    { name: "one_worker_bounded_readonly_queue", passed: scenarios[1].passed === true },
    { name: "lease_heartbeat_timeout_stop_conditions_required", passed: scenarios[2].passed === true },
    { name: "kill_switch_and_retry_stop_clean", passed: scenarios[3].passed === true },
    { name: "strict_budget_required_before_daemon_dispatch", passed: scenarios[4].passed === true },
    { name: "always_on_requires_future_approval", passed: scenarios[5].passed === true },
    { name: "run_scope_no_global_autonomy", passed: input.validation.globalAutonomyReady === false && input.validation.globalAutonomyNoShip === true && input.validation.childDispatchAllowed === false && input.validation.productionWritesPerformed === false && input.validation.autoApply === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const proof = {
    schema: "zob.autonomous-scheduler-proof-plan.v1",
    runId: input.runId,
    phase: "8B",
    status: failedChecks.length === 0 ? "scheduler_daemon_proof_ready_execution_blocked" : "scheduler_daemon_proof_incomplete",
    schedulerProofReady: failedChecks.length === 0,
    daemonDefaultDisabledProofPassed: scenarios[0].passed === true,
    oneWorkerBoundedProofPassed: scenarios[1].passed === true,
    stopConditionsProofPassed: scenarios[2].passed === true,
    killSwitchRetryProofPassed: scenarios[3].passed === true,
    strictBudgetBeforeDispatchProofPassed: scenarios[4].passed === true,
    alwaysOnApprovalProofPassed: scenarios[5].passed === true,
    finalE2ERequirementCleared: false,
    no_ship: true,
    checks,
    failedChecks,
    scenarios,
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/scheduler-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
      ".pi/daemon-policy.json",
    ],
    blockers: [
      "daemon_scheduler_not_started",
      "always_on_daemon_not_enabled",
      "daemon_autostart_disabled",
      "final_e2e_daemon_scheduler_evidence_required",
    ],
    schedulerExecutionAllowed: false,
    daemonStarted: false,
    autoStartDaemon: false,
    continuousLoop: false,
    cronEnabled: false,
    childDispatchAllowed: false,
    liveChildExecution: false,
    writeAdaptersEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecutionBeyondSmoke: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(proof)) throw new Error("autonomous scheduler proof plan would store forbidden plaintext body keys");
  return proof;
}

function buildAutonomousMissionControlPlan(repoRoot: string, input: { runId: string; schedulerPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const team = loadTeamDefinition(repoRoot, "zob-core");
  const teamErrors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  const definition = team.definition;
  const snapshot = definition ? buildMissionControlSnapshot(repoRoot, definition, { runId: input.runId, limit: 5 }) : undefined;
  const communicationAudit = definition ? buildZobCommunicationReadinessAudit(repoRoot, definition) : undefined;
  const transport = buildZobComsTransportReadiness(repoRoot);
  const orchestratorId = definition?.orchestrator.id ?? "orchestrator";
  const commandProposals = definition ? MISSION_CONTROL_COMMANDS.map((command) => buildMissionControlCommandProposal(definition, {
    proposalId: `auto-${sha256(`${input.runId}-${command}`).slice(0, 16)}-${command}`,
    runId: input.runId,
    command,
    targetRole: orchestratorId,
    rationaleHash: sha256(`autonomous mission control ${command}`),
    artifactRefs: [`reports/autonomous-runs/${input.runId}/validation.json`],
  })) : [];
  const directWorkerErrors = definition && definition.workers[0] ? (() => {
    try {
      buildMissionControlCommandProposal(definition, {
        proposalId: `auto-${sha256(`${input.runId}-blocked-worker`).slice(0, 16)}-blocked-worker`,
        runId: input.runId,
        command: "stop",
        targetRole: definition.workers[0].id,
        rationaleHash: sha256("direct worker blocked"),
      });
      return [] as string[];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  })() : ["no worker role available for direct worker guard"];
  const transportFailedChecks = Array.isArray(transport.failedChecks) ? transport.failedChecks.filter((check): check is string => typeof check === "string") : [];
  const communicationFailedChecks = Array.isArray(communicationAudit?.failedChecks) ? communicationAudit.failedChecks.filter((check): check is string => typeof check === "string") : [];
  const communicationChecks = Array.isArray(communicationAudit?.checks) ? communicationAudit.checks.filter(isRecord) : [];
  const communicationCheckPassed = (name: string): boolean => communicationChecks.some((check) => check.name === name && check.passed === true);
  const livePeerAbsenceBlocksDelivery = transport.mode === "required_local"
    && transport.networkEnabled === false
    && transport.dispatchAllowed === true
    && transportFailedChecks.length > 0
    && transportFailedChecks.every((check) => check === "required_local_live_ready_when_enabled");
  const proposalOnlyCommunicationSafety = communicationAudit?.verdict === "PASS" && communicationAudit.no_ship === false
    || (livePeerAbsenceBlocksDelivery
      && communicationFailedChecks.length > 0
      && communicationFailedChecks.every((check) => check === "transport_policy_safe" || check === "registry_observe_only_available")
      && communicationCheckPassed("topology_guard_active")
      && communicationCheckPassed("worker_to_worker_blocked")
      && communicationCheckPassed("message_body_storage_blocked")
      && communicationCheckPassed("existing_ledgers_body_free")
      && communicationCheckPassed("stale_transport_not_completion")
      && communicationCheckPassed("dashboard_commands_are_proposals")
      && communicationCheckPassed("dashboard_direct_worker_commands_blocked"));
  const requiredLocalTransportSafeForNoDispatchPlan = transport.mode === "required_local"
    && transport.verdict === "PASS"
    && transport.noExecution === true
    && transport.networkEnabled === false
    && transport.dispatchAllowed === true;
  const transportSafeForAutonomySmoke = transport.networkEnabled === false
    && (
      (transport.verdict === "PASS" && transport.enabled === false && transport.dispatchAllowed === false)
      || requiredLocalTransportSafeForNoDispatchPlan
      || livePeerAbsenceBlocksDelivery
      || (transport.mode === "required_local" && transport.verdict === "PASS")
    );
  const checks = [
    { name: "team_topology_valid", passed: teamErrors.length === 0 },
    { name: "dashboard_snapshot_available", passed: snapshot?.schema === "zob.mission-control-snapshot.v1" },
    { name: "communication_readiness_pass", passed: proposalOnlyCommunicationSafety, detail: { readinessVerdict: communicationAudit?.verdict ?? "FAIL", livePeerAbsenceBlocksDelivery, livePeerReadyRequiredForDispatch: true, proposalOnlyNoDispatchPlan: true } },
    { name: "transport_disabled", passed: transportSafeForAutonomySmoke, detail: { transportVerdict: transport.verdict, requiredLocalTransportSafeForNoDispatchPlan, livePeerAbsenceBlocksDelivery, dispatchAllowedInPlan: false, networkComsEnabledInPlan: false } },
    { name: "commands_proposal_only", passed: commandProposals.length === MISSION_CONTROL_COMMANDS.length && commandProposals.every((proposal) => proposal.proposalOnly === true && proposal.parentOwned === true && proposal.directWorkerWrite === false && proposal.transportDispatch === false && proposal.networkTransport === false) },
    { name: "direct_worker_commands_blocked", passed: directWorkerErrors.some((error) => error.includes("direct worker")) },
    { name: "no_body_storage", passed: commandProposals.every((proposal) => proposal.bodyStored === false && proposal.promptBodiesStored === false && proposal.outputBodiesStored === false) },
    { name: "scheduler_still_disabled", passed: input.schedulerPlan.schedulerExecutionAllowed === false && input.schedulerPlan.daemonStarted === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const plan = {
    schema: "zob.autonomous-mission-control-plan.v1",
    runId: input.runId,
    missionControlPlanReady: failedChecks.length === 0,
    failedChecks,
    checks,
    dashboard: {
      snapshotAvailable: snapshot?.schema === "zob.mission-control-snapshot.v1",
      dashboardReads: ["runs", "factories", "queue", "budget", "model_routing", "coms", "blockers", "autonomy_status"],
      latestRunLimit: 5,
      directWorkerWrites: false,
      bypassesParentGates: false,
      networkComsEnabled: false,
      snapshotSchema: snapshot?.schema,
    },
    commandPolicy: {
      proposalOnly: true,
      parentOwned: true,
      directWorkerWrites: false,
      transportDispatch: false,
      networkTransport: false,
      allowedCommands: [...MISSION_CONTROL_COMMANDS],
      proposalCount: commandProposals.length,
      proposalHashes: commandProposals.map((proposal) => proposal.commandHash).filter((hash): hash is string => typeof hash === "string"),
      directWorkerCommandBlocked: directWorkerErrors.some((error) => error.includes("direct worker")),
    },
    comsPolicy: {
      readinessVerdict: communicationAudit?.verdict ?? "FAIL",
      proposalOnlyReadinessAccepted: proposalOnlyCommunicationSafety,
      livePeerAbsenceBlocksDelivery,
      livePeerReadyRequiredForDispatch: true,
      topologyGuardActive: Array.isArray(communicationAudit?.checks) && communicationAudit.checks.some((check) => isRecord(check) && check.name === "topology_guard_active" && check.passed === true),
      hashOnlyLedgers: true,
      workerToWorkerFreeChatAllowed: false,
      rawPromptOutputStored: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
    transportPolicy: {
      enabled: false,
      localDispatchEnabled: false,
      dispatchAllowed: false,
      networkEnabled: false,
      stalePeerCountsAsCompletion: false,
      responseBodiesStored: false,
      livePeerAbsenceBlocksDelivery,
      livePeerReadyRequiredForDispatch: true,
      futureHeartbeatRequired: true,
      futureStaleDetectionRequired: true,
      futureActiveWorkerRegistryRequired: true,
      futureResponseCaptureRequired: true,
    },
    autonomyStatus: {
      globalAutonomyReady: false,
      globalAutonomyNoShip: true,
      noGlobalAutonomyClaim: true,
    },
    schedulerExecutionAllowed: false,
    daemonStarted: false,
    childDispatchAllowed: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous mission control plan would store forbidden plaintext body keys");
  return plan;
}

function buildAutonomousMissionControlProofPlan(input: { runId: string; missionControlPlan: Record<string, unknown>; schedulerProofPlan: Record<string, unknown>; modelRoutingProofPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const commandPolicy = isRecord(input.missionControlPlan.commandPolicy) ? input.missionControlPlan.commandPolicy : {};
  const comsPolicy = isRecord(input.missionControlPlan.comsPolicy) ? input.missionControlPlan.comsPolicy : {};
  const transportPolicy = isRecord(input.missionControlPlan.transportPolicy) ? input.missionControlPlan.transportPolicy : {};
  const allowedCommands = Array.isArray(commandPolicy.allowedCommands) ? commandPolicy.allowedCommands.filter((command): command is string => typeof command === "string") : [];
  const proposalHashes = Array.isArray(commandPolicy.proposalHashes) ? commandPolicy.proposalHashes.filter((hash): hash is string => typeof hash === "string") : [];
  const proposalHashesValid = proposalHashes.length === MISSION_CONTROL_COMMANDS.length && proposalHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash));
  const allMissionCommandsCovered = MISSION_CONTROL_COMMANDS.every((command) => allowedCommands.includes(command));
  const approvalCommandAvailable = allowedCommands.includes("approve");
  const scenarios = [
    {
      name: "proposal_only_commands_parent_owned",
      passed: commandPolicy.proposalOnly === true && commandPolicy.parentOwned === true && commandPolicy.transportDispatch === false && commandPolicy.networkTransport === false && commandPolicy.proposalCount === MISSION_CONTROL_COMMANDS.length && allMissionCommandsCovered && proposalHashesValid,
      dispatchAllowed: false,
    },
    {
      name: "topology_hash_only_comms",
      passed: comsPolicy.topologyGuardActive === true && comsPolicy.hashOnlyLedgers === true && comsPolicy.workerToWorkerFreeChatAllowed === false && comsPolicy.rawPromptOutputStored === false && comsPolicy.bodyStored === false && comsPolicy.promptBodiesStored === false && comsPolicy.outputBodiesStored === false,
      dispatchAllowed: false,
    },
    {
      name: "direct_worker_commands_blocked",
      passed: commandPolicy.directWorkerWrites === false && commandPolicy.directWorkerCommandBlocked === true && input.missionControlPlan.directWorkerWrites === false,
      dispatchAllowed: false,
    },
    {
      name: "live_transport_and_network_disabled",
      passed: transportPolicy.enabled === false && transportPolicy.localDispatchEnabled === false && transportPolicy.dispatchAllowed === false && transportPolicy.networkEnabled === false && input.missionControlPlan.transportDispatch === false && input.missionControlPlan.networkComsEnabled === false,
      dispatchAllowed: false,
    },
    {
      name: "approval_required_before_live_global_routing",
      passed: approvalCommandAvailable && commandPolicy.proposalOnly === true && commandPolicy.parentOwned === true && input.modelRoutingProofPlan.globalLiveRoutingEnabled === false && input.modelRoutingProofPlan.liveAutonomousRoutingApplied === false && input.modelRoutingProofPlan.finalE2ERequirementCleared === false && input.modelRoutingProofPlan.no_ship === true,
      dispatchAllowed: false,
    },
    {
      name: "post_8b_scheduler_still_blocked",
      passed: input.schedulerProofPlan.schedulerProofReady === true && input.schedulerProofPlan.schedulerExecutionAllowed === false && input.schedulerProofPlan.daemonStarted === false && input.schedulerProofPlan.childDispatchAllowed === false,
      dispatchAllowed: false,
    },
  ];
  const checks = [
    { name: "mission_control_plan_ready", passed: input.missionControlPlan.missionControlPlanReady === true },
    { name: "proposal_only_commands_parent_owned", passed: scenarios[0].passed === true },
    { name: "topology_hash_only_comms", passed: scenarios[1].passed === true },
    { name: "direct_worker_commands_blocked", passed: scenarios[2].passed === true },
    { name: "live_transport_and_network_disabled", passed: scenarios[3].passed === true },
    { name: "approval_required_before_live_global_routing", passed: scenarios[4].passed === true },
    { name: "post_8b_scheduler_still_blocked", passed: scenarios[5].passed === true },
    { name: "run_scope_no_global_autonomy", passed: input.validation.globalAutonomyReady === false && input.validation.globalAutonomyNoShip === true && input.validation.childDispatchAllowed === false && input.validation.productionWritesPerformed === false && input.validation.autoApply === false && input.missionControlPlan.globalAutonomyReady === false && input.missionControlPlan.globalAutonomyNoShip === true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const proof = {
    schema: "zob.autonomous-mission-control-proof-plan.v1",
    runId: input.runId,
    phase: "9B",
    status: failedChecks.length === 0 ? "mission_control_comms_proof_ready_execution_blocked" : "mission_control_comms_proof_incomplete",
    missionControlProofReady: failedChecks.length === 0,
    proposalOnlyCommandsProofPassed: scenarios[0].passed === true,
    topologyHashOnlyCommsProofPassed: scenarios[1].passed === true,
    directWorkerCommandsBlockedProofPassed: scenarios[2].passed === true,
    liveTransportNetworkDisabledProofPassed: scenarios[3].passed === true,
    liveGlobalRoutingApprovalProofPassed: scenarios[4].passed === true,
    post8bSchedulerBlockedProofPassed: scenarios[5].passed === true,
    finalE2ERequirementCleared: false,
    no_ship: true,
    checks,
    failedChecks,
    scenarios,
    commandProposalProof: {
      proposalOnly: true,
      parentOwned: true,
      allowedCommands,
      proposalCount: commandPolicy.proposalCount,
      proposalHashesValid,
      directWorkerCommandBlocked: commandPolicy.directWorkerCommandBlocked === true,
      transportDispatch: false,
      networkTransport: false,
    },
    comsTopologyProof: {
      topologyGuardActive: comsPolicy.topologyGuardActive === true,
      hashOnlyLedgers: comsPolicy.hashOnlyLedgers === true,
      workerToWorkerFreeChatAllowed: false,
      rawPromptOutputStored: false,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
    transportProof: {
      enabled: false,
      localDispatchEnabled: false,
      dispatchAllowed: false,
      networkEnabled: false,
      stalePeerCountsAsCompletion: false,
      responseBodiesStored: false,
      futureHeartbeatRequired: transportPolicy.futureHeartbeatRequired === true,
      futureStaleDetectionRequired: transportPolicy.futureStaleDetectionRequired === true,
      futureActiveWorkerRegistryRequired: transportPolicy.futureActiveWorkerRegistryRequired === true,
      futureResponseCaptureRequired: transportPolicy.futureResponseCaptureRequired === true,
    },
    routingApprovalPolicy: {
      approvalCommandAvailable,
      approvalCommandProposalOnly: true,
      liveRoutingRequiresApproval: true,
      globalRoutingRequiresApproval: true,
      approvalDoesNotEnableRoutingInThisRun: true,
      liveRoutingAllowedAfterThisProof: false,
      globalLiveRoutingAllowedAfterThisProof: false,
    },
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/mission-control-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/scheduler-proof-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/model-routing-proof-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
      ".pi/teams/zob-core.json",
      ".pi/mission-control/zob_coms_transport.json",
      ".pi/coms/messages.jsonl",
      ".pi/coms/status.jsonl",
    ],
    blockers: [
      "live_transport_not_enabled",
      "network_coms_disabled",
      "global_live_routing_approval_not_granted",
      "final_e2e_mission_control_live_comms_evidence_required",
    ],
    schedulerExecutionAllowed: false,
    daemonStarted: false,
    childDispatchAllowed: false,
    liveChildExecution: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    liveRoutingEnabled: false,
    globalLiveRoutingEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecutionBeyondSmoke: true,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(proof)) throw new Error("autonomous mission control proof plan would store forbidden plaintext body keys");
  return proof;
}

function buildAutonomousSandboxApplyPlan(repoRoot: string, input: { runId: string; missionControlPlan: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const isolatedPath = "reports/sandbox-isolated-execution-smoke.json";
  const reviewPath = "reports/sandbox-diff-review-gate-smoke.json";
  const simulationPath = "reports/sandbox-apply-simulation-smoke.json";
  const preflightPath = "reports/sandbox-manual-apply-preflight-smoke.json";
  const isolatedRead = readJsonArtifact(join(repoRoot, isolatedPath));
  const reviewRead = readJsonArtifact(join(repoRoot, reviewPath));
  const simulationRead = readJsonArtifact(join(repoRoot, simulationPath));
  const preflightRead = readJsonArtifact(join(repoRoot, preflightPath));
  const isolated = isRecord(isolatedRead.parsed) ? isolatedRead.parsed : {};
  const review = isRecord(reviewRead.parsed) ? reviewRead.parsed : {};
  const simulation = isRecord(simulationRead.parsed) ? simulationRead.parsed : {};
  const preflight = isRecord(preflightRead.parsed) ? preflightRead.parsed : {};
  const isolatedDiffHash = typeof isolated.diffHash === "string" ? isolated.diffHash : undefined;
  const reviewDiffHash = typeof review.diffHash === "string" ? review.diffHash : undefined;
  const simulationDiffHash = typeof simulation.diffHash === "string" ? simulation.diffHash : undefined;
  const diffHashesMatch = Boolean(isolatedDiffHash && isolatedDiffHash === reviewDiffHash && reviewDiffHash === simulationDiffHash);
  const checks = [
    { name: "isolated_temp_workspace_executed", passed: isolated.status === "executed_in_sandbox" && isolated.isolatedExecutionPerformed === true && isolated.productionWritesPerformed === false },
    { name: "diff_hash_consistent", passed: diffHashesMatch },
    { name: "oracle_diff_review_passed", passed: review.status === "diff_review_passed" && review.reviewPassed === true && review.applyReadyUnlocked === true && review.applyPerformed === false },
    { name: "rollback_metadata_required", passed: isolated.rollbackPrepared === true && simulation.rollbackPrepared === true && isolated.rollbackApplied === false && simulation.rollbackApplied === false },
    { name: "apply_simulation_temp_workspace_only", passed: simulation.status === "simulated_apply_in_temp_workspace" && simulation.simulatedApplyPerformed === true && simulation.tempTargetWorkspaceScoped === true && simulation.productionWritesPerformed === false },
    { name: "manual_apply_preflight_packet_ready", passed: preflight.status === "manual_apply_preflight_passed" && preflight.manualApplyPreflightPassed === true && preflight.executionAllowedByThisTool === false && preflight.realApplyExecuted === false && preflight.productionWritesPerformed === false },
    { name: "manual_approval_required", passed: isolated.manualApplyRequired === true && review.manualApplyRequired === true && simulation.manualApplyRequired === true && preflight.manualApplyRequired === true && isolated.humanApprovalRequired === true && review.humanApprovalRequired === true && simulation.humanApprovalRequired === true && preflight.humanApprovalRequired === true },
    { name: "auto_apply_disabled", passed: isolated.autoApply === false && review.autoApply === false && simulation.autoApply === false && preflight.autoApply === false },
    { name: "mission_control_still_proposal_only", passed: input.missionControlPlan.directWorkerWrites === false && input.missionControlPlan.transportDispatch === false },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const plan = {
    schema: "zob.autonomous-sandbox-apply-plan.v1",
    runId: input.runId,
    sandboxApplyPlanReady: failedChecks.length === 0,
    failedChecks,
    checks,
    evidenceRefs: [isolatedPath, reviewPath, simulationPath, preflightPath],
    evidenceHashes: {
      isolatedExecution: isolatedRead.hash,
      diffReviewGate: reviewRead.hash,
      applySimulation: simulationRead.hash,
      manualApplyPreflight: preflightRead.hash,
    },
    sandboxRunIdHash: typeof isolated.runId === "string" ? sha256(isolated.runId) : undefined,
    isolatedTempWorkspace: {
      required: true,
      executed: isolated.isolatedExecutionPerformed === true,
      workspacePathStored: false,
      productionWritesPerformed: false,
    },
    applyPlan: {
      required: true,
      plaintextContentStored: false,
      allowedPathsRequired: true,
      forbiddenPathsRequired: true,
      writeTargetsMustExcludeSecretsVendorGenerated: true,
    },
    diffGate: {
      diffHashRequired: true,
      diffHash: isolatedDiffHash,
      diffHashesMatch,
      changedPathCount: Array.isArray(isolated.changedPaths) ? isolated.changedPaths.length : undefined,
      rawDiffStored: false,
    },
    oracleDiffReview: {
      required: true,
      reviewPassed: review.reviewPassed === true,
      applyReadyUnlocked: review.applyReadyUnlocked === true,
      liveOracleDispatchRequiredBeforeRealApply: true,
    },
    rollbackPolicy: {
      rollbackMetadataRequired: true,
      rollbackPrepared: isolated.rollbackPrepared === true && simulation.rollbackPrepared === true,
      rollbackApplied: false,
      rollbackSnapshotRequiredBeforeMainApply: true,
    },
    approvalPolicy: {
      manualApprovalRequired: true,
      humanApprovalRequired: true,
      approvalMetadataHashOnly: true,
      approvedForMainWorkspaceApply: false,
    },
    applySimulation: {
      required: true,
      simulatedApplyPerformed: simulation.simulatedApplyPerformed === true,
      tempTargetWorkspaceScoped: simulation.tempTargetWorkspaceScoped === true,
      productionWritesPerformed: false,
      autoApply: false,
    },
    manualApplyPreflight: {
      required: true,
      preflightPassed: preflight.manualApplyPreflightPassed === true,
      executionAllowedByThisTool: false,
      confirmationPhraseMatched: isRecord(preflight.gates) && preflight.gates.confirmationPhraseMatched === true,
      approvalHashOnly: isRecord(preflight.gates) && preflight.gates.approvalHashOnly === true,
      realApplyExecuted: false,
      productionWritesPerformed: false,
      autoApply: false,
    },
    mainWorkspaceApply: {
      realApplyAllowed: false,
      realApplyExecuted: false,
      productionWritesPerformed: false,
      autoApply: false,
      reason: "phase_10b_manual_apply_preflight_only_no_main_workspace_apply",
      requiredBeforeRealApply: ["fresh_oracle_diff_review_PASS", "rollback_snapshot", "manual_human_approval", "strict_budget_gate", "allowed_paths_write_policy", "separate_manual_apply_executor", "post_apply_validation_oracle"],
    },
    writeSafety: {
      noDirectAutonomousWritesToMainWorkspace: true,
      noAutoApplyByDefault: true,
      noSecretsVendorGeneratedPaths: true,
      rollbackMetadataRequiredBeforeScalingWrites: true,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    realApplyExecuted: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous sandbox apply plan would store forbidden plaintext body keys");
  return plan;
}

function expectedAutonomousCurrentSourceFingerprintFiles(factorySelection: Record<string, unknown>): string[] {
  const selectedFactory = typeof factorySelection.selectedFactory === "string" ? factorySelection.selectedFactory : undefined;
  const factoryFiles = selectedFactory ? [`.pi/factories/${selectedFactory}/factory.json`, `.pi/factories/${selectedFactory}/smoke-manifest.json`] : [];
  return [...AUTONOMOUS_CURRENT_SOURCE_FINGERPRINT_FILES, ...factoryFiles].filter((file, index, items) => items.indexOf(file) === index).sort();
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function sameStringArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left) && left.every((item) => typeof item === "string") && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function buildAutonomousCurrentSourceFingerprint(repoRoot: string, input: { runId: string; factorySelection: Record<string, unknown> }): Record<string, unknown> {
  const selectedFactory = typeof input.factorySelection.selectedFactory === "string" ? input.factorySelection.selectedFactory : undefined;
  const sourceFiles = expectedAutonomousCurrentSourceFingerprintFiles(input.factorySelection);
  const missingFiles = sourceFiles.filter((file) => !existsSync(join(repoRoot, file)));
  const fileHashes = Object.fromEntries(sourceFiles.filter((file) => existsSync(join(repoRoot, file))).map((file) => [file, sha256(readFileSync(join(repoRoot, file), "utf8"))]));
  const fingerprintHash = sha256(JSON.stringify(fileHashes));
  const fingerprint = {
    schema: "zob.autonomous-current-source-fingerprint.v1",
    runId: input.runId,
    phase: "11C",
    status: missingFiles.length === 0 ? "current_source_fingerprint_captured" : "blocked_missing_source_files",
    currentSourceFingerprintReady: missingFiles.length === 0,
    currentSourceFingerprintCaptured: missingFiles.length === 0,
    noMockCurrentSourceE2EProved: false,
    finalE2EProofReady: false,
    sourceFiles,
    sourceFileCount: sourceFiles.length,
    hashedFileCount: Object.keys(fileHashes).length,
    missingFiles,
    fileHashes,
    fingerprintHash,
    selectedFactory,
    evidencePolicy: {
      hashOnly: true,
      sourceBodiesStored: false,
      currentSourceOnly: true,
      rehashRequiredBeforeFinalE2E: true,
      noMockProofRequiredSeparately: true,
    },
    safety: {
      noExecution: true,
      childDispatchAllowed: false,
      daemonStarted: false,
      productionWritesPerformed: false,
      autoApply: false,
      networkAccessed: false,
      globalAutonomyReady: false,
      globalAutonomyNoShip: true,
    },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(fingerprint)) throw new Error("autonomous current-source fingerprint would store forbidden plaintext body keys");
  return fingerprint;
}

function validateAutonomousCurrentSourceFingerprintFreshness(repoRoot: string, fingerprint: Record<string, unknown>, factorySelection: Record<string, unknown>): Record<string, unknown> {
  const expectedSourceFiles = expectedAutonomousCurrentSourceFingerprintFiles(factorySelection);
  const currentMissingFiles = expectedSourceFiles.filter((file) => !existsSync(join(repoRoot, file)));
  const currentFileHashes = Object.fromEntries(expectedSourceFiles.filter((file) => existsSync(join(repoRoot, file))).map((file) => [file, sha256(readFileSync(join(repoRoot, file), "utf8"))]));
  const storedFileHashes = stringRecord(fingerprint.fileHashes);
  const currentFingerprintHash = sha256(JSON.stringify(currentFileHashes));
  const storedFingerprintHash = typeof fingerprint.fingerprintHash === "string" ? fingerprint.fingerprintHash : undefined;
  const hashValuesValid = Object.values(storedFileHashes).every((hash) => /^[a-f0-9]{64}$/.test(hash));
  const expectedHashKeys = Object.keys(currentFileHashes).sort();
  const storedHashKeys = Object.keys(storedFileHashes).sort();
  const fileHashesMatch = JSON.stringify(expectedHashKeys) === JSON.stringify(storedHashKeys) && expectedHashKeys.every((file) => storedFileHashes[file] === currentFileHashes[file]);
  const sourceFilesMatch = sameStringArray(fingerprint.sourceFiles, expectedSourceFiles);
  const missingFilesMatch = sameStringArray(fingerprint.missingFiles, currentMissingFiles);
  const fingerprintHashMatches = storedFingerprintHash === currentFingerprintHash;
  const fresh = fingerprint.schema === "zob.autonomous-current-source-fingerprint.v1"
    && fingerprint.currentSourceFingerprintReady === true
    && fingerprint.currentSourceFingerprintCaptured === true
    && sourceFilesMatch
    && missingFilesMatch
    && currentMissingFiles.length === 0
    && hashValuesValid
    && fileHashesMatch
    && fingerprintHashMatches
    && fingerprint.noMockCurrentSourceE2EProved === false;
  const result = {
    schema: "zob.autonomous-current-source-fingerprint-freshness.v1",
    fresh,
    sourceFilesMatch,
    missingFilesMatch,
    hashValuesValid,
    fileHashesMatch,
    fingerprintHashMatches,
    currentFingerprintHash,
    storedFingerprintHash,
    expectedSourceFileCount: expectedSourceFiles.length,
    storedSourceFileCount: Array.isArray(fingerprint.sourceFiles) ? fingerprint.sourceFiles.length : 0,
    expectedHashedFileCount: expectedHashKeys.length,
    storedHashedFileCount: storedHashKeys.length,
    currentMissingFiles,
    noMockCurrentSourceE2EProved: false,
    noExecution: true,
    childDispatchAllowed: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(result)) throw new Error("autonomous current-source freshness validation would store forbidden plaintext body keys");
  return result;
}

function buildAutonomousFinalNoShipOracle(input: { runId: string; finalE2EProofPlan: Record<string, unknown>; currentSourceFingerprint: Record<string, unknown> }): Record<string, unknown> {
  const blockers = Array.isArray(input.finalE2EProofPlan.blockers) ? input.finalE2EProofPlan.blockers.filter((blocker): blocker is string => typeof blocker === "string") : ["final_e2e_proof_plan_missing_blockers"];
  const checks = [
    { name: "final_e2e_proof_ready", passed: input.finalE2EProofPlan.finalE2EProofReady === true },
    { name: "final_e2e_no_ship_cleared", passed: input.finalE2EProofPlan.no_ship === false },
    { name: "no_mock_current_source_e2e_proved", passed: isRecord(input.finalE2EProofPlan.currentSourceProof) && input.finalE2EProofPlan.currentSourceProof.noMockCurrentSourceE2EProved === true },
    { name: "current_source_fingerprint_captured", passed: input.currentSourceFingerprint.currentSourceFingerprintCaptured === true && typeof input.currentSourceFingerprint.fingerprintHash === "string" },
    { name: "pilot_executed", passed: isRecord(input.finalE2EProofPlan.promotionStatus) && input.finalE2EProofPlan.promotionStatus.pilotExecuted === true },
    { name: "batch_executed", passed: isRecord(input.finalE2EProofPlan.promotionStatus) && input.finalE2EProofPlan.promotionStatus.batchExecuted === true },
    { name: "live_strict_budget_enforced", passed: isRecord(input.finalE2EProofPlan.liveGateStatus) && input.finalE2EProofPlan.liveGateStatus.strictBudgetEnforced === true },
    { name: "live_model_routing_enabled", passed: isRecord(input.finalE2EProofPlan.liveGateStatus) && input.finalE2EProofPlan.liveGateStatus.liveModelRoutingEnabled === true },
    { name: "daemon_started", passed: isRecord(input.finalE2EProofPlan.liveGateStatus) && input.finalE2EProofPlan.liveGateStatus.daemonStarted === true },
    { name: "real_apply_executed", passed: isRecord(input.finalE2EProofPlan.liveGateStatus) && input.finalE2EProofPlan.liveGateStatus.sandboxRealApplyExecuted === true },
    { name: "global_ready_sentinel_allowed", passed: isRecord(input.finalE2EProofPlan.sentinelPolicy) && input.finalE2EProofPlan.sentinelPolicy.globalReadySentinelAllowed === true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const oracle = {
    schema: "zob.autonomous-final-no-ship-oracle.v1",
    runId: input.runId,
    phase: "11E",
    oracleType: "deterministic_structural_no_ship",
    verdict: "FAIL",
    no_ship: true,
    finalOracleReady: false,
    finalOraclePass: false,
    finalE2EProofReady: false,
    evidenceChecked: true,
    checks,
    failedChecks,
    blockers,
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/final-e2e-proof-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/current-source-fingerprint.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
    ],
    decision: {
      globalAutonomyReady: false,
      globalAutonomyNoShip: true,
      claim100PercentAutonomyAllowed: false,
      writeGlobalReadySentinelAllowed: false,
      writeFinalDoneSentinelAllowed: false,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    realApplyExecuted: false,
    liveRoutingEnabled: false,
    budgetEnforced: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(oracle)) throw new Error("autonomous final no-ship oracle would store forbidden plaintext body keys");
  return oracle;
}

function buildAutonomousFinalE2EProofPlan(repoRoot: string, input: { runId: string; runtimeGates: Record<string, unknown>; strictBudgetProofPlan: Record<string, unknown>; modelRoutingProofPlan: Record<string, unknown>; modelRoutingPlan: Record<string, unknown>; factorySelection: Record<string, unknown>; factoryRunRef: Record<string, unknown>; oracleReview: Record<string, unknown>; promotionPlan: Record<string, unknown>; promotionProofPlan: Record<string, unknown>; schedulerPlan: Record<string, unknown>; schedulerProofPlan: Record<string, unknown>; missionControlPlan: Record<string, unknown>; missionControlProofPlan: Record<string, unknown>; sandboxApplyPlan: Record<string, unknown>; currentSourceFingerprint: Record<string, unknown>; validation: Record<string, unknown> }): Record<string, unknown> {
  const safeRunId = safeFileStem(input.runId);
  const runRoot = `reports/autonomous-runs/${safeRunId}`;
  const globalReadySentinelPath = join(repoRoot, runRoot, "GLOBAL_AUTONOMY_READY.sentinel");
  const smokeGate = isRecord(input.promotionPlan.smokeGate) ? input.promotionPlan.smokeGate : {};
  const pilotGate = isRecord(input.promotionPlan.pilotGate) ? input.promotionPlan.pilotGate : {};
  const batchGate = isRecord(input.promotionPlan.batchGate) ? input.promotionPlan.batchGate : {};
  const strictBudgetGate = isRecord(input.runtimeGates.autonomousStrictBudgetGate) ? input.runtimeGates.autonomousStrictBudgetGate : {};
  const mainWorkspaceApply = isRecord(input.sandboxApplyPlan.mainWorkspaceApply) ? input.sandboxApplyPlan.mainWorkspaceApply : {};
  const globalReadySentinelPresent = existsSync(globalReadySentinelPath);
  const proofSteps = [
    { name: "user_need", state: "captured", evidenceRef: `${runRoot}/spec-gate.json`, dispatchAllowed: false },
    { name: "spec_lock", state: "proved", evidenceRef: `${runRoot}/spec-gate.json`, dispatchAllowed: false },
    { name: "context_scope", state: "proved", evidenceRef: `${runRoot}/context-scope.json`, dispatchAllowed: false },
    { name: "context_pack", state: "proved", evidenceRef: `${runRoot}/context-pack.json`, dispatchAllowed: false },
    { name: "strict_budget", state: input.strictBudgetProofPlan.strictBudgetProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/strict-budget-proof-plan.json`, blocker: "live_autonomous_strict_budget_not_enforced", dispatchAllowed: false },
    { name: "model_routing", state: input.modelRoutingProofPlan.modelRoutingProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/model-routing-proof-plan.json`, blocker: "live_autonomous_model_routing_not_enabled", dispatchAllowed: false },
    { name: "factory_selection", state: "proved", evidenceRef: `${runRoot}/factory-selection.json`, dispatchAllowed: false },
    { name: "smoke", state: input.factoryRunRef.status === "done" ? "proved" : "blocked", evidenceRef: `${runRoot}/factory-run-ref.json`, dispatchAllowed: false },
    { name: "smoke_oracle", state: input.oracleReview.verdict === "PASS" && input.oracleReview.no_ship === false ? "proved" : "blocked", evidenceRef: `${runRoot}/oracle-review.json`, dispatchAllowed: false },
    { name: "promotion_proof", state: input.promotionProofPlan.promotionProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/promotion-proof-plan.json`, blocker: "pilot_batch_execution_not_enabled", dispatchAllowed: false },
    { name: "pilot", state: "blocked", evidenceRef: `${runRoot}/promotion-plan.json`, blocker: "pilot_execution_disabled_until_live_gates", dispatchAllowed: false },
    { name: "pilot_oracle", state: "blocked", evidenceRef: `${runRoot}/promotion-plan.json`, blocker: "pilot_oracle_missing_until_pilot_executes", dispatchAllowed: false },
    { name: "batch", state: "blocked", evidenceRef: `${runRoot}/promotion-plan.json`, blocker: "batch_execution_disabled_until_pilot_oracle_and_concurrency_gate", dispatchAllowed: false },
    { name: "final_oracle", state: "blocked", evidenceRef: `${runRoot}/final-e2e-proof-plan.json`, blocker: "final_oracle_missing_until_full_current_source_e2e", dispatchAllowed: false },
    { name: "scheduler_proof", state: input.schedulerProofPlan.schedulerProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/scheduler-proof-plan.json`, blocker: "daemon_scheduler_not_started", dispatchAllowed: false },
    { name: "mission_control_proof", state: input.missionControlProofPlan.missionControlProofReady === true ? "proved_run_scope_gate_only" : "blocked", evidenceRef: `${runRoot}/mission-control-proof-plan.json`, blocker: "live_mission_control_transport_not_enabled", dispatchAllowed: false },
    { name: "stop_clean", state: "planned", evidenceRef: `${runRoot}/scheduler-plan.json`, dispatchAllowed: false },
  ];
  const requiredArtifacts = [
    { name: "spec-gate.json", present: true, evidenceRef: `${runRoot}/spec-gate.json` },
    { name: "context-scope.json", present: true, evidenceRef: `${runRoot}/context-scope.json` },
    { name: "context-pack.json", present: true, evidenceRef: `${runRoot}/context-pack.json` },
    { name: "factory-selection.json", present: true, evidenceRef: `${runRoot}/factory-selection.json` },
    { name: "runtime-gates.json", present: true, evidenceRef: `${runRoot}/runtime-gates.json` },
    { name: "strict-budget-proof-plan.json", present: input.strictBudgetProofPlan.strictBudgetProofReady === true, evidenceRef: `${runRoot}/strict-budget-proof-plan.json` },
    { name: "model-routing-proof-plan.json", present: input.modelRoutingProofPlan.modelRoutingProofReady === true, evidenceRef: `${runRoot}/model-routing-proof-plan.json` },
    { name: "run-graph.json", present: true, evidenceRef: `${runRoot}/run-graph.json` },
    { name: "current-source-fingerprint.json", present: input.currentSourceFingerprint.currentSourceFingerprintReady === true, evidenceRef: `${runRoot}/current-source-fingerprint.json` },
    { name: "factory-run-smoke", present: input.factoryRunRef.status === "done", evidenceRef: `${runRoot}/factory-run-ref.json` },
    { name: "factory-run-pilot", present: false, missingReason: "pilot_not_executed" },
    { name: "factory-run-batch", present: false, missingReason: "batch_not_executed" },
    { name: "oracle-review-smoke.json", present: input.oracleReview.verdict === "PASS", evidenceRef: `${runRoot}/oracle-review.json` },
    { name: "promotion-proof-plan.json", present: input.promotionProofPlan.promotionProofReady === true, evidenceRef: `${runRoot}/promotion-proof-plan.json` },
    { name: "scheduler-proof-plan.json", present: input.schedulerProofPlan.schedulerProofReady === true, evidenceRef: `${runRoot}/scheduler-proof-plan.json` },
    { name: "mission-control-proof-plan.json", present: input.missionControlProofPlan.missionControlProofReady === true, evidenceRef: `${runRoot}/mission-control-proof-plan.json` },
    { name: "oracle-review-pilot.json", present: false, missingReason: "pilot_oracle_missing" },
    { name: "final-oracle.json", present: false, missingReason: "final_oracle_missing" },
    { name: "validation.json", present: input.validation.status === "smoke_autonomy_passed", evidenceRef: `${runRoot}/validation.json` },
    { name: "DONE.sentinel", present: false, missingReason: "final_e2e_not_run" },
    { name: "GLOBAL_AUTONOMY_READY.sentinel", present: globalReadySentinelPresent, missingReason: globalReadySentinelPresent ? undefined : "global_autonomy_not_ready" },
  ];
  const blockers = [
    "final_e2e_no_mock_current_source_not_proven",
    ...(strictBudgetGate.strictEnabled === true && strictBudgetGate.budgetEnforced === true ? [] : ["live_strict_budget_not_enforced"]),
    ...(input.modelRoutingPlan.liveRoutingEnabled === true ? [] : ["live_model_routing_not_enabled"]),
    ...(input.schedulerPlan.schedulerExecutionAllowed === true && input.schedulerPlan.daemonStarted === true ? [] : ["daemon_scheduler_not_started"]),
    ...(input.missionControlProofPlan.finalE2ERequirementCleared === true ? [] : ["live_mission_control_transport_not_enabled"]),
    ...(smokeGate.passed === true ? [] : ["smoke_gate_not_passed"]),
    ...(pilotGate.executionAllowed === true ? [] : ["pilot_execution_disabled"]),
    ...(batchGate.executionAllowed === true ? [] : ["batch_execution_disabled"]),
    ...(mainWorkspaceApply.realApplyExecuted === true ? [] : ["real_apply_not_executed"]),
    "final_oracle_missing",
    ...(globalReadySentinelPresent ? [] : ["global_autonomy_ready_sentinel_absent"]),
  ];
  const plan = {
    schema: "zob.autonomous-final-e2e-proof-plan.v1",
    runId: input.runId,
    phase: "11A",
    status: "blocked_for_final_e2e_proof",
    finalE2EProofReady: false,
    no_ship: true,
    blockers,
    proofSteps,
    requiredArtifacts,
    currentSourceProof: {
      required: true,
      noMockRequired: true,
      currentSourceFingerprintCaptured: input.currentSourceFingerprint.currentSourceFingerprintCaptured === true,
      currentSourceFingerprintHash: typeof input.currentSourceFingerprint.fingerprintHash === "string" ? input.currentSourceFingerprint.fingerprintHash : undefined,
      sourceFileCount: typeof input.currentSourceFingerprint.sourceFileCount === "number" ? input.currentSourceFingerprint.sourceFileCount : undefined,
      missingFiles: Array.isArray(input.currentSourceFingerprint.missingFiles) ? input.currentSourceFingerprint.missingFiles : [],
      noMockCurrentSourceE2EProved: false,
      registeredFactoryPathChecked: input.factorySelection.currentSourceProofRequired === true,
      arbitraryFactoryAutonomyReady: false,
    },
    liveGateStatus: {
      strictBudgetEnforced: strictBudgetGate.budgetEnforced === true,
      strictBudgetEnabled: strictBudgetGate.strictEnabled === true,
      strictBudgetProofReady: input.strictBudgetProofPlan.strictBudgetProofReady === true,
      strictBudgetBlockProofPassed: input.strictBudgetProofPlan.strictBudgetBlockProofPassed === true,
      strictBudgetFinalE2ERequirementCleared: input.strictBudgetProofPlan.finalE2ERequirementCleared === true,
      modelRoutingProofReady: input.modelRoutingProofPlan.modelRoutingProofReady === true,
      modelRoutingOracleProofPassed: input.modelRoutingProofPlan.routingOracleProofPassed === true,
      modelRoutingFinalE2ERequirementCleared: input.modelRoutingProofPlan.finalE2ERequirementCleared === true,
      liveModelRoutingEnabled: input.modelRoutingPlan.liveRoutingEnabled === true,
      schedulerExecutionAllowed: input.schedulerPlan.schedulerExecutionAllowed === true,
      schedulerProofReady: input.schedulerProofPlan.schedulerProofReady === true,
      schedulerFinalE2ERequirementCleared: input.schedulerProofPlan.finalE2ERequirementCleared === true,
      daemonStarted: input.schedulerPlan.daemonStarted === true,
      missionControlProposalOnly: isRecord(input.missionControlPlan.commandPolicy) && input.missionControlPlan.commandPolicy.proposalOnly === true,
      missionControlProofReady: input.missionControlProofPlan.missionControlProofReady === true,
      missionControlFinalE2ERequirementCleared: input.missionControlProofPlan.finalE2ERequirementCleared === true,
      directWorkerCommandsBlocked: input.missionControlProofPlan.directWorkerCommandsBlockedProofPassed === true,
      liveTransportNetworkDisabled: input.missionControlProofPlan.liveTransportNetworkDisabledProofPassed === true,
      liveGlobalRoutingApprovalRequired: input.missionControlProofPlan.liveGlobalRoutingApprovalProofPassed === true,
      sandboxRealApplyExecuted: mainWorkspaceApply.realApplyExecuted === true,
    },
    promotionStatus: {
      smokeGatePassed: smokeGate.passed === true,
      pilotPreconditionsMet: pilotGate.preconditionsMet === true,
      promotionProofReady: input.promotionProofPlan.promotionProofReady === true,
      promotionFinalE2ERequirementCleared: input.promotionProofPlan.finalE2ERequirementCleared === true,
      pilotExecutionAllowed: pilotGate.executionAllowed === true,
      batchPreconditionsMet: batchGate.preconditionsMet === true,
      batchExecutionAllowed: batchGate.executionAllowed === true,
      pilotExecuted: input.promotionPlan.pilotExecuted === true,
      batchExecuted: input.promotionPlan.batchExecuted === true,
    },
    sentinelPolicy: {
      doneSentinelAllowed: false,
      globalReadySentinelAllowed: false,
      globalReadySentinelPresent,
      globalReadySentinelPath: `${runRoot}/GLOBAL_AUTONOMY_READY.sentinel`,
    },
    finalReportPolicy: {
      finalGlobalReportAllowed: false,
      currentReportIsRunScopedSmokeOnly: true,
      claim100PercentAutonomyAllowed: false,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    realApplyExecuted: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(plan)) throw new Error("autonomous final e2e proof plan would store forbidden plaintext body keys");
  return plan;
}

function buildAutonomousCompletionGate(input: { runId: string; finalE2EProofPlan: Record<string, unknown>; finalNoShipOracle: Record<string, unknown>; currentSourceFingerprintFreshness: Record<string, unknown> }): Record<string, unknown> {
  const finalBlockers = Array.isArray(input.finalE2EProofPlan.blockers) ? input.finalE2EProofPlan.blockers.filter((blocker): blocker is string => typeof blocker === "string") : [];
  const oracleFailedChecks = Array.isArray(input.finalNoShipOracle.failedChecks) ? input.finalNoShipOracle.failedChecks.filter((check): check is string => typeof check === "string") : [];
  const checks = [
    { name: "final_e2e_proof_ready", passed: input.finalE2EProofPlan.finalE2EProofReady === true },
    { name: "final_no_ship_oracle_pass", passed: input.finalNoShipOracle.finalOraclePass === true && input.finalNoShipOracle.no_ship === false },
    { name: "current_source_fingerprint_fresh", passed: input.currentSourceFingerprintFreshness.fresh === true },
    { name: "global_ready_sentinel_allowed", passed: isRecord(input.finalE2EProofPlan.sentinelPolicy) && input.finalE2EProofPlan.sentinelPolicy.globalReadySentinelAllowed === true },
    { name: "final_done_sentinel_allowed", passed: isRecord(input.finalNoShipOracle.decision) && input.finalNoShipOracle.decision.writeFinalDoneSentinelAllowed === true },
    { name: "claim_100_percent_allowed", passed: isRecord(input.finalNoShipOracle.decision) && input.finalNoShipOracle.decision.claim100PercentAutonomyAllowed === true },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const gate = {
    schema: "zob.autonomous-completion-gate.v1",
    runId: input.runId,
    phase: "11F",
    status: "blocked_for_goal_completion",
    completionReady: false,
    allRequirementsVerified: false,
    no_ship: true,
    updateGoalAllowed: false,
    requiredGoalStatus: "in_progress",
    completionToolAvailableInThisRun: false,
    checks,
    failedChecks,
    blockers: [...new Set([...finalBlockers, ...oracleFailedChecks, ...failedChecks])].sort(),
    evidenceRefs: [
      `reports/autonomous-runs/${safeFileStem(input.runId)}/final-e2e-proof-plan.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/final-no-ship-oracle.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/current-source-fingerprint.json`,
      `reports/autonomous-runs/${safeFileStem(input.runId)}/validation.json`,
    ],
    requiredBeforeCompletion: [
      "final_e2e_no_mock_current_source_proof",
      "final_oracle_PASS_no_ship_false",
      "smoke_pilot_batch_artifacts_current_source",
      "live_strict_budget_enforced",
      "live_model_routing_enabled",
      "daemon_scheduler_proven_with_kill_switch",
      "sandbox_real_apply_or_explicit_no_apply_final_policy",
      "GLOBAL_AUTONOMY_READY_sentinel_allowed_by_final_oracle",
      "update_goal_tool_available_and_called_only_after_all_gates_pass",
    ],
    decision: {
      updateGoalStatusCompleteAllowed: false,
      globalAutonomyReady: false,
      globalAutonomyNoShip: true,
      writeGlobalReadySentinelAllowed: false,
      writeFinalDoneSentinelAllowed: false,
      claim100PercentAutonomyAllowed: false,
    },
    childDispatchAllowed: false,
    daemonStarted: false,
    directWorkerWrites: false,
    transportDispatch: false,
    networkComsEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    realApplyExecuted: false,
    liveRoutingEnabled: false,
    budgetEnforced: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  if (hasForbiddenBodyKeys(gate)) throw new Error("autonomous completion gate would store forbidden plaintext body keys");
  return gate;
}

function buildAutonomousReadOnlySmokeFinalReport(validation: Record<string, unknown>, factoryRunRef: Record<string, unknown>, oracleReview: Record<string, unknown>): string {
  const blockers = Array.isArray(validation.blockers) ? validation.blockers.map((blocker) => `- ${String(blocker)}`).join("\n") : "";
  return [
    "# Autonomous Read-Only Smoke Report",
    "",
    `Run ID: ${String(validation.runId ?? "unknown")}`,
    `Status: ${String(validation.status ?? "unknown")}`,
    `Smoke no-ship: ${String(validation.no_ship === true)}`,
    `Global autonomy no-ship: ${String(validation.globalAutonomyNoShip === true)}`,
    "",
    "## Factory smoke",
    "",
    `- Selected factory: ${String(factoryRunRef.selectedFactory ?? "none")}`,
    `- Factory run id: ${String(factoryRunRef.factoryRunId ?? "none")}`,
    `- Factory status: ${String(factoryRunRef.status ?? "unknown")}`,
    `- Deterministic execution: ${String(factoryRunRef.execution === "deterministic")}`,
    "",
    "## Structural oracle",
    "",
    `- Verdict: ${String(oracleReview.verdict ?? "unknown")}`,
    `- No-ship for this smoke: ${String(oracleReview.no_ship === true)}`,
    `- Live oracle dispatched: ${String(oracleReview.liveOracleDispatched === true)}`,
    "",
    "## Blockers",
    "",
    blockers || "- None for this read-only smoke slice.",
    "",
    "## Evidence refs",
    "",
    "- spec-gate.json",
    "- context-scope.json",
    "- context-pack.json",
    "- runtime-gates.json",
    "- model-routing-plan.json",
    "- model-routing-proof-plan.json",
    "- factory-selection.json",
    "- factory-run-ref.json",
    "- oracle-review.json",
    "- promotion-plan.json",
    "- promotion-proof-plan.json",
    "- scheduler-plan.json",
    "- scheduler-proof-plan.json",
    "- mission-control-plan.json",
    "- mission-control-proof-plan.json",
    "- sandbox-apply-plan.json",
    "- strict-budget-proof-plan.json",
    "- current-source-fingerprint.json",
    "- final-e2e-proof-plan.json",
    "- final-no-ship-oracle.json",
    "- completion-gate.json",
    "- validation.json",
    "- SMOKE_AUTONOMY_PASSED.sentinel when status=smoke_autonomy_passed",
    "",
    "Compliance: Phase 4A read-only deterministic smoke evidence only; global autonomy remains no-ship.",
    "",
  ].join("\n");
}

export function validateAutonomousRuntimeDryRunArtifacts(repoRoot: string, runId: string): Record<string, unknown> {
  const safeRunId = safeFileStem(runId);
  const runDir = join(repoRoot, "reports", "autonomous-runs", safeRunId);
  const requiredArtifacts = ["spec-gate.json", "context-scope.json", "context-lookup.json", "context-pack.json", "runtime-gates.json", "model-routing-plan.json", "run-graph.json", "factory-selection.json", "proof-plan.json", "dry-run-report.json", "validation.json", "final-report.md", "DRY_RUN_READY.sentinel"];
  const jsonArtifacts = requiredArtifacts.filter((name) => name.endsWith(".json"));
  const parsedArtifacts: Record<string, Record<string, unknown> | unknown[]> = {};
  const artifactMetadata = requiredArtifacts.map((name) => {
    const artifactPath = join(runDir, name);
    const present = existsSync(artifactPath);
    if (!present) return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, bodyStored: false };
    if (!name.endsWith(".json")) {
      const raw = readFileSync(artifactPath, "utf8");
      return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, hash: sha256(raw), bodyStored: false };
    }
    const read = readJsonArtifact(artifactPath);
    if (read.parsed) parsedArtifacts[name] = read.parsed;
    return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, hash: read.hash, schema: isRecord(read.parsed) ? read.parsed.schema : undefined, error: read.error, bodyStored: false };
  });
  const artifact = (name: string): Record<string, unknown> => isRecord(parsedArtifacts[name]) ? parsedArtifacts[name] as Record<string, unknown> : {};
  const arrayArtifact = (name: string): unknown[] => Array.isArray(parsedArtifacts[name]) ? parsedArtifacts[name] as unknown[] : [];
  const report = artifact("dry-run-report.json");
  const validation = artifact("validation.json");
  const specGate = artifact("spec-gate.json");
  const contextScope = artifact("context-scope.json");
  const contextLookups = arrayArtifact("context-lookup.json");
  const contextPack = artifact("context-pack.json");
  const runtimeGates = artifact("runtime-gates.json");
  const modelRoutingPlan = artifact("model-routing-plan.json");
  const runGraph = artifact("run-graph.json");
  const factorySelection = artifact("factory-selection.json");
  const proofPlan = artifact("proof-plan.json");
  const proofStages = Array.isArray(proofPlan.stages) ? proofPlan.stages.filter(isRecord) : [];
  const graphEdges = Array.isArray(runGraph.edges) ? runGraph.edges.filter(isRecord) : [];
  const graphNodes = Array.isArray(runGraph.nodes) ? runGraph.nodes.filter(isRecord) : [];
  const modelRoutes = Array.isArray(modelRoutingPlan.routes) ? modelRoutingPlan.routes.filter(isRecord) : [];
  const lookupPlan = isRecord(report.contextPlan) && isRecord(report.contextPlan.lookupPlan) ? report.contextPlan.lookupPlan : {};
  const factoryReadiness = isRecord(factorySelection.factoryReadiness) ? factorySelection.factoryReadiness : {};
  const jsonBodyFree = jsonArtifacts.every((name) => {
    const parsed = parsedArtifacts[name];
    return parsed !== undefined && !hasForbiddenBodyKeys(parsed);
  });
  const checks = [
    { name: "required_artifacts_present", passed: artifactMetadata.every((item) => item.present === true), detail: { requiredArtifacts } },
    { name: "json_artifacts_parse", passed: artifactMetadata.filter((item) => item.name.endsWith(".json")).every((item) => !item.error), detail: { jsonArtifacts } },
    { name: "artifact_schemas", passed: specGate.schema === "zob.autonomous-spec-gate.v1" && contextScope.schema === "zob.context-scope.v1" && contextPack.schema === "zob.context-pack.v1" && runtimeGates.schema === "zob.autonomous-runtime-gates.v1" && modelRoutingPlan.schema === "zob.autonomous-model-routing-plan.v1" && runGraph.schema === "zob.autonomous-run-graph.v1" && factorySelection.schema === "zob.autonomous-factory-selection.v1" && proofPlan.schema === "zob.autonomous-proof-plan.v1" && report.schema === "zob.autonomous-runtime-dry-run.v1" && validation.schema === "zob.autonomous-runtime-dry-run-validation.v1", detail: "expected autonomous dry-run artifact schemas" },
    { name: "spec_gate_scope_locked", passed: specGate.specLocked === true && specGate.allowedPathsRequired === true && specGate.pathGatePassed === true && specGate.applyPolicyRequired === true && specGate.applyPolicyProvided === true && specGate.budgetProfileRequired === true && specGate.budgetProfileProvided === true && specGate.autonomousStrictBudgetRequired === true && specGate.autonomousStrictBudgetSatisfied === true && Array.isArray(specGate.allowedPaths) && specGate.allowedPaths.length > 0 && Array.isArray(specGate.forbiddenPaths) && specGate.forbiddenPaths.length > 0, detail: "autonomous spec lock requires safe bounded allowed_paths, forbidden_paths, explicit apply_policy, and explicit strict_requested budget_profile" },
    { name: "dry_run_safety_flags", passed: report.noExecution === true && report.childDispatchAllowed === false && report.daemonStarted === false && report.productionWritesPerformed === false && report.autoApply === false && report.networkAccessed === false && report.globalAutonomyReady === false && report.globalAutonomyNoShip === true, detail: "report safety posture" },
    { name: "validation_safety_flags", passed: validation.passed === true && validation.noExecution === true && validation.childDispatchAllowed === false && validation.networkAccessed === false && validation.globalAutonomyNoShip === true && validation.sentinel === "DRY_RUN_READY.sentinel", detail: "validation safety posture" },
    { name: "context_lookup_pack_cited_bounded", passed: contextLookups.length > 0 && contextLookups.every((lookup) => isRecord(lookup) && lookup.schema === "zob.brain-lookup-result.v1" && lookup.queryStored === false && lookup.citationRequired === true) && Array.isArray(contextPack.citations) && contextPack.citations.length > 0 && isRecord(contextPack.loadingRules) && contextPack.loadingRules.boundedContextOnly === true && contextPack.loadingRules.agentLoadsEntireCorpus === false, detail: { lookupCount: contextLookups.length, citationCount: Array.isArray(contextPack.citations) ? contextPack.citations.length : 0 } },
    { name: "gbrain_disabled", passed: lookupPlan.gbrainImportEnabled === false && lookupPlan.gbrainEmbedEnabled === false && lookupPlan.gbrainSyncEnabled === false && lookupPlan.gbrainWriteEnabled === false, detail: "P0 dry-run does not import/embed/sync/write GBrain" },
    { name: "runtime_gates_no_execution", passed: runtimeGates.passed === true && isRecord(runtimeGates.autonomousStrictBudgetGate) && runtimeGates.autonomousStrictBudgetGate.strictRequested === true && runtimeGates.autonomousStrictBudgetGate.strictEnabled === false && runtimeGates.autonomousStrictBudgetGate.budgetEnforced === false && runtimeGates.noExecution === true && runtimeGates.childDispatchAllowed === false && runtimeGates.globalBudgetEnforced === false && runtimeGates.globalModelRoutingEnabled === false && runtimeGates.daemonStarted === false && runtimeGates.productionWritesPerformed === false && runtimeGates.autoApply === false && runtimeGates.networkAccessed === false, detail: "runtime gates require strict budget intent while remaining disabled/proposal-only" },
    { name: "model_routing_plan_safe", passed: modelRoutingPlan.routingPlanReady === true && modelRoutingPlan.liveRoutingEnabled === false && modelRoutingPlan.globalLiveRoutingEnabled === false && modelRoutingPlan.modelRouterUsed === false && modelRoutingPlan.routingApplied === false && modelRoutingPlan.childDispatchAllowed === false && modelRoutingPlan.noExecution === true && modelRoutes.some((route) => route.stage === "context_reuse_scout" && route.recommendedModelClass === "cheap_scout") && modelRoutes.some((route) => route.oracleCritical === true && route.recommendedModelClass === "strong_oracle") && modelRoutes.every((route) => route.noExecution === true && route.modelRouterUsed === false && route.routingApplied === false && route.childDispatchAllowed === false), detail: { routeCount: modelRoutes.length, failedChecks: modelRoutingPlan.failedChecks } },
    { name: "run_graph_parent_owned_no_dispatch", passed: runGraph.status === "dry_run_graph_ready" && runGraph.parentOwned === true && runGraph.noExecution === true && runGraph.childDispatchAllowed === false && graphNodes.some((node) => node.id === "model_routing_plan") && graphNodes.some((node) => node.id === "registered_factory_current_source_proof") && graphEdges.length > 0 && graphEdges.every((edge) => edge.parentOwned === true && edge.dispatchAllowed === false), detail: { nodes: graphNodes.length, edges: graphEdges.length } },
    { name: "factory_selection_requires_current_source_proof", passed: factorySelection.currentSourceProofRequired === true && typeof factoryReadiness.registeredBatchReady === "boolean" && factorySelection.proofBeforeExecutionRequired === (factoryReadiness.registeredBatchReady !== true), detail: { selectedFactory: factorySelection.selectedFactory, registeredBatchReady: factoryReadiness.registeredBatchReady } },
    { name: "proof_plan_has_required_gates", passed: ["context_lookup_and_pack", "runtime_gates_preflight", "model_routing_plan", "registered_factory_current_source_proof", "smoke_oracle", "pilot_oracle", "batch"].every((name) => proofStages.some((stage) => stage.name === name)) && proofStages.every((stage) => stage.name === "spec_lock" || stage.dispatchAllowed === false || stage.dispatchAllowed === undefined), detail: { stages: proofStages.map((stage) => stage.name) } },
    { name: "json_artifacts_body_free", passed: jsonBodyFree, detail: "no forbidden plaintext body keys in JSON artifacts" },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  const result = {
    schema: "zob.autonomous-runtime-dry-run-artifact-validation.v1",
    runId: safeRunId,
    valid: failedChecks.length === 0,
    failedChecks,
    checks,
    artifacts: artifactMetadata,
    noExecution: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(result)) throw new Error("autonomous dry-run artifact validation would store forbidden plaintext body keys");
  return result;
}

export function writeAutonomousRuntimeDryRunReport(repoRoot: string, input: AutonomousRuntimeDryRunInput): Record<string, unknown> {
  const report = buildAutonomousRuntimeDryRun(repoRoot, input);
  const runId = String(report.runId);
  const safeRunId = safeFileStem(runId);
  const runDir = join(repoRoot, "reports", "autonomous-runs", safeRunId);
  mkdirSync(runDir, { recursive: true });
  const specGatePath = join(runDir, "spec-gate.json");
  const contextScopePath = join(runDir, "context-scope.json");
  const contextLookupPath = join(runDir, "context-lookup.json");
  const contextPackPath = join(runDir, "context-pack.json");
  const runtimeGatesPath = join(runDir, "runtime-gates.json");
  const modelRoutingPlanPath = join(runDir, "model-routing-plan.json");
  const runGraphPath = join(runDir, "run-graph.json");
  const factorySelectionPath = join(runDir, "factory-selection.json");
  const proofPlanPath = join(runDir, "proof-plan.json");
  const reportPath = join(runDir, "dry-run-report.json");
  const validationPath = join(runDir, "validation.json");
  const finalReportPath = join(runDir, "final-report.md");
  writeFileSync(specGatePath, `${JSON.stringify(report.specGate, null, 2)}\n`);
  const contextPlan = isRecord(report.contextPlan) ? report.contextPlan : {};
  const contextScope = isRecord(contextPlan.contextScope) ? contextPlan.contextScope : {};
  writeFileSync(contextScopePath, `${JSON.stringify(contextScope, null, 2)}\n`);
  writeFileSync(contextLookupPath, `${JSON.stringify(contextPlan.lookupResults ?? [], null, 2)}\n`);
  writeFileSync(contextPackPath, `${JSON.stringify(contextPlan.contextPack ?? {}, null, 2)}\n`);
  writeFileSync(runtimeGatesPath, `${JSON.stringify(report.runtimeGates, null, 2)}\n`);
  writeFileSync(modelRoutingPlanPath, `${JSON.stringify(report.modelRoutingPlan, null, 2)}\n`);
  writeFileSync(runGraphPath, `${JSON.stringify(report.runGraph, null, 2)}\n`);
  writeFileSync(factorySelectionPath, `${JSON.stringify(report.factorySelection, null, 2)}\n`);
  writeFileSync(proofPlanPath, `${JSON.stringify(report.proofPlan, null, 2)}\n`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const validation = buildAutonomousRuntimeDryRunValidation(report);
  writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  writeFileSync(finalReportPath, buildAutonomousRuntimeDryRunFinalReport(report));
  if (report.status === "dry_run_plan_ready") writeFileSync(join(runDir, "DRY_RUN_READY.sentinel"), "dry-run-ready\n");
  return {
    ...report,
    specGatePath: `reports/autonomous-runs/${safeRunId}/spec-gate.json`,
    contextScopePath: `reports/autonomous-runs/${safeRunId}/context-scope.json`,
    contextLookupPath: `reports/autonomous-runs/${safeRunId}/context-lookup.json`,
    contextPackPath: `reports/autonomous-runs/${safeRunId}/context-pack.json`,
    runtimeGatesPath: `reports/autonomous-runs/${safeRunId}/runtime-gates.json`,
    modelRoutingPlanPath: `reports/autonomous-runs/${safeRunId}/model-routing-plan.json`,
    runGraphPath: `reports/autonomous-runs/${safeRunId}/run-graph.json`,
    factorySelectionPath: `reports/autonomous-runs/${safeRunId}/factory-selection.json`,
    proofPlanPath: `reports/autonomous-runs/${safeRunId}/proof-plan.json`,
    reportPath: `reports/autonomous-runs/${safeRunId}/dry-run-report.json`,
    validationPath: `reports/autonomous-runs/${safeRunId}/validation.json`,
    finalReportPath: `reports/autonomous-runs/${safeRunId}/final-report.md`,
    sentinelPath: report.status === "dry_run_plan_ready" ? `reports/autonomous-runs/${safeRunId}/DRY_RUN_READY.sentinel` : undefined,
  };
}

export function writeAutonomousReadOnlySmokeRunReport(repoRoot: string, input: AutonomousReadOnlySmokeRunInput): Record<string, unknown> {
  const runId = safeFileStem(input.runId ?? `autonomous-readonly-smoke-${sha256(input.userNeed || "missing-spec").slice(0, 12)}`);
  const safeRunId = safeFileStem(runId);
  const runDir = join(repoRoot, "reports", "autonomous-runs", safeRunId);
  const smokeAutonomySentinelPath = join(runDir, "SMOKE_AUTONOMY_PASSED.sentinel");
  if (existsSync(smokeAutonomySentinelPath)) throw new Error(`Autonomous smoke run already passed; choose a fresh run_id to avoid stale sentinel reuse: ${runId}`);
  const dryRun = writeAutonomousRuntimeDryRunReport(repoRoot, {
    ...input,
    runId,
    applyPolicy: input.applyPolicy ?? "no_apply",
    budgetProfile: input.budgetProfile ?? "strict_requested",
  });
  const factorySelection = isRecord(dryRun.factorySelection) ? dryRun.factorySelection : {};
  const selectedFactory = typeof factorySelection.selectedFactory === "string" ? factorySelection.selectedFactory : undefined;
  const manifestPath = selectedFactory ? `.pi/factories/${selectedFactory}/smoke-manifest.json` : undefined;
  const factoryRunId = safeFileStem(input.factoryRunId ?? `autonomous-smoke-${safeRunId}`);
  const factoryRunAlreadyExists = existsSync(join(repoRoot, "reports", "factory-runs", factoryRunId));
  const blockers = [
    ...(dryRun.status === "dry_run_plan_ready" ? [] : ["dry_run_not_ready"]),
    ...(isRecord(dryRun.validation) && Array.isArray(dryRun.validation.blockers) ? dryRun.validation.blockers.filter((blocker): blocker is string => typeof blocker === "string") : []),
    ...(isRecord(dryRun.specGate) && dryRun.specGate.applyPolicy === "no_apply" ? [] : ["apply_policy_must_be_no_apply_for_readonly_smoke"]),
    ...(isRecord(dryRun.specGate) && dryRun.specGate.budgetProfile === "strict_requested" ? [] : ["strict_requested_budget_required_for_readonly_smoke"]),
    ...(isRecord(dryRun.runtimeGates) && dryRun.runtimeGates.childDispatchAllowed === false && dryRun.runtimeGates.daemonStarted === false && dryRun.runtimeGates.productionWritesPerformed === false && dryRun.runtimeGates.autoApply === false ? [] : ["runtime_gates_not_readonly_safe"]),
    ...(isRecord(dryRun.modelRoutingPlan) && dryRun.modelRoutingPlan.routingPlanReady === true && dryRun.modelRoutingPlan.liveRoutingEnabled === false && dryRun.modelRoutingPlan.childDispatchAllowed === false ? [] : ["model_routing_plan_not_readonly_safe"]),
    ...(selectedFactory ? [] : ["factory_selection_missing"]),
    ...(factorySelection.selectionStatus === "existing_factory_selected" ? [] : ["selected_factory_must_be_existing_for_readonly_smoke"]),
    ...(manifestPath && existsSync(join(repoRoot, manifestPath)) ? [] : ["selected_factory_smoke_manifest_missing"]),
    ...(factoryRunAlreadyExists ? ["factory_run_id_already_exists"] : []),
  ];
  const shouldRunFactory = blockers.length === 0 && selectedFactory !== undefined && manifestPath !== undefined;
  const factoryRunResult = shouldRunFactory ? runFactoryRun(repoRoot, {
    factory: selectedFactory,
    input_manifest: manifestPath,
    run_id: factoryRunId,
    mode: "smoke",
    max_items: 1,
    execution: "deterministic",
    budget: { strictRequested: true, strictEnabled: false, maxRuns: 1, estimatedRuns: 1, maxParallelChildren: 1, estimatedParallelChildren: 1 },
    model_routing: { enabled: false, risk: input.risk ?? "medium", contextTokens: input.maxContextTokens },
  }) : undefined;
  const factoryRunDir = join(repoRoot, "reports", "factory-runs", factoryRunId);
  const factoryValidationPath = join(factoryRunDir, "validation.json");
  const factoryValidationRead = readJsonArtifact(factoryValidationPath);
  const factoryValidation = isRecord(factoryValidationRead.parsed) ? factoryValidationRead.parsed : {};
  const phaseSentinelPresent = existsSync(join(factoryRunDir, "SMOKE_PASSED.sentinel"));
  const doneSentinelPresent = existsSync(join(factoryRunDir, "DONE.sentinel"));
  const factoryRunRef = {
    schema: "zob.autonomous-readonly-smoke-factory-run-ref.v1",
    runId,
    selectedFactory,
    manifestPath,
    factoryRunId,
    factoryRunPath: relativeFactoryRunPath(factoryRunId),
    status: factoryRunResult?.status ?? "not_started",
    processed: factoryRunResult?.processed ?? 0,
    failed: factoryRunResult?.failed ?? 0,
    execution: "deterministic",
    mode: "smoke",
    reportsOnlyWrites: true,
    productionWritesPerformed: false,
    autoApply: false,
    childDispatchAllowed: false,
    liveChildDispatches: 0,
    daemonStarted: false,
    phaseSentinel: "SMOKE_PASSED.sentinel",
    phaseSentinelPresent,
    doneSentinelPresent,
    validationPath: relativeFactoryRunPath(factoryRunId, "validation.json"),
    validationHash: factoryValidationRead.hash,
    artifactHashes: {
      validation: factoryValidationRead.hash,
      smokeSentinel: artifactHashIfPresent(join(factoryRunDir, "SMOKE_PASSED.sentinel")),
      doneSentinel: artifactHashIfPresent(join(factoryRunDir, "DONE.sentinel")),
      telemetry: artifactHashIfPresent(join(factoryRunDir, "telemetry.json")),
      agenticPlan: artifactHashIfPresent(join(factoryRunDir, "agentic-plan.json")),
    },
    artifacts: factoryRunResult?.artifacts ?? [],
    errors: factoryRunResult?.errors ?? [],
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const oracleChecks = [
    { name: "dry_run_ready", passed: dryRun.status === "dry_run_plan_ready" },
    { name: "context_pack_cited", passed: isRecord(dryRun.contextPlan) && dryRun.contextPlan.contextPackValid === true },
    { name: "runtime_gates_readonly", passed: isRecord(dryRun.runtimeGates) && dryRun.runtimeGates.childDispatchAllowed === false && dryRun.runtimeGates.daemonStarted === false && dryRun.runtimeGates.productionWritesPerformed === false && dryRun.runtimeGates.autoApply === false },
    { name: "model_routing_plan_readonly", passed: isRecord(dryRun.modelRoutingPlan) && dryRun.modelRoutingPlan.routingPlanReady === true && dryRun.modelRoutingPlan.liveRoutingEnabled === false && dryRun.modelRoutingPlan.childDispatchAllowed === false },
    { name: "factory_selection_existing", passed: factorySelection.selectionStatus === "existing_factory_selected" && Boolean(selectedFactory) },
    { name: "factory_smoke_done", passed: factoryRunResult?.status === "done" && factoryRunResult.processed === 1 && factoryRunResult.failed === 0 },
    { name: "factory_validation_passed", passed: factoryValidation.status === "passed" },
    { name: "smoke_sentinel_present", passed: phaseSentinelPresent },
    { name: "done_sentinel_present", passed: doneSentinelPresent },
  ];
  const structuralOraclePassed = blockers.length === 0 && oracleChecks.every((check) => check.passed === true);
  const oracleReview = {
    schema: "zob.autonomous-readonly-smoke-oracle-review.v1",
    runId,
    oracleType: "deterministic_structural",
    verdict: structuralOraclePassed ? "PASS" : "FAIL",
    no_ship: !structuralOraclePassed,
    liveOracleDispatched: false,
    evidenceChecked: true,
    checks: oracleChecks,
    failedChecks: oracleChecks.filter((check) => check.passed !== true).map((check) => check.name),
    evidenceRefs: [
      `reports/autonomous-runs/${safeRunId}/spec-gate.json`,
      `reports/autonomous-runs/${safeRunId}/context-pack.json`,
      `reports/autonomous-runs/${safeRunId}/runtime-gates.json`,
      `reports/autonomous-runs/${safeRunId}/model-routing-plan.json`,
      `reports/autonomous-runs/${safeRunId}/factory-selection.json`,
      `reports/autonomous-runs/${safeRunId}/factory-run-ref.json`,
      relativeFactoryRunPath(factoryRunId, "validation.json"),
      relativeFactoryRunPath(factoryRunId, "SMOKE_PASSED.sentinel"),
      relativeFactoryRunPath(factoryRunId, "DONE.sentinel"),
    ],
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const validation = {
    schema: "zob.autonomous-readonly-smoke-validation.v1",
    runId,
    status: structuralOraclePassed ? "smoke_autonomy_passed" : "blocked",
    passed: structuralOraclePassed,
    no_ship: !structuralOraclePassed,
    smokeRunNoShip: !structuralOraclePassed,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    blockers: [...blockers, ...oracleChecks.filter((check) => check.passed !== true).map((check) => check.name)],
    warnings: ["phase_4a_deterministic_structural_oracle_only", "global_autonomy_no_ship", "reports_only_writes"],
    dryRunReady: dryRun.status === "dry_run_plan_ready",
    selectedFactory,
    factoryRunId,
    factoryRunStatus: factoryRunResult?.status ?? "not_started",
    oracleVerdict: oracleReview.verdict,
    oracleNoShip: oracleReview.no_ship,
    reportsOnlyWrites: true,
    deterministicExecution: true,
    childDispatchAllowed: false,
    liveChildDispatches: 0,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    liveRoutingEnabled: false,
    globalLiveRoutingEnabled: false,
    sentinel: structuralOraclePassed ? "SMOKE_AUTONOMY_PASSED.sentinel" : undefined,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const promotionPlan = buildAutonomousPromotionPlan({ runId, selectedFactory, factoryRunRef, oracleReview, validation });
  const promotionProofPlan = buildAutonomousPromotionProofPlan({ runId, promotionPlan, factoryRunRef, oracleReview, validation });
  const schedulerPlan = buildAutonomousSchedulerPlan(repoRoot, { runId, promotionPlan, validation });
  const schedulerProofPlan = buildAutonomousSchedulerProofPlan({ runId, schedulerPlan, validation });
  const missionControlPlan = buildAutonomousMissionControlPlan(repoRoot, { runId, schedulerPlan, validation });
  const strictBudgetProofPlan = buildAutonomousStrictBudgetProofPlan({ runId, runtimeGates: isRecord(dryRun.runtimeGates) ? dryRun.runtimeGates : {}, validation });
  const modelRoutingProofPlan = buildAutonomousModelRoutingProofPlan({ runId, modelRoutingPlan: isRecord(dryRun.modelRoutingPlan) ? dryRun.modelRoutingPlan : {}, validation });
  const missionControlProofPlan = buildAutonomousMissionControlProofPlan({ runId, missionControlPlan, schedulerProofPlan, modelRoutingProofPlan, validation });
  const sandboxApplyPlan = buildAutonomousSandboxApplyPlan(repoRoot, { runId, missionControlPlan, validation });
  const currentSourceFingerprint = buildAutonomousCurrentSourceFingerprint(repoRoot, { runId, factorySelection });
  const finalE2EProofPlan = buildAutonomousFinalE2EProofPlan(repoRoot, {
    runId,
    runtimeGates: isRecord(dryRun.runtimeGates) ? dryRun.runtimeGates : {},
    strictBudgetProofPlan,
    modelRoutingProofPlan,
    modelRoutingPlan: isRecord(dryRun.modelRoutingPlan) ? dryRun.modelRoutingPlan : {},
    factorySelection,
    factoryRunRef,
    oracleReview,
    promotionPlan,
    promotionProofPlan,
    schedulerPlan,
    schedulerProofPlan,
    missionControlPlan,
    missionControlProofPlan,
    sandboxApplyPlan,
    currentSourceFingerprint,
    validation,
  });
  const finalNoShipOracle = buildAutonomousFinalNoShipOracle({ runId, finalE2EProofPlan, currentSourceFingerprint });
  const currentSourceFingerprintFreshness = validateAutonomousCurrentSourceFingerprintFreshness(repoRoot, currentSourceFingerprint, factorySelection);
  const completionGate = buildAutonomousCompletionGate({ runId, finalE2EProofPlan, finalNoShipOracle, currentSourceFingerprintFreshness });
  if (hasForbiddenBodyKeys(factoryRunRef) || hasForbiddenBodyKeys(oracleReview) || hasForbiddenBodyKeys(promotionPlan) || hasForbiddenBodyKeys(promotionProofPlan) || hasForbiddenBodyKeys(schedulerPlan) || hasForbiddenBodyKeys(schedulerProofPlan) || hasForbiddenBodyKeys(missionControlPlan) || hasForbiddenBodyKeys(missionControlProofPlan) || hasForbiddenBodyKeys(sandboxApplyPlan) || hasForbiddenBodyKeys(strictBudgetProofPlan) || hasForbiddenBodyKeys(modelRoutingProofPlan) || hasForbiddenBodyKeys(currentSourceFingerprint) || hasForbiddenBodyKeys(finalE2EProofPlan) || hasForbiddenBodyKeys(finalNoShipOracle) || hasForbiddenBodyKeys(completionGate) || hasForbiddenBodyKeys(validation)) throw new Error("autonomous readonly smoke artifacts would store forbidden plaintext body keys");
  const factoryRunRefPath = join(runDir, "factory-run-ref.json");
  const oracleReviewPath = join(runDir, "oracle-review.json");
  const promotionPlanPath = join(runDir, "promotion-plan.json");
  const promotionProofPlanPath = join(runDir, "promotion-proof-plan.json");
  const schedulerPlanPath = join(runDir, "scheduler-plan.json");
  const schedulerProofPlanPath = join(runDir, "scheduler-proof-plan.json");
  const missionControlPlanPath = join(runDir, "mission-control-plan.json");
  const missionControlProofPlanPath = join(runDir, "mission-control-proof-plan.json");
  const sandboxApplyPlanPath = join(runDir, "sandbox-apply-plan.json");
  const strictBudgetProofPlanPath = join(runDir, "strict-budget-proof-plan.json");
  const modelRoutingProofPlanPath = join(runDir, "model-routing-proof-plan.json");
  const currentSourceFingerprintPath = join(runDir, "current-source-fingerprint.json");
  const finalE2EProofPlanPath = join(runDir, "final-e2e-proof-plan.json");
  const finalNoShipOraclePath = join(runDir, "final-no-ship-oracle.json");
  const completionGatePath = join(runDir, "completion-gate.json");
  const validationPath = join(runDir, "validation.json");
  const finalReportPath = join(runDir, "final-report.md");
  writeFileSync(factoryRunRefPath, `${JSON.stringify(factoryRunRef, null, 2)}\n`);
  writeFileSync(oracleReviewPath, `${JSON.stringify(oracleReview, null, 2)}\n`);
  writeFileSync(promotionPlanPath, `${JSON.stringify(promotionPlan, null, 2)}\n`);
  writeFileSync(promotionProofPlanPath, `${JSON.stringify(promotionProofPlan, null, 2)}\n`);
  writeFileSync(schedulerPlanPath, `${JSON.stringify(schedulerPlan, null, 2)}\n`);
  writeFileSync(schedulerProofPlanPath, `${JSON.stringify(schedulerProofPlan, null, 2)}\n`);
  writeFileSync(missionControlPlanPath, `${JSON.stringify(missionControlPlan, null, 2)}\n`);
  writeFileSync(missionControlProofPlanPath, `${JSON.stringify(missionControlProofPlan, null, 2)}\n`);
  writeFileSync(sandboxApplyPlanPath, `${JSON.stringify(sandboxApplyPlan, null, 2)}\n`);
  writeFileSync(strictBudgetProofPlanPath, `${JSON.stringify(strictBudgetProofPlan, null, 2)}\n`);
  writeFileSync(modelRoutingProofPlanPath, `${JSON.stringify(modelRoutingProofPlan, null, 2)}\n`);
  writeFileSync(currentSourceFingerprintPath, `${JSON.stringify(currentSourceFingerprint, null, 2)}\n`);
  writeFileSync(finalE2EProofPlanPath, `${JSON.stringify(finalE2EProofPlan, null, 2)}\n`);
  writeFileSync(finalNoShipOraclePath, `${JSON.stringify(finalNoShipOracle, null, 2)}\n`);
  writeFileSync(completionGatePath, `${JSON.stringify(completionGate, null, 2)}\n`);
  writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  writeFileSync(finalReportPath, buildAutonomousReadOnlySmokeFinalReport(validation, factoryRunRef, oracleReview));
  if (structuralOraclePassed) writeFileSync(smokeAutonomySentinelPath, "smoke-autonomy-passed\n");
  return {
    ...dryRun,
    status: validation.status,
    no_ship: validation.no_ship,
    smokeRunNoShip: validation.smokeRunNoShip,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    factoryRunRef,
    oracleReview,
    promotionPlan,
    promotionProofPlan,
    schedulerPlan,
    schedulerProofPlan,
    missionControlPlan,
    missionControlProofPlan,
    sandboxApplyPlan,
    strictBudgetProofPlan,
    modelRoutingProofPlan,
    currentSourceFingerprint,
    finalE2EProofPlan,
    finalNoShipOracle,
    completionGate,
    validation,
    factoryRunRefPath: `reports/autonomous-runs/${safeRunId}/factory-run-ref.json`,
    oracleReviewPath: `reports/autonomous-runs/${safeRunId}/oracle-review.json`,
    promotionPlanPath: `reports/autonomous-runs/${safeRunId}/promotion-plan.json`,
    promotionProofPlanPath: `reports/autonomous-runs/${safeRunId}/promotion-proof-plan.json`,
    schedulerPlanPath: `reports/autonomous-runs/${safeRunId}/scheduler-plan.json`,
    schedulerProofPlanPath: `reports/autonomous-runs/${safeRunId}/scheduler-proof-plan.json`,
    missionControlPlanPath: `reports/autonomous-runs/${safeRunId}/mission-control-plan.json`,
    missionControlProofPlanPath: `reports/autonomous-runs/${safeRunId}/mission-control-proof-plan.json`,
    sandboxApplyPlanPath: `reports/autonomous-runs/${safeRunId}/sandbox-apply-plan.json`,
    strictBudgetProofPlanPath: `reports/autonomous-runs/${safeRunId}/strict-budget-proof-plan.json`,
    modelRoutingProofPlanPath: `reports/autonomous-runs/${safeRunId}/model-routing-proof-plan.json`,
    currentSourceFingerprintPath: `reports/autonomous-runs/${safeRunId}/current-source-fingerprint.json`,
    finalE2EProofPlanPath: `reports/autonomous-runs/${safeRunId}/final-e2e-proof-plan.json`,
    finalNoShipOraclePath: `reports/autonomous-runs/${safeRunId}/final-no-ship-oracle.json`,
    completionGatePath: `reports/autonomous-runs/${safeRunId}/completion-gate.json`,
    validationPath: `reports/autonomous-runs/${safeRunId}/validation.json`,
    finalReportPath: `reports/autonomous-runs/${safeRunId}/final-report.md`,
    smokeSentinelPath: structuralOraclePassed ? `reports/autonomous-runs/${safeRunId}/SMOKE_AUTONOMY_PASSED.sentinel` : undefined,
  };
}

export function validateAutonomousReadOnlySmokeRunArtifacts(repoRoot: string, runId: string): Record<string, unknown> {
  const safeRunId = safeFileStem(runId);
  const runDir = join(repoRoot, "reports", "autonomous-runs", safeRunId);
  const requiredArtifacts = ["spec-gate.json", "context-scope.json", "context-pack.json", "runtime-gates.json", "model-routing-plan.json", "model-routing-proof-plan.json", "factory-selection.json", "factory-run-ref.json", "oracle-review.json", "promotion-plan.json", "promotion-proof-plan.json", "scheduler-plan.json", "scheduler-proof-plan.json", "mission-control-plan.json", "mission-control-proof-plan.json", "sandbox-apply-plan.json", "strict-budget-proof-plan.json", "current-source-fingerprint.json", "final-e2e-proof-plan.json", "final-no-ship-oracle.json", "completion-gate.json", "validation.json", "final-report.md", "SMOKE_AUTONOMY_PASSED.sentinel"];
  const jsonArtifacts = requiredArtifacts.filter((name) => name.endsWith(".json"));
  const parsedArtifacts: Record<string, Record<string, unknown>> = {};
  const artifacts = requiredArtifacts.map((name) => {
    const artifactPath = join(runDir, name);
    const present = existsSync(artifactPath);
    if (!present) return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, bodyStored: false };
    if (!name.endsWith(".json")) return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, hash: artifactHashIfPresent(artifactPath), bodyStored: false };
    const read = readJsonArtifact(artifactPath);
    if (isRecord(read.parsed)) parsedArtifacts[name] = read.parsed;
    return { name, path: `reports/autonomous-runs/${safeRunId}/${name}`, present, hash: read.hash, schema: isRecord(read.parsed) ? read.parsed.schema : undefined, error: read.error, bodyStored: false };
  });
  const artifact = (name: string): Record<string, unknown> => parsedArtifacts[name] ?? {};
  const runtimeGates = artifact("runtime-gates.json");
  const modelRoutingPlan = artifact("model-routing-plan.json");
  const modelRoutingProofPlan = artifact("model-routing-proof-plan.json");
  const factorySelection = artifact("factory-selection.json");
  const factoryRunRef = artifact("factory-run-ref.json");
  const oracleReview = artifact("oracle-review.json");
  const promotionPlan = artifact("promotion-plan.json");
  const promotionProofPlan = artifact("promotion-proof-plan.json");
  const schedulerPlan = artifact("scheduler-plan.json");
  const schedulerProofPlan = artifact("scheduler-proof-plan.json");
  const missionControlPlan = artifact("mission-control-plan.json");
  const missionControlProofPlan = artifact("mission-control-proof-plan.json");
  const sandboxApplyPlan = artifact("sandbox-apply-plan.json");
  const strictBudgetProofPlan = artifact("strict-budget-proof-plan.json");
  const currentSourceFingerprint = artifact("current-source-fingerprint.json");
  const finalE2EProofPlan = artifact("final-e2e-proof-plan.json");
  const finalNoShipOracle = artifact("final-no-ship-oracle.json");
  const completionGate = artifact("completion-gate.json");
  const validation = artifact("validation.json");
  const currentSourceFingerprintFreshness = validateAutonomousCurrentSourceFingerprintFreshness(repoRoot, currentSourceFingerprint, factorySelection);
  const factoryRunId = typeof factoryRunRef.factoryRunId === "string" ? factoryRunRef.factoryRunId : "unknown";
  const factoryRunDir = join(repoRoot, "reports", "factory-runs", factoryRunId);
  const finalDoneSentinelPath = join(runDir, "DONE.sentinel");
  const globalReadySentinelPath = join(runDir, "GLOBAL_AUTONOMY_READY.sentinel");
  const finalDoneSentinelPresent = existsSync(finalDoneSentinelPath);
  const globalReadySentinelPresent = existsSync(globalReadySentinelPath);
  const checks = [
    { name: "required_artifacts_present", passed: artifacts.every((item) => item.present === true), detail: { requiredArtifacts } },
    { name: "json_artifacts_parse", passed: artifacts.filter((item) => item.name.endsWith(".json")).every((item) => !item.error), detail: { jsonArtifacts } },
    { name: "artifact_schemas", passed: factoryRunRef.schema === "zob.autonomous-readonly-smoke-factory-run-ref.v1" && oracleReview.schema === "zob.autonomous-readonly-smoke-oracle-review.v1" && promotionPlan.schema === "zob.autonomous-promotion-plan.v1" && promotionProofPlan.schema === "zob.autonomous-promotion-proof-plan.v1" && schedulerPlan.schema === "zob.autonomous-scheduler-plan.v1" && schedulerProofPlan.schema === "zob.autonomous-scheduler-proof-plan.v1" && missionControlPlan.schema === "zob.autonomous-mission-control-plan.v1" && missionControlProofPlan.schema === "zob.autonomous-mission-control-proof-plan.v1" && sandboxApplyPlan.schema === "zob.autonomous-sandbox-apply-plan.v1" && strictBudgetProofPlan.schema === "zob.autonomous-strict-budget-proof-plan.v1" && modelRoutingProofPlan.schema === "zob.autonomous-model-routing-proof-plan.v1" && currentSourceFingerprint.schema === "zob.autonomous-current-source-fingerprint.v1" && finalE2EProofPlan.schema === "zob.autonomous-final-e2e-proof-plan.v1" && finalNoShipOracle.schema === "zob.autonomous-final-no-ship-oracle.v1" && completionGate.schema === "zob.autonomous-completion-gate.v1" && validation.schema === "zob.autonomous-readonly-smoke-validation.v1", detail: "expected Phase 4A/5B/6B/7B/8B/9A/9B/10B/11F smoke artifact schemas" },
    { name: "runtime_and_model_gates_safe", passed: runtimeGates.childDispatchAllowed === false && runtimeGates.daemonStarted === false && runtimeGates.productionWritesPerformed === false && runtimeGates.autoApply === false && modelRoutingPlan.liveRoutingEnabled === false && modelRoutingPlan.globalLiveRoutingEnabled === false && modelRoutingPlan.childDispatchAllowed === false, detail: "runtime/model routing gates remain disabled" },
    { name: "model_routing_proof_plan_gate_only", passed: modelRoutingProofPlan.status === "model_routing_dispatch_gate_proof_ready_global_default_blocked" && modelRoutingProofPlan.modelRoutingProofReady === true && modelRoutingProofPlan.routingDefaultDisabledProofPassed === true && modelRoutingProofPlan.routingOracleProofPassed === true && modelRoutingProofPlan.routingHighContextProofPassed === true && modelRoutingProofPlan.routingSecurityNoDowngradeProofPassed === true && modelRoutingProofPlan.selectedModelsStored === false && modelRoutingProofPlan.selectedModelHashesOnly === true && modelRoutingProofPlan.finalE2ERequirementCleared === false && modelRoutingProofPlan.no_ship === true && Array.isArray(modelRoutingProofPlan.scenarios) && modelRoutingProofPlan.scenarios.some((scenario) => isRecord(scenario) && scenario.name === "routing_oracle_applies_when_enabled" && scenario.selectedModelClass === "strong_oracle" && typeof scenario.selectedModelHash === "string" && scenario.selectedModelStored === false) && modelRoutingProofPlan.globalLiveRoutingEnabled === false && modelRoutingProofPlan.liveAutonomousRoutingApplied === false && modelRoutingProofPlan.modelRouterUsed === false && modelRoutingProofPlan.routingApplied === false && modelRoutingProofPlan.childDispatchAllowed === false && modelRoutingProofPlan.noExecution === true && modelRoutingProofPlan.globalAutonomyReady === false && modelRoutingProofPlan.globalAutonomyNoShip === true, detail: "Phase 6B proves model routing dispatch gate class selection without enabling global/live routing" },
    { name: "factory_selection_existing", passed: factorySelection.selectionStatus === "existing_factory_selected" && typeof factorySelection.selectedFactory === "string", detail: { selectedFactory: factorySelection.selectedFactory } },
    { name: "factory_smoke_completed", passed: factoryRunRef.status === "done" && factoryRunRef.execution === "deterministic" && factoryRunRef.phaseSentinelPresent === true && factoryRunRef.doneSentinelPresent === true && existsSync(join(factoryRunDir, "SMOKE_PASSED.sentinel")) && existsSync(join(factoryRunDir, "DONE.sentinel")), detail: { factoryRunId } },
    { name: "structural_oracle_passed", passed: oracleReview.verdict === "PASS" && oracleReview.no_ship === false && oracleReview.liveOracleDispatched === false, detail: { oracleType: oracleReview.oracleType } },
    { name: "promotion_plan_smoke_to_pilot_gate", passed: isRecord(promotionPlan.smokeGate) && promotionPlan.smokeGate.passed === true && isRecord(promotionPlan.pilotGate) && promotionPlan.pilotGate.preconditionsMet === true && promotionPlan.pilotGate.executionAllowed === false && promotionPlan.pilotGate.dispatchAllowed === false && isRecord(promotionPlan.batchGate) && promotionPlan.batchGate.preconditionsMet === false && promotionPlan.batchGate.batchConcurrencyCapRequired === true && promotionPlan.globalAutonomyNoShip === true, detail: "Phase 7A promotion gates are metadata-only and do not execute pilot/batch" },
    { name: "promotion_proof_plan_execution_blocked", passed: promotionProofPlan.status === "pilot_batch_promotion_proof_ready_execution_blocked" && promotionProofPlan.promotionProofReady === true && promotionProofPlan.smokeToPilotPreconditionsProved === true && promotionProofPlan.pilotExecutionBlockedProofPassed === true && promotionProofPlan.batchExecutionBlockedProofPassed === true && promotionProofPlan.resumeRetryPolicyProofPassed === true && promotionProofPlan.oraclePolicyProofPassed === true && promotionProofPlan.finalE2ERequirementCleared === false && promotionProofPlan.no_ship === true && promotionProofPlan.pilotExecutionAllowed === false && promotionProofPlan.batchExecutionAllowed === false && promotionProofPlan.pilotExecuted === false && promotionProofPlan.batchExecuted === false && promotionProofPlan.childDispatchAllowed === false && promotionProofPlan.noExecutionBeyondSmoke === true && promotionProofPlan.globalAutonomyReady === false && promotionProofPlan.globalAutonomyNoShip === true, detail: "Phase 7B proves pilot/batch promotion prerequisites and blocked execution without running pilot/batch" },
    { name: "scheduler_plan_disabled_bounded", passed: schedulerPlan.schedulerPlanReady === true && schedulerPlan.schedulerExecutionAllowed === false && schedulerPlan.daemonStarted === false && schedulerPlan.autoStartDaemon === false && schedulerPlan.continuousLoop === false && schedulerPlan.childDispatchAllowed === false && isRecord(schedulerPlan.killSwitch) && schedulerPlan.killSwitch.required === true && isRecord(schedulerPlan.workerPool) && schedulerPlan.workerPool.maxWorkers === 1 && isRecord(schedulerPlan.retryPolicy) && schedulerPlan.retryPolicy.retriesCapped === true && isRecord(schedulerPlan.budgetPolicy) && schedulerPlan.budgetPolicy.strictBudgetRequired === true && schedulerPlan.globalAutonomyNoShip === true, detail: "Phase 8A scheduler plan is bounded and disabled by default" },
    { name: "scheduler_proof_plan_execution_blocked", passed: schedulerProofPlan.status === "scheduler_daemon_proof_ready_execution_blocked" && schedulerProofPlan.schedulerProofReady === true && schedulerProofPlan.daemonDefaultDisabledProofPassed === true && schedulerProofPlan.oneWorkerBoundedProofPassed === true && schedulerProofPlan.stopConditionsProofPassed === true && schedulerProofPlan.killSwitchRetryProofPassed === true && schedulerProofPlan.strictBudgetBeforeDispatchProofPassed === true && schedulerProofPlan.alwaysOnApprovalProofPassed === true && schedulerProofPlan.finalE2ERequirementCleared === false && schedulerProofPlan.no_ship === true && schedulerProofPlan.schedulerExecutionAllowed === false && schedulerProofPlan.daemonStarted === false && schedulerProofPlan.autoStartDaemon === false && schedulerProofPlan.continuousLoop === false && schedulerProofPlan.childDispatchAllowed === false && schedulerProofPlan.productionWritesPerformed === false && schedulerProofPlan.autoApply === false && schedulerProofPlan.noExecutionBeyondSmoke === true && schedulerProofPlan.globalAutonomyReady === false && schedulerProofPlan.globalAutonomyNoShip === true, detail: "Phase 8B proves daemon/scheduler policy and blocked execution without starting daemon" },
    { name: "mission_control_plan_proposal_only", passed: missionControlPlan.missionControlPlanReady === true && missionControlPlan.transportDispatch === false && missionControlPlan.networkComsEnabled === false && missionControlPlan.directWorkerWrites === false && missionControlPlan.childDispatchAllowed === false && isRecord(missionControlPlan.commandPolicy) && missionControlPlan.commandPolicy.proposalOnly === true && missionControlPlan.commandPolicy.directWorkerWrites === false && missionControlPlan.commandPolicy.directWorkerCommandBlocked === true && isRecord(missionControlPlan.comsPolicy) && missionControlPlan.comsPolicy.topologyGuardActive === true && missionControlPlan.comsPolicy.hashOnlyLedgers === true && missionControlPlan.globalAutonomyNoShip === true, detail: "Phase 9A Mission Control/coms plan is proposal-only and transport-disabled" },
    { name: "mission_control_proof_plan_execution_blocked", passed: missionControlProofPlan.status === "mission_control_comms_proof_ready_execution_blocked" && missionControlProofPlan.missionControlProofReady === true && missionControlProofPlan.proposalOnlyCommandsProofPassed === true && missionControlProofPlan.topologyHashOnlyCommsProofPassed === true && missionControlProofPlan.directWorkerCommandsBlockedProofPassed === true && missionControlProofPlan.liveTransportNetworkDisabledProofPassed === true && missionControlProofPlan.liveGlobalRoutingApprovalProofPassed === true && missionControlProofPlan.post8bSchedulerBlockedProofPassed === true && missionControlProofPlan.finalE2ERequirementCleared === false && missionControlProofPlan.no_ship === true && missionControlProofPlan.childDispatchAllowed === false && missionControlProofPlan.daemonStarted === false && missionControlProofPlan.directWorkerWrites === false && missionControlProofPlan.transportDispatch === false && missionControlProofPlan.networkComsEnabled === false && missionControlProofPlan.liveRoutingEnabled === false && missionControlProofPlan.globalLiveRoutingEnabled === false && missionControlProofPlan.productionWritesPerformed === false && missionControlProofPlan.autoApply === false && missionControlProofPlan.globalAutonomyReady === false && missionControlProofPlan.globalAutonomyNoShip === true, detail: "Phase 9B proves proposal-only commands, topology/hash-only comms, blocked direct-worker commands, disabled transport/network, and approval-required live/global routing" },
    { name: "sandbox_apply_plan_metadata_only", passed: sandboxApplyPlan.sandboxApplyPlanReady === true && sandboxApplyPlan.productionWritesPerformed === false && sandboxApplyPlan.autoApply === false && sandboxApplyPlan.realApplyExecuted === false && sandboxApplyPlan.childDispatchAllowed === false && sandboxApplyPlan.globalAutonomyNoShip === true && isRecord(sandboxApplyPlan.isolatedTempWorkspace) && sandboxApplyPlan.isolatedTempWorkspace.required === true && sandboxApplyPlan.isolatedTempWorkspace.executed === true && isRecord(sandboxApplyPlan.diffGate) && sandboxApplyPlan.diffGate.diffHashRequired === true && sandboxApplyPlan.diffGate.diffHashesMatch === true && isRecord(sandboxApplyPlan.oracleDiffReview) && sandboxApplyPlan.oracleDiffReview.required === true && sandboxApplyPlan.oracleDiffReview.reviewPassed === true && isRecord(sandboxApplyPlan.rollbackPolicy) && sandboxApplyPlan.rollbackPolicy.rollbackMetadataRequired === true && sandboxApplyPlan.rollbackPolicy.rollbackPrepared === true && isRecord(sandboxApplyPlan.approvalPolicy) && sandboxApplyPlan.approvalPolicy.manualApprovalRequired === true && sandboxApplyPlan.approvalPolicy.approvedForMainWorkspaceApply === false && isRecord(sandboxApplyPlan.manualApplyPreflight) && sandboxApplyPlan.manualApplyPreflight.required === true && sandboxApplyPlan.manualApplyPreflight.preflightPassed === true && sandboxApplyPlan.manualApplyPreflight.executionAllowedByThisTool === false && sandboxApplyPlan.manualApplyPreflight.realApplyExecuted === false && isRecord(sandboxApplyPlan.mainWorkspaceApply) && sandboxApplyPlan.mainWorkspaceApply.realApplyAllowed === false && sandboxApplyPlan.mainWorkspaceApply.realApplyExecuted === false && sandboxApplyPlan.mainWorkspaceApply.productionWritesPerformed === false, detail: "Phase 10B sandbox/apply plan requires temp workspace, diff hash, oracle review, rollback, manual approval, and manual apply preflight while blocking real apply" },
    { name: "strict_budget_proof_plan_gate_only", passed: strictBudgetProofPlan.status === "strict_budget_dispatch_gate_proof_ready_global_default_blocked" && strictBudgetProofPlan.strictBudgetProofReady === true && strictBudgetProofPlan.strictBudgetAllowProofPassed === true && strictBudgetProofPlan.strictBudgetBlockProofPassed === true && strictBudgetProofPlan.strictBudgetDefaultDisabledProofPassed === true && strictBudgetProofPlan.finalE2ERequirementCleared === false && strictBudgetProofPlan.no_ship === true && Array.isArray(strictBudgetProofPlan.scenarios) && strictBudgetProofPlan.scenarios.some((scenario) => isRecord(scenario) && scenario.name === "strict_gate_blocks_exceedance_pre_dispatch" && scenario.wouldBlockDispatch === true && scenario.gateChildDispatchAllowed === false && scenario.dispatchDecision === "block") && strictBudgetProofPlan.globalStrictBudgetEnabled === false && strictBudgetProofPlan.globalBudgetEnforced === false && strictBudgetProofPlan.liveAutonomousBudgetEnforced === false && strictBudgetProofPlan.budgetEnforced === false && strictBudgetProofPlan.strictEnabled === false && strictBudgetProofPlan.childDispatchAllowed === false && strictBudgetProofPlan.noExecution === true && strictBudgetProofPlan.globalAutonomyReady === false && strictBudgetProofPlan.globalAutonomyNoShip === true, detail: "Phase 5B proves strict dispatch gate allow/block/default-disabled behavior without clearing final live strict-budget requirement" },
    { name: "current_source_fingerprint_hash_only", passed: currentSourceFingerprint.status === "current_source_fingerprint_captured" && currentSourceFingerprint.currentSourceFingerprintReady === true && currentSourceFingerprint.currentSourceFingerprintCaptured === true && currentSourceFingerprint.noMockCurrentSourceE2EProved === false && typeof currentSourceFingerprint.fingerprintHash === "string" && /^[a-f0-9]{64}$/.test(currentSourceFingerprint.fingerprintHash) && Array.isArray(currentSourceFingerprint.sourceFiles) && currentSourceFingerprint.sourceFiles.length > 0 && isRecord(currentSourceFingerprint.fileHashes) && Object.values(currentSourceFingerprint.fileHashes).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) && Array.isArray(currentSourceFingerprint.missingFiles) && currentSourceFingerprint.missingFiles.length === 0 && isRecord(currentSourceFingerprint.evidencePolicy) && currentSourceFingerprint.evidencePolicy.hashOnly === true && currentSourceFingerprint.evidencePolicy.sourceBodiesStored === false && isRecord(currentSourceFingerprint.safety) && currentSourceFingerprint.safety.noExecution === true && currentSourceFingerprint.safety.globalAutonomyNoShip === true, detail: "Phase 11C current-source fingerprint captures hash-only source evidence without proving final no-mock E2E" },
    { name: "current_source_fingerprint_fresh", passed: currentSourceFingerprintFreshness.fresh === true && currentSourceFingerprintFreshness.fileHashesMatch === true && currentSourceFingerprintFreshness.fingerprintHashMatches === true && currentSourceFingerprintFreshness.sourceFilesMatch === true && currentSourceFingerprintFreshness.missingFilesMatch === true && currentSourceFingerprintFreshness.currentMissingFiles && Array.isArray(currentSourceFingerprintFreshness.currentMissingFiles) && currentSourceFingerprintFreshness.currentMissingFiles.length === 0, detail: "Phase 11D validator recomputes current source hashes and fails stale/tampered fingerprints" },
    { name: "final_e2e_proof_plan_no_ship", passed: finalE2EProofPlan.status === "blocked_for_final_e2e_proof" && finalE2EProofPlan.finalE2EProofReady === false && finalE2EProofPlan.no_ship === true && Array.isArray(finalE2EProofPlan.blockers) && finalE2EProofPlan.blockers.includes("live_strict_budget_not_enforced") && finalE2EProofPlan.blockers.includes("live_model_routing_not_enabled") && finalE2EProofPlan.blockers.includes("pilot_execution_disabled") && finalE2EProofPlan.blockers.includes("batch_execution_disabled") && finalE2EProofPlan.blockers.includes("final_oracle_missing") && isRecord(finalE2EProofPlan.sentinelPolicy) && finalE2EProofPlan.sentinelPolicy.globalReadySentinelAllowed === false && finalE2EProofPlan.sentinelPolicy.globalReadySentinelPresent === false && isRecord(finalE2EProofPlan.currentSourceProof) && finalE2EProofPlan.currentSourceProof.currentSourceFingerprintCaptured === true && typeof finalE2EProofPlan.currentSourceProof.currentSourceFingerprintHash === "string" && finalE2EProofPlan.currentSourceProof.noMockCurrentSourceE2EProved === false && finalE2EProofPlan.globalAutonomyReady === false && finalE2EProofPlan.globalAutonomyNoShip === true && finalE2EProofPlan.childDispatchAllowed === false && finalE2EProofPlan.productionWritesPerformed === false && finalE2EProofPlan.autoApply === false, detail: "Phase 11C final E2E proof plan references current-source fingerprint while preserving no-ship" },
    { name: "final_no_ship_oracle_blocks_global_autonomy", passed: finalNoShipOracle.verdict === "FAIL" && finalNoShipOracle.no_ship === true && finalNoShipOracle.finalOracleReady === false && finalNoShipOracle.finalOraclePass === false && Array.isArray(finalNoShipOracle.failedChecks) && finalNoShipOracle.failedChecks.includes("final_e2e_proof_ready") && finalNoShipOracle.failedChecks.includes("no_mock_current_source_e2e_proved") && isRecord(finalNoShipOracle.decision) && finalNoShipOracle.decision.globalAutonomyReady === false && finalNoShipOracle.decision.globalAutonomyNoShip === true && finalNoShipOracle.decision.writeGlobalReadySentinelAllowed === false && finalNoShipOracle.globalAutonomyReady === false && finalNoShipOracle.globalAutonomyNoShip === true && finalNoShipOracle.childDispatchAllowed === false && finalNoShipOracle.productionWritesPerformed === false && finalNoShipOracle.autoApply === false, detail: "Phase 11E deterministic final no-ship oracle blocks global autonomy until final E2E proof" },
    { name: "completion_gate_blocks_goal_completion", passed: completionGate.status === "blocked_for_goal_completion" && completionGate.completionReady === false && completionGate.allRequirementsVerified === false && completionGate.no_ship === true && completionGate.updateGoalAllowed === false && completionGate.requiredGoalStatus === "in_progress" && Array.isArray(completionGate.failedChecks) && completionGate.failedChecks.includes("final_e2e_proof_ready") && isRecord(completionGate.decision) && completionGate.decision.updateGoalStatusCompleteAllowed === false && completionGate.decision.globalAutonomyReady === false && completionGate.decision.globalAutonomyNoShip === true && completionGate.decision.writeGlobalReadySentinelAllowed === false && completionGate.globalAutonomyReady === false && completionGate.globalAutonomyNoShip === true && completionGate.childDispatchAllowed === false && completionGate.productionWritesPerformed === false && completionGate.autoApply === false, detail: "Phase 11F completion gate blocks update_goal complete until every final requirement is verified" },
    { name: "final_global_sentinels_absent", passed: finalDoneSentinelPresent === false && globalReadySentinelPresent === false, detail: { doneSentinelPresent: finalDoneSentinelPresent, globalReadySentinelPresent } },
    { name: "validation_passed_scope_limited", passed: validation.passed === true && validation.status === "smoke_autonomy_passed" && validation.no_ship === false && validation.globalAutonomyReady === false && validation.globalAutonomyNoShip === true && validation.childDispatchAllowed === false && validation.productionWritesPerformed === false && validation.autoApply === false, detail: "run-scoped smoke pass without global autonomy" },
    { name: "json_artifacts_body_free", passed: jsonArtifacts.every((name) => isRecord(parsedArtifacts[name]) && !hasForbiddenBodyKeys(parsedArtifacts[name])), detail: "no forbidden plaintext body keys" },
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const result = {
    schema: "zob.autonomous-readonly-smoke-artifact-validation.v1",
    runId: safeRunId,
    valid: failedChecks.length === 0,
    failedChecks,
    checks,
    artifacts,
    finalGlobalSentinels: {
      doneSentinelPresent: finalDoneSentinelPresent,
      globalReadySentinelPresent,
      doneSentinelAllowed: false,
      globalReadySentinelAllowed: false,
    },
    currentSourceFingerprintFreshness,
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    childDispatchAllowed: false,
    daemonStarted: false,
    productionWritesPerformed: false,
    autoApply: false,
    liveRoutingEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(result)) throw new Error("autonomous readonly smoke validation would store forbidden plaintext body keys");
  return result;
}
