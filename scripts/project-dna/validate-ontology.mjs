#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const FORBIDDEN_BODY_KEYS = new Set(["body", "content", "prompt", "output", "message", "rawConversation", "conversationHistory", "snippet", "diff", "patch"]);

function usage() {
  console.error("Usage: node scripts/project-dna/validate-ontology.mjs --ontology <repo-relative-json>");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ontology") out.ontology = argv[++i];
    else if (arg === "--scan-dir") out.ontology = `${argv[++i].replace(/\/$/, "")}/ontology.json`;
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

function findForbiddenKeys(value, trail = "$", hits = []) {
  if (!value || typeof value !== "object") return hits;
  if (Array.isArray(value)) {
    value.forEach((child, index) => findForbiddenKeys(child, `${trail}[${index}]`, hits));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) hits.push(`${trail}.${key}`);
    findForbiddenKeys(child, `${trail}.${key}`, hits);
  }
  return hits;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.ontology) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const ontologyPath = resolveRepoPath(args.ontology, "--ontology");
  const ontology = JSON.parse(readFileSync(ontologyPath, "utf8"));
  const errors = [];
  if (ontology.schema !== "zob.project-dna-ontology.v1") errors.push("ontology schema mismatch");
  if (typeof ontology.ontology_id !== "string" || !ontology.ontology_id) errors.push("ontology_id required");
  if (ontology.source_safe !== true) errors.push("source_safe must be true");
  if (ontology.raw_bodies_stored !== false) errors.push("raw_bodies_stored must be false");
  if (ontology.knowledge_backend_write_enabled !== false) errors.push("knowledge_backend_write_enabled must be false");
  if (ontology.promotion_policy !== "proposal_only") errors.push("promotion_policy must be proposal_only");
  if (!Array.isArray(ontology.concepts) || ontology.concepts.length < 5) errors.push("at least five concepts required for 5/5 smoke");
  const ids = new Set();
  for (const concept of ontology.concepts ?? []) {
    if (typeof concept.id !== "string" || !/^[a-z0-9_.-]+$/.test(concept.id)) errors.push(`invalid concept id: ${concept.id}`);
    if (ids.has(concept.id)) errors.push(`duplicate concept id: ${concept.id}`);
    ids.add(concept.id);
    if (!Array.isArray(concept.aliases) || concept.aliases.length < 1) errors.push(`${concept.id} aliases required`);
    if (!Array.isArray(concept.expected_file_hints) || concept.expected_file_hints.length < 1) errors.push(`${concept.id} expected_file_hints required`);
    if (!Array.isArray(concept.minimum_citation_roles) || concept.minimum_citation_roles.length < 1) errors.push(`${concept.id} minimum_citation_roles required`);
  }
  if (!Array.isArray(ontology.edge_types) || !ontology.edge_types.includes("tested_by") || !ontology.edge_types.includes("validated_by")) errors.push("edge_types must include tested_by and validated_by");
  if (ontology.citation_policy?.citation_required !== true) errors.push("citation_policy.citation_required must be true");
  if (ontology.citation_policy?.prefer_symbol_ranges !== true) errors.push("citation_policy.prefer_symbol_ranges must be true");
  if (ontology.citation_policy?.raw_body_storage_allowed !== false) errors.push("citation_policy.raw_body_storage_allowed must be false");
  const bodyHits = findForbiddenKeys(ontology);
  if (bodyHits.length > 0) errors.push(`ontology contains forbidden raw/body-like keys: ${bodyHits.slice(0, 10).join(", ")}`);
  const result = {
    schema: "zob.project-dna-ontology-validation.v1",
    valid: errors.length === 0,
    ontology: relative(repoRoot, ontologyPath),
    concept_count: Array.isArray(ontology.concepts) ? ontology.concepts.length : 0,
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
  console.error(JSON.stringify({ schema: "zob.project-dna-ontology-validation-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
