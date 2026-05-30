#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const repoRoot = process.cwd();
const errors = [];
const warnings = [];

function rel(path) {
  return path.replace(repoRoot + "/", "");
}

function requireFile(path) {
  const full = join(repoRoot, path);
  if (!existsSync(full)) {
    errors.push(`missing required file: ${path}`);
    return "";
  }
  return readFileSync(full, "utf8");
}

function readJson(path) {
  const text = requireFile(path);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function isSafeArtifactName(value) {
  return typeof value === "string"
    && value.length > 0
    && value === basename(value)
    && !value.includes("..")
    && !value.includes("/")
    && !value.includes("\\")
    && /^[a-zA-Z0-9._-]+$/.test(value);
}

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function assertIncludes(text, needle, path) {
  if (!text.includes(needle)) errors.push(`${path} must include: ${needle}`);
}

const requiredFiles = [
  "docs/ZOB_PROJECT_DNA_CODE_KNOWLEDGE_GRAPH_PLAN.md",
  "docs/ZOB_COMPUTE_PROFILE_ROUTING_PLAN.md",
  ".pi/skills/zob-compute-profile/SKILL.md",
  ".pi/skills/zob-project-dna/SKILL.md",
  ".pi/prompts/compute-preview.md",
  ".pi/prompts/compute-plan.md",
  ".pi/prompts/project-dna.md",
  ".pi/factories/project-dna/README.md",
  ".pi/factories/project-dna/factory.json",
  ".pi/factories/project-dna/smoke-manifest.json",
  ".pi/factories/project-dna/pilot-manifest.json",
  ".pi/factories/project-dna/batch-manifest.json",
  ".pi/factories/project-dna/example-project-dna-manifest.json",
  ".pi/factories/project-dna/example-project-dna-manifest-v2.json",
  ".pi/factories/project-dna/schemas/manifest.schema.json",
  ".pi/factories/project-dna/schemas/manifest-v2.schema.json",
  ".pi/factories/project-dna/schemas/project-fingerprint.schema.json",
  ".pi/factories/project-dna/schemas/code-knowledge-graph.schema.json",
  ".pi/factories/project-dna/schemas/context-pack.schema.json",
  ".pi/factories/project-dna/schemas/ontology.schema.json",
  ".pi/factories/project-dna/schemas/golden-case.schema.json",
  ".pi/factories/project-dna/schemas/query-steward-report.schema.json",
  ".pi/factories/project-dna/schemas/benchmark-suite.schema.json",
  ".pi/factories/project-dna/pi-agentic-ontology.json",
  ".pi/factories/project-dna/golden-cases-smoke.json",
  ".pi/agents/project-dna-ontology-steward.md",
  ".pi/agents/project-dna-query-steward.md",
  ".pi/agents/project-dna-test-linker.md",
  ".pi/agents/project-dna-golden-evaluator.md",
  "scripts/compute-profile/preview.mjs",
  "scripts/compute-profile/validate-preview.mjs",
  ".pi/compute-profiles/defaults.json",
  ".pi/compute-profiles/overrides.json",
  ".pi/compute-profiles/risk-rules.json",
  "scripts/compute-profile/plan-workflow.mjs",
  "scripts/compute-profile/validate-workflow.mjs",
  "scripts/compute-profile/validate-policy.mjs",
  "scripts/compute-profile/summarize.mjs",
  "scripts/compute-profile/regression-smoke.mjs",
  "scripts/project-dna/scan.mjs",
  "scripts/project-dna/plan-workflow.mjs",
  "scripts/project-dna/validate-workflow.mjs",
  "scripts/project-dna/validate-scan-artifacts.mjs",
  "scripts/project-dna/build-capsules.mjs",
  "scripts/project-dna/build-sample-spec.mjs",
  "scripts/project-dna/generate-sample.mjs",
  "scripts/project-dna/validate-sample-project.mjs",
  "scripts/project-dna/query-context.mjs",
  "scripts/project-dna/emit-ontology.mjs",
  "scripts/project-dna/validate-ontology.mjs",
  "scripts/project-dna/emit-golden-cases.mjs",
  "scripts/project-dna/validate-golden-cases.mjs",
  "scripts/project-dna/query-steward.mjs",
  "scripts/project-dna/validate-5of5.mjs",
  ".pi/extensions/zob-harness/src/project-dna.ts",
  ".pi/extensions/zob-harness/src/runtime/tools-project-dna.ts",
  "scripts/project-dna/bench-smoke.mjs",
  "scripts/project-dna/oracle-review-smoke.mjs",
];

for (const file of requiredFiles) requireFile(file);

const factory = readJson(".pi/factories/project-dna/factory.json");
if (factory) {
  assert(factory.name === "project-dna", "factory name must be project-dna");
  assert(factory.defaultMode === "smoke", "factory defaultMode must be smoke");
  assert(factory.autoPromotion === false, "factory autoPromotion must be false");
  assert(factory.manualPromotionRequired === true, "factory manualPromotionRequired must be true");
  assert(Array.isArray(factory.requiredStages), "factory requiredStages must be an array");
  for (const stage of factory.requiredStages ?? []) {
    assert(["manifest_loaded", "agentic_plan_written", "item_processed", "validation", "sentinel"].includes(stage), `unexpected ProjectDNA required stage: ${stage}`);
  }
  assert(Array.isArray(factory.expectedArtifacts) && factory.expectedArtifacts.length >= 3, "factory expectedArtifacts must list ProjectDNA artifacts");
  for (const artifact of factory.expectedArtifacts ?? []) {
    assert(isSafeArtifactName(artifact), `expected artifact must be a safe basename: ${artifact}`);
  }
  const stageTypes = new Set((factory.stages ?? []).map((stage) => stage.type));
  assert(stageTypes.has("map"), "factory must include a map stage");
  assert(stageTypes.has("reduce"), "factory must include a reduce stage");
  assert(stageTypes.has("validate"), "factory must include a validate stage");
  for (const stage of factory.stages ?? []) {
    assert(Array.isArray(stage.requiredTools), `stage ${stage.name} requiredTools must be an array`);
    for (const tool of stage.requiredTools ?? []) {
      assert(["read", "grep", "find", "ls"].includes(tool), `stage ${stage.name} must stay read-only; found tool ${tool}`);
    }
    assert((stage.mustNotDo ?? []).some((rule) => /secret/i.test(rule)), `stage ${stage.name} must forbid secrets`);
    assert((stage.mustNotDo ?? []).some((rule) => /external knowledge[- ]backend/.test(rule)), `stage ${stage.name} must forbid unapproved external knowledge-backend writes/imports`);
  }
}

for (const manifestPath of ["smoke-manifest.json", "pilot-manifest.json", "batch-manifest.json"].map((name) => `.pi/factories/project-dna/${name}`)) {
  const manifest = readJson(manifestPath);
  if (!manifest) continue;
  assert(manifest.factory === "project-dna", `${manifestPath} factory must be project-dna`);
  assert(Array.isArray(manifest.items) && manifest.items.length > 0, `${manifestPath} must include at least one item`);
  for (const item of manifest.items ?? []) {
    assert(typeof item.id === "string" && item.id.length > 0, `${manifestPath} item requires id`);
    assert(typeof item.path === "string" && item.path.length > 0, `${manifestPath} item requires path`);
    if (typeof item.path === "string" && !existsSync(join(repoRoot, item.path))) {
      errors.push(`${manifestPath} item path does not exist: ${item.path}`);
    }
  }
}

const projectDnaExampleManifest = readJson(".pi/factories/project-dna/example-project-dna-manifest.json");
if (projectDnaExampleManifest) {
  assert(projectDnaExampleManifest.schema === "zob.project-dna-manifest.v1", "example ProjectDNA manifest schema mismatch");
  assert(projectDnaExampleManifest.source_project?.source_id === "project-dna-factory", "example ProjectDNA manifest source_id mismatch");
  assert(["auto", "low", "medium", "high", "xhigh", "max"].includes(projectDnaExampleManifest.compute_profile), "example ProjectDNA manifest compute_profile invalid or missing");
  assert(projectDnaExampleManifest.compute_caps?.maxAgents <= 30, "example ProjectDNA manifest compute_caps.maxAgents must stay <= 30");
  assert(projectDnaExampleManifest.promotion?.writeback_policy === "proposal_only", "example ProjectDNA manifest must be proposal_only");
  for (const allowedPath of projectDnaExampleManifest.read_policy?.allowed_paths ?? []) {
    if (!existsSync(join(repoRoot, allowedPath))) errors.push(`example ProjectDNA manifest allowed path does not exist: ${allowedPath}`);
  }
}

const projectDnaExampleManifestV2 = readJson(".pi/factories/project-dna/example-project-dna-manifest-v2.json");
if (projectDnaExampleManifestV2) {
  assert(projectDnaExampleManifestV2.schema === "zob.project-dna-manifest.v2", "example ProjectDNA manifest v2 schema mismatch");
  assert(typeof projectDnaExampleManifestV2.user_note === "string" && projectDnaExampleManifestV2.user_note.length > 0, "example ProjectDNA manifest v2 user_note required");
  assert(projectDnaExampleManifestV2.capture_goal?.source_id === "project-dna-factory", "example ProjectDNA manifest v2 capture_goal.source_id mismatch");
  assert(projectDnaExampleManifestV2.capture_goal?.bounded_context_only === true, "example ProjectDNA manifest v2 must be bounded context only");
  assert(projectDnaExampleManifestV2.capture_goal?.citation_required === true, "example ProjectDNA manifest v2 must require citations");
  assert(["auto", "low", "medium", "high", "xhigh", "max"].includes(projectDnaExampleManifestV2.requested_compute_profile), "example ProjectDNA manifest v2 requested_compute_profile invalid or missing");
  assert(["full_capture", "architecture_only", "targeted_capture", "sample_first", "context_only"].includes(projectDnaExampleManifestV2.capture_mode_policy?.semantic_mode), "example ProjectDNA manifest v2 semantic_mode invalid or missing");
  assert(projectDnaExampleManifestV2.capture_mode_policy?.semantic_mode === "architecture_only", "example ProjectDNA manifest v2 semantic_mode should be architecture_only for smoke");
  assert(projectDnaExampleManifestV2.capture_mode_policy?.metadata_only === true, "example ProjectDNA manifest v2 must be metadata-only");
  assert(projectDnaExampleManifestV2.capture_mode_policy?.parent_owned_dispatch === true, "example ProjectDNA manifest v2 must keep parent-owned dispatch");
  assert(projectDnaExampleManifestV2.capture_mode_policy?.child_direct_dispatch_allowed === false, "example ProjectDNA manifest v2 must reject child direct dispatch");
  assert(projectDnaExampleManifestV2.capture_mode_policy?.source_mutation_allowed === false, "example ProjectDNA manifest v2 must reject source mutation");
  assert(projectDnaExampleManifestV2.capture_mode_policy?.knowledge_backend_write_allowed === false, "example ProjectDNA manifest v2 must reject backend writes");
  assert(projectDnaExampleManifestV2.compute_caps?.maxAgents <= 30, "example ProjectDNA manifest v2 compute_caps.maxAgents must stay <= 30");
  assert(projectDnaExampleManifestV2.read_policy?.forbid_secret_like_paths === true, "example ProjectDNA manifest v2 must forbid secret-like paths");
  assert(projectDnaExampleManifestV2.read_policy?.external_project_scan_allowed === false, "example ProjectDNA manifest v2 must reject external project scan");
  assert(projectDnaExampleManifestV2.sample_project?.quarantine_required === true, "example ProjectDNA manifest v2 sample project must require quarantine");
  assert(projectDnaExampleManifestV2.promotion?.writeback_policy === "proposal_only", "example ProjectDNA manifest v2 must be proposal_only");
  assert(projectDnaExampleManifestV2.promotion?.durable_promotion_allowed === false, "example ProjectDNA manifest v2 must reject durable promotion");
  for (const allowedPath of projectDnaExampleManifestV2.read_policy?.allowed_paths ?? []) {
    if (!existsSync(join(repoRoot, allowedPath))) errors.push(`example ProjectDNA manifest v2 allowed path does not exist: ${allowedPath}`);
  }
}

for (const schemaPath of [
  ".pi/factories/project-dna/schemas/manifest.schema.json",
  ".pi/factories/project-dna/schemas/manifest-v2.schema.json",
  ".pi/factories/project-dna/schemas/project-fingerprint.schema.json",
  ".pi/factories/project-dna/schemas/code-knowledge-graph.schema.json",
  ".pi/factories/project-dna/schemas/context-pack.schema.json",
  ".pi/factories/project-dna/schemas/ontology.schema.json",
  ".pi/factories/project-dna/schemas/golden-case.schema.json",
  ".pi/factories/project-dna/schemas/query-steward-report.schema.json",
  ".pi/factories/project-dna/schemas/benchmark-suite.schema.json",
]) {
  const schema = readJson(schemaPath);
  if (!schema) continue;
  const hasSchemaId = typeof schema.$id === "string" && schema.$id.length > 0;
  assert(hasSchemaId, `${schemaPath} should have a non-empty $id`);
  if (hasSchemaId && !schema.$id.includes("project") && !schema.$id.includes("code-knowledge-graph")) {
    warnings.push(`${schemaPath} $id is present but does not include project/code-knowledge-graph: ${schema.$id}`);
  }
  assert(schema.type === "object", `${schemaPath} root type must be object`);
}

const computeSkillText = requireFile(".pi/skills/zob-compute-profile/SKILL.md");
assertIncludes(computeSkillText, "xhigh", ".pi/skills/zob-compute-profile/SKILL.md");
assertIncludes(computeSkillText, "No-ship rules", ".pi/skills/zob-compute-profile/SKILL.md");
assertIncludes(computeSkillText, "child direct dispatch", ".pi/skills/zob-compute-profile/SKILL.md");

const skillText = requireFile(".pi/skills/zob-project-dna/SKILL.md");
assertIncludes(skillText, "ProjectDNA", ".pi/skills/zob-project-dna/SKILL.md");
assertIncludes(skillText, "No external knowledge backend import", ".pi/skills/zob-project-dna/SKILL.md");
assertIncludes(skillText, "No-ship rules", ".pi/skills/zob-project-dna/SKILL.md");
assertIncludes(skillText, "quarantine", ".pi/skills/zob-project-dna/SKILL.md");
assertIncludes(skillText, "5/5", ".pi/skills/zob-project-dna/SKILL.md");
assertIncludes(skillText, "Query Steward", ".pi/skills/zob-project-dna/SKILL.md");

const computePreviewPrompt = requireFile(".pi/prompts/compute-preview.md");
assertIncludes(computePreviewPrompt, "zob-compute-profile", ".pi/prompts/compute-preview.md");
assertIncludes(computePreviewPrompt, "xhigh", ".pi/prompts/compute-preview.md");

const promptText = requireFile(".pi/prompts/project-dna.md");
assertIncludes(promptText, "zob-project-dna", ".pi/prompts/project-dna.md");
assertIncludes(promptText, "context", ".pi/prompts/project-dna.md");
assertIncludes(promptText, "factory_run", ".pi/prompts/project-dna.md");
assertIncludes(promptText, "5/5", ".pi/prompts/project-dna.md");
assertIncludes(promptText, "Query Steward", ".pi/prompts/project-dna.md");

const computePreviewScript = requireFile("scripts/compute-profile/preview.mjs");
assertIncludes(computePreviewScript, "zob.compute-preview.v1", "scripts/compute-profile/preview.mjs");
assertIncludes(computePreviewScript, "childDispatchAllowed: false", "scripts/compute-profile/preview.mjs");
assertIncludes(computePreviewScript, "knowledgeBackendWriteEnabled: false", "scripts/compute-profile/preview.mjs");

const computeValidateScript = requireFile("scripts/compute-profile/validate-preview.mjs");
assertIncludes(computeValidateScript, "zob.compute-profile-validation.v1", "scripts/compute-profile/validate-preview.mjs");
assertIncludes(computeValidateScript, "childDispatchAllowed", "scripts/compute-profile/validate-preview.mjs");

const computeWorkflowScript = requireFile("scripts/compute-profile/plan-workflow.mjs");
assertIncludes(computeWorkflowScript, "zob.compute-workflow-shape.v1", "scripts/compute-profile/plan-workflow.mjs");
assertIncludes(computeWorkflowScript, "childDirectDispatch: false", "scripts/compute-profile/plan-workflow.mjs");

const computePolicyScript = requireFile("scripts/compute-profile/validate-policy.mjs");
assertIncludes(computePolicyScript, "zob.compute-profile-policy-validation.v1", "scripts/compute-profile/validate-policy.mjs");
assertIncludes(computePolicyScript, "max profile must require human approval", "scripts/compute-profile/validate-policy.mjs");

const computeSummaryScript = requireFile("scripts/compute-profile/summarize.mjs");
assertIncludes(computeSummaryScript, "zob.compute-mission-control-summary.v1", "scripts/compute-profile/summarize.mjs");
assertIncludes(computeSummaryScript, "fullHudWidgetWiringBlocker", "scripts/compute-profile/summarize.mjs");

const computeRegressionScript = requireFile("scripts/compute-profile/regression-smoke.mjs");
assertIncludes(computeRegressionScript, "zob.compute-profile-regression-smoke.v1", "scripts/compute-profile/regression-smoke.mjs");
assertIncludes(computeRegressionScript, "max must require human approval", "scripts/compute-profile/regression-smoke.mjs");

const projectDnaWorkflowPlannerScript = requireFile("scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "zob.project-dna-agentic-plan.v1", "scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "effectiveCaptureMode", "scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "repo-scout", "scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "architecture-cartographer", "scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "project-dna-query-steward", "scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "project-dna-golden-evaluator", "scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "childDirectDispatch: false", "scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "knowledgeBackendWriteEnabled: false", "scripts/project-dna/plan-workflow.mjs");
assertIncludes(projectDnaWorkflowPlannerScript, "rawBodiesStored: false", "scripts/project-dna/plan-workflow.mjs");

const projectDnaWorkflowValidatorScript = requireFile("scripts/project-dna/validate-workflow.mjs");
assertIncludes(projectDnaWorkflowValidatorScript, "zob.project-dna-agentic-plan-validation.v1", "scripts/project-dna/validate-workflow.mjs");
assertIncludes(projectDnaWorkflowValidatorScript, "effectiveCaptureMode", "scripts/project-dna/validate-workflow.mjs");
assertIncludes(projectDnaWorkflowValidatorScript, "raw key forbidden", "scripts/project-dna/validate-workflow.mjs");
assertIncludes(projectDnaWorkflowValidatorScript, "childDirectDispatch", "scripts/project-dna/validate-workflow.mjs");

const packageJson = readJson("package.json");
if (packageJson) {
  assert(typeof packageJson.scripts?.["plan:project-dna-workflow:smoke"] === "string", "package.json must include plan:project-dna-workflow:smoke");
  assert(typeof packageJson.scripts?.["validate:project-dna-workflow:smoke"] === "string", "package.json must include validate:project-dna-workflow:smoke");
  assert(typeof packageJson.scripts?.["emit:project-dna-ontology:smoke"] === "string", "package.json must include emit:project-dna-ontology:smoke");
  assert(typeof packageJson.scripts?.["validate:project-dna-ontology:smoke"] === "string", "package.json must include validate:project-dna-ontology:smoke");
  assert(typeof packageJson.scripts?.["emit:project-dna-golden-cases:smoke"] === "string", "package.json must include emit:project-dna-golden-cases:smoke");
  assert(typeof packageJson.scripts?.["validate:project-dna-golden-cases:smoke"] === "string", "package.json must include validate:project-dna-golden-cases:smoke");
  assert(typeof packageJson.scripts?.["steward:project-dna-query:smoke"] === "string", "package.json must include steward:project-dna-query:smoke");
  assert(typeof packageJson.scripts?.["validate:project-dna-5of5:smoke"] === "string", "package.json must include validate:project-dna-5of5:smoke");
}

const scanScript = requireFile("scripts/project-dna/scan.mjs");
assertIncludes(scanScript, "DEFAULT_FORBIDDEN", "scripts/project-dna/scan.mjs");
assertIncludes(scanScript, "assertSourceAllowedByManifest", "scripts/project-dna/scan.mjs");
assertIncludes(scanScript, "source_project_modified: false", "scripts/project-dna/scan.mjs");
assertIncludes(scanScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/scan.mjs");

const scanValidatorScript = requireFile("scripts/project-dna/validate-scan-artifacts.mjs");
assertIncludes(scanValidatorScript, "citation line range outside file-map lines", "scripts/project-dna/validate-scan-artifacts.mjs");
assertIncludes(scanValidatorScript, "source_project_modified: false", "scripts/project-dna/validate-scan-artifacts.mjs");
assertIncludes(scanValidatorScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/validate-scan-artifacts.mjs");

const capsuleScript = requireFile("scripts/project-dna/build-capsules.mjs");
assertIncludes(capsuleScript, "scan_metadata_only: true", "scripts/project-dna/build-capsules.mjs");
assertIncludes(capsuleScript, "source_project_modified: false", "scripts/project-dna/build-capsules.mjs");
assertIncludes(capsuleScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/build-capsules.mjs");

const sampleSpecScript = requireFile("scripts/project-dna/build-sample-spec.mjs");
assertIncludes(sampleSpecScript, "spec_only_no_code_generated", "scripts/project-dna/build-sample-spec.mjs");
assertIncludes(sampleSpecScript, "sample_code_generated: false", "scripts/project-dna/build-sample-spec.mjs");
assertIncludes(sampleSpecScript, "source_project_modified: false", "scripts/project-dna/build-sample-spec.mjs");
assertIncludes(sampleSpecScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/build-sample-spec.mjs");

const sampleGeneratorScript = requireFile("scripts/project-dna/generate-sample.mjs");
assertIncludes(sampleGeneratorScript, "assertQuarantineOutDir", "scripts/project-dna/generate-sample.mjs");
assertIncludes(sampleGeneratorScript, "source_files_copied: false", "scripts/project-dna/generate-sample.mjs");
assertIncludes(sampleGeneratorScript, "source_project_modified: false", "scripts/project-dna/generate-sample.mjs");
assertIncludes(sampleGeneratorScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/generate-sample.mjs");

const sampleValidatorScript = requireFile("scripts/project-dna/validate-sample-project.mjs");
assertIncludes(sampleValidatorScript, "quarantine_only", "scripts/project-dna/validate-sample-project.mjs");
assertIncludes(sampleValidatorScript, "node --check", "scripts/project-dna/validate-sample-project.mjs");
assertIncludes(sampleValidatorScript, "source_project_modified: false", "scripts/project-dna/validate-sample-project.mjs");
assertIncludes(sampleValidatorScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/validate-sample-project.mjs");

const queryScript = requireFile("scripts/project-dna/query-context.mjs");
assertIncludes(queryScript, "query_stored: false", "scripts/project-dna/query-context.mjs");
assertIncludes(queryScript, "query_steward", "scripts/project-dna/query-context.mjs");
assertIncludes(queryScript, "bounded_context_only", "scripts/project-dna/query-context.mjs");
assertIncludes(queryScript, "agent_loads_entire_project: false", "scripts/project-dna/query-context.mjs");
assertIncludes(queryScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/query-context.mjs");

const runtimeProjectDna = requireFile(".pi/extensions/zob-harness/src/project-dna.ts");
assertIncludes(runtimeProjectDna, "zob.project-dna-agentic-plan.v1", ".pi/extensions/zob-harness/src/project-dna.ts");
assertIncludes(runtimeProjectDna, "zob.project-dna-query-result.v1", ".pi/extensions/zob-harness/src/project-dna.ts");
assertIncludes(runtimeProjectDna, "zob.project-dna-federated-query-result.v1", ".pi/extensions/zob-harness/src/project-dna.ts");
assertIncludes(runtimeProjectDna, "knowledge_backend_write_enabled: false", ".pi/extensions/zob-harness/src/project-dna.ts");
assertIncludes(runtimeProjectDna, "durable_promotion_allowed: false", ".pi/extensions/zob-harness/src/project-dna.ts");

const runtimeProjectDnaTools = requireFile(".pi/extensions/zob-harness/src/runtime/tools-project-dna.ts");
assertIncludes(runtimeProjectDnaTools, "zob_project_dna_plan_workflow", ".pi/extensions/zob-harness/src/runtime/tools-project-dna.ts");
assertIncludes(runtimeProjectDnaTools, "zob_project_dna_query", ".pi/extensions/zob-harness/src/runtime/tools-project-dna.ts");
assertIncludes(runtimeProjectDnaTools, "zob_project_dna_federated_query", ".pi/extensions/zob-harness/src/runtime/tools-project-dna.ts");
assertIncludes(runtimeProjectDnaTools, "zob_project_dna_writeback_proposal", ".pi/extensions/zob-harness/src/runtime/tools-project-dna.ts");

const ontologyEmitterScript = requireFile("scripts/project-dna/emit-ontology.mjs");
assertIncludes(ontologyEmitterScript, "zob.project-dna-ontology-emission.v1", "scripts/project-dna/emit-ontology.mjs");
const ontologyValidatorScript = requireFile("scripts/project-dna/validate-ontology.mjs");
assertIncludes(ontologyValidatorScript, "zob.project-dna-ontology-validation.v1", "scripts/project-dna/validate-ontology.mjs");
const goldenEmitterScript = requireFile("scripts/project-dna/emit-golden-cases.mjs");
assertIncludes(goldenEmitterScript, "zob.project-dna-golden-cases-emission.v1", "scripts/project-dna/emit-golden-cases.mjs");
const goldenValidatorScript = requireFile("scripts/project-dna/validate-golden-cases.mjs");
assertIncludes(goldenValidatorScript, "zob.project-dna-golden-suite-validation.v1", "scripts/project-dna/validate-golden-cases.mjs");
const queryStewardScript = requireFile("scripts/project-dna/query-steward.mjs");
assertIncludes(queryStewardScript, "zob.project-dna-query-steward-report.v1", "scripts/project-dna/query-steward.mjs");
const fiveOfFiveValidatorScript = requireFile("scripts/project-dna/validate-5of5.mjs");
assertIncludes(fiveOfFiveValidatorScript, "zob.project-dna-5of5-validation.v1", "scripts/project-dna/validate-5of5.mjs");

const benchScript = requireFile("scripts/project-dna/bench-smoke.mjs");
assertIncludes(benchScript, "golden-agentic-5of5-smoke", "scripts/project-dna/bench-smoke.mjs");
assertIncludes(benchScript, "llm_judge_used: false", "scripts/project-dna/bench-smoke.mjs");
assertIncludes(benchScript, "promotion_allowed: false", "scripts/project-dna/bench-smoke.mjs");
assertIncludes(benchScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/bench-smoke.mjs");

const oracleReviewScript = requireFile("scripts/project-dna/oracle-review-smoke.mjs");
assertIncludes(oracleReviewScript, "durable_promotion_allowed: false", "scripts/project-dna/oracle-review-smoke.mjs");
assertIncludes(oracleReviewScript, "writeback_policy: \"proposal_only\"", "scripts/project-dna/oracle-review-smoke.mjs");
assertIncludes(oracleReviewScript, "knowledge_backend_write_enabled: false", "scripts/project-dna/oracle-review-smoke.mjs");

const result = {
  schema: "zob.project-dna-scaffold-validation.v1",
  valid: errors.length === 0,
  checkedFiles: requiredFiles.map((path) => rel(join(repoRoot, path))),
  errors,
  warnings,
  noExternalProjectScanned: true,
  sourceProjectModified: false,
  knowledgeBackendWriteEnabled: false,
};

console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exit(1);
