#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { detectColgrep, fallbackSearch, loadConfig, normalizeColgrepResults, parseArgs, printHumanSearch, printJson } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const query = args.query ?? args.q ?? args._.join(" ");
if (!query) {
  console.error("usage: npm run zob:context:query -- --query <text> [--max-results 20] [--max-context-lines 2] [--json]");
  process.exit(2);
}

const config = loadConfig();
const maxResults = Math.max(1, Math.min(Number(args["max-results"] ?? config.limits.maxResults ?? 20), 100));
const maxContextLines = Math.max(0, Math.min(Number(args["max-context-lines"] ?? config.limits.maxContextLines ?? 2), 5));
const rawColgrepTimeoutMs = Number(process.env.ZOB_CONTEXT_COLGREP_TIMEOUT_MS ?? config.limits.colgrepTimeoutMs ?? 8_000);
const colgrepTimeoutMs = Number.isFinite(rawColgrepTimeoutMs) ? Math.max(500, Math.min(rawColgrepTimeoutMs, 30_000)) : 8_000;
const colgrep = detectColgrep();

function runFallback(reason) {
  return {
    ...fallbackSearch({ query, config, maxResults, maxContextLines }),
    reason,
    colgrep,
  };
}

let result;
if (colgrep.ready) {
  const colgrepArgs = ["--json", "-k", String(maxResults), "-n", String(maxContextLines), String(query), ...config.includePaths];
  const colgrepResult = spawnSync("colgrep", colgrepArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: colgrepTimeoutMs,
    killSignal: "SIGTERM",
  });

  if (colgrepResult.status === 0) {
    result = normalizeColgrepResults(colgrepResult.stdout, { query, config, maxResults, maxContextLines });
    result.stderr = colgrepResult.stderr.trim().slice(0, 240);
    result.colgrepArgs = colgrepArgs;
  } else {
    const timedOut = colgrepResult.error?.code === "ETIMEDOUT" || colgrepResult.signal === "SIGTERM";
    result = runFallback(timedOut ? "colgrep-timeout-fallback" : "colgrep-query-failed");
    result.colgrepQueryStatus = colgrepResult.status;
    result.colgrepQuerySignal = colgrepResult.signal;
    result.colgrepQueryStderr = colgrepResult.stderr.trim().slice(0, 240);
    result.colgrepTimeoutMs = colgrepTimeoutMs;
    result.colgrepArgs = colgrepArgs;
  }
} else {
  result = runFallback(colgrep.installed ? "colgrep-not-ready" : "colgrep-missing");
}

if (args.json) {
  printJson(result);
} else {
  printHumanSearch(result);
}
