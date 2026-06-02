import { sha256 } from "../../../core/utils/hashing.js";
import { readZobLiveRegistrySnapshot } from "./registry.js";
import { readZobComsV2Policy } from "./policy.js";
import type { ZobLivePeerCard, ZobLivePresenceSummary } from "./types.js";
import { activeZpeerRoomId, zpeerMembershipsForPeer } from "./zpeer.js";

export function buildZobLivePresenceSummary(repoRoot: string, teamName?: string): ZobLivePresenceSummary {
  const policy = readZobComsV2Policy(repoRoot);
  const snapshot = readZobLiveRegistrySnapshot(repoRoot, teamName);
  return {
    schema: "zob.live-presence-summary.v1",
    available: policy.mode !== "off",
    mode: policy.mode,
    registry: snapshot.registry,
    team: teamName,
    peerCount: snapshot.peers.length,
    online: snapshot.counts.online,
    stale: snapshot.counts.stale,
    offline: snapshot.counts.offline,
    stalePeerCountsAsCompletion: false,
    dispatchEnabled: policy.dispatchAllowed,
    networkEnabled: policy.networkEnabled,
    bodyStored: false,
  };
}

export function redactZobLivePeerForMissionControl(peer: ZobLivePeerCard): Record<string, unknown> {
  const memberships = zpeerMembershipsForPeer(peer);
  return {
    team: peer.team,
    roleId: peer.roleId,
    roleType: peer.roleType,
    leadId: peer.leadId,
    agent: peer.agent,
    sessionHash: peer.sessionHash,
    transport: peer.transport,
    endpointHash: peer.endpointHash,
    cwdHash: peer.cwdHash,
    startedAt: peer.startedAt,
    heartbeatAt: peer.heartbeatAt,
    contextUsedPct: peer.contextUsedPct,
    queueDepth: peer.queueDepth,
    status: peer.status,
    zpeerRoomIdHash: peer.zpeerRoomId ? sha256(peer.zpeerRoomId) : undefined,
    zpeerAliasHash: peer.zpeerAlias ? sha256(peer.zpeerAlias) : undefined,
    zpeerActiveRoomIdHash: sha256(activeZpeerRoomId(peer)),
    zpeerMembershipCount: memberships.length,
    zpeerMembershipRoomHashes: memberships.map((membership) => sha256(membership.roomId)),
    zpeerMembershipAliasHashes: memberships.map((membership) => sha256(membership.alias)),
    zpeerLocalOnly: peer.zpeerLocalOnly === true ? true : undefined,
    staleAfterMs: peer.staleAfterMs,
    offlineAfterMs: peer.offlineAfterMs,
    bodyStored: false,
  };
}
