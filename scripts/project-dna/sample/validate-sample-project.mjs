#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const REQUIRED = [
  "package.json",
  "README.md",
  "src/config/index.mjs",
  "src/example-module/index.mjs",
  "src/tools/example-tool.mjs",
  "src/extension.mjs",
  ".pi/agents/example-agent.md",
  ".pi/skills/example-skill/SKILL.md",
  "test/sample.test.mjs",
  "scripts/validate-sample.mjs",
  "project-dna-sample-summary.json",
];

function usage() {
  console.error("Usage: node scripts/project-dna/validate-sample-project.mjs --sample-dir <repo-relative-quarantine-sample-dir>");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--sample-dir") out.sampleDir = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function resolveRepoDir(input) {
  if (!input || isAbsolute(input)) throw new Error("--sample-dir must be repo-relative");
  const resolved = resolve(repoRoot, input);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || rel === "") throw new Error("--sample-dir must stay inside repo and not be repo root");
  if (!rel.split(/[/\\]/).includes("quarantine")) throw new Error("--sample-dir must be under a quarantine path");
  return resolved;
}

function runNode(args, cwd) {
  return execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.sampleDir) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const sampleDir = resolveRepoDir(args.sampleDir);
  const errors = [];
  const missing = REQUIRED.filter((path) => !existsSync(join(sampleDir, path)));
  if (missing.length > 0) errors.push(`missing required sample files: ${missing.join(", ")}`);
  let pkg;
  let summary;
  if (missing.length === 0) {
    pkg = JSON.parse(readFileSync(join(sampleDir, "package.json"), "utf8"));
    summary = JSON.parse(readFileSync(join(sampleDir, "project-dna-sample-summary.json"), "utf8"));
    if (pkg.projectDna?.source_files_copied !== false) errors.push("package projectDna.source_files_copied must be false");
    if (pkg.projectDna?.source_project_modified !== false) errors.push("package projectDna.source_project_modified must be false");
    if (pkg.projectDna?.knowledge_backend_write_enabled !== false) errors.push("package projectDna.knowledge_backend_write_enabled must be false");
    if (summary.quarantine_only !== true) errors.push("summary quarantine_only must be true");
    if (summary.source_files_copied !== false) errors.push("summary source_files_copied must be false");
    if (summary.source_project_modified !== false) errors.push("summary source_project_modified must be false");
    if (summary.knowledge_backend_write_enabled !== false) errors.push("summary knowledge_backend_write_enabled must be false");
    if (Object.keys(pkg.dependencies ?? {}).length !== 0 || Object.keys(pkg.devDependencies ?? {}).length !== 0) errors.push("P1 sample smoke must be dependency-free");
  }

  const commandResults = [];
  if (errors.length === 0) {
    for (const file of ["src/config/index.mjs", "src/example-module/index.mjs", "src/tools/example-tool.mjs", "src/extension.mjs", "test/sample.test.mjs", "scripts/validate-sample.mjs"]) {
      runNode(["--check", file], sampleDir);
      commandResults.push(`node --check ${file}`);
    }
    commandResults.push(`node scripts/validate-sample.mjs -> ${runNode(["scripts/validate-sample.mjs"], sampleDir).split("\n")[0]}`);
    commandResults.push(`node test/sample.test.mjs -> ${runNode(["test/sample.test.mjs"], sampleDir)}`);
  }

  const result = {
    schema: "zob.project-dna-sample-validation.v1",
    sample_dir: relative(repoRoot, sampleDir),
    valid: errors.length === 0,
    errors,
    required_files: REQUIRED,
    command_results: commandResults,
    quarantine_only: true,
    source_project_modified: false,
    knowledge_backend_write_enabled: false,
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-sample-validation-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
