import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "./utils/hashing.js";
import { safeFileStem } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

const FORBIDDEN_CONTEXT_BODY_KEYS = new Set(["body", "task", "prompt", "output", "content", "message", "diff", "patch", "rawConversation", "conversationHistory"]);
const CONTEXT_SCOPE_MAX_TOKENS_CAP = 8000;

export interface ContextScopeInput {
  scopeId?: string;
  runId: string;
  todoId?: string;
  allowedBrains?: string[];
  allowedSources?: string[];
  forbiddenSources?: string[];
  agentProfile?: string;
  maxContextTokens?: number;
  freshnessPolicy?: string;
  readPolicy?: string;
  writePolicy?: string;
  citationRequired?: boolean;
}

export interface ContextLookupInput {
  lookupId?: string;
  scope: Record<string, unknown>;
  brainId: string;
  sourceId: string;
  queryHash: string;
  facts?: Array<Record<string, unknown>>;
  patterns?: Array<Record<string, unknown>>;
  gaps?: Array<Record<string, unknown>>;
  freshness?: string;
  confidence?: string;
}

export interface ContextWritebackProposalInput {
  proposalId?: string;
  runId: string;
  observedProblemHash: string;
  newPatternHash: string;
  evidenceRefs: string[];
  recommendedArtifact: string;
}

function hasForbiddenContextBodyKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenContextBodyKey);
  return Object.entries(value).some(([key, child]) => FORBIDDEN_CONTEXT_BODY_KEYS.has(key) || hasForbiddenContextBodyKey(child));
}

function isHexSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isSafeSourceRef(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("..")) return false;
  if (value === ".env" || value.startsWith(".env.") || value.includes("/.env")) return false;
  if (value.includes("node_modules/") || value.includes("dist/") || value.includes("build/")) return false;
  if (value.endsWith(".pem") || value.endsWith(".key")) return false;
  return true;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function isCitation(value: unknown): boolean {
  if (typeof value === "string") return value.includes(":") || value.startsWith("docs/") || value.startsWith(".pi/") || value.startsWith("reports/");
  if (!isRecord(value)) return false;
  const ref = value.ref;
  const sourceId = value.sourceId;
  const path = value.path;
  return (typeof ref === "string" && ref.length > 0) || (typeof sourceId === "string" && typeof path === "string" && isSafeSourceRef(path));
}

function entriesHaveCitations(entries: unknown): boolean {
  if (!Array.isArray(entries)) return true;
  return entries.every((entry) => {
    if (!isRecord(entry)) return false;
    const citations = Array.isArray(entry.citations) ? entry.citations : (entry.citation ? [entry.citation] : []);
    return citations.length > 0 && citations.every(isCitation);
  });
}

function sourceMap(registry: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const sources = Array.isArray(registry.sources) ? registry.sources.filter(isRecord) : [];
  return new Map(sources.map((source) => [String(source.sourceId), source]));
}

function brainSet(registry: Record<string, unknown>): Set<string> {
  const brains = Array.isArray(registry.brains) ? registry.brains.filter(isRecord) : [];
  return new Set(brains.map((brain) => String(brain.brainId)));
}

export function buildContextBrainSourceRegistry(repoRoot: string): Record<string, unknown> {
  const sources = [
    {
      brainId: "harness-system",
      sourceId: "zob-harness-src",
      domain: "harness/system brain",
      owner: "zob-harness",
      sourceRoot: ".pi/extensions/zob-harness/src",
      gbrainSourceId: null,
      allowedAgents: ["planner", "explore", "oracle", "context-steward", "factory"],
      readPolicy: "repo_local_metadata_only",
      writePolicy: "proposal_only",
      freshnessPolicy: "current_source_required",
      noShipRules: ["citation_required", "context_scope_required", "no_raw_bodies"],
    },
    {
      brainId: "harness-system",
      sourceId: "zob-harness-docs",
      domain: "harness/system brain",
      owner: "zob-harness",
      sourceRoot: "docs",
      gbrainSourceId: null,
      allowedAgents: ["planner", "explore", "oracle", "context-steward", "factory"],
      readPolicy: "repo_local_metadata_only",
      writePolicy: "proposal_only",
      freshnessPolicy: "current_source_required",
      noShipRules: ["citation_required", "context_scope_required", "no_raw_bodies"],
    },
    {
      brainId: "factory-evidence",
      sourceId: "factory-run-reports",
      domain: "factory-evidence brain",
      owner: "zob-harness",
      sourceRoot: "reports/factory-runs",
      gbrainSourceId: null,
      allowedAgents: ["oracle", "context-steward", "factory"],
      readPolicy: "validated_summaries_only",
      writePolicy: "proposal_only",
      freshnessPolicy: "current_run_validation_required",
      noShipRules: ["citation_required", "sentinel_or_validation_required", "no_raw_outputs"],
    },
    {
      brainId: "conversation-chronicle",
      sourceId: "redacted-chronicle-summaries",
      domain: "conversation/chronicle brain",
      owner: "zob-harness",
      sourceRoot: ".pi/logs/summaries",
      gbrainSourceId: null,
      allowedAgents: ["planner", "context-steward", "oracle"],
      readPolicy: "redacted_summaries_only",
      writePolicy: "proposal_only",
      freshnessPolicy: "summary_hash_required",
      noShipRules: ["no_raw_conversation_history", "citation_required"],
    },
    {
      brainId: "learning-patterns",
      sourceId: "writeback-proposals",
      domain: "learning/pattern brain",
      owner: "zob-harness",
      sourceRoot: ".pi/context/writeback-proposals.jsonl",
      gbrainSourceId: null,
      allowedAgents: ["context-steward", "oracle"],
      readPolicy: "proposal_metadata_only",
      writePolicy: "proposal_only_no_auto_promote",
      freshnessPolicy: "oracle_review_required_before_promotion",
      noShipRules: ["auto_promote_blocked", "human_approval_required_for_promotion"],
    },
  ];
  return {
    schema: "zob.context-brain-source-registry.v1",
    repoRootHash: sha256(repoRoot),
    brains: uniqueSorted(sources.map((source) => source.brainId)).map((brainId) => ({ brainId, controlPlane: false, knowledgePlane: true })),
    sources,
    p0EmulatedBrainsOnly: true,
    gbrainImportEnabled: false,
    gbrainEmbedEnabled: false,
    gbrainSyncEnabled: false,
    gbrainWriteEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function buildDefaultContextScope(repoRoot: string, input: ContextScopeInput): Record<string, unknown> {
  const registry = buildContextBrainSourceRegistry(repoRoot);
  const defaultSources = ["zob-harness-src", "zob-harness-docs", "factory-run-reports"];
  const allowedSources = uniqueSorted(input.allowedSources ?? defaultSources);
  const registrySources = sourceMap(registry);
  const allowedBrains = uniqueSorted(input.allowedBrains ?? allowedSources.map((sourceId) => String(registrySources.get(sourceId)?.brainId ?? "")).filter(Boolean));
  return {
    schema: "zob.context-scope.v1",
    scopeId: input.scopeId ?? safeFileStem(`${input.runId}-context-scope`),
    runId: input.runId,
    todoId: input.todoId ?? null,
    allowedBrains,
    allowedSources,
    forbiddenSources: uniqueSorted(input.forbiddenSources ?? [".env", ".env.*", "secrets", "raw-conversation-history", "node_modules", "dist", "build"]),
    agentProfile: input.agentProfile ?? "context-steward-p0",
    maxContextTokens: Math.min(CONTEXT_SCOPE_MAX_TOKENS_CAP, Math.max(1, Math.floor(input.maxContextTokens ?? 4000))),
    freshnessPolicy: input.freshnessPolicy ?? "current_source_or_declared_stale",
    readPolicy: input.readPolicy ?? "bounded_metadata_only",
    writePolicy: input.writePolicy ?? "proposal_only",
    citationRequired: input.citationRequired ?? true,
    contextPackRequired: true,
    sourceScopeRequired: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function validateContextScope(repoRoot: string, scope: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const registry = buildContextBrainSourceRegistry(repoRoot);
  const knownBrains = brainSet(registry);
  const knownSources = sourceMap(registry);
  if (hasForbiddenContextBodyKey(scope)) errors.push("context_scope must not contain raw task/prompt/output/body/content/conversation fields");
  if (scope.schema !== "zob.context-scope.v1") errors.push("context_scope schema must be zob.context-scope.v1");
  if (typeof scope.runId !== "string" || scope.runId.length === 0) errors.push("context_scope requires runId");
  if (scope.todoId !== undefined && scope.todoId !== null && (typeof scope.todoId !== "string" || !/^[A-Za-z0-9._:-]+$/.test(scope.todoId))) errors.push("context_scope todoId must be metadata-safe when provided");
  if (scope.citationRequired !== true) errors.push("context_scope must set citationRequired=true");
  if (scope.writePolicy !== "proposal_only") errors.push("context_scope writePolicy must be proposal_only in P0");
  if (scope.readPolicy !== "bounded_metadata_only" && scope.readPolicy !== "repo_local_metadata_only") errors.push("context_scope readPolicy must be bounded metadata-only in P0");
  const maxTokens = typeof scope.maxContextTokens === "number" ? scope.maxContextTokens : 0;
  if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > CONTEXT_SCOPE_MAX_TOKENS_CAP) errors.push(`context_scope maxContextTokens must be 1..${CONTEXT_SCOPE_MAX_TOKENS_CAP}`);
  const allowedBrains = stringArray(scope.allowedBrains);
  const allowedSources = stringArray(scope.allowedSources);
  const forbiddenSources = stringArray(scope.forbiddenSources);
  if (allowedBrains.length === 0) errors.push("context_scope requires allowedBrains");
  if (allowedSources.length === 0) errors.push("context_scope requires allowedSources");
  for (const brainId of allowedBrains) if (!knownBrains.has(brainId)) errors.push(`context_scope unknown brain: ${brainId}`);
  for (const sourceId of allowedSources) {
    const source = knownSources.get(sourceId);
    if (!source) errors.push(`context_scope unknown source: ${sourceId}`);
    else if (!allowedBrains.includes(String(source.brainId))) errors.push(`context_scope source outside allowed brain: ${sourceId}`);
  }
  for (const forbidden of forbiddenSources) {
    if (allowedSources.includes(forbidden)) errors.push(`context_scope source cannot be both allowed and forbidden: ${forbidden}`);
  }
  if (!forbiddenSources.some((source) => source.includes(".env")) || !forbiddenSources.some((source) => source.includes("raw-conversation"))) errors.push("context_scope must forbid secrets and raw conversation history");
  return errors;
}

function validateLookupAccess(repoRoot: string, scope: Record<string, unknown>, brainId: string, sourceId: string): string[] {
  const errors = validateContextScope(repoRoot, scope);
  const allowedBrains = stringArray(scope.allowedBrains);
  const allowedSources = stringArray(scope.allowedSources);
  const forbiddenSources = stringArray(scope.forbiddenSources);
  const registrySources = sourceMap(buildContextBrainSourceRegistry(repoRoot));
  const source = registrySources.get(sourceId);
  if (!allowedBrains.includes(brainId)) errors.push(`brain outside context_scope: ${brainId}`);
  if (!allowedSources.includes(sourceId)) errors.push(`source outside context_scope: ${sourceId}`);
  if (forbiddenSources.includes(sourceId)) errors.push(`source forbidden by context_scope: ${sourceId}`);
  if (!source) errors.push(`unknown source: ${sourceId}`);
  else if (String(source.brainId) !== brainId) errors.push(`source '${sourceId}' does not belong to brain '${brainId}'`);
  return errors;
}

export function buildBrainLookupResult(repoRoot: string, input: ContextLookupInput): Record<string, unknown> {
  const accessErrors = validateLookupAccess(repoRoot, input.scope, input.brainId, input.sourceId);
  if (accessErrors.length > 0) throw new Error(accessErrors.join("; "));
  const lookup = {
    schema: "zob.brain-lookup-result.v1",
    lookupId: input.lookupId ?? safeFileStem(`${String(input.scope.runId)}-${input.sourceId}-lookup`),
    runId: input.scope.runId,
    scopeId: input.scope.scopeId,
    brainId: input.brainId,
    sourceId: input.sourceId,
    queryHash: input.queryHash,
    queryStored: false,
    facts: input.facts ?? [],
    patterns: input.patterns ?? [],
    gaps: input.gaps ?? [],
    freshness: input.freshness ?? "current_or_declared_stale",
    confidence: input.confidence ?? "MEDIUM",
    citationRequired: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const validationErrors = validateBrainLookupResult(repoRoot, input.scope, lookup);
  if (validationErrors.length > 0) throw new Error(validationErrors.join("; "));
  return lookup;
}

export function validateBrainLookupResult(repoRoot: string, scope: Record<string, unknown>, lookup: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (hasForbiddenContextBodyKey(lookup)) errors.push("brain_lookup must not contain raw task/prompt/output/body/content fields");
  if (lookup.schema !== "zob.brain-lookup-result.v1") errors.push("brain_lookup schema must be zob.brain-lookup-result.v1");
  if (!isHexSha256(lookup.queryHash)) errors.push("brain_lookup requires queryHash sha256; raw query is not stored");
  if (lookup.queryStored !== false) errors.push("brain_lookup queryStored must be false");
  if (lookup.citationRequired !== true) errors.push("brain_lookup citationRequired must be true");
  if (typeof lookup.brainId !== "string" || typeof lookup.sourceId !== "string") errors.push("brain_lookup requires brainId and sourceId");
  else errors.push(...validateLookupAccess(repoRoot, scope, lookup.brainId, lookup.sourceId));
  if (!entriesHaveCitations(lookup.facts)) errors.push("brain_lookup facts require citations");
  if (!entriesHaveCitations(lookup.patterns)) errors.push("brain_lookup patterns require citations");
  if (lookup.bodyStored !== false || lookup.promptBodiesStored !== false || lookup.outputBodiesStored !== false) errors.push("brain_lookup must mark body/prompt/output storage false");
  return errors;
}

export function buildContextPack(repoRoot: string, scope: Record<string, unknown>, lookups: Array<Record<string, unknown>>): Record<string, unknown> {
  const scopeErrors = validateContextScope(repoRoot, scope);
  if (scopeErrors.length > 0) throw new Error(scopeErrors.join("; "));
  const lookupErrors = lookups.flatMap((lookup) => validateBrainLookupResult(repoRoot, scope, lookup));
  if (lookupErrors.length > 0) throw new Error(lookupErrors.join("; "));
  const registrySources = sourceMap(buildContextBrainSourceRegistry(repoRoot));
  const allowedSources = stringArray(scope.allowedSources);
  const sourceLocks = allowedSources.map((sourceId) => {
    const source = registrySources.get(sourceId);
    const sourceRoot = typeof source?.sourceRoot === "string" ? source.sourceRoot : sourceId;
    return { sourceId, brainId: source?.brainId, sourceRoot, sourceRootHash: sha256(sourceRoot), exists: existsSync(join(repoRoot, sourceRoot)) };
  });
  const citations = uniqueSorted(lookups.flatMap((lookup) => [lookup.facts, lookup.patterns].flatMap((entries) => Array.isArray(entries) ? entries.flatMap((entry) => isRecord(entry) ? (Array.isArray(entry.citations) ? entry.citations : [entry.citation]).filter((citation): citation is string => typeof citation === "string") : []) : [])));
  return {
    schema: "zob.context-pack.v1",
    packId: safeFileStem(`${String(scope.runId)}-context-pack`),
    runId: scope.runId,
    scopeId: scope.scopeId,
    contextScope: scope,
    lookupIds: lookups.map((lookup) => lookup.lookupId),
    sourceLocks,
    loadingRules: { contextScopeRequired: true, boundedContextOnly: true, agentLoadsEntireCorpus: false, citationRequired: true },
    agentProfileMap: { [String(scope.agentProfile ?? "context-steward-p0")]: { maxContextTokens: scope.maxContextTokens, allowedSources: scope.allowedSources } },
    citations,
    budgetLimits: { maxContextTokens: scope.maxContextTokens, maxLookups: 10, budgetEnforced: false },
    gaps: lookups.flatMap((lookup) => Array.isArray(lookup.gaps) ? lookup.gaps : []),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function validateContextPack(repoRoot: string, pack: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (hasForbiddenContextBodyKey(pack)) errors.push("context_pack must not contain raw task/prompt/output/body/content fields");
  if (pack.schema !== "zob.context-pack.v1") errors.push("context_pack schema must be zob.context-pack.v1");
  const scope = isRecord(pack.contextScope) ? pack.contextScope : undefined;
  if (!scope) errors.push("context_pack requires contextScope");
  else errors.push(...validateContextScope(repoRoot, scope));
  const loadingRules = isRecord(pack.loadingRules) ? pack.loadingRules : {};
  if (loadingRules.contextScopeRequired !== true || loadingRules.boundedContextOnly !== true || loadingRules.agentLoadsEntireCorpus !== false || loadingRules.citationRequired !== true) errors.push("context_pack loadingRules must require scope, citations, and bounded context only");
  if (!Array.isArray(pack.sourceLocks) || pack.sourceLocks.length === 0) errors.push("context_pack requires sourceLocks");
  if (!Array.isArray(pack.citations) || pack.citations.length === 0 || !pack.citations.every(isCitation)) errors.push("context_pack requires citations");
  if (pack.bodyStored !== false || pack.promptBodiesStored !== false || pack.outputBodiesStored !== false) errors.push("context_pack must mark body/prompt/output storage false");
  return errors;
}

export function buildContextWritebackProposal(input: ContextWritebackProposalInput): Record<string, unknown> {
  const proposal = {
    schema: "zob.context-writeback-proposal.v1",
    proposalId: input.proposalId ?? safeFileStem(`${input.runId}-context-writeback`),
    runId: input.runId,
    observedProblemHash: input.observedProblemHash,
    newPatternHash: input.newPatternHash,
    evidenceRefs: input.evidenceRefs,
    recommendedArtifact: input.recommendedArtifact,
    promotionRequires: ["oracle_PASS", "human_approval", "smoke_proof"],
    autoPromote: false,
    writebackApplied: false,
    gbrainWriteEnabled: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  const errors = validateContextWritebackProposal(proposal);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return proposal;
}

export function validateContextWritebackProposal(proposal: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (hasForbiddenContextBodyKey(proposal)) errors.push("context writeback proposal must not contain raw task/prompt/output/body/content fields");
  if (proposal.schema !== "zob.context-writeback-proposal.v1") errors.push("context writeback proposal schema must be zob.context-writeback-proposal.v1");
  if (!isHexSha256(proposal.observedProblemHash)) errors.push("context writeback proposal requires observedProblemHash sha256");
  if (!isHexSha256(proposal.newPatternHash)) errors.push("context writeback proposal requires newPatternHash sha256");
  if (!Array.isArray(proposal.evidenceRefs) || proposal.evidenceRefs.length === 0 || !proposal.evidenceRefs.every((ref) => typeof ref === "string" && isSafeSourceRef(ref))) errors.push("context writeback proposal requires safe evidenceRefs");
  if (typeof proposal.recommendedArtifact !== "string" || !isSafeSourceRef(proposal.recommendedArtifact)) errors.push("context writeback proposal requires safe recommendedArtifact");
  if (proposal.autoPromote !== false || proposal.writebackApplied !== false || proposal.gbrainWriteEnabled !== false) errors.push("context writeback proposal must be proposal-only with no auto-promotion or GBrain write");
  if (!Array.isArray(proposal.promotionRequires) || !["oracle_PASS", "human_approval", "smoke_proof"].every((item) => (proposal.promotionRequires as unknown[]).includes(item))) errors.push("context writeback proposal requires oracle, human approval, and smoke proof before promotion");
  if (proposal.bodyStored !== false || proposal.promptBodiesStored !== false || proposal.outputBodiesStored !== false) errors.push("context writeback proposal must mark body/prompt/output storage false");
  return errors;
}

export function writeContextWritebackProposal(repoRoot: string, input: ContextWritebackProposalInput): Record<string, unknown> {
  const proposal = buildContextWritebackProposal(input);
  const dir = join(repoRoot, ".pi", "context");
  mkdirSync(dir, { recursive: true });
  const ledgerPath = join(dir, "writeback-proposals.jsonl");
  const artifactPath = join(dir, `${proposal.proposalId}.json`);
  writeFileSync(artifactPath, JSON.stringify(proposal, null, 2), "utf8");
  writeFileSync(ledgerPath, `${JSON.stringify(proposal)}\n`, { flag: "a" });
  return { ...proposal, proposalLedger: ".pi/context/writeback-proposals.jsonl", proposalArtifact: `.pi/context/${proposal.proposalId}.json` };
}

export function buildContextGbrainReadinessAudit(repoRoot: string, input: { runId?: string } = {}): Record<string, unknown> {
  const registry = buildContextBrainSourceRegistry(repoRoot);
  const scope = buildDefaultContextScope(repoRoot, { runId: input.runId ?? "context-gbrain-readiness-smoke", maxContextTokens: 2000 });
  const citation = "harness-system:zob-harness-docs:docs/AUTONOMOUS_SUPER_FACTORY_GOAL.md#phase-1.5";
  const lookup = buildBrainLookupResult(repoRoot, {
    scope,
    brainId: "harness-system",
    sourceId: "zob-harness-docs",
    queryHash: sha256("context readiness P0"),
    facts: [{ factHash: sha256("context_scope required before lookup"), citations: [citation], confidence: "HIGH" }],
    gaps: [{ gapHash: sha256("real GBrain adapter not enabled"), citations: [citation], noShipIfTreatedAsPass: true }],
    confidence: "HIGH",
  });
  const pack = buildContextPack(repoRoot, scope, [lookup]);
  const writeback = buildContextWritebackProposal({
    runId: String(scope.runId),
    observedProblemHash: sha256("context readiness observed problem"),
    newPatternHash: sha256("context readiness writeback pattern"),
    evidenceRefs: ["docs/AUTONOMOUS_SUPER_FACTORY_GOAL.md", ".pi/extensions/zob-harness/src/context-gbrain.ts"],
    recommendedArtifact: ".pi/context/writeback-proposals.jsonl",
  });
  const forbiddenScope = { ...scope, allowedSources: ["zob-harness-docs", "raw-conversation-history"], forbiddenSources: ["raw-conversation-history", ".env"] };
  const checks = [
    { name: "registry_metadata_only", passed: registry.gbrainImportEnabled === false && registry.gbrainEmbedEnabled === false && registry.gbrainSyncEnabled === false && registry.gbrainWriteEnabled === false && registry.p0EmulatedBrainsOnly === true && !hasForbiddenContextBodyKey(registry), detail: "P0 emulated registry only" },
    { name: "context_scope_required_and_valid", passed: validateContextScope(repoRoot, scope).length === 0, detail: JSON.stringify({ scopeId: scope.scopeId, allowedSources: scope.allowedSources }) },
    { name: "forbidden_source_blocked", passed: validateContextScope(repoRoot, forbiddenScope).some((error) => error.includes("both allowed and forbidden")), detail: "raw-conversation-history cannot be allowed" },
    { name: "lookup_scope_and_citations_enforced", passed: validateBrainLookupResult(repoRoot, scope, lookup).length === 0 && validateBrainLookupResult(repoRoot, scope, { ...lookup, facts: [{ factHash: sha256("missing citation") }] }).some((error) => error.includes("citations")), detail: String(lookup.lookupId) },
    { name: "context_pack_bounded_body_free", passed: validateContextPack(repoRoot, pack).length === 0 && !hasForbiddenContextBodyKey(pack), detail: JSON.stringify({ packId: pack.packId, citations: Array.isArray(pack.citations) ? pack.citations.length : 0 }) },
    { name: "writeback_local_metadata_proposal_only", passed: validateContextWritebackProposal(writeback).length === 0 && writeback.autoPromote === false && writeback.writebackApplied === false && writeback.gbrainWriteEnabled === false, detail: JSON.stringify({ proposalId: writeback.proposalId, localProposalArtifactAllowed: true, corpusWrite: false, gbrainWrite: false }) },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  return {
    schema: "zob.context-gbrain-readiness-audit.v1",
    verdict: failedChecks.length === 0 ? "PASS" : "FAIL",
    no_ship: failedChecks.length > 0,
    checks,
    failedChecks,
    registry,
    contextScope: scope,
    sampleLookup: lookup,
    sampleContextPack: pack,
    sampleWritebackProposal: writeback,
    gbrainImportEnabled: false,
    gbrainEmbedEnabled: false,
    gbrainSyncEnabled: false,
    gbrainWriteEnabled: false,
    localProposalArtifactsAllowed: true,
    corpusWritesEnabled: false,
    controlPlane: false,
    knowledgePlane: true,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}

export function writeContextGbrainReadinessAuditReport(repoRoot: string, runId = "context-gbrain-readiness-smoke"): string {
  const report = buildContextGbrainReadinessAudit(repoRoot, { runId });
  const reportsDir = join(repoRoot, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const path = join(reportsDir, `${safeFileStem(runId)}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}
