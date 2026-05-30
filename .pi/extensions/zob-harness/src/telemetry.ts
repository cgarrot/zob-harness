import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { classifyDelegationChronicleCompletion, classifyFactoryChronicleCompletion, writeChronicleSnapshot } from "./chronicle.js";
import type { AssistantLikeMessage, ChildResult, ChildStopCondition, DelegationTelemetryInput, FactoryTelemetryInput } from "./types.js";
import { parseJsonFile } from "./utils/json.js";
import { safeFileStem } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

function usageEmpty(): ChildResult["usage"] {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

function addUsage(target: ChildResult["usage"], source: ChildResult["usage"] | undefined): void {
  if (!source) return;
  target.turns += source.turns ?? 0;
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.cost += source.cost ?? 0;
  target.contextTokens = Math.max(target.contextTokens, source.contextTokens ?? 0);
}

function updateUsage(result: ChildResult, message: AssistantLikeMessage): void {
  result.usage.turns += 1;
  const usage = message.usage;
  if (!usage) return;
  result.usage.input += usage.input ?? 0;
  result.usage.output += usage.output ?? 0;
  result.usage.cacheRead += usage.cacheRead ?? 0;
  result.usage.cacheWrite += usage.cacheWrite ?? 0;
  result.usage.cost += usage.cost?.total ?? 0;
  result.usage.contextTokens = usage.totalTokens ?? result.usage.contextTokens;
}

export function buildDelegationTelemetrySummary(input: DelegationTelemetryInput): Record<string, unknown> {
  const usage = input.usage ?? usageEmpty();
  return {
    schema: "zob.delegation-telemetry.v1",
    runId: input.runId,
    source: input.source,
    mode: input.mode,
    agent: input.agent,
    model: input.model,
    cwd: input.cwd,
    tools: input.tools,
    taskHash: input.taskHash,
    outputHash: input.outputHash,
    outputContract: input.outputContract,
    status: input.status,
    stopCondition: input.stopCondition ?? (classifyDelegationChronicleCompletion(input).stopCondition as ChildStopCondition),
    chronicle: classifyDelegationChronicleCompletion(input),
    gate: {
      passed: input.gatePassed ?? false,
      errors: input.gateErrors ?? [],
    },
    usage: {
      turns: usage.turns,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost,
      contextTokens: usage.contextTokens,
    },
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    sessionPath: input.sessionPath,
  };
}

export function writeDelegationTelemetrySummary(repoRoot: string, input: DelegationTelemetryInput): string {
  const dir = join(repoRoot, ".pi", "logs", "telemetry");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(input.runId)}.json`);
  const summary = buildDelegationTelemetrySummary(input);
  writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf8");
  if (isRecord(summary.chronicle)) writeChronicleSnapshot(repoRoot, summary.chronicle as Record<string, unknown>);
  writeDailyTelemetrySummary(repoRoot, input.startedAt.slice(0, 10));
  return outputPath;
}

export function buildFactoryTelemetrySummary(input: FactoryTelemetryInput): Record<string, unknown> {
  const usage = input.usage ?? usageEmpty();
  const costTotal = usage.cost;
  return {
    schema: "zob.factory-telemetry.v1",
    runId: input.runId,
    factory: input.factory,
    mode: input.mode,
    execution: input.execution,
    status: input.status,
    items: {
      selected: input.itemCount,
      processed: input.processed,
      failed: input.failed,
      costTotal,
      costPerItem: input.itemCount > 0 ? costTotal / input.itemCount : 0,
    },
    artifacts: {
      expected: input.expectedArtifacts,
      generated: input.generatedArtifacts,
      count: input.generatedArtifacts.length,
      costTotal,
      costPerArtifact: input.generatedArtifacts.length > 0 ? costTotal / input.generatedArtifacts.length : 0,
    },
    stages: {
      declared: input.stageCount,
      agenticTasks: input.agenticTasks,
      failuresByStage: input.failuresByStage,
    },
    retries: {
      count: input.retryCount,
    },
    usage: {
      turns: usage.turns,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost,
      contextTokens: usage.contextTokens,
    },
    wallTimeMs: Math.max(0, Math.round(input.wallTimeMs)),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    budgetEnforced: input.budgetEnforced === true,
    modelRouterUsed: input.modelRouterUsed === true,
    chronicle: classifyFactoryChronicleCompletion(input),
    errors: input.errors ?? [],
  };
}

export function writeFactoryTelemetrySummary(repoRoot: string, input: FactoryTelemetryInput): { globalPath: string; runPath?: string } {
  const dir = join(repoRoot, ".pi", "logs", "telemetry");
  mkdirSync(dir, { recursive: true });
  const summary = buildFactoryTelemetrySummary(input);
  if (isRecord(summary.chronicle)) writeChronicleSnapshot(repoRoot, summary.chronicle as Record<string, unknown>);
  const globalStem = input.status === "failed_preflight" && !input.runDir ? `factory-${safeFileStem(input.runId)}-failed-preflight` : `factory-${safeFileStem(input.runId)}`;
  const globalPath = join(dir, `${globalStem}.json`);
  writeFileSync(globalPath, JSON.stringify(summary, null, 2), "utf8");
  writeDailyTelemetrySummary(repoRoot, input.startedAt.slice(0, 10));
  let runPath: string | undefined;
  if (input.runDir && existsSync(input.runDir)) {
    runPath = join(input.runDir, "telemetry.json");
    writeFileSync(runPath, JSON.stringify(summary, null, 2), "utf8");
  }
  return { globalPath, runPath };
}

function normalizeDailyTelemetryDate(date?: string): string {
  const candidate = (date ?? new Date().toISOString()).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : new Date().toISOString().slice(0, 10);
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function usageFromRecord(value: unknown): ChildResult["usage"] {
  if (!isRecord(value)) return usageEmpty();
  return {
    turns: numberFrom(value.turns),
    input: numberFrom(value.input),
    output: numberFrom(value.output),
    cacheRead: numberFrom(value.cacheRead),
    cacheWrite: numberFrom(value.cacheWrite),
    cost: numberFrom(value.cost),
    contextTokens: numberFrom(value.contextTokens),
  };
}

function incrementCounter(target: Record<string, number>, key: string | undefined, amount = 1): void {
  if (!key) return;
  target[key] = (target[key] ?? 0) + amount;
}

function incrementUsageBucket(target: Record<string, { runs: number; cost: number; input: number; output: number; failures: number }>, key: string | undefined, usage: ChildResult["usage"], failed: boolean): void {
  if (!key) return;
  const bucket = target[key] ?? { runs: 0, cost: 0, input: 0, output: 0, failures: 0 };
  bucket.runs += 1;
  bucket.cost += usage.cost;
  bucket.input += usage.input;
  bucket.output += usage.output;
  if (failed) bucket.failures += 1;
  target[key] = bucket;
}

function telemetryRecordDate(record: Record<string, unknown>): string | undefined {
  const startedAt = stringFrom(record.startedAt);
  if (startedAt && /^\d{4}-\d{2}-\d{2}/.test(startedAt)) return startedAt.slice(0, 10);
  const endedAt = stringFrom(record.endedAt);
  if (endedAt && /^\d{4}-\d{2}-\d{2}/.test(endedAt)) return endedAt.slice(0, 10);
  return undefined;
}

function telemetryStatusFailed(record: Record<string, unknown>): boolean {
  const status = stringFrom(record.status) ?? "unknown";
  if (["failed", "failed_preflight", "failed_validation", "agentic_failed", "incomplete_or_failed", "unknown_agent"].includes(status)) return true;
  const gate = isRecord(record.gate) ? record.gate : undefined;
  return gate?.passed === false;
}

export function buildDailyTelemetrySummary(repoRoot: string, date?: string): Record<string, unknown> {
  const day = normalizeDailyTelemetryDate(date);
  const telemetryDir = join(repoRoot, ".pi", "logs", "telemetry");
  const parseErrors: Array<{ file: string; error: string }> = [];
  const records: Array<Record<string, unknown>> = [];
  const runSummaries: Array<Record<string, unknown>> = [];
  const statusCounts: Record<string, number> = {};
  const schemaCounts: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byAgent: Record<string, { runs: number; cost: number; input: number; output: number; failures: number }> = {};
  const byModel: Record<string, { runs: number; cost: number; input: number; output: number; failures: number }> = {};
  const byOutputContract: Record<string, { runs: number; cost: number; input: number; output: number; failures: number }> = {};
  const byFactory: Record<string, { runs: number; cost: number; input: number; output: number; failures: number }> = {};
  const failuresByStage: Record<string, number> = {};
  const forbiddenTopLevelFields: Array<{ file: string; field: string }> = [];
  const totals = {
    runs: 0,
    delegationRuns: 0,
    factoryRuns: 0,
    failures: 0,
    gatePassed: 0,
    gateFailed: 0,
    gateErrors: 0,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextTokens: 0,
    cost: 0,
    latencyMs: 0,
    wallTimeMs: 0,
    retries: 0,
    itemsSelected: 0,
    itemsProcessed: 0,
    itemsFailed: 0,
    artifactsGenerated: 0,
  };

  const files = existsSync(telemetryDir) ? readdirSync(telemetryDir).filter((file) => file.endsWith(".json")).sort() : [];
  for (const file of files) {
    const path = join(telemetryDir, file);
    let parsed: unknown;
    try {
      parsed = parseJsonFile(path);
    } catch (error) {
      parseErrors.push({ file, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!isRecord(parsed)) continue;
    const schema = stringFrom(parsed.schema);
    if (schema !== "zob.delegation-telemetry.v1" && schema !== "zob.factory-telemetry.v1") continue;
    if (telemetryRecordDate(parsed) !== day) continue;

    records.push(parsed);
    const usage = usageFromRecord(parsed.usage);
    const status = stringFrom(parsed.status) ?? "unknown";
    const failed = telemetryStatusFailed(parsed);
    const source = schema === "zob.factory-telemetry.v1" ? "factory_run" : stringFrom(parsed.source) ?? "delegation";
    const gate = isRecord(parsed.gate) ? parsed.gate : undefined;

    totals.runs += 1;
    if (schema === "zob.delegation-telemetry.v1") totals.delegationRuns += 1;
    if (schema === "zob.factory-telemetry.v1") totals.factoryRuns += 1;
    if (failed) totals.failures += 1;
    totals.turns += usage.turns;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.contextTokens = Math.max(totals.contextTokens, usage.contextTokens);
    totals.cost += usage.cost;
    totals.latencyMs += numberFrom(parsed.latencyMs);
    totals.wallTimeMs += numberFrom(parsed.wallTimeMs);

    if (gate) {
      if (gate.passed === true) totals.gatePassed += 1;
      if (gate.passed === false) totals.gateFailed += 1;
      if (Array.isArray(gate.errors)) totals.gateErrors += gate.errors.length;
    }

    if (schema === "zob.factory-telemetry.v1") {
      const items = isRecord(parsed.items) ? parsed.items : {};
      const artifacts = isRecord(parsed.artifacts) ? parsed.artifacts : {};
      const retries = isRecord(parsed.retries) ? parsed.retries : {};
      const stages = isRecord(parsed.stages) ? parsed.stages : {};
      totals.itemsSelected += numberFrom(items.selected);
      totals.itemsProcessed += numberFrom(items.processed);
      totals.itemsFailed += numberFrom(items.failed);
      totals.artifactsGenerated += numberFrom(artifacts.count);
      totals.retries += numberFrom(retries.count);
      const stageFailures = isRecord(stages.failuresByStage) ? stages.failuresByStage : {};
      for (const [stage, count] of Object.entries(stageFailures)) incrementCounter(failuresByStage, stage, numberFrom(count));
      incrementUsageBucket(byFactory, stringFrom(parsed.factory), usage, failed);
    }

    incrementCounter(statusCounts, status);
    incrementCounter(schemaCounts, schema);
    incrementCounter(bySource, source);
    incrementUsageBucket(byAgent, stringFrom(parsed.agent), usage, failed);
    incrementUsageBucket(byModel, stringFrom(parsed.model), usage, failed);
    incrementUsageBucket(byOutputContract, stringFrom(parsed.outputContract), usage, failed);

    for (const field of ["task", "output", "prompt", "body"]) {
      if (Object.prototype.hasOwnProperty.call(parsed, field)) forbiddenTopLevelFields.push({ file, field });
    }

    runSummaries.push({
      file,
      schema,
      runId: stringFrom(parsed.runId),
      source,
      status,
      agent: stringFrom(parsed.agent),
      factory: stringFrom(parsed.factory),
      model: stringFrom(parsed.model),
      outputContract: stringFrom(parsed.outputContract),
      cost: usage.cost,
      input: usage.input,
      outputTokens: usage.output,
      failed,
      startedAt: stringFrom(parsed.startedAt),
      endedAt: stringFrom(parsed.endedAt),
      latencyMs: numberFrom(parsed.latencyMs),
      wallTimeMs: numberFrom(parsed.wallTimeMs),
    });
  }

  return {
    schema: "zob.telemetry-daily-summary.v1",
    date: day,
    generatedAt: new Date().toISOString(),
    sourceDir: ".pi/logs/telemetry",
    telemetryFiles: records.length,
    totals,
    statusCounts,
    schemaCounts,
    bySource,
    byAgent,
    byModel,
    byOutputContract,
    byFactory,
    failuresByStage,
    bodySafety: {
      forbiddenTopLevelFieldsPresent: forbiddenTopLevelFields,
      storesPromptOrOutputBodies: forbiddenTopLevelFields.length > 0,
    },
    budgetEnforced: false,
    modelRouterUsed: false,
    parseErrors,
    runs: runSummaries,
  };
}

export function writeDailyTelemetrySummary(repoRoot: string, date?: string): string {
  const day = normalizeDailyTelemetryDate(date);
  const dir = join(repoRoot, ".pi", "logs", "summaries");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${day}.json`);
  writeFileSync(outputPath, JSON.stringify(buildDailyTelemetrySummary(repoRoot, day), null, 2), "utf8");
  return outputPath;
}

export { addUsage, incrementCounter, normalizeDailyTelemetryDate, stringFrom, updateUsage, usageEmpty };
