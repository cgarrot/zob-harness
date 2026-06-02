import { loadProjectAgents } from "../delegation/agents.js";
import { validateOutputContractId } from "../delegation/output-contracts.js";
import { validateAllowedPathPolicy, validateDelegateTaskWriteScope, validateForbiddenPathPolicy, validateToolList } from "../governance/safety.js";
import { sha256 } from "../../core/utils/hashing.js";
import { isRecord } from "../../core/utils/records.js";

export interface LeadPlanWorkerContract {
  worker_id: string;
  lead_id?: string;
  agent: string;
  task: string;
  expected_outcome: string;
  required_tools: string[];
  output_contract: string;
  must_do: string[];
  must_not_do: string[];
  context: string;
  allowed_paths?: string[];
  forbidden_paths?: string[];
  model_class?: string;
}

export interface LeadPlanWorkerContractExtraction {
  schema: "zob.lead-plan-worker-contract-extraction.v1";
  contracts: LeadPlanWorkerContract[];
  errors: string[];
}

export interface LeadPlanWorkerContractValidationOptions {
  leadId?: string;
  allowedWorkerIds?: string[];
  allowedTools?: string[];
  supervisedReadonly?: boolean;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseJsonCandidate(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonCandidates(output: string): unknown[] {
  const candidates: unknown[] = [];
  const trimmed = output.trim();
  const whole = parseJsonCandidate(trimmed);
  if (whole !== undefined) candidates.push(whole);

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = parseJsonCandidate(match[1].trim());
    if (parsed !== undefined) candidates.push(parsed);
  }

  for (const match of trimmed.matchAll(/<worker_contracts>\s*([\s\S]*?)\s*<\/worker_contracts>/gi)) {
    const parsed = parseJsonCandidate(match[1].trim());
    if (parsed !== undefined) candidates.push(parsed);
  }

  return candidates;
}

function contractsRoot(candidate: unknown): unknown[] | undefined {
  if (Array.isArray(candidate)) return candidate;
  if (!isRecord(candidate)) return undefined;
  if (Array.isArray(candidate.worker_contracts)) return candidate.worker_contracts;
  if (Array.isArray(candidate.workerContracts)) return candidate.workerContracts;
  return undefined;
}

function normalizeContract(value: unknown, index: number): { contract?: LeadPlanWorkerContract; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: [`worker_contracts[${index}] must be an object`] };

  const workerId = typeof value.worker_id === "string" ? value.worker_id : typeof value.workerId === "string" ? value.workerId : undefined;
  const leadId = typeof value.lead_id === "string" ? value.lead_id : typeof value.leadId === "string" ? value.leadId : undefined;
  const expectedOutcome = typeof value.expected_outcome === "string" ? value.expected_outcome : typeof value.expectedOutcome === "string" ? value.expectedOutcome : undefined;
  const requiredTools = isStringArray(value.required_tools) ? value.required_tools : isStringArray(value.requiredTools) ? value.requiredTools : undefined;
  const outputContract = typeof value.output_contract === "string" ? value.output_contract : typeof value.outputContract === "string" ? value.outputContract : undefined;
  const mustDo = isStringArray(value.must_do) ? value.must_do : isStringArray(value.mustDo) ? value.mustDo : undefined;
  const mustNotDo = isStringArray(value.must_not_do) ? value.must_not_do : isStringArray(value.mustNotDo) ? value.mustNotDo : undefined;
  const allowedPaths = isStringArray(value.allowed_paths) ? value.allowed_paths : isStringArray(value.allowedPaths) ? value.allowedPaths : undefined;
  const forbiddenPaths = isStringArray(value.forbidden_paths) ? value.forbidden_paths : isStringArray(value.forbiddenPaths) ? value.forbiddenPaths : undefined;
  const modelClass = typeof value.model_class === "string" ? value.model_class : typeof value.modelClass === "string" ? value.modelClass : undefined;

  if (!workerId) errors.push(`worker_contracts[${index}].worker_id is required`);
  if (leadId !== undefined && leadId.length === 0) errors.push(`worker_contracts[${index}].lead_id must not be empty`);
  if (typeof value.agent !== "string" || value.agent.length === 0) errors.push(`worker_contracts[${index}].agent is required`);
  if (typeof value.task !== "string" || value.task.length === 0) errors.push(`worker_contracts[${index}].task is required`);
  if (!expectedOutcome) errors.push(`worker_contracts[${index}].expected_outcome is required`);
  if (!requiredTools) errors.push(`worker_contracts[${index}].required_tools must be a string array`);
  if (!outputContract) errors.push(`worker_contracts[${index}].output_contract is required`);
  if (!mustDo) errors.push(`worker_contracts[${index}].must_do must be a string array`);
  if (!mustNotDo) errors.push(`worker_contracts[${index}].must_not_do must be a string array`);
  if (typeof value.context !== "string" || value.context.length === 0) errors.push(`worker_contracts[${index}].context is required`);
  if (errors.length > 0) return { errors };

  return {
    contract: {
      worker_id: workerId!,
      lead_id: leadId,
      agent: value.agent as string,
      task: value.task as string,
      expected_outcome: expectedOutcome!,
      required_tools: requiredTools!,
      output_contract: outputContract!,
      must_do: mustDo!,
      must_not_do: mustNotDo!,
      context: value.context as string,
      allowed_paths: allowedPaths,
      forbidden_paths: forbiddenPaths,
      model_class: modelClass,
    },
    errors: [],
  };
}

export function extractLeadPlanWorkerContracts(output: string): LeadPlanWorkerContractExtraction {
  const candidates = jsonCandidates(output);
  for (const candidate of candidates) {
    const root = contractsRoot(candidate);
    if (!root) continue;
    const contracts: LeadPlanWorkerContract[] = [];
    const errors: string[] = [];
    root.forEach((item, index) => {
      const normalized = normalizeContract(item, index);
      if (normalized.contract) contracts.push(normalized.contract);
      errors.push(...normalized.errors);
    });
    return { schema: "zob.lead-plan-worker-contract-extraction.v1", contracts, errors };
  }
  return { schema: "zob.lead-plan-worker-contract-extraction.v1", contracts: [], errors: ["No parseable worker_contracts JSON found in lead-plan output"] };
}

export function redactLeadPlanWorkerContractsForPersistence(contracts: LeadPlanWorkerContract[]): Array<Record<string, unknown>> {
  return contracts.map((contract) => ({
    worker_id: contract.worker_id,
    lead_id: contract.lead_id,
    agent: contract.agent,
    taskHash: sha256(contract.task),
    expected_outcomeHash: sha256(contract.expected_outcome),
    required_tools: contract.required_tools,
    output_contract: contract.output_contract,
    must_doHashes: contract.must_do.map((item) => sha256(item)),
    must_not_doHashes: contract.must_not_do.map((item) => sha256(item)),
    contextHash: sha256(contract.context),
    allowed_paths: contract.allowed_paths,
    forbidden_paths: contract.forbidden_paths,
    model_class: contract.model_class,
    bodyStored: false,
  }));
}

export function validateLeadPlanWorkerContracts(repoRoot: string, contracts: LeadPlanWorkerContract[], options: LeadPlanWorkerContractValidationOptions = {}): string[] {
  const errors: string[] = [];
  const agents = new Map(loadProjectAgents(repoRoot).map((agent) => [agent.name.toLowerCase(), agent]));
  const allowedWorkers = options.allowedWorkerIds ? new Set(options.allowedWorkerIds) : undefined;
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;

  contracts.forEach((contract, index) => {
    const label = `worker_contracts[${index}] '${contract.worker_id}'`;
    if (options.leadId && contract.lead_id && contract.lead_id !== options.leadId) errors.push(`${label}: lead_id must match '${options.leadId}'`);
    if (allowedWorkers && !allowedWorkers.has(contract.worker_id)) errors.push(`${label}: worker_id is not delegated by this lead`);

    const agent = agents.get(contract.agent.toLowerCase());
    if (!agent) {
      errors.push(`${label}: unknown agent '${contract.agent}'`);
    } else {
      errors.push(...validateToolList(agent, contract.required_tools).map((error) => `${label}: ${error}`));
    }

    if (allowedTools) {
      const blockedTools = contract.required_tools.filter((tool) => !allowedTools.has(tool));
      if (blockedTools.length > 0) errors.push(`${label}: tools not allowed by execution boundary: ${blockedTools.join(", ")}`);
    }
    if (options.supervisedReadonly) {
      const writeLike = contract.required_tools.filter((tool) => ["bash", "edit", "write", "delegate_agent", "delegate_task", "orchestrate_run", "factory_run"].includes(tool));
      if (writeLike.length > 0) errors.push(`${label}: supervised_readonly worker contracts must remain read-only: ${writeLike.join(", ")}`);
    }

    errors.push(...validateOutputContractId(contract.output_contract).map((error) => `${label}: ${error}`));
    errors.push(...validateDelegateTaskWriteScope(contract.required_tools, contract.allowed_paths).map((error) => `${label}: ${error}`));
    errors.push(...validateAllowedPathPolicy(contract.allowed_paths, `${label} allowed_paths`, repoRoot));
    errors.push(...validateForbiddenPathPolicy(contract.forbidden_paths, `${label} forbidden_paths`, repoRoot));
  });

  return errors;
}
