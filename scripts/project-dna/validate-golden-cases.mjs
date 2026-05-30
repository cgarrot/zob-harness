#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const repoRoot = process.cwd();

function usage() {
  console.error("Usage: node scripts/project-dna/validate-golden-cases.mjs --golden-cases <repo-relative-json>");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--golden-cases") out.goldenCases = argv[++i];
    else if (arg === "--scan-dir") out.goldenCases = `${argv[++i].replace(/\/$/, "")}/golden-cases-smoke.json`;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function resolveRepoPath(input, label) {
  if (!input || isAbsolute(input)) throw new Error(`${label} must be repo-relative`);
  const resolved = resolve(repoRoot, input);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || rel === "") throw new Error(`${label} must stay inside repo and not be repo root`);
  if (!existsSync(resolved)) throw new Error(`${label} not found: ${input}`);
  return resolved;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.goldenCases) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const suitePath = resolveRepoPath(args.goldenCases, "--golden-cases");
  const suite = JSON.parse(readFileSync(suitePath, "utf8"));
  const errors = [];
  if (suite.schema !== "zob.project-dna-golden-suite.v1") errors.push("golden suite schema mismatch");
  if (suite.raw_queries_persisted !== false) errors.push("raw_queries_persisted must be false");
  if (suite.knowledge_backend_write_enabled !== false) errors.push("knowledge_backend_write_enabled must be false");
  if (suite.promotion_policy !== "proposal_only") errors.push("promotion_policy must be proposal_only");
  if (!Array.isArray(suite.cases) || suite.cases.length < 5) errors.push("at least five golden cases required for 5/5 smoke");
  const ids = new Set();
  for (const testCase of suite.cases ?? []) {
    if (typeof testCase.id !== "string" || !/^[a-z0-9._-]+$/.test(testCase.id)) errors.push(`invalid case id: ${testCase.id}`);
    if (ids.has(testCase.id)) errors.push(`duplicate case id: ${testCase.id}`);
    ids.add(testCase.id);
    if (typeof testCase.intent_id !== "string" || !testCase.intent_id) errors.push(`${testCase.id} intent_id required`);
    if (typeof testCase.query !== "string" || testCase.query.length < 1) errors.push(`${testCase.id} transient query required`);
    if (!Array.isArray(testCase.required_citation_includes) || testCase.required_citation_includes.length < 1) errors.push(`${testCase.id} required_citation_includes required`);
    if (!Array.isArray(testCase.required_files_to_read_first) || testCase.required_files_to_read_first.length < 1) errors.push(`${testCase.id} required_files_to_read_first required`);
    if (!Array.isArray(testCase.required_safety) || !testCase.required_safety.includes("bounded_context_only") || !testCase.required_safety.includes("citation_required")) errors.push(`${testCase.id} required_safety must include bounded_context_only and citation_required`);
    if (Number(testCase.score_threshold) < 5) errors.push(`${testCase.id} score_threshold must be 5 for 5/5 smoke`);
  }
  const result = {
    schema: "zob.project-dna-golden-suite-validation.v1",
    valid: errors.length === 0,
    golden_cases: relative(repoRoot, suitePath),
    case_count: Array.isArray(suite.cases) ? suite.cases.length : 0,
    errors,
    source_project_modified: false,
    knowledge_backend_write_enabled: false,
    durable_promotion_allowed: false,
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-golden-suite-validation-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
