#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const files = [
  '.pi/extensions/zob-harness/src/domains/coms/zagents.ts',
  '.pi/extensions/zob-harness/src/runtime/commands.ts',
  '.pi/extensions/zob-harness/src/runtime/events.ts',
  '.pi/extensions/zob-harness/src/runtime/state.ts',
  '.pi/extensions/zob-harness/src/runtime/widget.ts',
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/zpeer.ts',
  '.pi/capabilities/zob-public-runtime-capabilities.json',
  '.pi/extensions/zob-harness/src/core/constants.ts',
  '.pi/skills/zob-zagent-creator/SKILL.md',
  '.pi/skills/zob-factory/SKILL.md',
  '.pi/zteams/zob-harness-devs.json',
  '.pi/zteams/zob-harness-devs.modes.json',
  '.pi/zteams/zob-harness-devs.tmux.sh',
];
const contents = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
const failures = [];

function parseJson(file) {
  try {
    return JSON.parse(contents[file]);
  } catch (error) {
    failures.push(`${file} must parse as JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function requireCondition(condition, message) {
  if (!condition) failures.push(message);
}

function requireIncludes(file, needles, label = file) {
  for (const needle of needles) {
    if (!contents[file].includes(needle)) failures.push(`${label} missing ${needle}`);
  }
}

function parseConstStringArray(name) {
  const source = contents['.pi/extensions/zob-harness/src/core/constants.ts'];
  const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`, 's'));
  if (!match) {
    failures.push(`constants missing ${name} string array`);
    return [];
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function expandModeTools(modeName) {
  const source = contents['.pi/extensions/zob-harness/src/core/constants.ts'];
  const match = source.match(new RegExp(`${modeName}: \\[([^\\]]*)\\]`, 's'));
  if (!match) {
    failures.push(`constants MODE_TOOLS missing ${modeName}`);
    return [];
  }
  const directTools = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  const spreadTools = [...match[1].matchAll(/\.\.\.([A-Z0-9_]+)/g)].flatMap((entry) => parseConstStringArray(entry[1]));
  return [...new Set([...directTools, ...spreadTools])];
}

const zagents = contents['.pi/extensions/zob-harness/src/domains/coms/zagents.ts'];
requireIncludes('.pi/extensions/zob-harness/src/domains/coms/zagents.ts', [
  'const ZAGENTS_DIR = ".pi/zagents"',
  'const ZTEAMS_DIR = ".pi/zteams"',
  'const ZAGENT_PROMPTS_DIR = ".pi/zagents/prompts"',
  'const ZTEAM_MODE_PACK_SCHEMA_ID = "zob.zteam-modes.v1"',
  'export const ZTEAM_MODE_PACK_SCHEMA',
  'export function normalizeZagentRoomBindings',
  'export function readZagentPrompt',
  'export function loadZagentManifest',
  'export function loadZteamManifest',
  'export function listZagentManifests',
  'export function listZteamManifests',
  'export function loadZteamModePack',
  'export function validateZteamModePack',
  'export function resolveZteamScopedMode',
  'export function zteamAllowsZpeerContact',
  'export function resolveZagentTeamMemberships',
  'export function resolveZagentRuntimeRoomBindings',
  'localOnly: true',
  'zagent.model must be a safe Pi --model pattern',
  'zagent.defaultMode must be one of',
  'networkEnabled: false',
  'bodyStored: false',
  'allowedToolsExplicit',
  'zteam mode pack must match zob.zteam-modes.v1 shape',
  'baseMode vanilla requires explicit owner-approved metadata',
  'allowedTools must be a subset of MODE_TOOLS',
  'modePackRef must stay under ${ZTEAMS_DIR}',
  'zteam.metadata.modePackRef must not reference secret/key/env paths',
]);
if (!zagents.includes('join(projectZagentsDir(repoRoot), `${safeZagentId(id) ?? "__invalid__"}.json`)')) failures.push('zagents loader must resolve manifests under .pi/zagents');
if (!zagents.includes('join(projectZteamsDir(repoRoot), `${safeZagentId(id) ?? "__invalid__"}.json`)')) failures.push('zagents loader must resolve manifests under .pi/zteams');

const canonicalModeNames = ['explore', 'plan', 'implement', 'oracle', 'factory', 'orchestrator', 'vanilla'];
const canonicalModeSetLiteral = 'new Set<ModeName>(["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla"])';
requireCondition(zagents.includes(canonicalModeSetLiteral), 'zagents must not add custom global ModeName values for scoped ZTeam modes');

const harnessTeam = parseJson('.pi/zteams/zob-harness-devs.json');
const harnessModePack = parseJson('.pi/zteams/zob-harness-devs.modes.json');
if (harnessTeam && harnessModePack) {
  requireCondition(harnessModePack.schema === 'zob.zteam-modes.v1', 'harness scoped mode pack schema must be zob.zteam-modes.v1');
  requireCondition(harnessModePack.teamId === harnessTeam.id, 'harness scoped mode pack teamId must match ZTeam id');
  requireCondition(harnessModePack.localOnly === true, 'harness scoped mode pack localOnly must be true');
  requireCondition(harnessModePack.networkEnabled === false, 'harness scoped mode pack networkEnabled must be false');
  requireCondition(harnessModePack.bodyStored === false, 'harness scoped mode pack bodyStored must be false');
  requireCondition(harnessModePack.defaults?.byAgent?.['harness-chief'] === 'chief-coordinator', 'harness-chief default must be chief-coordinator');
  requireCondition(Array.isArray(harnessModePack.modes) && harnessModePack.modes.length > 0, 'harness scoped mode pack must define scoped modes');
  const chiefMode = harnessModePack.modes?.find((mode) => mode.id === 'chief-coordinator');
  requireCondition(Boolean(chiefMode), 'harness scoped mode pack must define chief-coordinator mode');
  requireCondition(chiefMode?.baseMode === 'orchestrator', 'chief-coordinator baseMode must be orchestrator');
  const chiefAllowedTools = chiefMode?.toolPolicy?.allowedTools;
  requireCondition(Array.isArray(chiefAllowedTools) && chiefAllowedTools.length > 0, 'chief-coordinator must set explicit toolPolicy.allowedTools');
  const orchestratorToolSet = new Set(expandModeTools('orchestrator'));
  for (const tool of chiefAllowedTools ?? []) {
    requireCondition(orchestratorToolSet.has(tool), `chief-coordinator allowedTool must be in MODE_TOOLS.orchestrator: ${tool}`);
  }
  for (const requiredTool of [
    'read',
    'grep',
    'find',
    'ls',
    'get_goal',
    'get_goal_todos',
    'update_goal_todo',
    'resolve_goal_todo',
    'zob_delegation_catalog',
    'zob_coms_status',
    'zob_coms_list',
    'zob_coms_get',
    'zob_coms_await',
    'zpeer_ask',
    'zob_goal_room_send',
    'zob_goal_room_list',
    'zob_coms_readiness',
    'zob_mission_control_snapshot',
  ]) {
    requireCondition(chiefAllowedTools?.includes(requiredTool), `chief-coordinator missing required coordination tool: ${requiredTool}`);
  }
  for (const forbiddenTool of [
    'edit',
    'write',
    'bash',
    'delegate_task',
    'delegate_agent',
    'orchestrate_run',
    'chain_run',
    'zob_zcommit_run',
    'zob_workspace_claim',
    'zob_workspace_release',
    'zob_workspace_claims_list',
    'zob_worker_pool_plan',
    'zob_worker_pool_status',
    'zob_worker_pool_owner_request',
    'zob_worker_pool_owner_decision',
    'zob_merge_candidate_submit',
    'zob_merge_queue_decide',
    'zob_merge_queue_list',
    'factory_run',
    'factory_quarantine_review',
    'factory_quarantine_activate',
    'factory_quarantine_verify_activation',
    'zob_project_dna_writeback_proposal',
    'zob_context_writeback_proposal',
    'zob_compute_write_profile_reports',
  ]) {
    requireCondition(!chiefAllowedTools?.includes(forbiddenTool), `chief-coordinator must not allow ${forbiddenTool}`);
  }
  for (const [index, mode] of (harnessModePack.modes ?? []).entries()) {
    requireCondition(typeof mode.id === 'string' && mode.id.length > 0, `harness scoped mode ${index} must have an id`);
    requireCondition(canonicalModeNames.includes(mode.baseMode), `harness scoped mode ${mode.id ?? index} baseMode must be canonical`);
    requireCondition(mode.baseMode !== 'vanilla', `harness scoped mode ${mode.id ?? index} must not use vanilla without owner-specific fixture`);
    requireCondition(!Object.prototype.hasOwnProperty.call(mode, 'allowedTools'), `harness scoped mode ${mode.id ?? index} must not use top-level allowedTools`);
    if (mode.id !== 'chief-coordinator') {
      requireCondition(!(mode.toolPolicy && Object.prototype.hasOwnProperty.call(mode.toolPolicy, 'allowedTools')), `harness scoped mode ${mode.id ?? index} must not set explicit allowedTools unless it is chief-coordinator`);
    }
  }
  const contract = harnessModePack.metadata?.teamContractPack;
  requireCondition(contract?.parentVisible === true, 'team contract pack must be parent-visible');
  requireCondition(contract?.hiddenPeerChat === false, 'team contract pack must disable hidden peer chat');
  requireCondition(contract?.networkEnabled === false, 'team contract pack must disable network');
  requireCondition(contract?.bodyStored === false, 'team contract pack must be body-free');
  requireCondition(contract?.launchIsManual === true, 'team contract pack launch must be manual');
  requireCondition(contract?.spawnCountFromLaunchPlan === 0, 'team contract pack launch-plan spawn count must be 0');

  const rawModePackRef = harnessTeam.metadata?.modePackRef;
  requireCondition(typeof rawModePackRef === 'string' && rawModePackRef.length > 0, 'ZTeam metadata.modePackRef must be present');
  const normalizedModePackRef = typeof rawModePackRef === 'string'
    ? rawModePackRef.startsWith('.pi/') ? rawModePackRef : join('.pi/zteams', rawModePackRef)
    : '';
  const resolvedModePackRef = resolve(process.cwd(), normalizedModePackRef);
  const resolvedZteamsDir = resolve(process.cwd(), '.pi/zteams');
  requireCondition(normalizedModePackRef.startsWith('.pi/zteams/'), 'modePackRef must normalize under .pi/zteams/');
  requireCondition(resolvedModePackRef.startsWith(`${resolvedZteamsDir}/`), 'modePackRef resolved path must stay under .pi/zteams');
  requireCondition(normalizedModePackRef.endsWith('.json'), 'modePackRef must point to a JSON file');
  requireCondition(!/[\\/](?:\.env)(?:[\\/]|$)|secret|key/i.test(normalizedModePackRef), 'modePackRef must not reference env/secret/key paths');
}

const commands = contents['.pi/extensions/zob-harness/src/runtime/commands.ts'];
const zagentCommandMatches = commands.match(/registerCommand\("zagent"/g) ?? [];
if (zagentCommandMatches.length !== 1) failures.push(`expected exactly one /zagent command, found ${zagentCommandMatches.length}`);
const zteamCommandMatches = commands.match(/registerCommand\("zteam"/g) ?? [];
if (zteamCommandMatches.length !== 1) failures.push(`expected exactly one /zteam command, found ${zteamCommandMatches.length}`);
requireIncludes('.pi/extensions/zob-harness/src/runtime/commands.ts', [
  'formatZagentList',
  'formatZteamList',
  'listZagentManifests',
  'listZteamManifests',
  'loadZagentManifest',
  'loadZteamManifest',
  'normalizeZagentRoomBindings',
  'readZagentPrompt',
  'readZobLiveRegistryAllProjectsSnapshot',
  'MODE_TOOLS',
  'validateZagentManifest',
  'validateZteamManifest',
  'zagentManifestPath',
  'zteamManifestPath',
  'ZOB_ZTEAM_ID=${team.id} ZOB_ZAGENT_ID=${member.id} pi',
  'ZOB_ZAGENT_ID=${member.id} pi',
  '--model ${model}',
  'modelIdHashes: plan.modelIds.map((modelId) => sha256(modelId))',
  'defaultModeHashes: plan.defaultModes.map((mode) => sha256(mode))',
  'defaultMode=${defaultMode}',
  'After each session starts, run /zagent use <id> to bind its ZPeer alias/rooms.',
  'loadActiveZagentScopedMode(state, ctx.cwd)',
  'scoped mode blocked',
  'Project-local full-session ZAgents',
  'Project-local ZTeams',
  'launch-plan printed; spawn count=0',
  'spawn-count=0',
  'hot-add [id] <ask>',
  'hot-add [team-id] <natural-language ask>',
  'reset|reload|quit [team-id] [--dry-run]',
  'reset-plan ${id}',
  'reload-plan ${id}',
  'quit-plan ${id}',
  'zob.zteam-hot-add-command.v1',
  'zteam_hot_add_plan',
  'zteam_hot_add_apply_blocked',
  'zteam_hot_add_apply',
  'parseZteamHotAddArgs(ctx.cwd, parts)',
  'resolveZteamHotAddTeamId(ctx.cwd, state, parsed.id)',
  'source: "env"',
  'source: "zagent"',
  'source: "zpeer"',
  'source: "activeRoom"',
  'source: "repoConvention"',
  'promptRef = `.pi/zagents/prompts/${agentId}.md`',
  'promptBody = buildHotAddPrompt',
  'tools = hotAddToolsForMode(defaultMode)',
  'allowedPaths = hotAddAllowedPathsForMode(defaultMode)',
  'forbiddenPaths = [...HOT_ADD_FORBIDDEN_PATHS]',
  'approvalGates',
  'hot-add-presence',
  'zob.zteam-hot-add-presence.v1',
  'tmuxWindowCountsAsPresence: false',
  'presence check after manual launch',
  'tmux-window plan command (manual only)',
  'apply requires explicit confirmation: --apply --confirm ${team.id}',
  'optional tmux window launch requires explicit approval: --tmux-window --launch-confirm ${team.id}',
  'presence evidence: local lease/registry snapshot via readZobLiveRegistryAllProjectsSnapshot',
  'raw ask bodies are hashed and not stored in durable command records',
  'hot-add never launches tmux/pi automatically',
  'writeFileSync(plan.promptPath',
  'writeFileSync(plan.zagentPath',
  'bodyStored: false',
  'type ZteamTmuxAction = "reset" | "reload" | "quit"',
  'resolveCurrentZteamId',
  'resolveZteamCommandTeamId(ctx.cwd, state, parsed.id)',
  'zob.zteam-tmux-action-command.v1',
  'zteam_${requestedAction}_dry_run',
  'zteam_${requestedAction}_execute_blocked',
  'zteam_${requestedAction}_execute',
  'execute blocked: optional --confirm must exactly match',
  'tmuxLauncher must be a project-local .pi/zteams/*.tmux.sh path',
  'newPlanned: boolean',
  'reloadPlanned: boolean',
  'quitPlanned: boolean',
  'launcherBody.includes("send_new_to_agents")',
  'launcherBody.includes("send_reload_to_agents")',
  'execute blocked: launcher does not expose ${requiredLauncherAction} action for /zteam ${action}',
  'spawnSync("bash", [plan.launcherPath, "status"]',
  'lease cleanup planned: ${String(plan.leaseCleanupPlanned)} (runtime owns graceful release/reclaim)',
  'new planned: ${String(plan.newPlanned)}',
  'reload planned: ${String(plan.reloadPlanned)}',
  'quit planned: ${String(plan.quitPlanned)}',
  'actions: status -> ${plan.launcherAction ?? zteamLauncherActionFor(plan.requestedAction)}',
  'spawnSync("bash", [plan.launcherPath, plan.launcherAction]',
  'dry-run only: no tmux and no ${actionDescription} sent',
  'part === "--dry-run" || part === "--plan"',
  'confirmMatched',
  'launcherHash',
  'agentIdHashes: plan.agentIds.map((agentId) => sha256(agentId))',
  'roomIdHashes: plan.roomIds.map((roomId) => sha256(roomId))',
  'modePackRef=',
  'Scoped modes available:',
  'scopedMode=${effectiveScoped} baseMode=${effectiveBaseMode ?? "current"}',
  'writeZpeerLocalProfileFromPeer(ctx.cwd, state.zobLive.peerCard, zpeerCommandProfileId(ctx))',
  'promptHash=',
  'bodyStored: false',
], 'commands');
if (!commands.includes('if (!options.execute)')) failures.push('zteam reset dry-run branch must use resolved options, so reset-plan cannot execute');
if (commands.includes('if (!parsed.options.execute)')) failures.push('zteam reset dry-run branch must not use pre-reset-plan parsed options');

requireIncludes('.pi/extensions/zob-harness/src/runtime/events.ts', [
  'function loadActiveZagentFromEnv',
  'process.env.ZOB_ZAGENT_ID?.trim()',
  'loadZagentManifest(repoRoot, zagentId)',
  'readZagentPrompt(repoRoot, manifest.promptRef)',
  'resolveZagentRuntimeRoomBindings(repoRoot, manifest)',
  'state.zagent = nextZagent',
  'defaultMode: manifest.defaultMode',
  'loadActiveZagentFromEnv(state, ctx.cwd)',
  'loadActiveZagentScopedMode(state, ctx.cwd)',
  'const scopedMode = activeZagentState(state)?.scopedMode',
  'function zagentLockedMode',
  'locks auto-mode',
  'const lockedMode = zagentLockedMode(state);',
  'scopedMode.baseMode ?? state.zagent.defaultMode ?? "explore"',
  'ZAGENT RUNTIME ACTIVATION',
  'ZAgents are full Pi sessions tied to ZPeer/live coordination, not delegate subagents.',
  'team: zagent?.team ?? basePeer.team',
  'teams: resolved.teamIds',
  'roleId: zagent?.id ?? basePeer.roleId',
  'agent: zagent?.id ?? basePeer.agent',
  'team: zagent?.team ?? state.zobLive.peerCard.team',
  'roleId: zagent?.id ?? state.zobLive.peerCard.roleId',
  'agent: zagent?.id ?? state.zobLive.peerCard.agent',
  'claimZobLiveTeamAgentLease(repoRoot, peerCard, { reason: "runtime_start" })',
  'claimZobLiveTeamAgentLease(repoRoot, peerCard, { reason: "runtime_refresh" })',
  'stopLeaseBlockedLocalEndpoint(state, repoRoot, peerCard, server)',
  'duplicate local endpoint stopped and peer marked offline',
  'state.zobLive.leaseOwned = true',
  'state.zobLive.leaseOwned = false',
  'releaseZobLiveTeamAgentLease(repoRoot, state.zobLive.peerCard, { reason: "session_shutdown" })',
], 'events');

requireIncludes('.pi/extensions/zob-harness/src/runtime/state.ts', [
  'export interface ZagentRuntimeState',
  'team?: string;',
  'teams?: string[];',
  'role?: string;',
  'alias?: string;',
  'rooms: ZAgentRoomBinding[];',
  'defaultMode?: ModeName;',
  'ZagentScopedModeRuntimeState',
  'allowedToolsExplicit?: boolean;',
  'leaseOwned?: boolean;',
  'leaseStatus?: "owned" | "blocked" | "unavailable";',
  'zagent: ZagentRuntimeState;',
  'zagent: { rooms: [], errors: [] }',
], 'state');

requireIncludes('.pi/extensions/zob-harness/src/domains/coms/coms-v2/zpeer.ts', [
  'import { loadZteamManifest, zteamAllowsZpeerContact } from "../zagents.js"',
  'const zteam = loadZteamManifest(repoRoot, self.team)',
  'zteam fallback blocked',
  'zteamAllowsZpeerContact(zteam.manifest, self.roleId, roomId, selfAlias)',
  'zteamAllowsZpeerContact(zteam.manifest, target.roleId, roomId, targetAlias)',
  'zpeer topology blocked: peers are not in the same zteam',
], 'zpeer');

requireIncludes('.pi/extensions/zob-harness/src/runtime/widget.ts', [
  'const zagentLine = state.zagent.id',
  'ZAgent',
  'state.zagent.alias ? `@${state.zagent.alias}` : state.zagent.id',
  'team=${state.zagent.team}',
  'room=${state.zagent.activeRoom}',
  'mode=${scopedMode.label}',
  'scopedAllowedTools.filter((tool) => available.has(tool))',
  'pi.setActiveTools(activeTools)',
  'allowedToolsExplicit !== true',
  '...(zagentLine ? [zagentLine] : [])',
], 'widget');

const registry = JSON.parse(contents['.pi/capabilities/zob-public-runtime-capabilities.json']);
for (const commandName of ['zagent', 'zteam']) {
  const entry = registry.commands?.find((command) => command.name === commandName);
  if (!entry) {
    failures.push(`capability registry missing /${commandName} command`);
    continue;
  }
  if (entry.family !== 'zagent') failures.push(`capability registry /${commandName} family must be zagent`);
  if (!entry.skillRefs?.includes('.pi/skills/zob-zagent-creator/SKILL.md')) {
    failures.push(`capability registry /${commandName} missing zob-zagent-creator skill ref`);
  }
  if (commandName === 'zteam' && !entry.noShipNotes?.includes('Hot-add apply requires --apply --confirm <team-id>')) {
    failures.push('capability registry /zteam must document hot-add confirmation/no-spawn gates');
  }
}

if (!existsSync('.pi/skills/zob-zagent-creator/SKILL.md')) failures.push('zagent creator skill file missing');
requireIncludes('.pi/skills/zob-zagent-creator/SKILL.md', [
  'full Pi sessions tied to ZPeer',
  'not `delegate_agent`/`delegate_task` subagents',
  'not delegate subagents',
  'not a delegated subagent',
  'natural-language team/agent description',
  'owner’s natural-language ask',
  'Analyze the current repo and any owner-provided reference context',
  '.pi/zagents/*.json',
  '.pi/zagents/prompts/*.md',
  '.pi/zteams/*.json',
  'project-local and are not harness-global',
  '/zteam launch-plan <team-id>',
  'ZOB_ZAGENT_ID=<id> pi',
  'do not automatically spawn processes',
  '/zteam hot-add <team-id> <natural-language ask>',
  'current-context inference may use `ZOB_ZTEAM_ID`, active ZAgent team, ZPeer team/active room, or repo convention fallback',
  '--apply --confirm <team-id>',
  '--tmux-window --launch-confirm <team-id>',
  'readZobLiveRegistryAllProjectsSnapshot',
  'Durable hot-add ledger records must keep `bodyStored=false`',
  'A tmux window is not presence proof',
  '.pi/model-catalog.json',
  '.pi/model-catalog.example.json',
  '.pi/model-routing.json',
  'costTier',
  'qualityTier',
  'ZOB_ZAGENT_ID=<id> pi --model <model>',
  'Default ZOB mode selection',
  'defaultMode',
  'never choose `vanilla` by default',
  'Do not add a scaffold slash command',
  'I need a three-agent team',
  'metadata.entryAgent',
  'start [agent]',
  'attach [agent]',
  'window <agent>',
  'list',
  'resolve_target_agent',
  'Unknown agent/window',
  'Scoped ZTeam Mode Packs and Team Contract Packs',
  'schema `zob.zteam-modes.v1`',
  'ZOB_ZTEAM_ID=<team>',
  'ZOB_ZPEER_PROFILE_ID=%q ZOB_ZAGENT_ID=%q',
  'profile_id_for_agent()',
  'spawn-count=0',
  'Active ZPeer/ZTeam presence is lease-based',
  'runtime owns stable `teamId+agentId` leases',
  'relaunch pings the previous live endpoint before reclaiming',
  '`/zteam reset` sends Pi `/new`, `/zteam reload` sends Pi `/reload`, and `/zteam quit` calls scoped launcher `close`',
  'Launcher `close` is only tmux lifecycle control',
], 'zagent skill');

requireIncludes('.pi/zteams/zob-harness-devs.tmux.sh', [
  'TEAM_ID="zob-harness-devs"',
  'BUNDLE_ID="${ZOB_ZTEAM_BUNDLE_ID:-zob-harness-devs}"',
  'LAUNCH_ID="${ZOB_ZTEAM_LAUNCH_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"',
  'profile_id_for_agent()',
  'ZOB_ZTEAM_ID=%q ZOB_ZTEAM_BUNDLE_ID=%q ZOB_ZTEAM_LAUNCH_ID=%q ZOB_ZPEER_PROFILE_ID=%q ZOB_ZAGENT_ID=%q',
  'presence lifecycle: runtime releases matching stable team-agent leases on graceful shutdown',
  'relaunch reclaims only nonresponsive scoped leases after ping; /zteam reset sends Pi /new without closing tmux',
  'lease cleanup is runtime-owned/ping-gated',
  'send_new_to_agents()',
  'send_reload_to_agents()',
  'tmux send-keys -t "$SESSION_NAME:$window" C-u "/new" C-m',
  'tmux send-keys -t "$SESSION_NAME:$window" C-u "/reload" C-m',
], 'harness tmux launcher');

requireIncludes('.pi/skills/zob-factory/SKILL.md', [
  'Scoped ZTeam Mode Pack',
  'Team Contract Pack',
  'schema `zob.zteam-modes.v1`',
  'spawn-count=0',
  'Do not treat launching a tmux team, printing `/zteam launch-plan`, or receiving ZPeer ACKs as factory success.',
], 'factory skill');

const scaffoldCommand = ['/zteam', 'scaffold'].join(' ');
if (contents['.pi/skills/zob-zagent-creator/SKILL.md'].includes(scaffoldCommand)) {
  failures.push('zagent creator skill must not require a scaffold slash command string');
}
if (commands.includes(scaffoldCommand)) failures.push('commands must not expose a zteam scaffold command');

if (failures.length > 0) {
  console.error(`zagent static smoke FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('zagent static smoke PASS');
