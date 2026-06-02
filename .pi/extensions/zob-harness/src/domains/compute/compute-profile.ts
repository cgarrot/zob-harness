import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

import { sha256 } from "../../core/utils/hashing.js";
import { resolveRepoPath, safeFileStem, safeRunId } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";

export type ComputeRequestedProfile = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export type ComputeEffectiveProfile = Exclude<ComputeRequestedProfile, "auto">;
export type ComputeDomain = "generic" | "project-dna" | "factory" | "orchestration";
export type ComputePreviewConfidence = "low" | "medium" | "high";

export interface ComputeCapsInput {
  maxAgents?: number;
  maxDelegationDepth?: number;
  maxParallel?: number;
  maxIterations?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
  maxContextTokens?: number;
  strictBudgetRequired?: boolean;
  oracleRequired?: boolean;
}

export interface ComputePreviewInput {
  runId?: string;
  domain?: ComputeDomain | string;
  requestedProfile?: ComputeRequestedProfile | string;
  targetPath?: string;
  taskHash?: string;
  maxProfile?: ComputeEffectiveProfile | string;
  computeCaps?: ComputeCapsInput;
  riskHints?: string[];
}

export interface ComputeProfileValidationInput {
  previewPath: string;
  resolutionPath?: string;
}

interface ProfileDefaults {
  maxAgents: number;
  maxDelegationDepth: number;
  maxParallel: number;
  maxIterations: number;
  maxDurationMs: number;
  maxCostUsd: number;
  maxContextTokens: number;
  strictBudgetRequired: boolean;
  oracleRequired: boolean;
  validationLevel: string;
  oraclePolicy: string;
  benchmarkLevel: string;
}

interface TargetStats {
  exists: boolean;
  targetKind: "repo" | "repo_path" | "missing";
  fileCount: number;
  directoryCount: number;
  skippedCount: number;
  totalBytesEstimate: number;
  extensionCounts: Record<string, number>;
  languageCount: number;
  packageManifestCount: number;
  workspaceIndicatorCount: number;
  testFileCount: number;
  docsFileCount: number;
  exampleFileCount: number;
  configFileCount: number;
  forbiddenVisibleCount: number;
  generatedVendorSkippedCount: number;
  maxFilesReached: boolean;
  errors: string[];
}

const PROFILE_ORDER: ComputeEffectiveProfile[] = ["low", "medium", "high", "xhigh", "max"];
const REQUESTED_PROFILES: ComputeRequestedProfile[] = ["auto", ...PROFILE_ORDER];
const DOMAINS: ComputeDomain[] = ["generic", "project-dna", "factory", "orchestration"];
const MAX_PREVIEW_FILES = 5000;

const DEFAULT_CAPS: Record<ComputeEffectiveProfile, ProfileDefaults> = {
  low: {
    maxAgents: 1,
    maxDelegationDepth: 0,
    maxParallel: 1,
    maxIterations: 1,
    maxDurationMs: 120_000,
    maxCostUsd: 0.25,
    maxContextTokens: 3000,
    strictBudgetRequired: false,
    oracleRequired: false,
    validationLevel: "narrow",
    oraclePolicy: "off_unless_risky",
    benchmarkLevel: "none",
  },
  medium: {
    maxAgents: 4,
    maxDelegationDepth: 1,
    maxParallel: 2,
    maxIterations: 2,
    maxDurationMs: 300_000,
    maxCostUsd: 1,
    maxContextTokens: 6000,
    strictBudgetRequired: false,
    oracleRequired: false,
    validationLevel: "targeted",
    oraclePolicy: "conditional",
    benchmarkLevel: "smoke",
  },
  high: {
    maxAgents: 10,
    maxDelegationDepth: 2,
    maxParallel: 4,
    maxIterations: 3,
    maxDurationMs: 600_000,
    maxCostUsd: 5,
    maxContextTokens: 12_000,
    strictBudgetRequired: true,
    oracleRequired: true,
    validationLevel: "full_local",
    oraclePolicy: "required_for_completion",
    benchmarkLevel: "smoke_plus_targeted_cases",
  },
  xhigh: {
    maxAgents: 20,
    maxDelegationDepth: 3,
    maxParallel: 6,
    maxIterations: 4,
    maxDurationMs: 1_200_000,
    maxCostUsd: 15,
    maxContextTokens: 20_000,
    strictBudgetRequired: true,
    oracleRequired: true,
    validationLevel: "full_plus_adversarial",
    oraclePolicy: "required_with_no_ship_gate",
    benchmarkLevel: "suite",
  },
  max: {
    maxAgents: 30,
    maxDelegationDepth: 4,
    maxParallel: 8,
    maxIterations: 5,
    maxDurationMs: 3_600_000,
    maxCostUsd: 50,
    maxContextTokens: 32_000,
    strictBudgetRequired: true,
    oracleRequired: true,
    validationLevel: "exhaustive_within_scope",
    oraclePolicy: "required_multiple_oracle_lanes",
    benchmarkLevel: "suite_plus_regression",
  },
};

const DEFAULT_FORBIDDEN_NAMES = new Set([
  ".env",
  ".git",
  ".npmrc",
  ".ssh",
  ".aws",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "out",
  "vendor",
  "generated",
]);

const GENERATED_VENDOR_NAMES = new Set(["node_modules", "dist", "build", "coverage", ".next", ".nuxt", "out", "vendor", "generated"]);
const SECRET_NAME_PATTERNS = [/\.env(?:\..*)?$/i, /secret/i, /credential/i, /(?:^|[-_])key(?:[-_.]|$)/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /^id_rsa$/i, /^id_ed25519$/i];
const LANGUAGE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".cs", ".rb", ".php", ".swift", ".vue", ".svelte"]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeRequestedProfile(value: string | undefined): ComputeRequestedProfile {
  return REQUESTED_PROFILES.includes(value as ComputeRequestedProfile) ? value as ComputeRequestedProfile : "auto";
}

function normalizeEffectiveProfile(value: string | undefined): ComputeEffectiveProfile | undefined {
  return PROFILE_ORDER.includes(value as ComputeEffectiveProfile) ? value as ComputeEffectiveProfile : undefined;
}

function normalizeDomain(value: string | undefined): ComputeDomain {
  return DOMAINS.includes(value as ComputeDomain) ? value as ComputeDomain : "generic";
}

function profileIndex(profile: ComputeEffectiveProfile): number {
  return PROFILE_ORDER.indexOf(profile);
}

function minProfile(profile: ComputeEffectiveProfile, maxProfile: ComputeEffectiveProfile | undefined): ComputeEffectiveProfile {
  if (!maxProfile) return profile;
  return PROFILE_ORDER[Math.min(profileIndex(profile), profileIndex(maxProfile))] ?? profile;
}

function isForbiddenName(name: string): boolean {
  return DEFAULT_FORBIDDEN_NAMES.has(name) || SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)(\/|$)/i.test(relativePath) || /\.(test|spec)\.[cm]?[tj]sx?$/i.test(relativePath);
}

function isDocsFile(relativePath: string): boolean {
  return /(^|\/)(docs?|documentation)(\/|$)/i.test(relativePath) || /(^|\/)(readme|architecture|design|guide)[^/]*\.md$/i.test(relativePath);
}

function isExampleFile(relativePath: string): boolean {
  return /(^|\/)(examples?|samples?)(\/|$)/i.test(relativePath);
}

function isConfigFile(relativePath: string): boolean {
  return /(^|\/)(package\.json|tsconfig\.json|vite\.config\.|next\.config\.|eslint\.|prettier\.|tailwind\.|factory\.json|.*\.schema\.json)$/i.test(relativePath);
}

function emptyStats(targetKind: TargetStats["targetKind"], exists: boolean, errors: string[] = []): TargetStats {
  return {
    exists,
    targetKind,
    fileCount: 0,
    directoryCount: 0,
    skippedCount: 0,
    totalBytesEstimate: 0,
    extensionCounts: {},
    languageCount: 0,
    packageManifestCount: 0,
    workspaceIndicatorCount: 0,
    testFileCount: 0,
    docsFileCount: 0,
    exampleFileCount: 0,
    configFileCount: 0,
    forbiddenVisibleCount: 0,
    generatedVendorSkippedCount: 0,
    maxFilesReached: false,
    errors,
  };
}

function collectTargetStats(repoRoot: string, targetPath: string | undefined): TargetStats {
  const requestedPath = targetPath && targetPath.trim().length > 0 ? targetPath : ".";
  const resolved = resolveRepoPath(repoRoot, requestedPath);
  if (resolved.errors.length > 0) return emptyStats("missing", false, resolved.errors);
  const absoluteTarget = resolved.path;
  if (!existsSync(absoluteTarget)) return emptyStats("missing", false, [`target_path does not exist: ${requestedPath}`]);

  const root = resolve(repoRoot);
  const stats = emptyStats(absoluteTarget === root ? "repo" : "repo_path", true);

  const visit = (absolutePath: string): void => {
    if (stats.fileCount >= MAX_PREVIEW_FILES) {
      stats.maxFilesReached = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(absolutePath, { withFileTypes: true });
    } catch (error) {
      stats.errors.push(`could not read directory metadata: ${relative(root, absolutePath) || "."}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const entry of entries) {
      if (stats.fileCount >= MAX_PREVIEW_FILES) {
        stats.maxFilesReached = true;
        return;
      }
      const childAbsolute = join(absolutePath, entry.name);
      const childRelative = relative(root, childAbsolute).replace(/\\/g, "/") || entry.name;
      if (isForbiddenName(entry.name)) {
        stats.skippedCount += 1;
        stats.forbiddenVisibleCount += 1;
        if (GENERATED_VENDOR_NAMES.has(entry.name)) stats.generatedVendorSkippedCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        stats.directoryCount += 1;
        visit(childAbsolute);
        continue;
      }
      if (!entry.isFile()) continue;
      stats.fileCount += 1;
      try {
        stats.totalBytesEstimate += statSync(childAbsolute).size;
      } catch {
        // Keep preview metadata-only and non-failing for transient stat errors.
      }
      const ext = extname(entry.name).toLowerCase() || "[no-ext]";
      stats.extensionCounts[ext] = (stats.extensionCounts[ext] ?? 0) + 1;
      if (entry.name === "package.json") stats.packageManifestCount += 1;
      if (entry.name === "pnpm-workspace.yaml" || entry.name === "lerna.json" || entry.name === "turbo.json" || entry.name === "nx.json") stats.workspaceIndicatorCount += 1;
      if (isTestFile(childRelative)) stats.testFileCount += 1;
      if (isDocsFile(childRelative)) stats.docsFileCount += 1;
      if (isExampleFile(childRelative)) stats.exampleFileCount += 1;
      if (isConfigFile(childRelative)) stats.configFileCount += 1;
    }
  };

  const targetStat = statSync(absoluteTarget);
  if (targetStat.isDirectory()) visit(absoluteTarget);
  else if (targetStat.isFile()) {
    stats.fileCount = 1;
    stats.totalBytesEstimate = targetStat.size;
    const ext = extname(absoluteTarget).toLowerCase() || "[no-ext]";
    stats.extensionCounts[ext] = 1;
  }

  stats.languageCount = Object.keys(stats.extensionCounts).filter((ext) => LANGUAGE_EXTENSIONS.has(ext)).length;
  return stats;
}

function scoreStats(stats: TargetStats, input: ComputePreviewInput, domain: ComputeDomain): Record<string, number> {
  const sourceFiles = Object.entries(stats.extensionCounts)
    .filter(([ext]) => LANGUAGE_EXTENSIONS.has(ext))
    .reduce((sum, [, count]) => sum + count, 0);
  const sourceFileRatio = stats.fileCount > 0 ? sourceFiles / stats.fileCount : 0;
  const riskHints = new Set((input.riskHints ?? []).map((hint) => hint.toLowerCase()));
  const writeRequested = riskHints.has("write") || riskHints.has("apply") || riskHints.has("mutation") ? 1 : 0;
  const externalAccess = riskHints.has("network") || riskHints.has("browser") || riskHints.has("cloud") ? 1 : 0;
  const durablePromotion = riskHints.has("promotion") || riskHints.has("durable") ? 1 : 0;
  const projectDnaBoost = domain === "project-dna" ? 0.15 : 0;

  const size = clamp01((stats.fileCount / 1000) * 0.35 + (stats.packageManifestCount / 20) * 0.25 + (stats.languageCount / 8) * 0.15 + (stats.totalBytesEstimate / 50_000_000) * 0.25);
  const material = clamp01(sourceFileRatio * 0.25 + Math.min(stats.testFileCount, 50) / 50 * 0.25 + Math.min(stats.docsFileCount, 25) / 25 * 0.15 + Math.min(stats.packageManifestCount, 5) / 5 * 0.15 + Math.min(stats.exampleFileCount, 20) / 20 * 0.10 + Math.min(stats.configFileCount, 20) / 20 * 0.10);
  const complexity = clamp01((stats.packageManifestCount / 10) * 0.30 + (stats.workspaceIndicatorCount / 4) * 0.20 + (stats.languageCount / 8) * 0.25 + (stats.configFileCount / 30) * 0.25);
  const ambiguity = clamp01(input.taskHash ? 0.15 : 0.30);
  const risk = clamp01((stats.forbiddenVisibleCount > 0 ? 0.20 : 0) + writeRequested * 0.25 + externalAccess * 0.15 + durablePromotion * 0.20 + (stats.errors.length > 0 ? 0.10 : 0));
  const novelty = clamp01(domain === "generic" ? 0.35 : 0.45 + projectDnaBoost);
  const reuseValue = clamp01((domain === "project-dna" || domain === "factory" || domain === "orchestration" ? 0.55 : 0.30) + projectDnaBoost + Math.min(stats.packageManifestCount, 5) / 5 * 0.20 + Math.min(stats.docsFileCount, 10) / 10 * 0.10);
  const validationNeed = clamp01(Math.max(complexity, risk) * 0.7 + material * 0.3);

  return { size, material, complexity, ambiguity, risk, novelty, reuseValue, validationNeed };
}

function reasonCodesFor(stats: TargetStats, scores: Record<string, number>, domain: ComputeDomain): string[] {
  const reasons: string[] = [];
  if (domain !== "generic") reasons.push(`${domain}_domain`);
  if (stats.fileCount >= 500) reasons.push("large_file_count");
  else if (stats.fileCount >= 100) reasons.push("medium_file_count");
  if (stats.packageManifestCount > 1) reasons.push("multiple_package_manifests");
  if (stats.workspaceIndicatorCount > 0) reasons.push("workspace_indicators_present");
  if (stats.testFileCount > 0) reasons.push("tests_present");
  if (stats.docsFileCount > 0) reasons.push("docs_present");
  if (stats.forbiddenVisibleCount > 0) reasons.push("forbidden_paths_visible_but_skipped");
  if (stats.maxFilesReached) reasons.push("preview_file_cap_reached");
  if (scores.reuseValue >= 0.7) reasons.push("high_reuse_value");
  if (scores.complexity >= 0.65) reasons.push("high_complexity");
  return reasons.length > 0 ? reasons : ["small_or_low_signal_target"];
}

function recommendProfile(scores: Record<string, number>, stats: TargetStats): ComputeEffectiveProfile {
  const qualityNeed = Math.max(scores.complexity, scores.ambiguity, scores.reuseValue, scores.validationNeed);
  const computeWorth = scores.material * scores.reuseValue;
  if (stats.errors.length > 0 && scores.material < 0.15) return "low";
  if (qualityNeed > 0.85 && computeWorth > 0.75) return "xhigh";
  if (qualityNeed > 0.65 && computeWorth > 0.55) return "high";
  if (qualityNeed > 0.35 || stats.fileCount > 25) return "medium";
  return "low";
}

function confidenceFor(stats: TargetStats, recommendedProfile: ComputeEffectiveProfile): ComputePreviewConfidence {
  if (stats.errors.length > 0 || stats.maxFilesReached) return "medium";
  if (recommendedProfile === "low" && stats.fileCount < 25) return "high";
  if (stats.fileCount > 100 && stats.packageManifestCount > 0) return "high";
  return "medium";
}

function adaptivePolicyHint(profile: ComputeEffectiveProfile): Record<string, unknown> {
  const depthByProfile: Record<ComputeEffectiveProfile, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
  const fanoutByProfile: Record<ComputeEffectiveProfile, number> = { low: 1, medium: 2, high: 4, xhigh: 6, max: 8 };
  return {
    schema: "zob.compute-adaptive-policy-hint.v1",
    profile,
    enabledByDefault: false,
    advisoryOnly: profile === "low" || profile === "medium",
    supervisedReadonlyEligible: profile === "high" || profile === "xhigh" || profile === "max",
    runtimeMaxDepthHint: depthByProfile[profile],
    globalParallelMaxHint: fanoutByProfile[profile],
    parentOwnedDispatch: true,
    childDirectDispatch: false,
    liveDispatchEnabled: false,
    noExecution: true,
  };
}

function mergeCaps(profile: ComputeEffectiveProfile, overrides: ComputeCapsInput | undefined): ProfileDefaults {
  const base = DEFAULT_CAPS[profile];
  return {
    ...base,
    maxAgents: finitePositive(overrides?.maxAgents) ?? base.maxAgents,
    maxDelegationDepth: finitePositive(overrides?.maxDelegationDepth) ?? base.maxDelegationDepth,
    maxParallel: finitePositive(overrides?.maxParallel) ?? base.maxParallel,
    maxIterations: finitePositive(overrides?.maxIterations) ?? base.maxIterations,
    maxDurationMs: finitePositive(overrides?.maxDurationMs) ?? base.maxDurationMs,
    maxCostUsd: finitePositive(overrides?.maxCostUsd) ?? base.maxCostUsd,
    maxContextTokens: finitePositive(overrides?.maxContextTokens) ?? base.maxContextTokens,
    strictBudgetRequired: overrides?.strictBudgetRequired ?? base.strictBudgetRequired,
    oracleRequired: overrides?.oracleRequired ?? base.oracleRequired,
  };
}

function noShipFor(stats: TargetStats): { noShip: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!stats.exists) blockers.push("target_path_missing_or_outside_repo");
  if (stats.errors.length > 0) blockers.push("preview_metadata_errors_present");
  return { noShip: blockers.length > 0, blockers };
}

export function buildComputePreview(repoRoot: string, input: ComputePreviewInput = {}): Record<string, unknown> {
  const domain = normalizeDomain(input.domain);
  const requestedProfile = normalizeRequestedProfile(input.requestedProfile);
  const stats = collectTargetStats(repoRoot, input.targetPath);
  const scores = scoreStats(stats, input, domain);
  const recommendedProfile = recommendProfile(scores, stats);
  const confidence = confidenceFor(stats, recommendedProfile);
  const { noShip, blockers } = noShipFor(stats);
  return {
    schema: "zob.compute-preview.v1",
    runId: input.runId,
    domain,
    requestedProfile,
    recommendedProfile,
    confidence,
    scores,
    reasonCodes: reasonCodesFor(stats, scores, domain),
    target: {
      targetKind: stats.targetKind,
      targetPathHash: sha256(input.targetPath ?? "."),
      targetPathStored: false,
      targetBasename: basename(input.targetPath ?? repoRoot),
      exists: stats.exists,
    },
    stats: {
      fileCount: stats.fileCount,
      directoryCount: stats.directoryCount,
      skippedCount: stats.skippedCount,
      totalBytesEstimate: stats.totalBytesEstimate,
      extensionCounts: stats.extensionCounts,
      languageCount: stats.languageCount,
      packageManifestCount: stats.packageManifestCount,
      workspaceIndicatorCount: stats.workspaceIndicatorCount,
      testFileCount: stats.testFileCount,
      docsFileCount: stats.docsFileCount,
      exampleFileCount: stats.exampleFileCount,
      configFileCount: stats.configFileCount,
      forbiddenVisibleCount: stats.forbiddenVisibleCount,
      generatedVendorSkippedCount: stats.generatedVendorSkippedCount,
      maxFilesReached: stats.maxFilesReached,
      errorCount: stats.errors.length,
    },
    blockers,
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
}

export function resolveComputeProfile(repoRoot: string, input: ComputePreviewInput = {}): Record<string, unknown> {
  const preview = buildComputePreview(repoRoot, input);
  const requestedProfile = preview.requestedProfile as ComputeRequestedProfile;
  const recommendedProfile = preview.recommendedProfile as ComputeEffectiveProfile;
  const maxProfile = normalizeEffectiveProfile(input.maxProfile);
  const requestedEffective = requestedProfile === "auto" ? recommendedProfile : requestedProfile;
  const cappedProfile = minProfile(requestedEffective, maxProfile);
  const caps = mergeCaps(cappedProfile, input.computeCaps);
  const blockedEscalation = profileIndex(cappedProfile) < profileIndex(requestedEffective)
    ? { to: requestedEffective, reason: "requested_or_recommended_profile_exceeds_max_profile_cap" }
    : requestedProfile === "auto" && recommendedProfile === "max"
      ? { to: "max", reason: "max requires explicit human approval; auto cannot silently select max" }
      : undefined;
  const effectiveProfile = requestedProfile === "auto" && recommendedProfile === "max" ? minProfile("xhigh", maxProfile) : cappedProfile;
  const effectiveCaps = mergeCaps(effectiveProfile, input.computeCaps);
  return {
    schema: "zob.compute-profile-resolution.v1",
    runId: input.runId,
    domain: preview.domain,
    requestedProfile,
    recommendedProfile,
    effectiveProfile,
    confidence: preview.confidence,
    reasonCodes: preview.reasonCodes,
    previewHash: sha256(JSON.stringify(preview)),
    previewEmbedded: false,
    caps: effectiveCaps,
    gates: {
      strictBudgetRequired: effectiveCaps.strictBudgetRequired,
      oracleRequired: effectiveCaps.oracleRequired,
      humanApprovalRequired: effectiveProfile === "max",
      sandboxRequiredForWrites: true,
      parentOwnedDispatch: true,
      childDirectDispatch: false,
    },
    adaptiveDelegationPolicyHint: adaptivePolicyHint(effectiveProfile),
    blockedEscalation,
    noShip: preview.noShip === true,
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
}

export function writeComputeProfileReports(repoRoot: string, input: ComputePreviewInput = {}): Record<string, unknown> {
  const runId = safeRunId(input.runId, "compute-profile");
  const dir = join(repoRoot, ".pi", "logs", "compute-profile", runId);
  mkdirSync(dir, { recursive: true });
  const preview = buildComputePreview(repoRoot, { ...input, runId });
  const resolution = resolveComputeProfile(repoRoot, { ...input, runId });
  const previewPath = join(dir, "compute-preview.json");
  const resolutionPath = join(dir, "compute-profile-resolution.json");
  writeFileSync(previewPath, JSON.stringify(preview, null, 2), "utf8");
  writeFileSync(resolutionPath, JSON.stringify(resolution, null, 2), "utf8");
  return {
    schema: "zob.compute-profile-report-write.v1",
    status: "written",
    runId,
    previewPath: relative(repoRoot, previewPath).replace(/\\/g, "/"),
    resolutionPath: relative(repoRoot, resolutionPath).replace(/\\/g, "/"),
    noExecution: true,
    childDispatchAllowed: false,
    bodyStored: false,
  };
}

function readRepoJson(repoRoot: string, repoPath: string): Record<string, unknown> | undefined {
  const resolved = resolveRepoPath(repoRoot, repoPath);
  if (resolved.errors.length > 0 || !existsSync(resolved.path)) return undefined;
  const parsed = JSON.parse(readFileSync(resolved.path, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : undefined;
}

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => ["task", "prompt", "output", "body", "content", "diff", "patch"].includes(key) || hasForbiddenBodyKeys(child));
}

function validScoreMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["size", "material", "complexity", "ambiguity", "risk", "novelty", "reuseValue", "validationNeed"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1);
}

export function validateComputeProfileArtifacts(repoRoot: string, input: ComputeProfileValidationInput): Record<string, unknown> {
  const errors: string[] = [];
  const preview = readRepoJson(repoRoot, input.previewPath);
  const resolution = input.resolutionPath ? readRepoJson(repoRoot, input.resolutionPath) : undefined;
  if (!preview) errors.push("preview artifact missing or invalid JSON object");
  if (preview) {
    if (preview.schema !== "zob.compute-preview.v1") errors.push("preview schema must be zob.compute-preview.v1");
    if (!REQUESTED_PROFILES.includes(preview.requestedProfile as ComputeRequestedProfile)) errors.push("preview requestedProfile invalid");
    if (!PROFILE_ORDER.includes(preview.recommendedProfile as ComputeEffectiveProfile)) errors.push("preview recommendedProfile invalid");
    if (!validScoreMap(preview.scores)) errors.push("preview scores invalid");
    for (const flag of ["noExecution", "sourceProjectModified", "knowledgeBackendWriteEnabled", "bodyStored", "promptBodiesStored", "outputBodiesStored"]) {
      if (flag === "noExecution" && preview[flag] !== true) errors.push("preview must keep noExecution=true");
      if (flag !== "noExecution" && preview[flag] !== false) errors.push(`preview must keep ${flag}=false`);
    }
    if (preview.childDispatchAllowed !== false) errors.push("preview childDispatchAllowed must be false");
    if (preview.networkAccessed !== false) errors.push("preview networkAccessed must be false");
    if (hasForbiddenBodyKeys(preview)) errors.push("preview must not contain raw body/prompt/output/content/diff/patch keys");
  }
  if (input.resolutionPath && !resolution) errors.push("resolution artifact missing or invalid JSON object");
  if (resolution) {
    if (resolution.schema !== "zob.compute-profile-resolution.v1") errors.push("resolution schema must be zob.compute-profile-resolution.v1");
    if (!PROFILE_ORDER.includes(resolution.effectiveProfile as ComputeEffectiveProfile)) errors.push("resolution effectiveProfile invalid");
    if (resolution.childDispatchAllowed !== false) errors.push("resolution childDispatchAllowed must be false");
    if (hasForbiddenBodyKeys(resolution)) errors.push("resolution must not contain raw body/prompt/output/content/diff/patch keys");
  }
  return {
    schema: "zob.compute-profile-validation.v1",
    valid: errors.length === 0,
    errors,
    previewPath: safeFileStem(input.previewPath),
    resolutionPath: input.resolutionPath ? safeFileStem(input.resolutionPath) : undefined,
    noExecution: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    bodyStored: false,
    generatedAt: new Date().toISOString(),
  };
}
