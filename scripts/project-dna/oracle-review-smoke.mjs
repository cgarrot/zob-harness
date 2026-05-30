#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();

function usage() {
  console.error(`Usage:
  node scripts/project-dna/oracle-review-smoke.mjs --scan-dir <repo-relative-scan-dir> --benchmark <repo-relative-json> [--out <repo-relative-json>]

Writes a structural oracle review for ProjectDNA smoke artifacts. This is not durable promotion approval.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan-dir") out.scanDir = argv[++i];
    else if (arg === "--benchmark") out.benchmark = argv[++i];
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir || !args.benchmark) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const scanDir = resolveRepoPath(args.scanDir, "--scan-dir");
  const benchmarkPath = resolveRepoPath(args.benchmark, "--benchmark");
  const scanDirRel = relative(repoRoot, scanDir).split(sep).join("/");
  const outPath = resolveRepoPath(args.out ?? `${scanDirRel}/oracle/project-dna-smoke-oracle-review.json`, "--out", true);
  mkdirSync(dirname(outPath), { recursive: true });

  const benchmark = readJson(benchmarkPath);
  const scanSummary = readJson(join(scanDir, "scan-summary.json"));
  const contextPack = readJson(join(scanDir, "context-pack-smoke.json"));
  const sampleSummaryPath = join(scanDir, "quarantine", "sample-project", "project-dna-sample-summary.json");
  const sampleSummary = existsSync(sampleSummaryPath) ? readJson(sampleSummaryPath) : undefined;
  const queryResultPath = join(scanDir, "query-result-smoke.json");
  const queryResult = existsSync(queryResultPath) ? readJson(queryResultPath) : undefined;
  const ontologyPath = join(scanDir, "ontology.json");
  const ontology = existsSync(ontologyPath) ? readJson(ontologyPath) : undefined;
  const goldenCasesPath = join(scanDir, "golden-cases-smoke.json");
  const goldenCases = existsSync(goldenCasesPath) ? readJson(goldenCasesPath) : undefined;
  const queryStewardPath = join(scanDir, "query-steward-smoke.json");
  const querySteward = existsSync(queryStewardPath) ? readJson(queryStewardPath) : undefined;

  const blocking = [];
  const notes = [];
  if (benchmark.schema !== "zob.project-dna-benchmark-smoke.v1") blocking.push("benchmark schema mismatch");
  if (benchmark.status !== "passed") blocking.push("benchmark status is not passed");
  if (benchmark.benchmark_kind !== "golden-agentic-5of5-smoke") blocking.push("benchmark must use golden-agentic-5of5-smoke cases");
  if (benchmark.metrics?.cases_total < 5) blocking.push("benchmark must include at least five golden cases");
  if (benchmark.metrics?.cases_passed !== benchmark.metrics?.cases_total) blocking.push("all golden benchmark cases must pass");
  if (benchmark.gates?.source_project_modified !== false) blocking.push("benchmark must prove source_project_modified=false");
  if (benchmark.gates?.knowledge_backend_write_enabled !== false) blocking.push("benchmark must prove knowledge_backend_write_enabled=false");
  if (benchmark.gates?.promotion_allowed !== false) blocking.push("benchmark smoke must not allow durable promotion");
  if (scanSummary.source_project_modified !== false) blocking.push("scan summary source_project_modified must be false");
  if (scanSummary.knowledge_backend_write_enabled !== false) blocking.push("scan summary knowledge_backend_write_enabled must be false");
  if (contextPack.loading_rules?.citation_required !== true) blocking.push("context pack must require citations");
  if (contextPack.loading_rules?.agent_loads_entire_project !== false) blocking.push("context pack must not load entire project");
  if (!sampleSummary) blocking.push("sample summary missing");
  else {
    if (sampleSummary.quarantine_only !== true) blocking.push("sample summary must be quarantine_only=true");
    if (sampleSummary.source_files_copied !== false) blocking.push("sample summary source_files_copied must be false");
    if (sampleSummary.knowledge_backend_write_enabled !== false) blocking.push("sample summary knowledge_backend_write_enabled must be false");
  }
  if (!queryResult) notes.push("query-result-smoke.json missing; benchmark cases still provide query artifacts");
  else {
    if (queryResult.raw_query_persisted !== false) blocking.push("query result must not persist raw query");
    if (queryResult.loading_rules?.bounded_context_only !== true) blocking.push("query result must be bounded_context_only");
    if (queryResult.query_steward?.used !== true) blocking.push("query result must record query_steward.used=true");
  }
  if (!ontology) blocking.push("ontology.json missing for 5/5 agentic smoke");
  else {
    if (ontology.schema !== "zob.project-dna-ontology.v1") blocking.push("ontology schema mismatch");
    if (ontology.knowledge_backend_write_enabled !== false) blocking.push("ontology must keep knowledge_backend_write_enabled=false");
    if (ontology.promotion_policy !== "proposal_only") blocking.push("ontology promotion_policy must be proposal_only");
  }
  if (!goldenCases) blocking.push("golden-cases-smoke.json missing for 5/5 agentic smoke");
  else {
    if (goldenCases.schema !== "zob.project-dna-golden-suite.v1") blocking.push("golden cases schema mismatch");
    if (!Array.isArray(goldenCases.cases) || goldenCases.cases.length < 5) blocking.push("golden cases must include at least five cases");
    if (goldenCases.knowledge_backend_write_enabled !== false) blocking.push("golden cases backend write flag must be false");
  }
  if (!querySteward) blocking.push("query-steward-smoke.json missing for 5/5 agentic smoke");
  else {
    if (querySteward.schema !== "zob.project-dna-query-steward-report.v1") blocking.push("query steward schema mismatch");
    if (querySteward.raw_query_persisted !== false) blocking.push("query steward must not persist raw query");
    if (querySteward.controlled_expansion?.stored_raw_terms !== false) blocking.push("query steward must not persist raw expansion terms");
    if (querySteward.loading_rules?.bounded_context_only !== true) blocking.push("query steward must be bounded_context_only");
  }

  const review = {
    schema: "zob.oracle-review.v1",
    reviewedRunId: "project-dna-smoke-local-artifacts",
    verdict: blocking.length === 0 ? "PASS" : "FAIL",
    no_ship: blocking.length > 0,
    evidence: blocking.length === 0
      ? "ProjectDNA 5/5 agentic smoke artifacts passed deterministic scan/query-steward/ontology/golden/sample benchmark and remain proposal-only with no external knowledge-backend writes."
      : "ProjectDNA 5/5 agentic smoke artifacts failed structural oracle checks.",
    reviewer: "project-dna-structural-oracle",
    blocking_issues: blocking,
    non_blocking_notes: notes,
    evidence_refs: [
      `${scanDirRel}/scan-summary.json`,
      relative(repoRoot, benchmarkPath).split(sep).join("/"),
      `${scanDirRel}/context-pack-smoke.json`,
      `${scanDirRel}/ontology.json`,
      `${scanDirRel}/golden-cases-smoke.json`,
      `${scanDirRel}/query-steward-smoke.json`,
      `${scanDirRel}/quarantine/sample-project/project-dna-sample-summary.json`,
      `${scanDirRel}/query-result-smoke.json`
    ],
    promotion: {
      durable_promotion_allowed: false,
      reason: "Smoke oracle covers scaffold readiness only. Durable knowledge/sample promotion still requires human approval and a real-project run review.",
      human_approval_required: true,
      writeback_policy: "proposal_only"
    },
    safety: {
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
      secrets_read: false,
      production_writes_performed: false
    }
  };
  writeFileSync(outPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(review, null, 2));
  if (blocking.length > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-oracle-review-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
