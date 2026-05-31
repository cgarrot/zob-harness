import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadTeamDefinition, validateTeamDefinition } from "../topology/teams.js";
import { isRecord } from "../utils/records.js";
import { safeFileStem } from "../utils/paths.js";
import { buildCurrentZobLivePeerCard, buildZobComsProjectId } from "./identity.js";
import { readZobComsV2Policy, zobComsRegistryEnabled } from "./policy.js";
import type { ZobLivePeerCard, ZobLivePeerStatus, ZobLiveRegistrySnapshot } from "./types.js";

const FORBIDDEN_PERSISTED_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "rationale", "text", "diff", "patch"]);

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

function peerPath(repoRoot: string, peer: Pick<ZobLivePeerCard, "roleId" | "sessionHash">): string {
  const { dir } = projectAgentsDir(repoRoot);
  return join(dir, `${safeFileStem(`${peer.roleId}-${peer.sessionHash.slice(0, 12)}`)}.json`);
}

function parsePeerCard(value: unknown): ZobLivePeerCard | undefined {
  if (!isRecord(value) || value.schema !== "zob.live-peer-card.v1") return undefined;
  if (hasForbiddenPersistedKey(value) || value.bodyStored !== false) return undefined;
  if (typeof value.roleId !== "string" || typeof value.team !== "string" || typeof value.sessionHash !== "string") return undefined;
  return value as unknown as ZobLivePeerCard;
}

function derivePeerStatus(peer: ZobLivePeerCard, nowMs: number): ZobLivePeerStatus {
  if (peer.status === "offline") return "offline";
  const heartbeatMs = Date.parse(peer.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return "stale";
  if (nowMs - heartbeatMs >= peer.offlineAfterMs) return "offline";
  if (nowMs - heartbeatMs >= peer.staleAfterMs) return "stale";
  return "online";
}

export function writeZobLivePeerCard(repoRoot: string, peer: ZobLivePeerCard): ZobLivePeerCard {
  if (hasForbiddenPersistedKey(peer)) throw new Error("Refusing to persist ZOB live peer card with forbidden body-like keys");
  if (peer.bodyStored !== false) throw new Error("ZOB live peer card bodyStored must be false");
  const { dir } = projectAgentsDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(peerPath(repoRoot, peer), `${JSON.stringify(peer, null, 2)}\n`, "utf8");
  return peer;
}

export function registerCurrentZobLivePeer(repoRoot: string, teamName = "zob-core"): ZobLivePeerCard | undefined {
  const policy = readZobComsV2Policy(repoRoot);
  if (!zobComsRegistryEnabled(policy)) return undefined;
  const team = loadTeamDefinition(repoRoot, teamName);
  const errors = [...team.errors, ...validateTeamDefinition(repoRoot, team.definition)];
  if (errors.length > 0 || !team.definition) throw new Error(`Cannot register ZOB live peer: ${errors.join("; ")}`);
  return writeZobLivePeerCard(repoRoot, buildCurrentZobLivePeerCard(repoRoot, team.definition, policy));
}

export function touchCurrentZobLivePeer(repoRoot: string, teamName = "zob-core"): ZobLivePeerCard | undefined {
  const peer = registerCurrentZobLivePeer(repoRoot, teamName);
  return peer ? writeZobLivePeerCard(repoRoot, { ...peer, heartbeatAt: new Date().toISOString(), status: "online" }) : undefined;
}

export function unregisterCurrentZobLivePeer(repoRoot: string, teamName = "zob-core"): ZobLivePeerCard | undefined {
  const policy = readZobComsV2Policy(repoRoot);
  const team = loadTeamDefinition(repoRoot, teamName);
  if (!team.definition || !zobComsRegistryEnabled(policy)) return undefined;
  const peer = buildCurrentZobLivePeerCard(repoRoot, team.definition, policy);
  return writeZobLivePeerCard(repoRoot, { ...peer, heartbeatAt: new Date().toISOString(), status: "offline" });
}

export function readZobLiveRegistrySnapshot(repoRoot: string, teamName?: string): ZobLiveRegistrySnapshot {
  const { dir, projectId, kind } = projectAgentsDir(repoRoot);
  const nowMs = Date.now();
  const peers = existsSync(dir)
    ? readdirSync(dir)
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
      .map((peer) => ({ ...peer, status: derivePeerStatus(peer, nowMs) }))
    : [];
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
