#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const run = process.argv[2];
const runDir = (run || "").startsWith(".pi/reports/") || (run || "").startsWith("reports/") ? run : `.pi/reports/agentic-spec-runs/${run || ""}`;
const file = join(runDir, "validation/traceability-matrix.json");
const errors = [];
if (!existsSync(file)) errors.push(`missing ${file}`);
let value = null;
if (!errors.length) value = JSON.parse(readFileSync(file, "utf8"));
if (value && value.schema !== "agentic-spec.traceability.v1") errors.push("schema mismatch");
if (value && !Array.isArray(value.rows)) errors.push("rows must be an array");
for (const row of value?.rows || []) {
  if (!row.requirement_id || !row.support_ref) errors.push(`row missing requirement/support: ${JSON.stringify(row)}`);
  if (!Array.isArray(row.acceptance_criteria_refs) || row.acceptance_criteria_refs.length < 1) errors.push(`row missing acceptance criteria: ${row.requirement_id}`);
  if (!Array.isArray(row.task_refs) || row.task_refs.length < 1) errors.push(`row missing task refs: ${row.requirement_id}`);
  if (!row.oracle_check_ref) errors.push(`row missing oracle check: ${row.requirement_id}`);
}
console.log(JSON.stringify({ schema: "agentic-spec.validate-traceability-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
