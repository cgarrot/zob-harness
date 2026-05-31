#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const files = [
  '.pi/extensions/zob-harness/src/coms-v2/zpeer.ts',
  '.pi/extensions/zob-harness/src/coms-v2/zpeer-profile.ts',
  '.pi/extensions/zob-harness/src/coms-v2/transcript-capture.ts',
  '.pi/extensions/zob-harness/src/runtime/commands.ts',
  '.pi/extensions/zob-harness/src/runtime/tools-coms.ts',
  '.pi/extensions/zob-harness/src/runtime/events.ts',
  '.pi/extensions/zob-harness/src/runtime/state.ts',
  '.pi/extensions/zob-harness/src/runtime/widget.ts',
  '.pi/extensions/zob-harness/src/mission-control.ts',
  '.pi/extensions/zob-harness/src/schemas.ts',
  '.pi/extensions/zob-harness/src/constants.ts',
  '.pi/capabilities/zob-public-runtime-capabilities.json',
];
const contents = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
const failures = [];

const commandMatches = contents['.pi/extensions/zob-harness/src/runtime/commands.ts'].match(/registerCommand\("zpeer"/g) ?? [];
if (commandMatches.length !== 1) failures.push(`expected exactly one zpeer command, found ${commandMatches.length}`);
const toolsComs = contents['.pi/extensions/zob-harness/src/runtime/tools-coms.ts'];
const zpeerAskMatches = toolsComs.match(/name: "zpeer_ask"/g) ?? [];
if (zpeerAskMatches.length !== 1) failures.push(`expected exactly one zpeer_ask tool, found ${zpeerAskMatches.length}`);
for (const needle of ['parameters: ZpeerAskParams', 'sendZpeerPrompt(ctx.cwd', 'mode = params.mode ?? "async"', 'zpeerAskGuardBlock', 'max 3 agent-initiated ZPeer asks per 60s window', 'customType: "zob-zpeer-event"', 'source: "agent-request"', 'action: "agent_request"', 'feedbackEmittedTerminal', 'reasonInputHash', 'bodyStored: false', 'promptBodiesStored: false', 'outputBodiesStored: false']) {
  if (!toolsComs.includes(needle)) failures.push(`zpeer_ask tool missing ${needle}`);
}
if (toolsComs.includes('emitZpeerAskEvent({ kind: "attempt", status: "agent-request"')) failures.push('zpeer_ask async must not emit pre-ACK attempt feed noise');
if (!toolsComs.includes('peerAliasInRoom(self, requestedRoomId)') || !toolsComs.includes('peerAliasInRoom(self, eventRoomId)')) failures.push('zpeer_ask feed events must use room-scoped sender alias for explicit roomId');
const schemas = contents['.pi/extensions/zob-harness/src/schemas.ts'];
for (const needle of ['const ZpeerAskParams', 'targetAlias', 'message', 'roomId', 'Default async', '["async", "await", "long"]', 'timeoutMs', 'ZpeerAskParams']) {
  if (!schemas.includes(needle)) failures.push(`zpeer_ask schema missing ${needle}`);
}
const registry = contents['.pi/capabilities/zob-public-runtime-capabilities.json'];
if (!registry.includes('"name": "zpeer_ask"') || !registry.includes('rate/loop guarded')) failures.push('capability registry missing zpeer_ask visibility/safety notes');
const constants = contents['.pi/extensions/zob-harness/src/constants.ts'];
const zpeerComsAllowlistBlock = constants.match(/export const ZOB_COMS_TOOLS = \[[^\n]*\] as const;/)?.[0] ?? '';
if (!zpeerComsAllowlistBlock.includes('"zpeer_ask"')) failures.push('ZOB_COMS_TOOLS missing zpeer_ask active allowlist entry');
const modeBlocks = Object.fromEntries([...constants.matchAll(/\n  (explore|plan|implement|oracle|orchestrator|factory): \[[^\n]*\],/g)].map((match) => [match[1], match[0]]));
for (const mode of ['plan', 'implement', 'orchestrator', 'factory']) {
  if (!modeBlocks[mode]?.includes('...ZOB_COMS_TOOLS')) failures.push(`MODE_TOOLS.${mode} must expose zpeer_ask through ZOB_COMS_TOOLS`);
}
for (const mode of ['explore', 'oracle']) {
  if (!modeBlocks[mode]?.includes('"zpeer_ask"')) failures.push(`MODE_TOOLS.${mode} missing zpeer_ask explicit active allowlist entry`);
}
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'output:', 'content: params.message', 'message: params.message', 'text: params.message', 'diff:', 'patch:']) {
  const appendBlocks = [...toolsComs.matchAll(/appendEntry\("zob-zpeer",\s*\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  if (appendBlocks.some((block) => block.includes(forbidden))) failures.push(`zpeer_ask appendEntry contains forbidden raw key/value ${forbidden}`);
}

const zpeer = contents['.pi/extensions/zob-harness/src/coms-v2/zpeer.ts'];
const zpeerProfile = contents['.pi/extensions/zob-harness/src/coms-v2/zpeer-profile.ts'];
for (const needle of ['networkEnabled: false', 'localOnly: true', 'bodyStored: false', 'sendZobLocalEnvelope', 'taskHash', 'outputHash', 'ZpeerSendMode', 'status: "waiting"', 'status: "reply"', 'zpeerMembershipsForPeer', 'joinZpeerRoom', 'leaveZpeerRoom', 'useZpeerRoom', 'roomId?: string', 'buildZpeerPeerRoomSummaries', 'active: membership.roomId === activeRoomId']) {
  if (!zpeer.includes(needle)) failures.push(`zpeer missing ${needle}`);
}
for (const needle of ['peer-messages.jsonl', 'peer-status.jsonl', 'appendZpeerPeerRecords', 'reasonHash', 'bodyStored: false']) {
  if (!zpeer.includes(needle)) failures.push(`zpeer hash-only peer ledger support missing ${needle}`);
}
if (/required_network|pi-vs-claude-code|sse/.test(zpeer)) failures.push('zpeer must not enable network/SSE transport');
if (!zpeer.includes('normalizeZpeerMemberships(restoredMemberships)') || !zpeer.includes('restoredRoomId(roomId) ?? restoredRoomId(peer.zpeerActiveRoomId) ?? baseMemberships[0]?.roomId') || !zpeer.includes(': safeZpeerRoomId(roomId ?? peer.zpeerActiveRoomId ?? peer.zpeerRoomId)')) failures.push('ensureZpeerFields restored memberships must avoid legacy/default fallback injection');
for (const needle of ['schema: PROFILE_SCHEMA', 'profileId', 'projectId', 'alias', 'roomId', 'localOnly: true', 'networkEnabled: false', 'bodyStored: false', 'ZOB_ZPEER_PROFILE_ID', 'ZPEER_PROFILE', 'ZOB_COMS_SESSION_ID', 'zpeer-profiles']) {
  if (!zpeerProfile.includes(needle)) failures.push(`zpeer profile missing ${needle}`);
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
if (!command.includes('writeZpeerLocalProfileFromPeer(ctx.cwd, result.peer)')) failures.push('zpeer command must save profile after successful name/room changes');
if (!command.includes('customType: "zob-zpeer-response"') || !command.includes('result.transientResponse')) failures.push('zpeer command missing transient response display support');
for (const needle of ['customType: "zob-zpeer-event"', 'if (sendMode.mode !== "async") emitZpeerEvent({ kind: "attempt"', 'feedbackEmittedTerminal', 'send_async', 'replyTimeoutMs', 'safety: local-only/hash-only/bodyStored=false', 'verb === "join"', 'verb === "use"', 'verb === "leave"', 'verb === "rooms"', 'verb === "in"']) {
  if (!command.includes(needle)) failures.push(`zpeer command missing UX event/status support ${needle}`);
}
if (!command.includes('const eventFromAlias = peerAliasInRoom(state.zobLive.peerCard, eventRoomId)') || !command.includes('peerAliasInRoom(state.zobLive.peerCard, resultRoomId)')) failures.push('/zpeer in <room> events must use room-scoped sender alias');
for (const forbidden of ['transientPrompt:', 'transientResponse:', 'prompt:', 'output:', 'content:', 'message:', 'text:', 'diff:', 'patch:']) {
  const appendBlocks = [...command.matchAll(/appendEntry\("zob-zpeer",\s*\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  if (appendBlocks.some((block) => block.includes(forbidden))) failures.push(`zpeer appendEntry contains forbidden key ${forbidden}`);
}

if (!contents['.pi/extensions/zob-harness/src/runtime/events.ts'].includes('ensureZpeerFields')) failures.push('runtime does not auto-ensure zpeer fields');
const events = contents['.pi/extensions/zob-harness/src/runtime/events.ts'];
if (!events.includes('readZpeerLocalProfile(repoRoot)')) failures.push('runtime must load zpeer profile before ensuring/registering fields');
if (!events.includes('zpeerProfile?.roomId, zpeerProfile?.alias')) failures.push('runtime must apply persisted zpeer room/alias during ensure');
for (const needle of ['ZPEER AWARENESS (transient, rebuilt each turn)', 'zpeer_ask with mode=\\"async\\"', 'avoid spam', 'Raw ZPeer bodies are transient', 'registerMessageRenderer("zob-zpeer-event"', 'scheduleZpeerHeartbeat', 'clearZpeerHeartbeatTimer', 'refreshZpeerSelf(repoRoot', 'kind: "response_sent"', 'kind: "inbound"']) {
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
const transcriptCapture = contents['.pi/extensions/zob-harness/src/coms-v2/transcript-capture.ts'];
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
if (!contents['.pi/extensions/zob-harness/src/runtime/state.ts']?.includes('ZobLiveLastEvent')) failures.push('runtime state missing in-memory ZPeer last event type');
if (!contents['.pi/extensions/zob-harness/src/mission-control.ts'].includes('zpeerRooms')) failures.push('Mission Control missing zpeerRooms summary');

if (failures.length > 0) {
  console.error(`zpeer static smoke FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('zpeer static smoke PASS');
