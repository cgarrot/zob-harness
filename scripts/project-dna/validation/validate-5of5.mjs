#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();

function usage() {
  console.error(`Usage:
  node scripts/project-dna/validate-5of5.mjs --scan-dir <repo-relative-scan-dir>

Validates the ProjectDNA 5/5 agentic smoke posture: ontology, golden cases, query steward, benchmark, oracle, sample quarantine, and safety gates.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan-dir") out.scanDir = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function resolveRepoDir(input) {
  if (!input || isAbsolute(input)) throw new Error("--scan-dir must be repo-relative");
  const resolved = resolve(repoRoot, input);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || rel === "") throw new Error("--scan-dir must stay inside repo and not be repo root");
  if (!existsSync(resolved)) throw new Error(`--scan-dir not found: ${input}`);
  return resolved;
}

function readJson(path, errors, label) {
  if (!existsSync(path)) {
    errors.push(`missing ${label}: ${relative(repoRoot, path).split(sep).join("/")}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function runNode(args) {
  return execFileSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0] ?? "";
}

function broadCitation(citation) {
  const match = /:L(\d+)-L?(\d+)$/.exec(String(citation));
  return match ? Number(match[2]) - Number(match[1]) + 1 > 250 : false;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const scanDir = resolveRepoDir(args.scanDir);
  const scanDirRel = relative(repoRoot, scanDir).split(sep).join("/");
  const errors = [];
  const warnings = [];
  const commandResults = [];

  for (const command of [
    ["scripts/project-dna/validate-scan-artifacts.mjs", "--scan-dir", scanDirRel],
    ["scripts/project-dna/validate-ontology.mjs", "--scan-dir", scanDirRel],
    ["scripts/project-dna/validate-golden-cases.mjs", "--scan-dir", scanDirRel],
  ]) {
    try {
      commandResults.push({ command: `node ${command.join(" ")}`, output: runNode(command) });
    } catch (error) {
      errors.push(`validator failed: node ${command.join(" ")} :: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const sampleSummaryPath = join(scanDir, "quarantine", "sample-project", "project-dna-sample-summary.json");
  if (existsSync(sampleSummaryPath)) {
    try {
      commandResults.push({ command: `node scripts/project-dna/validate-sample-project.mjs --sample-dir ${scanDirRel}/quarantine/sample-project`, output: runNode(["scripts/project-dna/validate-sample-project.mjs", "--sample-dir", `${scanDirRel}/quarantine/sample-project`]) });
    } catch (error) {
      errors.push(`sample validator failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    errors.push("sample summary missing; 5/5 requires quarantine sample evidence");
  }

  const benchmark = readJson(join(scanDir, "bench", "benchmark-smoke.json"), errors, "benchmark-smoke.json");
  const oracle = readJson(join(scanDir, "oracle", "project-dna-smoke-oracle-review.json"), errors, "project-dna-smoke-oracle-review.json");
  const querySteward = readJson(join(scanDir, "query-steward-smoke.json"), errors, "query-steward-smoke.json");

  if (benchmark) {
    if (benchmark.schema !== "zob.project-dna-benchmark-smoke.v1") errors.push("benchmark schema mismatch");
    if (benchmark.status !== "passed") errors.push("benchmark status must be passed");
    if (benchmark.benchmark_kind !== "golden-agentic-5of5-smoke") errors.push("benchmark_kind must be golden-agentic-5of5-smoke");
    if (benchmark.metrics?.cases_total < 5) errors.push("benchmark must evaluate at least five golden cases");
    if (benchmark.metrics?.cases_passed !== benchmark.metrics?.cases_total) errors.push("all golden benchmark cases must pass");
    if (benchmark.gates?.source_project_modified !== false) errors.push("benchmark source_project_modified must be false");
    if (benchmark.gates?.knowledge_backend_write_enabled !== false) errors.push("benchmark knowledge_backend_write_enabled must be false");
    if (benchmark.gates?.promotion_allowed !== false) errors.push("benchmark promotion_allowed must be false");
  }

  if (oracle) {
    if (oracle.schema !== "zob.oracle-review.v1") errors.push("oracle schema mismatch");
    if (oracle.verdict !== "PASS") errors.push("oracle verdict must be PASS");
    if (oracle.no_ship !== false) errors.push("oracle no_ship must be false");
  }

  if (querySteward) {
    if (querySteward.schema !== "zob.project-dna-query-steward-report.v1") errors.push("query steward schema mismatch");
    if (querySteward.raw_query_persisted !== false) errors.push("query steward must not persist raw query");
    if (querySteward.controlled_expansion?.stored_raw_terms !== false) errors.push("query steward must not persist raw expansion terms");
    if (querySteward.loading_rules?.bounded_context_only !== true) errors.push("query steward bounded_context_only must be true");
    if (querySteward.safety?.knowledge_backend_write_enabled !== false) errors.push("query steward backend write must be false");
  }

  const benchmarkCases = benchmark?.cases ?? [];
  const allCitations = benchmarkCases.flatMap((testCase) => testCase.citations_checked ?? []);
  if (allCitations.length > 0) {
    const broad = allCitations.filter(broadCitation).length;
    const ratio = broad / allCitations.length;
    if (ratio > 0.75) warnings.push(`broad citation ratio high: ${ratio.toFixed(2)}; acceptable for smoke only, not production 5/5`);
  }

  const result = {
    schema: "zob.project-dna-5of5-validation.v1",
    valid: errors.length === 0,
    scan_dir: scanDirRel,
    errors,
    warnings,
    command_results: commandResults,
    gates: {
      agents_first: true,
      deterministic_scripts_as_tools: true,
      ontology_required: true,
      golden_cases_required: true,
      query_steward_required: true,
      oracle_required: true,
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
      durable_promotion_allowed: false,
      writeback_policy: "proposal_only",
    }
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-5of5-validation-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
