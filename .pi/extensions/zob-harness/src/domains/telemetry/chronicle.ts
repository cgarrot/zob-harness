import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BudgetPreflightDryRunInput,
  ChildStopCondition,
  ChildStopConditionInput,
  ChronicleClassifyInput,
  DelegationTelemetryInput,
  FactoryTelemetryInput,
  RunawayGuardInput,
} from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { safeFileStem } from "../../core/utils/paths.js";

export const CHRONICLE_STATES = [
  "created",
  "preflighted",
  "running",
  "assistant_turn_seen",
  "output_captured",
  "output_validated",
  "evidence_checked",
  "complete",
  "failed_preflight",
  "incomplete_no_assistant_turn",
  "incomplete_no_evidence",
  "failed_validation",
  "scope_violation",
  "timeout",
  "blocked",
  "planned",
  "agentic_failed",
] as const;

export type ChronicleState = (typeof CHRONICLE_STATES)[number];

const TERMINAL_CHRONICLE_FAILURE_STATES = new Set<ChronicleState>([
  "failed_preflight",
  "incomplete_no_assistant_turn",
  "incomplete_no_evidence",
  "failed_validation",
  "scope_violation",
  "timeout",
  "blocked",
  "agentic_failed",
]);

export function evaluateBudgetPreflightDryRun(input: BudgetPreflightDryRunInput): Record<string, unknown> {
  const caps = input.caps ?? {};
  const observed = {
    costUsd: input.costUsd ?? 0,
    runs: input.runs ?? 0,
    durationMs: input.durationMs ?? 0,
    parallelChildren: input.parallelChildren ?? 0,
  };
  const checks = [
    { name: "maxCostUsd", cap: caps.maxCostUsd, observed: observed.costUsd },
    { name: "maxRuns", cap: caps.maxRuns, observed: observed.runs },
    { name: "maxDurationMs", cap: caps.maxDurationMs, observed: observed.durationMs },
    { name: "maxParallelChildren", cap: caps.maxParallelChildren, observed: observed.parallelChildren },
  ].map((check) => ({
    ...check,
    passed: check.cap === undefined || check.observed <= check.cap,
  }));
  const failures = checks.filter((check) => !check.passed).map((check) => check.name);
  return {
    schema: "zob.budget-preflight-result.v1",
    passed: failures.length === 0,
    failures,
    caps,
    observed,
    checks,
    dryRun: true,
    mode: "advisory",
    advisory: true,
    wouldExceed: failures.length > 0,
    strictRequested: input.strictRequested === true,
    strictEnabled: false,
    budgetEnforced: false,
    wouldBlockDispatch: false,
    defaultDispatchDecision: "allow",
    modelRouterUsed: false,
    daemonStarted: false,
    childDispatchAllowed: false,
    noExecution: true,
  };
}

function outputHasEvidenceMarker(output: string | undefined): boolean {
  if (!output) return false;
  return /(?:<evidence>[\s\S]*?<\/evidence>|<evidence>|\bevidence\b|preuve|preuves)/i.test(output);
}

export function detectOracleFail(output: string | undefined): { oracleFailed: boolean; noShip: boolean; stopCondition: ChildStopCondition } {
  const text = output ?? "";
  const oracleFailed = /(?:<verdict>\s*FAIL\s*<\/verdict>|\bverdict\s*[:=-]\s*FAIL\b|^\s*FAIL\b)/im.test(text);
  const noShip = /(?:<no_ship>\s*(?:true|yes)\s*<\/no_ship>|\bno_ship\s*[:=-]\s*(?:true|yes)\b|\bno ship\s*[:=-]\s*(?:true|yes)\b)/i.test(text);
  return { oracleFailed, noShip, stopCondition: noShip ? "no_ship" : oracleFailed ? "oracle_fail" : "none" };
}

export function summarizeRunawayGuard(input: RunawayGuardInput = {}): Record<string, unknown> {
  const threshold = Math.max(1, Math.floor(input.failLoopThreshold ?? 3));
  const failureStatuses = new Set(["failed", "failed_preflight", "failed_validation", "incomplete_or_failed", "incomplete_no_assistant_turn", "incomplete_no_evidence", "timeout", "agentic_failed", "oracle_fail", "no_ship"]);
  const recentFailures = typeof input.failures === "number" ? input.failures : (input.recentStatuses ?? []).filter((status) => failureStatuses.has(status)).length;
  const failLoopExceeded = recentFailures >= threshold;
  return {
    schema: "zob.runaway-guard.v1",
    stopCondition: failLoopExceeded ? "fail_loop" : "none",
    shouldStop: failLoopExceeded,
    failLoopThreshold: threshold,
    recentFailures,
    budget: {
      wouldExceed: input.budgetWouldExceed === true,
      enforced: false,
      advisory: true,
      wouldBlockDispatch: false,
    },
    budgetEnforced: false,
  };
}

export function classifyChildStopCondition(input: ChildStopConditionInput): Record<string, unknown> {
  const oracle = detectOracleFail(input.output);
  const outputCaptured = input.outputCaptured ?? Boolean(input.outputHash);
  let stopCondition: ChildStopCondition = "none";

  if (input.failLoopExceeded) stopCondition = "fail_loop";
  else if (input.scopeViolation) stopCondition = "scope_violation";
  else if (input.timedOut || input.status === "timeout") stopCondition = "timeout";
  else if (input.blocked || input.status === "blocked") stopCondition = "blocked";
  else if (input.agenticFailed || input.status === "agentic_failed") stopCondition = "agentic_failed";
  else if (input.preflightPassed === false || input.status === "failed_preflight" || input.status === "unknown_agent") stopCondition = "failed_preflight";
  else if (oracle.noShip) stopCondition = "no_ship";
  else if (oracle.oracleFailed) stopCondition = "oracle_fail";
  else if (input.assistantTurnSeen === false) stopCondition = "incomplete_no_assistant_turn";
  else if (!outputCaptured || !input.outputHash || input.evidenceChecked === false) stopCondition = "incomplete_no_evidence";
  else if (input.outputValidated === false || input.status === "failed_validation" || input.status === "incomplete_or_failed") stopCondition = "failed_validation";

  return {
    schema: "zob.child-stop-condition.v1",
    stopCondition,
    shouldStop: stopCondition !== "none",
    oracleFailed: oracle.oracleFailed,
    noShip: oracle.noShip,
    budget: { advisory: true, enforced: false },
    budgetEnforced: false,
  };
}

export function classifyChronicleCompletion(input: ChronicleClassifyInput): Record<string, unknown> {
  const preflightPassed = input.preflightPassed ?? input.status !== "failed_preflight";
  const assistantTurnSeen = input.assistantTurnSeen === true;
  const outputCaptured = input.outputCaptured ?? Boolean(input.outputHash);
  const outputValidated = input.outputValidated === true;
  const evidenceChecked = input.evidenceChecked === true;
  let state: ChronicleState = "created";

  if (input.scopeViolation) state = "scope_violation";
  else if (input.timedOut) state = "timeout";
  else if (input.blocked) state = "blocked";
  else if (input.agenticFailed || input.status === "agentic_failed") state = "agentic_failed";
  else if (!preflightPassed || input.status === "failed_preflight") state = "failed_preflight";
  else if (input.planned || input.status === "planned") state = "planned";
  else if (!assistantTurnSeen) state = "incomplete_no_assistant_turn";
  else if (!outputCaptured || !input.outputHash || !evidenceChecked) state = "incomplete_no_evidence";
  else if (!outputValidated) state = "failed_validation";
  else state = "complete";

  const stopCondition = input.stopCondition ?? (state === "complete" || state === "planned" ? "none" : (state as ChildStopCondition));

  return {
    schema: "zob.chronicle-state.v1",
    kind: input.kind,
    runId: input.runId,
    state,
    complete: state === "complete",
    stopCondition,
    falseDoneGuard: {
      assistantTurnSeen,
      outputCaptured: Boolean(outputCaptured && input.outputHash),
      outputValidated,
      evidenceChecked,
      passed: state === "complete",
    },
    taskHash: input.taskHash,
    outputHash: input.outputHash,
    evidencePaths: input.evidencePaths ?? [],
    budget: {
      advisory: input.budget?.advisory ?? true,
      enforced: input.budget?.enforced === true,
    },
    terminalFailure: TERMINAL_CHRONICLE_FAILURE_STATES.has(state),
    errors: input.errors ?? [],
  };
}

export function classifyDelegationChronicleCompletion(input: DelegationTelemetryInput): Record<string, unknown> {
  const stop = classifyChildStopCondition({
    status: input.status,
    agent: input.agent,
    outputContract: input.outputContract,
    assistantTurnSeen: input.assistantTurnSeen ?? ((input.usage?.turns ?? 0) > 0),
    outputHash: input.outputHash,
    outputCaptured: input.outputCaptured ?? Boolean(input.outputHash),
    outputValidated: input.outputValidated ?? input.gatePassed === true,
    evidenceChecked: input.evidenceChecked ?? input.gatePassed === true,
    preflightPassed: input.status !== "failed_preflight" && input.status !== "unknown_agent",
    timedOut: input.status === "timeout",
    blocked: input.status === "blocked",
  });
  return classifyChronicleCompletion({
    kind: "delegation",
    runId: input.runId,
    status: input.status,
    taskHash: input.taskHash,
    outputHash: input.outputHash,
    stopCondition: input.stopCondition ?? (stop.stopCondition as ChildStopCondition),
    assistantTurnSeen: input.assistantTurnSeen ?? ((input.usage?.turns ?? 0) > 0),
    outputCaptured: input.outputCaptured ?? Boolean(input.outputHash),
    outputValidated: input.outputValidated ?? input.gatePassed === true,
    evidenceChecked: input.evidenceChecked ?? input.gatePassed === true,
    preflightPassed: input.status !== "failed_preflight" && input.status !== "unknown_agent",
    timedOut: input.status === "timeout",
    blocked: input.status === "blocked",
    budget: { advisory: true, enforced: false },
    errors: input.gateErrors ?? [],
  });
}

export function classifyFactoryChronicleCompletion(input: FactoryTelemetryInput): Record<string, unknown> {
  const outputHash = input.generatedArtifacts.length > 0 ? sha256(input.generatedArtifacts.join("\n")) : undefined;
  const validationPassed = input.status === "done";
  return classifyChronicleCompletion({
    kind: "factory",
    runId: input.runId,
    status: input.status,
    outputHash,
    evidencePaths: input.generatedArtifacts,
    assistantTurnSeen: input.execution === "agentic" ? (input.usage?.turns ?? 0) > 0 : input.status !== "failed_preflight",
    outputCaptured: input.generatedArtifacts.length > 0,
    outputValidated: validationPassed,
    evidenceChecked: validationPassed,
    preflightPassed: input.status !== "failed_preflight",
    planned: input.status === "planned",
    agenticFailed: input.status === "agentic_failed",
    budget: { advisory: true, enforced: false },
    errors: input.errors ?? [],
  });
}

export function writeChronicleSnapshot(repoRoot: string, snapshot: Record<string, unknown>): string {
  const runId = typeof snapshot.runId === "string" && snapshot.runId ? snapshot.runId : "unknown";
  const kind = typeof snapshot.kind === "string" && snapshot.kind ? snapshot.kind : "run";
  const dir = join(repoRoot, ".pi", "logs", "chronicle");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(kind)}-${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf8");
  return outputPath;
}

export { outputHasEvidenceMarker };
