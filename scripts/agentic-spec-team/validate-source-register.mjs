#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const run = process.argv[2];
const runDir = (run || "").startsWith("reports/") ? run : `reports/agentic-spec-runs/${run || ""}`;
const file = join(runDir, "source-register.json");
const errors = [];
if (!existsSync(file)) errors.push(`missing ${file}`);
let value = null;
if (!errors.length) value = JSON.parse(readFileSync(file, "utf8"));
if (value && value.schema !== "agentic-spec.source-register.v1") errors.push("schema mismatch");
if (value && (!Array.isArray(value.sources) || value.sources.length < 1)) errors.push("sources must be non-empty");
for (const source of value?.sources || []) {
  if (!source.source_id || !source.path || !source.policy) errors.push(`invalid source row: ${JSON.stringify(source)}`);
}
console.log(JSON.stringify({ schema: "agentic-spec.validate-source-register-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
