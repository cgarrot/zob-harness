import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import type { ModeName } from "../../core/types/core.js";
import { MODE_TOOLS } from "../../core/constants.js";
import { safeZpeerAlias, safeZpeerRoomId } from "./coms-v2/zpeer.js";
import { parseJsonFile } from "../../core/utils/json.js";
import { isSafeArtifactName } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

const ZAGENTS_DIR = ".pi/zagents";
const ZTEAMS_DIR = ".pi/zteams";
const ZAGENT_PROMPTS_DIR = ".pi/zagents/prompts";
const ZAGENT_SCHEMA_ID = "zob.zagent.v1";
const ZTEAM_SCHEMA_ID = "zob.zteam.v1";
const ZTEAM_MODE_PACK_SCHEMA_ID = "zob.zteam-modes.v1";
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const ZAGENT_MODE_NAMES = new Set<ModeName>(["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla"]);

export const ZAGENT_MANIFEST_SCHEMA = {
  schema: ZAGENT_SCHEMA_ID,
  storage: { localOnly: true, networkEnabled: false, bodyStored: false },
  required: ["schema", "id", "localOnly", "networkEnabled", "bodyStored"],
} as const;

export const ZTEAM_MANIFEST_SCHEMA = {
  schema: ZTEAM_SCHEMA_ID,
  storage: { localOnly: true, networkEnabled: false, bodyStored: false },
  required: ["schema", "id", "localOnly", "networkEnabled", "bodyStored"],
} as const;

export const ZTEAM_MODE_PACK_SCHEMA = {
  schema: ZTEAM_MODE_PACK_SCHEMA_ID,
  storage: { localOnly: true, networkEnabled: false, bodyStored: false },
  required: ["schema", "teamId", "modes", "localOnly", "networkEnabled", "bodyStored"],
} as const;

export interface ZAgentRoomBinding {
  id: string;
  alias?: string;
  role?: string;
  active?: boolean;
}

export type ZAgentRoomRef = string | ZAgentRoomBinding;

export interface ZAgentContextRef {
  ref: string;
  kind?: string;
  description?: string;
  required?: boolean;
}

export type ZAgentContextRefInput = string | ZAgentContextRef;

export interface ZAgentCommunicationPolicy {
  zpeerContact?: boolean;
  allowZpeerContact?: boolean;
  allowedRooms?: string[];
  allowedAliases?: string[];
  requireActiveRoom?: boolean;
}

export interface ZAgentManifest {
  schema: typeof ZAGENT_SCHEMA_ID;
  id: string;
  team?: string;
  role?: string;
  alias?: string;
  description?: string;
  promptRef?: string;
  defaultRoom?: string;
  activeRoom?: string;
  rooms?: ZAgentRoomRef[];
  communicationPolicy?: ZAgentCommunicationPolicy;
  contextRefs?: ZAgentContextRefInput[];
  model?: string;
  defaultMode?: ModeName;
  tools?: string[];
  metadata?: Record<string, unknown>;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
  promptBodiesStored?: false;
  outputBodiesStored?: false;
}

export interface ZTeamRoomBinding {
  id: string;
  alias?: string;
  role?: string;
  active?: boolean;
}

export type ZTeamRoomRef = string | ZTeamRoomBinding;

export interface ZTeamMemberManifest {
  zagentId: string;
  alias?: string;
  room?: string;
  rooms?: ZAgentRoomRef[];
  role?: string;
  active?: boolean;
  communicationPolicy?: ZAgentCommunicationPolicy;
}

export interface ZTeamAgentManifest extends Omit<ZTeamMemberManifest, "zagentId"> {
  id: string;
}

export interface ZTeamManifest {
  schema: typeof ZTEAM_SCHEMA_ID;
  id: string;
  description?: string;
  defaultRoom?: string;
  activeRoom?: string;
  rooms?: ZTeamRoomRef[];
  members?: ZTeamMemberManifest[];
  agents?: ZTeamAgentManifest[];
  communicationPolicy?: ZAgentCommunicationPolicy;
  metadata?: Record<string, unknown>;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
  promptBodiesStored?: false;
  outputBodiesStored?: false;
}

export interface ZAgentLoaded {
  manifest: ZAgentManifest;
  path: string;
  promptPath?: string;
  errors: string[];
}

export interface ZTeamLoaded {
  manifest: ZTeamManifest;
  path: string;
  errors: string[];
}

export interface ZTeamModePackLoaded {
  modePack?: unknown;
  path?: string;
  ref?: string;
  errors: string[];
}

export interface ZAgentPromptRefResolution {
  ref?: string;
  path?: string;
  exists: boolean;
  errors: string[];
}

export interface ZAgentPromptReadResult extends ZAgentPromptRefResolution {
  body?: string;
}

export interface ZTeamModePackModePolicy {
  allowedTools?: string[];
}

export interface ZTeamModePackPathPolicy {
  forbiddenPaths?: string[];
}

export interface ZTeamModePackMode {
  id: string;
  baseMode: ModeName;
  promptRef?: string;
  allowedTools?: string[];
  toolPolicy?: ZTeamModePackModePolicy;
  pathPolicy?: ZTeamModePackPathPolicy;
  communicationPolicy?: ZAgentCommunicationPolicy;
  forbiddenPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface ZTeamModePackDefaults {
  byAgent?: Record<string, string>;
  byRole?: Record<string, string>;
}

export interface ZTeamModePackManifest {
  schema: typeof ZTEAM_MODE_PACK_SCHEMA_ID;
  teamId: string;
  modes: ZTeamModePackMode[];
  defaults?: ZTeamModePackDefaults;
  metadata?: Record<string, unknown>;
  localOnly: true;
  networkEnabled: false;
  bodyStored: false;
}

export interface ZTeamScopedModePolicy {
  allowedTools: string[];
  allowedToolsExplicit: boolean;
}

export interface ZTeamScopedPathPolicy {
  forbiddenPaths: string[];
}

export type ZTeamScopedModeSource = "explicit" | "env" | "zagentMetadata" | "teamDefaultAgent" | "teamDefaultRole" | "zagentDefaultMode" | "none";

export interface ZTeamScopedModeResolution {
  teamId?: string;
  modeId?: string;
  baseMode?: ModeName;
  promptRef?: string;
  source: ZTeamScopedModeSource;
  toolPolicy: ZTeamScopedModePolicy;
  pathPolicy: ZTeamScopedPathPolicy;
  comsPolicy?: ZAgentCommunicationPolicy;
  errors: string[];
  blockers: string[];
}

export interface ResolveZTeamScopedModeInput {
  repoRoot: string;
  zagent: ZAgentManifest;
  team?: ZTeamManifest;
  modePack?: unknown;
  explicitModeId?: string;
  envModeId?: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isContextRef(value: unknown): value is ZAgentContextRefInput {
  return typeof value === "string" || (isRecord(value)
    && typeof value.ref === "string"
    && (value.kind === undefined || typeof value.kind === "string")
    && (value.description === undefined || typeof value.description === "string")
    && (value.required === undefined || typeof value.required === "boolean"));
}

function isCommunicationPolicy(value: unknown): value is ZAgentCommunicationPolicy {
  return value === undefined || (isRecord(value)
    && (value.zpeerContact === undefined || typeof value.zpeerContact === "boolean")
    && (value.allowZpeerContact === undefined || typeof value.allowZpeerContact === "boolean")
    && (value.allowedRooms === undefined || isStringArray(value.allowedRooms))
    && (value.allowedAliases === undefined || isStringArray(value.allowedAliases))
    && (value.requireActiveRoom === undefined || typeof value.requireActiveRoom === "boolean"));
}

function isRoomBinding(value: unknown): value is ZAgentRoomRef {
  return typeof value === "string" || (isRecord(value)
    && typeof value.id === "string"
    && (value.alias === undefined || typeof value.alias === "string")
    && (value.role === undefined || typeof value.role === "string")
    && (value.active === undefined || typeof value.active === "boolean"));
}

function projectZagentsDir(repoRoot: string): string {
  return join(repoRoot, ZAGENTS_DIR);
}

function projectZteamsDir(repoRoot: string): string {
  return join(repoRoot, ZTEAMS_DIR);
}

function projectZagentPromptsDir(repoRoot: string): string {
  return join(repoRoot, ZAGENT_PROMPTS_DIR);
}

function safeZagentId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !SAFE_ID_PATTERN.test(trimmed) || !isSafeArtifactName(trimmed)) return undefined;
  return trimmed;
}

function pathInside(childPath: string, parentPath: string): boolean {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  return child === parent || child.startsWith(`${parent}/`);
}

function repoLocalPath(repoRoot: string, requestedPath: string): { path?: string; errors: string[] } {
  if (!requestedPath.trim()) return { errors: ["path must not be empty"] };
  if (requestedPath.startsWith("/") || requestedPath.startsWith("~")) return { errors: [`path must be repo-relative: ${requestedPath}`] };
  const root = resolve(repoRoot);
  const resolvedPath = resolve(root, requestedPath);
  if (!pathInside(resolvedPath, root)) return { errors: [`path must stay inside repo root: ${requestedPath}`] };
  return { path: resolvedPath, errors: [] };
}

function normalizePromptRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith(`${ZAGENT_PROMPTS_DIR}/`)) return trimmed;
  if (trimmed.startsWith(".pi/")) return trimmed;
  return `${ZAGENT_PROMPTS_DIR}/${trimmed}`;
}

export function resolveZagentPromptRef(repoRoot: string, promptRef: string | undefined): ZAgentPromptRefResolution {
  if (promptRef === undefined) return { exists: false, errors: [] };
  const normalized = normalizePromptRef(promptRef);
  const resolved = repoLocalPath(repoRoot, normalized);
  const promptRoot = projectZagentPromptsDir(repoRoot);
  const errors = [...resolved.errors];
  if (resolved.path && !pathInside(resolved.path, promptRoot)) errors.push(`promptRef must stay under ${ZAGENT_PROMPTS_DIR}: ${promptRef}`);
  if (resolved.path && !resolved.path.endsWith(".md")) errors.push(`promptRef must point to a markdown file: ${promptRef}`);
  return { ref: normalized, path: resolved.path, exists: Boolean(resolved.path && existsSync(resolved.path)), errors };
}

export function readZagentPrompt(repoRoot: string, promptRef: string | undefined): ZAgentPromptReadResult {
  const resolved = resolveZagentPromptRef(repoRoot, promptRef);
  if (!promptRef || resolved.errors.length > 0 || !resolved.path || !resolved.exists) return resolved;
  try {
    return { ...resolved, body: readFileSync(resolved.path, "utf8") };
  } catch (error) {
    return { ...resolved, errors: [...resolved.errors, `could not read zagent prompt '${resolved.ref ?? promptRef}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function normalizeZagentRoomBindings(rooms: ZAgentRoomRef[] | undefined, defaultRoom?: string, activeRoom?: string): ZAgentRoomBinding[] {
  const bindings: ZAgentRoomBinding[] = [];
  const pushBinding = (binding: ZAgentRoomBinding): void => {
    const id = binding.id.trim();
    if (!id || bindings.some((existing) => existing.id === id && existing.alias === binding.alias && existing.role === binding.role)) return;
    bindings.push({ ...binding, id });
  };
  for (const room of rooms ?? []) {
    if (typeof room === "string") {
      pushBinding({ id: room, active: activeRoom === room });
    } else {
      pushBinding({ ...room, active: room.active ?? activeRoom === room.id });
    }
  }
  if (defaultRoom && !bindings.some((binding) => binding.id === defaultRoom)) pushBinding({ id: defaultRoom, active: activeRoom === defaultRoom });
  if (activeRoom && !bindings.some((binding) => binding.id === activeRoom)) pushBinding({ id: activeRoom, active: true });
  if (!bindings.some((binding) => binding.active) && bindings.length === 1) bindings[0].active = true;
  return bindings;
}

function validateManifestFlags(value: Record<string, unknown>, label: string): string[] {
  const errors: string[] = [];
  if (value.localOnly !== true) errors.push(`${label}.localOnly must be true`);
  if (value.networkEnabled !== false) errors.push(`${label}.networkEnabled must be false`);
  if (value.bodyStored !== false) errors.push(`${label}.bodyStored must be false`);
  if (value.promptBodiesStored !== undefined && value.promptBodiesStored !== false) errors.push(`${label}.promptBodiesStored must be false when present`);
  if (value.outputBodiesStored !== undefined && value.outputBodiesStored !== false) errors.push(`${label}.outputBodiesStored must be false when present`);
  return errors;
}

function validateRoomBindings(rooms: ZAgentRoomRef[] | undefined, label: string): string[] {
  const errors: string[] = [];
  for (const [index, room] of (rooms ?? []).entries()) {
    const binding = typeof room === "string" ? { id: room } : room;
    if (safeZpeerRoomId(binding.id) !== binding.id) errors.push(`${label}[${index}].id must match ZPeer room id rules: ${binding.id}`);
    if (binding.alias !== undefined && safeZpeerAlias(binding.alias) !== binding.alias) errors.push(`${label}[${index}].alias must match ZPeer alias rules: ${binding.alias}`);
  }
  return errors;
}


function safePiModelPattern(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 160) return undefined;
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r") || trimmed.includes("..")) return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return undefined;
  return /^[a-zA-Z0-9._:/+@-]+$/.test(trimmed) ? trimmed : undefined;
}

function isZagentModeName(value: unknown): value is ModeName {
  return typeof value === "string" && ZAGENT_MODE_NAMES.has(value as ModeName);
}

function validateCommunicationPolicy(policy: unknown, label: string): string[] {
  const errors: string[] = [];
  if (policy === undefined) return errors;
  if (!isCommunicationPolicy(policy)) return [`${label} must match communication policy shape`];
  for (const room of policy.allowedRooms ?? []) {
    if (safeZpeerRoomId(room) !== room) errors.push(`${label}.allowedRooms must match ZPeer room id rules: ${room}`);
  }
  for (const alias of policy.allowedAliases ?? []) {
    if (safeZpeerAlias(alias) !== alias) errors.push(`${label}.allowedAliases must match ZPeer alias rules: ${alias}`);
  }
  return errors;
}

function safeStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isZTeamModePackModePolicy(value: unknown): value is ZTeamModePackModePolicy {
  return value === undefined || (isRecord(value)
    && (value.allowedTools === undefined || isStringArray(value.allowedTools)));
}

function isZTeamModePackPathPolicy(value: unknown): value is ZTeamModePackPathPolicy {
  return value === undefined || (isRecord(value)
    && (value.forbiddenPaths === undefined || isStringArray(value.forbiddenPaths)));
}

function isZTeamModePackMode(value: unknown): value is ZTeamModePackMode {
  return isRecord(value)
    && typeof value.id === "string"
    && isZagentModeName(value.baseMode)
    && (value.promptRef === undefined || typeof value.promptRef === "string")
    && (value.allowedTools === undefined || isStringArray(value.allowedTools))
    && isZTeamModePackModePolicy(value.toolPolicy)
    && isZTeamModePackPathPolicy(value.pathPolicy)
    && isCommunicationPolicy(value.communicationPolicy)
    && (value.forbiddenPaths === undefined || isStringArray(value.forbiddenPaths))
    && (value.metadata === undefined || isRecord(value.metadata));
}

function isZTeamModePackDefaults(value: unknown): value is ZTeamModePackDefaults {
  return value === undefined || (isRecord(value)
    && (value.byAgent === undefined || safeStringRecord(value.byAgent))
    && (value.byRole === undefined || safeStringRecord(value.byRole)));
}

function isZTeamModePackManifest(value: unknown): value is ZTeamModePackManifest {
  return isRecord(value)
    && value.schema === ZTEAM_MODE_PACK_SCHEMA_ID
    && typeof value.teamId === "string"
    && Array.isArray(value.modes)
    && value.modes.every(isZTeamModePackMode)
    && isZTeamModePackDefaults(value.defaults)
    && (value.metadata === undefined || isRecord(value.metadata))
    && value.localOnly === true
    && value.networkEnabled === false
    && value.bodyStored === false;
}

function communicationPolicyNarrowingErrors(base: ZAgentCommunicationPolicy | undefined, overlay: ZAgentCommunicationPolicy | undefined, label: string): string[] {
  const errors = validateCommunicationPolicy(overlay, label);
  if (!overlay || errors.length > 0) return errors;
  if (base?.zpeerContact === false && overlay.zpeerContact !== false) errors.push(`${label}.zpeerContact cannot broaden a disabled base policy`);
  if (base?.allowZpeerContact === false && overlay.allowZpeerContact !== false) errors.push(`${label}.allowZpeerContact cannot broaden a disabled base policy`);
  if (base?.requireActiveRoom === true && overlay.requireActiveRoom === false) errors.push(`${label}.requireActiveRoom cannot relax a required active-room policy`);
  if (base?.allowedRooms) {
    for (const room of overlay.allowedRooms ?? []) if (!base.allowedRooms.includes(room)) errors.push(`${label}.allowedRooms must be a subset of the base policy: ${room}`);
  }
  if (base?.allowedAliases) {
    for (const alias of overlay.allowedAliases ?? []) if (!base.allowedAliases.includes(alias)) errors.push(`${label}.allowedAliases must be a subset of the base policy: ${alias}`);
  }
  return errors;
}

function ownerApprovedVanilla(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.ownerApprovedVanilla === true || metadata?.ownerApprovedVanillaMode === true;
}

function modePackAllowedTools(mode: ZTeamModePackMode): string[] | undefined {
  return mode.toolPolicy?.allowedTools ?? mode.allowedTools;
}

function modePackAllowedToolsExplicit(mode: ZTeamModePackMode): boolean {
  return (mode.toolPolicy !== undefined && Object.prototype.hasOwnProperty.call(mode.toolPolicy, "allowedTools"))
    || Object.prototype.hasOwnProperty.call(mode, "allowedTools");
}

function modePackForbiddenPaths(mode: ZTeamModePackMode): string[] {
  return [...new Set([...(mode.pathPolicy?.forbiddenPaths ?? []), ...(mode.forbiddenPaths ?? [])])];
}

export function validateZteamModePack(repoRoot: string, modePack: unknown, team?: ZTeamManifest): string[] {
  const errors: string[] = [];
  if (!isRecord(modePack)) return ["zteam mode pack must be a JSON object"];
  if (!isZTeamModePackManifest(modePack)) errors.push("zteam mode pack must match zob.zteam-modes.v1 shape");
  errors.push(...validateManifestFlags(modePack, "zteamModePack"));
  const teamId = typeof modePack.teamId === "string" ? safeZagentId(modePack.teamId) : undefined;
  if (!teamId) errors.push(`zteamModePack.teamId must be a safe team id: ${String(modePack.teamId)}`);
  if (team && teamId && team.id !== teamId) errors.push(`zteamModePack.teamId '${teamId}' must match zteam.id '${team.id}'`);
  if (!Array.isArray(modePack.modes)) return errors;
  const ids = new Set<string>();
  for (const [index, mode] of modePack.modes.entries()) {
    const label = `zteamModePack.modes[${index}]`;
    if (!isRecord(mode)) {
      errors.push(`${label} must be a JSON object`);
      continue;
    }
    const id = typeof mode.id === "string" ? safeZagentId(mode.id) : undefined;
    if (!id) errors.push(`${label}.id must be a safe scoped mode id: ${String(mode.id)}`);
    if (id && ids.has(id)) errors.push(`${label}.id duplicates another scoped mode: ${id}`);
    if (id) ids.add(id);
    const baseMode = isZagentModeName(mode.baseMode) ? mode.baseMode : undefined;
    if (!baseMode) errors.push(`${label}.baseMode must be a canonical ModeName: ${String(mode.baseMode)}`);
    if (baseMode === "vanilla" && !ownerApprovedVanilla(isRecord(mode.metadata) ? mode.metadata : undefined) && !ownerApprovedVanilla(isRecord(modePack.metadata) ? modePack.metadata : undefined)) {
      errors.push(`${label}.baseMode vanilla requires explicit owner-approved metadata`);
    }
    const allowedTools = isZTeamModePackMode(mode) ? modePackAllowedTools(mode) : undefined;
    if (allowedTools) {
      const baseTools = new Set(baseMode ? MODE_TOOLS[baseMode] : []);
      for (const tool of allowedTools) if (!baseTools.has(tool)) errors.push(`${label}.allowedTools must be a subset of MODE_TOOLS.${String(baseMode)}: ${tool}`);
    }
    if (typeof mode.promptRef === "string") {
      const prompt = resolveZagentPromptRef(repoRoot, mode.promptRef);
      errors.push(...prompt.errors.map((error) => `${label}.${error}`));
      if (!prompt.exists) errors.push(`${label}.promptRef missing: ${prompt.ref ?? mode.promptRef}`);
    }
    if (isZTeamModePackMode(mode)) {
      errors.push(...communicationPolicyNarrowingErrors(team?.communicationPolicy, mode.communicationPolicy, `${label}.communicationPolicy`));
      for (const [pathIndex, forbiddenPath] of modePackForbiddenPaths(mode).entries()) {
        const resolved = repoLocalPath(repoRoot, forbiddenPath);
        if (resolved.errors.length > 0) errors.push(`${label}.forbiddenPaths[${pathIndex}] ${resolved.errors.join("; ")}`);
      }
    }
  }
  const defaults = isRecord(modePack.defaults) ? modePack.defaults : undefined;
  for (const [agentId, modeId] of Object.entries(safeStringRecord(defaults?.byAgent) ? defaults.byAgent : {})) {
    if (!safeZagentId(agentId)) errors.push(`zteamModePack.defaults.byAgent key must be a safe zagent id: ${agentId}`);
    if (!ids.has(modeId)) errors.push(`zteamModePack.defaults.byAgent.${agentId} references missing scoped mode: ${modeId}`);
  }
  for (const [role, modeId] of Object.entries(safeStringRecord(defaults?.byRole) ? defaults.byRole : {})) {
    if (!safeZagentId(role)) errors.push(`zteamModePack.defaults.byRole key must be a safe role id: ${role}`);
    if (!ids.has(modeId)) errors.push(`zteamModePack.defaults.byRole.${role} references missing scoped mode: ${modeId}`);
  }
  return errors;
}

function scopedModeResult(baseMode: ModeName | undefined, source: ZTeamScopedModeSource, errors: string[] = [], blockers: string[] = []): ZTeamScopedModeResolution {
  return { source, baseMode, toolPolicy: { allowedTools: baseMode ? [...MODE_TOOLS[baseMode]] : [], allowedToolsExplicit: false }, pathPolicy: { forbiddenPaths: [] }, errors, blockers };
}

function zagentDefaultTeamMode(zagent: ZAgentManifest): string | undefined {
  const metadata = zagent.metadata;
  if (!metadata) return undefined;
  return typeof metadata.defaultTeamMode === "string" ? metadata.defaultTeamMode : undefined;
}

export function resolveZteamScopedMode(input: ResolveZTeamScopedModeInput): ZTeamScopedModeResolution {
  const baseFallback = scopedModeResult(input.zagent.defaultMode, "zagentDefaultMode");
  if (input.modePack === undefined) return baseFallback;
  const errors = validateZteamModePack(input.repoRoot, input.modePack, input.team);
  if (!isZTeamModePackManifest(input.modePack)) return scopedModeResult(input.zagent.defaultMode, "zagentDefaultMode", errors, errors);
  if (errors.length > 0) return scopedModeResult(input.zagent.defaultMode, "zagentDefaultMode", errors, errors);
  const members = [...(input.team?.members ?? []), ...(input.team?.agents ?? [])];
  const member = members.find((candidate) => zteamMemberAgentId(candidate) === input.zagent.id);
  const role = member?.role ?? input.zagent.role;
  const candidates: Array<{ modeId?: string; source: ZTeamScopedModeSource }> = [
    { modeId: input.explicitModeId, source: "explicit" },
    { modeId: input.envModeId, source: "env" },
    { modeId: zagentDefaultTeamMode(input.zagent), source: "zagentMetadata" },
    { modeId: input.modePack.defaults?.byAgent?.[input.zagent.id], source: "teamDefaultAgent" },
    { modeId: role ? input.modePack.defaults?.byRole?.[role] : undefined, source: "teamDefaultRole" },
  ];
  for (const candidate of candidates) {
    if (!candidate.modeId) continue;
    const mode = input.modePack.modes.find((item) => item.id === candidate.modeId);
    if (!mode) return scopedModeResult(input.zagent.defaultMode, "zagentDefaultMode", [`scoped mode '${candidate.modeId}' not found for source ${candidate.source}`], [`scoped mode '${candidate.modeId}' not found`]);
    const narrowingErrors = [
      ...communicationPolicyNarrowingErrors(input.zagent.communicationPolicy, mode.communicationPolicy, `zteamModePack.modes.${mode.id}.communicationPolicy`),
      ...communicationPolicyNarrowingErrors(member?.communicationPolicy, mode.communicationPolicy, `zteamModePack.modes.${mode.id}.communicationPolicy`),
    ];
    if (narrowingErrors.length > 0) return scopedModeResult(input.zagent.defaultMode, "zagentDefaultMode", narrowingErrors, narrowingErrors);
    return {
      teamId: input.modePack.teamId,
      modeId: mode.id,
      baseMode: mode.baseMode,
      promptRef: mode.promptRef ? resolveZagentPromptRef(input.repoRoot, mode.promptRef).ref : undefined,
      source: candidate.source,
      toolPolicy: { allowedTools: modePackAllowedTools(mode) ?? [...MODE_TOOLS[mode.baseMode]], allowedToolsExplicit: modePackAllowedToolsExplicit(mode) },
      pathPolicy: { forbiddenPaths: modePackForbiddenPaths(mode) },
      comsPolicy: mode.communicationPolicy,
      errors: [],
      blockers: [],
    };
  }
  return baseFallback;
}

function validateActiveRoom(activeRoom: unknown, bindings: ZAgentRoomBinding[], label: string): string[] {
  if (activeRoom === undefined) return [];
  if (typeof activeRoom !== "string") return [`${label}.activeRoom must be a string`];
  if (safeZpeerRoomId(activeRoom) !== activeRoom) return [`${label}.activeRoom must match ZPeer room id rules: ${activeRoom}`];
  if (bindings.length > 0 && !bindings.some((binding) => binding.id === activeRoom)) return [`${label}.activeRoom must be present in rooms/defaultRoom: ${activeRoom}`];
  return [];
}

function isZAgentManifest(value: unknown): value is ZAgentManifest {
  return isRecord(value)
    && value.schema === ZAGENT_SCHEMA_ID
    && typeof value.id === "string"
    && (value.team === undefined || typeof value.team === "string")
    && (value.role === undefined || typeof value.role === "string")
    && (value.alias === undefined || typeof value.alias === "string")
    && (value.description === undefined || typeof value.description === "string")
    && (value.promptRef === undefined || typeof value.promptRef === "string")
    && (value.defaultRoom === undefined || typeof value.defaultRoom === "string")
    && (value.activeRoom === undefined || typeof value.activeRoom === "string")
    && (value.rooms === undefined || (Array.isArray(value.rooms) && value.rooms.every(isRoomBinding)))
    && isCommunicationPolicy(value.communicationPolicy)
    && (value.contextRefs === undefined || (Array.isArray(value.contextRefs) && value.contextRefs.every(isContextRef)))
    && (value.model === undefined || typeof value.model === "string")
    && (value.defaultMode === undefined || isZagentModeName(value.defaultMode))
    && (value.tools === undefined || isStringArray(value.tools))
    && (value.metadata === undefined || isRecord(value.metadata))
    && value.localOnly === true
    && value.networkEnabled === false
    && value.bodyStored === false
    && (value.promptBodiesStored === undefined || value.promptBodiesStored === false)
    && (value.outputBodiesStored === undefined || value.outputBodiesStored === false);
}

function isZTeamMemberManifest(value: unknown): value is ZTeamMemberManifest {
  return isRecord(value)
    && typeof value.zagentId === "string"
    && (value.alias === undefined || typeof value.alias === "string")
    && (value.room === undefined || typeof value.room === "string")
    && (value.rooms === undefined || (Array.isArray(value.rooms) && value.rooms.every(isRoomBinding)))
    && (value.role === undefined || typeof value.role === "string")
    && (value.active === undefined || typeof value.active === "boolean")
    && isCommunicationPolicy(value.communicationPolicy);
}

function isZTeamAgentManifest(value: unknown): value is ZTeamAgentManifest {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.alias === undefined || typeof value.alias === "string")
    && (value.room === undefined || typeof value.room === "string")
    && (value.rooms === undefined || (Array.isArray(value.rooms) && value.rooms.every(isRoomBinding)))
    && (value.role === undefined || typeof value.role === "string")
    && (value.active === undefined || typeof value.active === "boolean")
    && isCommunicationPolicy(value.communicationPolicy);
}

function isZTeamManifest(value: unknown): value is ZTeamManifest {
  return isRecord(value)
    && value.schema === ZTEAM_SCHEMA_ID
    && typeof value.id === "string"
    && (value.description === undefined || typeof value.description === "string")
    && (value.defaultRoom === undefined || typeof value.defaultRoom === "string")
    && (value.activeRoom === undefined || typeof value.activeRoom === "string")
    && (value.rooms === undefined || (Array.isArray(value.rooms) && value.rooms.every(isRoomBinding)))
    && (value.members === undefined || (Array.isArray(value.members) && value.members.every(isZTeamMemberManifest)))
    && (value.agents === undefined || (Array.isArray(value.agents) && value.agents.every(isZTeamAgentManifest)))
    && isCommunicationPolicy(value.communicationPolicy)
    && (value.metadata === undefined || isRecord(value.metadata))
    && value.localOnly === true
    && value.networkEnabled === false
    && value.bodyStored === false
    && (value.promptBodiesStored === undefined || value.promptBodiesStored === false)
    && (value.outputBodiesStored === undefined || value.outputBodiesStored === false);
}

export function validateZagentManifest(repoRoot: string, manifest: unknown, manifestPath?: string): string[] {
  const errors: string[] = [];
  if (!isRecord(manifest)) return ["zagent manifest must be a JSON object"];
  if (!isZAgentManifest(manifest)) errors.push("zagent manifest must match zob.zagent.v1 shape");
  errors.push(...validateManifestFlags(manifest, "zagent"));
  const id = typeof manifest.id === "string" ? safeZagentId(manifest.id) : undefined;
  if (!id) errors.push(`zagent.id must be a safe id: ${String(manifest.id)}`);
  if (manifestPath && id && basename(manifestPath, ".json") !== id) errors.push(`zagent.id '${id}' must match file stem '${basename(manifestPath, ".json")}'`);
  if (typeof manifest.team === "string" && !safeZagentId(manifest.team)) errors.push(`zagent.team must be a safe team id: ${manifest.team}`);
  if (typeof manifest.alias === "string" && safeZpeerAlias(manifest.alias) !== manifest.alias) errors.push(`zagent.alias must match ZPeer alias rules: ${manifest.alias}`);
  if (typeof manifest.defaultRoom === "string" && safeZpeerRoomId(manifest.defaultRoom) !== manifest.defaultRoom) errors.push(`zagent.defaultRoom must match ZPeer room id rules: ${manifest.defaultRoom}`);
  const rooms = Array.isArray(manifest.rooms) && manifest.rooms.every(isRoomBinding) ? manifest.rooms : undefined;
  const bindings = normalizeZagentRoomBindings(rooms, typeof manifest.defaultRoom === "string" ? manifest.defaultRoom : undefined, typeof manifest.activeRoom === "string" ? manifest.activeRoom : undefined);
  errors.push(...validateRoomBindings(rooms, "zagent.rooms"));
  errors.push(...validateActiveRoom(manifest.activeRoom, bindings, "zagent"));
  errors.push(...validateCommunicationPolicy(manifest.communicationPolicy, "zagent.communicationPolicy"));
  if (typeof manifest.model === "string" && safePiModelPattern(manifest.model) !== manifest.model.trim()) {
    errors.push(`zagent.model must be a safe Pi --model pattern: ${manifest.model}`);
  }
  if (manifest.defaultMode !== undefined && !isZagentModeName(manifest.defaultMode)) {
    errors.push(`zagent.defaultMode must be one of ${[...ZAGENT_MODE_NAMES].join(",")}: ${String(manifest.defaultMode)}`);
  }
  if (typeof manifest.promptRef === "string") {
    const prompt = resolveZagentPromptRef(repoRoot, manifest.promptRef);
    errors.push(...prompt.errors);
    if (!prompt.exists) errors.push(`zagent.promptRef missing: ${prompt.ref ?? manifest.promptRef}`);
  }
  return errors;
}

function zteamMemberAgentId(member: ZTeamMemberManifest | ZTeamAgentManifest): string {
  return "zagentId" in member ? member.zagentId : member.id;
}

function zteamMemberRooms(member: ZTeamMemberManifest | ZTeamAgentManifest, defaultRoom?: string): ZAgentRoomBinding[] {
  const rooms = member.rooms ?? (member.room ? [member.room] : undefined);
  return normalizeZagentRoomBindings(rooms, defaultRoom, undefined);
}

export function validateZteamManifest(repoRoot: string, manifest: unknown, manifestPath?: string): string[] {
  const errors: string[] = [];
  if (!isRecord(manifest)) return ["zteam manifest must be a JSON object"];
  if (!isZTeamManifest(manifest)) errors.push("zteam manifest must match zob.zteam.v1 shape");
  errors.push(...validateManifestFlags(manifest, "zteam"));
  const id = typeof manifest.id === "string" ? safeZagentId(manifest.id) : undefined;
  if (!id) errors.push(`zteam.id must be a safe id: ${String(manifest.id)}`);
  if (manifestPath && id && basename(manifestPath, ".json") !== id) errors.push(`zteam.id '${id}' must match file stem '${basename(manifestPath, ".json")}'`);
  if (typeof manifest.defaultRoom === "string" && safeZpeerRoomId(manifest.defaultRoom) !== manifest.defaultRoom) errors.push(`zteam.defaultRoom must match ZPeer room id rules: ${manifest.defaultRoom}`);
  const teamRooms = Array.isArray(manifest.rooms) && manifest.rooms.every(isRoomBinding) ? manifest.rooms : undefined;
  const teamBindings = normalizeZagentRoomBindings(teamRooms, typeof manifest.defaultRoom === "string" ? manifest.defaultRoom : undefined, typeof manifest.activeRoom === "string" ? manifest.activeRoom : undefined);
  errors.push(...validateRoomBindings(teamRooms, "zteam.rooms"));
  errors.push(...validateActiveRoom(manifest.activeRoom, teamBindings, "zteam"));
  errors.push(...validateCommunicationPolicy(manifest.communicationPolicy, "zteam.communicationPolicy"));
  const members = [
    ...(Array.isArray(manifest.members) ? manifest.members.filter(isZTeamMemberManifest) : []),
    ...(Array.isArray(manifest.agents) ? manifest.agents.filter(isZTeamAgentManifest) : []),
  ];
  if (members.length === 0) errors.push("zteam.members or zteam.agents must contain at least one agent");
  const memberKeys = new Set<string>();
  for (const [index, member] of members.entries()) {
    const label = `zteam.agents[${index}]`;
    const zagentId = safeZagentId(zteamMemberAgentId(member));
    if (!zagentId) {
      errors.push(`${label}.id must be a safe zagent id: ${String(zteamMemberAgentId(member))}`);
    } else if (!existsSync(zagentManifestPath(repoRoot, zagentId))) {
      errors.push(`${label}.id references missing project-local zagent: ${zagentId}`);
    }
    if (typeof member.alias === "string" && safeZpeerAlias(member.alias) !== member.alias) errors.push(`${label}.alias must match ZPeer alias rules: ${member.alias}`);
    if (typeof member.room === "string" && safeZpeerRoomId(member.room) !== member.room) errors.push(`${label}.room must match ZPeer room id rules: ${member.room}`);
    errors.push(...validateRoomBindings(member.rooms, `${label}.rooms`));
    errors.push(...validateCommunicationPolicy(member.communicationPolicy, `${label}.communicationPolicy`));
    const memberRooms = zteamMemberRooms(member, typeof manifest.defaultRoom === "string" ? manifest.defaultRoom : undefined);
    const key = `${zagentId ?? String(zteamMemberAgentId(member))}:${memberRooms.map((room) => room.id).join(",")}:${member.alias ?? ""}`;
    if (memberKeys.has(key)) errors.push(`${label} duplicates another agent binding`);
    memberKeys.add(key);
  }
  return errors;
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

export function zagentManifestPath(repoRoot: string, id: string): string {
  return join(projectZagentsDir(repoRoot), `${safeZagentId(id) ?? "__invalid__"}.json`);
}

export function zteamManifestPath(repoRoot: string, id: string): string {
  return join(projectZteamsDir(repoRoot), `${safeZagentId(id) ?? "__invalid__"}.json`);
}

export function loadZagentManifest(repoRoot: string, id: string): ZAgentLoaded {
  const path = zagentManifestPath(repoRoot, id);
  const idErrors = safeZagentId(id) ? [] : [`invalid zagent id: ${id}`];
  try {
    const parsed = parseJsonFile(path);
    const errors = validateZagentManifest(repoRoot, parsed, path);
    const prompt = isRecord(parsed) && typeof parsed.promptRef === "string" ? resolveZagentPromptRef(repoRoot, parsed.promptRef) : undefined;
    return { manifest: parsed as ZAgentManifest, path, promptPath: prompt?.path, errors: [...idErrors, ...errors] };
  } catch (error) {
    return { manifest: { schema: ZAGENT_SCHEMA_ID, id, localOnly: true, networkEnabled: false, bodyStored: false }, path, errors: [...idErrors, `could not load zagent '${id}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function loadZteamManifest(repoRoot: string, id: string): ZTeamLoaded {
  const path = zteamManifestPath(repoRoot, id);
  const idErrors = safeZagentId(id) ? [] : [`invalid zteam id: ${id}`];
  try {
    const parsed = parseJsonFile(path);
    return { manifest: parsed as ZTeamManifest, path, errors: [...idErrors, ...validateZteamManifest(repoRoot, parsed, path)] };
  } catch (error) {
    return { manifest: { schema: ZTEAM_SCHEMA_ID, id, members: [], localOnly: true, networkEnabled: false, bodyStored: false }, path, errors: [...idErrors, `could not load zteam '${id}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function zteamModePackRef(team: ZTeamManifest): string | undefined {
  const ref = isRecord(team.metadata) ? team.metadata.modePackRef : undefined;
  return typeof ref === "string" && ref.trim().length > 0 ? ref.trim() : undefined;
}

function normalizeZteamModePackRef(ref: string): string {
  if (ref.startsWith(`${ZTEAMS_DIR}/`)) return ref;
  if (ref.startsWith(".pi/")) return ref;
  return `${ZTEAMS_DIR}/${ref}`;
}

function modePackRefLooksForbidden(ref: string): boolean {
  return ref.split(/[\\/]+/).some((part) => {
    const lower = part.toLowerCase();
    return lower === ".env" || lower.includes("secret") || lower.includes("key");
  });
}

export function loadZteamModePack(repoRoot: string, team: ZTeamManifest): ZTeamModePackLoaded {
  const ref = zteamModePackRef(team);
  if (!ref) return { errors: [] };
  const normalized = normalizeZteamModePackRef(ref);
  const resolved = repoLocalPath(repoRoot, normalized);
  const errors = [...resolved.errors];
  if (modePackRefLooksForbidden(normalized)) errors.push(`zteam.metadata.modePackRef must not reference secret/key/env paths: ${ref}`);
  if (resolved.path && !pathInside(resolved.path, projectZteamsDir(repoRoot))) errors.push(`zteam.metadata.modePackRef must stay under ${ZTEAMS_DIR}: ${ref}`);
  if (resolved.path && !resolved.path.endsWith(".json")) errors.push(`zteam.metadata.modePackRef must point to a JSON file: ${ref}`);
  if (errors.length > 0 || !resolved.path) return { ref: normalized, path: resolved.path, errors };
  try {
    const parsed = parseJsonFile(resolved.path);
    return { modePack: parsed, ref: normalized, path: resolved.path, errors: validateZteamModePack(repoRoot, parsed, team) };
  } catch (error) {
    return { ref: normalized, path: resolved.path, errors: [`could not load zteam mode pack '${normalized}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function listZagentManifests(repoRoot: string): ZAgentLoaded[] {
  return listJsonFiles(projectZagentsDir(repoRoot)).map((path) => loadZagentManifest(repoRoot, basename(path, ".json")));
}

export function listZteamManifests(repoRoot: string): ZTeamLoaded[] {
  return listJsonFiles(projectZteamsDir(repoRoot)).map((path) => loadZteamManifest(repoRoot, basename(path, ".json")));
}

export interface ZAgentResolvedTeamMembership {
  teamId: string;
  alias?: string;
  role?: string;
  rooms: ZAgentRoomBinding[];
}

function zteamMemberMatchesZagent(member: ZTeamMemberManifest | ZTeamAgentManifest, zagentId: string): boolean {
  return zteamMemberAgentId(member) === zagentId;
}

export function resolveZagentTeamMemberships(repoRoot: string, zagentId: string): ZAgentResolvedTeamMembership[] {
  const memberships: ZAgentResolvedTeamMembership[] = [];
  for (const loaded of listZteamManifests(repoRoot)) {
    if (loaded.errors.length > 0) continue;
    const teamRooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
    const members = [...(loaded.manifest.members ?? []), ...(loaded.manifest.agents ?? [])];
    for (const member of members) {
      if (!zteamMemberMatchesZagent(member, zagentId)) continue;
      const memberRooms = zteamMemberRooms(member, loaded.manifest.defaultRoom);
      const rooms = memberRooms.length > 0 ? memberRooms : teamRooms;
      memberships.push({
        teamId: loaded.manifest.id,
        alias: member.alias,
        role: member.role,
        rooms,
      });
    }
  }
  return memberships;
}

export function resolveZagentRuntimeRoomBindings(repoRoot: string, manifest: ZAgentManifest): { rooms: ZAgentRoomBinding[]; teamIds: string[] } {
  const byRoom = new Map<string, ZAgentRoomBinding>();
  const pushRoom = (room: ZAgentRoomBinding, defaults: { alias?: string; role?: string } = {}): void => {
    const id = safeZpeerRoomId(room.id);
    if (!id) return;
    const existing = byRoom.get(id);
    byRoom.set(id, {
      ...existing,
      ...room,
      id,
      alias: existing?.alias ?? room.alias ?? defaults.alias,
      role: existing?.role ?? room.role ?? defaults.role,
      active: existing?.active === true || room.active === true,
    });
  };

  for (const room of normalizeZagentRoomBindings(manifest.rooms, manifest.defaultRoom, manifest.activeRoom)) pushRoom(room, { alias: manifest.alias });
  const teamIds = new Set<string>(manifest.team ? [manifest.team] : []);
  for (const membership of resolveZagentTeamMemberships(repoRoot, manifest.id)) {
    teamIds.add(membership.teamId);
    for (const room of membership.rooms) pushRoom(room, { alias: membership.alias ?? manifest.alias, role: membership.role });
  }
  const rooms = [...byRoom.values()];
  return { rooms, teamIds: [...teamIds] };
}

function policyAllowsZpeerContact(policy: ZAgentCommunicationPolicy | undefined, roomId?: string, alias?: string): boolean {
  if (!policy) return true;
  if (policy.zpeerContact === false || policy.allowZpeerContact === false) return false;
  if (roomId && policy.allowedRooms && !policy.allowedRooms.includes(roomId)) return false;
  if (alias && policy.allowedAliases && !policy.allowedAliases.includes(alias)) return false;
  if (policy.requireActiveRoom && !roomId) return false;
  return true;
}

export function zteamAllowsZpeerContact(team: ZTeamManifest, zagentId: string, roomId?: string, alias?: string): boolean {
  if (!policyAllowsZpeerContact(team.communicationPolicy, roomId, alias)) return false;
  const members = [
    ...(team.members ?? []),
    ...(team.agents ?? []),
  ];
  const member = members.find((candidate) => zteamMemberAgentId(candidate) === zagentId || candidate.alias === alias);
  if (!member) return false;
  if (!policyAllowsZpeerContact(member.communicationPolicy, roomId, alias ?? member.alias)) return false;
  const rooms = zteamMemberRooms(member, team.defaultRoom);
  if (roomId && rooms.length > 0 && !rooms.some((room) => room.id === roomId)) return false;
  return true;
}

export function formatZagentList(agents: ZAgentLoaded[]): string {
  if (agents.length === 0) return "No project-local ZAgents found.";
  return agents.map(({ manifest, path, promptPath, errors }) => {
    const relPath = relative(process.cwd(), path);
    const relPrompt = promptPath ? ` prompt=${relative(process.cwd(), promptPath)}` : "";
    const alias = manifest.alias ? ` @${manifest.alias}` : "";
    const role = manifest.role ? ` role=${manifest.role}` : "";
    const team = manifest.team ? ` team=${manifest.team}` : "";
    const mode = manifest.defaultMode ? ` defaultMode=${manifest.defaultMode}` : "";
    const rooms = normalizeZagentRoomBindings(manifest.rooms, manifest.defaultRoom, manifest.activeRoom);
    const roomText = rooms.length ? ` rooms=${rooms.map((room) => `${room.id}${room.active ? "*" : ""}`).join(",")}` : "";
    const status = errors.length === 0 ? "ok" : `errors=${errors.length}`;
    return `- ${manifest.id}${alias} [${status}]${team}${role}${mode}${roomText}${relPrompt} path=${relPath}`;
  }).join("\n");
}

export function formatZteamList(teams: ZTeamLoaded[]): string {
  if (teams.length === 0) return "No project-local ZTeams found.";
  return teams.map(({ manifest, path, errors }) => {
    const relPath = relative(process.cwd(), path);
    const rooms = normalizeZagentRoomBindings(manifest.rooms, manifest.defaultRoom, manifest.activeRoom);
    const roomText = rooms.length ? ` rooms=${rooms.map((room) => `${room.id}${room.active ? "*" : ""}`).join(",")}` : "";
    const memberCount = (manifest.members?.length ?? 0) + (manifest.agents?.length ?? 0);
    const status = errors.length === 0 ? "ok" : `errors=${errors.length}`;
    return `- ${manifest.id} [${status}] agents=${memberCount}${roomText} path=${relPath}`;
  }).join("\n");
}

export {
  projectZagentPromptsDir,
  projectZagentsDir,
  projectZteamsDir,
  safeZagentId,
};
