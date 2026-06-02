import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { READ_ONLY_QUEUE_JOB_TYPES } from "../telemetry/queue.js";
import type { ChildStopCondition } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { parseJsonFile } from "../../core/utils/json.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export interface DaemonPolicyReadinessAuditInput {
  run_id?: string;
}

const FORBIDDEN_DAEMON_POLICY_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content", "patch", "diff"]);
const REQUIRED_DISABLED_FLAGS = [
  "daemonEnabled",
  "alwaysOnDaemonEnabled",
  "autoStartDaemon",
  "continuousLoop",
  "cronEnabled",
  "budgetEnforced",
  "strictEnabled",
  "wouldBlockDispatch",
  "modelRouterUsed",
  "routingApplied",
  "childDispatchAllowed",
  "liveChildExecution",
  "networkAccessed",
  "writeAdaptersEnabled",
  "productionWritesPerformed",
  "autoApply",
  "bodyStored",
  "promptBodiesStored",
  "outputBodiesStored",
];
const REQUIRED_DISALLOWED_ADAPTERS = ["write", "edit", "github", "browser", "cloud", "web", "deploy", "publish"];
const ALL_STOP_CONDITIONS: ChildStopCondition[] = [
  "none",
  "failed_preflight",
  "incomplete_no_assistant_turn",
  "incomplete_no_evidence",
  "failed_validation",
  "timeout",
  "blocked",
  "scope_violation",
  "agentic_failed",
  "oracle_fail",
  "no_ship",
  "fail_loop",
];
const REQUIRED_TERMINAL_STOP_CONDITIONS = ALL_STOP_CONDITIONS.filter((condition) => condition !== "none");

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_DAEMON_POLICY_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function sameStringSet(actual: string[] | undefined, expected: string[]): boolean {
  if (!actual) return false;
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function readinessCheck(name: string, passed: boolean, detail: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, passed, detail };
}

export function validateDaemonPolicyConfig(repoRoot: string): Record<string, unknown> {
  const configPath = join(repoRoot, ".pi", "daemon-policy.json");
  const errors: string[] = [];
  let parsed: Record<string, unknown> | undefined;
  let configHash: string | undefined;
  if (!existsSync(configPath)) {
    errors.push(".pi/daemon-policy.json is missing");
  } else {
    try {
      const raw = readFileSync(configPath, "utf8");
      configHash = sha256(raw);
      const value = parseJsonFile(configPath);
      if (!isRecord(value)) errors.push("daemon policy config must be a JSON object");
      else parsed = value;
    } catch (error) {
      errors.push(`daemon policy config could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const allowedJobTypes = stringArray(parsed?.allowedJobTypes);
  const allowedStopConditions = stringArray(parsed?.allowedStopConditions);
  const requiredStopConditions = stringArray(parsed?.requiredStopConditions);
  const disallowedAdapters = stringArray(parsed?.disallowedAdapters);
  const futureAlwaysOnPrerequisites = stringArray(parsed?.futureAlwaysOnPrerequisites);

  if (parsed) {
    if (parsed.schema !== "zob.daemon-policy.v1") errors.push("daemon policy schema must be zob.daemon-policy.v1");
    if (parsed.mode !== "manual_one_shot_readonly") errors.push("daemon policy mode must remain manual_one_shot_readonly");
    for (const flag of REQUIRED_DISABLED_FLAGS) {
      if (parsed[flag] !== false) errors.push(`daemon policy must keep ${flag}=false`);
    }
    if (parsed.noExecution !== true) errors.push("daemon policy must keep noExecution=true");
    if (parsed.maxWorkersDefault !== 1) errors.push("daemon policy maxWorkersDefault must remain 1");
    if (parsed.maxWorkersMax !== 1) errors.push("daemon policy maxWorkersMax must remain 1");
    if (parsed.claimAtMostOneJobPerTick !== true) errors.push("daemon policy must claim at most one job per tick");
    if (!sameStringSet(allowedJobTypes, READ_ONLY_QUEUE_JOB_TYPES)) errors.push("daemon policy allowedJobTypes must match READ_ONLY_QUEUE_JOB_TYPES");
    if (!sameStringSet(disallowedAdapters, REQUIRED_DISALLOWED_ADAPTERS)) errors.push("daemon policy disallowedAdapters must match required unsafe adapters");
    if (!sameStringSet(allowedStopConditions, ALL_STOP_CONDITIONS)) errors.push("daemon policy allowedStopConditions must cover all known child stop conditions");
    if (!sameStringSet(requiredStopConditions, REQUIRED_TERMINAL_STOP_CONDITIONS)) errors.push("daemon policy requiredStopConditions must cover all terminal stop conditions");
    if (!futureAlwaysOnPrerequisites || futureAlwaysOnPrerequisites.length === 0) errors.push("daemon policy requires futureAlwaysOnPrerequisites string array");
    if (hasForbiddenBodyKeys(parsed)) errors.push("daemon policy must not store raw task/prompt/output/body/content/patch/diff fields");
  }

  return {
    schema: "zob.daemon-policy-validation.v1",
    path: ".pi/daemon-policy.json",
    present: existsSync(configPath),
    valid: errors.length === 0,
    errors,
    configHash,
    mode: parsed?.mode,
    allowedJobTypes: allowedJobTypes ?? [],
    disallowedAdapters: disallowedAdapters ?? [],
    allowedStopConditions: allowedStopConditions ?? [],
    requiredStopConditions: requiredStopConditions ?? [],
    futureAlwaysOnPrerequisitesCount: futureAlwaysOnPrerequisites?.length ?? 0,
    maxWorkersDefault: parsed?.maxWorkersDefault,
    maxWorkersMax: parsed?.maxWorkersMax,
    claimAtMostOneJobPerTick: parsed?.claimAtMostOneJobPerTick === true,
    daemonEnabled: parsed?.daemonEnabled === true,
    alwaysOnDaemonEnabled: parsed?.alwaysOnDaemonEnabled === true,
    autoStartDaemon: parsed?.autoStartDaemon === true,
    continuousLoop: parsed?.continuousLoop === true,
    cronEnabled: parsed?.cronEnabled === true,
    budgetEnforced: parsed?.budgetEnforced === true,
    strictEnabled: parsed?.strictEnabled === true,
    wouldBlockDispatch: parsed?.wouldBlockDispatch === true,
    modelRouterUsed: parsed?.modelRouterUsed === true,
    routingApplied: parsed?.routingApplied === true,
    childDispatchAllowed: parsed?.childDispatchAllowed === true,
    liveChildExecution: parsed?.liveChildExecution === true,
    networkAccessed: parsed?.networkAccessed === true,
    writeAdaptersEnabled: parsed?.writeAdaptersEnabled === true,
    productionWritesPerformed: parsed?.productionWritesPerformed === true,
    autoApply: parsed?.autoApply === true,
    noExecution: parsed?.noExecution === true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildDaemonPolicyReadinessAudit(repoRoot: string, input: DaemonPolicyReadinessAuditInput = {}): Record<string, unknown> {
  const configValidation = validateDaemonPolicyConfig(repoRoot);
  const checks = [
    readinessCheck("daemon_policy_config_valid", configValidation.present === true && configValidation.valid === true, { configHash: configValidation.configHash, errors: configValidation.errors }),
    readinessCheck("manual_one_shot_readonly_policy", configValidation.mode === "manual_one_shot_readonly" && configValidation.claimAtMostOneJobPerTick === true, { mode: configValidation.mode, claimAtMostOneJobPerTick: configValidation.claimAtMostOneJobPerTick }),
    readinessCheck("one_worker_policy", configValidation.maxWorkersDefault === 1 && configValidation.maxWorkersMax === 1, { maxWorkersDefault: configValidation.maxWorkersDefault, maxWorkersMax: configValidation.maxWorkersMax }),
    readinessCheck("read_only_job_types_match_queue_registry", sameStringSet(configValidation.allowedJobTypes as string[], READ_ONLY_QUEUE_JOB_TYPES), { allowedJobTypes: configValidation.allowedJobTypes, queueJobTypes: READ_ONLY_QUEUE_JOB_TYPES }),
    readinessCheck("terminal_stop_conditions_registered", sameStringSet(configValidation.requiredStopConditions as string[], REQUIRED_TERMINAL_STOP_CONDITIONS), { requiredStopConditions: configValidation.requiredStopConditions }),
    readinessCheck("daemon_activation_flags_disabled", REQUIRED_DISABLED_FLAGS.every((flag) => configValidation[flag] === false) && configValidation.noExecution === true, { disabledFlags: REQUIRED_DISABLED_FLAGS }),
    readinessCheck("always_on_daemon_integration_implemented", false, { reason: "always-on daemon/cron runner is intentionally not implemented or enabled yet" }),
  ];
  const failedChecks = checks.filter((check) => check.passed !== true).map((check) => check.name);
  const auditPassed = checks
    .filter((check) => check.name !== "always_on_daemon_integration_implemented")
    .every((check) => check.passed === true);
  const report = {
    schema: "zob.daemon-policy-readiness-audit.v1",
    runId: input.run_id,
    auditPassed,
    readiness: failedChecks.length === 0 ? "ready_for_future_always_on_daemon_review" : "blocked_for_always_on_daemon",
    readyForManualOneShotOnly: auditPassed,
    alwaysOnDaemonReady: false,
    alwaysOnDaemonNoShip: true,
    alwaysOnDaemonBlockers: [
      "always-on daemon/cron runner is not implemented",
      "daemon autostart remains disabled",
      "continuous loop remains disabled",
      "strict budget enforcement is not integrated with dispatch blocking",
      "live model routing is not integrated",
      "oracle review and explicit approval are required before daemon autostart",
    ],
    checks,
    failedChecks,
    config: configValidation,
    maxWorkersDefault: 1,
    maxWorkersMax: 1,
    claimAtMostOneJobPerTick: true,
    autoStartDaemon: false,
    continuousLoop: false,
    daemonStarted: false,
    cronEnabled: false,
    budgetEnforced: false,
    strictEnabled: false,
    wouldBlockDispatch: false,
    modelRouterUsed: false,
    routingApplied: false,
    childDispatchAllowed: false,
    liveChildExecution: false,
    networkAccessed: false,
    writeAdaptersEnabled: false,
    productionWritesPerformed: false,
    autoApply: false,
    noExecution: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(report)) throw new Error("Daemon policy readiness audit would store forbidden body keys");
  return report;
}

export function writeDaemonPolicyReadinessAuditReport(repoRoot: string, runId = "daemon-policy-readiness", input: DaemonPolicyReadinessAuditInput = {}): string {
  const dir = join(repoRoot, ".pi", "logs", "daemon-readiness");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(buildDaemonPolicyReadinessAudit(repoRoot, { ...input, run_id: runId }), null, 2), "utf8");
  return outputPath;
}
