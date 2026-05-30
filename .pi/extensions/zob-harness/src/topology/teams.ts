import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadAgentsFromDir } from "../agents.js";
import { validateOutputContractId } from "../output-contracts.js";
import { validateToolList } from "../safety.js";
import type { HarnessAgent, TeamDefinition, TeamLead, TeamRoleBase, TeamWorker } from "../types.js";
import { parseJsonFile } from "../utils/json.js";
import { isSafeArtifactName, safeFileStem } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTeamRoleBase(value: unknown): value is TeamRoleBase {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.agent === "string" &&
    isStringArray(value.requiredTools) &&
    typeof value.outputContract === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.responsibilities === undefined || isStringArray(value.responsibilities))
  );
}

function isTeamLead(value: unknown): value is TeamLead {
  return isTeamRoleBase(value) && (!isRecord(value) || value.workerIds === undefined || isStringArray(value.workerIds));
}

function isTeamWorker(value: unknown): value is TeamWorker {
  return isTeamRoleBase(value) && isRecord(value) && typeof value.leadId === "string" && (value.taskTemplate === undefined || typeof value.taskTemplate === "string");
}

function isTeamDefinition(value: unknown): value is TeamDefinition {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.description === "string" &&
    isTeamRoleBase(value.orchestrator) &&
    Array.isArray(value.leads) &&
    value.leads.every(isTeamLead) &&
    Array.isArray(value.workers) &&
    value.workers.every(isTeamWorker)
  );
}

export function loadTeamDefinition(repoRoot: string, teamName: string): { definition?: TeamDefinition; teamPath: string; errors: string[] } {
  if (!/^[a-zA-Z0-9._-]+$/.test(teamName)) return { teamPath: join(repoRoot, ".pi", "teams", `${safeFileStem(teamName)}.json`), errors: [`Invalid team name '${teamName}'`] };
  const teamPath = join(repoRoot, ".pi", "teams", `${teamName}.json`);
  if (!existsSync(teamPath)) return { teamPath, errors: [`Team topology not found: ${teamPath}`] };
  try {
    const parsed = parseJsonFile(teamPath);
    if (!isTeamDefinition(parsed)) return { teamPath, errors: [`Invalid team topology: ${teamPath}`] };
    if (parsed.name !== teamName) return { teamPath, errors: [`Team topology name '${parsed.name}' does not match requested '${teamName}'`] };
    return { definition: parsed, teamPath, errors: [] };
  } catch (error) {
    return { teamPath, errors: [`Could not parse team topology '${teamPath}': ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function validateTeamRole(role: TeamRoleBase, label: string, agents: Map<string, HarnessAgent>): string[] {
  const errors: string[] = [];
  if (!isSafeArtifactName(role.id)) errors.push(`${label} id must be path-safe: ${role.id}`);
  const agent = agents.get(role.agent.toLowerCase());
  if (!agent) {
    errors.push(`${label} references unknown agent '${role.agent}'`);
  } else {
    errors.push(...validateToolList(agent, role.requiredTools).map((error) => `${label}: ${error}`));
  }
  errors.push(...validateOutputContractId(role.outputContract).map((error) => `${label}: ${error}`));
  return errors;
}

export function validateTeamDefinition(repoRoot: string, definition: TeamDefinition | undefined): string[] {
  const errors: string[] = [];
  if (!definition) return ["Team topology is missing"];
  if (!isSafeArtifactName(definition.name)) errors.push(`Team name must be path-safe: ${definition.name}`);
  const agents = new Map(loadAgentsFromDir(join(repoRoot, ".pi", "agents"), "project").map((agent) => [agent.name.toLowerCase(), agent]));
  const ids = new Set<string>();
  const markId = (id: string, label: string): void => {
    if (ids.has(id)) errors.push(`Duplicate team role id: ${id}`);
    ids.add(id);
    if (!isSafeArtifactName(id)) errors.push(`${label} id must be path-safe: ${id}`);
  };

  markId(definition.orchestrator.id, "orchestrator");
  errors.push(...validateTeamRole(definition.orchestrator, `orchestrator '${definition.orchestrator.id}'`, agents));
  if (definition.leads.length === 0) errors.push("Team topology must define at least one lead");
  if (definition.workers.length === 0) errors.push("Team topology must define at least one worker");

  const leadIds = new Set(definition.leads.map((lead) => lead.id));
  const workerIds = new Set(definition.workers.map((worker) => worker.id));
  for (const lead of definition.leads) {
    markId(lead.id, "lead");
    errors.push(...validateTeamRole(lead, `lead '${lead.id}'`, agents));
    for (const workerId of lead.workerIds ?? []) {
      if (!workerIds.has(workerId)) errors.push(`Lead '${lead.id}' references unknown worker '${workerId}'`);
    }
  }
  for (const worker of definition.workers) {
    markId(worker.id, "worker");
    errors.push(...validateTeamRole(worker, `worker '${worker.id}'`, agents));
    if (!leadIds.has(worker.leadId)) errors.push(`Worker '${worker.id}' references unknown lead '${worker.leadId}'`);
  }
  return errors;
}

export { isStringArray };
