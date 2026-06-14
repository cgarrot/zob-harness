#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();

function usage() {
  console.error(`Usage:
  node scripts/project-dna/generate-sample.mjs --sample-spec <repo-relative-json> --out-dir <repo-relative-quarantine-dir>

Generates a tiny dependency-free neutral sample project in a quarantine/report path. It does not copy source files or run package installs.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--sample-spec") out.sampleSpec = argv[++i];
    else if (arg === "--out-dir") out.outDir = argv[++i];
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

function assertQuarantineOutDir(outDir) {
  const rel = relative(repoRoot, outDir).split(sep).join("/");
  const allowed = rel.startsWith(".pi/reports/project-dna-scans/") || rel.startsWith("reports/project-dna-scans/") || rel.startsWith(".pi/reports/factory-runs/") || rel.startsWith("reports/factory-runs/");
  if (!allowed || !rel.includes("/quarantine/")) {
    throw new Error("--out-dir must be a repo-local .pi/reports/.../quarantine/... path, with legacy reports/... accepted for existing runs");
  }
}

function safePackageName(value) {
  return String(value ?? "project-dna-sample")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project-dna-sample";
}

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.sampleSpec || !args.outDir) {
    usage();
    if (!args.help) process.exit(2);
    return;
  }
  const specPath = resolveRepoPath(args.sampleSpec, "--sample-spec");
  const outDir = resolveRepoPath(args.outDir, "--out-dir");
  assertQuarantineOutDir(outDir);
  if (!existsSync(specPath)) throw new Error(`sample spec not found: ${args.sampleSpec}`);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  if (spec.schema !== "zob.project-dna-sample-spec.v1") throw new Error("sample spec schema must be zob.project-dna-sample-spec.v1");
  if (spec.safety?.sample_code_generated !== false) throw new Error("sample spec must start as spec_only/no generated code");

  const packageName = safePackageName(spec.sample_name);
  const sourceId = String(spec.source_id ?? "unknown-source");
  const neutralDomain = String(spec.neutral_domain ?? "neutral-domain");
  const requiredModules = Array.isArray(spec.required_modules) && spec.required_modules.length > 0 ? spec.required_modules : ["example-module", "tests"];
  const citations = Array.isArray(spec.citations) ? spec.citations.slice(0, 12) : [];

  writeText(join(outDir, "package.json"), JSON.stringify({
    name: packageName,
    version: "0.0.0-project-dna-sample",
    private: true,
    type: "module",
    description: `Neutral ProjectDNA sample generated from ${sourceId} metadata for ${neutralDomain}.`,
    scripts: {
      check: "node scripts/validate-sample.mjs",
      test: "node test/sample.test.mjs",
      build: "node scripts/validate-sample.mjs"
    },
    dependencies: {},
    devDependencies: {},
    projectDna: {
      source_id: sourceId,
      neutral_domain: neutralDomain,
      copy_policy: "structure_and_patterns_only",
      generated_from_scan_metadata_only: true,
      source_files_copied: false,
      source_project_modified: false,
      knowledge_backend_write_enabled: false
    }
  }, null, 2));

  writeText(join(outDir, "README.md"), `# ${packageName}

Neutral ProjectDNA sample generated in quarantine.

- source_id: \`${sourceId}\`
- neutral_domain: \`${neutralDomain}\`
- generation: metadata-only structure/pattern sample
- source files copied: false
- source project modified: false
- external knowledge-backend write: false

## Preserved signals

${(spec.preserve ?? []).slice(0, 20).map((item) => `- ${item}`).join("\n") || "- No preserve signals detected."}

## Citations to inspect before use

${citations.map((citation) => `- \`${citation}\``).join("\n") || "- Gap: no citations in sample spec."}

## Validation

\`npm run check\`, \`npm test\`, and \`npm run build\` are dependency-free local Node checks.
`);

  writeText(join(outDir, "src/config/index.mjs"), `export const projectDnaConfig = Object.freeze({
  sourceId: ${JSON.stringify(sourceId)},
  neutralDomain: ${JSON.stringify(neutralDomain)},
  generatedFromScanMetadataOnly: true,
  sourceFilesCopied: false,
  sourceProjectModified: false,
  knowledgeBackendWriteEnabled: false,
});
`);

  writeText(join(outDir, "src/example-module/index.mjs"), `import { projectDnaConfig } from "../config/index.mjs";

export function describeProjectDnaSample(input = {}) {
  const name = typeof input.name === "string" && input.name.length > 0 ? input.name : "example";
  return {
    id: ` + "`${projectDnaConfig.neutralDomain}:${name}`" + `,
    sourceId: projectDnaConfig.sourceId,
    neutralDomain: projectDnaConfig.neutralDomain,
    rules: [
      "read cited source/sample files before implementation",
      "keep context bounded",
      "do not copy product-specific logic",
      "keep writeback proposal-only"
    ],
  };
}
`);

  writeText(join(outDir, "src/tools/example-tool.mjs"), `export const exampleTool = Object.freeze({
  name: "project-dna-example-tool",
  description: "Dependency-free Pi-like tool descriptor generated from ProjectDNA metadata.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" }
    },
    additionalProperties: false
  },
  async run(input = {}) {
    const name = typeof input.name === "string" && input.name.length > 0 ? input.name : "world";
    return { ok: true, greeting: ` + "`hello ${name}`" + ` };
  }
});
`);

  writeText(join(outDir, "src/extension.mjs"), `import { describeProjectDnaSample } from "./example-module/index.mjs";
import { exampleTool } from "./tools/example-tool.mjs";

export function createProjectDnaExtension() {
  return {
    name: "project-dna-sample-extension",
    summary: describeProjectDnaSample({ name: "extension" }),
    tools: [exampleTool],
    prompts: [".pi/skills/example-skill/SKILL.md"],
    agents: [".pi/agents/example-agent.md"],
    safety: {
      sourceFilesCopied: false,
      sourceProjectModified: false,
      knowledgeBackendWriteEnabled: false,
      writebackPolicy: "proposal_only"
    }
  };
}
`);

  writeText(join(outDir, ".pi/agents/example-agent.md"), `---
name: example-agent
description: Example dependency-free Pi-like agent generated by ProjectDNA sample quarantine.
tools: read,grep,find,ls
---
You are an example ProjectDNA sample agent.

Rules:
- Use bounded cited context only.
- Do not read secrets or generated/vendor folders.
- Keep writeback proposal-only.
`);

  writeText(join(outDir, ".pi/skills/example-skill/SKILL.md"), `---
name: example-skill
description: Example ProjectDNA sample skill. Use for dependency-free Pi-like scaffold smoke tests.
---
# Example Skill

This skill is generated from ProjectDNA metadata only. It demonstrates folder shape, not copied product logic.
`);

  writeText(join(outDir, "test/sample.test.mjs"), `import assert from "node:assert/strict";
import { describeProjectDnaSample } from "../src/example-module/index.mjs";
import { createProjectDnaExtension } from "../src/extension.mjs";
import { exampleTool } from "../src/tools/example-tool.mjs";

const result = describeProjectDnaSample({ name: "smoke" });
assert.equal(result.sourceId, ${JSON.stringify(sourceId)});
assert.equal(result.neutralDomain, ${JSON.stringify(neutralDomain)});
assert.ok(result.id.includes("smoke"));
assert.ok(result.rules.includes("keep context bounded"));

const extension = createProjectDnaExtension();
assert.equal(extension.name, "project-dna-sample-extension");
assert.equal(extension.safety.sourceFilesCopied, false);
assert.equal(extension.tools[0].name, exampleTool.name);
const toolResult = await exampleTool.run({ name: "agentic" });
assert.equal(toolResult.greeting, "hello agentic");
console.log("ProjectDNA Pi-like neutral sample test passed");
`);

  writeText(join(outDir, "scripts/validate-sample.mjs"), `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const required = [
  "package.json",
  "README.md",
  "src/config/index.mjs",
  "src/example-module/index.mjs",
  "src/tools/example-tool.mjs",
  "src/extension.mjs",
  ".pi/agents/example-agent.md",
  ".pi/skills/example-skill/SKILL.md",
  "test/sample.test.mjs",
];
const missing = required.filter((path) => !existsSync(join(root, path)));
if (missing.length > 0) {
  console.error(JSON.stringify({ valid: false, missing }, null, 2));
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const errors = [];
if (pkg.projectDna?.source_files_copied !== false) errors.push("source_files_copied must be false");
if (pkg.projectDna?.source_project_modified !== false) errors.push("source_project_modified must be false");
if (pkg.projectDna?.knowledge_backend_write_enabled !== false) errors.push("knowledge_backend_write_enabled must be false");
if (Object.keys(pkg.dependencies ?? {}).length !== 0) errors.push("sample must stay dependency-free in P1 smoke");
if (errors.length > 0) {
  console.error(JSON.stringify({ valid: false, errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ valid: true, files: required, dependencyFree: true }, null, 2));
`);

  const summary = {
    schema: "zob.project-dna-sample-generation-summary.v1",
    source_id: sourceId,
    sample_name: packageName,
    neutral_domain: neutralDomain,
    out_dir: relative(repoRoot, outDir).split(sep).join("/"),
    required_modules: requiredModules,
    generated_files: [
      "package.json",
      "README.md",
      "src/config/index.mjs",
      "src/example-module/index.mjs",
      "src/tools/example-tool.mjs",
      "src/extension.mjs",
      ".pi/agents/example-agent.md",
      ".pi/skills/example-skill/SKILL.md",
      "test/sample.test.mjs",
      "scripts/validate-sample.mjs"
    ],
    quarantine_only: true,
    source_files_copied: false,
    source_project_modified: false,
    knowledge_backend_write_enabled: false,
    promotion: {
      writeback_policy: "proposal_only",
      oracle_required: true,
      human_approval_required: true
    }
  };
  writeText(join(outDir, "project-dna-sample-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ schema: "zob.project-dna-sample-generation-error.v1", error: error instanceof Error ? error.message : String(error), source_project_modified: false, knowledge_backend_write_enabled: false }, null, 2));
  process.exit(1);
}
