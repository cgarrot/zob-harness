#!/usr/bin/env node
import { spawnSync } from "node:child_process";

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

console.log("context-discovery smoke PASS");
console.log(`provider=${parsed.provider} reason=${parsed.reason} results=${parsed.resultCount}`);
console.log(`evidence=${parsed.results.find((entry) => typeof entry.path === "string")?.ref}`);
