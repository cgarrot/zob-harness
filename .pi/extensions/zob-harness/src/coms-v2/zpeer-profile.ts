import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildZobComsProjectId } from "./identity.js";
import type { ZobLivePeerCard } from "./types.js";
import { sha256 } from "../utils/hashing.js";
import { isRecord } from "../utils/records.js";
import { safeFileStem } from "../utils/paths.js";

const PROFILE_SCHEMA = "zob.zpeer-local-profile.v1";
const FORBIDDEN_PROFILE_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "response", "rationale", "text", "diff", "patch"]);

export interface ZpeerLocalProfile {
  schema: typeof PROFILE_SCHEMA;
  profileId: string;
  projectId: string;
  alias?: string;
  roomId?: string;
  createdAt: string;
  updatedAt: string;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
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
  const comsSession = firstEnvValue(["ZOB_COMS_SESSION_ID"]);
  if (comsSession) return safeFileStem(`coms-${comsSession.value}`).slice(0, 80) || `coms-${sha256(comsSession.value).slice(0, 16)}`;
  const terminalSeed = derivedSessionSeed(repoRoot);
  if (terminalSeed) return `terminal-${sha256(terminalSeed).slice(0, 20)}`;
  return `process-${sha256(`${repoRoot}:${process.pid}:${Date.now()}`).slice(0, 20)}`;
}

function zpeerProfileDir(repoRoot: string): { dir: string; projectId: string } {
  const projectId = buildZobComsProjectId(repoRoot);
  return { dir: join(registryRoot(), "projects", projectId, "zpeer-profiles"), projectId };
}

export function zpeerProfilePath(repoRoot: string, profileId = resolveZpeerProfileId(repoRoot)): string {
  const { dir } = zpeerProfileDir(repoRoot);
  return join(dir, `${safeFileStem(sha256(profileId).slice(0, 32))}.json`);
}

function hasForbiddenProfileKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenProfileKey);
  return Object.entries(value).some(([key, child]) => FORBIDDEN_PROFILE_KEYS.has(key) || hasForbiddenProfileKey(child));
}

function parseZpeerLocalProfile(value: unknown, repoRoot: string): ZpeerLocalProfile | undefined {
  if (!isRecord(value) || value.schema !== PROFILE_SCHEMA) return undefined;
  if (hasForbiddenProfileKey(value) || value.bodyStored !== false || value.localOnly !== true || value.networkEnabled !== false) return undefined;
  if (typeof value.profileId !== "string" || value.projectId !== buildZobComsProjectId(repoRoot)) return undefined;
  if (value.alias !== undefined && typeof value.alias !== "string") return undefined;
  if (value.roomId !== undefined && typeof value.roomId !== "string") return undefined;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return undefined;
  return value as unknown as ZpeerLocalProfile;
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

export function writeZpeerLocalProfile(repoRoot: string, input: { alias?: string; roomId?: string }, profileId = resolveZpeerProfileId(repoRoot)): ZpeerLocalProfile {
  const { dir, projectId } = zpeerProfileDir(repoRoot);
  const existing = readZpeerLocalProfile(repoRoot, profileId);
  const now = new Date().toISOString();
  const profile: ZpeerLocalProfile = {
    schema: PROFILE_SCHEMA,
    profileId,
    projectId,
    alias: input.alias ?? existing?.alias,
    roomId: input.roomId ?? existing?.roomId,
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

export function writeZpeerLocalProfileFromPeer(repoRoot: string, peer: Pick<ZobLivePeerCard, "zpeerAlias" | "zpeerRoomId">, profileId = resolveZpeerProfileId(repoRoot)): ZpeerLocalProfile {
  return writeZpeerLocalProfile(repoRoot, { alias: peer.zpeerAlias, roomId: peer.zpeerRoomId }, profileId);
}
