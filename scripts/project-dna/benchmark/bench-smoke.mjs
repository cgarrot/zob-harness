#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();

const LEGACY_CASES = [
  {
    id: "factory-schema-validation",
    query: "factory schema validation",
    required_citation_includes: ["factory.json", "schemas/"],
    required_files_to_read_first: ["factory.json"],
    expected_patterns: [],
    required_safety: ["bounded_context_only", "citation_required", "no_knowledge_backend_write"],
    score_threshold: 5,
  },
  {
    id: "config-or-testing-gap",
    query: "testing config pattern",
    required_citation_includes: ["README.md"],
    required_files_to_read_first: ["README.md"],
    expected_patterns: [],
    required_safety: ["bounded_context_only", "citation_required", "no_knowledge_backend_write"],
    score_threshold: 5,
  },
  {
    id: "manifest-compute-profile",
    query: "manifest compute profile caps",
    required_citation_includes: ["example-project-dna-manifest.json"],
    required_files_to_read_first: ["example-project-dna-manifest.json"],
    expected_patterns: [],
    required_safety: ["bounded_context_only", "citation_required", "no_knowledge_backend_write"],
    score_threshold: 5,
  },
  {
    id: "context-pack-schema",
    query: "context pack schema citations loading rules",
    required_citation_includes: ["schemas/context-pack.schema.json"],
    required_files_to_read_first: ["schemas/context-pack.schema.json"],
    expected_patterns: [],
    required_safety: ["bounded_context_only", "citation_required", "no_knowledge_backend_write"],
    score_threshold: 5,
  },
];

function usage() {
  console.error(`Usage:
  node scripts/project-dna/bench-smoke.mjs --scan-dir <repo-relative-scan-dir> [--out <repo-relative-json>]

Runs a deterministic ProjectDNA retrieval/sample smoke benchmark. Does not call LLMs or external knowledge backend.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan-dir") out.scanDir = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function resolveRepoPath(input, label, allowMissing = false) {
  if (!input || isAbsolute(input)) throw new Error(`${label} must be repo-relative`);
  const resolved = resolve(repoRoot, input);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || rel === "") throw new Error(`${label} must stay inside repo and not be repo root`);
  if (!allowMissing && !existsSync(resolved)) throw new Error(`${label} not found: ${input}`);
  return resolved;
}

function runNode(args) {
  return execFileSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function optionalJson(path) {
  return existsSync(path) ? readJson(path) : undefined;
}

function loadCases(scanDir) {
  const suite = optionalJson(join(scanDir, "golden-cases-smoke.json")) ?? optionalJson(join(repoRoot, ".pi/factories/project-dna/golden-cases-smoke.json"));
  if (suite?.schema === "zob.project-dna-golden-suite.v1" && Array.isArray(suite.cases) && suite.cases.length > 0) {
    return { benchmarkKind: "golden-agentic-5of5-smoke", suiteId: suite.suite_id, cases: suite.cases };
  }
  return { benchmarkKind: "legacy-hardcoded-smoke", suiteId: null, cases: LEGACY_CASES };
}

function queryCase(scanDirRel, testCase, index) {
  const outRel = `${scanDirRel.replace(/\/$/, "")}/bench/${String(index + 1).padStart(2, "0")}-${testCase.id}.json`;
  const stewardReportArgs = index === 0 ? ["--steward-report-out", `${scanDirRel.replace(/\/$/, "")}/query-steward-smoke.json`] : [];
  const stdout = runNode([
    "scripts/project-dna/query-context.mjs",
    "--scan-dir", scanDirRel,
    "--query", testCase.query,
    "--golden-case-id", testCase.id,
    "--max-files", "12",
    "--out", outRel,
    ...stewardReportArgs,
  ]);
  const result = readJson(join(repoRoot, outRel));
  const citations = result.citations ?? [];
  const filesToReadFirst = (result.files_to_read_first ?? []).map((file) => String(file.path ?? ""));
  const patternHits = (result.pattern_hits ?? []).map((pattern) => String(pattern.id ?? ""));
  const errors = [];
  if (result.schema !== "zob.project-dna-query-result.v1") errors.push("query result schema mismatch");
  if (result.query_stored !== false || result.raw_query_persisted !== false) errors.push("query result must not persist raw query");
  if (result.query_steward?.used !== true) errors.push("query steward must be used");
  if (result.query_steward?.raw_query_persisted !== false) errors.push("query steward must not persist raw query");
  if (result.query_steward?.controlled_expansion_terms_stored !== false) errors.push("query steward must not persist raw expansion terms");
  if (result.loading_rules?.bounded_context_only !== true) errors.push("query result must be bounded_context_only");
  if (result.loading_rules?.citation_required !== true) errors.push("query result must require citations");
  if (result.loading_rules?.agent_loads_entire_project !== false) errors.push("query result must not load whole project");
  if (result.safety?.knowledge_backend_write_enabled !== false) errors.push("query result must keep knowledge_backend_write_enabled=false");
  for (const needle of testCase.required_citation_includes ?? []) {
    if (!citations.some((citation) => String(citation).includes(needle))) errors.push(`missing citation containing ${needle}`);
  }
  for (const needle of testCase.required_files_to_read_first ?? []) {
    if (!filesToReadFirst.some((file) => file.includes(needle))) errors.push(`missing files_to_read_first containing ${needle}`);
  }
  for (const pattern of testCase.expected_patterns ?? []) {
    if (!patternHits.includes(pattern)) errors.push(`missing expected pattern hit ${pattern}`);
  }
  const score = errors.length === 0 ? 5 : Math.max(0, 5 - errors.length);
  if (score < Number(testCase.score_threshold ?? 5)) errors.push(`score ${score} below threshold ${testCase.score_threshold ?? 5}`);
  return {
    id: testCase.id,
    status: errors.length === 0 ? "passed" : "failed",
    score,
    threshold: Number(testCase.score_threshold ?? 5),
    errors,
    queryResultPath: outRel,
    citationCount: citations.length,
    citations_checked: citations,
    filesToReadFirstCount: filesToReadFirst.length,
    patternHitCount: patternHits.length,
    stewardIntent: result.query_steward?.intent_id ?? null,
    stdoutFirstLine: stdout.split("\n")[0] ?? "",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const scanDir = resolveRepoPath(args.scanDir, "--scan-dir");
  const scanDirRel = relative(repoRoot, scanDir).split(sep).join("/");
  const outPath = resolveRepoPath(args.out ?? `${scanDirRel}/bench/benchmark-smoke.json`, "--out", true);
  mkdirSync(dirname(outPath), { recursive: true });

  const errors = [];
  const commandResults = [];
  try {
    commandResults.push({ command: `node scripts/project-dna/validate-scan-artifacts.mjs --scan-dir ${scanDirRel}`, output: runNode(["scripts/project-dna/validate-scan-artifacts.mjs", "--scan-dir", scanDirRel]).split("\n")[0] });
  } catch (error) {
    errors.push(`scan validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sampleDirRel = `${scanDirRel}/quarantine/sample-project`;
  if (existsSync(join(repoRoot, sampleDirRel))) {
    try {
      commandResults.push({ command: `node scripts/project-dna/validate-sample-project.mjs --sample-dir ${sampleDirRel}`, output: runNode(["scripts/project-dna/validate-sample-project.mjs", "--sample-dir", sampleDirRel]).split("\n")[0] });
    } catch (error) {
      errors.push(`sample validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    errors.push(`sample dir missing for benchmark: ${sampleDirRel}`);
  }

  const suite = loadCases(scanDir);
  const cases = suite.cases.map((testCase, index) => queryCase(scanDirRel, testCase, index));
  for (const testCase of cases) for (const error of testCase.errors) errors.push(`${testCase.id}: ${error}`);

  const result = {
    schema: "zob.project-dna-benchmark-smoke.v1",
    benchmark_kind: suite.benchmarkKind,
    suite_id: suite.suiteId,
    scan_dir: scanDirRel,
    status: errors.length === 0 ? "passed" : "failed",
    cases,
    command_results: commandResults,
    errors,
    metrics: {
      cases_total: cases.length,
      cases_passed: cases.filter((testCase) => testCase.status === "passed").length,
      citation_total: cases.reduce((sum, testCase) => sum + testCase.citationCount, 0),
      average_score: cases.length > 0 ? Number((cases.reduce((sum, testCase) => sum + testCase.score, 0) / cases.length).toFixed(2)) : 0,
    },
    gates: {
      deterministic_only: true,
      llm_judge_used: false,
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
      promotion_allowed: false,
      human_approval_required: true,
    }
  };
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-benchmark-smoke-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
