import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { sha256 } from "./utils/hashing.js";
import { safeFileStem } from "./utils/paths.js";
import { isRecord } from "./utils/records.js";

export type FactoryDemandSignal = "code_review" | "budget_preflight" | "roadmap_lots" | "opencode_patterns" | "project_dna" | "factory_forge";
export type FactorySelectionStatus = "existing_factory_selected" | "factory_forge_quarantine_recommended" | "no_factory_available";

export interface FactoryDemandInput {
  id?: string;
  refinedSpec?: string;
  acceptanceCriteria?: string[];
  expectedArtifacts?: string[];
}

export interface FactorySelectorCandidateInput {
  id?: string;
  name?: string;
  sourcePath?: string;
  summary?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  manifests?: string[];
}

export interface FactorySelectorDemandSummary {
  demandId: string;
  demandHash: string;
  signals: FactoryDemandSignal[];
  acceptanceCriteriaHashes: string[];
  expectedArtifactHashes: string[];
}

export interface FactorySelectorCandidateScore {
  kind: "factory";
  id: string;
  sourcePath?: string;
  score: number;
  confidence: number;
  reasonCodes: string[];
  demandMatches: Array<{ demandId: string; signals: FactoryDemandSignal[]; score: number; reasonCodes: string[] }>;
  manifestAvailability: { smoke: boolean; pilot: boolean; batch: boolean };
  summaryHash?: string;
  selected: boolean;
}

export interface FactorySelectorResult {
  schema: "zob.factory-selector.v1" | "zob.autonomous-factory-selection-score.v1";
  selectionStatus: FactorySelectionStatus;
  selectedFactory?: string;
  selectedScore: number;
  confidence: number;
  signals: FactoryDemandSignal[];
  demands: FactorySelectorDemandSummary[];
  deterministicScoring: true;
  multiDemand: true;
  candidates: FactorySelectorCandidateScore[];
  factoryForge: {
    available: boolean;
    selected: boolean;
    quarantineRequired: boolean;
    noAutoActivation: true;
    activationRequiresReview: true;
    activationPerformed: false;
    quarantineOnly: true;
  };
  noAutoActivation: true;
  quarantineRequiredForNewFactory: boolean;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
}

export interface FactorySelectorSmokeReport {
  schema: "zob.factory-selector-smoke.v1";
  status: "passed" | "failed";
  result: FactorySelectorResult;
  checks: Array<{ name: string; passed: boolean }>;
  failedChecks: string[];
  no_ship: boolean;
  bodyStored: false;
  promptBodiesStored: false;
  outputBodiesStored: false;
  generatedAt: string;
}

const SIGNAL_MATCHERS: Array<{ signal: FactoryDemandSignal; pattern: RegExp }> = [
  { signal: "code_review", pattern: /\b(code review|review code|review changes|oracle matrix|security review|qa review|correctness|architecture)\b/i },
  { signal: "budget_preflight", pattern: /\b(budget|cost|costs|cap|caps|preflight|strict budget|max runs|max cost|parallel children)\b/i },
  { signal: "roadmap_lots", pattern: /\b(roadmap|lot|lots|milestone|unchecked item|execution queue)\b/i },
  { signal: "opencode_patterns", pattern: /\b(opencode|pattern|patterns|canonizer|canonical|taxonomy|workflow rules|quality gates)\b/i },
  { signal: "project_dna", pattern: /\b(projectdna|project dna|project-dna|knowledge graph|code knowledge|context pack|repo scan|reference project)\b/i },
  { signal: "factory_forge", pattern: /\b(new factory|create factory|generate factory|factory scaffold|quarantine|factory-forge|forge)\b/i },
];

const FACTORY_SIGNAL_IDS: Record<FactoryDemandSignal, string> = {
  code_review: "code-review-matrix",
  budget_preflight: "budget-preflight-dry-run",
  roadmap_lots: "roadmap-smoke-lots",
  opencode_patterns: "opencode-pattern-canonizer",
  project_dna: "project-dna",
  factory_forge: "factory-forge",
};

function uniqueSorted<T extends string>(items: T[]): T[] {
  return [...new Set(items)].sort() as T[];
}

function stableStrings(items: unknown): string[] {
  return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).sort() : [];
}

function hashList(items: string[]): string[] {
  return items.map((item) => sha256(item)).sort();
}

export function detectFactoryDemandSignals(...values: string[]): FactoryDemandSignal[] {
  const text = values.join("\n");
  return uniqueSorted(SIGNAL_MATCHERS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.signal));
}

function manifestAvailability(manifests: string[]): { smoke: boolean; pilot: boolean; batch: boolean } {
  return {
    smoke: manifests.includes("smoke-manifest.json"),
    pilot: manifests.includes("pilot-manifest.json"),
    batch: manifests.includes("batch-manifest.json"),
  };
}

function candidateManifests(candidate: FactorySelectorCandidateInput): string[] {
  const metadata = isRecord(candidate.metadata) ? candidate.metadata : {};
  return uniqueSorted([
    ...stableStrings(candidate.manifests),
    ...stableStrings(metadata.manifests),
  ]);
}

function candidateId(candidate: FactorySelectorCandidateInput): string {
  return safeFileStem(typeof candidate.id === "string" ? candidate.id : typeof candidate.name === "string" ? candidate.name : "unknown");
}

function summarizeDemand(demand: FactoryDemandInput, index: number): FactorySelectorDemandSummary {
  const acceptanceCriteria = stableStrings(demand.acceptanceCriteria);
  const expectedArtifacts = stableStrings(demand.expectedArtifacts);
  const refinedSpec = typeof demand.refinedSpec === "string" ? demand.refinedSpec : "";
  return {
    demandId: safeFileStem(demand.id ?? `demand-${index + 1}`),
    demandHash: sha256([refinedSpec, ...acceptanceCriteria, ...expectedArtifacts].join("\n")),
    signals: detectFactoryDemandSignals(refinedSpec, acceptanceCriteria.join("\n"), expectedArtifacts.join("\n")),
    acceptanceCriteriaHashes: hashList(acceptanceCriteria),
    expectedArtifactHashes: hashList(expectedArtifacts),
  };
}

function scoreDemandForFactory(factoryId: string, demand: FactorySelectorDemandSummary): { score: number; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  let score = 0;
  for (const signal of demand.signals) {
    if (FACTORY_SIGNAL_IDS[signal] === factoryId) {
      score += 8;
      reasonCodes.push(`signal:${signal}`);
    }
  }
  return { score, reasonCodes };
}

function scoreFactoryCandidate(candidate: FactorySelectorCandidateInput, demands: FactorySelectorDemandSummary[]): Omit<FactorySelectorCandidateScore, "selected"> {
  const id = candidateId(candidate);
  const manifests = candidateManifests(candidate);
  const availability = manifestAvailability(manifests);
  const demandMatches = demands.map((demand) => {
    const score = scoreDemandForFactory(id, demand);
    return { demandId: demand.demandId, signals: demand.signals, score: score.score, reasonCodes: score.reasonCodes.sort() };
  });
  const manifestScore = (availability.smoke ? 1 : 0) + (availability.pilot ? 1 : 0) + (availability.batch ? 1 : 0);
  const signalScore = demandMatches.reduce((sum, match) => sum + match.score, 0);
  const reasonCodes = uniqueSorted([
    ...demandMatches.flatMap((match) => match.reasonCodes),
    ...(availability.smoke ? ["manifest:smoke"] : []),
    ...(availability.pilot ? ["manifest:pilot"] : []),
    ...(availability.batch ? ["manifest:batch"] : []),
  ]);
  const score = signalScore + manifestScore;
  const candidateSummary = typeof candidate.summary === "string" ? candidate.summary : typeof candidate.description === "string" ? candidate.description : undefined;
  return {
    kind: "factory",
    id,
    sourcePath: candidate.sourcePath,
    score,
    confidence: Math.max(0, Math.min(0.99, score / Math.max(12, demands.length * 10))),
    reasonCodes,
    demandMatches,
    manifestAvailability: availability,
    summaryHash: candidateSummary ? sha256(candidateSummary) : undefined,
  };
}

export function selectFactoryForDemands(input: { factories: FactorySelectorCandidateInput[]; demands?: FactoryDemandInput[]; refinedSpec?: string; acceptanceCriteria?: string[]; expectedArtifacts?: string[]; schema?: FactorySelectorResult["schema"] }): FactorySelectorResult {
  const demandInputs = input.demands && input.demands.length > 0
    ? input.demands
    : [{ id: "primary", refinedSpec: input.refinedSpec ?? "", acceptanceCriteria: input.acceptanceCriteria ?? [], expectedArtifacts: input.expectedArtifacts ?? [] }];
  const demands = demandInputs.map(summarizeDemand);
  const signals = uniqueSorted(demands.flatMap((demand) => demand.signals));
  const scoredWithoutSelection = input.factories
    .map((candidate) => scoreFactoryCandidate(candidate, demands))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const forgeCandidate = scoredWithoutSelection.find((candidate) => candidate.id === "factory-forge");
  const bestExisting = scoredWithoutSelection.find((candidate) => candidate.id !== "factory-forge" && candidate.score >= 8);
  const selected = bestExisting ?? (forgeCandidate && (forgeCandidate.score >= 8 || !bestExisting) ? forgeCandidate : undefined);
  const selectedFactory = selected?.id;
  const selectionStatus: FactorySelectionStatus = selectedFactory && selectedFactory !== "factory-forge"
    ? "existing_factory_selected"
    : selectedFactory === "factory-forge"
      ? "factory_forge_quarantine_recommended"
      : "no_factory_available";
  const candidates = scoredWithoutSelection.map((candidate) => ({ ...candidate, selected: candidate.id === selectedFactory }));
  const forgeSelected = selectedFactory === "factory-forge";
  return {
    schema: input.schema ?? "zob.factory-selector.v1",
    selectionStatus,
    selectedFactory,
    selectedScore: selected?.score ?? 0,
    confidence: selected?.confidence ?? 0,
    signals,
    demands,
    deterministicScoring: true,
    multiDemand: true,
    candidates,
    factoryForge: {
      available: Boolean(forgeCandidate),
      selected: forgeSelected,
      quarantineRequired: forgeSelected,
      noAutoActivation: true,
      activationRequiresReview: true,
      activationPerformed: false,
      quarantineOnly: true,
    },
    noAutoActivation: true,
    quarantineRequiredForNewFactory: forgeSelected,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export function loadFactorySelectorCandidates(repoRoot: string): FactorySelectorCandidateInput[] {
  const factoriesDir = join(repoRoot, ".pi", "factories");
  if (!existsSync(factoriesDir)) return [];
  return readdirSync(factoriesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const factoryName = safeFileStem(entry.name);
      const factoryDir = join(factoriesDir, factoryName);
      const factoryJsonPath = join(factoryDir, "factory.json");
      const parsed = existsSync(factoryJsonPath) ? JSON.parse(readFileSync(factoryJsonPath, "utf8")) as unknown : {};
      const record = isRecord(parsed) ? parsed : {};
      return {
        id: typeof record.name === "string" ? record.name : factoryName,
        sourcePath: `.pi/factories/${factoryName}/factory.json`,
        summary: typeof record.summary === "string" ? record.summary : undefined,
        description: typeof record.description === "string" ? record.description : undefined,
        manifests: readdirSync(factoryDir, { withFileTypes: true }).filter((file) => file.isFile() && file.name.endsWith("-manifest.json")).map((file) => basename(file.name)).sort(),
        metadata: isRecord(record.metadata) ? record.metadata : {},
      };
    })
    .sort((left, right) => candidateId(left).localeCompare(candidateId(right)));
}

export function buildFactorySelectorSmokeReport(repoRoot: string): FactorySelectorSmokeReport {
  const candidates = loadFactorySelectorCandidates(repoRoot);
  const result = selectFactoryForDemands({
    factories: candidates,
    demands: [
      {
        id: "code-review",
        refinedSpec: "Run a code review matrix with architecture, correctness, security, and QA review.",
        acceptanceCriteria: ["oracle matrix", "security review"],
        expectedArtifacts: ["code-review-matrix.json"],
      },
      {
        id: "new-factory",
        refinedSpec: "Create a new factory scaffold in quarantine for visual QA workflow.",
        acceptanceCriteria: ["factory-forge quarantine", "manual activation required"],
        expectedArtifacts: ["factory.json", "smoke-manifest.json"],
      },
    ],
  });
  const forgeOnly = selectFactoryForDemands({
    factories: candidates,
    refinedSpec: "Generate a new factory scaffold in quarantine for a future workflow.",
    acceptanceCriteria: ["quarantine only", "no activation"],
    expectedArtifacts: ["factory scaffold"],
  });
  const checks = [
    { name: "multi_demand_enabled", passed: result.multiDemand === true && result.demands.length === 2 },
    { name: "existing_factory_selected_for_existing_signal", passed: result.selectedFactory === "code-review-matrix" && result.signals.includes("code_review") },
    { name: "factory_forge_available", passed: result.factoryForge.available === true && result.candidates.some((candidate) => candidate.id === "factory-forge") },
    { name: "forge_only_routes_to_quarantine", passed: forgeOnly.selectedFactory === "factory-forge" && forgeOnly.quarantineRequiredForNewFactory === true && forgeOnly.factoryForge.activationPerformed === false },
    { name: "no_auto_activation", passed: result.noAutoActivation === true && forgeOnly.noAutoActivation === true },
    { name: "body_free", passed: result.bodyStored === false && result.promptBodiesStored === false && result.outputBodiesStored === false },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  return {
    schema: "zob.factory-selector-smoke.v1",
    status: failedChecks.length === 0 ? "passed" : "failed",
    result,
    checks,
    failedChecks,
    no_ship: failedChecks.length > 0,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
}
