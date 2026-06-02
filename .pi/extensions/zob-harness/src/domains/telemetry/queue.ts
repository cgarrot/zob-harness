import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { evaluateStrictBudgetDispatchGate } from "../governance/budget-policy.js";
import { classifyChildStopCondition, evaluateBudgetPreflightDryRun } from "./chronicle.js";
import { DEFAULT_RULES } from "../../core/constants.js";
import { incrementCounter, normalizeDailyTelemetryDate, stringFrom } from "./telemetry.js";
import type { ChildStopCondition, FactoryRunBudgetInput, QueueState, QueueTickResult, ReadOnlyQueueJob, ReadOnlyQueueJobType } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { parseJsonFile } from "../../core/utils/json.js";
import { expandHome, isSafeArtifactName, pathMatches, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export const READ_ONLY_QUEUE_JOB_TYPES: ReadOnlyQueueJobType[] = ["docs_watch", "repo_audit_readonly", "todo_risk_report", "session_analysis"];
const QUEUE_STATES: QueueState[] = ["pending", "running", "done", "failed"];
const DISALLOWED_QUEUE_JOB_TYPE_WORDS = /(?:write|edit|fix|patch|autofix|github|browser|cloud|deploy|publish|commit)/i;
const DISALLOWED_QUEUE_ADAPTERS = new Set(["write", "edit", "github", "browser", "cloud", "web", "deploy", "publish"]);
const FORBIDDEN_QUEUE_JOB_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content"]);
const QUEUE_DAEMON_LEASE_MS = 30_000;
const QUEUE_DAEMON_MAX_WORKERS = 1;
const QUEUE_DAEMON_MAX_RETRIES = 1;

export function getQueuePaths(repoRoot: string): Record<QueueState | "root" | "ledger", string> {
  const root = join(repoRoot, ".pi", "queue");
  return {
    root,
    pending: join(root, "pending"),
    running: join(root, "running"),
    done: join(root, "done"),
    failed: join(root, "failed"),
    ledger: join(root, "ledger.jsonl"),
  };
}

export function ensureQueueDirs(repoRoot: string): Record<QueueState | "root" | "ledger", string> {
  const paths = getQueuePaths(repoRoot);
  for (const state of QUEUE_STATES) mkdirSync(paths[state], { recursive: true });
  return paths;
}

function isReadOnlyQueueJob(value: unknown): value is ReadOnlyQueueJob {
  return isRecord(value) && typeof value.id === "string" && typeof value.type === "string";
}

function queueJobPathSafeName(jobId: string): string {
  return `${safeFileStem(jobId)}.json`;
}

function queueKillSwitchPath(repoRoot: string): string {
  return join(getQueuePaths(repoRoot).root, "KILL_SWITCH");
}

function queueHeartbeatPath(repoRoot: string): string {
  return join(getQueuePaths(repoRoot).root, "heartbeat.json");
}

function buildQueueLease(jobId: string | undefined, jobType: string | undefined): Record<string, unknown> {
  const now = Date.now();
  return {
    schema: "zob.queue-daemon-lease.v1",
    leaseId: sha256(`${jobId ?? "unknown"}:${jobType ?? "unknown"}:${now}`).slice(0, 24),
    jobId,
    jobType,
    claimedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUEUE_DAEMON_LEASE_MS).toISOString(),
    leaseMs: QUEUE_DAEMON_LEASE_MS,
    maxWorkers: QUEUE_DAEMON_MAX_WORKERS,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function writeQueueHeartbeat(repoRoot: string, lease: Record<string, unknown>, status: string): Record<string, unknown> {
  const heartbeat = {
    schema: "zob.queue-daemon-heartbeat.v1",
    leaseId: lease.leaseId,
    jobId: lease.jobId,
    status,
    heartbeatAt: new Date().toISOString(),
    staleAfterMs: QUEUE_DAEMON_LEASE_MS,
    killSwitchPath: ".pi/queue/KILL_SWITCH",
    maxWorkers: QUEUE_DAEMON_MAX_WORKERS,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  writeFileSync(queueHeartbeatPath(repoRoot), JSON.stringify(heartbeat, null, 2), "utf8");
  return heartbeat;
}

function retryPolicyForJob(job: ReadOnlyQueueJob | undefined): Record<string, unknown> {
  const attempts = typeof job?.attempts === "number" && Number.isFinite(job.attempts) && job.attempts >= 0 ? Math.floor(job.attempts) : 0;
  const maxRetries = typeof job?.maxRetries === "number" && Number.isFinite(job.maxRetries) && job.maxRetries >= 0 ? Math.min(Math.floor(job.maxRetries), QUEUE_DAEMON_MAX_RETRIES) : QUEUE_DAEMON_MAX_RETRIES;
  return {
    schema: "zob.queue-daemon-retry-policy.v1",
    attempts,
    maxRetries,
    retriesCapped: true,
    retryAllowed: attempts < maxRetries,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

function recoverStaleRunningJobs(repoRoot: string): number {
  const paths = ensureQueueDirs(repoRoot);
  let recovered = 0;
  const now = Date.now();
  for (const file of readdirSync(paths.running).filter((entry) => entry.endsWith(".json")).sort()) {
    const runningPath = join(paths.running, file);
    let record: unknown;
    try {
      record = parseJsonFile(runningPath);
    } catch {
      continue;
    }
    const lease = isRecord(record) && isRecord(record.lease) ? record.lease : undefined;
    const expiresAt = typeof lease?.expiresAt === "string" ? Date.parse(lease.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt) || now < expiresAt) continue;
    const stalePayload = {
      ...(isRecord(record) ? record : {}),
      schema: "zob.queue-job-result.v1",
      status: "failed",
      stopCondition: "timeout",
      staleLeaseRecovered: true,
      recoveredAt: new Date(now).toISOString(),
      budgetEnforced: false,
      promptBodiesStored: false,
      outputBodiesStored: false,
    };
    const finalPath = finalizeQueueJob(repoRoot, runningPath, "failed", stalePayload);
    writeQueueLifecycleEvent(repoRoot, { event: "stale_recovered", jobFile: file, finalPath, stopCondition: "timeout", leaseId: lease?.leaseId });
    recovered += 1;
  }
  return recovered;
}

function normalizeQueueJobPaths(job: ReadOnlyQueueJob): string[] {
  return job.paths?.length ? job.paths : ["."];
}

function validateQueueJobPath(repoRoot: string, path: string): string[] {
  const errors: string[] = [];
  const resolved = resolve(repoRoot, expandHome(path));
  const root = resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) errors.push(`path must stay inside repo root: ${path}`);
  for (const protectedPattern of [...DEFAULT_RULES.zeroAccessPaths, ...DEFAULT_RULES.readOnlyPaths]) {
    if (pathMatches(path, protectedPattern, repoRoot, repoRoot)) errors.push(`protected path is not allowed in read-only queue jobs: ${protectedPattern}`);
  }
  return errors;
}

function findForbiddenQueueJobBodyKeys(value: unknown, prefix = "job"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((child, index) => findForbiddenQueueJobBodyKeys(child, `${prefix}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = `${prefix}.${key}`;
    return [...(FORBIDDEN_QUEUE_JOB_BODY_KEYS.has(key) ? [path] : []), ...findForbiddenQueueJobBodyKeys(child, path)];
  });
}

export function validateReadOnlyQueueJob(repoRoot: string, job: unknown): string[] {
  const errors: string[] = [];
  const forbiddenBodyKeys = findForbiddenQueueJobBodyKeys(job);
  if (forbiddenBodyKeys.length > 0) errors.push(`queue job must not contain raw task/prompt/output/body/content fields: ${forbiddenBodyKeys.join(", ")}`);
  if (!isReadOnlyQueueJob(job)) return errors.length > 0 ? errors : ["queue job must be an object with string id and type"];
  if (job.schema !== undefined && job.schema !== "zob.queue-job.v1") errors.push("queue job schema must be zob.queue-job.v1");
  if (!isSafeArtifactName(job.id)) errors.push(`queue job id must be path-safe: ${job.id}`);
  if (!READ_ONLY_QUEUE_JOB_TYPES.includes(job.type as ReadOnlyQueueJobType)) errors.push(`unsupported read-only queue job type: ${job.type}`);
  if (DISALLOWED_QUEUE_JOB_TYPE_WORDS.test(job.type)) errors.push(`unsafe queue job type is not allowed: ${job.type}`);
  if (job.readOnly !== true) errors.push("queue job must declare readOnly=true");
  if (job.adapters !== undefined && (!Array.isArray(job.adapters) || !job.adapters.every((adapter) => typeof adapter === "string"))) errors.push("queue job adapters must be strings when provided");
  for (const adapter of job.adapters ?? []) {
    if (DISALLOWED_QUEUE_ADAPTERS.has(adapter.toLowerCase())) errors.push(`unsafe queue adapter is not allowed: ${adapter}`);
  }
  if (job.paths !== undefined && (!Array.isArray(job.paths) || !job.paths.every((path) => typeof path === "string"))) errors.push("queue job paths must be strings when provided");
  if (Array.isArray(job.paths)) for (const path of normalizeQueueJobPaths(job)) errors.push(...validateQueueJobPath(repoRoot, path));
  if (job.attempts !== undefined && (!Number.isInteger(job.attempts) || job.attempts < 0)) errors.push("queue job attempts must be a nonnegative integer when provided");
  if (job.maxRetries !== undefined && (!Number.isInteger(job.maxRetries) || job.maxRetries < 0 || job.maxRetries > QUEUE_DAEMON_MAX_RETRIES)) errors.push(`queue job maxRetries must be between 0 and ${QUEUE_DAEMON_MAX_RETRIES}`);
  return errors;
}

export function writeQueueLifecycleEvent(repoRoot: string, event: Record<string, unknown>): string {
  const paths = ensureQueueDirs(repoRoot);
  const safeEvent = {
    schema: "zob.queue-lifecycle-event.v1",
    timestamp: new Date().toISOString(),
    budgetEnforced: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    ...event,
  };
  appendFileSync(paths.ledger, `${JSON.stringify(safeEvent)}\n`, "utf8");
  return paths.ledger;
}

function readQueueJobFile(path: string): unknown {
  return parseJsonFile(path);
}

function queueBudgetResult(job: ReadOnlyQueueJob): Record<string, unknown> {
  const budget = job.budget;
  return evaluateBudgetPreflightDryRun({
    costUsd: budget?.observedCostUsd,
    runs: budget?.observedRuns,
    durationMs: budget?.observedDurationMs,
    parallelChildren: budget?.observedParallelChildren,
    caps: budget,
    strictRequested: budget?.strictRequested,
  });
}

function queueStrictBudgetGate(job: ReadOnlyQueueJob): Record<string, unknown> {
  const budget = job.budget;
  const strictBudget: FactoryRunBudgetInput = {
    ...(budget?.maxCostUsd !== undefined ? { maxCostUsd: budget.maxCostUsd } : {}),
    ...(budget?.maxRuns !== undefined ? { maxRuns: budget.maxRuns } : {}),
    ...(budget?.maxDurationMs !== undefined ? { maxDurationMs: budget.maxDurationMs } : {}),
    ...(budget?.maxParallelChildren !== undefined ? { maxParallelChildren: budget.maxParallelChildren } : {}),
    strictRequested: budget?.strictRequested,
    strictEnabled: budget?.strictEnabled,
    estimatedCostUsd: budget?.estimatedCostUsd ?? budget?.observedCostUsd,
    estimatedRuns: budget?.estimatedRuns ?? budget?.observedRuns,
    estimatedDurationMs: budget?.estimatedDurationMs ?? budget?.observedDurationMs,
    estimatedParallelChildren: budget?.estimatedParallelChildren ?? budget?.observedParallelChildren,
  };
  return evaluateStrictBudgetDispatchGate({
    runId: job.id,
    mode: "queue-daemon",
    execution: "deterministic_metadata_only",
    taskCount: 1,
    selectedItems: 1,
    budget: strictBudget,
  });
}

function runReadOnlyQueueJobHandler(repoRoot: string, job: ReadOnlyQueueJob, strictBudgetGate: Record<string, unknown>): Record<string, unknown> {
  const inspectedPaths = normalizeQueueJobPaths(job);
  return {
    schema: "zob.queue-job-result.v1",
    jobId: job.id,
    jobType: job.type,
    status: "done",
    readOnly: true,
    liveChildExecution: false,
    handlerMode: "deterministic_metadata_only",
    plannedActions: {
      docs_watch: "Inspect documentation drift and summarize changed docs without edits.",
      repo_audit_readonly: "Audit repository structure and safety signals without edits.",
      todo_risk_report: "Report TODO/FIXME risk locations without edits.",
      session_analysis: "Summarize local telemetry/session ledgers without prompt/output bodies.",
    }[job.type as ReadOnlyQueueJobType],
    inspectedPaths,
    pathHashes: inspectedPaths.map((path) => ({ path, hash: sha256(resolve(repoRoot, path)) })),
    budget: queueBudgetResult(job),
    strictBudgetGate,
    stop: classifyChildStopCondition({ assistantTurnSeen: true, outputHash: sha256(`${job.id}:${job.type}:metadata`), outputCaptured: true, outputValidated: true, evidenceChecked: true }),
    budgetEnforced: strictBudgetGate.budgetEnforced === true,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function finalizeQueueJob(repoRoot: string, runningPath: string, state: "done" | "failed", payload: Record<string, unknown>): string {
  const paths = ensureQueueDirs(repoRoot);
  const finalPath = join(paths[state], basename(runningPath));
  writeFileSync(runningPath, JSON.stringify(payload, null, 2), "utf8");
  renameSync(runningPath, finalPath);
  return finalPath;
}

export function runQueueDaemonTick(repoRoot: string): QueueTickResult {
  const paths = ensureQueueDirs(repoRoot);
  const killSwitchPresent = existsSync(queueKillSwitchPath(repoRoot));
  if (killSwitchPresent) {
    const killSwitch = { path: ".pi/queue/KILL_SWITCH", present: true, stopCondition: "blocked", bodyStored: false, promptBodiesStored: false, outputBodiesStored: false };
    writeQueueLifecycleEvent(repoRoot, { event: "kill_switch_blocked", claimed: false, stopCondition: "blocked" });
    return { schema: "zob.queue-tick-result.v1", claimed: false, status: "failed", errors: ["queue daemon kill switch present"], stopCondition: "blocked", killSwitch, maxWorkers: QUEUE_DAEMON_MAX_WORKERS, budgetEnforced: false, promptBodiesStored: false, outputBodiesStored: false };
  }

  const staleRecovered = recoverStaleRunningJobs(repoRoot);
  const pending = readdirSync(paths.pending).filter((file) => file.endsWith(".json")).sort();
  if (pending.length === 0) {
    writeQueueLifecycleEvent(repoRoot, { event: "idle", claimed: false, staleRecovered });
    return { schema: "zob.queue-tick-result.v1", claimed: false, status: "idle", errors: [], stopCondition: "none", staleRecovered, maxWorkers: QUEUE_DAEMON_MAX_WORKERS, budgetEnforced: false, promptBodiesStored: false, outputBodiesStored: false };
  }

  const pendingPath = join(paths.pending, pending[0]);
  const runningPath = join(paths.running, pending[0]);
  renameSync(pendingPath, runningPath);
  writeQueueLifecycleEvent(repoRoot, { event: "claimed", jobFile: pending[0], claimedPath: runningPath, maxWorkers: QUEUE_DAEMON_MAX_WORKERS, staleRecovered });

  let job: unknown;
  try {
    job = readQueueJobFile(runningPath);
  } catch (error) {
    const errors = [`could not parse queue job: ${error instanceof Error ? error.message : String(error)}`];
    const finalPath = finalizeQueueJob(repoRoot, runningPath, "failed", { schema: "zob.queue-job-result.v1", status: "failed", errors, budgetEnforced: false, promptBodiesStored: false, outputBodiesStored: false });
    writeQueueLifecycleEvent(repoRoot, { event: "failed", jobFile: pending[0], errors, stopCondition: "failed_preflight" });
    return { schema: "zob.queue-tick-result.v1", claimed: true, status: "failed", claimedPath: runningPath, finalPath, errors, stopCondition: "failed_preflight", staleRecovered, maxWorkers: QUEUE_DAEMON_MAX_WORKERS, budgetEnforced: false, promptBodiesStored: false, outputBodiesStored: false };
  }

  const errors = validateReadOnlyQueueJob(repoRoot, job);
  const jobId = isReadOnlyQueueJob(job) ? job.id : undefined;
  const jobType = isReadOnlyQueueJob(job) ? job.type : undefined;
  if (errors.length > 0 || !isReadOnlyQueueJob(job)) {
    const finalPath = finalizeQueueJob(repoRoot, runningPath, "failed", { schema: "zob.queue-job-result.v1", jobId, jobType, status: "failed", errors, stopCondition: "failed_preflight", budgetEnforced: false, promptBodiesStored: false, outputBodiesStored: false });
    writeQueueLifecycleEvent(repoRoot, { event: "failed", jobId, jobType, jobFile: pending[0], errors, stopCondition: "failed_preflight" });
    return { schema: "zob.queue-tick-result.v1", claimed: true, jobId, jobType, status: "failed", claimedPath: runningPath, finalPath, errors, stopCondition: "failed_preflight", staleRecovered, maxWorkers: QUEUE_DAEMON_MAX_WORKERS, retryPolicy: retryPolicyForJob(isReadOnlyQueueJob(job) ? job : undefined), budgetEnforced: false, promptBodiesStored: false, outputBodiesStored: false };
  }

  const strictBudgetGate = queueStrictBudgetGate(job);
  if (strictBudgetGate.wouldBlockDispatch === true) {
    const finalPath = finalizeQueueJob(repoRoot, runningPath, "failed", { schema: "zob.queue-job-result.v1", jobId: job.id, jobType: job.type, status: "failed", errors: ["strict budget gate blocked queue daemon job before handler"], stopCondition: "blocked", strictBudgetGate, budgetEnforced: strictBudgetGate.budgetEnforced === true, promptBodiesStored: false, outputBodiesStored: false });
    writeQueueLifecycleEvent(repoRoot, { event: "strict_budget_blocked", jobId: job.id, jobType: job.type, jobFile: pending[0], finalPath, stopCondition: "blocked", strictBudgetGate });
    return { schema: "zob.queue-tick-result.v1", claimed: true, jobId: job.id, jobType: job.type, status: "failed", claimedPath: runningPath, finalPath, errors: ["strict budget gate blocked queue daemon job before handler"], stopCondition: "blocked", strictBudgetGate, staleRecovered, maxWorkers: QUEUE_DAEMON_MAX_WORKERS, retryPolicy: retryPolicyForJob(job), budgetEnforced: strictBudgetGate.budgetEnforced === true, promptBodiesStored: false, outputBodiesStored: false };
  }

  const lease = buildQueueLease(job.id, job.type);
  const heartbeat = writeQueueHeartbeat(repoRoot, lease, "running");
  writeFileSync(runningPath, JSON.stringify({ ...job, lease, heartbeat, scheduler: { schema: "zob.queue-daemon-scheduler.v1", maxWorkers: QUEUE_DAEMON_MAX_WORKERS, claimAtMostOneJobPerTick: true, boundedRetries: true, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false } }, null, 2), "utf8");
  writeQueueLifecycleEvent(repoRoot, { event: "heartbeat", jobId: job.id, jobType: job.type, leaseId: lease.leaseId, heartbeatAt: heartbeat.heartbeatAt });

  const result: Record<string, unknown> = { ...runReadOnlyQueueJobHandler(repoRoot, job, strictBudgetGate), lease, heartbeat, retryPolicy: retryPolicyForJob(job), maxWorkers: QUEUE_DAEMON_MAX_WORKERS };
  const stopCondition = isRecord(result.stop) && typeof result.stop.stopCondition === "string" ? (result.stop.stopCondition as ChildStopCondition) : "none";
  const finalPath = finalizeQueueJob(repoRoot, runningPath, stopCondition === "none" ? "done" : "failed", result);
  writeQueueLifecycleEvent(repoRoot, { event: stopCondition === "none" ? "done" : "failed", jobId: job.id, jobType: job.type, jobFile: pending[0], finalPath, stopCondition, leaseId: lease.leaseId });
  return { schema: "zob.queue-tick-result.v1", claimed: true, jobId: job.id, jobType: job.type, status: stopCondition === "none" ? "done" : "failed", claimedPath: runningPath, finalPath, errors: [], stopCondition, lease, heartbeat, staleRecovered, maxWorkers: QUEUE_DAEMON_MAX_WORKERS, retryPolicy: retryPolicyForJob(job), strictBudgetGate, budgetEnforced: strictBudgetGate.budgetEnforced === true, promptBodiesStored: false, outputBodiesStored: false };
}

function countQueueFiles(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")).length : 0;
}

function readQueueLedger(repoRoot: string): Array<Record<string, unknown>> {
  const ledger = getQueuePaths(repoRoot).ledger;
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

export function buildQueueDashboardSummary(repoRoot: string, date?: string): Record<string, unknown> {
  const paths = ensureQueueDirs(repoRoot);
  const ledger = readQueueLedger(repoRoot);
  const byEvent: Record<string, number> = {};
  const byJobType: Record<string, number> = {};
  for (const entry of ledger) {
    incrementCounter(byEvent, stringFrom(entry.event));
    incrementCounter(byJobType, stringFrom(entry.jobType));
  }
  const day = normalizeDailyTelemetryDate(date);
  const dailyPath = join(repoRoot, ".pi", "logs", "summaries", `${day}.json`);
  const daily = existsSync(dailyPath) && isRecord(parseJsonFile(dailyPath)) ? (parseJsonFile(dailyPath) as Record<string, unknown>) : undefined;
  return {
    schema: "zob.queue-dashboard-summary.v1",
    generatedAt: new Date().toISOString(),
    queue: {
      pending: countQueueFiles(paths.pending),
      running: countQueueFiles(paths.running),
      done: countQueueFiles(paths.done),
      failed: countQueueFiles(paths.failed),
    },
    lifecycle: { events: ledger.length, byEvent, byJobType, latest: ledger.slice(-5) },
    telemetry: daily ? { date: day, totals: daily.totals, statusCounts: daily.statusCounts, bodySafety: daily.bodySafety } : { date: day, missing: true },
    budgetEnforced: false,
    autoStartDaemon: false,
    continuousLoop: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}
