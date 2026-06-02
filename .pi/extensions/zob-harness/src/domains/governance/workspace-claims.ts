import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RULES } from "../../core/constants.js";
import type { TeamDefinition } from "../../types.js";
import { sha256 } from "../../core/utils/hashing.js";
import { readJsonl } from "../../core/utils/json.js";
import { pathMatches, resolveRepoPath, safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export type WorkspaceClaimMode = "read" | "write";
export type WorkspaceClaimStatus = "active" | "blocked_conflict";

export interface WorkspaceClaimInput {
  run_id: string;
  claimant: string;
  paths: string[];
  mode?: WorkspaceClaimMode;
  purpose_hash: string;
  todo_id?: string;
  sandbox_run_id?: string;
  lease_ms?: number;
  allow_conflicts?: boolean;
}

export interface WorkspaceReleaseInput {
  claim_id: string;
  released_by: string;
  reason_hash?: string;
}

export interface WorkspaceClaimsListInput {
  run_id?: string;
  claimant?: string;
  include_expired?: boolean;
  include_released?: boolean;
  limit?: number;
}

export interface WorkspaceClaimRecord {
  schema: "zob.workspace-claim.v1";
  claimId: string;
  runId: string;
  claimant: string;
  todoId: string | null;
  sandboxRunId: string | null;
  mode: WorkspaceClaimMode;
  status: WorkspaceClaimStatus;
  paths: string[];
  pathHashes: string[];
  purposeHash: string;
  leaseMs: number;
  claimedAt: string;
  expiresAt: string;
  conflicts: WorkspaceConflictWarning[];
  active: boolean;
  parentOwnedResolutionRequired: boolean;
  productionWritesPerformed: false;
  autoApply: false;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface WorkspaceReleaseRecord {
  schema: "zob.workspace-release.v1";
  releaseId: string;
  claimId: string;
  releasedBy: string;
  reasonHash: string | null;
  releasedAt: string;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface WorkspaceConflictWarning {
  schema: "zob.workspace-conflict-warning.v1";
  claimId: string;
  conflictingClaimIds: string[];
  overlappingPaths: string[];
  conflictHash: string;
  parentOwnedResolutionRequired: true;
  writesBlocked: true;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

function workspaceClaimsDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "workspace-claims");
}

function claimsPath(repoRoot: string): string {
  return join(workspaceClaimsDir(repoRoot), "claims.jsonl");
}

function releasesPath(repoRoot: string): string {
  return join(workspaceClaimsDir(repoRoot), "releases.jsonl");
}

function eventsPath(repoRoot: string): string {
  return join(workspaceClaimsDir(repoRoot), "events.jsonl");
}

function knownRoleIds(definition: TeamDefinition): Set<string> {
  return new Set([definition.orchestrator.id, ...definition.leads.map((lead) => lead.id), ...definition.workers.map((worker) => worker.id), "parent", "mission-control"]);
}

function appendWorkspaceClaimEvent(repoRoot: string, event: Record<string, unknown>): void {
  mkdirSync(workspaceClaimsDir(repoRoot), { recursive: true });
  appendFileSync(eventsPath(repoRoot), `${JSON.stringify({ ...event, timestamp: new Date().toISOString(), bodyStored: false, promptBodiesStored: false, outputBodiesStored: false })}\n`, "utf8");
}

function validateClaimInput(repoRoot: string, definition: TeamDefinition, input: WorkspaceClaimInput): string[] {
  const errors: string[] = [];
  if (!input.run_id || safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (input.todo_id && safeFileStem(input.todo_id) !== input.todo_id) errors.push(`todo_id must be path-safe: ${input.todo_id}`);
  if (input.sandbox_run_id && safeFileStem(input.sandbox_run_id) !== input.sandbox_run_id) errors.push(`sandbox_run_id must be path-safe: ${input.sandbox_run_id}`);
  if (!knownRoleIds(definition).has(input.claimant)) errors.push(`Unknown workspace claim claimant '${input.claimant}'`);
  if (input.mode !== undefined && input.mode !== "read" && input.mode !== "write") errors.push("workspace claim mode must be read|write");
  if (!SHA256_HEX.test(input.purpose_hash)) errors.push("workspace claim purpose_hash must be sha256 hex");
  if (!Array.isArray(input.paths) || input.paths.length === 0) errors.push("workspace claim requires at least one path");
  if (input.paths.length > 50) errors.push("workspace claim paths are capped at 50");
  for (const path of input.paths ?? []) {
    if (typeof path !== "string" || path.trim().length === 0) {
      errors.push("workspace claim contains an empty path");
      continue;
    }
    const resolved = resolveRepoPath(repoRoot, path);
    errors.push(...resolved.errors.map((error) => `workspace claim path: ${error}`));
    for (const protectedPattern of DEFAULT_RULES.zeroAccessPaths) {
      if (pathMatches(path, protectedPattern, repoRoot, repoRoot)) errors.push(`workspace claim path references zero-access path: ${protectedPattern}`);
    }
  }
  if (input.lease_ms !== undefined && (!Number.isFinite(input.lease_ms) || input.lease_ms <= 0 || input.lease_ms > MAX_LEASE_MS)) errors.push("workspace claim lease_ms must be positive and <= 24h");
  return errors;
}

function normalizedPath(repoRoot: string, path: string): string {
  return resolveRepoPath(repoRoot, path).path.replace(/\/+$/g, "");
}

function pathsOverlap(repoRoot: string, left: string, right: string): boolean {
  const a = normalizedPath(repoRoot, left);
  const b = normalizedPath(repoRoot, right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isReleased(claimId: string, releases: WorkspaceReleaseRecord[]): boolean {
  return releases.some((release) => release.claimId === claimId);
}

function isExpired(claim: WorkspaceClaimRecord, nowMs = Date.now()): boolean {
  const expiresAt = Date.parse(claim.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

function readClaims(repoRoot: string): WorkspaceClaimRecord[] {
  return readJsonl(claimsPath(repoRoot)).filter(isWorkspaceClaimRecord).map((record) => record as unknown as WorkspaceClaimRecord);
}

function readReleases(repoRoot: string): WorkspaceReleaseRecord[] {
  return readJsonl(releasesPath(repoRoot)).filter(isWorkspaceReleaseRecord).map((record) => record as unknown as WorkspaceReleaseRecord);
}

function activeClaims(repoRoot: string, nowMs = Date.now()): WorkspaceClaimRecord[] {
  const releases = readReleases(repoRoot);
  return readClaims(repoRoot).filter((claim) => claim.status === "active" && !isExpired(claim, nowMs) && !isReleased(claim.claimId, releases));
}

function conflictWarnings(repoRoot: string, claimId: string, paths: string[], mode: WorkspaceClaimMode): WorkspaceConflictWarning[] {
  if (mode !== "write") return [];
  const conflicts = activeClaims(repoRoot).flatMap((claim) => {
    const overlaps = paths.filter((path) => claim.paths.some((claimedPath) => pathsOverlap(repoRoot, path, claimedPath)));
    if (overlaps.length === 0) return [];
    return [{ claim, overlaps }];
  });
  if (conflicts.length === 0) return [];
  const overlappingPaths = [...new Set(conflicts.flatMap((conflict) => conflict.overlaps))].sort();
  const conflictingClaimIds = conflicts.map((conflict) => conflict.claim.claimId).sort();
  return [{
    schema: "zob.workspace-conflict-warning.v1",
    claimId,
    conflictingClaimIds,
    overlappingPaths,
    conflictHash: sha256(JSON.stringify({ claimId, conflictingClaimIds, overlappingPaths })),
    parentOwnedResolutionRequired: true,
    writesBlocked: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  }];
}

export function createWorkspaceClaim(repoRoot: string, definition: TeamDefinition, input: WorkspaceClaimInput): WorkspaceClaimRecord {
  const errors = validateClaimInput(repoRoot, definition, input);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const now = Date.now();
  const leaseMs = Math.floor(input.lease_ms ?? DEFAULT_LEASE_MS);
  const claimId = `wclaim_${sha256(`${input.run_id}:${input.claimant}:${input.paths.join("|")}:${input.purpose_hash}:${now}`).slice(0, 16)}`;
  const mode = input.mode ?? "write";
  const conflicts = conflictWarnings(repoRoot, claimId, input.paths, mode);
  const blocked = conflicts.length > 0 && input.allow_conflicts !== true;
  const record: WorkspaceClaimRecord = {
    schema: "zob.workspace-claim.v1",
    claimId,
    runId: input.run_id,
    claimant: input.claimant,
    todoId: input.todo_id ?? null,
    sandboxRunId: input.sandbox_run_id ?? null,
    mode,
    status: blocked ? "blocked_conflict" : "active",
    paths: [...new Set(input.paths)].sort(),
    pathHashes: [...new Set(input.paths)].sort().map((path) => sha256(path)),
    purposeHash: input.purpose_hash,
    leaseMs,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
    conflicts,
    active: !blocked,
    parentOwnedResolutionRequired: blocked,
    productionWritesPerformed: false,
    autoApply: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  mkdirSync(workspaceClaimsDir(repoRoot), { recursive: true });
  if (!blocked) appendFileSync(claimsPath(repoRoot), `${JSON.stringify(record)}\n`, "utf8");
  appendWorkspaceClaimEvent(repoRoot, { event: blocked ? "conflict_blocked" : "claim_active", claimId, runId: record.runId, claimant: record.claimant, mode: record.mode, paths: record.paths, conflicts, productionWritesPerformed: false, autoApply: false });
  return record;
}

export function releaseWorkspaceClaim(repoRoot: string, definition: TeamDefinition, input: WorkspaceReleaseInput): WorkspaceReleaseRecord {
  if (!input.claim_id || safeFileStem(input.claim_id) !== input.claim_id) throw new Error(`claim_id must be path-safe: ${input.claim_id}`);
  if (!knownRoleIds(definition).has(input.released_by)) throw new Error(`Unknown workspace release actor '${input.released_by}'`);
  if (input.reason_hash !== undefined && !SHA256_HEX.test(input.reason_hash)) throw new Error("workspace release reason_hash must be sha256 hex");
  const claim = readClaims(repoRoot).find((candidate) => candidate.claimId === input.claim_id);
  if (!claim) throw new Error(`workspace claim not found: ${input.claim_id}`);
  const record: WorkspaceReleaseRecord = {
    schema: "zob.workspace-release.v1",
    releaseId: `wrelease_${sha256(`${input.claim_id}:${input.released_by}:${Date.now()}`).slice(0, 16)}`,
    claimId: input.claim_id,
    releasedBy: input.released_by,
    reasonHash: input.reason_hash ?? null,
    releasedAt: new Date().toISOString(),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  mkdirSync(workspaceClaimsDir(repoRoot), { recursive: true });
  appendFileSync(releasesPath(repoRoot), `${JSON.stringify(record)}\n`, "utf8");
  appendWorkspaceClaimEvent(repoRoot, { event: "claim_released", claimId: record.claimId, releaseId: record.releaseId, releasedBy: record.releasedBy });
  return record;
}

export function listWorkspaceClaims(repoRoot: string, input: WorkspaceClaimsListInput = {}): WorkspaceClaimRecord[] {
  const releases = readReleases(repoRoot);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  return readClaims(repoRoot)
    .filter((claim) => !input.run_id || claim.runId === input.run_id)
    .filter((claim) => !input.claimant || claim.claimant === input.claimant)
    .filter((claim) => input.include_expired === true || !isExpired(claim))
    .filter((claim) => input.include_released === true || !isReleased(claim.claimId, releases))
    .slice(-limit);
}

export function workspaceClaimBodyFreeViolations(value: unknown): string[] {
  const forbidden = new Set(["body", "task", "prompt", "output", "content", "patch", "diff"]);
  const violations: string[] = [];
  const visit = (item: unknown, path: string): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (forbidden.has(key)) violations.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "root");
  return violations;
}

export function isWorkspaceClaimRecord(value: unknown): value is WorkspaceClaimRecord {
  return isRecord(value) && value.schema === "zob.workspace-claim.v1" && typeof value.claimId === "string" && typeof value.runId === "string" && Array.isArray(value.paths) && value.bodyStored === false && value.productionWritesPerformed === false && value.autoApply === false;
}

export function isWorkspaceReleaseRecord(value: unknown): value is WorkspaceReleaseRecord {
  return isRecord(value) && value.schema === "zob.workspace-release.v1" && typeof value.claimId === "string" && value.bodyStored === false;
}
