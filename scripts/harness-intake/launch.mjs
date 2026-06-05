#!/usr/bin/env node
import { inferRunSpecFromRequest, parseArgs, printJson, runFullAnalysis } from "./lib.mjs";

function help() {
  return {
    schema: "zob.harness-intake.help.v1",
    usage: [
      "node scripts/harness-intake/launch.mjs \"Analyse ../repo-x comme setup Claude Code\"",
      "node scripts/harness-intake/launch.mjs --target ../repo-x --harness claude-code --allow-sessions \"Lis les sessions et propose une team\"",
      "node scripts/harness-intake/launch.mjs --demo --mode smoke",
      "node scripts/harness-intake/launch.mjs --prepare-only --target ../repo-x \"Prépare une run tmux\"",
    ],
    output: "json",
    no_ship: false,
  };
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printJson(help());
    process.exit(0);
  }
  const request = opts._.join(" ");
  const spec = inferRunSpecFromRequest(request, opts);
  const result = runFullAnalysis(spec, { prepareOnly: Boolean(opts.prepareOnly) });
  printJson(result);
  if (result.no_ship) process.exitCode = 1;
} catch (error) {
  printJson({ schema: "zob.harness-intake.error.v1", status: "error", no_ship: true, message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
