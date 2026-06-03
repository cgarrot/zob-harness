#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const run = process.argv[2];
const runDir = (run || "").startsWith("reports/") ? run : `reports/agentic-spec-runs/${run || ""}`;
const file = join(runDir, "run-manifest.json");
const errors = [];
if (!existsSync(file)) errors.push(`missing ${file}`);
let manifest = null;
if (!errors.length) manifest = JSON.parse(readFileSync(file, "utf8"));
if (manifest && manifest.schema !== "agentic-spec-run.manifest.v1") errors.push("schema mismatch");
if (manifest && (!manifest.mission || !manifest.source_count)) errors.push("mission and source_count are required");
console.log(JSON.stringify({ schema: "agentic-spec.validate-manifest-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
