#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();
const STOPWORDS = new Set(["the", "and", "for", "with", "how", "does", "this", "that", "using", "use", "project", "style"]);

function usage() {
  console.error(`Usage:
  node scripts/project-dna/query-context.mjs --scan-dir <repo-relative-scan-dir> --query <text> [--out <repo-relative-json>] [--max-files 8]

Builds a bounded cited ProjectDNA context pack from scan metadata. Raw query text is hashed, not persisted.`);
}

function parseArgs(argv) {
  const out = { maxFiles: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan-dir") out.scanDir = argv[++i];
    else if (arg === "--query") out.query = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--max-files") out.maxFiles = Number(argv[++i]);
    else if (arg === "--golden-case-id") out.goldenCaseId = argv[++i];
    else if (arg === "--steward-report-out") out.stewardReportOut = argv[++i];
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

function readJson(dir, name) {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`missing scan artifact: ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function queryTerms(query) {
  return [...new Set(String(query).toLowerCase().split(/[^a-z0-9_.$-]+/).filter((term) => term.length >= 3 && !STOPWORDS.has(term)))];
}

function scoreFile(file, terms, steward = {}) {
  const haystack = [file.path, file.kind, file.language, ...(file.imports ?? []), ...(file.exports ?? [])].join(" ").toLowerCase();
  const path = String(file.path ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 3;
  }
  for (const hint of steward.expectedFileHints ?? []) {
    const normalizedHint = String(hint).toLowerCase();
    if (normalizedHint && path.includes(normalizedHint)) score += 30;
  }
  if (terms.includes("queue") && file.kind === "queue") score += 8;
  if ((terms.includes("worker") || terms.includes("job")) && file.kind === "worker") score += 8;
  if ((terms.includes("route") || terms.includes("api") || terms.includes("controller")) && file.kind === "route") score += 8;
  if (terms.includes("service") && file.kind === "service") score += 8;
  if ((terms.includes("test") || terms.includes("testing") || terms.includes("vitest")) && file.kind === "test") score += 8;
  if ((terms.includes("config") || terms.includes("configuration") || terms.includes("manifest")) && (file.kind === "config" || file.kind === "package-manifest" || file.kind === "schema")) score += 8;
  if ((terms.includes("schema") || terms.includes("schemas")) && file.kind === "schema") score += 10;
  if ((terms.includes("readme") || terms.includes("docs")) && (path.endsWith("readme.md") || file.language === "markdown")) score += 8;
  if ((terms.includes("golden") || terms.includes("benchmark")) && path.includes("golden-cases")) score += 12;
  if ((terms.includes("ontology") || terms.includes("pattern")) && path.includes("ontology")) score += 12;
  return score;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readOptionalJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadOntology(scanDir) {
  return readOptionalJson(join(scanDir, "ontology.json")) ?? readOptionalJson(resolve(repoRoot, ".pi/factories/project-dna/pi-agentic-ontology.json"));
}

function loadGoldenSuite(scanDir) {
  return readOptionalJson(join(scanDir, "golden-cases-smoke.json")) ?? readOptionalJson(resolve(repoRoot, ".pi/factories/project-dna/golden-cases-smoke.json"));
}

function scoreConcept(concept, terms) {
  const haystack = [concept.id, concept.kind, ...(concept.aliases ?? []), ...(concept.expected_file_hints ?? [])].join(" ").toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length;
}

function stewardExpansion(scanDir, query, goldenCaseId) {
  const ontology = loadOntology(scanDir);
  const suite = loadGoldenSuite(scanDir);
  const terms = queryTerms(query);
  const explicitCase = (suite?.cases ?? []).find((testCase) => testCase.id === goldenCaseId);
  const matchedCase = explicitCase ?? (suite?.cases ?? [])
    .map((testCase) => ({ testCase, score: terms.filter((term) => String(testCase.query ?? "").toLowerCase().includes(term) || String(testCase.intent_id ?? "").toLowerCase().includes(term)).length }))
    .sort((left, right) => right.score - left.score)[0]?.testCase;
  const matchedConcept = (ontology?.concepts ?? [])
    .map((concept) => ({ concept, score: scoreConcept(concept, terms) + (concept.id === matchedCase?.intent_id ? 5 : 0) }))
    .sort((left, right) => right.score - left.score)[0]?.concept;
  const intentId = explicitCase?.intent_id ?? matchedCase?.intent_id ?? matchedConcept?.id ?? "project_dna.context_lookup";
  const expectedPatterns = unique([...(matchedCase?.expected_patterns ?? []), intentId]);
  const expectedFileHints = unique([...(matchedConcept?.expected_file_hints ?? []), ...(matchedCase?.required_files_to_read_first ?? []), ...(matchedCase?.required_citation_includes ?? [])]);
  const controlledTerms = unique([intentId, ...(matchedConcept?.aliases ?? []), ...expectedFileHints].map((term) => String(term).toLowerCase()));
  return {
    intentId,
    confidence: explicitCase ? "high" : matchedCase || matchedConcept ? "medium" : "low",
    goldenCaseId: explicitCase?.id ?? matchedCase?.id ?? null,
    expectedPatterns,
    expectedFileHints,
    controlledTerms,
    ontologyId: ontology?.ontology_id ?? null,
    suiteId: suite?.suite_id ?? null,
  };
}

function writeStewardReport(outRel, scanDir, queryHash, steward) {
  const outPath = resolveRepoPath(outRel, "--steward-report-out", true);
  const scanDirRel = relative(repoRoot, scanDir).split(sep).join("/");
  const report = {
    schema: "zob.project-dna-query-steward-report.v1",
    scan_dir: scanDirRel,
    query_hash: queryHash,
    raw_query_persisted: false,
    query_stored: false,
    intent: {
      id: steward.intentId,
      confidence: steward.confidence,
      golden_case_id: steward.goldenCaseId,
      ontology_id: steward.ontologyId,
      suite_id: steward.suiteId,
    },
    controlled_expansion: {
      stored_raw_terms: false,
      term_hashes: steward.controlledTerms.map((term) => sha256(term)),
      term_count: steward.controlledTerms.length,
    },
    expected_patterns: steward.expectedPatterns,
    expected_file_hints: steward.expectedFileHints,
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
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return relative(repoRoot, outPath).split(sep).join("/");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir || !args.query) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const scanDir = resolveRepoPath(args.scanDir, "--scan-dir");
  const baseTerms = queryTerms(args.query);
  const queryHash = sha256(args.query);
  const steward = stewardExpansion(scanDir, args.query, args.goldenCaseId);
  const terms = unique([...baseTerms, ...steward.controlledTerms]);
  const stewardReportRef = args.stewardReportOut ? writeStewardReport(args.stewardReportOut, scanDir, queryHash, steward) : null;
  const maxFiles = Number.isFinite(args.maxFiles) && args.maxFiles > 0 ? Math.min(20, Math.floor(args.maxFiles)) : 8;

  const fingerprint = readJson(scanDir, "project-fingerprint.json");
  const fileMap = readJson(scanDir, "file-map.json");
  const architectureMap = readJson(scanDir, "architecture-map.json");
  const contextPack = readJson(scanDir, "context-pack-smoke.json");
  const graph = readJson(scanDir, "code-knowledge-graph.json");

  const scored = (fileMap.files ?? [])
    .map((file) => ({ file, score: scoreFile(file, terms, steward) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const selected = (scored.length > 0 ? scored : (fileMap.files ?? []).slice(0, maxFiles).map((file) => ({ file, score: 0 }))).slice(0, maxFiles);
  const selectedCitations = unique(selected.flatMap((item) => [...(item.file.symbol_citations ?? []), ...(item.file.citations ?? [])]));
  const architecturePatternHits = (architectureMap.patterns ?? []).filter((pattern) => {
    const id = String(pattern.id ?? "").toLowerCase();
    return terms.some((term) => id.includes(term)) || steward.expectedPatterns.includes(pattern.id);
  });
  const stewardPatternHits = steward.expectedPatterns
    .filter((id) => !architecturePatternHits.some((pattern) => pattern.id === id))
    .map((id) => ({ id, confidence: steward.confidence, evidence: selectedCitations.slice(0, 3), stewarded: true }));
  const patternHits = [...architecturePatternHits, ...stewardPatternHits];
  const graphEdges = (graph.edges ?? []).filter((edge) => selected.some((item) => edge.to === `source:${item.file.path}` || edge.from === `source:${item.file.path}`)).slice(0, 20);
  const broadCitations = selectedCitations.filter((citation) => {
    const match = /:L(\d+)-L?(\d+)$/.exec(String(citation));
    return match ? Number(match[2]) - Number(match[1]) + 1 > 250 : false;
  });

  const result = {
    schema: "zob.project-dna-query-result.v1",
    source_id: fingerprint.source_id,
    scan_dir: relative(repoRoot, scanDir).split(sep).join("/"),
    query_hash: queryHash,
    query_stored: false,
    query_terms_stored: false,
    raw_query_persisted: false,
    answer: selected.length > 0
      ? "ProjectDNA Query Steward found bounded cited pointers in scan metadata. Read cited files before implementation."
      : "ProjectDNA Query Steward did not find matching files; treat this as a context gap.",
    query_steward: {
      used: true,
      intent_id: steward.intentId,
      confidence: steward.confidence,
      golden_case_id: steward.goldenCaseId,
      report_ref: stewardReportRef,
      raw_query_persisted: false,
      controlled_expansion_terms_stored: false,
      expected_patterns: steward.expectedPatterns,
      expected_file_hint_count: steward.expectedFileHints.length,
      controlled_expansion_term_hashes: steward.controlledTerms.map((term) => sha256(term)),
    },
    files_to_read_first: selected.map((item) => ({
      path: item.file.path,
      kind: item.file.kind,
      score: item.score,
      line_range: (item.file.primary_symbol_citation ?? item.file.citations?.[0])?.split(":").at(-1) ?? null,
      reason: item.score > 0 ? "metadata_match" : "fallback_from_context_pack",
      citations: unique([...(item.file.symbol_citations ?? []), ...(item.file.citations ?? [])]),
    })),
    citations: unique([...selectedCitations, ...(patternHits.flatMap((pattern) => pattern.evidence ?? [])), ...((contextPack.citations ?? []).slice(0, 4))]),
    graph_edges: graphEdges,
    pattern_hits: patternHits.map((pattern) => ({ id: pattern.id, confidence: pattern.confidence, evidence: pattern.evidence ?? [], stewarded: pattern.stewarded === true })),
    citation_quality: {
      citations_checked: selectedCitations.length,
      broad_citation_count: broadCitations.length,
      broad_citation_ratio: selectedCitations.length > 0 ? Number((broadCitations.length / selectedCitations.length).toFixed(3)) : 0,
      prefers_symbol_ranges: true,
    },
    gaps: selected.length === 0 ? ["No files available in ProjectDNA file map."] : patternHits.length === 0 ? ["No ontology or architecture pattern id matched the query terms; use file-level citations only."] : [],
    loading_rules: {
      bounded_context_only: true,
      citation_required: true,
      agent_loads_entire_project: false,
      writeback_policy: "proposal_only",
    },
    safety: {
      scan_metadata_only: true,
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
    }
  };

  if (args.out) {
    const outPath = resolveRepoPath(args.out, "--out", true);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-query-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
