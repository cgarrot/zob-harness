#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const run = process.argv[2];
const runDir = (run || "").startsWith("reports/") ? run : `reports/agentic-spec-runs/${run || ""}`;
const file = join(runDir, "final-report.json");
const errors = [];
if (!existsSync(file)) errors.push(`missing ${file}`);
let value = null;
if (!errors.length) value = JSON.parse(readFileSync(file, "utf8"));
if (value && value.schema !== "agentic-spec.final-report.v1") errors.push("schema mismatch");
if (value && !(value.status === "pass" && value.verdict === "PASS" && value.no_ship === false)) errors.push("final report must be status=pass verdict=PASS no_ship=false");
console.log(JSON.stringify({ schema: "agentic-spec.validate-final-report-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
