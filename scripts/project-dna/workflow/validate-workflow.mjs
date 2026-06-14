#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();
const profiles = new Set(["low", "medium", "high", "xhigh", "max"]);
const semanticCaptureModes = new Set(["full_capture", "architecture_only", "targeted_capture", "sample_first", "context_only"]);
const rawKeyDenylist = new Set(["body", "prompt", "output", "content", "diff", "patch"]);

function usage() {
  console.error("Usage: node scripts/project-dna/validate-workflow.mjs --plan .pi/reports/project-dna-scans/project-dna-factory-smoke/agentic-plan.json [--manifest .pi/factories/project-dna/example-project-dna-manifest-v2.json]");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan" || arg === "--workflow") args.plan = argv[++index];
    else if (arg === "--manifest") args.manifest = argv[++index];
    else if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.plan) throw new Error("--plan is required");
  return args;
}

function repoPath(path, label) {
  if (!path || isAbsolute(path)) throw new Error(`${label} must be repo-relative`);
  const resolved = resolve(repoRoot, path);
  const root = resolve(repoRoot);
  const rel = relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} must stay inside repo and not be repo root: ${path}`);
  return resolved;
}

function assertNoRawKeys(value, errors, trail = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertNoRawKeys(value[index], errors, [...trail, String(index)]);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (rawKeyDenylist.has(key.toLowerCase())) errors.push(`raw key forbidden: ${[...trail, key].join(".")}`);
    assertNoRawKeys(child, errors, [...trail, key]);
  }
}

function mustBe(value, expected, label, errors) {
  if (value !== expected) errors.push(`${label} must be ${expected}`);
}

function validatePlan(plan) {
  const errors = [];
  assertNoRawKeys(plan, errors);
  if (plan.schema !== "zob.project-dna-agentic-plan.v1") errors.push("plan schema must be zob.project-dna-agentic-plan.v1");
  if (typeof plan.runId !== "string" || !/^[A-Za-z0-9._-]+$/.test(plan.runId)) errors.push("runId must be a safe id");
  if (typeof plan.sourceId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(plan.sourceId)) errors.push("sourceId must be safe kebab id");
  if (!profiles.has(plan.effectiveComputeProfile)) errors.push("effectiveComputeProfile invalid");
  if (!semanticCaptureModes.has(plan.requestedCaptureMode)) errors.push("requestedCaptureMode invalid");
  if (!semanticCaptureModes.has(plan.effectiveCaptureMode)) errors.push("effectiveCaptureMode invalid");
  if (!Array.isArray(plan.targetedDomains)) errors.push("targetedDomains must be an array");
  if (!plan.repoStats || typeof plan.repoStats !== "object" || Array.isArray(plan.repoStats)) errors.push("repoStats metadata object required");
  mustBe(plan.metadataOnly, true, "metadataOnly", errors);
  mustBe(plan.parentOwnedDispatch, true, "parentOwnedDispatch", errors);
  mustBe(plan.childDirectDispatch, false, "childDirectDispatch", errors);
  mustBe(plan.liveDispatchEnabled, false, "liveDispatchEnabled", errors);
  mustBe(plan.noExecution, true, "noExecution", errors);
  mustBe(plan.networkAccessed, false, "networkAccessed", errors);
  mustBe(plan.sourceProjectModified, false, "sourceProjectModified", errors);
  mustBe(plan.sourceMutationAllowed, false, "sourceMutationAllowed", errors);
  mustBe(plan.knowledgeBackendWriteEnabled, false, "knowledgeBackendWriteEnabled", errors);
  mustBe(plan.durablePromotionAllowed, false, "durablePromotionAllowed", errors);
  mustBe(plan.rawBodiesStored, false, "rawBodiesStored", errors);
  mustBe(plan.promptBodiesStored, false, "promptBodiesStored", errors);
  mustBe(plan.resultBodiesStored, false, "resultBodiesStored", errors);
  mustBe(plan.bodyFreePlan, true, "bodyFreePlan", errors);
  if (plan.promotionPolicy !== "proposal_only") errors.push("promotionPolicy must be proposal_only");
  if (!Array.isArray(plan.artifactTargets) || plan.artifactTargets.length < 1) errors.push("artifactTargets must be non-empty");
  for (const artifact of plan.artifactTargets ?? []) {
    if (typeof artifact !== "string" || artifact.includes("/") || artifact.includes("\\") || artifact.includes("..")) errors.push(`artifactTargets entry must be safe basename: ${artifact}`);
  }
  if (!Array.isArray(plan.lanes) || plan.lanes.length < 1) errors.push("lanes must be non-empty");
  const laneIds = new Set();
  for (const [index, lane] of (plan.lanes ?? []).entries()) {
    if (typeof lane.id !== "string" || !/^[a-z0-9_]+$/.test(lane.id)) errors.push(`lane ${index} id invalid`);
    if (laneIds.has(lane.id)) errors.push(`duplicate lane id: ${lane.id}`);
    laneIds.add(lane.id);
    if (!["p0", "p1"].includes(lane.phase)) errors.push(`lane ${index} phase must be p0 or p1`);
    if (!Number.isInteger(lane.order) || lane.order < 1) errors.push(`lane ${index} order invalid`);
    if (typeof lane.agent !== "string" || !/^[a-z0-9._-]+$/.test(lane.agent)) errors.push(`lane ${index} agent invalid`);
    if (!Number.isInteger(lane.maxWorkers) || lane.maxWorkers < 1 || lane.maxWorkers > 8) errors.push(`lane ${index} maxWorkers must be 1..8`);
    if (!Array.isArray(lane.toolHints) || lane.toolHints.length < 1) errors.push(`lane ${index} toolHints required`);
    for (const tool of lane.toolHints ?? []) {
      if (!["read", "grep", "find", "ls", "bash"].includes(tool)) errors.push(`lane ${index} tool not allowed: ${tool}`);
    }
    mustBe(lane.parentOwnedDispatch, true, `lane ${index} parentOwnedDispatch`, errors);
    mustBe(lane.childDirectDispatch, false, `lane ${index} childDirectDispatch`, errors);
    mustBe(lane.liveDispatchEnabled, false, `lane ${index} liveDispatchEnabled`, errors);
    mustBe(lane.sourceMutationAllowed, false, `lane ${index} sourceMutationAllowed`, errors);
    mustBe(lane.backendWritesEnabled, false, `lane ${index} backendWritesEnabled`, errors);
    mustBe(lane.durablePromotionAllowed, false, `lane ${index} durablePromotionAllowed`, errors);
    mustBe(lane.storesRawBodies, false, `lane ${index} storesRawBodies`, errors);
  }
  if (!laneIds.has("manifest_preflight")) errors.push("lanes must include manifest_preflight");
  if (!laneIds.has("read_only_scan")) errors.push("lanes must include read_only_scan");
  if (!laneIds.has("scan_validation")) errors.push("lanes must include scan_validation");
  mustBe(plan.safetyAssertions?.sourceReadOnly, true, "safetyAssertions.sourceReadOnly", errors);
  mustBe(plan.safetyAssertions?.forbiddenPathsExcluded, true, "safetyAssertions.forbiddenPathsExcluded", errors);
  mustBe(plan.safetyAssertions?.secretLikePathsForbidden, true, "safetyAssertions.secretLikePathsForbidden", errors);
  mustBe(plan.safetyAssertions?.externalKnowledgeBackendDisabled, true, "safetyAssertions.externalKnowledgeBackendDisabled", errors);
  mustBe(plan.safetyAssertions?.durablePromotionRequiresHumanApproval, true, "safetyAssertions.durablePromotionRequiresHumanApproval", errors);
  mustBe(plan.safetyAssertions?.citationsRequired, true, "safetyAssertions.citationsRequired", errors);
  mustBe(plan.safetyAssertions?.boundedContextOnly, true, "safetyAssertions.boundedContextOnly", errors);
  return errors;
}

function validateManifest(manifest, plan) {
  const errors = [];
  assertNoRawKeys(manifest, errors, ["manifest"]);
  if (manifest.schema !== "zob.project-dna-manifest.v2") errors.push("manifest schema must be zob.project-dna-manifest.v2");
  if (manifest.run_id !== plan.runId) errors.push("manifest run_id must match plan runId");
  if (manifest.source_project?.source_id !== plan.sourceId) errors.push("manifest source_project.source_id must match plan sourceId");
  if (!semanticCaptureModes.has(manifest.capture_mode_policy?.semantic_mode)) errors.push("manifest semantic capture mode invalid");
  if (manifest.capture_mode_policy?.semantic_mode !== plan.requestedCaptureMode) errors.push("manifest semantic_mode must match plan requestedCaptureMode");
  if (manifest.capture_mode_policy?.metadata_only !== true) errors.push("manifest capture_mode_policy.metadata_only must be true");
  if (manifest.capture_mode_policy?.child_direct_dispatch_allowed !== false) errors.push("manifest child direct dispatch must be false");
  if (manifest.capture_mode_policy?.source_mutation_allowed !== false) errors.push("manifest source mutation must be false");
  if (manifest.capture_mode_policy?.knowledge_backend_write_allowed !== false) errors.push("manifest backend writes must be false");
  if (manifest.promotion?.writeback_policy !== "proposal_only") errors.push("manifest promotion must be proposal_only");
  if (manifest.promotion?.durable_promotion_allowed !== false) errors.push("manifest durable promotion must be false");
  return errors;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const planPath = repoPath(args.plan, "--plan");
  if (!existsSync(planPath)) throw new Error(`missing plan: ${args.plan}`);
  const normalizedPlan = args.plan.split(sep).join("/");
  if (!normalizedPlan.startsWith(".pi/reports/project-dna-scans/") && !normalizedPlan.startsWith("reports/project-dna-scans/")) throw new Error("--plan must be under .pi/reports/project-dna-scans or legacy reports/project-dna-scans");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  let errors = validatePlan(plan);
  if (args.manifest) {
    const manifestPath = repoPath(args.manifest, "--manifest");
    if (!existsSync(manifestPath)) throw new Error(`missing manifest: ${args.manifest}`);
    errors = errors.concat(validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), plan));
  }
  const result = {
    schema: "zob.project-dna-agentic-plan-validation.v1",
    valid: errors.length === 0,
    errors,
    planPath: normalizedPlan,
    metadataOnly: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    sourceProjectModified: false,
    knowledgeBackendWriteEnabled: false,
    durablePromotionAllowed: false,
    rawBodiesStored: false
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
