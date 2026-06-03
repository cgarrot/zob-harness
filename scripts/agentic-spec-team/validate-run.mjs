#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const target = process.argv[2];
if (!target || process.argv.includes("--help")) {
  console.log(JSON.stringify({ schema: "agentic-spec.validate-run-help.v1", usage: "node scripts/agentic-spec-team/validate-run.mjs <run_id|run_dir>" }, null, 2));
  process.exit(target ? 0 : 1);
}
const result = spawnSync(process.execPath, ["scripts/spec-run.mjs", "validate", target], { encoding: "utf8", cwd: process.cwd() });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exitCode = result.status ?? 1;
