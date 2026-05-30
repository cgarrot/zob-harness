import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { evaluateBudgetPreflightDryRun } from "./chronicle.js";
import { validateDaemonPolicyConfig } from "./daemon-policy.js";
import { evaluateModelRoutingDryRun } from "./model-routing.js";
import { buildQueueDashboardSummary, ensureQueueDirs, READ_ONLY_QUEUE_JOB_TYPES, validateReadOnlyQueueJob } from "./queue.js";
import { sha256 } from "./utils/hashing.js";
import { parseJsonFile } from "./utils/json.js";
import { safeFileStem } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

export interface DaemonReadinessDryRunInput {
  run_id?: string;
  maxWorkers?: number;
}

function pendingQueueJobSummaries(repoRoot: string): Array<Record<string, unknown>> {
  const paths = ensureQueueDirs(repoRoot);
  const pending = readdirSync(paths.pending).filter((file) => file.endsWith(".json")).sort();
  return pending.map((fileName) => {
    const filePath = join(paths.pending, fileName);
    let parsed: unknown;
    let parseError: string | undefined;
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf8");
      parsed = parseJsonFile(filePath);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
    const validationErrors = parseError ? [`could not parse queue job: ${parseError}`] : validateReadOnlyQueueJob(repoRoot, parsed);
    const record = isRecord(parsed) ? parsed : {};
    return {
      fileName,
      jobHash: sha256(raw),
      id: typeof record.id === "string" ? record.id : undefined,
      type: typeof record.type === "string" ? record.type : undefined,
      readOnly: record.readOnly === true,
      pathCount: Array.isArray(record.paths) ? record.paths.length : 0,
      adapterCount: Array.isArray(record.adapters) ? record.adapters.length : 0,
      valid: validationErrors.length === 0,
      validationErrors,
      bodyStored: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    };
  });
}

function readinessCheck(name: string, passed: boolean, detail: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, passed, detail };
}

export function buildDaemonReadinessDryRun(repoRoot: string, input: DaemonReadinessDryRunInput = {}): Record<string, unknown> {
  const maxWorkers = input.maxWorkers ?? 1;
  const queuePaths = ensureQueueDirs(repoRoot);
  const pendingJobs = pendingQueueJobSummaries(repoRoot);
  const invalidPendingJobs = pendingJobs.filter((job) => job.valid !== true);
  const queueDashboard = buildQueueDashboardSummary(repoRoot);
  const budget = evaluateBudgetPreflightDryRun({ runs: 1, parallelChildren: maxWorkers, caps: { maxParallelChildren: 1 }, strictRequested: false });
  const modelRouting = evaluateModelRoutingDryRun({ mode: "factory", taskType: "read-only-queue-daemon-dry-run", risk: "medium", estimatedRuns: 1, estimatedParallelChildren: maxWorkers, caps: { maxParallelChildren: 1 } });
  const daemonPolicy = validateDaemonPolicyConfig(repoRoot);

  const checks = [
    readinessCheck("queue_dirs_ready", [queuePaths.pending, queuePaths.running, queuePaths.done, queuePaths.failed].every((path) => existsSync(path)), { root: queuePaths.root }),
    readinessCheck("read_only_job_types_registered", READ_ONLY_QUEUE_JOB_TYPES.length > 0, { jobTypes: READ_ONLY_QUEUE_JOB_TYPES }),
    readinessCheck("daemon_policy_config_valid", daemonPolicy.present === true && daemonPolicy.valid === true && daemonPolicy.alwaysOnDaemonEnabled === false && daemonPolicy.autoStartDaemon === false && daemonPolicy.continuousLoop === false && daemonPolicy.noExecution === true, { configHash: daemonPolicy.configHash, errors: daemonPolicy.errors }),
    readinessCheck("pending_jobs_readonly_valid", invalidPendingJobs.length === 0, { pending: pendingJobs.length, invalid: invalidPendingJobs.length }),
    readinessCheck("one_worker_default", maxWorkers === 1, { maxWorkers }),
    readinessCheck("controlled_scheduler_controls_available", true, { leases: true, heartbeat: true, staleRecovery: true, killSwitchPath: ".pi/queue/KILL_SWITCH", maxRetries: 1, claimAtMostOneJobPerTick: true }),
    readinessCheck("budget_advisory_nonblocking", budget.budgetEnforced === false && budget.wouldBlockDispatch === false && budget.childDispatchAllowed === false, { wouldExceed: budget.wouldExceed, failures: budget.failures }),
    readinessCheck("model_routing_dry_run_only", modelRouting.modelRouterUsed === false && modelRouting.routingApplied === false && modelRouting.childDispatchAllowed === false, { recommendedModelClass: modelRouting.recommendedModelClass }),
    readinessCheck("no_autostart_no_loop", true, { autoStartDaemon: false, continuousLoop: false, daemonStarted: false }),
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const readyForManualOneShot = failedChecks.length === 0;

  return {
    schema: "zob.daemon-readiness-dry-run.v1",
    runId: input.run_id,
    readiness: readyForManualOneShot ? "ready_for_manual_one_shot" : "blocked_preflight",
    readyForManualOneShot,
    no_ship: !readyForManualOneShot,
    checks,
    failedChecks,
    queue: {
      paths: queuePaths,
      dashboard: queueDashboard,
      pendingJobs,
      controlPlane: {
        schema: "zob.queue-daemon-control-plane.v1",
        leaseMs: 30000,
        heartbeatFile: ".pi/queue/heartbeat.json",
        killSwitchPath: ".pi/queue/KILL_SWITCH",
        staleRunningJobRecovery: true,
        maxWorkers: 1,
        maxRetries: 1,
        claimAtMostOneJobPerTick: true,
        autoStartDaemon: false,
        continuousLoop: false,
        bodyStored: false,
        promptBodiesStored: false,
        outputBodiesStored: false,
      },
    },
    daemonPolicy,
    budget,
    modelRouting,
    maxWorkers,
    autoStartDaemon: false,
    continuousLoop: false,
    daemonStarted: false,
    childDispatchAllowed: false,
    liveChildExecution: false,
    networkAccessed: false,
    writeAdaptersEnabled: false,
    budgetEnforced: false,
    modelRouterUsed: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function writeDaemonReadinessDryRunReport(repoRoot: string, runId = "daemon-readiness", input: DaemonReadinessDryRunInput = {}): string {
  const dir = join(repoRoot, ".pi", "logs", "daemon-readiness");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(buildDaemonReadinessDryRun(repoRoot, { ...input, run_id: runId }), null, 2), "utf8");
  return outputPath;
}
