#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const failures = [];
function assert(condition, message) { if (!condition) failures.push(message); }
function includes(source, needle, label) { assert(source.includes(needle), `${label} missing ${needle}`); }
function sectionBetween(source, start, end, label) {
  const startIndex = source.indexOf(start);
  const endIndex = startIndex >= 0 ? source.indexOf(end, startIndex + start.length) : -1;
  if (startIndex < 0 || endIndex < 0) {
    failures.push(`could not extract ${label}`);
    return '';
  }
  return source.slice(startIndex, endIndex);
}

const tools = readFileSync('.pi/extensions/zob-harness/src/runtime/tools-zagent.ts', 'utf8');
const schemas = readFileSync('.pi/extensions/zob-harness/src/runtime/schemas.ts', 'utf8');
const harness = readFileSync('.pi/extensions/zob-harness/src/runtime/zobHarness.ts', 'utf8');
const constants = readFileSync('.pi/extensions/zob-harness/src/core/constants.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const skill = readFileSync('.pi/skills/zob-zagent-creator/SKILL.md', 'utf8');
const registry = JSON.parse(readFileSync('.pi/capabilities/zob-public-runtime-capabilities.json', 'utf8'));
const hotAddEntry = registry.tools?.find((tool) => tool.name === 'zob_zteam_hot_add');
const removeEntry = registry.tools?.find((tool) => tool.name === 'zob_zteam_remove');

includes(harness, 'import { registerZagentTools } from "./tools-zagent.js";', 'zagent tool registration import');
includes(harness, 'registerZagentTools(pi, state);', 'zagent tool registration call');

includes(schemas, 'const ZteamHotAddParams = Type.Object', 'hot-add schema');
includes(schemas, 'const ZteamRemoveParams = Type.Object', 'remove schema');
includes(schemas, 'StringEnum(["plan", "apply", "launch"]', 'plan/apply/launch schema');
includes(schemas, 'apply_confirmation', 'hot-add confirmation schema');
includes(schemas, 'launch_confirmation_phrase', 'hot-add launch confirmation schema');
includes(schemas, 'tmux_session_name', 'hot-add launch tmux session schema');
includes(schemas, 'presence_timeout_ms', 'hot-add launch presence timeout schema');
includes(schemas, 'StringEnum(["plan", "apply", "close_tmux"]', 'remove plan/apply/close schema');
includes(schemas, 'confirmation_phrase', 'remove confirmation schema');
includes(schemas, 'close_confirmation_phrase', 'remove close confirmation schema');
includes(schemas, 'tmux_window_name', 'remove close window schema');
includes(schemas, 'graceful_timeout_ms', 'remove graceful timeout schema');
includes(schemas, 'force_close_window', 'remove targeted close fallback schema');
includes(schemas, 'manifest_and_prompt', 'remove delete scope schema');
includes(schemas, 'include_tmux_plan', 'manual tmux plan schema');
includes(schemas, 'ZteamHotAddParams,', 'schema export');
includes(schemas, 'ZteamRemoveParams,', 'schema export');

includes(constants, 'ZOB_ZAGENT_TOOLS = ["zob_zteam_hot_add", "zob_zteam_remove"]', 'mode tool constants');
includes(constants, '...ZOB_ZAGENT_TOOLS', 'mode allowlists');

includes(tools, 'name: "zob_zteam_hot_add"', 'hot-add tool registration');
includes(tools, 'name: "zob_zteam_remove"', 'remove tool registration');
includes(tools, 'params.action ?? "plan"', 'default plan-only action');
includes(tools, 'spawnCount: 0', 'no-spawn result');
includes(tools, 'bodyStored: false', 'body-free result');
includes(tools, 'requestHash', 'hot-add request hash');
includes(tools, 'sourceCommand: "zob_zteam_hot_add"', 'hot-add manifest source');
includes(tools, 'manualLaunchOnly: true', 'hot-add manifest manual launch posture');
includes(tools, 'apply requires exact apply_confirmation=${teamId}', 'hot-add exact confirmation gate');
includes(tools, 'tmux window plan requires exact launch_confirmation=${teamId}', 'hot-add tmux plan confirmation gate');
includes(tools, 'LAUNCH ZTEAM ${teamId} ZAGENT ${agentId} IN TMUX ${sessionName}', 'hot-add launch exact confirmation phrase');
includes(tools, 'action=launch requires safe team_id', 'hot-add launch team id gate');
includes(tools, 'launch requires existing ZTeam manifest', 'hot-add launch zteam manifest gate');
includes(tools, 'launch requires existing ZAgent manifest', 'hot-add launch zagent manifest gate');
includes(tools, 'launch requires ZAgent membership in ZTeam', 'hot-add launch membership gate');
includes(tools, 'chooseTmuxSessionExists(plan.sessionName)', 'hot-add launch existing session gate');
includes(tools, 'chooseTmuxWindowExists(plan.sessionName, plan.windowName)', 'hot-add launch absent window gate');
includes(tools, '["new-window", "-d", "-t", plan.sessionName, "-n", plan.windowName]', 'hot-add launch scoped detached tmux new-window');
includes(tools, '["send-keys", "-t", `${plan.sessionName}:${plan.windowName}`, plan.launchCommand, "C-m"]', 'hot-add launch send-keys target command');
includes(tools, 'waitForTeamAgentPresence', 'hot-add launch bounded presence wait');
includes(tools, 'liveProofBlocked', 'hot-add launch live proof blocker');
includes(tools, 'REMOVE ZTEAM ${teamId} ZAGENT ${agentId} SCOPE ${scope}', 'remove exact confirmation phrase');
includes(tools, 'deleteManifestPlanned', 'remove manifest scope');
includes(tools, 'deletePromptPlanned', 'remove prompt scope');
includes(tools, 'promptPathSafe', 'remove prompt path safety gate');
includes(tools, 'outside .pi/zagents/prompts', 'remove prompt scope path blocker');
includes(tools, 'manual only: inspect scoped session', 'remove manual tmux plan');
includes(tools, 'no kill/close/restart is executed by zob_zteam_remove', 'remove manual plan no process/tmux kill posture');
includes(tools, 'CLOSE ZTEAM ${teamId} ZAGENT ${agentId} TMUX WINDOW ${sessionName}', 'remove close exact confirmation phrase');
includes(tools, 'action=close_tmux requires safe team_id', 'remove close safe team id gate');
includes(tools, 'chooseTmuxSessionExists(plan.sessionName)', 'remove close existing session gate');
includes(tools, 'chooseTmuxWindowExists(plan.sessionName, plan.windowName)', 'remove close existing target window gate');
includes(tools, '["send-keys", "-t", target, "C-u", "/quit", "C-m"]', 'remove close graceful quit command');
includes(tools, '["kill-window", "-t", tmuxTarget(plan.sessionName, plan.windowName)]', 'remove close targeted window fallback');
includes(tools, 'forceCloseWindow: params.force_close_window === true', 'remove close explicit force flag');
includes(tools, 'waitForTeamAgentNotOnlineOrWindowGone', 'remove close bounded presence/window wait');
includes(tools, 'targetedWindowCloseUsed', 'remove close target-close evidence');
includes(tools, 'liveCloseBlocked', 'remove close live blocker');

const hotAddToolSection = sectionBetween(tools, 'pi.registerTool({\n    name: "zob_zteam_hot_add"', 'pi.registerTool({\n    name: "zob_zteam_remove"', 'hot-add registerTool section');
const removeToolSection = sectionBetween(tools, 'pi.registerTool({\n    name: "zob_zteam_remove"', '\n  });\n}', 'remove registerTool section');
assert(tools.includes('spawnSync(command, args'), 'hot-add launch must use bounded child_process spawnSync wrapper');
assert(tools.includes('from "node:child_process"'), 'hot-add launch must import child_process explicitly for tmux action');
assert(!tools.includes('execSync('), 'zteam tools must not exec tmux/pi commands through a shell');
assert(!tools.includes('kill-session'), 'zteam tools must not contain tmux kill-session operations');
assert(!tools.includes('kill-server'), 'zteam tools must not contain tmux kill-server operations');
assert(!tools.includes('new-session'), 'zteam remove/launch tools must not create tmux sessions');
assert(!tools.includes('killall'), 'zteam tools must not contain broad process kills');
assert(!tools.includes('pkill'), 'zteam tools must not contain broad process pkill');
assert(tools.includes('["kill-window", "-t", tmuxTarget(plan.sessionName, plan.windowName)]'), 'remove close may only use targeted tmux kill-window fallback');
assert(hotAddToolSection.includes('tool_hot_add_plan'), 'hot-add tool must ledger plan action');
assert(hotAddToolSection.includes('tool_hot_add_apply_blocked'), 'hot-add apply must block before writing when gated');
assert(hotAddToolSection.includes('tool_hot_add_launch_blocked'), 'hot-add launch must block before tmux when gated');
assert(hotAddToolSection.includes('runHotAddLaunch(ctx.cwd, launchPlan)'), 'hot-add launch must run only through governed launch helper');
assert(removeToolSection.includes('tool_remove_plan'), 'remove tool must ledger plan action');
assert(removeToolSection.includes('tool_remove_apply_blocked'), 'remove apply must block before deleting when gated');
assert(removeToolSection.includes('tool_remove_close_tmux_blocked'), 'remove close must block before tmux when gated');
assert(removeToolSection.includes('runRemoveTmuxClose(ctx.cwd, closePlan)'), 'remove close must run only through governed close helper');

const hotAddLedger = sectionBetween(tools, 'function hotAddLedgerEntry', 'function formatHotAddPlan', 'hot-add ledger');
assert(!hotAddLedger.includes('promptBody'), 'hot-add ledger must not persist generated prompt body');
assert(!hotAddLedger.includes('params.request'), 'hot-add ledger must not persist raw request');
assert(!hotAddLedger.includes('tmuxWindowCommand,'), 'hot-add ledger must not persist raw tmux command');
includes(hotAddLedger, 'localOnly: true', 'hot-add local-only ledger');
includes(hotAddLedger, 'networkEnabled: false', 'hot-add no-network ledger');
includes(hotAddLedger, 'requestHash: plan.requestHash', 'hot-add hash-only ledger');
includes(hotAddLedger, 'pathHashes', 'hot-add path hash ledger');
includes(hotAddLedger, 'tmuxWindowPlanHash', 'hot-add tmux plan hash ledger');
includes(hotAddLedger, 'promptBodiesStored: false', 'hot-add prompt body-free ledger');
const hotAddLaunchLedger = sectionBetween(tools, 'function hotAddLaunchLedgerEntry', 'function formatHotAddLaunch', 'hot-add launch ledger');
assert(!hotAddLaunchLedger.includes('launchCommand,'), 'hot-add launch ledger must not persist raw launch command');
assert(!hotAddLaunchLedger.includes('confirmationRequired,'), 'hot-add launch ledger must not persist raw confirmation phrase');
includes(hotAddLaunchLedger, 'localOnly: true', 'hot-add launch local-only ledger');
includes(hotAddLaunchLedger, 'networkEnabled: false', 'hot-add launch no-network ledger');
includes(hotAddLaunchLedger, 'sessionNameHash', 'hot-add launch session hash ledger');
includes(hotAddLaunchLedger, 'launchCommandHash', 'hot-add launch command hash ledger');
includes(hotAddLaunchLedger, 'liveProofBlocked', 'hot-add launch live-proof ledger');
includes(hotAddLaunchLedger, 'bodyStored: false', 'hot-add launch body-free ledger');

const removeLedger = sectionBetween(tools, 'function removeLedgerEntry', 'function formatRemovePlan', 'remove ledger');
assert(!removeLedger.includes('nextTeamManifest'), 'remove ledger must not persist rewritten team manifest body');
assert(!removeLedger.includes('manualTmuxPlan'), 'remove ledger must not persist raw tmux cleanup text');
includes(removeLedger, 'localOnly: true', 'remove local-only ledger');
includes(removeLedger, 'networkEnabled: false', 'remove no-network ledger');
includes(removeLedger, 'scopeHash: sha256(plan.scope)', 'remove scope hash ledger');
includes(removeLedger, 'confirmationPhraseHash', 'remove confirmation hash ledger');
includes(removeLedger, 'pathHashes', 'remove path hash ledger');
includes(removeLedger, 'bodyStored: false', 'remove body-free ledger');
const removeCloseLedger = sectionBetween(tools, 'function removeTmuxCloseLedgerEntry', 'function formatRemoveTmuxClose', 'remove close ledger');
assert(!removeCloseLedger.includes('confirmationRequired,'), 'remove close ledger must not persist raw confirmation phrase');
includes(removeCloseLedger, 'localOnly: true', 'remove close local-only ledger');
includes(removeCloseLedger, 'networkEnabled: false', 'remove close no-network ledger');
includes(removeCloseLedger, 'sessionNameHash', 'remove close session hash ledger');
includes(removeCloseLedger, 'windowNameHash', 'remove close window hash ledger');
includes(removeCloseLedger, 'gracefulCommandHash', 'remove close graceful command hash ledger');
includes(removeCloseLedger, 'targetCloseCommandHash', 'remove close target close command hash ledger');
includes(removeCloseLedger, 'liveCloseBlocked', 'remove close live blocker ledger');
includes(removeCloseLedger, 'bodyStored: false', 'remove close body-free ledger');

const applyHotAdd = sectionBetween(tools, 'function applyHotAddPlan', 'function redactHotAddPlan', 'hot-add apply');
includes(applyHotAdd, 'writeFileSync(plan.promptPath', 'hot-add apply prompt write');
includes(applyHotAdd, 'writeFileSync(plan.zagentPath', 'hot-add apply zagent write');
includes(applyHotAdd, 'writeFileSync(plan.teamPath', 'hot-add apply team write');
assert(!applyHotAdd.includes('tmux'), 'hot-add apply must not execute tmux');

const applyRemove = sectionBetween(tools, 'function applyRemovePlan', 'function redactRemovePlan', 'remove apply');
includes(applyRemove, 'unlinkSync(plan.zagentPath)', 'remove apply manifest deletion');
includes(applyRemove, 'unlinkSync(plan.promptPath)', 'remove apply prompt deletion');
assert(!applyRemove.includes('tmux'), 'remove apply must not execute tmux');
assert(!applyRemove.includes('rm '), 'remove apply must use scoped unlinkSync, not shell rm');

assert(pkg.scripts?.['smoke:zteam-tools'] === 'node scripts/zteam-tools/smoke.mjs', 'package.json must expose focused zteam tool smoke');
includes(skill, '`zob_zteam_hot_add`', 'zagent skill tool docs');
includes(skill, '`zob_zteam_remove`', 'zagent skill remove docs');
assert(hotAddEntry?.family === 'zteam/zagent', 'capability registry must include zob_zteam_hot_add');
assert(removeEntry?.family === 'zteam/zagent', 'capability registry must include zob_zteam_remove');
assert(hotAddEntry?.noShipNotes?.includes('Defaults to plan-only/no-spawn'), 'hot-add registry must document plan-only/no-spawn');
assert(hotAddEntry?.noShipNotes?.includes('action=launch'), 'hot-add registry must document explicit launch action');
assert(hotAddEntry?.noShipNotes?.includes('LAUNCH ZTEAM'), 'hot-add registry must document exact launch phrase');
assert(hotAddEntry?.noShipNotes?.includes('liveProofBlocked'), 'hot-add registry must document presence blocker');
assert(removeEntry?.noShipNotes?.includes('exact confirmation phrase'), 'remove registry must document exact apply confirmation');
assert(removeEntry?.noShipNotes?.includes('action=close_tmux'), 'remove registry must document explicit close action');
assert(removeEntry?.noShipNotes?.includes('CLOSE ZTEAM'), 'remove registry must document exact close phrase');
assert(removeEntry?.noShipNotes?.includes('force_close_window'), 'remove registry must document explicit targeted fallback');

if (failures.length > 0) {
  console.error(`zteam tool smoke FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('zteam tool smoke PASS');
