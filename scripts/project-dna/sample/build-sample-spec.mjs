#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();

function usage() {
  console.error(`Usage:
  node scripts/project-dna/build-sample-spec.mjs --scan-dir <repo-relative-scan-dir> [--neutral-domain <domain>] [--out <repo-relative-json>]

Builds a neutral ProjectDNA sample specification from scan metadata. It does not generate sample code.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan-dir") out.scanDir = argv[++i];
    else if (arg === "--neutral-domain") out.neutralDomain = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
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
  return resolved;
}

function readJson(dir, name) {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`missing scan artifact: ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }

  const scanDir = resolveRepoPath(args.scanDir, "--scan-dir");
  const outPath = resolveRepoPath(args.out ?? `${args.scanDir.replace(/\/$/, "")}/sample-spec.json`, "--out");
  const fingerprint = readJson(scanDir, "project-fingerprint.json");
  const dependencyMap = readJson(scanDir, "dependency-map.json");
  const fileMap = readJson(scanDir, "file-map.json");
  const architectureMap = readJson(scanDir, "architecture-map.json");
  const contextPack = readJson(scanDir, "context-pack-smoke.json");

  const kinds = new Set((fileMap.files ?? []).map((file) => file.kind));
  const requiredModules = ["config"];
  if (kinds.has("route") || kinds.has("entrypoint")) requiredModules.push("api");
  if (kinds.has("service")) requiredModules.push("services");
  if (kinds.has("queue") || kinds.has("worker")) requiredModules.push("queues", "workers");
  if (kinds.has("database")) requiredModules.push("database");
  if (kinds.has("test")) requiredModules.push("tests");
  if (requiredModules.length === 1) requiredModules.push("example-module", "tests");

  const toolRoles = dependencyMap.tool_roles ?? [];
  const preserve = unique([
    dependencyMap.package_manager ? `package-manager:${dependencyMap.package_manager}` : undefined,
    ...toolRoles.map((tool) => `tool-role:${tool.name}:${tool.role}`),
    ...Object.keys(architectureMap.kind_counts ?? {}).map((kind) => `file-kind:${kind}`),
    ...((architectureMap.patterns ?? []).map((pattern) => `pattern:${pattern.id}`)),
  ]);

  const sampleSpec = {
    schema: "zob.project-dna-sample-spec.v1",
    source_id: fingerprint.source_id,
    sample_name: `${fingerprint.source_id}-dna-sample`,
    neutral_domain: args.neutralDomain ?? "task-tracker",
    generation_status: "spec_only_no_code_generated",
    target_stack_policy: "preserve_detected_stack_where_safe",
    copy_policy: "structure_and_patterns_only",
    preserve,
    remove: [
      "real product concepts",
      "company/user/customer names",
      "business-specific logic",
      "private data",
      "secrets and credentials",
      "fragile external integrations",
      "large verbatim source files"
    ],
    required_modules: unique(requiredModules),
    suggested_files: unique(requiredModules).map((module) => ({
      module,
      path: module === "api" ? "src/api/routes.ts" : module === "tests" ? "test/sample.test.ts" : `src/${module}/index.ts`,
      purpose: `neutral ${module} example preserving observed ProjectDNA conventions where cited`,
    })),
    citations: unique([...(contextPack.citations ?? []), ...(architectureMap.citations ?? [])]).slice(0, 30),
    validation: {
      required: true,
      suggested_commands: ["install", "lint/typecheck if configured", "test if configured", "build if configured"],
      no_ship_if_fails: true,
    },
    promotion: {
      writeback_policy: "proposal_only",
      oracle_required: true,
      human_approval_required: true,
    },
    safety: {
      source_files_read: false,
      scan_metadata_only: true,
      sample_code_generated: false,
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
    },
  };

  writeFileSync(outPath, `${JSON.stringify(sampleSpec, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    schema: "zob.project-dna-sample-spec-build-summary.v1",
    source_id: fingerprint.source_id,
    out: relative(repoRoot, outPath).split(sep).join("/"),
    neutral_domain: sampleSpec.neutral_domain,
    required_modules: sampleSpec.required_modules,
    sample_code_generated: false,
    source_project_modified: false,
    knowledge_backend_write_enabled: false,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-sample-spec-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
