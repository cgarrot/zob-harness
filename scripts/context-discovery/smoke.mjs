#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const env = { ...process.env, ZOB_CONTEXT_FORCE_FALLBACK: "1" };
const result = spawnSync(process.execPath, ["scripts/context-discovery/query.mjs", "--query", "ZOB Harness", "--json", "--max-results", "5"], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status !== 0) {
  console.error("context-discovery smoke FAIL: query exited non-zero");
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch (error) {
  console.error("context-discovery smoke FAIL: query did not emit JSON");
  console.error(result.stdout);
  process.exit(1);
}

const hasAllowedRef = Array.isArray(parsed.results) && parsed.results.some((entry) => typeof entry.path === "string" && !entry.path.includes(".pi/sessions") && !entry.path.includes(".pi/agent-sessions") && !entry.path.includes("node_modules"));
if (parsed.provider !== "grep-fallback" || parsed.fallback !== true || parsed.reason !== "colgrep-missing" || !hasAllowedRef) {
  console.error("context-discovery smoke FAIL: fallback result did not match expectations");
  console.error(JSON.stringify({ provider: parsed.provider, fallback: parsed.fallback, reason: parsed.reason, results: parsed.results }, null, 2));
  process.exit(1);
}

const constantsSource = readFileSync(".pi/extensions/zob-harness/src/core/constants.ts", "utf8");
const runtimeSource = readFileSync(".pi/extensions/zob-harness/src/domains/context/context-discovery.ts", "utf8");
const querySource = readFileSync("scripts/context-discovery/query.mjs", "utf8");
const sharedSource = readFileSync("scripts/context-discovery/shared.mjs", "utf8");
const requiredPromptFragments = [
  "For exploratory, natural-language",
  "start with zob_context_search/ColGREP before grep/find",
  "npm run --silent zob:context:query -- --query",
  "Do not conclude the native tool is unavailable and immediately use broad rg/grep",
  "Run one exploratory context search, then read the returned refs",
  "Use grep/read after semantic discovery",
  "Never run broad grep/find over .pi unless .pi/sessions and .pi/agent-sessions are explicitly excluded/pruned",
  "unit?.file",
  "normalizeBackendPath(repoRoot, rawPath)",
];
const requiredWrapperFragments = [
  "normalizeColgrepResults",
  "printHumanSearch(result)",
];
const requiredAsyncRuntimeFragments = [
  "async function runColgrep",
  "spawn(\"colgrep\"",
  "export async function runContextSearch",
  "await runColgrep",
  "COLGREP_TIMEOUT_MS = 30_000",
];
const forbiddenWrapperFragments = [
  "console.log(result.raw)",
  "raw: colgrepResult.stdout",
];
const missingWrapperFragments = requiredWrapperFragments.filter((fragment) => !querySource.includes(fragment) && !sharedSource.includes(fragment));
const missingAsyncRuntimeFragments = requiredAsyncRuntimeFragments.filter((fragment) => !runtimeSource.includes(fragment));
const presentForbiddenWrapperFragments = forbiddenWrapperFragments.filter((fragment) => querySource.includes(fragment));
const contextReadToolsLine = constantsSource.match(/ZOB_CONTEXT_READ_TOOLS = \[(?<tools>[^\]]+)\]/u)?.groups?.tools ?? "";
if (!contextReadToolsLine.includes('"zob_context_search"')) {
  console.error("context-discovery smoke FAIL: zob_context_search missing from ZOB_CONTEXT_READ_TOOLS native mode allowlist");
  process.exit(1);
}

const missingPromptFragments = requiredPromptFragments.filter((fragment) => !runtimeSource.includes(fragment));
if (missingPromptFragments.length > 0) {
  console.error("context-discovery smoke FAIL: runtime prompt hardening fragments missing");
  console.error(JSON.stringify({ missingPromptFragments }, null, 2));
  process.exit(1);
}
if (missingWrapperFragments.length > 0 || presentForbiddenWrapperFragments.length > 0) {
  console.error("context-discovery smoke FAIL: ColGREP wrapper compact-output contract broken");
  console.error(JSON.stringify({ missingWrapperFragments, presentForbiddenWrapperFragments }, null, 2));
  process.exit(1);
}
if (missingAsyncRuntimeFragments.length > 0) {
  console.error("context-discovery smoke FAIL: native ColGREP execution must stay async/non-blocking");
  console.error(JSON.stringify({ missingAsyncRuntimeFragments }, null, 2));
  process.exit(1);
}

console.log("context-discovery smoke PASS");
console.log(`provider=${parsed.provider} reason=${parsed.reason} results=${parsed.resultCount}`);
console.log(`evidence=${parsed.results.find((entry) => typeof entry.path === "string")?.ref}`);
