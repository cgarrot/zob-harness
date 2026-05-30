#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();

function usage() {
  console.error(`Usage:
  node scripts/project-dna/emit-golden-cases.mjs --scan-dir <repo-relative-scan-dir> [--source <repo-relative-json>] [--out <repo-relative-json>]

Copies ProjectDNA golden cases into a reports scan directory. No source scan, no backend write.`);
}

function parseArgs(argv) {
  const out = { source: ".pi/factories/project-dna/golden-cases-smoke.json" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan-dir") out.scanDir = argv[++i];
    else if (arg === "--source") out.source = argv[++i];
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

function assertReportPath(input, label) {
  const normalized = input.split(sep).join("/");
  if (!normalized.startsWith("reports/project-dna-scans/")) throw new Error(`${label} must stay under reports/project-dna-scans`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.scanDir) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  assertReportPath(args.scanDir, "--scan-dir");
  const scanDir = resolveRepoPath(args.scanDir, "--scan-dir", true);
  const sourcePath = resolveRepoPath(args.source, "--source");
  const outRel = args.out ?? `${args.scanDir.replace(/\/$/, "")}/golden-cases-smoke.json`;
  assertReportPath(outRel, "--out");
  const outPath = resolveRepoPath(outRel, "--out", true);
  if (!relative(scanDir, outPath) || relative(scanDir, outPath).startsWith("..")) throw new Error("--out must stay inside --scan-dir");
  const suite = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (suite.schema !== "zob.project-dna-golden-suite.v1") throw new Error("golden case suite schema mismatch");
  const emitted = {
    ...suite,
    emitted_from: relative(repoRoot, sourcePath).split(sep).join("/"),
    scan_dir: relative(repoRoot, scanDir).split(sep).join("/"),
    source_project_modified: false,
    knowledge_backend_write_enabled: false,
    durable_promotion_allowed: false,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(emitted, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ schema: "zob.project-dna-golden-cases-emission.v1", out: relative(repoRoot, outPath).split(sep).join("/"), case_count: emitted.cases.length, source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-golden-cases-emission-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
