#!/usr/bin/env node
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const failures = [];
const forbiddenLedgerKeys = new Set(['body', 'task', 'prompt', 'output', 'content', 'message', 'text', 'rationale', 'diff', 'patch', 'transientPrompt', 'transientResponse']);
const rawPrompt = 'hash-only local zpeer smoke prompt';
const rawResponse = 'hash-only local zpeer smoke response';
const root = mkdtempSync(join(tmpdir(), 'zpeer-local-e2e-'));
const outDir = join(root, 'compiled');
const repoRoot = join(root, 'repo');
const registryRoot = join(root, 'registry');
const previousRegistryRoot = process.env.ZOB_COMS_REGISTRY_ROOT;
const previousZpeerProfileId = process.env.ZOB_ZPEER_PROFILE_ID;
const previousZpeerProfile = process.env.ZPEER_PROFILE;
const previousComsSessionId = process.env.ZOB_COMS_SESSION_ID;
const previousTmuxPane = process.env.TMUX_PANE;
const previousZobComsRoleId = process.env.ZOB_COMS_ROLE_ID;
const servers = [];

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function hasForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  return Object.entries(value).some(([key, child]) => forbiddenLedgerKeys.has(key) || hasForbiddenKey(child));
}

function containsRawBody(value) {
  return JSON.stringify(value).includes(rawPrompt) || JSON.stringify(value).includes(rawResponse);
}

function makePeer({ alias, roomId, endpoint, endpointHash, sha256, roleId = 'zob-orchestrator', roleType = 'orchestrator', heartbeatAt }) {
  const now = new Date().toISOString();
  return {
    schema: 'zob.live-peer-card.v1',
    projectId: 'temporary-project-id-overwritten-by-ensureZpeerFields',
    team: 'zob-core',
    roleId,
    roleType,
    agent: 'zpeer-local-e2e-smoke',
    sessionId: `session-${alias}`, 
    sessionHash: sha256(`session-${alias}`),
    transport: 'local_socket',
    endpoint,
    endpointHash,
    cwdHash: sha256(repoRoot),
    pid: process.pid,
    startedAt: now,
    heartbeatAt: heartbeatAt ?? now,
    contextUsedPct: 0,
    queueDepth: 0,
    status: 'online',
    zpeerRoomId: roomId,
    zpeerAlias: alias,
    zpeerLocalOnly: true,
    staleAfterMs: 60_000,
    offlineAfterMs: 120_000,
    bodyStored: false,
  };
}

async function main() {
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(registryRoot, { recursive: true });
  process.env.ZOB_COMS_REGISTRY_ROOT = registryRoot;

  const localTsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(localTsc)) {
    throw new Error(`local TypeScript compiler not found at ${localTsc}; run from a repo with installed local dependencies`);
  }
  const tsc = spawnSync(process.execPath, [localTsc, '--project', 'tsconfig.json', '--noEmit', 'false', '--outDir', outDir, '--rootDir', '.'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (tsc.status !== 0) {
    throw new Error(`temporary TypeScript compile failed\nstdout:\n${tsc.stdout}\nstderr:\n${tsc.stderr}`);
  }
  const repoNodeModules = join(process.cwd(), 'node_modules');
  if (existsSync(repoNodeModules)) symlinkSync(repoNodeModules, join(outDir, 'node_modules'), 'dir');

  const compiledSrc = join(outDir, '.pi/extensions/zob-harness/src');
  const zpeer = await import(`${compiledSrc}/coms-v2/zpeer.js`);
  const zpeerProfile = await import(`${compiledSrc}/coms-v2/zpeer-profile.js`);
  const toolsComs = await import(`${compiledSrc}/runtime/tools-coms.js`);
  const localTransport = await import(`${compiledSrc}/coms-v2/local-transport.js`);
  const envelope = await import(`${compiledSrc}/coms-v2/envelope.js`);
  const hashing = await import(`${compiledSrc}/utils/hashing.js`);

  process.env.ZOB_ZPEER_PROFILE_ID = 'profile-alpha';
  delete process.env.ZPEER_PROFILE;
  delete process.env.ZOB_COMS_SESSION_ID;
  const alphaProfile = zpeerProfile.writeZpeerLocalProfile(repoRoot, { alias: 'persistedalpha', roomId: 'persisted-room' });
  const alphaProfilePath = zpeerProfile.zpeerProfilePath(repoRoot);
  const restoredAlphaProfile = zpeerProfile.readZpeerLocalProfile(repoRoot);
  assert(restoredAlphaProfile?.alias === 'persistedalpha', 'zpeer profile must restore persisted alias for same explicit profile id');
  assert(restoredAlphaProfile?.roomId === 'persisted-room', 'zpeer profile must restore persisted room for same explicit profile id');
  assert(alphaProfile.localOnly === true && alphaProfile.networkEnabled === false && alphaProfile.bodyStored === false, 'zpeer profile must persist metadata-only safety flags');

  process.env.ZOB_ZPEER_PROFILE_ID = 'profile-beta';
  const betaProfile = zpeerProfile.writeZpeerLocalProfile(repoRoot, { alias: 'persistedbeta', roomId: 'other-room' });
  const betaProfilePath = zpeerProfile.zpeerProfilePath(repoRoot);
  assert(betaProfilePath !== alphaProfilePath, 'different zpeer profile ids must not overwrite the same profile file');
  assert(zpeerProfile.readZpeerLocalProfile(repoRoot)?.alias === 'persistedbeta', 'second zpeer profile must read its own alias');
  process.env.ZOB_ZPEER_PROFILE_ID = 'profile-alpha';
  assert(zpeerProfile.readZpeerLocalProfile(repoRoot)?.alias === 'persistedalpha', 'first zpeer profile must remain intact after writing second profile');
  const profileJson = JSON.parse(readFileSync(alphaProfilePath, 'utf8'));
  assert(profileJson.schema === 'zob.zpeer-local-profile.v1', 'zpeer profile schema must be explicit');
  assert(profileJson.projectId === alphaProfile.projectId && profileJson.profileId === alphaProfile.profileId, 'zpeer profile must include project/profile ids');
  assert(!hasForbiddenKey(profileJson), 'zpeer profile must not contain forbidden raw body-like keys');
  assert(!alphaProfilePath.includes(join(repoRoot, '.pi', 'coms')), 'zpeer profile path must not be under .pi/coms');

  process.env.ZOB_ZPEER_PROFILE_ID = 'profile-preserve-alias';
  zpeerProfile.writeZpeerLocalProfile(repoRoot, { alias: 'humanalias', roomId: 'human-room' });
  const generatedAliasPeer = makePeer({ alias: 'tempbase', roomId: 'human-room', endpoint: join(root, 'generated-alias.sock'), endpointHash: hashing.sha256(join(root, 'generated-alias.sock')), sha256: hashing.sha256 });
  const generatedAlias = `${generatedAliasPeer.roleId}-${generatedAliasPeer.sessionHash.slice(0, 6)}`;
  zpeerProfile.writeZpeerLocalProfileFromPeer(repoRoot, { ...generatedAliasPeer, zpeerAlias: generatedAlias, zpeerRoomId: 'human-room', zpeerActiveRoomId: 'human-room', zpeerMemberships: [{ roomId: 'human-room', alias: generatedAlias, role: 'member', joinedAt: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false }] });
  assert(zpeerProfile.readZpeerLocalProfile(repoRoot)?.alias === 'humanalias', 'profile save must not overwrite a persisted human alias with a reload-generated alias');
  process.env.ZOB_ZPEER_PROFILE_ID = 'profile-alpha';

  const reloadPeer = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'reloadbase', roomId: 'default', endpoint: join(root, 'reload.sock'), endpointHash: hashing.sha256(join(root, 'reload.sock')), sha256: hashing.sha256 }), restoredAlphaProfile.roomId, restoredAlphaProfile.alias);
  assert(reloadPeer.zpeerAlias === 'persistedalpha', 'simulated reload must apply restored profile alias before registration');
  assert(reloadPeer.zpeerRoomId === 'persisted-room', 'simulated reload must apply restored profile room before registration');
  const restoredOnlyPeer = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'reloadbase', roomId: 'default', endpoint: join(root, 'reload-restored.sock'), endpointHash: hashing.sha256(join(root, 'reload-restored.sock')), sha256: hashing.sha256 }), undefined, undefined, [{ roomId: 'persisted-room', alias: 'persistedalpha', role: 'member', joinedAt: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false }]);
  const restoredOnlyMemberships = zpeer.zpeerMembershipsForPeer(restoredOnlyPeer);
  assert(restoredOnlyPeer.zpeerRoomId === 'persisted-room' && restoredOnlyPeer.zpeerAlias === 'persistedalpha', 'restored memberships must set active room/alias without legacy default input');
  assert(restoredOnlyMemberships.length === 1 && restoredOnlyMemberships[0].roomId === 'persisted-room', 'restored memberships must not inject an unrequested default membership');
  const staleBasePeer = makePeer({ alias: 'stalealias', roomId: 'default', endpoint: join(root, 'reload-stale.sock'), endpointHash: hashing.sha256(join(root, 'reload-stale.sock')), sha256: hashing.sha256 });
  staleBasePeer.zpeerActiveRoomId = 'stale-room';
  const restoredMultiPeer = zpeer.ensureZpeerFields(repoRoot, staleBasePeer, undefined, undefined, [
    { roomId: 'room-b', alias: 'bravo', role: 'member', joinedAt: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false },
    { roomId: 'room-a', alias: 'alpha', role: 'member', joinedAt: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false },
  ]);
  const restoredMultiMemberships = zpeer.zpeerMembershipsForPeer(restoredMultiPeer);
  const restoredMultiRoomIds = restoredMultiMemberships.map((membership) => membership.roomId);
  assert(restoredMultiRoomIds.length === 2 && restoredMultiRoomIds.includes('room-a') && restoredMultiRoomIds.includes('room-b'), 'restored memberships with stale/default legacy room ids must keep only restored rooms');
  assert(!restoredMultiRoomIds.includes('default') && !restoredMultiRoomIds.includes('stale-room'), 'stale/default legacy active room ids must not create restored membership parasites');
  assert(restoredMultiPeer.zpeerRoomId === 'room-a' && restoredMultiPeer.zpeerActiveRoomId === 'room-a' && restoredMultiPeer.zpeerAlias === 'alpha', 'restored memberships must fall back to first restored room/alias when legacy active room is stale');

  delete process.env.ZOB_ZPEER_PROFILE_ID;
  delete process.env.ZPEER_PROFILE;
  delete process.env.ZOB_COMS_SESSION_ID;
  process.env.TMUX_PANE = '%zpeer-smoke-pane';
  const terminalProfileIdOne = zpeerProfile.resolveZpeerProfileId(repoRoot);
  zpeerProfile.writeZpeerLocalProfile(repoRoot, { alias: 'terminalalpha', roomId: 'terminal-room' });
  const terminalProfileIdTwo = zpeerProfile.resolveZpeerProfileId(repoRoot);
  assert(terminalProfileIdOne === terminalProfileIdTwo, 'terminal-derived zpeer profile id must be stable without explicit env ids');
  assert(zpeerProfile.readZpeerLocalProfile(repoRoot)?.roomId === 'terminal-room', 'terminal-derived zpeer profile must restore room without explicit env ids');
  process.env.ZOB_COMS_SESSION_ID = 'session-before-reload';
  const reloadStableProfileIdOne = zpeerProfile.resolveZpeerProfileId(repoRoot);
  zpeerProfile.writeZpeerLocalProfile(repoRoot, { alias: 'reloadstable', roomId: 'reload-room' });
  process.env.ZOB_COMS_SESSION_ID = 'session-after-reload';
  const reloadStableProfileIdTwo = zpeerProfile.resolveZpeerProfileId(repoRoot);
  assert(reloadStableProfileIdOne === reloadStableProfileIdTwo, 'terminal-derived zpeer profile id must stay stable across changed ZOB_COMS_SESSION_ID reloads');
  assert(zpeerProfile.readZpeerLocalProfile(repoRoot)?.alias === 'reloadstable' && zpeerProfile.readZpeerLocalProfile(repoRoot)?.roomId === 'reload-room', 'zpeer reload continuity must restore alias and room when coms session id changes');
  delete process.env.TMUX_PANE;
  delete process.env.ZOB_COMS_SESSION_ID;
  delete process.env.ZOB_COMS_ROLE_ID;
  const defaultRoleProfileIdOne = zpeerProfile.resolveZpeerProfileId(repoRoot);
  const defaultRoleProfileIdTwo = zpeerProfile.resolveZpeerProfileId(repoRoot);
  assert(defaultRoleProfileIdOne === 'role-zob-orchestrator' && defaultRoleProfileIdTwo === defaultRoleProfileIdOne, 'profile id fallback must be stable across reloads even without terminal/session env');
  zpeerProfile.writeZpeerLocalProfile(repoRoot, { alias: 'sharedalias', roomId: 'shared-room', activeRoomId: 'shared-room', memberships: [{ roomId: 'shared-room', alias: 'sharedalias', role: 'member', joinedAt: new Date().toISOString(), localOnly: true, networkEnabled: false, bodyStored: false }] });
  const sharedFallbackProfile = zpeerProfile.readZpeerLocalProfile(repoRoot);
  assert(sharedFallbackProfile?.roomId === 'shared-room' && sharedFallbackProfile?.alias === undefined && sharedFallbackProfile?.memberships === undefined, 'shared role fallback profiles must preserve room but not alias/memberships across multiple sessions');
  process.env.ZOB_COMS_ROLE_ID = 'lead-alpha';
  assert(zpeerProfile.resolveZpeerProfileId(repoRoot) === 'role-lead-alpha', 'role-derived zpeer profile fallback must isolate different role ids when no terminal/session env exists');
  delete process.env.ZOB_COMS_ROLE_ID;
  process.env.ZOB_ZPEER_PROFILE_ID = 'profile-alpha';

  const alphaEndpoint = join(root, 'alpha.sock');
  const betaEndpoint = join(root, 'beta.sock');
  const gammaEndpoint = join(root, 'gamma.sock');
  const workerOneEndpoint = join(root, 'worker-one.sock');
  const workerTwoEndpoint = join(root, 'worker-two.sock');
  const pendingReplies = new Map();
  const receivedPrompts = [];
  const receivedResponses = [];

  servers.push(await localTransport.bindZobLocalEndpoint(alphaEndpoint, async (incoming) => {
    if (incoming.type === 'response') {
      receivedResponses.push(incoming);
      const pending = pendingReplies.get(incoming.msgId);
      if (pending) pending.resolve({ status: 'completed', envelope: incoming });
      return envelope.buildZobLiveAckEnvelope(incoming);
    }
    return envelope.buildZobLiveAckEnvelope(incoming);
  }));

  servers.push(await localTransport.bindZobLocalEndpoint(betaEndpoint, async (incoming) => {
    receivedPrompts.push(incoming);
    if (incoming.type === 'prompt' && incoming.replyEndpoint) {
      setTimeout(() => {
        const response = envelope.buildZobLiveEnvelope({
          type: 'response',
          msgId: incoming.msgId,
          runId: incoming.runId,
          sender: incoming.receiver,
          receiver: incoming.sender,
          team: incoming.team,
          taskHash: incoming.taskHash,
          outputHash: hashing.sha256(rawResponse),
          transientResponse: rawResponse,
        });
        localTransport.sendZobLocalEnvelope(incoming.replyEndpoint, response, { timeoutMs: 5_000 }).catch((error) => {
          const pending = pendingReplies.get(incoming.msgId);
          if (pending) pending.resolve({ status: 'error', envelope: envelope.buildZobLiveErrorEnvelope(incoming, String(error), 'reply_send_failed') });
        });
      }, 10);
    }
    return envelope.buildZobLiveAckEnvelope(incoming);
  }));

  servers.push(await localTransport.bindZobLocalEndpoint(gammaEndpoint, async (incoming) => envelope.buildZobLiveAckEnvelope(incoming)));
  servers.push(await localTransport.bindZobLocalEndpoint(workerOneEndpoint, async (incoming) => envelope.buildZobLiveAckEnvelope(incoming)));
  servers.push(await localTransport.bindZobLocalEndpoint(workerTwoEndpoint, async (incoming) => envelope.buildZobLiveAckEnvelope(incoming)));

  const oldHeartbeatAt = new Date(Date.now() - 180_000).toISOString();
  let alpha = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'alpha', roomId: 'room-one', endpoint: alphaEndpoint, endpointHash: hashing.sha256(alphaEndpoint), sha256: hashing.sha256, heartbeatAt: oldHeartbeatAt }), 'room-one', 'alpha');
  let beta = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'beta', roomId: 'room-one', endpoint: betaEndpoint, endpointHash: hashing.sha256(betaEndpoint), sha256: hashing.sha256, heartbeatAt: oldHeartbeatAt }), 'room-one', 'beta');
  zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'gamma', roomId: 'room-two', endpoint: gammaEndpoint, endpointHash: hashing.sha256(gammaEndpoint), sha256: hashing.sha256 }), 'room-two', 'gamma');
  const workerOne = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'workerone', roomId: 'worker-room', endpoint: workerOneEndpoint, endpointHash: hashing.sha256(workerOneEndpoint), sha256: hashing.sha256, roleId: 'explore-worker', roleType: 'worker' }), 'worker-room', 'workerone');
  zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'workertwo', roomId: 'worker-room', endpoint: workerTwoEndpoint, endpointHash: hashing.sha256(workerTwoEndpoint), sha256: hashing.sha256, roleId: 'research-worker', roleType: 'worker' }), 'worker-room', 'workertwo');

  assert(alpha.bodyStored === false && beta.bodyStored === false, 'registered peers must be bodyStored=false');
  const staleSummary = zpeer.buildZpeerRoomSummary(repoRoot, alpha);
  assert(staleSummary.roomId === 'room-one', 'summary must be scoped to room-one');
  assert(staleSummary.peerCount === 2, `stale room-one summary expected 2 peers, got ${staleSummary.peerCount}`);
  assert(staleSummary.online === 0, `stale room-one summary expected 0 online peers before refresh, got ${staleSummary.online}`);
  assert(staleSummary.aliases.includes('alpha') && staleSummary.aliases.includes('beta') && !staleSummary.aliases.includes('gamma'), 'stale room-one aliases must include alpha/beta only');

  alpha = zpeer.refreshZpeerSelf(repoRoot, alpha);
  beta = zpeer.refreshZpeerSelf(repoRoot, beta);
  const initialSummary = zpeer.buildZpeerRoomSummary(repoRoot, alpha);
  assert(initialSummary.peerCount === 2, `room-one summary expected 2 peers, got ${initialSummary.peerCount}`);
  assert(initialSummary.online === 2, `room-one summary expected 2 online peers after refresh, got ${initialSummary.online}`);
  assert(initialSummary.aliases.includes('alpha') && initialSummary.aliases.includes('beta') && !initialSummary.aliases.includes('gamma'), 'room-one aliases must include alpha/beta only');

  const waitForReply = (msgId) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), 5_000);
    pendingReplies.set(msgId, {
      resolve: (value) => {
        clearTimeout(timer);
        pendingReplies.delete(msgId);
        resolve(value);
      },
    });
  });

  const joinedAlpha = await zpeer.joinZpeerRoom(repoRoot, alpha, 'shared-room', 'sharedalpha', 'bridge');
  assert(joinedAlpha.ok === true, `alpha multi-room join expected ok, got ${joinedAlpha.reason ?? 'not ok'}`);
  alpha = joinedAlpha.peer;
  const joinedBeta = await zpeer.joinZpeerRoom(repoRoot, beta, 'shared-room', 'sharedbeta');
  assert(joinedBeta.ok === true, `beta multi-room join expected ok, got ${joinedBeta.reason ?? 'not ok'}`);
  beta = joinedBeta.peer;
  assert(zpeer.zpeerMembershipsForPeer(alpha).length === 2, 'alpha must be in two zpeer rooms after join');
  const sharedSummary = zpeer.buildZpeerRoomSummary(repoRoot, alpha, 'shared-room');
  assert(sharedSummary.peerCount === 2 && sharedSummary.aliases.includes('sharedalpha') && sharedSummary.aliases.includes('sharedbeta'), 'shared-room summary must include alpha/beta aliases');
  const stillActiveSummary = zpeer.buildZpeerRoomSummary(repoRoot, alpha);
  assert(stillActiveSummary.roomId === 'room-one' && stillActiveSummary.aliases.includes('alpha') && !stillActiveSummary.aliases.includes('sharedalpha'), 'join must preserve active room-one compatibility');
  const explicitRoomResult = await zpeer.sendZpeerPrompt(repoRoot, alpha, 'sharedbeta', rawPrompt, waitForReply, { roomId: 'shared-room' });
  assert(explicitRoomResult.status === 'reply' && explicitRoomResult.roomId === 'shared-room', `explicit room send expected shared-room reply, got ${explicitRoomResult.status}`);
  const explicitRoomEnvelope = receivedPrompts.at(-1);
  assert(explicitRoomEnvelope.sender === 'sharedalpha' && explicitRoomEnvelope.receiver === 'sharedbeta' && explicitRoomEnvelope.runId === 'zpeer:shared-room', 'explicit room envelope must use room-scoped sender/receiver aliases and runId');
  const implicitBlocked = await zpeer.sendZpeerPrompt(repoRoot, alpha, 'sharedbeta', rawPrompt, waitForReply);
  assert(implicitBlocked.status === 'blocked' && String(implicitBlocked.reason).includes("not found in room 'room-one'"), 'implicit active-room send must not cross into shared-room');
  const duplicateJoin = await zpeer.joinZpeerRoom(repoRoot, beta, 'shared-room', 'sharedalpha');
  assert(duplicateJoin.ok === false && String(duplicateJoin.reason).includes('live peer'), 'duplicate alias on a live peer in the same room must be blocked');
  const releasedGhost = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'released', roomId: 'released-room', endpoint: join(root, 'released-ghost-missing.sock'), endpointHash: hashing.sha256(join(root, 'released-ghost-missing.sock')), sha256: hashing.sha256, heartbeatAt: new Date(Date.now() - 180_000).toISOString() }), 'released-room', 'released');
  assert(releasedGhost.status !== 'online' || !existsSync(releasedGhost.endpoint), 'released ghost peer must not be reachable online');
  const aliasContender = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'contender', roomId: 'released-room', endpoint: join(root, 'released-contender.sock'), endpointHash: hashing.sha256(join(root, 'released-contender.sock')), sha256: hashing.sha256 }), 'released-room', 'contender');
  const reclaimReleased = await zpeer.changeZpeerAlias(repoRoot, aliasContender, 'released');
  assert(reclaimReleased.ok === true, `stale/offline alias must be reclaimable by a new session, got ${reclaimReleased.reason ?? 'not ok'}`);
  const joinReleased = await zpeer.joinZpeerRoom(repoRoot, alpha, 'released-room', 'released');
  assert(joinReleased.ok === true, `stale/offline alias must not block join alias reuse, got ${joinReleased.reason ?? 'not ok'}`);
  const ghostEndpointPath = join(root, 'online-ghost-file.sock');
  writeFileSync(ghostEndpointPath, 'not a socket server', 'utf8');
  const onlineGhost = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'ghostname', roomId: 'ghost-room', endpoint: ghostEndpointPath, endpointHash: hashing.sha256(ghostEndpointPath), sha256: hashing.sha256 }), 'ghost-room', 'ghostname');
  assert(onlineGhost.status === 'online' && existsSync(onlineGhost.endpoint), 'ghost alias fixture should look online in registry before live ping');
  const ghostContender = zpeer.ensureZpeerFields(repoRoot, makePeer({ alias: 'ghostcontender', roomId: 'ghost-room', endpoint: join(root, 'ghost-contender.sock'), endpointHash: hashing.sha256(join(root, 'ghost-contender.sock')), sha256: hashing.sha256 }), 'ghost-room', 'ghostcontender');
  const reclaimGhost = await zpeer.changeZpeerAlias(repoRoot, ghostContender, 'ghostname');
  assert(reclaimGhost.ok === true, `non-responsive online registry ghost must not block alias reclaim, got ${reclaimGhost.reason ?? 'not ok'}`);
  const clearGhostRoom = zpeer.clearZpeerRoom(repoRoot, reclaimGhost.peer, 'ghost-room');
  assert(clearGhostRoom.ok === true && clearGhostRoom.cleared >= 1 && clearGhostRoom.preservedSelf === true, 'clearZpeerRoom must mark other room peers offline while preserving current self');
  const ghostRoomAfterClear = zpeer.buildZpeerRoomSummary(repoRoot, reclaimGhost.peer, 'ghost-room');
  assert(ghostRoomAfterClear.aliases.includes('ghostname') && !ghostRoomAfterClear.aliases.includes('ghostcontender'), 'clearZpeerRoom must leave only the current alias visible in the cleared room');
  const crossRoomAlias = await zpeer.joinZpeerRoom(repoRoot, alpha, 'alias-room', 'beta');
  assert(crossRoomAlias.ok === true, 'same alias in a different room must be allowed');
  alpha = crossRoomAlias.peer;
  const peerRoomSummaries = zpeer.buildZpeerPeerRoomSummaries(repoRoot, alpha);
  assert(peerRoomSummaries.length === 3, `multi-room helper expected 3 alpha rooms, got ${peerRoomSummaries.length}`);
  assert(peerRoomSummaries.filter((summary) => summary.active).length === 1 && peerRoomSummaries[0].active === true && peerRoomSummaries[0].roomId === 'room-one', 'multi-room helper must mark exactly one active room first');
  const roomOneSummary = peerRoomSummaries.find((summary) => summary.roomId === 'room-one');
  const sharedRoomSummary = peerRoomSummaries.find((summary) => summary.roomId === 'shared-room');
  const aliasRoomSummary = peerRoomSummaries.find((summary) => summary.roomId === 'alias-room');
  assert(roomOneSummary?.selfAlias === 'alpha' && sharedRoomSummary?.selfAlias === 'sharedalpha' && aliasRoomSummary?.selfAlias === 'beta', 'multi-room helper must expose room-scoped self aliases');
  assert(roomOneSummary?.peerCount === 2 && sharedRoomSummary?.peerCount === 2 && aliasRoomSummary?.peerCount === 1, 'multi-room helper peer counts must remain scoped per room');
  assert(roomOneSummary?.aliases.includes('beta') && !roomOneSummary.aliases.includes('sharedbeta'), 'room-one summary must not leak shared-room aliases');
  assert(sharedRoomSummary?.aliases.includes('sharedbeta') && !sharedRoomSummary.aliases.includes('alpha'), 'shared-room summary must not leak room-one aliases');
  const useShared = zpeer.useZpeerRoom(repoRoot, alpha, 'shared-room');
  assert(useShared.ok === true && useShared.peer.zpeerRoomId === 'shared-room' && useShared.peer.zpeerAlias === 'sharedalpha', 'useZpeerRoom must switch active room and alias');
  alpha = zpeer.useZpeerRoom(repoRoot, useShared.peer, 'room-one').peer;

  const directPromptCountBefore = receivedPrompts.length;
  const directResponseCountBefore = receivedResponses.length;
  const result = await zpeer.sendZpeerPrompt(repoRoot, alpha, 'beta', rawPrompt, waitForReply);
  assert(result.status === 'reply', `sendZpeerPrompt expected reply, got ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
  assert(typeof result.transientResponse === 'string' && result.transientResponse === rawResponse, 'reply result must include transientResponse from peer');
  assert(result.taskHash === hashing.sha256(rawPrompt), 'reply result must include prompt taskHash');
  assert(result.outputHash === hashing.sha256(rawResponse), 'reply result must include response outputHash');
  assert(result.bodyStored === false, 'reply result must be bodyStored=false');
  assert(receivedPrompts.length === directPromptCountBefore + 1 && receivedPrompts.at(-1).replyEndpoint === alphaEndpoint, 'beta must receive one prompt with alpha replyEndpoint');
  assert(receivedResponses.length === directResponseCountBefore + 1 && receivedResponses.at(-1).msgId === result.msgId, 'alpha must receive async response on replyEndpoint');

  const feedback = [];
  const responseCountBeforeAsync = receivedResponses.length;
  const asyncResult = await zpeer.sendZpeerPrompt(repoRoot, alpha, 'beta', rawPrompt, waitForReply, { mode: 'async', onFeedback: (item) => feedback.push(item.kind) });
  assert(asyncResult.status === 'waiting', `async send expected waiting after ACK, got ${asyncResult.status}`);
  assert(feedback.filter((kind) => kind === 'waiting').length === 1 && !feedback.includes('delivered'), 'async send must emit one compact delivered/waiting feedback after ACK');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert(receivedResponses.length > responseCountBeforeAsync, 'async late reply must still arrive on replyEndpoint after command returns waiting');

  const registeredTools = new Map();
  const appendEntries = [];
  const feedMessages = [];
  const mockPi = {
    registerTool: (tool) => registeredTools.set(tool.name, tool),
    appendEntry: (customType, data) => appendEntries.push({ customType, data }),
    sendMessage: (message) => { feedMessages.push(message); return Promise.resolve(); },
  };
  const toolState = { zobLive: { peerCard: alpha, pendingReplies: { wait: waitForReply } } };
  toolsComs.registerComsTools(mockPi, toolState);
  const zpeerAsk = registeredTools.get('zpeer_ask');
  assert(zpeerAsk, 'zpeer_ask tool must be registered by registerComsTools');
  assert(zpeerAsk.parameters, 'zpeer_ask tool must expose a schema');
  const toolResponseCountBefore = receivedResponses.length;
  const toolResult = await zpeerAsk.execute('tool-call-zpeer-ask', { targetAlias: 'beta', message: rawPrompt, reason: 'smoke coordination reason' }, undefined, undefined, { cwd: repoRoot });
  assert(toolResult?.details?.status === 'waiting', `zpeer_ask default async expected waiting, got ${toolResult?.details?.status}`);
  assert(toolResult?.details?.mode === 'async', 'zpeer_ask must default to async mode');
  assert(JSON.stringify(toolResult?.content ?? '').includes('idle/passive wait: no follow-up turn queued'), 'zpeer_ask async waiting result must tell the agent to idle instead of polling/continuing just to wait');
  const asyncWaitingFeed = feedMessages.filter((item) => item.customType === 'zob-zpeer-event' && item.details?.source === 'agent-request' && item.details?.status === 'waiting' && item.details?.msgId === toolResult?.details?.msgId);
  assert(asyncWaitingFeed.length === 1, `zpeer_ask async must emit exactly one compact waiting feed event, got ${asyncWaitingFeed.length}`);
  assert(!feedMessages.some((item) => item.customType === 'zob-zpeer-event' && item.details?.source === 'agent-request' && item.details?.kind === 'attempt'), 'zpeer_ask async must not emit a pre-ACK attempt feed event');
  assert(!containsRawBody(toolResult), 'zpeer_ask async tool result must not echo the full prompt/response body');
  assert(appendEntries.some((item) => item.customType === 'zob-zpeer' && item.data?.schema === 'zob.zpeer-ask.v1' && item.data?.action === 'agent_request' && item.data?.mode === 'async' && item.data?.bodyStored === false), 'zpeer_ask must append hash-only visible command metadata');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert(receivedResponses.length > toolResponseCountBefore, 'zpeer_ask async late reply must still arrive on replyEndpoint after tool returns waiting');
  for (const [name, value] of [['appendEntries', appendEntries], ['feed metadata', feedMessages.map((item) => item.details)]]) {
    assert(!containsRawBody(value), `${name} must not persist raw zpeer_ask prompt/response`);
    assert(!hasForbiddenKey(value), `${name} must not contain forbidden raw body-like keys`);
  }
  const duplicateGuard = await zpeerAsk.execute('tool-call-zpeer-ask-dup', { targetAlias: 'beta', message: rawPrompt }, undefined, undefined, { cwd: repoRoot });
  assert(duplicateGuard?.details?.status === 'blocked' && String(duplicateGuard?.details?.reason).includes('duplicate'), 'zpeer_ask must block duplicate target/message loop attempts');
  const selfGuard = await zpeerAsk.execute('tool-call-zpeer-ask-self', { targetAlias: 'alpha', message: 'different smoke prompt' }, undefined, undefined, { cwd: repoRoot });
  assert(selfGuard?.details?.status === 'blocked' && String(selfGuard?.details?.reason).includes('self'), 'zpeer_ask must block self-target attempts');
  const explicitRoomToolResult = await zpeerAsk.execute('tool-call-zpeer-ask-room', { roomId: 'shared-room', targetAlias: 'sharedbeta', message: rawPrompt }, undefined, undefined, { cwd: repoRoot });
  assert(explicitRoomToolResult?.details?.status === 'waiting' && explicitRoomToolResult?.details?.roomId === 'shared-room', 'zpeer_ask roomId must route to explicit membership room');
  const explicitRoomFeed = feedMessages.find((item) => item.customType === 'zob-zpeer-event' && item.details?.source === 'agent-request' && item.details?.msgId === explicitRoomToolResult?.details?.msgId);
  assert(explicitRoomFeed?.details?.roomId === 'shared-room' && explicitRoomFeed?.details?.fromAlias === 'sharedalpha' && explicitRoomFeed?.details?.toAlias === 'sharedbeta', 'zpeer_ask explicit room feed must use room-scoped fromAlias/toAlias/roomId');
  assert(toolState.zobLive.lastEvent?.roomId === 'shared-room' && toolState.zobLive.lastEvent?.fromAlias === 'sharedalpha' && toolState.zobLive.lastEvent?.toAlias === 'sharedbeta', 'zpeer_ask explicit room lastEvent must use room-scoped aliases');
  assert(!containsRawBody(explicitRoomToolResult), 'zpeer_ask explicit room tool result must not echo the full prompt/response body');
  const promptCountBeforeWorkerTool = receivedPrompts.length;
  const workerToolState = { zobLive: { peerCard: workerOne, pendingReplies: { wait: waitForReply } } };
  const workerRegisteredTools = new Map();
  toolsComs.registerComsTools({ ...mockPi, registerTool: (tool) => workerRegisteredTools.set(tool.name, tool) }, workerToolState);
  const workerToolBlocked = await workerRegisteredTools.get('zpeer_ask').execute('tool-call-zpeer-ask-worker', { targetAlias: 'workertwo', message: 'worker topology smoke prompt' }, undefined, undefined, { cwd: repoRoot });
  assert(workerToolBlocked?.details?.status === 'blocked' && String(workerToolBlocked?.details?.reason).includes('topology'), 'zpeer_ask must reuse topology guard for worker-to-worker blocks');
  assert(receivedPrompts.length === promptCountBeforeWorkerTool, 'zpeer_ask topology block must happen before transport prompt delivery');

  const isolated = await zpeer.sendZpeerPrompt(repoRoot, alpha, 'gamma', rawPrompt, waitForReply);
  assert(isolated.status === 'blocked', `cross-room send expected blocked, got ${isolated.status}`);
  assert(typeof isolated.reason === 'string' && isolated.reason.includes("not found in room 'room-one'"), 'cross-room send must report target not found in sender room');

  const promptCountBeforeWorkerDirect = receivedPrompts.length;
  const workerBlocked = await zpeer.sendZpeerPrompt(repoRoot, workerOne, 'workertwo', rawPrompt, waitForReply);
  assert(workerBlocked.status === 'blocked', `worker-to-worker send expected blocked, got ${workerBlocked.status}`);
  assert(typeof workerBlocked.reason === 'string' && workerBlocked.reason.includes('Worker-to-worker coms are blocked by topology guard'), 'worker-to-worker send must be blocked by topology guard');
  assert(receivedPrompts.length === promptCountBeforeWorkerDirect, 'worker-to-worker topology block must happen before transport prompt delivery');

  const messagesPath = join(repoRoot, '.pi', 'coms', 'peer-messages.jsonl');
  const statusesPath = join(repoRoot, '.pi', 'coms', 'peer-status.jsonl');
  const messages = readJsonl(messagesPath);
  const statuses = readJsonl(statusesPath);
  assert(messages.length >= 4, `expected peer-messages records for attempt/ack/terminal/isolation, got ${messages.length}`);
  assert(statuses.length === messages.length, 'peer-status must mirror peer-messages count');
  for (const [file, records] of [[messagesPath, messages], [statusesPath, statuses]]) {
    assert(file.startsWith(repoRoot), `${file} must be inside temp repo`);
    records.forEach((record, index) => {
      assert(record.bodyStored === false, `${file} record ${index} must be bodyStored=false`);
      assert(record.localOnly === true, `${file} record ${index} must be localOnly=true`);
      assert(record.networkEnabled === false, `${file} record ${index} must keep network disabled`);
      assert(!hasForbiddenKey(record), `${file} record ${index} contains forbidden raw body-like key`);
      assert(!containsRawBody(record), `${file} record ${index} contains raw prompt/response body`);
    });
  }
  assert(messages.some((record) => record.event === 'ack' && record.status === 'delivered' && record.taskHash === hashing.sha256(rawPrompt)), 'peer ledger must include delivered ack hash record');
  assert(messages.some((record) => record.event === 'terminal' && record.status === 'reply' && record.outputHash === hashing.sha256(rawResponse)), 'peer ledger must include reply outputHash record');
  assert(messages.some((record) => record.event === 'terminal' && record.status === 'waiting' && record.taskHash === hashing.sha256(rawPrompt)), 'peer ledger must include async waiting hash record');
  assert(messages.some((record) => record.event === 'attempt' && record.status === 'blocked' && record.reasonHash), 'peer ledger must include hash-only blocked room-isolation record');
  assert(messages.some((record) => record.event === 'attempt' && record.status === 'blocked' && record.targetAliasHash === hashing.sha256('workertwo') && record.reasonHash && record.taskHash === hashing.sha256(rawPrompt)), 'peer ledger must include hash-only worker-to-worker topology block record');

  const realRepoComs = join(process.cwd(), '.pi', 'coms');
  assert(messagesPath !== join(realRepoComs, 'peer-messages.jsonl'), 'smoke must not target real .pi/coms peer-messages ledger');
  assert(statusesPath !== join(realRepoComs, 'peer-status.jsonl'), 'smoke must not target real .pi/coms peer-status ledger');

  if (failures.length > 0) {
    console.error(`zpeer local e2e smoke FAIL\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('zpeer local e2e smoke PASS');
}

try {
  await main();
} finally {
  await Promise.allSettled(servers.map((server) => server.close()));
  if (previousRegistryRoot === undefined) delete process.env.ZOB_COMS_REGISTRY_ROOT;
  else process.env.ZOB_COMS_REGISTRY_ROOT = previousRegistryRoot;
  if (previousZpeerProfileId === undefined) delete process.env.ZOB_ZPEER_PROFILE_ID;
  else process.env.ZOB_ZPEER_PROFILE_ID = previousZpeerProfileId;
  if (previousZpeerProfile === undefined) delete process.env.ZPEER_PROFILE;
  else process.env.ZPEER_PROFILE = previousZpeerProfile;
  if (previousComsSessionId === undefined) delete process.env.ZOB_COMS_SESSION_ID;
  else process.env.ZOB_COMS_SESSION_ID = previousComsSessionId;
  if (previousTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = previousTmuxPane;
  if (previousZobComsRoleId === undefined) delete process.env.ZOB_COMS_ROLE_ID;
  else process.env.ZOB_COMS_ROLE_ID = previousZobComsRoleId;
  rmSync(root, { recursive: true, force: true });
}
