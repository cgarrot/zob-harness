import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildZobComsProjectId } from "./identity.js";
import type { ZobLivePeerCard, ZpeerRoomMembership } from "./types.js";
import { sha256 } from "../utils/hashing.js";
import { isRecord } from "../utils/records.js";
import { safeFileStem } from "../utils/paths.js";

const PROFILE_SCHEMA = "zob.zpeer-local-profile.v1";
const NEW_CARRYOVER_SCHEMA = "zob.zpeer-new-carryover.v1";
const DEFAULT_NEW_CARRYOVER_TTL_MS = 30 * 60 * 1000;
const FORBIDDEN_PROFILE_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "response", "rationale", "text", "diff", "patch"]);

export interface ZpeerLocalProfile {
  schema: typeof PROFILE_SCHEMA;
  profileId: string;
  projectId: string;
  alias?: string;
  roomId?: string;
  activeRoomId?: string;
  memberships?: ZpeerRoomMembership[];
  createdAt: string;
  updatedAt: string;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
}

export interface ZpeerNewCarryoverProfile {
  schema: typeof NEW_CARRYOVER_SCHEMA;
  projectId: string;
  alias?: string;
  roomId?: string;
  activeRoomId?: string;
  memberships?: ZpeerRoomMembership[];
  zagentId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
}

export interface ZpeerNewCarryoverInput {
  alias?: string;
  roomId?: string;
  activeRoomId?: string;
  memberships?: ZpeerRoomMembership[];
  zagentId?: string;
  ttlMs?: number;
}

function registryRoot(): string {
  const override = process.env.ZOB_COMS_REGISTRY_ROOT;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".pi", "zob-coms");
}

function firstEnvValue(names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

function derivedSessionSeed(repoRoot: string): string | undefined {
  const parts = [
    process.env.TMUX_PANE,
    process.env.STY,
    process.env.TERM_SESSION_ID,
    process.env.KITTY_WINDOW_ID,
    process.env.WEZTERM_PANE,
    process.env.WINDOWID,
    process.env.VSCODE_PID,
    process.env.TTY,
    process.env.SSH_TTY,
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (parts.length === 0) return undefined;
  return `${repoRoot}\n${parts.join("\n")}`;
}

export function resolveZpeerProfileId(repoRoot: string): string {
  const explicit = firstEnvValue(["ZOB_ZPEER_PROFILE_ID", "ZPEER_PROFILE"]);
  if (explicit) return safeFileStem(`explicit-${explicit.value}`).slice(0, 80) || `explicit-${sha256(explicit.value).slice(0, 16)}`;
  const terminalSeed = derivedSessionSeed(repoRoot);
  if (terminalSeed) return `terminal-${sha256(terminalSeed).slice(0, 20)}`;
  const comsSession = firstEnvValue(["ZOB_COMS_SESSION_ID"]);
  if (comsSession) return safeFileStem(`coms-${comsSession.value}`).slice(0, 80) || `coms-${sha256(comsSession.value).slice(0, 16)}`;
  const role = firstEnvValue(["ZOB_COMS_ROLE_ID"]);
  const roleId = role?.value ?? "zob-orchestrator";
  return `role-${safeFileStem(roleId).slice(0, 40) || sha256(roleId).slice(0, 16)}`;
}

export function zpeerProfileIdIsSharedFallback(profileId = resolveZpeerProfileId("")): boolean {
  return profileId.startsWith("role-");
}

function zpeerProfileDir(repoRoot: string): { dir: string; projectId: string } {
  const projectId = buildZobComsProjectId(repoRoot);
  return { dir: join(registryRoot(), "projects", projectId, "zpeer-profiles"), projectId };
}

export function zpeerProfilePath(repoRoot: string, profileId = resolveZpeerProfileId(repoRoot)): string {
  const { dir } = zpeerProfileDir(repoRoot);
  return join(dir, `${safeFileStem(sha256(profileId).slice(0, 32))}.json`);
}

function zpeerNewCarryoverProfilePath(repoRoot: string): string {
  const { dir } = zpeerProfileDir(repoRoot);
  return join(dir, "new-carryover.json");
}

function hasForbiddenProfileKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenProfileKey);
  return Object.entries(value).some(([key, child]) => FORBIDDEN_PROFILE_KEYS.has(key) || hasForbiddenProfileKey(child));
}

function validZpeerMemberships(value: unknown): value is ZpeerRoomMembership[] {
  if (!Array.isArray(value)) return false;
  for (const membership of value) {
    if (!isRecord(membership)) return false;
    if (hasForbiddenProfileKey(membership)) return false;
    if (typeof membership.roomId !== "string" || typeof membership.alias !== "string" || typeof membership.role !== "string") return false;
    if (typeof membership.joinedAt !== "string" || membership.localOnly !== true || membership.networkEnabled !== false || membership.bodyStored !== false) return false;
  }
  return true;
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseZpeerLocalProfile(value: unknown, repoRoot: string): ZpeerLocalProfile | undefined {
  if (!isRecord(value) || value.schema !== PROFILE_SCHEMA) return undefined;
  if (hasForbiddenProfileKey(value) || value.bodyStored !== false || value.localOnly !== true || value.networkEnabled !== false) return undefined;
  if (typeof value.profileId !== "string" || value.projectId !== buildZobComsProjectId(repoRoot)) return undefined;
  if (value.alias !== undefined && typeof value.alias !== "string") return undefined;
  if (value.roomId !== undefined && typeof value.roomId !== "string") return undefined;
  if (value.activeRoomId !== undefined && typeof value.activeRoomId !== "string") return undefined;
  if (value.memberships !== undefined && !validZpeerMemberships(value.memberships)) return undefined;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return undefined;
  return value as unknown as ZpeerLocalProfile;
}

function parseZpeerNewCarryoverProfile(value: unknown, repoRoot: string, nowMs = Date.now()): ZpeerNewCarryoverProfile | undefined {
  if (!isRecord(value) || value.schema !== NEW_CARRYOVER_SCHEMA) return undefined;
  if (hasForbiddenProfileKey(value) || value.bodyStored !== false || value.localOnly !== true || value.networkEnabled !== false) return undefined;
  if (value.projectId !== buildZobComsProjectId(repoRoot)) return undefined;
  if (value.alias !== undefined && typeof value.alias !== "string") return undefined;
  if (value.roomId !== undefined && typeof value.roomId !== "string") return undefined;
  if (value.activeRoomId !== undefined && typeof value.activeRoomId !== "string") return undefined;
  if (value.zagentId !== undefined && typeof value.zagentId !== "string") return undefined;
  if (value.memberships !== undefined && !validZpeerMemberships(value.memberships)) return undefined;
  if (!validIsoDate(value.createdAt) || !validIsoDate(value.updatedAt) || !validIsoDate(value.expiresAt)) return undefined;
  if (Date.parse(value.expiresAt) <= nowMs) return undefined;
  return value as unknown as ZpeerNewCarryoverProfile;
}

export function readZpeerLocalProfile(repoRoot: string, profileId = resolveZpeerProfileId(repoRoot)): ZpeerLocalProfile | undefined {
  const path = zpeerProfilePath(repoRoot, profileId);
  if (!existsSync(path)) return undefined;
  try {
    return parseZpeerLocalProfile(JSON.parse(readFileSync(path, "utf8")) as unknown, repoRoot);
  } catch {
    return undefined;
  }
}

export function writeZpeerLocalProfile(repoRoot: string, input: { alias?: string; roomId?: string; activeRoomId?: string; memberships?: ZpeerRoomMembership[] }, profileId = resolveZpeerProfileId(repoRoot)): ZpeerLocalProfile {
  const { dir, projectId } = zpeerProfileDir(repoRoot);
  const existing = readZpeerLocalProfile(repoRoot, profileId);
  const now = new Date().toISOString();
  const sharedFallback = zpeerProfileIdIsSharedFallback(profileId);
  const profile: ZpeerLocalProfile = {
    schema: PROFILE_SCHEMA,
    profileId,
    projectId,
    alias: sharedFallback ? undefined : input.alias ?? existing?.alias,
    roomId: input.roomId ?? existing?.roomId,
    activeRoomId: input.activeRoomId ?? input.roomId ?? existing?.activeRoomId,
    memberships: sharedFallback ? undefined : input.memberships ?? existing?.memberships,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
  };
  if (hasForbiddenProfileKey(profile)) throw new Error("Refusing to persist ZPeer local profile with forbidden body-like keys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(zpeerProfilePath(repoRoot, profileId), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return profile;
}

export function readZpeerNewCarryoverProfile(repoRoot: string): ZpeerNewCarryoverProfile | undefined {
  const path = zpeerNewCarryoverProfilePath(repoRoot);
  if (!existsSync(path)) return undefined;
  try {
    const profile = parseZpeerNewCarryoverProfile(JSON.parse(readFileSync(path, "utf8")) as unknown, repoRoot);
    if (!profile) clearZpeerNewCarryoverProfile(repoRoot);
    return profile;
  } catch {
    return undefined;
  }
}

export function writeZpeerNewCarryoverProfile(repoRoot: string, input: ZpeerNewCarryoverInput): ZpeerNewCarryoverProfile {
  if (hasForbiddenProfileKey(input)) throw new Error("Refusing to persist ZPeer /new carryover profile with forbidden body-like keys");
  if (input.memberships !== undefined && !validZpeerMemberships(input.memberships)) throw new Error("Refusing to persist ZPeer /new carryover profile with invalid memberships");
  const { dir, projectId } = zpeerProfileDir(repoRoot);
  const existing = readZpeerNewCarryoverProfile(repoRoot);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const ttlMs = input.ttlMs !== undefined && Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_NEW_CARRYOVER_TTL_MS;
  const profile: ZpeerNewCarryoverProfile = {
    schema: NEW_CARRYOVER_SCHEMA,
    projectId,
    alias: input.alias ?? existing?.alias,
    roomId: input.roomId ?? existing?.roomId,
    activeRoomId: input.activeRoomId ?? input.roomId ?? existing?.activeRoomId,
    memberships: input.memberships ?? existing?.memberships,
    zagentId: input.zagentId ?? existing?.zagentId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
  };
  if (hasForbiddenProfileKey(profile)) throw new Error("Refusing to persist ZPeer /new carryover profile with forbidden body-like keys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(zpeerNewCarryoverProfilePath(repoRoot), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return profile;
}

export function clearZpeerNewCarryoverProfile(repoRoot: string): void {
  const path = zpeerNewCarryoverProfilePath(repoRoot);
  if (existsSync(path)) unlinkSync(path);
}

function generatedAliasForPeer(peer: Pick<ZobLivePeerCard, "roleId" | "sessionHash">): string | undefined {
  const roleAlias = `${peer.roleId}-${peer.sessionHash.slice(0, 6)}`;
  if (/^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/.test(roleAlias)) return roleAlias;
  return `peer-${peer.sessionHash.slice(0, 8)}`;
}

function activeMembershipAlias(peer: Pick<ZobLivePeerCard, "zpeerRoomId" | "zpeerActiveRoomId" | "zpeerMemberships">): string | undefined {
  const activeRoomId = peer.zpeerActiveRoomId ?? peer.zpeerRoomId;
  return peer.zpeerMemberships?.find((membership) => membership.roomId === activeRoomId)?.alias;
}

export function writeZpeerLocalProfileFromPeer(repoRoot: string, peer: Pick<ZobLivePeerCard, "roleId" | "sessionHash" | "zpeerAlias" | "zpeerRoomId" | "zpeerActiveRoomId" | "zpeerMemberships">, profileId = resolveZpeerProfileId(repoRoot)): ZpeerLocalProfile {
  const existing = readZpeerLocalProfile(repoRoot, profileId);
  const generatedAlias = generatedAliasForPeer(peer);
  const membershipAlias = activeMembershipAlias(peer);
  const candidateAlias = membershipAlias ?? peer.zpeerAlias;
  const alias = candidateAlias && candidateAlias !== generatedAlias ? candidateAlias : existing?.alias ?? candidateAlias;
  return writeZpeerLocalProfile(repoRoot, { alias, roomId: peer.zpeerRoomId, activeRoomId: peer.zpeerActiveRoomId, memberships: peer.zpeerMemberships }, profileId);
}
