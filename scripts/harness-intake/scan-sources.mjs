#!/usr/bin/env node
import { inferRunSpecFromRequest, parseArgs, printJson, repoRel, resolveRunDir, scanSources, writeSourceArtifacts, readJson } from "./lib.mjs";
import { join } from "node:path";

function help() {
  return {
    schema: "zob.harness-intake.scan-sources.help.v1",
    usage: [
      "node scripts/harness-intake/scan-sources.mjs --target ../repo-x --run-id my-run",
      "node scripts/harness-intake/scan-sources.mjs --spec reports/factory-runs/my-run/inferred-run-spec.json",
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
  const spec = opts.spec ? readJson(opts.spec) : inferRunSpecFromRequest(opts._.join(" "), opts);
  const runDir = resolveRunDir(spec.run_id);
  const sourceIndex = scanSources(spec);
  writeSourceArtifacts(runDir, sourceIndex);
  printJson({ schema: "zob.harness-intake.scan-sources.result.v1", status: "pass", no_ship: false, run_id: spec.run_id, run_dir: repoRel(runDir), source_count: sourceIndex.source_count, sources_ref: `${repoRel(runDir)}/sources-index.json` });
} catch (error) {
  printJson({ schema: "zob.harness-intake.scan-sources.error.v1", status: "error", no_ship: true, message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
