#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();
const STOPWORDS = new Set(["the", "and", "for", "with", "how", "does", "this", "that", "using", "use", "project", "style"]);

function usage() {
  console.error(`Usage:
  node scripts/project-dna/query-steward.mjs --scan-dir <repo-relative-scan-dir> --query <transient text> [--golden-case-id <id>] [--out <repo-relative-json>]

Classifies a ProjectDNA query into controlled ontology/golden-case intent. Raw query text is hashed and never persisted.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan-dir") out.scanDir = argv[++i];
    else if (arg === "--query") out.query = argv[++i];
    else if (arg === "--golden-case-id") out.goldenCaseId = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveRepoPath(input, label, allowMissing = false) {
  if (!input || isAbsolute(input)) throw new Error(`${label} must be repo-relative`);
  const resolved = resolve(repoRoot, input);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || rel === "") throw new Error(`${label} must stay inside repo and not be repo root`);
  if (!allowMissing && !existsSync(resolved)) throw new Error(`${label} not found: ${input}`);
  return resolved;
}

function readOptionalJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function termsFromQuery(query) {
  return [...new Set(String(query).toLowerCase().split(/[^a-z0-9_.$/-]+/).filter((term) => term.length >= 3 && !STOPWORDS.has(term)))];
}

function loadOntology(scanDir) {
  return readOptionalJson(join(scanDir, "ontology.json")) ?? readOptionalJson(resolve(repoRoot, ".pi/factories/project-dna/pi-agentic-ontology.json"));
}

function loadGoldenSuite(scanDir) {
  return readOptionalJson(join(scanDir, "golden-cases-smoke.json")) ?? readOptionalJson(resolve(repoRoot, ".pi/factories/project-dna/golden-cases-smoke.json"));
}

function scoreConcept(concept, terms) {
  const haystack = [concept.id, concept.kind, ...(concept.aliases ?? []), ...(concept.expected_file_hints ?? [])].join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += 1;
  return score;
}

function steward(scanDir, query, goldenCaseId) {
  const ontology = loadOntology(scanDir);
  const suite = loadGoldenSuite(scanDir);
  const terms = termsFromQuery(query);
  const explicitCase = (suite?.cases ?? []).find((testCase) => testCase.id === goldenCaseId);
  const scoredCase = explicitCase ?? (suite?.cases ?? [])
    .map((testCase) => ({ testCase, score: terms.filter((term) => String(testCase.query ?? "").toLowerCase().includes(term) || String(testCase.intent_id ?? "").toLowerCase().includes(term)).length }))
    .sort((left, right) => right.score - left.score)[0]?.testCase;
  const scoredConcept = (ontology?.concepts ?? [])
    .map((concept) => ({ concept, score: scoreConcept(concept, terms) + (concept.id === scoredCase?.intent_id ? 5 : 0) }))
    .sort((left, right) => right.score - left.score)[0]?.concept;
  const intentId = explicitCase?.intent_id ?? scoredCase?.intent_id ?? scoredConcept?.id ?? "project_dna.context_lookup";
  const expectedPatterns = [...new Set([...(scoredCase?.expected_patterns ?? []), intentId].filter(Boolean))];
  const expectedFileHints = [...new Set([...(scoredConcept?.expected_file_hints ?? []), ...(scoredCase?.required_files_to_read_first ?? []), ...(scoredCase?.required_citation_includes ?? [])].filter(Boolean))];
  const controlledTerms = [...new Set([intentId, ...(scoredConcept?.aliases ?? []), ...expectedFileHints].map((term) => String(term).toLowerCase()).filter(Boolean))];
  return {
    intentId,
    confidence: explicitCase ? "high" : scoredCase || scoredConcept ? "medium" : "low",
    goldenCaseId: explicitCase?.id ?? scoredCase?.id ?? null,
    controlledTerms,
    expectedPatterns,
    expectedFileHints,
    ontologyId: ontology?.ontology_id ?? null,
    suiteId: suite?.suite_id ?? null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir || !args.query) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const scanDir = resolveRepoPath(args.scanDir, "--scan-dir");
  const scanDirRel = relative(repoRoot, scanDir).split(sep).join("/");
  const decision = steward(scanDir, args.query, args.goldenCaseId);
  const report = {
    schema: "zob.project-dna-query-steward-report.v1",
    scan_dir: scanDirRel,
    query_hash: sha256(args.query),
    raw_query_persisted: false,
    query_stored: false,
    intent: {
      id: decision.intentId,
      confidence: decision.confidence,
      golden_case_id: decision.goldenCaseId,
      ontology_id: decision.ontologyId,
      suite_id: decision.suiteId,
    },
    controlled_expansion: {
      stored_raw_terms: false,
      term_hashes: decision.controlledTerms.map((term) => sha256(term)),
      term_count: decision.controlledTerms.length,
    },
    expected_patterns: decision.expectedPatterns,
    expected_file_hints: decision.expectedFileHints,
    loading_rules: {
      bounded_context_only: true,
      citation_required: true,
      agent_loads_entire_project: false,
      writeback_policy: "proposal_only",
    },
    safety: {
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
      durable_promotion_allowed: false,
    }
  };
  if (args.out) {
    const outPath = resolveRepoPath(args.out, "--out", true);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-query-steward-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
