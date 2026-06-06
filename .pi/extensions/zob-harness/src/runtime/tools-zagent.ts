import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MODE_TOOLS } from "../core/constants.js";
import { sha256 } from "../core/utils/hashing.js";
import type { ModeName } from "../types.js";
import { loadZteamManifest, loadZagentManifest, normalizeZagentRoomBindings, safeZagentId, validateZagentManifest, validateZteamManifest, zagentManifestPath, zteamManifestPath, type ZAgentManifest, type ZAgentRoomBinding, type ZTeamAgentManifest, type ZTeamManifest, type ZTeamMemberManifest } from "../domains/coms/zagents.js";
import { safeZpeerAlias, safeZpeerRoomId } from "../domains/coms/coms-v2/zpeer.js";
import { readZobLiveRegistryAllProjectsSnapshot } from "../domains/coms/coms-v2/registry.js";
import { ZteamHotAddParams, ZteamRemoveParams } from "./schemas.js";
import type { HarnessRuntimeState } from "./state.js";

const HOT_ADD_MODE_NAMES = new Set<ModeName>(["explore", "plan", "implement", "oracle", "factory", "orchestrator"]);
const HOT_ADD_STOP_WORDS = new Set(["add", "agent", "zagent", "team", "zteam", "hot", "new", "a", "an", "the", "to", "for", "with", "and", "or", "that", "who", "can", "should", "please", "need", "needs"]);
const HOT_ADD_FORBIDDEN_PATHS = [".env", ".env.*", "~/.ssh", "~/.aws", "*.pem", "*.key", ".git", "node_modules", "dist", "build"] as const;
const REMOVE_SCOPES = new Set(["membership", "manifest", "prompt", "manifest_and_prompt"]);
const HOT_ADD_LAUNCH_DEFAULT_TIMEOUT_MS = 5_000;
const HOT_ADD_LAUNCH_MAX_TIMEOUT_MS = 30_000;
const HOT_ADD_LAUNCH_DEFAULT_POLL_MS = 500;
const HOT_ADD_LAUNCH_MAX_POLL_MS = 2_000;
const REMOVE_TMUX_CLOSE_DEFAULT_TIMEOUT_MS = 5_000;
const REMOVE_TMUX_CLOSE_MAX_TIMEOUT_MS = 30_000;
const REMOVE_TMUX_CLOSE_DEFAULT_POLL_MS = 500;
const REMOVE_TMUX_CLOSE_MAX_POLL_MS = 2_000;
const REMOVE_TMUX_CLOSE_DEFAULT_GRACEFUL_TIMEOUT_MS = 5_000;
const REMOVE_TMUX_CLOSE_MAX_GRACEFUL_TIMEOUT_MS = 30_000;

const HOT_ADD_TOOL_PREFS: Partial<Record<ModeName, string[]>> = {
  explore: ["read", "grep", "find", "ls", "zob_context_search", "zpeer_ask", "zob_goal_room_list"],
  plan: ["read", "grep", "find", "ls", "zob_context_search", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list", "get_goal", "get_goal_todos"],
  implement: ["read", "grep", "find", "ls", "edit", "write", "bash", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list", "get_goal", "get_goal_todos"],
  oracle: ["read", "grep", "find", "ls", "bash", "zob_context_search", "zpeer_ask", "zob_goal_room_list", "get_goal", "get_goal_todos"],
  factory: ["read", "grep", "find", "ls", "bash", "edit", "write", "factory_run", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list"],
  orchestrator: ["read", "grep", "find", "ls", "delegate_agent", "delegate_task", "get_goal", "get_goal_todos", "zpeer_ask", "zob_goal_room_send", "zob_goal_room_list"],
};

type ZteamHotAddTeamSource = "explicit" | "env" | "zagent" | "zpeer" | "activeRoom" | "repoConvention" | "unresolved";
type ZteamHotAddAction = "plan" | "apply" | "launch";
type ZteamRemoveAction = "plan" | "apply" | "close_tmux";
type ZteamRemoveScope = "membership" | "manifest" | "prompt" | "manifest_and_prompt";

type HotAddToolParams = {
  action?: ZteamHotAddAction;
  request?: string;
  team_id?: string;
  zagent_id?: string;
  alias?: string;
  role?: string;
  room?: string;
  default_mode?: ModeName;
  apply_confirmation?: string;
  tmux_window_plan?: boolean;
  launch_confirmation?: string;
  launch_confirmation_phrase?: string;
  tmux_session_name?: string;
  presence_timeout_ms?: number;
  presence_poll_ms?: number;
};

type RemoveToolParams = {
  action?: ZteamRemoveAction;
  team_id: string;
  zagent_id: string;
  scope?: ZteamRemoveScope;
  confirmation_phrase?: string;
  include_tmux_plan?: boolean;
  tmux_confirmation_phrase?: string;
  close_confirmation_phrase?: string;
  tmux_session_name?: string;
  tmux_window_name?: string;
  presence_timeout_ms?: number;
  presence_poll_ms?: number;
  graceful_timeout_ms?: number;
  force_close_window?: boolean;
};

type HotAddPlan = {
  schema: "zob.zteam-hot-add-tool-plan.v1";
  teamId: string;
  teamSource: ZteamHotAddTeamSource;
  requestHash: string;
  agentId: string;
  alias: string;
  role: string;
  roomId: string;
  defaultMode: ModeName;
  promptRef: string;
  promptPath: string;
  zagentPath: string;
  teamPath: string;
  tools: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  purpose: string;
  scope: string;
  manualLaunchCommand: string;
  presenceCheckCommand: string;
  tmuxWindowCommand?: string;
  execute: boolean;
  confirmMatched: boolean;
  launchWindowRequested: boolean;
  launchWindowApproved: boolean;
  spawnCount: 0;
  bodyStored: false;
  existingAgent: boolean;
  existingPrompt: boolean;
  existingMember: boolean;
  proposedPresenceStatus: "none" | "online" | "stale" | "offline";
  presenceCounts: { online: number; stale: number; offline: number };
  errors: string[];
  promptBody: string;
  agentManifest: ZAgentManifest;
  teamManifest: ZTeamManifest;
};

type HotAddPresenceStatus = "online" | "stale" | "offline" | "none";

type HotAddLaunchPlan = {
  schema: "zob.zteam-hot-add-launch-plan.v1";
  teamId: string;
  agentId: string;
  sessionName: string;
  windowName: string;
  confirmationRequired: string;
  confirmMatched: boolean;
  teamPath: string;
  zagentPath: string;
  teamManifestExists: boolean;
  zagentManifestExists: boolean;
  membershipFound: boolean;
  sessionChecked: boolean;
  windowChecked: boolean;
  launchCommand: string;
  launchCommandHash: string;
  presenceTimeoutMs: number;
  presencePollMs: number;
  errors: string[];
  liveProofBlocked: boolean;
};

type HotAddLaunchResult = {
  schema: "zob.zteam-hot-add-launch-result.v1";
  status: "ok" | "blocked";
  ok: boolean;
  liveProofBlocked: boolean;
  presenceStatus: HotAddPresenceStatus;
  presenceCounts: { online: number; stale: number; offline: number };
  sessionChecked: boolean;
  sessionExists: boolean;
  windowChecked: boolean;
  windowExistsBeforeLaunch: boolean;
  windowCreated: boolean;
  sendKeysSent: boolean;
  spawnCount: 0 | 1;
  launchCommandHash: string;
  blockerHashes: string[];
  errors: string[];
};

type RemoveTmuxClosePlan = {
  schema: "zob.zteam-remove-tmux-close-plan.v1";
  teamId: string;
  agentId: string;
  sessionName: string;
  windowName: string;
  explicitWindowOverride: boolean;
  confirmationRequired: string;
  confirmMatched: boolean;
  teamPath: string;
  zagentPath: string;
  teamManifestExists: boolean;
  zagentManifestExists: boolean;
  membershipFound: boolean;
  presenceBefore: HotAddPresenceStatus;
  presenceCountsBefore: { online: number; stale: number; offline: number };
  gracefulTimeoutMs: number;
  presenceTimeoutMs: number;
  presencePollMs: number;
  forceCloseWindow: boolean;
  gracefulCommandHash: string;
  targetCloseCommandHash: string;
  errors: string[];
  liveCloseBlocked: boolean;
};

type RemoveTmuxCloseResult = {
  schema: "zob.zteam-remove-tmux-close-result.v1";
  status: "ok" | "blocked";
  ok: boolean;
  attempted: boolean;
  liveCloseBlocked: boolean;
  presenceBefore: HotAddPresenceStatus;
  presenceAfter: HotAddPresenceStatus;
  presenceCountsAfter: { online: number; stale: number; offline: number };
  sessionChecked: boolean;
  sessionExists: boolean;
  windowChecked: boolean;
  windowExistedBefore: boolean;
  gracefulCommandSent: boolean;
  windowClosedAfterGraceful: boolean;
  targetedWindowCloseUsed: boolean;
  windowClosed: boolean;
  spawnCount: 0;
  closeCount: 0 | 1;
  blockerHashes: string[];
  errors: string[];
};

type RemovePlan = {
  schema: "zob.zteam-remove-tool-plan.v1";
  teamId: string;
  agentId: string;
  scope: ZteamRemoveScope;
  confirmationRequired: string;
  confirmMatched: boolean;
  execute: boolean;
  spawnCount: 0;
  bodyStored: false;
  teamPath: string;
  zagentPath: string;
  promptPath?: string;
  membershipFound: boolean;
  manifestExists: boolean;
  promptExists: boolean;
  removeMembershipPlanned: boolean;
  deleteManifestPlanned: boolean;
  deletePromptPlanned: boolean;
  tmuxPlanRequested: boolean;
  tmuxPlanApproved: boolean;
  manualTmuxPlan?: string;
  errors: string[];
  nextTeamManifest?: ZTeamManifest;
  nextAgentManifest?: ZAgentManifest;
};

function zteamMemberId(member: ZTeamMemberManifest | ZTeamAgentManifest | { id?: unknown; zagentId?: unknown }): string | undefined {
  const value = "zagentId" in member ? member.zagentId : member.id;
  return typeof value === "string" ? value : undefined;
}

function zteamMembers(team: ZTeamManifest): Array<{ id: string; alias?: string; rooms?: ZAgentRoomBinding[]; role?: string; active?: boolean }> {
  const rawMembers = [...(team.members ?? []), ...(team.agents ?? [])];
  return rawMembers.flatMap((member) => {
    const id = zteamMemberId(member);
    if (!id) return [];
    return [{
      id,
      alias: member.alias,
      rooms: normalizeZagentRoomBindings(member.rooms ?? (member.room ? [member.room] : undefined), team.defaultRoom, member.active ? (member.room ?? team.activeRoom) : undefined),
      role: member.role,
      active: member.active,
    }];
  });
}

function projectZteamManifestExists(repoRoot: string, id: string | undefined): id is string {
  if (!id || safeZagentId(id) !== id) return false;
  return existsSync(zteamManifestPath(repoRoot, id));
}

function listProjectZteamIds(repoRoot: string): string[] {
  const dir = resolve(repoRoot, ".pi/zteams");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".modes.json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter((id) => safeZagentId(id) === id)
    .sort();
}

function resolveZteamHotAddTeamId(repoRoot: string, state: HarnessRuntimeState, explicitId: string | undefined): { id?: string; source: ZteamHotAddTeamSource; errors: string[] } {
  if (explicitId) return { id: explicitId, source: "explicit", errors: [] };
  const envTeam = process.env.ZOB_ZTEAM_ID?.trim();
  if (projectZteamManifestExists(repoRoot, envTeam)) return { id: envTeam, source: "env", errors: [] };
  if (projectZteamManifestExists(repoRoot, state.zagent.team)) return { id: state.zagent.team, source: "zagent", errors: [] };
  if (projectZteamManifestExists(repoRoot, state.zobLive.peerCard?.team)) return { id: state.zobLive.peerCard.team, source: "zpeer", errors: [] };

  const activeRoom = state.zobLive.peerCard?.zpeerActiveRoomId ?? state.zobLive.peerCard?.zpeerRoomId ?? state.zagent.activeRoom;
  const validTeams = listProjectZteamIds(repoRoot)
    .map((teamId) => loadZteamManifest(repoRoot, teamId))
    .filter((team) => team.errors.length === 0);
  if (activeRoom) {
    const roomMatches = validTeams.filter((team) => zteamAllRoomIds(team.manifest).includes(activeRoom));
    if (roomMatches.length === 1) return { id: roomMatches[0].manifest.id, source: "activeRoom", errors: [] };
  }
  const ownerLaunchTeams = validTeams.filter((team) => team.manifest.metadata?.ownerLaunchRequired === true);
  if (ownerLaunchTeams.length === 1) return { id: ownerLaunchTeams[0].manifest.id, source: "repoConvention", errors: [] };
  if (validTeams.length === 1) return { id: validTeams[0].manifest.id, source: "repoConvention", errors: [] };
  return { source: "unresolved", errors: ["team_id omitted and current-context/repo-convention fallback was ambiguous; pass team_id explicitly"] };
}

function zteamAllRoomIds(team: ZTeamManifest): string[] {
  return [...new Set([
    ...normalizeZagentRoomBindings(team.rooms, team.defaultRoom, team.activeRoom).map((room) => room.id),
    ...zteamMembers(team).flatMap((member) => (member.rooms ?? []).map((room) => room.id)),
  ])];
}

function safeMode(value: string | undefined): ModeName | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return HOT_ADD_MODE_NAMES.has(trimmed as ModeName) ? trimmed as ModeName : undefined;
}

function hotAddSlugFromText(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((word) => word && !HOT_ADD_STOP_WORDS.has(word)).slice(0, 4);
  return words.join("-").replace(/^-+|-+$/g, "") || "agent";
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

function pathInside(childPath: string, parentPath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !rel.startsWith("/"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeTmuxWindowName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "zagent";
}

function safeTmuxSessionName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 80) return undefined;
  return /^[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : undefined;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function hotAddLaunchConfirmationPhrase(teamId: string, agentId: string, sessionName: string): string {
  return `LAUNCH ZTEAM ${teamId} ZAGENT ${agentId} IN TMUX ${sessionName}`;
}

function removeTmuxCloseConfirmationPhrase(teamId: string, agentId: string, sessionName: string): string {
  return `CLOSE ZTEAM ${teamId} ZAGENT ${agentId} TMUX WINDOW ${sessionName}`;
}

function safeExplicitTmuxWindowName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 64) return undefined;
  return safeTmuxWindowName(trimmed) === trimmed ? trimmed : undefined;
}

function tmuxTarget(sessionName: string, windowName: string): string {
  return `${sessionName}:${windowName}`;
}

function commandHash(command: string, args: string[]): string {
  return sha256([command, ...args].join("\u0000"));
}

function chooseHotAddLaunchSession(team: ZTeamManifest | undefined, params: HotAddToolParams, errors: string[]): string {
  const explicit = safeTmuxSessionName(params.tmux_session_name);
  if (params.tmux_session_name && !explicit) errors.push(`tmux_session_name must be a safe tmux session name: ${params.tmux_session_name}`);
  const metadataSession = typeof team?.metadata?.tmuxSession === "string" ? safeTmuxSessionName(team.metadata.tmuxSession) : undefined;
  const fallback = safeTmuxSessionName(team?.id) ?? "zob";
  return explicit ?? metadataSession ?? fallback;
}

function chooseHotAddLaunchWindow(agentId: string, errors: string[]): string {
  const windowName = safeTmuxWindowName(agentId);
  if (windowName !== agentId) errors.push(`zagent_id must map exactly to a safe tmux window name: ${agentId}`);
  return windowName;
}

function chooseRemoveCloseSession(team: ZTeamManifest | undefined, params: RemoveToolParams, errors: string[]): string {
  const explicit = safeTmuxSessionName(params.tmux_session_name);
  if (params.tmux_session_name && !explicit) errors.push(`tmux_session_name must be a safe tmux session name: ${params.tmux_session_name}`);
  const metadataSession = typeof team?.metadata?.tmuxSession === "string" ? safeTmuxSessionName(team.metadata.tmuxSession) : undefined;
  const fallback = safeTmuxSessionName(team?.id ?? params.team_id) ?? "zob";
  return explicit ?? metadataSession ?? fallback;
}

function chooseRemoveCloseWindow(agentId: string, params: RemoveToolParams, errors: string[]): { windowName: string; explicitWindowOverride: boolean } {
  const explicit = safeExplicitTmuxWindowName(params.tmux_window_name);
  if (params.tmux_window_name && !explicit) errors.push(`tmux_window_name must be a safe tmux window name: ${params.tmux_window_name}`);
  if (explicit) return { windowName: explicit, explicitWindowOverride: true };
  const windowName = safeTmuxWindowName(agentId);
  if (windowName !== agentId) errors.push(`zagent_id must map exactly to the default safe tmux window name or tmux_window_name must be an explicit safe override: ${agentId}`);
  return { windowName, explicitWindowOverride: false };
}

function choosePresenceStatus(snapshot: ReturnType<typeof readZobLiveRegistryAllProjectsSnapshot>, teamId: string, agentId: string): HotAddPresenceStatus {
  const peer = snapshot.peers.find((candidate) => candidate.team === teamId && candidate.roleId === agentId);
  return peer?.status ?? "none";
}

function choosePresenceCounts(snapshot: ReturnType<typeof readZobLiveRegistryAllProjectsSnapshot>): { online: number; stale: number; offline: number } {
  return snapshot.counts;
}

async function waitForTeamAgentPresence(repoRoot: string, teamId: string, agentId: string, timeoutMs: number, pollMs: number): Promise<{ status: HotAddPresenceStatus; counts: { online: number; stale: number; offline: number } }> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, teamId);
  let status = choosePresenceStatus(snapshot, teamId, agentId);
  while (status !== "online" && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, teamId);
    status = choosePresenceStatus(snapshot, teamId, agentId);
  }
  return { status, counts: choosePresenceCounts(snapshot) };
}

async function waitForTeamAgentNotOnlineOrWindowGone(repoRoot: string, teamId: string, agentId: string, sessionName: string, windowName: string, timeoutMs: number, pollMs: number): Promise<{ status: HotAddPresenceStatus; counts: { online: number; stale: number; offline: number }; windowExists: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, teamId);
  let status = choosePresenceStatus(snapshot, teamId, agentId);
  let windowExists = chooseTmuxWindowExists(sessionName, windowName);
  while (status === "online" && windowExists && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, teamId);
    status = choosePresenceStatus(snapshot, teamId, agentId);
    windowExists = chooseTmuxWindowExists(sessionName, windowName);
  }
  return { status, counts: choosePresenceCounts(snapshot), windowExists };
}

function chooseHotAddLaunchCommand(repoRoot: string, teamId: string, agent: ZAgentManifest): string {
  const launchId = `hot-add-launch-${sha256(`${teamId}:${agent.id}:${Date.now()}`).slice(0, 12)}`;
  const profileId = `zteam-${safeTmuxWindowName(teamId)}-${safeTmuxWindowName(agent.id)}`;
  const modelArg = typeof agent.model === "string" ? ` --model ${shellQuote(agent.model)}` : "";
  return `cd ${shellQuote(repoRoot)} && ZOB_ZTEAM_ID=${shellQuote(teamId)} ZOB_ZTEAM_BUNDLE_ID=${shellQuote(teamId)} ZOB_ZTEAM_LAUNCH_ID=${shellQuote(launchId)} ZOB_ZPEER_PROFILE_ID=${shellQuote(profileId)} ZOB_ZAGENT_ID=${shellQuote(agent.id)} pi${modelArg}`;
}

function chooseTmuxExitStatus(command: string, args: string[], timeoutMs: number): { ok: boolean; stdout: string; status: number | null } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
  return { ok: result.status === 0, stdout: typeof result.stdout === "string" ? result.stdout : "", status: result.status };
}

function chooseTmuxSessionExists(sessionName: string): boolean {
  return chooseTmuxExitStatus("tmux", ["has-session", "-t", sessionName], 2_000).ok;
}

function chooseTmuxWindowExists(sessionName: string, windowName: string): boolean {
  const listed = chooseTmuxExitStatus("tmux", ["list-windows", "-t", sessionName, "-F", "#{window_name}"], 2_000);
  if (!listed.ok) return false;
  return listed.stdout.split(/\r?\n/).some((line) => line.trim() === windowName);
}

function chooseHotAddRoom(team: ZTeamManifest, requestText: string, explicitRoom: string | undefined, errors: string[]): { roomId: string; roomIds: string[] } {
  const roomIds = zteamAllRoomIds(team);
  const explicit = explicitRoom ? safeZpeerRoomId(explicitRoom) : undefined;
  if (explicitRoom && !explicit) errors.push(`room must be a safe ZPeer room id: ${explicitRoom}`);
  const mentioned = roomIds.find((roomId) => requestText.toLowerCase().includes(roomId.toLowerCase()));
  const roomId = explicit ?? mentioned ?? team.activeRoom ?? team.defaultRoom ?? roomIds[0] ?? "default";
  if (!safeZpeerRoomId(roomId)) errors.push(`selected room is not a safe ZPeer room id: ${roomId}`);
  if (roomIds.length > 0 && !roomIds.includes(roomId)) errors.push(`room must be one of existing zteam rooms (${roomIds.join(",")}): ${roomId}`);
  return { roomId, roomIds: roomIds.length ? roomIds : [roomId] };
}

function zteamWithHotAddedMember(team: ZTeamManifest, input: { agentId: string; alias: string; role: string; roomId: string }): ZTeamManifest {
  const roomBinding: ZAgentRoomBinding = { id: input.roomId, alias: input.alias, role: input.role, active: true };
  const agent: ZTeamAgentManifest = { id: input.agentId, alias: input.alias, rooms: [roomBinding], role: input.role, active: true, communicationPolicy: { zpeerContact: true, allowedRooms: [input.roomId], allowedAliases: [input.alias], requireActiveRoom: true } };
  return { ...team, agents: [...(team.agents ?? []), agent] };
}

function buildManualLaunchCommand(teamId: string, agentId: string): string {
  return `ZOB_ZTEAM_ID=${teamId} ZOB_ZAGENT_ID=${agentId} pi`;
}

function buildHotAddTmuxWindowCommand(repoRoot: string, team: ZTeamManifest, agentId: string): string | undefined {
  const session = typeof team.metadata?.tmuxSession === "string" && safeZagentId(team.metadata.tmuxSession) === team.metadata.tmuxSession ? team.metadata.tmuxSession : team.id;
  if (!safeZagentId(session)) return undefined;
  const window = safeTmuxWindowName(agentId);
  const launchId = `hot-add-${sha256(`${team.id}:${agentId}`).slice(0, 12)}`;
  const profileId = `zteam-${safeTmuxWindowName(team.id)}-${safeTmuxWindowName(agentId)}`;
  const launchCommand = `cd ${shellQuote(repoRoot)} && ZOB_ZTEAM_ID=${shellQuote(team.id)} ZOB_ZTEAM_BUNDLE_ID=${shellQuote(team.id)} ZOB_ZTEAM_LAUNCH_ID=${shellQuote(launchId)} ZOB_ZPEER_PROFILE_ID=${shellQuote(profileId)} ZOB_ZAGENT_ID=${shellQuote(agentId)} pi`;
  return `tmux new-window -t ${shellQuote(session)} -n ${shellQuote(window)} ${shellQuote(launchCommand)}`;
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
  ].join("\n");
}

function buildHotAddPlan(repoRoot: string, state: HarnessRuntimeState, params: HotAddToolParams): HotAddPlan {
  const errors: string[] = [];
  const action = params.action ?? "plan";
  const teamResolution = resolveZteamHotAddTeamId(repoRoot, state, params.team_id);
  errors.push(...teamResolution.errors);
  const team = teamResolution.id ? loadZteamManifest(repoRoot, teamResolution.id) : undefined;
  if (team) errors.push(...team.errors);
  const requestHash = sha256(params.request ?? "");
  const defaultMode = safeMode(params.default_mode) ?? inferHotAddMode(params.request ?? "");
  if (params.default_mode && !safeMode(params.default_mode)) errors.push(`default_mode must be one of ${[...HOT_ADD_MODE_NAMES].join(",")}`);
  const slug = hotAddSlugFromText(params.request ?? "").slice(0, 48).replace(/-+$/g, "") || "agent";
  const generatedAgentId = safeZagentId(`hot-${slug}-${requestHash.slice(0, 8)}`) ?? `hot-agent-${requestHash.slice(0, 8)}`;
  const explicitAgentId = params.zagent_id ? safeZagentId(params.zagent_id) : undefined;
  if (params.zagent_id && !explicitAgentId) errors.push(`zagent_id must be a safe ZAgent id: ${params.zagent_id}`);
  const agentId = explicitAgentId ?? generatedAgentId;
  const explicitAlias = params.alias ? safeZpeerAlias(params.alias) : undefined;
  if (params.alias && !explicitAlias) errors.push(`alias must be a safe ZPeer alias: ${params.alias}`);
  const aliasBase = agentId.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z]+/, "agent_").slice(0, 32);
  const alias = explicitAlias ?? safeZpeerAlias(aliasBase) ?? `agent_${requestHash.slice(0, 8)}`;
  const role = hotAddRoleFromText(params.request ?? "", defaultMode, params.role);
  const loadedTeam = team?.manifest ?? { schema: "zob.zteam.v1", id: teamResolution.id ?? "__unresolved__", agents: [], localOnly: true, networkEnabled: false, bodyStored: false } as ZTeamManifest;
  const room = chooseHotAddRoom(loadedTeam, params.request ?? "", params.room, errors);
  const teamId = loadedTeam.id;
  const zagentPath = zagentManifestPath(repoRoot, agentId);
  const teamPath = zteamManifestPath(repoRoot, teamId);
  const promptRef = `.pi/zagents/prompts/${agentId}.md`;
  const promptPath = resolve(repoRoot, promptRef);
  const existingAgent = existsSync(zagentPath);
  const existingPrompt = existsSync(promptPath);
  const existingMember = zteamMembers(loadedTeam).some((member) => member.id === agentId);
  if (existingAgent) errors.push(`hot-add would overwrite existing zagent manifest: ${agentId}`);
  if (existingPrompt) errors.push(`hot-add would overwrite existing zagent prompt: ${promptRef}`);
  if (existingMember) errors.push(`hot-add would duplicate existing zteam member: ${agentId}`);
  const snapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, teamId);
  const proposedPeer = snapshot.peers.find((peer) => peer.team === teamId && peer.roleId === agentId);
  const proposedPresenceStatus = proposedPeer?.status ?? "none";
  if (proposedPresenceStatus === "online" || proposedPresenceStatus === "stale") errors.push(`local lease/registry evidence shows ${teamId}/${agentId} already has ${proposedPresenceStatus} presence`);
  const confirmMatched = params.apply_confirmation === teamId;
  if (action === "apply" && !confirmMatched) errors.push(`apply requires exact apply_confirmation=${teamId}`);
  const launchWindowRequested = params.tmux_window_plan === true;
  const launchWindowApproved = launchWindowRequested && params.launch_confirmation === teamId;
  if (launchWindowRequested && !launchWindowApproved) errors.push(`tmux window plan requires exact launch_confirmation=${teamId}`);
  const tools = hotAddToolsForMode(defaultMode);
  const allowedPaths = hotAddAllowedPathsForMode(defaultMode);
  const forbiddenPaths = [...HOT_ADD_FORBIDDEN_PATHS];
  const purpose = `Hot-added ${role} ZAgent for ${teamId}; derived from request hash ${requestHash.slice(0, 12)} without storing the raw request body.`;
  const scope = `Operate only in room ${room.roomId}, use explicit tools/paths, and report blockers instead of expanding authority.`;
  const presenceCheckCommand = `/zteam hot-add-presence ${teamId} ${agentId}`;
  const manualLaunchCommand = buildManualLaunchCommand(teamId, agentId);
  const tmuxWindowCommand = launchWindowRequested ? buildHotAddTmuxWindowCommand(repoRoot, loadedTeam, agentId) : undefined;
  const promptBody = buildHotAddPrompt({ teamId, agentId, alias, role, purpose, scope, defaultMode, roomId: room.roomId, tools, allowedPaths, forbiddenPaths, requestHash, presenceCheckCommand });
  const agentManifest: ZAgentManifest = {
    schema: "zob.zagent.v1",
    id: agentId,
    team: teamId,
    role,
    alias,
    description: purpose,
    promptRef,
    defaultRoom: room.roomId,
    activeRoom: room.roomId,
    rooms: [{ id: room.roomId, alias, role, active: true }],
    communicationPolicy: { zpeerContact: true, allowedRooms: [room.roomId], allowedAliases: [alias], requireActiveRoom: true },
    defaultMode,
    tools,
    metadata: { purpose, scope, allowedPaths, forbiddenPaths, approvalGates: { launch: "manual only", writes: "explicit approval required", externalAccess: "explicit approval required", commit: "governed zcommit only when owner requested" }, verification: { launchPresenceCommand: presenceCheckCommand, evidenceSource: "local lease/registry only", tmuxWindowCountsAsPresence: false }, hotAdd: { schema: "zob.zteam-hot-add.v1", teamIdHash: sha256(teamId), requestHash, sourceCommand: "zob_zteam_hot_add", teamSource: teamResolution.source, ownerApprovalRequired: true, manualLaunchOnly: true, spawnCount: 0, bodyStored: false } },
    localOnly: true,
    networkEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
  const teamManifest = zteamWithHotAddedMember(loadedTeam, { agentId, alias, role, roomId: room.roomId });
  errors.push(...validateZagentManifest(repoRoot, agentManifest, zagentPath).filter((error) => !error.startsWith("zagent.promptRef missing:")));
  errors.push(...validateZteamManifest(repoRoot, teamManifest, teamPath).filter((error) => !error.includes(`references missing project-local zagent: ${agentId}`)));
  if ((action === "plan" || action === "apply") && !(params.request ?? "").trim()) errors.push("request is required for zob_zteam_hot_add plan/apply generation");
  return { schema: "zob.zteam-hot-add-tool-plan.v1", teamId, teamSource: teamResolution.source, requestHash, agentId, alias, role, roomId: room.roomId, defaultMode, promptRef, promptPath, zagentPath, teamPath, tools, allowedPaths, forbiddenPaths, purpose, scope, manualLaunchCommand, presenceCheckCommand, tmuxWindowCommand, execute: action === "apply", confirmMatched, launchWindowRequested, launchWindowApproved, spawnCount: 0, bodyStored: false, existingAgent, existingPrompt, existingMember, proposedPresenceStatus, presenceCounts: snapshot.counts, errors: [...new Set(errors)], promptBody, agentManifest, teamManifest };
}

function buildHotAddLaunchPlan(repoRoot: string, params: HotAddToolParams): HotAddLaunchPlan {
  const errors: string[] = [];
  const teamId = safeZagentId(params.team_id ?? "") ?? "__invalid__";
  const agentId = safeZagentId(params.zagent_id ?? "") ?? "__invalid__";
  if (!params.team_id || teamId === "__invalid__") errors.push("action=launch requires safe team_id");
  if (!params.zagent_id || agentId === "__invalid__") errors.push("action=launch requires safe zagent_id");
  const teamPath = zteamManifestPath(repoRoot, teamId);
  const zagentPath = zagentManifestPath(repoRoot, agentId);
  const teamManifestExists = teamId !== "__invalid__" && existsSync(teamPath);
  const zagentManifestExists = agentId !== "__invalid__" && existsSync(zagentPath);
  if (!teamManifestExists) errors.push(`launch requires existing ZTeam manifest: ${teamId}`);
  if (!zagentManifestExists) errors.push(`launch requires existing ZAgent manifest: ${agentId}`);
  const team = teamManifestExists ? loadZteamManifest(repoRoot, teamId) : undefined;
  const agent = zagentManifestExists ? loadZagentManifest(repoRoot, agentId) : undefined;
  if (team) errors.push(...team.errors);
  if (agent) errors.push(...agent.errors);
  const membershipFound = team ? zteamMembers(team.manifest).some((member) => member.id === agentId) : false;
  if (!membershipFound) errors.push(`launch requires ZAgent membership in ZTeam: ${teamId}/${agentId}`);
  if (!pathInside(teamPath, repoRoot) || !pathInside(zagentPath, repoRoot)) errors.push("launch paths must stay inside the project cwd");
  const sessionName = chooseHotAddLaunchSession(team?.manifest, params, errors);
  const windowName = chooseHotAddLaunchWindow(agentId, errors);
  const confirmationRequired = hotAddLaunchConfirmationPhrase(teamId, agentId, sessionName);
  const confirmMatched = params.launch_confirmation_phrase === confirmationRequired;
  if (!confirmMatched) errors.push(`launch requires exact launch_confirmation_phrase: ${confirmationRequired}`);
  const presenceTimeoutMs = boundedPositiveInteger(params.presence_timeout_ms, HOT_ADD_LAUNCH_DEFAULT_TIMEOUT_MS, HOT_ADD_LAUNCH_MAX_TIMEOUT_MS);
  const presencePollMs = Math.max(100, boundedPositiveInteger(params.presence_poll_ms, HOT_ADD_LAUNCH_DEFAULT_POLL_MS, HOT_ADD_LAUNCH_MAX_POLL_MS));
  const launchCommand = agent ? chooseHotAddLaunchCommand(repoRoot, teamId, agent.manifest) : "";
  return { schema: "zob.zteam-hot-add-launch-plan.v1", teamId, agentId, sessionName, windowName, confirmationRequired, confirmMatched, teamPath, zagentPath, teamManifestExists, zagentManifestExists, membershipFound, sessionChecked: false, windowChecked: false, launchCommand, launchCommandHash: launchCommand ? sha256(launchCommand) : sha256(""), presenceTimeoutMs, presencePollMs, errors: [...new Set(errors)], liveProofBlocked: !confirmMatched };
}

async function runHotAddLaunch(repoRoot: string, plan: HotAddLaunchPlan): Promise<HotAddLaunchResult> {
  const blockers = [...plan.errors];
  let sessionExists = false;
  let windowExistsBeforeLaunch = false;
  let windowCreated = false;
  let sendKeysSent = false;
  if (blockers.length === 0) {
    sessionExists = chooseTmuxSessionExists(plan.sessionName);
    if (!sessionExists) blockers.push(`tmux session does not exist: ${plan.sessionName}`);
  }
  if (blockers.length === 0) {
    windowExistsBeforeLaunch = chooseTmuxWindowExists(plan.sessionName, plan.windowName);
    if (windowExistsBeforeLaunch) blockers.push(`tmux window already exists: ${plan.sessionName}:${plan.windowName}`);
  }
  if (blockers.length === 0) {
    const created = chooseTmuxExitStatus("tmux", ["new-window", "-d", "-t", plan.sessionName, "-n", plan.windowName], 5_000);
    windowCreated = created.ok;
    if (!created.ok) blockers.push(`tmux new-window failed with status ${String(created.status)}`);
  }
  if (blockers.length === 0) {
    const sent = chooseTmuxExitStatus("tmux", ["send-keys", "-t", `${plan.sessionName}:${plan.windowName}`, plan.launchCommand, "C-m"], 5_000);
    sendKeysSent = sent.ok;
    if (!sent.ok) blockers.push(`tmux send-keys failed with status ${String(sent.status)}`);
  }
  const presence = blockers.length === 0
    ? await waitForTeamAgentPresence(repoRoot, plan.teamId, plan.agentId, plan.presenceTimeoutMs, plan.presencePollMs)
    : { status: "none" as HotAddPresenceStatus, counts: { online: 0, stale: 0, offline: 0 } };
  if (blockers.length === 0 && presence.status !== "online") blockers.push(`ZPeer presence was not online after bounded wait: ${presence.status}`);
  const ok = blockers.length === 0 && presence.status === "online";
  return { schema: "zob.zteam-hot-add-launch-result.v1", status: ok ? "ok" : "blocked", ok, liveProofBlocked: !ok, presenceStatus: presence.status, presenceCounts: presence.counts, sessionChecked: plan.confirmMatched, sessionExists, windowChecked: plan.confirmMatched && sessionExists, windowExistsBeforeLaunch, windowCreated, sendKeysSent, spawnCount: windowCreated ? 1 : 0, launchCommandHash: plan.launchCommandHash, blockerHashes: blockers.map((blocker) => sha256(blocker)), errors: blockers };
}

function applyHotAddPlan(repoRoot: string, plan: HotAddPlan): { ok: boolean; errors: string[]; writtenPaths: string[] } {
  if (plan.errors.length > 0) return { ok: false, errors: plan.errors, writtenPaths: [] };
  const writtenPaths: string[] = [];
  try {
    mkdirSync(dirname(plan.promptPath), { recursive: true });
    mkdirSync(dirname(plan.zagentPath), { recursive: true });
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

function redactHotAddPlan(plan: HotAddPlan): Omit<HotAddPlan, "promptBody" | "agentManifest" | "teamManifest"> {
  const { promptBody: _promptBody, agentManifest: _agentManifest, teamManifest: _teamManifest, ...redacted } = plan;
  return redacted;
}

function redactHotAddLaunchPlan(plan: HotAddLaunchPlan): Omit<HotAddLaunchPlan, "launchCommand"> {
  const { launchCommand: _launchCommand, ...redacted } = plan;
  return redacted;
}

function hotAddLaunchLedgerEntry(action: string, plan: HotAddLaunchPlan, result?: HotAddLaunchResult): Record<string, unknown> {
  return { schema: "zob.zteam-hot-add-launch-tool.v1", action, status: result?.status ?? "blocked", localOnly: true, networkEnabled: false, teamIdHash: sha256(plan.teamId), agentIdHash: sha256(plan.agentId), sessionNameHash: sha256(plan.sessionName), windowNameHash: sha256(plan.windowName), confirmationPhraseHash: plan.confirmMatched ? sha256(plan.confirmationRequired) : undefined, launchCommandHash: plan.launchCommandHash, teamPathHash: sha256(plan.teamPath), zagentPathHash: sha256(plan.zagentPath), confirmMatched: plan.confirmMatched, sessionChecked: result?.sessionChecked ?? false, sessionExists: result?.sessionExists ?? false, windowChecked: result?.windowChecked ?? false, windowCreated: result?.windowCreated ?? false, sendKeysSent: result?.sendKeysSent ?? false, presenceStatus: result?.presenceStatus ?? "none", liveProofBlocked: result?.liveProofBlocked ?? true, spawnCount: result?.spawnCount ?? 0, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, blockerHashes: result?.blockerHashes ?? plan.errors.map((error) => sha256(error)), generatedAt: new Date().toISOString() };
}

function formatHotAddLaunch(plan: HotAddLaunchPlan, result?: HotAddLaunchResult): string {
  const status = result?.status ?? "blocked";
  const presence = result?.presenceStatus ?? "none";
  const liveProofBlocked = result?.liveProofBlocked ?? true;
  const errors = result?.errors ?? plan.errors;
  return [`zob_zteam_hot_add launch: team=${plan.teamId} agent=${plan.agentId} session=${plan.sessionName} window=${plan.windowName} status=${status} spawn-count=${result?.spawnCount ?? 0}`, `confirmationRequired=${plan.confirmationRequired}`, `confirmMatched=${String(plan.confirmMatched)} launchCommandHash=${plan.launchCommandHash}`, `sessionChecked=${String(result?.sessionChecked ?? false)} sessionExists=${String(result?.sessionExists ?? false)} windowCreated=${String(result?.windowCreated ?? false)} sendKeysSent=${String(result?.sendKeysSent ?? false)}`, `presence=${presence} liveProofBlocked=${String(liveProofBlocked)}`, errors.length ? `blockers=${errors.join(" | ")}` : undefined].filter((line): line is string => Boolean(line)).join("\n");
}

function hotAddLedgerEntry(action: string, plan: HotAddPlan, status: "planned" | "ok" | "blocked", extraErrors: string[] = []): Record<string, unknown> {
  return { schema: "zob.zteam-hot-add-tool.v1", action, status, localOnly: true, networkEnabled: false, teamIdHash: sha256(plan.teamId), teamSource: plan.teamSource, agentIdHash: sha256(plan.agentId), aliasHash: sha256(plan.alias), roleHash: sha256(plan.role), roomIdHash: sha256(plan.roomId), requestHash: plan.requestHash, promptRefHash: sha256(plan.promptRef), pathHashes: [plan.promptPath, plan.zagentPath, plan.teamPath].map((path) => sha256(path)), confirmationHash: plan.confirmMatched ? sha256(plan.teamId) : undefined, launchConfirmationHash: plan.launchWindowApproved ? sha256(plan.teamId) : undefined, tmuxWindowPlanHash: plan.tmuxWindowCommand ? sha256(plan.tmuxWindowCommand) : undefined, execute: plan.execute, spawnCount: 0, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, errorHashes: [...plan.errors, ...extraErrors].map((error) => sha256(error)), generatedAt: new Date().toISOString() };
}

function formatHotAddPlan(plan: HotAddPlan, writtenPaths: string[] = []): string {
  return [`zob_zteam_hot_add ${plan.execute ? "apply" : "plan"}: team=${plan.teamId} source=${plan.teamSource} agent=${plan.agentId} mode=${plan.defaultMode} execute=${String(plan.execute)} spawn-count=0 status=${plan.errors.length ? "blocked" : "ready"}`, `requestHash=${plan.requestHash}`, `promptRef=${plan.promptRef}`, `tools=${plan.tools.join(",")}`, `allowedPaths=${plan.allowedPaths.join(",")}`, `forbiddenPaths=${plan.forbiddenPaths.join(",")}`, `manualLaunch=${plan.manualLaunchCommand}`, `presenceCommand=${plan.presenceCheckCommand}`, `tmuxWindowRequested=${String(plan.launchWindowRequested)} approved=${String(plan.launchWindowApproved)} manualOnly=${plan.tmuxWindowCommand ? sha256(plan.tmuxWindowCommand) : "none"}`, writtenPaths.length ? `written=${writtenPaths.join(",")}` : undefined, plan.errors.length ? `errors=${plan.errors.join(" | ")}` : undefined].filter((line): line is string => Boolean(line)).join("\n");
}

function removeConfirmationPhrase(teamId: string, agentId: string, scope: ZteamRemoveScope): string {
  return `REMOVE ZTEAM ${teamId} ZAGENT ${agentId} SCOPE ${scope}`;
}

function zteamWithoutMember(team: ZTeamManifest, agentId: string): ZTeamManifest {
  const filterMember = (member: ZTeamMemberManifest | ZTeamAgentManifest): boolean => zteamMemberId(member) !== agentId;
  return { ...team, members: team.members?.filter(filterMember), agents: team.agents?.filter(filterMember) };
}

function buildRemoveTmuxClosePlan(repoRoot: string, params: RemoveToolParams): RemoveTmuxClosePlan {
  const errors: string[] = [];
  const teamId = safeZagentId(params.team_id ?? "") ?? "__invalid__";
  const agentId = safeZagentId(params.zagent_id ?? "") ?? "__invalid__";
  if (!params.team_id || teamId === "__invalid__") errors.push("action=close_tmux requires safe team_id");
  if (!params.zagent_id || agentId === "__invalid__") errors.push("action=close_tmux requires safe zagent_id");
  const teamPath = zteamManifestPath(repoRoot, teamId);
  const zagentPath = zagentManifestPath(repoRoot, agentId);
  const teamManifestExists = teamId !== "__invalid__" && existsSync(teamPath);
  const zagentManifestExists = agentId !== "__invalid__" && existsSync(zagentPath);
  const team = teamManifestExists ? loadZteamManifest(repoRoot, teamId) : undefined;
  if (team) errors.push(...team.errors);
  const membershipFound = team ? zteamMembers(team.manifest).some((member) => member.id === agentId) : false;
  if (!pathInside(teamPath, repoRoot) || !pathInside(zagentPath, repoRoot)) errors.push("close_tmux paths must stay inside the project cwd");
  const sessionName = chooseRemoveCloseSession(team?.manifest, params, errors);
  const window = chooseRemoveCloseWindow(agentId, params, errors);
  const confirmationRequired = removeTmuxCloseConfirmationPhrase(teamId, agentId, sessionName);
  const confirmMatched = params.close_confirmation_phrase === confirmationRequired;
  if (!confirmMatched) errors.push(`close_tmux requires exact close_confirmation_phrase: ${confirmationRequired}`);
  const gracefulTimeoutMs = boundedPositiveInteger(params.graceful_timeout_ms, REMOVE_TMUX_CLOSE_DEFAULT_GRACEFUL_TIMEOUT_MS, REMOVE_TMUX_CLOSE_MAX_GRACEFUL_TIMEOUT_MS);
  const presenceTimeoutMs = boundedPositiveInteger(params.presence_timeout_ms, REMOVE_TMUX_CLOSE_DEFAULT_TIMEOUT_MS, REMOVE_TMUX_CLOSE_MAX_TIMEOUT_MS);
  const presencePollMs = Math.max(100, boundedPositiveInteger(params.presence_poll_ms, REMOVE_TMUX_CLOSE_DEFAULT_POLL_MS, REMOVE_TMUX_CLOSE_MAX_POLL_MS));
  const presenceSnapshot = readZobLiveRegistryAllProjectsSnapshot(repoRoot, teamId);
  const target = tmuxTarget(sessionName, window.windowName);
  const gracefulCommandHash = commandHash("tmux", ["send-keys", "-t", target, "C-u", "/quit", "C-m"]);
  const targetCloseCommandHash = commandHash("tmux", ["kill-window", "-t", target]);
  return { schema: "zob.zteam-remove-tmux-close-plan.v1", teamId, agentId, sessionName, windowName: window.windowName, explicitWindowOverride: window.explicitWindowOverride, confirmationRequired, confirmMatched, teamPath, zagentPath, teamManifestExists, zagentManifestExists, membershipFound, presenceBefore: choosePresenceStatus(presenceSnapshot, teamId, agentId), presenceCountsBefore: choosePresenceCounts(presenceSnapshot), gracefulTimeoutMs, presenceTimeoutMs, presencePollMs, forceCloseWindow: params.force_close_window === true, gracefulCommandHash, targetCloseCommandHash, errors: [...new Set(errors)], liveCloseBlocked: !confirmMatched };
}

async function runRemoveTmuxClose(repoRoot: string, plan: RemoveTmuxClosePlan): Promise<RemoveTmuxCloseResult> {
  const blockers = [...plan.errors];
  let sessionExists = false;
  let windowExistedBefore = false;
  let gracefulCommandSent = false;
  let windowClosedAfterGraceful = false;
  let targetedWindowCloseUsed = false;
  let windowClosed = false;
  let presenceAfter = plan.presenceBefore;
  let presenceCountsAfter = plan.presenceCountsBefore;
  if (blockers.length === 0) {
    sessionExists = chooseTmuxSessionExists(plan.sessionName);
    if (!sessionExists) blockers.push(`tmux session does not exist: ${plan.sessionName}`);
  }
  if (blockers.length === 0) {
    windowExistedBefore = chooseTmuxWindowExists(plan.sessionName, plan.windowName);
    if (!windowExistedBefore) blockers.push(`tmux window does not exist: ${plan.sessionName}:${plan.windowName}`);
  }
  if (blockers.length === 0) {
    const target = tmuxTarget(plan.sessionName, plan.windowName);
    const graceful = chooseTmuxExitStatus("tmux", ["send-keys", "-t", target, "C-u", "/quit", "C-m"], 5_000);
    gracefulCommandSent = graceful.ok;
    if (!graceful.ok) blockers.push(`tmux graceful /quit send-keys failed with status ${String(graceful.status)}`);
  }
  if (blockers.length === 0) {
    const observed = await waitForTeamAgentNotOnlineOrWindowGone(repoRoot, plan.teamId, plan.agentId, plan.sessionName, plan.windowName, plan.gracefulTimeoutMs, plan.presencePollMs);
    presenceAfter = observed.status;
    presenceCountsAfter = observed.counts;
    windowClosedAfterGraceful = !observed.windowExists;
    windowClosed = windowClosedAfterGraceful;
  }
  if (blockers.length === 0 && !windowClosed && plan.forceCloseWindow) {
    const targetClose = chooseTmuxExitStatus("tmux", ["kill-window", "-t", tmuxTarget(plan.sessionName, plan.windowName)], 5_000);
    targetedWindowCloseUsed = targetClose.ok;
    if (!targetClose.ok) blockers.push(`targeted tmux kill-window failed with status ${String(targetClose.status)}`);
    if (targetClose.ok) {
      const observed = await waitForTeamAgentNotOnlineOrWindowGone(repoRoot, plan.teamId, plan.agentId, plan.sessionName, plan.windowName, plan.presenceTimeoutMs, plan.presencePollMs);
      presenceAfter = observed.status;
      presenceCountsAfter = observed.counts;
      windowClosed = !observed.windowExists;
    }
  }
  if (blockers.length === 0 && !windowClosed) blockers.push("target tmux window still exists after graceful close; set force_close_window=true with exact close confirmation to close only the target window");
  const ok = blockers.length === 0 && windowClosed;
  return { schema: "zob.zteam-remove-tmux-close-result.v1", status: ok ? "ok" : "blocked", ok, attempted: plan.confirmMatched, liveCloseBlocked: !ok, presenceBefore: plan.presenceBefore, presenceAfter, presenceCountsAfter, sessionChecked: plan.confirmMatched, sessionExists, windowChecked: plan.confirmMatched && sessionExists, windowExistedBefore, gracefulCommandSent, windowClosedAfterGraceful, targetedWindowCloseUsed, windowClosed, spawnCount: 0, closeCount: targetedWindowCloseUsed ? 1 : 0, blockerHashes: blockers.map((blocker) => sha256(blocker)), errors: blockers };
}

function buildRemovePlan(repoRoot: string, params: RemoveToolParams): RemovePlan {
  const errors: string[] = [];
  const action = params.action ?? "plan";
  const scope = params.scope ?? "membership";
  if (!REMOVE_SCOPES.has(scope)) errors.push(`scope must be one of ${[...REMOVE_SCOPES].join(",")}`);
  if (!projectZteamManifestExists(repoRoot, params.team_id)) errors.push(`team_id must reference a project-local ZTeam: ${params.team_id}`);
  if (safeZagentId(params.zagent_id) !== params.zagent_id) errors.push(`zagent_id must be a safe ZAgent id: ${params.zagent_id}`);
  const team = loadZteamManifest(repoRoot, params.team_id);
  errors.push(...team.errors);
  const teamPath = zteamManifestPath(repoRoot, params.team_id);
  const zagentPath = zagentManifestPath(repoRoot, params.zagent_id);
  const loadedAgent = loadZagentManifest(repoRoot, params.zagent_id);
  const promptPath = loadedAgent.promptPath;
  const promptRoot = resolve(repoRoot, ".pi/zagents/prompts");
  const promptPathSafe = Boolean(promptPath && pathInside(promptPath, promptRoot));
  const membershipFound = zteamMembers(team.manifest).some((member) => member.id === params.zagent_id);
  const manifestExists = existsSync(zagentPath);
  const promptExists = Boolean(promptPath && promptPathSafe && existsSync(promptPath));
  const removeMembershipPlanned = scope === "membership" || scope === "manifest" || scope === "prompt" || scope === "manifest_and_prompt";
  const deleteManifestPlanned = scope === "manifest" || scope === "manifest_and_prompt";
  const deletePromptPlanned = scope === "prompt" || scope === "manifest_and_prompt";
  const confirmationRequired = removeConfirmationPhrase(params.team_id, params.zagent_id, scope);
  const confirmMatched = params.confirmation_phrase === confirmationRequired;
  if (action === "apply" && !confirmMatched) errors.push(`apply requires exact confirmation_phrase: ${confirmationRequired}`);
  if (removeMembershipPlanned && !membershipFound) errors.push(`zagent is not a member of team: ${params.zagent_id}`);
  if (deleteManifestPlanned && !manifestExists) errors.push(`zagent manifest is missing: ${params.zagent_id}`);
  if (deletePromptPlanned && !promptPathSafe) errors.push(`zagent prompt path is missing or outside .pi/zagents/prompts: ${params.zagent_id}`);
  if (deletePromptPlanned && promptPathSafe && !promptExists) errors.push(`zagent prompt is missing: ${params.zagent_id}`);
  const tmuxPlanRequested = params.include_tmux_plan === true;
  const tmuxPlanApproved = tmuxPlanRequested && params.tmux_confirmation_phrase === `PLAN TMUX REMOVE ${params.team_id} ${params.zagent_id}`;
  if (tmuxPlanRequested && !tmuxPlanApproved) errors.push(`tmux remove plan requires exact tmux_confirmation_phrase: PLAN TMUX REMOVE ${params.team_id} ${params.zagent_id}`);
  const manualTmuxPlan = tmuxPlanRequested ? `manual only: inspect scoped session for ${params.team_id}/${params.zagent_id}; no kill/close/restart is executed by zob_zteam_remove` : undefined;
  const nextTeamManifest = removeMembershipPlanned ? zteamWithoutMember(team.manifest, params.zagent_id) : undefined;
  const nextAgentManifest = deletePromptPlanned && !deleteManifestPlanned && manifestExists ? { ...loadedAgent.manifest, promptRef: undefined } as ZAgentManifest : undefined;
  if (nextTeamManifest) errors.push(...validateZteamManifest(repoRoot, nextTeamManifest, teamPath));
  if (nextAgentManifest) errors.push(...validateZagentManifest(repoRoot, nextAgentManifest, zagentPath));
  return { schema: "zob.zteam-remove-tool-plan.v1", teamId: params.team_id, agentId: params.zagent_id, scope, confirmationRequired, confirmMatched, execute: action === "apply", spawnCount: 0, bodyStored: false, teamPath, zagentPath, promptPath, membershipFound, manifestExists, promptExists, removeMembershipPlanned, deleteManifestPlanned, deletePromptPlanned, tmuxPlanRequested, tmuxPlanApproved, manualTmuxPlan, errors: [...new Set(errors)], nextTeamManifest, nextAgentManifest };
}

function applyRemovePlan(plan: RemovePlan): { ok: boolean; errors: string[]; changedPaths: string[] } {
  if (plan.errors.length > 0) return { ok: false, errors: plan.errors, changedPaths: [] };
  const changedPaths: string[] = [];
  try {
    if (plan.removeMembershipPlanned && plan.nextTeamManifest) {
      writeFileSync(plan.teamPath, `${JSON.stringify(plan.nextTeamManifest, null, 2)}\n`, "utf8");
      changedPaths.push(plan.teamPath);
    }
    if (plan.nextAgentManifest && !plan.deleteManifestPlanned) {
      writeFileSync(plan.zagentPath, `${JSON.stringify(plan.nextAgentManifest, null, 2)}\n`, "utf8");
      changedPaths.push(plan.zagentPath);
    }
    if (plan.deleteManifestPlanned) {
      unlinkSync(plan.zagentPath);
      changedPaths.push(plan.zagentPath);
    }
    if (plan.deletePromptPlanned && plan.promptPath) {
      unlinkSync(plan.promptPath);
      changedPaths.push(plan.promptPath);
    }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], changedPaths };
  }
  return { ok: true, errors: [], changedPaths };
}

function redactRemovePlan(plan: RemovePlan): Omit<RemovePlan, "nextTeamManifest" | "nextAgentManifest"> {
  const { nextTeamManifest: _nextTeamManifest, nextAgentManifest: _nextAgentManifest, ...redacted } = plan;
  return redacted;
}

function removeTmuxCloseLedgerEntry(action: string, plan: RemoveTmuxClosePlan, result?: RemoveTmuxCloseResult): Record<string, unknown> {
  return { schema: "zob.zteam-remove-tmux-close-tool.v1", action, status: result?.status ?? "blocked", localOnly: true, networkEnabled: false, teamIdHash: sha256(plan.teamId), agentIdHash: sha256(plan.agentId), sessionNameHash: sha256(plan.sessionName), windowNameHash: sha256(plan.windowName), explicitWindowOverride: plan.explicitWindowOverride, confirmationPhraseHash: plan.confirmMatched ? sha256(plan.confirmationRequired) : undefined, teamPathHash: sha256(plan.teamPath), zagentPathHash: sha256(plan.zagentPath), gracefulCommandHash: plan.gracefulCommandHash, targetCloseCommandHash: plan.targetCloseCommandHash, confirmMatched: plan.confirmMatched, teamManifestExists: plan.teamManifestExists, zagentManifestExists: plan.zagentManifestExists, membershipFound: plan.membershipFound, presenceBefore: plan.presenceBefore, presenceAfter: result?.presenceAfter ?? "none", sessionChecked: result?.sessionChecked ?? false, sessionExists: result?.sessionExists ?? false, windowChecked: result?.windowChecked ?? false, windowExistedBefore: result?.windowExistedBefore ?? false, gracefulCommandSent: result?.gracefulCommandSent ?? false, windowClosed: result?.windowClosed ?? false, targetedWindowCloseUsed: result?.targetedWindowCloseUsed ?? false, liveCloseBlocked: result?.liveCloseBlocked ?? true, spawnCount: 0, closeCount: result?.closeCount ?? 0, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, blockerHashes: result?.blockerHashes ?? plan.errors.map((error) => sha256(error)), generatedAt: new Date().toISOString() };
}

function formatRemoveTmuxClose(plan: RemoveTmuxClosePlan, result?: RemoveTmuxCloseResult): string {
  const status = result?.status ?? "blocked";
  const errors = result?.errors ?? plan.errors;
  return [`zob_zteam_remove close_tmux: team=${plan.teamId} agent=${plan.agentId} session=${plan.sessionName} window=${plan.windowName} status=${status} spawn-count=0 close-count=${result?.closeCount ?? 0}`, `confirmationRequired=${plan.confirmationRequired}`, `confirmMatched=${String(plan.confirmMatched)} gracefulCommandHash=${plan.gracefulCommandHash} targetCloseCommandHash=${plan.targetCloseCommandHash}`, `windowExistedBefore=${String(result?.windowExistedBefore ?? false)} gracefulCommandSent=${String(result?.gracefulCommandSent ?? false)} windowClosed=${String(result?.windowClosed ?? false)} targetedWindowCloseUsed=${String(result?.targetedWindowCloseUsed ?? false)}`, `presenceBefore=${plan.presenceBefore} presenceAfter=${result?.presenceAfter ?? "none"} liveCloseBlocked=${String(result?.liveCloseBlocked ?? true)}`, errors.length ? `blockers=${errors.join(" | ")}` : undefined].filter((line): line is string => Boolean(line)).join("\n");
}

function removeLedgerEntry(action: string, plan: RemovePlan, status: "planned" | "ok" | "blocked", extraErrors: string[] = []): Record<string, unknown> {
  return { schema: "zob.zteam-remove-tool.v1", action, status, localOnly: true, networkEnabled: false, teamIdHash: sha256(plan.teamId), agentIdHash: sha256(plan.agentId), scopeHash: sha256(plan.scope), confirmationPhraseHash: plan.confirmMatched ? sha256(plan.confirmationRequired) : undefined, pathHashes: [plan.teamPath, plan.zagentPath, plan.promptPath ?? ""].filter(Boolean).map((path) => sha256(path)), execute: plan.execute, spawnCount: 0, deleteManifestPlanned: plan.deleteManifestPlanned, deletePromptPlanned: plan.deletePromptPlanned, agentManifestUpdated: Boolean(plan.nextAgentManifest), removeMembershipPlanned: plan.removeMembershipPlanned, tmuxPlanRequested: plan.tmuxPlanRequested, tmuxPlanApproved: plan.tmuxPlanApproved, bodyStored: false, promptBodiesStored: false, outputBodiesStored: false, errorHashes: [...plan.errors, ...extraErrors].map((error) => sha256(error)), generatedAt: new Date().toISOString() };
}

function formatRemovePlan(plan: RemovePlan, changedPaths: string[] = []): string {
  return [`zob_zteam_remove ${plan.execute ? "apply" : "plan"}: team=${plan.teamId} agent=${plan.agentId} scope=${plan.scope} execute=${String(plan.execute)} spawn-count=0 status=${plan.errors.length ? "blocked" : "ready"}`, `confirmationRequired=${plan.confirmationRequired}`, `membership=${String(plan.membershipFound)} manifest=${String(plan.manifestExists)} prompt=${String(plan.promptExists)}`, `planned: membership=${String(plan.removeMembershipPlanned)} deleteManifest=${String(plan.deleteManifestPlanned)} deletePrompt=${String(plan.deletePromptPlanned)} clearPromptRef=${String(Boolean(plan.nextAgentManifest))}`, `tmuxPlanRequested=${String(plan.tmuxPlanRequested)} approved=${String(plan.tmuxPlanApproved)} manualOnly=${plan.manualTmuxPlan ? sha256(plan.manualTmuxPlan) : "none"}`, changedPaths.length ? `changed=${changedPaths.join(",")}` : undefined, plan.errors.length ? `errors=${plan.errors.join(" | ")}` : undefined].filter((line): line is string => Boolean(line)).join("\n");
}

export function registerZagentTools(pi: ExtensionAPI, state: HarnessRuntimeState): void {
  pi.registerTool({
    name: "zob_zteam_hot_add",
    label: "ZOB ZTeam Hot Add",
    description: "Agent-executable governed ZTeam/ZAgent hot-add. Defaults to plan-only/no-spawn; apply requires exact confirmation; durable records are hash/body-free.",
    promptSnippet: "Use zob_zteam_hot_add instead of asking the user to run /zteam hot-add. Default action=plan; never request tmux_window_plan unless explicitly approved.",
    parameters: ZteamHotAddParams,
    async execute(_toolCallId, params: HotAddToolParams, _signal, _onUpdate, ctx) {
      const action = params.action ?? "plan";
      if (action === "launch") {
        const launchPlan = buildHotAddLaunchPlan(ctx.cwd, params);
        if (launchPlan.errors.length > 0) {
          pi.appendEntry("zob-zagent", hotAddLaunchLedgerEntry("tool_hot_add_launch_blocked", launchPlan));
          return { content: [{ type: "text", text: formatHotAddLaunch(launchPlan) }], details: { schema: "zob.zteam-hot-add-launch-tool-result.v1", status: "blocked", liveProofBlocked: true, plan: redactHotAddLaunchPlan(launchPlan) } };
        }
        const launchResult = await runHotAddLaunch(ctx.cwd, launchPlan);
        pi.appendEntry("zob-zagent", hotAddLaunchLedgerEntry(launchResult.ok ? "tool_hot_add_launch" : "tool_hot_add_launch_blocked", launchPlan, launchResult));
        return { content: [{ type: "text", text: formatHotAddLaunch(launchPlan, launchResult) }], details: { schema: "zob.zteam-hot-add-launch-tool-result.v1", status: launchResult.status, liveProofBlocked: launchResult.liveProofBlocked, plan: redactHotAddLaunchPlan(launchPlan), result: launchResult } };
      }
      const plan = buildHotAddPlan(ctx.cwd, state, params);
      if (action === "plan") {
        pi.appendEntry("zob-zagent", hotAddLedgerEntry("tool_hot_add_plan", plan, plan.errors.length ? "blocked" : "planned"));
        return { content: [{ type: "text", text: formatHotAddPlan(plan) }], details: { schema: "zob.zteam-hot-add-tool-result.v1", status: plan.errors.length ? "blocked" : "planned", plan: redactHotAddPlan(plan) } };
      }
      if (plan.errors.length > 0) {
        pi.appendEntry("zob-zagent", hotAddLedgerEntry("tool_hot_add_apply_blocked", plan, "blocked"));
        return { content: [{ type: "text", text: formatHotAddPlan(plan) }], details: { schema: "zob.zteam-hot-add-tool-result.v1", status: "blocked", plan: redactHotAddPlan(plan) } };
      }
      const result = applyHotAddPlan(ctx.cwd, plan);
      pi.appendEntry("zob-zagent", hotAddLedgerEntry(result.ok ? "tool_hot_add_apply" : "tool_hot_add_apply_failed", plan, result.ok ? "ok" : "blocked", result.errors));
      return { content: [{ type: "text", text: formatHotAddPlan(plan, result.writtenPaths) }], details: { schema: "zob.zteam-hot-add-tool-result.v1", status: result.ok ? "ok" : "blocked", plan: redactHotAddPlan(plan), writtenPaths: result.writtenPaths, errors: result.errors } };
    },
  });

  pi.registerTool({
    name: "zob_zteam_remove",
    label: "ZOB ZTeam Remove",
    description: "Agent-executable governed ZTeam/ZAgent remove/delete/close planner. Defaults to plan-only; exact confirmation is required for membership removal, manifest/prompt deletion, or targeted tmux-window close.",
    promptSnippet: "Use zob_zteam_remove for governed removal. Default action=plan; apply requires exact confirmation_phrase; close_tmux requires exact close_confirmation_phrase and targets only one existing tmux window.",
    parameters: ZteamRemoveParams,
    async execute(_toolCallId, params: RemoveToolParams, _signal, _onUpdate, ctx) {
      if ((params.action ?? "plan") === "close_tmux") {
        const closePlan = buildRemoveTmuxClosePlan(ctx.cwd, params);
        if (closePlan.errors.length > 0) {
          pi.appendEntry("zob-zagent", removeTmuxCloseLedgerEntry("tool_remove_close_tmux_blocked", closePlan));
          return { content: [{ type: "text", text: formatRemoveTmuxClose(closePlan) }], details: { schema: "zob.zteam-remove-tmux-close-tool-result.v1", status: "blocked", liveCloseBlocked: true, plan: closePlan } };
        }
        const closeResult = await runRemoveTmuxClose(ctx.cwd, closePlan);
        pi.appendEntry("zob-zagent", removeTmuxCloseLedgerEntry(closeResult.ok ? "tool_remove_close_tmux" : "tool_remove_close_tmux_blocked", closePlan, closeResult));
        return { content: [{ type: "text", text: formatRemoveTmuxClose(closePlan, closeResult) }], details: { schema: "zob.zteam-remove-tmux-close-tool-result.v1", status: closeResult.status, liveCloseBlocked: closeResult.liveCloseBlocked, plan: closePlan, result: closeResult } };
      }
      const plan = buildRemovePlan(ctx.cwd, params);
      if ((params.action ?? "plan") === "plan") {
        pi.appendEntry("zob-zagent", removeLedgerEntry("tool_remove_plan", plan, plan.errors.length ? "blocked" : "planned"));
        return { content: [{ type: "text", text: formatRemovePlan(plan) }], details: { schema: "zob.zteam-remove-tool-result.v1", status: plan.errors.length ? "blocked" : "planned", plan: redactRemovePlan(plan) } };
      }
      if (plan.errors.length > 0) {
        pi.appendEntry("zob-zagent", removeLedgerEntry("tool_remove_apply_blocked", plan, "blocked"));
        return { content: [{ type: "text", text: formatRemovePlan(plan) }], details: { schema: "zob.zteam-remove-tool-result.v1", status: "blocked", plan: redactRemovePlan(plan) } };
      }
      const result = applyRemovePlan(plan);
      pi.appendEntry("zob-zagent", removeLedgerEntry(result.ok ? "tool_remove_apply" : "tool_remove_apply_failed", plan, result.ok ? "ok" : "blocked", result.errors));
      return { content: [{ type: "text", text: formatRemovePlan(plan, result.changedPaths) }], details: { schema: "zob.zteam-remove-tool-result.v1", status: result.ok ? "ok" : "blocked", plan: redactRemovePlan(plan), changedPaths: result.changedPaths, errors: result.errors } };
    },
  });
}
