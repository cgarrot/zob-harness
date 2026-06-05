#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = process.cwd();
const srcRoot = join(repoRoot, ".pi", "extensions", "zob-harness", "src");
const outRoot = join(tmpdir(), `zob-intent-classifier-smoke-${process.pid}-${Date.now()}`);

function listTsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listTsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

for (const file of listTsFiles(srcRoot)) {
  const rel = relative(srcRoot, file).replace(/\.ts$/, ".js");
  const out = join(outRoot, rel);
  mkdirSync(dirname(out), { recursive: true });
  const transpiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      skipLibCheck: true,
      sourceMap: false,
    },
    fileName: file,
  });
  const outputText = transpiled.outputText
    .replace(
      /import \{ getAgentDir \} from "@earendil-works\/pi-coding-agent";/g,
      "const getAgentDir = () => process.cwd();",
    )
    .replace(
      /import \{ completeSimple \} from "@earendil-works\/pi-ai";/g,
      "const completeSimple = async () => { throw new Error('stubbed pi-ai completeSimple unavailable in smoke'); };",
    );
  writeFileSync(out, outputText);
}

const classifier = await import(pathToFileURL(join(outRoot, "domains", "intent", "intent-classifier.js")).href);

const implement = classifier.classifyIntentRegex("Please fix this bug in the runtime");
assert.equal(implement.intent, "implement");
assert.equal(implement.provider, "regex");
assert.equal(implement.rawInputStored, false);
assert.equal(implement.safetyApproved, false);
assert.match(implement.inputHash, /^[a-f0-9]{64}$/);

const factory = classifier.classifyIntentRegex("Create a software factory manifest and smoke sentinel for this workflow");
assert.equal(factory.intent, "factory");

const orchestrator = classifier.classifyIntentRegex("Launch multiple workers and an oracle for this work graph");
assert.equal(orchestrator.intent, "orchestrator");

const vanilla = classifier.classifyIntentRegex("Use vanilla Pi base mode and run an external command");
assert.equal(vanilla.intent, "vanilla");
assert.equal(vanilla.autoSwitch, true);

const explore = classifier.classifyIntentRegex("Inspect the runtime and understand what changed");
assert.equal(explore.intent, "explore");
assert.equal(explore.autoSwitch, true);

const plan = classifier.classifyIntentRegex("Design a plan for this feature without editing files yet");
assert.equal(plan.intent, "plan");
assert.equal(plan.autoSwitch, true);

const oracle = classifier.classifyIntentRegex("Review and validate this implementation for blockers");
assert.equal(oracle.intent, "oracle");
assert.equal(oracle.autoSwitch, true);

const fixtureRoot = join(outRoot, "fixture");
mkdirSync(join(fixtureRoot, ".pi", "routing"), { recursive: true });
writeFileSync(join(fixtureRoot, ".pi", "routing", "intent-classifier.json"), `${JSON.stringify({
  schema: "zob.intent-classifier.config.v1",
  enabled: true,
  provider: "http-json",
  model: "test-intent-model",
  minConfidence: 0.72,
  timeoutMs: 1000,
  fallback: "regex",
  sendUserTextToProvider: false,
  providers: { "http-json": { endpoint: "", apiKeyEnv: "", requestFormat: "openai-chat" }, "pi-provider": { enabled: false } },
  allowedIntents: ["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla", "unknown"],
}, null, 2)}\n`, "utf8");
const fallback = await classifier.classifyIntent("Patch this file", fixtureRoot);
assert.equal(fallback.provider, "fallback");
assert.equal(fallback.configuredProvider, "http-json");
assert.equal(fallback.intent, "implement");
assert.equal(fallback.rawInputStored, false);
assert.equal(fallback.safetyApproved, false);
assert.equal(fallback.fallbackReason, "sendUserTextToProvider=false");

writeFileSync(join(fixtureRoot, ".pi", "routing", "intent-classifier.json"), `${JSON.stringify({
  schema: "zob.intent-classifier.config.v1",
  enabled: true,
  provider: "http-json",
  model: "test-intent-model",
  minConfidence: 0.72,
  timeoutMs: 1000,
  fallback: "unknown",
  sendUserTextToProvider: false,
  providers: { "http-json": { endpoint: "", apiKeyEnv: "", requestFormat: "openai-chat" }, "pi-provider": { enabled: false } },
  allowedIntents: ["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla", "unknown"],
}, null, 2)}\n`, "utf8");
const unknownFallback = await classifier.classifyIntent("Patch this file", fixtureRoot);
assert.equal(unknownFallback.provider, "fallback");
assert.equal(unknownFallback.intent, "unknown");
assert.equal(unknownFallback.needsClarification, true);

writeFileSync(join(fixtureRoot, ".pi", "routing", "intent-classifier.json"), `${JSON.stringify({
  schema: "zob.intent-classifier.config.v1",
  enabled: true,
  provider: "pi-provider",
  model: "provider/test-model",
  minConfidence: 0.72,
  timeoutMs: 1000,
  fallback: "unknown",
  sendUserTextToProvider: true,
  providers: { "http-json": { endpoint: "", apiKeyEnv: "", requestFormat: "openai-chat" }, "pi-provider": { enabled: true } },
  allowedIntents: ["explore", "plan", "implement", "oracle", "factory", "orchestrator", "vanilla", "unknown"],
}, null, 2)}\n`, "utf8");
const piProviderUnavailable = await classifier.classifyIntent("Patch this file", fixtureRoot);
assert.equal(piProviderUnavailable.provider, "fallback");
assert.equal(piProviderUnavailable.configuredProvider, "pi-provider");
assert.equal(piProviderUnavailable.intent, "unknown");
assert.match(piProviderUnavailable.fallbackReason, /model registry is unavailable/);

console.log("intent-classifier smoke PASS");
