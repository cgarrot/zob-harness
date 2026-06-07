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

const commands = readSurface('.pi/extensions/zob-harness/src/runtime/commands.ts');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const skill = readFileSync('.pi/skills/zob-zagent-creator/SKILL.md', 'utf8');
const registry = JSON.parse(readFileSync('.pi/capabilities/zob-public-runtime-capabilities.json', 'utf8'));
const zteamEntry = registry.commands?.find((command) => command.name === 'zteam');

includes(commands, 'hot-add [id] <ask>', 'zteam command description');
includes(commands, 'parseZteamHotAddArgs(ctx.cwd, parts)', 'hot-add handler');
includes(commands, 'resolveZteamHotAddTeamId(ctx.cwd, state, parsed.id)', 'hot-add current-context resolution');
includes(commands, 'source: "env"', 'team resolution');
includes(commands, 'source: "zagent"', 'team resolution');
includes(commands, 'source: "zpeer"', 'team resolution');
includes(commands, 'source: "activeRoom"', 'team resolution');
includes(commands, 'source: "repoConvention"', 'team resolution');
includes(commands, 'promptRef = `.pi/zagents/prompts/${agentId}.md`', 'generated prompt ref');
includes(commands, 'promptBody = buildHotAddPrompt', 'generated prompt body');
includes(commands, 'tools = hotAddToolsForMode(defaultMode)', 'explicit tools');
includes(commands, 'allowedPaths = hotAddAllowedPathsForMode(defaultMode)', 'allowed paths');
includes(commands, 'forbiddenPaths = [...HOT_ADD_FORBIDDEN_PATHS]', 'forbidden paths');
includes(commands, 'approvalGates', 'owner approval gates');
includes(commands, 'externalAccess', 'external access gate');
includes(commands, 'commit: "Commit/push/tag forbidden unless owner explicitly requests governed zcommit."', 'commit gate');
includes(commands, 'buildHotAddTmuxWindowCommand', 'tmux window plan');
includes(commands, 'tmux new-window', 'tmux window command');
includes(commands, 'hot-add never launches tmux/pi automatically', 'no auto launch text');
includes(commands, 'presence check after manual launch', 'presence subflow output');
includes(commands, 'tmux window is not presence proof', 'presence proof rule');
includes(commands, 'zob.zteam-hot-add-presence.v1', 'presence ledger');
includes(commands, 'readZobLiveRegistryAllProjectsSnapshot(repoRoot, teamId)', 'presence check local registry');
includes(commands, 'writeFileSync(plan.promptPath', 'apply writes prompt');

const handlerSection = sectionBetween(commands, 'if (action === "hot-add" || action === "hotadd" || action === "add-agent")', 'if (action === "hot-add-presence"', 'hot-add handler');
assert(!handlerSection.includes('spawnSync('), 'hot-add handler must not spawn tmux/pi or call spawnSync');
assert(handlerSection.includes('execute: false, spawnCount: 0, bodyStored: false'), 'hot-add dry-run details must be no-spawn/body-free');
assert(handlerSection.includes('requestHash: plan.requestHash'), 'hot-add display details should include request hash only');

const ledgerSection = sectionBetween(commands, 'function zteamHotAddLedgerEntry', 'function applyZteamHotAddPlan', 'hot-add ledger');
assert(!ledgerSection.includes('requestText'), 'hot-add ledger must not persist raw request text');
assert(!ledgerSection.includes('promptBody'), 'hot-add ledger must not persist generated prompt body');
assert(!ledgerSection.includes('tmuxWindowCommand,'), 'hot-add ledger must not persist raw tmux command');
includes(ledgerSection, 'requestHash: plan.requestHash', 'hot-add ledger');
includes(ledgerSection, 'bodyStored: false', 'hot-add ledger');
includes(ledgerSection, 'promptBodiesStored: false', 'hot-add ledger');
includes(ledgerSection, 'outputBodiesStored: false', 'hot-add ledger');

const formatSection = sectionBetween(commands, 'function formatZteamHotAddPlan', 'function zteamHotAddLedgerEntry', 'hot-add format');
includes(formatSection, 'spawn-count=${plan.spawnCount}', 'hot-add dry-run plan');
includes(formatSection, 'tmux-window plan command (manual only)', 'hot-add tmux window plan');
includes(formatSection, 'raw natural-language ask is not stored in durable ledgers', 'hot-add raw-body warning');

assert(pkg.scripts?.['smoke:zteam-hot-add'] === 'node scripts/zteam-hot-add/smoke.mjs', 'package.json must expose focused hot-add smoke');
includes(skill, '/zteam hot-add <team-id> <natural-language ask>', 'zagent skill');
includes(skill, 'current-context inference may use `ZOB_ZTEAM_ID`, active ZAgent team, ZPeer team/active room, or repo convention fallback', 'zagent skill current-context docs');
assert(zteamEntry?.noShipNotes?.includes('Hot-add supports explicit team ids or current-context inference'), 'capability registry must document hot-add current-context behavior');
assert(zteamEntry?.noShipNotes?.includes('raw natural-language ask is hashed only'), 'capability registry must document hash-only hot-add ask handling');

if (failures.length > 0) {
  console.error(`zteam hot-add smoke FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('zteam hot-add smoke PASS');
