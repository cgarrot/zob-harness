#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, existsSync, symlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const failures = [];
const root = mkdtempSync(join(tmpdir(), 'zteam-lifecycle-smoke-'));
const outDir = join(root, 'compiled');
const repoRoot = join(root, 'repo');
const registryRoot = join(root, 'registry');
const previousRegistryRoot = process.env.ZOB_COMS_REGISTRY_ROOT;
const servers = [];

function fail(message) { failures.push(message); }
function assert(condition, message) { if (!condition) fail(message); }

function makePeer({ alias, roomId, endpoint, endpointHash, sha256, sessionId, team = 'zteam-lifecycle', roleId = 'agent-alpha', roleType = 'lead', heartbeatAt }) {
  const now = new Date().toISOString();
  return {
    schema: 'zob.live-peer-card.v1',
    projectId: 'temporary-project-id-overwritten-by-registry',
    team,
    roleId,
    roleType,
    agent: roleId,
    sessionId,
    sessionHash: sha256(sessionId),
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
    zpeerActiveRoomId: roomId,
    zpeerMemberships: [{ roomId, alias, role: 'member', joinedAt: now, localOnly: true, networkEnabled: false, bodyStored: false }],
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
  if (!existsSync(localTsc)) throw new Error(`local TypeScript compiler not found at ${localTsc}`);
  const tsc = spawnSync(process.execPath, [localTsc, '--project', 'tsconfig.json', '--noEmit', 'false', '--outDir', outDir, '--rootDir', '.'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (tsc.status !== 0) throw new Error(`temporary TypeScript compile failed\nstdout:\n${tsc.stdout}\nstderr:\n${tsc.stderr}`);
  const repoNodeModules = join(process.cwd(), 'node_modules');
  if (existsSync(repoNodeModules)) symlinkSync(repoNodeModules, join(outDir, 'node_modules'), 'dir');

  const compiledSrc = join(outDir, '.pi/extensions/zob-harness/src');
  const registry = await import(`${compiledSrc}/domains/coms/coms-v2/registry.js`);
  const zpeer = await import(`${compiledSrc}/domains/coms/coms-v2/zpeer.js`);
  const localTransport = await import(`${compiledSrc}/domains/coms/coms-v2/local-transport.js`);
  const envelope = await import(`${compiledSrc}/domains/coms/coms-v2/envelope.js`);
  const hashing = await import(`${compiledSrc}/core/utils/hashing.js`);
  const identity = await import(`${compiledSrc}/domains/coms/coms-v2/identity.js`);

  const staleEndpoint = join(root, 'stale-alpha.sock');
  const freshEndpoint = join(root, 'fresh-alpha.sock');
  const duplicateEndpoint = join(root, 'duplicate-alpha.sock');
  const targetEndpoint = join(root, 'target-beta.sock');
  const oldPeer = makePeer({ alias: 'alpha', roomId: 'control', endpoint: staleEndpoint, endpointHash: hashing.sha256(staleEndpoint), sha256: hashing.sha256, sessionId: 'session-old' });
  const freshPeer = makePeer({ alias: 'alpha', roomId: 'control', endpoint: freshEndpoint, endpointHash: hashing.sha256(freshEndpoint), sha256: hashing.sha256, sessionId: 'session-fresh' });
  const duplicatePeer = makePeer({ alias: 'alpha', roomId: 'control', endpoint: duplicateEndpoint, endpointHash: hashing.sha256(duplicateEndpoint), sha256: hashing.sha256, sessionId: 'session-duplicate' });
  const targetPeer = makePeer({ alias: 'beta', roomId: 'control', endpoint: targetEndpoint, endpointHash: hashing.sha256(targetEndpoint), sha256: hashing.sha256, sessionId: 'session-beta', roleId: 'agent-beta' });
  const receivedPrompts = [];

  registry.writeZobLivePeerCard(repoRoot, oldPeer);
  registry.writeZobLiveTeamAgentLease(repoRoot, oldPeer, { reason: 'initial_start' });
  assert(registry.readZobLiveRegistryAllProjectsSnapshot(repoRoot, 'zteam-lifecycle').peers.length === 1, 'initial active snapshot must come from the old stable lease');

  servers.push(await localTransport.bindZobLocalEndpoint(freshEndpoint, async (incoming) => envelope.buildZobLivePongEnvelope(incoming)));
  const claimFresh = await registry.claimZobLiveTeamAgentLease(repoRoot, freshPeer, { reason: 'relaunch_after_tmux_close' });
  assert(claimFresh.ok === true && claimFresh.status === 'reclaimed', `fresh relaunch must reclaim an unresponsive prior lease after ping, got ${JSON.stringify(claimFresh)}`);

  registry.writeZobLivePeerCard(repoRoot, freshPeer);
  const activeAfterRelaunch = registry.readZobLiveRegistryAllProjectsSnapshot(repoRoot, 'zteam-lifecycle');
  assert(activeAfterRelaunch.peers.length === 1, `active snapshot must contain exactly one lease-backed peer after relaunch, got ${activeAfterRelaunch.peers.length}`);
  assert(activeAfterRelaunch.peers[0]?.sessionHash === freshPeer.sessionHash, 'active snapshot must point at the relaunched lease owner, not old history');
  const summaryAfterRelaunch = zpeer.buildZpeerRoomSummary(repoRoot, freshPeer, 'control');
  assert(summaryAfterRelaunch.peerCount === 1, `room summary must count one active lease member, got ${summaryAfterRelaunch.peerCount}`);
  assert(summaryAfterRelaunch.online === 1, `room summary must show one online lease member, got ${summaryAfterRelaunch.online}`);
  assert(summaryAfterRelaunch.duplicateAliases.length === 0, `lease summary must not report duplicate aliases after relaunch: ${summaryAfterRelaunch.duplicateAliases.join(',')}`);

  servers.push(await localTransport.bindZobLocalEndpoint(targetEndpoint, async (incoming) => {
    receivedPrompts.push(incoming);
    return envelope.buildZobLiveAckEnvelope(incoming);
  }));
  registry.writeZobLivePeerCard(repoRoot, targetPeer);
  registry.writeZobLiveTeamAgentLease(repoRoot, targetPeer, { reason: 'target_start' });

  servers.push(await localTransport.bindZobLocalEndpoint(duplicateEndpoint, async (incoming) => envelope.buildZobLivePongEnvelope(incoming)));
  const claimDuplicate = await registry.claimZobLiveTeamAgentLease(repoRoot, duplicatePeer, { reason: 'duplicate_start_attempt' });
  assert(claimDuplicate.ok === false && claimDuplicate.status === 'blocked_live_owner', `live duplicate claim must be blocked after ping, got ${JSON.stringify(claimDuplicate)}`);
  const afterDuplicate = registry.readZobLiveRegistryAllProjectsSnapshot(repoRoot, 'zteam-lifecycle');
  assert(afterDuplicate.peers.length === 2 && afterDuplicate.peers.some((peer) => peer.sessionHash === freshPeer.sessionHash) && afterDuplicate.peers.some((peer) => peer.sessionHash === targetPeer.sessionHash), 'blocked duplicate must not replace active stable leases');
  const duplicateSend = await zpeer.sendZpeerPrompt(repoRoot, duplicatePeer, 'beta', 'duplicate loser must not send', async () => ({ status: 'timeout' }), { roomId: 'control' });
  assert(duplicateSend.status === 'blocked' && String(duplicateSend.reason).includes('does not own stable team-agent lease'), `duplicate lease loser outbound send must be blocked by ownership guard, got ${duplicateSend.status}: ${duplicateSend.reason ?? ''}`);
  assert(receivedPrompts.length === 0, 'duplicate lease loser must not deliver outbound prompt to target peer');

  const wrongRelease = registry.releaseZobLiveTeamAgentLease(repoRoot, oldPeer, { reason: 'wrong_owner_shutdown' });
  assert(wrongRelease.released === false && wrongRelease.reason === 'owner_mismatch', `wrong owner release must not remove current lease, got ${JSON.stringify(wrongRelease)}`);
  assert(registry.readZobLiveRegistryAllProjectsSnapshot(repoRoot, 'zteam-lifecycle').peers.length === 2, 'wrong owner release must leave active leases intact');

  const rightRelease = registry.releaseZobLiveTeamAgentLease(repoRoot, freshPeer, { reason: 'matching_owner_shutdown' });
  assert(rightRelease.released === true, `matching owner release must remove lease, got ${JSON.stringify(rightRelease)}`);
  assert(registry.readZobLiveRegistryAllProjectsSnapshot(repoRoot, 'zteam-lifecycle').peers.length === 1, 'after matching alpha release, only target beta active lease should remain even though cards remain');
  const summaryAfterRelease = zpeer.buildZpeerRoomSummary(repoRoot, freshPeer, 'control');
  assert(summaryAfterRelease.peerCount === 1 && summaryAfterRelease.aliases.includes('beta') && !summaryAfterRelease.aliases.includes('alpha'), `room summary must ignore historical alpha cards after lease release, got ${summaryAfterRelease.aliases.join(',')}`);

  const projectId = identity.buildZobComsProjectId(repoRoot);
  const cardDir = join(registryRoot, 'projects', projectId, 'agents');
  const cardCount = existsSync(cardDir) ? readdirSync(cardDir).filter((name) => name.endsWith('.json')).length : 0;
  assert(cardCount >= 2, `peer cards must remain as history only; expected at least two card records, got ${cardCount}`);

  const retired = await registry.retireInactiveZobLiveTeamAgentLeases(repoRoot, { teamName: 'zteam-lifecycle', agentIds: ['agent-alpha'] });
  assert(retired.schema === 'zob.live-team-agent-lease-retire.v1' && retired.checked >= 0 && retired.bodyStored === false, 'exact-scope lease retire helper must return body-free metadata');

  for (const server of servers.splice(0)) await server.close();

  if (failures.length > 0) {
    console.error(`zteam lifecycle smoke FAIL\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('zteam lifecycle smoke PASS');
}

main().catch(async (error) => {
  for (const server of servers.splice(0)) {
    try { await server.close(); } catch { /* ignore cleanup */ }
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}).finally(() => {
  if (previousRegistryRoot === undefined) delete process.env.ZOB_COMS_REGISTRY_ROOT;
  else process.env.ZOB_COMS_REGISTRY_ROOT = previousRegistryRoot;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore cleanup */ }
});
