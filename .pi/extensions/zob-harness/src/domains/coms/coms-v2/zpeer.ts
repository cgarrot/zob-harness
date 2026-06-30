import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { buildZobComsProjectId } from "./identity.js";
import { buildZobLiveEnvelope, type ZpeerInterruptMode, type ZpeerInterruptPriority, type ZpeerInterruptStatus } from "./envelope.js";
import { sendZobLocalEnvelope } from "./local-transport.js";
import { hasLocalSocketEndpointEvidence, ownsZobLiveTeamAgentLease, readZobLiveRegistryAllProjectsSnapshot, writeZobLivePeerCard, writeZobLivePeerCardToProjectId, writeZobLiveTeamAgentLease } from "./registry.js";
import type { ZobLivePeerCard, ZobLivePeerStatus, ZpeerRoomMembership, ZpeerRoomMembershipRole } from "./types.js";
import { validateZobComsEdge } from "../../topology/coms.js";
import { loadTeamDefinition, validateTeamDefinition } from "../../topology/teams.js";
import { loadZteamManifest, zteamAllowsZpeerContact } from "../zagents.js";
import { sha256 } from "../../../core/utils/hashing.js";
import { annotateZpeerStatus } from "./zpeer-status.js";

const DEFAULT_ROOM_ID = "default";
const ALIAS_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/;
const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const MEMBERSHIP_ROLES = new Set<ZpeerRoomMembershipRole>(["member", "bridge", "observer"]);
const ZPEER_FORCE_ALLOWED_SENDER_ROLE_TYPES = new Set(["orchestrator", "lead"]);
const ZPEER_FORCE_ALLOWED_RECEIVER_ROLE_TYPES = new Set(["orchestrator", "lead", "worker"]);

export interface ZpeerRoomSummary {
  schema: "zob.zpeer-room-summary.v1";
  projectId: string;
  roomId: string;
  selfAlias?: string;
  peerCount: number;
  online: number;
  stale: number;
  offline: number;
  aliases: string[];
  onlineAliases: string[];
  staleAliases: string[];
  offlineAliases: string[];
  duplicateAliases: string[];
  membershipCount?: number;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
}

export interface ZpeerPeerRoomSummary extends ZpeerRoomSummary {
  active: boolean;
}

export type ZpeerSendMode = "await" | "async" | "long";
export type ZpeerSendStatus = "delivered" | "waiting" | "reply" | "completed" | "blocked" | "error" | "timeout" | "expired" | "required_response_expired";

export interface ZpeerSendResult {
  status: ZpeerSendStatus;
  reason?: string;
  msgId?: string;
  roomId?: string;
  targetAlias?: string;
  taskHash?: string;
  outputHash?: string;
  transientResponse?: string;
  priority?: ZpeerInterruptPriority;
  interruptMode?: ZpeerInterruptMode;
  interruptStatus?: ZpeerInterruptStatus;
  interruptReasonHash?: string;
  requireResponse?: boolean;
  responseRequiredBy?: string;
  responseTimeoutMs?: number;
  maxReinjects?: number;
  responseReceived?: boolean;
  deliveryStatus?: "delivered" | "blocked" | "stale" | "offline" | "transport_error";
  deliveryMethod?: "local_socket" | "tmux_sendkeys";
  fallback_delivery?: boolean;
  best_effort?: boolean;
  terminal?: boolean;
  statusRank?: number;
  bodyStored: false;
}

export interface ZpeerSendFeedback {
  kind: "delivered" | "waiting" | "reply" | "expired" | "timeout" | "blocked" | "error";
  result: ZpeerSendResult;
}

export type ZpeerFallbackDelivery = (input: {
  targetAlias: string;
  senderAlias: string;
  roomId: string;
  taskHash?: string;
  prompt: string;
  priority: ZpeerInterruptPriority;
  interruptMode: ZpeerInterruptMode;
  requireResponse: boolean;
  responseTimeoutMs?: number;
  maxReinjects?: number;
}) => Promise<{ delivered: boolean; target?: string; reason?: string }>;

export interface ZpeerSendOptions {
  mode?: ZpeerSendMode;
  roomId?: string;
  priority?: ZpeerInterruptPriority;
  interruptMode?: ZpeerInterruptMode;
  interruptReasonHash?: string;
  requireResponse?: boolean;
  responseTimeoutMs?: number;
  maxReinjects?: number;
  onFeedback?: (feedback: ZpeerSendFeedback) => void;
  // WS-ZH4: optional best-effort fallback delivery seam. When local-socket delivery is
  // blocked (0 live candidates), the app may inject a fallback (e.g. tmux send-keys to
  // the target agent's pane). This keeps coms-v2 IO-free; the app supplies the tmux
  // delivery. A fallback delivery is NOT verified delivery: outputHash stays absent,
  // confirmation_ref stays null, and bodyStored stays false (coms-safety: append-only /
  // best-effort is not delivery success). Force/abort is never eligible for fallback.
  fallbackDelivery?: ZpeerFallbackDelivery;
}

interface ZpeerRoomPeer {
  peer: ZobLivePeerCard;
  membership: ZpeerRoomMembership;
}

export function generatedZpeerAlias(peer: Pick<ZobLivePeerCard, "roleId" | "sessionHash">): string {
  return safeZpeerAlias(`${peer.roleId}-${peer.sessionHash.slice(0, 6)}`) ?? `peer-${peer.sessionHash.slice(0, 8)}`;
}

export function safeZpeerAlias(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^@+/, "");
  if (!trimmed || !ALIAS_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

export function zpeerAliasLookupKey(value: string | undefined): string | undefined {
  const alias = safeZpeerAlias(value);
  return alias ? alias.replaceAll("-", "_") : undefined;
}

export function zpeerAliasesEquivalent(left: string | undefined, right: string | undefined): boolean {
  const leftKey = zpeerAliasLookupKey(left);
  const rightKey = zpeerAliasLookupKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

export function zpeerAliasIncluded(aliases: readonly string[] | undefined, alias: string | undefined): boolean {
  const key = zpeerAliasLookupKey(alias);
  return Boolean(key && aliases?.some((candidate) => zpeerAliasLookupKey(candidate) === key));
}

export function duplicateZpeerAliasLookupKeys(aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const alias of aliases) {
    const key = zpeerAliasLookupKey(alias);
    if (!key) continue;
    if (seen.has(key)) duplicates.add(alias);
    else seen.add(key);
  }
  return aliases.filter((alias) => {
    const key = zpeerAliasLookupKey(alias);
    return Boolean(key && duplicates.has(alias)) || Boolean(key && aliases.filter((candidate) => zpeerAliasLookupKey(candidate) === key).length > 1);
  }).filter((alias, index, all) => all.indexOf(alias) === index).sort();
}

export function safeZpeerRoomId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !ROOM_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function safeMembershipRole(value: string | undefined): ZpeerRoomMembershipRole {
  return value && MEMBERSHIP_ROLES.has(value as ZpeerRoomMembershipRole) ? value as ZpeerRoomMembershipRole : "member";
}

function buildMembership(input: { roomId: string; alias: string; role?: string; joinedAt?: string }): ZpeerRoomMembership {
  return {
    roomId: input.roomId,
    alias: input.alias,
    role: safeMembershipRole(input.role),
    joinedAt: input.joinedAt && Number.isFinite(Date.parse(input.joinedAt)) ? input.joinedAt : new Date().toISOString(),
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
  };
}

function normalizeZpeerMemberships(memberships: readonly ZpeerRoomMembership[] | undefined): ZpeerRoomMembership[] {
  const byRoom = new Map<string, ZpeerRoomMembership>();
  for (const raw of memberships ?? []) {
    const roomId = safeZpeerRoomId(raw.roomId);
    const alias = safeZpeerAlias(raw.alias);
    if (!roomId || !alias) continue;
    byRoom.set(roomId, buildMembership({ roomId, alias, role: raw.role, joinedAt: raw.joinedAt }));
  }
  return [...byRoom.values()].sort((left, right) => left.roomId.localeCompare(right.roomId));
}

export function zpeerMembershipsForPeer(peer: ZobLivePeerCard): ZpeerRoomMembership[] {
  const memberships = normalizeZpeerMemberships(peer.zpeerMemberships);
  const byRoom = new Map(memberships.map((membership) => [membership.roomId, membership]));
  const legacyRoomId = safeZpeerRoomId(peer.zpeerRoomId) ?? DEFAULT_ROOM_ID;
  const legacyAlias = safeZpeerAlias(peer.zpeerAlias) ?? generatedZpeerAlias(peer);
  if (!byRoom.has(legacyRoomId)) {
    byRoom.set(legacyRoomId, buildMembership({ roomId: legacyRoomId, alias: legacyAlias, role: "member", joinedAt: peer.startedAt }));
  }
  return [...byRoom.values()].sort((left, right) => left.roomId.localeCompare(right.roomId));
}

export function activeZpeerRoomId(peer: ZobLivePeerCard): string {
  const requested = safeZpeerRoomId(peer.zpeerActiveRoomId ?? peer.zpeerRoomId) ?? DEFAULT_ROOM_ID;
  const memberships = zpeerMembershipsForPeer(peer);
  return memberships.some((membership) => membership.roomId === requested) ? requested : memberships[0]?.roomId ?? DEFAULT_ROOM_ID;
}

export function zpeerMembershipForRoom(peer: ZobLivePeerCard, roomId: string): ZpeerRoomMembership | undefined {
  return zpeerMembershipsForPeer(peer).find((membership) => membership.roomId === roomId);
}

export function activeZpeerMembership(peer: ZobLivePeerCard): ZpeerRoomMembership | undefined {
  return zpeerMembershipForRoom(peer, activeZpeerRoomId(peer));
}

export function peerAliasInRoom(peer: ZobLivePeerCard, roomId: string): string | undefined {
  return zpeerMembershipForRoom(peer, roomId)?.alias;
}

export function isPeerInZpeerRoom(peer: ZobLivePeerCard, roomId: string): boolean {
  return Boolean(zpeerMembershipForRoom(peer, roomId));
}

function upsertMembership(memberships: ZpeerRoomMembership[], next: ZpeerRoomMembership): ZpeerRoomMembership[] {
  const replaced = memberships.filter((membership) => membership.roomId !== next.roomId);
  return [...replaced, next].sort((left, right) => left.roomId.localeCompare(right.roomId));
}

function withZpeerMembershipState(repoRoot: string, peer: ZobLivePeerCard, memberships: ZpeerRoomMembership[], activeRoomIdInput?: string): ZobLivePeerCard {
  const normalized = memberships.length > 0 ? memberships : zpeerMembershipsForPeer(peer);
  const activeRoomId = safeZpeerRoomId(activeRoomIdInput) && normalized.some((membership) => membership.roomId === activeRoomIdInput)
    ? activeRoomIdInput
    : normalized[0]?.roomId ?? DEFAULT_ROOM_ID;
  const activeMembership = normalized.find((membership) => membership.roomId === activeRoomId) ?? normalized[0] ?? buildMembership({ roomId: DEFAULT_ROOM_ID, alias: generatedZpeerAlias(peer), role: "member", joinedAt: peer.startedAt });
  return writeZobLivePeerCard(repoRoot, {
    ...peer,
    projectId: buildZobComsProjectId(repoRoot),
    zpeerRoomId: activeMembership.roomId,
    zpeerAlias: activeMembership.alias,
    zpeerActiveRoomId: activeMembership.roomId,
    zpeerMemberships: normalized,
    zpeerLocalOnly: true,
    bodyStored: false,
  });
}

function zpeerStrictSocketEvidenceRequired(): boolean {
  return /^(1|true|yes|on|strict)$/i.test(process.env.ZOB_ZPEER_REQUIRE_VERIFIED_SOCKET ?? "");
}

function zpeerReachableStatus(peer: ZobLivePeerCard): ZobLivePeerStatus {
  if (peer.status === "online" && hasLocalSocketEndpointEvidence(peer, { requireVerified: zpeerStrictSocketEvidenceRequired() })) return "online";
  if (peer.status === "stale") return "stale";
  return "offline";
}

async function peerRespondsToAliasPing(peer: ZobLivePeerCard): Promise<boolean> {
  if (zpeerReachableStatus(peer) !== "online") return false;
  try {
    const response = await sendZobLocalEnvelope(peer.endpoint, {
      schema: "zob.live-envelope.v1",
      type: "ping",
      msgId: `zpeer-alias-ping:${Date.now()}`,
      hops: 0,
      timestamp: new Date().toISOString(),
      bodyStored: false,
    }, { timeoutMs: 1_000 });
    return response.type === "pong" || response.type === "ack";
  } catch {
    return false;
  }
}

async function probeAndReviveZpeerCandidate(repoRoot: string, entry: ZpeerRoomPeer): Promise<ZpeerRoomPeer | undefined> {
  if (!hasLocalSocketEndpointEvidence(entry.peer)) return undefined;
  const nowIso = new Date().toISOString();
  try {
    const response = await sendZobLocalEnvelope(entry.peer.endpoint, {
      schema: "zob.live-envelope.v1",
      type: "ping",
      msgId: `zpeer-candidate-probe:${entry.peer.roleId}:${Date.now()}`,
      hops: 0,
      timestamp: nowIso,
      bodyStored: false,
    }, { timeoutMs: 1_000 });
    if (response.type !== "pong" && response.type !== "ack") return undefined;
    const revived = { ...entry.peer, heartbeatAt: nowIso, status: "online", socketVerifiedAt: nowIso } as ZobLivePeerCard;
    if (revived.zpeerAdhoc === true || revived.projectId !== buildZobComsProjectId(repoRoot)) {
      writeZobLivePeerCardToProjectId(revived);
    } else {
      writeZobLiveTeamAgentLease(repoRoot, revived, { reason: "zpeer_candidate_probe" });
    }
    return { ...entry, peer: revived };
  } catch {
    return undefined;
  }
}

async function activeAliasCollision(repoRoot: string, self: ZobLivePeerCard, roomId: string, alias: string): Promise<ZpeerRoomPeer | undefined> {
  for (const entry of peersInRoom(repoRoot, roomId)) {
    if (entry.peer.sessionHash === self.sessionHash || !zpeerAliasesEquivalent(entry.membership.alias, alias)) continue;
    if (await peerRespondsToAliasPing(entry.peer)) return entry;
    if (zpeerReachableStatus(entry.peer) === "online") {
      try { writeZobLivePeerCard(repoRoot, { ...entry.peer, heartbeatAt: new Date().toISOString(), status: "offline" }); } catch { /* best-effort stale alias release */ }
    }
  }
  return undefined;
}

export function ensureZpeerFields(repoRoot: string, peer: ZobLivePeerCard, roomId?: string, alias?: string, restoredMemberships?: ZpeerRoomMembership[]): ZobLivePeerCard {
  const hasRestoredMemberships = Boolean(restoredMemberships && restoredMemberships.length > 0);
  const baseMemberships = hasRestoredMemberships
    ? normalizeZpeerMemberships(restoredMemberships)
    : zpeerMembershipsForPeer(peer);
  const restoredRoomId = (candidate: string | undefined): string | undefined => {
    const safe = safeZpeerRoomId(candidate);
    return safe && baseMemberships.some((membership) => membership.roomId === safe) ? safe : undefined;
  };
  const requestedRoomId = hasRestoredMemberships
    ? restoredRoomId(roomId) ?? restoredRoomId(peer.zpeerActiveRoomId) ?? baseMemberships[0]?.roomId ?? DEFAULT_ROOM_ID
    : safeZpeerRoomId(roomId ?? peer.zpeerActiveRoomId ?? peer.zpeerRoomId) ?? baseMemberships[0]?.roomId ?? DEFAULT_ROOM_ID;
  const existing = baseMemberships.find((membership) => membership.roomId === requestedRoomId);
  const requestedAlias = safeZpeerAlias(alias ?? existing?.alias ?? peer.zpeerAlias) ?? generatedZpeerAlias(peer);
  const requested = buildMembership({ roomId: requestedRoomId, alias: requestedAlias, role: existing?.role ?? "member", joinedAt: existing?.joinedAt ?? peer.startedAt });
  return withZpeerMembershipState(repoRoot, peer, upsertMembership(baseMemberships, requested), requestedRoomId);
}

export function refreshZpeerSelf(repoRoot: string, peer: ZobLivePeerCard, roomId?: string, alias?: string, restoredMemberships?: ZpeerRoomMembership[], options: { socketVerifiedAtMs?: number } = {}): ZobLivePeerCard {
  const ensured = ensureZpeerFields(repoRoot, peer, roomId, alias, restoredMemberships);
  if (!hasLocalSocketEndpointEvidence(ensured)) return ensured;
  // WS-ZH1: stamp socketVerifiedAt only when the caller supplies a freshly verified
  // self-ping timestamp (startup path / ping-aware heartbeat). The timestamp is
  // metadata-only (hash/body-free) and is consumed by
  // hasLocalSocketEndpointEvidence({ requireVerified: true }) callers. Without it the
  // prior socketVerifiedAt (if any) is preserved so periodic refresh does not erase
  // verified evidence.
  const baseCard = options.socketVerifiedAtMs !== undefined
    ? ({ ...ensured, socketVerifiedAt: new Date(options.socketVerifiedAtMs).toISOString() } as ZobLivePeerCard)
    : ensured;
  const refreshed = writeZobLivePeerCard(repoRoot, { ...baseCard, heartbeatAt: new Date().toISOString(), status: "online" });
  if (refreshed.zpeerAdhoc !== true) writeZobLiveTeamAgentLease(repoRoot, refreshed, { reason: "zpeer_refresh" });
  return refreshed;
}

type ZobLiveRegistrySnapshotValue = ReturnType<typeof readZobLiveRegistryAllProjectsSnapshot>;

function peersInRoomFromSnapshot(snapshot: ZobLiveRegistrySnapshotValue, roomId: string): ZpeerRoomPeer[] {
  return snapshot.peers
    .flatMap((peer) => zpeerMembershipsForPeer(peer)
      .filter((membership) => membership.roomId === roomId)
      .map((membership) => ({ peer, membership })));
}

function peersInRoom(repoRoot: string, roomId: string): ZpeerRoomPeer[] {
  return peersInRoomFromSnapshot(readZobLiveRegistryAllProjectsSnapshot(repoRoot), roomId);
}

function buildZpeerRoomSummaryFromPeers(projectId: string, self: ZobLivePeerCard | undefined, roomId: string, peers: ZpeerRoomPeer[]): ZpeerRoomSummary {
  const counts: Record<ZobLivePeerStatus, number> = { online: 0, stale: 0, offline: 0 };
  const statusAliases: Record<ZobLivePeerStatus, string[]> = { online: [], stale: [], offline: [] };
  const aliases = peers.map((entry) => entry.membership.alias).sort();
  for (const entry of peers) {
    const status = zpeerReachableStatus(entry.peer);
    counts[status] += 1;
    statusAliases[status].push(entry.membership.alias);
  }
  const onlineAliases = statusAliases.online.sort();
  const duplicateAliases = duplicateZpeerAliasLookupKeys(onlineAliases);
  return {
    schema: "zob.zpeer-room-summary.v1",
    projectId,
    roomId,
    selfAlias: self ? peerAliasInRoom(self, roomId) : undefined,
    peerCount: peers.length,
    online: counts.online,
    stale: counts.stale,
    offline: counts.offline,
    aliases,
    onlineAliases,
    staleAliases: statusAliases.stale.sort(),
    offlineAliases: statusAliases.offline.sort(),
    duplicateAliases,
    membershipCount: self ? zpeerMembershipsForPeer(self).length : undefined,
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
  };
}

export function buildZpeerRoomSummary(repoRoot: string, self?: ZobLivePeerCard, requestedRoomId?: string): ZpeerRoomSummary {
  const snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot);
  const roomId = safeZpeerRoomId(requestedRoomId) ?? (self ? activeZpeerRoomId(self) : DEFAULT_ROOM_ID);
  return buildZpeerRoomSummaryFromPeers(snapshot.projectId, self, roomId, peersInRoomFromSnapshot(snapshot, roomId));
}

export function buildZpeerPeerRoomSummaries(repoRoot: string, self: ZobLivePeerCard): ZpeerPeerRoomSummary[] {
  const snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot);
  const activeRoomId = activeZpeerRoomId(self);
  return zpeerMembershipsForPeer(self).map((membership) => ({
    ...buildZpeerRoomSummaryFromPeers(snapshot.projectId, self, membership.roomId, peersInRoomFromSnapshot(snapshot, membership.roomId)),
    active: membership.roomId === activeRoomId,
  })).sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.roomId.localeCompare(right.roomId);
  });
}

export async function changeZpeerAlias(repoRoot: string, self: ZobLivePeerCard, requestedAlias: string, requestedRoomId?: string): Promise<{ ok: true; peer: ZobLivePeerCard } | { ok: false; reason: string }> {
  const alias = safeZpeerAlias(requestedAlias);
  if (!alias) return { ok: false, reason: "alias must match [a-zA-Z][a-zA-Z0-9_-]{1,31}" };
  const roomId = safeZpeerRoomId(requestedRoomId) ?? activeZpeerRoomId(self);
  const memberships = zpeerMembershipsForPeer(self);
  const current = memberships.find((membership) => membership.roomId === roomId);
  if (!current) return { ok: false, reason: `current peer is not a member of room '${roomId}'` };
  const collision = await activeAliasCollision(repoRoot, self, roomId, alias);
  if (collision) return { ok: false, reason: `alias '${alias}' is already used by a live peer in room '${roomId}'` };
  return { ok: true, peer: refreshZpeerSelf(repoRoot, withZpeerMembershipState(repoRoot, self, upsertMembership(memberships, { ...current, alias }), activeZpeerRoomId(self))) };
}

export async function joinZpeerRoom(repoRoot: string, self: ZobLivePeerCard, requestedRoom: string, requestedAlias?: string, role: ZpeerRoomMembershipRole = "member"): Promise<{ ok: true; peer: ZobLivePeerCard } | { ok: false; reason: string }> {
  const roomId = safeZpeerRoomId(requestedRoom);
  if (!roomId) return { ok: false, reason: "room must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}" };
  const memberships = zpeerMembershipsForPeer(self);
  const existing = memberships.find((membership) => membership.roomId === roomId);
  const alias = safeZpeerAlias(requestedAlias ?? existing?.alias ?? self.zpeerAlias) ?? generatedZpeerAlias(self);
  const collision = await activeAliasCollision(repoRoot, self, roomId, alias);
  if (collision) return { ok: false, reason: `alias '${alias}' already exists on a live peer in target room '${roomId}'; rename first or use 'as <alias>'` };
  const next = buildMembership({ roomId, alias, role, joinedAt: existing?.joinedAt ?? new Date().toISOString() });
  return { ok: true, peer: refreshZpeerSelf(repoRoot, withZpeerMembershipState(repoRoot, self, upsertMembership(memberships, next), activeZpeerRoomId(self))) };
}

export function leaveZpeerRoom(repoRoot: string, self: ZobLivePeerCard, requestedRoom: string): { ok: true; peer: ZobLivePeerCard } | { ok: false; reason: string } {
  const roomId = safeZpeerRoomId(requestedRoom);
  if (!roomId) return { ok: false, reason: "room must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}" };
  const memberships = zpeerMembershipsForPeer(self);
  if (!memberships.some((membership) => membership.roomId === roomId)) return { ok: false, reason: `current peer is not a member of room '${roomId}'` };
  if (memberships.length <= 1) return { ok: false, reason: "cannot leave the last zpeer room" };
  const remaining = memberships.filter((membership) => membership.roomId !== roomId);
  const nextActive = activeZpeerRoomId(self) === roomId ? remaining[0]?.roomId : activeZpeerRoomId(self);
  return { ok: true, peer: refreshZpeerSelf(repoRoot, withZpeerMembershipState(repoRoot, self, remaining, nextActive)) };
}

export function useZpeerRoom(repoRoot: string, self: ZobLivePeerCard, requestedRoom: string): { ok: true; peer: ZobLivePeerCard } | { ok: false; reason: string } {
  const roomId = safeZpeerRoomId(requestedRoom);
  if (!roomId) return { ok: false, reason: "room must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}" };
  const memberships = zpeerMembershipsForPeer(self);
  if (!memberships.some((membership) => membership.roomId === roomId)) return { ok: false, reason: `current peer is not a member of room '${roomId}'; join it first` };
  return { ok: true, peer: refreshZpeerSelf(repoRoot, withZpeerMembershipState(repoRoot, self, memberships, roomId)) };
}

export function clearZpeerRoom(repoRoot: string, self: ZobLivePeerCard, requestedRoom: string): { ok: true; roomId: string; cleared: number; preservedSelf: true } | { ok: false; reason: string } {
  const roomId = safeZpeerRoomId(requestedRoom);
  if (!roomId) return { ok: false, reason: "room must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}" };
  let cleared = 0;
  for (const entry of peersInRoom(repoRoot, roomId)) {
    if (entry.peer.sessionHash === self.sessionHash) continue;
    const remaining = zpeerMembershipsForPeer(entry.peer).filter((membership) => membership.roomId !== roomId);
    const fallbackRoomId = `cleared-${entry.peer.sessionHash.slice(0, 8)}`;
    const fallbackAlias = safeZpeerAlias(entry.peer.zpeerAlias) ?? generatedZpeerAlias(entry.peer);
    const nextMemberships = remaining.length > 0 ? remaining : [buildMembership({ roomId: fallbackRoomId, alias: fallbackAlias, role: "observer", joinedAt: new Date().toISOString() })];
    const active = nextMemberships[0];
    writeZobLivePeerCardToProjectId({
      ...entry.peer,
      heartbeatAt: new Date().toISOString(),
      status: "offline",
      zpeerRoomId: active.roomId,
      zpeerActiveRoomId: active.roomId,
      zpeerAlias: active.alias,
      zpeerMemberships: nextMemberships,
    });
    cleared += 1;
  }
  return { ok: true, roomId, cleared, preservedSelf: true };
}

export async function changeZpeerRoom(repoRoot: string, self: ZobLivePeerCard, requestedRoom: string): Promise<{ ok: true; peer: ZobLivePeerCard } | { ok: false; reason: string }> {
  const roomId = safeZpeerRoomId(requestedRoom);
  if (!roomId) return { ok: false, reason: "room must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}" };
  const memberships = zpeerMembershipsForPeer(self);
  if (!memberships.some((membership) => membership.roomId === roomId)) {
    const joined = await joinZpeerRoom(repoRoot, self, roomId, self.zpeerAlias ?? generatedZpeerAlias(self));
    if (!joined.ok) return joined;
    return useZpeerRoom(repoRoot, joined.peer, roomId);
  }
  return useZpeerRoom(repoRoot, self, roomId);
}

function zpeerComsDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "coms");
}

function appendHashOnlyZpeerJsonl(repoRoot: string, fileName: "peer-messages.jsonl" | "peer-status.jsonl", record: Record<string, unknown>): void {
  mkdirSync(zpeerComsDir(repoRoot), { recursive: true });
  appendFileSync(join(zpeerComsDir(repoRoot), fileName), `${JSON.stringify({ ...record, bodyStored: false, timestamp: new Date().toISOString() })}\n`, "utf8");
}

function appendZpeerPeerRecords(repoRoot: string, record: {
  event: "attempt" | "ack" | "terminal";
  status: ZpeerSendResult["status"] | "sent";
  roomId: string;
  msgId?: string;
  senderAlias?: string;
  targetAlias?: string;
  taskHash?: string;
  outputHash?: string;
  reason?: string;
  peerCount?: number;
  priority?: ZpeerInterruptPriority;
  interruptMode?: ZpeerInterruptMode;
  interruptStatus?: ZpeerInterruptStatus;
  interruptReasonHash?: string;
  requireResponse?: boolean;
  responseRequiredBy?: string;
  responseTimeoutMs?: number;
  maxReinjects?: number;
  responseReceived?: boolean;
  deliveryStatus?: "delivered" | "blocked" | "stale" | "offline" | "transport_error";
  deliveryMethod?: "local_socket" | "tmux_sendkeys";
  fallbackDelivery?: boolean;
}): void {
  const base = {
    schema: "zob.zpeer-peer-hash-ref.v1",
    event: record.event,
    status: record.status,
    msgId: record.msgId,
    roomIdHash: sha256(record.roomId),
    senderAliasHash: record.senderAlias ? sha256(record.senderAlias) : undefined,
    targetAliasHash: record.targetAlias ? sha256(record.targetAlias) : undefined,
    taskHash: record.taskHash,
    outputHash: record.outputHash,
    reasonHash: record.reason ? sha256(record.reason) : undefined,
    peerCount: record.peerCount,
    priority: record.priority,
    interruptMode: record.interruptMode,
    interruptStatus: record.interruptStatus,
    interruptReasonHash: record.interruptReasonHash,
    requireResponse: record.requireResponse,
    responseRequiredBy: record.responseRequiredBy,
    responseTimeoutMs: record.responseTimeoutMs,
    maxReinjects: record.maxReinjects,
    responseReceived: record.responseReceived,
    deliveryStatus: record.deliveryStatus,
    deliveryMethod: record.deliveryMethod,
    fallbackDelivery: record.fallbackDelivery,
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
  };
  appendHashOnlyZpeerJsonl(repoRoot, "peer-messages.jsonl", base);
  appendHashOnlyZpeerJsonl(repoRoot, "peer-status.jsonl", { ...base, schema: "zob.zpeer-peer-status.v1" });
}

function validateZpeerTopology(repoRoot: string, self: ZobLivePeerCard, target: ZobLivePeerCard, roomId: string, selfAlias?: string, targetAlias?: string): string | undefined {
  if (self.roleId === target.roleId && self.roleType === "orchestrator" && target.roleType === "orchestrator") return undefined;
  const selfInRequestedRoom = isPeerInZpeerRoom(self, roomId);
  const targetInRequestedRoom = isPeerInZpeerRoom(target, roomId);
  const bothPeersAreWorkers = self.roleType === "worker" && target.roleType === "worker";
  if (selfInRequestedRoom && targetInRequestedRoom && !bothPeersAreWorkers) return undefined;
  const teamName = self.team || target.team || "zob-core";
  if (target.team !== teamName) return "zpeer topology blocked: peers are in different teams";
  let topologyRoot = repoRoot;
  let loaded = loadTeamDefinition(topologyRoot, teamName);
  if (!loaded.definition && process.cwd() !== repoRoot) {
    topologyRoot = process.cwd();
    loaded = loadTeamDefinition(topologyRoot, teamName);
  }
  if (loaded.definition) {
    const definitionErrors = validateTeamDefinition(topologyRoot, loaded.definition);
    if (definitionErrors.length > 0) return `zpeer topology blocked: ${definitionErrors.join("; ")}`;
    const edgeErrors = validateZobComsEdge(loaded.definition, self.roleId, target.roleId);
    if (edgeErrors.length === 0) return undefined;
    if (!edgeErrors.some((error) => error.startsWith("Unknown coms sender") || error.startsWith("Unknown coms receiver"))) return `zpeer topology blocked: ${edgeErrors.join("; ")}`;
  }

  if (!self.team || self.team !== target.team) return "zpeer topology blocked: peers are not in the same zteam";
  const zteam = loadZteamManifest(repoRoot, self.team);
  if (zteam.errors.length > 0) return `zpeer topology blocked: ${loaded.errors.join("; ") || "legacy topology rejected ZAgent role ids"}; zteam fallback blocked: ${zteam.errors.join("; ")}`;
  if (!zteamAllowsZpeerContact(zteam.manifest, self.roleId, roomId, selfAlias)) return `zpeer topology blocked: zteam '${self.team}' does not allow ${self.roleId} in room '${roomId}'`;
  if (!zteamAllowsZpeerContact(zteam.manifest, target.roleId, roomId, targetAlias)) return `zpeer topology blocked: zteam '${target.team}' does not allow ${target.roleId} in room '${roomId}'`;
  return undefined;
}

export async function sendZpeerPrompt(repoRoot: string, self: ZobLivePeerCard, targetAliasInput: string, transientPrompt: string, awaitReply: (msgId: string) => Promise<{ status: string; envelope?: { outputHash?: string; transientResponse?: string; errorHash?: string } }>, options: ZpeerSendOptions = {}): Promise<ZpeerSendResult> {
  const roomId = safeZpeerRoomId(options.roomId) ?? activeZpeerRoomId(self);
  const selfMembership = zpeerMembershipForRoom(self, roomId);
  const senderAlias = selfMembership?.alias ?? activeZpeerMembership(self)?.alias ?? generatedZpeerAlias(self);
  const targetAlias = safeZpeerAlias(targetAliasInput);
  const taskHash = transientPrompt.trim() ? sha256(transientPrompt) : undefined;
  const mode = options.mode ?? "await";
  const priority = options.priority ?? (options.interruptMode === "abort" ? "force" : options.interruptMode === "steer" ? "urgent" : "normal");
  const interruptMode = options.interruptMode ?? (priority === "force" ? "abort" : priority === "urgent" ? "steer" : "none");
  const interruptReasonHash = options.interruptReasonHash;
  const interruptRequested = priority !== "normal" || interruptMode !== "none";
  const requireResponse = options.requireResponse === true;
  const responseTimeoutMs = Math.max(1_000, Math.min(30 * 60 * 1000, Math.floor(options.responseTimeoutMs ?? (mode === "long" ? 30 * 60 * 1000 : 10 * 60 * 1000))));
  const maxReinjects = Math.max(0, Math.min(3, Math.floor(options.maxReinjects ?? 1)));
  const emitFeedback = (kind: ZpeerSendFeedback["kind"], result: ZpeerSendResult): void => {
    options.onFeedback?.({ kind, result });
  };
  const finish = (event: "attempt" | "ack" | "terminal", result: ZpeerSendResult, peerCount?: number): ZpeerSendResult => {
    appendZpeerPeerRecords(repoRoot, {
      event,
      status: result.status,
      roomId,
      msgId: result.msgId,
      senderAlias,
      targetAlias: result.targetAlias,
      taskHash: result.taskHash,
      outputHash: result.outputHash,
      reason: result.reason,
      peerCount,
      priority: result.priority ?? priority,
      interruptMode: result.interruptMode ?? interruptMode,
      interruptStatus: result.interruptStatus,
      interruptReasonHash: result.interruptReasonHash ?? interruptReasonHash,
      requireResponse: result.requireResponse,
      responseRequiredBy: result.responseRequiredBy,
      responseTimeoutMs: result.responseTimeoutMs,
      maxReinjects: result.maxReinjects,
      responseReceived: result.responseReceived,
      deliveryStatus: result.deliveryStatus,
      deliveryMethod: result.deliveryMethod,
      fallbackDelivery: result.fallback_delivery,
    });
    return annotateZpeerStatus({ roomId, priority, interruptMode, interruptReasonHash, requireResponse: requireResponse || undefined, responseTimeoutMs: requireResponse ? responseTimeoutMs : undefined, maxReinjects: requireResponse ? maxReinjects : undefined, ...result });
  };

  if (priority === "force" && !interruptReasonHash) return finish("attempt", { status: "blocked", reason: "force interrupt requires reason hash", targetAlias: targetAlias ?? undefined, taskHash, interruptStatus: "force_blocked", bodyStored: false });
  if (!selfMembership) return finish("attempt", { status: "blocked", reason: `current peer is not a member of room '${roomId}'`, targetAlias: targetAlias ?? undefined, taskHash, bodyStored: false });
  if (self.zpeerAdhoc !== true) {
    const leaseOwnership = ownsZobLiveTeamAgentLease(repoRoot, self);
    if (!leaseOwnership.owned) return finish("attempt", { status: "blocked", reason: `current peer does not own stable team-agent lease (${leaseOwnership.reason})`, targetAlias: targetAlias ?? undefined, taskHash, bodyStored: false });
  }
  if (selfMembership.role === "observer") return finish("attempt", { status: "blocked", reason: `current peer is observer-only in room '${roomId}'`, targetAlias: targetAlias ?? undefined, taskHash, bodyStored: false });
  if (priority === "force" && !ZPEER_FORCE_ALLOWED_SENDER_ROLE_TYPES.has(self.roleType)) return finish("attempt", { status: "blocked", reason: `force interrupt not allowed from role type ${self.roleType}`, targetAlias: targetAlias ?? undefined, taskHash, interruptStatus: "force_blocked", bodyStored: false });
  if (!targetAlias) return finish("attempt", { status: "blocked", reason: "invalid target alias", bodyStored: false });
  if (!transientPrompt.trim()) return finish("attempt", { status: "blocked", reason: "empty peer prompt", targetAlias, bodyStored: false });
  const candidates = peersInRoom(repoRoot, roomId).filter((entry) => zpeerAliasesEquivalent(entry.membership.alias, targetAlias) && entry.peer.sessionHash !== self.sessionHash);
  if (zpeerAliasesEquivalent(targetAlias, senderAlias)) return finish("attempt", { status: "blocked", reason: "cannot send to self", targetAlias, taskHash, bodyStored: false });
  if (candidates.length === 0) return finish("attempt", { status: "blocked", reason: `peer @${targetAlias} not found in room '${roomId}'`, targetAlias, taskHash, bodyStored: false }, 0);
  let liveCandidates = candidates.filter((entry) => zpeerReachableStatus(entry.peer) === "online");
  if (liveCandidates.length > 1) {
    const responsiveCandidates: ZpeerRoomPeer[] = [];
    for (const entry of liveCandidates) {
      if (await peerRespondsToAliasPing(entry.peer)) {
        responsiveCandidates.push(entry);
      } else {
        try { writeZobLivePeerCard(repoRoot, { ...entry.peer, heartbeatAt: new Date().toISOString(), status: "offline" }); } catch { /* best-effort ghost alias release */ }
      }
    }
    liveCandidates = responsiveCandidates;
  }
  if (liveCandidates.length === 0) {
    const probedCandidates: ZpeerRoomPeer[] = [];
    for (const entry of candidates) {
      const revived = await probeAndReviveZpeerCandidate(repoRoot, entry);
      if (revived) probedCandidates.push(revived);
    }
    liveCandidates = probedCandidates;
  }
  if (liveCandidates.length === 0) {
    const statuses = [...new Set(candidates.map((entry) => zpeerReachableStatus(entry.peer)))].sort().join("/") || "offline";
    // WS-ZH4: last-resort fallback delivery. When local-socket transport is blocked
    // but the caller injected a fallback (e.g. tmux send-keys to the target agent's
    // pane), deliver the prompt best-effort. This is NOT verified delivery:
    // outputHash/confirmation_ref stay absent and bodyStored stays false; the receiver,
    // if it answers at all, answers via its own local_socket later (that ledgered reply
    // is what WS-Q5 counts). Urgent/steer is eligible when the caller explicitly wires
    // a safe fallback hook; force/abort is never eligible. If no fallback is supplied or
    // it fails/declines, fall through to the standard blocked result unchanged.
    if (options.fallbackDelivery && targetAlias && priority !== "force") {
      try {
        const fallback = await options.fallbackDelivery({ targetAlias, senderAlias, roomId, taskHash, prompt: transientPrompt, priority, interruptMode, requireResponse, responseTimeoutMs: requireResponse ? responseTimeoutMs : undefined, maxReinjects: requireResponse ? maxReinjects : undefined });
        if (fallback.delivered) {
          const fallbackMsgId = `zpeer-fallback:${self.sessionHash.slice(0, 8)}:${Date.now()}`;
          return finish("attempt", { status: "delivered", reason: `tmux_sendkeys_fallback: peer @${targetAlias} socket ${statuses}; best-effort delivery to ${fallback.target ?? targetAlias} (not verified)`, msgId: fallbackMsgId, targetAlias, taskHash, deliveryStatus: "blocked", deliveryMethod: "tmux_sendkeys", fallback_delivery: true, best_effort: true, responseReceived: requireResponse ? false : undefined, bodyStored: false }, candidates.length);
        }
      } catch {
        // best-effort fallback failed; fall through to the standard blocked result.
      }
    }
    return finish("attempt", { status: "blocked", reason: `peer @${targetAlias} is ${statuses}`, targetAlias, taskHash, bodyStored: false }, candidates.length);
  }
  if (liveCandidates.length > 1) return finish("attempt", { status: "blocked", reason: `duplicate live alias @${targetAlias} in room '${roomId}'`, targetAlias, taskHash, bodyStored: false }, liveCandidates.length);
  const target = liveCandidates[0];
  const targetReachableStatus = zpeerReachableStatus(target.peer);
  if (targetReachableStatus !== "online") return finish("attempt", { status: "blocked", reason: `peer @${targetAlias} is ${targetReachableStatus}`, targetAlias, taskHash, bodyStored: false }, 1);
  if (priority === "force" && !ZPEER_FORCE_ALLOWED_RECEIVER_ROLE_TYPES.has(target.peer.roleType)) return finish("attempt", { status: "blocked", reason: `force interrupt not allowed to role type ${target.peer.roleType}`, targetAlias, taskHash, interruptStatus: "force_blocked", bodyStored: false }, 1);
  const topologyBlocker = validateZpeerTopology(repoRoot, self, target.peer, roomId, senderAlias, target.membership.alias);
  if (topologyBlocker) return finish("attempt", { status: "blocked", reason: topologyBlocker, targetAlias, taskHash, bodyStored: false }, 1);
  if (target.peer.transport !== "local_socket" || target.peer.endpoint.startsWith("pending-") || target.peer.endpoint === "observe-only") return finish("attempt", { status: "blocked", reason: `peer @${targetAlias} is not reachable by local_socket`, targetAlias, taskHash, bodyStored: false }, 1);
  if (self.transport !== "local_socket" || !self.endpoint || self.endpoint.startsWith("pending-") || self.endpoint === "observe-only") return finish("attempt", { status: "blocked", reason: "current session has no local_socket reply endpoint", targetAlias, taskHash, bodyStored: false }, 1);

  const msgId = `zpeer:${self.sessionHash.slice(0, 8)}:${target.peer.sessionHash.slice(0, 8)}:${Date.now()}`;
  const responseRequiredBy = requireResponse ? new Date(Date.now() + responseTimeoutMs).toISOString() : undefined;
  finish("attempt", { status: "delivered", msgId, targetAlias, taskHash, requireResponse: requireResponse || undefined, responseRequiredBy, responseTimeoutMs: requireResponse ? responseTimeoutMs : undefined, maxReinjects: requireResponse ? maxReinjects : undefined, deliveryStatus: "delivered", responseReceived: requireResponse ? false : undefined, bodyStored: false }, 1);
  const liveEnvelope = buildZobLiveEnvelope({
    type: "prompt",
    msgId,
    runId: `zpeer:${roomId}`,
    sender: senderAlias,
    receiver: target.membership.alias,
    team: self.team,
    taskHash,
    replyEndpoint: self.endpoint,
    replyEndpointHash: self.endpointHash,
    transientPrompt,
    priority,
    interruptRequested,
    interruptMode,
    interruptReasonHash,
    requireResponse: requireResponse || undefined,
    responseTimeoutMs: requireResponse ? responseTimeoutMs : undefined,
    responseRequiredBy,
    maxReinjects: requireResponse ? maxReinjects : undefined,
  });
  try {
    const ack = await sendZobLocalEnvelope(target.peer.endpoint, liveEnvelope, { timeoutMs: 5_000 });
    if (ack.type !== "ack") return finish("terminal", { status: "error", reason: `expected ack, got ${ack.type}`, msgId, targetAlias, taskHash, bodyStored: false }, 1);
    const ackInterruptStatus = ack.interruptStatus;
    appendZpeerPeerRecords(repoRoot, { event: "ack", status: "delivered", roomId, msgId, senderAlias, targetAlias, taskHash, priority, interruptMode, interruptStatus: ackInterruptStatus, interruptReasonHash, peerCount: 1 });
    if (ackInterruptStatus === "force_blocked") return finish("terminal", { status: "blocked", reason: "force interrupt blocked by receiver policy", msgId, targetAlias, taskHash, interruptStatus: ackInterruptStatus, bodyStored: false }, 1);
    if (mode === "async" && !requireResponse) {
      const waiting = finish("terminal", { status: "waiting", reason: "delivered locally; awaiting async reply", msgId, targetAlias, taskHash, interruptStatus: ackInterruptStatus, deliveryStatus: "delivered", bodyStored: false }, 1);
      emitFeedback("waiting", waiting);
      return waiting;
    }
    emitFeedback("delivered", { status: "delivered", roomId, msgId, targetAlias, taskHash, priority, interruptMode, interruptStatus: ackInterruptStatus, interruptReasonHash, requireResponse: requireResponse || undefined, responseRequiredBy, responseTimeoutMs: requireResponse ? responseTimeoutMs : undefined, maxReinjects: requireResponse ? maxReinjects : undefined, deliveryStatus: "delivered", responseReceived: requireResponse ? false : undefined, bodyStored: false });
    emitFeedback("waiting", { status: "waiting", roomId, reason: requireResponse ? "waiting for required peer response" : mode === "long" ? "waiting for long peer reply" : "waiting for peer reply", msgId, targetAlias, taskHash, priority, interruptMode, interruptStatus: ackInterruptStatus, interruptReasonHash, requireResponse: requireResponse || undefined, responseRequiredBy, responseTimeoutMs: requireResponse ? responseTimeoutMs : undefined, maxReinjects: requireResponse ? maxReinjects : undefined, deliveryStatus: "delivered", responseReceived: requireResponse ? false : undefined, bodyStored: false });
    const reply = await awaitReply(msgId);
    const replyEnvelope = reply["envelope"];
    if (reply.status === "completed") {
      const transientResponse = replyEnvelope?.transientResponse;
      const result = finish("terminal", { status: "reply", msgId, targetAlias, taskHash, outputHash: replyEnvelope?.outputHash ?? (transientResponse ? sha256(transientResponse) : undefined), transientResponse, interruptStatus: ackInterruptStatus, requireResponse: requireResponse || undefined, responseRequiredBy, responseTimeoutMs: requireResponse ? responseTimeoutMs : undefined, maxReinjects: requireResponse ? maxReinjects : undefined, deliveryStatus: "delivered", responseReceived: requireResponse ? true : undefined, bodyStored: false }, 1);
      emitFeedback("reply", result);
      return result;
    }
    if (reply.status === "required_response_expired") {
      const result = finish("terminal", { status: "required_response_expired", reason: "required peer response expired", msgId, targetAlias, taskHash, interruptStatus: ackInterruptStatus, requireResponse: true, responseRequiredBy, responseTimeoutMs, maxReinjects, deliveryStatus: "delivered", responseReceived: false, bodyStored: false }, 1);
      emitFeedback("expired", result);
      return result;
    }
    if (reply.status === "timeout") {
      const result = finish("terminal", { status: "timeout", reason: "await response timed out", msgId, targetAlias, taskHash, interruptStatus: ackInterruptStatus, deliveryStatus: "delivered", bodyStored: false }, 1);
      emitFeedback(mode === "long" ? "expired" : "timeout", result);
      return result;
    }
    const result = finish("terminal", { status: "error", reason: replyEnvelope?.errorHash ?? "peer response error", msgId, targetAlias, taskHash, interruptStatus: ackInterruptStatus, requireResponse: requireResponse || undefined, responseRequiredBy, responseTimeoutMs: requireResponse ? responseTimeoutMs : undefined, maxReinjects: requireResponse ? maxReinjects : undefined, deliveryStatus: "delivered", responseReceived: requireResponse ? false : undefined, bodyStored: false }, 1);
    emitFeedback("error", result);
    return result;
  } catch (error) {
    return finish("terminal", { status: "error", reason: error instanceof Error ? error.message : String(error), msgId, targetAlias, taskHash, bodyStored: false }, 1);
  }
}
