#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Reads the source-text "surface" for a module: the file at `file` plus, when a
// move-only refactor split that file into a sibling directory named after it
// (minus the `.ts`/`.mjs` extension), every `*.ts`/`*.mjs` file under that
// directory, concatenated recursively. This widens only WHERE guard text is
// read from (barrel + submodules) without changing any assertion. For files
// without such a sibling directory it returns the file content unchanged.
function readSurface(file) {
  const absPath = resolve(file);
  let text = readFileSync(absPath, 'utf8');
  const siblingDir = absPath.replace(/\.(ts|mjs)$/, '');
  if (siblingDir !== absPath && existsSync(siblingDir) && statSync(siblingDir).isDirectory()) {
    const stack = [siblingDir];
    const collected = [];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) stack.push(full);
        else if (/\.(ts|mjs)$/.test(full)) collected.push(full);
      }
    }
    collected.sort();
    for (const sub of collected) text += `\n${readFileSync(sub, 'utf8')}`;
  }
  return text;
}

const files = [
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/zpeer.ts',
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/envelope.ts',
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/pending-replies.ts',
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/response-capture.ts',
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/registry.ts',
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/zpeer-profile.ts',
  '.pi/extensions/zob-harness/src/domains/coms/coms-v2/transcript-capture.ts',
  '.pi/extensions/zob-harness/src/domains/delegation/child-runner.ts',
  '.pi/extensions/zob-harness/src/runtime/commands.ts',
  '.pi/extensions/zob-harness/src/runtime/tools-coms.ts',
  '.pi/extensions/zob-harness/src/runtime/events.ts',
  '.pi/extensions/zob-harness/src/runtime/state.ts',
  '.pi/extensions/zob-harness/src/runtime/goal-runtime.ts',
  '.pi/extensions/zob-harness/src/runtime/widget.ts',
  '.pi/extensions/zob-harness/src/domains/coms/mission-control.ts',
  '.pi/extensions/zob-harness/src/runtime/schemas.ts',
  '.pi/extensions/zob-harness/src/core/constants.ts',
  '.pi/capabilities/zob-public-runtime-capabilities.json',
];
const contents = Object.fromEntries(files.map((file) => [file, readSurface(file)]));
const failures = [];

const commandMatches = contents['.pi/extensions/zob-harness/src/runtime/commands.ts'].match(/registerCommand\("zpeer"/g) ?? [];
if (commandMatches.length !== 1) failures.push(`expected exactly one zpeer command, found ${commandMatches.length}`);
const toolsComs = contents['.pi/extensions/zob-harness/src/runtime/tools-coms.ts'];
const zpeerAskMatches = toolsComs.match(/name: "zpeer_ask"/g) ?? [];
if (zpeerAskMatches.length !== 1) failures.push(`expected exactly one zpeer_ask tool, found ${zpeerAskMatches.length}`);
const zpeerReplyMatches = toolsComs.match(/name: "zpeer_reply"/g) ?? [];
if (zpeerReplyMatches.length !== 1) failures.push(`expected exactly one zpeer_reply tool, found ${zpeerReplyMatches.length}`);
for (const needle of ['parameters: ZpeerAskParams', 'sendZpeerPrompt(ctx.cwd', 'mode = params.mode ?? "async"', 'requireResponse = params.requireResponse === true', 'pendingReplies.wait(msgId, timeoutMs, { requireResponse })', 'maxReinjects', 'zpeerAskGuardBlock', 'ZPEER_AGENT_ASK_RATE_LIMIT_PER_MINUTE = 50', 'ZPEER_AGENT_URGENT_RATE_LIMIT_PER_MINUTE = 10', 'ZPEER_AGENT_FORCE_RATE_LIMIT_PER_MINUTE = 3', 'normalizeZpeerInterrupt', 'force interrupt requires reason', 'max ${ZPEER_AGENT_ASK_RATE_LIMIT_PER_MINUTE} agent-initiated ZPeer asks per 60s window', 'idle/passive wait: no follow-up turn queued', 'customType: "zob-zpeer-event"', 'source: "agent-request"', 'action: "agent_request"', 'feedbackEmittedTerminal', 'reasonInputHash', 'interruptReasonHash', 'bodyStored: false', 'promptBodiesStored: false', 'outputBodiesStored: false']) {
  if (!toolsComs.includes(needle)) failures.push(`zpeer_ask tool missing ${needle}`);
}
for (const needle of ['parameters: ZpeerReplyParams', 'buildZobLiveResponseEnvelope', 'sendZobLocalEnvelope(replyEndpoint', 'replyToMsgId: inbound.envelope.msgId', 'action: "reply"', 'action: "reply_blocked"', 'status: "response_sent"', 'ZPeer msgId required response already expired']) {
  if (!toolsComs.includes(needle)) failures.push(`zpeer_reply tool missing ${needle}`);
}
if (toolsComs.includes('emitZpeerAskEvent({ kind: "attempt", status: "agent-request"')) failures.push('zpeer_ask async must not emit pre-ACK attempt feed noise');
if (!toolsComs.includes('peerAliasInRoom(self, requestedRoomId)') || !toolsComs.includes('peerAliasInRoom(self, eventRoomId)')) failures.push('zpeer_ask feed events must use room-scoped sender alias for explicit roomId');
const schemas = contents['.pi/extensions/zob-harness/src/runtime/schemas.ts'];
for (const needle of ['const ZpeerAskParams', 'targetAlias', 'message', 'roomId', 'Default async', '["async", "await", "long"]', 'timeoutMs', 'requireResponse', 'maxReinjects', 'ZpeerAskParams', 'const ZpeerReplyParams', 'msgId', 'ZpeerReplyParams']) {
  if (!schemas.includes(needle)) failures.push(`zpeer schemas missing ${needle}`);
}
const registry = contents['.pi/capabilities/zob-public-runtime-capabilities.json'];
if (!registry.includes('"name": "zpeer_ask"') || !registry.includes('rate/loop guarded') || !registry.includes('requireResponse tracks msgId-correlated replies')) failures.push('capability registry missing zpeer_ask visibility/safety notes');
if (!registry.includes('"name": "zpeer_reply"') || !registry.includes('wrong/expired/already-answered msgIds are blocked')) failures.push('capability registry missing zpeer_reply visibility/safety notes');
const constants = contents['.pi/extensions/zob-harness/src/core/constants.ts'];
const zpeerComsAllowlistBlock = constants.match(/export const ZOB_COMS_TOOLS = \[[^\n]*\] as const;/)?.[0] ?? '';
if (!zpeerComsAllowlistBlock.includes('"zpeer_ask"') || !zpeerComsAllowlistBlock.includes('"zpeer_reply"')) failures.push('ZOB_COMS_TOOLS missing zpeer_ask/zpeer_reply active allowlist entry');
const modeBlocks = Object.fromEntries([...constants.matchAll(/\n  (explore|plan|implement|oracle|orchestrator|factory): \[[^\n]*\],/g)].map((match) => [match[1], match[0]]));
for (const mode of ['plan', 'implement', 'orchestrator', 'factory']) {
  if (!modeBlocks[mode]?.includes('...ZOB_COMS_TOOLS')) failures.push(`MODE_TOOLS.${mode} must expose zpeer_ask through ZOB_COMS_TOOLS`);
}
for (const mode of ['explore', 'oracle']) {
  if (!modeBlocks[mode]?.includes('"zpeer_ask"') || !modeBlocks[mode]?.includes('"zpeer_reply"')) failures.push(`MODE_TOOLS.${mode} missing zpeer_ask/zpeer_reply explicit active allowlist entry`);
}
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'output:', 'content: params.message', 'message: params.message', 'text: params.message', 'diff:', 'patch:']) {
  const appendBlocks = [...toolsComs.matchAll(/appendEntry\("zob-zpeer",\s*\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  if (appendBlocks.some((block) => block.includes(forbidden))) failures.push(`zpeer_ask appendEntry contains forbidden raw key/value ${forbidden}`);
}

const zpeer = contents['.pi/extensions/zob-harness/src/domains/coms/coms-v2/zpeer.ts'];
const envelope = contents['.pi/extensions/zob-harness/src/domains/coms/coms-v2/envelope.ts'];
const pendingReplies = contents['.pi/extensions/zob-harness/src/domains/coms/coms-v2/pending-replies.ts'];
const responseCapture = contents['.pi/extensions/zob-harness/src/domains/coms/coms-v2/response-capture.ts'];
const liveRegistry = contents['.pi/extensions/zob-harness/src/domains/coms/coms-v2/registry.ts'];
const zpeerProfile = contents['.pi/extensions/zob-harness/src/domains/coms/coms-v2/zpeer-profile.ts'];
for (const needle of ['networkEnabled: false', 'localOnly: true', 'bodyStored: false', 'sendZobLocalEnvelope', 'taskHash', 'outputHash', 'ZpeerSendMode', 'status: "waiting"', 'status: "reply"', 'required_response_expired', 'requireResponse', 'responseRequiredBy', 'responseReceived', 'deliveryStatus', 'zpeerMembershipsForPeer', 'joinZpeerRoom', 'leaveZpeerRoom', 'useZpeerRoom', 'clearZpeerRoom', 'preservedSelf: true', 'roomId?: string', 'buildZpeerPeerRoomSummaries', 'active: membership.roomId === activeRoomId', 'peerRespondsToAliasPing', 'activeAliasCollision', 'zpeer-alias-ping', 'zpeerAdhoc']) {
  if (!zpeer.includes(needle)) failures.push(`zpeer missing ${needle}`);
}
for (const needle of ['peer-messages.jsonl', 'peer-status.jsonl', 'appendZpeerPeerRecords', 'reasonHash', 'priority', 'interruptMode', 'interruptStatus', 'interruptReasonHash', 'bodyStored: false']) {
  if (!zpeer.includes(needle)) failures.push(`zpeer hash-only peer ledger support missing ${needle}`);
}
if (/required_network|pi-vs-claude-code|sse/.test(zpeer)) failures.push('zpeer must not enable network/SSE transport');
for (const needle of ['value.type === "response" && value.replyToMsgId !== value.msgId', 'ZOB live response replyToMsgId must match msgId']) {
  if (!envelope.includes(needle)) failures.push(`envelope missing strict response replyToMsgId validation ${needle}`);
}
for (const needle of ['requireResponse: options.requireResponse === true', 'item?.requireResponse && envelope.replyToMsgId !== msgId', 'completed.envelope?.replyToMsgId !== msgId']) {
  if (!pendingReplies.includes(needle)) failures.push(`pending replies missing strict required-response correlation ${needle}`);
}
for (const needle of ['replyToMsgId: request.msgId', 'responseHash: capture.outputHash']) {
  if (!responseCapture.includes(needle)) failures.push(`response capture missing msgId-safe response envelope field ${needle}`);
}
const roomFirstTopologyIndex = zpeer.indexOf('if (selfInRequestedRoom && targetInRequestedRoom && !bothPeersAreWorkers) return undefined;');
const hardTeamMismatchIndex = zpeer.indexOf('zpeer topology blocked: peers are in different teams');
if (roomFirstTopologyIndex === -1) failures.push('zpeer topology must allow same-room non-worker peers before team/ZTeam policy');
if (!zpeer.includes('const bothPeersAreWorkers = self.roleType === "worker" && target.roleType === "worker";')) failures.push('zpeer topology must preserve worker-to-worker same-room legacy topology block');
if (hardTeamMismatchIndex !== -1 && (roomFirstTopologyIndex === -1 || hardTeamMismatchIndex < roomFirstTopologyIndex)) failures.push('zpeer topology must not hard-block cross-team peers before same-room allowance');
if (!zpeer.includes('const candidates = peersInRoom(repoRoot, roomId).filter') || !zpeer.includes('if (!selfMembership)') || !zpeer.includes('current peer is observer-only in room')) failures.push('zpeer same-room allowance must preserve room candidate, self membership, and observer guards');
for (const needle of ['ZPEER_FORCE_ALLOWED_SENDER_ROLE_TYPES', 'ZPEER_FORCE_ALLOWED_RECEIVER_ROLE_TYPES', 'force interrupt not allowed from role type', 'force interrupt not allowed to role type', 'priority === "normal"']) {
  if (!zpeer.includes(needle)) failures.push(`zpeer force sender policy/fallback guard missing ${needle}`);
}
if (!liveRegistry.includes('readZobLiveRegistryAllProjectsSnapshot') || !liveRegistry.includes('join(projectsDir, entry.name, "agents")')) failures.push('live registry must expose all-project agents room discovery helper');
if (!liveRegistry.includes('peer.zpeerAdhoc !== true') || !liveRegistry.includes('mergeLeaseBackedAndAdhocPeers(leaseDirs.flatMap')) failures.push('live registry must merge explicit ad-hoc room peer cards into lease-backed summaries');
for (const needle of ['ZobLiveTeamAgentLease', 'zob.live-team-agent-lease.v1', 'stableLease: true', 'exclusiveBy: "teamId+agentId"', 'claimZobLiveTeamAgentLease', 'leaseRespondsToPing', 'pingZobLocalEndpoint', 'releaseZobLiveTeamAgentLease', 'ownsZobLiveTeamAgentLease', 'sameLeaseOwner', 'retireInactiveZobLiveTeamAgentLeases', 'readLeasesFromDir', 'hasLeaseDomain', 'mergeLeaseBackedAndAdhocPeers']) {
  if (!liveRegistry.includes(needle)) failures.push(`live registry stable lease support missing ${needle}`);
}
if (!zpeer.includes('readZobLiveRegistryAllProjectsSnapshot(repoRoot)')) failures.push('zpeer room discovery must use all-project registry snapshots');
if (!zpeer.includes('writeZobLiveTeamAgentLease(repoRoot, refreshed, { reason: "zpeer_refresh" })')) failures.push('zpeer refresh must renew stable team-agent leases for active summaries');
if (!zpeer.includes('ownsZobLiveTeamAgentLease(repoRoot, self)') || !zpeer.includes('current peer does not own stable team-agent lease')) failures.push('zpeer outbound sends must hard-block when self does not own the stable team-agent lease');
if (zpeer.includes('peer.projectId === snapshot.projectId')) failures.push('zpeer room discovery must not filter same-room peers by projectId');
if (!zpeer.includes('normalizeZpeerMemberships(restoredMemberships)') || !zpeer.includes('restoredRoomId(roomId) ?? restoredRoomId(peer.zpeerActiveRoomId) ?? baseMemberships[0]?.roomId') || !zpeer.includes(': safeZpeerRoomId(roomId ?? peer.zpeerActiveRoomId ?? peer.zpeerRoomId)')) failures.push('ensureZpeerFields restored memberships must avoid legacy/default fallback injection');
for (const needle of ['schema: PROFILE_SCHEMA', 'profileId', 'projectId', 'alias', 'roomId', 'localOnly: true', 'networkEnabled: false', 'bodyStored: false', 'ZOB_ZPEER_PROFILE_ID', 'ZPEER_PROFILE', 'ZOB_COMS_SESSION_ID', 'ZOB_COMS_ROLE_ID', 'zob-orchestrator', 'zpeerProfileIdIsSharedFallback', 'sharedFallback ? undefined', 'generatedAliasForPeer', 'activeMembershipAlias', 'existing?.alias ?? candidateAlias', 'zpeer-profiles']) {
  if (!zpeerProfile.includes(needle)) failures.push(`zpeer profile missing ${needle}`);
}
for (const needle of ['const NEW_CARRYOVER_SCHEMA = "zob.zpeer-new-carryover.v1"', 'export function writeZpeerNewCarryoverProfile', 'export function readZpeerNewCarryoverProfile', 'export function clearZpeerNewCarryoverProfile', 'schema: NEW_CARRYOVER_SCHEMA', 'zagentId?: string', 'expiresAt:', 'localOnly: true', 'networkEnabled: false', 'bodyStored: false']) {
  if (!zpeerProfile.includes(needle)) failures.push(`zpeer /new carryover profile missing ${needle}`);
}
if (zpeerProfile.includes('join(repoRoot, ".pi", "coms")')) failures.push('zpeer profile must not persist under .pi/coms');
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'response:', 'body:', 'content:', 'message:', 'text:', 'task:', 'output:', 'diff:', 'patch:']) {
  if (zpeerProfile.includes(forbidden)) failures.push(`zpeer profile contains forbidden raw/body-like persisted key ${forbidden}`);
}
const peerLedgerBase = zpeer.match(/const base = \{[\s\S]*?\n  \};/)?.[0] ?? '';
for (const forbidden of ['prompt:', 'response:', 'body:', 'content:', 'message:', 'text:', 'task:', 'output:']) {
  const peerLedgerBlocks = [peerLedgerBase, ...zpeer.matchAll(/appendHashOnlyZpeerJsonl\(repoRoot,[\s\S]*?\);/g)].map((m) => Array.isArray(m) ? m[0] : m);
  if (peerLedgerBlocks.some((block) => block.includes(forbidden))) failures.push(`zpeer peer ledger append contains forbidden raw key ${forbidden}`);
}

const command = contents['.pi/extensions/zob-harness/src/runtime/commands.ts'];
const newCommandBlock = command.match(/pi\.registerCommand\("new", \{[\s\S]*?\n  \}\);/)?.[0] ?? '';
if (!newCommandBlock) failures.push('/new hard helper command must remain registered unless another hard reset path exists');
for (const needle of ['ctx.newSession()', 'clearZpeerNewCarryoverProfile(ctx.cwd)', 'markZpeerNewHardResetPending(ctx.cwd)', 'hard', 'pi.appendEntry("zob-znew"', 'schema: "zob.znew-command.v1"', 'source: "registered_command"', 'action: hard ? "new_hard" : "new_soft_deferred_to_session_shutdown"', 'carryoverWritten: false', 'carryoverCleared: hard', 'carryoverDeferredToShutdown: !hard', 'localOnly: true', 'networkEnabled: false', 'bodyStored: false']) {
  if (newCommandBlock && !newCommandBlock.includes(needle)) failures.push(`/new command helper missing hard/deferred metadata ${needle}`);
}
if (!command.includes('Exact `/new` is handled by Pi before extension input/command hooks') || !command.includes('Soft carryover') || !command.includes('session_shutdown')) failures.push('/new command helper must document that soft /new is handled by session_shutdown, not the registered command');
if (newCommandBlock.includes('writeZpeerNewCarryoverProfile(ctx.cwd')) failures.push('/new registered command must not be the soft carryover source; session_shutdown reason=new owns soft carryover');
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'response:', 'body:', 'content:', 'message:', 'text:', 'task:', 'output:', 'diff:', 'patch:']) {
  if (newCommandBlock.includes(forbidden)) failures.push(`/new command append/write path contains forbidden raw/body-like key ${forbidden}`);
}
if (!command.includes('zpeerCommandProfileId(ctx)') || !command.includes('writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer, zpeerProfileId)')) failures.push('zpeer command must save profile under the current Pi session profile after successful name/room changes');
if (!command.includes('customType: "zob-zpeer-response"') || !command.includes('result.transientResponse')) failures.push('zpeer command missing transient response display support');
for (const needle of ['customType: "zob-zpeer-event"', 'if (sendMode.mode !== "async") emitZpeerEvent({ kind: "attempt"', 'feedbackEmittedTerminal', 'send_async', 'replyTimeoutMs', '--require-response', 'requireResponse', 'maxReinjects', 'idle/passive wait; no follow-up turn queued', 'safety: local-only/hash-only/bodyStored=false', 'verb === "clear"', 'action: "clear"', 'verb === "join"', 'verb === "use"', 'verb === "leave"', 'verb === "reply"', 'action: "reply"', 'action: "reply_blocked"', 'buildZobLiveResponseEnvelope', 'sendZobLocalEnvelope(replyEndpoint', 'replyToMsgId: inbound.envelope.msgId', '/zpeer reply <msgId> <response>', 'verb === "rooms"', 'verb === "in"', 'tokenizeZpeerArgs', 'priorityToken', '--reason is required for force', 'interruptReasonHash', 'reasonInputHash', 'interrupt=${result.interruptStatus}', '/zpeer urgent @alias <prompt>', '/zpeer force @alias --reason <reason> <prompt>']) {
  if (!command.includes(needle)) failures.push(`zpeer command missing UX event/status support ${needle}`);
}
if (!command.includes('const eventFromAlias = peerAliasInRoom(state.zobLive.peerCard, eventRoomId)') || !command.includes('peerAliasInRoom(state.zobLive.peerCard, resultRoomId)')) failures.push('/zpeer in <room> events must use room-scoped sender alias');
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'output:', 'content:', 'message:', 'text:', 'diff:', 'patch:']) {
  const appendBlocks = [...command.matchAll(/appendEntry\("zob-zpeer",\s*\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  if (appendBlocks.some((block) => block.includes(forbidden))) failures.push(`zpeer appendEntry contains forbidden key ${forbidden}`);
}

if (!contents['.pi/extensions/zob-harness/src/runtime/events.ts'].includes('ensureZpeerFields')) failures.push('runtime does not auto-ensure zpeer fields');
const events = contents['.pi/extensions/zob-harness/src/runtime/events.ts'];
for (const needle of ['parseZpeerNewSlashInput(event.text)', 'recordZpeerNewCarryoverPreflight(pi, state, ctx.cwd, znewInput.hard)', 'source: "input_pre_dispatch"', 'writeZpeerNewCarryoverProfile(repoRoot', 'clearZpeerNewCarryoverProfile(repoRoot)', 'markZpeerNewHardResetPending(repoRoot)', 'return { action: "continue" as const };']) {
  if (!events.includes(needle)) failures.push(`runtime must pre-dispatch /new carryover before builtin command dispatch where visible: missing ${needle}`);
}
const znewPreDispatchBlock = events.match(/function recordZpeerNewCarryoverPreflight[\s\S]*?function recordZpeerNewCarryoverOnShutdown/)?.[0] ?? '';
if (!znewPreDispatchBlock) failures.push('runtime missing /new pre-dispatch carryover helper');
for (const needle of ['schema: "zob.znew-command.v1"', 'action: hard ? "new_hard" : "new_soft"', 'carryoverWritten: !hard', 'carryoverCleared: hard', 'aliasHash:', 'roomIdHash:', 'activeRoomIdHash:', 'membershipCount:', 'zagentIdHash:', 'localOnly: true', 'networkEnabled: false', 'bodyStored: false']) {
  if (znewPreDispatchBlock && !znewPreDispatchBlock.includes(needle)) failures.push(`/new pre-dispatch hook missing metadata-only field ${needle}`);
}
const znewShutdownBlock = events.match(/function recordZpeerNewCarryoverOnShutdown[\s\S]*?function clearZpeerHeartbeatTimer/)?.[0] ?? '';
if (!znewShutdownBlock) failures.push('runtime missing session_shutdown /new carryover helper');
for (const needle of ['if (reason !== "new") return;', 'zpeerNewHardResetPendingRepos.delete(repoRoot)', 'source: "session_shutdown"', 'action: "new_soft"', 'status: "ok"', 'writeZpeerNewCarryoverProfile(repoRoot', 'zagentId: state.zagent.id', 'carryoverWritten: true', 'carryoverCleared: false', 'shutdownReason: "new"', 'aliasHash:', 'roomIdHash:', 'activeRoomIdHash:', 'membershipCount:', 'zagentIdHash:', 'localOnly: true', 'networkEnabled: false', 'bodyStored: false']) {
  if (znewShutdownBlock && !znewShutdownBlock.includes(needle)) failures.push(`session_shutdown /new carryover missing metadata-only field ${needle}`);
}
if (!events.includes('recordZpeerNewCarryoverOnShutdown(pi, state, ctx.cwd, event.reason)') || !events.includes('await stopZobLiveRuntime(state, ctx)')) failures.push('session_shutdown must write /new carryover before stopZobLiveRuntime clears state');
if (events.indexOf('recordZpeerNewCarryoverOnShutdown(pi, state, ctx.cwd, event.reason)') > events.indexOf('await stopZobLiveRuntime(state, ctx)')) failures.push('session_shutdown /new carryover must happen before stopZobLiveRuntime');
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'response:', 'body:', 'content:', 'message:', 'text:', 'task:', 'output:', 'diff:', 'patch:']) {
  if (znewPreDispatchBlock.includes(forbidden)) failures.push(`/new pre-dispatch hook contains forbidden raw/body-like key ${forbidden}`);
  if (znewShutdownBlock.includes(forbidden)) failures.push(`/new session_shutdown hook contains forbidden raw/body-like key ${forbidden}`);
}
if (!events.includes('readZpeerLocalProfile(repoRoot, profileId)')) failures.push('runtime must load session-scoped zpeer profile before ensuring/registering fields');
if (!events.includes('sharedZpeerProfile ? undefined : zpeerProfile?.alias') || !events.includes('sharedZpeerProfile ? undefined : zpeerProfile?.memberships')) failures.push('runtime must not restore alias/memberships from shared role fallback zpeer profiles');
if ((events.match(/writeZpeerLocalProfileFromPeer\(repoRoot, state\.zobLive\.peerCard, profileId\)/g) ?? []).length < 3 || !events.includes('zpeerRuntimeProfileId(ctx)')) failures.push('runtime must persist zpeer self profile under the current Pi session during initial registration, refresh, and shutdown');
if (!events.includes('zpeerProfileRoomId') || !events.includes('zpeerProfileAlias') || !events.includes('zpeerProfileMemberships')) failures.push('runtime must apply persisted zpeer room and conditionally stable alias/memberships during ensure');
for (const needle of ['readZpeerNewCarryoverProfile(repoRoot)', 'const carryoverProfile = !explicitZagentId && !zpeerProfile ? readZpeerNewCarryoverProfile(repoRoot) : undefined', 'carryoverProfile?.zagentId', 'loadActiveZagentById(state, repoRoot, carryoverProfile.zagentId)', 'carryoverProfile?.activeRoomId ?? carryoverProfile?.roomId', '?? carryoverProfile?.alias', '?? carryoverProfile?.memberships']) {
  if (!events.includes(needle)) failures.push(`runtime must restore /new carryover when no env/session profile: missing ${needle}`);
}
if (!events.includes('event.source === "extension" && !event.text.trim()') || !events.includes('action: "handled" as const')) failures.push('runtime must handle empty extension follow-ups without continuing the agent');
if (!events.includes('ZPeer async reply received from @') || !events.includes('{ triggerTurn: true, deliverAs: "followUp" }')) failures.push('runtime must resume an idle agent with a follow-up when an async ZPeer reply arrives');
for (const needle of ['forceAbortAllowedForCurrentState', 'interruptStatus = "force_blocked"', 'interruptStatus = "force_downgraded"', 'ctx.abort()', 'const deliverAs = priority === "normal" ? "followUp" : "steer"', 'inboundByMsgId', 'activeInboundMsgId', 'state.zobLive.inboundByMsgId && !activeInbound', 'scheduleZpeerRequiredResponseWatchdog', 'required_response_reinject', 'required_response_expired', 'Original transient message:', 'zpeer_required_response_expired', 'pendingReplies.expire', 'forceAbortRepeated: false', 'replyToMsgId !== envelope.msgId', 'wrong or missing replyToMsgId']) {
  if (!events.includes(needle)) failures.push(`runtime missing urgent/force/msgId-safe inbound support ${needle}`);
}
for (const needle of ['ZPEER AWARENESS (transient, rebuilt each turn)', 'buildZpeerPeerRoomSummaries(repoRoot, state.zobLive.peerCard)', '- rooms:', 'explicit roomId', 'zpeer_ask with mode=\\"async\\"', 'Passive wait rule', 'stop the turn and remain idle', 'avoid spam', 'Raw ZPeer bodies are transient', 'registerMessageRenderer("zob-zpeer-event"', 'scheduleZpeerHeartbeat', 'clearZpeerHeartbeatTimer', 'refreshZpeerSelf(repoRoot', 'kind: "response_sent"', 'kind: "inbound"', 'zpeerStableTeamAgentLeaseRequired', 'withZpeerLeaseMode', 'leaseStatus = "unavailable"', 'runtime_adhoc']) {
  if (!events.includes(needle)) failures.push(`runtime missing zpeer awareness/event support ${needle}`);
}
const responseSentBlock = events.match(/setZpeerLastEvent\(state, \{\s*kind: "response_sent"[\s\S]*?customType: "zob-zpeer-event"[\s\S]*?triggerTurn: false[\s\S]*?\}\);/)?.[0] ?? '';
if (!responseSentBlock) failures.push('runtime missing response_sent zob-zpeer-event feed card after lastEvent update');
for (const needle of ['roomId:', 'fromAlias:', 'toAlias:', 'status: "response_sent"', 'msgId:', 'taskHash:', 'outputHash:', 'bodyStored: false', 'localOnly: true', 'networkEnabled: false']) {
  if (responseSentBlock && !responseSentBlock.includes(needle)) failures.push(`response_sent feed card missing metadata-only field ${needle}`);
}
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'response:', 'body:', 'content: responseText', 'message:', 'text:', 'rationale:', 'diff:', 'patch:']) {
  if (responseSentBlock.includes(forbidden)) failures.push(`response_sent feed card contains forbidden raw/body-like field ${forbidden}`);
}
const transcriptCapture = contents['.pi/extensions/zob-harness/src/domains/coms/coms-v2/transcript-capture.ts'];
const artifactBlock = transcriptCapture.match(/const artifact = \{[\s\S]*?\n  \};/)?.[0] ?? '';
if (!artifactBlock) failures.push('redacted capture artifact shape not found');
for (const needle of ['rawBodiesStored: false', 'redactedBodiesStored: true', 'comsLedgerBodyStored: false', 'bodyStored: false', 'taskHash: input.taskHash', 'outputHash: input.outputHash']) {
  if (artifactBlock && !artifactBlock.includes(needle)) failures.push(`redacted capture artifact missing no-raw-body evidence ${needle}`);
}
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'response:', 'body:', 'content:', 'message:', 'text:', 'rationale:', 'diff:', 'patch:']) {
  if (artifactBlock.includes(forbidden)) failures.push(`redacted capture artifact contains forbidden raw/body-like persisted key ${forbidden}`);
}
const captureRefBlock = transcriptCapture.match(/return \{\s*schema: "zob\.coms-redacted-capture-ref\.v1"[\s\S]*?\n  \};/)?.[0] ?? '';
if (!captureRefBlock || !captureRefBlock.includes('bodyStored: false')) failures.push('redacted capture ref must remain bodyStored=false');
if (!transcriptCapture.includes('writeFileSync(artifactPath, serialized, "utf8")')) failures.push('redacted capture static smoke could not locate persisted serialized artifact write');
if (!transcriptCapture.includes('const serialized = `${JSON.stringify(artifact, null, 2)}\\n`;')) failures.push('redacted capture must persist only the artifact object inspected by this smoke');
const widget = contents['.pi/extensions/zob-harness/src/runtime/widget.ts'];
if (!widget.includes('ZPeer')) failures.push('HUD missing ZPeer line');
if (!widget.includes('"Last"')) failures.push('HUD missing ZPeer Last line');
if (!widget.includes('"Wait"') || !widget.includes('lastHeartbeatMs')) failures.push('HUD missing ZPeer wait/heartbeat freshness line');
for (const needle of ['buildZpeerPeerRoomSummaries', 'zpeerRoomCap = 4', 'summary.active ? "*"', 'summary.roomId', 'summary.selfAlias', 'summary.online}/${summary.peerCount}', 'summary.stale > 0', 'summary.offline > 0', '+${zpeerRoomSummaries.length - zpeerRoomCap} rooms', 'truncateToWidth(`${marker}', 'Math.min(52, Math.max(34, Math.floor(availableColumnWidth * 0.36)))', 'truncateToWidth(`${marker} ${summary.roomId} ${selfAlias} ${peerState} ${aliasText}`, 52, "…")']) {
  if (!widget.includes(needle)) failures.push(`HUD multi-room ZPeer missing ${needle}`);
}
const stateTs = contents['.pi/extensions/zob-harness/src/runtime/state.ts'];
if (!stateTs?.includes('ZobLiveLastEvent')) failures.push('runtime state missing in-memory ZPeer last event type');
for (const needle of ['ZobPassivePeerWaitState', 'passivePeerWait?: ZobPassivePeerWaitState', 'schema: "zob.passive-peer-wait.v1"', 'suppressGoalContinuation: true', 'bodyStored: false', 'localOnly: true', 'networkEnabled: false']) {
  if (!stateTs.includes(needle)) failures.push(`runtime state missing passive peer wait field ${needle}`);
}
const goalRuntime = contents['.pi/extensions/zob-harness/src/runtime/goal-runtime.ts'];
for (const needle of ['state.zobLive.passivePeerWait?.suppressGoalContinuation === true', 'clearRuntimeGoalContinuationTimer(state)', 'return;']) {
  if (!goalRuntime.includes(needle)) failures.push(`goal runtime missing passive peer continuation suppression ${needle}`);
}

const childRunner = contents['.pi/extensions/zob-harness/src/domains/delegation/child-runner.ts'];
for (const needle of ['childModelPattern', 'ctx.model', 'resolveCodexFastModeExtension', 'getAgentDir()', 'codex-fast-mode.ts', 'childCodexFastModeExtension', 'args.push("-e", childCodexFastModeExtension)', 'const model = resolvedModel']) {
  if (!childRunner.includes(needle)) failures.push(`delegation child runner missing Codex auto/model inheritance support ${needle}`);
}
for (const needle of ['updatePassivePeerWaitState(state, result', 'result.status !== "waiting"', 'state.zobLive.passivePeerWait = undefined', 'schema: "zob.passive-peer-wait.v1"', 'source: "zpeer_ask"', 'suppressGoalContinuation: true', 'bodyStored: false', 'localOnly: true', 'networkEnabled: false']) {
  if (!toolsComs.includes(needle)) failures.push(`zpeer_ask missing passive peer wait state handling ${needle}`);
}
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'message:', 'content:', 'text:', 'prompt:', 'response:']) {
  const passiveWaitBlocks = [...toolsComs.matchAll(/state\.zobLive\.passivePeerWait = \{[\s\S]*?\n  \};/g)].map((m) => m[0]);
  if (passiveWaitBlocks.some((block) => block.includes(forbidden))) failures.push(`passivePeerWait block contains forbidden body-like key ${forbidden}`);
}
for (const needle of ['clearPassivePeerWaitForResponse', 'envelope.type !== "response"', 'envelope.msgId === wait.msgId', 'state.zobLive.passivePeerWait = undefined', 'envelope.sender === wait.targetAlias']) {
  if (!events.includes(needle)) failures.push(`runtime events missing passive wait response clear ${needle}`);
}
if (!contents['.pi/extensions/zob-harness/src/domains/coms/mission-control.ts'].includes('zpeerRooms')) failures.push('Mission Control missing zpeerRooms summary');

if (failures.length > 0) {
  console.error(`zpeer static smoke FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('zpeer static smoke PASS');
