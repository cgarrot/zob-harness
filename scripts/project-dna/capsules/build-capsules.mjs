#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();

function usage() {
  console.error(`Usage:
  node scripts/project-dna/build-capsules.mjs --scan-dir <repo-relative-scan-dir> [--out-dir <repo-relative-output-dir>]

Builds pointer capsules from ProjectDNA scan metadata. Does not read source project files.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan-dir") out.scanDir = argv[++i];
    else if (arg === "--out-dir") out.outDir = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function resolveRepoDir(input, label) {
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

function citationList(citations = []) {
  const unique = [...new Set(citations.filter(Boolean))];
  if (unique.length === 0) return "- Gap: no citations available.";
  return unique.map((citation) => `- \`${citation}\``).join("\n");
}

function filesByKind(fileMap, kind) {
  return (fileMap.files ?? []).filter((file) => file.kind === kind);
}

function filesAsPointers(files, limit = 12) {
  if (files.length === 0) return "- Gap: no matching files detected.";
  return files.slice(0, limit).map((file) => {
    const citation = file.citations?.[0] ?? file.path;
    return `- \`${citation}\` — ${file.kind}${file.imports?.length ? `; imports: ${file.imports.slice(0, 5).join(", ")}` : ""}`;
  }).join("\n");
}

function writeCapsule(outDir, name, content) {
  writeFileSync(join(outDir, name), `${content.trim()}\n`, "utf8");
}

function capsuleHeader(title, sourceId) {
  return `# ${title}\n\nSource: \`${sourceId}\`\n\nStatus: generated pointer capsule from ProjectDNA scan metadata. Treat citations as navigation hints, not full truth. Read cited files before implementation.\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const scanDir = resolveRepoDir(args.scanDir, "--scan-dir");
  const outDir = resolveRepoDir(args.outDir ?? `${args.scanDir.replace(/\/$/, "")}/capsules`, "--out-dir");
  const outRel = relative(repoRoot, outDir).split(sep).join("/");
  mkdirSync(outDir, { recursive: true });

  const fingerprint = readJson(scanDir, "project-fingerprint.json");
  const dependencyMap = readJson(scanDir, "dependency-map.json");
  const fileMap = readJson(scanDir, "file-map.json");
  const architectureMap = readJson(scanDir, "architecture-map.json");
  const contextPack = readJson(scanDir, "context-pack-smoke.json");
  const graph = readJson(scanDir, "code-knowledge-graph.json");
  const sourceId = fingerprint.source_id;

  const capsules = [];

  const architecture = `${capsuleHeader("Architecture overview", sourceId)}
## Look here first

${citationList(contextPack.citations)}

## Detected stack/tools

- package manager: ${dependencyMap.package_manager ?? "not detected"}
- runtime dependencies: ${(dependencyMap.runtime_dependencies ?? []).slice(0, 20).join(", ") || "none detected"}
- dev dependencies: ${(dependencyMap.dev_dependencies ?? []).slice(0, 20).join(", ") || "none detected"}

## Detected patterns

${(architectureMap.patterns ?? []).length ? architectureMap.patterns.map((pattern) => `- ${pattern.id} (${pattern.confidence}) — evidence: ${(pattern.evidence ?? []).slice(0, 4).map((item) => `\`${item}\``).join(", ")}`).join("\n") : "- Gap: no high-confidence architecture patterns detected."}

## Graph summary

- nodes: ${(graph.nodes ?? []).length}
- edges: ${(graph.edges ?? []).length}

## Gaps

${(architectureMap.gaps ?? []).map((gap) => `- ${gap}`).join("\n") || "- No scan-level gaps reported."}
`;
  writeCapsule(outDir, "architecture.md", architecture);
  capsules.push("architecture.md");

  const folderStructure = `${capsuleHeader("Folder structure", sourceId)}
## Top-level directories/files

${(architectureMap.top_level_directories ?? []).map((dir) => `- \`${dir}\``).join("\n") || "- Gap: no files detected."}

## File pointers by kind

${Object.entries(architectureMap.kind_counts ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `- ${kind}: ${count}`).join("\n") || "- Gap: no kind counts available."}
`;
  writeCapsule(outDir, "folder-structure.md", folderStructure);
  capsules.push("folder-structure.md");

  const testing = `${capsuleHeader("Testing pointers", sourceId)}
## Test files

${filesAsPointers(filesByKind(fileMap, "test"))}

## Observed rule

- Use these citations to infer test placement/style; do not infer missing test conventions from generic framework docs.
`;
  writeCapsule(outDir, "testing.md", testing);
  capsules.push("testing.md");

  const config = `${capsuleHeader("Config pointers", sourceId)}
## Config files

${filesAsPointers(filesByKind(fileMap, "config"))}

## Observed rule

- Prefer cited config files over ad-hoc direct client/secret construction.
`;
  writeCapsule(outDir, "config.md", config);
  capsules.push("config.md");

  const services = `${capsuleHeader("Service-layer pointers", sourceId)}
## Service files

${filesAsPointers(filesByKind(fileMap, "service"))}

## Route/controller files

${filesAsPointers(filesByKind(fileMap, "route"))}

## Observed rule

- If both route and service files exist, inspect cited pairs before adding business logic.
`;
  writeCapsule(outDir, "services.md", services);
  capsules.push("services.md");

  const queues = `${capsuleHeader("Queue / worker pointers", sourceId)}
## Queue files

${filesAsPointers(filesByKind(fileMap, "queue"))}

## Worker files

${filesAsPointers(filesByKind(fileMap, "worker"))}

## Tool evidence

${(dependencyMap.tool_roles ?? []).filter((tool) => tool.role === "queue").map((tool) => `- ${tool.name}: ${tool.role}`).join("\n") || "- Gap: no queue dependency detected."}

## Observed rule

- Only use this capsule when cited queue/worker files exist; otherwise report a gap instead of inventing a queue pattern.
`;
  writeCapsule(outDir, "queues.md", queues);
  capsules.push("queues.md");

  const summary = {
    schema: "zob.project-dna-capsule-build-summary.v1",
    source_id: sourceId,
    scan_dir: relative(repoRoot, scanDir).split(sep).join("/"),
    out_dir: outRel,
    capsules,
    source_files_read: false,
    scan_metadata_only: true,
    source_project_modified: false,
    knowledge_backend_write_enabled: false,
  };
  writeFileSync(join(outDir, "capsule-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-capsule-build-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
