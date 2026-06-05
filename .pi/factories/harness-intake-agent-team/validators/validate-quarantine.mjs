#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const run = process.argv[2];
if (!run) {
  console.error("Usage: node .pi/factories/harness-intake-agent-team/validators/validate-quarantine.mjs <run_dir>");
  process.exit(2);
}
const errors = [];
for (const file of ["validation.json", "team-candidates.json", "factory-candidates.json"]) {
  if (!existsSync(join(run, file))) errors.push(`missing ${file}`);
}
if (!existsSync(join(run, "generated-proposals"))) errors.push("missing generated-proposals directory");
const validation = existsSync(join(run, "validation.json")) ? JSON.parse(readFileSync(join(run, "validation.json"), "utf8")) : null;
if (validation?.activation_performed !== false) errors.push("activation_performed must be false");
if (validation?.quarantine_only !== true) errors.push("quarantine_only must be true");
const result = { schema: "zob.harness-intake.quarantine-validation.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exit(1);
