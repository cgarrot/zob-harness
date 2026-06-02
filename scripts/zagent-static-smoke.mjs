#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const files = [
  '.pi/extensions/zob-harness/src/domains/coms/zagents.ts',
  '.pi/extensions/zob-harness/src/runtime/commands.ts',
  '.pi/extensions/zob-harness/src/runtime/events.ts',
  '.pi/extensions/zob-harness/src/runtime/state.ts',
  '.pi/extensions/zob-harness/src/runtime/widget.ts',
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/zpeer.ts',
  '.pi/capabilities/zob-public-runtime-capabilities.json',
  '.pi/skills/zob-zagent-creator/SKILL.md',
];
const contents = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
const failures = [];

function requireIncludes(file, needles, label = file) {
  for (const needle of needles) {
    if (!contents[file].includes(needle)) failures.push(`${label} missing ${needle}`);
  }
}

const zagents = contents['.pi/extensions/zob-harness/src/domains/coms/zagents.ts'];
requireIncludes('.pi/extensions/zob-harness/src/domains/coms/zagents.ts', [
  'const ZAGENTS_DIR = ".pi/zagents"',
  'const ZTEAMS_DIR = ".pi/zteams"',
  'const ZAGENT_PROMPTS_DIR = ".pi/zagents/prompts"',
  'export function normalizeZagentRoomBindings',
  'export function readZagentPrompt',
  'export function loadZagentManifest',
  'export function loadZteamManifest',
  'export function listZagentManifests',
  'export function listZteamManifests',
  'export function zteamAllowsZpeerContact',
  'export function resolveZagentTeamMemberships',
  'export function resolveZagentRuntimeRoomBindings',
  'localOnly: true',
  'zagent.model must be a safe Pi --model pattern',
  'zagent.defaultMode must be one of',
  'networkEnabled: false',
  'bodyStored: false',
]);
if (!zagents.includes('join(projectZagentsDir(repoRoot), `${safeZagentId(id) ?? "__invalid__"}.json`)')) failures.push('zagents loader must resolve manifests under .pi/zagents');
if (!zagents.includes('join(projectZteamsDir(repoRoot), `${safeZagentId(id) ?? "__invalid__"}.json`)')) failures.push('zagents loader must resolve manifests under .pi/zteams');

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
  'ZOB_ZAGENT_ID=${member.id} pi',
  '--model ${model}',
  'modelIdHashes: plan.modelIds.map((modelId) => sha256(modelId))',
  'defaultModeHashes: plan.defaultModes.map((mode) => sha256(mode))',
  'defaultMode=${defaultMode}',
  'After each session starts, run /zagent use <id> to bind its ZPeer alias/rooms.',
  'Project-local full-session ZAgents',
  'Project-local ZTeams',
  'launch-plan printed; spawn count=0',
  'writeZpeerLocalProfileFromPeer(ctx.cwd, state.zobLive.peerCard, zpeerCommandProfileId(ctx))',
  'promptHash=',
  'bodyStored: false',
], 'commands');

requireIncludes('.pi/extensions/zob-harness/src/runtime/events.ts', [
  'function loadActiveZagentFromEnv',
  'process.env.ZOB_ZAGENT_ID?.trim()',
  'loadZagentManifest(repoRoot, zagentId)',
  'readZagentPrompt(repoRoot, manifest.promptRef)',
  'resolveZagentRuntimeRoomBindings(repoRoot, manifest)',
  'state.zagent = nextZagent',
  'defaultMode: manifest.defaultMode',
  'loadActiveZagentFromEnv(state, ctx.cwd)',
  'state.zagent.defaultMode && state.zagent.defaultMode !== state.activeMode',
  'ZAGENT RUNTIME ACTIVATION',
  'ZAgents are full Pi sessions tied to ZPeer/live coordination, not delegate subagents.',
  'team: zagent?.team ?? basePeer.team',
  'teams: resolved.teamIds',
  'roleId: zagent?.id ?? basePeer.roleId',
  'agent: zagent?.id ?? basePeer.agent',
  'team: zagent?.team ?? state.zobLive.peerCard.team',
  'roleId: zagent?.id ?? state.zobLive.peerCard.roleId',
  'agent: zagent?.id ?? state.zobLive.peerCard.agent',
], 'events');

requireIncludes('.pi/extensions/zob-harness/src/runtime/state.ts', [
  'export interface ZagentRuntimeState',
  'team?: string;',
  'teams?: string[];',
  'role?: string;',
  'alias?: string;',
  'rooms: ZAgentRoomBinding[];',
  'defaultMode?: ModeName;',
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
  'J\'ai besoin d\'une team de trois agents',
], 'zagent skill');

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
