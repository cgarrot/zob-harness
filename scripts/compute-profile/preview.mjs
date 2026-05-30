#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const PROFILES = ["low", "medium", "high", "xhigh", "max"];
const REQUESTED = ["auto", ...PROFILES];
const DOMAINS = ["generic", "project-dna", "factory", "orchestration"];
const MAX_PREVIEW_FILES = 5000;
const forbiddenNames = new Set([".env", ".git", ".npmrc", ".ssh", ".aws", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", "out", "vendor", "generated"]);
const generatedNames = new Set(["node_modules", "dist", "build", "coverage", ".next", ".nuxt", "out", "vendor", "generated"]);
const secretPatterns = [/\.env(?:\..*)?$/i, /secret/i, /credential/i, /(?:^|[-_])key(?:[-_.]|$)/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /^id_rsa$/i, /^id_ed25519$/i];
const languageExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".cs", ".rb", ".php", ".swift", ".vue", ".svelte"]);

const defaultCaps = {
  low: { maxAgents: 1, maxDelegationDepth: 0, maxParallel: 1, maxIterations: 1, maxDurationMs: 120000, maxCostUsd: 0.25, maxContextTokens: 3000, strictBudgetRequired: false, oracleRequired: false, validationLevel: "narrow", oraclePolicy: "off_unless_risky", benchmarkLevel: "none" },
  medium: { maxAgents: 4, maxDelegationDepth: 1, maxParallel: 2, maxIterations: 2, maxDurationMs: 300000, maxCostUsd: 1, maxContextTokens: 6000, strictBudgetRequired: false, oracleRequired: false, validationLevel: "targeted", oraclePolicy: "conditional", benchmarkLevel: "smoke" },
  high: { maxAgents: 10, maxDelegationDepth: 2, maxParallel: 4, maxIterations: 3, maxDurationMs: 600000, maxCostUsd: 5, maxContextTokens: 12000, strictBudgetRequired: true, oracleRequired: true, validationLevel: "full_local", oraclePolicy: "required_for_completion", benchmarkLevel: "smoke_plus_targeted_cases" },
  xhigh: { maxAgents: 20, maxDelegationDepth: 3, maxParallel: 6, maxIterations: 4, maxDurationMs: 1200000, maxCostUsd: 15, maxContextTokens: 20000, strictBudgetRequired: true, oracleRequired: true, validationLevel: "full_plus_adversarial", oraclePolicy: "required_with_no_ship_gate", benchmarkLevel: "suite" },
  max: { maxAgents: 30, maxDelegationDepth: 4, maxParallel: 8, maxIterations: 5, maxDurationMs: 3600000, maxCostUsd: 50, maxContextTokens: 32000, strictBudgetRequired: true, oracleRequired: true, validationLevel: "exhaustive_within_scope", oraclePolicy: "required_multiple_oracle_lanes", benchmarkLevel: "suite_plus_regression" },
};

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function clamp01(value) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function safeStem(value) { return String(value || "compute-profile").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "compute-profile"; }
function usage() {
  console.error(`Usage: node scripts/compute-profile/preview.mjs --domain project-dna --path .pi/factories/project-dna --requested auto --out reports/.../compute-preview.json [--resolution-out reports/.../compute-profile-resolution.json]`);
}
function parseArgs(argv) {
  const out = { requested: "auto", domain: "generic", riskHints: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--domain") out.domain = next();
    else if (arg === "--path" || arg === "--target-path") out.path = next();
    else if (arg === "--requested" || arg === "--requested-profile") out.requested = next();
    else if (arg === "--max-profile") out.maxProfile = next();
    else if (arg === "--task-hash") out.taskHash = next();
    else if (arg === "--run-id") out.runId = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--resolution-out") out.resolutionOut = next();
    else if (arg === "--risk-hint") out.riskHints.push(next());
    else if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.out) throw new Error("--out is required");
  if (!out.path) out.path = ".";
  out.domain = DOMAINS.includes(out.domain) ? out.domain : "generic";
  out.requested = REQUESTED.includes(out.requested) ? out.requested : "auto";
  out.maxProfile = PROFILES.includes(out.maxProfile) ? out.maxProfile : undefined;
  return out;
}
function insideRepo(requestedPath) {
  const resolved = resolve(repoRoot, requestedPath);
  const root = resolve(repoRoot);
  return { resolved, errors: resolved === root || resolved.startsWith(`${root}/`) ? [] : [`Path must stay inside repo root: ${requestedPath}`] };
}
function forbidden(name) { return forbiddenNames.has(name) || secretPatterns.some((pattern) => pattern.test(name)); }
function isTest(file) { return /(^|\/)(__tests__|test|tests|spec)(\/|$)/i.test(file) || /\.(test|spec)\.[cm]?[tj]sx?$/i.test(file); }
function isDocs(file) { return /(^|\/)(docs?|documentation)(\/|$)/i.test(file) || /(^|\/)(readme|architecture|design|guide)[^/]*\.md$/i.test(file); }
function isExample(file) { return /(^|\/)(examples?|samples?)(\/|$)/i.test(file); }
function isConfig(file) { return /(^|\/)(package\.json|tsconfig\.json|vite\.config\.|next\.config\.|eslint\.|prettier\.|tailwind\.|factory\.json|.*\.schema\.json)$/i.test(file); }
function emptyStats(exists, kind, errors = []) {
  return { exists, targetKind: kind, fileCount: 0, directoryCount: 0, skippedCount: 0, totalBytesEstimate: 0, extensionCounts: {}, languageCount: 0, packageManifestCount: 0, workspaceIndicatorCount: 0, testFileCount: 0, docsFileCount: 0, exampleFileCount: 0, configFileCount: 0, forbiddenVisibleCount: 0, generatedVendorSkippedCount: 0, maxFilesReached: false, errors };
}
function collectStats(targetPath) {
  const checked = insideRepo(targetPath);
  if (checked.errors.length) return emptyStats(false, "missing", checked.errors);
  if (!existsSync(checked.resolved)) return emptyStats(false, "missing", [`target_path does not exist: ${targetPath}`]);
  const root = resolve(repoRoot);
  const stats = emptyStats(true, checked.resolved === root ? "repo" : "repo_path");
  const targetBase = basename(checked.resolved);
  if (forbidden(targetBase)) {
    stats.skippedCount += 1;
    stats.forbiddenVisibleCount += 1;
    stats.errors.push(`target_path is forbidden and was not scanned: ${targetBase}`);
    return stats;
  }
  function visit(dir) {
    if (stats.fileCount >= MAX_PREVIEW_FILES) { stats.maxFilesReached = true; return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { stats.errors.push(`could not read directory metadata: ${relative(root, dir) || "."}: ${error.message}`); return; }
    for (const entry of entries) {
      if (stats.fileCount >= MAX_PREVIEW_FILES) { stats.maxFilesReached = true; return; }
      const abs = resolve(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (forbidden(entry.name)) {
        stats.skippedCount += 1;
        stats.forbiddenVisibleCount += 1;
        if (generatedNames.has(entry.name)) stats.generatedVendorSkippedCount += 1;
        continue;
      }
      if (entry.isDirectory()) { stats.directoryCount += 1; visit(abs); continue; }
      if (!entry.isFile()) continue;
      stats.fileCount += 1;
      try { stats.totalBytesEstimate += statSync(abs).size; } catch {}
      const ext = extname(entry.name).toLowerCase() || "[no-ext]";
      stats.extensionCounts[ext] = (stats.extensionCounts[ext] || 0) + 1;
      if (entry.name === "package.json") stats.packageManifestCount += 1;
      if (["pnpm-workspace.yaml", "lerna.json", "turbo.json", "nx.json"].includes(entry.name)) stats.workspaceIndicatorCount += 1;
      if (isTest(rel)) stats.testFileCount += 1;
      if (isDocs(rel)) stats.docsFileCount += 1;
      if (isExample(rel)) stats.exampleFileCount += 1;
      if (isConfig(rel)) stats.configFileCount += 1;
    }
  }
  const stat = statSync(checked.resolved);
  if (stat.isDirectory()) visit(checked.resolved);
  else if (stat.isFile()) {
    stats.fileCount = 1;
    stats.totalBytesEstimate = stat.size;
    stats.extensionCounts[extname(checked.resolved).toLowerCase() || "[no-ext]"] = 1;
  }
  stats.languageCount = Object.keys(stats.extensionCounts).filter((ext) => languageExts.has(ext)).length;
  return stats;
}
function score(stats, args) {
  const sourceFiles = Object.entries(stats.extensionCounts).filter(([ext]) => languageExts.has(ext)).reduce((sum, [, count]) => sum + count, 0);
  const sourceFileRatio = stats.fileCount > 0 ? sourceFiles / stats.fileCount : 0;
  const hints = new Set(args.riskHints.map((hint) => hint.toLowerCase()));
  const domainBoost = args.domain === "project-dna" ? 0.15 : 0;
  const size = clamp01((stats.fileCount / 1000) * 0.35 + (stats.packageManifestCount / 20) * 0.25 + (stats.languageCount / 8) * 0.15 + (stats.totalBytesEstimate / 50000000) * 0.25);
  const material = clamp01(sourceFileRatio * 0.25 + Math.min(stats.testFileCount, 50) / 50 * 0.25 + Math.min(stats.docsFileCount, 25) / 25 * 0.15 + Math.min(stats.packageManifestCount, 5) / 5 * 0.15 + Math.min(stats.exampleFileCount, 20) / 20 * 0.10 + Math.min(stats.configFileCount, 20) / 20 * 0.10);
  const complexity = clamp01((stats.packageManifestCount / 10) * 0.30 + (stats.workspaceIndicatorCount / 4) * 0.20 + (stats.languageCount / 8) * 0.25 + (stats.configFileCount / 30) * 0.25);
  const ambiguity = clamp01(args.taskHash ? 0.15 : 0.30);
  const risk = clamp01((stats.forbiddenVisibleCount > 0 ? 0.20 : 0) + (hints.has("write") || hints.has("apply") ? 0.25 : 0) + (hints.has("network") || hints.has("browser") || hints.has("cloud") ? 0.15 : 0) + (hints.has("promotion") || hints.has("durable") ? 0.20 : 0) + (stats.errors.length > 0 ? 0.10 : 0));
  const novelty = clamp01(args.domain === "generic" ? 0.35 : 0.45 + domainBoost);
  const reuseValue = clamp01((args.domain === "project-dna" || args.domain === "factory" || args.domain === "orchestration" ? 0.55 : 0.30) + domainBoost + Math.min(stats.packageManifestCount, 5) / 5 * 0.20 + Math.min(stats.docsFileCount, 10) / 10 * 0.10);
  const validationNeed = clamp01(Math.max(complexity, risk) * 0.7 + material * 0.3);
  return { size, material, complexity, ambiguity, risk, novelty, reuseValue, validationNeed };
}
function recommend(scores, stats) {
  const qualityNeed = Math.max(scores.complexity, scores.ambiguity, scores.reuseValue, scores.validationNeed);
  const computeWorth = scores.material * scores.reuseValue;
  if (stats.errors.length > 0 && scores.material < 0.15) return "low";
  if (qualityNeed > 0.85 && computeWorth > 0.75) return "xhigh";
  if (qualityNeed > 0.65 && computeWorth > 0.55) return "high";
  if (qualityNeed > 0.35 || stats.fileCount > 25) return "medium";
  return "low";
}
function reasons(stats, scores, domain) {
  const out = [];
  if (domain !== "generic") out.push(`${domain}_domain`);
  if (stats.fileCount >= 500) out.push("large_file_count"); else if (stats.fileCount >= 100) out.push("medium_file_count");
  if (stats.packageManifestCount > 1) out.push("multiple_package_manifests");
  if (stats.workspaceIndicatorCount > 0) out.push("workspace_indicators_present");
  if (stats.testFileCount > 0) out.push("tests_present");
  if (stats.docsFileCount > 0) out.push("docs_present");
  if (stats.forbiddenVisibleCount > 0) out.push("forbidden_paths_visible_but_skipped");
  if (stats.maxFilesReached) out.push("preview_file_cap_reached");
  if (scores.reuseValue >= 0.7) out.push("high_reuse_value");
  if (scores.complexity >= 0.65) out.push("high_complexity");
  return out.length ? out : ["small_or_low_signal_target"];
}
function capProfile(profile, maxProfile) {
  if (!maxProfile) return profile;
  return PROFILES[Math.min(PROFILES.indexOf(profile), PROFILES.indexOf(maxProfile))] || profile;
}
function adaptivePolicyHint(profile) {
  const depth = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }[profile];
  const parallel = { low: 1, medium: 2, high: 4, xhigh: 6, max: 8 }[profile];
  return { schema: "zob.compute-adaptive-policy-hint.v1", profile, enabledByDefault: false, advisoryOnly: profile === "low" || profile === "medium", supervisedReadonlyEligible: profile === "high" || profile === "xhigh" || profile === "max", runtimeMaxDepthHint: depth, globalParallelMaxHint: parallel, parentOwnedDispatch: true, childDirectDispatch: false, liveDispatchEnabled: false, noExecution: true };
}
function build(args) {
  const stats = collectStats(args.path);
  const scores = score(stats, args);
  const recommended = recommend(scores, stats);
  const noShip = !stats.exists || stats.errors.length > 0;
  const preview = {
    schema: "zob.compute-preview.v1",
    runId: args.runId,
    domain: args.domain,
    requestedProfile: args.requested,
    recommendedProfile: recommended,
    confidence: stats.errors.length || stats.maxFilesReached ? "medium" : "high",
    scores,
    reasonCodes: reasons(stats, scores, args.domain),
    target: { targetKind: stats.targetKind, targetPathHash: sha256(args.path || "."), targetPathStored: false, targetBasename: basename(args.path || repoRoot), exists: stats.exists },
    stats: { ...stats, errors: undefined },
    blockers: noShip ? ["preview_metadata_errors_present"] : [],
    errors: stats.errors,
    noShip,
    noExecution: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    sourceProjectModified: false,
    knowledgeBackendWriteEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const requestedEffective = args.requested === "auto" ? recommended : args.requested;
  const effectiveProfile = args.requested === "auto" && recommended === "max" ? capProfile("xhigh", args.maxProfile) : capProfile(requestedEffective, args.maxProfile);
  const resolution = {
    schema: "zob.compute-profile-resolution.v1",
    runId: args.runId,
    domain: args.domain,
    requestedProfile: args.requested,
    recommendedProfile: recommended,
    effectiveProfile,
    confidence: preview.confidence,
    reasonCodes: preview.reasonCodes,
    previewHash: sha256(JSON.stringify(preview)),
    previewEmbedded: false,
    caps: defaultCaps[effectiveProfile],
    gates: { strictBudgetRequired: defaultCaps[effectiveProfile].strictBudgetRequired, oracleRequired: defaultCaps[effectiveProfile].oracleRequired, humanApprovalRequired: effectiveProfile === "max", sandboxRequiredForWrites: true, parentOwnedDispatch: true, childDirectDispatch: false },
    adaptiveDelegationPolicyHint: adaptivePolicyHint(effectiveProfile),
    noShip,
    blockers: preview.blockers,
    noExecution: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    sourceProjectModified: false,
    knowledgeBackendWriteEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  return { preview, resolution };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runId) args.runId = safeStem(`${args.domain}-${args.requested}-preview`);
  const { preview, resolution } = build(args);
  mkdirSync(dirname(resolve(repoRoot, args.out)), { recursive: true });
  writeFileSync(resolve(repoRoot, args.out), JSON.stringify(preview, null, 2), "utf8");
  if (args.resolutionOut) {
    mkdirSync(dirname(resolve(repoRoot, args.resolutionOut)), { recursive: true });
    writeFileSync(resolve(repoRoot, args.resolutionOut), JSON.stringify(resolution, null, 2), "utf8");
  }
  console.log(JSON.stringify({ schema: "zob.compute-profile-preview-cli.v1", previewPath: relative(repoRoot, resolve(repoRoot, args.out)), resolutionPath: args.resolutionOut ? relative(repoRoot, resolve(repoRoot, args.resolutionOut)) : undefined, recommendedProfile: preview.recommendedProfile, effectiveProfile: resolution.effectiveProfile, noShip: preview.noShip }, null, 2));
  if (preview.noShip) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
