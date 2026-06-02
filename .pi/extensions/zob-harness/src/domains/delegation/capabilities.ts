import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { discoverAgents } from "./agents.js";
import { getOutputContractDefinitions } from "./output-contracts.js";
import { loadChainDefinition, listChainDefinitions } from "../topology/chains.js";
import { sha256 } from "../../core/utils/hashing.js";
import { parseJsonFile } from "../../core/utils/json.js";
import { safeFileStem } from "../../core/utils/paths.js";
import { isRecord } from "../../core/utils/records.js";
import { readableZobResourcePath, readableZobResourcePaths } from "../../core/utils/resources.js";

export interface ReuseScoutInput {
  query: string;
  run_id?: string;
  limit?: number;
}

type CapabilityKind = "agent" | "factory" | "chain" | "output_contract";

interface CapabilityCandidate {
  kind: CapabilityKind;
  id: string;
  sourcePath?: string;
  summary: string;
  searchText: string;
  metadata: Record<string, unknown>;
}

const FORBIDDEN_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content"]);

function hasForbiddenBodyKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKeys(child));
}

function keywords(value: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "only", "zob", "agent", "factory"]);
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_]+/).filter((item) => item.length >= 3 && !stop.has(item)))].sort();
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replace(/\\/g, "/");
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseJsonFile(path);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function listFactoryNames(repoRoot: string): string[] {
  const names = new Set<string>();
  for (const dir of readableZobResourcePaths(repoRoot, "factories")) {
    for (const name of readdirSync(dir)) {
      if (existsSync(join(dir, name, "factory.json"))) names.add(name);
    }
  }
  return [...names].sort();
}

function listOutputContractFiles(repoRoot: string): string[] {
  const fileNames = new Set<string>();
  for (const dir of readableZobResourcePaths(repoRoot, "output-contracts")) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".json")) fileNames.add(name);
    }
  }
  return [...fileNames].sort();
}

function capabilityCandidates(repoRoot: string): CapabilityCandidate[] {
  const agents = discoverAgents(repoRoot, "project").map((agent) => ({
    kind: "agent" as const,
    id: agent.name,
    sourcePath: repoRelative(repoRoot, agent.filePath),
    summary: agent.description,
    searchText: [agent.name, agent.description, agent.tools?.join(" ") ?? ""].join(" "),
    metadata: {
      tools: agent.tools ?? [],
      source: agent.source,
      modelClass: agent.model,
      promptHash: sha256(agent.prompt),
    },
  }));

  const factories = listFactoryNames(repoRoot).map((name) => {
    const factoryPath = readableZobResourcePath(repoRoot, "factories", name, "factory.json");
    const definition = readJsonObject(factoryPath) ?? {};
    const stages = Array.isArray(definition.stages) ? definition.stages.filter(isRecord) : [];
    const stageAgents = [...new Set(stages.map((stage) => String(stage.agent ?? "")).filter(Boolean))].sort();
    const stageContracts = [...new Set(stages.map((stage) => String(stage.outputContract ?? "")).filter(Boolean))].sort();
    const stageTypes = [...new Set(stages.map((stage) => String(stage.type ?? "")).filter(Boolean))].sort();
    const manifests = ["smoke-manifest.json", "pilot-manifest.json", "batch-manifest.json"].filter((fileName) => existsSync(readableZobResourcePath(repoRoot, "factories", name, fileName)));
    const description = typeof definition.description === "string" ? definition.description : "";
    return {
      kind: "factory" as const,
      id: name,
      sourcePath: repoRelative(repoRoot, factoryPath),
      summary: description,
      searchText: [name, description, stageAgents.join(" "), stageContracts.join(" "), stageTypes.join(" ")].join(" "),
      metadata: {
        version: definition.version,
        defaultMode: definition.defaultMode,
        stageTypes,
        stageAgents,
        outputContracts: stageContracts,
        manifests,
        expectedArtifacts: Array.isArray(definition.expectedArtifacts) ? definition.expectedArtifacts : [],
      },
    };
  });

  const chains = listChainDefinitions(repoRoot).map((name) => {
    const loaded = loadChainDefinition(repoRoot, name);
    const definition = loaded.definition;
    const steps = definition?.steps ?? [];
    const stepAgents = [...new Set(steps.map((step) => step.agent))].sort();
    const stepContracts = [...new Set(steps.map((step) => step.outputContract))].sort();
    return {
      kind: "chain" as const,
      id: name,
      sourcePath: repoRelative(repoRoot, loaded.chainPath),
      summary: definition?.description ?? "",
      searchText: [name, definition?.description ?? "", stepAgents.join(" "), stepContracts.join(" ")].join(" "),
      metadata: {
        readOnly: definition?.readOnly ?? true,
        defaultExecution: definition?.defaultExecution ?? "plan_only",
        steps: steps.length,
        stepAgents,
        outputContracts: stepContracts,
        definitionHash: definition ? sha256(JSON.stringify(definition)) : undefined,
      },
    };
  });

  const contractDefinitions = new Map(getOutputContractDefinitions().map((definition) => [definition.id, definition.required]));
  const outputContracts = listOutputContractFiles(repoRoot).map((fileName) => {
    const contractPath = readableZobResourcePath(repoRoot, "output-contracts", fileName);
    const parsed = readJsonObject(contractPath) ?? {};
    const id = typeof parsed.id === "string" ? parsed.id : basename(fileName, ".json");
    const description = typeof parsed.description === "string" ? parsed.description : "";
    const required = contractDefinitions.get(id) ?? [];
    return {
      kind: "output_contract" as const,
      id,
      sourcePath: repoRelative(repoRoot, contractPath),
      summary: description,
      searchText: [id, description, required.join(" ")].join(" "),
      metadata: {
        required,
        contractHash: sha256(readFileSync(contractPath, "utf8")),
      },
    };
  });

  return [...agents, ...factories, ...chains, ...outputContracts].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

export function buildCapabilityIndex(repoRoot: string): Record<string, unknown> {
  const candidates = capabilityCandidates(repoRoot);
  const byKind = candidates.reduce<Record<string, number>>((accumulator, candidate) => {
    accumulator[candidate.kind] = (accumulator[candidate.kind] ?? 0) + 1;
    return accumulator;
  }, {});
  const capabilities = candidates.map((candidate) => ({
    kind: candidate.kind,
    id: candidate.id,
    sourcePath: candidate.sourcePath,
    summary: candidate.summary,
    keywords: keywords(candidate.searchText),
    metadata: candidate.metadata,
  }));
  const index = {
    schema: "zob.capability-index.v1",
    counts: { total: capabilities.length, byKind },
    capabilities,
    noExecution: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(index)) throw new Error("Capability index would store forbidden body keys");
  return index;
}

export function buildReuseScoutReport(repoRoot: string, input: ReuseScoutInput): Record<string, unknown> {
  const queryKeywords = keywords(input.query);
  const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 10)));
  const candidates = capabilityCandidates(repoRoot)
    .map((candidate) => {
      const candidateKeywords = keywords(candidate.searchText);
      const overlap = candidateKeywords.filter((keyword) => queryKeywords.includes(keyword));
      const kindBoost = candidate.kind === "factory" && queryKeywords.includes("factory") ? 2 : candidate.kind === "chain" && queryKeywords.includes("workflow") ? 2 : 0;
      const score = overlap.length + kindBoost;
      return {
        kind: candidate.kind,
        id: candidate.id,
        sourcePath: candidate.sourcePath,
        score,
        reasonCodes: [...overlap.map((keyword) => `keyword:${keyword}`), ...(kindBoost > 0 ? [`kind_boost:${candidate.kind}`] : [])].sort(),
        summaryHash: sha256(candidate.summary),
        metadata: candidate.metadata,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
    .slice(0, limit);
  const report = {
    schema: "zob.reuse-scout-report.v1",
    queryHash: sha256(input.query),
    queryKeywords,
    candidates,
    candidateCount: candidates.length,
    noExecution: true,
    childDispatchAllowed: false,
    networkAccessed: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    generatedAt: new Date().toISOString(),
  };
  if (hasForbiddenBodyKeys(report)) throw new Error("Reuse scout report would store forbidden body keys");
  return report;
}

export function writeCapabilityIndex(repoRoot: string, runId = "capability-index"): string {
  const dir = join(repoRoot, ".pi", "logs", "capabilities");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(runId)}.json`);
  writeFileSync(outputPath, JSON.stringify(buildCapabilityIndex(repoRoot), null, 2), "utf8");
  return outputPath;
}

export function writeReuseScoutReport(repoRoot: string, input: ReuseScoutInput): string {
  const dir = join(repoRoot, ".pi", "logs", "capabilities");
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${safeFileStem(input.run_id ?? "reuse-scout")}.json`);
  writeFileSync(outputPath, JSON.stringify(buildReuseScoutReport(repoRoot, input), null, 2), "utf8");
  return outputPath;
}
