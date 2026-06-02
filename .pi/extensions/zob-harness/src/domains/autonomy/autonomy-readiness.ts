import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildAutonomousRuntimeDryRun, validateAutonomousReadOnlySmokeRunArtifacts, validateAutonomousRuntimeDryRunArtifacts } from "./autonomous-runtime.js";
import { buildCapabilityIndex } from "../delegation/capabilities.js";
import { buildContextGbrainReadinessAudit } from "../context/context-gbrain.js";
import { loadFactoryDefinition, loadFactoryInputManifest, validateFactoryStages } from "../factory/validation.js";
import { validateStrictGoalSpecAnchor } from "../goal/goal.js";
import { validateDelegationWriteScope } from "../governance/safety.js";
import { sha256 } from "../../core/utils/hashing.js";
import { parseJsonFile } from "../../core/utils/json.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export interface AutonomyReadinessAuditInput {
  run_id?: string;
  autonomous_dry_run_id?: string;
  autonomous_readonly_smoke_run_id?: string;
}

export interface FactoryRegistryReadinessInput {
  run_id?: string;
}

const FORBIDDEN_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content", "patch", "diff"]);

const REGISTERED_FACTORY_CHAIN = {
  smoke: "registered-agentic-factory-proof-smoke-v28",
  pilot: "registered-agentic-factory-proof-pilot-v24",
  batch: "registered-agentic-factory-proof-batch-v22",
};

const REGISTERED_FACTORY_CURRENT_CHAIN_LOG = "reports/harness-registered-agentic-factory-current-chain-post-autonomous-p0-v28.log";
const RUN_ID_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const REGISTERED_FACTORY_SOURCE_FINGERPRINT_BASE_FILES = [
  "package.json",
  "scripts/run-registered-agentic-factory-proof.mjs",
  "scripts/verify-agentic-factory-proof.mjs",
  "scripts/audit-agentic-factory-promotion.mjs",
  "scripts/audit-agentic-factory-batch-promotion.mjs",
  ".pi/budget-policy.json",
  ".pi/model-routing.json",
  ".pi/extensions/zob-harness/index.ts",
  ".pi/extensions/zob-harness/src/runtime/tools-factory.ts",
  ".pi/extensions/zob-harness/src/domains/governance/budget-policy.ts",
  ".pi/extensions/zob-harness/src/domains/models/model-routing.ts",
  ".pi/extensions/zob-harness/src/runtime/schemas.ts",
  ".pi/extensions/zob-harness/src/types.ts",
  ".pi/extensions/zob-harness/src/domains/telemetry/telemetry.ts",
  ".pi/extensions/zob-harness/src/domains/factory/run.ts",
  ".pi/extensions/zob-harness/src/domains/factory/agentic-plan.ts",
  ".pi/extensions/zob-harness/src/domains/factory/validation.ts",
  ".pi/extensions/zob-harness/src/domains/delegation/child-runner.ts",
  ".pi/extensions/zob-harness/src/domains/delegation/output-contracts.ts",
];

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort();
}

function listRepoFilesUnder(repoRoot: string, relativeDir: string, predicate: (file: string) => boolean = () => true): string[] {
  const absoluteDir = join(repoRoot, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  const results: string[] = [];
  const visit = (relativePath: string): void => {
    for (const entry of readdirSync(join(repoRoot, relativePath))) {
      const childRelative = `${relativePath}/${entry}`;
      const childStat = statSync(join(repoRoot, childRelative));
      if (childStat.isDirectory()) visit(childRelative);
      else if (childStat.isFile() && predicate(childRelative)) results.push(childRelative);
    }
  };
  visit(relativeDir);
  return results;
}

function registeredFactoryManifestModes(mode: "smoke" | "pilot" | "batch"): Array<"smoke" | "pilot" | "batch"> {
  if (mode === "smoke") return ["smoke"];
  if (mode === "pilot") return ["smoke", "pilot"];
  return ["smoke", "pilot", "batch"];
}

function registeredFactorySourceFingerprintFiles(repoRoot: string, factoryName: string, mode: "smoke" | "pilot" | "batch"): string[] | undefined {
  const factoryJsonPath = `.pi/factories/${factoryName}/factory.json`;
  const factoryPath = join(repoRoot, factoryJsonPath);
  if (!existsSync(factoryPath)) return undefined;
  const definition = readRecord(factoryPath);
  const stages = Array.isArray(definition?.stages) ? definition.stages.filter(isRecord) : [];
  const stageFiles = stages.flatMap((stage) => [
    typeof stage.agent === "string" ? `.pi/agents/${stage.agent}.md` : undefined,
    typeof stage.outputContract === "string" ? `.pi/output-contracts/${stage.outputContract}.json` : undefined,
  ]).filter((item): item is string => typeof item === "string");
  const manifestFiles = registeredFactoryManifestModes(mode).map((manifestMode) => `.pi/factories/${factoryName}/${manifestMode}-manifest.json`);
  const extensionSourceFiles = listRepoFilesUnder(repoRoot, ".pi/extensions/zob-harness/src", (file) => file.endsWith(".ts"));
  return uniqueSorted([...REGISTERED_FACTORY_SOURCE_FINGERPRINT_BASE_FILES, ...extensionSourceFiles, factoryJsonPath, ...manifestFiles, ...stageFiles]);
}

function registeredFactoryCurrentFileHashes(repoRoot: string, factoryName: string, mode: "smoke" | "pilot" | "batch"): Record<string, string> | undefined {
  const files = registeredFactorySourceFingerprintFiles(repoRoot, factoryName, mode);
  if (!files) return undefined;
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const absolute = join(repoRoot, file);
    if (!existsSync(absolute)) return undefined;
    hashes[file] = sha256(readFileSync(absolute, "utf8"));
  }
  return hashes;
}

function parseJsonRecordDetail(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function registeredInvocationFreshSource(invocation: Record<string, unknown> | undefined, mode: "smoke" | "pilot" | "batch"): boolean {
  if (!invocation || invocation.schema !== "zob.registered-agentic-factory-proof-invocation.v1") return false;
  if (invocation.mode !== mode || invocation.execution !== "agentic") return false;
  const factoryName = typeof invocation.factory === "string" ? invocation.factory : undefined;
  const sourceFingerprint = isRecord(invocation.sourceFingerprint) ? invocation.sourceFingerprint : undefined;
  const storedFileHashes = isRecord(sourceFingerprint?.fileHashes) ? sourceFingerprint.fileHashes : undefined;
  const storedHash = typeof sourceFingerprint?.fingerprintHash === "string" ? sourceFingerprint.fingerprintHash : undefined;
  if (!factoryName || sourceFingerprint?.schema !== "zob.registered-agentic-factory-source-fingerprint.v1" || sourceFingerprint.algorithm !== "sha256" || sourceFingerprint.factory !== factoryName || sourceFingerprint.mode !== mode || !storedFileHashes || !storedHash) return false;
  if (Object.values(storedFileHashes).some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) return false;
  return storedHash === sha256(JSON.stringify(storedFileHashes));
}

function stringHashRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, hash]) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function hashRecordsEqual(left: Record<string, string> | undefined, right: Record<string, string> | undefined): boolean {
  if (!left || !right) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys) && leftKeys.every((key) => left[key] === right[key]);
}

function registeredFreshSourceProofPassed(repoRoot: string, runId: string, verification: Record<string, unknown> | undefined, invocation: Record<string, unknown> | undefined, mode: "smoke" | "pilot" | "batch"): boolean {
  if (!registeredInvocationFreshSource(invocation, mode)) return false;
  if (invocation?.runId !== runId || invocation.bodyStored !== false || invocation.promptBodiesStored !== false || invocation.outputBodiesStored !== false) return false;
  const factoryName = typeof invocation.factory === "string" ? invocation.factory : undefined;
  const sourceFingerprint = isRecord(invocation.sourceFingerprint) ? invocation.sourceFingerprint : undefined;
  const storedFileHashes = stringHashRecord(sourceFingerprint?.fileHashes);
  const currentFileHashes = factoryName ? registeredFactoryCurrentFileHashes(repoRoot, factoryName, mode) : undefined;
  const fingerprintHash = typeof sourceFingerprint?.fingerprintHash === "string" ? sourceFingerprint.fingerprintHash : undefined;
  const currentFingerprintHash = currentFileHashes ? sha256(JSON.stringify(currentFileHashes)) : undefined;
  const checks = Array.isArray(verification?.checks) ? verification.checks.filter(isRecord) : [];
  const freshSource = checks.find((item) => item.name === "registered_tool_invocation_fresh_source");
  const detail = parseJsonRecordDetail(freshSource?.detail);
  return verification?.verdict === "PASS"
    && verification.no_ship === false
    && Array.isArray(verification.failedChecks)
    && verification.failedChecks.length === 0
    && freshSource?.passed === true
    && detail?.runId === runId
    && detail.status === "done"
    && detail.fingerprintHash === fingerprintHash
    && detail.expectedFingerprintHash === currentFingerprintHash
    && fingerprintHash === currentFingerprintHash
    && hashRecordsEqual(storedFileHashes, currentFileHashes);
}

function registeredChainLogPassed(path: string, requiredRunIds: string[]): boolean {
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, "utf8");
    return requiredRunIds.every((runId) => text.includes(runId)) && (text.includes("ALL_CHAINS_DONE") || text.includes("ALL_15_VERIFIED"));
  } catch {
    return false;
  }
}

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

function readRecord(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseJsonFile(path);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function artifact(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { path, present: false };
  return { path, present: true, hash: sha256(readFileSync(path, "utf8")) };
}

function check(name: string, passed: boolean, detail: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, passed, detail };
}

function verificationPassed(repoRoot: string, runId: string, mode: "smoke" | "pilot" | "batch"): Record<string, unknown> {
  const runDir = join(repoRoot, "reports", "factory-runs", runId);
  const verificationPath = join(runDir, "agentic-factory-proof-verification.json");
  const validationPath = join(runDir, "validation.json");
  const invocationPath = join(runDir, "registered-agentic-factory-proof-invocation.json");
  const verification = readRecord(verificationPath);
  const validation = readRecord(validationPath);
  const invocation = readRecord(invocationPath);
  const checks = Array.isArray(verification?.checks) ? verification.checks.filter(isRecord) : [];
  const freshSource = checks.find((item) => item.name === "registered_tool_invocation_fresh_source");
  const currentFreshSource = registeredFreshSourceProofPassed(repoRoot, runId, verification, invocation, mode);
  const agenticExecution = isRecord(validation?.agenticExecution) ? validation.agenticExecution : undefined;
  const finalGate = isRecord(agenticExecution?.finalGate) ? agenticExecution.finalGate : undefined;
  return {
    runId,
    mode,
    verification: artifact(verificationPath),
    validation: artifact(validationPath),
    invocation: artifact(invocationPath),
    passed: verification?.verdict === "PASS"
      && verification.no_ship === false
      && Array.isArray(verification.failedChecks)
      && verification.failedChecks.length === 0
      && validation?.status === "passed"
      && validation.mode === mode
      && validation.execution === "agentic"
      && agenticExecution?.dispatcher === "live_child_pi"
      && agenticExecution.mocked === false
      && agenticExecution.mockedDispatches === 0
      && agenticExecution.noMockReady === true
      && finalGate?.passed === true
      && finalGate.no_ship === false
      && freshSource?.passed === true
      && currentFreshSource === true
      && invocation?.bodyStored === false
      && invocation.promptBodiesStored === false
      && invocation.outputBodiesStored === false,
    liveDispatches: agenticExecution?.liveDispatches,
    mockedDispatches: agenticExecution?.mockedDispatches,
    contractsValidated: agenticExecution?.outputContractsValidated,
    childSessionPaths: agenticExecution?.childSessionPaths,
    freshSourcePassed: freshSource?.passed === true,
    currentFreshSourcePassed: currentFreshSource,
    phaseSentinel: validation?.phaseSentinel,
  };
}

function exactFailedChecks(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string")
    && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
}

function runRecordTimestamp(run: Record<string, unknown>): number {
  if (typeof run.verificationGeneratedAt === "string") {
    const parsed = Date.parse(run.verificationGeneratedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function compareRunRecords(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftTimestamp = runRecordTimestamp(left);
  const rightTimestamp = runRecordTimestamp(right);
  if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  const leftRunId = typeof left.runId === "string" ? left.runId : "";
  const rightRunId = typeof right.runId === "string" ? right.runId : "";
  return RUN_ID_COLLATOR.compare(leftRunId, rightRunId);
}

function listFactoryNames(repoRoot: string): string[] {
  const dir = join(repoRoot, ".pi", "factories");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "factory.json"))).sort();
}

function manifestSummary(repoRoot: string, factoryName: string, mode: "smoke" | "pilot" | "batch"): Record<string, unknown> {
  const relativePath = `.pi/factories/${factoryName}/${mode}-manifest.json`;
  const loaded = loadFactoryInputManifest(repoRoot, relativePath);
  return {
    mode,
    path: relativePath,
    present: existsSync(join(repoRoot, relativePath)),
    valid: loaded.errors.length === 0 && loaded.manifest?.factory === factoryName,
    itemCount: loaded.manifest?.items.length ?? 0,
    errors: loaded.errors,
    manifestHash: existsSync(join(repoRoot, relativePath)) ? sha256(readFileSync(join(repoRoot, relativePath), "utf8")) : undefined,
    bodyStored: false,
  };
}

function factoryRunCoverage(repoRoot: string, factoryName: string): Record<string, unknown> {
  const root = join(repoRoot, "reports", "factory-runs");
  const byMode: Record<string, Array<Record<string, unknown>>> = { smoke: [], pilot: [], batch: [] };
  if (existsSync(root)) {
    for (const runId of readdirSync(root).sort(RUN_ID_COLLATOR.compare)) {
      const validationPath = join(root, runId, "validation.json");
      if (!existsSync(validationPath)) continue;
      const validation = readRecord(validationPath);
      if (validation?.factory !== factoryName) continue;
      const mode = typeof validation.mode === "string" ? validation.mode : "unknown";
      if (!Array.isArray(byMode[mode])) continue;
      const verificationPath = join(root, runId, "agentic-factory-proof-verification.json");
      const verification = readRecord(verificationPath);
      const checks = Array.isArray(verification?.checks) ? verification.checks.filter(isRecord) : [];
      const freshSource = checks.find((item) => item.name === "registered_tool_invocation_fresh_source");
      const invocation = readRecord(join(root, runId, "registered-agentic-factory-proof-invocation.json"));
      const currentFreshSource = mode === "smoke" || mode === "pilot" || mode === "batch" ? registeredFreshSourceProofPassed(repoRoot, runId, verification, invocation, mode) : false;
      const agenticExecution = isRecord(validation.agenticExecution) ? validation.agenticExecution : undefined;
      const finalGate = isRecord(agenticExecution?.finalGate) ? agenticExecution.finalGate : undefined;
      const budgetGate = isRecord(agenticExecution?.budgetGate) ? agenticExecution.budgetGate : isRecord(validation.budgetGate) ? validation.budgetGate : undefined;
      const modelRouting = isRecord(agenticExecution?.modelRouting) ? agenticExecution.modelRouting : undefined;
      const phaseSentinel = isRecord(validation.phaseSentinel) ? validation.phaseSentinel : undefined;
      const pilotGate = isRecord(validation.pilotGate) ? validation.pilotGate : undefined;
      const batchGate = isRecord(validation.batchGate) ? validation.batchGate : undefined;
      const prerequisiteRunId = mode === "pilot" && typeof pilotGate?.smokeRunId === "string" ? pilotGate.smokeRunId : mode === "batch" && typeof batchGate?.pilotRunId === "string" ? batchGate.pilotRunId : undefined;
      const phaseArtifact = typeof phaseSentinel?.artifact === "string" ? phaseSentinel.artifact : mode === "smoke" ? "SMOKE_PASSED.sentinel" : mode === "pilot" ? "PILOT_PASSED.sentinel" : mode === "batch" ? "BATCH_PASSED.sentinel" : undefined;
      const entry = {
        runId,
        mode,
        prerequisiteRunId,
        verificationGeneratedAt: typeof verification?.generatedAt === "string" ? verification.generatedAt : undefined,
        execution: validation.execution,
        status: validation.status,
        passed: validation.status === "passed" && validation.sentinelWritten === true && phaseSentinel?.written === true,
        agentic: validation.execution === "agentic",
        noMockReady: agenticExecution?.noMockReady === true && finalGate?.passed === true && finalGate.no_ship === false,
        registeredFreshSource: freshSource?.passed === true && currentFreshSource === true,
        storedRegisteredFreshSource: freshSource?.passed === true,
        currentRegisteredFreshSource: currentFreshSource,
        verificationPassed: verification?.verdict === "PASS" && verification.no_ship === false && Array.isArray(verification.failedChecks) && verification.failedChecks.length === 0,
        strictBudgetEnforced: budgetGate?.schema === "zob.strict-budget-dispatch-gate.v1" && budgetGate.strictEnabled === true && budgetGate.budgetEnforced === true && budgetGate.passed === true && budgetGate.dispatchDecision === "allow_strict" && budgetGate.wouldBlockDispatch === false && budgetGate.childDispatchAllowed === true && agenticExecution?.budgetEnforced === true,
        modelRoutingApplied: modelRouting?.enabled === true && modelRouting.modelRouterUsed === true && modelRouting.routingApplied === true && modelRouting.routedStages === agenticExecution?.tasks && modelRouting.totalStages === agenticExecution?.tasks && modelRouting.selectedModelStored === false,
        phaseSentinel: phaseArtifact,
        phaseSentinelPresent: typeof phaseArtifact === "string" && existsSync(join(root, runId, phaseArtifact)),
        doneSentinelPresent: existsSync(join(root, runId, "DONE.sentinel")),
        bodyStored: false,
      };
      byMode[mode].push(entry);
    }
  }
  const latestByMode = Object.fromEntries(Object.entries(byMode).map(([mode, runs]) => [mode, [...runs].sort(compareRunRecords).at(-1)]));
  const registeredProofReady = (run: unknown): boolean => isRecord(run)
    && run.passed === true
    && run.agentic === true
    && run.noMockReady === true
    && run.registeredFreshSource === true
    && run.verificationPassed === true
    && run.phaseSentinelPresent === true
    && run.doneSentinelPresent === true;
  const strictRoutingProofReady = (run: unknown): boolean => registeredProofReady(run)
    && isRecord(run)
    && run.strictBudgetEnforced === true
    && run.modelRoutingApplied === true;
  const runById = new Map<string, Record<string, unknown>>();
  for (const run of Object.values(byMode).flat()) {
    if (typeof run.runId === "string") runById.set(run.runId, run);
  }
  let linkedRegisteredChain: { smoke: Record<string, unknown>; pilot: Record<string, unknown>; batch: Record<string, unknown> } | undefined;
  let linkedStrictRoutingChain: { smoke: Record<string, unknown>; pilot: Record<string, unknown>; batch: Record<string, unknown> } | undefined;
  for (const batch of [...byMode.batch].sort(compareRunRecords).reverse()) {
    const pilotRunId = typeof batch.prerequisiteRunId === "string" ? batch.prerequisiteRunId : undefined;
    const pilot = pilotRunId ? runById.get(pilotRunId) : undefined;
    const smokeRunId = typeof pilot?.prerequisiteRunId === "string" ? pilot.prerequisiteRunId : undefined;
    const smoke = smokeRunId ? runById.get(smokeRunId) : undefined;
    if (smoke && pilot && strictRoutingProofReady(smoke) && strictRoutingProofReady(pilot) && strictRoutingProofReady(batch)) {
      linkedStrictRoutingChain = { smoke, pilot, batch };
      linkedRegisteredChain = linkedRegisteredChain ?? { smoke, pilot, batch };
      break;
    }
    if (!linkedRegisteredChain && smoke && pilot && registeredProofReady(smoke) && registeredProofReady(pilot) && registeredProofReady(batch)) {
      linkedRegisteredChain = { smoke, pilot, batch };
    }
  }
  const bestByMode = linkedRegisteredChain ? {
    smoke: linkedRegisteredChain.smoke,
    pilot: linkedRegisteredChain.pilot,
    batch: linkedRegisteredChain.batch,
  } : Object.fromEntries(Object.entries(byMode).map(([mode, runs]) => {
    const sortedRuns = [...runs].sort(compareRunRecords);
    const preferred = [...sortedRuns].reverse().find((run) => registeredProofReady(run))
      ?? [...sortedRuns].reverse().find((run) => run.passed === true)
      ?? sortedRuns.at(-1);
    return [mode, preferred];
  }));
  const bestStrictRoutingByMode = linkedStrictRoutingChain ? {
    smoke: linkedStrictRoutingChain.smoke,
    pilot: linkedStrictRoutingChain.pilot,
    batch: linkedStrictRoutingChain.batch,
  } : Object.fromEntries(Object.entries(byMode).map(([mode, runs]) => {
    const sortedRuns = [...runs].sort(compareRunRecords);
    const preferred = [...sortedRuns].reverse().find((run) => strictRoutingProofReady(run));
    return [mode, preferred];
  }));
  const registeredProofChain = linkedRegisteredChain ? {
    smokeRunId: linkedRegisteredChain.smoke.runId,
    pilotRunId: linkedRegisteredChain.pilot.runId,
    batchRunId: linkedRegisteredChain.batch.runId,
    linked: true,
    durableVerifierFreshSource: true,
    bodyStored: false,
  } : undefined;
  const strictRoutingProofChain = linkedStrictRoutingChain ? {
    smokeRunId: linkedStrictRoutingChain.smoke.runId,
    pilotRunId: linkedStrictRoutingChain.pilot.runId,
    batchRunId: linkedStrictRoutingChain.batch.runId,
    linked: true,
    strictBudgetEnforced: true,
    modelRoutingApplied: true,
    durableVerifierFreshSource: true,
    bodyStored: false,
  } : undefined;
  return { byMode, latestByMode, bestByMode, bestStrictRoutingByMode, registeredProofChain, strictRoutingProofChain };
}

function proofPlanForFactory(factoryName: string, manifests: Record<string, Record<string, unknown>>, readiness: Record<string, unknown>): Record<string, unknown> {
  const requiredModes = ["smoke", "pilot", "batch"];
  const missingManifests = requiredModes.filter((mode) => !isRecord(manifests[mode]) || manifests[mode].valid !== true);
  const missingProofs = [
    ...(readiness.registeredSmokeReady === true ? [] : ["registered_current_source_agentic_smoke"]),
    ...(readiness.registeredPilotReady === true ? [] : ["registered_current_source_agentic_pilot"]),
    ...(readiness.registeredBatchReady === true ? [] : ["registered_current_source_agentic_batch"]),
  ];
  const missingStrictRoutingProofs = [
    ...(readiness.strictRoutingSmokeReady === true ? [] : ["strict_budget_model_routing_agentic_smoke"]),
    ...(readiness.strictRoutingPilotReady === true ? [] : ["strict_budget_model_routing_agentic_pilot"]),
    ...(readiness.strictRoutingBatchReady === true ? [] : ["strict_budget_model_routing_agentic_batch"]),
  ];
  const completeForRegisteredPath = readiness.registeredAgenticBatchReady === true;
  return {
    factory: factoryName,
    completeForRegisteredPath,
    completeForStrictBudgetModelRoutingPath: readiness.strictBudgetModelRoutingAgenticBatchReady === true,
    arbitraryAutonomyReady: false,
    nextProofMode: completeForRegisteredPath ? "none_single_path_ready" : missingManifests.includes("smoke") || missingProofs.includes("registered_current_source_agentic_smoke") ? "smoke" : missingManifests.includes("pilot") || missingProofs.includes("registered_current_source_agentic_pilot") ? "pilot" : "batch",
    missingManifests,
    missingProofs: completeForRegisteredPath ? [] : missingProofs,
    missingStrictBudgetModelRoutingProofs: readiness.strictBudgetModelRoutingAgenticBatchReady === true ? [] : missingStrictRoutingProofs,
    requiredEvidence: [
      "registered factory_run invocation through tool entrypoint",
      "agentic-factory-proof-verification PASS/no_ship=false",
      "registered_tool_invocation_fresh_source passed",
      "persisted oracle review PASS/no_ship=false before promotion",
      "phase sentinel and DONE.sentinel",
      "body-free/hash-only child result metadata",
      "strict_budget_enforced_allow_gate verifier check for strict-routing scope",
      "live_model_routing_applied verifier check for strict-routing scope",
    ],
    noShipUntilComplete: !completeForRegisteredPath,
    bodyStored: false,
  };
}

function buildFactoryRegistryReadiness(repoRoot: string): Record<string, unknown> {
  const factories = listFactoryNames(repoRoot).map((factoryName) => {
    const loaded = loadFactoryDefinition(repoRoot, factoryName);
    const definition = loaded.definition;
    const stageErrors = validateFactoryStages(repoRoot, definition);
    const stages = definition?.stages ?? [];
    const manifests = {
      smoke: manifestSummary(repoRoot, factoryName, "smoke"),
      pilot: manifestSummary(repoRoot, factoryName, "pilot"),
      batch: manifestSummary(repoRoot, factoryName, "batch"),
    };
    const coverage = factoryRunCoverage(repoRoot, factoryName);
    const bestByMode = isRecord(coverage.bestByMode) ? coverage.bestByMode : {};
    const bestStrictRoutingByMode = isRecord(coverage.bestStrictRoutingByMode) ? coverage.bestStrictRoutingByMode : {};
    const smokeReady = isRecord(bestByMode.smoke) && bestByMode.smoke.passed === true;
    const pilotReady = isRecord(bestByMode.pilot) && bestByMode.pilot.passed === true;
    const batchReady = isRecord(bestByMode.batch) && bestByMode.batch.passed === true;
    const registeredProofReady = (run: unknown): boolean => isRecord(run)
      && run.passed === true
      && run.agentic === true
      && run.noMockReady === true
      && run.registeredFreshSource === true
      && run.verificationPassed === true
      && run.phaseSentinelPresent === true
      && run.doneSentinelPresent === true;
    const strictRoutingProofReady = (run: unknown): boolean => registeredProofReady(run)
      && isRecord(run)
      && run.strictBudgetEnforced === true
      && run.modelRoutingApplied === true;
    const registeredSmokeReady = registeredProofReady(bestByMode.smoke);
    const registeredPilotReady = registeredProofReady(bestByMode.pilot);
    const registeredBatchReady = registeredProofReady(bestByMode.batch);
    const registeredAgenticBatchReady = registeredSmokeReady && registeredPilotReady && registeredBatchReady;
    const strictRoutingSmokeReady = strictRoutingProofReady(bestStrictRoutingByMode.smoke);
    const strictRoutingPilotReady = strictRoutingProofReady(bestStrictRoutingByMode.pilot);
    const strictRoutingBatchReady = strictRoutingProofReady(bestStrictRoutingByMode.batch);
    const strictBudgetModelRoutingAgenticBatchReady = strictRoutingSmokeReady && strictRoutingPilotReady && strictRoutingBatchReady;
    const readiness = {
      smokeValidated: smokeReady,
      pilotValidated: pilotReady,
      batchValidated: batchReady,
      registeredSmokeReady,
      registeredPilotReady,
      registeredBatchReady,
      registeredAgenticBatchReady,
      strictRoutingSmokeReady,
      strictRoutingPilotReady,
      strictRoutingBatchReady,
      strictBudgetModelRoutingAgenticBatchReady,
      arbitraryAutonomyReady: false,
      noShipReason: strictBudgetModelRoutingAgenticBatchReady ? "registered factory path proven with strict budget and live model routing; arbitrary autonomy still requires full registry proof matrix" : registeredAgenticBatchReady ? "registered factory path proven without strict budget/model-routing proof for all phases" : "missing registered current-source smoke/pilot/batch proof chain",
    };
    return {
      name: factoryName,
      definition: {
        path: `.pi/factories/${factoryName}/factory.json`,
        valid: loaded.errors.length === 0 && stageErrors.length === 0,
        errors: [...loaded.errors, ...stageErrors],
        definitionHash: existsSync(join(repoRoot, ".pi", "factories", factoryName, "factory.json")) ? sha256(readFileSync(join(repoRoot, ".pi", "factories", factoryName, "factory.json"), "utf8")) : undefined,
        descriptionHash: definition?.description ? sha256(definition.description) : undefined,
        stageCount: stages.length,
        stageAgents: [...new Set(stages.map((stage) => stage.agent))].sort(),
        outputContracts: [...new Set(stages.map((stage) => stage.outputContract))].sort(),
      },
      manifests,
      coverage,
      readiness,
      proofPlan: proofPlanForFactory(factoryName, manifests, readiness),
      bodyStored: false,
    };
  });
  const missingRegisteredBatchProof = factories.filter((factory) => !isRecord(factory.readiness) || factory.readiness.registeredAgenticBatchReady !== true).map((factory) => factory.name);
  const missingStrictRoutingBatchProof = factories.filter((factory) => !isRecord(factory.readiness) || factory.readiness.strictBudgetModelRoutingAgenticBatchReady !== true).map((factory) => factory.name);
  const unproven = missingRegisteredBatchProof;
  const arbitraryAutonomyUnproven = factories.filter((factory) => !isRecord(factory.readiness) || factory.readiness.arbitraryAutonomyReady !== true).map((factory) => factory.name);
  const registeredMatrixComplete = missingRegisteredBatchProof.length === 0;
  const strictBudgetModelRoutingMatrixComplete = missingStrictRoutingBatchProof.length === 0;
  return {
    schema: "zob.factory-registry-readiness.v1",
    factoryCount: factories.length,
    factories,
    registryIndexed: factories.length > 0,
    registeredAgenticBatchReadyFactories: factories.filter((factory) => isRecord(factory.readiness) && factory.readiness.registeredAgenticBatchReady === true).map((factory) => factory.name),
    strictBudgetModelRoutingAgenticBatchReadyFactories: factories.filter((factory) => isRecord(factory.readiness) && factory.readiness.strictBudgetModelRoutingAgenticBatchReady === true).map((factory) => factory.name),
    strictBudgetModelRoutingMatrixComplete,
    arbitraryFactoryAutonomyReady: false,
    arbitraryFactoryNoShip: true,
    unprovenFactories: unproven,
    arbitraryAutonomyUnprovenFactories: arbitraryAutonomyUnproven,
    factoriesMissingRegisteredBatchProof: missingRegisteredBatchProof,
    factoriesMissingStrictBudgetModelRoutingProof: missingStrictRoutingBatchProof,
    proofPlan: factories.map((factory) => factory.proofPlan),
    blockers: [
      ...(registeredMatrixComplete ? [] : [
        "not_all_factories_have_registered_current_source_agentic_smoke_pilot_batch_proofs",
        "registered_batch_proof_matrix_incomplete_for_all_factories",
      ]),
      ...(strictBudgetModelRoutingMatrixComplete ? [] : [
        "not_all_factories_have_strict_budget_model_routing_smoke_pilot_batch_proofs",
        "strict_budget_model_routing_proof_matrix_incomplete_for_all_factories",
      ]),
      "arbitrary_factory_autonomy_requires_spec_context_and_factory_selection_gate",
      "factory_specific_oracle_reviews_required_for_new_or_unproven_paths",
    ],
    noExecution: true,
    childDispatchAllowed: false,
    daemonStarted: false,
    networkAccessed: false,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildFactoryRegistryReadinessAudit(repoRoot: string, input: FactoryRegistryReadinessInput = {}): Record<string, unknown> {
  const report = {
    ...buildFactoryRegistryReadiness(repoRoot),
    runId: input.run_id,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(report)) throw new Error("Factory registry readiness audit would store forbidden body keys");
  return report;
}

export function writeFactoryRegistryReadinessAuditReport(repoRoot: string, runId = "factory-registry-readiness", input: FactoryRegistryReadinessInput = {}): string {
  const dir = join(repoRoot, "reports");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(buildFactoryRegistryReadinessAudit(repoRoot, { ...input, run_id: runId }), null, 2), "utf8");
  return outputPath;
}

export function buildAutonomyReadinessAudit(repoRoot: string, input: AutonomyReadinessAuditInput = {}): Record<string, unknown> {
  const smoke = verificationPassed(repoRoot, REGISTERED_FACTORY_CHAIN.smoke, "smoke");
  const pilot = verificationPassed(repoRoot, REGISTERED_FACTORY_CHAIN.pilot, "pilot");
  const batch = verificationPassed(repoRoot, REGISTERED_FACTORY_CHAIN.batch, "batch");
  const batchOraclePath = join(repoRoot, "reports", "factory-runs", REGISTERED_FACTORY_CHAIN.batch, "oracle-review-pass.json");
  const batchOracle = readRecord(batchOraclePath);
  const currentChainLogPath = join(repoRoot, REGISTERED_FACTORY_CURRENT_CHAIN_LOG);
  const sandboxIsolatedPath = join(repoRoot, "reports", "sandbox-isolated-execution-smoke.json");
  const sandboxDiffReviewPath = join(repoRoot, "reports", "sandbox-diff-review-gate-smoke.json");
  const sandboxApplySimulationPath = join(repoRoot, "reports", "sandbox-apply-simulation-smoke.json");
  const sandboxManualApplyPreflightPath = join(repoRoot, "reports", "sandbox-manual-apply-preflight-smoke.json");
  const modelRoutingPath = join(repoRoot, "reports", "model-routing-readiness-audit-smoke.json");
  const budgetPath = join(repoRoot, "reports", "budget-readiness-audit-smoke.json");
  const daemonPath = join(repoRoot, "reports", "daemon-readiness-smoke.json");
  const daemonPolicyPath = join(repoRoot, "reports", "daemon-policy-readiness-smoke.json");
  const sandboxIsolated = readRecord(sandboxIsolatedPath);
  const sandboxDiffReview = readRecord(sandboxDiffReviewPath);
  const sandboxApplySimulation = readRecord(sandboxApplySimulationPath);
  const sandboxManualApplyPreflight = readRecord(sandboxManualApplyPreflightPath);
  const modelRouting = readRecord(modelRoutingPath);
  const budget = readRecord(budgetPath);
  const daemon = readRecord(daemonPath);
  const daemonPolicy = readRecord(daemonPolicyPath);
  const currentChainLogPassed = registeredChainLogPassed(currentChainLogPath, [REGISTERED_FACTORY_CHAIN.smoke, REGISTERED_FACTORY_CHAIN.pilot, REGISTERED_FACTORY_CHAIN.batch]);
  const capabilities = buildCapabilityIndex(repoRoot);
  const capabilityCounts = isRecord(capabilities.counts) ? capabilities.counts : undefined;
  const capabilityByKind = isRecord(capabilityCounts?.byKind) ? capabilityCounts.byKind : {};
  const factoryRegistry = buildFactoryRegistryReadinessAudit(repoRoot, { run_id: input.run_id ? `${input.run_id}-factory-registry` : undefined });
  const contextGbrain = buildContextGbrainReadinessAudit(repoRoot, { runId: input.run_id ? `${input.run_id}-context-gbrain` : "autonomy-readiness-context-gbrain" });
  const autonomousDryRun = buildAutonomousRuntimeDryRun(repoRoot, {
    runId: input.run_id ? `${input.run_id}-autonomous-dry-run` : "autonomy-readiness-autonomous-dry-run",
    userNeed: "Plan a no-apply autonomous factory dry-run with context citations and oracle gates.",
    acceptanceCriteria: ["context_scope validates", "model routing plan is metadata-only", "factory selection is metadata-only", "smoke/pilot/batch proof plan is present"],
    expectedArtifacts: ["dry-run-report.json", "validation evidence summary"],
    allowedPaths: ["docs/", ".pi/extensions/zob-harness/src/"],
    applyPolicy: "no_apply",
    budgetProfile: "strict_requested",
    risk: "medium",
  });
  const autonomousDryRunArtifactValidation = input.autonomous_dry_run_id ? validateAutonomousRuntimeDryRunArtifacts(repoRoot, input.autonomous_dry_run_id) : undefined;
  const autonomousDryRunArtifactValidatorPassed = isRecord(autonomousDryRunArtifactValidation)
    && autonomousDryRunArtifactValidation.valid === true
    && autonomousDryRunArtifactValidation.noExecution === true
    && autonomousDryRunArtifactValidation.childDispatchAllowed === false
    && autonomousDryRunArtifactValidation.networkAccessed === false
    && autonomousDryRunArtifactValidation.globalAutonomyNoShip === true;
  const autonomousReadOnlySmokeValidation = input.autonomous_readonly_smoke_run_id ? validateAutonomousReadOnlySmokeRunArtifacts(repoRoot, input.autonomous_readonly_smoke_run_id) : undefined;
  const autonomousReadOnlySmokeRunDir = input.autonomous_readonly_smoke_run_id ? join(repoRoot, "reports", "autonomous-runs", safeFileStem(input.autonomous_readonly_smoke_run_id)) : undefined;
  const autonomousCompletionGate = autonomousReadOnlySmokeRunDir ? readRecord(join(autonomousReadOnlySmokeRunDir, "completion-gate.json")) : undefined;
  const autonomousFinalNoShipOracle = autonomousReadOnlySmokeRunDir ? readRecord(join(autonomousReadOnlySmokeRunDir, "final-no-ship-oracle.json")) : undefined;
  const autonomousFinalE2EProofPlan = autonomousReadOnlySmokeRunDir ? readRecord(join(autonomousReadOnlySmokeRunDir, "final-e2e-proof-plan.json")) : undefined;
  const autonomousReadOnlySmokeCompletionGatePassed = isRecord(autonomousReadOnlySmokeValidation)
    && autonomousReadOnlySmokeValidation.valid === true
    && autonomousReadOnlySmokeValidation.globalAutonomyReady === false
    && autonomousReadOnlySmokeValidation.globalAutonomyNoShip === true
    && autonomousReadOnlySmokeValidation.childDispatchAllowed === false
    && autonomousReadOnlySmokeValidation.productionWritesPerformed === false
    && autonomousReadOnlySmokeValidation.autoApply === false
    && autonomousCompletionGate?.schema === "zob.autonomous-completion-gate.v1"
    && autonomousCompletionGate.status === "blocked_for_goal_completion"
    && autonomousCompletionGate.updateGoalAllowed === false
    && autonomousCompletionGate.completionReady === false
    && autonomousCompletionGate.globalAutonomyReady === false
    && autonomousCompletionGate.globalAutonomyNoShip === true
    && isRecord(autonomousCompletionGate.decision)
    && autonomousCompletionGate.decision.updateGoalStatusCompleteAllowed === false
    && autonomousCompletionGate.decision.writeGlobalReadySentinelAllowed === false
    && autonomousFinalNoShipOracle?.schema === "zob.autonomous-final-no-ship-oracle.v1"
    && autonomousFinalNoShipOracle.verdict === "FAIL"
    && autonomousFinalNoShipOracle.no_ship === true
    && autonomousFinalNoShipOracle.globalAutonomyReady === false
    && autonomousFinalNoShipOracle.globalAutonomyNoShip === true
    && autonomousFinalE2EProofPlan?.schema === "zob.autonomous-final-e2e-proof-plan.v1"
    && autonomousFinalE2EProofPlan.status === "blocked_for_final_e2e_proof"
    && autonomousFinalE2EProofPlan.finalE2EProofReady === false
    && autonomousFinalE2EProofPlan.no_ship === true
    && autonomousFinalE2EProofPlan.globalAutonomyReady === false
    && autonomousFinalE2EProofPlan.globalAutonomyNoShip === true;
  const strictGoalSpecGate = validateStrictGoalSpecAnchor({ kind: "orchestrate_run", goal: "Autonomy readiness strict spec smoke", originalUserAsk: "Verify strict goal/spec anchors before autonomous dispatch." }).length === 0
    && validateStrictGoalSpecAnchor({ kind: "delegate_write", taskText: "1. TASK: edit\n2. EXPECTED OUTCOME: scoped change\n3. REQUIRED TOOLS: read, edit\n4. MUST DO:\n- cite evidence\n5. MUST NOT DO:\n- no secrets\n6. CONTEXT: smoke", requiredTools: ["read", "edit"] }).some((error) => error.includes("ORIGINAL_USER_ASK"));

  const delegateAgentWriteScopeGate = validateDelegationWriteScope("delegate_agent", ["read", "edit"], []).some((error) => error.includes("requires non-empty allowed_paths"))
    && validateDelegationWriteScope("delegate_agent", ["read", "edit"], ["docs/"]).length === 0;
  const contextGbrainNoShipRules = [
    "context_scope_required_before_context_injection",
    "citation_required_for_context_pack_facts",
    "gbrain_writeback_proposal_only",
    "no_raw_conversation_history_injection",
    "forbidden_source_scope_blocks_secret_paths",
  ];

  const capabilityChecks = [
    check("registered_agentic_factory_current_source_chain", smoke.passed === true && pilot.passed === true && batch.passed === true && batchOracle?.verdict === "PASS" && batchOracle.no_ship === false && currentChainLogPassed, { smokeRunId: REGISTERED_FACTORY_CHAIN.smoke, pilotRunId: REGISTERED_FACTORY_CHAIN.pilot, batchRunId: REGISTERED_FACTORY_CHAIN.batch, currentChainLogPassed }),
    check("sandbox_isolated_diff_review_apply_simulation_and_manual_preflight", sandboxIsolated?.status === "executed_in_sandbox" && sandboxIsolated.productionWritesPerformed === false && sandboxIsolated.autoApply === false && sandboxDiffReview?.status === "diff_review_passed" && sandboxDiffReview.reviewPassed === true && sandboxDiffReview.productionWritesPerformed === false && sandboxDiffReview.autoApply === false && sandboxApplySimulation?.status === "simulated_apply_in_temp_workspace" && sandboxApplySimulation.simulatedApplyPerformed === true && sandboxApplySimulation.productionWritesPerformed === false && sandboxApplySimulation.autoApply === false && sandboxApplySimulation.tempTargetWorkspaceWritten === true && sandboxManualApplyPreflight?.status === "manual_apply_preflight_passed" && sandboxManualApplyPreflight.manualApplyPreflightPassed === true && sandboxManualApplyPreflight.executionAllowedByThisTool === false && sandboxManualApplyPreflight.productionWritesPerformed === false && sandboxManualApplyPreflight.autoApply === false, { isolated: sandboxIsolatedPath, diffReview: sandboxDiffReviewPath, applySimulation: sandboxApplySimulationPath, manualApplyPreflight: sandboxManualApplyPreflightPath }),
    check("model_routing_gate_available_default_blocked", modelRouting?.auditPassed === true && modelRouting.liveRoutingNoShip === true && exactFailedChecks(modelRouting.failedChecks, ["live_routing_global_default_enabled"]) && modelRouting.liveRoutingDispatchGateAvailable === true && modelRouting.modelRouterUsed === false && modelRouting.routingApplied === false && modelRouting.childDispatchAllowed === false, { report: modelRoutingPath }),
    check("budget_policy_strict_gate_default_blocked", budget?.auditPassed === true && budget.strictBudgetNoShip === true && exactFailedChecks(budget.failedChecks, ["strict_budget_global_default_enabled"]) && budget.strictBudgetDispatchGateAvailable === true && budget.budgetEnforced === false && budget.strictEnabled === false && budget.wouldBlockDispatch === false, { report: budgetPath }),
    check("daemon_readiness_dry_run_only", daemon?.readyForManualOneShot === true && daemon.no_ship === false && daemon.autoStartDaemon === false && daemon.continuousLoop === false && daemon.daemonStarted === false && daemon.noExecution === true, { report: daemonPath }),
    check("daemon_policy_manual_one_shot_no_ship", daemonPolicy?.auditPassed === true && daemonPolicy.readyForManualOneShotOnly === true && daemonPolicy.alwaysOnDaemonReady === false && daemonPolicy.alwaysOnDaemonNoShip === true && daemonPolicy.autoStartDaemon === false && daemonPolicy.continuousLoop === false && daemonPolicy.daemonStarted === false && daemonPolicy.noExecution === true, { report: daemonPolicyPath }),
    check("delegate_agent_write_scope_gate_available", delegateAgentWriteScopeGate, { writeEditRequiresAllowedPaths: delegateAgentWriteScopeGate }),
    check("strict_goal_spec_gate_enforced_p0", strictGoalSpecGate, { acceptedAnchors: ["active GoalState", "orchestrate goal+original_user_ask", "factory definition+manifest", "delegate write original_user_ask"], enforcement: "runtime_tool_anchor_or_goal_required_for_write_factory_orchestrate" }),
    check("context_gbrain_runtime_scope_enforcement_p0", contextGbrain.verdict === "PASS" && contextGbrain.no_ship === false && contextGbrain.gbrainImportEnabled === false && contextGbrain.gbrainEmbedEnabled === false && contextGbrain.gbrainSyncEnabled === false && contextGbrain.gbrainWriteEnabled === false, { rules: contextGbrainNoShipRules, readiness: { verdict: contextGbrain.verdict, failedChecks: contextGbrain.failedChecks }, enforcement: "runtime_context_scope_citations_bounded_pack_writeback_proposal_only" }),
    check("autonomous_runtime_dry_run_loop_p0", autonomousDryRun.status === "dry_run_plan_ready" && isRecord(autonomousDryRun.modelRoutingPlan) && autonomousDryRun.modelRoutingPlan.routingPlanReady === true && autonomousDryRun.modelRoutingPlan.liveRoutingEnabled === false && autonomousDryRun.modelRoutingPlan.childDispatchAllowed === false && autonomousDryRun.noExecution === true && autonomousDryRun.childDispatchAllowed === false && autonomousDryRun.globalAutonomyNoShip === true && autonomousDryRun.productionWritesPerformed === false && autonomousDryRun.autoApply === false, { runId: autonomousDryRun.runId, status: autonomousDryRun.status, selectedFactory: isRecord(autonomousDryRun.factorySelection) ? autonomousDryRun.factorySelection.selectedFactory : undefined, proofPlan: "spec_lock_context_scope_model_routing_factory_selection_smoke_oracle_pilot_oracle_batch_final_report" }),
    ...(input.autonomous_dry_run_id ? [check("autonomous_runtime_dry_run_artifact_validator_p0", autonomousDryRunArtifactValidatorPassed, { runId: input.autonomous_dry_run_id, valid: isRecord(autonomousDryRunArtifactValidation) ? autonomousDryRunArtifactValidation.valid : false, failedChecks: isRecord(autonomousDryRunArtifactValidation) ? autonomousDryRunArtifactValidation.failedChecks : ["artifact_validation_not_available"], noExecution: isRecord(autonomousDryRunArtifactValidation) ? autonomousDryRunArtifactValidation.noExecution : undefined, networkAccessed: isRecord(autonomousDryRunArtifactValidation) ? autonomousDryRunArtifactValidation.networkAccessed : undefined })] : []),
    ...(input.autonomous_readonly_smoke_run_id ? [check("autonomous_readonly_smoke_completion_gate_p0", autonomousReadOnlySmokeCompletionGatePassed, { runId: input.autonomous_readonly_smoke_run_id, valid: isRecord(autonomousReadOnlySmokeValidation) ? autonomousReadOnlySmokeValidation.valid : false, failedChecks: isRecord(autonomousReadOnlySmokeValidation) ? autonomousReadOnlySmokeValidation.failedChecks : ["artifact_validation_not_available"], completionGateStatus: autonomousCompletionGate?.status, updateGoalAllowed: autonomousCompletionGate?.updateGoalAllowed, finalNoShipOracleVerdict: autonomousFinalNoShipOracle?.verdict, finalNoShip: autonomousFinalNoShipOracle?.no_ship, finalE2EProofStatus: autonomousFinalE2EProofPlan?.status, globalAutonomyReady: autonomousCompletionGate?.globalAutonomyReady, globalAutonomyNoShip: autonomousCompletionGate?.globalAutonomyNoShip })] : []),
    check("capability_index_available", Number(capabilityByKind.agent ?? 0) > 0 && Number(capabilityByKind.factory ?? 0) > 0 && Number(capabilityByKind.chain ?? 0) > 0 && Number(capabilityByKind.output_contract ?? 0) > 0 && capabilities.noExecution === true, { counts: capabilityCounts }),
    check("factory_registry_indexed_with_arbitrary_autonomy_blocked", factoryRegistry.registryIndexed === true && factoryRegistry.arbitraryFactoryAutonomyReady === false && factoryRegistry.arbitraryFactoryNoShip === true, { factoryCount: factoryRegistry.factoryCount, registeredAgenticBatchReadyFactories: factoryRegistry.registeredAgenticBatchReadyFactories, unprovenFactories: factoryRegistry.unprovenFactories }),
  ];
  const evidenceReady = capabilityChecks.every((item) => item.passed === true);
  const factoriesMissingRegisteredBatchProof = Array.isArray(factoryRegistry.factoriesMissingRegisteredBatchProof) ? factoryRegistry.factoriesMissingRegisteredBatchProof : [];
  const registeredFactoryMatrixComplete = factoriesMissingRegisteredBatchProof.length === 0;
  const globalBlockers = [
    "global_autonomy_not_proven_for_arbitrary_factories",
    "always_on_daemon_not_implemented",
    "global_live_model_routing_not_enabled",
    "global_strict_budget_enforcement_not_enabled",
    "production_write_apply_not_enabled",
    "auto_apply_not_enabled",
    "sandbox_writes_remain_manual_apply_only",
    ...(input.autonomous_readonly_smoke_run_id ? ["autonomous_completion_gate_blocks_goal_completion"] : []),
    ...(registeredFactoryMatrixComplete ? [] : ["registered_agentic_factory_batch_proof_matrix_incomplete"]),
  ];
  const report = {
    schema: "zob.autonomy-readiness-audit.v1",
    runId: input.run_id,
    evidenceReady,
    status: "blocked_for_global_autonomy",
    globalAutonomyReady: false,
    globalAutonomyNoShip: true,
    globalBlockers,
    capabilityChecks,
    factoryRegistry,
    evidence: {
      registeredFactory: { smoke, pilot, batch, batchOracle: artifact(batchOraclePath), currentChainLog: artifact(currentChainLogPath) },
      sandbox: { isolatedExecution: artifact(sandboxIsolatedPath), diffReviewGate: artifact(sandboxDiffReviewPath), applySimulation: artifact(sandboxApplySimulationPath), manualApplyPreflight: artifact(sandboxManualApplyPreflightPath) },
      modelRouting: artifact(modelRoutingPath),
      budget: artifact(budgetPath),
      daemon: artifact(daemonPath),
      daemonPolicy: artifact(daemonPolicyPath),
      safety: {
        delegateAgentWriteScopeGateAvailable: delegateAgentWriteScopeGate,
        strictGoalSpecRequiredForAutonomy: strictGoalSpecGate,
        contextGbrainNoShipRules,
        autonomousRuntimeDryRunP0: { status: autonomousDryRun.status, noExecution: autonomousDryRun.noExecution, childDispatchAllowed: autonomousDryRun.childDispatchAllowed, globalAutonomyNoShip: autonomousDryRun.globalAutonomyNoShip },
        autonomousRuntimeDryRunArtifactValidatorP0: isRecord(autonomousDryRunArtifactValidation) ? { runId: input.autonomous_dry_run_id, valid: autonomousDryRunArtifactValidation.valid, failedChecks: autonomousDryRunArtifactValidation.failedChecks, noExecution: autonomousDryRunArtifactValidation.noExecution, networkAccessed: autonomousDryRunArtifactValidation.networkAccessed, globalAutonomyNoShip: autonomousDryRunArtifactValidation.globalAutonomyNoShip } : undefined,
        autonomousReadOnlySmokeCompletionGateP0: input.autonomous_readonly_smoke_run_id && autonomousReadOnlySmokeRunDir ? { runId: input.autonomous_readonly_smoke_run_id, valid: isRecord(autonomousReadOnlySmokeValidation) ? autonomousReadOnlySmokeValidation.valid : false, failedChecks: isRecord(autonomousReadOnlySmokeValidation) ? autonomousReadOnlySmokeValidation.failedChecks : ["artifact_validation_not_available"], completionGate: artifact(join(autonomousReadOnlySmokeRunDir, "completion-gate.json")), finalNoShipOracle: artifact(join(autonomousReadOnlySmokeRunDir, "final-no-ship-oracle.json")), finalE2EProofPlan: artifact(join(autonomousReadOnlySmokeRunDir, "final-e2e-proof-plan.json")), updateGoalAllowed: autonomousCompletionGate?.updateGoalAllowed, globalAutonomyReady: autonomousCompletionGate?.globalAutonomyReady, globalAutonomyNoShip: autonomousCompletionGate?.globalAutonomyNoShip } : undefined,
        contextGbrainP0: { verdict: contextGbrain.verdict, no_ship: contextGbrain.no_ship, failedChecks: contextGbrain.failedChecks },
      },
      capabilityIndex: { counts: capabilityCounts },
      factoryRegistry: { factoryCount: factoryRegistry.factoryCount, arbitraryFactoryAutonomyReady: factoryRegistry.arbitraryFactoryAutonomyReady, arbitraryFactoryNoShip: factoryRegistry.arbitraryFactoryNoShip },
    },
    invariants: {
      auditOnly: true,
      noExecution: true,
      childDispatchAllowed: false,
      daemonStarted: false,
      autoStartDaemon: false,
      continuousLoop: false,
      cronEnabled: false,
      liveRoutingEnabled: false,
      modelRouterUsed: false,
      routingApplied: false,
      budgetEnforced: false,
      strictEnabled: false,
      wouldBlockDispatch: false,
      productionWritesPerformed: false,
      autoApply: false,
      networkAccessed: false,
    },
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(report)) throw new Error("Autonomy readiness audit would store forbidden body keys");
  return report;
}

export function writeAutonomyReadinessAuditReport(repoRoot: string, runId = "autonomy-readiness", input: AutonomyReadinessAuditInput = {}): string {
  const dir = join(repoRoot, "reports");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(buildAutonomyReadinessAudit(repoRoot, { ...input, run_id: runId }), null, 2), "utf8");
  return outputPath;
}
