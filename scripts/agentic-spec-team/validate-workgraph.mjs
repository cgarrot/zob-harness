#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const run = process.argv[2];
const runDir = (run || "").startsWith("reports/") ? run : `reports/agentic-spec-runs/${run || ""}`;
const workgraph = join(runDir, "handoff/workgraph.md");
const tasks = join(runDir, "handoff/implementation-tasks.md");
const errors = [];
if (!existsSync(workgraph)) errors.push(`missing ${workgraph}`);
if (!existsSync(tasks)) errors.push(`missing ${tasks}`);
if (existsSync(tasks) && !/REQ-|AC-|TASK-/u.test(readFileSync(tasks, "utf8"))) errors.push("tasks should cite requirement/acceptance/task ids");
console.log(JSON.stringify({ schema: "agentic-spec.validate-workgraph-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
