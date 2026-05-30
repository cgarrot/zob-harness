import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveComputeProfile } from "../compute-profile.js";
import { writeFactoryTelemetrySummary } from "../telemetry.js";
import type { FactoryAdaptiveDispatchGate, FactoryDefinition, FactoryInputManifest, FactoryManifestItem, FactoryRunInput, FactoryRunResult } from "../types.js";
import { sha256 } from "../utils/hashing.js";
import { resolveRepoPath, safeFileStem, safeRunId } from "../utils/paths.js";
import { buildFactoryAgenticPlan, detectCanonicalPatterns } from "./agentic-plan.js";
import { buildInitialAdaptiveDelegationGovernorState, normalizeAdaptiveDelegationPolicy } from "../orchestration/adaptive-delegation.js";
import { FACTORY_PHASE_SENTINELS, factoryPhaseSentinelForMode, loadFactoryDefinition, loadFactoryInputManifest, loadFactoryOracleReview, normalizeFactoryAdaptiveDispatchGate, summarizeFactoryOracleReview, validateFactoryRunInputs } from "./validation.js";

export function buildAgenticFactoryNoMockFinalGate(input: {
  status: string;
  tasks: number;
  completed: number;
  failed: number;
  liveDispatches: number;
  mockedDispatches: number;
  outputContractsValidated: number;
  childSessionPaths: number;
  phaseSentinelWritten: boolean;
  doneSentinelWritten: boolean;
}): { noMockReady: boolean; finalGate: Record<string, unknown> } {
  const noMockReady = input.status === "passed"
    && input.tasks > 0
    && input.completed === input.tasks
    && input.failed === 0
    && input.liveDispatches === input.tasks
    && input.mockedDispatches === 0
    && input.outputContractsValidated === input.tasks
    && input.childSessionPaths === input.liveDispatches
    && input.phaseSentinelWritten === true
    && input.doneSentinelWritten === true;
  const reason = noMockReady
    ? "all agentic factory stages completed through live_child_pi with output contracts, child sessions, phase sentinel, and DONE sentinel"
    : input.failed > 0
      ? "one or more agentic factory stages failed"
      : input.mockedDispatches > 0
        ? "mocked agentic factory dispatches were observed"
        : input.liveDispatches !== input.tasks
          ? "not all agentic factory stages have live_child_pi evidence"
          : input.outputContractsValidated !== input.tasks
            ? "not all agentic factory stage outputs passed output-contract validation"
            : input.childSessionPaths !== input.liveDispatches
              ? "live child session paths are missing"
              : !input.phaseSentinelWritten || !input.doneSentinelWritten
                ? "agentic factory sentinels are missing"
                : "agentic factory lifecycle is incomplete for no-mock readiness";
  return {
    noMockReady,
    finalGate: {
      schema: "zob.agentic-factory-final-gate.v1",
      status: noMockReady ? "passed_live_no_mock" : "not_ready",
      passed: noMockReady,
      no_ship: !noMockReady,
      reason,
      requiresLiveChildEvidence: true,
      requiresNoMocks: true,
      requiresOutputContracts: true,
      requiresSentinels: true,
      liveDispatches: input.liveDispatches,
      mockedDispatches: input.mockedDispatches,
      outputContractsValidated: input.outputContractsValidated === input.tasks && input.tasks > 0,
      childSessionPaths: input.childSessionPaths,
      phaseSentinelWritten: input.phaseSentinelWritten,
      doneSentinelWritten: input.doneSentinelWritten,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    },
  };
}

function factoryLedger(runDir: string, entry: Record<string, unknown>): void {
  appendFileSync(join(runDir, "ledger.jsonl"), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
}

const FACTORY_ADAPTIVE_ARTIFACTS = ["adaptive-delegation-policy.json", "delegation-governor-state.json", "delegation-requests.json", "delegation-decisions.json", "delegation-oracle-decisions.json", "delegation-dispatches.json", "adaptive-delegation-summary.md"];

function writeFactoryAdaptiveDelegationArtifacts(runDir: string, input: { runId: string; factoryName: string; mode: string; execution: string; originalGoalHash: string; adaptiveDelegation: ReturnType<typeof normalizeAdaptiveDelegationPolicy>; adaptiveFactoryDispatchGate?: FactoryAdaptiveDispatchGate }): string[] {
  const { runId, factoryName, mode, execution, originalGoalHash, adaptiveDelegation, adaptiveFactoryDispatchGate } = input;
  const liveFactoryAdaptiveRequested = adaptiveDelegation.dispatch === true;
  const integration = liveFactoryAdaptiveRequested ? "p8_live_factory_dispatch_blocked_pending_registered_proof" : "p8_advisory_only";
  const governorState = buildInitialAdaptiveDelegationGovernorState({ runId, rootGoalHash: originalGoalHash, policy: adaptiveDelegation });
  writeFileSync(join(runDir, "adaptive-delegation-policy.json"), JSON.stringify(adaptiveDelegation, null, 2), "utf8");
  writeFileSync(join(runDir, "delegation-governor-state.json"), JSON.stringify(governorState, null, 2), "utf8");
  writeFileSync(join(runDir, "delegation-requests.json"), JSON.stringify({ schema: "zob.delegation-request-set.v1", runId, mode: adaptiveDelegation.mode, dispatch: adaptiveDelegation.dispatch, requests: [], extractionErrors: [], bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  writeFileSync(join(runDir, "delegation-decisions.json"), JSON.stringify({ schema: "zob.governor-decision-set.v1", runId, decisions: [], bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  writeFileSync(join(runDir, "delegation-oracle-decisions.json"), JSON.stringify({ schema: "zob.delegation-oracle-decision-set.v1", runId, oracleRequired: 0, oracleDispatchesExecuted: 0, oracleDispatchesCompleted: 0, oracleDispatchesFailed: 0, oracleDispatchesMocked: 0, oracleLiveChildPiDispatches: 0, oraclePasses: 0, oracleWarns: 0, oracleFails: 0, decisions: [], liveOracleDispatched: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  writeFileSync(join(runDir, "delegation-dispatches.json"), JSON.stringify({ schema: "zob.parent-dispatch-contract-set.v1", runId, dispatches: [], dispatchContractsQueued: 0, liveDispatches: 0, completed: 0, failed: 0, mockedDispatches: 0, liveChildPiDispatches: 0, adaptiveLiveDispatchEnabled: false, requestedLiveFactoryAdaptiveDispatch: liveFactoryAdaptiveRequested, reason: liveFactoryAdaptiveRequested ? "factory adaptive live dispatch requested but blocked pending registered proof activation" : "factory adaptive delegation P8 is advisory-only; no live adaptive dispatch is enabled", bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
  const artifacts = [...FACTORY_ADAPTIVE_ARTIFACTS];
  if (adaptiveFactoryDispatchGate) {
    writeFileSync(join(runDir, "factory-adaptive-dispatch-gate.json"), JSON.stringify(adaptiveFactoryDispatchGate, null, 2), "utf8");
    artifacts.push("factory-adaptive-dispatch-gate.json");
  }
  writeFileSync(join(runDir, "adaptive-delegation-summary.md"), [`# Factory Adaptive Delegation Summary`, ``, `- runId: ${runId}`, `- factory: ${factoryName}`, `- mode: ${mode}`, `- execution: ${execution}`, `- enabled: ${adaptiveDelegation.enabled}`, `- adaptive_mode: ${adaptiveDelegation.mode}`, `- dispatch: ${adaptiveDelegation.dispatch}`, `- factory_integration: ${integration}`, `- live_dispatches: 0`, `- live_factory_adaptive_dispatch_enabled: false`, `- sentinel: not written by adaptive delegation`, ``].join("\n"), "utf8");
  return artifacts;
}

function factoryAdaptiveValidation(input: { adaptiveDelegation: ReturnType<typeof normalizeAdaptiveDelegationPolicy>; artifacts: string[]; adaptiveFactoryDispatchGate?: FactoryAdaptiveDispatchGate }): Record<string, unknown> {
  const { adaptiveDelegation, artifacts, adaptiveFactoryDispatchGate } = input;
  if (!adaptiveDelegation.enabled) return { enabled: false };
  const liveFactoryAdaptiveRequested = adaptiveDelegation.dispatch === true;
  return {
    schema: "zob.factory-adaptive-delegation-validation.v1",
    enabled: true,
    factoryIntegration: liveFactoryAdaptiveRequested ? "p8_live_factory_dispatch_blocked_pending_registered_proof" : "p8_advisory_only", 
    mode: adaptiveDelegation.mode,
    dispatch: adaptiveDelegation.dispatch,
    recordDecisionsOnly: adaptiveDelegation.recordDecisionsOnly,
    configuredMaxDepth: adaptiveDelegation.configuredMaxDepth,
    runtimeMaxDepth: adaptiveDelegation.runtimeMaxDepth,
    maxTotalAgents: adaptiveDelegation.maxTotalAgents,
    maxTotalAgentsWithOracle: adaptiveDelegation.maxTotalAgentsWithOracle,
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    requests: 0,
    decisions: 0,
    dispatchContractsQueued: 0,
    adaptiveDispatchesExecuted: 0,
    adaptiveOracleDispatchesExecuted: 0,
    liveDispatches: 0,
    liveOracleDispatches: 0,
    advisoryOnly: !liveFactoryAdaptiveRequested,
    requestedLiveFactoryAdaptiveDispatch: liveFactoryAdaptiveRequested,
    adaptiveLiveDispatchEnabled: false,
    liveFactoryAdaptiveDispatchEnabled: false,
    activationGatePresent: adaptiveFactoryDispatchGate?.enabled === true,
    adaptiveFactoryDispatchGate,
    artifacts,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function evaluateFactoryRequiredStages(
  definition: FactoryDefinition,
  runDir: string,
  selectedItems: FactoryManifestItem[],
  failed: number,
  agenticPlanPresent: boolean,
  checkpointsPresent: boolean,
  outputsPresent: boolean,
  validationWillBeWritten: boolean,
  sentinelWillBeWritten: boolean,
): Array<{ stage: string; present: boolean; evidence: string }> {
  const checks: Record<string, { present: boolean; evidence: string }> = {
    initialized: { present: existsSync(join(runDir, "manifest.json")) && existsSync(join(runDir, "ledger.jsonl")), evidence: "manifest.json and ledger.jsonl" },
    manifest_loaded: { present: existsSync(join(runDir, "manifest.json")), evidence: "manifest.json" },
    agentic_plan_written: { present: agenticPlanPresent, evidence: "agentic-plan.json" },
    item_processed: { present: selectedItems.length > 0 && failed === 0 && checkpointsPresent && outputsPresent, evidence: "outputs/*.json and checkpoints/*.checkpoint.json" },
    patterns_canonicalized: { present: existsSync(join(runDir, "patterns.canonical.json")), evidence: "patterns.canonical.json" },
    risks_canonicalized: { present: existsSync(join(runDir, "risks.canonical.json")), evidence: "risks.canonical.json" },
    workflow_rules_written: { present: existsSync(join(runDir, "workflow-rules.md")), evidence: "workflow-rules.md" },
    agent_instructions_written: { present: existsSync(join(runDir, "agent-instructions.md")), evidence: "agent-instructions.md" },
    quality_gates_written: { present: existsSync(join(runDir, "quality-gates.json")), evidence: "quality-gates.json" },
    dashboard_summary_written: { present: existsSync(join(runDir, "dashboard-summary.md")), evidence: "dashboard-summary.md" },
    validation: { present: validationWillBeWritten, evidence: "validation.json" },
    phase_sentinel: { present: sentinelWillBeWritten || Object.values(FACTORY_PHASE_SENTINELS).some((artifact) => existsSync(join(runDir, artifact))), evidence: "SMOKE_PASSED.sentinel/PILOT_PASSED.sentinel/BATCH_PASSED.sentinel" },
    sentinel: { present: sentinelWillBeWritten || existsSync(join(runDir, "DONE.sentinel")), evidence: "DONE.sentinel" },
  };

  return (definition.requiredStages ?? []).map((stage) => ({ stage, ...(checks[stage] ?? { present: false, evidence: "unknown required stage" }) }));
}

export function runFactoryRun(repoRoot: string, input: FactoryRunInput): FactoryRunResult {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const errors = validateFactoryRunInputs(repoRoot, input);
  const runId = safeRunId(input.run_id, "factory");
  const runDir = join(repoRoot, "reports", "factory-runs", runId);
  if (existsSync(runDir) && !input.resume) errors.push(`Run directory already exists. Use resume=true or choose another run_id: ${runDir}`);
  if (errors.length > 0) {
    const endedAtMs = Date.now();
    writeFactoryTelemetrySummary(repoRoot, {
      runId,
      factory: input.factory,
      mode: input.mode ?? "unknown",
      execution: input.execution ?? "deterministic",
      status: "failed_preflight",
      itemCount: 0,
      processed: 0,
      failed: 0,
      expectedArtifacts: [],
      generatedArtifacts: [],
      stageCount: 0,
      agenticTasks: 0,
      failuresByStage: { preflight: errors.length },
      retryCount: 0,
      wallTimeMs: endedAtMs - startedAtMs,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      errors,
    });
    return { runId, runDir, status: "failed_preflight", processed: 0, failed: 0, artifacts: [], errors };
  }

  const factory = loadFactoryDefinition(repoRoot, input.factory).definition as FactoryDefinition;
  const manifestResult = loadFactoryInputManifest(repoRoot, input.input_manifest);
  const manifest = manifestResult.manifest as FactoryInputManifest;
  const mode = input.mode ?? factory.defaultMode ?? "smoke";
  const execution = input.execution ?? "deterministic";
  const adaptiveDelegation = normalizeAdaptiveDelegationPolicy(input.adaptive_delegation);
  const adaptiveFactoryDispatchGate = normalizeFactoryAdaptiveDispatchGate(input.adaptive_factory_dispatch_gate);
  const computeProfile = resolveComputeProfile(repoRoot, {
    runId,
    domain: "factory",
    requestedProfile: input.compute_profile ?? "auto",
    targetPath: input.input_manifest,
    computeCaps: input.compute_caps,
    riskHints: execution === "agentic" ? ["durable"] : [],
  });
  const persistedInput = adaptiveDelegation.enabled || adaptiveFactoryDispatchGate || input.compute_profile || input.compute_caps ? { ...input, adaptive_delegation: adaptiveDelegation, adaptive_factory_dispatch_gate: adaptiveFactoryDispatchGate, compute_profile_resolution: computeProfile } : input;
  const modeLimit = mode === "smoke" ? 1 : mode === "pilot" ? 10 : manifest.items.length;
  const limit = Math.min(input.max_items ?? modeLimit, modeLimit, manifest.items.length);
  const selectedItems = manifest.items.slice(0, limit);

  const checkpointsDir = join(runDir, "checkpoints");
  const outputsDir = join(runDir, "outputs");
  mkdirSync(checkpointsDir, { recursive: true });
  mkdirSync(outputsDir, { recursive: true });
  const sentinelPath = join(runDir, "DONE.sentinel");
  if (existsSync(sentinelPath)) unlinkSync(sentinelPath);
  for (const phaseSentinel of Object.values(FACTORY_PHASE_SENTINELS)) {
    const phasePath = join(runDir, phaseSentinel);
    if (existsSync(phasePath)) unlinkSync(phasePath);
  }

  const expectedArtifacts = manifest.expectedArtifacts ?? factory.expectedArtifacts ?? [
    "patterns.canonical.json",
    "risks.canonical.json",
    "workflow-rules.md",
    "agent-instructions.md",
    "quality-gates.json",
    "dashboard-summary.md",
  ];

  const artifacts: string[] = ["agentic-plan.json", "compute-profile-resolution.json"];
  const patternCounts = new Map<string, number>();
  const riskCounts = new Map<string, number>();
  let failed = 0;
  const promotionRequiresOracle = (mode === "pilot" || mode === "batch") && execution !== "plan_only";
  const oracleReview = promotionRequiresOracle ? loadFactoryOracleReview(repoRoot, input.oracle_review_path).review : undefined;
  const oracleReviewSummary = summarizeFactoryOracleReview(oracleReview);
  const legacyOracleGate = input.oracle_gate ? {
    verdict: input.oracle_gate.verdict,
    no_ship: input.oracle_gate.no_ship,
    evidence: input.oracle_gate.evidence,
    reviewer: input.oracle_gate.reviewer ?? "unspecified",
  } : undefined;
  const pilotGate = mode === "pilot" && execution !== "plan_only" ? {
    required: true,
    passed: true,
    smokeRunId: input.prerequisite_smoke_run_id,
    oracleReviewPath: input.oracle_review_path,
    oracleReview: oracleReviewSummary,
    ...(legacyOracleGate ? { oracleGate: legacyOracleGate } : {}),
  } : undefined;
  const batchGate = mode === "batch" && execution !== "plan_only" ? {
    required: true,
    passed: true,
    pilotRunId: input.prerequisite_pilot_run_id,
    oracleReviewPath: input.oracle_review_path,
    oracleReview: oracleReviewSummary,
    concurrencyCap: input.batch_concurrency,
    ...(legacyOracleGate ? { oracleGate: legacyOracleGate } : {}),
  } : undefined;

  writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ factory, input: persistedInput, inputManifest: manifest, mode, execution, limit, sourceManifestPath: manifestResult.manifestPath, computeProfile, ...(pilotGate ? { pilotGate } : {}), ...(batchGate ? { batchGate } : {}) }, null, 2), "utf8");
  writeFileSync(join(runDir, "compute-profile-resolution.json"), JSON.stringify(computeProfile, null, 2), "utf8");
  const agenticPlan = buildFactoryAgenticPlan(repoRoot, factory, manifest, selectedItems, { runId, runDir, mode, checkpointsDir, outputsDir });
  writeFileSync(join(runDir, "agentic-plan.json"), JSON.stringify(agenticPlan, null, 2), "utf8");
  const adaptiveArtifacts = adaptiveDelegation.enabled ? writeFactoryAdaptiveDelegationArtifacts(runDir, { runId, factoryName: factory.name, mode, execution, originalGoalHash: sha256(`${factory.name}:${manifest.description ?? input.input_manifest}`), adaptiveDelegation, adaptiveFactoryDispatchGate }) : [];
  artifacts.push(...adaptiveArtifacts);
  factoryLedger(runDir, { event: "initialized", runId, factory: factory.name, mode, execution });
  factoryLedger(runDir, { event: "manifest_loaded", items: manifest.items.length, selectedItems: selectedItems.length });
  factoryLedger(runDir, { event: "agentic_plan_written", tasks: agenticPlan.tasks.length, stages: agenticPlan.stageCount });
  if (adaptiveDelegation.enabled) factoryLedger(runDir, { event: "factory_adaptive_delegation_policy_written", artifacts: adaptiveArtifacts, dispatch: adaptiveDelegation.dispatch, liveDispatches: 0, sentinel: "not written" });
  if (pilotGate) factoryLedger(runDir, { event: "pilot_gate_passed", smokeRunId: pilotGate.smokeRunId, oracleReviewPath: pilotGate.oracleReviewPath, oracleVerdict: oracleReview?.verdict, noShip: oracleReview?.no_ship, reviewer: oracleReview?.reviewer ?? "unspecified" });
  if (batchGate) factoryLedger(runDir, { event: "batch_gate_passed", pilotRunId: batchGate.pilotRunId, oracleReviewPath: batchGate.oracleReviewPath, oracleVerdict: oracleReview?.verdict, noShip: oracleReview?.no_ship, reviewer: oracleReview?.reviewer ?? "unspecified", concurrencyCap: batchGate.concurrencyCap });

  if (execution === "plan_only") {
    writeFileSync(join(runDir, "final-report.md"), [`# Factory Run Report`, ``, `- runId: ${runId}`, `- factory: ${factory.name}`, `- status: planned`, `- execution: plan_only`, `- planned_tasks: ${agenticPlan.tasks.length}`, `- sentinel: not written`, ``].join("\n"), "utf8");
    const validation = {
      runId,
      factory: factory.name,
      mode,
      execution,
      processed: 0,
      failed: 0,
      expectedArtifacts,
      artifactsPresent: expectedArtifacts.map((artifact) => ({ artifact, exists: false })),
      completionArtifactsPresent: ["manifest.json", "ledger.jsonl", "agentic-plan.json", "final-report.md"].map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) })),
      agenticPlan: { exists: existsSync(join(runDir, "agentic-plan.json")), tasks: agenticPlan.tasks.length, stages: agenticPlan.stageCount },
      computeProfile,
      adaptiveDelegation: factoryAdaptiveValidation({ adaptiveDelegation, artifacts: adaptiveArtifacts, adaptiveFactoryDispatchGate }),
      requiredStagesPresent: evaluateFactoryRequiredStages(factory, runDir, selectedItems, 0, existsSync(join(runDir, "agentic-plan.json")), false, false, true, false),
      checkpointsPresent: false,
      outputsPresent: false,
      status: "planned",
    };
    writeFileSync(join(runDir, "validation.json"), JSON.stringify(validation, null, 2), "utf8");
    const plannedArtifacts = ["agentic-plan.json", "compute-profile-resolution.json", ...adaptiveArtifacts, "final-report.md", "validation.json"];
    const endedAtMs = Date.now();
    writeFactoryTelemetrySummary(repoRoot, {
      runId,
      runDir,
      factory: factory.name,
      mode,
      execution,
      status: "planned",
      itemCount: selectedItems.length,
      processed: 0,
      failed: 0,
      expectedArtifacts,
      generatedArtifacts: plannedArtifacts,
      stageCount: factory.stages?.length ?? 0,
      agenticTasks: agenticPlan.tasks.length,
      failuresByStage: {},
      retryCount: 0,
      wallTimeMs: endedAtMs - startedAtMs,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      errors: [],
    });
    plannedArtifacts.push("telemetry.json");
    factoryLedger(runDir, { event: "planned", tasks: agenticPlan.tasks.length, sentinel: "not written" });
    return { runId, runDir, status: "planned", processed: 0, failed: 0, artifacts: plannedArtifacts, errors: [] };
  }

  for (const item of selectedItems) {
    const resolved = resolveRepoPath(repoRoot, item.path);
    const itemOutputPath = join(outputsDir, `${safeFileStem(item.id)}.json`);
    if (resolved.errors.length > 0 || !existsSync(resolved.path)) {
      failed += 1;
      const output = { id: item.id, path: item.path, status: "failed", errors: [...resolved.errors, existsSync(resolved.path) ? undefined : "input file not found"].filter(Boolean) };
      writeFileSync(itemOutputPath, JSON.stringify(output, null, 2), "utf8");
      factoryLedger(runDir, { event: "item_failed", id: item.id, path: item.path, errors: output.errors });
      continue;
    }
    const text = readFileSync(resolved.path, "utf8");
    const fingerprint = sha256(text);
    const detectedPatterns = detectCanonicalPatterns(text);
    for (const pattern of detectedPatterns) {
      patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
      if (pattern.startsWith("failure.")) riskCounts.set(pattern, (riskCounts.get(pattern) ?? 0) + 1);
    }
    const output = { id: item.id, path: item.path, status: "done", fingerprint, detectedPatterns, bytes: Buffer.byteLength(text, "utf8") };
    writeFileSync(itemOutputPath, JSON.stringify(output, null, 2), "utf8");
    writeFileSync(join(checkpointsDir, `${safeFileStem(item.id)}.checkpoint.json`), JSON.stringify({ id: item.id, status: "done", output: itemOutputPath, fingerprint }, null, 2), "utf8");
    factoryLedger(runDir, { event: "item_processed", id: item.id, path: item.path, detectedPatterns, fingerprint });
  }

  const patterns = [...patternCounts.entries()].map(([id, count]) => ({ id, count })).sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
  const risks = [...riskCounts.entries()].map(([id, count]) => ({ id, count })).sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));

  const isFactoryForge = factory.name === "factory-forge";
  const generatedFactoryName = isFactoryForge ? safeFileStem(String(selectedItems[0]?.metadata?.generatedName ?? "generated-smoke-factory")) : undefined;
  const quarantineRelativePath = generatedFactoryName ? `quarantine/${generatedFactoryName}` : undefined;
  const quarantineDir = generatedFactoryName ? join(runDir, "quarantine", generatedFactoryName) : undefined;
  const factoryForgeMetadata = isFactoryForge && generatedFactoryName && quarantineDir ? {
    status: "quarantined",
    generatedName: generatedFactoryName,
    quarantineStatus: "quarantined",
    quarantinePath: quarantineRelativePath,
    generatedFactoryRegistered: false,
    autoActivation: false,
    manualActivationRequired: true,
    sentinelScope: "run-validation-only",
    scaffoldArtifacts: [
      `${quarantineRelativePath}/factory.json`,
      `${quarantineRelativePath}/smoke-manifest.json`,
      `${quarantineRelativePath}/README.md`,
    ],
  } : undefined;

  const artifactWriters: Record<string, string> = {
    "patterns.canonical.json": JSON.stringify({ factory: factory.name, runId, patterns }, null, 2),
    "risks.canonical.json": JSON.stringify({ factory: factory.name, runId, risks }, null, 2),
    "workflow-rules.md": [`# Workflow Rules`, ``, ...patterns.map((pattern) => `- ${pattern.id}: observed ${pattern.count} time(s).`), ``].join("\n"),
    "agent-instructions.md": [`# Agent Instructions`, ``, `Use six-part contracts, evidence, oracle reviews, sentinels, and bounded scope for factory-generated work.`, ``].join("\n"),
    "quality-gates.json": JSON.stringify({ factory: factory.name, runId, gates: ["contract_valid", "output_contract_valid", "evidence_present", "sentinel_present"], mode }, null, 2),
    "dashboard-summary.md": [`# Factory Dashboard Summary`, ``, `- runId: ${runId}`, `- factory: ${factory.name}`, `- mode: ${mode}`, `- processed: ${selectedItems.length - failed}`, `- failed: ${failed}`, `- patterns: ${patterns.length}`, ``].join("\n"),
    "factory-forge-summary.json": JSON.stringify({ factory: factory.name, runId, status: "generated", quarantine: factoryForgeMetadata }, null, 2),
  };

  for (const artifact of expectedArtifacts) {
    const content = artifactWriters[artifact] ?? JSON.stringify({ artifact, factory: factory.name, runId, status: "generated" }, null, 2);
    writeFileSync(join(runDir, artifact), content, "utf8");
    artifacts.push(artifact);
  }

  if (factoryForgeMetadata && quarantineDir) {
    mkdirSync(quarantineDir, { recursive: true });
    writeFileSync(join(quarantineDir, "factory.json"), JSON.stringify({
      name: generatedFactoryName,
      version: "0.0.0-quarantined",
      status: "quarantined",
      autoActivation: false,
      manualActivationRequired: true,
      description: "Quarantined deterministic scaffold generated by factory-forge smoke run. Manual review and activation required.",
      defaultMode: "smoke",
      requiredStages: ["manifest_loaded", "agentic_plan_written", "item_processed", "validation", "sentinel"],
      expectedArtifacts: ["README.md"],
      stages: [],
    }, null, 2), "utf8");
    writeFileSync(join(quarantineDir, "smoke-manifest.json"), JSON.stringify({
      factory: generatedFactoryName,
      description: "Quarantined smoke manifest scaffold. Not registered under .pi/factories.",
      items: [{ id: "activated-readme", path: `.pi/factories/${generatedFactoryName}/README.md` }],
      expectedArtifacts: ["README.md"],
    }, null, 2), "utf8");
    writeFileSync(join(quarantineDir, "README.md"), [`# ${generatedFactoryName}`, ``, `Status: quarantined`, `Auto-activation: false`, `Manual activation required: true`, `Sentinel scope: run-validation-only`, ``].join("\n"), "utf8");
    artifacts.push(...factoryForgeMetadata.scaffoldArtifacts);
    factoryLedger(runDir, { event: "factory_forge_scaffold_quarantined", generatedName: generatedFactoryName, quarantinePath: quarantineRelativePath, autoActivation: false });
  }

  const expectedArtifactsPresent = expectedArtifacts.every((artifact) => existsSync(join(runDir, artifact)));
  const checkpointsPresent = selectedItems.every((item) => existsSync(join(checkpointsDir, `${safeFileStem(item.id)}.checkpoint.json`)));
  const outputsPresent = selectedItems.every((item) => existsSync(join(outputsDir, `${safeFileStem(item.id)}.json`)));
  const agenticPlanPresent = existsSync(join(runDir, "agentic-plan.json"));
  const baseLocalValidationPassed = failed === 0 && expectedArtifactsPresent && checkpointsPresent && outputsPresent && agenticPlanPresent;
  const preliminaryValidationStatus = baseLocalValidationPassed ? (execution === "deterministic" ? "passed" : "planned") : "failed";
  const requiredStagesPresent = evaluateFactoryRequiredStages(factory, runDir, selectedItems, failed, agenticPlanPresent, checkpointsPresent, outputsPresent, true, preliminaryValidationStatus === "passed");
  const requiredStagesPassed = requiredStagesPresent.every((stage) => stage.present || ((stage.stage === "sentinel" || stage.stage === "phase_sentinel") && execution !== "deterministic"));
  const localValidationPassed = baseLocalValidationPassed && requiredStagesPassed;
  const validationStatus = localValidationPassed ? (execution === "deterministic" ? "passed" : "planned") : "failed";
  const phaseSentinel = factoryPhaseSentinelForMode(mode);
  writeFileSync(join(runDir, "final-report.md"), [`# Factory Run Report`, ``, `- runId: ${runId}`, `- factory: ${factory.name}`, `- status: ${validationStatus}`, `- execution: ${execution}`, `- processed: ${selectedItems.length - failed}`, `- failed: ${failed}`, `- phase_sentinel: ${validationStatus === "passed" ? phaseSentinel : "not written"}`, `- sentinel: ${validationStatus === "passed" ? "DONE.sentinel" : "not written"}`, ``].join("\n"), "utf8");
  artifacts.push("final-report.md");
  const validation = {
    runId,
    factory: factory.name,
    mode,
    execution,
    processed: selectedItems.length - failed,
    failed,
    expectedArtifacts,
    artifactsPresent: expectedArtifacts.map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) })),
    completionArtifactsPresent: ["manifest.json", "ledger.jsonl", "agentic-plan.json", "final-report.md", phaseSentinel, "DONE.sentinel"].map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) })),
    phaseSentinel: { mode, artifact: phaseSentinel, written: false, validationRequired: true },
    sentinelWritten: false,
    agenticPlan: { exists: agenticPlanPresent, tasks: agenticPlan.tasks.length, stages: agenticPlan.stageCount },
    requiredStagesPresent,
    checkpointsPresent,
    outputsPresent,
    ...(pilotGate ? { pilotGate } : {}),
    ...(batchGate ? { batchGate } : {}),
    ...(factoryForgeMetadata ? { factoryForge: factoryForgeMetadata } : {}),
    computeProfile,
    adaptiveDelegation: factoryAdaptiveValidation({ adaptiveDelegation, artifacts: adaptiveArtifacts, adaptiveFactoryDispatchGate }),
    status: validationStatus,
  };
  writeFileSync(join(runDir, "validation.json"), JSON.stringify(validation, null, 2), "utf8");
  artifacts.push("validation.json");
  factoryLedger(runDir, { event: "validation", status: validation.status, failed, artifacts: expectedArtifacts });

  const writeRunTelemetry = (status: string, telemetryErrors: string[]): void => {
    const failuresByStage: Record<string, number> = {};
    if (failed > 0) failuresByStage.item_processed = failed;
    if (status === "failed_validation") failuresByStage.validation = 1;
    const endedAtMs = Date.now();
    writeFactoryTelemetrySummary(repoRoot, {
      runId,
      runDir,
      factory: factory.name,
      mode,
      execution,
      status,
      itemCount: selectedItems.length,
      processed: validation.processed,
      failed,
      expectedArtifacts,
      generatedArtifacts: [...artifacts],
      stageCount: factory.stages?.length ?? 0,
      agenticTasks: agenticPlan.tasks.length,
      failuresByStage,
      retryCount: 0,
      wallTimeMs: endedAtMs - startedAtMs,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      errors: telemetryErrors,
    });
    artifacts.push("telemetry.json");
  };

  if (validation.status === "passed") {
    const phaseSentinelPath = join(runDir, phaseSentinel);
    writeFileSync(phaseSentinelPath, `${mode} passed ${new Date().toISOString()}\n`, "utf8");
    artifacts.push(phaseSentinel);
    factoryLedger(runDir, { event: "phase_sentinel", mode, sentinel: phaseSentinel, after: "validation" });
    writeFileSync(sentinelPath, `done ${new Date().toISOString()}\n`, "utf8");
    artifacts.push("DONE.sentinel");
    const validationWithSentinels = {
      ...validation,
      phaseSentinel: { mode, artifact: phaseSentinel, written: true, validationRequired: true },
      sentinelWritten: true,
      completionArtifactsPresent: ["manifest.json", "ledger.jsonl", "agentic-plan.json", "final-report.md", phaseSentinel, "DONE.sentinel"].map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) })),
    };
    writeFileSync(join(runDir, "validation.json"), JSON.stringify(validationWithSentinels, null, 2), "utf8");
    factoryLedger(runDir, { event: "done", sentinel: "DONE.sentinel" });
    writeRunTelemetry("done", []);
    return { runId, runDir, status: "done", processed: validation.processed, failed, artifacts, errors: [] };
  }

  if (validation.status === "planned") {
    factoryLedger(runDir, { event: "planned", sentinel: "not written", execution });
    writeRunTelemetry("planned", []);
    return { runId, runDir, status: "planned", processed: validation.processed, failed, artifacts, errors: [] };
  }

  factoryLedger(runDir, { event: "failed_validation" });
  writeRunTelemetry("failed_validation", ["Factory validation failed"]);
  return { runId, runDir, status: "failed_validation", processed: validation.processed, failed, artifacts, errors: ["Factory validation failed"] };
}

export { factoryLedger };
