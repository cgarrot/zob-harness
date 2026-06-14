#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();
const profiles = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
const semanticCaptureModes = new Set(["full_capture", "architecture_only", "targeted_capture", "sample_first", "context_only"]);
const rawKeyDenylist = new Set(["body", "prompt", "output", "content", "diff", "patch"]);

function usage() {
  console.error("Usage: node scripts/project-dna/plan-workflow.mjs --manifest .pi/factories/project-dna/example-project-dna-manifest-v2.json [--scan-dir .pi/reports/project-dna-scans/project-dna-factory-smoke] --out .pi/reports/project-dna-scans/project-dna-factory-smoke/agentic-plan.json");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index];
    else if (arg === "--scan-dir") args.scanDir = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.manifest || !args.out) throw new Error("--manifest and --out are required");
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

function assertReportPath(path, label) {
  const normalized = path.split(sep).join("/");
  if (!normalized.startsWith(".pi/reports/project-dna-scans/") && !normalized.startsWith("reports/project-dna-scans/")) throw new Error(`${label} must stay under .pi/reports/project-dna-scans or legacy reports/project-dna-scans: ${path}`);
}

function isInsideOrEqual(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertNotBroadPath(path, label) {
  const resolved = resolve(path);
  if (["/", "/home", "/home/ubuntu"].includes(resolved)) throw new Error(`refusing broad ${label}: ${path}`);
}

function inputPath(path, label) {
  if (!path) throw new Error(`${label} is required`);
  const resolved = isAbsolute(path) ? resolve(path) : repoPath(path, label);
  assertNotBroadPath(resolved, label);
  return resolved;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertNoRawKeys(value, trail = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertNoRawKeys(value[index], [...trail, String(index)]);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (rawKeyDenylist.has(key.toLowerCase())) throw new Error(`raw key forbidden in plan metadata: ${[...trail, key].join(".")}`);
    assertNoRawKeys(child, [...trail, key]);
  }
}

function requireBoolean(value, expected, label, errors) {
  if (value !== expected) errors.push(`${label} must be ${expected}`);
}

function validateManifest(manifest) {
  const errors = [];
  if (manifest.schema !== "zob.project-dna-manifest.v2") errors.push("manifest schema must be zob.project-dna-manifest.v2");
  if (typeof manifest.run_id !== "string" || !/^[A-Za-z0-9._-]+$/.test(manifest.run_id)) errors.push("run_id must be a safe id");
  if (typeof manifest.user_note !== "string" || manifest.user_note.length < 1) errors.push("user_note is required");
  if (typeof manifest.capture_goal?.objective !== "string" || manifest.capture_goal.objective.length < 1) errors.push("capture_goal.objective is required");
  requireBoolean(manifest.capture_goal?.bounded_context_only, true, "capture_goal.bounded_context_only", errors);
  requireBoolean(manifest.capture_goal?.citation_required, true, "capture_goal.citation_required", errors);
  if (!profiles.has(manifest.requested_compute_profile)) errors.push("requested_compute_profile invalid");
  if (!semanticCaptureModes.has(manifest.capture_mode_policy?.semantic_mode)) errors.push("capture_mode_policy.semantic_mode invalid");
  if (manifest.capture_mode_policy?.large_repo_fallback !== undefined && !["architecture_only", "targeted_capture", "sample_first", "context_only"].includes(manifest.capture_mode_policy.large_repo_fallback)) errors.push("capture_mode_policy.large_repo_fallback invalid");
  requireBoolean(manifest.capture_mode_policy?.metadata_only, true, "capture_mode_policy.metadata_only", errors);
  requireBoolean(manifest.capture_mode_policy?.parent_owned_dispatch, true, "capture_mode_policy.parent_owned_dispatch", errors);
  requireBoolean(manifest.capture_mode_policy?.child_direct_dispatch_allowed, false, "capture_mode_policy.child_direct_dispatch_allowed", errors);
  requireBoolean(manifest.capture_mode_policy?.network_access_allowed, false, "capture_mode_policy.network_access_allowed", errors);
  requireBoolean(manifest.capture_mode_policy?.source_mutation_allowed, false, "capture_mode_policy.source_mutation_allowed", errors);
  requireBoolean(manifest.capture_mode_policy?.knowledge_backend_write_allowed, false, "capture_mode_policy.knowledge_backend_write_allowed", errors);
  if (manifest.capture_mode_policy?.durable_promotion_allowed !== undefined) requireBoolean(manifest.capture_mode_policy.durable_promotion_allowed, false, "capture_mode_policy.durable_promotion_allowed", errors);
  if (typeof manifest.source_project?.source_id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(manifest.source_project.source_id)) errors.push("source_project.source_id invalid");
  if (manifest.capture_goal?.source_id !== manifest.source_project?.source_id) errors.push("capture_goal.source_id must match source_project.source_id");
  if (typeof manifest.source_project?.path !== "string" || manifest.source_project.path.length < 1) errors.push("source_project.path is required");
  if (!Array.isArray(manifest.read_policy?.allowed_paths) || manifest.read_policy.allowed_paths.length < 1) errors.push("read_policy.allowed_paths required");
  if (!Array.isArray(manifest.read_policy?.forbidden_patterns) || manifest.read_policy.forbidden_patterns.length < 1) errors.push("read_policy.forbidden_patterns required");
  requireBoolean(manifest.read_policy?.forbid_secret_like_paths, true, "read_policy.forbid_secret_like_paths", errors);
  requireBoolean(manifest.read_policy?.external_project_scan_allowed, false, "read_policy.external_project_scan_allowed", errors);
  requireBoolean(manifest.sample_project?.quarantine_required, true, "sample_project.quarantine_required", errors);
  if (manifest.sample_project?.generation_policy !== "plan_only" && manifest.sample_project?.generation_policy !== "quarantine_only") errors.push("sample_project.generation_policy invalid");
  if (manifest.promotion?.writeback_policy !== "proposal_only") errors.push("promotion.writeback_policy must be proposal_only");
  requireBoolean(manifest.promotion?.requires_oracle_pass, true, "promotion.requires_oracle_pass", errors);
  requireBoolean(manifest.promotion?.requires_human_approval, true, "promotion.requires_human_approval", errors);
  requireBoolean(manifest.promotion?.durable_promotion_allowed, false, "promotion.durable_promotion_allowed", errors);
  return errors;
}

function effectiveProfile(requested) {
  if (requested === "auto") return "medium";
  return profiles.has(requested) ? requested : "low";
}

function readOptionalScanSummary(scanDir) {
  if (!scanDir) return {};
  const summaryPath = repoPath(`${scanDir.replace(/\/$/, "")}/scan-summary.json`, "scan-summary");
  if (!existsSync(summaryPath)) return {};
  const parsed = JSON.parse(readFileSync(summaryPath, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function deriveCaptureMode(manifest, profile, scanSummary) {
  const requested = manifest.capture_mode_policy?.semantic_mode;
  const fallback = manifest.capture_mode_policy?.large_repo_fallback ?? "architecture_only";
  const fileCount = Number(scanSummary.files_scanned ?? 0);
  const intent = `${manifest.user_note ?? ""} ${manifest.capture_goal?.objective ?? ""}`.toLowerCase();
  if (requested && requested !== "full_capture") return requested;
  if (/\b(sample|exemple|example|neutral)\b/.test(intent)) return "sample_first";
  if (/\b(context|query|lookup|retrieval)\b/.test(intent)) return "context_only";
  if (/\b(architecture|archi|structure|scaffold)\b/.test(intent)) return "architecture_only";
  if (fileCount >= 1000 || profile === "xhigh" || profile === "max") return fallback;
  return requested ?? "full_capture";
}

function laneCatalog(profile) {
  const base = [
    { id: "manifest_preflight", phase: "p0", agent: "project-dna-safety-preflight", artifactContract: "safety-metadata.v1", toolHints: ["read"], required: true },
    { id: "repo_scout", phase: "p0", agent: "repo-scout", artifactContract: "repo-complexity-report.v1", toolHints: ["read", "grep", "find", "ls"], required: true },
    { id: "read_only_scan", phase: "p1", agent: "agent", artifactContract: "scan-metadata.v1", toolHints: ["read", "grep", "find", "ls"], required: true },
    { id: "scan_validation", phase: "p1", agent: "qa", artifactContract: "validation-metadata.v1", toolHints: ["read", "bash"], required: true }
  ];
  if (["medium", "high", "xhigh", "max"].includes(profile)) base.push(
    { id: "ontology_curation", phase: "p1", agent: "project-dna-ontology-steward", artifactContract: "ontology-metadata.v1", toolHints: ["read", "grep", "find", "ls"], required: true },
    { id: "architecture_cartography", phase: "p1", agent: "architecture-cartographer", artifactContract: "architecture-map.v2", toolHints: ["read", "grep", "find", "ls"], required: true },
    { id: "pattern_mining", phase: "p1", agent: "pattern-miner", artifactContract: "pattern-index.partial.v1", toolHints: ["read", "grep", "find", "ls"], required: true },
    { id: "test_linking", phase: "p1", agent: "project-dna-test-linker", artifactContract: "test-link-metadata.v1", toolHints: ["read", "grep", "find", "ls"], required: true },
    { id: "capsule_build", phase: "p1", agent: "context-steward", artifactContract: "capsule-pointer-metadata.v1", toolHints: ["read"], required: true },
    { id: "sample_spec", phase: "p1", agent: "sample-architect", artifactContract: "sample-spec-metadata.v1", toolHints: ["read"], required: true },
    { id: "query_steward_review", phase: "p1", agent: "project-dna-query-steward", artifactContract: "query-steward-report.v1", toolHints: ["read", "grep", "find", "ls"], required: true },
    { id: "bounded_query", phase: "p1", agent: "context-steward", artifactContract: "context-pack-metadata.v1", toolHints: ["read"], required: true }
  );
  if (["high", "xhigh", "max"].includes(profile)) base.push(
    { id: "symbol_range_curation", phase: "p1", agent: "symbol-range-curator", artifactContract: "range-quality-report.v1", toolHints: ["read", "grep", "find", "ls"], required: true },
    { id: "quarantine_sample", phase: "p1", agent: "implementer", artifactContract: "quarantine-sample-metadata.v1", toolHints: ["read", "bash"], required: false },
    { id: "golden_case_benchmark", phase: "p1", agent: "project-dna-golden-evaluator", artifactContract: "golden-benchmark-metadata.v1", toolHints: ["read", "bash"], required: true },
    { id: "benchmark", phase: "p1", agent: "qa", artifactContract: "benchmark-metadata.v1", toolHints: ["read", "bash"], required: false },
    { id: "oracle_review", phase: "p1", agent: "project-dna-oracle", artifactContract: "oracle-metadata.v1", toolHints: ["read", "grep", "find", "ls"], required: true }
  );
  if (["xhigh", "max"].includes(profile)) base.push({ id: "adversarial_safety_review", phase: "p1", agent: "project-dna-oracle", artifactContract: "oracle-metadata.v1", toolHints: ["read", "grep", "find", "ls"], required: true });
  if (profile === "max") base.push({ id: "human_promotion_packet", phase: "p1", agent: "planner", artifactContract: "proposal-metadata.v1", toolHints: ["read"], required: true });
  return base;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = repoPath(args.manifest, "--manifest");
  if (!existsSync(manifestPath)) throw new Error(`missing manifest: ${args.manifest}`);
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assertNoRawKeys(manifest);
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length > 0) throw new Error(`manifest validation failed: ${manifestErrors.join("; ")}`);

  const sourcePath = inputPath(manifest.source_project.path, "source_project.path");
  if (!existsSync(sourcePath)) throw new Error(`source_project.path does not exist: ${manifest.source_project.path}`);
  const allowedPaths = manifest.read_policy.allowed_paths.map((allowedPath) => {
    const allowed = inputPath(allowedPath, "read_policy.allowed_paths[]");
    if (!existsSync(allowed)) throw new Error(`read_policy.allowed_paths entry does not exist: ${allowedPath}`);
    return allowed;
  });
  if (!allowedPaths.some((allowed) => isInsideOrEqual(allowed, sourcePath))) throw new Error("source_project.path must be inside one read_policy.allowed_paths entry");
  if (args.scanDir) {
    assertReportPath(args.scanDir, "--scan-dir");
    repoPath(args.scanDir, "--scan-dir");
  }
  assertReportPath(args.out, "--out");
  const outPath = repoPath(args.out, "--out");
  const profile = effectiveProfile(manifest.requested_compute_profile);
  const scanSummary = readOptionalScanSummary(args.scanDir);
  const effectiveCapture = deriveCaptureMode(manifest, profile, scanSummary);
  const caps = manifest.compute_caps ?? {};
  const maxParallel = Math.max(1, Math.min(Number(caps.maxParallel ?? 1), Number(caps.maxAgents ?? 1), 8));
  const lanes = laneCatalog(profile).map((lane, index) => ({
    ...lane,
    order: index + 1,
    maxWorkers: Math.min(maxParallel, lane.id === "read_only_scan" ? 2 : 1),
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    liveDispatchEnabled: false,
    sourceMutationAllowed: false,
    backendWritesEnabled: false,
    durablePromotionAllowed: false,
    storesRawBodies: false
  }));
  const plan = {
    schema: "zob.project-dna-agentic-plan.v1",
    runId: manifest.run_id,
    sourceId: manifest.source_project.source_id,
    manifestPath: args.manifest,
    manifestHash: sha256(manifestText),
    manifestEmbedded: false,
    scanDir: args.scanDir ?? `.pi/reports/project-dna-scans/${manifest.run_id}`,
    requestedComputeProfile: manifest.requested_compute_profile,
    effectiveComputeProfile: profile,
    requestedCaptureMode: manifest.capture_mode_policy.semantic_mode,
    effectiveCaptureMode: effectiveCapture,
    captureModeRationale: "derived_from_manifest_user_note_profile_and_optional_scan_summary",
    targetedDomains: Array.isArray(manifest.capture_mode_policy.targeted_domains) ? manifest.capture_mode_policy.targeted_domains : [],
    repoStats: {
      filesScanned: Number.isFinite(Number(scanSummary.files_scanned)) ? Number(scanSummary.files_scanned) : null,
      filesSkipped: Number.isFinite(Number(scanSummary.files_skipped)) ? Number(scanSummary.files_skipped) : null,
      scanSummaryAvailable: Object.keys(scanSummary).length > 0
    },
    objectiveHash: sha256(manifest.capture_goal.objective),
    metadataOnly: true,
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    liveDispatchEnabled: false,
    noExecution: true,
    networkAccessed: false,
    sourceProjectModified: false,
    sourceMutationAllowed: false,
    knowledgeBackendWriteEnabled: false,
    durablePromotionAllowed: false,
    rawBodiesStored: false,
    promptBodiesStored: false,
    resultBodiesStored: false,
    bodyFreePlan: true,
    dispatchPosture: "parent_owned_no_child_direct_dispatch",
    promotionPolicy: "proposal_only",
    artifactTargets: [
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
      "ontology.json",
      "golden-cases-smoke.json",
      "query-steward-smoke.json",
      "code-knowledge-graph.json",
      "context-pack-smoke.json"
    ],
    lanes,
    safetyAssertions: {
      sourceReadOnly: true,
      forbiddenPathsExcluded: true,
      secretLikePathsForbidden: true,
      externalKnowledgeBackendDisabled: true,
      durablePromotionRequiresHumanApproval: true,
      citationsRequired: true,
      boundedContextOnly: true
    },
    blockers: [],
    generatedAt: new Date().toISOString()
  };
  assertNoRawKeys(plan);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ schema: "zob.project-dna-agentic-plan-cli.v1", planPath: relative(repoRoot, outPath).split(sep).join("/"), effectiveComputeProfile: profile, effectiveCaptureMode: effectiveCapture, laneCount: lanes.length, metadataOnly: true, childDispatchAllowed: false }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
