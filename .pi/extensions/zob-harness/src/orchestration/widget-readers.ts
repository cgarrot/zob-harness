import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseJsonFile, readJsonObjectIfPresent } from "../utils/json.js";
import { isRecord } from "../utils/records.js";

function widgetCounts(value: unknown): string {
  if (!isRecord(value)) return "none";
  const parts = Object.entries(value)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([key, count]) => `${key}=${count}`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

function widgetUpdatedAt(timestamp: string): string {
  if (!timestamp) return "updated=?";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "updated=?";
  return `updated=${parsed.toISOString().slice(11, 16)}Z`;
}

interface OrchestrationWidgetData {
  runId: string;
  timestamp: string;
  total: number;
  events: number;
  running: number;
  status: string;
  ack: string;
  ping: string;
  noExecution: boolean;
  execution: string;
}

interface HarnessReadinessWidgetData {
  readiness: "supervised-factory" | "needs-attention";
  smokeOk: boolean;
  pilotOk: boolean;
  readonlyOk: boolean;
  factoryMatrixOk: boolean;
  globalNoShip: boolean;
  autonomyReady: boolean;
  source: string;
  blockers: string[];
}

function readLatestOrchestrationWidgetData(repoRoot: string): OrchestrationWidgetData | undefined {
  const orchestrationRoot = join(repoRoot, "reports", "orchestrations");
  if (!existsSync(orchestrationRoot)) return undefined;
  let latest: OrchestrationWidgetData | undefined;
  for (const entry of readdirSync(orchestrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const snapshotPath = join(orchestrationRoot, entry.name, "status-snapshot.json");
    const validationPath = join(orchestrationRoot, entry.name, "validation.json");
    if (!existsSync(snapshotPath)) continue;
    try {
      const snapshot = parseJsonFile(snapshotPath);
      const validation = existsSync(validationPath) ? parseJsonFile(validationPath) : undefined;
      if (!isRecord(snapshot)) continue;
      const byStatus = isRecord(snapshot.byStatus) ? snapshot.byStatus : {};
      const byAck = isRecord(snapshot.byAck) ? snapshot.byAck : {};
      const byPing = isRecord(snapshot.byPing) ? snapshot.byPing : {};
      const timestamp = typeof snapshot.timestamp === "string" ? snapshot.timestamp : lstatSync(snapshotPath).mtime.toISOString();
      const candidate: OrchestrationWidgetData = {
        runId: typeof snapshot.runId === "string" ? snapshot.runId : entry.name,
        timestamp,
        total: typeof snapshot.total === "number" ? snapshot.total : 0,
        events: typeof snapshot.events === "number" ? snapshot.events : (typeof snapshot.total === "number" ? snapshot.total : 0),
        running: typeof snapshot.running === "number" ? snapshot.running : 0,
        status: isRecord(validation) && typeof validation.status === "string" ? validation.status : widgetCounts(byStatus),
        ack: widgetCounts(byAck),
        ping: widgetCounts(byPing),
        noExecution: snapshot.noExecution === true,
        execution: typeof snapshot.execution === "string" ? snapshot.execution : "unknown",
      };
      if (!latest || candidate.timestamp.localeCompare(latest.timestamp) >= 0) latest = candidate;
    } catch {
      continue;
    }
  }
  return latest;
}

export function readLatestOrchestrationWidgetSummary(repoRoot: string): string {
  const latest = readLatestOrchestrationWidgetData(repoRoot);
  if (!latest) return "orchestration=none";
  return `orchestration=${latest.runId} · ${latest.status}/${latest.execution} · tasks=${latest.total} events=${latest.events} running=${latest.running} · ack ${latest.ack} · ping ${latest.ping} · noExec=${latest.noExecution} · ${widgetUpdatedAt(latest.timestamp)}`;
}

function readLatestReport(repoRoot: string, prefix: string): Record<string, unknown> | undefined {
  const reportsRoot = join(repoRoot, "reports");
  if (!existsSync(reportsRoot)) return undefined;
  let latest: { path: string; timestamp: string; value: Record<string, unknown> } | undefined;
  for (const entry of readdirSync(reportsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) continue;
    const path = join(reportsRoot, entry.name);
    const value = readJsonObjectIfPresent(path);
    if (!value) continue;
    const timestamp = typeof value.generatedAt === "string" ? value.generatedAt : lstatSync(path).mtime.toISOString();
    if (!latest || timestamp.localeCompare(latest.timestamp) >= 0) latest = { path, timestamp, value };
  }
  return latest?.value;
}

function readHarnessReadinessWidgetData(repoRoot: string): HarnessReadinessWidgetData {
  const readonlyValidation = readJsonObjectIfPresent(join(repoRoot, "reports", "orchestrations", "smoke-orchestrate-readonly", "validation.json"));
  const factorySmoke = readJsonObjectIfPresent(join(repoRoot, "reports", "factory-runs", "smoke-factory-run", "validation.json"));
  const factoryPilot = readJsonObjectIfPresent(join(repoRoot, "reports", "factory-runs", "smoke-factory-pilot-run", "validation.json"));
  const autonomy = readLatestReport(repoRoot, "autonomy-readiness");
  const registry = readLatestReport(repoRoot, "factory-registry-readiness");
  const readonlySupervised = isRecord(readonlyValidation?.supervisedReadonly) ? readonlyValidation.supervisedReadonly : undefined;
  const readonlyOk = readonlyValidation?.status === "completed" && readonlyValidation?.noExecution === false && readonlyValidation?.sentinelWritten === false && readonlySupervised?.mocked === false && readonlySupervised?.liveChildExecution === true;
  const legacySmokeOk = factorySmoke?.status === "passed" && factorySmoke?.sentinelWritten === true;
  const legacyPilotOk = factoryPilot?.status === "passed" && factoryPilot?.sentinelWritten === true;
  const missingRegisteredBatchProof = Array.isArray(registry?.factoriesMissingRegisteredBatchProof) ? registry.factoriesMissingRegisteredBatchProof.filter((item): item is string => typeof item === "string") : undefined;
  const registeredReadyFactories = Array.isArray(registry?.registeredAgenticBatchReadyFactories) ? registry.registeredAgenticBatchReadyFactories.filter((item): item is string => typeof item === "string") : undefined;
  const factoryMatrixOk = Array.isArray(missingRegisteredBatchProof) ? missingRegisteredBatchProof.length === 0 && Number(registry?.factoryCount ?? 0) > 0 : legacySmokeOk && legacyPilotOk;
  const smokeOk = Array.isArray(registeredReadyFactories) ? registeredReadyFactories.length > 0 : legacySmokeOk;
  const pilotOk = factoryMatrixOk;
  const globalNoShip = autonomy?.globalAutonomyNoShip === true;
  const autonomyReady = autonomy?.globalAutonomyReady === true && globalNoShip === false;
  const blockers = Array.isArray(autonomy?.globalBlockers) ? autonomy.globalBlockers.filter((item): item is string => typeof item === "string") : [];
  const readiness = globalNoShip ? "needs-attention" : readonlyOk && smokeOk && pilotOk ? "supervised-factory" : "needs-attention";
  return { readiness, smokeOk, pilotOk, readonlyOk, factoryMatrixOk, globalNoShip, autonomyReady, source: autonomy ? "autonomy-readiness" : "legacy-smoke", blockers };
}

export function readHarnessReadinessWidgetSummary(repoRoot: string): string {
  const summary = readHarnessReadinessWidgetData(repoRoot);
  return `ready=${summary.readiness} · factory matrix=${summary.factoryMatrixOk ? "PASS" : "MISS"} registered=${summary.smokeOk ? "SOME" : "NONE"} · orchestration live-readonly=${summary.readonlyOk ? "PASS" : "MISS"} · autonomy=${summary.autonomyReady ? "READY" : summary.globalNoShip ? "NO_SHIP" : "supervised"} · source=${summary.source}`;
}

export { readHarnessReadinessWidgetData, readLatestOrchestrationWidgetData, widgetUpdatedAt };
