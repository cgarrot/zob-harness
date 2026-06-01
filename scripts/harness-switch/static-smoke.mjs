#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

function readJson(path) {
  return JSON.parse(read(path));
}

const switchSource = read(".pi/extensions/zob-switch/index.ts");
const settings = readJson(".pi/settings.json");
const pkg = readJson("package.json");
const registry = readJson(".pi/capabilities/zob-public-runtime-capabilities.json");
assert.match(switchSource, /registerCommand\("zob"/, "zob-switch must register /zob");
assert.doesNotMatch(switchSource, /registerCommand\("(?:harness|zob-harness|zub)"/, "zob-switch must not register aliases");
assert.doesNotMatch(switchSource, /registerTool\(/, "zob-switch must not register LLM-callable tools");
assert.doesNotMatch(switchSource, /setWidget\(|setStatus\(|before_agent_start|systemPrompt|resources_discover/, "zob-switch must not inject prompt/widget/resource hooks");
assert.match(switchSource, /ctx\.reload\(\)/, "zob on/off must reload resources");
assert.match(switchSource, /settings-snapshot\.json/, "zob off must use a persistent settings snapshot");
assert.match(switchSource, /join\("\.pi", "tmp", "zob-switch", "settings-snapshot\.json"\)/, "zob off snapshot must be stored under ignored .pi/tmp runtime state");
assert.doesNotMatch(switchSource, /join\("\.pi", "extensions", "zob-switch", "settings-snapshot\.json"\)/, "zob off snapshot must not be generated in the source extension directory");
assert.match(switchSource, /function shouldWriteOffSnapshot\([^)]*Snapshot \| null[^)]*\)/, "zob off snapshot freshness must be centralized/readable");
assert.match(switchSource, /return snapshot === null \|\| hasValue\(current, "extensions", HARNESS_EXTENSION\)/, "zob off must only refresh snapshot when missing or current settings still include harness");
assert.match(switchSource, /const snapshot = await readSnapshot\(ctx\.cwd\);\s*if \(shouldWriteOffSnapshot\(current, snapshot\)\) \{\s*await writeSnapshot\(ctx\.cwd, current\);\s*\}/s, "zob off must inspect existing snapshot/current harness state before writeSnapshot");
assert.doesNotMatch(switchSource, /if \(action === "off"\) \{\s*const current = await readSettings\(ctx\.cwd\);\s*await writeSnapshot\(ctx\.cwd, current\);/s, "zob off must not blindly writeSnapshot on every invocation");

assert.deepEqual(settings.extensions.slice(0, 2), ["extensions/zob-switch/index.ts", "extensions/zob-harness/index.ts"], ".pi/settings.json must load switch before harness while on");
assert(settings.prompts.includes("prompts"), ".pi/settings.json must include ZOB prompts while on");
assert(settings.skills.includes("skills"), ".pi/settings.json must include ZOB skills while on");

assert.deepEqual(pkg.pi.extensions.slice(0, 2), [".pi/extensions/zob-switch/index.ts", ".pi/extensions/zob-harness/index.ts"], "package pi.extensions must list switch before harness");
assert.equal(pkg.scripts["smoke:harness-switch"], "node scripts/harness-switch/static-smoke.mjs", "package must expose smoke:harness-switch");

const zobCommands = registry.commands.filter((entry) => entry.name === "zob");
assert.equal(zobCommands.length, 1, "registry must have exactly one /zob entry");
assert.equal(zobCommands[0].family, "harness-switch", "registry /zob family must be harness-switch");
assert.match(zobCommands[0].noShipNotes, /No aliases\./, "registry must explicitly say no aliases");
assert(zobCommands[0].docRefs.includes("docs/HARNESS_CAPABILITY_MATRIX.md"), "registry must keep the capability matrix doc ref for local docs");

console.log("harness-switch static smoke: ok");
