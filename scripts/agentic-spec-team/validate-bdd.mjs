#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const run = process.argv[2];
const runDir = (run || "").startsWith(".pi/reports/") || (run || "").startsWith("reports/") ? run : `.pi/reports/agentic-spec-runs/${run || ""}`;
const criteria = join(runDir, "validation/acceptance-criteria.md");
const bdd = join(runDir, "validation/bdd-scenarios.feature.md");
const errors = [];
if (!existsSync(criteria)) errors.push(`missing ${criteria}`);
if (!existsSync(bdd)) errors.push(`missing ${bdd}`);
if (existsSync(bdd) && !/Given|When|Then/u.test(readFileSync(bdd, "utf8"))) errors.push("BDD scenarios should include Given/When/Then");
console.log(JSON.stringify({ schema: "agentic-spec.validate-bdd-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
