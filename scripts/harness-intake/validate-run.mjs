#!/usr/bin/env node
import { parseArgs, printJson, validateRun } from "./lib.mjs";

function help() {
  return {
    schema: "zob.harness-intake.validate-run.help.v1",
    usage: [
      "node scripts/harness-intake/validate-run.mjs <run_id|reports/factory-runs/run-id>",
    ],
    no_ship: false,
  };
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printJson(help());
    process.exit(0);
  }
  const run = opts._[0] || opts.runId || opts.runDir;
  if (!run) throw new Error("missing run id or run dir");
  const result = validateRun(run);
  printJson(result);
  if (result.no_ship) process.exitCode = 1;
} catch (error) {
  printJson({ schema: "zob.harness-intake.validate-run.error.v1", status: "error", no_ship: true, message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
