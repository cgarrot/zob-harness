#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const run = process.argv[2];
const checks = ["validate-run.mjs", "validate-question-loop.mjs", "validate-traceability.mjs"];
const results = checks.map((script) => {
  const res = spawnSync(process.execPath, [`scripts/agentic-spec-team/${script}`, run], { encoding: "utf8", cwd: process.cwd() });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch {}
  return { script, status: res.status, parsed };
});
const errors = results.filter((r) => r.status !== 0).map((r) => `${r.script} failed`);
console.log(JSON.stringify({ schema: "agentic-spec.validate-oracle-ready-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, errors, results }, null, 2));
process.exitCode = errors.length ? 1 : 0;
