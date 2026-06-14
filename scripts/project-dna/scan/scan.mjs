#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();
const DEFAULT_FORBIDDEN = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  "secrets",
  "credentials",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "out",
  ".git",
];
const MAX_FILE_BYTES = 256 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".yaml", ".yml", ".toml",
  ".sql", ".prisma", ".py", ".go", ".rs", ".java",
  ".kt", ".rb", ".php", ".cs", ".swift", ".vue", ".svelte",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function usage() {
  console.error(`Usage:
  node scripts/project-dna/scan.mjs --manifest <project-dna-manifest.json> [--out-dir <repo-relative-dir>]
  node scripts/project-dna/scan.mjs --source-path <path> --source-id <id> --out-dir <repo-relative-dir> [--allow-repo-root]

This scanner is read-only for the source project and writes only metadata artifacts under --out-dir.`);
}

function parseArgs(argv) {
  const out = { allowRepoRoot: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") out.manifest = argv[++i];
    else if (arg === "--source-path") out.sourcePath = argv[++i];
    else if (arg === "--source-id") out.sourceId = argv[++i];
    else if (arg === "--out-dir") out.outDir = argv[++i];
    else if (arg === "--allow-repo-root") out.allowRepoRoot = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function safeSourceId(value) {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`source_id must be lowercase kebab-ish and path safe: ${value}`);
  }
  return value;
}

function resolveRepoOutDir(outDir) {
  if (!outDir || isAbsolute(outDir)) throw new Error("--out-dir must be repo-relative");
  const resolved = resolve(repoRoot, outDir);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || rel === "") throw new Error("--out-dir must stay inside the repo and not be repo root");
  return resolved;
}

function loadManifest(manifestPath) {
  const resolved = isAbsolute(manifestPath) ? manifestPath : resolve(repoRoot, manifestPath);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..")) throw new Error("manifest must be repo-local for P0 ProjectDNA scans");
  const parsed = JSON.parse(readFileSync(resolved, "utf8"));
  if (parsed.schema !== "zob.project-dna-manifest.v1") throw new Error("manifest schema must be zob.project-dna-manifest.v1");
  const sourceId = safeSourceId(parsed.source_project?.source_id);
  const sourcePath = parsed.source_project?.path;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) throw new Error("manifest source_project.path is required");
  const allowedPaths = Array.isArray(parsed.read_policy?.allowed_paths) ? parsed.read_policy.allowed_paths : [];
  if (allowedPaths.length === 0) throw new Error("manifest read_policy.allowed_paths must be non-empty");
  const forbiddenPatterns = Array.isArray(parsed.read_policy?.forbidden_patterns) ? parsed.read_policy.forbidden_patterns : DEFAULT_FORBIDDEN;
  return { sourceId, sourcePath, allowedPaths, forbiddenPatterns };
}

function isInsideOrEqual(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function broadRootError(path, label) {
  const broadRoots = new Set(["/", "/home", "/home/ubuntu"]);
  if (broadRoots.has(path)) return `refusing broad ${label}: ${path}`;
  return undefined;
}

function assertSafeSourceRoot(sourceRoot, options) {
  if (!existsSync(sourceRoot)) throw new Error(`source path does not exist: ${sourceRoot}`);
  const stat = statSync(sourceRoot);
  if (!stat.isDirectory()) throw new Error(`source path must be a directory: ${sourceRoot}`);
  const broadError = broadRootError(sourceRoot, "source root");
  if (broadError) throw new Error(broadError);
  if (!options.allowRepoRoot && sourceRoot === repoRoot) throw new Error("refusing repo root scan without --allow-repo-root; pass a bounded project subdir instead");
}

function assertSourceAllowedByManifest(sourceRoot, allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) throw new Error("manifest read_policy.allowed_paths must be non-empty");
  const resolvedAllowed = allowedPaths.map((allowedPath) => resolve(String(allowedPath)));
  for (const allowedRoot of resolvedAllowed) {
    const broadError = broadRootError(allowedRoot, "allowed path");
    if (broadError) throw new Error(broadError);
    if (isInsideOrEqual(allowedRoot, sourceRoot)) return;
  }
  throw new Error(`source_project.path must be inside one manifest read_policy.allowed_paths entry; source=${sourceRoot}`);
}

function segmentMatchesForbidden(segment, pattern) {
  if (pattern.endsWith("/*")) return segment === pattern.slice(0, -2);
  if (pattern.startsWith("*")) return segment.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return segment.startsWith(pattern.slice(0, -1));
  return segment === pattern;
}

function pathForbidden(relPath, forbiddenPatterns = DEFAULT_FORBIDDEN) {
  const normalized = relPath.split(sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  for (const pattern of forbiddenPatterns) {
    if (!pattern) continue;
    const clean = String(pattern).replace(/\\/g, "/").replace(/\/$/, "");
    if (clean.includes("/")) {
      if (normalized === clean || normalized.startsWith(`${clean}/`)) return clean;
      continue;
    }
    for (const segment of segments) {
      if (segmentMatchesForbidden(segment, clean)) return clean;
    }
  }
  return undefined;
}

function languageFor(path) {
  const ext = extname(path).toLowerCase();
  const map = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sql": "sql",
    ".prisma": "prisma",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".swift": "swift",
    ".vue": "vue",
    ".svelte": "svelte",
  };
  return map[ext] ?? "text";
}

function classifyKind(relPath) {
  const lower = relPath.toLowerCase();
  if (/(__tests__|\.test\.|\.spec\.|tests?\/)/.test(lower)) return "test";
  if (/(config|settings|env|redis|database)\./.test(lower) || lower.includes("/config/")) return "config";
  if (/(route|router|controller)\./.test(lower) || lower.includes("/routes/") || lower.includes("/controllers/")) return "route";
  if (/service\./.test(lower) || lower.includes("/services/")) return "service";
  if (/(worker|processor)\./.test(lower) || lower.includes("/workers/")) return "worker";
  if (/(queue|job)\./.test(lower) || lower.includes("/queues/") || lower.includes("/jobs/")) return "queue";
  if (lower.includes("/schemas/") || lower.endsWith(".schema.json")) return "schema";
  if (/(model|migration|prisma)/.test(lower) || lower.includes("/db/") || lower.includes("/database/")) return "database";
  if (/(index|main|server|app)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) return "entrypoint";
  if (lower.endsWith("package.json")) return "package-manifest";
  return "source";
}

function walk(root, forbiddenPatterns) {
  const files = [];
  const skipped = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const relPath = relative(root, full);
      const forbidden = pathForbidden(relPath, forbiddenPatterns);
      if (forbidden) {
        skipped.push({ path: relPath.split(sep).join("/"), reason: `forbidden:${forbidden}`, directory: entry.isDirectory() });
        continue;
      }
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relPath.split(sep).join("/"), reason: "not_regular_file" });
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      const size = statSync(full).size;
      if (!TEXT_EXTENSIONS.has(ext)) {
        skipped.push({ path: relPath.split(sep).join("/"), reason: "unsupported_extension" });
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        skipped.push({ path: relPath.split(sep).join("/"), reason: `too_large>${MAX_FILE_BYTES}` });
        continue;
      }
      files.push({ full, relPath: relPath.split(sep).join("/"), size });
    }
  }
  visit(root);
  return { files, skipped };
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function extractImports(text) {
  const imports = [];
  const patterns = [
    /import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      imports.push(match[1]);
      match = pattern.exec(text);
    }
  }
  return [...new Set(imports)].sort();
}

function estimateSymbolEndLine(lines, startIndex) {
  const startLine = lines[startIndex] ?? "";
  const startsBlock = startLine.includes("{") || startLine.trim().endsWith("=>") || startLine.trim().endsWith("=");
  if (!startsBlock) return startIndex + 1;
  let braceDepth = 0;
  let sawBrace = false;
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 240); index += 1) {
    const line = lines[index].replace(/(['"`]).*?\1/g, "");
    for (const char of line) {
      if (char === "{") {
        braceDepth += 1;
        sawBrace = true;
      } else if (char === "}") {
        braceDepth -= 1;
      }
    }
    if (sawBrace && braceDepth <= 0 && index > startIndex) return index + 1;
  }
  return startIndex + 1;
}

function extractSymbols(text, relPath) {
  const symbols = [];
  const lines = text.split(/\r?\n/);
  const symbolPatterns = [
    { type: "class", re: /\bexport\s+class\s+([A-Za-z_$][\w$]*)|\bclass\s+([A-Za-z_$][\w$]*)/ },
    { type: "function", re: /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { type: "interface", re: /\bexport\s+interface\s+([A-Za-z_$][\w$]*)|\binterface\s+([A-Za-z_$][\w$]*)/ },
    { type: "type", re: /\bexport\s+type\s+([A-Za-z_$][\w$]*)|\btype\s+([A-Za-z_$][\w$]*)/ },
    { type: "const", re: /\bexport\s+const\s+([A-Za-z_$][\w$]*)|\bconst\s+([A-Za-z_$][\w$]*)\s*=/ },
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const { type, re } of symbolPatterns) {
      const match = re.exec(line);
      const name = match?.[1] ?? match?.[2];
      if (name) {
        const endLine = Math.max(index + 1, estimateSymbolEndLine(lines, index));
        symbols.push({
          symbol_id: `${relPath}::${name}`,
          name,
          qualified_name: name,
          type,
          file: relPath,
          start_line: index + 1,
          end_line: endLine,
          citations: [`${relPath}:L${index + 1}-L${endLine}`],
        });
      }
    }
  }
  return symbols;
}

function parsePackageJson(sourceRoot) {
  const packagePath = join(sourceRoot, "package.json");
  if (!existsSync(packagePath)) return { package_manager: null, runtime_dependencies: [], dev_dependencies: [], scripts: {} };
  const parsed = JSON.parse(readText(packagePath));
  const runtime = Object.keys(parsed.dependencies ?? {}).sort();
  const dev = Object.keys(parsed.devDependencies ?? {}).sort();
  let packageManager = null;
  for (const marker of ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "bun.lock"]) {
    if (existsSync(join(sourceRoot, marker))) packageManager = marker.startsWith("pnpm") ? "pnpm" : marker.startsWith("yarn") ? "yarn" : marker.startsWith("bun") ? "bun" : "npm";
  }
  return { package_manager: packageManager, runtime_dependencies: runtime, dev_dependencies: dev, scripts: parsed.scripts ?? {} };
}

function dependencyRoles(deps) {
  const roleMap = {
    bullmq: "queue",
    fastify: "api",
    express: "api",
    hapi: "api",
    koa: "api",
    next: "web-framework",
    react: "ui",
    vue: "ui",
    svelte: "ui",
    prisma: "database",
    drizzle: "database",
    typeorm: "database",
    mongoose: "database",
    zod: "validation",
    yup: "validation",
    vitest: "testing",
    jest: "testing",
    mocha: "testing",
    eslint: "linting",
    prettier: "formatting",
    typescript: "language",
  };
  return deps.filter((name) => roleMap[name]).map((name) => ({ name, role: roleMap[name] }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  let sourceId;
  let sourcePath;
  let forbiddenPatterns = DEFAULT_FORBIDDEN;
  let manifestAllowedPaths = [];
  if (args.manifest) {
    const manifest = loadManifest(args.manifest);
    sourceId = manifest.sourceId;
    sourcePath = manifest.sourcePath;
    manifestAllowedPaths = manifest.allowedPaths;
    forbiddenPatterns = [...new Set([...DEFAULT_FORBIDDEN, ...manifest.forbiddenPatterns])];
  } else {
    if (!args.sourcePath || !args.sourceId || !args.outDir) {
      usage();
      process.exit(2);
    }
    sourceId = safeSourceId(args.sourceId);
    sourcePath = args.sourcePath;
  }

  const sourceRoot = resolve(sourcePath);
  assertSafeSourceRoot(sourceRoot, args);
  if (args.manifest) assertSourceAllowedByManifest(sourceRoot, manifestAllowedPaths);
  const outDir = resolveRepoOutDir(args.outDir ?? `.pi/reports/project-dna-scans/${sourceId}`);
  const outRel = relative(repoRoot, outDir);
  if (relative(sourceRoot, outDir) && !relative(sourceRoot, outDir).startsWith("..")) {
    throw new Error("--out-dir must not be inside the source project");
  }
  mkdirSync(outDir, { recursive: true });

  const { files, skipped } = walk(sourceRoot, forbiddenPatterns);
  const languages = {};
  const fileEntries = [];
  const importEdges = [];
  const allSymbols = [];
  const kindCounts = {};

  for (const file of files) {
    const text = readText(file.full);
    const lines = text.split(/\r?\n/);
    const language = languageFor(file.relPath);
    const kind = classifyKind(file.relPath);
    languages[language] = (languages[language] ?? 0) + 1;
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    const imports = extractImports(text);
    for (const target of imports) importEdges.push({ from: file.relPath, to: target, type: "imports", citations: [`${file.relPath}:L1-L${lines.length}`] });
    const symbols = extractSymbols(text, file.relPath);
    allSymbols.push(...symbols);
    fileEntries.push({
      path: file.relPath,
      language,
      kind,
      imports,
      exports: symbols.map((symbol) => symbol.name),
      symbol_citations: symbols.flatMap((symbol) => symbol.citations).slice(0, 20),
      primary_symbol_citation: symbols[0]?.citations?.[0] ?? null,
      lines: lines.length,
      bytes: file.size,
      citations: [`${file.relPath}:L1-L${lines.length}`],
    });
  }

  const packageInfo = parsePackageJson(sourceRoot);
  const allDeps = [...new Set([...packageInfo.runtime_dependencies, ...packageInfo.dev_dependencies])].sort();
  const frameworks = dependencyRoles(allDeps).filter((item) => ["api", "web-framework", "ui", "queue", "database"].includes(item.role)).map((item) => item.name);
  const patterns = [];
  if (allDeps.includes("bullmq") || importEdges.some((edge) => String(edge.to).includes("bullmq"))) patterns.push({ id: "pattern.queue.bullmq", confidence: "medium", evidence: importEdges.filter((edge) => String(edge.to).includes("bullmq")).slice(0, 5).map((edge) => edge.citations[0]) });
  if ((kindCounts.service ?? 0) > 0 && (kindCounts.route ?? 0) > 0) patterns.push({ id: "pattern.architecture.route-service-split", confidence: "medium", evidence: fileEntries.filter((file) => file.kind === "service" || file.kind === "route").slice(0, 8).flatMap((file) => file.citations) });
  if ((kindCounts.config ?? 0) > 0) patterns.push({ id: "pattern.config.centralized", confidence: "low", evidence: fileEntries.filter((file) => file.kind === "config").slice(0, 8).flatMap((file) => file.citations) });
  if ((kindCounts.test ?? 0) > 0) patterns.push({ id: "pattern.testing.present", confidence: "low", evidence: fileEntries.filter((file) => file.kind === "test").slice(0, 8).flatMap((file) => file.citations) });

  const fingerprint = {
    schema: "zob.project-fingerprint.v1",
    source_id: sourceId,
    root_hash: sha256(`${sourceId}:${basename(sourceRoot)}:${files.length}`),
    files_scanned: files.length,
    files_skipped: skipped.length,
    languages,
    package_managers: packageInfo.package_manager ? [packageInfo.package_manager] : [],
    frameworks_detected: frameworks,
    secret_scan: {
      forbidden_paths_skipped: skipped.some((item) => String(item.reason).startsWith("forbidden:")),
      secret_like_artifacts_included: false,
      skipped_patterns: forbiddenPatterns,
    },
    generated_at: new Date().toISOString(),
  };

  const dependencyMap = {
    schema: "zob.dependency-map.v1",
    source_id: sourceId,
    package_manager: packageInfo.package_manager,
    runtime_dependencies: packageInfo.runtime_dependencies,
    dev_dependencies: packageInfo.dev_dependencies,
    scripts: packageInfo.scripts,
    tool_roles: dependencyRoles(allDeps),
  };

  const fileMap = { schema: "zob.file-map.v1", source_id: sourceId, files: fileEntries };
  const symbolMap = { schema: "zob.symbol-map.v1", source_id: sourceId, symbols: allSymbols };
  const importGraph = { schema: "zob.import-graph.v1", source_id: sourceId, edges: importEdges };
  const architectureMap = {
    schema: "zob.architecture-map.v1",
    source_id: sourceId,
    kind_counts: kindCounts,
    top_level_directories: [...new Set(fileEntries.map((file) => file.path.split("/")[0]).filter(Boolean))].sort(),
    patterns,
    citations: fileEntries.slice(0, 12).flatMap((file) => file.citations),
    gaps: patterns.length === 0 ? ["No high-confidence architecture patterns detected by deterministic P1 scanner."] : [],
  };

  const mapForKind = (schema, kinds) => {
    const wanted = new Set(kinds);
    const matched = fileEntries.filter((file) => wanted.has(file.kind));
    return {
      schema,
      source_id: sourceId,
      files: matched.map((file) => ({ path: file.path, kind: file.kind, language: file.language, citations: file.citations, symbol_citations: file.symbol_citations.slice(0, 8) })),
      citations: matched.slice(0, 12).flatMap((file) => file.citations),
      gaps: matched.length === 0 ? [`No ${kinds.join("/")} files detected by deterministic scanner.`] : [],
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
    };
  };
  const routeMap = mapForKind("zob.route-map.v1", ["route"]);
  const queueMap = mapForKind("zob.queue-map.v1", ["queue", "worker"]);
  const configMap = mapForKind("zob.config-map.v1", ["config", "package-manifest"]);
  const testMap = mapForKind("zob.test-map.v1", ["test"]);
  const dbMap = mapForKind("zob.db-map.v1", ["database"]);

  const graphNodes = [
    { id: `source:${sourceId}`, type: "SourceProject", label: sourceId },
    ...fileEntries.map((file) => ({ id: `source:${file.path}`, type: "File", label: basename(file.path), path: file.path })),
    ...patterns.map((pattern) => ({ id: pattern.id, type: "Pattern", label: pattern.id, confidence: pattern.confidence })),
  ];
  const graphEdges = [
    ...fileEntries.map((file) => ({ from: `source:${sourceId}`, to: `source:${file.path}`, type: "contains", citations: file.citations })),
    ...patterns.flatMap((pattern) => (pattern.evidence ?? []).map((citation) => {
      const file = String(citation).split(":L")[0];
      return { from: pattern.id, to: `source:${file}`, type: "implements_pattern", citations: [citation] };
    })),
  ];
  const codeKnowledgeGraph = {
    schema: "zob.code-knowledge-graph.v1",
    source_id: sourceId,
    nodes: graphNodes,
    edges: graphEdges,
    citation_required: true,
    promotion: { writeback_policy: "proposal_only", oracle_required: true, human_approval_required: true },
  };

  const contextPack = {
    schema: "zob.project-dna-context-pack.v1",
    query_hash: sha256(`project-dna-smoke:${sourceId}`),
    query_stored: false,
    answer: patterns.length > 0 ? "Deterministic ProjectDNA scanner found initial code/architecture signals; read cited files before synthesis." : "No high-confidence pattern detected; use file/dependency maps as initial context only.",
    citations: fileEntries.slice(0, 8).flatMap((file) => file.citations),
    files_to_read_first: fileEntries.slice(0, 8).map((file) => ({ path: file.path, line_range: file.citations[0].split(":").at(-1), reason: file.kind, citations: file.citations })),
    rules: ["bounded_context_only", "citation_required", "source_project_read_only", "writeback_proposal_only"],
    gaps: architectureMap.gaps,
    max_context_tokens: 4000,
    loading_rules: { bounded_context_only: true, citation_required: true, agent_loads_entire_project: false, writeback_policy: "proposal_only" },
  };

  const artifacts = {
    "project-fingerprint.json": fingerprint,
    "dependency-map.json": dependencyMap,
    "file-map.json": fileMap,
    "symbol-map.json": symbolMap,
    "import-graph.json": importGraph,
    "architecture-map.json": architectureMap,
    "route-map.json": routeMap,
    "queue-map.json": queueMap,
    "config-map.json": configMap,
    "test-map.json": testMap,
    "db-map.json": dbMap,
    "code-knowledge-graph.json": codeKnowledgeGraph,
    "context-pack-smoke.json": contextPack,
    "skipped-files.json": { schema: "zob.project-dna-skipped-files.v1", source_id: sourceId, skipped },
  };

  for (const [name, artifact] of Object.entries(artifacts)) {
    writeFileSync(join(outDir, name), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }

  const summary = {
    schema: "zob.project-dna-scan-summary.v1",
    source_id: sourceId,
    out_dir: outRel.split(sep).join("/"),
    files_scanned: files.length,
    files_skipped: skipped.length,
    artifacts: Object.keys(artifacts).sort(),
    no_external_writes: true,
    source_project_modified: false,
    knowledge_backend_write_enabled: false,
  };
  writeFileSync(join(outDir, "scan-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-scan-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
