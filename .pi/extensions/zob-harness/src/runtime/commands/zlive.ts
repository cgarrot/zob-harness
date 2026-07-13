import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { MODE_TOOLS } from "../../core/constants.js";
import type { ModeName } from "../../types.js";
import { formatZagentList, formatZteamList, listZagentManifests, listZteamManifests, loadZagentManifest, loadZteamManifest, loadZteamModePack, normalizeZagentRoomBindings, readZagentPrompt, resolveZagentRuntimeRoomBindings, resolveZteamScopedMode, safeZagentId, validateZagentManifest, validateZteamManifest, zagentManifestPath, zteamManifestPath, type ZAgentManifest, type ZAgentRoomBinding, type ZTeamAgentManifest, type ZTeamManifest, type ZTeamMemberManifest } from "../../domains/coms/zagents.js";
import { sha256 } from "../../core/utils/hashing.js";
import { writeZpeerLocalProfileFromPeer } from "../../domains/coms/coms-v2/zpeer-profile.js";
import { buildZpeerRoomSummary, changeZpeerAlias, changeZpeerRoom, clearZpeerRoom, joinZpeerRoom, leaveZpeerRoom, peerAliasInRoom, refreshZpeerSelf, safeZpeerAlias, safeZpeerRoomId, sendZpeerPrompt, useZpeerRoom, zpeerMembershipsForPeer, type ZpeerSendMode } from "../../domains/coms/coms-v2/zpeer.js";
import type { ZpeerInterruptMode, ZpeerInterruptPriority, ZpeerInterruptStatus } from "../../domains/coms/coms-v2/envelope.js";
import { sendZobLocalEnvelope } from "../../domains/coms/coms-v2/local-transport.js";
import { buildZobLiveResponseEnvelope } from "../../domains/coms/coms-v2/response-capture.js";
import { readZobLiveRegistryAllProjectsSnapshot } from "../../domains/coms/coms-v2/registry.js";
import { loadActiveZagentScopedMode } from "../events.js";
import { resolveRuleProfile } from "../../domains/governance/rules.js";
import type { HarnessRuntimeState } from "../state.js";
import { applyMode, renderHarnessWidget } from "../widget.js";
import { recordZpeerRuntimeEvent } from "../zpeer-events.js";

function zpeerCommandProfileId(ctx: ExtensionCommandContext): string {
  const sessionIdentity = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
  return `session-${sha256(sessionIdentity).slice(0, 24)}`;
}
function zagentArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const ids = listZagentManifests(process.cwd()).map((agent) => agent.manifest.id).filter(Boolean);
  const items: AutocompleteItem[] = [
    { value: "list", label: "list", description: "list project-local ZAgents" },
    ...ids.flatMap((id) => [
      { value: `show ${id}`, label: `show ${id}`, description: "show manifest metadata" },
      { value: `use ${id}`, label: `use ${id}`, description: "load ZAgent and apply ZPeer profile" },
    ]),
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function zteamArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const ids = listZteamManifests(process.cwd()).map((team) => team.manifest.id).filter(Boolean);
  const items: AutocompleteItem[] = [
    { value: "list", label: "list", description: "list project-local ZTeams" },
    { value: "hot-add ", label: "hot-add [team-id] <natural-language ask>", description: "plan-only ZAgent/ZTeam hot-add; infers current team when omitted; no spawn" },
    { value: "hot-add ", label: "hot-add [team-id] <ask> --apply --confirm <team-id>", description: "apply manifest edits only after exact owner confirmation" },
    { value: "reset", label: "reset", description: "send Pi /new to current team tmux windows" },
    { value: "reset --dry-run", label: "reset --dry-run", description: "preview current-team /new fanout without tmux/spawn" },
    { value: "reload", label: "reload", description: "send Pi /reload to current team tmux windows" },
    { value: "reload --dry-run", label: "reload --dry-run", description: "preview current-team /reload fanout without tmux/spawn" },
    { value: "quit", label: "quit", description: "close current team tmux session through its scoped launcher" },
    { value: "quit --dry-run", label: "quit --dry-run", description: "preview current-team tmux close without executing" },
    ...ids.flatMap((id) => [
      { value: `show ${id}`, label: `show ${id}`, description: "show team manifest metadata" },
      { value: `launch-plan ${id}`, label: `launch-plan ${id}`, description: "print full-session launch commands" },
      { value: `hot-add ${id} `, label: `hot-add ${id} <ask>`, description: "plan-only natural-language ZAgent/ZTeam hot-add" },
      { value: `hot-add ${id}  --apply --confirm ${id}`, label: `hot-add ${id} <ask> --apply --confirm ${id}`, description: "apply hot-add manifests; still no spawn" },
      { value: `hot-add-presence ${id} `, label: `hot-add-presence ${id} <zagent-id>`, description: "check local lease/registry presence after manual launch" },
      { value: `reset ${id}`, label: `reset ${id}`, description: "send Pi /new to every existing team tmux agent window" },
      { value: `reset ${id} --dry-run`, label: `reset ${id} --dry-run`, description: "preview the /new fanout plan without tmux/spawn" },
      { value: `reset-plan ${id}`, label: `reset-plan ${id}`, description: "alias for reset --dry-run" },
      { value: `reload ${id}`, label: `reload ${id}`, description: "send Pi /reload to every existing team tmux agent window" },
      { value: `reload ${id} --dry-run`, label: `reload ${id} --dry-run`, description: "preview the /reload fanout plan without tmux/spawn" },
      { value: `reload-plan ${id}`, label: `reload-plan ${id}`, description: "alias for reload --dry-run" },
      { value: `quit ${id}`, label: `quit ${id}`, description: "close only this team tmux session" },
      { value: `quit ${id} --dry-run`, label: `quit ${id} --dry-run`, description: "preview the scoped tmux close without executing" },
      { value: `quit-plan ${id}`, label: `quit-plan ${id}`, description: "alias for quit --dry-run" },
    ]),
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function zagentLedgerEntry(action: string, input: { id?: string; teamId?: string; status: "ok" | "blocked"; roomIds?: string[]; alias?: string; path?: string; promptRef?: string; promptBody?: string; errors?: string[] }): Record<string, unknown> {
  return {
    schema: "zob.zagent-command.v1",
    action,
    status: input.status,
    idHash: input.id ? sha256(input.id) : undefined,
    teamIdHash: input.teamId ? sha256(input.teamId) : undefined,
    aliasHash: input.alias ? sha256(input.alias) : undefined,
    roomIdHashes: (input.roomIds ?? []).map((roomId) => sha256(roomId)),
    pathHash: input.path ? sha256(input.path) : undefined,
    promptRefHash: input.promptRef ? sha256(input.promptRef) : undefined,
    promptHash: input.promptBody ? sha256(input.promptBody) : undefined,
    errorHashes: (input.errors ?? []).map((error) => sha256(error)),
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function formatZagentShow(loaded: ReturnType<typeof loadZagentManifest>): string {
  const rooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
  return [
    `ZAgent ${loaded.manifest.id}`,
    `path: ${loaded.path}`,
    `status: ${loaded.errors.length === 0 ? "ok" : `blocked (${loaded.errors.length} error${loaded.errors.length === 1 ? "" : "s"})`}`,
    loaded.manifest.description ? `description: ${loaded.manifest.description}` : undefined,
    loaded.manifest.team ? `team: ${loaded.manifest.team}` : undefined,
    loaded.manifest.role ? `role: ${loaded.manifest.role}` : undefined,
    loaded.manifest.alias ? `alias: @${loaded.manifest.alias}` : undefined,
    loaded.manifest.defaultMode ? `defaultMode: ${loaded.manifest.defaultMode}` : undefined,
    rooms.length ? `rooms: ${rooms.map((room) => `${room.id}${room.alias ? `@${room.alias}` : ""}${room.active ? "*" : ""}`).join(", ")}` : "rooms: none",
    loaded.manifest.promptRef ? `promptRef: ${loaded.manifest.promptRef}` : "promptRef: none",
    loaded.promptPath ? `promptPath: ${loaded.promptPath}` : undefined,
    loaded.errors.length ? `errors:\n- ${loaded.errors.join("\n- ")}` : undefined,
    "safety: project-local, localOnly=true, networkEnabled=false, bodyStored=false",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatZteamShow(loaded: ReturnType<typeof loadZteamManifest>): string {
  const rooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
  const members = zteamMembers(loaded.manifest);
  return [
    `ZTeam ${loaded.manifest.id}`,
    `path: ${loaded.path}`,
    `status: ${loaded.errors.length === 0 ? "ok" : `blocked (${loaded.errors.length} error${loaded.errors.length === 1 ? "" : "s"})`}`,
    loaded.manifest.description ? `description: ${loaded.manifest.description}` : undefined,
    rooms.length ? `rooms: ${rooms.map((room) => `${room.id}${room.active ? "*" : ""}`).join(", ")}` : "rooms: none",
    `agents: ${members.map((member) => member.id).join(", ") || "none"}`,
    loaded.errors.length ? `errors:\n- ${loaded.errors.join("\n- ")}` : undefined,
    "safety: launch-plan only; commands are printed, not spawned",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function normalizeZpeerRole(role: string | undefined): "member" | "bridge" | "observer" {
  return role === "bridge" || role === "observer" ? role : "member";
}

async function applyZagentToZpeer(repoRoot: string, peer: NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]>, manifest: ZAgentManifest): Promise<{ ok: true; peer: NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]> } | { ok: false; reason: string; peer: NonNullable<HarnessRuntimeState["zobLive"]["peerCard"]> }> {
  let current = refreshZpeerSelf(repoRoot, peer);
  const rooms = resolveZagentRuntimeRoomBindings(repoRoot, manifest).rooms;
  if (rooms.length === 0 && manifest.alias) {
    const changed = await changeZpeerAlias(repoRoot, current, manifest.alias);
    if (!changed.ok) return { ok: false, reason: changed.reason, peer: current };
    current = changed.peer;
  }
  for (const room of rooms) {
    const joined = await joinZpeerRoom(repoRoot, current, room.id, room.alias ?? manifest.alias, normalizeZpeerRole(room.role));
    if (!joined.ok) return { ok: false, reason: joined.reason, peer: current };
    current = joined.peer;
  }
  const activeRoom = rooms.find((room) => room.active)?.id ?? manifest.activeRoom ?? manifest.defaultRoom;
  if (activeRoom) {
    const used = useZpeerRoom(repoRoot, current, activeRoom);
    if (!used.ok) return { ok: false, reason: used.reason, peer: current };
    current = used.peer;
  }
  return { ok: true, peer: current };
}

function zteamMemberId(member: ZTeamMemberManifest | ZTeamAgentManifest): string {
  return "zagentId" in member ? member.zagentId : member.id;
}

function zteamMembers(team: ZTeamManifest): Array<{ id: string; alias?: string; room?: string; rooms?: ZAgentRoomBinding[]; role?: string; active?: boolean }> {
  const rawMembers = [...(team.members ?? []), ...(team.agents ?? [])];
  return rawMembers.map((member) => ({
    id: zteamMemberId(member),
    alias: member.alias,
    room: member.room,
    rooms: normalizeZagentRoomBindings(member.rooms ?? (member.room ? [member.room] : undefined), team.defaultRoom, member.active ? (member.room ?? team.activeRoom) : undefined),
    role: member.role,
    active: member.active,
  }));
}

function safeLaunchPlanModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 160) return undefined;
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r") || trimmed.includes("..")) return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return undefined;
  return /^[a-zA-Z0-9._:/+@-]+$/.test(trimmed) ? trimmed : undefined;
}

function zteamModePackModes(modePack: unknown): Array<{ id: string; baseMode: string }> {
  if (!modePack || typeof modePack !== "object") return [];
  const modes = (modePack as { modes?: unknown }).modes;
  if (!Array.isArray(modes)) return [];
  return modes.flatMap((mode) => {
    if (!mode || typeof mode !== "object") return [];
    const candidate = mode as { id?: unknown; baseMode?: unknown };
    return typeof candidate.id === "string" && typeof candidate.baseMode === "string" ? [{ id: candidate.id, baseMode: candidate.baseMode }] : [];
  });
}

function zteamLaunchPlanText(repoRoot: string, team: ZTeamManifest): { text: string; roomIds: string[]; agentIds: string[]; modelIds: string[]; defaultModes: string[]; scopedModeIds: string[]; modePackRef?: string } {
  const teamRooms = normalizeZagentRoomBindings(team.rooms, team.defaultRoom, team.activeRoom).map((room) => room.id);
  const members = zteamMembers(team);
  const roomIds = [...new Set([...teamRooms, ...members.flatMap((member) => (member.rooms ?? []).map((room) => room.id))])];
  const agentIds = members.map((member) => member.id);
  const loadedAgents = members.map((member) => ({ member, loaded: loadZagentManifest(repoRoot, member.id) }));
  const loadedModePack = loadZteamModePack(repoRoot, team);
  const scopedModes = zteamModePackModes(loadedModePack.modePack);
  const scopedModeIds = scopedModes.map((mode) => mode.id);
  const modelIds = [...new Set(loadedAgents.map(({ loaded }) => safeLaunchPlanModel(loaded.manifest.model)).filter((model): model is string => Boolean(model)))];
  const defaultModes = [...new Set(loadedAgents.map(({ loaded }) => loaded.manifest.defaultMode).filter((mode): mode is ModeName => Boolean(mode)))];
  const lines = [
    `# ZTeam launch-plan: ${team.id}`,
    "No processes spawned. spawn-count=0. Copy/paste each command in a separate terminal when approved.",
    `Team env: ZOB_ZTEAM_ID=${team.id}`,
    loadedModePack.ref ? `Mode pack: modePackRef=${loadedModePack.ref}${loadedModePack.errors.length ? ` blocked_errors=${loadedModePack.errors.length}` : ""}` : "Mode pack: none",
    scopedModes.length ? `Scoped modes available: ${scopedModes.map((mode) => `${mode.id}->baseMode=${mode.baseMode}`).join(", ")}` : "Scoped modes available: none",
    scopedModes.length ? "Scoped mode selection: set ZOB_ZTEAM_MODE_ID=<mode-id> or ZOB_ZTEAM_MODE=<mode-id> before manual launch; no sessions are spawned by this plan." : undefined,
    "",
    ...loadedAgents.map(({ member, loaded }) => {
      const rawModel = loaded.manifest.model;
      const model = safeLaunchPlanModel(rawModel);
      const defaultMode = loaded.manifest.defaultMode;
      const scoped = resolveZteamScopedMode({ repoRoot, zagent: loaded.manifest, team, modePack: loadedModePack.modePack });
      const effectiveScoped = scoped.teamId && scoped.modeId && scoped.baseMode ? `${scoped.modeId}@${scoped.teamId}` : "none";
      const effectiveBaseMode = scoped.baseMode ?? defaultMode;
      const rooms = (member.rooms ?? []).map((room) => `${room.id}${room.active ? "*" : ""}`).join(", ") || teamRooms.join(", ") || "default";
      const alias = member.alias ? ` alias=@${member.alias}` : "";
      const modelArg = model ? ` --model ${model}` : "";
      const modelNote = rawModel ? (model ? ` model=${model}` : " model=invalid_omitted") : "";
      const modeNote = defaultMode ? ` defaultMode=${defaultMode}` : "";
      const scopedNote = ` scopedMode=${effectiveScoped} baseMode=${effectiveBaseMode ?? "current"}`;
      return `ZOB_ZTEAM_ID=${team.id} ZOB_ZAGENT_ID=${member.id} pi${modelArg}    # expected_rooms=${rooms}${alias}${modelNote}${modeNote}${scopedNote}`;
    }),
    "",
    `Expected rooms: ${roomIds.join(", ") || "default"}`,
    modelIds.length ? `Models: ${modelIds.join(", ")}` : "Models: default Pi model unless each ZAgent manifest sets a safe model",
    defaultModes.length ? `Default modes: ${defaultModes.join(", ")}` : "Default modes: restored/current ZOB mode unless each ZAgent manifest sets defaultMode",
    loadedModePack.errors.length ? `Mode pack blockers:\n- ${loadedModePack.errors.join("\n- ")}` : undefined,
    "After each session starts, run /zagent use <id> to bind its ZPeer alias/rooms.",
  ].filter((line): line is string => Boolean(line));
  return { text: lines.join("\n"), roomIds, agentIds, modelIds, defaultModes, scopedModeIds, modePackRef: loadedModePack.ref };
}

const HOT_ADD_MODE_NAMES = new Set<ModeName>(["explore", "plan", "implement", "oracle", "factory", "orchestrator"]);
const HOT_ADD_STOP_WORDS = new Set(["add", "agent", "zagent", "team", "zteam", "hot", "new", "a", "an", "the", "to", "for", "with", "and", "or", "that", "who", "can", "should", "please", "need", "needs"]);
const HOT_ADD_FORBIDDEN_PATHS = [".env", ".env.*", "~/.ssh", "~/.aws", "*.pem", "*.key", ".git", "node_modules", "dist", "build"] as const;
const HOT_ADD_TOOL_PREFS: Partial<Record<ModeName, string[]>> = {
  explore: ["read", "grep", "find", "ls", "zob_context_search", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list"],
  plan: ["read", "grep", "find", "ls", "zob_context_search", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list", "get_goal", "get_goal_todos"],
  implement: ["read", "grep", "find", "ls", "edit", "write", "bash", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list", "get_goal", "get_goal_todos"],
  oracle: ["read", "grep", "find", "ls", "bash", "zob_context_search", "zpeer_ask", "zob_goal_room_list", "get_goal", "get_goal_todos"],
  factory: ["read", "grep", "find", "ls", "bash", "edit", "write", "factory_run", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list"],
  orchestrator: ["read", "grep", "find", "ls", "delegate_agent", "delegate_task", "get_goal", "get_goal_todos", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list"],
};

type ZteamHotAddTeamSource = "explicit" | "env" | "zagent" | "zpeer" | "activeRoom" | "repoConvention" | "unresolved";

type ZteamHotAddOptions = {
  execute: boolean;
  confirm?: string;
  launchWindow: boolean;
  launchConfirm?: string;
  id?: string;
  alias?: string;
  role?: string;
  room?: string;
  mode?: ModeName;
};

type ZteamHotAddPlan = {
  teamId: string;
  teamSource: ZteamHotAddTeamSource;
  teamPath: string;
  zagentPath: string;
  promptRef: string;
  promptPath: string;
  promptBody: string;
  requestHash: string;
  agentId: string;
  alias: string;
  role: string;
  purpose: string;
  scope: string;
  tools: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  roomId: string;
  roomIds: string[];
  defaultMode: ModeName;
  execute: boolean;
  confirmMatched: boolean;
  launchWindowRequested: boolean;
  launchWindowApproved: boolean;
  spawnCount: 0;
  tmuxSession?: string;
  tmuxWindowCommand?: string;
  manualLaunchCommand: string;
  presenceCheckCommand: string;
  existingAgent: boolean;
  existingPrompt: boolean;
  existingMember: boolean;
  presenceRegistry: "user_runtime" | "env_override";
  presenceCounts: { online: number; stale: number; offline: number };
  proposedPresenceStatus: "none" | "online" | "stale" | "offline";
  activeLeaseCount: number;
  errors: string[];
  agentManifest: ZAgentManifest;
  teamManifest: ZTeamManifest;
};

type ZteamHotAddPresencePlan = {
  teamId: string;
  agentId: string;
  registry: "user_runtime" | "env_override";
  status: "none" | "online" | "stale" | "offline";
  peerCount: number;
  online: number;
  stale: number;
  offline: number;
  leaseEvidenceOnly: true;
  tmuxWindowCountsAsPresence: false;
  bodyStored: false;
};

function safeHotAddMode(value: string | undefined): ModeName | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return HOT_ADD_MODE_NAMES.has(trimmed as ModeName) ? trimmed as ModeName : undefined;
}

function parseZteamHotAddArgs(repoRoot: string, parts: string[]): { id?: string; requestText: string; options: ZteamHotAddOptions; errors: string[] } {
  const errors: string[] = [];
  const maybeId = parts[1];
  const id = maybeId && !maybeId.startsWith("--") && projectZteamManifestExists(repoRoot, maybeId) ? maybeId : undefined;
  const requestParts: string[] = [];
  const options: ZteamHotAddOptions = { execute: false, launchWindow: false };
  const readValue = (index: number, flag: string): { value?: string; nextIndex: number } => {
    const value = parts[index + 1];
    if (!value || value.startsWith("--")) {
      errors.push(`${flag} requires a value`);
      return { nextIndex: index };
    }
    return { value, nextIndex: index + 1 };
  };
  for (let index = id ? 2 : 1; index < parts.length; index += 1) {
    const part = parts[index];
    const setMode = (value: string | undefined): void => {
      const mode = safeHotAddMode(value);
      if (mode) options.mode = mode;
      else if (value) errors.push(`--mode must be one of ${[...HOT_ADD_MODE_NAMES].join(",")}: ${value}`);
    };
    if (part === "--apply" || part === "--execute") {
      options.execute = true;
      continue;
    }
    if (part === "--plan" || part === "--dry-run") {
      options.execute = false;
      continue;
    }
    if (part === "--tmux-window" || part === "--launch-window") {
      options.launchWindow = true;
      continue;
    }
    if (part === "--confirm") {
      const read = readValue(index, part);
      options.confirm = read.value;
      index = read.nextIndex;
      continue;
    }
    if (part === "--launch-confirm") {
      const read = readValue(index, part);
      options.launchConfirm = read.value;
      index = read.nextIndex;
      continue;
    }
    if (part === "--id") {
      const read = readValue(index, part);
      options.id = read.value;
      index = read.nextIndex;
      continue;
    }
    if (part.startsWith("--id=")) {
      options.id = part.slice("--id=".length);
      continue;
    }
    if (part === "--alias") {
      const read = readValue(index, part);
      options.alias = read.value;
      index = read.nextIndex;
      continue;
    }
    if (part.startsWith("--alias=")) {
      options.alias = part.slice("--alias=".length);
      continue;
    }
    if (part === "--role") {
      const read = readValue(index, part);
      options.role = read.value;
      index = read.nextIndex;
      continue;
    }
    if (part.startsWith("--role=")) {
      options.role = part.slice("--role=".length);
      continue;
    }
    if (part === "--room") {
      const read = readValue(index, part);
      options.room = read.value;
      index = read.nextIndex;
      continue;
    }
    if (part.startsWith("--room=")) {
      options.room = part.slice("--room=".length);
      continue;
    }
    if (part === "--mode") {
      const read = readValue(index, part);
      setMode(read.value);
      index = read.nextIndex;
      continue;
    }
    if (part.startsWith("--mode=")) {
      setMode(part.slice("--mode=".length));
      continue;
    }
    if (part.startsWith("--")) {
      errors.push(`unknown hot-add option: ${part}`);
      continue;
    }
    requestParts.push(part);
  }
  const requestText = requestParts.join(" ").trim();
  if (!requestText) errors.push("hot-add requires a natural-language ask; raw ask bodies are hashed and not stored in durable command records");
  return { id, requestText, options, errors };
}

function hotAddSlugFromText(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((word) => word && !HOT_ADD_STOP_WORDS.has(word)).slice(0, 4);
  const slug = words.join("-").replace(/^-+|-+$/g, "");
  return slug || "agent";
}

function inferHotAddMode(text: string): ModeName {
  const lower = text.toLowerCase();
  if (/\b(oracle|review|verify|validation|qa|security|audit|no-ship|noship)\b/.test(lower)) return "oracle";
  if (/\b(factory|repeatable|pipeline|workflow|batch|smoke)\b/.test(lower)) return "factory";
  if (/\b(implement|implementation|build|code|patch|fix|edit|write)\b/.test(lower)) return "implement";
  if (/\b(chief|lead|orchestrate|coordinate|coordinator|dispatch)\b/.test(lower)) return "orchestrator";
  if (/\b(plan|planner|spec|architect|design|strategy)\b/.test(lower)) return "plan";
  return "explore";
}

function hotAddRoleFromText(text: string, mode: ModeName, explicitRole?: string): string {
  const explicit = explicitRole ? hotAddSlugFromText(explicitRole).slice(0, 48) : undefined;
  if (explicit && explicit !== "agent") return explicit;
  const slug = hotAddSlugFromText(text).split("-").slice(0, 3).join("-").slice(0, 48);
  if (slug && slug !== "agent") return slug;
  if (mode === "oracle") return "oracle-reviewer";
  if (mode === "implement") return "implementer";
  if (mode === "factory") return "factory-worker";
  if (mode === "orchestrator") return "coordinator";
  if (mode === "plan") return "planner";
  return "explorer";
}

function zteamAllRoomIds(team: ZTeamManifest): string[] {
  return [...new Set([
    ...normalizeZagentRoomBindings(team.rooms, team.defaultRoom, team.activeRoom).map((room) => room.id),
    ...zteamMembers(team).flatMap((member) => (member.rooms ?? []).map((room) => room.id)),
  ])];
}

function resolveZteamHotAddTeamId(repoRoot: string, state: HarnessRuntimeState, explicitId: string | undefined): { id?: string; source: ZteamHotAddTeamSource; errors: string[] } {
  if (explicitId) return { id: explicitId, source: "explicit", errors: [] };
  const envTeam = process.env.ZOB_ZTEAM_ID?.trim();
  if (projectZteamManifestExists(repoRoot, envTeam)) return { id: envTeam, source: "env", errors: [] };
  if (projectZteamManifestExists(repoRoot, state.zagent.team)) return { id: state.zagent.team, source: "zagent", errors: [] };
  if (projectZteamManifestExists(repoRoot, state.zobLive.peerCard?.team)) return { id: state.zobLive.peerCard?.team, source: "zpeer", errors: [] };

  const activeZagentTeams = [...new Set(state.zagent.teams ?? [])].filter((teamId) => projectZteamManifestExists(repoRoot, teamId));
  if (activeZagentTeams.length === 1) return { id: activeZagentTeams[0], source: "zagent", errors: [] };

  const activeRoom = state.zobLive.peerCard?.zpeerActiveRoomId ?? state.zobLive.peerCard?.zpeerRoomId ?? state.zagent.activeRoom;
  const validTeams = listZteamManifests(repoRoot).filter((team) => team.errors.length === 0);
  if (activeRoom) {
    const roomMatches = validTeams.filter((team) => zteamAllRoomIds(team.manifest).includes(activeRoom));
    if (roomMatches.length === 1) return { id: roomMatches[0].manifest.id, source: "activeRoom", errors: [] };
  }

  const ownerLaunchTeams = validTeams.filter((team) => team.manifest.metadata?.ownerLaunchRequired === true);
  if (ownerLaunchTeams.length === 1) return { id: ownerLaunchTeams[0].manifest.id, source: "repoConvention", errors: [] };
  const nonTemporaryTeams = validTeams.filter((team) => team.manifest.metadata?.temporaryRunTeam !== true && !/\bdemo\b/i.test(team.manifest.description ?? ""));
  if (nonTemporaryTeams.length === 1) return { id: nonTemporaryTeams[0].manifest.id, source: "repoConvention", errors: [] };
  if (validTeams.length === 1) return { id: validTeams[0].manifest.id, source: "repoConvention", errors: [] };

  const candidates = [...new Set([envTeam, state.zagent.team, state.zobLive.peerCard?.team, ...activeZagentTeams].filter((teamId): teamId is string => Boolean(teamId)))];
  const conventionIds = validTeams.map((team) => team.manifest.id);
  return {
    source: "unresolved",
    errors: [
      candidates.length ? `hot-add omitted team id but current-context candidates were not uniquely usable (${candidates.join(",")})` : "hot-add omitted team id and no current ZTeam context was found",
      conventionIds.length ? `repo convention fallback is ambiguous; use explicit <team-id> (available: ${conventionIds.join(",")})` : "no valid project-local ZTeam manifests are available for repo convention fallback",
    ],
  };
}

function chooseHotAddRoom(team: ZTeamManifest, requestText: string, explicitRoom: string | undefined, errors: string[]): { roomId: string; roomIds: string[] } {
  const roomIds = zteamAllRoomIds(team);
  const explicit = explicitRoom ? safeZpeerRoomId(explicitRoom) : undefined;
  if (explicitRoom && !explicit) errors.push(`--room must be a safe ZPeer room id: ${explicitRoom}`);
  const mentioned = roomIds.find((roomId) => requestText.toLowerCase().includes(roomId.toLowerCase()));
  const roomId = explicit ?? mentioned ?? team.activeRoom ?? team.defaultRoom ?? roomIds[0] ?? "default";
  if (!safeZpeerRoomId(roomId)) errors.push(`hot-add selected room is not a safe ZPeer room id: ${roomId}`);
  if (roomIds.length > 0 && !roomIds.includes(roomId)) errors.push(`hot-add room must be one of existing zteam rooms (${roomIds.join(",")}): ${roomId}`);
  return { roomId, roomIds: roomIds.length ? roomIds : [roomId] };
}

function zteamWithHotAddedMember(team: ZTeamManifest, input: { agentId: string; alias: string; role: string; roomId: string }): ZTeamManifest {
  const roomBinding: ZAgentRoomBinding = { id: input.roomId, alias: input.alias, role: input.role, active: true };
  if (Array.isArray(team.members) && !Array.isArray(team.agents)) {
    const member: ZTeamMemberManifest = { zagentId: input.agentId, alias: input.alias, rooms: [roomBinding], role: input.role, active: true, communicationPolicy: { zpeerContact: true, allowedRooms: [input.roomId], allowedAliases: [input.alias], requireActiveRoom: true } };
    return { ...team, members: [...team.members, member] };
  }
  const agent: ZTeamAgentManifest = { id: input.agentId, alias: input.alias, rooms: [roomBinding], role: input.role, active: true, communicationPolicy: { zpeerContact: true, allowedRooms: [input.roomId], allowedAliases: [input.alias], requireActiveRoom: true } };
  return { ...team, agents: [...(team.agents ?? []), agent] };
}

function hotAddToolsForMode(mode: ModeName): string[] {
  const allowed = new Set(MODE_TOOLS[mode] ?? []);
  const preferred = HOT_ADD_TOOL_PREFS[mode] ?? ["read", "grep", "find", "ls"];
  return [...new Set(preferred.filter((tool) => allowed.has(tool)))];
}

function hotAddAllowedPathsForMode(mode: ModeName): string[] {
  const base = [".pi/zagents", ".pi/zteams", "reports"];
  if (mode === "implement" || mode === "factory") return [...base, "scripts", ".pi/extensions", ".pi/factories"];
  if (mode === "orchestrator") return [...base, ".pi/agents", ".pi/prompts", ".pi/skills"];
  return base;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeTmuxWindowName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "zagent";
}

function buildManualLaunchCommand(teamId: string, agentId: string): string {
  return `ZOB_ZTEAM_ID=${teamId} ZOB_ZAGENT_ID=${agentId} pi`;
}

function buildHotAddTmuxWindowCommand(repoRoot: string, team: ZTeamManifest, agentId: string): { session?: string; command?: string } {
  const session = typeof team.metadata?.tmuxSession === "string" && safeZagentId(team.metadata.tmuxSession) === team.metadata.tmuxSession ? team.metadata.tmuxSession : team.id;
  if (!safeZagentId(session)) return {};
  const window = safeTmuxWindowName(agentId);
  const launchId = `hot-add-${sha256(`${team.id}:${agentId}`).slice(0, 12)}`;
  const profileId = `zteam-${safeTmuxWindowName(team.id)}-${safeTmuxWindowName(agentId)}`;
  const launchCommand = `cd ${shellQuote(repoRoot)} && ZOB_ZTEAM_ID=${shellQuote(team.id)} ZOB_ZTEAM_BUNDLE_ID=${shellQuote(team.id)} ZOB_ZTEAM_LAUNCH_ID=${shellQuote(launchId)} ZOB_ZPEER_PROFILE_ID=${shellQuote(profileId)} ZOB_ZAGENT_ID=${shellQuote(agentId)} pi`;
  return { session, command: `tmux new-window -t ${shellQuote(session)} -n ${shellQuote(window)} ${shellQuote(launchCommand)}` };
}

function buildHotAddPrompt(input: { teamId: string; agentId: string; alias: string; role: string; purpose: string; scope: string; defaultMode: ModeName; roomId: string; tools: string[]; allowedPaths: string[]; forbiddenPaths: string[]; requestHash: string; presenceCheckCommand: string }): string {
  return [
    `# ZAgent ${input.agentId}`,
    "",
    "You are a full Pi session tied to ZPeer/live coordination, not a delegated subagent.",
    `Purpose: ${input.purpose}`,
    `Scope: ${input.scope}`,
    `Team/room: ${input.teamId} / ${input.roomId} as @${input.alias}.`,
    `Default ZOB mode: ${input.defaultMode}.`,
    `Request hash: ${input.requestHash}. Raw owner request body is intentionally not stored in this prompt or ledgers.`,
    "",
    "Allowed tools:",
    ...input.tools.map((tool) => `- ${tool}`),
    "",
    "Allowed paths:",
    ...input.allowedPaths.map((path) => `- ${path}`),
    "",
    "Forbidden paths/patterns:",
    ...input.forbiddenPaths.map((path) => `- ${path}`),
    "",
    "Owner approval gates:",
    "- Launch: owner must manually launch this full Pi session; no automatic spawn.",
    "- Writes: require explicit owner/task approval and bounded paths before editing.",
    "- External access: disabled unless owner gives explicit approval for a bounded adapter/browser/web task.",
    "- Commit/push/tag: forbidden unless owner explicitly requests governed zcommit behavior.",
    "- Escalation: report blockers/no_ship rather than expanding authority silently.",
    "",
    "Presence subflow:",
    `- After manual launch, verify local lease/registry evidence only with: ${input.presenceCheckCommand}`,
    "- A tmux window is not presence proof; only an online/stale team-agent lease/registry card is evidence.",
    "",
    "Final report format:",
    "- result",
    "- evidence refs / validation commands",
    "- risks or blockers",
    "- no_ship status",
  ].join("\n");
}

function buildZteamHotAddPresencePlan(repoRoot: string, teamId: string, agentId: string): ZteamHotAddPresencePlan {
  const snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, teamId);
  const peer = snapshot.peers.find((candidate) => candidate.team === teamId && candidate.roleId === agentId);
  return {
    teamId,
    agentId,
    registry: snapshot.registry,
    status: peer?.status ?? "none",
    peerCount: snapshot.peers.length,
    online: snapshot.counts.online,
    stale: snapshot.counts.stale,
    offline: snapshot.counts.offline,
    leaseEvidenceOnly: true,
    tmuxWindowCountsAsPresence: false,
    bodyStored: false,
  };
}

function formatZteamHotAddPresencePlan(plan: ZteamHotAddPresencePlan): string {
  return [
    `# ZTeam hot-add presence check: ${plan.teamId}/${plan.agentId}`,
    "evidence source: local lease/registry only via readZobLiveRegistryAllProjectsSnapshot",
    `registry=${plan.registry}`,
    `status=${plan.status}`,
    `peerCount=${plan.peerCount}`,
    `online=${plan.online} stale=${plan.stale} offline=${plan.offline}`,
    "tmux window counts as presence: false",
    "bodyStored=false",
  ].join("\n");
}

function zteamHotAddPresenceLedgerEntry(plan: ZteamHotAddPresencePlan): Record<string, unknown> {
  return {
    schema: "zob.zteam-hot-add-presence.v1",
    teamIdHash: sha256(plan.teamId),
    agentIdHash: sha256(plan.agentId),
    registry: plan.registry,
    status: plan.status,
    peerCount: plan.peerCount,
    online: plan.online,
    stale: plan.stale,
    offline: plan.offline,
    leaseEvidenceOnly: true,
    tmuxWindowCountsAsPresence: false,
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function buildZteamHotAddPlan(repoRoot: string, team: ZTeamManifest, teamSource: ZteamHotAddTeamSource, requestText: string, options: ZteamHotAddOptions, manifestErrors: string[]): ZteamHotAddPlan {
  const errors = [...manifestErrors];
  const requestHash = sha256(requestText);
  const explicitAgentId = options.id ? safeZagentId(options.id) : undefined;
  if (options.id && !explicitAgentId) errors.push(`--id must be a safe ZAgent id: ${options.id}`);
  const slug = hotAddSlugFromText(requestText).slice(0, 48).replace(/-+$/g, "") || "agent";
  const generatedAgentId = safeZagentId(`hot-${slug}-${requestHash.slice(0, 8)}`) ?? `hot-agent-${requestHash.slice(0, 8)}`;
  const agentId = explicitAgentId ?? generatedAgentId;
  const explicitAlias = options.alias ? safeZpeerAlias(options.alias) : undefined;
  if (options.alias && !explicitAlias) errors.push(`--alias must be a safe ZPeer alias: ${options.alias}`);
  const aliasBase = agentId.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z]+/, "agent_").slice(0, 32);
  const alias = explicitAlias ?? safeZpeerAlias(aliasBase) ?? `agent_${requestHash.slice(0, 8)}`;
  const defaultMode = options.mode ?? inferHotAddMode(requestText);
  const role = hotAddRoleFromText(requestText, defaultMode, options.role);
  const room = chooseHotAddRoom(team, requestText, options.room, errors);
  const zagentPath = zagentManifestPath(repoRoot, agentId);
  const teamPath = zteamManifestPath(repoRoot, team.id);
  const promptRef = `.pi/zagents/prompts/${agentId}.md`;
  const promptPath = resolve(repoRoot, promptRef);
  const existingAgent = existsSync(zagentPath);
  const existingPrompt = existsSync(promptPath);
  const existingMember = zteamMembers(team).some((member) => member.id === agentId);
  if (existingAgent) errors.push(`hot-add would overwrite existing zagent manifest: ${agentId}`);
  if (existingPrompt) errors.push(`hot-add would overwrite existing zagent prompt: ${promptRef}`);
  if (existingMember) errors.push(`hot-add would duplicate existing zteam member: ${agentId}`);
  const snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, team.id);
  const proposedPeer = snapshot.peers.find((peer) => peer.team === team.id && peer.roleId === agentId);
  const proposedPresenceStatus = proposedPeer?.status ?? "none";
  if (proposedPresenceStatus === "online" || proposedPresenceStatus === "stale") {
    errors.push(`local lease/registry evidence shows ${team.id}/${agentId} already has ${proposedPresenceStatus} presence; choose a different --id or inspect leases first`);
  }
  const confirmMatched = options.confirm === team.id;
  if (options.execute && !confirmMatched) errors.push(`apply requires explicit confirmation: --apply --confirm ${team.id}`);
  const launchWindowApproved = options.launchWindow && options.launchConfirm === team.id;
  if (options.launchWindow && !launchWindowApproved) errors.push(`optional tmux window launch requires explicit approval: --tmux-window --launch-confirm ${team.id}`);
  const tools = hotAddToolsForMode(defaultMode);
  const allowedPaths = hotAddAllowedPathsForMode(defaultMode);
  const forbiddenPaths = [...HOT_ADD_FORBIDDEN_PATHS];
  const purpose = `Hot-added ${role} ZAgent for ${team.id}; derived from owner request hash ${requestHash.slice(0, 12)} without storing the raw request body.`;
  const scope = `Operate only in room ${room.roomId}, use explicit tools/paths, and report blockers instead of expanding authority.`;
  const manualLaunchCommand = buildManualLaunchCommand(team.id, agentId);
  const presenceCheckCommand = `/zteam hot-add-presence ${team.id} ${agentId}`;
  const tmux = options.launchWindow ? buildHotAddTmuxWindowCommand(repoRoot, team, agentId) : {};
  const promptBody = buildHotAddPrompt({ teamId: team.id, agentId, alias, role, purpose, scope, defaultMode, roomId: room.roomId, tools, allowedPaths, forbiddenPaths, requestHash, presenceCheckCommand });
  const agentManifest: ZAgentManifest = {
    schema: "zob.zagent.v1",
    id: agentId,
    team: team.id,
    role,
    alias,
    description: purpose,
    promptRef,
    defaultRoom: room.roomId,
    activeRoom: room.roomId,
    rooms: [{ id: room.roomId, alias, role, active: true }],
    communicationPolicy: { zpeerContact: true, allowedRooms: [room.roomId], allowedAliases: [alias], requireActiveRoom: true },
    contextRefs: [
      { ref: zteamManifestPath(repoRoot, team.id).replace(`${resolve(repoRoot)}${sep}`, ""), kind: "zteam-manifest", description: "Parent ZTeam manifest", required: true },
      { ref: ".pi/skills/zob-zagent-creator/SKILL.md", kind: "skill", description: "ZAgent/ZTeam safety and launch rules", required: true },
    ],
    defaultMode,
    tools,
    metadata: {
      purpose,
      scope,
      allowedPaths,
      forbiddenPaths,
      approvalGates: {
        launch: "Manual owner-approved full Pi session launch only; no automatic spawn.",
        writes: "Writes require explicit owner/task approval and bounded paths.",
        externalAccess: "External/browser/web/cloud access disabled unless explicitly approved for a bounded task.",
        commit: "Commit/push/tag forbidden unless owner explicitly requests governed zcommit.",
        escalation: "Report blocker/no_ship rather than broadening authority silently.",
      },
      verification: {
        launchPresenceCommand: presenceCheckCommand,
        evidenceSource: "local lease/registry only",
        tmuxWindowCountsAsPresence: false,
      },
      hotAdd: {
        schema: "zob.zteam-hot-add.v1",
        teamIdHash: sha256(team.id),
        requestHash,
        sourceCommand: "/zteam hot-add",
        teamSource,
        ownerApprovalRequired: true,
        manualLaunchOnly: true,
        spawnCount: 0,
        bodyStored: false,
      },
    },
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const teamManifest = zteamWithHotAddedMember(team, { agentId, alias, role, roomId: room.roomId });
  errors.push(...validateZagentManifest(repoRoot, agentManifest, zagentPath).filter((error) => !error.startsWith("zagent.promptRef missing:")));
  errors.push(...validateZteamManifest(repoRoot, teamManifest, teamPath).filter((error) => !error.includes(`references missing project-local zagent: ${agentId}`)));
  return {
    teamId: team.id,
    teamSource,
    teamPath,
    zagentPath,
    promptRef,
    promptPath,
    promptBody,
    requestHash,
    agentId,
    alias,
    role,
    purpose,
    scope,
    tools,
    allowedPaths,
    forbiddenPaths,
    roomId: room.roomId,
    roomIds: room.roomIds,
    defaultMode,
    execute: options.execute,
    confirmMatched,
    launchWindowRequested: options.launchWindow,
    launchWindowApproved,
    spawnCount: 0,
    tmuxSession: tmux.session,
    tmuxWindowCommand: tmux.command,
    manualLaunchCommand,
    presenceCheckCommand,
    existingAgent,
    existingPrompt,
    existingMember,
    presenceRegistry: snapshot.registry,
    presenceCounts: snapshot.counts,
    proposedPresenceStatus,
    activeLeaseCount: snapshot.counts.online + snapshot.counts.stale,
    errors: [...new Set(errors)],
    agentManifest,
    teamManifest,
  };
}

function formatZteamHotAddPlan(plan: ZteamHotAddPlan): string {
  return [
    `# ZTeam hot-add plan: ${plan.teamId}`,
    `team source: ${plan.teamSource}`,
    `execute=${String(plan.execute)}`,
    `apply planned: ${String(plan.execute)}`,
    `confirmMatched=${String(plan.confirmMatched)}`,
    `spawn-count=${plan.spawnCount}`,
    `requestHash=${plan.requestHash}`,
    `agent id: ${plan.agentId}`,
    `alias: @${plan.alias}`,
    `role: ${plan.role}`,
    `purpose: ${plan.purpose}`,
    `scope: ${plan.scope}`,
    `room: ${plan.roomId}`,
    `defaultMode: ${plan.defaultMode}`,
    `tools: ${plan.tools.join(", ") || "none"}`,
    `allowed paths: ${plan.allowedPaths.join(", ")}`,
    `forbidden paths: ${plan.forbiddenPaths.join(", ")}`,
    `would write prompt: ${plan.promptPath}`,
    `would write zagent: ${plan.zagentPath}`,
    `would update zteam: ${plan.teamPath}`,
    `presence evidence: local lease/registry snapshot via readZobLiveRegistryAllProjectsSnapshot; registry=${plan.presenceRegistry}; bodyStored=false`,
    `presence counts: online=${plan.presenceCounts.online} stale=${plan.presenceCounts.stale} offline=${plan.presenceCounts.offline} activeLeaseCount=${plan.activeLeaseCount}`,
    `proposed agent presence: ${plan.proposedPresenceStatus}`,
    `presence check after manual launch: ${plan.presenceCheckCommand}`,
    "presence rule: tmux window is not presence proof; only local lease/registry evidence counts",
    `tmux window requested: ${String(plan.launchWindowRequested)}`,
    `tmux window launch approved: ${String(plan.launchWindowApproved)} (hot-add never launches tmux/pi automatically)`,
    plan.launchWindowRequested && plan.tmuxWindowCommand ? `tmux-window plan command (manual only): ${plan.tmuxWindowCommand}` : "tmux-window plan command: request with --tmux-window --launch-confirm <team-id>",
    `manual launch command after owner approval: ${plan.manualLaunchCommand}`,
    "default behavior: plan-only/no-spawn; apply requires --apply --confirm <team-id>; optional tmux window requires --tmux-window --launch-confirm <team-id>; raw natural-language ask is not stored in durable ledgers",
    plan.errors.length ? `blocked/errors:\n- ${plan.errors.join("\n- ")}` : "status: ready",
  ].join("\n");
}

function zteamHotAddLedgerEntry(action: string, plan: ZteamHotAddPlan, status: "ok" | "blocked", extraErrors: string[] = []): Record<string, unknown> {
  return {
    schema: "zob.zteam-hot-add-command.v1",
    action,
    status,
    teamIdHash: sha256(plan.teamId),
    teamSource: plan.teamSource,
    agentIdHash: sha256(plan.agentId),
    aliasHash: sha256(plan.alias),
    roleHash: sha256(plan.role),
    roomIdHashes: [plan.roomId, ...plan.roomIds].map((roomId) => sha256(roomId)),
    promptRefHash: sha256(plan.promptRef),
    toolHashes: plan.tools.map((tool) => sha256(tool)),
    allowedPathHashes: plan.allowedPaths.map((path) => sha256(path)),
    forbiddenPathHashes: plan.forbiddenPaths.map((path) => sha256(path)),
    requestHash: plan.requestHash,
    execute: plan.execute,
    dryRun: !plan.execute,
    confirmMatched: plan.confirmMatched,
    launchWindowRequested: plan.launchWindowRequested,
    launchWindowApproved: plan.launchWindowApproved,
    tmuxWindowPlanHash: plan.tmuxWindowCommand ? sha256(plan.tmuxWindowCommand) : undefined,
    presenceCheckCommandHash: sha256(plan.presenceCheckCommand),
    spawnCount: plan.spawnCount,
    existingAgent: plan.existingAgent,
    existingPrompt: plan.existingPrompt,
    existingMember: plan.existingMember,
    presenceRegistry: plan.presenceRegistry,
    presenceCounts: plan.presenceCounts,
    proposedPresenceStatus: plan.proposedPresenceStatus,
    errorHashes: [...plan.errors, ...extraErrors].map((error) => sha256(error)),
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

function applyZteamHotAddPlan(repoRoot: string, plan: ZteamHotAddPlan): { ok: boolean; errors: string[]; writtenPaths: string[] } {
  if (plan.errors.length > 0) return { ok: false, errors: plan.errors, writtenPaths: [] };
  const writtenPaths: string[] = [];
  try {
    mkdirSync(dirname(plan.promptPath), { recursive: true });
    mkdirSync(dirname(plan.zagentPath), { recursive: true });
    mkdirSync(dirname(plan.teamPath), { recursive: true });
    writeFileSync(plan.promptPath, `${plan.promptBody}\n`, "utf8");
    writtenPaths.push(plan.promptPath);
    writeFileSync(plan.zagentPath, `${JSON.stringify(plan.agentManifest, null, 2)}\n`, "utf8");
    writtenPaths.push(plan.zagentPath);
    writeFileSync(plan.teamPath, `${JSON.stringify(plan.teamManifest, null, 2)}\n`, "utf8");
    writtenPaths.push(plan.teamPath);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], writtenPaths };
  }
  const validationErrors = [...loadZagentManifest(repoRoot, plan.agentId).errors, ...loadZteamManifest(repoRoot, plan.teamId).errors];
  return { ok: validationErrors.length === 0, errors: validationErrors, writtenPaths };
}

type ZteamTmuxAction = "reset" | "reload" | "quit";
type ZteamLauncherAction = "new" | "reload" | "close";

type ZteamTmuxActionPlan = {
  teamId: string;
  source: "explicit" | "current";
  requestedAction: ZteamTmuxAction;
  launcherAction?: ZteamLauncherAction;
  launcherRef?: string;
  launcherPath?: string;
  session?: string;
  entryAgent?: string;
  agentIds: string[];
  roomIds: string[];
  errors: string[];
  execute: boolean;
  confirmMatched: boolean;
  spawnCount: number;
  closePlanned: boolean;
  leaseCleanupPlanned: boolean;
  leaseCleanupAgentIds: string[];
  startPlanned: boolean;
  startAction?: "start-detached" | "start";
  newPlanned: boolean;
  reloadPlanned: boolean;
  quitPlanned: boolean;
};

type ZteamTmuxActionOptions = { execute: boolean; confirm?: string };

function zteamLauncherActionFor(action: ZteamTmuxAction): ZteamLauncherAction {
  if (action === "reset") return "new";
  if (action === "reload") return "reload";
  return "close";
}

function zteamActionInputDescription(action: ZteamTmuxAction): string {
  if (action === "reset") return "/new";
  if (action === "reload") return "/reload";
  return "scoped tmux close";
}

function parseZteamTmuxActionArgs(parts: string[], action: ZteamTmuxAction): { id?: string; options: ZteamTmuxActionOptions; errors: string[] } {
  const errors: string[] = [];
  const maybeId = parts[1];
  const id = maybeId && !maybeId.startsWith("--") ? maybeId : undefined;
  let execute = true;
  let confirm: string | undefined;
  for (let index = id ? 2 : 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "--dry-run" || part === "--plan") {
      execute = false;
      continue;
    }
    if (part === "--execute") {
      execute = true;
      continue;
    }
    if (part === "--confirm") {
      const value = parts[index + 1];
      if (!value || value.startsWith("--")) errors.push("--confirm requires the exact team id when provided");
      else {
        confirm = value;
        index += 1;
      }
      continue;
    }
    errors.push(`unknown ${action} option: ${part}`);
  }
  return { id, options: { execute, confirm }, errors };
}

function projectZteamManifestExists(repoRoot: string, id: string | undefined): id is string {
  if (!id || safeZagentId(id) !== id) return false;
  return existsSync(resolve(repoRoot, ".pi/zteams", `${id}.json`));
}

function resolveCurrentZteamId(repoRoot: string, state: HarnessRuntimeState): { id?: string; source: "current"; errors: string[] } {
  const primaryCandidates = [
    { id: state.zagent.team, source: "zagent.team" },
    { id: state.zobLive.peerCard?.team, source: "zpeer.team" },
    { id: process.env.ZOB_ZTEAM_ID?.trim() || undefined, source: "ZOB_ZTEAM_ID" },
  ];
  for (const candidate of primaryCandidates) {
    if (projectZteamManifestExists(repoRoot, candidate.id)) return { id: candidate.id, source: "current", errors: [] };
  }

  const zagentTeams = [...new Set(state.zagent.teams ?? [])].filter((id): id is string => Boolean(id));
  if (zagentTeams.length === 1 && projectZteamManifestExists(repoRoot, zagentTeams[0])) {
    return { id: zagentTeams[0], source: "current", errors: [] };
  }
  if (zagentTeams.length > 1) {
    return { source: "current", errors: [`current ZAgent belongs to multiple teams (${zagentTeams.join(", ")}); use /zteam <action> <team-id>`] };
  }

  const seenCandidates = [...new Set([...primaryCandidates.map((candidate) => candidate.id), ...zagentTeams].filter((id): id is string => Boolean(id)))];
  if (seenCandidates.length > 0) {
    return { source: "current", errors: [`current session team candidates have no project ZTeam manifest (${seenCandidates.join(", ")}); use /zteam <action> <team-id>`] };
  }
  return { source: "current", errors: ["current session is not bound to a ZTeam; use /zagent use <id> or /zteam <action> <team-id>"] };
}

function resolveZteamCommandTeamId(repoRoot: string, state: HarnessRuntimeState, explicitId: string | undefined): { id?: string; source: "explicit" | "current"; errors: string[] } {
  if (explicitId) return { id: explicitId, source: "explicit", errors: [] };
  return resolveCurrentZteamId(repoRoot, state);
}

function safeZteamLauncher(repoRoot: string, team: ZTeamManifest): { ref?: string; path?: string; errors: string[] } {
  const raw = team.metadata?.tmuxLauncher;
  const errors: string[] = [];
  if (typeof raw !== "string" || !raw.trim()) return { errors: ["zteam.metadata.tmuxLauncher is required for scoped tmux actions"] };
  const ref = raw.trim();
  if (!ref.startsWith(".pi/zteams/") || !ref.endsWith(".tmux.sh")) errors.push("tmuxLauncher must be a project-local .pi/zteams/*.tmux.sh path");
  if (ref.includes("..") || /[\0\n\r]/.test(ref) || /(?:^|[\/])\.env(?:[\/]|$)|secret|key/i.test(ref)) errors.push("tmuxLauncher path is not safe");
  const zteamsDir = resolve(repoRoot, ".pi/zteams");
  const launcherPath = resolve(repoRoot, ref);
  if (!(launcherPath.startsWith(`${zteamsDir}${sep}`) && launcherPath.endsWith(".tmux.sh"))) errors.push("tmuxLauncher must resolve under .pi/zteams");
  if (!existsSync(launcherPath)) errors.push("tmuxLauncher file is missing");
  return { ref, path: launcherPath, errors };
}

function launcherSupportsAction(launcherBody: string, action: ZteamLauncherAction): boolean {
  if (action === "new") return /(^|\n)\s*new\)/.test(launcherBody) || launcherBody.includes("send_new_to_agents");
  if (action === "reload") return /(^|\n)\s*reload\)/.test(launcherBody) || launcherBody.includes("send_reload_to_agents");
  return /(^|\n)\s*close\)/.test(launcherBody) || launcherBody.includes("close_session");
}

function buildZteamTmuxActionPlan(repoRoot: string, team: ZTeamManifest, action: ZteamTmuxAction, options: ZteamTmuxActionOptions, source: "explicit" | "current", manifestErrors: string[] = []): ZteamTmuxActionPlan {
  const teamRooms = normalizeZagentRoomBindings(team.rooms, team.defaultRoom, team.activeRoom).map((room) => room.id);
  const members = zteamMembers(team);
  const agentIds = members.map((member) => member.id);
  const roomIds = [...new Set([...teamRooms, ...members.flatMap((member) => (member.rooms ?? []).map((room) => room.id))])];
  const launcher = safeZteamLauncher(repoRoot, team);
  const safeTeamId = safeZagentId(team.id) === team.id;
  const confirmMatched = options.confirm === undefined || options.confirm === team.id;
  const launcherBody = launcher.path && existsSync(launcher.path) ? readFileSync(launcher.path, "utf8") : "";
  const requiredLauncherAction = zteamLauncherActionFor(action);
  const launcherAction = launcherSupportsAction(launcherBody, requiredLauncherAction) ? requiredLauncherAction : undefined;
  const errors = [
    ...manifestErrors,
    ...(safeTeamId ? [] : [`invalid zteam id: ${team.id}`]),
    ...launcher.errors,
    ...(options.confirm !== undefined && !confirmMatched ? [`execute blocked: optional --confirm must exactly match ${team.id}`] : []),
    ...(options.execute && !launcherAction ? [`execute blocked: launcher does not expose ${requiredLauncherAction} action for /zteam ${action}`] : []),
  ];
  return {
    teamId: team.id,
    source,
    requestedAction: action,
    launcherAction,
    launcherRef: launcher.ref,
    launcherPath: launcher.path,
    session: typeof team.metadata?.tmuxSession === "string" ? team.metadata.tmuxSession : undefined,
    entryAgent: typeof team.metadata?.entryAgent === "string" ? team.metadata.entryAgent : agentIds[0],
    agentIds,
    roomIds,
    errors,
    execute: options.execute,
    confirmMatched,
    spawnCount: 0,
    closePlanned: action === "quit",
    leaseCleanupPlanned: false,
    leaseCleanupAgentIds: [],
    startPlanned: false,
    startAction: undefined,
    newPlanned: action === "reset",
    reloadPlanned: action === "reload",
    quitPlanned: action === "quit",
  };
}

function formatZteamTmuxActionPlan(plan: ZteamTmuxActionPlan): string {
  const actionDescription = zteamActionInputDescription(plan.requestedAction);
  return [
    `# ZTeam ${plan.requestedAction} plan: ${plan.teamId}`,
    `execute=${String(plan.execute)}`,
    `source=${plan.source}`,
    `confirmMatched=${String(plan.confirmMatched)}`,
    `spawn-count=${plan.spawnCount}`,
    `team id: ${plan.teamId}`,
    `launcher: ${plan.launcherRef ?? "missing"}`,
    `session: ${plan.session ?? "not specified"}`,
    `entry agent: ${plan.entryAgent ?? "none"}`,
    `agents: ${plan.agentIds.join(", ") || "none"}`,
    `rooms: ${plan.roomIds.join(", ") || "default"}`,
    `close planned: ${String(plan.closePlanned)}`,
    `lease cleanup planned: ${String(plan.leaseCleanupPlanned)} (runtime owns graceful release/reclaim)`,
    `start planned: ${String(plan.startPlanned)}${plan.startAction ? ` (${plan.startAction})` : ""}`,
    `new planned: ${String(plan.newPlanned)}`,
    `reload planned: ${String(plan.reloadPlanned)}`,
    `quit planned: ${String(plan.quitPlanned)}`,
    `launcher action: ${plan.launcherAction ?? "unavailable"}`,
    plan.execute ? `actions: status -> ${plan.launcherAction ?? zteamLauncherActionFor(plan.requestedAction)} (${actionDescription})` : `dry-run only: no tmux and no ${actionDescription} sent`,
    plan.errors.length ? `blocked/errors:\n- ${plan.errors.join("\n- ")}` : "status: ready",
    "safety: scoped launcher only; no global cleanup, no direct lease cleanup, no kill-server/killall/pkill; reset/reload/quit are not completion evidence",
  ].join("\n");
}

function zteamTmuxActionLedgerEntry(action: string, plan: ZteamTmuxActionPlan, status: "ok" | "blocked", extraErrors: string[] = []): Record<string, unknown> {
  return {
    schema: "zob.zteam-tmux-action-command.v1",
    action,
    status,
    requestedAction: plan.requestedAction,
    source: plan.source,
    teamIdHash: sha256(plan.teamId),
    launcherHash: plan.launcherRef ? sha256(plan.launcherRef) : undefined,
    sessionHash: plan.session ? sha256(plan.session) : undefined,
    entryAgentHash: plan.entryAgent ? sha256(plan.entryAgent) : undefined,
    agentIdHashes: plan.agentIds.map((agentId) => sha256(agentId)),
    roomIdHashes: plan.roomIds.map((roomId) => sha256(roomId)),
    dryRun: !plan.execute,
    execute: plan.execute,
    confirmMatched: plan.confirmMatched,
    spawnCount: plan.spawnCount,
    closePlanned: plan.closePlanned,
    leaseCleanupPlanned: plan.leaseCleanupPlanned,
    leaseCleanupAgentHashes: plan.leaseCleanupAgentIds.map((agentId) => sha256(agentId)),
    startPlanned: plan.startPlanned,
    startActionHash: plan.startAction ? sha256(plan.startAction) : undefined,
    newPlanned: plan.newPlanned,
    reloadPlanned: plan.reloadPlanned,
    quitPlanned: plan.quitPlanned,
    launcherActionHash: plan.launcherAction ? sha256(plan.launcherAction) : undefined,
    errorHashes: [...plan.errors, ...extraErrors].map((error) => sha256(error)),
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

async function executeZteamTmuxActionPlan(_repoRoot: string, plan: ZteamTmuxActionPlan): Promise<{ ok: boolean; errors: string[]; actionStatuses: string[] }> {
  if (!plan.launcherPath) return { ok: false, errors: ["launcher path unavailable"], actionStatuses: [] };
  if (!plan.launcherAction) return { ok: false, errors: [`${plan.requestedAction} action unavailable`], actionStatuses: [] };
  const errors: string[] = [];
  const actionStatuses: string[] = [];

  const statusResult = spawnSync("bash", [plan.launcherPath, "status"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64_000 });
  actionStatuses.push(`status:${statusResult.status ?? "signal"}`);
  if (statusResult.error) errors.push(`status failed: ${statusResult.error.message}`);
  if (typeof statusResult.status === "number" && statusResult.status !== 0) errors.push(`status exited ${statusResult.status}`);
  if (statusResult.signal) errors.push(`status signaled ${statusResult.signal}`);
  if (errors.length > 0) return { ok: false, errors, actionStatuses };

  const actionResult = spawnSync("bash", [plan.launcherPath, plan.launcherAction], { encoding: "utf8", timeout: 30_000, maxBuffer: 64_000 });
  actionStatuses.push(`${plan.launcherAction}:${actionResult.status ?? "signal"}`);
  if (actionResult.error) errors.push(`${plan.launcherAction} failed: ${actionResult.error.message}`);
  if (typeof actionResult.status === "number" && actionResult.status !== 0) errors.push(`${plan.launcherAction} exited ${actionResult.status}`);
  if (actionResult.signal) errors.push(`${plan.launcherAction} signaled ${actionResult.signal}`);
  return { ok: errors.length === 0, errors, actionStatuses };
}

export function registerZliveCommands(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  const rememberZpeerEvent = (event: { kind: NonNullable<typeof state.zobLive.lastEvent>["kind"]; roomId?: string; fromAlias?: string; toAlias?: string; status: string; reason?: string; msgId?: string; taskHash?: string; outputHash?: string; priority?: ZpeerInterruptPriority; interruptMode?: ZpeerInterruptMode; interruptStatus?: ZpeerInterruptStatus }): NonNullable<typeof state.zobLive.lastEvent> | undefined => {
    const recorded = recordZpeerRuntimeEvent(state, event);
    return recorded.accepted ? recorded.event : undefined;
  };

  const emitZpeerEvent = (event: Parameters<typeof rememberZpeerEvent>[0]): boolean => {
    const recorded = rememberZpeerEvent(event);
    if (!recorded) return false;
    void pi.sendMessage({
      customType: "zob-zpeer-event",
      content: `ZPeer ${event.kind} ${event.fromAlias ? `@${event.fromAlias}` : "?"} → ${event.toAlias ? `@${event.toAlias}` : "?"} ${event.status}`,
      display: true,
      details: { ...recorded },
    }, { triggerTurn: false, deliverAs: "nextTurn" });
    return true;
  };

  pi.registerCommand("zagent", {
    description: "Project-local full-session ZAgents: /zagent list | show <id> | use <id>",
    getArgumentCompletions: zagentArgumentCompletions,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "list").toLowerCase();
      if (action === "list") {
        const agents = listZagentManifests(ctx.cwd);
        const roomIds = agents.flatMap((agent) => normalizeZagentRoomBindings(agent.manifest.rooms, agent.manifest.defaultRoom, agent.manifest.activeRoom).map((room) => room.id));
        pi.appendEntry("zob-zagent", zagentLedgerEntry("list", { status: "ok", roomIds }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zagent-list", content: formatZagentList(agents), display: true, details: { bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zagent list: ${agents.length} project-local manifest${agents.length === 1 ? "" : "s"}`, "info");
        return;
      }
      if (action === "show") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /zagent show <id>", "warning");
          return;
        }
        const loaded = loadZagentManifest(ctx.cwd, id);
        const rooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
        pi.appendEntry("zob-zagent", zagentLedgerEntry("show", { id: loaded.manifest.id, status: loaded.errors.length === 0 ? "ok" : "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, errors: loaded.errors }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zagent-show", content: formatZagentShow(loaded), display: true, details: { id: loaded.manifest.id, bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zagent ${loaded.manifest.id}: ${loaded.errors.length === 0 ? "ok" : `blocked (${loaded.errors.length})`}`, loaded.errors.length === 0 ? "info" : "warning");
        return;
      }
      if (action === "use") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /zagent use <id>", "warning");
          return;
        }
        const loaded = loadZagentManifest(ctx.cwd, id);
        const prompt = readZagentPrompt(ctx.cwd, loaded.manifest.promptRef);
        const resolved = resolveZagentRuntimeRoomBindings(ctx.cwd, loaded.manifest);
        const rooms = resolved.rooms;
        const errors = [...loaded.errors, ...prompt.errors];
        state.zagent = {
          id: loaded.manifest.id,
          team: loaded.manifest.team ?? resolved.teamIds[0],
          teams: resolved.teamIds,
          role: loaded.manifest.role,
          alias: loaded.manifest.alias,
          description: loaded.manifest.description,
          rooms,
          activeRoom: rooms.find((room) => room.active)?.id ?? loaded.manifest.activeRoom ?? loaded.manifest.defaultRoom,
          defaultMode: loaded.manifest.defaultMode,
          prompt: prompt.body,
          promptRef: loaded.manifest.promptRef,
          path: loaded.path,
          errors,
          loadedAt: new Date().toISOString(),
          communicationPolicy: loaded.manifest.communicationPolicy as Record<string, unknown> | undefined,
        };
        if (errors.length > 0) {
          pi.appendEntry("zob-zagent", zagentLedgerEntry("use_blocked", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body, errors }));
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`/zagent use ${id} blocked: ${errors[0]}`, "warning");
          return;
        }
        loadActiveZagentScopedMode(state, ctx.cwd);
        const scopedMode = state.zagent.scopedMode;
        if ((scopedMode?.blockers.length ?? 0) > 0) {
          const scopedErrors = state.zagent.errors.length > 0 ? state.zagent.errors : scopedMode?.blockers ?? [];
          pi.appendEntry("zob-zagent", zagentLedgerEntry("use_blocked", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body, errors: scopedErrors }));
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`/zagent use ${id} scoped mode blocked: ${scopedMode?.blockers[0] ?? "see zagent errors"}`, "warning");
          return;
        }
        if (scopedMode?.active && scopedMode.baseMode) {
          applyMode(pi, state, ctx, scopedMode.baseMode, false);
          state.activeRuleResolution = resolveRuleProfile({ repoRoot: ctx.cwd, mode: state.activeMode });
        }
        if (!state.zobLive.peerCard) {
          const peerErrors = ["current session has not registered a local ZPeer endpoint yet"];
          state.zagent.errors = peerErrors;
          pi.appendEntry("zob-zagent", zagentLedgerEntry("use_blocked", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body, errors: peerErrors }));
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`/zagent use ${id} loaded manifest/prompt but ZPeer is unavailable: ${peerErrors[0]}`, "warning");
          return;
        }
        const applied = await applyZagentToZpeer(ctx.cwd, state.zobLive.peerCard, loaded.manifest);
        state.zobLive.peerCard = applied.peer;
        if (!applied.ok) {
          state.zagent.errors = [applied.reason];
          pi.appendEntry("zob-zagent", zagentLedgerEntry("use_blocked", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "blocked", roomIds: rooms.map((room) => room.id), alias: loaded.manifest.alias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body, errors: [applied.reason] }));
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`/zagent use ${id} ZPeer apply blocked: ${applied.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = refreshZpeerSelf(ctx.cwd, applied.peer);
        state.zobLive.peerCard = {
          ...state.zobLive.peerCard,
          team: loaded.manifest.team ?? state.zobLive.peerCard.team,
          roleId: loaded.manifest.id,
          agent: loaded.manifest.id,
        };
        writeZpeerLocalProfileFromPeer(ctx.cwd, state.zobLive.peerCard, zpeerCommandProfileId(ctx));
        pi.appendEntry("zob-zagent", zagentLedgerEntry("use", { id: loaded.manifest.id, teamId: loaded.manifest.team, status: "ok", roomIds: zpeerMembershipsForPeer(state.zobLive.peerCard).map((membership) => membership.roomId), alias: state.zobLive.peerCard.zpeerAlias, path: loaded.path, promptRef: loaded.manifest.promptRef, promptBody: prompt.body }));
        renderHarnessWidget(pi, state, ctx);
        const active = state.zobLive.peerCard.zpeerRoomId ?? state.zobLive.peerCard.zpeerActiveRoomId ?? "default";
        ctx.ui.notify(`zagent ${loaded.manifest.id} loaded; ZPeer @${state.zobLive.peerCard.zpeerAlias ?? "?"} active=${active} rooms=${zpeerMembershipsForPeer(state.zobLive.peerCard).length}; promptHash=${prompt.body ? sha256(prompt.body).slice(0, 12) : "none"}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /zagent list | /zagent show <id> | /zagent use <id>", "warning");
    },
  });

  pi.registerCommand("zteam", {
    description: "Project-local ZTeams: /zteam list | show <id> | launch-plan <id> | hot-add [id] <ask> | hot-add-presence <id> <agent> | reset|reload|quit [team-id] [--dry-run]",
    getArgumentCompletions: zteamArgumentCompletions,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "list").toLowerCase();
      if (action === "list") {
        const teams = listZteamManifests(ctx.cwd);
        const roomIds = teams.flatMap((team) => normalizeZagentRoomBindings(team.manifest.rooms, team.manifest.defaultRoom, team.manifest.activeRoom).map((room) => room.id));
        pi.appendEntry("zob-zagent", zagentLedgerEntry("zteam_list", { status: "ok", roomIds }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zteam-list", content: formatZteamList(teams), display: true, details: { bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam list: ${teams.length} project-local manifest${teams.length === 1 ? "" : "s"}`, "info");
        return;
      }
      if (action === "show") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /zteam show <id>", "warning");
          return;
        }
        const loaded = loadZteamManifest(ctx.cwd, id);
        const rooms = normalizeZagentRoomBindings(loaded.manifest.rooms, loaded.manifest.defaultRoom, loaded.manifest.activeRoom);
        pi.appendEntry("zob-zagent", zagentLedgerEntry("zteam_show", { teamId: loaded.manifest.id, status: loaded.errors.length === 0 ? "ok" : "blocked", roomIds: rooms.map((room) => room.id), path: loaded.path, errors: loaded.errors }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zteam-show", content: formatZteamShow(loaded), display: true, details: { id: loaded.manifest.id, bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam ${loaded.manifest.id}: ${loaded.errors.length === 0 ? "ok" : `blocked (${loaded.errors.length})`}`, loaded.errors.length === 0 ? "info" : "warning");
        return;
      }
      if (action === "launch-plan") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /zteam launch-plan <id>", "warning");
          return;
        }
        const loaded = loadZteamManifest(ctx.cwd, id);
        const plan = zteamLaunchPlanText(ctx.cwd, loaded.manifest);
        pi.appendEntry("zob-zagent", zagentLedgerEntry("zteam_launch_plan", { teamId: loaded.manifest.id, status: loaded.errors.length === 0 ? "ok" : "blocked", roomIds: plan.roomIds, path: loaded.path, errors: loaded.errors }));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zteam-launch-plan", content: loaded.errors.length ? `${plan.text}\n\nBlocked manifest errors:\n- ${loaded.errors.join("\n- ")}` : plan.text, display: true, details: { id: loaded.manifest.id, agentIdHashes: plan.agentIds.map((agentId) => sha256(agentId)), roomIdHashes: plan.roomIds.map((roomId) => sha256(roomId)), modelIdHashes: plan.modelIds.map((modelId) => sha256(modelId)), defaultModeHashes: plan.defaultModes.map((mode) => sha256(mode)), bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam ${loaded.manifest.id} launch-plan printed; spawn count=0; expectedRooms=${plan.roomIds.join(",") || "default"}; models=${plan.modelIds.length || "default"}; defaultModes=${plan.defaultModes.length || "current"}`, loaded.errors.length === 0 ? "info" : "warning");
        return;
      }
      if (action === "hot-add" || action === "hotadd" || action === "add-agent") {
        const parsed = parseZteamHotAddArgs(ctx.cwd, parts);
        const target = resolveZteamHotAddTeamId(ctx.cwd, state, parsed.id);
        if (!target.id) {
          const errors = [...parsed.errors, ...target.errors];
          pi.appendEntry("zob-zagent", zagentLedgerEntry("zteam_hot_add_target_blocked", { status: "blocked", errors }));
          renderHarnessWidget(pi, state, ctx);
          void pi.sendMessage({ customType: "zob-zteam-hot-add-plan", content: ["# ZTeam hot-add blocked", ...errors].join("\n"), display: true, details: { execute: false, spawnCount: 0, bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify("Usage: /zteam hot-add [team-id] <natural-language ask> [--apply --confirm <team-id>]", "warning");
          return;
        }
        const loaded = loadZteamManifest(ctx.cwd, target.id);
        const plan = buildZteamHotAddPlan(ctx.cwd, loaded.manifest, target.source, parsed.requestText, parsed.options, [...loaded.errors, ...parsed.errors, ...target.errors]);
        if (!plan.execute) {
          pi.appendEntry("zob-zagent", zteamHotAddLedgerEntry("zteam_hot_add_plan", plan, plan.errors.length === 0 ? "ok" : "blocked"));
          renderHarnessWidget(pi, state, ctx);
          void pi.sendMessage({ customType: "zob-zteam-hot-add-plan", content: formatZteamHotAddPlan(plan), display: true, details: { teamIdHash: sha256(plan.teamId), agentIdHash: sha256(plan.agentId), roomIdHashes: plan.roomIds.map((roomId) => sha256(roomId)), requestHash: plan.requestHash, execute: false, spawnCount: 0, bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify(`zteam ${plan.teamId} hot-add plan printed; spawn count=0; apply=${String(plan.execute)}; errors=${plan.errors.length}`, plan.errors.length === 0 ? "info" : "warning");
          return;
        }
        if (plan.errors.length > 0) {
          pi.appendEntry("zob-zagent", zteamHotAddLedgerEntry("zteam_hot_add_apply_blocked", plan, "blocked"));
          renderHarnessWidget(pi, state, ctx);
          void pi.sendMessage({ customType: "zob-zteam-hot-add-plan", content: formatZteamHotAddPlan(plan), display: true, details: { teamIdHash: sha256(plan.teamId), agentIdHash: sha256(plan.agentId), requestHash: plan.requestHash, execute: true, confirmMatched: plan.confirmMatched, spawnCount: 0, bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify(`zteam ${plan.teamId} hot-add apply blocked; errors=${plan.errors.length}; spawn count=0`, "warning");
          return;
        }
        const result = applyZteamHotAddPlan(ctx.cwd, plan);
        pi.appendEntry("zob-zagent", zteamHotAddLedgerEntry(result.ok ? "zteam_hot_add_apply" : "zteam_hot_add_apply_failed", plan, result.ok ? "ok" : "blocked", result.errors));
        renderHarnessWidget(pi, state, ctx);
        const resultText = result.ok ? `\napplied files:\n- ${result.writtenPaths.join("\n- ")}` : `\napply errors:\n- ${result.errors.join("\n- ")}`;
        void pi.sendMessage({ customType: "zob-zteam-hot-add-plan", content: `${formatZteamHotAddPlan(plan)}${resultText}`, display: true, details: { teamIdHash: sha256(plan.teamId), agentIdHash: sha256(plan.agentId), requestHash: plan.requestHash, execute: true, confirmMatched: plan.confirmMatched, writtenPathHashes: result.writtenPaths.map((path) => sha256(path)), spawnCount: 0, bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam ${plan.teamId} hot-add apply ${result.ok ? "ok" : "failed"}; files=${result.writtenPaths.length}; spawn count=0`, result.ok ? "info" : "warning");
        return;
      }
      if (action === "hot-add-presence" || action === "hotadd-presence" || action === "presence-check") {
        const teamId = parts[1];
        const agentId = parts[2];
        const errors = [
          ...(!teamId ? ["hot-add presence check requires a team id"] : []),
          ...(!agentId ? ["hot-add presence check requires a zagent id"] : []),
          ...(teamId && !projectZteamManifestExists(ctx.cwd, teamId) ? [`unknown project-local zteam: ${teamId}`] : []),
          ...(agentId && safeZagentId(agentId) !== agentId ? [`invalid zagent id: ${agentId}`] : []),
        ];
        if (errors.length > 0 || !teamId || !agentId) {
          pi.appendEntry("zob-zagent", zagentLedgerEntry("zteam_hot_add_presence_blocked", { status: "blocked", errors }));
          renderHarnessWidget(pi, state, ctx);
          void pi.sendMessage({ customType: "zob-zteam-hot-add-presence", content: ["# ZTeam hot-add presence check blocked", ...errors].join("\n"), display: true, details: { bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify("Usage: /zteam hot-add-presence <team-id> <zagent-id>", "warning");
          return;
        }
        const presence = buildZteamHotAddPresencePlan(ctx.cwd, teamId, agentId);
        pi.appendEntry("zob-zagent", zteamHotAddPresenceLedgerEntry(presence));
        renderHarnessWidget(pi, state, ctx);
        void pi.sendMessage({ customType: "zob-zteam-hot-add-presence", content: formatZteamHotAddPresencePlan(presence), display: true, details: { teamIdHash: sha256(teamId), agentIdHash: sha256(agentId), status: presence.status, bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam ${teamId}/${agentId} presence=${presence.status}; source=local lease/registry; tmuxWindowCountsAsPresence=false`, presence.status === "online" ? "info" : "warning");
        return;
      }
      if (action === "reset" || action === "new" || action === "reset-plan" || action === "reload" || action === "reload-plan" || action === "quit" || action === "quit-plan") {
        const requestedAction: ZteamTmuxAction = action === "reload" || action === "reload-plan"
          ? "reload"
          : action === "quit" || action === "quit-plan"
            ? "quit"
            : "reset";
        const parsed = parseZteamTmuxActionArgs(parts, requestedAction);
        const options = action.endsWith("-plan") ? { ...parsed.options, execute: false } : parsed.options;
        const target = resolveZteamCommandTeamId(ctx.cwd, state, parsed.id);
        const targetErrors = target.errors.map((error) => error.replaceAll("<action>", requestedAction));
        if (!target.id) {
          pi.appendEntry("zob-zagent", zagentLedgerEntry(`zteam_${requestedAction}_target_blocked`, { status: "blocked", errors: [...targetErrors, ...parsed.errors] }));
          renderHarnessWidget(pi, state, ctx);
          const content = [`# ZTeam ${requestedAction} blocked`, ...targetErrors, ...parsed.errors].join("\n");
          void pi.sendMessage({ customType: "zob-zteam-tmux-action-plan", content, display: true, details: { execute: options.execute, bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify(`/zteam ${requestedAction} needs a team id or current ZTeam binding`, "warning");
          return;
        }
        const loaded = loadZteamManifest(ctx.cwd, target.id);
        const plan = buildZteamTmuxActionPlan(ctx.cwd, loaded.manifest, requestedAction, options, target.source, [...loaded.errors, ...parsed.errors, ...targetErrors]);
        if (!options.execute) {
          pi.appendEntry("zob-zagent", zteamTmuxActionLedgerEntry(`zteam_${requestedAction}_dry_run`, plan, plan.errors.length === 0 ? "ok" : "blocked"));
          renderHarnessWidget(pi, state, ctx);
          void pi.sendMessage({ customType: "zob-zteam-tmux-action-plan", content: formatZteamTmuxActionPlan(plan), display: true, details: { teamIdHash: sha256(plan.teamId), agentIdHashes: plan.agentIds.map((agentId) => sha256(agentId)), roomIdHashes: plan.roomIds.map((roomId) => sha256(roomId)), execute: false, spawnCount: 0, bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify(`zteam ${plan.teamId} ${requestedAction} dry-run; execute=false; spawn count=0; ${zteamActionInputDescription(requestedAction)} planned; errors=${plan.errors.length}`, plan.errors.length === 0 ? "info" : "warning");
          return;
        }
        if (plan.errors.length > 0) {
          pi.appendEntry("zob-zagent", zteamTmuxActionLedgerEntry(`zteam_${requestedAction}_execute_blocked`, plan, "blocked"));
          renderHarnessWidget(pi, state, ctx);
          void pi.sendMessage({ customType: "zob-zteam-tmux-action-plan", content: formatZteamTmuxActionPlan(plan), display: true, details: { teamIdHash: sha256(plan.teamId), execute: true, confirmMatched: plan.confirmMatched, spawnCount: 0, bodyStored: false } }, { triggerTurn: false });
          ctx.ui.notify(`zteam ${plan.teamId} ${requestedAction} execute blocked; errors=${plan.errors.length}`, "warning");
          return;
        }
        const result = await executeZteamTmuxActionPlan(ctx.cwd, plan);
        pi.appendEntry("zob-zagent", zteamTmuxActionLedgerEntry(result.ok ? `zteam_${requestedAction}_execute` : `zteam_${requestedAction}_execute_failed`, plan, result.ok ? "ok" : "blocked", result.errors));
        renderHarnessWidget(pi, state, ctx);
        const actionStatusText = result.actionStatuses.length ? `\naction-statuses: ${result.actionStatuses.join(", ")}` : "";
        const errorText = result.errors.length ? `\nexecute errors:\n- ${result.errors.join("\n- ")}` : "";
        void pi.sendMessage({ customType: "zob-zteam-tmux-action-plan", content: `${formatZteamTmuxActionPlan(plan)}${actionStatusText}${errorText}`, display: true, details: { teamIdHash: sha256(plan.teamId), execute: true, confirmMatched: plan.confirmMatched, spawnCount: plan.spawnCount, actionStatusHashes: result.actionStatuses.map((item) => sha256(item)), bodyStored: false } }, { triggerTurn: false });
        ctx.ui.notify(`zteam ${plan.teamId} ${requestedAction} execute ${result.ok ? "ok" : "failed"}; ${zteamActionInputDescription(requestedAction)} through scoped launcher; spawn count=${plan.spawnCount}`, result.ok ? "info" : "warning");
        return;
      }
      ctx.ui.notify("Usage: /zteam list | /zteam show <id> | /zteam launch-plan <id> | /zteam hot-add [id] <ask> [--apply --confirm <id>] | /zteam hot-add-presence <id> <agent> | /zteam reset|reload|quit [team-id] [--dry-run]", "warning");
    },
  });

  pi.registerCommand("zpeer", {
    description: "Room-scoped local peer sessions: /zpeer, /zpeer name <alias>, /zpeer room <roomId>, /zpeer @alias <prompt>, /zpeer reply <msgId> <response>, /zpeer --require-response @alias <prompt>, /zpeer urgent @alias <prompt>, /zpeer force @alias --reason <reason> <prompt>",
    handler: async (args, ctx) => {
      if (!state.zobLive.peerCard) {
        ctx.ui.notify("/zpeer unavailable: current session has not registered a local peer endpoint yet", "warning");
        return;
      }
      const self = refreshZpeerSelf(ctx.cwd, state.zobLive.peerCard);
      state.zobLive.peerCard = self;
      const trimmed = args.trim();
      const tokenizeZpeerArgs = (input: string): string[] => [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
      if (!trimmed) {
        const summary = buildZpeerRoomSummary(ctx.cwd, self);
        pi.appendEntry("zob-zpeer", {
          schema: "zob.zpeer-command.v1",
          action: "status",
          roomIdHash: sha256(summary.roomId),
          aliasHash: sha256(summary.selfAlias ?? ""),
          peerCount: summary.peerCount,
          online: summary.online,
          stale: summary.stale,
          offline: summary.offline,
          duplicateAliasCount: summary.duplicateAliases.length,
          membershipCount: summary.membershipCount ?? zpeerMembershipsForPeer(self).length,
          localOnly: true,
          networkEnabled: false,
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
          generatedAt: new Date().toISOString(),
        });
        emitZpeerEvent({ kind: "status", roomId: summary.roomId, fromAlias: summary.selfAlias, status: `online=${summary.online}/${summary.peerCount}`, reason: `stale=${summary.stale} offline=${summary.offline}` });
        renderHarnessWidget(pi, state, ctx);
        const availableAliases = summary.onlineAliases.filter((alias) => alias !== summary.selfAlias).map((alias) => `@${alias}`).join(", ") || "none";
        const unavailable = summary.stale + summary.offline;
        ctx.ui.notify(`zpeer room=${summary.roomId} memberships=${summary.membershipCount ?? zpeerMembershipsForPeer(self).length} self=@${summary.selfAlias ?? "?"} onlinePeers=${Math.max(0, summary.online - 1)} unavailable=${unavailable} livePeers=${availableAliases} · usage: /zpeer @alias <prompt> | /zpeer in <room> @alias <prompt> · safety: local-only/hash-only/bodyStored=false`, "info");
        return;
      }
      const parts = tokenizeZpeerArgs(trimmed);
      const verb = parts[0]?.toLowerCase();
      const zpeerProfileId = zpeerCommandProfileId(ctx);
      if (verb === "name") {
        const result = await changeZpeerAlias(ctx.cwd, self, parts[1] ?? "");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer name blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "name", aliasHash: sha256(result.peer.zpeerAlias ?? ""), roomIdHash: sha256(result.peer.zpeerRoomId ?? "default"), localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer alias set to @${result.peer.zpeerAlias}`, "info");
        return;
      }
      if (verb === "room") {
        const result = await changeZpeerRoom(ctx.cwd, self, parts[1] ?? "");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer room blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "room", aliasHash: sha256(result.peer.zpeerAlias ?? ""), roomIdHash: sha256(result.peer.zpeerRoomId ?? "default"), membershipCount: zpeerMembershipsForPeer(result.peer).length, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer room set to ${result.peer.zpeerRoomId} as @${result.peer.zpeerAlias}`, "info");
        return;
      }
      if (verb === "rooms") {
        const memberships = zpeerMembershipsForPeer(self);
        const summaries = memberships.map((membership) => buildZpeerRoomSummary(ctx.cwd, self, membership.roomId));
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "rooms", roomIdHash: sha256(self.zpeerRoomId ?? "default"), membershipCount: memberships.length, roomHashes: memberships.map((membership) => sha256(membership.roomId)), localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer active=${self.zpeerRoomId ?? "default"} rooms=${summaries.map((summary) => `${summary.roomId}(${summary.online}/${summary.peerCount})`).join(", ") || "none"}`, "info");
        return;
      }
      if (verb === "clear") {
        const result = clearZpeerRoom(ctx.cwd, self, parts[1] ?? self.zpeerRoomId ?? "default");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer clear blocked: ${result.reason}`, "warning");
          return;
        }
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "clear", roomIdHash: sha256(result.roomId), clearedCount: result.cleared, preservedSelf: result.preservedSelf, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer room ${result.roomId} cleared: ${result.cleared} other peer${result.cleared === 1 ? "" : "s"} marked offline/removed; current session preserved`, "info");
        return;
      }
      if (verb === "join") {
        const asIndex = parts.indexOf("as");
        const alias = asIndex >= 0 ? parts[asIndex + 1] : undefined;
        const role = parts.includes("--bridge") ? "bridge" : parts.includes("--observer") ? "observer" : "member";
        const result = await joinZpeerRoom(ctx.cwd, self, parts[1] ?? "", alias, role);
        if (!result.ok) {
          ctx.ui.notify(`/zpeer join blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "join", aliasHash: sha256(alias ?? result.peer.zpeerAlias ?? ""), roomIdHash: sha256(parts[1] ?? "default"), membershipCount: zpeerMembershipsForPeer(result.peer).length, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer joined ${parts[1]} (${role}); active=${result.peer.zpeerRoomId}`, "info");
        return;
      }
      if (verb === "use") {
        const result = useZpeerRoom(ctx.cwd, self, parts[1] ?? "");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer use blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "use", aliasHash: sha256(result.peer.zpeerAlias ?? ""), roomIdHash: sha256(result.peer.zpeerRoomId ?? "default"), membershipCount: zpeerMembershipsForPeer(result.peer).length, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer active room set to ${result.peer.zpeerRoomId} as @${result.peer.zpeerAlias}`, "info");
        return;
      }
      if (verb === "leave") {
        const result = leaveZpeerRoom(ctx.cwd, self, parts[1] ?? "");
        if (!result.ok) {
          ctx.ui.notify(`/zpeer leave blocked: ${result.reason}`, "warning");
          return;
        }
        state.zobLive.peerCard = result.peer;
        writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId);
        pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "leave", roomIdHash: sha256(parts[1] ?? "default"), membershipCount: zpeerMembershipsForPeer(result.peer).length, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
        renderHarnessWidget(pi, state, ctx);
        ctx.ui.notify(`zpeer left ${parts[1]}; active=${result.peer.zpeerRoomId}`, "info");
        return;
      }
      if (verb === "reply") {
        const msgId = parts[1]?.trim();
        const responseText = parts.slice(2).join(" ").trim();
        const outputHash = responseText ? sha256(responseText) : undefined;
        const inbound = msgId ? state.zobLive.inboundByMsgId?.[msgId] : undefined;
        const block = !msgId ? "msgId is required" : !responseText ? "response text is required" : !inbound ? "no active inbound ZPeer message for msgId" : inbound.responseSent || inbound.requiredResponseStatus === "replied" ? "ZPeer msgId already answered" : inbound.requiredResponseStatus === "expired" ? "ZPeer msgId required response already expired" : !inbound.envelope.replyEndpoint ? "ZPeer inbound msgId has no reply endpoint" : undefined;
        if (block) {
          pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "reply_blocked", status: "blocked", reasonHash: sha256(block), msgId, outputHash, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
          ctx.ui.notify(`/zpeer reply blocked: ${block}`, "warning");
          return;
        }
        if (!inbound || !inbound.envelope.replyEndpoint) {
          ctx.ui.notify("/zpeer reply blocked: invalid reply state", "warning");
          return;
        }
        const replyEndpoint = inbound.envelope.replyEndpoint;
        try {
          const responseEnvelope = { ...buildZobLiveResponseEnvelope(inbound.envelope, responseText, inbound.envelope.artifactRefs, inbound.envelope.artifactHashes), replyToMsgId: inbound.envelope.msgId, responseHash: outputHash };
          const ack = await sendZobLocalEnvelope(replyEndpoint, responseEnvelope, { timeoutMs: 5_000 });
          if (ack.type !== "ack") throw new Error(`expected ack, got ${ack.type}`);
          if (inbound.watchdogTimer) clearTimeout(inbound.watchdogTimer);
          inbound.responseSent = true;
          inbound.requiredResponseStatus = "replied";
          if (state.zobLive.inboundByMsgId) delete state.zobLive.inboundByMsgId[inbound.envelope.msgId];
          if (state.zobLive.inbound?.envelope.msgId === inbound.envelope.msgId) state.zobLive.inbound = { ...state.zobLive.inbound, responseSent: true };
          state.zobLive.activeInboundMsgId = undefined;
          state.zobLive.inboundQueue = (state.zobLive.inboundQueue ?? []).filter((candidate) => candidate !== inbound.envelope.msgId);
          const roomId = inbound.envelope.runId?.startsWith("zpeer:") ? inbound.envelope.runId.slice("zpeer:".length) : undefined;
          emitZpeerEvent({ kind: "response_sent", roomId, fromAlias: inbound.envelope.receiver, toAlias: inbound.envelope.sender, status: "response_sent", msgId: inbound.envelope.msgId, taskHash: inbound.envelope.taskHash, outputHash, priority: inbound.priority, interruptMode: inbound.interruptMode });
          pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "reply", status: "response_sent", msgId: inbound.envelope.msgId, taskHash: inbound.envelope.taskHash, outputHash, priority: inbound.priority, interruptMode: inbound.interruptMode, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
          renderHarnessWidget(pi, state, ctx);
          ctx.ui.notify(`zpeer reply sent msgId=${inbound.envelope.msgId} outputHash=${outputHash}`, "info");
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "reply_error", status: "error", reasonHash: sha256(reason), msgId, outputHash, localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
          ctx.ui.notify(`/zpeer reply error: ${reason}`, "warning");
        }
        return;
      }
      const sendModeFromParts = (inputParts: string[]): { mode: ZpeerSendMode; priority: ZpeerInterruptPriority; interruptMode: ZpeerInterruptMode; interruptReasonHash?: string; reasonHash?: string; requireResponse?: boolean; maxReinjects?: number; aliasToken?: string; bodyParts: string[]; error?: string } => {
        let mode: ZpeerSendMode = inputParts.includes("--async") ? "async" : inputParts.includes("--long") ? "long" : "await";
        let priority: ZpeerInterruptPriority = "normal";
        let requireResponse = false;
        let maxReinjects = 1;
        let aliasToken: string | undefined;
        let reason: string | undefined;
        const bodyParts: string[] = [];
        const modeToken = (value: string | undefined): value is ZpeerSendMode => value === "async" || value === "await" || value === "long";
        const priorityToken = (value: string | undefined): value is Exclude<ZpeerInterruptPriority, "normal"> => value === "urgent" || value === "force";
        for (let index = 0; index < inputParts.length; index += 1) {
          const part = inputParts[index];
          const lower = part.toLowerCase();
          if (!aliasToken && modeToken(lower)) {
            mode = lower;
            continue;
          }
          if (!aliasToken && priorityToken(lower)) {
            priority = lower;
            continue;
          }
          if (lower === "--async") {
            mode = "async";
            continue;
          }
          if (lower === "--long") {
            mode = "long";
            continue;
          }
          if (lower === "--urgent") {
            priority = priority === "force" ? "force" : "urgent";
            continue;
          }
          if (lower === "--force") {
            priority = "force";
            continue;
          }
          if (lower === "--require-response") {
            requireResponse = true;
            continue;
          }
          if (lower === "--max-reinjects") {
            const parsed = Number(inputParts[index + 1]);
            if (!Number.isFinite(parsed)) return { mode, priority, interruptMode: "none", aliasToken, bodyParts, error: "--max-reinjects requires a number" };
            maxReinjects = Math.max(0, Math.min(3, Math.floor(parsed)));
            index += 1;
            continue;
          }
          if (lower.startsWith("--max-reinjects=")) {
            const parsed = Number(part.slice("--max-reinjects=".length));
            if (!Number.isFinite(parsed)) return { mode, priority, interruptMode: "none", aliasToken, bodyParts, error: "--max-reinjects requires a number" };
            maxReinjects = Math.max(0, Math.min(3, Math.floor(parsed)));
            continue;
          }
          if (lower === "--reason") {
            reason = inputParts[index + 1];
            index += 1;
            continue;
          }
          if (lower.startsWith("--reason=")) {
            reason = part.slice("--reason=".length);
            continue;
          }
          if (!aliasToken) {
            aliasToken = part;
            continue;
          }
          bodyParts.push(part);
        }
        const interruptMode: ZpeerInterruptMode = priority === "force" ? "abort" : priority === "urgent" ? "steer" : "none";
        if (priority === "force" && !reason?.trim()) return { mode, priority, interruptMode, aliasToken, bodyParts, error: "--reason is required for force" };
        return { mode, priority, interruptMode, interruptReasonHash: reason?.trim() ? sha256(reason) : undefined, reasonHash: reason?.trim() ? sha256(reason) : undefined, requireResponse, maxReinjects, aliasToken, bodyParts };
      };
      const explicitRoomId = verb === "in" ? parts[1] : undefined;
      const sendParts = explicitRoomId ? parts.slice(2) : parts;
      const sendMode = sendModeFromParts(sendParts);
      if (sendMode.aliasToken?.startsWith("@")) {
        const targetAlias = sendMode.aliasToken.slice(1);
        const transientPrompt = sendMode.bodyParts.join(" ").trim();
        const replyTimeoutMs = sendMode.mode === "long" ? 30 * 60 * 1000 : 10 * 60 * 1000;
        const eventRoomId = explicitRoomId ?? state.zobLive.peerCard.zpeerRoomId ?? "default";
        const eventFromAlias = peerAliasInRoom(state.zobLive.peerCard, eventRoomId) ?? state.zobLive.peerCard.zpeerAlias;
        if (sendMode.error) {
          const taskHash = transientPrompt.trim() ? sha256(transientPrompt) : undefined;
          emitZpeerEvent({ kind: "blocked", roomId: eventRoomId, fromAlias: eventFromAlias, toAlias: targetAlias, status: "blocked", reason: sendMode.error, taskHash, priority: sendMode.priority, interruptMode: sendMode.interruptMode, interruptStatus: "force_blocked" });
          pi.appendEntry("zob-zpeer", { schema: "zob.zpeer-command.v1", action: "send_blocked", status: "blocked", reasonHash: sha256(sendMode.error), targetAliasHash: sha256(targetAlias), roomIdHash: sha256(eventRoomId), taskHash, priority: sendMode.priority, interruptMode: sendMode.interruptMode, interruptStatus: "force_blocked", localOnly: true, networkEnabled: false, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, generatedAt: new Date().toISOString() });
          ctx.ui.notify(`/zpeer force blocked: ${sendMode.error}`, "warning");
          return;
        }
        if (sendMode.mode !== "async") emitZpeerEvent({ kind: "attempt", roomId: eventRoomId, fromAlias: eventFromAlias, toAlias: targetAlias, status: "attempt", taskHash: transientPrompt.trim() ? sha256(transientPrompt) : undefined, priority: sendMode.priority, interruptMode: sendMode.interruptMode });
        let feedbackEmittedTerminal = false;
        const result = await sendZpeerPrompt(ctx.cwd, state.zobLive.peerCard, targetAlias, transientPrompt, (msgId) => state.zobLive.pendingReplies.wait(msgId, replyTimeoutMs, { requireResponse: sendMode.requireResponse === true }), {
          mode: sendMode.mode,
          roomId: explicitRoomId,
          priority: sendMode.priority,
          interruptMode: sendMode.interruptMode,
          interruptReasonHash: sendMode.interruptReasonHash,
          requireResponse: sendMode.requireResponse === true,
          responseTimeoutMs: replyTimeoutMs,
          maxReinjects: sendMode.maxReinjects,
          onFeedback: (feedback) => {
            feedbackEmittedTerminal = feedback.result.status === "waiting" || feedback.result.status === "reply" || feedback.result.status === "completed" || feedback.result.status === "blocked" || feedback.result.status === "error" || feedback.result.status === "timeout" || feedback.result.status === "expired" || feedback.result.status === "required_response_expired";
            if (feedback.kind === "waiting" && (sendMode.requireResponse === true || sendMode.mode !== "async")) return;
            const feedbackRoomId = feedback.result.roomId ?? eventRoomId;
            emitZpeerEvent({ kind: feedback.kind, roomId: feedbackRoomId, fromAlias: state.zobLive.peerCard ? peerAliasInRoom(state.zobLive.peerCard, feedbackRoomId) ?? eventFromAlias : eventFromAlias, toAlias: feedback.result.targetAlias ?? targetAlias, status: feedback.result.status, reason: feedback.result.reason, msgId: feedback.result.msgId, taskHash: feedback.result.taskHash, outputHash: feedback.result.outputHash, priority: feedback.result.priority ?? sendMode.priority, interruptMode: feedback.result.interruptMode ?? sendMode.interruptMode, interruptStatus: feedback.result.interruptStatus });
          },
        });
        const terminalKind = result.status === "reply" || result.status === "completed" ? "reply" : result.status === "blocked" ? "blocked" : result.status === "timeout" ? "timeout" : result.status === "expired" ? "expired" : result.status === "required_response_expired" ? "required_response_expired" : result.status === "error" ? "error" : result.status === "waiting" ? "waiting" : "delivered";
        if (!feedbackEmittedTerminal) {
          const resultRoomId = result.roomId ?? eventRoomId;
          emitZpeerEvent({ kind: terminalKind, roomId: resultRoomId, fromAlias: peerAliasInRoom(state.zobLive.peerCard, resultRoomId) ?? eventFromAlias, toAlias: result.targetAlias ?? targetAlias, status: result.status, reason: result.reason, msgId: result.msgId, taskHash: result.taskHash, outputHash: result.outputHash, priority: result.priority ?? sendMode.priority, interruptMode: result.interruptMode ?? sendMode.interruptMode, interruptStatus: result.interruptStatus });
        }
        pi.appendEntry("zob-zpeer", {
          schema: "zob.zpeer-command.v1",
          action: sendMode.mode === "async" ? "send_async" : sendMode.mode === "long" ? "send_long_await" : "send_await",
          status: result.status,
          reasonHash: result.reason ? sha256(result.reason) : undefined,
          msgId: result.msgId,
          targetAliasHash: result.targetAlias ? sha256(result.targetAlias) : undefined,
          roomIdHash: sha256(result.roomId ?? eventRoomId),
          taskHash: result.taskHash,
          outputHash: result.outputHash,
          priority: result.priority ?? sendMode.priority,
          interruptMode: result.interruptMode ?? sendMode.interruptMode,
          interruptStatus: result.interruptStatus,
          interruptReasonHash: result.interruptReasonHash ?? sendMode.interruptReasonHash,
          reasonInputHash: sendMode.reasonHash,
          requireResponse: sendMode.requireResponse === true || undefined,
          responseRequiredBy: result.responseRequiredBy,
          responseTimeoutMs: result.responseTimeoutMs,
          maxReinjects: result.maxReinjects,
          responseReceived: result.responseReceived,
          deliveryStatus: result.deliveryStatus,
          localOnly: true,
          networkEnabled: false,
          bodyStored: false,
          promptBodiesStored: false,
          outputBodiesStored: false,
          generatedAt: new Date().toISOString(),
        });
        renderHarnessWidget(pi, state, ctx);
        if ((result.status === "reply" || result.status === "completed") && result.transientResponse) {
          void pi.sendMessage({
            customType: "zob-zpeer-response",
            content: result.transientResponse,
            display: true,
            details: { msgId: result.msgId, targetAlias, outputHash: result.outputHash, bodyStored: false },
          }, { triggerTurn: false });
          ctx.ui.notify(`zpeer ${result.roomId ?? eventRoomId} @${targetAlias} reply · response displayed transiently · outputHash=${result.outputHash ?? "present"}`, "info");
        } else {
          const ok = result.status === "reply" || result.status === "completed" || result.status === "waiting" || result.status === "delivered";
          const passiveWaitSuffix = result.status === "waiting" ? " · idle/passive wait; no follow-up turn queued" : "";
          const interruptSuffix = result.interruptStatus ? ` interrupt=${result.interruptStatus}` : sendMode.priority !== "normal" ? ` priority=${sendMode.priority}` : "";
          ctx.ui.notify(ok ? `zpeer ${result.roomId ?? eventRoomId} @${targetAlias} ${result.status}${interruptSuffix}${result.outputHash ? ` outputHash=${result.outputHash}` : ""}${passiveWaitSuffix}` : `zpeer ${result.roomId ?? eventRoomId} @${targetAlias} ${result.status}: ${result.reason ?? "see metadata"}${interruptSuffix}`, ok ? "info" : "warning");
        }
        return;
      }
      ctx.ui.notify("Usage: /zpeer | /zpeer rooms | /zpeer clear <roomId> | /zpeer join <roomId> [as <alias>] | /zpeer use <roomId> | /zpeer leave <roomId> | /zpeer reply <msgId> <response> | /zpeer @alias <prompt> | /zpeer --require-response @alias <prompt> | /zpeer urgent @alias <prompt> | /zpeer force @alias --reason <reason> <prompt> | /zpeer in <roomId> urgent|force @alias <prompt>", "warning");
    },
  });
}
