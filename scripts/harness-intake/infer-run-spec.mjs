#!/usr/bin/env node
import { inferRunSpecFromRequest, parseArgs, printJson, repoRel, resolveRunDir, writeJson } from "./lib.mjs";
import { join } from "node:path";

function help() {
  return {
    schema: "zob.harness-intake.infer-run-spec.help.v1",
    usage: [
      "node scripts/harness-intake/infer-run-spec.mjs \"Analyze ../repo-x as a Claude Code setup\"",
      "node scripts/harness-intake/infer-run-spec.mjs --target ../repo-x --run-id my-run --write \"Propose a team\"",
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
  const request = opts._.join(" ");
  const spec = inferRunSpecFromRequest(request, opts);
  if (opts.write) {
    const runDir = resolveRunDir(spec.run_id);
    writeJson(join(runDir, "inferred-run-spec.json"), spec);
    printJson({ schema: "zob.harness-intake.infer-run-spec.result.v1", status: "pass", no_ship: false, run_id: spec.run_id, run_dir: repoRel(runDir), spec_ref: `${repoRel(runDir)}/inferred-run-spec.json` });
  } else {
    printJson(spec);
  }
} catch (error) {
  printJson({ schema: "zob.harness-intake.infer-run-spec.error.v1", status: "error", no_ship: true, message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
