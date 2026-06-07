import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "../../../core/utils/hashing.js";
import { parseJsonFile } from "../../../core/utils/json.js";
import { resolveRepoPath } from "../../../core/utils/paths.js";
import { isRecord } from "../../../core/utils/records.js";
import type { SandboxWritePlanChange } from "./types.js";

export const HEX_SHA256 = /^[a-f0-9]{64}$/i;
export const FORBIDDEN_PLAINTEXT_KEYS = new Set(["task", "prompt", "output", "body", "content", "patch", "diff"]);

export function containsForbiddenPlaintextKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenPlaintextKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_PLAINTEXT_KEYS.has(key) || containsForbiddenPlaintextKeys(child));
}

export function sandboxLedger(runDir: string, entry: Record<string, unknown>): void {
  appendFileSync(join(runDir, "ledger.jsonl"), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
}

export function readRecord(path: string, errors: string[], label: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    errors.push(`${label} is missing: ${path}`);
    return undefined;
  }
  try {
    const parsed = parseJsonFile(path);
    if (!isRecord(parsed)) {
      errors.push(`${label} is not a JSON object: ${path}`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    errors.push(`${label} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function artifactHash(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return sha256(readFileSync(path, "utf8"));
}

export function expectedManualApplyPreflightConfirmation(runId: string, preflightId: string): string {
  return `CONFIRM SANDBOX MANUAL APPLY PREFLIGHT ${runId} ${preflightId}`;
}

export function normalizeChanges(changes: SandboxWritePlanChange[]): Array<Record<string, unknown>> {
  return changes.map((change) => ({
    path: change.path,
    action: change.action,
    contentHash: change.contentHash,
    ...(change.reason ? { reasonHash: sha256(change.reason) } : {}),
    bodyStored: false,
  }));
}

export function changesFromManifest(manifest: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (!manifest || !Array.isArray(manifest.changes)) return [];
  return manifest.changes.filter(isRecord).map((change) => ({
    path: typeof change.path === "string" ? change.path : "unknown",
    action: change.action === "create" || change.action === "update" ? change.action : "unknown",
    contentHash: typeof change.contentHash === "string" ? change.contentHash : undefined,
    reasonHash: typeof change.reasonHash === "string" ? change.reasonHash : undefined,
    bodyStored: false,
  }));
}

export function sandboxRootFromManifest(repoRoot: string, runId: string, manifest: Record<string, unknown> | undefined, errors: string[]): string | undefined {
  if (!manifest || typeof manifest.sandboxRoot !== "string") {
    errors.push("sandbox manifest requires sandboxRoot");
    return undefined;
  }
  const resolved = resolveRepoPath(repoRoot, manifest.sandboxRoot);
  errors.push(...resolved.errors.map((error) => `sandboxRoot: ${error}`));
  const requiredPrefix = resolve(repoRoot, ".pi", "tmp", "sandbox-runs", runId);
  if (resolved.path !== requiredPrefix && !resolved.path.startsWith(`${requiredPrefix}/`)) errors.push("sandboxRoot must stay inside this run's .pi/tmp/sandbox-runs workspace");
  return resolved.path;
}

export function sameStringSet(left: unknown, right: string[]): boolean {
  if (!Array.isArray(left) || !left.every((item) => typeof item === "string")) return false;
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function isInsidePath(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}/`);
}

export function findIsolatedExecutionValidations(sandboxRoot: string | undefined): Array<Record<string, unknown>> {
  if (!sandboxRoot) return [];
  const root = join(sandboxRoot, "isolated-executions");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map((executionId): Record<string, unknown> | undefined => {
      const validationPath = join(root, executionId, "validation.json");
      const sentinelPath = join(root, executionId, "SANDBOX_ISOLATED_EXECUTION_COMPLETE.sentinel");
      if (!existsSync(validationPath)) return undefined;
      try {
        const parsed = parseJsonFile(validationPath);
        if (!isRecord(parsed)) return undefined;
        return {
          executionId,
          validationPath,
          sentinelPath,
          sentinelPresent: existsSync(sentinelPath),
          status: parsed.status,
          isolatedExecutionPerformed: parsed.isolatedExecutionPerformed,
          productionWritesPerformed: parsed.productionWritesPerformed,
          autoApply: parsed.autoApply,
          markerCount: parsed.markerCount,
          errors: parsed.errors,
          bodyStored: false,
        };
      } catch {
        return undefined;
      }
    })
    .filter((record): record is Record<string, unknown> => Boolean(record));
}
