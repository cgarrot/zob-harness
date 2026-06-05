#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { detectColgrep, fallbackSearch, loadConfig, parseArgs, printHumanSearch, printJson } from "./shared.mjs";

const args = parseArgs(process.argv.slice(2));
const query = args.query ?? args.q ?? args._.join(" ");
if (!query) {
  console.error("usage: npm run zob:context:query -- --query <text> [--max-results 20] [--max-context-lines 2] [--json]");
  process.exit(2);
}

const config = loadConfig();
const maxResults = Math.max(1, Math.min(Number(args["max-results"] ?? config.limits.maxResults ?? 20), 100));
const maxContextLines = Math.max(0, Math.min(Number(args["max-context-lines"] ?? config.limits.maxContextLines ?? 2), 5));
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
  });

  if (colgrepResult.status === 0) {
    result = {
      provider: "colgrep",
      fallback: false,
      query,
      resultCount: undefined,
      raw: colgrepResult.stdout.trim(),
      stderr: colgrepResult.stderr.trim(),
      recommendedVerification: ["Use grep/read on returned repo-relative refs for exact proof."],
    };
  } else {
    result = runFallback("colgrep-query-failed");
    result.colgrepQueryStatus = colgrepResult.status;
    result.colgrepQueryStderr = colgrepResult.stderr.trim();
    result.colgrepArgs = colgrepArgs;
  }
} else {
  result = runFallback(colgrep.installed ? "colgrep-not-ready" : "colgrep-missing");
}

if (args.json) {
  printJson(result);
} else if (result.provider === "colgrep") {
  console.log("provider: colgrep");
  console.log(result.raw);
} else {
  printHumanSearch(result);
}
