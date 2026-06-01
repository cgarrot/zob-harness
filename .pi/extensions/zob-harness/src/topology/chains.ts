import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadProjectAgents } from "../agents.js";
import { BLOCKED_CHAIN_TOOLS, READ_ONLY_CHAIN_TOOLS } from "../constants.js";
import { validateOutputContractId } from "../output-contracts.js";
import { validateToolList } from "../safety.js";
import type { ChainDefinition, ChainRunInput, ChainRunResult, ChainStepDefinition } from "../types.js";
import { sha256 } from "../utils/hashing.js";
import { parseJsonFile } from "../utils/json.js";
import { isSafeArtifactName, safeFileStem, safeRunId } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";
import { listZobResourceJsonStems, readableZobResourcePath } from "../utils/resources.js";
import { isStringArray } from "./teams.js";

function chainsDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "chains");
}

export function listChainDefinitions(repoRoot: string): string[] {
  return listZobResourceJsonStems(repoRoot, "chains");
}

function isChainStepDefinition(value: unknown): value is ChainStepDefinition {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.agent === "string" &&
    typeof value.task === "string" &&
    typeof value.expectedOutcome === "string" &&
    isStringArray(value.requiredTools) &&
    typeof value.outputContract === "string" &&
    isStringArray(value.mustDo) &&
    isStringArray(value.mustNotDo) &&
    typeof value.context === "string"
  );
}

function isChainDefinition(value: unknown): value is ChainDefinition {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.description === "string" &&
    (value.readOnly === undefined || typeof value.readOnly === "boolean") &&
    (value.defaultExecution === undefined || value.defaultExecution === "plan_only") &&
    Array.isArray(value.steps) &&
    value.steps.every(isChainStepDefinition)
  );
}

export function loadChainDefinition(repoRoot: string, chainName: string): { definition?: ChainDefinition; chainPath: string; errors: string[] } {
  if (!/^[a-zA-Z0-9._-]+$/.test(chainName)) return { chainPath: join(chainsDir(repoRoot), `${safeFileStem(chainName)}.json`), errors: [`Invalid chain name '${chainName}'`] };
  const chainPath = readableZobResourcePath(repoRoot, "chains", `${chainName}.json`);
  if (!existsSync(chainPath)) return { chainPath, errors: [`Chain definition not found: ${chainPath}`] };
  try {
    const parsed = parseJsonFile(chainPath);
    if (!isChainDefinition(parsed)) return { chainPath, errors: [`Invalid chain definition: ${chainPath}`] };
    if (parsed.name !== chainName) return { chainPath, errors: [`Chain definition name '${parsed.name}' does not match requested '${chainName}'`] };
    return { definition: parsed, chainPath, errors: [] };
  } catch (error) {
    return { chainPath, errors: [`Could not parse chain definition '${chainPath}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function renderChainTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => values[key] ?? match);
}

export function validateChainDefinition(repoRoot: string, definition: ChainDefinition | undefined): string[] {
  const errors: string[] = [];
  if (!definition) return ["Chain definition is missing"];
  if (!isSafeArtifactName(definition.name)) errors.push(`Chain name must be path-safe: ${definition.name}`);
  if (definition.readOnly === false) errors.push("Write-enabled chains are not supported without sandbox; only read-only chains may run");
  if (definition.defaultExecution !== undefined && definition.defaultExecution !== "plan_only") errors.push("Chain defaultExecution must be plan_only");
  if (definition.steps.length === 0) errors.push("Chain definition must include at least one step");
  const agents = new Map(loadProjectAgents(repoRoot).map((agent) => [agent.name.toLowerCase(), agent]));
  const ids = new Set<string>();
  const readOnlyTools = new Set<string>(READ_ONLY_CHAIN_TOOLS);
  const blockedTools = new Set<string>(BLOCKED_CHAIN_TOOLS);

  for (const step of definition.steps) {
    const label = `chain step '${step.id}'`;
    if (ids.has(step.id)) errors.push(`Duplicate chain step id: ${step.id}`);
    ids.add(step.id);
    if (!isSafeArtifactName(step.id)) errors.push(`${label} id must be path-safe: ${step.id}`);
    const agent = agents.get(step.agent.toLowerCase());
    if (!agent) {
      errors.push(`${label} references unknown agent '${step.agent}'`);
    } else {
      errors.push(...validateToolList(agent, step.requiredTools).map((error) => `${label}: ${error}`));
    }
    for (const tool of step.requiredTools) {
      if (blockedTools.has(tool)) errors.push(`${label}: Tool '${tool}' is unsafe for read-only chain execution`);
      if (!readOnlyTools.has(tool)) errors.push(`${label}: Tool '${tool}' is not in read-only chain allowlist (${READ_ONLY_CHAIN_TOOLS.join(", ")})`);
    }
    errors.push(...validateOutputContractId(step.outputContract).map((error) => `${label}: ${error}`));
  }
  return errors;
}

export function validateChainRunInputs(repoRoot: string, input: ChainRunInput): string[] {
  const errors: string[] = [];
  if (!input.goal || input.goal.trim().length === 0) errors.push("goal is required");
  if (input.run_id && safeFileStem(input.run_id) !== input.run_id) errors.push(`run_id must be path-safe: ${input.run_id}`);
  if (input.execution !== undefined && input.execution !== "plan_only") errors.push("chain_run only supports execution=plan_only; write/live execution requires a future sandbox");
  const loaded = loadChainDefinition(repoRoot, input.chain);
  errors.push(...loaded.errors);
  errors.push(...validateChainDefinition(repoRoot, loaded.definition));
  return errors;
}

export function buildChainPlan(repoRoot: string, definition: ChainDefinition, input: ChainRunInput, runId = safeRunId(input.run_id, "chain")): Record<string, unknown> {
  const previousStepIds: string[] = [];
  const originalUserAsk = input.original_user_ask ?? input.goal;
  const tasks = definition.steps.map((step, index) => {
    const values = { goal: input.goal, original_user_ask: originalUserAsk, chain: definition.name, step_id: step.id, previous_step_ids: previousStepIds.join(", ") || "none" };
    const task = {
      id: step.id,
      sequence: index + 1,
      agent: step.agent,
      task: renderChainTemplate(step.task, values),
      expected_outcome: renderChainTemplate(step.expectedOutcome, values),
      required_tools: step.requiredTools,
      must_do: step.mustDo.map((item) => renderChainTemplate(item, values)),
      must_not_do: step.mustNotDo.map((item) => renderChainTemplate(item, values)),
      context: renderChainTemplate(step.context, values),
      output_contract: step.outputContract,
      run_in_background: false,
      load_skills: [],
    };
    previousStepIds.push(step.id);
    return task;
  });
  return {
    schema: "zob.chain-plan.v1",
    chain: definition.name,
    version: definition.version,
    runId,
    execution: "plan_only",
    readOnly: definition.readOnly !== false,
    noExecution: true,
    liveChildExecution: false,
    budgetEnforced: false,
    modelRouterUsed: false,
    blockedTools: [...BLOCKED_CHAIN_TOOLS],
    allowedTools: [...READ_ONLY_CHAIN_TOOLS],
    invariants: {
      contractFirst: true,
      delegateTaskShaped: true,
      promptBodiesStored: false,
      outputBodiesStored: false,
      sentinelWritten: false,
      mandatoryBudgetGate: false,
    },
    tasks,
  };
}

export function runChainPlanOnly(repoRoot: string, input: ChainRunInput): ChainRunResult {
  const errors = validateChainRunInputs(repoRoot, input);
  const runId = safeRunId(input.run_id, "chain");
  const runDir = join(repoRoot, "reports", "chains", runId);
  if (existsSync(runDir) && !input.resume) errors.push(`Chain run directory already exists. Use resume=true or choose another run_id: ${runDir}`);
  const loaded = loadChainDefinition(repoRoot, input.chain);
  if (errors.length > 0 || !loaded.definition) return { runId, runDir, status: "failed_preflight", chain: input.chain, steps: 0, artifacts: [], errors };

  mkdirSync(runDir, { recursive: true });
  const sentinelPath = join(runDir, "DONE.sentinel");
  if (existsSync(sentinelPath)) unlinkSync(sentinelPath);
  const plan = buildChainPlan(repoRoot, loaded.definition, input, runId);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const artifacts = ["manifest.json", "ledger.jsonl", "chain-plan.json", "status.jsonl", "validation.json", "final-report.md"];
  const manifest = {
    schema: "zob.chain-run-manifest.v1",
    runId,
    chain: loaded.definition.name,
    chainPath: loaded.chainPath,
    execution: "plan_only",
    readOnly: true,
    noExecution: true,
    goalHash: sha256(input.goal),
    originalUserAskHash: sha256(input.original_user_ask ?? input.goal),
    steps: tasks.length,
    createdAt: new Date().toISOString(),
    budgetEnforced: false,
    mandatoryBudgetGate: false,
  };
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(runDir, "chain-plan.json"), JSON.stringify(plan, null, 2), "utf8");
  const statusLines = tasks.map((task) => {
    const record = isRecord(task) ? task : {};
    return JSON.stringify({
      schema: "zob.chain-status.v1",
      runId,
      chain: loaded.definition?.name,
      stepId: record.id,
      sequence: record.sequence,
      agent: record.agent,
      outputContract: record.output_contract,
      status: "planned",
      noExecution: true,
      running: false,
      taskHash: sha256(JSON.stringify(record)),
      outputHash: null,
      bodyStored: false,
    });
  });
  writeFileSync(join(runDir, "status.jsonl"), `${statusLines.join("\n")}\n`, "utf8");
  appendFileSync(join(runDir, "ledger.jsonl"), `${JSON.stringify({ schema: "zob.chain-ledger.v1", event: "planned", runId, chain: loaded.definition.name, steps: tasks.length, noExecution: true, sentinel: "not written", promptBodiesStored: false, outputBodiesStored: false, budgetEnforced: false, mandatoryBudgetGate: false })}\n`, "utf8");
  writeFileSync(join(runDir, "final-report.md"), [`# Chain Run Report`, ``, `- runId: ${runId}`, `- chain: ${loaded.definition.name}`, `- status: planned`, `- execution: plan_only`, `- steps: ${tasks.length}`, `- child_agents_executed: no`, `- read_only: yes`, `- sentinel: not written`, ``].join("\n"), "utf8");
  const validation = {
    schema: "zob.chain-validation.v1",
    runId,
    chain: loaded.definition.name,
    status: "planned",
    execution: "plan_only",
    readOnly: true,
    noExecution: true,
    liveChildExecution: false,
    steps: tasks.length,
    allowedTools: [...READ_ONLY_CHAIN_TOOLS],
    blockedTools: [...BLOCKED_CHAIN_TOOLS],
    artifactsPresent: artifacts.map((artifact) => ({ artifact, exists: artifact === "validation.json" ? true : existsSync(join(runDir, artifact)) })),
    sentinelWritten: existsSync(sentinelPath),
    budgetEnforced: false,
    mandatoryBudgetGate: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    errors: [],
  };
  writeFileSync(join(runDir, "validation.json"), JSON.stringify(validation, null, 2), "utf8");
  return { runId, runDir, status: "planned", chain: loaded.definition.name, steps: tasks.length, artifacts, errors: [] };
}

export { renderChainTemplate };
