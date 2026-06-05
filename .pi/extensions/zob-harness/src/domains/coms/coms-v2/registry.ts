import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { loadTeamDefinition, validateTeamDefinition } from "../../topology/teams.js";
import { isRecord } from "../../../core/utils/records.js";
import { safeFileStem } from "../../../core/utils/paths.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { buildCurrentZobLivePeerCard, buildZobComsProjectId } from "./identity.js";
import { pingZobLocalEndpoint } from "./local-transport.js";
import { readZobComsV2Policy, zobComsRegistryEnabled } from "./policy.js";
import type { ZobLivePeerCard, ZobLivePeerStatus, ZobLiveRegistrySnapshot, ZobLiveTeamAgentLease } from "./types.js";

const FORBIDDEN_PERSISTED_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "rationale", "text", "diff", "patch"]);
const DEFAULT_OFFLINE_PEER_RETENTION_MS = 24 * 60 * 60 * 1000;
const MIN_OFFLINE_PEER_RETENTION_MS = 5 * 60 * 1000;
const MIN_LEASE_TTL_MS = 30_000;

function registryRoot(): { path: string; kind: "user_runtime" | "env_override" } {
  const override = process.env.ZOB_COMS_REGISTRY_ROOT;
  if (override && override.trim().length > 0) return { path: override, kind: "env_override" };
  return { path: join(homedir(), ".pi", "zob-coms"), kind: "user_runtime" };
}

function hasForbiddenPersistedKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenPersistedKey);
  return Object.entries(value).some(([key, child]) => FORBIDDEN_PERSISTED_KEYS.has(key) || hasForbiddenPersistedKey(child));
}

function projectAgentsDir(repoRoot: string): { dir: string; projectId: string; kind: "user_runtime" | "env_override" } {
  const root = registryRoot();
  const projectId = buildZobComsProjectId(repoRoot);
  return { dir: join(root.path, "projects", projectId, "agents"), projectId, kind: root.kind };
}

function projectLeasesDir(repoRoot: string): { dir: string; projectId: string; kind: "user_runtime" | "env_override" } {
  const root = registryRoot();
  const projectId = buildZobComsProjectId(repoRoot);
  return { dir: join(root.path, "projects", projectId, "leases"), projectId, kind: root.kind };
}

function peerPath(repoRoot: string, peer: Pick<ZobLivePeerCard, "roleId" | "sessionHash">): string {
  const { dir } = projectAgentsDir(repoRoot);
  return join(dir, `${safeFileStem(`${peer.roleId}-${peer.sessionHash.slice(0, 12)}`)}.json`);
}

function peerPathForProjectId(projectId: string, peer: Pick<ZobLivePeerCard, "roleId" | "sessionHash">): string {
  return join(registryRoot().path, "projects", safeFileStem(projectId), "agents", `${safeFileStem(`${peer.roleId}-${peer.sessionHash.slice(0, 12)}`)}.json`);
}

function stableLeaseStem(input: Pick<ZobLivePeerCard, "team" | "roleId"> | Pick<ZobLiveTeamAgentLease, "teamId" | "agentId">): string {
  const teamId = "team" in input ? input.team : input.teamId;
  const agentId = "roleId" in input ? input.roleId : input.agentId;
  return safeFileStem(`${teamId}-${agentId}`);
}

function leasePath(repoRoot: string, peer: Pick<ZobLivePeerCard, "team" | "roleId">): string {
  const { dir } = projectLeasesDir(repoRoot);
  return join(dir, `${stableLeaseStem(peer)}.json`);
}

function leasePathForTeamAgent(repoRoot: string, teamId: string, agentId: string): string {
  const { dir } = projectLeasesDir(repoRoot);
  return join(dir, `${safeFileStem(`${teamId}-${agentId}`)}.json`);
}

function readPeerCardsFromAgentsDir(dir: string, nowMs: number, teamName?: string): ZobLivePeerCard[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      try {
        return parsePeerCard(JSON.parse(readFileSync(join(dir, entry), "utf8")) as unknown);
      } catch {
        return undefined;
      }
    })
    .filter((peer): peer is ZobLivePeerCard => Boolean(peer))
    .filter((peer) => !teamName || peer.team === teamName)
    .map((peer) => ({ ...peer, status: derivePeerStatus(peer, nowMs) }));
}

function readLeasesFromDir(dir: string, nowMs: number, teamName?: string): ZobLivePeerCard[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      try {
        return parseTeamAgentLease(JSON.parse(readFileSync(join(dir, entry), "utf8")) as unknown);
      } catch {
        return undefined;
      }
    })
    .filter((lease): lease is ZobLiveTeamAgentLease => Boolean(lease))
    .filter((lease) => !teamName || lease.teamId === teamName)
    .map((lease) => leaseToPeerCard(lease, nowMs));
}

function boundedOfflinePeerRetentionMs(value: number | undefined): number {
  const env = Number.parseInt(process.env.ZOB_COMS_OFFLINE_PEER_RETENTION_MS ?? "", 10);
  const raw = typeof value === "number" && Number.isFinite(value) ? value : Number.isFinite(env) ? env : DEFAULT_OFFLINE_PEER_RETENTION_MS;
  return Math.max(MIN_OFFLINE_PEER_RETENTION_MS, Math.floor(raw));
}

function offlinePeerExpired(peer: ZobLivePeerCard, nowMs: number, retentionMs: number): boolean {
  if (derivePeerStatus(peer, nowMs) !== "offline") return false;
  const heartbeatMs = Date.parse(peer.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return true;
  return nowMs - heartbeatMs >= Math.max(peer.offlineAfterMs, retentionMs);
}

function leaseExpired(lease: ZobLiveTeamAgentLease, nowMs: number, retentionMs = 0): boolean {
  const expiresMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  return nowMs >= expiresMs + Math.max(0, retentionMs);
}

function allProjectAgentsDirs(): string[] {
  const root = registryRoot();
  const projectsDir = join(root.path, "projects");
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsDir, entry.name, "agents"));
}

function allProjectLeasesDirs(): string[] {
  const root = registryRoot();
  const projectsDir = join(root.path, "projects");
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsDir, entry.name, "leases"));
}

function buildSnapshot(projectId: string, kind: "user_runtime" | "env_override", peers: ZobLivePeerCard[], teamName?: string): ZobLiveRegistrySnapshot {
  const counts: Record<ZobLivePeerStatus, number> = { online: 0, stale: 0, offline: 0 };
  for (const peer of peers) counts[peer.status] += 1;
  return {
    schema: "zob.live-registry-snapshot.v1",
    projectId,
    registry: kind,
    team: teamName,
    generatedAt: new Date().toISOString(),
    peers,
    counts,
    bodyStored: false,
  };
}

function parsePeerCard(value: unknown): ZobLivePeerCard | undefined {
  if (!isRecord(value) || value.schema !== "zob.live-peer-card.v1") return undefined;
  if (hasForbiddenPersistedKey(value) || value.bodyStored !== false) return undefined;
  if (typeof value.roleId !== "string" || typeof value.team !== "string" || typeof value.sessionHash !== "string") return undefined;
  return value as unknown as ZobLivePeerCard;
}

function parseTeamAgentLease(value: unknown): ZobLiveTeamAgentLease | undefined {
  if (!isRecord(value) || value.schema !== "zob.live-team-agent-lease.v1") return undefined;
  if (hasForbiddenPersistedKey(value) || value.bodyStored !== false || value.localOnly !== true || value.networkEnabled !== false) return undefined;
  if (value.stableLease !== true || value.exclusiveBy !== "teamId+agentId") return undefined;
  if (typeof value.teamId !== "string" || typeof value.agentId !== "string" || typeof value.sessionHash !== "string") return undefined;
  if (typeof value.leaseOwnerId !== "string" || typeof value.endpoint !== "string" || typeof value.endpointHash !== "string") return undefined;
  return value as unknown as ZobLiveTeamAgentLease;
}

function derivePeerStatus(peer: ZobLivePeerCard, nowMs: number): ZobLivePeerStatus {
  if (peer.status === "offline") return "offline";
  const heartbeatMs = Date.parse(peer.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return "stale";
  if (nowMs - heartbeatMs >= peer.offlineAfterMs) return "offline";
  if (nowMs - heartbeatMs >= peer.staleAfterMs) return "stale";
  return "online";
}

function deriveLeaseStatus(lease: ZobLiveTeamAgentLease, nowMs: number): ZobLivePeerStatus {
  if (lease.status === "offline" || leaseExpired(lease, nowMs)) return "offline";
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return "stale";
  if (nowMs - heartbeatMs >= lease.offlineAfterMs) return "offline";
  if (nowMs - heartbeatMs >= lease.staleAfterMs) return "stale";
  return "online";
}

function leaseOwnerId(peer: Pick<ZobLivePeerCard, "team" | "roleId" | "sessionHash" | "endpointHash">): string {
  return `${peer.team}:${peer.roleId}:${peer.sessionHash}:${peer.endpointHash}`;
}

function sameLeaseOwner(lease: ZobLiveTeamAgentLease, peer: Pick<ZobLivePeerCard, "team" | "roleId" | "sessionHash" | "endpointHash">): boolean {
  return lease.teamId === peer.team
    && lease.agentId === peer.roleId
    && lease.sessionHash === peer.sessionHash
    && lease.endpointHash === peer.endpointHash
    && lease.leaseOwnerId === leaseOwnerId(peer);
}

function leaseExpiresAt(peer: Pick<ZobLivePeerCard, "offlineAfterMs" | "staleAfterMs">, nowMs: number): string {
  const ttlMs = Math.max(MIN_LEASE_TTL_MS, Math.floor(Math.max(peer.offlineAfterMs, peer.staleAfterMs * 2)));
  return new Date(nowMs + ttlMs).toISOString();
}

function buildTeamAgentLease(repoRoot: string, peer: ZobLivePeerCard, input: { nowMs?: number } = {}): ZobLiveTeamAgentLease {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const projectId = buildZobComsProjectId(repoRoot);
  const ownerId = leaseOwnerId(peer);
  return {
    schema: "zob.live-team-agent-lease.v1",
    projectId,
    teamId: peer.team,
    agentId: peer.roleId,
    roleId: peer.roleId,
    roleType: peer.roleType,
    leadId: peer.leadId,
    agent: peer.agent,
    sessionId: peer.sessionId,
    sessionHash: peer.sessionHash,
    leaseOwnerId: ownerId,
    leaseOwnerHash: sha256(ownerId),
    transport: peer.transport,
    endpoint: peer.endpoint,
    endpointHash: peer.endpointHash,
    cwdHash: peer.cwdHash,
    pid: peer.pid,
    startedAt: peer.startedAt,
    heartbeatAt: now,
    leasedAt: now,
    renewedAt: now,
    expiresAt: leaseExpiresAt(peer, nowMs),
    contextUsedPct: peer.contextUsedPct,
    queueDepth: peer.queueDepth,
    status: peer.status === "offline" ? "offline" : "online",
    zpeerRoomId: peer.zpeerRoomId,
    zpeerAlias: peer.zpeerAlias,
    zpeerActiveRoomId: peer.zpeerActiveRoomId,
    zpeerMemberships: peer.zpeerMemberships,
    zpeerLocalOnly: peer.zpeerLocalOnly,
    staleAfterMs: peer.staleAfterMs,
    offlineAfterMs: peer.offlineAfterMs,
    stableLease: true,
    exclusiveBy: "teamId+agentId",
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
  };
}

function renewTeamAgentLease(repoRoot: string, existing: ZobLiveTeamAgentLease | undefined, peer: ZobLivePeerCard, input: { nowMs?: number } = {}): ZobLiveTeamAgentLease {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const next = buildTeamAgentLease(repoRoot, peer, { nowMs });
  return existing && sameLeaseOwner(existing, peer)
    ? { ...next, leasedAt: existing.leasedAt, renewedAt: now }
    : next;
}

function leaseToPeerCard(lease: ZobLiveTeamAgentLease, nowMs: number): ZobLivePeerCard {
  return {
    schema: "zob.live-peer-card.v1",
    projectId: lease.projectId,
    team: lease.teamId,
    roleId: lease.roleId,
    roleType: lease.roleType,
    leadId: lease.leadId,
    agent: lease.agent,
    sessionId: lease.sessionId,
    sessionHash: lease.sessionHash,
    transport: lease.transport,
    endpoint: lease.endpoint,
    endpointHash: lease.endpointHash,
    cwdHash: lease.cwdHash,
    pid: lease.pid,
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
    contextUsedPct: lease.contextUsedPct,
    queueDepth: lease.queueDepth,
    status: deriveLeaseStatus(lease, nowMs),
    zpeerRoomId: lease.zpeerRoomId,
    zpeerAlias: lease.zpeerAlias,
    zpeerActiveRoomId: lease.zpeerActiveRoomId,
    zpeerMemberships: lease.zpeerMemberships,
    zpeerLocalOnly: lease.zpeerLocalOnly,
    staleAfterMs: lease.staleAfterMs,
    offlineAfterMs: lease.offlineAfterMs,
    bodyStored: false,
  };
}

function readLeaseAtPath(filePath: string): ZobLiveTeamAgentLease | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return parseTeamAgentLease(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function writeLeaseAtPath(filePath: string, lease: ZobLiveTeamAgentLease): ZobLiveTeamAgentLease {
  if (hasForbiddenPersistedKey(lease)) throw new Error("Refusing to persist ZOB live team-agent lease with forbidden body-like keys");
  if (lease.bodyStored !== false || lease.localOnly !== true || lease.networkEnabled !== false) throw new Error("ZOB live team-agent lease must be localOnly=true networkEnabled=false bodyStored=false");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  return lease;
}

function leaseHasLocalSocketEndpoint(lease: ZobLiveTeamAgentLease): boolean {
  return lease.transport === "local_socket"
    && Boolean(lease.endpoint)
    && !lease.endpoint.startsWith("pending-")
    && lease.endpoint !== "observe-only"
    && existsSync(lease.endpoint);
}

async function leaseRespondsToPing(lease: ZobLiveTeamAgentLease): Promise<boolean> {
  if (!leaseHasLocalSocketEndpoint(lease)) return false;
  try {
    const response = await pingZobLocalEndpoint(lease.endpoint, `zteam-agent-lease-ping:${lease.teamId}:${lease.agentId}:${Date.now()}`);
    return response.type === "pong" || response.type === "ack";
  } catch {
    return false;
  }
}

export function pruneExpiredZobLivePeers(repoRoot: string, input: { teamName?: string; nowMs?: number; retentionMs?: number } = {}): { schema: "zob.live-registry-prune.v1"; pruned: number; retained: number; retentionMs: number; bodyStored: false } {
  const { dir } = projectAgentsDir(repoRoot);
  const nowMs = input.nowMs ?? Date.now();
  const retentionMs = boundedOfflinePeerRetentionMs(input.retentionMs);
  let pruned = 0;
  let retained = 0;
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const filePath = join(dir, entry);
      try {
        const peer = parsePeerCard(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
        if (!peer || (input.teamName && peer.team !== input.teamName)) {
          retained += 1;
          continue;
        }
        if (offlinePeerExpired(peer, nowMs, retentionMs)) {
          unlinkSync(filePath);
          pruned += 1;
        } else {
          retained += 1;
        }
      } catch {
        retained += 1;
      }
    }
  }
  const leasePrune = pruneExpiredZobLiveTeamAgentLeases(repoRoot, input);
  return { schema: "zob.live-registry-prune.v1", pruned: pruned + leasePrune.pruned, retained: retained + leasePrune.retained, retentionMs, bodyStored: false };
}

export function pruneExpiredZobLiveTeamAgentLeases(repoRoot: string, input: { teamName?: string; nowMs?: number; retentionMs?: number } = {}): { schema: "zob.live-team-agent-lease-prune.v1"; pruned: number; retained: number; retentionMs: number; bodyStored: false } {
  const { dir } = projectLeasesDir(repoRoot);
  const nowMs = input.nowMs ?? Date.now();
  const retentionMs = boundedOfflinePeerRetentionMs(input.retentionMs);
  let pruned = 0;
  let retained = 0;
  if (!existsSync(dir)) return { schema: "zob.live-team-agent-lease-prune.v1", pruned, retained, retentionMs, bodyStored: false };
  for (const entry of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const filePath = join(dir, entry);
    const lease = readLeaseAtPath(filePath);
    if (!lease || (input.teamName && lease.teamId !== input.teamName)) {
      retained += 1;
      continue;
    }
    if (leaseExpired(lease, nowMs, retentionMs)) {
      unlinkSync(filePath);
      pruned += 1;
    } else {
      retained += 1;
    }
  }
  return { schema: "zob.live-team-agent-lease-prune.v1", pruned, retained, retentionMs, bodyStored: false };
}

export function writeZobLivePeerCard(repoRoot: string, peer: ZobLivePeerCard): ZobLivePeerCard {
  if (hasForbiddenPersistedKey(peer)) throw new Error("Refusing to persist ZOB live peer card with forbidden body-like keys");
  if (peer.bodyStored !== false) throw new Error("ZOB live peer card bodyStored must be false");
  const { dir } = projectAgentsDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(peerPath(repoRoot, peer), `${JSON.stringify({ ...peer, projectId: buildZobComsProjectId(repoRoot) }, null, 2)}\n`, "utf8");
  return peer;
}

export function writeZobLivePeerCardToProjectId(peer: ZobLivePeerCard): ZobLivePeerCard {
  if (hasForbiddenPersistedKey(peer)) throw new Error("Refusing to persist ZOB live peer card with forbidden body-like keys");
  if (peer.bodyStored !== false) throw new Error("ZOB live peer card bodyStored must be false");
  const filePath = peerPathForProjectId(peer.projectId, peer);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(peer, null, 2)}\n`, "utf8");
  return peer;
}

export function writeZobLiveTeamAgentLease(repoRoot: string, peer: ZobLivePeerCard, input: { reason?: string; nowMs?: number } = {}): ZobLiveTeamAgentLease {
  const filePath = leasePath(repoRoot, peer);
  const existing = readLeaseAtPath(filePath);
  const nowMs = input.nowMs ?? Date.now();
  if (existing && !sameLeaseOwner(existing, peer) && !leaseExpired(existing, nowMs)) return existing;
  const ownedExisting = existing && sameLeaseOwner(existing, peer) ? existing : undefined;
  return writeLeaseAtPath(filePath, renewTeamAgentLease(repoRoot, ownedExisting, peer, { nowMs }));
}

export async function claimZobLiveTeamAgentLease(repoRoot: string, peer: ZobLivePeerCard, input: { reason?: string; nowMs?: number } = {}): Promise<
  | { ok: true; status: "acquired" | "renewed" | "reclaimed"; lease: ZobLiveTeamAgentLease; previousOwnerHash?: string; pingChecked: boolean; bodyStored: false }
  | { ok: false; status: "blocked_live_owner"; lease: ZobLiveTeamAgentLease; ownerHash: string; reason: string; pingChecked: true; bodyStored: false }
> {
  const filePath = leasePath(repoRoot, peer);
  const existing = readLeaseAtPath(filePath);
  const nowMs = input.nowMs ?? Date.now();
  if (!existing) {
    const lease = writeLeaseAtPath(filePath, buildTeamAgentLease(repoRoot, peer, { nowMs }));
    return { ok: true, status: "acquired", lease, pingChecked: false, bodyStored: false };
  }
  if (sameLeaseOwner(existing, peer)) {
    const lease = writeLeaseAtPath(filePath, renewTeamAgentLease(repoRoot, existing, peer, { nowMs }));
    return { ok: true, status: "renewed", lease, pingChecked: false, bodyStored: false };
  }
  const responsive = await leaseRespondsToPing(existing);
  if (responsive) {
    return {
      ok: false,
      status: "blocked_live_owner",
      lease: existing,
      ownerHash: existing.leaseOwnerHash,
      reason: `stable team-agent lease for ${existing.teamId}/${existing.agentId} is held by a responsive live endpoint`,
      pingChecked: true,
      bodyStored: false,
    };
  }
  const lease = writeLeaseAtPath(filePath, buildTeamAgentLease(repoRoot, peer, { nowMs }));
  return { ok: true, status: "reclaimed", lease, previousOwnerHash: existing.leaseOwnerHash, pingChecked: true, bodyStored: false };
}

export function releaseZobLiveTeamAgentLease(repoRoot: string, peer: ZobLivePeerCard, input: { reason?: string } = {}): { schema: "zob.live-team-agent-lease-release.v1"; released: boolean; reason: "released" | "not_found" | "owner_mismatch"; teamId: string; agentId: string; leaseOwnerHash?: string; bodyStored: false } {
  void input;
  const filePath = leasePath(repoRoot, peer);
  const existing = readLeaseAtPath(filePath);
  if (!existing) return { schema: "zob.live-team-agent-lease-release.v1", released: false, reason: "not_found", teamId: peer.team, agentId: peer.roleId, bodyStored: false };
  if (!sameLeaseOwner(existing, peer)) return { schema: "zob.live-team-agent-lease-release.v1", released: false, reason: "owner_mismatch", teamId: peer.team, agentId: peer.roleId, leaseOwnerHash: existing.leaseOwnerHash, bodyStored: false };
  unlinkSync(filePath);
  return { schema: "zob.live-team-agent-lease-release.v1", released: true, reason: "released", teamId: peer.team, agentId: peer.roleId, leaseOwnerHash: existing.leaseOwnerHash, bodyStored: false };
}

export function ownsZobLiveTeamAgentLease(repoRoot: string, peer: ZobLivePeerCard): { schema: "zob.live-team-agent-lease-ownership.v1"; owned: boolean; reason: "owned" | "not_found" | "owner_mismatch" | "expired"; teamId: string; agentId: string; leaseOwnerHash?: string; bodyStored: false } {
  const filePath = leasePath(repoRoot, peer);
  const existing = readLeaseAtPath(filePath);
  if (!existing) return { schema: "zob.live-team-agent-lease-ownership.v1", owned: false, reason: "not_found", teamId: peer.team, agentId: peer.roleId, bodyStored: false };
  if (leaseExpired(existing, Date.now())) return { schema: "zob.live-team-agent-lease-ownership.v1", owned: false, reason: "expired", teamId: peer.team, agentId: peer.roleId, leaseOwnerHash: existing.leaseOwnerHash, bodyStored: false };
  if (!sameLeaseOwner(existing, peer)) return { schema: "zob.live-team-agent-lease-ownership.v1", owned: false, reason: "owner_mismatch", teamId: peer.team, agentId: peer.roleId, leaseOwnerHash: existing.leaseOwnerHash, bodyStored: false };
  return { schema: "zob.live-team-agent-lease-ownership.v1", owned: true, reason: "owned", teamId: peer.team, agentId: peer.roleId, leaseOwnerHash: existing.leaseOwnerHash, bodyStored: false };
}

export async function retireInactiveZobLiveTeamAgentLeases(repoRoot: string, input: { teamName: string; agentIds: string[]; nowMs?: number }): Promise<{ schema: "zob.live-team-agent-lease-retire.v1"; teamName: string; checked: number; retired: number; retainedLive: number; missing: number; errorHashes: string[]; bodyStored: false }> {
  const errors: string[] = [];
  let checked = 0;
  let retired = 0;
  let retainedLive = 0;
  let missing = 0;
  const uniqueAgentIds = [...new Set(input.agentIds.filter((agentId) => agentId.trim().length > 0))];
  for (const agentId of uniqueAgentIds) {
    const filePath = leasePathForTeamAgent(repoRoot, input.teamName, agentId);
    const lease = readLeaseAtPath(filePath);
    if (!lease) {
      missing += 1;
      continue;
    }
    checked += 1;
    try {
      const live = await leaseRespondsToPing(lease);
      if (live) {
        retainedLive += 1;
      } else {
        unlinkSync(filePath);
        retired += 1;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { schema: "zob.live-team-agent-lease-retire.v1", teamName: input.teamName, checked, retired, retainedLive, missing, errorHashes: errors.map((error) => sha256(error)), bodyStored: false };
}

export function registerCurrentZobLivePeer(repoRoot: string, teamName = "zob-core"): ZobLivePeerCard | undefined {
  const policy = readZobComsV2Policy(repoRoot);
  if (!zobComsRegistryEnabled(policy)) return undefined;
  const team = loadTeamDefinition(repoRoot, teamName);
  const errors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  if (errors.length > 0 || !team.definition) throw new Error(`Cannot register ZOB live peer: ${errors.join("; ")}`);
  const peer = writeZobLivePeerCard(repoRoot, buildCurrentZobLivePeerCard(repoRoot, team.definition, policy));
  writeZobLiveTeamAgentLease(repoRoot, peer, { reason: "register_current" });
  return peer;
}

export function touchCurrentZobLivePeer(repoRoot: string, teamName = "zob-core"): ZobLivePeerCard | undefined {
  const peer = registerCurrentZobLivePeer(repoRoot, teamName);
  if (!peer) return undefined;
  const touched = writeZobLivePeerCard(repoRoot, { ...peer, heartbeatAt: new Date().toISOString(), status: "online" });
  writeZobLiveTeamAgentLease(repoRoot, touched, { reason: "touch_current" });
  return touched;
}

export function unregisterCurrentZobLivePeer(repoRoot: string, teamName = "zob-core"): ZobLivePeerCard | undefined {
  const policy = readZobComsV2Policy(repoRoot);
  const team = loadTeamDefinition(repoRoot, teamName);
  if (!team.definition || !zobComsRegistryEnabled(policy)) return undefined;
  const peer = buildCurrentZobLivePeerCard(repoRoot, team.definition, policy);
  releaseZobLiveTeamAgentLease(repoRoot, peer, { reason: "unregister_current" });
  return writeZobLivePeerCard(repoRoot, { ...peer, heartbeatAt: new Date().toISOString(), status: "offline" });
}

export function readZobLiveRegistrySnapshot(repoRoot: string, teamName?: string): ZobLiveRegistrySnapshot {
  const { dir, projectId, kind } = projectLeasesDir(repoRoot);
  const nowMs = Date.now();
  if (existsSync(dir)) return buildSnapshot(projectId, kind, readLeasesFromDir(dir, nowMs, teamName), teamName);
  const agents = projectAgentsDir(repoRoot);
  return buildSnapshot(agents.projectId, agents.kind, readPeerCardsFromAgentsDir(agents.dir, nowMs, teamName), teamName);
}

export function readZobLiveRegistryAllProjectsSnapshot(repoRoot: string, teamName?: string): ZobLiveRegistrySnapshot {
  const { projectId, kind } = projectAgentsDir(repoRoot);
  const nowMs = Date.now();
  const leaseDirs = allProjectLeasesDirs();
  const hasLeaseDomain = leaseDirs.some((dir) => existsSync(dir));
  const peers = hasLeaseDomain
    ? leaseDirs.flatMap((dir) => readLeasesFromDir(dir, nowMs, teamName))
    : allProjectAgentsDirs().flatMap((dir) => readPeerCardsFromAgentsDir(dir, nowMs, teamName));
  return buildSnapshot(projectId, kind, peers, teamName);
}
