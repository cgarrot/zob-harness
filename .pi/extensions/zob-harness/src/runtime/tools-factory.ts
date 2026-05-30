import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildZobLivePresenceSummary } from "../coms-v2/presence.js";
import { readZobComsV2Policy } from "../coms-v2/policy.js";
import { discoverAgents } from "../agents.js";
import { evaluateStrictBudgetDispatchGate } from "../budget-policy.js";
import { isFailed, runChildAgent } from "../child-runner.js";
import { classifyChronicleCompletion, outputHasEvidenceMarker } from "../chronicle.js";
import { buildAgenticFactoryNoMockFinalGate, factoryLedger, runFactoryRun } from "../factory/run.js";
import { buildInitialAdaptiveDelegationGovernorState, buildParentDispatchContractForDecision, decideDelegationRequest, extractDelegationRequestsFromText, normalizeAdaptiveDelegationPolicy, updateGovernorState } from "../orchestration/adaptive-delegation.js";
import { runFactoryQuarantineActivate, runFactoryQuarantineReview, runFactoryQuarantineVerifyActivation } from "../factory/quarantine.js";
import { evaluateModelRoutingDispatchGate } from "../model-routing.js";
import { applyChildGates, inferOutputContract, validateOutputContractId } from "../output-contracts.js";
import { FactoryQuarantineActivateParams, FactoryQuarantineReviewParams, FactoryQuarantineVerifyActivationParams, FactoryRunParams } from "../schemas.js";
import { factoryPhaseSentinelForMode, loadFactoryDefinition, loadFactoryInputManifest } from "../factory/validation.js";
import { validateToolList } from "../safety.js";
import { addUsage, usageEmpty, writeFactoryTelemetrySummary } from "../telemetry.js";
import { sha256 } from "../utils/hashing.js";
import { parseJsonFile } from "../utils/json.js";
import { safeFileStem } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";
import type { DelegationRequestProposal, GovernorDecision, ParentDispatchContract } from "../types.js";
import type { HarnessRuntimeState } from "./state.js";
import { strictGoalSpecErrors } from "./state.js";

function persistableModelRouting(route: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: route.schema,
    liveRoutingEnabled: route.liveRoutingEnabled === true,
    modelRouterUsed: route.modelRouterUsed === true,
    routingApplied: route.routingApplied === true,
    selectedModelClass: route.selectedModelClass,
    recommendedModelClass: route.recommendedModelClass,
    selectedModelHash: route.selectedModelHash,
    selectedModelStored: false,
    modelByClassProvided: route.modelByClassProvided === true,
    reasonCodes: Array.isArray(route.reasonCodes) ? route.reasonCodes : [],
    childDispatchAllowed: route.childDispatchAllowed === true,
    budgetEnforced: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function factoryStrictGoalSpecErrors(state: HarnessRuntimeState, repoRoot: string, params: { factory: string; input_manifest: string }): string[] {
  const loadedFactory = loadFactoryDefinition(repoRoot, params.factory);
  const loadedManifest = loadFactoryInputManifest(repoRoot, params.input_manifest);
  return strictGoalSpecErrors(state, {
    kind: "factory_run",
    factoryName: params.factory,
    factoryDescription: loadedFactory.definition?.description,
    inputManifest: params.input_manifest,
    manifestFactory: loadedManifest.manifest?.factory,
    manifestDescription: loadedManifest.manifest?.description,
    manifestItems: loadedManifest.manifest?.items.length,
  });
}

function factoryAgenticComsLivePreflightErrors(repoRoot: string, execution: string | undefined): string[] {
  if (execution !== "agentic") return [];
  const policy = readZobComsV2Policy(repoRoot);
  if (!policy.agenticWorkflowsRequireLive) return [];
  if (policy.legacy.appendOnlySendEnabled !== false) return ["ZOB coms v2 blocks factory agentic execution: legacy append-only send must be disabled for agentic workflows"];
  if (policy.mode !== "required_local" && policy.mode !== "required_network") return [`ZOB coms v2 blocks factory agentic execution: agentic workflows require required_local live transport, current mode=${policy.mode}`];
  if (policy.mode === "required_network") return ["ZOB coms v2 blocks factory agentic execution: required_network remains gated; use required_local live transport"];
  const presence = buildZobLivePresenceSummary(repoRoot);
  if (presence.dispatchEnabled !== true || presence.online <= 0 || presence.networkEnabled !== false) return [`ZOB coms v2 blocks factory agentic execution: live local registry is not ready (${JSON.stringify({ online: presence.online, stale: presence.stale, offline: presence.offline, dispatchEnabled: presence.dispatchEnabled, networkEnabled: presence.networkEnabled })})`];
  return [];
}

function factoryAdaptiveLiveReadonlyProofEnabled(params: Record<string, unknown>): boolean {
  const adaptive = isRecord(params.adaptive_delegation) ? params.adaptive_delegation : undefined;
  const gate = isRecord(params.adaptive_factory_dispatch_gate) ? params.adaptive_factory_dispatch_gate : undefined;
  return params.execution === "agentic"
    && (params.mode ?? "smoke") === "smoke"
    && adaptive?.enabled === true
    && adaptive?.dispatch === true
    && adaptive?.mode === "when_pertinent"
    && adaptive?.strictBudgetRequired === true
    && gate?.enabled === true
    && gate?.liveReadOnlyProofEnabled === true;
}

function buildFactoryAdaptiveProposalGuidance(input: { runId: string; stageName: string; itemId: string; evidenceRefs: string[] }): string {
  return [
    "FACTORY ADAPTIVE PROOF GUIDANCE:",
    "For this registered proof, you MUST emit exactly one metadata-only adaptive proposal. Place it before the final deliverable line inside <delegation_requests>{\"requests\":[...]}</delegation_requests>.",
    `Use requesterRole \"factory:${input.stageName}\", referentRole \"factory-runner\", requesterDepth 1, targetDepth 2, requestedAgent \"explore\", requestedOutputContract \"explore.v1\", requiredTools [\"read\",\"grep\",\"find\",\"ls\"], risk \"low\".`,
    `Use evidenceRefs ${JSON.stringify(input.evidenceRefs)} and targetFileSet ${JSON.stringify(input.evidenceRefs)}.`,
    "Do not include task/context/prompt/output/body/content/diff/patch/messages/transcript fields in the proposal. Do not dispatch children yourself.",
    `Factory run id: ${input.runId}; stage: ${input.stageName}; item: ${input.itemId}.`,
  ].join("\n");
}

function buildFactoryAdaptiveReadonlyTaskText(input: { requestId: string; request: DelegationRequestProposal; runId: string }): string {
  return [
    "Parent-owned factory adaptive read-only dispatch.",
    `Factory run id: ${input.runId}.`,
    `Adaptive request id: ${input.requestId}.`,
    `Evidence refs: ${input.request.evidenceRefs.join(", ")}.`,
    `Target files: ${(input.request.targetFileSet ?? input.request.evidenceRefs).join(", ")}.`,
    "Use only read/grep/find/ls. Do not write files. Do not access secrets. Do not delegate.",
    "Return the requested output contract with evidence, risks/blockers, compliance, and final line deliverable_delivered: yes.",
  ].join("\n");
}

export function registerFactoryTools(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerTool({
    name: "factory_quarantine_review",
    label: "Factory Quarantine Review",
    description: [
      "Review a quarantined factory-forge scaffold for manual activation readiness.",
      "Writes review artifacts only under reports/factory-runs/<runId>/reviews/<reviewId> and never activates or registers the generated factory.",
    ].join(" "),
    promptSnippet: "Review quarantined factory-forge output for manual activation readiness",
    promptGuidelines: [
      "Use only for factory-forge outputs that already live under a run quarantine directory.",
      "Require local checks, oracle PASS, and approval metadata before treating activationReady as true.",
      "This tool never performs activation, copying, or registration under .pi/factories.",
    ],
    parameters: FactoryQuarantineReviewParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalErrors = strictGoalSpecErrors(state, { kind: "quarantine", operation: "factory_quarantine_review", runId: params.run_id });
      if (goalErrors.length > 0) {
        const result = { status: "failed_preflight", runId: params.run_id, reviewId: params.review_id ?? "not-started", reviewDir: "", activationReady: false, activationPerformed: false, generatedFactoryRegistered: false, errors: goalErrors };
        return { content: [{ type: "text", text: `factory_quarantine_review failed_preflight:\n- ${goalErrors.join("\n- ")}\nSet /goal_gate or /job_intake before review.` }], details: result };
      }
      const result = runFactoryQuarantineReview(ctx.cwd, params);
      const text = [
        `factory_quarantine_review ${result.status}: ${result.runId}/${result.reviewId}`,
        `reviewDir: ${result.reviewDir}`,
        `activationReady: ${result.activationReady}`,
        `activationPerformed: false`,
        `generatedFactoryRegistered: ${result.generatedFactoryRegistered}`,
        result.errors.length > 0 ? `errors:\n- ${result.errors.join("\n- ")}` : "errors: none",
      ].join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "factory_quarantine_activate",
    label: "Factory Quarantine Activate",
    description: [
      "Explicitly activate a reviewed quarantined factory-forge scaffold by copying only allowlisted files into .pi/factories/<generated>.",
      "Requires activation-readiness.json with activationReady=true/activationPerformed=false and an exact confirmation phrase.",
    ].join(" "),
    promptSnippet: "Activate a quarantined generated factory after manual review",
    promptGuidelines: [
      "Use only after factory_quarantine_review reports activationReady=true.",
      "Require the exact confirmation phrase shown in the tool schema; never paraphrase it.",
      "This tool refuses existing .pi/factories targets and never overwrites.",
    ],
    parameters: FactoryQuarantineActivateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalErrors = strictGoalSpecErrors(state, { kind: "quarantine", operation: "factory_quarantine_activate", runId: params.run_id });
      if (goalErrors.length > 0) {
        const result = { status: "failed_preflight", runId: params.run_id, reviewId: params.review_id, activationId: params.activation_id ?? "not-started", generatedFactory: params.generated_factory, activationPerformed: false, confirmationMatched: false, targetDir: "", journalPath: "", copiedFiles: [], errors: goalErrors };
        return { content: [{ type: "text", text: `factory_quarantine_activate failed_preflight:\n- ${goalErrors.join("\n- ")}\nSet /goal_gate or /job_intake before activation.` }], details: result };
      }
      const result = runFactoryQuarantineActivate(ctx.cwd, params);
      const text = [
        `factory_quarantine_activate ${result.status}: ${result.runId}/${result.reviewId}`,
        `targetDir: ${result.targetDir}`,
        `activationPerformed: ${result.activationPerformed}`,
        `confirmationMatched: ${result.confirmationMatched}`,
        `journalPath: ${result.journalPath}`,
        result.errors.length > 0 ? `errors:\n- ${result.errors.join("\n- ")}` : "errors: none",
      ].join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "factory_quarantine_verify_activation",
    label: "Factory Quarantine Verify Activation",
    description: [
      "Verify a manually activated factory-forge scaffold by requiring a successful activation journal entry and running deterministic factory_run smoke.",
      "Writes verification artifacts under reports/factory-runs/<runId>/verification/<verificationId> and appends activation-verification-journal.jsonl.",
    ].join(" "),
    promptSnippet: "Verify a manually activated generated factory with deterministic smoke",
    promptGuidelines: [
      "Use only after factory_quarantine_activate reports activationPerformed=true.",
      "Do not use agentic/live model verification; this tool always runs deterministic mode=smoke.",
      "If the verification factory_run id already exists, choose a fresh verification_id or clean it manually.",
    ],
    parameters: FactoryQuarantineVerifyActivationParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goalErrors = strictGoalSpecErrors(state, { kind: "quarantine", operation: "factory_quarantine_verify_activation", runId: params.run_id });
      if (goalErrors.length > 0) {
        const result = { status: "failed_preflight", runId: params.run_id, activationId: params.activation_id, verificationId: params.verification_id ?? "not-started", generatedFactory: params.generated_factory, verificationDir: "", journalPath: "", factoryRunId: "", factoryRunDir: "", artifacts: [], errors: goalErrors };
        return { content: [{ type: "text", text: `factory_quarantine_verify_activation failed_preflight:\n- ${goalErrors.join("\n- ")}\nSet /goal_gate or /job_intake before verification.` }], details: result };
      }
      const result = runFactoryQuarantineVerifyActivation(ctx.cwd, params);
      const text = [
        `factory_quarantine_verify_activation ${result.status}: ${result.runId}/${result.verificationId}`,
        `verificationDir: ${result.verificationDir}`,
        `factoryRunId: ${result.factoryRunId}`,
        `journalPath: ${result.journalPath}`,
        result.errors.length > 0 ? `errors:\n- ${result.errors.join("\n- ")}` : "errors: none",
      ].join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "factory_run",
    label: "Factory Run",
    description: [
      "Run a ZOB software factory with manifest/checkpoint/output/validation/sentinel artifacts.",
      "Supports deterministic local runs, plan_only runs, and optional agentic execution of the generated map/reduce/validate plan.",
    ].join(" "),
    promptSnippet: "Run a manifest/checkpoint/sentinel software factory",
    promptGuidelines: [
      "Use factory_run only after the harness goal and factory contract are clear.",
      "Start with mode=smoke before pilot or batch.",
      "Use execution=plan_only to inspect child-agent tasks without spending model tokens.",
      "Do not claim a factory run is complete without validation.json and DONE.sentinel.",
    ],
    parameters: FactoryRunParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const goalErrors = factoryStrictGoalSpecErrors(state, ctx.cwd, params);
      if (goalErrors.length > 0) {
        const result = { status: "failed_preflight", runId: params.run_id ?? "not-started", runDir: "", processed: 0, failed: 0, artifacts: [], errors: goalErrors };
        return { content: [{ type: "text", text: `factory_run failed_preflight:\n- ${goalErrors.join("\n- ")}\nSet /goal_gate or /job_intake before dispatch.` }], details: result };
      }
      let result = runFactoryRun(ctx.cwd, params);

      if (params.execution === "agentic" && result.status === "planned") {
        const runDir = result.runDir;
        const checkpointsDir = join(runDir, "checkpoints");
        const agenticResultsDir = join(runDir, "agentic-results");
        mkdirSync(agenticResultsDir, { recursive: true });
        const planPath = join(runDir, "agentic-plan.json");
        const plan = parseJsonFile(planPath);
        const tasks = isRecord(plan) && Array.isArray(plan.tasks) ? plan.tasks : [];
        const agents = discoverAgents(ctx.cwd, "project");
        const agentsByName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent]));
        const stageResults: Array<Record<string, unknown>> = [];
        let failed = 0;
        const initialTelemetryPath = join(runDir, "telemetry.json");
        const initialTelemetry = existsSync(initialTelemetryPath) && isRecord(parseJsonFile(initialTelemetryPath)) ? (parseJsonFile(initialTelemetryPath) as Record<string, unknown>) : {};
        const initialItems = isRecord(initialTelemetry.items) ? initialTelemetry.items : {};
        const initialStartedAt = typeof initialTelemetry.startedAt === "string" ? initialTelemetry.startedAt : new Date().toISOString();
        const initialStartedAtMs = Number.isFinite(Date.parse(initialStartedAt)) ? Date.parse(initialStartedAt) : Date.now();
        const selectedItemCount = typeof initialItems.selected === "number" ? initialItems.selected : result.processed + result.failed;
        const initialItemFailed = typeof initialItems.failed === "number" ? initialItems.failed : result.failed;
        const aggregateUsage = usageEmpty();
        const failuresByStage: Record<string, number> = {};
        const incrementStageFailure = (stage: string): void => {
          failuresByStage[stage] = (failuresByStage[stage] ?? 0) + 1;
        };
        const factoryAdaptiveLiveProofEnabled = factoryAdaptiveLiveReadonlyProofEnabled(params as Record<string, unknown>);
        const adaptiveDelegationPolicy = normalizeAdaptiveDelegationPolicy(params.adaptive_delegation);
        const adaptiveRootGoalHash = sha256(`${params.factory}:${params.input_manifest}:${result.runId}`);
        let adaptiveGovernorState = adaptiveDelegationPolicy.enabled ? buildInitialAdaptiveDelegationGovernorState({ runId: result.runId, rootGoalHash: adaptiveRootGoalHash, policy: adaptiveDelegationPolicy }) : undefined;
        const adaptiveRequests: DelegationRequestProposal[] = [];
        const adaptiveDecisions: GovernorDecision[] = [];
        const adaptiveContracts: ParentDispatchContract[] = [];
        const adaptiveDispatchRecords: Array<Record<string, unknown>> = [];
        const adaptiveExtractionErrors: Array<Record<string, unknown>> = [];
        let adaptiveProofAttempted = false;
        let adaptiveProofFailed = false;

        const strictBudgetGate = evaluateStrictBudgetDispatchGate({
          runId: result.runId,
          mode: params.mode ?? "smoke",
          execution: "agentic",
          taskCount: tasks.length,
          selectedItems: selectedItemCount,
          budget: params.budget,
        });
        factoryLedger(runDir, { event: "strict_budget_dispatch_gate", dispatchDecision: strictBudgetGate.dispatchDecision, budgetEnforced: strictBudgetGate.budgetEnforced, wouldBlockDispatch: strictBudgetGate.wouldBlockDispatch, failures: strictBudgetGate.failures });
        if (strictBudgetGate.wouldBlockDispatch === true) {
          incrementStageFailure("strict_budget");
          const mode = params.mode ?? "smoke";
          const phaseSentinel = mode === "pilot" || mode === "batch" ? factoryPhaseSentinelForMode(mode) : factoryPhaseSentinelForMode("smoke");
          const validationPath = join(runDir, "validation.json");
          const validation = existsSync(validationPath) && isRecord(parseJsonFile(validationPath)) ? (parseJsonFile(validationPath) as Record<string, unknown>) : {};
          const { noMockReady, finalGate } = buildAgenticFactoryNoMockFinalGate({
            status: "blocked_by_budget",
            tasks: tasks.length,
            completed: 0,
            failed: tasks.length,
            liveDispatches: 0,
            mockedDispatches: 0,
            outputContractsValidated: 0,
            childSessionPaths: 0,
            phaseSentinelWritten: false,
            doneSentinelWritten: false,
          });
          const budgetBlockedExecution = {
            schema: "zob.agentic-factory-execution.v1",
            status: "blocked_by_budget",
            tasks: tasks.length,
            completed: 0,
            failed: tasks.length,
            dispatcher: "not_dispatched",
            mocked: false,
            liveDispatches: 0,
            mockedDispatches: 0,
            outputContractsValidated: 0,
            childSessionPaths: 0,
            budgetGate: strictBudgetGate,
            noMockReady,
            finalGate,
            results: [],
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          };
          writeFileSync(join(runDir, "agentic-results.json"), JSON.stringify(budgetBlockedExecution, null, 2), "utf8");
          validation.status = "failed";
          validation.budgetGate = strictBudgetGate;
          validation.agenticExecution = { schema: budgetBlockedExecution.schema, status: budgetBlockedExecution.status, tasks: budgetBlockedExecution.tasks, completed: budgetBlockedExecution.completed, failed: budgetBlockedExecution.failed, dispatcher: budgetBlockedExecution.dispatcher, mocked: budgetBlockedExecution.mocked, liveDispatches: 0, mockedDispatches: 0, outputContractsValidated: 0, childSessionPaths: 0, budgetGate: strictBudgetGate, noMockReady, finalGate };
          validation.phaseSentinel = { mode, artifact: phaseSentinel, written: false, validationRequired: true };
          validation.sentinelWritten = false;
          validation.completionArtifactsPresent = ["manifest.json", "ledger.jsonl", "agentic-plan.json", "final-report.md", phaseSentinel, "DONE.sentinel"].map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) }));
          writeFileSync(validationPath, JSON.stringify(validation, null, 2), "utf8");
          writeFileSync(join(runDir, "final-report.md"), [`# Factory Run Report`, ``, `- runId: ${result.runId}`, `- factory: ${params.factory}`, `- status: failed`, `- execution: agentic`, `- agentic_tasks: ${tasks.length}`, `- agentic_completed: 0`, `- agentic_failed: ${tasks.length}`, `- live_dispatches: 0`, `- mocked_dispatches: 0`, `- strict_budget_gate: blocked`, `- phase_sentinel: not written`, `- sentinel: not written`, ``].join("\n"), "utf8");
          factoryLedger(runDir, { event: "strict_budget_dispatch_blocked", dispatchDecision: strictBudgetGate.dispatchDecision, failures: strictBudgetGate.failures, liveDispatches: 0 });
          const blockedArtifacts = [...new Set([...result.artifacts, "agentic-results.json", "telemetry.json"])];
          result = { ...result, status: "agentic_failed", failed: tasks.length, artifacts: blockedArtifacts, errors: ["Strict budget dispatch gate blocked live child dispatch"] };
          const blockedEndedAtMs = Date.now();
          const expectedArtifacts = Array.isArray(validation.expectedArtifacts) ? validation.expectedArtifacts.filter((artifact): artifact is string => typeof artifact === "string") : [];
          writeFactoryTelemetrySummary(ctx.cwd, {
            runId: result.runId,
            runDir,
            factory: params.factory,
            mode,
            execution: "agentic",
            status: result.status,
            itemCount: selectedItemCount,
            processed: typeof validation.processed === "number" ? validation.processed : result.processed,
            failed: initialItemFailed,
            expectedArtifacts,
            generatedArtifacts: blockedArtifacts.filter((artifact) => artifact !== "telemetry.json"),
            stageCount: isRecord(plan) && typeof plan.stageCount === "number" ? plan.stageCount : 0,
            agenticTasks: tasks.length,
            failuresByStage,
            retryCount: 0,
            usage: aggregateUsage,
            wallTimeMs: blockedEndedAtMs - initialStartedAtMs,
            startedAt: initialStartedAt,
            endedAt: new Date(blockedEndedAtMs).toISOString(),
            errors: result.errors,
            budgetEnforced: true,
          });
          pi.appendEntry("zob-factory-run", {
            runId: result.runId,
            factory: params.factory,
            inputManifest: params.input_manifest,
            mode,
            execution: "agentic",
            status: result.status,
            processed: result.processed,
            failed: result.failed,
            artifacts: result.artifacts,
            errors: result.errors,
          });
          const text = [
            `factory_run ${result.status}: ${result.runId}`,
            `runDir: ${result.runDir}`,
            `execution: agentic`,
            `processed: ${result.processed}`,
            `failed: ${result.failed}`,
            `budget: strict dispatch gate blocked live child dispatch`,
            result.artifacts.length > 0 ? `artifacts:\n- ${result.artifacts.join("\n- ")}` : "artifacts: none",
            result.errors.length > 0 ? `errors:\n- ${result.errors.join("\n- ")}` : "errors: none",
          ].join("\n");
          return { content: [{ type: "text", text }], details: result };
        }

        const liveComsErrors = factoryAgenticComsLivePreflightErrors(ctx.cwd, params.execution);
        factoryLedger(runDir, { event: "agentic_coms_live_gate", passed: liveComsErrors.length === 0, errors: liveComsErrors, bodyStored: false });
        if (liveComsErrors.length > 0) {
          incrementStageFailure("zob_coms_live_required");
          const mode = params.mode ?? "smoke";
          const phaseSentinel = mode === "pilot" || mode === "batch" ? factoryPhaseSentinelForMode(mode) : factoryPhaseSentinelForMode("smoke");
          const validationPath = join(runDir, "validation.json");
          const validation = existsSync(validationPath) && isRecord(parseJsonFile(validationPath)) ? (parseJsonFile(validationPath) as Record<string, unknown>) : {};
          const { noMockReady, finalGate } = buildAgenticFactoryNoMockFinalGate({
            status: "blocked_by_coms_live_required",
            tasks: tasks.length,
            completed: 0,
            failed: tasks.length,
            liveDispatches: 0,
            mockedDispatches: 0,
            outputContractsValidated: 0,
            childSessionPaths: 0,
            phaseSentinelWritten: false,
            doneSentinelWritten: false,
          });
          const liveBlockedExecution = {
            schema: "zob.agentic-factory-execution.v1",
            status: "blocked_by_coms_live_required",
            tasks: tasks.length,
            completed: 0,
            failed: tasks.length,
            dispatcher: "not_dispatched",
            mocked: false,
            liveDispatches: 0,
            mockedDispatches: 0,
            outputContractsValidated: 0,
            childSessionPaths: 0,
            budgetGate: strictBudgetGate,
            comsLiveGate: { passed: false, errors: liveComsErrors, bodyStored: false },
            noMockReady,
            finalGate,
            results: [],
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          };
          writeFileSync(join(runDir, "agentic-results.json"), JSON.stringify(liveBlockedExecution, null, 2), "utf8");
          validation.status = "failed";
          validation.budgetGate = strictBudgetGate;
          validation.agenticExecution = { schema: liveBlockedExecution.schema, status: liveBlockedExecution.status, tasks: liveBlockedExecution.tasks, completed: liveBlockedExecution.completed, failed: liveBlockedExecution.failed, dispatcher: liveBlockedExecution.dispatcher, mocked: liveBlockedExecution.mocked, liveDispatches: 0, mockedDispatches: 0, outputContractsValidated: 0, childSessionPaths: 0, budgetGate: strictBudgetGate, comsLiveGate: liveBlockedExecution.comsLiveGate, noMockReady, finalGate };
          validation.phaseSentinel = { mode, artifact: phaseSentinel, written: false, validationRequired: true };
          validation.sentinelWritten = false;
          validation.completionArtifactsPresent = ["manifest.json", "ledger.jsonl", "agentic-plan.json", "final-report.md", phaseSentinel, "DONE.sentinel"].map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) }));
          writeFileSync(validationPath, JSON.stringify(validation, null, 2), "utf8");
          writeFileSync(join(runDir, "final-report.md"), [`# Factory Run Report`, ``, `- runId: ${result.runId}`, `- factory: ${params.factory}`, `- status: failed`, `- execution: agentic`, `- agentic_tasks: ${tasks.length}`, `- agentic_completed: 0`, `- agentic_failed: ${tasks.length}`, `- live_dispatches: 0`, `- mocked_dispatches: 0`, `- zob_coms_live_gate: blocked`, `- phase_sentinel: not written`, `- sentinel: not written`, ``].join("\n"), "utf8");
          factoryLedger(runDir, { event: "agentic_coms_live_blocked", errors: liveComsErrors, liveDispatches: 0, bodyStored: false });
          const blockedArtifacts = [...new Set([...result.artifacts, "agentic-results.json", "telemetry.json"])];
          result = { ...result, status: "agentic_failed", failed: tasks.length, artifacts: blockedArtifacts, errors: liveComsErrors };
          const blockedEndedAtMs = Date.now();
          const expectedArtifacts = Array.isArray(validation.expectedArtifacts) ? validation.expectedArtifacts.filter((artifact): artifact is string => typeof artifact === "string") : [];
          writeFactoryTelemetrySummary(ctx.cwd, { runId: result.runId, runDir, factory: params.factory, mode, execution: "agentic", status: result.status, itemCount: selectedItemCount, processed: typeof validation.processed === "number" ? validation.processed : result.processed, failed: initialItemFailed, expectedArtifacts, generatedArtifacts: blockedArtifacts.filter((artifact) => artifact !== "telemetry.json"), stageCount: isRecord(plan) && typeof plan.stageCount === "number" ? plan.stageCount : 0, agenticTasks: tasks.length, failuresByStage, retryCount: 0, usage: aggregateUsage, wallTimeMs: blockedEndedAtMs - initialStartedAtMs, startedAt: initialStartedAt, endedAt: new Date(blockedEndedAtMs).toISOString(), errors: result.errors, budgetEnforced: strictBudgetGate.budgetEnforced === true });
          pi.appendEntry("zob-factory-run", { runId: result.runId, factory: params.factory, inputManifest: params.input_manifest, mode, execution: "agentic", status: result.status, processed: result.processed, failed: result.failed, artifacts: result.artifacts, errors: result.errors });
          const text = [`factory_run ${result.status}: ${result.runId}`, `runDir: ${result.runDir}`, `execution: agentic`, `processed: ${result.processed}`, `failed: ${result.failed}`, `zob_coms_live_gate: blocked`, result.artifacts.length > 0 ? `artifacts:\n- ${result.artifacts.join("\n- ")}` : "artifacts: none", result.errors.length > 0 ? `errors:\n- ${result.errors.join("\n- ")}` : "errors: none"].join("\n");
          return { content: [{ type: "text", text }], details: result };
        }

        factoryLedger(runDir, { event: "agentic_execution_start", tasks: tasks.length, budgetGate: strictBudgetGate });

        for (const [index, task] of tasks.entries()) {
          if (!isRecord(task)) {
            failed += 1;
            incrementStageFailure("agentic_plan");
            stageResults.push({ index, status: "failed", errors: ["Invalid task record"] });
            break;
          }
          const agentName = typeof task.agent === "string" ? task.agent : "";
          const agent = agentsByName.get(agentName.toLowerCase());
          const requiredTools = Array.isArray(task.required_tools) ? task.required_tools.filter((tool): tool is string => typeof tool === "string") : [];
          const outputContract = typeof task.output_contract === "string" ? task.output_contract : inferOutputContract(agentName);
          const stageName = typeof task.stage === "string" ? task.stage : `stage-${index + 1}`;
          const itemId = typeof task.itemId === "string" ? task.itemId : "all-items";
          const modelRoute = evaluateModelRoutingDispatchGate({
            runId: result.runId,
            mode: "factory",
            stage: stageName,
            agent: agentName,
            taskType: `${stageName}:${agentName}`,
            outputContract,
            risk: agentName.toLowerCase().includes("oracle") || stageName.toLowerCase().includes("validate") ? "high" : "medium",
            defaultModel: params.model,
            modelRouting: params.model_routing,
          });
          const persistedModelRoute = persistableModelRouting(modelRoute);
          const routedModel = typeof modelRoute.selectedModel === "string" && modelRoute.selectedModel.length > 0 ? modelRoute.selectedModel : params.model;
          const taskErrors = [
            ...(agent ? validateToolList(agent, requiredTools) : [`Unknown agent '${agentName}'`]),
            ...validateOutputContractId(outputContract),
          ];
          if (taskErrors.length > 0 || !agent) {
            failed += 1;
            incrementStageFailure(stageName);
            const failedRecord = { index, stage: stageName, itemId, agent: agentName, status: "failed_preflight", dispatcher: "not_dispatched", mocked: false, outputContractValidated: false, modelRouting: persistedModelRoute, errors: taskErrors, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false };
            stageResults.push(failedRecord);
            writeFileSync(join(agenticResultsDir, `${safeFileStem(stageName)}-${safeFileStem(itemId)}.json`), JSON.stringify(failedRecord, null, 2), "utf8");
            factoryLedger(runDir, { event: "agentic_task_failed_preflight", index, stage: stageName, itemId, errors: taskErrors });
            break;
          }

          const adaptiveEvidenceRefs = [params.input_manifest, `.pi/factories/${params.factory}/factory.json`, "package.json"];
          const structuredTask = [
            `ORIGINAL_USER_ASK: ${state.activeGoal?.originalUserAsk ?? "Factory run"}`,
            `OUTPUT_CONTRACT: ${outputContract}`,
            "",
            `1. TASK: ${String(task.task ?? `Run factory stage ${stageName}`)}`,
            `2. EXPECTED OUTCOME: ${String(task.expected_outcome ?? `Complete ${stageName}`)}`,
            `3. REQUIRED TOOLS: ${requiredTools.join(", ")}`,
            `4. MUST DO:\n${(Array.isArray(task.must_do) ? task.must_do : ["Cite evidence", "Respect sentinels"]).map((item) => `   - ${String(item)}`).join("\n")}`,
            `5. MUST NOT DO:\n${(Array.isArray(task.must_not_do) ? task.must_not_do : ["No secrets", "No destructive commands", "No commits"]).map((item) => `   - ${String(item)}`).join("\n")}`,
            `6. CONTEXT: ${String(task.context ?? `Factory run ${result.runId}, stage ${stageName}`)}`,
            ...(factoryAdaptiveLiveProofEnabled && index === 0 ? ["", buildFactoryAdaptiveProposalGuidance({ runId: result.runId, stageName, itemId, evidenceRefs: adaptiveEvidenceRefs })] : []),
            "",
            "FINAL FORMAT:",
            "- result",
            "- evidence",
            "- risks/blockers",
            "- compliance line",
            "- Final line must be exactly: deliverable_delivered: yes",
          ].join("\n");

          onUpdate?.({ content: [{ type: "text", text: `factory_run agentic stage ${index + 1}/${tasks.length}: ${stageName}` }], details: result });
          factoryLedger(runDir, { event: "agentic_task_start", index, stage: stageName, itemId, agent: agent.name, outputContract, modelRouting: persistedModelRoute });
          const structuredTaskHash = sha256(structuredTask);
          const childResult = await runChildAgent(ctx, agent, structuredTask, ctx.cwd, signal, routedModel, requiredTools.join(","), undefined);
          childResult.outputContract = outputContract;
          applyChildGates(childResult, { repoRoot: ctx.cwd });
          addUsage(aggregateUsage, childResult.usage);

          const childOutputHash = childResult.output ? sha256(childResult.output) : undefined;
          const chronicle = classifyChronicleCompletion({
            kind: "factory",
            runId: `${result.runId}-${stageName}-${itemId}`,
            status: isFailed(childResult) ? "failed_validation" : "complete",
            taskHash: structuredTaskHash,
            outputHash: childOutputHash,
            evidencePaths: [childResult.sessionPath].filter((path): path is string => typeof path === "string"),
            assistantTurnSeen: childResult.usage.turns > 0 || childResult.output.trim().length > 0,
            outputCaptured: Boolean(childOutputHash),
            outputValidated: childResult.gatePassed === true,
            evidenceChecked: childResult.gatePassed === true && outputHasEvidenceMarker(childResult.output),
            preflightPassed: true,
            budget: { advisory: strictBudgetGate.budgetEnforced !== true, enforced: strictBudgetGate.budgetEnforced === true },
            errors: childResult.gateErrors ?? [],
          });
          const chronicleFailed = isRecord(chronicle) && (chronicle.complete !== true || chronicle.terminalFailure === true || (isRecord(chronicle.falseDoneGuard) && chronicle.falseDoneGuard.passed !== true));
          const recordStatus = isFailed(childResult) || chronicleFailed ? "failed" : "complete";
          const record = {
            index,
            stage: stageName,
            itemId,
            agent: agent.name,
            status: recordStatus,
            dispatcher: "live_child_pi",
            mocked: false,
            outputContract,
            outputContractValidated: childResult.gatePassed === true,
            modelRouting: persistedModelRoute,
            gatePassed: childResult.gatePassed,
            gateErrors: childResult.gateErrors ?? [],
            budget: { advisory: strictBudgetGate.budgetEnforced !== true, enforced: strictBudgetGate.budgetEnforced === true, dispatchDecision: strictBudgetGate.dispatchDecision },
            exitCode: childResult.exitCode,
            stopReason: childResult.stopReason,
            sessionPath: childResult.sessionPath,
            taskHash: structuredTaskHash,
            outputHash: childOutputHash,
            chronicle,
            usage: childResult.usage,
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          };
          stageResults.push(record);
          writeFileSync(join(agenticResultsDir, `${safeFileStem(stageName)}-${safeFileStem(itemId)}.json`), JSON.stringify(record, null, 2), "utf8");
          writeFileSync(join(checkpointsDir, `${safeFileStem(stageName)}-${safeFileStem(itemId)}.agentic.checkpoint.json`), JSON.stringify(record, null, 2), "utf8");
          factoryLedger(runDir, { event: "agentic_task_end", ...record });

          if (factoryAdaptiveLiveProofEnabled && !adaptiveProofAttempted && recordStatus === "complete") {
            adaptiveProofAttempted = true;
            const extraction = extractDelegationRequestsFromText(childResult.output);
            adaptiveExtractionErrors.push(...extraction.errors.map((error) => ({ sourceStage: stageName, errorHash: sha256(error), bodyStored: false, promptBodiesStored: false, outputBodiesStored: false })));
            const rawRequest = extraction.requests[0];
            const parentRequest: DelegationRequestProposal | undefined = rawRequest ? {
              ...rawRequest,
              requesterRole: `factory:${stageName}`,
              referentRole: "factory-runner",
              requesterDepth: 1,
              targetDepth: 2,
              requiredTools: rawRequest.requiredTools.filter((tool) => ["read", "grep", "find", "ls"].includes(tool)),
              evidenceRefs: rawRequest.evidenceRefs.length > 0 ? rawRequest.evidenceRefs : adaptiveEvidenceRefs,
              targetFileSet: rawRequest.targetFileSet && rawRequest.targetFileSet.length > 0 ? rawRequest.targetFileSet : adaptiveEvidenceRefs,
              bodyStored: false,
              promptBodiesStored: false,
              outputBodiesStored: false,
            } : undefined;
            if (parentRequest && adaptiveGovernorState) {
              adaptiveRequests.push(parentRequest);
              const decision = decideDelegationRequest({ repoRoot: ctx.cwd, runId: result.runId, rootGoalHash: adaptiveRootGoalHash, parentTaskId: `${stageName}:${itemId}`, request: parentRequest, policy: adaptiveDelegationPolicy });
              adaptiveDecisions.push(decision);
              adaptiveGovernorState = updateGovernorState(adaptiveGovernorState, decision);
              const contract = buildParentDispatchContractForDecision({ runId: result.runId, parentTaskId: `${stageName}:${itemId}`, request: parentRequest, decision, dispatchGate: "factory_live_readonly_proof" });
              if (decision.dispatchAllowed === true && contract) {
                adaptiveContracts.push(contract);
                const adaptiveAgent = agentsByName.get(parentRequest.requestedAgent.toLowerCase());
                const adaptiveTaskText = buildFactoryAdaptiveReadonlyTaskText({ requestId: decision.parentAssignedRequestId, request: parentRequest, runId: result.runId });
                const adaptiveTaskHash = sha256(adaptiveTaskText);
                if (!adaptiveAgent) {
                  adaptiveProofFailed = true;
                  incrementStageFailure("factory_adaptive_dispatch");
                  adaptiveDispatchRecords.push({ ...contract, status: "failed", liveDispatched: false, mocked: false, dispatcherKind: "not_dispatched", taskHash: adaptiveTaskHash, errorsHash: sha256("unknown adaptive agent"), bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
                } else {
                  factoryLedger(runDir, { event: "factory_adaptive_task_start", requestId: decision.parentAssignedRequestId, agent: adaptiveAgent.name, outputContract: parentRequest.requestedOutputContract, taskHash: adaptiveTaskHash });
                  const adaptiveChildResult = await runChildAgent(ctx, adaptiveAgent, adaptiveTaskText, ctx.cwd, signal, routedModel, parentRequest.requiredTools.join(","), undefined);
                  adaptiveChildResult.outputContract = parentRequest.requestedOutputContract;
                  applyChildGates(adaptiveChildResult, { repoRoot: ctx.cwd });
                  addUsage(aggregateUsage, adaptiveChildResult.usage);
                  const adaptiveOutputHash = adaptiveChildResult.output ? sha256(adaptiveChildResult.output) : undefined;
                  const adaptiveComplete = !isFailed(adaptiveChildResult) && adaptiveChildResult.gatePassed === true;
                  if (!adaptiveComplete) {
                    adaptiveProofFailed = true;
                    incrementStageFailure("factory_adaptive_dispatch");
                  }
                  const dispatchRecord = {
                    ...contract,
                    status: adaptiveComplete ? "completed" : "failed",
                    liveDispatched: true,
                    mocked: false,
                    dispatcherKind: "live_child_pi",
                    outputHash: adaptiveOutputHash,
                    outputContractValidated: adaptiveChildResult.gatePassed === true,
                    sessionPath: adaptiveChildResult.sessionPath,
                    gateErrorsHash: sha256((adaptiveChildResult.gateErrors ?? []).join("\n")),
                    usageHash: sha256(JSON.stringify(adaptiveChildResult.usage ?? {})),
                    bodyStored: false,
                    promptBodiesStored: false,
                    outputBodiesStored: false,
                  };
                  adaptiveDispatchRecords.push(dispatchRecord);
                  factoryLedger(runDir, { event: "factory_adaptive_task_end", requestId: decision.parentAssignedRequestId, status: dispatchRecord.status, outputHash: adaptiveOutputHash, outputContractValidated: adaptiveChildResult.gatePassed === true, sessionPath: adaptiveChildResult.sessionPath });
                }
              } else {
                adaptiveProofFailed = true;
                incrementStageFailure("factory_adaptive_dispatch");
                adaptiveDispatchRecords.push({ ...(contract ?? { requestId: decision.parentAssignedRequestId }), status: "blocked", liveDispatched: false, mocked: false, dispatcherKind: "not_dispatched", dispatchAllowed: decision.dispatchAllowed, errorsHash: sha256(decision.reasons.join("\n")), bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
              }
            } else {
              adaptiveProofFailed = true;
              incrementStageFailure("factory_adaptive_dispatch");
              adaptiveExtractionErrors.push({ sourceStage: stageName, errorHash: sha256("missing adaptive delegation request proposal"), bodyStored: false, promptBodiesStored: false, outputBodiesStored: false });
            }
          }

          if (recordStatus !== "complete") {
            failed += 1;
            incrementStageFailure(stageName);
            break;
          }
        }
        if (factoryAdaptiveLiveProofEnabled && (!adaptiveProofAttempted || adaptiveProofFailed || adaptiveDispatchRecords.length === 0)) failed += 1;

        const agenticExecutionStatus = failed === 0 && tasks.length > 0 && stageResults.length === tasks.length ? "passed" : "failed";
        const agenticCompleted = stageResults.filter((stage) => stage.status === "complete").length;
        const validationPath = join(runDir, "validation.json");
        const validation = existsSync(validationPath) && isRecord(parseJsonFile(validationPath)) ? (parseJsonFile(validationPath) as Record<string, unknown>) : {};
        validation.status = agenticExecutionStatus === "passed" ? "passed" : "failed";
        const mode = params.mode ?? "smoke";
        const phaseSentinel = mode === "pilot" || mode === "batch" ? factoryPhaseSentinelForMode(mode) : factoryPhaseSentinelForMode("smoke");

        if (agenticExecutionStatus === "passed") {
          writeFileSync(join(runDir, phaseSentinel), `${mode} agentic passed ${new Date().toISOString()}\n`, "utf8");
          writeFileSync(join(runDir, "DONE.sentinel"), `done ${new Date().toISOString()}\n`, "utf8");
          if (Array.isArray(validation.requiredStagesPresent)) {
            validation.requiredStagesPresent = validation.requiredStagesPresent.map((stage) => isRecord(stage) && (stage.stage === "sentinel" || stage.stage === "phase_sentinel") ? { ...stage, present: true } : stage);
          }
          factoryLedger(runDir, { event: "phase_sentinel", mode, execution: "agentic", sentinel: phaseSentinel, after: "agentic_validation" });
          factoryLedger(runDir, { event: "done", execution: "agentic", sentinel: "DONE.sentinel" });
          result = { ...result, status: "done", artifacts: [...new Set([...result.artifacts, "agentic-results.json", phaseSentinel, "DONE.sentinel"])] };
        } else {
          if (existsSync(join(runDir, phaseSentinel))) unlinkSync(join(runDir, phaseSentinel));
          if (existsSync(join(runDir, "DONE.sentinel"))) unlinkSync(join(runDir, "DONE.sentinel"));
          factoryLedger(runDir, { event: "agentic_execution_failed", failed });
          result = { ...result, status: "agentic_failed", failed, artifacts: [...new Set([...result.artifacts, "agentic-results.json"])], errors: ["Agentic factory execution failed"] };
        }

        const liveDispatches = stageResults.filter((stage) => stage.dispatcher === "live_child_pi").length;
        const mockedDispatches = stageResults.filter((stage) => stage.mocked === true).length;
        const outputContractsValidated = stageResults.filter((stage) => stage.outputContractValidated === true).length;
        const childSessionPaths = stageResults.filter((stage) => typeof stage.sessionPath === "string" && stage.sessionPath.length > 0).length;
        const modelRoutedStages = stageResults.filter((stage) => isRecord(stage.modelRouting) && stage.modelRouting.routingApplied === true).length;
        const modelRouterUsed = modelRoutedStages > 0;
        const modelRoutingSummary = {
          enabled: params.model_routing?.enabled === true,
          modelRouterUsed,
          routingApplied: modelRouterUsed,
          routedStages: modelRoutedStages,
          totalStages: stageResults.length,
          selectedModelClasses: [...new Set(stageResults.map((stage) => isRecord(stage.modelRouting) ? stage.modelRouting.selectedModelClass : undefined).filter((value): value is string => typeof value === "string"))].sort(),
          selectedModelStored: false,
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
        };
        const { noMockReady, finalGate } = buildAgenticFactoryNoMockFinalGate({
          status: agenticExecutionStatus,
          tasks: tasks.length,
          completed: agenticCompleted,
          failed,
          liveDispatches,
          mockedDispatches,
          outputContractsValidated,
          childSessionPaths,
          phaseSentinelWritten: existsSync(join(runDir, phaseSentinel)),
          doneSentinelWritten: existsSync(join(runDir, "DONE.sentinel")),
        });
        const agenticExecution = {
          schema: "zob.agentic-factory-execution.v1",
          status: agenticExecutionStatus,
          tasks: tasks.length,
          completed: agenticCompleted,
          failed,
          dispatcher: liveDispatches > 0 && mockedDispatches === 0 ? "live_child_pi" : "not_live",
          mocked: mockedDispatches > 0,
          liveDispatches,
          mockedDispatches,
          outputContractsValidated,
          childSessionPaths,
          noMockReady,
          finalGate,
          modelRouting: modelRoutingSummary,
          budgetGate: strictBudgetGate,
          budgetEnforced: strictBudgetGate.budgetEnforced === true,
          results: stageResults,
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
        };
        if (adaptiveGovernorState && adaptiveDelegationPolicy.enabled) {
          writeFileSync(join(runDir, "delegation-requests.json"), JSON.stringify({ schema: "zob.delegation-request-set.v1", runId: result.runId, mode: adaptiveDelegationPolicy.mode, dispatch: adaptiveDelegationPolicy.dispatch, requests: adaptiveRequests, extractionErrors: adaptiveExtractionErrors, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
          writeFileSync(join(runDir, "delegation-decisions.json"), JSON.stringify({ schema: "zob.governor-decision-set.v1", runId: result.runId, decisions: adaptiveDecisions, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
          writeFileSync(join(runDir, "delegation-governor-state.json"), JSON.stringify(adaptiveGovernorState, null, 2), "utf8");
          writeFileSync(join(runDir, "delegation-dispatches.json"), JSON.stringify({ schema: "zob.parent-dispatch-contract-set.v1", runId: result.runId, dispatches: adaptiveDispatchRecords, dispatchContractsQueued: adaptiveContracts.length, liveDispatches: adaptiveDispatchRecords.filter((record) => record.liveDispatched === true).length, completed: adaptiveDispatchRecords.filter((record) => record.status === "completed").length, failed: adaptiveDispatchRecords.filter((record) => record.status === "failed").length, mockedDispatches: adaptiveDispatchRecords.filter((record) => record.mocked === true).length, liveChildPiDispatches: adaptiveDispatchRecords.filter((record) => record.dispatcherKind === "live_child_pi").length, adaptiveLiveDispatchEnabled: factoryAdaptiveLiveProofEnabled, liveFactoryAdaptiveDispatchEnabled: factoryAdaptiveLiveProofEnabled, requestedLiveFactoryAdaptiveDispatch: adaptiveDelegationPolicy.dispatch === true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false }, null, 2), "utf8");
        }
        writeFileSync(join(runDir, "agentic-results.json"), JSON.stringify(agenticExecution, null, 2), "utf8");
        validation.budgetGate = strictBudgetGate;
        validation.agenticExecution = { schema: agenticExecution.schema, status: agenticExecution.status, tasks: agenticExecution.tasks, completed: agenticExecution.completed, failed: agenticExecution.failed, dispatcher: agenticExecution.dispatcher, mocked: agenticExecution.mocked, liveDispatches, mockedDispatches, outputContractsValidated, childSessionPaths, budgetGate: strictBudgetGate, budgetEnforced: strictBudgetGate.budgetEnforced === true, modelRouting: modelRoutingSummary, noMockReady, finalGate };
        if (isRecord(validation.adaptiveDelegation) && adaptiveDelegationPolicy.enabled) {
          validation.adaptiveDelegation = {
            ...validation.adaptiveDelegation,
            factoryIntegration: factoryAdaptiveLiveProofEnabled ? "p8_live_readonly_factory_adaptive_proof" : validation.adaptiveDelegation.factoryIntegration,
            advisoryOnly: factoryAdaptiveLiveProofEnabled ? false : validation.adaptiveDelegation.advisoryOnly,
            requestedLiveFactoryAdaptiveDispatch: adaptiveDelegationPolicy.dispatch === true,
            adaptiveLiveDispatchEnabled: factoryAdaptiveLiveProofEnabled,
            liveFactoryAdaptiveDispatchEnabled: factoryAdaptiveLiveProofEnabled,
            noExecution: !factoryAdaptiveLiveProofEnabled,
            requests: adaptiveRequests.length,
            decisions: adaptiveDecisions.length,
            dispatchContractsQueued: adaptiveContracts.length,
            adaptiveDispatchesExecuted: adaptiveDispatchRecords.filter((record) => record.liveDispatched === true).length,
            adaptiveDispatchesCompleted: adaptiveDispatchRecords.filter((record) => record.status === "completed").length,
            adaptiveDispatchesFailed: adaptiveDispatchRecords.filter((record) => record.status === "failed").length,
            adaptiveDispatchesMocked: adaptiveDispatchRecords.filter((record) => record.mocked === true).length,
            adaptiveLiveChildPiDispatches: adaptiveDispatchRecords.filter((record) => record.dispatcherKind === "live_child_pi").length,
            extractionErrors: adaptiveExtractionErrors.length,
            bodyStored: false,
            promptBodiesStored: false,
            outputBodiesStored: false,
          };
        }
        validation.phaseSentinel = { mode, artifact: phaseSentinel, written: existsSync(join(runDir, phaseSentinel)), validationRequired: true };
        validation.sentinelWritten = existsSync(join(runDir, "DONE.sentinel"));
        validation.completionArtifactsPresent = ["manifest.json", "ledger.jsonl", "agentic-plan.json", "final-report.md", phaseSentinel, "DONE.sentinel"].map((artifact) => ({ artifact, exists: existsSync(join(runDir, artifact)) }));
        writeFileSync(validationPath, JSON.stringify(validation, null, 2), "utf8");
        writeFileSync(join(runDir, "final-report.md"), [`# Factory Run Report`, ``, `- runId: ${result.runId}`, `- factory: ${params.factory}`, `- status: ${validation.status}`, `- execution: agentic`, `- agentic_tasks: ${agenticExecution.tasks}`, `- agentic_completed: ${agenticExecution.completed}`, `- agentic_failed: ${agenticExecution.failed}`, `- live_dispatches: ${liveDispatches}`, `- mocked_dispatches: ${mockedDispatches}`, `- strict_budget_gate: ${strictBudgetGate.budgetEnforced === true ? String(strictBudgetGate.dispatchDecision) : "advisory"}`, `- no_mock_readiness: ${noMockReady ? "passed" : "failed"}`, `- no_mock_reason: ${String(finalGate.reason)}`, `- phase_sentinel: ${existsSync(join(runDir, phaseSentinel)) ? phaseSentinel : "not written"}`, `- sentinel: ${existsSync(join(runDir, "DONE.sentinel")) ? "DONE.sentinel" : "not written"}`, ``].join("\n"), "utf8");

        if (agenticExecution.status === "failed" && Object.keys(failuresByStage).length === 0) failuresByStage.agentic_execution = 1;
        const expectedArtifacts = Array.isArray(validation.expectedArtifacts) ? validation.expectedArtifacts.filter((artifact): artifact is string => typeof artifact === "string") : [];
        const generatedArtifacts = [...new Set(result.artifacts.filter((artifact) => artifact !== "telemetry.json"))];
        const agenticEndedAtMs = Date.now();
        writeFactoryTelemetrySummary(ctx.cwd, {
          runId: result.runId,
          runDir,
          factory: params.factory,
          mode: params.mode ?? "smoke",
          execution: "agentic",
          status: result.status,
          itemCount: selectedItemCount,
          processed: typeof validation.processed === "number" ? validation.processed : result.processed,
          failed: initialItemFailed,
          expectedArtifacts,
          generatedArtifacts,
          stageCount: isRecord(plan) && typeof plan.stageCount === "number" ? plan.stageCount : 0,
          agenticTasks: tasks.length,
          failuresByStage,
          retryCount: 0,
          usage: aggregateUsage,
          wallTimeMs: agenticEndedAtMs - initialStartedAtMs,
          startedAt: initialStartedAt,
          endedAt: new Date(agenticEndedAtMs).toISOString(),
          errors: result.errors,
          budgetEnforced: strictBudgetGate.budgetEnforced === true,
          modelRouterUsed,
        });
        result = { ...result, artifacts: [...new Set([...result.artifacts, "telemetry.json"])] };
      }

      pi.appendEntry("zob-factory-run", {
        runId: result.runId,
        factory: params.factory,
        inputManifest: params.input_manifest,
        mode: params.mode ?? "smoke",
        execution: params.execution ?? "deterministic",
        status: result.status,
        processed: result.processed,
        failed: result.failed,
        artifacts: result.artifacts,
        errors: result.errors,
      });
      const text = [
        `factory_run ${result.status}: ${result.runId}`,
        `runDir: ${result.runDir}`,
        `execution: ${params.execution ?? "deterministic"}`,
        `processed: ${result.processed}`,
        `failed: ${result.failed}`,
        result.artifacts.length > 0 ? `artifacts:\n- ${result.artifacts.join("\n- ")}` : "artifacts: none",
        result.errors.length > 0 ? `errors:\n- ${result.errors.join("\n- ")}` : "errors: none",
      ].join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
