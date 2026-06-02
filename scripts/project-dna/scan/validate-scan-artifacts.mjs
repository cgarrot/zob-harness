#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const REQUIRED = [
  "scan-summary.json",
  "project-fingerprint.json",
  "dependency-map.json",
  "file-map.json",
  "symbol-map.json",
  "import-graph.json",
  "architecture-map.json",
  "route-map.json",
  "queue-map.json",
  "config-map.json",
  "test-map.json",
  "db-map.json",
  "code-knowledge-graph.json",
  "context-pack-smoke.json",
  "skipped-files.json",
];
const FORBIDDEN_BODY_KEYS = new Set(["body", "content", "prompt", "task", "output", "message", "rawConversation", "conversationHistory", "snippet"]);

function usage() {
  console.error("Usage: node scripts/project-dna/validate-scan-artifacts.mjs --scan-dir <repo-relative-scan-dir>");
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
  return resolved;
}

function readJson(scanDir, name, errors) {
  const path = join(scanDir, name);
  if (!existsSync(path)) {
    errors.push(`missing artifact: ${name}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function hasForbiddenBodyKey(value, path = "$", hits = []) {
  if (!value || typeof value !== "object") return hits;
  if (Array.isArray(value)) {
    value.forEach((child, index) => hasForbiddenBodyKey(child, `${path}[${index}]`, hits));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) hits.push(`${path}.${key}`);
    hasForbiddenBodyKey(child, `${path}.${key}`, hits);
  }
  return hits;
}

function collectCitations(value, out = []) {
  if (typeof value === "string") {
    if (/^[^\s:]+:L\d+(?:-L?\d+)?$/.test(value)) out.push(value);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectCitations(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes("citation")) collectCitations(child, out);
    else if (typeof child === "object") collectCitations(child, out);
  }
  return out;
}

function parseCitation(citation) {
  const match = /^(.+):L(\d+)(?:-L?(\d+))?$/.exec(citation);
  if (!match) return undefined;
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  return { path: match[1], start, end };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const errors = [];
  const warnings = [];
  const scanDir = resolveRepoDir(args.scanDir);
  const artifacts = Object.fromEntries(REQUIRED.map((name) => [name, readJson(scanDir, name, errors)]));
  if (errors.length === 0) {
    const summary = artifacts["scan-summary.json"];
    const fingerprint = artifacts["project-fingerprint.json"];
    const fileMap = artifacts["file-map.json"];
    const graph = artifacts["code-knowledge-graph.json"];
    const contextPack = artifacts["context-pack-smoke.json"];
    const routeMap = artifacts["route-map.json"];
    const queueMap = artifacts["queue-map.json"];
    const configMap = artifacts["config-map.json"];
    const testMap = artifacts["test-map.json"];
    const dbMap = artifacts["db-map.json"];

    if (summary.schema !== "zob.project-dna-scan-summary.v1") errors.push("scan-summary schema mismatch");
    if (summary.source_project_modified !== false) errors.push("scan summary must set source_project_modified=false");
    if (summary.knowledge_backend_write_enabled !== false) errors.push("scan summary must set knowledge_backend_write_enabled=false");
    if (fingerprint.schema !== "zob.project-fingerprint.v1") errors.push("project-fingerprint schema mismatch");
    if (fingerprint.secret_scan?.secret_like_artifacts_included !== false) errors.push("project-fingerprint must report secret_like_artifacts_included=false");
    if (fileMap.schema !== "zob.file-map.v1") errors.push("file-map schema mismatch");
    if (routeMap.schema !== "zob.route-map.v1") errors.push("route-map schema mismatch");
    if (queueMap.schema !== "zob.queue-map.v1") errors.push("queue-map schema mismatch");
    if (configMap.schema !== "zob.config-map.v1") errors.push("config-map schema mismatch");
    if (testMap.schema !== "zob.test-map.v1") errors.push("test-map schema mismatch");
    if (dbMap.schema !== "zob.db-map.v1") errors.push("db-map schema mismatch");
    if (graph.schema !== "zob.code-knowledge-graph.v1") errors.push("code-knowledge-graph schema mismatch");
    if (graph.citation_required !== true) errors.push("code-knowledge-graph must require citations");
    if (graph.promotion?.writeback_policy !== "proposal_only") errors.push("code-knowledge-graph promotion must be proposal_only");
    if (contextPack.schema !== "zob.project-dna-context-pack.v1") errors.push("context-pack schema mismatch");
    if (contextPack.query_stored !== false) errors.push("context-pack must not store raw query");
    if (contextPack.loading_rules?.bounded_context_only !== true) errors.push("context-pack must be bounded_context_only");
    if (contextPack.loading_rules?.citation_required !== true) errors.push("context-pack must require citations");
    if (contextPack.loading_rules?.agent_loads_entire_project !== false) errors.push("context-pack must not load entire project");

    for (const [name, artifact] of Object.entries(artifacts)) {
      const bodyHits = hasForbiddenBodyKey(artifact);
      if (bodyHits.length > 0) errors.push(`${name} contains forbidden raw/body-like keys: ${bodyHits.slice(0, 10).join(", ")}`);
    }

    const fileLines = new Map((fileMap.files ?? []).map((file) => [file.path, file.lines]));
    const allCitations = [...new Set(Object.values(artifacts).flatMap((artifact) => collectCitations(artifact)))].sort();
    for (const citation of allCitations) {
      const parsed = parseCitation(citation);
      if (!parsed) {
        errors.push(`invalid citation format: ${citation}`);
        continue;
      }
      const lines = fileLines.get(parsed.path);
      if (typeof lines !== "number") {
        errors.push(`citation path not present in file-map: ${citation}`);
        continue;
      }
      if (parsed.start < 1 || parsed.end < parsed.start || parsed.end > lines) {
        errors.push(`citation line range outside file-map lines (${lines}): ${citation}`);
      }
    }
    if (allCitations.length === 0) warnings.push("no L-line citations found in scan artifacts");
  }

  const result = {
    schema: "zob.project-dna-scan-validation.v1",
    scan_dir: relative(repoRoot, scanDir),
    valid: errors.length === 0,
    errors,
    warnings,
    artifacts_checked: REQUIRED,
    source_project_modified: false,
    knowledge_backend_write_enabled: false,
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-scan-validation-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
