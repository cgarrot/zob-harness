#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const run = process.argv[2];
if (!run) {
  console.error("Usage: node .pi/factories/harness-intake-agent-team/validators/validate-no-secrets.mjs <run_dir>");
  process.exit(2);
}
const riskPath = join(run, "source-risk-report.json");
if (!existsSync(riskPath)) {
  console.error(JSON.stringify({ schema: "zob.harness-intake.no-secrets-validation.v1", status: "fail", no_ship: true, errors: ["missing source-risk-report.json"] }, null, 2));
  process.exit(1);
}
const risk = JSON.parse(readFileSync(riskPath, "utf8"));
const errors = [];
if (risk.no_ship === true || (risk.risks ?? []).length > 0) errors.push("secret-like source risk requires review");
const result = { schema: "zob.harness-intake.no-secrets-validation.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exit(1);
