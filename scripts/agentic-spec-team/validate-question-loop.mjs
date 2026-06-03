#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const run = process.argv[2];
const runDir = (run || "").startsWith("reports/") ? run : `reports/agentic-spec-runs/${run || ""}`;
const file = join(runDir, "questions.jsonl");
const errors = [];
const rows = existsSync(file) ? readFileSync(file, "utf8").split(/\n/u).filter(Boolean).map((line) => JSON.parse(line)) : [];
for (const q of rows) {
  if (!q.question_id || q.schema !== "agentic-spec.question.v1") errors.push(`invalid question: ${JSON.stringify(q)}`);
}
const openBlocking = rows.filter((q) => q.blocking === true && !["answered", "closed", "withdrawn"].includes(q.status));
if (openBlocking.length) errors.push(`open blocking questions: ${openBlocking.map((q) => q.question_id).join(", ")}`);
console.log(JSON.stringify({ schema: "agentic-spec.validate-question-loop-result.v1", status: errors.length ? "fail" : "pass", no_ship: errors.length > 0, open_blocking_questions: openBlocking.map((q) => q.question_id), errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
