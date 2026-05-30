import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256 } from "./utils/hashing.js";
import { isRecord } from "./utils/records.js";
import { safeRunId } from "./utils/paths.js";

const STOPWORDS = new Set(["the", "and", "for", "with", "how", "does", "this", "that", "dans", "avec", "pour", "comment", "faire", "using", "use", "project", "style"]);
const DEFAULT_SCAN_DIR = "reports/project-dna-scans/project-dna-factory-smoke";
const SAFE_SCAN_PREFIXES = ["reports/project-dna-scans/"];
const MAX_CONTEXT_TOKENS_CAP = 8000;

const FORBIDDEN_PATH_MARKERS = [
  ".env",
  ".npmrc",
  "id_rsa",
  "id_ed25519",
  "credential",
  "credentials",
  "secret",
  "secrets",
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "coverage/",
];

export interface ProjectDnaQueryInput {
  scanDir?: string;
  query: string;
  maxFiles?: number;
  maxContextTokens?: number;
  allowedSources?: string[];
  contextScopeId?: string;
}

export interface ProjectDnaFederatedQueryInput {
  scanDirs: string[];
  query: string;
  maxFilesPerSource?: number;
  maxTotalFiles?: number;
  maxContextTokens?: number;
  allowedSources?: string[];
  contextScopeId?: string;
}

export interface ProjectDnaWritebackProposalInput {
  runId: string;
  proposalId?: string;
  sourceIds: string[];
  observedPatternHash: string;
  proposedCapsuleHash: string;
  evidenceRefs: string[];
  recommendedArtifact: string;
}

export interface ProjectDnaPlanWorkflowInput {
  manifestPath: string;
  scanDir?: string;
}

interface SafePathResult {
  absolutePath: string;
  relativePath: string;
}

interface FileMapEntry {
  path: string;
  kind?: string;
  language?: string;
  imports?: string[];
  exports?: string[];
  citations?: string[];
  symbolCitations?: string[];
  primarySymbolCitation?: string;
}

interface ScoredFile {
  file: FileMapEntry;
  score: number;
}

function normalizeSlashes(value: string): string {
  return value.split(sep).join("/");
}

function assertSafeRelativePath(input: string, label: string, repoRoot: string, options: { allowMissing?: boolean; allowedPrefixes?: string[] } = {}): SafePathResult {
  if (!input || input.trim().length === 0) throw new Error(`${label} is required`);
  if (isAbsolute(input)) throw new Error(`${label} must be repo-relative`);
  const root = resolve(repoRoot);
  const absolutePath = resolve(root, input);
  const relativePath = normalizeSlashes(relative(root, absolutePath));
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`${label} must stay inside repo and not be repo root`);
  if (hasForbiddenPathMarker(relativePath)) throw new Error(`${label} contains forbidden path marker: ${input}`);
  const prefixes = options.allowedPrefixes ?? [];
  if (prefixes.length > 0 && !prefixes.some((prefix) => relativePath === prefix.replace(/\/$/, "") || relativePath.startsWith(prefix))) {
    throw new Error(`${label} must be under one of: ${prefixes.join(", ")}`);
  }
  if (!options.allowMissing && !existsSync(absolutePath)) throw new Error(`${label} not found: ${relativePath}`);
  return { absolutePath, relativePath };
}

function hasForbiddenPathMarker(value: string): boolean {
  const normalized = normalizeSlashes(value).toLowerCase();
  return FORBIDDEN_PATH_MARKERS.some((marker) => normalized === marker || normalized.includes(marker));
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function readScanJson(scanDir: string, fileName: string): Record<string, unknown> {
  const path = join(scanDir, fileName);
  if (!existsSync(path)) throw new Error(`missing ProjectDNA scan artifact: ${fileName}`);
  return readJsonObject(path, fileName);
}

function stringValue(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function arrayOfRecords(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function queryTerms(query: string): string[] {
  return unique(query.toLowerCase().split(/[^a-z0-9_.$-]+/).filter((term) => term.length >= 3 && !STOPWORDS.has(term)));
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.min(max, Math.floor(value));
}

function fileEntryFromRecord(record: Record<string, unknown>): FileMapEntry | undefined {
  const path = stringValue(record, "path");
  if (!path || hasForbiddenPathMarker(path)) return undefined;
  return {
    path,
    kind: stringValue(record, "kind", "unknown"),
    language: stringValue(record, "language", "unknown"),
    imports: stringArray(record.imports),
    exports: stringArray(record.exports),
    citations: stringArray(record.citations).filter((citation) => !hasForbiddenPathMarker(citation)),
    symbolCitations: stringArray(record.symbol_citations).filter((citation) => !hasForbiddenPathMarker(citation)),
    primarySymbolCitation: typeof record.primary_symbol_citation === "string" && !hasForbiddenPathMarker(record.primary_symbol_citation) ? record.primary_symbol_citation : undefined,
  };
}

function scoreFile(file: FileMapEntry, terms: string[]): number {
  const haystack = [file.path, file.kind, file.language, ...(file.imports ?? []), ...(file.exports ?? [])].join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 3;
  }
  if (terms.includes("queue") && file.kind === "queue") score += 8;
  if ((terms.includes("worker") || terms.includes("job")) && file.kind === "worker") score += 8;
  if ((terms.includes("route") || terms.includes("api") || terms.includes("controller")) && file.kind === "route") score += 8;
  if (terms.includes("service") && file.kind === "service") score += 8;
  if ((terms.includes("test") || terms.includes("testing")) && file.kind === "test") score += 8;
  if ((terms.includes("config") || terms.includes("configuration")) && file.kind === "config") score += 8;
  if ((terms.includes("command") || terms.includes("slash")) && file.path.toLowerCase().includes("command")) score += 8;
  if ((terms.includes("skill") || terms.includes("prompt") || terms.includes("agent")) && /skill|prompt|agent/.test(file.path.toLowerCase())) score += 8;
  return score;
}

function sourceAllowed(sourceId: string, allowedSources: string[] | undefined): boolean {
  return !allowedSources || allowedSources.length === 0 || allowedSources.includes(sourceId);
}

function loadScanArtifacts(repoRoot: string, scanDirInput: string | undefined): { scanDirPath: string; scanDirRef: string; fingerprint: Record<string, unknown>; fileMap: Record<string, unknown>; architectureMap: Record<string, unknown>; contextPack: Record<string, unknown>; graph: Record<string, unknown> } {
  const scanDir = assertSafeRelativePath(scanDirInput ?? DEFAULT_SCAN_DIR, "scan_dir", repoRoot, { allowedPrefixes: SAFE_SCAN_PREFIXES });
  return {
    scanDirPath: scanDir.absolutePath,
    scanDirRef: scanDir.relativePath,
    fingerprint: readScanJson(scanDir.absolutePath, "project-fingerprint.json"),
    fileMap: readScanJson(scanDir.absolutePath, "file-map.json"),
    architectureMap: readScanJson(scanDir.absolutePath, "architecture-map.json"),
    contextPack: readScanJson(scanDir.absolutePath, "context-pack-smoke.json"),
    graph: readScanJson(scanDir.absolutePath, "code-knowledge-graph.json"),
  };
}

export function buildProjectDnaQueryResult(repoRoot: string, input: ProjectDnaQueryInput): Record<string, unknown> {
  const query = input.query.trim();
  if (!query) throw new Error("query is required");
  const terms = queryTerms(query);
  const maxFiles = clampPositiveInteger(input.maxFiles, 8, 20);
  const maxContextTokens = clampPositiveInteger(input.maxContextTokens, MAX_CONTEXT_TOKENS_CAP, MAX_CONTEXT_TOKENS_CAP);
  const artifacts = loadScanArtifacts(repoRoot, input.scanDir);
  const sourceId = stringValue(artifacts.fingerprint, "source_id", "unknown-source");
  if (!sourceAllowed(sourceId, input.allowedSources)) throw new Error(`source_id ${sourceId} is not in allowed_sources`);

  const files = arrayOfRecords(artifacts.fileMap, "files").map(fileEntryFromRecord).filter((file): file is FileMapEntry => Boolean(file));
  const scored = files
    .map((file) => ({ file, score: scoreFile(file, terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const selected: ScoredFile[] = (scored.length > 0 ? scored : files.slice(0, maxFiles).map((file) => ({ file, score: 0 }))).slice(0, maxFiles);
  const selectedCitations = unique(selected.flatMap((item) => [...(item.file.symbolCitations ?? []), ...(item.file.citations ?? [])]));
  const patterns = arrayOfRecords(artifacts.architectureMap, "patterns");
  const patternHits = patterns.filter((pattern) => terms.some((term) => stringValue(pattern, "id").toLowerCase().includes(term)));
  const edges = arrayOfRecords(artifacts.graph, "edges");
  const graphEdges = edges.filter((edge) => selected.some((item) => edge.to === `source:${item.file.path}` || edge.from === `source:${item.file.path}`)).slice(0, 20);
  const contextCitations = stringArray(artifacts.contextPack.citations).filter((citation) => !hasForbiddenPathMarker(citation)).slice(0, 4);
  const citations = unique([...selectedCitations, ...patternHits.flatMap((pattern) => stringArray(pattern.evidence)), ...contextCitations]);

  return {
    schema: "zob.project-dna-query-result.v1",
    source_id: sourceId,
    scan_dir: artifacts.scanDirRef,
    context_scope: {
      scope_id: input.contextScopeId ?? `project-dna-${sha256(`${artifacts.scanDirRef}:${sourceId}`).slice(0, 12)}`,
      allowed_brains: ["project-dna"],
      allowed_sources: input.allowedSources && input.allowedSources.length > 0 ? input.allowedSources : [sourceId],
      forbidden_sources: ["secrets", "raw-conversation-history", ".env", "credentials"],
      max_context_tokens: maxContextTokens,
      write_policy: "proposal_only",
    },
    query_hash: sha256(query),
    query_stored: false,
    query_terms_stored: false,
    raw_query_persisted: false,
    answer: selected.length > 0
      ? "ProjectDNA found bounded cited pointers in scan metadata. Read cited files before implementation."
      : "ProjectDNA did not find matching files; treat this as a context gap.",
    files_to_read_first: selected.map((item) => ({
      path: item.file.path,
      kind: item.file.kind,
      score: item.score,
      line_range: (item.file.primarySymbolCitation ?? item.file.citations?.[0])?.split(":").at(-1) ?? null,
      reason: item.score > 0 ? "metadata_match" : "fallback_from_context_pack",
      citations: unique([...(item.file.symbolCitations ?? []), ...(item.file.citations ?? [])]),
    })),
    citations,
    graph_edges: graphEdges,
    pattern_hits: patternHits.map((pattern) => ({ id: pattern.id, confidence: pattern.confidence, evidence: stringArray(pattern.evidence) })),
    gaps: selected.length === 0 ? ["No files available in ProjectDNA file map."] : patternHits.length === 0 ? ["No architecture pattern id matched the query terms; use file-level citations only."] : [],
    loading_rules: {
      bounded_context_only: true,
      citation_required: true,
      agent_loads_entire_project: false,
      writeback_policy: "proposal_only",
    },
    safety: {
      scan_metadata_only: true,
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
      network_accessed: false,
      child_dispatch_allowed: false,
      child_direct_dispatch: false,
      parent_owned_dispatch: true,
    },
  };
}

export function buildProjectDnaFederatedQueryResult(repoRoot: string, input: ProjectDnaFederatedQueryInput): Record<string, unknown> {
  if (!Array.isArray(input.scanDirs) || input.scanDirs.length === 0) throw new Error("scan_dirs requires at least one scan directory");
  if (input.scanDirs.length > 10) throw new Error("scan_dirs is capped at 10 sources for P5 federation smoke");
  const maxFilesPerSource = clampPositiveInteger(input.maxFilesPerSource, 5, 10);
  const maxTotalFiles = clampPositiveInteger(input.maxTotalFiles, 20, 50);
  const sourceResults = input.scanDirs.map((scanDir) => buildProjectDnaQueryResult(repoRoot, {
    scanDir,
    query: input.query,
    maxFiles: maxFilesPerSource,
    maxContextTokens: input.maxContextTokens,
    allowedSources: input.allowedSources,
    contextScopeId: input.contextScopeId,
  }));
  const files = sourceResults.flatMap((result) => {
    const sourceId = typeof result.source_id === "string" ? result.source_id : "unknown-source";
    const filesToRead = Array.isArray(result.files_to_read_first) ? result.files_to_read_first.filter(isRecord) : [];
    return filesToRead.map((file) => ({ ...file, source_id: sourceId }));
  }).slice(0, maxTotalFiles);
  const citations = unique(sourceResults.flatMap((result) => stringArray(result.citations))).slice(0, 100);
  const sourceIds = unique(sourceResults.map((result) => typeof result.source_id === "string" ? result.source_id : "unknown-source"));
  return {
    schema: "zob.project-dna-federated-query-result.v1",
    query_hash: sha256(input.query),
    query_stored: false,
    source_count: sourceResults.length,
    source_ids: sourceIds,
    files_to_read_first: files,
    citations,
    source_results: sourceResults.map((result) => ({
      source_id: result.source_id,
      scan_dir: result.scan_dir,
      citation_count: stringArray(result.citations).length,
      file_count: Array.isArray(result.files_to_read_first) ? result.files_to_read_first.length : 0,
      safety: result.safety,
    })),
    federation_policy: {
      cross_source_merge: "metadata_only",
      source_isolation_preserved: true,
      durable_promotion_allowed: false,
      human_approval_required_for_promotion: true,
      writeback_policy: "proposal_only",
    },
    safety: {
      scan_metadata_only: true,
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
      network_accessed: false,
      child_dispatch_allowed: false,
      child_direct_dispatch: false,
      parent_owned_dispatch: true,
    },
  };
}

const PROJECT_DNA_PROFILES = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
const PROJECT_DNA_EFFECTIVE_PROFILES = new Set(["low", "medium", "high", "xhigh", "max"]);
const PROJECT_DNA_SEMANTIC_CAPTURE_MODES = new Set(["full_capture", "architecture_only", "targeted_capture", "sample_first", "context_only"]);

function effectiveProjectDnaProfile(requested: string): string {
  if (requested === "auto") return "medium";
  return PROJECT_DNA_EFFECTIVE_PROFILES.has(requested) ? requested : "low";
}

function projectDnaLaneCatalog(profile: string): Record<string, unknown>[] {
  const lanes: Record<string, unknown>[] = [
    { id: "manifest_preflight", phase: "p0", agent: "project-dna-safety-preflight", required: true, artifact_contract: "safety-metadata.v1", tools: ["read"] },
    { id: "repo_scout", phase: "p0", agent: "repo-scout", required: true, artifact_contract: "repo-complexity-report.v1", tools: ["read", "grep", "find", "ls"] },
    { id: "read_only_scan", phase: "p1", agent: "agent", required: true, artifact_contract: "scan-metadata.v1", tools: ["read", "grep", "find", "ls"] },
    { id: "scan_validation", phase: "p1", agent: "qa", required: true, artifact_contract: "validation-metadata.v1", tools: ["read", "bash"] },
  ];
  if (["medium", "high", "xhigh", "max"].includes(profile)) lanes.push(
    { id: "architecture_cartography", phase: "p1", agent: "architecture-cartographer", required: true, artifact_contract: "architecture-map.v2", tools: ["read", "grep", "find", "ls"] },
    { id: "pattern_mining", phase: "p1", agent: "pattern-miner", required: true, artifact_contract: "pattern-index.partial.v1", tools: ["read", "grep", "find", "ls"] },
    { id: "sample_spec", phase: "p1", agent: "sample-architect", required: true, artifact_contract: "sample-spec-metadata.v1", tools: ["read"] },
  );
  if (["high", "xhigh", "max"].includes(profile)) lanes.push(
    { id: "symbol_range_curation", phase: "p1", agent: "symbol-range-curator", required: true, artifact_contract: "range-quality-report.v1", tools: ["read", "grep", "find", "ls"] },
    { id: "quarantine_sample", phase: "p1", agent: "implementer", required: false, artifact_contract: "quarantine-sample-metadata.v1", tools: ["read", "bash"] },
    { id: "project_dna_oracle", phase: "p1", agent: "project-dna-oracle", required: true, artifact_contract: "oracle.v1", tools: ["read", "grep", "find", "ls", "bash"] },
  );
  if (["xhigh", "max"].includes(profile)) lanes.push({ id: "adversarial_review", phase: "p1", agent: "project-dna-oracle", required: true, artifact_contract: "adversarial-oracle.v1", tools: ["read", "grep", "find", "ls"] });
  if (profile === "max") lanes.push({ id: "human_promotion_packet", phase: "p1", agent: "planner", required: true, artifact_contract: "promotion-packet.v1", tools: ["read", "grep", "find", "ls"] });
  return lanes.map((lane, index) => ({
    ...lane,
    order: index + 1,
    parent_owned_dispatch: true,
    child_direct_dispatch: false,
    live_dispatch_enabled: false,
    source_mutation_allowed: false,
    backend_writes_enabled: false,
    durable_promotion_allowed: false,
    stores_raw_bodies: false,
  }));
}

function readOptionalProjectDnaScanSummary(repoRoot: string, scanDirInput: string | undefined): Record<string, unknown> {
  if (!scanDirInput) return {};
  const scanDir = assertSafeRelativePath(scanDirInput, "scan_dir", repoRoot, { allowMissing: true, allowedPrefixes: SAFE_SCAN_PREFIXES });
  const summaryPath = join(scanDir.absolutePath, "scan-summary.json");
  if (!existsSync(summaryPath)) return {};
  return readJsonObject(summaryPath, "scan-summary.json");
}

function deriveProjectDnaCaptureMode(manifest: Record<string, unknown>, effectiveProfile: string, scanSummary: Record<string, unknown>): string {
  const policy = isRecord(manifest.capture_mode_policy) ? manifest.capture_mode_policy : {};
  const goal = isRecord(manifest.capture_goal) ? manifest.capture_goal : {};
  const requested = stringValue(policy, "semantic_mode", "full_capture");
  const fallback = stringValue(policy, "large_repo_fallback", "architecture_only");
  const intent = `${stringValue(manifest, "user_note")} ${stringValue(goal, "objective")}`.toLowerCase();
  const fileCount = typeof scanSummary.files_scanned === "number" ? scanSummary.files_scanned : 0;
  if (requested !== "full_capture" && PROJECT_DNA_SEMANTIC_CAPTURE_MODES.has(requested)) return requested;
  if (/\b(sample|exemple|example|neutral)\b/.test(intent)) return "sample_first";
  if (/\b(context|query|lookup|retrieval)\b/.test(intent)) return "context_only";
  if (/\b(architecture|archi|structure|scaffold)\b/.test(intent)) return "architecture_only";
  if (fileCount >= 1000 || effectiveProfile === "xhigh" || effectiveProfile === "max") return PROJECT_DNA_SEMANTIC_CAPTURE_MODES.has(fallback) ? fallback : "architecture_only";
  return PROJECT_DNA_SEMANTIC_CAPTURE_MODES.has(requested) ? requested : "full_capture";
}

export function buildProjectDnaAgenticPlan(repoRoot: string, input: ProjectDnaPlanWorkflowInput): Record<string, unknown> {
  const manifestPath = assertSafeRelativePath(input.manifestPath, "manifest_path", repoRoot);
  const manifest = readJsonObject(manifestPath.absolutePath, "ProjectDNA manifest");
  if (manifest.schema !== "zob.project-dna-manifest.v2") throw new Error("manifest schema must be zob.project-dna-manifest.v2");
  const sourceProject = isRecord(manifest.source_project) ? manifest.source_project : {};
  const sourceId = stringValue(sourceProject, "source_id");
  if (!sourceId) throw new Error("source_project.source_id is required");
  const requestedProfile = stringValue(manifest, "requested_compute_profile", "auto");
  if (!PROJECT_DNA_PROFILES.has(requestedProfile)) throw new Error("requested_compute_profile invalid");
  const effectiveProfile = effectiveProjectDnaProfile(requestedProfile);
  const scanSummary = readOptionalProjectDnaScanSummary(repoRoot, input.scanDir);
  const effectiveCaptureMode = deriveProjectDnaCaptureMode(manifest, effectiveProfile, scanSummary);
  const policy = isRecord(manifest.capture_mode_policy) ? manifest.capture_mode_policy : {};
  const goal = isRecord(manifest.capture_goal) ? manifest.capture_goal : {};
  const targetDomains = Array.isArray(policy.targeted_domains) ? policy.targeted_domains.filter((item): item is string => typeof item === "string") : [];
  return {
    schema: "zob.project-dna-agentic-plan.v1",
    run_id: stringValue(manifest, "run_id", `project-dna-${sha256(manifestPath.relativePath).slice(0, 8)}`),
    source_id: sourceId,
    manifest_path: manifestPath.relativePath,
    manifest_hash: sha256(JSON.stringify(manifest)),
    manifest_embedded: false,
    scan_dir: input.scanDir ?? DEFAULT_SCAN_DIR,
    requested_compute_profile: requestedProfile,
    effective_compute_profile: effectiveProfile,
    requested_capture_mode: stringValue(policy, "semantic_mode", "full_capture"),
    effective_capture_mode: effectiveCaptureMode,
    capture_mode_rationale: "derived_from_manifest_user_note_profile_and_optional_scan_summary",
    targeted_domains: targetDomains,
    objective_hash: sha256(stringValue(goal, "objective")),
    metadata_only: true,
    no_execution: true,
    parent_owned_dispatch: true,
    child_direct_dispatch: false,
    live_dispatch_enabled: false,
    network_accessed: false,
    source_project_modified: false,
    source_mutation_allowed: false,
    knowledge_backend_write_enabled: false,
    durable_promotion_allowed: false,
    raw_bodies_stored: false,
    prompt_bodies_stored: false,
    result_bodies_stored: false,
    promotion_policy: "proposal_only",
    lanes: projectDnaLaneCatalog(effectiveProfile),
    safety: {
      source_read_only: true,
      forbidden_paths_excluded: true,
      secret_like_paths_forbidden: true,
      external_knowledge_backend_disabled: true,
      durable_promotion_requires_human_approval: true,
      citations_required: true,
      bounded_context_only: true,
    },
  };
}

export function buildProjectDnaReadinessAudit(repoRoot: string, input: { scanDir?: string } = {}): Record<string, unknown> {
  const requiredRepoFiles = [
    "docs/ZOB_PROJECT_DNA_CODE_KNOWLEDGE_GRAPH_PLAN.md",
    ".pi/skills/zob-project-dna/SKILL.md",
    ".pi/prompts/project-dna.md",
    ".pi/factories/project-dna/factory.json",
    ".pi/factories/project-dna/schemas/manifest.schema.json",
    "scripts/project-dna/scan.mjs",
    "scripts/project-dna/query-context.mjs",
    "scripts/project-dna/bench-smoke.mjs",
  ];
  const missingRepoFiles = requiredRepoFiles.filter((path) => !existsSync(resolve(repoRoot, path)));
  const scanDir = input.scanDir ?? DEFAULT_SCAN_DIR;
  let scanErrors: string[] = [];
  let sourceId = "unknown-source";
  try {
    const artifacts = loadScanArtifacts(repoRoot, scanDir);
    sourceId = stringValue(artifacts.fingerprint, "source_id", sourceId);
  } catch (error) {
    scanErrors = [error instanceof Error ? error.message : String(error)];
  }
  const p4RuntimeReady = existsSync(resolve(repoRoot, ".pi/extensions/zob-harness/src/project-dna.ts")) && existsSync(resolve(repoRoot, ".pi/extensions/zob-harness/src/runtime/tools-project-dna.ts"));
  const p5FederationReady = p4RuntimeReady;
  const errors = [...missingRepoFiles.map((file) => `missing repo file: ${file}`), ...scanErrors];
  return {
    schema: "zob.project-dna-readiness.v1",
    verdict: errors.length === 0 ? "ready" : "blocked",
    source_id: sourceId,
    scan_dir: scanDir,
    phases: {
      p0_plan_contracts: missingRepoFiles.length === 0 ? "done" : "partial",
      p1_scanner_smoke: scanErrors.length === 0 ? "done" : "blocked",
      p2_code_graph_capsules: scanErrors.length === 0 ? "partial_smoke_ready" : "blocked",
      p3_neutral_sample: scanErrors.length === 0 ? "partial_smoke_ready" : "blocked",
      p4_runtime_integration: p4RuntimeReady ? "done" : "missing",
      p5_multi_project_learning: p5FederationReady ? "proposal_only_ready" : "missing",
    },
    errors,
    no_ship: errors.length > 0,
    safety: {
      source_project_modified: false,
      knowledge_backend_write_enabled: false,
      durable_promotion_allowed: false,
      human_approval_required_for_promotion: true,
      proposal_only: true,
    },
  };
}

function validateSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a sha256 hex digest`);
}

function validateEvidenceRef(ref: string): void {
  assertSafeRelativePath(ref, "evidence_ref", process.cwd(), { allowMissing: true });
}

export function writeProjectDnaWritebackProposal(repoRoot: string, input: ProjectDnaWritebackProposalInput): Record<string, unknown> {
  if (!input.runId.trim()) throw new Error("run_id is required");
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length === 0) throw new Error("source_ids requires at least one source id");
  validateSha256(input.observedPatternHash, "observed_pattern_hash");
  validateSha256(input.proposedCapsuleHash, "proposed_capsule_hash");
  const artifact = assertSafeRelativePath(input.recommendedArtifact, "recommended_artifact", repoRoot, { allowMissing: true });
  for (const ref of input.evidenceRefs) {
    const safeRef = assertSafeRelativePath(ref, "evidence_ref", repoRoot, { allowMissing: true });
    if (hasForbiddenPathMarker(safeRef.relativePath)) throw new Error(`forbidden evidence_ref: ${ref}`);
  }
  const proposalId = safeRunId(input.proposalId, "project-dna-writeback-proposal");
  const proposal = {
    schema: "zob.project-dna-writeback-proposal.v1",
    proposal_id: proposalId,
    run_id_hash: sha256(input.runId),
    source_ids: unique(input.sourceIds).sort(),
    observed_pattern_hash: input.observedPatternHash,
    proposed_capsule_hash: input.proposedCapsuleHash,
    evidence_refs: input.evidenceRefs,
    recommended_artifact: artifact.relativePath,
    raw_problem_stored: false,
    raw_pattern_stored: false,
    durable_promotion_allowed: false,
    human_approval_required: true,
    external_knowledge_backend_write_enabled: false,
    created_at: new Date().toISOString(),
  };
  const outPath = resolve(repoRoot, ".pi/project-dna/writeback-proposals.jsonl");
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, `${JSON.stringify(proposal)}\n`, "utf8");
  return proposal;
}
